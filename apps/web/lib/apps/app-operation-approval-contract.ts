import { createHash } from "node:crypto";

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
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
