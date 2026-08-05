import { randomUUID } from "node:crypto";

import type {
  KestrelAgent,
  KestrelAgentResumeInput,
  KestrelAgentTurnInput,
  KestrelRequestContext,
  RunnerEventSubscriptionFilter,
  RunnerRunTerminalEvent,
  RunnerStream,
} from "@kestrel-agents/sdk";
import type { RunnerEventEnvelope } from "@kestrel-agents/sdk/runner";
import {
  assertKnownNumericTraceAttributes,
  compactTraceAttributes as compactAttributes,
} from "./attributes.js";
import {
  createTraceContext,
  parseTraceContext,
  parseTraceStartDirective,
  resolveTraceStartDirective,
  type TraceContext,
  type TraceStartDirective,
} from "./context.js";

export type KestrelTracePrimitive = string | number | boolean;
export type KestrelTraceAttributes = Record<string, KestrelTracePrimitive | undefined>;

export interface TraceEvent {
  id: string;
  name: string;
  ts: string;
  attributes?: KestrelTraceAttributes | undefined;
}

export interface TraceLink {
  context: TraceContext;
  attributes?: KestrelTraceAttributes | undefined;
}

export type SpanKind =
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

export interface Span {
  traceId: string;
  spanId: string;
  traceFlags: "00" | "01";
  parentSpanId?: string | undefined;
  links: TraceLink[];
  name: string;
  kind: SpanKind;
  startedAt: string;
  endedAt?: string | undefined;
  status: "ok" | "error" | "cancelled";
  attributes: KestrelTraceAttributes;
  events: TraceEvent[];
}

export interface RunTrace {
  traceId: string;
  traceFlags: "00" | "01";
  rootSpanId: string;
  parentContext?: TraceContext | undefined;
  links: TraceLink[];
  agentId: string;
  profileId: string;
  startedAt: string;
  endedAt?: string | undefined;
  status: "ok" | "error" | "cancelled";
  sessionId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  metadata: KestrelTraceAttributes;
  spans: Span[];
}

export interface KestrelTraceProcessor {
  process(trace: RunTrace): Promise<void> | void;
}

export interface KestrelTraceExporter {
  export(traces: RunTrace[]): Promise<void> | void;
}

export interface CreateTracerOptions {
  processors?: KestrelTraceProcessor[] | undefined;
  exporters?: KestrelTraceExporter[] | undefined;
  resolveTraceStart?: ((input: TraceStartResolutionInput) => TraceStartDirective | undefined) | undefined;
  onExportError?: ((error: unknown) => void) | undefined;
}

export interface TraceStartResolutionInput {
  operation: "run" | "stream" | "resume" | "subscription";
  sessionId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  requestId?: string | undefined;
}

export interface StartTraceInput {
  agentId: string;
  profileId: string;
  name: string;
  kind: SpanKind;
  directive?: TraceStartDirective | undefined;
  attributes?: KestrelTraceAttributes | undefined;
  metadata?: KestrelTraceAttributes | undefined;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
}

export interface StartSpanInput {
  name: string;
  kind: SpanKind;
  parent?: Span | TraceContext | undefined;
  links?: TraceLink[] | undefined;
  attributes?: KestrelTraceAttributes | undefined;
}

export interface SpanHandle {
  readonly span: Span;
  readonly context: TraceContext;
  addEvent(name: string, attributes?: KestrelTraceAttributes): void;
  startChild(input: Omit<StartSpanInput, "parent">): SpanHandle;
  end(status?: Span["status"], attributes?: KestrelTraceAttributes): void;
}

export interface TraceHandle {
  readonly trace: RunTrace;
  readonly root: SpanHandle;
  startSpan(input: StartSpanInput): SpanHandle;
  end(status?: RunTrace["status"], attributes?: KestrelTraceAttributes): void;
}

export interface KestrelTracer {
  wrapAgent(agent: KestrelAgent): KestrelAgent;
  startTrace(input: StartTraceInput): TraceHandle;
  flush(): Promise<void>;
}

