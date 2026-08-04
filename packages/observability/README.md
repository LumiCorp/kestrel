# @kestrel-agents/observability

Tracing and observability helpers for Kestrel-backed agent clients.

This package exposes a Kestrel-native trace model and an OpenTelemetry export
bridge. It adds application-facing traces around SDK activity without making
OTEL the primary Kestrel contract.

The core model includes:

- `Trace`
- `RunTrace`
- `Span`
- `TraceEvent`

It also includes an OTEL export path for teams that need to forward traces into existing telemetry pipelines.

## What This Package Is For

Use it when you want to:

- wrap an SDK agent with trace capture
- process traces in memory or with custom exporters
- convert Kestrel-native traces into OpenTelemetry-compatible spans

It is not the runtime's internal observability system. It is the application-facing package for traced SDK usage.

## Install

```bash
pnpm add @kestrel-agents/observability@0.7.0 \
  @kestrel-agents/sdk@0.7.0
```

Check [0.7 release status](../../apps/docs/content/start/release-status.mdx)
before pinning a production dependency.

## Create a Tracer

```ts
import { createTracer, InMemoryTraceProcessor } from "@kestrel-agents/observability";

const tracer = createTracer({
  processors: [new InMemoryTraceProcessor()],
});
```

## Wrap an Agent

```ts
import { createAgent } from "@kestrel-agents/sdk";

const agent = createAgent({
  id: "support-agent",
  profileId: "reference",
  target: {
    kind: "remote",
    baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL!,
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN!,
  },
});

const tracedAgent = tracer.wrapAgent(agent);
```

The tracer wraps SDK calls and emits Kestrel-native trace objects through the configured processors.

## Create Nested Spans

Use `startTrace` when application code needs explicit parent, child, or linked
span structure. Span kinds require their documented identity and outcome
attributes before settlement.

```ts
const trace = tracer.startTrace({
  agentId: "support-agent",
  profileId: "reference",
  name: "agent.run",
  kind: "run",
  attributes: {
    "kestrel.agent_id": "support-agent",
    "kestrel.profile_id": "reference",
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
    "kestrel.latency_ms": 100,
    "kestrel.input_tokens": 10,
    "kestrel.output_tokens": 5,
    "kestrel.result": "completed",
  },
});

model.end();
trace.end();
await tracer.flush();
```

The `continue` relationship preserves a validated persisted trace identity for
resume. The `replay` and `fork` relationships always create a new trace linked
to the source context.

Prompt, response, tool-payload, credential, secret, and PII-shaped attributes
are omitted by default. Processor and exporter failures are reported through
the optional `onExportError` callback and never change agent behavior.

## Export to OTEL-Compatible Pipelines

```ts
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createTracer } from "@kestrel-agents/observability";
import { OpenTelemetryTraceExporter } from "@kestrel-agents/observability/otel";

const exporter = new InMemorySpanExporter();

const tracer = createTracer({
  exporters: [new OpenTelemetryTraceExporter(exporter)],
});
```

## Related Docs

- [SDK README](https://github.com/LumiCorp/kestrel/blob/main/packages/sdk/README.md)
- [Observability guide](../../apps/docs/content/build/adding-observability.mdx)
- [Root README](https://github.com/LumiCorp/kestrel/blob/main/README.md)
