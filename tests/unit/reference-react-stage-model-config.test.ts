import assert from "node:assert/strict";

import { AGENT_STEP_IDS } from "../../agents/reference-react/src/constants.js";
import {
  AGENT_MODEL_CONFIG_STAGES,
  applyStageModelOverridesToAgentOptions,
} from "../../agents/reference-react/src/stageModelConfig.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "agent stage model manifest exposes loop maintenance and delegated-child models", () => {
  assert.deepEqual(
    AGENT_MODEL_CONFIG_STAGES.map((stage) => stage.stageId),
    [AGENT_STEP_IDS.loop, "agent.maintenance", "delegation.child"],
  );
});

contractTest("runtime.hermetic", "applyStageModelOverridesToAgentOptions maps loop overrides", () => {
  assert.deepEqual(
    applyStageModelOverridesToAgentOptions({
      [AGENT_STEP_IDS.loop]: "provider/agent-model",
    }),
    {
      agentModel: "provider/agent-model",
    },
  );
});

contractTest("runtime.hermetic", "applyStageModelOverridesToAgentOptions maps maintenance and delegated-child overrides independently", () => {
  assert.deepEqual(
    applyStageModelOverridesToAgentOptions({
      "agent.maintenance": "provider/maintenance-model",
      "delegation.child": "provider/child-model",
    }),
    {
      maintenanceModel: "provider/maintenance-model",
      delegationModel: "provider/child-model",
    },
  );
});

contractTest("runtime.hermetic", "applyStageModelOverridesToAgentOptions ignores unknown stage ids", () => {
  assert.deepEqual(
    applyStageModelOverridesToAgentOptions({
      [AGENT_STEP_IDS.loop]: "provider/agent-model",
      "agent.unknown": "provider/ignored-model",
    }),
    {
      agentModel: "provider/agent-model",
    },
  );
});
