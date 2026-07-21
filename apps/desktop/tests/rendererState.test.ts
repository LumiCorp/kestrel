import assert from "node:assert/strict";
import test from "node:test";

import {
  addRendererThread,
  appendRendererTranscript,
  createRendererThread,
  getRendererTurnContinuation,
  getTerminalWaitEventType,
  getTerminalWaitingPrompt,
  MAX_PERSISTED_TRANSCRIPT_BYTES,
  MAX_PERSISTED_TRANSCRIPT_LINES_PER_THREAD,
  readDesktopRendererState,
  resolveRendererThreadProjectPath,
  serializeDesktopRendererState,
  toDesktopRunHistory,
} from "../renderer/src/state.js";
import type { DesktopRunnerEvent } from "../src/contracts.js";

test("new Desktop conversations default to the local checkout", () => {
  assert.equal(createRendererThread().workspaceMode, "local");
});

test("Vite renderer preserves an explicitly managed persisted conversation", () => {
  const state = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "desktop-renderer-vite",
    capturedAt: "2026-07-20T12:00:00.000Z",
    entries: {
      "kchat:web:active-thread:v1": "thread-managed",
      "kchat:web:threads:v2": JSON.stringify({
        summaries: [
          {
            id: "thread-managed",
            title: "Managed",
            updatedAt: "2026-07-20T12:00:00.000Z",
          },
        ],
        states: {
          "thread-managed": {
            sessionId: "session-managed",
            workspaceMode: "managed",
            transcript: [],
          },
        },
      }),
    },
  });

  assert.equal(state.threads[0]?.workspaceMode, "managed");
});

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
        summaries: [
          {
            id: "thread-1",
            title: "Existing thread",
            createdAt: "2026-07-09T10:00:00.000Z",
            updatedAt: "2026-07-09T11:00:00.000Z",
            titleLocked: true,
          },
        ],
        states: {
          "thread-1": {
            sessionId: "session-1",
            interactionMode: "plan",
            runtimeThreadId: "runtime-thread-1",
            openFiles: ["/workspace/project/src/app.ts"],
            diffScopeKind: "pull_request",
            diffRevision: "17",
            diffView: "side-by-side",
            transcript: [
              {
                role: "user",
                text: "Keep this message",
                timestamp: "2026-07-09T11:00:00.000Z",
              },
            ],
          },
        },
      }),
    },
  });

  assert.equal(state.activeThreadId, "thread-1");
  assert.equal(state.theme, "dark");
  assert.equal(state.threads[0]?.mode, "plan");
  assert.equal(state.threads[0]?.workspaceMode, "local");
  assert.equal(state.threads[0]?.workspaceBaseRef, "HEAD");
  assert.equal(state.threads[0]?.workspaceSetupExecutable, "");
  assert.deepEqual(state.threads[0]?.openFiles, [
    "/workspace/project/src/app.ts",
  ]);
  assert.deepEqual(
    [
      state.threads[0]?.diffScopeKind,
      state.threads[0]?.diffRevision,
      state.threads[0]?.diffView,
    ],
    ["pull_request", "17", "side-by-side"],
  );

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
  assert.equal(store.states["thread-1"]?.workspaceMode, "local");
  assert.equal(store.states["thread-1"]?.workspaceBaseRef, "HEAD");
  assert.equal(store.states["thread-1"]?.workspaceSetupExecutable, "");
  assert.deepEqual(store.states["thread-1"]?.openFiles, [
    "/workspace/project/src/app.ts",
  ]);
  assert.deepEqual(
    [
      store.states["thread-1"]?.diffScopeKind,
      store.states["thread-1"]?.diffRevision,
      store.states["thread-1"]?.diffView,
    ],
    ["pull_request", "17", "side-by-side"],
  );
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
        summaries: [
          {
            id: "thread-waiting",
            title: "Waiting",
            updatedAt: "2026-07-09T12:00:00.000Z",
          },
        ],
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

  assert.deepEqual(getRendererTurnContinuation(state.threads[0]!), {
    eventType: "user.approval",
    resumeFromWait: true,
    resumeBlockedRun: true,
  });
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
  assert.equal(hydrated.threads[0]?.pendingWaitEventType, "user.approval");
});

test("Vite renderer persists a project binding on project conversations", () => {
  const initial = readDesktopRendererState(null);
  const scoped = addRendererThread(initial, {
    projectPath: "/workspace/project-a",
  });
  const serialized = serializeDesktopRendererState(scoped);
  const hydrated = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "desktop-renderer-vite",
    sourceAppVersion: "0.6.0",
    capturedAt: "2026-07-14T12:00:00.000Z",
    entries: serialized,
  });

  assert.equal(hydrated.activeThreadId, scoped.activeThreadId);
  assert.equal(hydrated.threads[0]?.projectPath, "/workspace/project-a");
  assert.equal(hydrated.threads[1]?.projectPath, undefined);
});

test("Vite renderer binds an unscoped conversation turn to the active registered project", () => {
  const state = readDesktopRendererState(null);
  const projectPath = resolveRendererThreadProjectPath({
    thread: state.threads[0]!,
    activeProjectPath: "/workspace/project-b",
    projects: [
      { path: "/workspace/project-a" },
      { path: "/workspace/project-b" },
    ],
  });

  assert.equal(projectPath, "/workspace/project-b");
});

test("Vite renderer preserves a conversation project binding over the currently viewed project", () => {
  const projectPath = resolveRendererThreadProjectPath({
    thread: { projectPath: "/workspace/project-a" },
    activeProjectPath: "/workspace/project-b",
    projects: [
      { path: "/workspace/project-a" },
      { path: "/workspace/project-b" },
    ],
  });

  assert.equal(projectPath, "/workspace/project-a");
});

test("Vite renderer prefers the authoritative thread workspace over renderer selection", () => {
  const projectPath = resolveRendererThreadProjectPath({
    thread: { projectPath: "/workspace/project-a" },
    authoritativeProjectPath: "/workspace/project-b",
    activeProjectPath: "/workspace/project-c",
    projects: [
      { path: "/workspace/project-a" },
      { path: "/workspace/project-b" },
      { path: "/workspace/project-c" },
    ],
  });

  assert.equal(projectPath, "/workspace/project-b");
});

test("Vite renderer submits only tagged runtime waiting prompts as system history", () => {
  const state = readDesktopRendererState(null);
  const attachment = {
    attachmentId: "attachment-1",
    threadId: state.threads[0]!.sessionId,
    filename: "app.ts",
    mimeType: "text/plain",
    sizeBytes: 5,
    sha256: "a".repeat(64),
    kind: "text" as const,
    text: "hello",
  };
  const thread = {
    ...state.threads[0]!,
    transcript: [
      {
        role: "user" as const,
        text: "Inspect the workspace",
        timestamp: "2026-07-09T12:00:00.000Z",
        attachments: [attachment],
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
      attachments: [attachment],
    },
    {
      role: "system",
      text: "Which workspace should I inspect?",
      timestamp: "2026-07-09T12:00:02.000Z",
      data: { kind: "runtime.waiting_prompt", runId: "run-waiting" },
    },
  ]);

  const serialized = serializeDesktopRendererState({
    ...state,
    threads: [thread],
  });
  const hydrated = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "desktop-renderer-vite",
    sourceAppVersion: "0.6.0",
    capturedAt: "2026-07-09T12:01:00.000Z",
    entries: serialized,
  });
  assert.deepEqual(hydrated.threads[0]?.transcript[0]?.attachments, [
    attachment,
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
