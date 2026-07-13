import assert from "node:assert/strict";
import test from "node:test";
import { requiresExplicitToolApproval } from "../../agents/reference-react/src/steps/acter/policyGates.js";

test("external.confirm forces per-call approval even when the profile is otherwise automatic", () => {
  assert.equal(
    requiresExplicitToolApproval({
      interactionMode: "build",
      actSubmode: "full_auto",
      executionPolicy: {
        approvalPolicy: { strictApprovalPerCall: false },
      },
      requiredApprovalCapabilities: ["network.call", "external.confirm"],
    }),
    true
  );
  assert.equal(
    requiresExplicitToolApproval({
      interactionMode: "build",
      actSubmode: "full_auto",
      executionPolicy: {
        approvalPolicy: { strictApprovalPerCall: false },
      },
      requiredApprovalCapabilities: ["network.call"],
    }),
    false
  );
});