export function createTracer(options: CreateTracerOptions = {}): KestrelTracer {
  const processors = options.processors ?? [];
  const exporters = options.exporters ?? [];
  const pending = new Set<Promise<void>>();
  const schedule = (trace: RunTrace) => {
    const promise = processTrace(trace, processors, exporters, options.onExportError);
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };
  const resolveDirective = (input: TraceStartResolutionInput): TraceStartDirective | undefined => {
    try {
      const candidate = options.resolveTraceStart?.(input);
      const directive = candidate === undefined ? undefined : parseTraceStartDirective(candidate);
      if (input.operation === "resume" && directive !== undefined && directive.relationship !== "continue") {
        throw new Error("Agent resume trace context must use the continue relationship.");
      }
      return directive;
    } catch (error) {
      reportExportError(options.onExportError, error);
      return undefined;
    }
  };

  return {
    wrapAgent(agent) {
      return {
        ...agent,
        async run(input: KestrelAgentTurnInput, context: KestrelRequestContext) {
          const trace = createTrace(agent, "run", input, context, resolveDirective({
            operation: "run",
            sessionId: input.sessionId,
          }));
          const span = createSpan(trace, "agent.run", "run", {
            attributes: operationAttributes(agent, "run"),
          });
          try {
            const terminal = await agent.run(input, context);
            annotateRunTerminal(trace, span, terminal);
            return terminal;
          } catch (error) {
            annotateErrorTrace(trace, span, error);
            throw error;
          } finally {
            settleTrace(trace, span);
            schedule(trace);
          }
        },

        stream(input: KestrelAgentTurnInput & { signal?: AbortSignal | undefined }, context: KestrelRequestContext) {
          const trace = createTrace(agent, "stream", input, context, resolveDirective({
            operation: "stream",
            sessionId: input.sessionId,
          }));
          const span = createSpan(trace, "agent.stream", "stream", {
            attributes: operationAttributes(agent, "stream"),
          });
          const stream = agent.stream(input, context);
          return wrapRunnerStream({
            stream,
            onEvent: (event) => recordRunnerEvent(trace, span, event),
            onResult: (terminal: RunnerRunTerminalEvent) => applyRunTerminalStatus(trace, span, terminal),
            onError: (error: unknown) => annotateErrorTrace(trace, span, error),
            onFinally: () => {
              settleTrace(trace, span);
              schedule(trace);
            },
          });
        },

        async resume(input: KestrelAgentResumeInput, context: KestrelRequestContext) {
          const trace = createTrace(agent, "resume", input, context, resolveDirective({
            operation: "resume",
            sessionId: input.sessionId,
            requestId: input.requestId,
          }));
          const span = createSpan(trace, "agent.resume", "resume", {
            attributes: operationAttributes(agent, "resume"),
          });
          try {
            const terminal = await agent.resume(input, context);
            annotateRunTerminal(trace, span, terminal);
            return terminal;
          } catch (error) {
            annotateErrorTrace(trace, span, error);
            throw error;
          } finally {
            settleTrace(trace, span);
            schedule(trace);
          }
        },

        subscribe(
          filter: RunnerEventSubscriptionFilter,
          context: KestrelRequestContext,
          options?: {
            signal?: AbortSignal | undefined;
          },
        ) {
          const trace = createSubscriptionTrace(agent, filter, context, resolveDirective({
            operation: "subscription",
            ...(filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {}),
            ...(filter.threadId !== undefined ? { threadId: filter.threadId } : {}),
            ...(filter.runId !== undefined ? { runId: filter.runId } : {}),
          }));
          const span = createSpan(trace, "agent.subscribe", "subscription", {
            attributes: operationAttributes(agent, "subscription"),
          });
          const stream = agent.subscribe(filter, context, options);
          return wrapRunnerStream({
            stream,
            onEvent: (event) => recordRunnerEvent(trace, span, event),
            onResult: () => {
              trace.status = "ok";
              span.status = "ok";
            },
            onError: (error: unknown) => annotateErrorTrace(trace, span, error),
            onFinally: () => {
              settleTrace(trace, span);
              schedule(trace);
            },
          });
        },
      };
    },

    startTrace(input) {
      const trace = createStandaloneTrace(input);
      const rootSpan = createSpan(trace, input.name, input.kind, {
        attributes: input.attributes,
      });
      const root = createSpanHandle(trace, rootSpan);
      let ended = false;
      return {
        trace,
        root,
        startSpan(spanInput) {
          if (ended) throw new Error("Cannot start a span after the trace has ended.");
          return createSpanHandle(
            trace,
            createSpan(trace, spanInput.name, spanInput.kind, {
              parent: spanInput.parent ?? rootSpan,
              links: spanInput.links,
              attributes: spanInput.attributes,
            }),
          );
        },
        end(status = "ok", attributes = {}) {
          if (ended) return;
          const activeChild = trace.spans.find(
            (span) => span !== rootSpan && span.endedAt === undefined,
          );
          if (activeChild !== undefined) {
            throw new Error(`Cannot end trace while child span '${activeChild.name}' is active.`);
          }
          const rootAttributes = compactAttributes({ ...rootSpan.attributes, ...attributes });
          assertRequiredSpanAttributes({ ...rootSpan, attributes: rootAttributes });
          for (const span of trace.spans) {
            if (span !== rootSpan) assertRequiredSpanAttributes(span);
          }
          const rootEndedAt = rootSpan.endedAt ?? new Date().toISOString();
          assertValidSpanTree(trace, rootSpan, rootEndedAt);
          ended = true;
          rootSpan.attributes = rootAttributes;
          rootSpan.status = status;
          rootSpan.endedAt = rootEndedAt;
          trace.endedAt = trace.endedAt ?? rootEndedAt;
          trace.status = status;
          schedule(trace);
        },
      };
    },

    async flush() {
      await Promise.all([...pending]);
    },
  };
}

