import test from "node:test";
import assert from "node:assert/strict";

import type { RunConsoleUpdateV1, RunEvent } from "../../src/kestrel/contracts/events.js";
import type { ModelRequest, ToolGateway, ToolGatewayCallOptions } from "../../src/kestrel/contracts/model-io.js";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

test("Kestrel.run invokes toolGateway.preRun on every run", async () => {
  const store = new InMemorySessionStore();
  let preRunCalls = 0;

  const toolGateway: ToolGateway = {
    call: async () => null as never,
    preRun: async () => {
      preRunCalls += 1;
    },
  };

  const kestrel = new Kestrel({
    store,
    toolGateway,
    modelGateway: new RetryingModelGateway(async <T>(_request: ModelRequest) => ({} as T)),
  });
  kestrel.registerStep("done", async () => ({
    status: "COMPLETED",
  }));

  await kestrel.run({
    id: "evt-1",
    type: "user.message",
    sessionId: "session-1",
    payload: {},
    stepAgent: "done",
  });
  await kestrel.run({
    id: "evt-2",
    type: "user.message",
    sessionId: "session-1",
    payload: {},
    stepAgent: "done",
  });

  assert.equal(preRunCalls, 2);
});

test("Kestrel.run returns FAILED with preserved preRun error code/details", async () => {
  const store = new InMemorySessionStore();
  let stepCalls = 0;

  const toolGateway: ToolGateway = {
    call: async () => null as never,
    preRun: async () => {
      const error = new Error("MCP preflight failed for server(s): remote") as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
      error.code = "MCP_PRECHECK_FAILED";
      error.details = {
        unhealthyServers: [{ serverId: "remote", error: "connection refused" }],
      };
      throw error;
    },
  };

  const kestrel = new Kestrel({
    store,
    toolGateway,
    modelGateway: new RetryingModelGateway(async <T>(_request: ModelRequest) => ({} as T)),
  });
  kestrel.registerStep("done", async () => {
    stepCalls += 1;
    return {
      status: "COMPLETED",
    };
  });

  const output = await kestrel.run({
    id: "evt-precheck-1",
    type: "user.message",
    sessionId: "session-precheck-1",
    payload: {},
    stepAgent: "done",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "MCP_PRECHECK_FAILED");
  assert.deepEqual(output.errors[0]?.details, {
    unhealthyServers: [{ serverId: "remote", error: "connection refused" }],
  });
  assert.equal(stepCalls, 0);
});

test("Kestrel tool runtime status defaults to healthy empty providers", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>(_request: ModelRequest) => ({} as T)),
  });

  const status = await kestrel.getToolRuntimeStatus();
  const refreshed = await kestrel.refreshToolRuntime();

  assert.equal(status.healthy, true);
  assert.deepEqual(status.providers, {});
  assert.equal(refreshed.healthy, true);
  assert.deepEqual(refreshed.providers, {});
});

test("Kestrel delegates tool runtime status hooks when gateway implements them", async () => {
  const store = new InMemorySessionStore();
  let getCalls = 0;
  let refreshCalls = 0;

  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
      getRuntimeStatus: async () => {
        getCalls += 1;
        return {
          healthy: true,
          checkedAt: "2026-02-27T00:00:00.000Z",
          providers: {
            mcp: { healthy: true, checkedAt: "2026-02-27T00:00:00.000Z", servers: [], tools: [] },
          },
        };
      },
      refreshRuntime: async () => {
        refreshCalls += 1;
        return {
          healthy: true,
          checkedAt: "2026-02-27T00:00:01.000Z",
          providers: {
            mcp: { healthy: true, checkedAt: "2026-02-27T00:00:01.000Z", servers: [], tools: [] },
          },
        };
      },
    },
    modelGateway: new RetryingModelGateway(async <T>(_request: ModelRequest) => ({} as T)),
  });

  const status = await kestrel.getToolRuntimeStatus();
  const refreshed = await kestrel.refreshToolRuntime();

  assert.equal(status.checkedAt, "2026-02-27T00:00:00.000Z");
  assert.equal(refreshed.checkedAt, "2026-02-27T00:00:01.000Z");
  assert.equal(getCalls, 1);
  assert.equal(refreshCalls, 1);
});

test("Kestrel rejects overlapping runs for the same session with SESSION_BUSY", async () => {
  const store = new InMemorySessionStore();
  let releaseFirstRun: (() => void) | undefined;
  let markFirstRunEntered: (() => void) | undefined;
  const firstRunEntered = new Promise<void>((resolve) => {
    markFirstRunEntered = resolve;
  });

  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>(_request: ModelRequest) => ({} as T)),
  });

  kestrel.registerStep("blocking", async () => {
    markFirstRunEntered?.();
    await new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    return {
      status: "COMPLETED",
    };
  });

  const firstRun = kestrel.run({
    id: "evt-overlap-1",
    type: "user.message",
    sessionId: "session-overlap",
    payload: {},
    stepAgent: "blocking",
  });

  await firstRunEntered;

  const secondOutput = await kestrel.run({
    id: "evt-overlap-2",
    type: "user.message",
    sessionId: "session-overlap",
    payload: {},
    stepAgent: "blocking",
  });

  assert.equal(secondOutput.status, "FAILED");
  assert.equal(secondOutput.errors[0]?.code, "SESSION_BUSY");

  releaseFirstRun?.();
  const firstOutput = await firstRun;
  assert.equal(firstOutput.status, "COMPLETED");
});

