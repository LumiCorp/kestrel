export const TRACE_CONTEXT_VERSION = "trace_context_v1" as const;
export const TRACE_CORRELATION_VERSION = "trace_correlation_v1" as const;
export const RUNTIME_SPAN_VERSION = "runtime_span_v1" as const;
export const RUNTIME_SPAN_EVENT_VERSION = "runtime_span_event_v1" as const;

export type TraceFlagsV1 = "00" | "01";
export type RuntimeSpanStatusV1 = "active" | "ok" | "error" | "cancelled";
export type RuntimeSpanAttributeV1 = string | number | boolean;
export type RuntimeSpanKindV1 =
  | "run"
  | "stream"
  | "resume"
  | "subscription"
  | "model"
  | "tool"
  | "sandbox"
  | "memory"
  | "evaluation"
  | "delegation"
  | "approval"
  | "wait"
  | "settlement";

export interface TraceContextV1 {
  version: typeof TRACE_CONTEXT_VERSION;
  traceId: string;
  spanId: string;
  traceFlags: TraceFlagsV1;
}

export interface TraceCorrelationV1 {
  version: typeof TRACE_CORRELATION_VERSION;
  eventSequence?: number | undefined;
  checkpointId?: string | undefined;
  workspaceSnapshotId?: string | undefined;
  replayId?: string | undefined;
  forkId?: string | undefined;
  delegationId?: string | undefined;
  interactionId?: string | undefined;
  approvalId?: string | undefined;
}

export interface RuntimeSpanEventV1 {
  version: typeof RUNTIME_SPAN_EVENT_VERSION;
  eventId: string;
  name: string;
  timestamp: string;
  attributes: Record<string, RuntimeSpanAttributeV1>;
  correlation?: TraceCorrelationV1 | undefined;
}

export interface RuntimeSpanLinkV1 {
  context: TraceContextV1;
  attributes: Record<string, RuntimeSpanAttributeV1>;
}

export interface RuntimeSpanV1 {
  version: typeof RUNTIME_SPAN_VERSION;
  context: TraceContextV1;
  parentSpanId?: string | undefined;
  links: RuntimeSpanLinkV1[];
  name: string;
  kind: RuntimeSpanKindV1;
  startedAt: string;
  endedAt?: string | undefined;
  status: RuntimeSpanStatusV1;
  attributes: Record<string, RuntimeSpanAttributeV1>;
  events: RuntimeSpanEventV1[];
  correlation?: TraceCorrelationV1 | undefined;
}

