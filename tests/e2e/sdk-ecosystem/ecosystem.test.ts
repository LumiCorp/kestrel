import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createRunnerServiceServer } from "../../../cli/runner/RunnerService.js";
import { createTracer, InMemoryTraceProcessor } from "../../../packages/observability/src/index.js";
import { OpenTelemetryTraceExporter } from "../../../packages/observability/src/otel.js";
import { createJsonRunRouteHandler, createStreamRunRouteHandler } from "../../../packages/next/src/index.js";
import { createAgent } from "../../../packages/sdk/src/index.js";
import {
  createProfileProvider,
  createSdkE2eRuntimeFactory,
  packPackage,
  runChildProcess,
  sdkE2eContext,
  sdkE2eProfile,
  writePnpmWorkspaceOverrides,
} from "./helpers.js";

const observabilityRequire = createRequire(new URL("../../../packages/observability/package.json", import.meta.url));
const { InMemorySpanExporter } = await import(
  pathToFileURL(observabilityRequire.resolve("@opentelemetry/sdk-trace-base")).href
) as {
  InMemorySpanExporter: new () => {
    export(...args: unknown[]): void;
    shutdown(...args: unknown[]): Promise<void>;
    getFinishedSpans(): Array<{ attributes: Record<string, unknown> }>;
  };
};

