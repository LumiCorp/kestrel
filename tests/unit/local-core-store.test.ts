import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureLocalCoreReady } from "../../src/localCore/ready.js";
import { resolveKestrelCoreHome, resolveLocalCorePaths } from "../../src/localCore/home.js";
import {
  closeLocalCoreStore,
  ensureLocalCoreStore,
} from "../../src/localCore/store.js";

test("the 0.6 Core initializes one PGlite store without touching 0.5 state", async () => {
  const productRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-epoch-"));
  const legacyManifestPath = path.join(productRoot, "core", "manifest.json");
  const legacyRuntimePath = path.join(productRoot, "runtime.db");
  const legacyManifest = "{\"version\":1,\"sentinel\":\"0.5\"}\n";
  const legacyRuntime = "0.5-runtime-sentinel\n";

  try {
    await mkdir(path.dirname(legacyManifestPath), { recursive: true });
    await writeFile(legacyManifestPath, legacyManifest, "utf8");
    await writeFile(legacyRuntimePath, legacyRuntime, "utf8");

    const status = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: productRoot },
      platform: "darwin",
      coreVersion: "0.6.0",
      runMigrations: true,
      now: new Date("2026-07-13T12:00:00.000Z"),
    });
    const home = resolveKestrelCoreHome({ KESTREL_CORE_HOME: productRoot }, "darwin");
    const paths = resolveLocalCorePaths(productRoot);
    const canonicalPaths = resolveLocalCorePaths(await realpath(paths.stateRootPath));

    assert.equal(status.state, "healthy");
    assert.equal(status.home.productRootPath, productRoot);
    assert.equal(status.home.homePath, path.join(productRoot, "state", "0.6"));
    assert.equal(status.dbMode, "pglite");
    assert.equal(status.database.pglitePath, canonicalPaths.pgliteDataPath);
    assert.equal(status.databaseUrl, undefined);
    assert.equal(status.migrations?.state, "healthy");
    assert.equal(status.migrations?.migrated, true);
    assert.equal(home.homePath, paths.stateRootPath);
    assert.equal((await stat(canonicalPaths.pgliteDataPath)).isDirectory(), true);

    const [first, second] = await Promise.all([
      ensureLocalCoreStore({ homePath: productRoot }),
      ensureLocalCoreStore({ homePath: paths.stateRootPath, mode: "managed" }),
    ]);
    assert.equal(first, second);
    assert.equal(first.mode, "pglite");
    assert.equal(first.stateRootPath, canonicalPaths.stateRootPath);
    assert.deepEqual(
      (await first.executor.query<{ local_core_ready: number }>("SELECT 1 AS local_core_ready")).rows,
      [{ local_core_ready: 1 }],
    );

    assert.equal(await readFile(legacyManifestPath, "utf8"), legacyManifest);
    assert.equal(await readFile(legacyRuntimePath, "utf8"), legacyRuntime);
    assert.equal(JSON.parse(await readFile(paths.manifestPath, "utf8")).stateEpoch, "0.6");
  } finally {
    await closeLocalCoreStore(productRoot);
    await rm(productRoot, { recursive: true, force: true });
  }
});

test("Local Core store keys canonicalize symlink aliases to one PGlite authority", async () => {
  const productRoot = await mkdtemp(path.join("/tmp", "kcstore-real-"));
  const alias = `${productRoot}-alias`;
  await symlink(productRoot, alias, "dir");
  try {
    const [first, second] = await Promise.all([
      ensureLocalCoreStore({ homePath: productRoot }),
      ensureLocalCoreStore({ homePath: alias }),
    ]);
    const canonicalPaths = resolveLocalCorePaths(
      await realpath(resolveLocalCorePaths(productRoot).stateRootPath),
    );

    assert.equal(first, second);
    assert.equal(first.stateRootPath, canonicalPaths.stateRootPath);
    assert.equal(first.pglitePath, canonicalPaths.pgliteDataPath);
    assert.equal(first.pglitePath?.includes("-alias"), false);

    await closeLocalCoreStore(alias);
    const reopened = await ensureLocalCoreStore({ homePath: productRoot });
    assert.notEqual(reopened, first);
  } finally {
    await closeLocalCoreStore(productRoot);
    await rm(alias, { force: true });
    await rm(productRoot, { recursive: true, force: true });
  }
});

test("Local Core makes existing state and PGlite authority roots private", {
  skip: process.platform === "win32",
}, async () => {
  const productRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-private-store-"));
  const paths = resolveLocalCorePaths(productRoot);
  try {
    await chmod(productRoot, 0o755);
    await mkdir(paths.stateRootPath, { recursive: true, mode: 0o755 });
    await mkdir(paths.pgliteDataPath, { recursive: true, mode: 0o755 });
    await chmod(paths.stateRootPath, 0o755);
    await chmod(paths.pgliteDataPath, 0o755);

    const blockedStatus = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: productRoot },
      platform: "darwin",
      coreVersion: "0.6.0",
      databaseMode: "external",
    });
    assert.equal(blockedStatus.state, "blocked");
    assert.equal((await stat(paths.stateRootPath)).mode & 0o777, 0o700);

    await ensureLocalCoreStore({ homePath: productRoot });

    assert.equal((await stat(paths.pgliteDataPath)).mode & 0o777, 0o700);
  } finally {
    await closeLocalCoreStore(productRoot);
    await rm(productRoot, { recursive: true, force: true });
  }
});

test("external Postgres readiness rejects an unreachable explicit database", async () => {
  const productRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-external-store-"));
  const databaseUrl = "postgres://kestrel:kestrel@127.0.0.1:1/kestrel?connect_timeout=1";
  try {
    const status = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: productRoot },
      platform: "darwin",
      coreVersion: "0.6.0",
      databaseMode: "external",
      externalDatabaseUrl: databaseUrl,
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.dbMode, "external");
    assert.equal(status.databaseUrl, databaseUrl);
    assert.equal(status.database.state, "blocked");
    assert.equal(status.database.initialized, false);
    assert.equal(status.database.running, false);
    assert.equal(status.database.identityVerified, false);
    assert.equal(status.lastError?.code, "LOCAL_CORE_EXTERNAL_DATABASE_INIT_FAILED");
    await assert.rejects(ensureLocalCoreStore({
      homePath: resolveLocalCorePaths(productRoot).stateRootPath,
      mode: "external",
      externalDatabaseUrl: databaseUrl,
    }));
  } finally {
    await closeLocalCoreStore(productRoot);
    await rm(productRoot, { recursive: true, force: true });
  }
});
