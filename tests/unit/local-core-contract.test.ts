import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireCoreLock,
  createCoreManifest,
  ensureLocalCoreReady,
  parseLocalCoreRuntimeStoreReset,
  parseLocalCoreRuntimeStoreResetRequest,
  parseLocalCoreRuntimeStoreResetResult,
  parseLocalCoreStatus,
  readCoreLock,
  readCoreManifest,
  releaseCoreLock,
  resolveKestrelCoreHome,
  resolveLocalCorePaths,
  writeCoreManifest,
} from "../../src/localCore/index.js";
import { closeLocalCoreStore } from "../../src/localCore/store.js";

function canonicalLocalCoreStatus(): Record<string, unknown> {
  const productRootPath = "/tmp/kestrel";
  const homePath = path.join(productRootPath, "state", "0.6");
  const paths = resolveLocalCorePaths(homePath);
  return {
    state: "healthy",
    summary: "Kestrel Local Core ready.",
    home: {
      productRootPath,
      homePath,
      stateEpoch: "0.6",
      source: "explicit_core_home",
      isolated: false,
      platform: "darwin",
    },
    manifest: {
      version: 2,
      stateEpoch: "0.6",
      coreVersion: "0.6.0",
      schemaVersion: 1,
      homePath,
      dbMode: "pglite",
      capabilities: ["local-core.contract.v2", "local-core.store.pglite"],
      paths,
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T12:00:00.000Z",
    },
    lock: {
      state: "live",
      lockPath: paths.lockPath,
      lock: {
        version: 1,
        ownerPid: 123,
        authorityId: "authority-123",
        ownerExecutable: "/usr/local/bin/kestrel",
        coreVersion: "0.6.0",
        schemaVersion: 1,
        startedAt: "2026-07-13T12:00:00.000Z",
        heartbeatAt: "2026-07-13T12:00:01.000Z",
        socketPath: paths.apiSocketPath,
      },
    },
    dbMode: "pglite",
    database: {
      mode: "pglite",
      state: "healthy",
      summary: "Kestrel Local Core PGlite database ready.",
      managed: true,
      initialized: true,
      running: true,
      identityVerified: true,
      pglitePath: paths.pgliteDataPath,
      dataPath: paths.pgliteDataPath,
    },
    migrations: {
      state: "healthy",
      summary: "Core-owned PGlite schema ready.",
      schemaVersion: 1,
      lock: {
        state: "missing",
        lockPath: paths.migrationLockPath,
      },
      migrated: true,
    },
    settingsReady: true,
    workspaceRegistryReady: true,
    diagnosticsPath: paths.diagnosticsPath,
    logsPath: paths.logsPath,
  };
}

test("resolveKestrelCoreHome isolates the default macOS product root in the 0.6 state epoch", () => {
  const resolved = resolveKestrelCoreHome({}, "darwin");
  const productRoot = path.join(os.homedir(), "Library", "Application Support", "Kestrel");

  assert.equal(resolved.source, "default");
  assert.equal(resolved.isolated, false);
  assert.equal(resolved.productRootPath, productRoot);
  assert.equal(resolved.homePath, path.join(productRoot, "state", "0.6"));
  assert.equal(resolved.stateEpoch, "0.6");
});

test("resolveKestrelCoreHome treats KESTREL_HOME as explicit isolated dev state", () => {
  const resolved = resolveKestrelCoreHome({ KESTREL_HOME: "~/kestrel-isolated" }, "darwin");

  assert.equal(resolved.source, "isolated_dev_home");
  assert.equal(resolved.isolated, true);
  assert.equal(resolved.productRootPath, path.join(os.homedir(), "kestrel-isolated"));
  assert.equal(resolved.homePath, path.join(os.homedir(), "kestrel-isolated", "state", "0.6"));
});

test("resolveKestrelCoreHome gives explicit Core home precedence over isolated dev KESTREL_HOME", () => {
  const resolved = resolveKestrelCoreHome({
    KESTREL_CORE_HOME: "~/Library/Application Support/Kestrel",
    KESTREL_HOME: "~/kestrel-isolated",
  }, "darwin");

  assert.equal(resolved.source, "explicit_core_home");
  assert.equal(resolved.isolated, false);
  assert.equal(resolved.productRootPath, path.join(os.homedir(), "Library", "Application Support", "Kestrel"));
  assert.equal(resolved.homePath, path.join(os.homedir(), "Library", "Application Support", "Kestrel", "state", "0.6"));
});

test("resolveKestrelCoreHome keeps an already canonical state root stable", () => {
  const stateRoot = "/tmp/kestrel-product/state/0.6";
  const resolved = resolveKestrelCoreHome({ KESTREL_CORE_HOME: stateRoot }, "darwin");

  assert.equal(resolved.productRootPath, "/tmp/kestrel-product");
  assert.equal(resolved.homePath, stateRoot);
});

