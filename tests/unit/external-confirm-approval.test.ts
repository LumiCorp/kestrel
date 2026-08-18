import test from "node:test";
import assert from "node:assert/strict";
import { requiresExplicitToolApproval } from "../../agents/reference-react/src/steps/acter/policyGates.js";

test("an explicit approval disposition overrides legacy external.confirm", () => {
  assert.equal(
    requiresExplicitToolApproval({
      interactionMode: "build",
      actSubmode: "full_auto",
      executionPolicy: {
        approvalPolicy: { strictApprovalPerCall: false },
      },
      requiredApprovalCapabilities: ["network.call", "external.confirm"],
      approvalDisposition: {
        mode: "auto",
        reasonCode: "environment_policy",
        authority: {
          kind: "hosted_app_policy",
          revision: "policy:auto",
        },
      },
    }),
    false,
  );
  assert.equal(
    requiresExplicitToolApproval({
      interactionMode: "build",
      actSubmode: "full_auto",
      executionPolicy: {
        approvalPolicy: { strictApprovalPerCall: false },
      },
      requiredApprovalCapabilities: ["network.call"],
      approvalDisposition: {
        mode: "ask",
        reasonCode: "project_restriction",
        authority: {
          kind: "hosted_app_policy",
          revision: "policy:ask",
        },
      },
    }),
    true,
  );
});

test("legacy external.confirm and runtime strictness remain fail closed", () => {
  assert.equal(
    requiresExplicitToolApproval({
      interactionMode: "build",
      actSubmode: "full_auto",
      executionPolicy: {
        approvalPolicy: { strictApprovalPerCall: false },
      },
      requiredApprovalCapabilities: ["external.confirm"],
    }),
    true,
  );
  assert.equal(
    requiresExplicitToolApproval({
      interactionMode: "build",
      actSubmode: "full_auto",
      executionPolicy: {
        approvalPolicy: { strictApprovalPerCall: true },
      },
      requiredApprovalCapabilities: [],
      approvalDisposition: {
        mode: "auto",
        reasonCode: "environment_policy",
        authority: {
          kind: "hosted_app_policy",
          revision: "policy:auto",
        },
      },
    }),
    true,
  );
});
