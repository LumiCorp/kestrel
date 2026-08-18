import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopConversationCommandAdapter,
  resolveDesktopInterruptAuthority,
  resolveDesktopRefreshedInterruptAuthority,
} from "../renderer/src/conversationCommandAdapter.js";

test("Desktop command adapter delegates native commands and installs authority", async () => {
  const calls: string[] = [];
  const routed = {
    threadId: "thread-1",
    sessionId: "session-1",
    messageId: "message-1",
    disposition: "started" as const,
    view: { thread: { threadId: "thread-1" }, followUpQueue: { items: [] } },
  } as never;
  const adapter = createDesktopConversationCommandAdapter({
    submitConversationMessage: async () => {
      calls.push("submit");
      return routed;
    },
    submitOperatorControl: async () => {
      calls.push("answer");
      return { view: {} } as never;
    },
    cancelRun: async () => {
      calls.push("cancel");
      return { status: "cancelled", event: {} } as never;
    },
    resolveInterrupt: () => ({ sessionId: "session-1", runId: "run-1" }),
    installInterrupt: () => calls.push("installed-cancel"),
    switchMode: (mode) => calls.push(`mode:${mode}`),
  });
  await adapter.startTurn({ request: {} as never, install: () => calls.push("installed-submit") });
  await adapter.answerInteraction({
    requestId: "request-1",
    transport: "operator",
    request: { action: "reply", threadId: "thread-1", requestId: "request-1" },
    install: () => calls.push("installed-answer"),
  });
  await adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });
  assert.deepEqual(calls, [
    "submit",
    "installed-submit",
    "answer",
    "installed-answer",
    "cancel",
    "installed-cancel",
  ]);
});

test("Desktop mode switch retries one native interaction answer", async () => {
  const calls: string[] = [];
  const adapter = createDesktopConversationCommandAdapter({
    submitConversationMessage: async () => ({}) as never,
    submitOperatorControl: async () => {
      calls.push("answer");
      return { view: {} } as never;
    },
    cancelRun: async () => ({ status: "already_stopped" }),
    resolveInterrupt: () => undefined,
    installInterrupt: () => undefined,
    switchMode: (mode) => calls.push(`mode:${mode}`),
  });
  const command = {
    recommendationId: "request-1",
    mode: "build" as const,
    answer: {
      requestId: "request-1",
      transport: "operator" as const,
      request: { action: "reply" as const, threadId: "thread-1", requestId: "request-1" },
      install: () => calls.push("installed"),
    },
  };
  await adapter.switchModeAndRetry(command);
  await adapter.switchModeAndRetry(command);
  assert.deepEqual(calls, ["mode:build", "answer", "installed"]);
});

test("Desktop interrupt authority resolves only the view's explicit active run", () => {
  const staleView = {
    thread: { threadId: "thread-1" },
    activeRun: { runId: "run-2", status: "RUNNING" },
    conversationTurns: [{ turnId: "turn-1", activeRunId: "run-1" }],
  } as never;
  const refreshedView = {
    thread: { threadId: "thread-1" },
    activeRun: { runId: "run-2", status: "RUNNING" },
    conversationTurns: [{ turnId: "turn-2", activeRunId: "run-2" }],
  } as never;

  assert.equal(resolveDesktopInterruptAuthority(staleView), undefined);
  assert.deepEqual(resolveDesktopInterruptAuthority(refreshedView), {
    threadId: "thread-1",
    turnId: "turn-2",
  });
  assert.equal(resolveDesktopInterruptAuthority(refreshedView, "run-3"), undefined);
  assert.deepEqual(resolveDesktopInterruptAuthority(refreshedView, "run-2"), {
    threadId: "thread-1",
    turnId: "turn-2",
  });
});

test("Desktop refreshed interrupt authority never retargets Stop to a newer run", () => {
  const refreshedView = {
    thread: { threadId: "thread-1" },
    activeRun: { runId: "run-2", status: "RUNNING" },
    conversationTurns: [{ turnId: "turn-2", activeRunId: "run-2" }],
  } as never;

  assert.deepEqual(resolveDesktopRefreshedInterruptAuthority(refreshedView, "run-1"), {
    status: "run_changed",
    activeRunId: "run-2",
  });
  assert.deepEqual(resolveDesktopRefreshedInterruptAuthority(refreshedView), {
    status: "target",
    target: { threadId: "thread-1", turnId: "turn-2" },
  });
});
