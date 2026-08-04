import { createHash } from "node:crypto";

export const EXECUTION_BOUNDARY_POLICY_VERSION =
  "execution_boundary_policy_v1" as const;
export const EXECUTION_BOUNDARY_DECISION_VERSION =
  "execution_boundary_decision_v1" as const;
export const BOUNDARY_CONTENT_PROVENANCE_VERSION =
  "boundary_content_provenance_v1" as const;

export const EXECUTION_BOUNDARIES = Object.freeze([
  "user_input",
  "model_request",
  "model_stream",
  "model_action",
  "assembly_change",
  "tool_request",
  "tool_stream",
  "tool_result",
  "assistant_output",
] as const);

export type ExecutionBoundaryV1 = typeof EXECUTION_BOUNDARIES[number];
export type ExecutionBoundaryOutcomeV1 =
  | "ALLOW"
  | "DENY"
  | "APPROVAL_REQUIRED"
  | "REDACT"
  | "MODIFY"
  | "QUARANTINE"
  | "ESCALATE";

export interface ExecutionBoundaryPolicyV1 {
  version: typeof EXECUTION_BOUNDARY_POLICY_VERSION;
  policyId: string;
  revision: string;
  owner: string;
  changeId: string;
  supersedesRevision?: string | undefined;
  enforcement: "enforce";
  boundaries: ExecutionBoundaryV1[];
}

export interface SensitiveValueReferenceV1 {
  referenceId: string;
  kind: "credential" | "typed_sensitive";
  scope: string;
}

export interface BoundaryContentProvenanceV1 {
  version: typeof BOUNDARY_CONTENT_PROVENANCE_VERSION;
  source: "runtime" | "user" | "model" | "tool";
  trust: "control" | "data";
  sourceId: string;
  contentDigest: string;
}

