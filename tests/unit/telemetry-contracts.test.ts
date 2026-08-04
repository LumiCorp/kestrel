import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_SPAN_EVENT_VERSION,
  RUNTIME_SPAN_VERSION,
  TRACE_CONTEXT_VERSION,
  TRACE_CORRELATION_VERSION,
  parseRuntimeSpanV1,
  parseTraceContextV1,
  parseTraceCorrelationV1,
} from "../../src/kestrel/contracts/telemetry.js";

const rootContext = {
  version: TRACE_CONTEXT_VERSION,
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: "01",
} as const;

test("TraceContextV1 accepts only exact non-zero W3C identities", () => {
  assert.deepEqual(parseTraceContextV1(rootContext), rootContext);
  assert.throws(
    () => parseTraceContextV1({ ...rootContext, traceId: rootContext.traceId.toUpperCase() }),
    /lowercase W3C trace ID/u,
  );
  assert.throws(
    () => parseTraceContextV1({ ...rootContext, spanId: "0000000000000000" }),
    /non-zero lowercase W3C span ID/u,
  );
  assert.throws(
    () => parseTraceContextV1({ ...rootContext, baggage: "untrusted=value" }),
    /unknown field 'baggage'/u,
  );
});

test("TraceCorrelationV1 is typed and rejects empty or widened references", () => {
  assert.deepEqual(
    parseTraceCorrelationV1({
      version: TRACE_CORRELATION_VERSION,
      eventSequence: 4,
      checkpointId: "checkpoint-1",
      replayId: "replay-1",
    }),
    {
      version: TRACE_CORRELATION_VERSION,
      eventSequence: 4,
      checkpointId: "checkpoint-1",
      replayId: "replay-1",
    },
  );
  assert.throws(
    () => parseTraceCorrelationV1({ version: TRACE_CORRELATION_VERSION }),
    /at least one typed reference/u,
  );
  assert.throws(
    () => parseTraceCorrelationV1({ version: TRACE_CORRELATION_VERSION, requestId: "wide" }),
    /unknown field 'requestId'/u,
  );
});

test("RuntimeSpanV1 validates parentage, links, events, and required safe attributes", () => {
  const span = parseRuntimeSpanV1({
    version: RUNTIME_SPAN_VERSION,
    context: rootContext,
    parentSpanId: "fedcba9876543210",
    links: [
      {
        context: {
          ...rootContext,
          traceId: "fedcba9876543210fedcba9876543210",
          spanId: "fedcba9876543210",
        },
        attributes: { "kestrel.link_kind": "replay" },
      },
    ],
    name: "agent.run",
    kind: "run",
    startedAt: "2026-08-04T12:00:00.000Z",
    endedAt: "2026-08-04T12:00:01.000Z",
    status: "ok",
    attributes: {
      "kestrel.agent_id": "agent-1",
      "kestrel.profile_id": "profile-1",
      "kestrel.operation": "run",
    },
    events: [
      {
        version: RUNTIME_SPAN_EVENT_VERSION,
        eventId: "event-1",
        name: "run.completed",
        timestamp: "2026-08-04T12:00:01.000Z",
        attributes: { "kestrel.result": "completed" },
        correlation: {
          version: TRACE_CORRELATION_VERSION,
          eventSequence: 7,
        },
      },
    ],
  });
  assert.equal(span.parentSpanId, "fedcba9876543210");
  assert.equal(span.links[0]?.attributes["kestrel.link_kind"], "replay");
  assert.equal(span.events[0]?.correlation?.eventSequence, 7);
});

test("RuntimeSpanV1 fails closed on missing attributes, sensitive capture, and invalid lifecycle", () => {
  const base = {
    version: RUNTIME_SPAN_VERSION,
    context: rootContext,
    links: [],
    name: "model.call",
    kind: "model",
    startedAt: "2026-08-04T12:00:00.000Z",
    endedAt: "2026-08-04T12:00:01.000Z",
    status: "ok",
    attributes: {
      "kestrel.provider_id": "openai",
      "kestrel.model_id": "gpt-5",
      "kestrel.retry_attempt": 1,
      "kestrel.latency_ms": 1000,
      "kestrel.input_tokens": 10,
      "kestrel.output_tokens": 20,
      "kestrel.result": "completed",
    },
    events: [],
  };
  assert.equal(parseRuntimeSpanV1(base).kind, "model");
  const { endedAt: _endedAt, ...activeBase } = base;
  const active = parseRuntimeSpanV1({
    ...activeBase,
    status: "active",
    attributes: {
      "kestrel.provider_id": "openai",
      "kestrel.model_id": "gpt-5",
      "kestrel.retry_attempt": 1,
    },
  });
  assert.equal(active.status, "active");
  assert.throws(
    () => parseRuntimeSpanV1({ ...base, attributes: { ...base.attributes, "kestrel.prompt": "secret" } }),
    /forbidden sensitive key/u,
  );
  assert.throws(
    () => parseRuntimeSpanV1({ ...base, attributes: { ...base.attributes, "kestrel.actor_name": "Taylor" } }),
    /forbidden sensitive key/u,
  );
  const { "kestrel.output_tokens": _omitted, ...missingUsage } = base.attributes;
  assert.throws(
    () => parseRuntimeSpanV1({ ...base, attributes: missingUsage }),
    /requires attribute 'kestrel.output_tokens'/u,
  );
  assert.throws(
    () => parseRuntimeSpanV1({ ...base, status: "active" }),
    /active runtime span cannot have endedAt/u,
  );
  for (const [key, value, expected] of [
    ["kestrel.retry_attempt", "first", /retry_attempt.*non-negative safe integer/u],
    ["kestrel.retry_attempt", -1, /retry_attempt.*non-negative safe integer/u],
    ["kestrel.latency_ms", -0.1, /latency_ms.*non-negative finite number/u],
    ["kestrel.input_tokens", 1.5, /input_tokens.*non-negative safe integer/u],
    ["kestrel.output_tokens", -1, /output_tokens.*non-negative safe integer/u],
  ] as const) {
    assert.throws(
      () => parseRuntimeSpanV1({
        ...base,
        attributes: { ...base.attributes, [key]: value },
      }),
      expected,
    );
  }
});
