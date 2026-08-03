import { createHash } from "node:crypto";
import {
  RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
  parseRunnerExternalApprovalBindingV1,
  serializeCanonicalApprovalPayload,
  type RunnerExternalApprovalBindingV1,
} from "@kestrel-agents/protocol";

export type AppOperationApprovalBinding = {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  actorUserId: string;
  agentId: string;
  appKey: string;
  capabilityKey: string;
  connectionId: string;
  resourceId: string;
  resourceType: string;
  operationKey: string;
  runtimeApprovalId: string;
  payload: Record<string, unknown>;
};

export function hashAppOperationPayload(payload: Record<string, unknown>) {
  return createHash("sha256")
    .update(serializeCanonicalApprovalPayload(payload))
    .digest("hex");
}

export function hashAppApprovalAuthority(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(serializeCanonicalApprovalPayload(value))
    .digest("hex")}`;
}

export function createAppExternalApprovalBinding(input: {
  binding: AppOperationApprovalBinding;
  requestedExecutionId: string;
  authorityRevision: string;
  requestedAt: Date;
  expiresAt: Date;
}): RunnerExternalApprovalBindingV1 {
  return parseRunnerExternalApprovalBindingV1({
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
    approvalId: input.binding.runtimeApprovalId,
    threadId: input.binding.threadId,
    runId: input.requestedExecutionId,
    actionKey: input.binding.operationKey,
    payloadHash: `sha256:${hashAppOperationPayload(input.binding.payload)}`,
    toolClass: "external_side_effect",
    capabilities: [input.binding.capabilityKey].sort(),
    authorityKind: "hosted_app_policy",
    authorityRevision: input.authorityRevision,
    requestedAt: input.requestedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  });
}

export function assertAppExternalApprovalBinding(input: {
  stored: unknown;
  actual: AppOperationApprovalBinding;
  requestedExecutionId: string;
  authorityRevision: string;
}) {
  const stored = parseRunnerExternalApprovalBindingV1(input.stored);
  const expected = createAppExternalApprovalBinding({
    binding: input.actual,
    requestedExecutionId: input.requestedExecutionId,
    authorityRevision: input.authorityRevision,
    requestedAt: new Date(stored.requestedAt),
    expiresAt: new Date(stored.expiresAt),
  });
  if (
    serializeCanonicalApprovalPayload(stored) !==
    serializeCanonicalApprovalPayload(expected)
  ) {
    throw new Error("APP_OPERATION_EXTERNAL_APPROVAL_BINDING_MISMATCH");
  }
  return stored;
}

export function assertAppOperationApprovalBinding(
  expected: AppOperationApprovalBinding & { payloadHash: string },
  actual: AppOperationApprovalBinding
) {
  const actualHash = hashAppOperationPayload(actual.payload);
  for (const key of [
    "organizationId",
    "environmentId",
    "workspaceId",
    "threadId",
    "actorUserId",
    "agentId",
    "appKey",
    "capabilityKey",
    "connectionId",
    "resourceId",
    "resourceType",
    "operationKey",
    "runtimeApprovalId",
  ] as const) {
    if (expected[key] !== actual[key]) {
      throw new Error("APP_OPERATION_APPROVAL_BINDING_MISMATCH");
    }
  }
  if (expected.payloadHash !== actualHash) {
    throw new Error("APP_OPERATION_APPROVAL_PAYLOAD_MISMATCH");
  }
}
