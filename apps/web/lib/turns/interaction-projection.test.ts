import test from "node:test";
import assert from "node:assert/strict";
import { projectSafeThreadInteraction } from "./interaction-projection";

test("safe interaction projection exposes lifecycle state without internal evidence", () => {
  const now = new Date();
  const interaction = {
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
      responseEnvelope: { decision: "approve_once" },
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
    } satisfies Parameters<typeof projectSafeThreadInteraction>[0];
  const projected = projectSafeThreadInteraction(
    interaction,
    "response-1",
  );
  assert.equal(projected.approvalOutcome?.retryEligible, false);
  assert.match(projected.approvalOutcome?.publicMessage ?? "", /fresh approval/u);
  assert.doesNotMatch(
    JSON.stringify(projected),
    /runtime-secret|runner-secret|raw runtime failure secret|organization-secret|actor-secret/u,
  );

  const declined = projectSafeThreadInteraction({
    ...interaction,
    status: "resolved",
    responseEnvelope: { decision: "decline" },
    responseFailureCode: null,
    effectStatus: "not_started",
  }, "response-declined");
  assert.equal(declined.approvalOutcome?.decision, "denied");
  assert.equal(declined.approvalOutcome?.authorizationState, "denied");

  const expired = projectSafeThreadInteraction({
    ...interaction,
    responseEnvelope: null,
    responseFailureCode: "EXTERNAL_APPROVAL_EXPIRED",
  }, null);
  assert.equal(expired.approvalOutcome?.decision, "expired");
  assert.equal(expired.approvalOutcome?.authorizationState, "expired");

  const committed = projectSafeThreadInteraction({
    ...interaction,
    status: "resolved",
    responseEnvelope: { decision: "approve_once" },
    responseFailureCode: null,
    effectStatus: "committed",
  }, "response-committed");
  assert.equal(committed.approvalOutcome?.effectState, "committed");
});
