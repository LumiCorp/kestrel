import assert from "node:assert/strict";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


class StartRunFailureStore extends InMemorySessionStore {
  logFlushCalls = 0;
  eventFlushCalls = 0;

  override async startRun(): Promise<void> {
    throw new Error("startRun boom");
  }

  override async appendRunLogsBatch(): Promise<void> {
    this.logFlushCalls += 1;
    throw new Error("unexpected lifecycle log flush");
  }

  override async appendRunEventsBatch(): Promise<void> {
    this.eventFlushCalls += 1;
    throw new Error("unexpected lifecycle event flush");
  }
}

contractTest("runtime.hermetic", "ExecutionEngine preserves startRun failures without flushing lifecycle buffers", async () => {
  const store = new StartRunFailureStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  const output = await kestrel.run({
    id: "evt-start-run-failure",
    type: "user.message",
    sessionId: "session-start-run-failure",
    payload: {},
    stepAgent: "react.route",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.message, "startRun boom");
  assert.equal(store.logFlushCalls, 0);
  assert.equal(store.eventFlushCalls, 0);
});
