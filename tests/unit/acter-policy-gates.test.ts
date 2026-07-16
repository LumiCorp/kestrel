import assert from "node:assert/strict";
import test from "node:test";

import { checkToolBatchChunkPolicyGate } from "../../agents/reference-react/src/steps/acter/policyGates.js";

const base = {
  reactState: {},
  activeRegion: undefined,
  acterStepId: "agent.exec.dispatch",
  stepIndex: 1,
  toolApprovalCapabilitiesByName: {},
  actSubmode: undefined,
  modeSystemV2Enabled: false,
  executionPolicy: undefined,
};

test("execution defense blocks Build-only mutations in Chat even with a widening override", () => {
  const result = checkToolBatchChunkPolicyGate({
    ...base,
    items: [{ name: "fs.write_text", input: { path: "a", content: "b" } }],
    toolExecutionClassByName: { "fs.write_text": "sandboxed_only" },
    toolAllowedInteractionModesByName: {},
    interactionMode: "chat",
    executionPolicy: { toolClassPolicy: { sandboxed_only: true } },
  });
  assert.equal(result.kind, "blocked");
});

test("execution defense allows an explicitly Chat-enabled authorized app action", () => {
  const result = checkToolBatchChunkPolicyGate({
    ...base,
    items: [{ name: "calendar.create", input: {} }],
    toolExecutionClassByName: { "calendar.create": "external_side_effect" },
    toolAllowedInteractionModesByName: { "calendar.create": ["chat", "build"] },
    interactionMode: "chat",
  });
  assert.equal(result.kind, "allowed");
});
