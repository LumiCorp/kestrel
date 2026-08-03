export const RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION =
  "runner_external_approval_binding_v1" as const;

export const RUNNER_EXTERNAL_APPROVAL_AUTHORITY_KINDS = [
  "runtime_policy",
  "hosted_mcp_grant",
  "hosted_app_policy",
] as const;

export type RunnerExternalApprovalAuthorityKind =
  (typeof RUNNER_EXTERNAL_APPROVAL_AUTHORITY_KINDS)[number];

export interface RunnerExternalApprovalBindingV1 {
  version: typeof RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION;
  approvalId: string;
  threadId: string;
  runId: string;
  actionKey: string;
  payloadHash: string;
  toolClass: "external_side_effect";
  capabilities: string[];
  authorityKind: RunnerExternalApprovalAuthorityKind;
  authorityRevision: string;
  requestedAt: string;
  expiresAt: string;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const BINDING_FIELDS = new Set([
  "version",
  "approvalId",
  "threadId",
  "runId",
  "actionKey",
  "payloadHash",
  "toolClass",
  "capabilities",
  "authorityKind",
  "authorityRevision",
  "requestedAt",
  "expiresAt",
]);

export function parseRunnerExternalApprovalBindingV1(
  value: unknown,
): RunnerExternalApprovalBindingV1 {
  const binding = requireRecord(value, "external approval binding");
  for (const key of Object.keys(binding)) {
    if (BINDING_FIELDS.has(key) === false) {
      throw new Error(`external approval binding contains unknown field '${key}'`);
    }
  }
  if (binding.version !== RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION) {
    throw new Error(
      `external approval binding.version must be '${RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION}'`,
    );
  }
  if (binding.toolClass !== "external_side_effect") {
    throw new Error(
      "external approval binding.toolClass must be 'external_side_effect'",
    );
  }
  if (
    typeof binding.authorityKind !== "string" ||
    RUNNER_EXTERNAL_APPROVAL_AUTHORITY_KINDS.includes(
      binding.authorityKind as RunnerExternalApprovalAuthorityKind,
    ) === false
  ) {
    throw new Error("external approval binding.authorityKind is invalid");
  }
  const payloadHash = requireNonEmptyString(
    binding.payloadHash,
    "external approval binding.payloadHash",
  );
  if (SHA256_PATTERN.test(payloadHash) === false) {
    throw new Error(
      "external approval binding.payloadHash must use sha256:<64 lowercase hex>",
    );
  }
  const capabilities = requireCanonicalStringArray(
    binding.capabilities,
    "external approval binding.capabilities",
  );
  const requestedAt = requireTimestamp(
    binding.requestedAt,
    "external approval binding.requestedAt",
  );
  const expiresAt = requireTimestamp(
    binding.expiresAt,
    "external approval binding.expiresAt",
  );
  if (Date.parse(expiresAt) <= Date.parse(requestedAt)) {
    throw new Error(
      "external approval binding.expiresAt must be after requestedAt",
    );
  }

  return {
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
    approvalId: requireNonEmptyString(
      binding.approvalId,
      "external approval binding.approvalId",
    ),
    threadId: requireNonEmptyString(
      binding.threadId,
      "external approval binding.threadId",
    ),
    runId: requireNonEmptyString(
      binding.runId,
      "external approval binding.runId",
    ),
    actionKey: requireNonEmptyString(
      binding.actionKey,
      "external approval binding.actionKey",
    ),
    payloadHash,
    toolClass: "external_side_effect",
    capabilities,
    authorityKind: binding.authorityKind as RunnerExternalApprovalAuthorityKind,
    authorityRevision: requireNonEmptyString(
      binding.authorityRevision,
      "external approval binding.authorityRevision",
    ),
    requestedAt,
    expiresAt,
  };
}

export function serializeCanonicalApprovalPayload(value: unknown): string {
  return serializeCanonicalJsonValue(value, new Set());
}

function serializeCanonicalJsonValue(
  value: unknown,
  ancestors: Set<object>,
): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (Number.isFinite(value) === false) {
      throw new Error("canonical approval payload numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    assertNotCircular(value, ancestors);
    const serialized = value.map((item) =>
      serializeCanonicalJsonValue(item, ancestors));
    ancestors.delete(value);
    return `[${serialized.join(",")}]`;
  }
  if (typeof value === "object") {
    assertNotCircular(value, ancestors);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical approval payload objects must be plain objects");
    }
    const record = value as Record<string, unknown>;
    const serialized = Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) {
          throw new Error(
            `canonical approval payload field '${key}' must not be undefined`,
          );
        }
        return `${JSON.stringify(key)}:${serializeCanonicalJsonValue(record[key], ancestors)}`;
      });
    ancestors.delete(value);
    return `{${serialized.join(",")}}`;
  }
  throw new Error(
    `canonical approval payload cannot serialize values of type '${typeof value}'`,
  );
}

function assertNotCircular(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) {
    throw new Error("canonical approval payload must not contain circular values");
  }
  ancestors.add(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label);
  if (Number.isFinite(Date.parse(timestamp)) === false) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return timestamp;
}

function requireCanonicalStringArray(value: unknown, label: string): string[] {
  if (
    Array.isArray(value) === false ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  const capabilities = value as string[];
  const canonical = [...new Set(capabilities)].sort();
  if (
    canonical.length !== capabilities.length ||
    canonical.some((item, index) => item !== capabilities[index])
  ) {
    throw new Error(`${label} must be sorted and contain unique values`);
  }
  return [...capabilities];
}
