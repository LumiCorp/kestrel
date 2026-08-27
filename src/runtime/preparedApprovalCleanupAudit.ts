import type { EffectResult } from "../kestrel/contracts/execution.js";
import type { RunEvent } from "../kestrel/contracts/events.js";
import type { PersistedEffect } from "../kestrel/contracts/store.js";
import { canonicalJson, hashCanonical } from "../kestrel/contracts/tool-contract.js";
import { sanitizeUtf16String } from "./jsonSanitizer.js";

const MAX_DEPTH = 4;
const MAX_NODES = 128;
const MAX_CONTAINER_ENTRIES = 16;
const MAX_STRING_CODE_UNITS = 256;
const OMIT_NORMALIZED_VALUE = Symbol("omit-cleanup-evidence-value");
const NORMALIZATION_MARKER = "$kestrelCleanupEvidence";

export const PREPARED_APPROVAL_CLEANUP_QUARANTINE_AUDIT_MAX_METADATA_BYTES =
  4_096;

interface BoundedProjectionState {
  nodesVisited: number;
  sourceBytesObserved: number;
  sourceBytesTruncated: boolean;
  traversalTruncated: boolean;
  ancestors: WeakSet<object>;
}

interface BoundedShapeSummary {
  type: string;
  topLevelEntriesObserved?: number | undefined;
  topLevelEntriesTruncated?: boolean | undefined;
  topLevelValueTypes?: Record<string, number> | undefined;
}

type NormalizedCleanupEvidenceValue =
  | null
  | boolean
  | number
  | string
  | NormalizedCleanupEvidenceValue[]
  | { [key: string]: NormalizedCleanupEvidenceValue };

export function normalizePreparedApprovalCleanupDoneEvidence(
  result: EffectResult & { status: "DONE" },
): EffectResult & { status: "DONE" } {
  const state: BoundedProjectionState = {
    nodesVisited: 0,
    sourceBytesObserved: 0,
    sourceBytesTruncated: false,
    traversalTruncated: false,
    ancestors: new WeakSet<object>(),
  };
  const output = normalizeEvidenceValue(result.output, state, 0, "root");
  const error = normalizeEvidenceValue(result.error, state, 0, "root");
  return {
    idempotencyKey: result.idempotencyKey,
    status: "DONE",
    ...(output === OMIT_NORMALIZED_VALUE ? {} : { output }),
    ...(error === OMIT_NORMALIZED_VALUE ? {} : { error: error as never }),
    timestamp: result.timestamp,
  };
}

export function buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent(input: {
  effect: PersistedEffect;
  invalidResult: EffectResult & { status: "DONE" };
  occurredAt: string;
}): RunEvent {
  const normalizedResult = normalizePreparedApprovalCleanupDoneEvidence(
    input.invalidResult,
  );
  const evidence = projectBoundedEvidence({
    output: normalizedResult.output,
    error: normalizedResult.error,
  });
  const effectIdentity = {
    runId: projectIdentifier(input.effect.runId),
    sessionId: projectIdentifier(input.effect.sessionId),
    idempotencyKey: projectIdentifier(input.effect.idempotencyKey),
  };
  const resultIdentity = {
    idempotencyKey: projectIdentifier(input.invalidResult.idempotencyKey),
    status: input.invalidResult.status,
    originalTimestamp: projectTimestamp(input.invalidResult.timestamp),
  };
  const metadata = {
    version: "prepared_approval_cleanup_done_evidence_quarantine_v2",
    validationReasonCode:
      "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
    effectIdentity,
    resultIdentity,
    evidence,
    ...projectReleasedPreparedInvocationId(input.invalidResult.output),
  };
  return {
    runId: input.effect.runId,
    sessionId: input.effect.sessionId,
    stepIndex: input.effect.stepIndex,
    type: "prepared_approval_cleanup.done_evidence_quarantined",
    level: "WARN",
    timestamp: input.occurredAt,
    metadata: boundPreparedApprovalCleanupQuarantineAuditMetadata(
      metadata,
      String(evidence.canonicalHash),
    ),
  };
}

export function boundPreparedApprovalCleanupQuarantineAuditMetadata(
  metadata: Record<string, unknown>,
  canonicalHash: string,
): Record<string, unknown> {
  if (
    Buffer.byteLength(JSON.stringify(metadata)) <=
    PREPARED_APPROVAL_CLEANUP_QUARANTINE_AUDIT_MAX_METADATA_BYTES
  ) return metadata;
  return {
    version: "prepared_approval_cleanup_done_evidence_quarantine_v2",
    validationReasonCode:
      "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
    projectionStatus: "metadata_bound_exceeded",
    evidence: { canonicalHash },
  };
}

