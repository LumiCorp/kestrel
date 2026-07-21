import assert from "node:assert/strict";

import {
  applyReferenceReactExecPatch,
  createReferenceReactFinalOutputPatch,
  createReferenceReactNextActionPatch,
  createReferenceReactTerminalPatch,
} from "../../agents/reference-react/src/state.js";
import {
  CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
  validateRuntimeSessionState,
} from "../../src/runtime/state.js";
import { contractTest } from "../helpers/contract-test.js";


function buildRuntimeSessionState(agent: Record<string, unknown>): Record<string, unknown> {
  return {
    runtime: {
      schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
    },
    agent,
  };
}

contractTest("runtime.hermetic", "reference-react state patches leave malformed nextAction to runtime validation", () => {
  const agent = {
    ...applyReferenceReactExecPatch({}, {}),
    ...createReferenceReactNextActionPatch("[Circular]" as unknown as never),
  };

  const error = validateRuntimeSessionState(buildRuntimeSessionState(agent));

  assert.equal(error?.message, "state.agent.nextAction must be an object");
  assert.deepEqual(error?.details, {
    path: "state.agent.nextAction",
  });
});

contractTest("runtime.hermetic", "reference-react exec patch keeps pending approval state structured", () => {
  const agent = applyReferenceReactExecPatch({}, {
    substate: "wait_approval",
    pendingApproval: {
      approvalId: "approval-1",
      toolName: "fs.write_text",
      toolClass: "sandboxed_only",
    },
  });

  assert.deepEqual(agent.exec.pendingApproval, {
    approvalId: "approval-1",
    toolName: "fs.write_text",
    toolClass: "sandboxed_only",
  });
  assert.equal(validateRuntimeSessionState(buildRuntimeSessionState(agent)), undefined);
});

contractTest("runtime.hermetic", "reference-react exec patch preserves durable pending batches", () => {
  const agent = applyReferenceReactExecPatch({}, {
    substate: "dispatch",
    pendingBatch: {
      executionMode: "durable",
      items: [
        {
          name: "fs.write_text",
          input: {
            path: "/tmp/a.txt",
            content: "a",
          },
        },
      ],
      nextIndex: 0,
      checkpointSize: 5,
      completedItems: [],
    },
  });

  assert.deepEqual(agent.exec.pendingBatch, {
    executionMode: "durable",
    items: [
      {
        name: "fs.write_text",
        input: {
          path: "/tmp/a.txt",
          content: "a",
        },
      },
    ],
    nextIndex: 0,
    checkpointSize: 5,
    completedItems: [],
  });
  assert.equal(validateRuntimeSessionState(buildRuntimeSessionState(agent)), undefined);
});

contractTest("runtime.hermetic", "reference-react final output and terminal patches stay compatible with runtime state validation", () => {
  const agent = {
    ...applyReferenceReactExecPatch({}, {
      substate: "finalize",
      pendingBatch: undefined,
    }),
    ...createReferenceReactFinalOutputPatch({
      message: "done",
    }),
    ...createReferenceReactTerminalPatch({
      status: "COMPLETED",
      reasonCode: "goal_satisfied",
      finalStepAgent: "agent.exec.finalize",
      finalizedAt: new Date(0).toISOString(),
      outputRef: "agent.finalOutput",
    }),
  };

  assert.deepEqual(agent.finalOutput, {
    message: "done",
  });
  assert.equal(agent.terminal?.outputRef, "agent.finalOutput");
  assert.equal(validateRuntimeSessionState(buildRuntimeSessionState(agent)), undefined);
});
