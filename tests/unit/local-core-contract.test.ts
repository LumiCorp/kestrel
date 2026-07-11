import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireCoreLock,
  createCoreManifest,
  ensureLocalCoreReady,
  readCoreLock,
  readCoreManifest,
  resolveKestrelCoreHome,
  resolveLocalCorePaths,
  writeCoreManifest,
} from "../../src/localCore/index.js";

test("resolveKestrelCoreHome uses the macOS product root by default", () => {
  const resolved = resolveKestrelCoreHome({}, "darwin");

  assert.equal(resolved.source, "default");
  assert.equal(resolved.isolated, false);
  assert.equal(resolved.homePath, path.join(os.homedir(), "Library", "Application Support", "Kestrel"));
});

test("resolveKestrelCoreHome treats KESTREL_HOME as explicit isolated dev state", () => {
  const resolved = resolveKestrelCoreHome({ KESTREL_HOME: "~/kestrel-isolated" }, "darwin");

  assert.equal(resolved.source, "isolated_dev_home");
  assert.equal(resolved.isolated, true);
  assert.equal(resolved.homePath, path.join(os.homedir(), "kestrel-isolated"));
});

test("resolveKestrelCoreHome gives explicit Core home precedence over isolated dev KESTREL_HOME", () => {
  const resolved = resolveKestrelCoreHome({
    KESTREL_CORE_HOME: "~/Library/Application Support/Kestrel",
    KESTREL_HOME: "~/kestrel-isolated",
  }, "darwin");

  assert.equal(resolved.source, "explicit_core_home");
  assert.equal(resolved.isolated, false);
  assert.equal(resolved.homePath, path.join(os.homedir(), "Library", "Application Support", "Kestrel"));
});

