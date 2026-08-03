import test from "node:test";
import assert from "node:assert/strict";

import { loadDesktopUiState } from "../renderer/src/uiStateBootstrap.js";

test("Desktop opens with a fresh workspace when persisted UI state is incompatible", async () => {
  const result = await loadDesktopUiState(async () => {
    throw new Error("Desktop legacy UI state includes unsupported key 'kestrel:desktop-interaction-state:v1'.");
  });

  assert.deepEqual(result, {
    state: null,
    persistenceEnabled: false,
  });
});

test("Desktop retains persistence when persisted UI state loads", async () => {
  const state = {
    version: "desktop-ui-state-v1" as const,
    source: "vite-renderer" as const,
    sourceAppVersion: "0.6.0",
    capturedAt: "2026-07-27T12:00:00.000Z",
    entries: {},
  };

  const result = await loadDesktopUiState(async () => state);

  assert.deepEqual(result, {
    state,
    persistenceEnabled: true,
  });
});