test("core SDK e2e covers run, resume, subscribe, cancel, and revisioned memory", async (t) => {
  const server = await createRunnerServiceServer({
    profileProvider: createProfileProvider(),
    runtimeFactory: createSdkE2eRuntimeFactory(),
  });
  t.after(async () => {
    await server.close();
  });

  const agent = createAgent({
    id: "support-agent",
    profileId: sdkE2eProfile.id,
    target: { kind: "remote", baseUrl: server.url },
  });
  t.after(async () => {
    await agent.close();
  });

  const run = await agent.run(
    {
      sessionId: "session-e2e",
      message: "hello",
    },
    sdkE2eContext,
  );
  assert.equal(run.type, "run.completed");

  const resumed = await agent.resume(
    {
      sessionId: "session-e2e",
      message: "continue",
      requestId: "request-e2e",
    },
    sdkE2eContext,
  );
  assert.equal(resumed.type, "run.completed");

  const subscription = agent.subscribe(
    {
      sessionId: "session-e2e",
      eventTypes: ["task.updated"],
    },
    sdkE2eContext,
  );
  const firstSubscriptionEvent = (async () => {
    for await (const event of subscription) {
      return event;
    }
    return ;
  })();

  await agent.run(
    {
      sessionId: "session-e2e",
      message: "emit background update",
    },
    sdkE2eContext,
  );
  const subscriptionEvent = await firstSubscriptionEvent;
  await subscription.cancel();
  assert.equal(subscriptionEvent?.type, "task.updated");
  assert.equal(subscriptionEvent?.sessionId, "session-e2e");

  const stream = agent.stream(
    {
      sessionId: "session-cancel",
      message: "cancel me",
    },
    sdkE2eContext,
  );
  const iterator = stream[Symbol.asyncIterator]();
  const started = await iterator.next();
  assert.equal(started.value?.type, "run.started");
  await stream.cancel();
  const terminal = await stream.result;
  assert.equal(terminal.type, "run.cancelled");

  const memoryBefore = await agent.session("session-memory").memory.get(sdkE2eContext);
  assert.equal(memoryBefore.revision, 1);
  assert.equal(memoryBefore.value.goal, "Ship the release");

  const memoryAfter = await agent.session("session-memory").memory.update(
    {
      expectedRevision: memoryBefore.revision,
      patch: {
        findings: "Release notes are ready.",
      },
    },
    sdkE2eContext,
  );
  assert.equal(memoryAfter.revision, 2);
  assert.equal(memoryAfter.value.findings, "Release notes are ready.");

  const session = await agent.session("session-memory").get(sdkE2eContext);
  assert.equal(session.version, 2);
  assert.equal(session.memoryRevision, 2);
  assert.equal(session.memory.findings, "Release notes are ready.");

  await assert.rejects(
    agent.session("session-memory").memory.update(
      {
        expectedRevision: memoryBefore.revision,
        patch: {
          nextAction: "Publish release",
        },
      },
      sdkE2eContext,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "SESSION_VERSION_CONFLICT",
  );
});

test("core SDK e2e isolates concurrent subscriptions and rejects stale concurrent memory writers", async (t) => {
  const server = await createRunnerServiceServer({
    profileProvider: createProfileProvider(),
    runtimeFactory: createSdkE2eRuntimeFactory(),
  });
  t.after(async () => {
    await server.close();
  });

  const agent = createAgent({
    id: "support-agent",
    profileId: sdkE2eProfile.id,
    target: { kind: "remote", baseUrl: server.url },
  });
  t.after(async () => {
    await agent.close();
  });

  const subscriptionA = agent.subscribe(
    {
      sessionId: "session-a",
      eventTypes: ["task.updated"],
    },
    sdkE2eContext,
  );
  const subscriptionB = agent.subscribe(
    {
      sessionId: "session-b",
      eventTypes: ["task.updated"],
    },
    sdkE2eContext,
  );

  const eventA = (async () => {
    for await (const event of subscriptionA) {
      return event;
    }
    return ;
  })();
  const eventB = (async () => {
    for await (const event of subscriptionB) {
      return event;
    }
    return ;
  })();

  await Promise.all([
    agent.run(
      {
        sessionId: "session-a",
        message: "update a",
      },
      sdkE2eContext,
    ),
    agent.run(
      {
        sessionId: "session-b",
        message: "update b",
      },
      sdkE2eContext,
    ),
  ]);

  const [receivedA, receivedB] = await Promise.all([eventA, eventB]);
  await Promise.all([subscriptionA.cancel(), subscriptionB.cancel()]);
  assert.equal(receivedA?.sessionId, "session-a");
  assert.equal(receivedB?.sessionId, "session-b");

  const memorySnapshot = await agent.session("session-race").memory.get(sdkE2eContext);
  const [firstUpdate, secondUpdate] = await Promise.allSettled([
    agent.session("session-race").memory.update(
      {
        expectedRevision: memorySnapshot.revision,
        patch: {
          findings: "first writer",
        },
      },
      sdkE2eContext,
    ),
    agent.session("session-race").memory.update(
      {
        expectedRevision: memorySnapshot.revision,
        patch: {
          findings: "second writer",
        },
      },
      sdkE2eContext,
    ),
  ]);

  const fulfilled = [firstUpdate, secondUpdate].filter((result) => result.status === "fulfilled");
  const rejected = [firstUpdate, secondUpdate].filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(
    rejected[0]?.status === "rejected" && rejected[0].reason instanceof Error && "code" in rejected[0].reason
      ? (rejected[0].reason as Error & { code?: string }).code
      : undefined,
    "SESSION_VERSION_CONFLICT",
  );

  const memoryAfterRace = await agent.session("session-race").memory.get(sdkE2eContext);
  assert.equal(memoryAfterRace.revision, 2);
  assert.match(memoryAfterRace.value.findings, /writer/u);
});

test("core SDK e2e stream lifecycle and subscription delivery stay consistent for the same session", async (t) => {
  const server = await createRunnerServiceServer({
    profileProvider: createProfileProvider(),
    runtimeFactory: createSdkE2eRuntimeFactory(),
  });
  t.after(async () => {
    await server.close();
  });

  const agent = createAgent({
    id: "support-agent",
    profileId: sdkE2eProfile.id,
    target: { kind: "remote", baseUrl: server.url },
  });
  t.after(async () => {
    await agent.close();
  });

  const subscription = agent.subscribe(
    {
      sessionId: "session-stream-updates",
      eventTypes: ["task.updated"],
    },
    sdkE2eContext,
  );
  const firstSubscriptionEvent = (async () => {
    for await (const event of subscription) {
      return event;
    }
    return ;
  })();

  const stream = agent.stream(
    {
      sessionId: "session-stream-updates",
      message: "emit background update",
    },
    sdkE2eContext,
  );
  const events: string[] = [];
  for await (const event of stream) {
    events.push(event.type);
    if (event.type === "run.completed" || event.type === "run.cancelled") {
      break;
    }
  }
  const terminal = await stream.result;
  const subscriptionEvent = await firstSubscriptionEvent;
  await subscription.cancel();
  await subscription.result;

  assert.equal(terminal.type, "run.completed");
  assert.equal(events.includes("run.started"), true);
  assert.equal(subscriptionEvent?.type, "task.updated");
  assert.equal(subscriptionEvent?.sessionId, "session-stream-updates");
  assert.equal(events[events.length - 1], "run.completed");
});

test("observability e2e exports native traces and real OTEL spans", async (t) => {
  const server = await createRunnerServiceServer({
    profileProvider: createProfileProvider(),
    runtimeFactory: createSdkE2eRuntimeFactory(),
  });
  t.after(async () => {
    await server.close();
  });

  const processor = new InMemoryTraceProcessor();
  const spanExporter = new InMemorySpanExporter();
  const tracer = createTracer({
    processors: [processor],
    exporters: [new OpenTelemetryTraceExporter(spanExporter)],
  });
  const agent = tracer.wrapAgent(
    createAgent({
      id: "support-agent",
      profileId: sdkE2eProfile.id,
      target: { kind: "remote", baseUrl: server.url },
    }) as unknown as Parameters<typeof tracer.wrapAgent>[0],
  );
  t.after(async () => {
    await agent.close();
  });

  const stream = agent.stream(
    {
      sessionId: "session-observed",
      message: "observe me",
    },
    sdkE2eContext,
  );
  await stream.result;
  await tracer.flush();

  assert.equal(processor.traces.length, 1);
  const trace = processor.traces[0];
  assert.ok(trace);
  assert.equal(trace.sessionId, "session-observed");
  assert.equal(trace.spans[0]?.events.filter((event) => event.name === "run.completed").length, 1);

  const spans = spanExporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.attributes["kestrel.session_id"], "session-observed");
  assert.equal(spans[0]?.attributes["enduser.id"], "sdk-e2e-user");
  assert.equal(spans[0]?.attributes["kestrel.outcome"], "ok");
});

