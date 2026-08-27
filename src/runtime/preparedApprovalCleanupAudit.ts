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
const NORMALIZED_KEY_PREFIX = "$kestrelCleanupKey:v1:";

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

export interface PreparedApprovalCleanupDoneAuditSnapshot {
  resultIdentity: Record<string, unknown>;
  evidence: Record<string, unknown>;
  releasedPreparedInvocationId?: Record<string, unknown> | undefined;
}

export function snapshotPreparedApprovalCleanupDoneResult(input: {
  result: unknown;
  expectedIdempotencyKey: string;
}): {
  snapshot: (EffectResult & { status: "DONE" }) | null;
  auditSnapshot: PreparedApprovalCleanupDoneAuditSnapshot;
} {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input.result);
  } catch {
    return {
      snapshot: null,
      auditSnapshot: materializePreparedApprovalCleanupDoneAuditSnapshot({
        idempotencyKey: UNREADABLE_DESCRIPTOR,
        status: UNREADABLE_DESCRIPTOR,
        output: unreadableAuditValue(),
        error: unreadableAuditValue(),
        timestamp: UNREADABLE_DESCRIPTOR,
      }),
    };
  }
  const idempotencyKey = readDataDescriptor(descriptors.idempotencyKey);
  const status = readDataDescriptor(descriptors.status);
  const output = readDataDescriptor(descriptors.output);
  const error = readDataDescriptor(descriptors.error);
  const timestamp = readDataDescriptor(descriptors.timestamp);
  const materializedOutput = materializeCleanupOutput(output);
  const auditSnapshot = materializePreparedApprovalCleanupDoneAuditSnapshot({
    idempotencyKey,
    status,
    ...(materializedOutput.auditValue === undefined
      ? {}
      : { output: materializedOutput.auditValue }),
    ...(error === UNREADABLE_DESCRIPTOR
      ? { error: unreadableAuditValue() }
      : error === undefined ? {} : { error }),
    timestamp,
  });
  if (
    idempotencyKey !== input.expectedIdempotencyKey ||
    status !== "DONE" ||
    error !== undefined ||
    typeof timestamp !== "string" ||
    !isCanonicalTimestamp(timestamp) ||
    materializedOutput.exactReleasedPreparedInvocationId === undefined
  ) return { snapshot: null, auditSnapshot };
  return {
    snapshot: {
      idempotencyKey,
      status: "DONE",
      output: {
        releasedPreparedInvocationId:
          materializedOutput.exactReleasedPreparedInvocationId,
      },
      timestamp,
    },
    auditSnapshot,
  };
}

