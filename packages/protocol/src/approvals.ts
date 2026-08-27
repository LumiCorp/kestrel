export const RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION =
  "runner_external_approval_binding_v1" as const;
export const RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION =
  "runner_external_approval_binding_v2" as const;
export const HOSTED_TOOL_APPROVAL_DECISIONS = [
  "decline",
  "approve_once",
  "remember_approval",
] as const;
export const STABLE_TOOL_APPROVAL_IDENTITY_VERSION =
  "stable_tool_approval_identity_v1" as const;
export const REMEMBERED_TOOL_APPROVAL_VERSION =
  "remembered_tool_approval_v1" as const;
export const REMEMBERED_TOOL_APPROVAL_EVIDENCE_VERSION =
  "remembered_tool_approval_evidence_v1" as const;

export type HostedToolApprovalDecision =
  (typeof HOSTED_TOOL_APPROVAL_DECISIONS)[number];

export type ToolApprovalMode = "auto" | "ask" | "deny";
export type ToolApprovalReasonCode =
  | "tool_minimum"
  | "environment_policy"
  | "project_restriction"
  | "subject_restriction"
  | "runtime_strict"
  | "remembered_thread";
export type ToolApprovalAuthorityKind =
  | "runtime_policy"
  | "hosted_mcp_grant"
  | "hosted_app_policy";

export interface ToolApprovalDispositionV1 {
  mode: ToolApprovalMode;
  reasonCode: ToolApprovalReasonCode;
  authority: {
    kind: ToolApprovalAuthorityKind;
    revision: string;
  };
}

export interface ToolApprovalPolicyEvidenceV1 {
  environment: ToolApprovalMode;
  project?: ToolApprovalMode | undefined;
  subject?: ToolApprovalMode | undefined;
  minimum: Exclude<ToolApprovalMode, "deny">;
  strictApprovalPerCall?: boolean | undefined;
}

export function resolveToolApprovalDispositionV1(input: {
  environment: ToolApprovalMode;
  project?: ToolApprovalMode | undefined;
  subject?: ToolApprovalMode | undefined;
  minimum?: Exclude<ToolApprovalMode, "deny"> | undefined;
  strictApprovalPerCall?: boolean | undefined;
  authority: ToolApprovalDispositionV1["authority"];
}): ToolApprovalDispositionV1 {
  let mode = input.environment;
  let reasonCode: ToolApprovalReasonCode = "environment_policy";
  if (isStricterApprovalMode(input.project, mode)) {
    mode = input.project!;
    reasonCode = "project_restriction";
  }
  if (isStricterApprovalMode(input.subject, mode)) {
    mode = input.subject!;
    reasonCode = "subject_restriction";
  } else if (input.subject === "ask" && mode === "ask") {
    reasonCode = "subject_restriction";
  }
  if (input.minimum === "ask" && mode !== "deny") {
    if (mode === "auto") mode = "ask";
    if (mode === "ask") reasonCode = "tool_minimum";
  }
  if (input.strictApprovalPerCall === true && mode !== "deny") {
    if (mode === "auto") mode = "ask";
    if (mode === "ask") reasonCode = "runtime_strict";
  }
  return { mode, reasonCode, authority: { ...input.authority } };
}

export function applyRememberedThreadApprovalV1(input: {
  disposition: ToolApprovalDispositionV1;
  exactEvidenceMatch: boolean;
  currentPolicy: ToolApprovalPolicyEvidenceV1;
}): ToolApprovalDispositionV1 {
  if (
    input.exactEvidenceMatch !== true ||
    input.disposition.mode !== "ask" ||
    isRememberApprovalEligibleV1({
      disposition: input.disposition,
      currentPolicy: input.currentPolicy,
    }) === false
  ) {
    return {
      ...input.disposition,
      authority: { ...input.disposition.authority },
    };
  }
  return {
    mode: "auto",
    reasonCode: "remembered_thread",
    authority: { ...input.disposition.authority },
  };
}

export function isRememberApprovalEligibleV1(input: {
  disposition: ToolApprovalDispositionV1;
  currentPolicy?: ToolApprovalPolicyEvidenceV1 | undefined;
}): boolean {
  if (
    input.disposition.mode !== "ask" ||
    (input.disposition.reasonCode !== "environment_policy" &&
      input.disposition.reasonCode !== "project_restriction")
  ) {
    return false;
  }
  const policy = input.currentPolicy;
  if (policy === undefined) return true;
  return (
    policy.environment !== "deny" &&
    policy.project !== "deny" &&
    (policy.environment === "ask" || policy.project === "ask") &&
    policy.subject !== "ask" &&
    policy.subject !== "deny" &&
    policy.minimum === "auto" &&
    policy.strictApprovalPerCall !== true
  );
}

