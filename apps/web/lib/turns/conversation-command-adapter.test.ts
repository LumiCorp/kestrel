import assert from "node:assert/strict";
import test from "node:test";

import {
  createKestrelOneConversationCommandAdapter,
  executeKestrelOneQueueSubmission,
} from "./conversation-command-adapter";

test("Kestrel One command adapter preserves native start, queue, interaction, and interrupt transports", async () => {
  const calls: string[] = [];
  const adapter = createKestrelOneConversationCommandAdapter({
    interrupt: async ({ turnId }) => { calls.push(`interrupt:${turnId}`); },
    switchMode: async (mode) => { calls.push(`mode:${mode}`); },
  });
  await adapter.startTurn({ intent: "start", execute: async () => { calls.push("start"); } });
  await adapter.queueTurn({ intent: "queue", execute: async () => { calls.push("queue"); } });
  await adapter.answerInteraction({
    requestId: "request-1",
    source: "runtime",
    execute: async () => { calls.push("answer"); },
  });
  await adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });
  assert.deepEqual(calls, ["start", "queue", "answer", "interrupt:turn-1"]);
});

test("Kestrel One mode switch retries exactly once", async () => {
  const calls: string[] = [];
  const adapter = createKestrelOneConversationCommandAdapter({
    interrupt: async () => undefined,
    switchMode: async (mode) => { calls.push(`mode:${mode}`); },
  });
  const command = {
    recommendationId: "request-1",
    mode: "plan" as const,
    answer: {
      requestId: "request-1",
      source: "runtime" as const,
      execute: async () => { calls.push("answer"); },
    },
  };
  await adapter.switchModeAndRetry(command);
  await adapter.switchModeAndRetry(command);
  assert.deepEqual(calls, ["mode:plan", "answer"]);
});

test("Kestrel One keeps an acknowledged queue submission when refresh fails", async () => {
  const calls: string[] = [];
  const receipt = await executeKestrelOneQueueSubmission({
    submit: async () => {
      calls.push("submit");
      return { turnId: "turn-queued" };
    },
    install: ({ turnId }) => { calls.push(`install:${turnId}`); },
    refresh: async () => {
      calls.push("refresh");
      throw new Error("snapshot unavailable");
    },
    onRefreshFailure: (error) => {
      calls.push(`warning:${error instanceof Error ? error.message : String(error)}`);
    },
  });

  assert.deepEqual(receipt, { turnId: "turn-queued" });
  assert.deepEqual(calls, [
    "submit",
    "install:turn-queued",
    "refresh",
    "warning:snapshot unavailable",
  ]);
});

test("Kestrel One does not install or refresh a rejected queue submission", async () => {
  const calls: string[] = [];
  await assert.rejects(executeKestrelOneQueueSubmission({
    submit: async () => {
      calls.push("submit");
      throw new Error("queue rejected");
    },
    install: () => { calls.push("install"); },
    refresh: async () => { calls.push("refresh"); },
    onRefreshFailure: () => { calls.push("warning"); },
  }), /queue rejected/u);
  assert.deepEqual(calls, ["submit"]);
});
