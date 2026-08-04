import test from "node:test";
import assert from "node:assert/strict";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type {
  KestrelAgent,
  KestrelAgentTurnInput,
  KestrelRequestContext,
  RunnerEventSubscriptionFilter,
  RunnerRunTerminalEvent,
  RunnerStream,
  RunnerStreamEvent,
} from "@kestrel-agents/sdk";
import type { RunnerEventEnvelope } from "@kestrel-agents/sdk/runner";
import {
  TRACE_CONTEXT_VERSION,
  createTracer,
  InMemoryTraceProcessor,
  parseTraceContext,
  parseTraceStartDirective,
} from "../src/index.js";
import { OpenTelemetryTraceExporter } from "../src/otel.js";


const context: KestrelRequestContext = {
  actor: {
    actorId: "user-1",
    actorType: "end_user",
    displayName: "Taylor",
    tenantId: "acme",
  },
  tenantId: "acme",
};

test("createTracer records Kestrel-native run traces", async () => {
  const processor = new InMemoryTraceProcessor();
  const tracer = createTracer({ processors: [processor] });
  const agent = tracer.wrapAgent(createFakeAgent());

  const terminal = await agent.run(
    {
      sessionId: "session-1",
      message: "hello",
    },
    context,
  );

  assert.equal(terminal.type, "run.completed");
  await tracer.flush();
  assert.equal(processor.traces.length, 1);
  const trace = processor.traces[0];
  assert.equal(trace?.agentId, "support-agent");
  assert.equal(trace?.sessionId, "session-1");
  assert.equal(trace?.runId, "run-session-1");
  assert.equal(trace?.metadata["kestrel.actor_id"], "user-1");
  assert.equal(trace?.metadata["kestrel.actor_name"], undefined);
  assert.equal(trace?.spans[0]?.status, "ok");
});

test("OpenTelemetryTraceExporter exports real spans with correlation metadata", async () => {
  const exporter = new InMemorySpanExporter();
  const tracer = createTracer({ exporters: [new OpenTelemetryTraceExporter(exporter)] });
  const agent = tracer.wrapAgent(createFakeAgent());

  await agent.run(
    {
      sessionId: "session-2",
      message: "hello",
    },
    context,
  );
  await tracer.flush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.attributes["kestrel.agent_id"], "support-agent");
  assert.equal(spans[0]?.attributes["kestrel.session_id"], "session-2");
  assert.equal(spans[0]?.attributes["enduser.id"], "user-1");
  assert.equal(spans[0]?.attributes["kestrel.actor_name"], undefined);
  assert.equal(spans[0]?.attributes["kestrel.outcome"], "ok");
});

test("stream traces record terminal outcomes exactly once", async () => {
  const processor = new InMemoryTraceProcessor();
  const tracer = createTracer({ processors: [processor] });
  const agent = tracer.wrapAgent(createFakeAgent());

  const stream = agent.stream(
    {
      sessionId: "session-3",
      message: "hello",
    },
    context,
  );
  for await (const _event of stream) {
    // Drain all streamed events.
  }
  await stream.result;
  await tracer.flush();

  const trace = processor.traces[0];
  assert.ok(trace);
  const terminalEvents = trace.spans[0]?.events.filter((event) => event.name === "run.completed") ?? [];
  assert.equal(terminalEvents.length, 1);
});

test("stream traces capture events even when the caller only awaits result", async () => {
  const processor = new InMemoryTraceProcessor();
  const tracer = createTracer({ processors: [processor] });
  const agent = tracer.wrapAgent(createFakeAgent());

  const stream = agent.stream(
    {
      sessionId: "session-4",
      message: "hello",
    },
    context,
  );
  await stream.result;
  await tracer.flush();

  const trace = processor.traces[0];
  assert.ok(trace);
  const eventNames = trace.spans[0]?.events.map((event) => event.name) ?? [];
  assert.deepEqual(eventNames, ["run.started", "run.completed"]);
});

