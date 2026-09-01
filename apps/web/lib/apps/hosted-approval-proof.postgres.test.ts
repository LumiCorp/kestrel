import test from "node:test";
import assert from "node:assert/strict";
import { compareHostedApprovalProof } from "./hosted-approval-proof";

const hash = "a".repeat(64);
const proof = {
  interaction: {
    id: "interaction-1",
    requestId: "request-1",
    organizationId: "org-1",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "resolved",
    resolvedByUserId: "user-1",
    version: "runner_hosted_tool_approval_interaction_v4",
    decision: "remember_approval",
    effectState: "committed",
    failureCode: null,
    preparedInvocationId: "prepared-1",
    toolId: "kestrel_one.github_issue_create",
    descriptorRevision: "descriptor-1",
    authorityRevision: "authority-1",
    requestingActorId: "user-1",
    requestingTenantId: "org-1",
    policy: {
      mode: "ask",
      reasonCode: "environment_policy",
      authorityRevision: "authority-1",
    },
  },
  thread: {
    id: "thread-1",
    organizationId: "org-1",
    projectId: "project-1",
  },
  providerApproval: {
    id: "provider-1",
    lifecycleVersion: "interaction_v2",
    interactionId: "interaction-1",
    runtimeApprovalId: "approval-1",
    organizationId: "org-1",
    environmentId: "environment-1",
    threadId: "thread-1",
    actorUserId: "user-1",
    operationKey: "issue.create",
    payloadHash: hash,
    authorityRevision: "authority-1",
    availabilityStatus: "consumed",
    requestedExecutionId: "execution-requested",
    consumedExecutionId: "execution-consumed",
  },
  binding: {
    version: "runner_external_approval_binding_v2",
    approvalId: "approval-1",
    preparedInvocationId: "prepared-1",
    threadId: "thread-1",
    actionKey: "kestrel_one.github_issue_create",
    payloadHash: `sha256:${hash}`,
    actorId: "user-1",
    tenantId: "org-1",
    authorityRevision: "authority-1",
    toolId: "kestrel_one.github_issue_create",
    descriptorRevision: "descriptor-1",
    stableAuthorityRevision: "authority-1",
  },
  requestedExecution: {
    id: "execution-requested",
    organizationId: "org-1",
    environmentId: "environment-1",
    threadId: "thread-1",
    projectId: "project-1",
    actorId: "user-1",
    runtimeRunId: "run-requested",
    status: "completed",
  },
  consumingExecution: {
    id: "execution-consumed",
    organizationId: "org-1",
    environmentId: "environment-1",
    threadId: "thread-1",
    projectId: "project-1",
    actorId: "user-1",
    runtimeRunId: "run-consumed",
    status: "completed",
  },
  remembered: {
    id: "remembered-1",
    actorUserId: "user-1",
    threadId: "thread-1",
    toolId: "kestrel_one.github_issue_create",
    descriptorRevision: "descriptor-1",
    authorityRevision: "authority-1",
  },
  settled: {
    preparedInvocationId: "prepared-1",
    outcomeKind: "success",
    effectState: "committed",
  },
} as const;

test("hosted approval proof joins exact identity, rotation, consumption, and effect", () => {
  const result = compareHostedApprovalProof(proof);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.credentialRefresh, "rotated_execution");
  assert.equal(result.rememberedEvidence, "recorded_exact");
  assert.equal(result.compatibilityPath, null);
  assert.equal(result.identity.payloadHash, `sha256:${hash}`);
  assert.equal(result.providerConsumption?.operationKey, "issue.create");
});

test("hosted approval proof reports actor, payload, execution, and effect mismatches", () => {
  const result = compareHostedApprovalProof({
    ...proof,
    providerApproval: {
      ...proof.providerApproval,
      operationKey: "pull_request.merge",
    },
    binding: {
      ...proof.binding,
      payloadHash: `sha256:${"b".repeat(64)}`,
      actorId: "user-2",
    },
    consumingExecution: {
      ...proof.consumingExecution,
      environmentId: "environment-2",
    },
    settled: {
      ...proof.settled,
      effectState: "unknown",
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, [
    "provider.operation",
    "binding.payload_hash",
    "binding.actor",
    "consuming_execution.environment",
    "settled.effect",
  ]);
});

test("hosted approval proof rejects an approved decision without durable execution proof", () => {
  const result = compareHostedApprovalProof({
    ...proof,
    interaction: {
      ...proof.interaction,
      resolvedByUserId: "user-2",
      effectState: "not_started",
    },
    providerApproval: {
      ...proof.providerApproval,
      availabilityStatus: "available",
      consumedExecutionId: null,
    },
    consumingExecution: null,
    remembered: null,
    settled: null,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, [
    "interaction.resolver",
    "provider.availability",
    "provider.consumption.missing",
    "remembered.missing",
    "settled.missing",
    "interaction.effect",
  ]);
});

test("decline proves no execution, no remembered grant, and a not-started effect", () => {
  const result = compareHostedApprovalProof({
    ...proof,
    interaction: {
      ...proof.interaction,
      decision: "decline",
      effectState: "not_started",
    },
    providerApproval: {
      ...proof.providerApproval,
      availabilityStatus: "expired",
      consumedExecutionId: null,
    },
    consumingExecution: null,
    remembered: null,
    settled: null,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test("approve once proves execution without creating remembered authority", () => {
  const result = compareHostedApprovalProof({
    ...proof,
    interaction: {
      ...proof.interaction,
      decision: "approve_once",
    },
    remembered: null,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.rememberedEvidence, "not_recorded");
});
