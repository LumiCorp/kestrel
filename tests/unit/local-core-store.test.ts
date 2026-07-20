import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureLocalCoreReady } from "../../src/localCore/ready.js";
import { resolveKestrelCoreHome, resolveLocalCorePaths } from "../../src/localCore/home.js";
import {
  archiveLocalCorePgliteStore,
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

test("Local Core archives the canonical PGlite store without touching legacy state", async () => {
  const productRoot = await mkdtemp(path.join("/tmp", "kcstore-archive-"));
  const alias = `${productRoot}-alias`;
  const now = new Date("2026-07-13T12:00:00.000Z");
  await symlink(productRoot, alias, "dir");
  try {
    const handle = await ensureLocalCoreStore({ homePath: alias });
    assert.ok(handle.pglitePath);
    await writeFile(path.join(handle.pglitePath, "active-sentinel"), "active\n", "utf8");
    const legacyRuntimePath = path.join(productRoot, "runtime.db");
    await writeFile(legacyRuntimePath, "legacy-runtime\n", "utf8");
    await closeLocalCoreStore(alias);

    const firstArchive = `${handle.pglitePath}.archived-2026-07-13T12-00-00-000Z`;
    await mkdir(firstArchive, { recursive: true });
    await writeFile(path.join(firstArchive, "collision-sentinel"), "existing\n", "utf8");

    const reset = await archiveLocalCorePgliteStore({ homePath: alias, now });

    assert.equal(reset.storePath, handle.pglitePath);
    assert.equal(reset.archivedStorePath, `${firstArchive}-1`);
    assert.equal(reset.resetAt, now.toISOString());
    assert.equal(reset.storePath.includes("-alias"), false);
    assert.equal(await readFile(path.join(firstArchive, "collision-sentinel"), "utf8"), "existing\n");
    assert.equal(await readFile(path.join(reset.archivedStorePath!, "active-sentinel"), "utf8"), "active\n");
    assert.equal((await stat(reset.archivedStorePath!)).mode & 0o777, 0o700);
    assert.equal(await readFile(legacyRuntimePath, "utf8"), "legacy-runtime\n");
    await assert.rejects(stat(reset.storePath), { code: "ENOENT" });
  } finally {
    await closeLocalCoreStore(productRoot);
    await rm(alias, { force: true });
    await rm(productRoot, { recursive: true, force: true });
  }
});

test("Local Core archives a leaf symlink without traversing its external target", async () => {
  const productRoot = await mkdtemp(path.join("/tmp", "kcstore-link-"));
  const externalTarget = await mkdtemp(path.join("/tmp", "kcstore-external-"));
  const paths = resolveLocalCorePaths(productRoot);
  try {
    await mkdir(path.dirname(paths.pgliteDataPath), { recursive: true });
    await writeFile(path.join(externalTarget, "external-sentinel"), "untouched\n", "utf8");
    await symlink(externalTarget, paths.pgliteDataPath, "dir");

    const reset = await archiveLocalCorePgliteStore({
      homePath: productRoot,
      now: new Date("2026-07-13T12:30:00.000Z"),
    });

    assert.ok(reset.archivedStorePath);
    assert.equal((await lstat(reset.archivedStorePath)).isSymbolicLink(), true);
    assert.equal(await realpath(reset.archivedStorePath), await realpath(externalTarget));
    assert.equal(await readFile(path.join(externalTarget, "external-sentinel"), "utf8"), "untouched\n");
    await assert.rejects(lstat(paths.pgliteDataPath), { code: "ENOENT" });
  } finally {
    await rm(productRoot, { recursive: true, force: true });
    await rm(externalTarget, { recursive: true, force: true });
  }
});

test("Local Core reports a missing PGlite store without inventing an archive", async () => {
  const productRoot = await mkdtemp(path.join("/tmp", "kcstore-missing-"));
  try {
    const reset = await archiveLocalCorePgliteStore({
      homePath: productRoot,
      now: new Date("2026-07-13T13:00:00.000Z"),
    });
    assert.equal(reset.archivedStorePath, null);
    assert.equal(reset.storePath, resolveLocalCorePaths(productRoot).pgliteDataPath);
  } finally {
    await rm(productRoot, { recursive: true, force: true });
  }
});

test("Local Core makes existing state and PGlite authority roots private", async () => {
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

test("Local Core PGlite initialization honors its explicit migration directory", async () => {
  const productRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-explicit-migrations-"));
  const migrationsDir = path.join(productRoot, "runtime-assets", "db", "migrations");
  try {
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(
      path.join(migrationsDir, "001_explicit_marker.sql"),
      "CREATE TABLE explicit_migration_marker (id INTEGER PRIMARY KEY);\n",
      "utf8",
    );

    const handle = await ensureLocalCoreStore({
      homePath: productRoot,
      migrationsDir,
    });
    const result = await handle.executor.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'explicit_migration_marker'",
    );
    assert.deepEqual(result.rows, [{ table_name: "explicit_migration_marker" }]);
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
