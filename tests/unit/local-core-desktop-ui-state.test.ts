import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopUiStateStore } from "../../src/localCore/desktopUiState.js";
import { resolveLocalCorePaths } from "../../src/localCore/home.js";

test("Desktop UI state serializes concurrent snapshots without trailing bytes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-ui-state-"));
  const storeA = new DesktopUiStateStore(home);
  const storeB = new DesktopUiStateStore(home);
  try {
    const first = storeA.sync({
      version: "desktop-ui-state-v1",
      source: "vite-renderer",
      sourceAppVersion: "0.6.0",
      capturedAt: "2026-07-21T12:00:00.000Z",
      entries: {
        "kchat:web:threads:v2": "x".repeat(8 * 1024 * 1024),
      },
    });
    const second = storeB.sync({
      version: "desktop-ui-state-v1",
      source: "vite-renderer",
      sourceAppVersion: "0.6.0",
      capturedAt: "2026-07-21T12:00:01.000Z",
      entries: {
        "kchat:web:threads:v2": "small",
      },
    });

    await Promise.all([first, second]);

    const settingsPath = resolveLocalCorePaths(home).settingsPath;
    const persisted = JSON.parse(
      await readFile(path.join(settingsPath, "desktop-ui-state.json"), "utf8"),
    ) as { capturedAt?: string; entries?: Record<string, string> };
    assert.equal(persisted.capturedAt, "2026-07-21T12:00:01.000Z");
    assert.equal(persisted.entries?.["kchat:web:threads:v2"], "small");
    assert.deepEqual(
      (await readdir(settingsPath)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