export class InMemoryTraceProcessor implements KestrelTraceProcessor {
  readonly traces: RunTrace[] = [];

  process(trace: RunTrace): void {
    this.traces.push(trace);
  }
}

export class ConsoleTraceExporter implements KestrelTraceExporter {
  export(traces: RunTrace[]): void {
    for (const trace of traces) {
      console.log(JSON.stringify(trace));
    }
  }
}

function createTrace(
  agent: KestrelAgent,
  kind: "run" | "stream" | "resume",
  input: KestrelAgentTurnInput,
  context: KestrelRequestContext,
  directive?: TraceStartDirective,
): RunTrace {
  const now = new Date().toISOString();
  const start = resolveTraceStartDirective(directive);
  return {
    traceId: start.context.traceId,
    traceFlags: start.context.traceFlags,
    rootSpanId: start.context.spanId,
    ...(start.parentContext !== undefined ? { parentContext: start.parentContext } : {}),
    links: start.linkContext === undefined
      ? []
      : [{ context: start.linkContext, attributes: { "kestrel.link_kind": start.relationship } }],
    agentId: agent.id,
    profileId: agent.profileId,
    startedAt: now,
    status: "ok",
    sessionId: input.sessionId,
    metadata: {
      "kestrel.kind": kind,
      "kestrel.reasoning.sidecar_model_calls": 0,
      "kestrel.actor_id": context.actor.actorId,
      "kestrel.actor_type": context.actor.actorType,
      ...(context.tenantId !== undefined ? { "kestrel.tenant_id": context.tenantId } : {}),
    },
    spans: [],
  };
}

function createSubscriptionTrace(
  agent: KestrelAgent,
  filter: RunnerEventSubscriptionFilter,
  context: KestrelRequestContext,
  directive?: TraceStartDirective,
): RunTrace {
  const now = new Date().toISOString();
  const start = resolveTraceStartDirective(directive);
  return {
    traceId: start.context.traceId,
    traceFlags: start.context.traceFlags,
    rootSpanId: start.context.spanId,
    ...(start.parentContext !== undefined ? { parentContext: start.parentContext } : {}),
    links: start.linkContext === undefined
      ? []
      : [{ context: start.linkContext, attributes: { "kestrel.link_kind": start.relationship } }],
    agentId: agent.id,
    profileId: agent.profileId,
    startedAt: now,
    status: "ok",
    ...(filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {}),
    ...(filter.threadId !== undefined ? { threadId: filter.threadId } : {}),
    ...(filter.runId !== undefined ? { runId: filter.runId } : {}),
    metadata: {
      "kestrel.kind": "subscription",
      "kestrel.reasoning.sidecar_model_calls": 0,
      "kestrel.actor_id": context.actor.actorId,
      "kestrel.actor_type": context.actor.actorType,
      ...(context.tenantId !== undefined ? { "kestrel.tenant_id": context.tenantId } : {}),
    },
    spans: [],
  };
}