function normalizeEvidenceValue(
  value: unknown,
  state: BoundedProjectionState,
  depth: number,
  container: "root" | "object" | "array",
): NormalizedCleanupEvidenceValue | typeof OMIT_NORMALIZED_VALUE {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return container === "array" ? null : OMIT_NORMALIZED_VALUE;
  }
  if (state.nodesVisited >= MAX_NODES) {
    state.traversalTruncated = true;
    return normalizationMarker("node_limit");
  }
  state.nodesVisited += 1;
  if (value === null) return null;
  switch (typeof value) {
    case "string": {
      const truncated = value.length > MAX_STRING_CODE_UNITS;
      state.sourceBytesTruncated ||= truncated;
      return truncated
        ? normalizationMarker("truncated_string", projectIdentifier(value))
        : sanitizeUtf16String(value);
    }
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      state.sourceBytesTruncated = true;
      return normalizationMarker("bigint");
    case "object":
      break;
  }
  if (state.ancestors.has(value)) {
    state.traversalTruncated = true;
    return normalizationMarker("circular");
  }
  let array: boolean;
  try {
    array = Array.isArray(value);
  } catch {
    state.traversalTruncated = true;
    return normalizationMarker("uninspectable");
  }
  if (depth >= MAX_DEPTH) {
    state.traversalTruncated = true;
    return normalizationMarker(`${array ? "array" : "object"}_depth_limit`);
  }
  state.ancestors.add(value);
  try {
    return array
      ? normalizeEvidenceArray(value as unknown[], state, depth)
      : normalizeEvidenceObject(
          value as Record<string, unknown>,
          state,
          depth,
        );
  } finally {
    state.ancestors.delete(value);
  }
}

function normalizeEvidenceArray(
  value: unknown[],
  state: BoundedProjectionState,
  depth: number,
): NormalizedCleanupEvidenceValue {
  let length: number;
  try {
    length = value.length;
  } catch {
    state.traversalTruncated = true;
    return normalizationMarker("uninspectable_array");
  }
  const truncated = length > MAX_CONTAINER_ENTRIES;
  const observed = Math.min(
    length,
    truncated ? MAX_CONTAINER_ENTRIES - 1 : MAX_CONTAINER_ENTRIES,
  );
  state.traversalTruncated ||= truncated;
  const normalized: NormalizedCleanupEvidenceValue[] = [];
  for (let index = 0; index < observed; index += 1) {
    let member: unknown;
    try {
      member = value[index];
    } catch {
      state.traversalTruncated = true;
      member = normalizationMarker("unreadable");
    }
    const next = normalizeEvidenceValue(member, state, depth + 1, "array");
    normalized.push(next === OMIT_NORMALIZED_VALUE ? null : next);
  }
  if (truncated) normalized.push(normalizationMarker("array_truncated"));
  return normalized;
}