test("OpenTelemetryTraceExporter marks cancelled traces with explicit outcome", async () => {
  const exporter = new InMemorySpanExporter();
  const tracer = createTracer({ exporters: [new OpenTelemetryTraceExporter(exporter)] });
  const agent = tracer.wrapAgent(createCancelledAgent());

  await agent.run(
    {
      sessionId: "session-5",
      message: "cancel",
    },
    context,
  );
  await tracer.flush();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.attributes["kestrel.outcome"], "cancelled");
  assert.equal(spans[0]?.status.code, 0);
});

test("stream traces expose provider-reasoning and terminal dispatch latency metrics", async () => {
  const processor = new InMemoryTraceProcessor();
  const tracer = createTracer({ processors: [processor] });
  const agent = tracer.wrapAgent(createMetricAgent());
  const stream = agent.stream({ sessionId: "session-metrics", message: "measure" }, context);
  for await (const _event of stream) {
    // Drain the measured stream.
  }
  await stream.result;
  await tracer.flush();

  const trace = processor.traces[0];
  assert.equal(trace?.metadata["kestrel.reasoning.sidecar_model_calls"], 0);
  const attributes = trace?.spans[0]?.attributes;
  assert.equal(attributes?.["kestrel.latency.model_completion_to_dispatch_ms"], 20);
  assert.equal(attributes?.["kestrel.latency.finalize_to_first_byte_ms"], 15);
  assert.equal(typeof attributes?.["kestrel.latency.time_to_first_reasoning_ms"], "number");
});

test("generic traces preserve nested parentage and required safe model attributes", async () => {
  const processor = new InMemoryTraceProcessor();
  const tracer = createTracer({ processors: [processor] });
  const trace = tracer.startTrace({
    agentId: "support-agent",
    profileId: "support",
    name: "agent.run",
    kind: "run",
    attributes: {
      "kestrel.agent_id": "support-agent",
      "kestrel.profile_id": "support",
      "kestrel.operation": "run",
    },
  });
  const model = trace.root.startChild({
    name: "model.call",
    kind: "model",
    attributes: {
      "kestrel.provider_id": "openai",
      "kestrel.model_id": "gpt-5",
      "kestrel.retry_attempt": 1,
      "kestrel.latency_ms": 20,
      "kestrel.input_tokens": 10,
      "kestrel.output_tokens": 5,
      "kestrel.result": "completed",
      "kestrel.prompt": "must-not-be-captured",
    },
  });
  model.addEvent("model.completed", { "kestrel.result": "completed" });
  model.end();
  trace.end();
  await tracer.flush();

  const recorded = processor.traces[0];
  const root = recorded?.spans[0];
  const child = recorded?.spans[1];
  assert.equal(root?.traceId, child?.traceId);
  assert.equal(child?.parentSpanId, root?.spanId);
  assert.equal(child?.attributes["kestrel.prompt"], undefined);
  assert.match(root?.traceId ?? "", /^[0-9a-f]{32}$/u);
  assert.match(child?.spanId ?? "", /^[0-9a-f]{16}$/u);
});

test("resume continues only an exact persisted trace context", async () => {
  const processor = new InMemoryTraceProcessor();
  const persisted = {
    version: TRACE_CONTEXT_VERSION,
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    traceFlags: "01",
  } as const;
  const tracer = createTracer({
    processors: [processor],
    resolveTraceStart(input) {
      return input.operation === "resume"
        ? { relationship: "continue", sourceContext: persisted }
        : undefined;
    },
  });
  const agent = tracer.wrapAgent(createFakeAgent());
  await agent.resume(
    { sessionId: "session-resume", requestId: "request-1", message: "continue" },
    context,
  );
  await tracer.flush();

  const span = processor.traces[0]?.spans[0];
  assert.equal(span?.traceId, persisted.traceId);
  assert.equal(span?.parentSpanId, persisted.spanId);
  assert.notEqual(span?.spanId, persisted.spanId);
});