function createStandaloneTrace(input: StartTraceInput): RunTrace {
  const now = new Date().toISOString();
  const start = resolveTraceStartDirective(input.directive);
  return {
    traceId: start.context.traceId,
    traceFlags: start.context.traceFlags,
    rootSpanId: start.context.spanId,
    ...(start.parentContext !== undefined ? { parentContext: start.parentContext } : {}),
    links: start.linkContext === undefined
      ? []
      : [{ context: start.linkContext, attributes: { "kestrel.link_kind": start.relationship } }],
    agentId: input.agentId,
    profileId: input.profileId,
    startedAt: now,
    status: "ok",
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    metadata: compactAttributes(input.metadata ?? {}),
    spans: [],
  };
}

function createSpan(
  trace: RunTrace,
  name: string,
  kind: Span["kind"],
  options: {
    parent?: Span | TraceContext | undefined;
    links?: TraceLink[] | undefined;
    attributes?: KestrelTraceAttributes | undefined;
  } = {},
): Span {
  const isRoot = trace.spans.length === 0;
  const parentContext = options.parent === undefined
    ? (isRoot ? trace.parentContext : undefined)
    : toTraceContext(options.parent);
  if (parentContext !== undefined && parentContext.traceId !== trace.traceId) {
    throw new Error("A parent span must belong to the same trace; use a link for another trace.");
  }
  if (!isRoot && parentContext !== undefined) {
    const localParent = trace.spans.find((span) => span.spanId === parentContext.spanId);
    if (localParent?.endedAt !== undefined) {
      throw new Error(`Cannot start a child after the parent span '${localParent.name}' has ended.`);
    }
  }
  const context = isRoot
    ? {
        version: "trace_context_v1" as const,
        traceId: trace.traceId,
        spanId: trace.rootSpanId,
        traceFlags: trace.traceFlags,
      }
    : createTraceContext({ traceId: trace.traceId, traceFlags: trace.traceFlags });
  const span: Span = {
    traceId: trace.traceId,
    spanId: context.spanId,
    traceFlags: trace.traceFlags,
    ...(parentContext !== undefined ? { parentSpanId: parentContext.spanId } : {}),
    links: normalizeLinks([...(isRoot ? trace.links : []), ...(options.links ?? [])]),
    name,
    kind,
    startedAt: new Date().toISOString(),
    status: "ok",
    attributes: compactAttributes(options.attributes ?? {}),
    events: [],
  };
  trace.spans.push(span);
  return span;
}

const REQUIRED_SPAN_ATTRIBUTES: Readonly<Record<SpanKind, readonly string[]>> = Object.freeze({
  run: ["kestrel.agent_id", "kestrel.profile_id", "kestrel.operation"],
  stream: ["kestrel.agent_id", "kestrel.profile_id", "kestrel.operation"],
  resume: ["kestrel.agent_id", "kestrel.profile_id", "kestrel.operation"],
  subscription: ["kestrel.agent_id", "kestrel.profile_id", "kestrel.operation"],
  model: [
    "kestrel.provider_id",
    "kestrel.model_id",
    "kestrel.retry_attempt",
    "kestrel.latency_ms",
    "kestrel.input_tokens",
    "kestrel.output_tokens",
    "kestrel.result",
  ],
  tool: ["kestrel.tool_id", "kestrel.retry_attempt", "kestrel.latency_ms", "kestrel.result"],
  sandbox: ["kestrel.sandbox_id", "kestrel.result"],
  memory: ["kestrel.memory_operation", "kestrel.result"],
  evaluation: ["kestrel.evaluator_id", "kestrel.result"],
  delegation: ["kestrel.delegation_id", "kestrel.result"],
  approval: ["kestrel.approval_id", "kestrel.result"],
  wait: ["kestrel.wait_kind", "kestrel.result"],
  settlement: ["kestrel.termination_reason", "kestrel.result"],
});

function operationAttributes(
  agent: KestrelAgent,
  operation: "run" | "stream" | "resume" | "subscription",
): KestrelTraceAttributes {
  return {
    "kestrel.agent_id": agent.id,
    "kestrel.profile_id": agent.profileId,
    "kestrel.operation": operation,
  };
}

function toTraceContext(value: Span | TraceContext): TraceContext {
  if ("version" in value) return parseTraceContext(value);
  return parseTraceContext({
    version: "trace_context_v1",
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: value.traceFlags,
  });
}