export interface RuntimeSpanSinkV1 {
  write(span: RuntimeSpanV1): Promise<void> | void;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const TRACE_CONTEXT_FIELDS = new Set(["version", "traceId", "spanId", "traceFlags"]);
const CORRELATION_FIELDS = new Set([
  "version",
  "eventSequence",
  "checkpointId",
  "workspaceSnapshotId",
  "replayId",
  "forkId",
  "delegationId",
  "interactionId",
  "approvalId",
]);
const EVENT_FIELDS = new Set([
  "version",
  "eventId",
  "name",
  "timestamp",
  "attributes",
  "correlation",
]);
const LINK_FIELDS = new Set(["context", "attributes"]);
const SPAN_FIELDS = new Set([
  "version",
  "context",
  "parentSpanId",
  "links",
  "name",
  "kind",
  "startedAt",
  "endedAt",
  "status",
  "attributes",
  "events",
  "correlation",
]);
const SPAN_KINDS = new Set<RuntimeSpanKindV1>([
  "run",
  "stream",
  "resume",
  "subscription",
  "model",
  "tool",
  "sandbox",
  "memory",
  "evaluation",
  "delegation",
  "approval",
  "wait",
  "settlement",
]);
const SPAN_STATUSES = new Set<RuntimeSpanStatusV1>([
  "active",
  "ok",
  "error",
  "cancelled",
]);
const SENSITIVE_ATTRIBUTE_KEY =
  /(?:^|[._-])(actor[_-]?name|authorization|cookie|credential|display[_-]?name|password|prompt|response|secret|raw[_-]?payload|tool[_-]?payload|pii|user[_-]?name)(?:$|[._-])/iu;
const NON_NEGATIVE_INTEGER_ATTRIBUTES = new Set([
  "kestrel.retry_attempt",
  "kestrel.input_tokens",
  "kestrel.output_tokens",
]);
const NON_NEGATIVE_NUMBER_ATTRIBUTES = new Set([
  "kestrel.latency_ms",
]);

export const REQUIRED_RUNTIME_SPAN_ATTRIBUTES_V1: Readonly<
  Record<RuntimeSpanKindV1, readonly string[]>
> = Object.freeze({
  run: ["kestrel.agent_id", "kestrel.profile_id", "kestrel.operation"],
  stream: ["kestrel.agent_id", "kestrel.profile_id", "kestrel.operation"],
  resume: ["kestrel.agent_id", "kestrel.profile_id", "kestrel.operation"],
  subscription: ["kestrel.agent_id", "kestrel.profile_id", "kestrel.operation"],
  model: [
    "kestrel.provider_id",
    "kestrel.model_id",
    "kestrel.retry_attempt",
  ],
  tool: ["kestrel.tool_id", "kestrel.retry_attempt"],
  sandbox: ["kestrel.sandbox_id"],
  memory: ["kestrel.memory_operation"],
  evaluation: ["kestrel.evaluator_id"],
  delegation: ["kestrel.delegation_id"],
  approval: ["kestrel.approval_id"],
  wait: ["kestrel.wait_kind"],
  settlement: ["kestrel.termination_reason"],
});

export const REQUIRED_SETTLED_RUNTIME_SPAN_ATTRIBUTES_V1: Readonly<
  Record<RuntimeSpanKindV1, readonly string[]>
> = Object.freeze({
  run: [],
  stream: [],
  resume: [],
  subscription: [],
  model: [
    "kestrel.latency_ms",
    "kestrel.input_tokens",
    "kestrel.output_tokens",
    "kestrel.result",
  ],
  tool: ["kestrel.latency_ms", "kestrel.result"],
  sandbox: ["kestrel.result"],
  memory: ["kestrel.result"],
  evaluation: ["kestrel.result"],
  delegation: ["kestrel.result"],
  approval: ["kestrel.result"],
  wait: ["kestrel.result"],
  settlement: ["kestrel.result"],
});

export function parseTraceContextV1(value: unknown): TraceContextV1 {
  const record = requireRecord(value, "Trace context");
  rejectUnknownFields(record, TRACE_CONTEXT_FIELDS, "Trace context");
  if (record.version !== TRACE_CONTEXT_VERSION) {
    throw new Error(`Trace context version must be '${TRACE_CONTEXT_VERSION}'.`);
  }
  const traceId = requireTraceId(record.traceId, "Trace context traceId");
  const spanId = requireSpanId(record.spanId, "Trace context spanId");
  if (record.traceFlags !== "00" && record.traceFlags !== "01") {
    throw new Error("Trace context traceFlags must be '00' or '01'.");
  }
  return {
    version: TRACE_CONTEXT_VERSION,
    traceId,
    spanId,
    traceFlags: record.traceFlags,
  };
}

export function parseTraceCorrelationV1(value: unknown): TraceCorrelationV1 {
  const record = requireRecord(value, "Trace correlation");
  rejectUnknownFields(record, CORRELATION_FIELDS, "Trace correlation");
  if (record.version !== TRACE_CORRELATION_VERSION) {
    throw new Error(`Trace correlation version must be '${TRACE_CORRELATION_VERSION}'.`);
  }
  const parsed: TraceCorrelationV1 = { version: TRACE_CORRELATION_VERSION };
  if (record.eventSequence !== undefined) {
    parsed.eventSequence = requireNonNegativeInteger(
      record.eventSequence,
      "Trace correlation eventSequence",
    );
  }
  for (const field of [
    "checkpointId",
    "workspaceSnapshotId",
    "replayId",
    "forkId",
    "delegationId",
    "interactionId",
    "approvalId",
  ] as const) {
    if (record[field] !== undefined) {
      parsed[field] = requireIdentifier(record[field], `Trace correlation ${field}`);
    }
  }
  if (Object.keys(parsed).length === 1) {
    throw new Error("Trace correlation must contain at least one typed reference.");
  }
  return parsed;
}

export function parseRuntimeSpanEventV1(value: unknown): RuntimeSpanEventV1 {
  const record = requireRecord(value, "Runtime span event");
  rejectUnknownFields(record, EVENT_FIELDS, "Runtime span event");
  if (record.version !== RUNTIME_SPAN_EVENT_VERSION) {
    throw new Error(`Runtime span event version must be '${RUNTIME_SPAN_EVENT_VERSION}'.`);
  }
  return {
    version: RUNTIME_SPAN_EVENT_VERSION,
    eventId: requireIdentifier(record.eventId, "Runtime span event eventId"),
    name: requireIdentifier(record.name, "Runtime span event name"),
    timestamp: requireTimestamp(record.timestamp, "Runtime span event timestamp"),
    attributes: parseAttributes(record.attributes, "Runtime span event attributes"),
    ...(record.correlation !== undefined
      ? { correlation: parseTraceCorrelationV1(record.correlation) }
      : {}),
  };
}

export function parseRuntimeSpanV1(value: unknown): RuntimeSpanV1 {
  const record = requireRecord(value, "Runtime span");
  rejectUnknownFields(record, SPAN_FIELDS, "Runtime span");
  if (record.version !== RUNTIME_SPAN_VERSION) {
    throw new Error(`Runtime span version must be '${RUNTIME_SPAN_VERSION}'.`);
  }
  const context = parseTraceContextV1(record.context);
  const kind = requireEnum(record.kind, SPAN_KINDS, "Runtime span kind");
  const status = requireEnum(record.status, SPAN_STATUSES, "Runtime span status");
  const startedAt = requireTimestamp(record.startedAt, "Runtime span startedAt");
  const endedAt = record.endedAt === undefined
    ? undefined
    : requireTimestamp(record.endedAt, "Runtime span endedAt");
  if (status === "active" && endedAt !== undefined) {
    throw new Error("An active runtime span cannot have endedAt.");
  }
  if (status !== "active" && endedAt === undefined) {
    throw new Error("A settled runtime span requires endedAt.");
  }
  if (endedAt !== undefined && Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new Error("Runtime span endedAt cannot precede startedAt.");
  }
  const parentSpanId = record.parentSpanId === undefined
    ? undefined
    : requireSpanId(record.parentSpanId, "Runtime span parentSpanId");
  if (parentSpanId === context.spanId) {
    throw new Error("Runtime span cannot be its own parent.");
  }
  const attributes = parseAttributes(record.attributes, "Runtime span attributes");
  assertKnownNumericAttributes(attributes, "Runtime span");
  for (const required of REQUIRED_RUNTIME_SPAN_ATTRIBUTES_V1[kind]) {
    if (attributes[required] === undefined) {
      throw new Error(`Runtime span kind '${kind}' requires attribute '${required}'.`);
    }
  }
  if (status !== "active") {
    for (const required of REQUIRED_SETTLED_RUNTIME_SPAN_ATTRIBUTES_V1[kind]) {
      if (attributes[required] === undefined) {
        throw new Error(`Settled runtime span kind '${kind}' requires attribute '${required}'.`);
      }
    }
  }
  const links = requireArray(record.links, "Runtime span links").map((value, index) =>
    parseSpanLink(value, `Runtime span links[${index}]`));
  const linkKeys = new Set<string>();
  for (const link of links) {
    const key = `${link.context.traceId}:${link.context.spanId}`;
    if (key === `${context.traceId}:${context.spanId}`) {
      throw new Error("Runtime span cannot link to itself.");
    }
    if (linkKeys.has(key)) {
      throw new Error("Runtime span links must be unique.");
    }
    linkKeys.add(key);
  }
  const events = requireArray(record.events, "Runtime span events").map((value) =>
    parseRuntimeSpanEventV1(value));
  requireUnique(events.map((event) => event.eventId), "Runtime span event IDs");
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (timestamp < Date.parse(startedAt) || (endedAt !== undefined && timestamp > Date.parse(endedAt))) {
      throw new Error("Runtime span event timestamp must be within the span lifecycle.");
    }
  }
  return {
    version: RUNTIME_SPAN_VERSION,
    context,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    links,
    name: requireIdentifier(record.name, "Runtime span name"),
    kind,
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    status,
    attributes,
    events,
    ...(record.correlation !== undefined
      ? { correlation: parseTraceCorrelationV1(record.correlation) }
      : {}),
  };
}

