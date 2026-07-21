import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildLocalCoreManagedDatabaseUrl,
  ensureLocalCoreManagedPostgres,
  resolveLocalCorePaths,
  type LocalCorePostgresCommandInput,
} from "../../src/localCore/index.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "managed Postgres starts from Core paths with a private socket and no localhost listener", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-postgres-"));
  const bundleRoot = path.join(home, "bundle");
  const paths = resolveLocalCorePaths(home);
  const commands: LocalCorePostgresCommandInput[] = [];
  try {
    const result = await ensureLocalCoreManagedPostgres({
      paths,
      bundleRootPath: bundleRoot,
      fileExists: (targetPath) => isBundledPostgresBinary(bundleRoot, targetPath),
      runCommandImpl: async (input) => {
        commands.push(input);
        return { ok: true, stdout: "", stderr: "", detail: "ok" };
      },
      probeSocketImpl: async () => {},
    });

    assert.equal(result.status.state, "healthy");
    assert.equal(result.status.socketPath, paths.postgresSocketPath);
    assert.equal(result.status.dataPath, paths.postgresDataPath);
    assert.equal(result.status.identityVerified, true);
    assert.equal(result.status.databaseUrl, buildLocalCoreManagedDatabaseUrl({
      socketPath: paths.postgresSocketPath,
      port: 5432,
    }));

    const pgCtl = commands.find((command) => command.command.endsWith("pg_ctl"));
    assert.ok(pgCtl);
    assert.deepEqual(pgCtl.args.slice(0, 2), ["start", "-D"]);
    assert.match(pgCtl.args.join(" "), /-k/u);
    assert.match(pgCtl.args.join(" "), /-h ''/u);
    assert.doesNotMatch(pgCtl.args.join(" "), /127\.0\.0\.1/u);
    assert.equal(JSON.parse(await readFile(paths.postgresMetadataPath, "utf8")).socketPath, paths.postgresSocketPath);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "managed Postgres removes stale pid files before restart", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-postgres-stale-"));
  const bundleRoot = path.join(home, "bundle");
  const paths = resolveLocalCorePaths(home);
  const pidPath = path.join(paths.postgresDataPath, "postmaster.pid");
  const commands: string[] = [];
  try {
    await mkdir(paths.postgresDataPath, { recursive: true });
    await writeFile(path.join(paths.postgresDataPath, "PG_VERSION"), "14\n", "utf8");
    await writeFile(paths.postgresMetadataPath, JSON.stringify({
      version: 1,
      port: 5432,
      database: "kestrel",
      user: "kestrel",
      dataPath: paths.postgresDataPath,
      socketPath: paths.postgresSocketPath,
    }), "utf8");
    await writeFile(pidPath, [
      "12345",
      paths.postgresDataPath,
      "1718636400",
      "5432",
      paths.postgresSocketPath,
      "",
    ].join("\n"), "utf8");

    const result = await ensureLocalCoreManagedPostgres({
      paths,
      bundleRootPath: bundleRoot,
      fileExists: async (targetPath) => isBundledPostgresBinary(bundleRoot, targetPath) || fileExistsOnDisk(targetPath),
      isPidAlive: () => false,
      runCommandImpl: async (input) => {
        commands.push(path.basename(input.command));
        return { ok: true, stdout: "", stderr: "", detail: "ok" };
      },
      probeSocketImpl: async () => {},
    });

    assert.equal(result.status.state, "healthy");
    assert.deepEqual(commands, ["pg_ctl", "createdb"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "managed Postgres blocks when pid identity points at a different socket", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-postgres-identity-"));
  const bundleRoot = path.join(home, "bundle");
  const paths = resolveLocalCorePaths(home);
  try {
    await mkdir(paths.postgresDataPath, { recursive: true });
    await writeFile(path.join(paths.postgresDataPath, "PG_VERSION"), "14\n", "utf8");
    await writeFile(paths.postgresMetadataPath, JSON.stringify({
      version: 1,
      port: 5432,
      database: "kestrel",
      user: "kestrel",
      dataPath: paths.postgresDataPath,
      socketPath: paths.postgresSocketPath,
    }), "utf8");
    await writeFile(path.join(paths.postgresDataPath, "postmaster.pid"), [
      "12345",
      paths.postgresDataPath,
      "1718636400",
      "5432",
      path.join(home, "wrong-socket"),
      "",
    ].join("\n"), "utf8");

    const result = await ensureLocalCoreManagedPostgres({
      paths,
      bundleRootPath: bundleRoot,
      fileExists: async (targetPath) => isBundledPostgresBinary(bundleRoot, targetPath) || fileExistsOnDisk(targetPath),
      runCommandImpl: async () => {
        throw new Error("should not start on identity mismatch");
      },
    });

    assert.equal(result.status.state, "blocked");
    assert.equal(result.status.lastError?.code, "LOCAL_CORE_POSTGRES_SOCKET_MISMATCH");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "managed Postgres reports initialization failures as blocked status", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-postgres-init-fail-"));
  const bundleRoot = path.join(home, "bundle");
  const paths = resolveLocalCorePaths(home);
  try {
    const result = await ensureLocalCoreManagedPostgres({
      paths,
      bundleRootPath: bundleRoot,
      fileExists: (targetPath) => isBundledPostgresBinary(bundleRoot, targetPath),
      runCommandImpl: async () => ({
        ok: false,
        stdout: "",
        stderr: "initdb failed",
        detail: "initdb failed",
      }),
    });

    assert.equal(result.status.state, "blocked");
    assert.equal(result.status.lastError?.code, "LOCAL_CORE_POSTGRES_INIT_FAILED");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function isBundledPostgresBinary(bundleRoot: string, targetPath: string): boolean {
  return [
    path.join(bundleRoot, "bin", "initdb"),
    path.join(bundleRoot, "bin", "postgres"),
    path.join(bundleRoot, "bin", "pg_ctl"),
    path.join(bundleRoot, "bin", "createdb"),
  ].includes(targetPath);
}

async function fileExistsOnDisk(targetPath: string): Promise<boolean> {
  try {
    await readFile(targetPath);
    return true;
  } catch {
    return false;
  }
}
