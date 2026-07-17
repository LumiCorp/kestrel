import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createRunnerServiceServer } from "../../../cli/runner/RunnerService.js";
import {
  createProfileProvider,
  createSdkE2eRuntimeFactory,
  packPackage,
  runChildProcess,
  writePnpmWorkspaceOverrides,
} from "./helpers.js";

test("installed observability package exports OTLP spans through local Jaeger", async (t) => {
  const server = await createRunnerServiceServer({
    profileProvider: createProfileProvider(),
    runtimeFactory: createSdkE2eRuntimeFactory(),
  });
  t.after(async () => {
    await server.close();
  });

  const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-otel-pack-"));
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-otel-fixture-"));
  const storeDir = path.join(os.tmpdir(), "kestrel-otel-pnpm-store");
  const serviceName = `kestrel-sdk-e2e-${Date.now()}`;
  const successSessionId = `otel-success-${Date.now()}`;
  const cancelledSessionId = `otel-cancelled-${Date.now()}`;
  t.after(() => {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const jaegerQueryUrl = process.env.JAEGER_QUERY_URL ?? "http://127.0.0.1:16686";
  const jaegerAvailable = await isJaegerAvailable(jaegerQueryUrl);
  if (jaegerAvailable === false) {
    t.skip(`Jaeger query API is unreachable at ${jaegerQueryUrl}.`);
    return;
  }

  const protocolTarball = packPackage(path.join(process.cwd(), "packages/protocol"), packDir);
  const sdkTarball = packPackage(path.join(process.cwd(), "packages/sdk"), packDir);
  const observabilityTarball = packPackage(path.join(process.cwd(), "packages/observability"), packDir);

  writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({
    name: "kestrel-otel-fixture",
    private: true,
    type: "module",
    packageManager: "pnpm@9.12.2",
    pnpm: {
      overrides: {
        "@kestrel-agents/protocol": protocolTarball,
        "@kestrel-agents/sdk": sdkTarball,
      },
    },
  }, null, 2));
  writePnpmWorkspaceOverrides(fixtureDir, {
    "@kestrel-agents/protocol": protocolTarball,
    "@kestrel-agents/sdk": sdkTarball,
  });

  execFileSync("pnpm", ["add", "--workspace-root", protocolTarball, sdkTarball, observabilityTarball, "@opentelemetry/exporter-trace-otlp-http"], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      npm_config_store_dir: storeDir,
    },
    stdio: "pipe",
  });

  writeFileSync(path.join(fixtureDir, "consumer.mjs"), `
import { createAgent } from "@kestrel-agents/sdk";
import { createTracer } from "@kestrel-agents/observability";
import { OpenTelemetryTraceExporter } from "@kestrel-agents/observability/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const agent = createAgent({
  id: "otel-fixture-agent",
  profileId: "reference",
  target: { kind: "remote", baseUrl: process.env.RUNNER_URL },
});

const otlpExporter = new OTLPTraceExporter({
  url: process.env.OTEL_ENDPOINT,
});
const kestrelExporter = new OpenTelemetryTraceExporter(otlpExporter, {
  serviceName: process.env.OTEL_SERVICE_NAME,
});
const tracer = createTracer({
  exporters: [kestrelExporter],
});
const tracedAgent = tracer.wrapAgent(agent);
const context = {
  actor: {
    actorId: "otel-fixture-user",
    actorType: "end_user",
    tenantId: "acme",
  },
  tenantId: "acme",
};

await tracedAgent.run({
  sessionId: process.env.SUCCESS_SESSION_ID,
  message: "hello from otel fixture",
}, context);

const stream = tracedAgent.stream({
  sessionId: process.env.CANCELLED_SESSION_ID,
  message: "cancel me",
}, context);
const iterator = stream[Symbol.asyncIterator]();
await iterator.next();
await stream.cancel();
await stream.result;

await tracer.flush();
await kestrelExporter.forceFlush();
await kestrelExporter.shutdown();
await agent.close();
process.exit(0);
`);

  await runChildProcess(process.execPath, ["consumer.mjs"], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      RUNNER_URL: server.url,
      OTEL_ENDPOINT: `${process.env.JAEGER_OTLP_HTTP_URL ?? "http://127.0.0.1:4318"}/v1/traces`,
      OTEL_SERVICE_NAME: serviceName,
      SUCCESS_SESSION_ID: successSessionId,
      CANCELLED_SESSION_ID: cancelledSessionId,
    },
  });

  const traces = await waitForJaegerTraces(
    jaegerQueryUrl,
    serviceName,
    2,
  );
  const successSpan = findSpanBySessionId(traces, successSessionId);
  const cancelledSpan = findSpanBySessionId(traces, cancelledSessionId);
  const successTags = normalizeTags(successSpan?.tags);
  const cancelledTags = normalizeTags(cancelledSpan?.tags);

  assert.equal(successTags["kestrel.outcome"], "ok");
  assert.equal(cancelledTags["kestrel.outcome"], "cancelled");
  assert.notEqual(cancelledTags["otel.status_code"], "OK", "cancelled Jaeger spans must not look successful");
});

async function isJaegerAvailable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${baseUrl}/api/services`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function waitForJaegerTraces(
  baseUrl: string,
  serviceName: string,
  minimumCount: number,
): Promise<JaegerTrace[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/traces?service=${encodeURIComponent(serviceName)}&lookback=1h&limit=20`,
    );
    assert.equal(response.ok, true, `Jaeger trace query failed with status ${response.status}.`);
    const body = await response.json() as { data?: JaegerTrace[] };
    const traces = Array.isArray(body.data) ? body.data : [];
    const spans = traces.flatMap((trace) => trace.spans);
    if (spans.length >= minimumCount) {
      return traces;
    }
    await delay(500);
  }
  assert.fail(`Expected at least ${minimumCount} Jaeger spans for service ${serviceName}.`);
}

function findSpanBySessionId(
  traces: JaegerTrace[],
  sessionId: string,
): JaegerSpan | undefined {
  return traces
    .flatMap((trace) => trace.spans)
    .find((span) => normalizeTags(span.tags)["kestrel.session_id"] === sessionId);
}

interface JaegerTrace {
  spans: JaegerSpan[];
}

interface JaegerSpan {
  tags: unknown;
}

function normalizeTags(tags: unknown): Record<string, unknown> {
  if (Array.isArray(tags) === false) {
    return {};
  }
  return Object.fromEntries(tags.flatMap((tag) => {
    if (typeof tag !== "object" || tag === null) {
      return [];
    }
    const key = (tag as { key?: unknown }).key;
    if (typeof key !== "string") {
      return [];
    }
    return [[key, (tag as { value?: unknown }).value]];
  }));
}
