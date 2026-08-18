import assert from "node:assert/strict";
import test from "node:test";
import { resolveAlwaysApprovalAction } from "./runtime-approval-policy";

test("persistent approval always opens Environment Apps", () => {
  assert.equal(
    resolveAlwaysApprovalAction({
      environmentEnabled: true,
      environmentApprovalMode: "auto",
      projectEnabled: true,
      minimumApprovalMode: "auto",
      reasonCode: "environment_policy",
    }),
    "open_environment_apps",
  );
  assert.equal(
    resolveAlwaysApprovalAction({
      environmentEnabled: true,
      environmentApprovalMode: "ask",
      projectEnabled: true,
      minimumApprovalMode: "auto",
      reasonCode: "environment_policy",
    }),
    "open_environment_apps",
  );
  assert.equal(
    resolveAlwaysApprovalAction({
      environmentEnabled: false,
      environmentApprovalMode: "deny",
      projectEnabled: false,
      minimumApprovalMode: "auto",
      reasonCode: "environment_policy",
    }),
    "open_environment_apps",
  );
});

test("minimum Ask capabilities cannot be made persistent", () => {
  assert.equal(
    resolveAlwaysApprovalAction({
      environmentEnabled: true,
      environmentApprovalMode: "auto",
      projectEnabled: true,
      minimumApprovalMode: "ask",
      reasonCode: "tool_minimum",
    }),
    "minimum_ask",
  );
});

test("runtime and subject restrictions cannot be broadened in Environment Apps", () => {
  for (const reasonCode of ["runtime_strict", "subject_restriction"] as const) {
    assert.equal(
      resolveAlwaysApprovalAction({
        environmentEnabled: true,
        environmentApprovalMode: "auto",
        projectEnabled: true,
        minimumApprovalMode: "auto",
        reasonCode,
      }),
      "unavailable",
    );
  }
});