test("Local Core runtime-store reset contracts require explicit confirmation and canonical output", () => {
  assert.deepEqual(parseLocalCoreRuntimeStoreResetRequest({ confirm: true }), {
    confirm: true,
  });
  assert.throws(
    () => parseLocalCoreRuntimeStoreResetRequest({}),
    /confirm: true/u,
  );
  assert.throws(
    () => parseLocalCoreRuntimeStoreResetRequest({ confirm: true, path: "/tmp/other" }),
    /unsupported field 'path'/u,
  );

  const reset = parseLocalCoreRuntimeStoreReset({
    storePath: "/tmp/kestrel/state/0.6/core/database/pglite",
    archivedStorePath: null,
    resetAt: "2026-07-13T12:00:00.000Z",
  });
  assert.equal(reset.archivedStorePath, null);
  assert.throws(
    () => parseLocalCoreRuntimeStoreReset({
      ...reset,
      archivedStorePath: reset.storePath,
    }),
    /archive must differ/u,
  );
  assert.throws(
    () => parseLocalCoreRuntimeStoreReset({
      ...reset,
      resetAt: "2026-07-13 12:00:00Z",
    }),
    /canonical ISO timestamp/u,
  );

  const status = canonicalLocalCoreStatus();
  const result = parseLocalCoreRuntimeStoreResetResult({
    ok: true,
    reset,
    status,
  });
  assert.deepEqual(result.status, status);
  assert.throws(
    () => parseLocalCoreRuntimeStoreResetResult({
      ok: true,
      reset,
      status,
      secret: "not-allowed",
    }),
    /unsupported field 'secret'/u,
  );
  assert.throws(
    () => parseLocalCoreRuntimeStoreResetResult({
      ok: true,
      reset,
      status: { state: "healthy" },
    }),
    /status\.summary must be a non-empty string/u,
  );
});

test("Local Core status parser validates the complete nested boundary contract", () => {
  const status = canonicalLocalCoreStatus();
  assert.deepEqual(parseLocalCoreStatus(status), status);

  const incomplete = structuredClone(status);
  delete incomplete.workspaceRegistryReady;
  assert.throws(
    () => parseLocalCoreStatus(incomplete),
    /status\.workspaceRegistryReady must be a boolean/u,
  );

  const malformed = structuredClone(status);
  (malformed.database as Record<string, unknown>).running = "yes";
  assert.throws(
    () => parseLocalCoreStatus(malformed),
    /status\.database\.running must be a boolean/u,
  );

  const unknownNestedField = structuredClone(status);
  (unknownNestedField.lock as Record<string, unknown>).token = "not-allowed";
  assert.throws(
    () => parseLocalCoreStatus(unknownNestedField),
    /status\.lock includes unsupported field 'token'/u,
  );
});