test("next route helpers e2e preserve correlation and propagate abort cancellation", async (t) => {
  const server = await createRunnerServiceServer({
    profileProvider: createProfileProvider(),
    runtimeFactory: createSdkE2eRuntimeFactory(),
  });
  t.after(async () => {
    await server.close();
  });

  const agent = createAgent({
    id: "support-agent",
    profileId: sdkE2eProfile.id,
    target: { kind: "remote", baseUrl: server.url },
  });
  t.after(async () => {
    await agent.close();
  });

  const jsonHandler = createJsonRunRouteHandler({
    agent: agent as unknown as Parameters<typeof createJsonRunRouteHandler>[0]["agent"],
    resolveContext: () => sdkE2eContext,
  });
  const jsonResponse = await jsonHandler(new Request("http://localhost/api/agent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "req-e2e-1",
      "x-correlation-id": "corr-e2e-1",
    },
    body: JSON.stringify({
      sessionId: "session-next",
      message: "hello from next",
    }),
  }));
  assert.equal(jsonResponse.headers.get("x-kestrel-request-id"), "req-e2e-1");
  assert.equal(jsonResponse.headers.get("x-kestrel-correlation-id"), "corr-e2e-1");
  const jsonBody = await jsonResponse.json() as { type: string };
  assert.equal(jsonBody.type, "run.completed");

  const streamHandler = createStreamRunRouteHandler({
    agent: agent as unknown as Parameters<typeof createStreamRunRouteHandler>[0]["agent"],
    resolveContext: () => sdkE2eContext,
  });
  const abortController = new AbortController();
  const streamResponse = await streamHandler(new Request("http://localhost/api/agent/stream", {
    method: "POST",
    signal: abortController.signal,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "session-next-cancel",
      message: "cancel me",
    }),
  }));
  const reader = streamResponse.body?.getReader();
  assert.ok(reader, "stream response must have a readable body");

  const decoder = new TextDecoder();
  let body = "";
  const firstChunk = await reader.read();
  body += decoder.decode(firstChunk.value ?? new Uint8Array(), { stream: true });
  abortController.abort();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();

  assert.match(body, /event: run\.started/);
  assert.match(body, /event: run\.cancelled/);
});

