import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { DesktopPostgresSupervisor } from "../src/postgresSupervisor.js";

test("DesktopPostgresSupervisor initializes, starts, and reuses persisted metadata", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kestrel-postgres-supervisor-"));
  const bundleRoot = path.join(root, "postgres-bundle");
  const installRoot = path.join(bundleRoot, "darwin-arm64");
  const dataPath = path.join(root, "state", "data");
  const logPath = path.join(root, "logs", "desktop-postgres.log");
  const metadataPath = path.join(root, "state", "metadata.json");
  const commands: string[] = [];

  createBundleLayout(installRoot);

  const spawnImpl = ((command: string, args: string[]) => {
    commands.push(`${path.basename(command)} ${args.join(" ")}`);
    if (path.basename(command) === "initdb") {
      mkdirSync(dataPath, { recursive: true });
      writeFileSync(path.join(dataPath, "PG_VERSION"), "14\n", "utf8");
    }

    const child = new EventEmitter() as import("node:child_process").ChildProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = null;
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  const supervisor = new DesktopPostgresSupervisor({
    bundleRootPath: bundleRoot,
    dataPath,
    logPath,
    metadataPath,
    platform: "darwin",
    arch: "arm64",
    allocatePort: async () => 61234,
    probeTcpPortImpl: async () => undefined,
    spawnImpl,
  });

  try {
    const first = await supervisor.ensureReady();
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { port: number };

    assert.equal(first.databaseUrl, "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel");
    assert.equal(first.status.state, "healthy");
    assert.equal(first.status.managed, true);
    assert.equal(first.status.port, 61234);
    assert.equal(metadata.port, 61234);
    assert.equal(commands.some((entry) => entry.startsWith("initdb ")), true);
    assert.equal(commands.some((entry) => entry.startsWith("pg_ctl start ")), true);
    assert.equal(commands.some((entry) => entry.startsWith("createdb ")), true);

    commands.length = 0;
    const restarted = await supervisor.restart();

    assert.equal(restarted.state, "healthy");
    assert.equal(restarted.port, 61234);
    assert.equal(commands.some((entry) => entry.startsWith("pg_ctl stop ")), true);
    assert.equal(commands.some((entry) => entry.startsWith("pg_ctl start ")), true);
    assert.equal(commands.some((entry) => entry.startsWith("initdb ")), false);
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("DesktopPostgresSupervisor reports a blocked status when the bundle is missing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kestrel-postgres-supervisor-missing-"));
  const supervisor = new DesktopPostgresSupervisor({
    bundleRootPath: path.join(root, "missing-bundle"),
    dataPath: path.join(root, "state", "data"),
    logPath: path.join(root, "logs", "desktop-postgres.log"),
    metadataPath: path.join(root, "state", "metadata.json"),
    platform: "darwin",
    arch: "arm64",
  });

  try {
    await assert.rejects(
      () => supervisor.ensureReady(),
      /No bundled Postgres installation/u,
    );
    const status = supervisor.getStatus();
    assert.equal(status.state, "blocked");
    assert.equal(status.lastError?.code, "DESKTOP_POSTGRES_BUNDLE_MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DesktopPostgresSupervisor reuses an already-running managed cluster", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kestrel-postgres-supervisor-running-"));
  const bundleRoot = path.join(root, "postgres-bundle");
  const installRoot = path.join(bundleRoot, "darwin-arm64");
  const dataPath = path.join(root, "state", "data");
  const logPath = path.join(root, "logs", "desktop-postgres.log");
  const metadataPath = path.join(root, "state", "metadata.json");
  const commands: string[] = [];

  createBundleLayout(installRoot);
  mkdirSync(dataPath, { recursive: true });
  mkdirSync(path.dirname(metadataPath), { recursive: true });
  writeFileSync(path.join(dataPath, "PG_VERSION"), "14\n", "utf8");
  writeFileSync(path.join(dataPath, "postmaster.pid"), "12345\n", "utf8");
  writeFileSync(metadataPath, `${JSON.stringify({ version: 1, port: 61234 }, null, 2)}\n`, "utf8");

  const spawnImpl = ((command: string, args: string[]) => {
    commands.push(`${path.basename(command)} ${args.join(" ")}`);
    const child = new EventEmitter() as import("node:child_process").ChildProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = null;
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  const supervisor = new DesktopPostgresSupervisor({
    bundleRootPath: bundleRoot,
    dataPath,
    logPath,
    metadataPath,
    platform: "darwin",
    arch: "arm64",
    probeTcpPortImpl: async () => undefined,
    spawnImpl,
  });

  try {
    const ready = await supervisor.ensureReady();

    assert.equal(ready.status.state, "healthy");
    assert.equal(ready.status.port, 61234);
    assert.equal(commands.some((entry) => entry.startsWith("pg_ctl start ")), false);
    assert.equal(commands.some((entry) => entry.startsWith("createdb ")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createBundleLayout(root: string): void {
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "lib"), { recursive: true });
  mkdirSync(path.join(root, "share"), { recursive: true });
  for (const binary of ["initdb", "postgres", "pg_ctl", "createdb"]) {
    writeFileSync(path.join(root, "bin", binary), "#!/bin/sh\n", "utf8");
  }
}