test("Core manifest round-trips canonical paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-manifest-"));
  try {
    const manifest = createCoreManifest({
      homePath: home,
      coreVersion: "0.6.0",
      capabilities: ["shell.status", "local-core.contract.v2"],
      now: new Date("2026-06-17T12:00:00.000Z"),
    });

    await writeCoreManifest(home, manifest);
    const restored = await readCoreManifest(home);
    const canonicalPaths = resolveLocalCorePaths(
      await realpath(resolveLocalCorePaths(home).stateRootPath),
    );

    assert.equal(restored?.version, 2);
    assert.equal(restored?.stateEpoch, "0.6");
    assert.equal(restored?.coreVersion, "0.6.0");
    assert.equal(restored?.schemaVersion, 1);
    assert.equal(restored?.dbMode, "pglite");
    assert.deepEqual(restored?.capabilities, ["local-core.contract.v2", "shell.status"]);
    assert.equal(restored?.paths.manifestPath, canonicalPaths.manifestPath);
    assert.equal(restored?.paths.apiSocketPath, canonicalPaths.apiSocketPath);
    assert.equal(restored?.paths.apiTokenPath, canonicalPaths.apiTokenPath);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Core manifest accepts another path spelling for the same physical state root", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcmanifest-real-"));
  const alias = `${home}-alias`;
  await symlink(home, alias, "dir");
  try {
    await writeCoreManifest(home, createCoreManifest({
      homePath: home,
      coreVersion: "0.6.0",
    }));

    const restored = await readCoreManifest(alias);
    const canonicalStateRoot = await realpath(resolveLocalCorePaths(home).stateRootPath);

    assert.equal(restored?.homePath, canonicalStateRoot);
    assert.equal(restored?.paths.stateRootPath, canonicalStateRoot);
  } finally {
    await rm(alias, { force: true });
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

test("readCoreLock treats dead or expired old-version owners as stale before version incompatibility", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-lock-version-precedence-"));
  try {
    const acquired = await acquireCoreLock({
      homePath: home,
      coreVersion: "0.6.0",
      ownerExecutable: "/Applications/Kestrel.app",
      ownerPid: 101,
      now: new Date("2026-07-13T12:00:00.000Z"),
    });
    assert.equal(acquired.state, "live");

    assert.equal((await readCoreLock({
      homePath: home,
      currentCoreVersion: "0.6.1",
      now: new Date("2026-07-13T12:00:10.000Z"),
      isPidAlive: () => true,
    })).state, "incompatible");
    assert.equal((await readCoreLock({
      homePath: home,
      currentCoreVersion: "0.6.1",
      now: new Date("2026-07-13T12:00:10.000Z"),
      isPidAlive: () => false,
    })).state, "stale");
    assert.equal((await readCoreLock({
      homePath: home,
      currentCoreVersion: "0.6.1",
      now: new Date("2026-07-13T12:01:00.000Z"),
    })).state, "stale");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("acquireCoreLock recovers a dead old-version lock without stealing a live old-version owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-lock-upgrade-"));
  const staleHome = path.join(root, "stale-owner");
  const liveHome = path.join(root, "live-owner");
  try {
    await acquireCoreLock({
      homePath: staleHome,
      coreVersion: "0.6.0",
      ownerExecutable: "/Applications/Kestrel.app",
      ownerPid: 101,
      now: new Date("2026-07-13T12:00:00.000Z"),
    });
    const recovered = await acquireCoreLock({
      homePath: staleHome,
      coreVersion: "0.6.1",
      ownerExecutable: "/usr/local/bin/kestrel",
      ownerPid: 202,
      now: new Date("2026-07-13T12:00:10.000Z"),
      isPidAlive: () => false,
    });
    assert.equal(recovered.state, "live");
    assert.equal(recovered.lock.coreVersion, "0.6.1");
    assert.equal(recovered.lock.ownerPid, 202);

    await acquireCoreLock({
      homePath: liveHome,
      coreVersion: "0.6.0",
      ownerExecutable: "/Applications/Kestrel.app",
      ownerPid: 303,
      now: new Date("2026-07-13T12:00:00.000Z"),
    });
    const blocked = await acquireCoreLock({
      homePath: liveHome,
      coreVersion: "0.6.1",
      ownerExecutable: "/usr/local/bin/kestrel",
      ownerPid: 404,
      now: new Date("2026-07-13T12:00:10.000Z"),
      isPidAlive: () => true,
    });
    assert.equal(blocked.state, "incompatible");
    assert.equal(blocked.lock.coreVersion, "0.6.0");
    assert.equal(blocked.lock.ownerPid, 303);
  } finally {
    await rm(root, { recursive: true, force: true });
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

test("concurrent stale-lock recovery elects one authority without deleting the winner", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-lock-stale-concurrent-"));
  const paths = resolveLocalCorePaths(home);
  const acquisitionPath = `${paths.lockPath}.acquire`;
  try {
    await acquireCoreLock({
      homePath: home,
      coreVersion: "0.6.0",
      ownerExecutable: "/Applications/Kestrel-old.app",
      ownerPid: 101,
      authorityId: "stale-authority",
      now: new Date("2026-07-13T12:00:00.000Z"),
    });
    await writeFile(acquisitionPath, "test-held-acquisition\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    const attempts = [
      acquireCoreLock({
        homePath: home,
        coreVersion: "0.6.0",
        ownerExecutable: "/usr/local/bin/kestrel-a",
        ownerPid: 201,
        authorityId: "authority-a",
        isPidAlive: (pid) => pid !== 101,
      }),
      acquireCoreLock({
        homePath: home,
        coreVersion: "0.6.0",
        ownerExecutable: "/usr/local/bin/kestrel-b",
        ownerPid: 202,
        authorityId: "authority-b",
        isPidAlive: (pid) => pid !== 101,
      }),
    ] as const;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(JSON.parse(await readFile(paths.lockPath, "utf8")).authorityId, "stale-authority");
    await rm(acquisitionPath, { force: true });

    const [first, second] = await Promise.all(attempts);
    assert.equal(first.state, "live");
    assert.equal(second.state, "live");
    if (first.state !== "live" || second.state !== "live") {
      assert.fail("Both stale-lock contenders must observe the elected live authority.");
    }
    assert.equal(first.lock.authorityId, second.lock.authorityId);
    assert.equal(first.lock.ownerPid, second.lock.ownerPid);
    const persisted = JSON.parse(await readFile(paths.lockPath, "utf8")) as {
      authorityId?: string | undefined;
      ownerPid?: number | undefined;
    };
    assert.equal(persisted.authorityId, first.lock.authorityId);
    assert.equal(persisted.ownerPid, first.lock.ownerPid);
    await assert.rejects(readFile(acquisitionPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(acquisitionPath, { force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("release racing stale-lock recovery cannot delete the replacement authority", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-lock-release-race-"));
  const paths = resolveLocalCorePaths(home);
  const acquisitionPath = `${paths.lockPath}.acquire`;
  try {
    await acquireCoreLock({
      homePath: home,
      coreVersion: "0.6.0",
      ownerExecutable: "/Applications/Kestrel-old.app",
      ownerPid: 101,
      authorityId: "old-authority",
    });
    await writeFile(acquisitionPath, "test-held-acquisition\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    const release = releaseCoreLock({
      homePath: home,
      coreVersion: "0.6.0",
      ownerPid: 101,
      authorityId: "old-authority",
    });
    const replacement = acquireCoreLock({
      homePath: home,
      coreVersion: "0.6.0",
      ownerExecutable: "/usr/local/bin/kestrel-new",
      ownerPid: 202,
      authorityId: "replacement-authority",
      isPidAlive: (pid) => pid !== 101,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(JSON.parse(await readFile(paths.lockPath, "utf8")).authorityId, "old-authority");
    await rm(acquisitionPath, { force: true });

    const [, replacementResult] = await Promise.all([release, replacement] as const);
    assert.equal(replacementResult.state, "live");
    if (replacementResult.state !== "live") {
      assert.fail("Stale-lock recovery must install a replacement authority.");
    }
    assert.equal(replacementResult.lock.authorityId, "replacement-authority");
    const persisted = JSON.parse(await readFile(paths.lockPath, "utf8")) as {
      authorityId?: string | undefined;
      ownerPid?: number | undefined;
    };
    assert.equal(persisted.authorityId, "replacement-authority");
    assert.equal(persisted.ownerPid, 202);
  } finally {
    await rm(acquisitionPath, { force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureLocalCoreReady blocks an unreachable external database", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-ready-"));
  const databaseUrl = "postgres://kestrel:kestrel@127.0.0.1:1/kestrel?connect_timeout=1";
  try {
    const status = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.5.0-beta.0",
      databaseMode: "external",
      externalDatabaseUrl: databaseUrl,
      now: new Date("2026-06-17T12:00:00.000Z"),
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.home.productRootPath, home);
    assert.equal(status.home.homePath, path.join(home, "state", "0.6"));
    assert.equal(status.home.source, "explicit_core_home");
    assert.equal(status.dbMode, "external");
    assert.equal(status.database.managed, false);
    assert.equal(status.database.initialized, false);
    assert.equal(status.database.running, false);
    assert.equal(status.database.identityVerified, false);
    assert.equal(status.databaseUrl, undefined);
    assert.equal(status.lastError?.code, "LOCAL_CORE_EXTERNAL_DATABASE_INIT_FAILED");
    assert.equal(status.lock.state, "live");
    assert.equal(status.manifest?.coreVersion, "0.5.0-beta.0");
    assert.match(await readFile(resolveLocalCorePaths(home).manifestPath, "utf8"), /local-core\.contract\.v2/u);
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureLocalCoreReady updates executable metadata without changing compatible epoch state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-version-update-"));
  try {
    await writeCoreManifest(home, createCoreManifest({
      homePath: home,
      coreVersion: "0.6.0",
      now: new Date("2026-06-17T12:00:00.000Z"),
    }));

    const status = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.6.1",
      now: new Date("2026-07-10T12:00:00.000Z"),
    });

    assert.equal(status.state, "healthy");
    assert.equal(status.manifest?.coreVersion, "0.6.1");
    assert.equal(status.manifest?.stateEpoch, "0.6");
    assert.equal(status.manifest?.createdAt, "2026-06-17T12:00:00.000Z");
    assert.equal(status.manifest?.updatedAt, "2026-07-10T12:00:00.000Z");
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureLocalCoreReady blocks an incompatible state schema independently of executable version", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-schema-incompatible-"));
  try {
    await writeCoreManifest(home, createCoreManifest({
      homePath: home,
      coreVersion: "0.6.0",
      schemaVersion: 2,
    }));

    const status = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.6.1",
      schemaVersion: 1,
      databaseMode: "external",
      externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.lastError?.code, "LOCAL_CORE_SCHEMA_VERSION_INCOMPATIBLE");
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureLocalCoreReady blocks a manifest from a different state epoch", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-epoch-incompatible-"));
  try {
    await writeCoreManifest(home, {
      ...createCoreManifest({
        homePath: home,
        coreVersion: "0.6.0",
      }),
      stateEpoch: "0.5",
    });

    const status = await ensureLocalCoreReady({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.6.1",
      databaseMode: "external",
      externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.lastError?.code, "LOCAL_CORE_STATE_EPOCH_INCOMPATIBLE");
  } finally {
    await closeLocalCoreStore(home);
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
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});