test("Kestrel returns RUN_CANCELLED when aborted during a model call", async () => {
  const store = new InMemorySessionStore();
  const controller = new AbortController();

  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(
      async <T>(_request: ModelRequest) =>
        await new Promise<T>((resolve) => {
          setTimeout(() => resolve({ ok: true } as T), 250);
        }),
      {
        retryCount: 0,
      },
    ),
  });

  kestrel.registerStep("wait-model", async (_ctx, io) => {
    await io.useModel({ model: "mock", input: { prompt: "cancel me" } });
    return {
      status: "COMPLETED",
    };
  });

  const runPromise = kestrel.run(
    {
      id: "evt-cancel-1",
      type: "user.message",
      sessionId: "session-cancel",
      payload: {},
      stepAgent: "wait-model",
    },
    {
      signal: controller.signal,
    },
  );

  setTimeout(() => controller.abort(), 20);
  const output = await runPromise;

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "RUN_CANCELLED");

  const followup = await kestrel.run({
    id: "evt-cancel-2",
    type: "user.message",
    sessionId: "session-cancel",
    payload: {},
    stepAgent: "wait-model",
  });
  assert.equal(followup.status, "COMPLETED");
});

test("Kestrel runtime IO forwards runtime budget metadata into model calls", async () => {
  const store = new InMemorySessionStore();
  const seenRequests: ModelRequest[] = [];

  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>(request: ModelRequest) => {
      seenRequests.push(structuredClone(request));
      return { ok: true } as T;
    }, {
      retryCount: 0,
    }),
  });

  kestrel.registerStep("budgeted-model", async (_ctx, io) => {
    await io.useModel({
      model: "mock-model",
      input: {
        prompt: "budget me",
      },
      metadata: {
        phase: "budgeted",
        modelRole: "decision",
      },
    });
    return {
      status: "COMPLETED",
    };
  });

  const output = await kestrel.run({
    id: "evt-budgeted-model",
    type: "user.message",
    sessionId: "session-budgeted-model",
    payload: {
      metadata: {
        externalDeadlineMs: Date.now() + 15_000,
      },
    },
    stepAgent: "budgeted-model",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(seenRequests.length, 1);
  assert.equal(typeof seenRequests[0]?.metadata?.runtimeBudgetRemainingMs, "number");
  assert.equal((seenRequests[0]?.metadata?.runtimeBudgetRemainingMs as number) > 0, true);
});

test("Kestrel runtime IO streams dev-shell console updates through the console listener", async () => {
  const store = new InMemorySessionStore();
  const consoleUpdates: RunConsoleUpdateV1[] = [];
  const runEvents: RunEvent[] = [];

  const kestrel = new Kestrel({
    store,
    consoleListener: (update) => {
      consoleUpdates.push(structuredClone(update));
    },
    runEventListener: (event) => {
      runEvents.push(structuredClone(event));
    },
    toolGateway: {
      call: async <T>(_name: string, _input: unknown, options?: ToolGatewayCallOptions) => {
        await options?.console?.({
          status: "chunk",
          channel: "stdout",
          text: "hello\n",
          byteLength: 6,
          cursor: 1,
          nextCursor: 2,
          processId: "proc-1",
          truncated: false,
        });
        return {
          status: "COMPLETED",
          text: "hello\n",
          truncated: false,
          cursor: 1,
          nextCursor: 2,
          processId: "proc-1",
          exitCode: 0,
        } as T;
      },
    },
    modelGateway: new RetryingModelGateway(async <T>(_request: ModelRequest) => ({ ok: true } as T)),
  });

  kestrel.registerStep("console-tool", async (_ctx, io) => {
    await io.useTool!("dev.process.read", {
      processId: "proc-1",
    });
    return {
      status: "COMPLETED",
    };
  });

  const output = await kestrel.run({
    id: "evt-console-tool",
    type: "user.message",
    sessionId: "session-console-tool",
    payload: {},
    stepAgent: "console-tool",
  });

  assert.equal(output.status, "COMPLETED");
  assert.deepEqual(consoleUpdates.map((update) => update.status), ["started", "chunk", "completed"]);
  assert.equal(consoleUpdates[1]?.toolName, "dev.process.read");
  assert.equal(consoleUpdates[1]?.text, "hello\n");
  assert.equal(consoleUpdates[2]?.processId, "proc-1");
  assert.equal(consoleUpdates[2]?.exitCode, 0);

  const toolEvents = runEvents.filter((event) => event.type.startsWith("run.tool."));
  assert.deepEqual(toolEvents.map((event) => event.type), ["run.tool.started", "run.tool.completed"]);
  assert.equal(toolEvents[0]?.metadata?.toolName, "dev.process.read");
  assert.equal(toolEvents[1]?.metadata?.toolName, "dev.process.read");
  assert.equal(toolEvents[1]?.metadata?.phase, "completed");
  assert.equal((toolEvents[1]?.metadata?.output as { text?: string } | undefined)?.text, "hello\n");
  assert.equal(consoleUpdates[0]?.toolCallId, toolEvents[0]?.metadata?.toolCallId);
  assert.equal(consoleUpdates[1]?.toolCallId, toolEvents[0]?.metadata?.toolCallId);
  assert.equal(consoleUpdates[2]?.toolCallId, toolEvents[0]?.metadata?.toolCallId);
});
