import { randomBytes } from "node:crypto";

export const TRACE_CONTEXT_VERSION = "trace_context_v1" as const;

export interface TraceContext {
  version: typeof TRACE_CONTEXT_VERSION;
  traceId: string;
  spanId: string;
  traceFlags: "00" | "01";
}

export type TraceRelationship = "new" | "continue" | "replay" | "fork";

export interface TraceStartDirective {
  relationship: TraceRelationship;
  sourceContext?: TraceContext | undefined;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const FIELDS = new Set(["version", "traceId", "spanId", "traceFlags"]);

export function parseTraceContext(value: unknown): TraceContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Trace context must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FIELDS.has(key)) {
      throw new Error(`Trace context contains unknown field '${key}'.`);
    }
  }
  if (record.version !== TRACE_CONTEXT_VERSION) {
    throw new Error(`Trace context version must be '${TRACE_CONTEXT_VERSION}'.`);
  }
  if (
    typeof record.traceId !== "string" ||
    !TRACE_ID_PATTERN.test(record.traceId) ||
    record.traceId === ZERO_TRACE_ID
  ) {
    throw new Error("Trace context traceId must be a non-zero lowercase W3C trace ID.");
  }
  if (
    typeof record.spanId !== "string" ||
    !SPAN_ID_PATTERN.test(record.spanId) ||
    record.spanId === ZERO_SPAN_ID
  ) {
    throw new Error("Trace context spanId must be a non-zero lowercase W3C span ID.");
  }
  if (record.traceFlags !== "00" && record.traceFlags !== "01") {
    throw new Error("Trace context traceFlags must be '00' or '01'.");
  }
  return {
    version: TRACE_CONTEXT_VERSION,
    traceId: record.traceId,
    spanId: record.spanId,
    traceFlags: record.traceFlags,
  };
}

export function createTraceContext(input: {
  traceId?: string | undefined;
  traceFlags?: "00" | "01" | undefined;
} = {}): TraceContext {
  return parseTraceContext({
    version: TRACE_CONTEXT_VERSION,
    traceId: input.traceId ?? randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    traceFlags: input.traceFlags ?? "01",
  });
}

export function resolveTraceStartDirective(
  directive: TraceStartDirective | undefined,
): {
  context: TraceContext;
  parentContext?: TraceContext | undefined;
  linkContext?: TraceContext | undefined;
} {
  const relationship = directive?.relationship ?? "new";
  const sourceContext = directive?.sourceContext === undefined
    ? undefined
    : parseTraceContext(directive.sourceContext);
  if (relationship === "new") {
    if (sourceContext !== undefined) {
      throw new Error("A new trace cannot provide sourceContext.");
    }
    return { context: createTraceContext() };
  }
  if (sourceContext === undefined) {
    throw new Error(`Trace relationship '${relationship}' requires sourceContext.`);
  }
  if (relationship === "continue") {
    return {
      context: createTraceContext({
        traceId: sourceContext.traceId,
        traceFlags: sourceContext.traceFlags,
      }),
      parentContext: sourceContext,
    };
  }
  return {
    context: createTraceContext({ traceFlags: sourceContext.traceFlags }),
    linkContext: sourceContext,
  };
}
