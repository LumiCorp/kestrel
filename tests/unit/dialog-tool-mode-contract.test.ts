import test from "node:test";
import assert from "node:assert/strict";

import { buildExecutionPolicyFromPack } from "../../src/mode/approvalPolicyPacks.js";
import { isToolEligibleForInteractionMode } from "../../src/mode/contracts.js";
import { dialogCloseTool } from "../../tools/runtime/dialogClose.js";
import { dialogListTool } from "../../tools/runtime/dialogList.js";
import { dialogOpenTool } from "../../tools/runtime/dialogOpen.js";
import { dialogReadTool } from "../../tools/runtime/dialogRead.js";
import { dialogSendTool } from "../../tools/runtime/dialogSend.js";

const dialogTools = [
  dialogOpenTool,
  dialogSendTool,
  dialogReadTool,
  dialogListTool,
  dialogCloseTool,
];

test("main-thread dialog tools are available in Chat, Plan, and Build when delegation is granted", () => {
  for (const packId of ["dev", "hosted_workspace"] as const) {
    const executionPolicy = buildExecutionPolicyFromPack(packId);
    assert.equal(executionPolicy.capabilityPolicy?.["delegation.control"], true);

    for (const tool of dialogTools) {
      const capability = tool.definition.capability;
      assert.equal(capability.executionClass, "external_side_effect", tool.definition.name);
      assert.deepEqual(
        capability.allowedInteractionModes,
        ["chat", "plan", "build"],
        tool.definition.name,
      );
      assert.deepEqual(
        capability.approvalCapabilities,
        ["delegation.control"],
        tool.definition.name,
      );

      for (const interactionMode of ["chat", "plan", "build"] as const) {
        assert.equal(
          isToolEligibleForInteractionMode({
            interactionMode,
            toolClass: capability.executionClass,
            allowedInteractionModes: capability.allowedInteractionModes,
            executionPolicy,
            requiredCapabilities: capability.approvalCapabilities,
          }),
          true,
          `${tool.definition.name} should be available in ${interactionMode} under ${packId}`,
        );
      }
    }
  }
});

test("dialog tools remain unavailable when delegation authority is not granted", () => {
  for (const packId of ["isolated_code", "ci_bot", "production"] as const) {
    const executionPolicy = buildExecutionPolicyFromPack(packId);
    assert.equal(executionPolicy.capabilityPolicy?.["delegation.control"], false);

    for (const tool of dialogTools) {
      const capability = tool.definition.capability;
      assert.equal(
        isToolEligibleForInteractionMode({
          interactionMode: "chat",
          toolClass: capability.executionClass,
          allowedInteractionModes: capability.allowedInteractionModes,
          executionPolicy,
          requiredCapabilities: capability.approvalCapabilities,
        }),
        false,
        `${tool.definition.name} should fail closed under ${packId}`,
      );
    }
  }
});
