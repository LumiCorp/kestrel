import assert from "node:assert/strict";

import type { NormalizedOutput } from "../../src/kestrel/contracts/execution.js";
import type { SessionRecord } from "../../src/kestrel/contracts/store.js";
import {
  ThreadRuntime,
  type TurnExecutionInput,
  type TurnExecutionResult,
  type TurnExecutor,
} from "../../src/orchestration/index.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


class FollowUpExecutor implements TurnExecutor {
  readonly inputs: TurnExecutionInput[] = [];
  constructor(
    private readonly store: InMemorySessionStore,
    private readonly results: TurnExecutionResult[],
  ) {}
  async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    this.inputs.push(structuredClone(input));
    const result = this.results.shift();
    if (result === undefined) throw new Error("No queued result");
    return result;
  }
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.store.getSession(sessionId);
  }
}

contractTest("runtime.hermetic", "ThreadRuntime dispatches durable follow-ups in FIFO order and suppresses duplicate IDs", async () => {
  const store = new InMemorySessionStore();
  const executor = new FollowUpExecutor(store, [completed("run-follow-up-1"), completed("run-follow-up-2")]);
  const runtime = new ThreadRuntime({ sessionStore: store, executor });
  const started = await runtime.startThread({ threadId: "thread-fifo", sessionId: "session-fifo", title: "FIFO" });
  await store.upsertThread({ ...started, status: "RUNNING", updatedAt: new Date().toISOString() });

  await runtime.enqueueFollowUp({ threadId: started.threadId, followUpId: "follow-up-1", message: "first" });
  await runtime.enqueueFollowUp({ threadId: started.threadId, followUpId: "follow-up-2", message: "second" });
  await runtime.enqueueFollowUp({ threadId: started.threadId, followUpId: "follow-up-1", message: "duplicate" });
  const queued = await runtime.getOperatorThreadView(started.threadId);
  assert.deepEqual(queued?.followUpQueue?.items.map((entry) => entry.message), ["first", "second"]);

  const latest = await store.getThread(started.threadId);
  await store.upsertThread({ ...latest!, status: "COMPLETED", activeRunId: undefined, updatedAt: new Date().toISOString() });
  await runtime.resumeFollowUpQueue({ threadId: started.threadId });
  await waitUntil(() => executor.inputs.length === 2);
  await waitUntil(async () => (await runtime.getOperatorThreadView(started.threadId))?.followUpQueue?.items.length === 0);

  assert.deepEqual(executor.inputs.map((input) => input.message), ["first", "second"]);
  assert.deepEqual(executor.inputs.map((input) => input.metadata?.followUpId), ["follow-up-1", "follow-up-2"]);
});

contractTest("runtime.hermetic", "ThreadRuntime pauses remaining follow-ups when an entry waits for operator input", async () => {
  const store = new InMemorySessionStore();
  const executor = new FollowUpExecutor(store, [waiting("run-follow-up-wait")]);
  const runtime = new ThreadRuntime({ sessionStore: store, executor });
  const started = await runtime.startThread({ threadId: "thread-pause", sessionId: "session-pause", title: "Pause" });
  await store.upsertThread({ ...started, status: "RUNNING", updatedAt: new Date().toISOString() });
  await runtime.enqueueFollowUp({ threadId: started.threadId, followUpId: "follow-up-wait", message: "ask" });
  await runtime.enqueueFollowUp({ threadId: started.threadId, followUpId: "follow-up-after", message: "after" });
  const latest = await store.getThread(started.threadId);
  await store.upsertThread({ ...latest!, status: "COMPLETED", activeRunId: undefined, updatedAt: new Date().toISOString() });
  await runtime.resumeFollowUpQueue({ threadId: started.threadId });

  await waitUntil(async () => {
    const queue = (await runtime.getOperatorThreadView(started.threadId))?.followUpQueue;
    return queue?.state === "paused" && queue.items[0]?.followUpId === "follow-up-after";
  });
  const view = await runtime.getOperatorThreadView(started.threadId);
  assert.equal(view?.followUpQueue?.pauseReason, "waiting");
  assert.deepEqual(view?.followUpQueue?.items.map((entry) => entry.followUpId), ["follow-up-after"]);
  await assert.rejects(runtime.resumeFollowUpQueue({ threadId: started.threadId }), /Resolve the thread's waiting action/u);
});

contractTest("runtime.hermetic", "ThreadRuntime preserves an explicit cancellation pause for queued follow-ups", async () => {
  const store = new InMemorySessionStore();
  const runtime = new ThreadRuntime({ sessionStore: store, executor: new FollowUpExecutor(store, []) });
  const started = await runtime.startThread({ threadId: "thread-cancel", sessionId: "session-cancel", title: "Cancel" });
  await store.upsertThread({ ...started, status: "RUNNING", updatedAt: new Date().toISOString() });
  await runtime.enqueueFollowUp({ threadId: started.threadId, followUpId: "follow-up-after-cancel", message: "after" });

  const view = await runtime.pauseFollowUpQueue({ threadId: started.threadId, reason: "cancelled" });
  assert.equal(view.followUpQueue?.state, "paused");
  assert.equal(view.followUpQueue?.pauseReason, "cancelled");
  assert.deepEqual(view.followUpQueue?.items.map((entry) => entry.followUpId), ["follow-up-after-cancel"]);
});

function completed(runId: string): TurnExecutionResult {
  return { output: output(runId, "COMPLETED"), assistantText: "done" };
}
function waiting(runId: string): TurnExecutionResult {
  return {
    output: output(runId, "WAITING", {
      kind: "user",
      eventType: "user.reply",
      metadata: { prompt: "Need input" },
    }),
    assistantText: "Need input",
  };
}
function output(runId: string, status: NormalizedOutput["status"], waitFor?: NormalizedOutput["waitFor"]): NormalizedOutput {
  return {
    status,
    sessionId: "session-placeholder",
    runId,
    ...(waitFor !== undefined ? { waitFor } : {}),
    quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
    errors: [],
    telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
  };
}
async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for follow-up runtime state");
}
