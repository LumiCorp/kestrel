import assert from "node:assert/strict";

import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "commitStep emits compact runtime state diagnostics without action input", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("state-diagnostics-session", "agent.loop");

  await store.commitStep({
    runId: "run-state-diagnostics",
    event: {
      id: "evt-state-diagnostics",
      type: "user.message",
      sessionId: "state-diagnostics-session",
      payload: {},
    },
    sessionId: "state-diagnostics-session",
    expectedVersion: 0,
    stepAgent: "agent.loop",
    nextStepAgent: "agent.exec.dispatch",
    statePatch: {
      agent: {
        observations: [],
        exec: {},
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: {
            path: "secret.txt",
            content: "SECRET_CONTENT_SHOULD_NOT_BE_LOGGED",
          },
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  const events = await store.getReplayStream({ runId: "run-state-diagnostics" });
  const diagnostic = events.find((event) => event.type === "runtime.state_persisted");
  assert.equal(diagnostic?.metadata?.version, 1);
  assert.equal(diagnostic?.metadata?.snapshotKind, "full");
  assert.equal(diagnostic?.metadata?.stepAgent, "agent.loop");
  assert.equal(diagnostic?.metadata?.nextStepAgent, "agent.exec.dispatch");
  assert.equal(diagnostic?.metadata?.agentNextActionShape, "object");
  assert.equal(diagnostic?.metadata?.agentNextActionKind, "tool");
  assert.equal(diagnostic?.metadata?.agentNextActionName, "fs.write_text");
  assert.deepEqual(diagnostic?.metadata?.statePatchKeys, ["agent"]);
  assert.equal(JSON.stringify(diagnostic?.metadata).includes("SECRET_CONTENT_SHOULD_NOT_BE_LOGGED"), false);
});

contractTest("runtime.hermetic", "commitStep validation failures include compact runtime state diagnostics", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("state-validation-session", "agent.loop");

  await assert.rejects(
    () =>
      store.commitStep({
        runId: "run-state-validation",
        event: {
          id: "evt-state-validation",
          type: "user.message",
          sessionId: "state-validation-session",
          payload: {},
        },
        sessionId: "state-validation-session",
        expectedVersion: 0,
        nextStepAgent: "agent.exec.dispatch",
        statePatch: {
          agent: {
            observations: [],
            exec: {},
            nextAction: "[Circular]",
          },
        },
        effects: [],
        emitEvents: [],
        stepIndex: 0,
      }),
    (error: unknown) => {
      const runtimeError = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(runtimeError.code, "RUNTIME_STATE_INVALID");
      assert.equal(runtimeError.details?.invalidStatePath, "state.agent.nextAction");
      const diagnostic = runtimeError.details?.runtimeStateDiagnostic as Record<string, unknown>;
      assert.equal(diagnostic.agentNextActionShape, "string");
      assert.deepEqual(diagnostic.statePatchKeys, ["agent"]);
      return true;
    },
  );
});