function parseSpanLink(value: unknown, label: string): RuntimeSpanLinkV1 {
  const record = requireRecord(value, label);
  rejectUnknownFields(record, LINK_FIELDS, label);
  return {
    context: parseTraceContextV1(record.context),
    attributes: parseAttributes(record.attributes, `${label} attributes`),
  };
}

function parseAttributes(
  value: unknown,
  label: string,
): Record<string, RuntimeSpanAttributeV1> {
  const record = requireRecord(value, label);
  const parsed: Record<string, RuntimeSpanAttributeV1> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!IDENTIFIER_PATTERN.test(key)) {
      throw new Error(`${label} contains invalid key '${key}'.`);
    }
    if (SENSITIVE_ATTRIBUTE_KEY.test(key)) {
      throw new Error(`${label} contains forbidden sensitive key '${key}'.`);
    }
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error(`${label} '${key}' must be a string, number, or boolean.`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new Error(`${label} '${key}' must be finite.`);
    }
    parsed[key] = item;
  }
  return parsed;
}

function assertKnownNumericAttributes(
  attributes: Record<string, RuntimeSpanAttributeV1>,
  label: string,
): void {
  for (const key of NON_NEGATIVE_INTEGER_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw new Error(`${label} attribute '${key}' must be a non-negative safe integer.`);
    }
  }
  for (const key of NON_NEGATIVE_NUMBER_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${label} attribute '${key}' must be a non-negative finite number.`);
    }
  }
}

function requireTraceId(value: unknown, label: string): string {
  if (typeof value !== "string" || !TRACE_ID_PATTERN.test(value) || value === ZERO_TRACE_ID) {
    throw new Error(`${label} must be a non-zero lowercase W3C trace ID.`);
  }
  return value;
}

function requireSpanId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SPAN_ID_PATTERN.test(value) || value === ZERO_SPAN_ID) {
    throw new Error(`${label} must be a non-zero lowercase W3C span ID.`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded identifier.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requireEnum<T extends string>(value: unknown, allowed: Set<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown field '${key}'.`);
    }
  }
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique.`);
  }
}
