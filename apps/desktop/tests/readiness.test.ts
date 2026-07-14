import assert from "node:assert/strict";
import test from "node:test";

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

test("provider setup owns the summary when no higher-severity check is blocked", () => {
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
      summary: "Runtime is ready.",
      running: true,
      recentStdout: [],
      recentStderr: [],
    },
  });

  assert.equal(readiness.summary.state, "degraded");
  assert.equal(readiness.summary.detail, "Choose a model provider to finish Desktop setup.");
});