function normalizeEvidenceObject(
  value: Record<string, unknown>,
  state: BoundedProjectionState,
  depth: number,
): NormalizedCleanupEvidenceValue {
  let selection: { keys: string[]; truncated: boolean };
  try {
    selection = selectCanonicalOwnKeys(value);
  } catch {
    state.traversalTruncated = true;
    return normalizationMarker("uninspectable_object");
  }
  state.traversalTruncated ||= selection.truncated;
  const normalized: Record<string, NormalizedCleanupEvidenceValue> = {};
  const selectedKeys = selection.truncated
    ? selection.keys.slice(0, MAX_CONTAINER_ENTRIES - 1)
    : selection.keys;
  for (const key of selectedKeys) {
    let member: unknown;
    try {
      member = value[key];
    } catch {
      state.traversalTruncated = true;
      member = normalizationMarker("unreadable");
    }
    const next = normalizeEvidenceValue(member, state, depth + 1, "object");
    if (next === OMIT_NORMALIZED_VALUE) continue;
    const safeKey = sanitizeUtf16String(key.slice(0, MAX_STRING_CODE_UNITS));
    Object.defineProperty(normalized, safeKey, {
      value: next,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (selection.truncated) {
    Object.defineProperty(normalized, NORMALIZATION_MARKER, {
      value: "object_truncated",
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return normalized;
}

function normalizationMarker(
  kind: string,
  evidence: Record<string, unknown> = {},
): NormalizedCleanupEvidenceValue {
  return { [NORMALIZATION_MARKER]: kind, ...evidence } as
    NormalizedCleanupEvidenceValue;
}

function projectBoundedEvidence(input: {
  output: unknown;
  error: unknown;
}): Record<string, unknown> {
  const state: BoundedProjectionState = {
    nodesVisited: 0,
    sourceBytesObserved: 0,
    sourceBytesTruncated: false,
    traversalTruncated: false,
    ancestors: new WeakSet<object>(),
  };
  const output = projectValue(input.output, state, 0);
  const error = projectValue(input.error, state, 0);
  const canonicalProjection = { output: output.canonical, error: error.canonical };
  return {
    canonicalHash: hashCanonical(canonicalProjection),
    canonicalByteSize: Buffer.byteLength(canonicalJson(canonicalProjection)),
    sourceBytesObserved: state.sourceBytesObserved,
    sourceBytesTruncated: state.sourceBytesTruncated,
    traversalTruncated: state.traversalTruncated,
    nodesVisited: state.nodesVisited,
    outputShape: output.summary,
    errorShape: error.summary,
  };
}

function projectValue(
  value: unknown,
  state: BoundedProjectionState,
  depth: number,
): { canonical: unknown; summary: BoundedShapeSummary } {
  if (state.nodesVisited >= MAX_NODES) {
    state.traversalTruncated = true;
    return truncatedProjection("node_limit");
  }
  state.nodesVisited += 1;
  if (value === null) return primitiveProjection("null", null, state);
  switch (typeof value) {
    case "string": {
      const truncated = value.length > MAX_STRING_CODE_UNITS;
      const safe = sanitizeUtf16String(
        value.slice(0, MAX_STRING_CODE_UNITS),
      );
      state.sourceBytesObserved += Buffer.byteLength(safe);
      state.sourceBytesTruncated ||= truncated;
      return {
        canonical: {
          type: "string",
          value: safe,
          codeUnitsObserved: Math.min(value.length, MAX_STRING_CODE_UNITS),
          truncated,
        },
        summary: { type: "string" },
      };
    }
    case "number":
      return primitiveProjection(
        "number",
        Number.isFinite(value) ? value : String(value),
        state,
      );
    case "boolean":
      return primitiveProjection("boolean", value, state);
    case "undefined":
      return primitiveProjection("undefined", null, state);
    case "bigint":
      state.sourceBytesTruncated = true;
      return primitiveProjection("bigint", null, state);
    case "symbol":
      return primitiveProjection("symbol", null, state);
    case "function":
      return primitiveProjection("function", null, state);
    case "object":
      break;
  }
  if (state.ancestors.has(value)) {
    state.traversalTruncated = true;
    return truncatedProjection("circular");
  }
  const containerType = Array.isArray(value) ? "array" : "object";
  if (depth >= MAX_DEPTH) {
    state.traversalTruncated = true;
    return truncatedProjection(`${containerType}_depth_limit`);
  }
  state.ancestors.add(value);
  try {
    return Array.isArray(value)
      ? projectArray(value, state, depth)
      : projectObject(value as Record<string, unknown>, state, depth);
  } finally {
    state.ancestors.delete(value);
  }
}

function projectArray(
  value: unknown[],
  state: BoundedProjectionState,
  depth: number,
): { canonical: unknown; summary: BoundedShapeSummary } {
  const observed = Math.min(value.length, MAX_CONTAINER_ENTRIES);
  const carriesTruncationMarker = value.some((entry) =>
    isNormalizationMarker(entry, "array_truncated")
  );
  const entries: unknown[] = [];
  const types: Record<string, number> = {};
  for (let index = 0; index < observed; index += 1) {
    const projected = projectValue(value[index], state, depth + 1);
    entries.push(projected.canonical);
    incrementType(types, projected.summary.type);
  }
  const truncated = value.length > observed || carriesTruncationMarker;
  state.traversalTruncated ||= truncated;
  return {
    canonical: { type: "array", entries, observed, truncated },
    summary: {
      type: "array",
      topLevelEntriesObserved: observed,
      topLevelEntriesTruncated: truncated,
      topLevelValueTypes: types,
    },
  };
}

function projectObject(
  value: Record<string, unknown>,
  state: BoundedProjectionState,
  depth: number,
): { canonical: unknown; summary: BoundedShapeSummary } {
  const normalizationKind = readNormalizationKind(value);
  if (normalizationKind === "truncated_string" || normalizationKind === "bigint") {
    state.sourceBytesTruncated = true;
  }
  if (
    normalizationKind !== undefined &&
    normalizationKind !== "truncated_string" &&
    normalizationKind !== "bigint"
  ) {
    state.traversalTruncated = true;
  }
  let selection: { keys: string[]; truncated: boolean };
  try {
    selection = selectCanonicalOwnKeys(value);
  } catch {
    state.traversalTruncated = true;
    return truncatedProjection("object_enumeration_failed");
  }
  const entries: Array<{ key: string; value: unknown }> = [];
  const types: Record<string, number> = {};
  for (const key of selection.keys) {
    const keyEvidence = projectIdentifier(key);
    state.sourceBytesObserved += keyEvidence.utf8ByteSize;
    let member: unknown;
    try {
      member = value[key];
    } catch {
      state.traversalTruncated = true;
      member = undefined;
    }
    const projected = projectValue(member, state, depth + 1);
    entries.push({ key: keyEvidence.canonicalHash, value: projected.canonical });
    incrementType(types, projected.summary.type);
  }
  const carriesTruncationMarker = normalizationKind === "object_truncated";
  state.traversalTruncated ||= selection.truncated || carriesTruncationMarker;
  return {
    canonical: {
      type: "object",
      entries,
      observed: selection.keys.length,
      truncated: selection.truncated || carriesTruncationMarker,
    },
    summary: {
      type: "object",
      topLevelEntriesObserved: selection.keys.length,
      topLevelEntriesTruncated: selection.truncated || carriesTruncationMarker,
      topLevelValueTypes: types,
    },
  };
}

function readNormalizationKind(value: Record<string, unknown>): string | undefined {
  let marker: unknown;
  try {
    marker = value[NORMALIZATION_MARKER];
  } catch {
    return;
  }
  return typeof marker === "string" ? marker : undefined;
}

function isNormalizationMarker(value: unknown, kind: string): boolean {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    readNormalizationKind(value as Record<string, unknown>) === kind;
}

function selectCanonicalOwnKeys(value: Record<string, unknown>): {
  keys: string[];
  truncated: boolean;
} {
  const selected: string[] = [];
  let ownKeyCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    ownKeyCount += 1;
    let insertAt = selected.findIndex((candidate) => key < candidate);
    if (insertAt < 0) insertAt = selected.length;
    selected.splice(insertAt, 0, key);
    if (selected.length > MAX_CONTAINER_ENTRIES) selected.pop();
  }
  return { keys: selected, truncated: ownKeyCount > selected.length };
}

function primitiveProjection(
  type: string,
  value: unknown,
  state: BoundedProjectionState,
): { canonical: unknown; summary: BoundedShapeSummary } {
  const canonical = { type, value };
  state.sourceBytesObserved += Buffer.byteLength(canonicalJson(canonical));
  return { canonical, summary: { type } };
}

function truncatedProjection(
  reason: string,
): { canonical: unknown; summary: BoundedShapeSummary } {
  return {
    canonical: { type: "truncated", reason },
    summary: { type: "truncated" },
  };
}

function incrementType(types: Record<string, number>, type: string): void {
  types[type] = (types[type] ?? 0) + 1;
}

function projectReleasedPreparedInvocationId(
  output: unknown,
): Record<string, unknown> {
  if (typeof output !== "object" || output === null) {
    return {};
  }
  try {
    if (Array.isArray(output)) return {};
  } catch {
    return {};
  }
  let candidate: unknown;
  try {
    candidate = (output as Record<string, unknown>)
      .releasedPreparedInvocationId;
  } catch {
    return {};
  }
  if (typeof candidate !== "string") return {};
  return {
    releasedPreparedInvocationId: projectIdentifier(candidate),
  };
}

function projectIdentifier(value: string): {
  canonicalHash: string;
  utf8ByteSize: number;
} {
  return {
    canonicalHash: hashCanonical({ value }),
    utf8ByteSize: Buffer.byteLength(value),
  };
}

function projectTimestamp(value: unknown): string | Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (
      Number.isFinite(parsed) &&
      new Date(parsed).toISOString() === value
    ) {
      return value;
    }
    return { type: "string", ...projectIdentifier(value) };
  }
  return { type: value === null ? "null" : typeof value };
}
