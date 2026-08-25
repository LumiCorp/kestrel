import test from "node:test";
import assert from "node:assert/strict";
import { projectSafeThreadInteraction } from "./interaction-projection";

test("safe interaction projection exposes lifecycle state without internal evidence", () => {
  const now = new Date();
  const projected = projectSafeThreadInteraction(
    {
      id: "interaction-1",
      requestId: "request-1",
      organizationId: "organization-secret",
      threadId: "thread-1",
      turnId: "turn-1",
      assistantMessageId: "message-1",
      source: "runtime",
      sourceCheckpointId: null,
      kind: "approval",
      eventType: "user.approval",
      prompt: "Approve?",
      status: "failed",
      requestEnvelope: { approval: { toolName: "kestrel_one.email_send" } },
      responseEnvelope: { approved: true },
      runtimeApprovalId: "runtime-secret",
      sourceRuntimeRunId: "runner-secret",
      responseFailureCode: "EXTERNAL_APPROVAL_IDENTITY_MISMATCH",
      responseFailureMessage: "raw runtime failure secret",
      effectStatus: "not_started",
      responseRetryable: false,
      resolvedByUserId: "actor-secret",
      resolvedAt: now,
      resumedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    "response-1",
  );
  assert.equal(projected.approvalOutcome?.retryEligible, false);
  assert.match(projected.approvalOutcome?.publicMessage ?? "", /fresh approval/u);
  assert.doesNotMatch(
    JSON.stringify(projected),
    /runtime-secret|runner-secret|raw runtime failure secret|organization-secret|actor-secret/u,
  );
});
