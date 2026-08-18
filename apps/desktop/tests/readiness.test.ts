import test from "node:test";
import assert from "node:assert/strict";

import { deriveDesktopReadiness } from "../../../src/desktopShell/readiness.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";


test("blocked database owns the readiness summary ahead of provider setup", () => {
  const settings = createDefaultDesktopSettings();
  const readiness = deriveDesktopReadiness({
    isDesktopApp: true,
    settings,
    settingsLoaded: true,
    resourcesReady: true,
    bridgeConnected: true,
    projectCount: 0,
    databaseStatus: {
      state: "blocked",
      summary: "Local Core database could not start.",
      managed: true,
      initialized: false,
      running: false,
    },
  });

  assert.equal(readiness.summary.state, "blocked");
  assert.equal(readiness.summary.detail, "Local Core database could not start.");
  const database = readiness.items.find((item) => item.id === "database");
  assert.deepEqual(database?.action, {
    label: "Retry Database",
    command: "restart_database",
  });
});

test("provider setup is an explicit starting state rather than degraded runtime", () => {
  const settings = createDefaultDesktopSettings();
  const readiness = deriveDesktopReadiness({
    isDesktopApp: true,
    settings,
    settingsLoaded: true,
    resourcesReady: true,
    bridgeConnected: true,
    projectCount: 0,
    databaseStatus: {
      state: "healthy",
      summary: "Local Core database is ready.",
      managed: true,
      initialized: true,
      running: true,
    },
    runtimeHealth: {
      state: "healthy",
      connection: "connected",
      summary: "Runtime is ready.",
      running: true,
      recentStdout: [],
      recentStderr: [],
    },
  });

  assert.equal(readiness.summary.state, "starting");
  assert.equal(
    readiness.summary.detail,
    "Runtime starts after you choose and verify a model provider.",
  );
});

test("capability verification evidence overrides legacy plaintext-key readiness", () => {
  const settings = {
    ...createDefaultDesktopSettings(),
    providerSelectionCompletedAt: "2026-08-04T12:00:00.000Z",
  };
  const readiness = deriveDesktopReadiness({
    isDesktopApp: true,
    settings,
    providerConfigured: true,
    bootState: { phase: "ready", message: "Desktop ready." },
    settingsLoaded: true,
    resourcesReady: true,
    bridgeConnected: true,
    projectCount: 1,
    databaseStatus: {
      state: "healthy",
      summary: "Local Core database is ready.",
      managed: true,
      initialized: true,
      running: true,
    },
    runtimeHealth: {
      state: "healthy",
      connection: "connected",
      summary: "Runtime is ready.",
      running: true,
      recentStdout: [],
      recentStderr: [],
    },
  });

  assert.equal(
    readiness.items.find((item) => item.id === "provider")?.state,
    "ready",
  );
  assert.equal(readiness.summary.state, "ready");
});

test("Local Core profile incompatibility directs the user to update Desktop", () => {
  const readiness = deriveDesktopReadiness({
    isDesktopApp: true,
    settings: createDefaultDesktopSettings(),
    settingsLoaded: true,
    resourcesReady: true,
    bridgeConnected: true,
    projectCount: 0,
    databaseStatus: {
      state: "healthy",
      summary: "Local Core database is ready.",
      managed: true,
      initialized: true,
      running: true,
    },
    runtimeHealth: {
      state: "blocked",
      connection: "disconnected",
      summary: "Kestrel Local Core needs an update.",
      code: "desktop.local_core_execution_profile_incompatible",
      running: false,
    },
  });

  assert.deepEqual(readiness.items.find((item) => item.id === "runner")?.action, {
    label: "Update Kestrel",
    command: "reinstall_desktop",
  });
});
