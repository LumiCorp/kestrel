import assert from "node:assert/strict";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { AGENT_STEP_IDS } from "../../agents/reference-react/src/constants.js";
import {
  createAgentInstance,
  createReferenceReactAgentDefinition,
  registerAgentInstance,
} from "../../agents/reference-react/src/agentDefinition.js";
import { contractTest } from "../helpers/contract-test.js";


const EXPECTED_STEP_IDS = [
  AGENT_STEP_IDS.loop,
  AGENT_STEP_IDS.execDispatch,
  AGENT_STEP_IDS.execWaitEffect,
  AGENT_STEP_IDS.execWaitApproval,
  AGENT_STEP_IDS.execWaitUser,
  AGENT_STEP_IDS.execCollect,
  AGENT_STEP_IDS.execFinalize,
];

function createDefinitionForTest() {
  return createReferenceReactAgentDefinition({
    agentTools: [],
    capabilityManifest: [],
  });
}

contractTest("runtime.hermetic", "reference-react agent definition is inspectable without constructing a runtime", () => {
  const definition = createDefinitionForTest();

  assert.equal(definition.id, "reference-react");
  assert.equal(definition.entryStepAgent, AGENT_STEP_IDS.loop);
  assert.deepEqual(definition.steps.map((step) => step.id), EXPECTED_STEP_IDS);
  assert.equal(definition.steps.every((step) => typeof step.createStep === "function"), true);
});

contractTest("runtime.hermetic", "reference-react agent instance adapts canonical definition into Kestrel step and contract registries", () => {
  const definition = createDefinitionForTest();
  const instance = createAgentInstance(definition);
  const kestrel = new Kestrel({
    store: new InMemorySessionStore(),
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
  });

  const registration = registerAgentInstance(kestrel, instance);
  const internals = kestrel as unknown as {
    registry: { steps: Map<string, unknown> };
    stepContractRegistry: { validators: Map<string, unknown> };
  };

  assert.equal(registration.entryStepAgent, AGENT_STEP_IDS.loop);
  assert.equal(registration.agentDefinition, definition);
  assert.deepEqual([...internals.registry.steps.keys()], EXPECTED_STEP_IDS);
  assert.deepEqual([...internals.stepContractRegistry.validators.keys()], EXPECTED_STEP_IDS);
});

contractTest("runtime.hermetic", "agent.loop FAILED contract accepts structured runtime failures", () => {
  const definition = createDefinitionForTest();
  const loopContract = definition.steps.find((step) => step.id === AGENT_STEP_IDS.loop)?.contract;
  assert.equal(typeof loopContract, "function");

  assert.doesNotThrow(() =>
    loopContract?.({
      transition: {
        status: "FAILED",
        statePatch: {
          agent: {
            terminal: {
              status: "FAILED",
              reasonCode: "LOOP_GUARD_TRIGGERED",
              message: "Loop guard stopped repeated rejected actions.",
            },
          },
        },
      },
    } as never),
  );
  assert.doesNotThrow(() =>
    loopContract?.({
      transition: {
        status: "FAILED",
        statePatch: {
          agent: {
            lastActionResult: {
              ok: false,
              error: {
                code: "AGENT_VALIDATION_RETRY_EXHAUSTED",
                message: "Validation retry budget exhausted.",
              },
            },
          },
        },
      },
    } as never),
  );
});

contractTest("runtime.hermetic", "agent.loop FAILED contract rejects unstructured failures", () => {
  const definition = createDefinitionForTest();
  const loopContract = definition.steps.find((step) => step.id === AGENT_STEP_IDS.loop)?.contract;

  assert.throws(
    () =>
      loopContract?.({
        transition: {
          status: "FAILED",
          statePatch: {
            agent: {
              terminal: {
                status: "FAILED",
                message: "A failed transition without a reason code.",
              },
            },
          },
        },
      } as never),
    /agent\.loop FAILED transitions must commit a structured runtime failure/u,
  );
});