function normalizeLinks(links: TraceLink[]): TraceLink[] {
  const seen = new Set<string>();
  return links.map((link) => {
    const context = parseTraceContext(link.context);
    const key = `${context.traceId}:${context.spanId}`;
    if (seen.has(key)) throw new Error("Span links must be unique.");
    seen.add(key);
    return {
      context,
      ...(link.attributes !== undefined
        ? { attributes: compactAttributes(link.attributes) }
        : {}),
    };
  });
}

function createSpanHandle(trace: RunTrace, span: Span): SpanHandle {
  let ended = span.endedAt !== undefined;
  return {
    span,
    context: toTraceContext(span),
    addEvent(name, attributes = {}) {
      if (ended) throw new Error("Cannot add an event after the span has ended.");
      span.events.push({
        id: randomUUID(),
        name,
        ts: new Date().toISOString(),
        attributes: compactAttributes(attributes),
      });
    },
    startChild(input) {
      if (ended) throw new Error("Cannot start a child after the parent span has ended.");
      return createSpanHandle(trace, createSpan(trace, input.name, input.kind, {
        parent: span,
        links: input.links,
        attributes: input.attributes,
      }));
    },
    end(status = "ok", attributes = {}) {
      if (ended) return;
      const activeDescendant = findActiveDescendant(trace, span);
      if (activeDescendant !== undefined) {
        throw new Error(`Cannot end span '${span.name}' while descendant span '${activeDescendant.name}' is active.`);
      }
      const nextAttributes = compactAttributes({ ...span.attributes, ...attributes });
      assertRequiredSpanAttributes({ ...span, attributes: nextAttributes });
      ended = true;
      span.status = status;
      span.attributes = nextAttributes;
      span.endedAt = new Date().toISOString();
    },
  };
}

function assertRequiredSpanAttributes(span: Span): void {
  for (const key of REQUIRED_SPAN_ATTRIBUTES[span.kind]) {
    if (span.attributes[key] === undefined) {
      throw new Error(`Span kind '${span.kind}' requires attribute '${key}'.`);
    }
  }
  assertKnownNumericTraceAttributes(span.attributes, `Span kind '${span.kind}'`);
}

function findActiveDescendant(trace: RunTrace, ancestor: Span): Span | undefined {
  const spansById = new Map(trace.spans.map((span) => [span.spanId, span]));
  return trace.spans.find((candidate) => {
    if (candidate === ancestor || candidate.endedAt !== undefined) return false;
    const visited = new Set<string>();
    let parentSpanId = candidate.parentSpanId;
    while (parentSpanId !== undefined) {
      if (parentSpanId === ancestor.spanId) return true;
      if (visited.has(parentSpanId)) return false;
      visited.add(parentSpanId);
      parentSpanId = spansById.get(parentSpanId)?.parentSpanId;
    }
    return false;
  });
}

function assertValidSpanTree(trace: RunTrace, root: Span, rootEndedAt: string): void {
  const spansById = new Map(trace.spans.map((span) => [span.spanId, span]));
  if (spansById.size !== trace.spans.length) {
    throw new Error("A trace cannot contain duplicate span IDs.");
  }
  for (const span of trace.spans) {
    const startedAt = Date.parse(span.startedAt);
    const endedAtValue = span === root ? rootEndedAt : span.endedAt;
    const endedAt = endedAtValue === undefined ? Number.NaN : Date.parse(endedAtValue);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
      throw new Error(`Span '${span.name}' has an invalid temporal lifecycle.`);
    }
    if (span.parentSpanId === undefined) continue;
    const parent = spansById.get(span.parentSpanId);
    if (parent === undefined) continue;
    const visited = new Set([span.spanId]);
    let ancestor: Span | undefined = parent;
    while (ancestor !== undefined) {
      if (visited.has(ancestor.spanId)) {
        throw new Error(`Span '${span.name}' has cyclic parentage.`);
      }
      visited.add(ancestor.spanId);
      ancestor = ancestor.parentSpanId === undefined
        ? undefined
        : spansById.get(ancestor.parentSpanId);
    }
    const parentStartedAt = Date.parse(parent.startedAt);
    const parentEndedAtValue = parent === root ? rootEndedAt : parent.endedAt;
    const parentEndedAt = parentEndedAtValue === undefined ? Number.NaN : Date.parse(parentEndedAtValue);
    if (
      !Number.isFinite(parentStartedAt) ||
      !Number.isFinite(parentEndedAt) ||
      startedAt < parentStartedAt ||
      endedAt > parentEndedAt
    ) {
      throw new Error(`Span '${span.name}' is outside parent span '${parent.name}' lifecycle.`);
    }
  }
}