test("nested spans cannot outlive or be created after their parent", async () => {
  const tracer = createTracer();
  const trace = tracer.startTrace({
    agentId: "support-agent",
    profileId: "support",
    name: "agent.run",
    kind: "run",
    attributes: {
      "kestrel.agent_id": "support-agent",
      "kestrel.profile_id": "support",
      "kestrel.operation": "run",
    },
  });
  const child = trace.root.startChild({
    name: "tool.call",
    kind: "tool",
    attributes: {
      "kestrel.tool_id": "weather.forecast",
      "kestrel.retry_attempt": 1,
      "kestrel.latency_ms": 5,
      "kestrel.result": "completed",
    },
  });
  const descendant = child.startChild({
    name: "sandbox.call",
    kind: "sandbox",
    attributes: {
      "kestrel.sandbox_id": "sandbox-1",
      "kestrel.result": "completed",
    },
  });
  assert.throws(() => trace.end(), /child span 'tool.call' is active/u);
  assert.throws(
    () => child.end(),
    /span 'tool.call' while descendant span 'sandbox.call' is active/u,
  );
  descendant.end();
  child.end();
  assert.throws(
    () => trace.startSpan({
      name: "late.sandbox",
      kind: "sandbox",
      parent: child.span,
      attributes: {
        "kestrel.sandbox_id": "sandbox-2",
        "kestrel.result": "completed",
      },
    }),
    /parent span 'tool.call' has ended/u,
  );
  trace.end();
  await assert.doesNotReject(() => tracer.flush());
});

test("trace settlement rejects a mutated temporal tree", () => {
  const tracer = createTracer();
  const trace = startRunTrace(tracer);
  const child = trace.root.startChild({
    name: "tool.call",
    kind: "tool",
    attributes: {
      "kestrel.tool_id": "weather.forecast",
      "kestrel.retry_attempt": 0,
      "kestrel.latency_ms": 5,
      "kestrel.result": "completed",
    },
  });
  child.end();
  child.span.endedAt = "2999-01-01T00:00:00.000Z";
  assert.throws(() => trace.end(), /outside parent span 'agent.run' lifecycle/u);
});

test("replay and fork start linked traces instead of continuing the source", async () => {
  const exporter = new InMemorySpanExporter();
  const tracer = createTracer({ exporters: [new OpenTelemetryTraceExporter(exporter)] });
  const sourceContext = {
    version: TRACE_CONTEXT_VERSION,
    traceId: "fedcba9876543210fedcba9876543210",
    spanId: "fedcba9876543210",
    traceFlags: "01",
  } as const;
  for (const relationship of ["replay", "fork"] as const) {
    const trace = tracer.startTrace({
      agentId: "support-agent",
      profileId: "support",
      name: `agent.${relationship}`,
      kind: "run",
      directive: { relationship, sourceContext },
      attributes: {
        "kestrel.agent_id": "support-agent",
        "kestrel.profile_id": "support",
        "kestrel.operation": relationship,
      },
    });
    assert.notEqual(trace.root.context.traceId, sourceContext.traceId);
    assert.equal(trace.root.span.parentSpanId, undefined);
    trace.end();
  }
  await tracer.flush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 2);
  assert.equal(spans[0]?.links[0]?.context.traceId, sourceContext.traceId);
  assert.equal(spans[0]?.links[0]?.attributes["kestrel.link_kind"], "replay");
  assert.equal(spans[1]?.links[0]?.attributes["kestrel.link_kind"], "fork");
});

test("invalid context and untrusted baggage fail strict parsing", () => {
  assert.throws(
    () => parseTraceContext({
      version: TRACE_CONTEXT_VERSION,
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: "01",
      baggage: "untrusted=value",
    }),
    /unknown field 'baggage'/u,
  );
  assert.throws(
    () => parseTraceStartDirective({
      relationship: "replaay",
      sourceContext: {
        version: TRACE_CONTEXT_VERSION,
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: "01",
      },
    }),
    /relationship is invalid/u,
  );
});

test("invalid persisted directives are reported without changing agent behavior or creating links", async () => {
  const processor = new InMemoryTraceProcessor();
  const failures: unknown[] = [];
  const tracer = createTracer({
    processors: [processor],
    resolveTraceStart() {
      return {
        relationship: "replaay",
        sourceContext: {
          version: TRACE_CONTEXT_VERSION,
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: "0123456789abcdef",
          traceFlags: "01",
        },
      } as never;
    },
    onExportError(error) { failures.push(error); },
  });
  const terminal = await tracer.wrapAgent(createFakeAgent()).run(
    { sessionId: "session-invalid-directive", message: "hello" },
    context,
  );
  await tracer.flush();

  assert.equal(terminal.type, "run.completed");
  assert.equal(failures.length, 1);
  assert.equal(processor.traces[0]?.parentContext, undefined);
  assert.deepEqual(processor.traces[0]?.links, []);
});

