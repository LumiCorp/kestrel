import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireCoreMigrationLock,
  readCoreMigrationLock,
  resolveLocalCorePaths,
  runLocalCoreMigrations,
} from "../../src/localCore/index.js";

test("migration lock classifies missing, live, stale, incompatible, and invalid locks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-migration-lock-"));
  const paths = resolveLocalCorePaths(home);
  try {
    assert.equal((await readCoreMigrationLock({ homePath: home })).state, "missing");

    const live = await acquireCoreMigrationLock({
      homePath: home,
      coreVersion: "0.5.0-beta.0",
      schemaVersion: 1,
      ownerExecutable: "/Applications/Kestrel.app",
      ownerPid: 123,
      now: new Date("2026-06-17T12:00:00.000Z"),
    });
    assert.equal(live.state, "live");

    assert.equal((await readCoreMigrationLock({
      homePath: home,
      currentCoreVersion: "0.5.0-beta.0",
      currentSchemaVersion: 1,
      now: new Date("2026-06-17T12:00:10.000Z"),
    })).state, "live");
    assert.equal((await readCoreMigrationLock({
      homePath: home,
      currentCoreVersion: "0.5.0-beta.1",
      currentSchemaVersion: 1,
      now: new Date("2026-06-17T12:00:10.000Z"),
    })).state, "incompatible");
    assert.equal((await readCoreMigrationLock({
      homePath: home,
      currentCoreVersion: "0.5.0-beta.0",
      currentSchemaVersion: 2,
      now: new Date("2026-06-17T12:00:10.000Z"),
    })).state, "incompatible");
    assert.equal((await readCoreMigrationLock({
      homePath: home,
      currentCoreVersion: "0.5.0-beta.0",
      currentSchemaVersion: 1,
      now: new Date("2026-06-17T12:01:00.000Z"),
    })).state, "stale");

    await writeFile(paths.migrationLockPath, "{", "utf8");
    assert.equal((await readCoreMigrationLock({ homePath: home })).state, "repair_required");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migration lock uses one shared owner under concurrent migration attempts", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-migration-lock-concurrent-"));
  try {
    const [first, second] = await Promise.all([
      acquireCoreMigrationLock({
        homePath: home,
        coreVersion: "0.5.0-beta.0",
        schemaVersion: 1,
        ownerExecutable: "/Applications/Kestrel.app",
        ownerPid: 101,
      }),
      acquireCoreMigrationLock({
        homePath: home,
        coreVersion: "0.5.0-beta.0",
        schemaVersion: 1,
        ownerExecutable: "/usr/local/bin/kestrel",
        ownerPid: 202,
      }),
    ]);

    assert.equal(first.state, "live");
    assert.equal(second.state, "live");
    assert.equal(first.lock.ownerPid, second.lock.ownerPid);
    assert.equal((await readCoreMigrationLock({ homePath: home })).state, "live");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runLocalCoreMigrations runs under the Core migration lock and injects the explicit database URL", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-migration-run-"));
  try {
    let observedDatabaseUrl: string | undefined;
    let observedEnvDatabaseUrl: string | undefined;
    let observedDisableDotEnv: string | undefined;
    const status = await runLocalCoreMigrations({
      homePath: home,
      coreVersion: "0.5.0-beta.0",
      schemaVersion: 1,
      ownerExecutable: "/Applications/Kestrel.app",
      databaseUrl: "postgres://kestrel:kestrel@localhost/kestrel?host=%2Ftmp%2Fkestrel",
      repoRoot: "/repo",
      now: new Date("2026-06-17T12:00:00.000Z"),
      runCommandImpl: async (input) => {
        observedDatabaseUrl = input.databaseUrl;
        observedEnvDatabaseUrl = input.env.DATABASE_URL;
        observedDisableDotEnv = input.env.KESTREL_DISABLE_DOTENV;
        return { ok: true, stdout: "", stderr: "", code: 0 };
      },
    });

    assert.equal(status.state, "healthy");
    assert.equal(status.migrated, true);
    assert.equal(observedDatabaseUrl, "postgres://kestrel:kestrel@localhost/kestrel?host=%2Ftmp%2Fkestrel");
    assert.equal(observedEnvDatabaseUrl, observedDatabaseUrl);
    assert.equal(observedDisableDotEnv, "1");
    assert.equal((await readCoreMigrationLock({ homePath: home })).state, "missing");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runLocalCoreMigrations reports command failure without shell-owned decisions", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-migration-fail-"));
  try {
    const status = await runLocalCoreMigrations({
      homePath: home,
      coreVersion: "0.5.0-beta.0",
      schemaVersion: 1,
      ownerExecutable: "/Applications/Kestrel.app",
      databaseUrl: "postgres://kestrel:kestrel@localhost/kestrel?host=%2Ftmp%2Fkestrel",
      repoRoot: "/repo",
      now: new Date("2026-06-17T12:00:00.000Z"),
      runCommandImpl: async () => ({
        ok: false,
        stdout: "",
        stderr: "relation already exists",
        code: 1,
      }),
    });

    assert.equal(status.state, "blocked");
    assert.equal(status.migrated, false);
    assert.equal(status.lastError?.code, "LOCAL_CORE_MIGRATION_FAILED");
    assert.match(status.lastError?.message ?? "", /relation already exists/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
