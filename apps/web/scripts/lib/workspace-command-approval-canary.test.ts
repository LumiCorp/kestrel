import assert from "node:assert/strict";
import test from "node:test";
import { threadTurnBodySchema } from "../../lib/chat/thread-turn-request-contract";
import {
  assertExecCommandNoSpendPreflight,
  isCurrentExecCommandApprovalActionable,
  matchesExactExecCommandApprovalScope,
  createExecCommandCanaryApprovalResponse,
} from "./workspace-command-approval-canary";

test("canary approval matches the Web production request contract", () => {
  const body = createExecCommandCanaryApprovalResponse({
    requestId: "request-sha256:canary",
    turnId: "98ccebd9-e2e7-40c6-a52c-ca371cdefb5c",
    messageId: "6aef02ce-6766-4b90-b34e-3d06b38b4d83",
  });
  assert.equal(threadTurnBodySchema.safeParse(body).success, true);
  assert.equal(
    threadTurnBodySchema.safeParse({
      interactionResponse: {
        ...body.interactionResponse,
        message: "Approve once",
      },
    }).success,
    false,
  );
});

test("V4 identifies a prepared command before any tool-start event", () => {
  const scope = {
    kind: "exec_command_exact",
    command: "printf canary",
    cwd: ".",
    envMode: "inherit",
    envNames: [],
  };
  assert.equal(
    matchesExactExecCommandApprovalScope(scope, "printf canary"),
    true,
  );
  for (const mutation of [
    { command: "different" },
    { cwd: "elsewhere" },
    { envMode: "explicit" },
    { envNames: ["SECRET"] },
    { kind: "other" },
  ]) {
    assert.equal(
      matchesExactExecCommandApprovalScope(
        { ...scope, ...mutation },
        "printf canary",
      ),
      false,
    );
  }
  assert.equal(
    matchesExactExecCommandApprovalScope(undefined, "printf canary"),
    false,
  );
});

test("the no-spend command preflight accepts an eligible exact Ask First decision", () => {
  assert.doesNotThrow(() =>
    assertExecCommandNoSpendPreflight({
      toolName: "exec_command",
      decision: {
        available: true,
        approvalDisposition: {
          mode: "ask",
          reasonCode: "environment_policy",
        },
        rememberApprovalEligible: true,
      },
    }),
  );
});

test("the no-spend command preflight rejects unsupported and blocked runners", () => {
  assert.throws(
    () =>
      assertExecCommandNoSpendPreflight({
        toolName: "exec_command",
      }),
    /no-spend exec_command preflight/u,
  );
  assert.throws(
    () =>
      assertExecCommandNoSpendPreflight({
        toolName: "exec_command",
        decision: {
          available: false,
          approvalDisposition: {
            mode: "deny",
            reasonCode: "environment_policy",
          },
          rememberApprovalEligible: false,
        },
      }),
    /no-spend exec_command preflight/u,
  );
});

test("a built-in command card is actionable without provider resource evidence", () => {
  assert.equal(
    isCurrentExecCommandApprovalActionable({
      environmentApprovalMode: "ask",
      projectApprovalMode: "auto",
      subjectApprovalMode: null,
      rememberApprovalEligible: true,
    }),
    true,
  );
});

test("missing or denied current command authority is not actionable", () => {
  assert.equal(isCurrentExecCommandApprovalActionable(undefined), false);
  assert.equal(
    isCurrentExecCommandApprovalActionable({
      environmentApprovalMode: "ask",
      projectApprovalMode: "deny",
      rememberApprovalEligible: true,
    }),
    false,
  );
});