test("known numeric span attributes require exact non-negative values", () => {
  const cases: ReadonlyArray<readonly [string, string | number, RegExp]> = [
    ["kestrel.retry_attempt", "first", /retry_attempt.*non-negative safe integer/u],
    ["kestrel.retry_attempt", -1, /retry_attempt.*non-negative safe integer/u],
    ["kestrel.latency_ms", -0.1, /latency_ms.*non-negative finite number/u],
    ["kestrel.input_tokens", 1.5, /input_tokens.*non-negative safe integer/u],
    ["kestrel.output_tokens", -1, /output_tokens.*non-negative safe integer/u],
  ];
  for (const [key, value, expected] of cases) {
    const trace = startRunTrace(createTracer());
    const model = trace.root.startChild({
      name: "model.call",
      kind: "model",
      attributes: {
        "kestrel.provider_id": "openai",
        "kestrel.model_id": "gpt-5",
        "kestrel.retry_attempt": 0,
        "kestrel.latency_ms": 10,
        "kestrel.input_tokens": 1,
        "kestrel.output_tokens": 1,
        "kestrel.result": "completed",
        [key]: value,
      },
    });
    assert.throws(() => model.end(), expected);
  }
});

test("OTEL export removes actor-name and PII metadata even if a trace is mutated", async () => {
  const exporter = new InMemorySpanExporter();
  const tracer = createTracer({ exporters: [new OpenTelemetryTraceExporter(exporter)] });
  const trace = startRunTrace(tracer);
  trace.trace.metadata["kestrel.actor_name"] = "Taylor";
  trace.trace.metadata["kestrel.pii"] = "must-not-export";
  trace.end();
  await tracer.flush();

  const attributes = exporter.getFinishedSpans()[0]?.attributes;
  assert.equal(attributes?.["kestrel.actor_name"], undefined);
  assert.equal(attributes?.["kestrel.pii"], undefined);
});

test("processor and exporter failures cannot change agent behavior", async () => {
  const failures: unknown[] = [];
  const tracer = createTracer({
    processors: [{ process() { throw new Error("processor unavailable"); } }],
    exporters: [{ export() { throw new Error("exporter unavailable"); } }],
    onExportError(error) { failures.push(error); },
  });
  const terminal = await tracer.wrapAgent(createFakeAgent()).run(
    { sessionId: "session-export-failure", message: "hello" },
    context,
  );
  assert.equal(terminal.type, "run.completed");
  await assert.doesNotReject(() => tracer.flush());
  assert.equal(failures.length, 2);
});

function startRunTrace(tracer: ReturnType<typeof createTracer>) {
  return tracer.startTrace({
    agentId: "support-agent",
    profileId: "support",
    name: "agent.run",
    kind: "run",
    attributes: {
      "kestrel.agent_id": "support-agent",
      "kestrel.profile_id": "support",
      "kestrel.operation": "run",
    },
  });
}