export interface ExecutionBoundaryDecisionV1 {
  version: typeof EXECUTION_BOUNDARY_DECISION_VERSION;
  decisionId: string;
  runId: string;
  sessionId: string;
  callId?: string | undefined;
  stepIndex?: number | undefined;
  policyId: string;
  policyRevision: string;
  boundary: ExecutionBoundaryV1;
  provenance: BoundaryContentProvenanceV1;
  inputDigest: string;
  outputDigest: string;
  outcome: ExecutionBoundaryOutcomeV1;
  reasonCode: string;
  sensitiveReferences: SensitiveValueReferenceV1[];
  transformId?: "redact.registered_values.v1" | undefined;
  createdAt: string;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const POLICY_FIELDS = new Set([
  "version",
  "policyId",
  "revision",
  "owner",
  "changeId",
  "supersedesRevision",
  "enforcement",
  "boundaries",
]);
const PROVENANCE_FIELDS = new Set([
  "version",
  "source",
  "trust",
  "sourceId",
  "contentDigest",
]);
const DECISION_FIELDS = new Set([
  "version",
  "decisionId",
  "runId",
  "sessionId",
  "callId",
  "stepIndex",
  "policyId",
  "policyRevision",
  "boundary",
  "provenance",
  "inputDigest",
  "outputDigest",
  "outcome",
  "reasonCode",
  "sensitiveReferences",
  "transformId",
  "createdAt",
]);
const REFERENCE_FIELDS = new Set(["referenceId", "kind", "scope"]);
const OUTCOMES = new Set<ExecutionBoundaryOutcomeV1>([
  "ALLOW",
  "DENY",
  "APPROVAL_REQUIRED",
  "REDACT",
  "MODIFY",
  "QUARANTINE",
  "ESCALATE",
]);

export function createExecutionBoundaryPolicyV1(
  input: Omit<ExecutionBoundaryPolicyV1, "version" | "revision">,
): ExecutionBoundaryPolicyV1 {
  const draft: ExecutionBoundaryPolicyV1 = {
    version: EXECUTION_BOUNDARY_POLICY_VERSION,
    policyId: input.policyId,
    revision: emptyHash(),
    owner: input.owner,
    changeId: input.changeId,
    ...(input.supersedesRevision !== undefined
      ? { supersedesRevision: input.supersedesRevision }
      : {}),
    enforcement: input.enforcement,
    boundaries: [...input.boundaries],
  };
  draft.revision = fingerprintExecutionBoundaryPolicyV1(draft);
  return parseExecutionBoundaryPolicyV1(draft);
}

export function parseExecutionBoundaryPolicyV1(
  value: unknown,
): ExecutionBoundaryPolicyV1 {
  const record = requireRecord(value, "Execution-boundary policy");
  rejectUnknownFields(record, POLICY_FIELDS, "Execution-boundary policy");
  if (record.version !== EXECUTION_BOUNDARY_POLICY_VERSION) {
    throw new Error(
      `Execution-boundary policy version must be '${EXECUTION_BOUNDARY_POLICY_VERSION}'.`,
    );
  }
  if (record.enforcement !== "enforce") {
    throw new Error("Execution-boundary policy enforcement must be 'enforce'.");
  }
  const boundaries = requireArray(
    record.boundaries,
    "Execution-boundary policy boundaries",
  ).map((item, index) =>
    requireBoundary(item, `Execution-boundary policy boundaries[${index}]`));
  requireUnique(boundaries, "Execution-boundary policy boundaries");
  if (
    boundaries.length !== EXECUTION_BOUNDARIES.length ||
    boundaries.some((boundary, index) => boundary !== EXECUTION_BOUNDARIES[index])
  ) {
    throw new Error(
      "Execution-boundary policy boundaries must match the exact canonical boundary order.",
    );
  }
  const policy: ExecutionBoundaryPolicyV1 = {
    version: EXECUTION_BOUNDARY_POLICY_VERSION,
    policyId: requireString(record.policyId, "Execution-boundary policy policyId"),
    revision: requireHash(record.revision, "Execution-boundary policy revision"),
    owner: requireString(record.owner, "Execution-boundary policy owner"),
    changeId: requireString(record.changeId, "Execution-boundary policy changeId"),
    ...(record.supersedesRevision !== undefined
      ? {
          supersedesRevision: requireHash(
            record.supersedesRevision,
            "Execution-boundary policy supersedesRevision",
          ),
        }
      : {}),
    enforcement: "enforce",
    boundaries,
  };
  if (fingerprintExecutionBoundaryPolicyV1(policy) !== policy.revision) {
    throw new Error(
      "Execution-boundary policy revision does not match its canonical payload.",
    );
  }
  return policy;
}

export function fingerprintExecutionBoundaryPolicyV1(
  policy: ExecutionBoundaryPolicyV1,
): string {
  return digestCanonicalValue({
    version: policy.version,
    policyId: policy.policyId,
    owner: policy.owner,
    changeId: policy.changeId,
    ...(policy.supersedesRevision !== undefined
      ? { supersedesRevision: policy.supersedesRevision }
      : {}),
    enforcement: policy.enforcement,
    boundaries: policy.boundaries,
  });
}

export function parseBoundaryContentProvenanceV1(
  value: unknown,
): BoundaryContentProvenanceV1 {
  const record = requireRecord(value, "Boundary content provenance");
  rejectUnknownFields(record, PROVENANCE_FIELDS, "Boundary content provenance");
  if (record.version !== BOUNDARY_CONTENT_PROVENANCE_VERSION) {
    throw new Error(
      `Boundary content provenance version must be '${BOUNDARY_CONTENT_PROVENANCE_VERSION}'.`,
    );
  }
  if (
    record.source !== "runtime" &&
    record.source !== "user" &&
    record.source !== "model" &&
    record.source !== "tool"
  ) {
    throw new Error("Boundary content provenance source is invalid.");
  }
  if (record.trust !== "control" && record.trust !== "data") {
    throw new Error("Boundary content provenance trust is invalid.");
  }
  if (record.trust === "control" && record.source !== "runtime") {
    throw new Error("Only runtime provenance may carry control trust.");
  }
  return {
    version: BOUNDARY_CONTENT_PROVENANCE_VERSION,
    source: record.source,
    trust: record.trust,
    sourceId: requireString(record.sourceId, "Boundary content provenance sourceId"),
    contentDigest: requireHash(
      record.contentDigest,
      "Boundary content provenance contentDigest",
    ),
  };
}

export function parseSensitiveValueReferenceV1(
  value: unknown,
): SensitiveValueReferenceV1 {
  const record = requireRecord(value, "Sensitive-value reference");
  rejectUnknownFields(record, REFERENCE_FIELDS, "Sensitive-value reference");
  if (record.kind !== "credential" && record.kind !== "typed_sensitive") {
    throw new Error("Sensitive-value reference kind is invalid.");
  }
  return {
    referenceId: requireString(record.referenceId, "Sensitive-value reference referenceId"),
    kind: record.kind,
    scope: requireString(record.scope, "Sensitive-value reference scope"),
  };
}

export function parseExecutionBoundaryDecisionV1(
  value: unknown,
): ExecutionBoundaryDecisionV1 {
  const record = requireRecord(value, "Execution-boundary decision");
  rejectUnknownFields(record, DECISION_FIELDS, "Execution-boundary decision");
  if (record.version !== EXECUTION_BOUNDARY_DECISION_VERSION) {
    throw new Error(
      `Execution-boundary decision version must be '${EXECUTION_BOUNDARY_DECISION_VERSION}'.`,
    );
  }
  if (!OUTCOMES.has(record.outcome as ExecutionBoundaryOutcomeV1)) {
    throw new Error("Execution-boundary decision outcome is invalid.");
  }
  const transformId = record.transformId;
  if (
    transformId !== undefined &&
    transformId !== "redact.registered_values.v1"
  ) {
    throw new Error("Execution-boundary decision transformId is invalid.");
  }
  if (record.outcome === "REDACT" && transformId === undefined) {
    throw new Error("A REDACT decision requires an exact transformId.");
  }
  if (record.outcome !== "REDACT" && transformId !== undefined) {
    throw new Error("Only a REDACT decision may carry transformId in v1.");
  }
  const stepIndex = record.stepIndex === undefined
    ? undefined
    : requireNonNegativeInteger(
        record.stepIndex,
        "Execution-boundary decision stepIndex",
      );
  const sensitiveReferences = requireArray(
    record.sensitiveReferences,
    "Execution-boundary decision sensitiveReferences",
  ).map(parseSensitiveValueReferenceV1);
  requireUnique(
    sensitiveReferences.map((reference) => reference.referenceId),
    "Execution-boundary decision sensitiveReferences",
  );
  return {
    version: EXECUTION_BOUNDARY_DECISION_VERSION,
    decisionId: requireString(record.decisionId, "Execution-boundary decision decisionId"),
    runId: requireString(record.runId, "Execution-boundary decision runId"),
    sessionId: requireString(record.sessionId, "Execution-boundary decision sessionId"),
    ...(record.callId !== undefined
      ? { callId: requireString(record.callId, "Execution-boundary decision callId") }
      : {}),
    ...(stepIndex !== undefined ? { stepIndex } : {}),
    policyId: requireString(record.policyId, "Execution-boundary decision policyId"),
    policyRevision: requireHash(
      record.policyRevision,
      "Execution-boundary decision policyRevision",
    ),
    boundary: requireBoundary(record.boundary, "Execution-boundary decision boundary"),
    provenance: parseBoundaryContentProvenanceV1(record.provenance),
    inputDigest: requireHash(record.inputDigest, "Execution-boundary decision inputDigest"),
    outputDigest: requireHash(record.outputDigest, "Execution-boundary decision outputDigest"),
    outcome: record.outcome as ExecutionBoundaryOutcomeV1,
    reasonCode: requireCode(record.reasonCode, "Execution-boundary decision reasonCode"),
    sensitiveReferences,
    ...(transformId !== undefined ? { transformId } : {}),
    createdAt: requireTimestamp(record.createdAt, "Execution-boundary decision createdAt"),
  };
}

export function digestCanonicalValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) output[key] = sortValue(item);
  }
  return output;
}

function emptyHash(): string {
  return "sha256:0000000000000000000000000000000000000000000000000000000000000000";
}

function requireBoundary(value: unknown, label: string): ExecutionBoundaryV1 {
  if (!EXECUTION_BOUNDARIES.includes(value as ExecutionBoundaryV1)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as ExecutionBoundaryV1;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function requireCode(value: unknown, label: string): string {
  const code = requireString(value, label);
  if (!/^[A-Z][A-Z0-9_]*$/u.test(code)) {
    throw new Error(`${label} must be an uppercase reason code.`);
  }
  return code;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 digest.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown !== undefined) {
    throw new Error(`${label} contains unsupported field '${unknown}'.`);
  }
}
