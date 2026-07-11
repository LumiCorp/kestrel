import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_UI_STATE_SOURCE,
  DESKTOP_UI_STATE_VERSION,
  parseDesktopLegacyUiStateEntries,
  parseDesktopUiStateV1,
} from "../../src/desktopShell/contracts.js";

test("Desktop UI state accepts only the versioned legacy storage contract", () => {
  const state = parseDesktopUiStateV1({
    version: DESKTOP_UI_STATE_VERSION,
    source: DESKTOP_UI_STATE_SOURCE,
    sourceAppVersion: "0.5.1",
    capturedAt: "2026-07-09T12:00:00.000Z",
    entries: {
      "kchat:web:theme-mode": "dark",
      "kchat:web:active-thread:v1": "thread-1",
    },
  });

  assert.deepEqual(state.entries, {
    "kchat:web:theme-mode": "dark",
    "kchat:web:active-thread:v1": "thread-1",
  });
  assert.equal(state.sourceAppVersion, "0.5.1");
});

test("Desktop UI state rejects unknown storage keys and non-string values", () => {
  assert.throws(
    () => parseDesktopLegacyUiStateEntries({ "provider-api-key": "secret" }),
    /unsupported key/u,
  );
  assert.throws(
    () => parseDesktopLegacyUiStateEntries({ "kchat:web:theme-mode": { mode: "dark" } }),
    /must be a string/u,
  );
});