function createFakeAgent(): KestrelAgent {
  return {
    id: "support-agent",
    profileId: "support",
    async run(_input: KestrelAgentTurnInput, _context: KestrelRequestContext): Promise<RunnerRunTerminalEvent> {
      const input = _input;
      return {
        id: "evt-run-completed",
        type: "run.completed",
        ts: new Date().toISOString(),
        sessionId: input.sessionId,
        runId: `run-${input.sessionId}`,
        payload: {
          result: {
            output: {
              status: "COMPLETED",
              sessionId: input.sessionId,
              runId: `run-${input.sessionId}`,
              errors: [],
            },
          },
        },
      };
    },
    stream(_input: KestrelAgentTurnInput, _context: KestrelRequestContext): RunnerStream<RunnerStreamEvent, RunnerRunTerminalEvent> {
      const input = _input;
      const terminal: RunnerRunTerminalEvent = {
        id: "evt-run-completed",
        type: "run.completed",
        ts: new Date().toISOString(),
        sessionId: input.sessionId,
        runId: `run-${input.sessionId}`,
        payload: {
          result: {
            output: {
              status: "COMPLETED",
              sessionId: input.sessionId,
              runId: `run-${input.sessionId}`,
              errors: [],
            },
          },
        },
      };
      return {
        result: Promise.resolve(terminal),
        async cancel() {},
        async *[Symbol.asyncIterator]() {
          const started: RunnerStreamEvent = {
            id: "evt-run-started",
            type: "run.started",
            ts: new Date().toISOString(),
            sessionId: input.sessionId,
            payload: {
              sessionId: input.sessionId,
              eventType: "user.message",
            },
          };
          yield started;
          yield terminal;
        },
      };
    },
    async resume(input: KestrelAgentTurnInput, contextValue: KestrelRequestContext): Promise<RunnerRunTerminalEvent> {
      return this.run(input, contextValue);
    },
    subscribe(
      _filter: RunnerEventSubscriptionFilter,
      _context: KestrelRequestContext,
    ): RunnerStream<RunnerEventEnvelope, void> {
      return {
        result: Promise.resolve(),
        async cancel() {},
        async *[Symbol.asyncIterator]() {
          yield {
            id: "evt-task-updated",
            type: "task.updated",
            ts: new Date().toISOString(),
            sessionId: "session-1",
            payload: {
              task: {
                taskId: "task-1",
              },
              kind: "waiting",
            },
          };
        },
      };
    },
    session() {
      return {
        async get() {
          return {
            sessionId: "session-1",
            version: 1,
            memory: {
              goal: "",
              currentPlan: "",
              findings: "",
              decisions: "",
              openQuestions: "",
              nextAction: "",
              linkedArtifacts: [],
            },
            memoryRevision: 1,
          };
        },
        memory: {
          async get() {
            return {
              revision: 1,
              value: {
                goal: "",
                currentPlan: "",
                findings: "",
                decisions: "",
                openQuestions: "",
                nextAction: "",
                linkedArtifacts: [],
              },
            };
          },
          async update() {
            return {
              revision: 2,
              value: {
                goal: "",
                currentPlan: "",
                findings: "",
                decisions: "",
                openQuestions: "",
                nextAction: "",
                linkedArtifacts: [],
              },
            };
          },
        },
      };
    },
    async close() {},
  };
}

function createMetricAgent(): KestrelAgent {
  const base = Date.now() + 25;
  const sessionId = "session-metrics";
  const runId = "run-metrics";
  const event = (id: string, type: string, offset: number, payload: Record<string, unknown>) => ({
    id,
    type,
    ts: new Date(base + offset).toISOString(),
    sessionId,
    runId,
    payload,
  }) as RunnerStreamEvent;
  const terminal = event("evt-completed", "run.completed", 65, {
    result: { output: { status: "COMPLETED", sessionId, runId, errors: [] } },
  }) as RunnerRunTerminalEvent;
  return {
    ...createFakeAgent(),
    stream() {
      const events = [
        event("evt-started", "run.started", 0, { sessionId, eventType: "user.message" }),
        event("evt-reasoning", "run.model.reasoning.started", 10, {
          update: { version: "v1", event: "started" },
        }),
        event("evt-model-done", "run.progress", 20, {
          update: { code: "MODEL_CALL_DONE" },
        }),
        event("evt-step-committed", "run.progress", 40, {
          update: { code: "STEP_COMMITTED" },
        }),
        event("evt-terminalized", "run.progress", 50, {
          update: { code: "RUN_COMPLETED" },
        }),
        terminal,
      ];
      return {
        result: Promise.resolve(terminal),
        async cancel() {},
        async *[Symbol.asyncIterator]() {
          for (const item of events) yield item;
        },
      };
    },
  };
}

function createCancelledAgent(): KestrelAgent {
  return {
    ...createFakeAgent(),
    async run(input: KestrelAgentTurnInput): Promise<RunnerRunTerminalEvent> {
      return {
        id: "evt-run-cancelled",
        type: "run.cancelled",
        ts: new Date().toISOString(),
        sessionId: input.sessionId,
        runId: `run-${input.sessionId}`,
        payload: {
          sessionId: input.sessionId,
          runId: `run-${input.sessionId}`,
        },
      };
    },
  };
}
