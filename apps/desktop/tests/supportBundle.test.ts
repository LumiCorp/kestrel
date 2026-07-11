import assert from "node:assert/strict";
import test from "node:test";

import { buildDesktopSupportBundle } from "../src/supportBundle.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";

test("buildDesktopSupportBundle includes native runtime, database, settings, and project run summaries", () => {
  const bundle = buildDesktopSupportBundle({
    generatedAt: "2026-04-29T12:00:00.000Z",
    appInfo: { name: "Kestrel", version: "0.1.0", isPackaged: false },
    bootState: { phase: "ready", message: "Ready.", webUrl: "http://localhost:43100" },
    runtimeHealth: { state: "healthy", summary: "Runtime ready.", running: true, logPath: "/tmp/runtime.log" },
    databaseStatus: { state: "healthy", summary: "DB ready.", managed: true, initialized: true, running: true },
    settings: { ...createDefaultDesktopSettings(), openrouterApiKey: "sk-or-v1-secret" },
    projectRuns: [
      {
        runId: "run-1",
        projectPath: "/repo",
        manifestPath: "/repo/package.json",
        scriptName: "dev",
        packageManager: "pnpm",
        command: "pnpm run dev",
        status: "failed",
        startedAt: "2026-04-29T11:00:00.000Z",
        updatedAt: "2026-04-29T11:01:00.000Z",
        exitCode: 1,
        stdoutTail: ["Listening on http://localhost:3000"],
        stderrTail: ["Failed with token sk-or-v1-secret"],
      },
    ],
    paths: {
      runtimeLogPath: "/tmp/runtime.log",
      settingsPath: "/tmp/settings.json",
    },
  });

  assert.equal(bundle.app.surface, "desktop");
  assert.equal(bundle.projectRuns?.[0]?.status, "failed");
  assert.doesNotMatch(JSON.stringify(bundle), /sk-or-v1-secret/);
  assert.equal(bundle.redactions.count > 0, true);
});