function recordRunnerEvent(trace: RunTrace, span: Span, event: RunnerEventEnvelope): void {
  const priorModelCompletion = findLastProgressEventTimestamp(span, "MODEL_CALL_DONE");
  const priorTerminalization =
    findLastProgressEventTimestamp(span, "RUN_COMPLETED") ??
    findLastProgressEventTimestamp(span, "RUN_TERMINAL");
  const progressCode = readProgressCode(event);
  span.events.push({
    id: event.id,
    name: event.type,
    ts: event.ts,
    attributes: compactAttributes({
      ...(event.sessionId !== undefined ? { "kestrel.session_id": event.sessionId } : {}),
      ...(event.threadId !== undefined ? { "kestrel.thread_id": event.threadId } : {}),
      ...(event.runId !== undefined ? { "kestrel.run_id": event.runId } : {}),
      ...(event.commandId !== undefined ? { "kestrel.command_id": event.commandId } : {}),
      ...(progressCode !== undefined ? { "kestrel.progress_code": progressCode } : {}),
    }),
  });
  if (event.sessionId !== undefined) {
    trace.sessionId = event.sessionId;
  }
  if (event.threadId !== undefined) {
    trace.threadId = event.threadId;
  }
  if (event.runId !== undefined) {
    trace.runId = event.runId;
  }
  if (event.type === "run.cancelled") {
    trace.status = "cancelled";
    span.status = "cancelled";
  }
  if (
    span.attributes["kestrel.latency.time_to_first_reasoning_ms"] === undefined &&
    (event.type === "run.model.reasoning.started" || event.type === "run.model.reasoning.delta")
  ) {
    span.attributes["kestrel.latency.time_to_first_reasoning_ms"] = elapsedMs(span.startedAt, event.ts);
  }
  if (progressCode === "STEP_COMMITTED" && priorModelCompletion !== undefined) {
    span.attributes["kestrel.latency.model_completion_to_dispatch_ms"] = elapsedMs(
      priorModelCompletion,
      event.ts,
    );
  }
  if (event.type === "run.completed" && priorTerminalization !== undefined) {
    span.attributes["kestrel.latency.finalize_to_first_byte_ms"] = elapsedMs(
      priorTerminalization,
      event.ts,
    );
  }
}

function findLastProgressEventTimestamp(span: Span, code: string): string | undefined {
  for (let index = span.events.length - 1; index >= 0; index -= 1) {
    const event = span.events[index];
    if (event?.attributes?.["kestrel.progress_code"] === code) return event.ts;
  }
  return ;
}

function readProgressCode(event: RunnerEventEnvelope): string | undefined {
  if (event.type !== "run.progress") return ;
  const payload = event.payload as { update?: { code?: unknown } | undefined };
  return typeof payload.update?.code === "string" ? payload.update.code : undefined;
}

function elapsedMs(start: string, end: string): number {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function annotateRunTerminal(trace: RunTrace, span: Span, terminal: RunnerRunTerminalEvent): void {
  recordRunnerEvent(trace, span, terminal);
  applyRunTerminalStatus(trace, span, terminal);
}

function applyRunTerminalStatus(trace: RunTrace, span: Span, terminal: RunnerRunTerminalEvent): void {
  trace.runId = trace.runId ?? terminal.runId ?? readRunId(terminal);
  if (terminal.type === "run.failed") {
    trace.status = "error";
    span.status = "error";
    return;
  }
  if (terminal.type === "run.cancelled") {
    trace.status = "cancelled";
    span.status = "cancelled";
    return;
  }
  trace.status = "ok";
  span.status = "ok";
}

function annotateErrorTrace(trace: RunTrace, span: Span, error: unknown): void {
  trace.status = "error";
  span.status = "error";
  span.events.push({
    id: randomUUID(),
    name: "error",
    ts: new Date().toISOString(),
    attributes: compactAttributes({
      "error.type": error instanceof Error ? error.name : "UnknownError",
    }),
  });
}

function settleTrace(trace: RunTrace, span: Span): void {
  const now = new Date().toISOString();
  span.endedAt = span.endedAt ?? now;
  trace.endedAt = trace.endedAt ?? now;
}

async function processTrace(
  trace: RunTrace,
  processors: KestrelTraceProcessor[],
  exporters: KestrelTraceExporter[],
  onExportError?: ((error: unknown) => void) | undefined,
): Promise<void> {
  for (const processor of processors) {
    try {
      await processor.process(trace);
    } catch (error) {
      reportExportError(onExportError, error);
    }
  }
  for (const exporter of exporters) {
    try {
      await exporter.export([trace]);
    } catch (error) {
      reportExportError(onExportError, error);
    }
  }
}

function reportExportError(
  onExportError: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    onExportError?.(error);
  } catch {
    // Observability callbacks are intentionally non-authoritative.
  }
}

