import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedOutput } from "../../src/kestrel/contracts/execution.js";
import type { SessionRecord } from "../../src/kestrel/contracts/store.js";
import {
  ThreadRuntime,
  type TurnExecutionInput,
  type TurnExecutionResult,
  type TurnExecutor,
} from "../../src/orchestration/index.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

class ConcurrentExecutor implements TurnExecutor {
  readonly entered: TurnExecutionInput[] = [];
  private readonly releases = new Map<string, (result: TurnExecutionResult) => void>();

  constructor(private readonly store: InMemorySessionStore) {}

  async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    this.entered.push(structuredClone(input));
    return new Promise((resolve) => this.releases.set(input.sessionId, resolve));
  }

  release(sessionId: string): void {
    const resolve = this.releases.get(sessionId);
    if (resolve === undefined) throw new Error(`Session '${sessionId}' has not entered execution.`);
    resolve({ output: completed(sessionId), assistantText: "done" });
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.store.getSession(sessionId);
  }
}

test("Desktop conversation authority permits concurrent threads and rejects a second active run on one thread", async () => {
  const store = new InMemorySessionStore();
  const executor = new ConcurrentExecutor(store);
  const runtime = new ThreadRuntime({ sessionStore: store, executor });
  await runtime.startThread({ threadId: "thread-a", sessionId: "session-a", title: "A" });
  await runtime.startThread({ threadId: "thread-b", sessionId: "session-b", title: "B" });

  const first = runtime.submitTurn({ threadId: "thread-a", message: "first", eventType: "user.message" });
  await waitUntil(() => executor.entered.length === 1);
  await assert.rejects(
    runtime.submitTurn({ threadId: "thread-a", message: "duplicate", eventType: "user.message" }),
    (error: unknown) => (error as { code?: string }).code === "THREAD_RUN_ALREADY_ACTIVE",
  );

  const second = runtime.submitTurn({ threadId: "thread-b", message: "independent", eventType: "user.message" });
  await waitUntil(() => executor.entered.length === 2);
  assert.deepEqual(new Set(executor.entered.map((input) => input.sessionId)), new Set(["session-a", "session-b"]));

  executor.release("session-a");
  executor.release("session-b");
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.output.status), ["COMPLETED", "COMPLETED"]);
});

function completed(sessionId: string): NormalizedOutput {
  return {
    status: "COMPLETED",
    sessionId,
    runId: `run-${sessionId}`,
    quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
    errors: [],
    telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
  };
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for concurrent execution.");
}
