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

export type KestrelTracePrimitive = string | number | boolean;
export type KestrelTraceAttributes = Record<string, KestrelTracePrimitive | undefined>;

export interface TraceEvent {
  id: string;
  name: string;
  ts: string;
  attributes?: KestrelTraceAttributes | undefined;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  kind: "run" | "stream" | "resume" | "subscription";
  startedAt: string;
  endedAt?: string | undefined;
  status: "ok" | "error" | "cancelled";
  attributes: KestrelTraceAttributes;
  events: TraceEvent[];
}

export interface RunTrace {
  traceId: string;
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
}

export interface KestrelTracer {
  wrapAgent(agent: KestrelAgent): KestrelAgent;
  flush(): Promise<void>;
}

export function createTracer(options: CreateTracerOptions = {}): KestrelTracer {
  const processors = options.processors ?? [];
  const exporters = options.exporters ?? [];
  const pending = new Set<Promise<void>>();

  return {
    wrapAgent(agent) {
      return {
        ...agent,
        async run(input: KestrelAgentTurnInput, context: KestrelRequestContext) {
          const trace = createTrace(agent, "run", input, context);
          const span = createSpan(trace, "agent.run", "run");
          try {
            const terminal = await agent.run(input, context);
            annotateRunTerminal(trace, span, terminal);
            return terminal;
          } catch (error) {
            annotateErrorTrace(trace, span, error);
            throw error;
          } finally {
            settleTrace(trace, span);
            const processTracePromise = processTrace(trace, processors, exporters);
            pending.add(processTracePromise.finally(() => pending.delete(processTracePromise)));
          }
        },

        stream(input: KestrelAgentTurnInput & { signal?: AbortSignal | undefined }, context: KestrelRequestContext) {
          const trace = createTrace(agent, "stream", input, context);
          const span = createSpan(trace, "agent.stream", "stream");
          const stream = agent.stream(input, context);
          return wrapRunnerStream({
            stream,
            onEvent: (event) => recordRunnerEvent(trace, span, event),
            onResult: (terminal: RunnerRunTerminalEvent) => applyRunTerminalStatus(trace, span, terminal),
            onError: (error: unknown) => annotateErrorTrace(trace, span, error),
            onFinally: () => {
              settleTrace(trace, span);
              const promise = processTrace(trace, processors, exporters);
              pending.add(promise.finally(() => pending.delete(promise)));
            },
          });
        },

        async resume(input: KestrelAgentResumeInput, context: KestrelRequestContext) {
          const trace = createTrace(agent, "resume", input, context);
          const span = createSpan(trace, "agent.resume", "resume");
          try {
            const terminal = await agent.resume(input, context);
            annotateRunTerminal(trace, span, terminal);
            return terminal;
          } catch (error) {
            annotateErrorTrace(trace, span, error);
            throw error;
          } finally {
            settleTrace(trace, span);
            const promise = processTrace(trace, processors, exporters);
            pending.add(promise.finally(() => pending.delete(promise)));
          }
        },

        subscribe(
          filter: RunnerEventSubscriptionFilter,
          context: KestrelRequestContext,
          options?: {
            signal?: AbortSignal | undefined;
          },
        ) {
          const trace = createSubscriptionTrace(agent, filter, context);
          const span = createSpan(trace, "agent.subscribe", "subscription");
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
              const promise = processTrace(trace, processors, exporters);
              pending.add(promise.finally(() => pending.delete(promise)));
            },
          });
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
): RunTrace {
  const now = new Date().toISOString();
  return {
    traceId: randomUUID(),
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
      ...(context.actor.displayName !== undefined ? { "kestrel.actor_name": context.actor.displayName } : {}),
    },
    spans: [],
  };
}

function createSubscriptionTrace(
  agent: KestrelAgent,
  filter: RunnerEventSubscriptionFilter,
  context: KestrelRequestContext,
): RunTrace {
  const now = new Date().toISOString();
  return {
    traceId: randomUUID(),
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

function createSpan(trace: RunTrace, name: string, kind: Span["kind"]): Span {
  const span: Span = {
    traceId: trace.traceId,
    spanId: randomUUID(),
    name,
    kind,
    startedAt: new Date().toISOString(),
    status: "ok",
    attributes: {},
    events: [],
  };
  trace.spans.push(span);
  return span;
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
      "error.message": error instanceof Error ? error.message : "Unknown error",
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
): Promise<void> {
  for (const processor of processors) {
    await processor.process(trace);
  }
  for (const exporter of exporters) {
    await exporter.export([trace]);
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

  mirrored = new MirroredRunnerStream(result, () => input.stream.cancel());
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

function compactAttributes(attributes: KestrelTraceAttributes): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [[key, value]];
      }
      return [];
    }),
  );
}

class MirroredRunnerStream<TEvent, TTerminal>
  implements RunnerStream<TEvent, TTerminal>, AsyncIterator<TEvent>
{
  readonly result: Promise<TTerminal>;

  private readonly cancelImpl: () => Promise<void>;
  private readonly queue: TEvent[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<TEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  constructor(result: Promise<TTerminal>, cancelImpl: () => Promise<void>) {
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
