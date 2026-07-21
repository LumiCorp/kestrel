import assert from "node:assert/strict";

import { InMemoryStepContractRegistry } from "../../src/engine/StepContractRegistry.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "step contract registry validates registered step", () => {
  const registry = new InMemoryStepContractRegistry();

  registry.register("step.a", ({ transition }) => {
    if (transition.status !== "RUNNING") {
      throw new Error("expected running");
    }
  });

  assert.doesNotThrow(() =>
    registry.validate({
      stepName: "step.a",
      transition: { status: "RUNNING", nextStepAgent: "step.b" },
      context: {
        runId: "r1",
        session: {
          sessionId: "s1",
          version: 1,
          state: {},
          updatedAt: new Date().toISOString(),
        },
        event: {
          id: "e1",
          type: "user.message",
          sessionId: "s1",
          payload: {},
        },
        stepIndex: 0,
        memory: {
          working: {},
          episodicRef: "episodic:1",
          semanticRef: "semantic:1",
        },
        budget: {
          remainingMs: 1000,
          tokensUsed: 0,
          toolCallsUsed: 0,
        },
      },
    }),
  );
});