function materializeCleanupOutput(value: unknown): {
  auditValue: unknown;
  exactReleasedPreparedInvocationId?: string | undefined;
} {
  if (value === UNREADABLE_DESCRIPTOR) {
    return { auditValue: unreadableAuditValue() };
  }
  if (typeof value !== "object" || value === null) {
    return { auditValue: value };
  }
  let isArray: boolean;
  let descriptors: PropertyDescriptorMap;
  try {
    isArray = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return { auditValue: unreadableAuditValue() };
  }
  const keys = Reflect.ownKeys(descriptors);
  const auditValue: Record<string, unknown> | unknown[] = isArray ? [] : {};
  for (const key of keys) {
    if (typeof key !== "string" || key === "length") continue;
    const descriptor = descriptors[key];
    if (descriptor?.enumerable !== true) continue;
    Object.defineProperty(auditValue, key, {
      value: descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : unreadableAuditValue(),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const releasedDescriptor = descriptors.releasedPreparedInvocationId;
  const exactReleasedPreparedInvocationId =
    !isArray &&
    keys.length === 1 &&
    keys[0] === "releasedPreparedInvocationId" &&
    releasedDescriptor?.enumerable === true &&
    "value" in releasedDescriptor &&
    typeof releasedDescriptor.value === "string"
      ? releasedDescriptor.value
      : undefined;
  return {
    auditValue,
    ...(exactReleasedPreparedInvocationId === undefined
      ? {}
      : { exactReleasedPreparedInvocationId }),
  };
}

const UNREADABLE_DESCRIPTOR = Symbol("unreadable-cleanup-result-descriptor");

function readDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): unknown | typeof UNREADABLE_DESCRIPTOR {
  if (descriptor === undefined) return undefined;
  return "value" in descriptor ? descriptor.value : UNREADABLE_DESCRIPTOR;
}

function unreadableAuditValue(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  Object.defineProperty(value, "unreadable", {
    enumerable: true,
    get() {
      throw new Error("cleanup evidence was unreadable");
    },
  });
  return value;
}

function materializePreparedApprovalCleanupDoneAuditSnapshot(input: {
  idempotencyKey: unknown;
  status: unknown;
  output?: unknown;
  error?: unknown;
  timestamp: unknown;
}): PreparedApprovalCleanupDoneAuditSnapshot {
  const normalizedResult = normalizePreparedApprovalCleanupDoneEvidence({
    idempotencyKey: "audit-only",
    status: "DONE",
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.error === undefined ? {} : { error: input.error as never }),
    timestamp: "1970-01-01T00:00:00.000Z",
  });
  const releasedPreparedInvocationId =
    projectReleasedPreparedInvocationIdFromDescriptor(input.output);
  return {
    resultIdentity: {
      idempotencyKey: projectAuditIdentity(input.idempotencyKey),
      status: projectAuditStatus(input.status),
      originalTimestamp: input.timestamp === UNREADABLE_DESCRIPTOR
        ? { type: "unreadable" }
        : projectTimestamp(input.timestamp),
    },
    evidence: projectBoundedEvidence({
      output: normalizedResult.output,
      error: normalizedResult.error,
    }),
    ...(releasedPreparedInvocationId === undefined
      ? {}
      : { releasedPreparedInvocationId }),
  };
}

function projectAuditIdentity(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return projectIdentifier(value);
  if (value === UNREADABLE_DESCRIPTOR) return { type: "unreadable" };
  const projection = projectBoundedEvidence({ output: value, error: undefined });
  return {
    type: (projection.outputShape as Record<string, unknown>).type,
    canonicalHash: projection.canonicalHash,
  };
}

function projectAuditStatus(value: unknown): unknown {
  if (value === "DONE") return "DONE";
  if (value === UNREADABLE_DESCRIPTOR) return { type: "unreadable" };
  return projectAuditIdentity(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

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
  return buildPreparedApprovalCleanupDoneEvidenceQuarantineEventFromSnapshot({
    effect: input.effect,
    occurredAt: input.occurredAt,
    auditSnapshot: materializePreparedApprovalCleanupDoneAuditSnapshot({
      idempotencyKey: input.invalidResult.idempotencyKey,
      status: input.invalidResult.status,
      output: input.invalidResult.output,
      error: input.invalidResult.error,
      timestamp: input.invalidResult.timestamp,
    }),
  });
}

export function buildPreparedApprovalCleanupDoneEvidenceQuarantineEventFromSnapshot(
  input: {
    effect: PersistedEffect;
    auditSnapshot: PreparedApprovalCleanupDoneAuditSnapshot;
    occurredAt: string;
  },
): RunEvent {
  const evidence = input.auditSnapshot.evidence;
  const effectIdentity = {
    runId: projectIdentifier(input.effect.runId),
    sessionId: projectIdentifier(input.effect.sessionId),
    idempotencyKey: projectIdentifier(input.effect.idempotencyKey),
  };
  const metadata = {
    version: "prepared_approval_cleanup_done_evidence_quarantine_v2",
    validationReasonCode:
      "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
    effectIdentity,
    resultIdentity: input.auditSnapshot.resultIdentity,
    evidence,
    ...(input.auditSnapshot.releasedPreparedInvocationId === undefined
      ? {}
      : {
          releasedPreparedInvocationId:
            input.auditSnapshot.releasedPreparedInvocationId,
        }),
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
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      state.traversalTruncated = true;
      normalized.push(normalizationMarker("unreadable"));
      continue;
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      state.traversalTruncated = true;
      normalized.push(normalizationMarker("unreadable"));
      continue;
    }
    const member = descriptor.value;
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
  let selection: {
    keys: string[];
    truncated: boolean;
    keysTruncated: boolean;
  };
  try {
    selection = selectCanonicalOwnKeys(value);
  } catch {
    state.traversalTruncated = true;
    return normalizationMarker("uninspectable_object");
  }
  const selectedUserKeys = selection.keys;
  const entriesTruncated =
    selection.truncated ||
    (selection.keysTruncated &&
      selectedUserKeys.length >= MAX_CONTAINER_ENTRIES);
  const keysTruncated = selection.keysTruncated;
  state.traversalTruncated ||= entriesTruncated;
  state.sourceBytesTruncated ||= keysTruncated;
  const normalized: Record<string, NormalizedCleanupEvidenceValue> = {};
  const needsDiagnostics = entriesTruncated || keysTruncated;
  const selectedKeys = needsDiagnostics
    ? selectedUserKeys.slice(0, MAX_CONTAINER_ENTRIES - 1)
    : selectedUserKeys;
  for (const key of selectedKeys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      state.traversalTruncated = true;
      const safeKey = normalizeEvidenceKey(key);
      Object.defineProperty(normalized, safeKey, {
        value: normalizationMarker("unreadable"),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      continue;
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      state.traversalTruncated = true;
      const safeKey = normalizeEvidenceKey(key);
      Object.defineProperty(normalized, safeKey, {
        value: normalizationMarker("unreadable"),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      continue;
    }
    const member = descriptor.value;
    const next = normalizeEvidenceValue(member, state, depth + 1, "object");
    if (next === OMIT_NORMALIZED_VALUE) continue;
    const safeKey = normalizeEvidenceKey(key);
    Object.defineProperty(normalized, safeKey, {
      value: next,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (needsDiagnostics) {
    Object.defineProperty(normalized, NORMALIZATION_MARKER, {
      value: entriesTruncated && keysTruncated
        ? "object_entries_and_keys_truncated"
        : entriesTruncated
          ? "object_truncated"
          : "object_keys_truncated",
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

function normalizeEvidenceKey(key: string): string {
  const safe = sanitizeUtf16String(key);
  if (
    safe === key &&
    key.length <= MAX_STRING_CODE_UNITS &&
    key !== NORMALIZATION_MARKER &&
    !key.startsWith(NORMALIZED_KEY_PREFIX)
  ) return key;
  const identity = projectIdentifier(key);
  return `${NORMALIZED_KEY_PREFIX}${identity.canonicalHash.slice("sha256:".length)}:${identity.utf8ByteSize}`;
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
  const normalizationKind = readObjectNormalizationMarker(value)?.kind;
  if (normalizationKind === "truncated_string" || normalizationKind === "bigint") {
    state.sourceBytesTruncated = true;
  }
  if (
    normalizationKind === "object_keys_truncated" ||
    normalizationKind === "object_entries_and_keys_truncated"
  ) {
    state.sourceBytesTruncated = true;
  }
  if (
    normalizationKind !== undefined &&
    normalizationKind !== "truncated_string" &&
    normalizationKind !== "bigint" &&
    !isObjectNormalizationDiagnostic(normalizationKind)
  ) {
    state.traversalTruncated = true;
  }
  let selection: {
    keys: string[];
    truncated: boolean;
    keysTruncated: boolean;
  };
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
  const carriesTruncationMarker =
    normalizationKind === "object_truncated" ||
    normalizationKind === "object_entries_and_keys_truncated";
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

function readNormalizationMarker(value: Record<string, unknown>):
  | { kind: string; evidence: Record<string, NormalizedCleanupEvidenceValue> }
  | undefined {
  let keys: string[];
  let marker: unknown;
  try {
    keys = Object.keys(value);
    marker = value[NORMALIZATION_MARKER];
  } catch {
    return;
  }
  if (typeof marker !== "string" || !isNormalizationKind(marker)) return;
  if (marker !== "truncated_string") {
    return keys.length === 1 && keys[0] === NORMALIZATION_MARKER
      ? { kind: marker, evidence: {} }
      : undefined;
  }
  if (
    keys.length !== 3 ||
    !keys.includes(NORMALIZATION_MARKER) ||
    !keys.includes("canonicalHash") ||
    !keys.includes("utf8ByteSize")
  ) return;
  const evidence = {
    canonicalHash: value.canonicalHash,
    utf8ByteSize: value.utf8ByteSize,
  } as Record<string, NormalizedCleanupEvidenceValue>;
  return isValidTruncatedStringEvidence(evidence)
    ? { kind: marker, evidence }
    : undefined;
}

function readObjectNormalizationMarker(
  value: Record<string, unknown>,
): { kind: string; evidence: Record<string, NormalizedCleanupEvidenceValue> }
  | undefined {
  const standalone = readNormalizationMarker(value);
  if (standalone !== undefined) return standalone;
  let payload: unknown;
  try {
    payload = value[NORMALIZATION_MARKER];
  } catch {
    return;
  }
  return typeof payload === "string" &&
      isObjectNormalizationDiagnostic(payload)
    ? { kind: payload, evidence: {} }
    : undefined;
}

function isNormalizationMarker(value: unknown, kind: string): boolean {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    readNormalizationMarker(value as Record<string, unknown>)?.kind === kind;
}

function isNormalizationKind(kind: string): boolean {
  return [
    "node_limit",
    "truncated_string",
    "bigint",
    "circular",
    "uninspectable",
    "array_depth_limit",
    "object_depth_limit",
    "uninspectable_array",
    "unreadable",
    "array_truncated",
    "uninspectable_object",
    "object_truncated",
    "object_keys_truncated",
    "object_entries_and_keys_truncated",
  ].includes(kind);
}

function isObjectNormalizationDiagnostic(kind: string | undefined): boolean {
  return kind === "object_truncated" ||
    kind === "object_keys_truncated" ||
    kind === "object_entries_and_keys_truncated";
}

function isValidTruncatedStringEvidence(
  evidence: Record<string, NormalizedCleanupEvidenceValue>,
): boolean {
  const keys = Object.keys(evidence);
  return keys.length === 2 &&
    keys.includes("canonicalHash") &&
    keys.includes("utf8ByteSize") &&
    typeof evidence.canonicalHash === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(evidence.canonicalHash) &&
    typeof evidence.utf8ByteSize === "number" &&
    Number.isSafeInteger(evidence.utf8ByteSize) &&
    evidence.utf8ByteSize >= 0;
}

function selectCanonicalOwnKeys(value: Record<string, unknown>): {
  keys: string[];
  truncated: boolean;
  keysTruncated: boolean;
} {
  const selected: string[] = [];
  let ownKeyCount = 0;
  let keysTruncated = false;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    ownKeyCount += 1;
    keysTruncated ||= key.length > MAX_STRING_CODE_UNITS;
    let insertAt = selected.findIndex((candidate) => key < candidate);
    if (insertAt < 0) insertAt = selected.length;
    selected.splice(insertAt, 0, key);
    if (selected.length > MAX_CONTAINER_ENTRIES) selected.pop();
  }
  return {
    keys: selected,
    truncated: ownKeyCount > selected.length,
    keysTruncated,
  };
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

function projectReleasedPreparedInvocationIdFromDescriptor(
  output: unknown,
): Record<string, unknown> | undefined {
  if (typeof output !== "object" || output === null) return;
  let descriptor: PropertyDescriptor | undefined;
  try {
    if (Array.isArray(output)) return;
    descriptor = Object.getOwnPropertyDescriptor(
      output,
      "releasedPreparedInvocationId",
    );
  } catch {
    return;
  }
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string"
  ) return;
  return projectIdentifier(descriptor.value);
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
