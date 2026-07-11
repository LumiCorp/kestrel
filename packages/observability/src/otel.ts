import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMATTRS_ENDUSER_ID, SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import type {
  KestrelTraceAttributes,
  KestrelTraceExporter,
  KestrelTracePrimitive,
  RunTrace,
  Span,
  TraceEvent,
} from "./tracer.js";

export interface OpenTelemetryTraceExporterOptions {
  serviceName?: string | undefined;
  resourceAttributes?: Record<string, KestrelTracePrimitive | undefined> | undefined;
  instrumentationScopeName?: string | undefined;
  instrumentationScopeVersion?: string | undefined;
}

export class OpenTelemetryTraceExporter implements KestrelTraceExporter {
  private readonly exporter: SpanExporter;
  private readonly resource: ReturnType<typeof resourceFromAttributes>;
  private readonly instrumentationScope: ReadableSpan["instrumentationScope"];

  constructor(exporter: SpanExporter, options: OpenTelemetryTraceExporterOptions = {}) {
    this.exporter = exporter;
    this.resource = resourceFromAttributes(compactAttributes({
      [SEMRESATTRS_SERVICE_NAME]: options.serviceName ?? "kestrel-agent",
      ...(options.resourceAttributes ?? {}),
    }));
    this.instrumentationScope = {
      name: options.instrumentationScopeName ?? "@kestrel-agents/observability",
      ...(options.instrumentationScopeVersion !== undefined
        ? { version: options.instrumentationScopeVersion }
        : {}),
    };
  }

  async export(traces: RunTrace[]): Promise<void> {
    const spans = traces.flatMap((trace) => trace.spans.map((span) => toReadableSpan(trace, span, this.resource, this.instrumentationScope)));
    if (spans.length === 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.exporter.export(spans, (result) => {
        if (result.error !== undefined) {
          reject(result.error);
          return;
        }
        resolve();
      });
    });
  }

  async forceFlush(): Promise<void> {
    if (typeof this.exporter.forceFlush === "function") {
      await this.exporter.forceFlush();
    }
  }

  async shutdown(): Promise<void> {
    await this.exporter.shutdown();
  }
}

function toReadableSpan(
  trace: RunTrace,
  span: Span,
  resource: ReturnType<typeof resourceFromAttributes>,
  instrumentationScope: ReadableSpan["instrumentationScope"],
): ReadableSpan {
  const traceId = toTraceId(span.traceId);
  const spanId = toSpanId(span.spanId);
  const parentSpanId = span.parentSpanId !== undefined ? toSpanId(span.parentSpanId) : undefined;
  const startTime = toHrTime(span.startedAt);
  const endTime = toHrTime(span.endedAt ?? trace.endedAt ?? span.startedAt);
  const duration = diffHrTime(startTime, endTime);

  return {
    name: span.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
    }),
    ...(parentSpanId !== undefined
      ? {
          parentSpanContext: {
            traceId,
            spanId: parentSpanId,
            traceFlags: TraceFlags.SAMPLED,
          },
        }
      : {}),
    startTime,
    endTime,
    status: {
      code:
        span.status === "error"
          ? SpanStatusCode.ERROR
          : span.status === "cancelled"
            ? SpanStatusCode.UNSET
            : SpanStatusCode.OK,
    },
    attributes: compactAttributes({
      ...trace.metadata,
      ...span.attributes,
      "kestrel.outcome": span.status,
      [SEMATTRS_ENDUSER_ID]:
        typeof trace.metadata["kestrel.actor_id"] === "string"
          ? trace.metadata["kestrel.actor_id"]
          : undefined,
      "kestrel.agent_id": trace.agentId,
      "kestrel.profile_id": trace.profileId,
      ...(trace.sessionId !== undefined ? { "kestrel.session_id": trace.sessionId } : {}),
      ...(trace.threadId !== undefined ? { "kestrel.thread_id": trace.threadId } : {}),
      ...(trace.runId !== undefined ? { "kestrel.run_id": trace.runId } : {}),
    }),
    links: [],
    events: span.events.map((event) => toReadableEvent(event)),
    duration,
    ended: true,
    resource,
    instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function toReadableEvent(event: TraceEvent): ReadableSpan["events"][number] {
  return {
    name: event.name,
    time: toHrTime(event.ts),
    ...(event.attributes !== undefined ? { attributes: compactAttributes(event.attributes) } : {}),
    droppedAttributesCount: 0,
  };
}

function toTraceId(value: string): string {
  const normalized = value.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  return normalized.length === 32 ? normalized : normalized.padEnd(32, "0").slice(0, 32);
}

function toSpanId(value: string): string {
  const normalized = value.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  return normalized.length >= 16 ? normalized.slice(0, 16) : normalized.padEnd(16, "0");
}

function toHrTime(value: string): [number, number] {
  const millis = Date.parse(value);
  const seconds = Math.floor(millis / 1000);
  const nanos = Math.max(0, millis - seconds * 1000) * 1_000_000;
  return [seconds, nanos];
}

function diffHrTime(startTime: [number, number], endTime: [number, number]): [number, number] {
  let seconds = endTime[0] - startTime[0];
  let nanos = endTime[1] - startTime[1];
  if (nanos < 0) {
    seconds -= 1;
    nanos += 1_000_000_000;
  }
  return [Math.max(0, seconds), Math.max(0, nanos)];
}

function compactAttributes(
  attributes: Record<string, KestrelTracePrimitive | undefined>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [[key, value]];
      }
      return [];
    }),
  );
}
