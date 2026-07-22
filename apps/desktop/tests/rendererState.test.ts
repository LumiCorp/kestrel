import assert from "node:assert/strict";

import {
  acceptRendererPrompt,
  addRendererDraftAttachment,
  addRendererThread,
  appendRendererTranscript,
  archiveRendererThread,
  createRendererThread,
  getRendererTurnContinuation,
  getRendererThreadArchiveBlockReason,
  getTerminalWaitEventType,
  getTerminalWaitingPrompt,
  groupRendererThreads,
  isRendererThreadProjectLocked,
  MAX_PERSISTED_TRANSCRIPT_BYTES,
  MAX_PERSISTED_TRANSCRIPT_LINES_PER_THREAD,
  readDesktopRendererState,
  renameRendererThread,
  resolveRendererThreadProjectPath,
  restoreRendererThread,
  serializeDesktopRendererState,
  updateRendererDraft,
  updateRendererDraftAttachments,
  toDesktopRunHistory,
  undoArchiveRendererThread,
} from "../renderer/src/state.js";
import type { DesktopRunnerEvent } from "../src/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "new Desktop conversations default to the local checkout", () => {
  assert.equal(createRendererThread().workspaceMode, "local");
});

contractTest("desktop.hermetic", "Vite renderer preserves an explicitly managed persisted conversation", () => {
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

contractTest("desktop.hermetic", "Vite renderer hydrates legacy threads and preserves unknown persisted fields", () => {
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
  assert.equal(state.threads[0]?.titleLocked, true);
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

contractTest("desktop.hermetic", "Vite renderer repairs a blank persisted session without dropping its conversation", () => {
  const state = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "legacy-local-storage",
    capturedAt: "2026-07-22T12:00:00.000Z",
    entries: {
      "kchat:web:active-thread:v1": "thread-blank-session",
      "kchat:web:threads:v2": JSON.stringify({
        summaries: [{ id: "thread-blank-session", title: "Keep me" }],
        states: {
          "thread-blank-session": {
            sessionId: "   ",
            transcript: [{ role: "user", text: "Preserve this", timestamp: "2026-07-22T12:00:00.000Z" }],
          },
        },
      }),
    },
  });

  assert.equal(state.activeThreadId, "thread-blank-session");
  assert.equal(state.threads[0]?.title, "Keep me");
  assert.equal(state.threads[0]?.transcript[0]?.text, "Preserve this");
  assert.ok((state.threads[0]?.sessionId.length ?? 0) > 0);
  const serialized = JSON.parse(serializeDesktopRendererState(state)["kchat:web:threads:v2"]!) as {
    states: Record<string, { sessionId?: string }>;
  };
  assert.ok((serialized.states["thread-blank-session"]?.sessionId?.length ?? 0) > 0);
});

contractTest("desktop.hermetic", "Vite renderer persists and resumes the pending wait contract", () => {
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

contractTest("desktop.hermetic", "dialog messages persist inline and deduplicate by runtime message id", () => {
  let state = readDesktopRendererState(null);
  const threadId = state.activeThreadId;
  const line = {
    role: "assistant" as const,
    text: "The queue owns this transition.",
    timestamp: "2026-07-21T12:00:00.000Z",
    dialog: {
      messageId: "dialog-message-1",
      dialogId: "dialog-1",
      name: "Peregrine",
      childSessionId: "dialog-child-1",
      sender: "collaborator" as const,
    },
  };
  state = appendRendererTranscript(state, threadId, line);
  state = appendRendererTranscript(state, threadId, line);
  assert.equal(state.threads[0]?.transcript.length, 1);

  const restored = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "desktop-main",
    sourceAppVersion: "test",
    capturedAt: "2026-07-21T12:01:00.000Z",
    entries: serializeDesktopRendererState(state),
  });
  assert.deepEqual(restored.threads[0]?.transcript[0]?.dialog, line.dialog);
});

contractTest("desktop.hermetic", "Vite renderer persists a project binding on project conversations", () => {
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

contractTest("desktop.hermetic", "Vite renderer does not implicitly bind an unscoped conversation", () => {
  const state = readDesktopRendererState(null);
  const projectPath = resolveRendererThreadProjectPath({
    thread: state.threads[0]!,
  });

  assert.equal(projectPath, undefined);
});

contractTest("desktop.hermetic", "Vite renderer preserves a persisted conversation project binding", () => {
  const projectPath = resolveRendererThreadProjectPath({
    thread: { projectPath: "/workspace/project-a" },
  });

  assert.equal(projectPath, "/workspace/project-a");
});

contractTest("desktop.hermetic", "Vite renderer prefers the authoritative thread workspace over renderer selection", () => {
  const projectPath = resolveRendererThreadProjectPath({
    thread: { projectPath: "/workspace/project-a" },
    authoritativeProjectPath: "/workspace/project-b",
  });

  assert.equal(projectPath, "/workspace/project-b");
});

contractTest("desktop.hermetic", "manual conversation titles are trimmed, bounded, and locked against first-message replacement", () => {
  const initial = readDesktopRendererState(null);
  const threadId = initial.activeThreadId;
  const renamed = renameRendererThread(initial, threadId, `  ${"A".repeat(70)}  `);
  assert.equal(renamed.threads[0]?.title, `${"A".repeat(51)}...`);
  assert.equal(renamed.threads[0]?.titleLocked, true);
  assert.equal(isRendererThreadProjectLocked(renamed.threads[0]!), false);

  const messaged = appendRendererTranscript(renamed, threadId, {
    role: "user",
    text: "This would normally become the automatic title",
    timestamp: "2026-07-22T12:00:00.000Z",
  });
  assert.equal(messaged.threads[0]?.title, `${"A".repeat(51)}...`);
  assert.equal(isRendererThreadProjectLocked(messaged.threads[0]!), true);
  assert.equal(renameRendererThread(messaged, threadId, "   "), messaged);
});

contractTest("desktop.hermetic", "archive selects the next active conversation and restore supports Undo", () => {
  const first = { ...createRendererThread({ projectPath: "/workspace/a" }), id: "first", updatedAt: "2026-07-22T12:00:00.000Z" };
  const second = { ...createRendererThread({ projectPath: "/workspace/b" }), id: "second", updatedAt: "2026-07-22T11:00:00.000Z" };
  const initial = { ...readDesktopRendererState(null), activeThreadId: first.id, threads: [first, second] };
  const archived = archiveRendererThread(initial, first.id, {}, "2026-07-22T13:00:00.000Z");
  assert.equal(archived.activeThreadId, second.id);
  assert.equal(archived.threads.find((thread) => thread.id === first.id)?.archivedAt, "2026-07-22T13:00:00.000Z");

  const restored = restoreRendererThread(archived, first.id);
  assert.equal(restored.activeThreadId, first.id);
  assert.equal(restored.threads.find((thread) => thread.id === first.id)?.archivedAt, undefined);
});

contractTest("desktop.hermetic", "archive blocking explains running turns, pending waits, and actionable requests", () => {
  const thread = createRendererThread();
  assert.match(getRendererThreadArchiveBlockReason(thread, { runActive: true, actionableOperatorRequest: false }) ?? "", /Stop the running work/u);
  assert.match(getRendererThreadArchiveBlockReason({ ...thread, pendingWaitEventType: "user.reply" }, { runActive: false, actionableOperatorRequest: false }) ?? "", /pending wait/u);
  assert.match(getRendererThreadArchiveBlockReason(thread, { runActive: false, runtimeWaiting: true, actionableOperatorRequest: false }) ?? "", /pending wait/u);
  assert.match(getRendererThreadArchiveBlockReason(thread, { runActive: false, actionableOperatorRequest: true }) ?? "", /operator request/u);
  assert.equal(getRendererThreadArchiveBlockReason(thread, { runActive: false, actionableOperatorRequest: false }), undefined);
});

contractTest("desktop.hermetic", "generated attachments update their owning conversation after navigation", () => {
  const first = { ...createRendererThread(), id: "first", draft: "" };
  const second = { ...createRendererThread(), id: "second", draft: "Second draft" };
  const initial = { ...readDesktopRendererState(null), activeThreadId: second.id, threads: [first, second] };
  const updated = addRendererDraftAttachment(initial, first.id, {
    attachmentId: "attachment-1",
    generatedDraft: "Review the generated evidence.",
  });
  assert.equal(updated.activeThreadId, second.id);
  assert.deepEqual(updated.threads.find((thread) => thread.id === first.id)?.draftAttachmentIds, ["attachment-1"]);
  assert.equal(updated.threads.find((thread) => thread.id === first.id)?.draft, "Review the generated evidence.");
  assert.equal(updated.threads.find((thread) => thread.id === second.id)?.draft, "Second draft");
});

contractTest("desktop.hermetic", "generated attachments preserve draft limits and replacement policy", () => {
  const thread = { ...createRendererThread(), id: "thread", draft: "Keep me", draftAttachmentIds: Array.from({ length: 8 }, (_, index) => `attachment-${index}`) };
  const initial = { ...readDesktopRendererState(null), activeThreadId: thread.id, threads: [thread] };
  const overflow = addRendererDraftAttachment(initial, thread.id, { attachmentId: "overflow", generatedDraft: "Replace" });
  assert.equal(overflow.threads[0], thread);
  const available = { ...initial, threads: [{ ...thread, draftAttachmentIds: [] }] };
  const preserved = addRendererDraftAttachment(available, thread.id, { attachmentId: "new", generatedDraft: "Replace" });
  assert.equal(preserved.threads[0]?.draft, "Keep me");
  const replaced = addRendererDraftAttachment(available, thread.id, { attachmentId: "new", generatedDraft: "Replace", replaceDraft: true });
  assert.equal(replaced.threads[0]?.draft, "Replace");
});

contractTest("desktop.hermetic", "archiving the only active conversation creates an empty replacement in the same project", () => {
  const only = { ...createRendererThread({ projectPath: "/workspace/a" }), id: "only" };
  const initial = { ...readDesktopRendererState(null), activeThreadId: only.id, threads: [only] };
  const archived = archiveRendererThread(initial, only.id, {}, "2026-07-22T13:00:00.000Z");
  const replacement = archived.threads.find((thread) => thread.id === archived.activeThreadId);
  assert.notEqual(replacement?.id, only.id);
  assert.equal(replacement?.projectPath, "/workspace/a");
  assert.deepEqual(replacement?.transcript, []);
  const undone = undoArchiveRendererThread(archived, only.id, true);
  assert.equal(undone.activeThreadId, only.id);
  assert.deepEqual(undone.threads.map((thread) => thread.id), [only.id]);
  assert.equal(undone.threads[0]?.archivedAt, undefined);
});

contractTest("desktop.hermetic", "archived state persists without dropping unknown legacy fields", () => {
  const initial = readDesktopRendererState(null);
  const thread = initial.threads[0]!;
  const changed = {
    ...initial,
    threads: [{ ...thread, archivedAt: "2026-07-22T13:00:00.000Z", titleLocked: true, rawSummary: { legacySummary: "keep" }, rawState: { legacyState: "keep" } }],
  };
  const serialized = serializeDesktopRendererState(changed);
  const hydrated = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "desktop-renderer-vite",
    capturedAt: "2026-07-22T13:01:00.000Z",
    entries: serialized,
  });
  assert.equal(hydrated.threads[0]?.archivedAt, "2026-07-22T13:00:00.000Z");
  assert.equal(hydrated.threads[0]?.titleLocked, true);
  const reserialized = JSON.parse(serializeDesktopRendererState(hydrated)["kchat:web:threads:v2"]!) as { summaries: Record<string, unknown>[]; states: Record<string, Record<string, unknown>> };
  assert.equal(reserialized.summaries[0]?.legacySummary, "keep");
  assert.equal(reserialized.states[thread.id]?.legacyState, "keep");
});

contractTest("desktop.hermetic", "conversation groups order projects and threads while separating archive and unavailable paths", () => {
  const threads = [
    { ...createRendererThread({ projectPath: "/workspace/a" }), id: "a-old", title: "Alpha old", updatedAt: "2026-07-22T10:00:00.000Z" },
    { ...createRendererThread({ projectPath: "/workspace/a" }), id: "a-new", title: "Alpha new", updatedAt: "2026-07-22T12:00:00.000Z" },
    { ...createRendererThread({ projectPath: "/workspace/b" }), id: "b", title: "Beta", updatedAt: "2026-07-22T11:00:00.000Z" },
    { ...createRendererThread(), id: "none", title: "Loose", updatedAt: "2026-07-22T14:00:00.000Z" },
    { ...createRendererThread({ projectPath: "/removed/path" }), id: "missing", title: "Legacy", updatedAt: "2026-07-22T13:00:00.000Z" },
    { ...createRendererThread({ projectPath: "/workspace/b" }), id: "archived", title: "Archived beta", archivedAt: "2026-07-22T15:00:00.000Z", updatedAt: "2026-07-22T15:00:00.000Z" },
  ];
  const projects = [{ path: "/workspace/a", label: "Alpha project" }, { path: "/workspace/b", label: "Beta project" }];
  const activeGroups = groupRendererThreads({ threads, projects, archived: false });
  assert.deepEqual(activeGroups.map((group) => group.label), ["Alpha project", "Beta project", "No project", "Unavailable project"]);
  assert.deepEqual(activeGroups[0]?.threads.map((thread) => thread.id), ["a-new", "a-old"]);
  assert.deepEqual(groupRendererThreads({ threads, projects, archived: true }).flatMap((group) => group.threads.map((thread) => thread.id)), ["archived"]);
  assert.deepEqual(groupRendererThreads({ threads, projects, archived: false, query: "beta project" }).flatMap((group) => group.threads.map((thread) => thread.id)), ["b"]);
  assert.deepEqual(groupRendererThreads({ threads, projects, archived: false, query: "legacy" }).flatMap((group) => group.threads.map((thread) => thread.id)), ["missing"]);
});

contractTest("desktop.hermetic", "Vite renderer submits only tagged runtime waiting prompts as system history", () => {
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

contractTest("desktop.hermetic", "Vite renderer bounds persisted transcript history below the UI-state cap", () => {
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

contractTest("desktop.hermetic", "Vite renderer persists independent drafts, attachment references, and bounded prompt history", () => {
  let state = readDesktopRendererState(null);
  const firstId = state.activeThreadId;
  state = updateRendererDraft(state, firstId, "unfinished first");
  for (let index = 0; index < 105; index += 1) {
    state = acceptRendererPrompt(state, firstId, `prompt ${index}`);
  }
  state = updateRendererDraft(state, firstId, "unfinished first");
  state = updateRendererDraftAttachments(state, firstId, ["attachment-1"]);
  state = addRendererThread(state);
  const secondId = state.activeThreadId;
  state = updateRendererDraft(state, secondId, "unfinished second");

  const reloaded = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "vite-renderer",
    sourceAppVersion: "0.6.0",
    capturedAt: new Date().toISOString(),
    entries: serializeDesktopRendererState(state),
  });
  const first = reloaded.threads.find((thread) => thread.id === firstId)!;
  const second = reloaded.threads.find((thread) => thread.id === secondId)!;
  assert.equal(first.draft, "unfinished first");
  assert.deepEqual(first.draftAttachmentIds, ["attachment-1"]);
  assert.equal(first.promptHistory.length, 100);
  assert.equal(first.promptHistory[0], "prompt 5");
  assert.equal(second.draft, "unfinished second");
});

contractTest("desktop.hermetic", "Vite renderer migrates legacy per-thread composer drafts and prompt history", () => {
  const initial = readDesktopRendererState(null);
  const thread = initial.threads[0]!;
  const entries = serializeDesktopRendererState(initial);
  entries["kchat:web:composer-drafts:v1"] = JSON.stringify({ [thread.id]: "legacy draft" });
  entries["kchat:web:prompt-history:v1"] = JSON.stringify({ [thread.id]: ["one", "two"] });
  delete entries["kestrel:desktop-interaction-state:v1"];

  const migrated = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "legacy-local-storage",
    sourceAppVersion: "0.5.0",
    capturedAt: new Date().toISOString(),
    entries,
  });
  assert.equal(migrated.threads[0]?.draft, "legacy draft");
  assert.deepEqual(migrated.threads[0]?.promptHistory, ["one", "two"]);
});
