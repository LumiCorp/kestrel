import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRendererTranscript,
  getRendererTurnContinuation,
  getTerminalWaitEventType,
  getTerminalWaitingPrompt,
  MAX_PERSISTED_TRANSCRIPT_BYTES,
  MAX_PERSISTED_TRANSCRIPT_LINES_PER_THREAD,
  readDesktopRendererState,
  serializeDesktopRendererState,
  toDesktopRunHistory,
} from "../renderer/src/state.js";
import type { DesktopRunnerEvent } from "../src/contracts.js";

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

test("Vite renderer persists and resumes the pending wait contract", () => {
  const state = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "desktop-renderer-vite",
    sourceAppVersion: "0.5.1",
    capturedAt: "2026-07-09T12:00:00.000Z",
    entries: {
      "kchat:web:active-thread:v1": "thread-waiting",
      "kchat:web:threads:v2": JSON.stringify({
        summaries: [{
          id: "thread-waiting",
          title: "Waiting",
          updatedAt: "2026-07-09T12:00:00.000Z",
        }],
        states: {
          "thread-waiting": {
            sessionId: "session-waiting",
            transcript: [],
            pendingWaitEventType: "user.approval",
          },
        },
      }),
    },
  });

  assert.deepEqual(
    getRendererTurnContinuation(state.threads[0]!),
    {
      eventType: "user.approval",
      resumeFromWait: true,
      resumeBlockedRun: true,
    },
  );
  const terminal = {
    id: "event-waiting",
    type: "run.completed",
    ts: "2026-07-09T12:00:00.000Z",
    payload: {
      result: {
        assistantText: null,
        output: {
          status: "WAITING",
          sessionId: "session-waiting",
          runId: "run-waiting",
          waitFor: {
            eventType: "user.reply",
            metadata: { question: "Which workspace should I inspect?" },
          },
          quality: {
            citationCoverage: 0,
            unresolvedClaims: 0,
            reworkRate: 0,
            thrashIndex: 0,
          },
          errors: [],
          telemetry: {
            stepsExecuted: 1,
            toolCalls: 0,
            modelCalls: 1,
            durationMs: 1,
          },
        },
      },
    },
  } satisfies DesktopRunnerEvent;
  assert.equal(getTerminalWaitEventType(terminal), "user.reply");
  assert.deepEqual(getTerminalWaitingPrompt(terminal), {
    text: "Which workspace should I inspect?",
    runId: "run-waiting",
  });

  assert.deepEqual(
    getRendererTurnContinuation({
      ...state.threads[0]!,
      pendingWaitEventType: "user.reply",
    }),
    {
      eventType: "user.reply",
      resumeFromWait: true,
    },
  );

  const serialized = serializeDesktopRendererState(state);
  const hydrated = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "desktop-renderer-vite",
    sourceAppVersion: "0.5.1",
    capturedAt: "2026-07-09T12:01:00.000Z",
    entries: serialized,
  });
  assert.equal(
    hydrated.threads[0]?.pendingWaitEventType,
    "user.approval",
  );
});

test("Vite renderer submits only tagged runtime waiting prompts as system history", () => {
  const state = readDesktopRendererState(null);
  const thread = {
    ...state.threads[0]!,
    transcript: [
      {
        role: "user" as const,
        text: "Inspect the workspace",
        timestamp: "2026-07-09T12:00:00.000Z",
      },
      {
        role: "system" as const,
        text: "Local status: connected",
        timestamp: "2026-07-09T12:00:01.000Z",
      },
      {
        role: "system" as const,
        text: "Which workspace should I inspect?",
        timestamp: "2026-07-09T12:00:02.000Z",
        data: { kind: "runtime.waiting_prompt" as const, runId: "run-waiting" },
      },
    ],
  };

  assert.deepEqual(toDesktopRunHistory(thread), [
    {
      role: "user",
      text: "Inspect the workspace",
      timestamp: "2026-07-09T12:00:00.000Z",
    },
    {
      role: "system",
      text: "Which workspace should I inspect?",
      timestamp: "2026-07-09T12:00:02.000Z",
      data: { kind: "runtime.waiting_prompt", runId: "run-waiting" },
    },
  ]);
});

test("Vite renderer bounds persisted transcript history below the UI-state cap", () => {
  let state = readDesktopRendererState(null);
  const threadId = state.activeThreadId;
  for (let index = 0; index < 700; index += 1) {
    state = appendRendererTranscript(state, threadId, {
      role: index % 2 === 0 ? "user" : "assistant",
      text: `${index}: ${"x".repeat(20_000)}`,
      timestamp: new Date(Date.UTC(2026, 6, 9, 12, 0, index)).toISOString(),
    });
  }

  const serialized = serializeDesktopRendererState(state);
  const threadStore = serialized["kchat:web:threads:v2"]!;
  const parsed = JSON.parse(threadStore) as {
    states: Record<string, { transcript: Array<{ text: string }> }>;
  };
  const persisted = parsed.states[threadId]!.transcript;

  assert.ok(
    Buffer.byteLength(threadStore, "utf8") <
      MAX_PERSISTED_TRANSCRIPT_BYTES + 512 * 1024,
  );
  assert.ok(persisted.length <= MAX_PERSISTED_TRANSCRIPT_LINES_PER_THREAD);
  assert.match(persisted.at(-1)?.text ?? "", /^699:/u);
});
