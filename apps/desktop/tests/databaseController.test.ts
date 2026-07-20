import assert from "node:assert/strict";
import test from "node:test";

import type { LocalCoreStatus } from "../../../src/localCore/contracts.js";
import { createCoreOwnedDesktopDatabaseController } from "../src/databaseController.js";

test("Core-owned Desktop database accepts healthy PGlite without a database URL", async () => {
  const status = pgliteStatus();
  const controller = createCoreOwnedDesktopDatabaseController({
    ensureReady: async () => status,
  });

  const ready = await controller.prepare();

  assert.equal(ready.databaseUrl, undefined);
  assert.deepEqual(ready.status, {
    state: "healthy",
    summary: "Kestrel Local Core PGlite database ready.",
    managed: true,
    initialized: true,
    running: true,
  });
});

test("Core-owned Desktop database still rejects unavailable PGlite", async () => {
  const status = pgliteStatus({
    state: "degraded",
    initialized: false,
    running: false,
    lastError: {
      code: "LOCAL_CORE_PGLITE_UNAVAILABLE",
      message: "PGlite is unavailable.",
    },
  });
  const controller = createCoreOwnedDesktopDatabaseController({
    ensureReady: async () => status,
  });

  await assert.rejects(
    controller.prepare(),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "LOCAL_CORE_PGLITE_UNAVAILABLE");
      return true;
    },
  );
});

test("Core-owned Desktop database accepts verified external storage without returning its URL", async () => {
  const controller = createCoreOwnedDesktopDatabaseController({
    async ensureReady() {
      return { ...pgliteStatus(), dbMode: "external", database: { mode: "external", state: "healthy", summary: "External ready", managed: false, initialized: true, running: true, identityVerified: true } };
    },
  });
  const ready = await controller.prepare();
  assert.equal(ready.databaseUrl, undefined);
  assert.equal(ready.status.managed, false);
  assert.equal(ready.status.running, true);
});

function pgliteStatus(
  databaseOverrides: Partial<LocalCoreStatus["database"]> = {},
): LocalCoreStatus {
  const homePath = "/tmp/kestrel-desktop-pglite";
  return {
    state: "healthy",
    summary: "Kestrel Local Core ready.",
    home: {
      productRootPath: homePath,
      homePath,
      stateEpoch: "0.6",
      source: "isolated_dev_home",
      isolated: true,
      platform: "darwin",
    },
    lock: {
      state: "missing",
      lockPath: `${homePath}/state/0.6/core/lock.json`,
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
      pglitePath: `${homePath}/state/0.6/core/database/pglite`,
      ...databaseOverrides,
    },
    settingsReady: true,
    workspaceRegistryReady: true,
    diagnosticsPath: `${homePath}/state/0.6/diagnostics`,
    logsPath: `${homePath}/state/0.6/logs`,
  };
}