function isStricterApprovalMode(
  candidate: ToolApprovalMode | undefined,
  current: ToolApprovalMode,
) {
  if (candidate === undefined) return false;
  const strictness: Record<ToolApprovalMode, number> = {
    auto: 0,
    ask: 1,
    deny: 2,
  };
  return strictness[candidate] > strictness[current];
}

export interface StableToolApprovalIdentityV1 {
  version: typeof STABLE_TOOL_APPROVAL_IDENTITY_VERSION;
  toolId: string;
  descriptorContractRevision: string;
  approvalAuthorityRevision: string;
}

export type RememberedApprovalScope =
  | { kind: "tool_identity" }
  | {
      kind: "exec_command_exact";
      command: string;
      cwd: string;
      envNames: string[];
      envMode: string;
    };

export interface RememberedToolApprovalV1 {
  version: typeof REMEMBERED_TOOL_APPROVAL_VERSION;
  id: string;
  organizationId: string;
  threadId: string;
  actorUserId: string;
  toolIdentity: StableToolApprovalIdentityV1;
  scope: RememberedApprovalScope;
  sourceInteractionId: string;
  createdAt: string;
}

export interface RememberedToolApprovalEvidenceV1 {
  version: typeof REMEMBERED_TOOL_APPROVAL_EVIDENCE_VERSION;
  organizationId: string;
  projectId: string;
  environmentId: string;
  threadId: string;
  actorUserId: string;
  toolIdentity: StableToolApprovalIdentityV1;
  scope: RememberedApprovalScope;
  sourceInteractionId: string;
}

export interface RunnerApprovalActorAuthorityV1 {
  actorType: "end_user" | "operator" | "service";
  actorId: string;
  tenantId?: string | undefined;
}

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

export interface RunnerExternalApprovalBindingV2 {
  version: typeof RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION;
  approvalId: string;
  preparedInvocationId: string;
  threadId: string;
  actionKey: string;
  payloadHash: string;
  stableAuthorityFingerprint: string;
  stableToolIdentity: StableToolApprovalIdentityV1;
  requestingActor: RunnerApprovalActorAuthorityV1;
  toolClass: "external_side_effect";
  capabilities: string[];
  authorityKind: RunnerExternalApprovalAuthorityKind;
  authorityRevision: string;
  requestedAt: string;
  expiresAt: string;
}