function readRunId(terminal: RunnerRunTerminalEvent): string | undefined {
  if (terminal.runId !== undefined) {
    return terminal.runId;
  }
  const payload = terminal.payload as {
    result?: {
      output?: {
        runId?: string | undefined;
      } | undefined;
    } | undefined;
  };
  return payload.result?.output?.runId;
}

function wrapRunnerStream<TEvent extends RunnerEventEnvelope, TTerminal>(
  input: {
    stream: RunnerStream<TEvent, TTerminal>;
    onEvent: (event: TEvent) => void;
    onResult: (result: TTerminal) => void;
    onError: (error: unknown) => void;
    onFinally: () => void;
  },
): RunnerStream<TEvent, TTerminal> {
  let mirrored!: MirroredRunnerStream<TEvent, TTerminal>;
  let settled = false;
  let errorHandled = false;
  let pendingCompletion = false;
  let pendingFailure: unknown;
  const pendingEvents: TEvent[] = [];
  const handleError = (error: unknown) => {
    if (errorHandled) {
      return;
    }
    errorHandled = true;
    input.onError(error);
  };

  const pump = (async () => {
    try {
      for await (const event of input.stream) {
        input.onEvent(event);
        if (mirrored === undefined) {
          pendingEvents.push(event);
          continue;
        }
        mirrored.push(event);
      }
      if (mirrored === undefined) {
        pendingCompletion = true;
        return;
      }
      mirrored.finish();
    } catch (error) {
      handleError(error);
      if (mirrored === undefined) {
        pendingFailure = error;
        return;
      }
      mirrored.fail(error);
      throw error;
    }
  })();

  const result = input.stream.result
    .then((terminal) => {
      input.onResult(terminal);
      return terminal;
    })
    .catch((error) => {
      handleError(error);
      mirrored.fail(error);
      throw error;
    })
    .finally(async () => {
      await pump.catch(() => {});
      if (settled) {
        return;
      }
      settled = true;
      input.onFinally();
    });

  mirrored = new MirroredRunnerStream(
    result,
    () => input.stream.cancel(),
    input.stream.ready,
  );
  for (const event of pendingEvents) {
    mirrored.push(event);
  }
  if (pendingFailure !== undefined) {
    mirrored.fail(pendingFailure);
  } else if (pendingCompletion) {
    mirrored.finish();
  }
  return mirrored;
}

class MirroredRunnerStream<TEvent, TTerminal>
  implements RunnerStream<TEvent, TTerminal>, AsyncIterator<TEvent>
{
  readonly ready: Promise<void>;
  readonly result: Promise<TTerminal>;

  private readonly cancelImpl: () => Promise<void>;
  private readonly queue: TEvent[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<TEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  constructor(
    result: Promise<TTerminal>,
    cancelImpl: () => Promise<void>,
    ready: Promise<void>,
  ) {
    this.ready = ready;
    this.result = result;
    this.cancelImpl = cancelImpl;
  }

  push(event: TEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failure = undefined;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failure = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  async cancel(): Promise<void> {
    await this.cancelImpl();
  }

  next(): Promise<IteratorResult<TEvent>> {
    if (this.queue.length > 0) {
      const value = this.queue.shift() as TEvent;
      return Promise.resolve({ value, done: false });
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<TEvent>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    return this;
  }
}
