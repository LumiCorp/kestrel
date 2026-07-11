import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRendererTranscript,
  readDesktopRendererState,
  serializeDesktopRendererState,
} from "../renderer/src/state.js";

test("Vite renderer hydrates legacy threads and preserves unknown persisted fields", () => {
  const state = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "legacy-local-storage",
    sourceAppVersion: "0.5.1",
    capturedAt: "2026-07-09T12:00:00.000Z",
    entries: {
      "kchat:web:active-thread:v1": "thread-1",
      "kchat:web:theme-mode": "dark",
      "kchat:web:threads:v2": JSON.stringify({
        summaries: [{
          id: "thread-1",
          title: "Existing thread",
          createdAt: "2026-07-09T10:00:00.000Z",
          updatedAt: "2026-07-09T11:00:00.000Z",
          titleLocked: true,
        }],
        states: {
          "thread-1": {
            sessionId: "session-1",
            interactionMode: "plan",
            runtimeThreadId: "runtime-thread-1",
            transcript: [{
              role: "user",
              text: "Keep this message",
              timestamp: "2026-07-09T11:00:00.000Z",
            }],
          },
        },
      }),
    },
  });

  assert.equal(state.activeThreadId, "thread-1");
  assert.equal(state.theme, "dark");
  assert.equal(state.threads[0]?.mode, "plan");

  const next = appendRendererTranscript(state, "thread-1", {
    role: "assistant",
    text: "Preserved",
    timestamp: "2026-07-09T12:01:00.000Z",
  });
  const serialized = serializeDesktopRendererState(next);
  const store = JSON.parse(serialized["kchat:web:threads:v2"] ?? "{}") as {
    summaries: Array<Record<string, unknown>>;
    states: Record<string, Record<string, unknown>>;
  };
  assert.equal(store.summaries[0]?.titleLocked, true);
  assert.equal(store.states["thread-1"]?.runtimeThreadId, "runtime-thread-1");
  assert.equal((store.states["thread-1"]?.transcript as unknown[]).length, 2);
});