export type RunnerExternalApprovalBinding =
  | RunnerExternalApprovalBindingV1
  | RunnerExternalApprovalBindingV2;

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
const BINDING_V2_FIELDS = new Set([
  "version",
  "approvalId",
  "preparedInvocationId",
  "threadId",
  "actionKey",
  "payloadHash",
  "stableAuthorityFingerprint",
  "stableToolIdentity",
  "requestingActor",
  "toolClass",
  "capabilities",
  "authorityKind",
  "authorityRevision",
  "requestedAt",
  "expiresAt",
]);
const STABLE_TOOL_IDENTITY_FIELDS = new Set([
  "version",
  "toolId",
  "descriptorContractRevision",
  "approvalAuthorityRevision",
]);
const ACTOR_AUTHORITY_FIELDS = new Set(["actorType", "actorId", "tenantId"]);
const REMEMBERED_APPROVAL_FIELDS = new Set([
  "scope",
  "version",
  "id",
  "organizationId",
  "threadId",
  "actorUserId",
  "toolIdentity",
  "sourceInteractionId",
  "createdAt",
]);
const REMEMBERED_EVIDENCE_FIELDS = new Set([
  "scope",
  "version",
  "organizationId",
  "projectId",
  "environmentId",
  "threadId",
  "actorUserId",
  "toolIdentity",
  "sourceInteractionId",
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

export function parseRunnerExternalApprovalBindingV2(
  value: unknown,
): RunnerExternalApprovalBindingV2 {
  const binding = requireRecord(value, "external approval binding v2");
  rejectUnknown(binding, BINDING_V2_FIELDS, "external approval binding v2");
  if (binding.version !== RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION) {
    throw new Error(
      `external approval binding v2.version must be '${RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION}'`,
    );
  }
  if (binding.toolClass !== "external_side_effect") {
    throw new Error(
      "external approval binding v2.toolClass must be 'external_side_effect'",
    );
  }
  if (
    typeof binding.authorityKind !== "string" ||
    RUNNER_EXTERNAL_APPROVAL_AUTHORITY_KINDS.includes(
      binding.authorityKind as RunnerExternalApprovalAuthorityKind,
    ) === false
  ) {
    throw new Error("external approval binding v2.authorityKind is invalid");
  }
  const payloadHash = requireSha256(
    binding.payloadHash,
    "external approval binding v2.payloadHash",
  );
  const stableAuthorityFingerprint = requireSha256(
    binding.stableAuthorityFingerprint,
    "external approval binding v2.stableAuthorityFingerprint",
  );
  const requestedAt = requireTimestamp(
    binding.requestedAt,
    "external approval binding v2.requestedAt",
  );
  const expiresAt = requireTimestamp(
    binding.expiresAt,
    "external approval binding v2.expiresAt",
  );
  if (Date.parse(expiresAt) <= Date.parse(requestedAt)) {
    throw new Error(
      "external approval binding v2.expiresAt must be after requestedAt",
    );
  }
  const stableToolIdentity = parseStableToolApprovalIdentityV1(
    binding.stableToolIdentity,
  );
  const actionKey = requireNonEmptyString(
    binding.actionKey,
    "external approval binding v2.actionKey",
  );
  const authorityRevision = requireNonEmptyString(
    binding.authorityRevision,
    "external approval binding v2.authorityRevision",
  );
  if (actionKey !== stableToolIdentity.toolId) {
    throw new Error(
      "external approval binding v2.actionKey must match stableToolIdentity.toolId",
    );
  }
  if (authorityRevision !== stableToolIdentity.approvalAuthorityRevision) {
    throw new Error(
      "external approval binding v2.authorityRevision must match stableToolIdentity.approvalAuthorityRevision",
    );
  }
  return {
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
    approvalId: requireNonEmptyString(binding.approvalId, "external approval binding v2.approvalId"),
    preparedInvocationId: requireNonEmptyString(binding.preparedInvocationId, "external approval binding v2.preparedInvocationId"),
    threadId: requireNonEmptyString(binding.threadId, "external approval binding v2.threadId"),
    actionKey,
    payloadHash,
    stableAuthorityFingerprint,
    stableToolIdentity,
    requestingActor: parseRunnerApprovalActorAuthorityV1(binding.requestingActor),
    toolClass: "external_side_effect",
    capabilities: requireCanonicalStringArray(binding.capabilities, "external approval binding v2.capabilities"),
    authorityKind: binding.authorityKind as RunnerExternalApprovalAuthorityKind,
    authorityRevision,
    requestedAt,
    expiresAt,
  };
}

export function parseRunnerExternalApprovalBinding(
  value: unknown,
): RunnerExternalApprovalBinding {
  const binding = requireRecord(value, "external approval binding");
  if (binding.version === RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION) {
    return parseRunnerExternalApprovalBindingV1(binding);
  }
  if (binding.version === RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION) {
    return parseRunnerExternalApprovalBindingV2(binding);
  }
  throw new Error("external approval binding.version is unsupported");
}

export function parseHostedToolApprovalDecision(
  value: unknown,
): HostedToolApprovalDecision {
  if (
    typeof value !== "string" ||
    HOSTED_TOOL_APPROVAL_DECISIONS.includes(value as HostedToolApprovalDecision) === false
  ) {
    throw new Error("hosted tool approval decision is invalid");
  }
  return value as HostedToolApprovalDecision;
}

export function parseStableToolApprovalIdentityV1(
  value: unknown,
): StableToolApprovalIdentityV1 {
  const identity = requireRecord(value, "stable tool approval identity");
  rejectUnknown(identity, STABLE_TOOL_IDENTITY_FIELDS, "stable tool approval identity");
  if (identity.version !== STABLE_TOOL_APPROVAL_IDENTITY_VERSION) {
    throw new Error(
      `stable tool approval identity.version must be '${STABLE_TOOL_APPROVAL_IDENTITY_VERSION}'`,
    );
  }
  return {
    version: STABLE_TOOL_APPROVAL_IDENTITY_VERSION,
    toolId: requireNonEmptyString(identity.toolId, "stable tool approval identity.toolId"),
    descriptorContractRevision: requireNonEmptyString(identity.descriptorContractRevision, "stable tool approval identity.descriptorContractRevision"),
    approvalAuthorityRevision: requireNonEmptyString(identity.approvalAuthorityRevision, "stable tool approval identity.approvalAuthorityRevision"),
  };
}

export function parseRememberedApprovalScope(
  value: unknown,
): RememberedApprovalScope {
  const scope = requireRecord(value, "remembered approval scope");
  if (scope.kind === "tool_identity") {
    rejectUnknown(scope, new Set(["kind"]), "remembered approval scope");
    return { kind: "tool_identity" };
  }
  if (scope.kind !== "exec_command_exact") {
    throw new Error("remembered approval scope.kind is invalid");
  }
  rejectUnknown(
    scope,
    new Set(["kind", "command", "cwd", "envNames", "envMode"]),
    "remembered approval scope",
  );
  if (!Array.isArray(scope.envNames) || scope.envNames.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error("remembered approval scope.envNames must contain non-empty strings");
  }
  const envNames = [...scope.envNames].sort();
  if (new Set(envNames).size !== envNames.length) {
    throw new Error("remembered approval scope.envNames must be unique");
  }
  return {
    kind: "exec_command_exact",
    command: requireNonEmptyString(scope.command, "remembered approval scope.command"),
    cwd: requireNonEmptyString(scope.cwd, "remembered approval scope.cwd"),
    envNames,
    envMode: requireNonEmptyString(scope.envMode, "remembered approval scope.envMode"),
  };
}

export function parseRememberedToolApprovalV1(
  value: unknown,
): RememberedToolApprovalV1 {
  const approval = requireRecord(value, "remembered tool approval");
  rejectUnknown(approval, REMEMBERED_APPROVAL_FIELDS, "remembered tool approval");
  if (approval.version !== REMEMBERED_TOOL_APPROVAL_VERSION) {
    throw new Error(
      `remembered tool approval.version must be '${REMEMBERED_TOOL_APPROVAL_VERSION}'`,
    );
  }
  return {
    version: REMEMBERED_TOOL_APPROVAL_VERSION,
    id: requireNonEmptyString(approval.id, "remembered tool approval.id"),
    organizationId: requireNonEmptyString(approval.organizationId, "remembered tool approval.organizationId"),
    threadId: requireNonEmptyString(approval.threadId, "remembered tool approval.threadId"),
    actorUserId: requireNonEmptyString(approval.actorUserId, "remembered tool approval.actorUserId"),
    toolIdentity: parseStableToolApprovalIdentityV1(approval.toolIdentity),
    scope: parseRememberedApprovalScope(approval.scope),
    sourceInteractionId: requireNonEmptyString(approval.sourceInteractionId, "remembered tool approval.sourceInteractionId"),
    createdAt: requireTimestamp(approval.createdAt, "remembered tool approval.createdAt"),
  };
}

export function parseRememberedToolApprovalEvidenceV1(
  value: unknown,
): RememberedToolApprovalEvidenceV1 {
  const evidence = requireRecord(value, "remembered tool approval evidence");
  rejectUnknown(evidence, REMEMBERED_EVIDENCE_FIELDS, "remembered tool approval evidence");
  if (evidence.version !== REMEMBERED_TOOL_APPROVAL_EVIDENCE_VERSION) {
    throw new Error(
      `remembered tool approval evidence.version must be '${REMEMBERED_TOOL_APPROVAL_EVIDENCE_VERSION}'`,
    );
  }
  return {
    version: REMEMBERED_TOOL_APPROVAL_EVIDENCE_VERSION,
    organizationId: requireNonEmptyString(evidence.organizationId, "remembered tool approval evidence.organizationId"),
    projectId: requireNonEmptyString(evidence.projectId, "remembered tool approval evidence.projectId"),
    environmentId: requireNonEmptyString(evidence.environmentId, "remembered tool approval evidence.environmentId"),
    threadId: requireNonEmptyString(evidence.threadId, "remembered tool approval evidence.threadId"),
    actorUserId: requireNonEmptyString(evidence.actorUserId, "remembered tool approval evidence.actorUserId"),
    toolIdentity: parseStableToolApprovalIdentityV1(evidence.toolIdentity),
    scope: parseRememberedApprovalScope(evidence.scope),
    sourceInteractionId: requireNonEmptyString(evidence.sourceInteractionId, "remembered tool approval evidence.sourceInteractionId"),
  };
}

export function parseRememberedToolApprovalEvidenceSetV1(
  value: unknown,
): RememberedToolApprovalEvidenceV1[] {
  if (value === undefined) return [];
  if (Array.isArray(value) === false) {
    throw new Error("remembered tool approval evidence must be an array");
  }
  return value.map(parseRememberedToolApprovalEvidenceV1);
}

function parseRunnerApprovalActorAuthorityV1(
  value: unknown,
): RunnerApprovalActorAuthorityV1 {
  const actor = requireRecord(value, "approval actor authority");
  rejectUnknown(actor, ACTOR_AUTHORITY_FIELDS, "approval actor authority");
  if (
    actor.actorType !== "end_user" &&
    actor.actorType !== "operator" &&
    actor.actorType !== "service"
  ) {
    throw new Error("approval actor authority.actorType is invalid");
  }
  return {
    actorType: actor.actorType,
    actorId: requireNonEmptyString(actor.actorId, "approval actor authority.actorId"),
    ...(actor.tenantId === undefined
      ? {}
      : { tenantId: requireNonEmptyString(actor.tenantId, "approval actor authority.tenantId") }),
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

function requireSha256(value: unknown, label: string): string {
  const digest = requireNonEmptyString(value, label);
  if (SHA256_PATTERN.test(digest) === false) {
    throw new Error(`${label} must use sha256:<64 lowercase hex>`);
  }
  return digest;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key) === false) {
      throw new Error(`${label} contains unknown field '${key}'`);
    }
  }
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
