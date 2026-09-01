import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExecCommandNoSpendPreflight,
  isCurrentExecCommandApprovalActionable,
} from "./workspace-command-approval-canary";

test("the no-spend command preflight accepts an eligible exact Ask First decision", () => {
  assert.doesNotThrow(() => assertExecCommandNoSpendPreflight({
    toolName: "exec_command",
    decision: {
      available: true,
      approvalDisposition: {
        mode: "ask",
        reasonCode: "environment_policy",
      },
      rememberApprovalEligible: true,
    },
  }));
});

test("the no-spend command preflight rejects unsupported and blocked runners", () => {
  assert.throws(() => assertExecCommandNoSpendPreflight({
    toolName: "exec_command",
  }), /no-spend exec_command preflight/u);
  assert.throws(() => assertExecCommandNoSpendPreflight({
    toolName: "exec_command",
    decision: {
      available: false,
      approvalDisposition: { mode: "deny", reasonCode: "environment_policy" },
      rememberApprovalEligible: false,
    },
  }), /no-spend exec_command preflight/u);
});

test("a built-in command card is actionable without provider resource evidence", () => {
  assert.equal(isCurrentExecCommandApprovalActionable({
    environmentApprovalMode: "ask",
    projectApprovalMode: "auto",
    subjectApprovalMode: null,
    rememberApprovalEligible: true,
  }), true);
});

test("missing or denied current command authority is not actionable", () => {
  assert.equal(isCurrentExecCommandApprovalActionable(undefined), false);
  assert.equal(isCurrentExecCommandApprovalActionable({
    environmentApprovalMode: "ask",
    projectApprovalMode: "deny",
    rememberApprovalEligible: true,
  }), false);
});