test("Core manifest round-trips canonical paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-manifest-"));
  try {
    const manifest = createCoreManifest({
      homePath: home,
      coreVersion: "0.5.0-beta.0",
      capabilities: ["shell.status", "local-core.contract.v1"],
      now: new Date("2026-06-17T12:00:00.000Z"),
    });

    await writeCoreManifest(home, manifest);
    const restored = await readCoreManifest(home);

    assert.equal(restored?.coreVersion, "0.5.0-beta.0");
    assert.equal(restored?.schemaVersion, 1);
    assert.deepEqual(restored?.capabilities, ["local-core.contract.v1", "shell.status"]);
    assert.equal(restored?.paths.manifestPath, resolveLocalCorePaths(home).manifestPath);
    assert.equal(restored?.paths.apiSocketPath, resolveLocalCorePaths(home).apiSocketPath);
    assert.equal(restored?.paths.apiTokenPath, resolveLocalCorePaths(home).apiTokenPath);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("readCoreLock classifies missing, live, stale, incompatible, and invalid locks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-lock-"));
  const paths = resolveLocalCorePaths(home);
  try {
    assert.equal((await readCoreLock({ homePath: home })).state, "missing");

    const live = await acquireCoreLock({
      homePath: home,
      coreVersion: "0.5.0-beta.0",
      ownerExecutable: "/Applications/Kestrel.app",
      schemaVersion: 1,
      now: new Date("2026-06-17T12:00:00.000Z"),
      socketPath: paths.apiSocketPath,
      databaseSocketPath: paths.postgresSocketPath,
    });
    assert.equal(live.state, "live");
    assert.equal(live.lockPath, paths.lockPath);
    assert.equal(live.lock.schemaVersion, 1);
    assert.equal(live.lock.socketPath, paths.apiSocketPath);
    assert.equal(live.lock.databaseSocketPath, paths.postgresSocketPath);
    assert.equal((await readCoreLock({
      homePath: home,
      currentCoreVersion: "0.5.0-beta.0",
      now: new Date("2026-06-17T12:00:10.000Z"),
    })).state, "live");
    assert.equal((await readCoreLock({
      homePath: home,
      currentCoreVersion: "0.5.0-beta.1",
      now: new Date("2026-06-17T12:00:10.000Z"),
    })).state, "incompatible");
    assert.equal((await readCoreLock({
      homePath: home,
      currentCoreVersion: "0.5.0-beta.0",
      now: new Date("2026-06-17T12:01:00.000Z"),
    })).state, "stale");

    await writeFile(paths.lockPath, "{", "utf8");
    assert.equal((await readCoreLock({ homePath: home })).state, "repair_required");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("acquireCoreLock uses one shared owner under concurrent shell attempts", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-lock-concurrent-"));
  try {
    const [first, second] = await Promise.all([
      acquireCoreLock({
        homePath: home,
        coreVersion: "0.5.0-beta.0",
        ownerExecutable: "/Applications/Kestrel.app",
        ownerPid: 101,
      }),
      acquireCoreLock({
        homePath: home,
        coreVersion: "0.5.0-beta.0",
        ownerExecutable: "/usr/local/bin/kestrel",
        ownerPid: 202,
      }),
    ]);

    assert.equal(first.state, "live");
    assert.equal(second.state, "live");
    assert.equal(first.lock.ownerPid, second.lock.ownerPid);
    assert.equal((await readCoreLock({ homePath: home })).state, "live");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureLocalCoreReady creates shared contract directories and status", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-ready-"));
  try {
    const status = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.5.0-beta.0",
      databaseMode: "external",
      externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
      now: new Date("2026-06-17T12:00:00.000Z"),
    });

    assert.equal(status.state, "healthy");
    assert.equal(status.home.homePath, home);
    assert.equal(status.home.source, "explicit_core_home");
    assert.equal(status.dbMode, "external");
    assert.equal(status.database.managed, false);
    assert.equal(status.databaseUrl, "postgres://kestrel:kestrel@example.invalid/kestrel");
    assert.equal(status.lock.state, "live");
    assert.equal(status.manifest?.coreVersion, "0.5.0-beta.0");
    assert.match(await readFile(resolveLocalCorePaths(home).manifestPath, "utf8"), /local-core\.contract\.v1/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureLocalCoreReady accepts the 0.5.0 manifest for the 0.5.1 bridge without rewriting it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-051-bridge-"));
  try {
    await writeCoreManifest(home, createCoreManifest({
      homePath: home,
      coreVersion: "0.5.0-beta.0",
      now: new Date("2026-06-17T12:00:00.000Z"),
    }));
    const manifestBefore = await readFile(resolveLocalCorePaths(home).manifestPath, "utf8");

    const status = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.5.1",
      databaseMode: "external",
      externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
      now: new Date("2026-07-10T12:00:00.000Z"),
    });

    assert.equal(status.state, "healthy");
    assert.equal(status.manifest?.coreVersion, "0.5.0-beta.0");
    assert.equal(
      await readFile(resolveLocalCorePaths(home).manifestPath, "utf8"),
      manifestBefore,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureLocalCoreReady blocks versions outside the explicit 0.5.1 bridge", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-incompatible-"));
  try {
    await writeCoreManifest(home, createCoreManifest({
      homePath: home,
      coreVersion: "0.5.0-beta.1",
    }));

    const status = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.5.1",
      databaseMode: "external",
      externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.lastError?.code, "LOCAL_CORE_MANIFEST_VERSION_INCOMPATIBLE");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureLocalCoreReady does not silently use inherited DATABASE_URL for external mode", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-external-"));
  try {
    const status = await ensureLocalCoreReady({
      env: {
        KESTREL_CORE_HOME: home,
        DATABASE_URL: "postgres://host-postgres.example.invalid/kestrel",
      },
      platform: "darwin",
      coreVersion: "0.5.0-beta.0",
      databaseMode: "external",
      now: new Date("2026-06-17T12:00:00.000Z"),
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.lastError?.code, "LOCAL_CORE_EXTERNAL_DATABASE_URL_REQUIRED");
    assert.equal(status.databaseUrl, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