test("packed tarball consumer fixture installs and executes real SDK behavior against the live runner service", async (t) => {
  const server = await createRunnerServiceServer({
    profileProvider: createProfileProvider(),
    runtimeFactory: createSdkE2eRuntimeFactory(),
  });
  t.after(async () => {
    await server.close();
  });

  const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-ecosystem-pack-"));
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-ecosystem-fixture-"));
  const storeDir = path.join(os.tmpdir(), "kestrel-ecosystem-pnpm-store");
  t.after(() => {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const protocolTarball = packPackage(path.join(process.cwd(), "packages/protocol"), packDir);
  const sdkTarball = packPackage(path.join(process.cwd(), "packages/sdk"), packDir);
  const observabilityTarball = packPackage(path.join(process.cwd(), "packages/observability"), packDir);
  writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({
    name: "kestrel-sdk-e2e-fixture",
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

  await runChildProcess("pnpm", ["add", "--workspace-root", protocolTarball, sdkTarball, observabilityTarball], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      npm_config_store_dir: storeDir,
    },
  });

  writeFileSync(path.join(fixtureDir, "consumer.mjs"), `
import assert from "node:assert/strict";
import { createAgent } from "@kestrel-agents/sdk";
import { createTracer, InMemoryTraceProcessor } from "@kestrel-agents/observability";
const context = {
  actor: {
    actorId: "fixture-user",
    actorType: "end_user",
    tenantId: "acme",
  },
  tenantId: "acme",
};

const agent = createAgent({
  id: "fixture-agent",
  profileId: "reference",
  target: { kind: "remote", baseUrl: process.env.RUNNER_URL },
});

const terminal = await agent.run({
  sessionId: "fixture-run",
  message: "hello from fixture",
}, context);
assert.equal(terminal.type, "run.completed");

const subscription = agent.subscribe({
  sessionId: "fixture-run",
  eventTypes: ["task.updated"],
}, context);
const firstEvent = (async () => {
  for await (const event of subscription) {
    return event;
  }
  return undefined;
})();
await agent.run({
  sessionId: "fixture-run",
  message: "emit background update",
}, context);
assert.equal((await firstEvent)?.type, "task.updated");
await subscription.cancel();
await subscription.result;

const stream = agent.stream({
  sessionId: "fixture-cancel",
  message: "cancel me",
}, context);
const iterator = stream[Symbol.asyncIterator]();
assert.equal((await iterator.next()).value?.type, "run.started");
await stream.cancel();
assert.equal((await stream.result).type, "run.cancelled");

const memoryBefore = await agent.session("fixture-memory").memory.get(context);
const memoryAfter = await agent.session("fixture-memory").memory.update({
  expectedRevision: memoryBefore.revision,
  patch: { findings: "fixture update" },
}, context);
assert.equal(memoryAfter.revision, memoryBefore.revision + 1);
await assert.rejects(
  agent.session("fixture-memory").memory.update({
    expectedRevision: memoryBefore.revision,
    patch: { findings: "stale fixture update" },
  }, context),
  (error) => error instanceof Error && "code" in error && error.code === "SESSION_VERSION_CONFLICT",
);

const processor = new InMemoryTraceProcessor();
const tracer = createTracer({
  processors: [processor],
});
const tracedAgent = tracer.wrapAgent(agent);
await tracedAgent.run({
  sessionId: "fixture-traced",
  message: "trace me",
}, context);
await tracer.flush();
assert.equal(processor.traces.length, 1);

await agent.close();
process.exit(0);
`);

  await runChildProcess(process.execPath, ["consumer.mjs"], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      RUNNER_URL: server.url,
    },
  });
});
