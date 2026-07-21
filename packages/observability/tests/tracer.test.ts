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
import { createTracer, InMemoryTraceProcessor } from "../src/index.js";
import { OpenTelemetryTraceExporter } from "../src/otel.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const context: KestrelRequestContext = {
  actor: {
    actorId: "user-1",
    actorType: "end_user",
    displayName: "Taylor",
    tenantId: "acme",
  },
  tenantId: "acme",
};

contractTest("packages.hermetic", "createTracer records Kestrel-native run traces", async () => {
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
  assert.equal(trace?.spans[0]?.status, "ok");
});

contractTest("packages.hermetic", "OpenTelemetryTraceExporter exports real spans with correlation metadata", async () => {
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
  assert.equal(spans[0]?.attributes["kestrel.outcome"], "ok");
});

contractTest("packages.hermetic", "stream traces record terminal outcomes exactly once", async () => {
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

contractTest("packages.hermetic", "stream traces capture events even when the caller only awaits result", async () => {
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

contractTest("packages.hermetic", "OpenTelemetryTraceExporter marks cancelled traces with explicit outcome", async () => {
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

contractTest("packages.hermetic", "stream traces expose provider-reasoning and terminal dispatch latency metrics", async () => {
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
