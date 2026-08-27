import type { EffectResult } from "../kestrel/contracts/execution.js";
import type { RunEvent } from "../kestrel/contracts/events.js";
import type { PersistedEffect } from "../kestrel/contracts/store.js";
import { canonicalJson, hashCanonical } from "../kestrel/contracts/tool-contract.js";
import { sanitizeUtf16String } from "./jsonSanitizer.js";

const MAX_DEPTH = 4;
const MAX_NODES = 128;
const MAX_CONTAINER_ENTRIES = 16;
const MAX_STRING_CODE_UNITS = 256;

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

export function buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent(input: {
  effect: PersistedEffect;
  invalidResult: EffectResult & { status: "DONE" };
  occurredAt: string;
}): RunEvent {
  const evidence = projectBoundedEvidence({
    output: input.invalidResult.output,
    error: input.invalidResult.error,
  });
  const event: RunEvent = {
    runId: input.effect.runId,
    sessionId: input.effect.sessionId,
    stepIndex: input.effect.stepIndex,
    type: "prepared_approval_cleanup.done_evidence_quarantined",
    level: "WARN",
    timestamp: input.occurredAt,
    metadata: {
      version: "prepared_approval_cleanup_done_evidence_quarantine_v2",
      validationReasonCode:
        "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
      effectIdentity: {
        runId: input.effect.runId,
        sessionId: input.effect.sessionId,
        idempotencyKey: input.effect.idempotencyKey,
      },
      resultIdentity: {
        idempotencyKey: input.invalidResult.idempotencyKey,
        status: input.invalidResult.status,
        originalTimestamp: input.invalidResult.timestamp,
      },
      evidence,
      ...projectReleasedPreparedInvocationId(input.invalidResult.output),
    },
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(event.metadata));
  if (
    serializedBytes >
    PREPARED_APPROVAL_CLEANUP_QUARANTINE_AUDIT_MAX_METADATA_BYTES
  ) {
    throw new Error("Cleanup quarantine audit metadata exceeded its hard bound");
  }
  return event;
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
  const entries: unknown[] = [];
  const types: Record<string, number> = {};
  for (let index = 0; index < observed; index += 1) {
    const projected = projectValue(value[index], state, depth + 1);
    entries.push(projected.canonical);
    incrementType(types, projected.summary.type);
  }
  const truncated = value.length > observed;
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
  const collected: string[] = [];
  let truncated = false;
  let propertiesScanned = 0;
  try {
    for (const key in value) {
      propertiesScanned += 1;
      if (propertiesScanned > MAX_CONTAINER_ENTRIES) {
        truncated = true;
        break;
      }
      if (!Object.hasOwn(value, key)) continue;
      collected.push(key);
    }
  } catch {
    state.traversalTruncated = true;
    return truncatedProjection("object_enumeration_failed");
  }
  collected.sort((left, right) => left.localeCompare(right));
  const entries: Array<{ key: string; value: unknown }> = [];
  const types: Record<string, number> = {};
  for (const key of collected) {
    const safeKey = sanitizeUtf16String(
      key.slice(0, MAX_STRING_CODE_UNITS),
    );
    state.sourceBytesObserved += Buffer.byteLength(safeKey);
    state.sourceBytesTruncated ||= key.length > MAX_STRING_CODE_UNITS;
    let member: unknown;
    try {
      member = value[key];
    } catch {
      state.traversalTruncated = true;
      member = undefined;
    }
    const projected = projectValue(member, state, depth + 1);
    entries.push({ key: safeKey, value: projected.canonical });
    incrementType(types, projected.summary.type);
  }
  state.traversalTruncated ||= truncated;
  return {
    canonical: { type: "object", entries, observed: collected.length, truncated },
    summary: {
      type: "object",
      topLevelEntriesObserved: collected.length,
      topLevelEntriesTruncated: truncated,
      topLevelValueTypes: types,
    },
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

function projectReleasedPreparedInvocationId(
  output: unknown,
): Record<string, unknown> {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
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
  const safe = sanitizeUtf16String(
    candidate.slice(0, MAX_STRING_CODE_UNITS),
  );
  return {
    releasedPreparedInvocationId: {
      canonicalHash: hashCanonical({
        value: safe,
        codeUnits: candidate.length,
        truncated: candidate.length > MAX_STRING_CODE_UNITS,
      }),
      bytesObserved: Buffer.byteLength(safe),
      truncated: candidate.length > MAX_STRING_CODE_UNITS,
    },
  };
}
