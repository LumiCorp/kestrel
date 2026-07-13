import assert from "node:assert/strict";
import http from "node:http";
import test, { type TestContext } from "node:test";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  createRunnerServiceHttpHandler,
  createRunnerServiceServer,
} from "../../cli/runner/RunnerService.js";
import type { RunnerServiceEventJournal } from "../../cli/runner/RunnerServiceEventJournal.js";
import type { RunnerRuntime } from "../../cli/runner/RunnerHost.js";
import {
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
  RUNNER_HEALTH_VERSION,
} from "../../packages/protocol/src/index.js";

const profile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

const actorMetadata = {
  actor: {
    actorId: "web-demo-user",
    actorType: "end_user" as const,
    displayName: "Web Demo User",
    tenantId: "internal",
  },
  tenantId: "internal",
};

test("shared runner service handler mounts under a prefix and reports active executions", async (t) => {
  let resolveRunEntered: (() => void) | undefined;
  const runEntered = new Promise<void>((resolve) => {
    resolveRunEntered = resolve;
  });
  let resolveRun: (() => void) | undefined;
  const finishRun = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  const handler = createRunnerServiceHttpHandler({
    pathPrefix: "/runtime/v2/",
    runtimeFactory: () => ({
      runTurn: async () => {
        resolveRunEntered?.();
        await finishRun;
        return {
          assistantText: "done",
          output: {
            status: "COMPLETED",
            sessionId: "session-shared-handler",
            runId: "run-shared-handler",
            errors: [],
            quality: {
              citationCoverage: 1,
              unresolvedClaims: 0,
              reworkRate: 0,
              thrashIndex: 0,
            },
            telemetry: {
              stepsExecuted: 1,
              toolCalls: 0,
              modelCalls: 0,
              durationMs: 1,
            },
          },
        };
      },
      close: async () => {},
    }),
  });
  const mounted = await mountRunnerHandlerOrSkip(t, handler.handle);
  if (mounted === undefined) {
    await handler.close();
    return;
  }

  try {
    await handler.ready();
    assert.equal(handler.hasActiveExecutions(), false);

    const rootHealth = await fetch(`${mounted.url}/health`);
    assert.equal(rootHealth.status, 404);
    const prefixedHealth = await fetch(`${mounted.url}/runtime/v2/health`);
    assert.equal(prefixedHealth.status, 200);

    const commandResponsePromise = fetch(`${mounted.url}/runtime/v2/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-shared-handler",
        type: "run.start",
        metadata: {
          ...actorMetadata,
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-shared-handler",
            runId: "run-shared-handler",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });

    await runEntered;
    assert.equal(handler.hasActiveExecutions(), true);
    resolveRun?.();

    const commandResponse = await commandResponsePromise;
    assert.equal(commandResponse.status, 200);
    assert.match(await commandResponse.text(), /"type":"run\.completed"/);
    assert.equal(handler.hasActiveExecutions(), false);
  } finally {
    resolveRun?.();
    await handler.close();
    await closeHttpServer(mounted.server);
  }
});

test("shared runner service close waits for aborted execution cleanup", async (t) => {
  let markRunEntered: (() => void) | undefined;
  const runEntered = new Promise<void>((resolve) => {
    markRunEntered = resolve;
  });
  let markAbortObserved: (() => void) | undefined;
  const abortObserved = new Promise<void>((resolve) => {
    markAbortObserved = resolve;
  });
  let releaseExecutionCleanup: (() => void) | undefined;
  const executionCleanup = new Promise<void>((resolve) => {
    releaseExecutionCleanup = resolve;
  });
  let runtimeCloseCalled = false;
  const handler = createRunnerServiceHttpHandler({
    runtimeFactory: () => ({
      runTurn: async (_turn, options) => {
        markRunEntered?.();
        const signal = options?.signal;
        assert.ok(signal);
        if (signal.aborted === false) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        markAbortObserved?.();
        await executionCleanup;
        throw new Error("execution aborted");
      },
      close: async () => {
        runtimeCloseCalled = true;
      },
    }),
  });
  const mounted = await mountRunnerHandlerOrSkip(t, handler.handle);
  if (mounted === undefined) {
    await handler.close();
    return;
  }

  try {
    const responsePromise = fetch(`${mounted.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-close-waits",
        type: "run.start",
        metadata: {
          ...actorMetadata,
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-close-waits",
            runId: "run-close-waits",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });
    await runEntered;

    let closeSettled = false;
    const closePromise = handler.close({ abortActiveRuns: true }).then(() => {
      closeSettled = true;
    });
    await abortObserved;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runtimeCloseCalled, false);
    assert.equal(closeSettled, false);

    releaseExecutionCleanup?.();
    await closePromise;
    assert.equal(runtimeCloseCalled, true);
    assert.equal(closeSettled, true);
    assert.equal(handler.hasActiveExecutions(), false);

    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"type":"run\.cancelled"/);
  } finally {
    releaseExecutionCleanup?.();
    await handler.close();
    await closeHttpServer(mounted.server);
  }
});

test("shared runner service drains unary runtime commands and rejects new work during close", async (t) => {
  let markStatusEntered: (() => void) | undefined;
  const statusEntered = new Promise<void>((resolve) => {
    markStatusEntered = resolve;
  });
  let releaseStatus: (() => void) | undefined;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  let runtimeCloseCalled = false;
  const handler = createRunnerServiceHttpHandler({
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      getToolRuntimeStatus: async () => {
        markStatusEntered?.();
        await statusGate;
        return {
          healthy: true,
          checkedAt: new Date().toISOString(),
          providers: {},
        };
      },
      close: async () => {
        runtimeCloseCalled = true;
      },
    }),
  });
  const mounted = await mountRunnerHandlerOrSkip(t, handler.handle);
  if (mounted === undefined) {
    await handler.close();
    return;
  }

  try {
    const statusResponsePromise = fetch(`${mounted.url}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-unary-close-barrier",
        type: "mcp.status",
        metadata: actorMetadata,
        payload: { profile },
      }),
    });
    await statusEntered;
    assert.equal(handler.hasActiveExecutions(), true);

    let closeSettled = false;
    const closePromise = handler.close({ abortActiveRuns: false }).then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);
    assert.equal(runtimeCloseCalled, false);

    const rejectedResponse = await fetch(`${mounted.url}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "cmd-rejected-during-close",
        type: "runner.ping",
        metadata: actorMetadata,
        payload: { nonce: "closing" },
      }),
    });
    assert.equal(rejectedResponse.status, 400);
    assert.match(await rejectedResponse.text(), /closing and cannot accept new commands/u);

    releaseStatus?.();
    const statusResponse = await statusResponsePromise;
    assert.equal(statusResponse.status, 200);
    assert.match(await statusResponse.text(), /"type":"mcp\.status"/u);
    await closePromise;
    assert.equal(closeSettled, true);
    assert.equal(runtimeCloseCalled, true);
    assert.equal(handler.hasActiveExecutions(), false);
  } finally {
    releaseStatus?.();
    await handler.close();
    await closeHttpServer(mounted.server);
  }
});

test("shared runner service aborts durable replay when its client disconnects", async (t) => {
  let markReplayStarted: (() => void) | undefined;
  const replayStarted = new Promise<void>((resolve) => {
    markReplayStarted = resolve;
  });
  let markReplayAborted: (() => void) | undefined;
  const replayAborted = new Promise<void>((resolve) => {
    markReplayAborted = resolve;
  });
  const journal: RunnerServiceEventJournal = {
    ready() {},
    append() {},
    async replayAfter(_sinceEventId, _filter, _onEvent, options) {
      markReplayStarted?.();
      options?.onReplayBoundary?.();
      if (options?.signal?.aborted !== true) {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      markReplayAborted?.();
      return { status: "cancelled" };
    },
  };
  const handler = createRunnerServiceHttpHandler({ eventJournal: journal });
  const mounted = await mountRunnerHandlerOrSkip(t, handler.handle);
  if (mounted === undefined) {
    await handler.close();
    return;
  }

  try {
    const controller = new AbortController();
    const responsePromise = fetch(`${mounted.url}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filter: {
          runId: "run-disconnected-replay",
          sinceEventId: "event-disconnected-replay",
        },
        metadata: actorMetadata,
      }),
      signal: controller.signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await replayStarted;
    controller.abort();
    await replayAborted;
    const responseError = await responsePromise;
    assert.ok(responseError instanceof Error);
    assert.equal(responseError.name, "AbortError");
  } finally {
    await handler.close();
    await closeHttpServer(mounted.server);
  }
});

test("runner service http exposes health and enforces auth and actor metadata", async (t) => {
  const server = await createHttpServerOrSkip(t, {
    authToken: "secret-token",
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  if (server === undefined) {
    return;
  }

  try {
    const healthResponse = await fetch(`${server.url}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      version: RUNNER_HEALTH_VERSION,
      ok: true,
      service: {
        name: "kestrel-runner",
        version: "0.5.1",
      },
      contracts: {
        command: RUNNER_COMMAND_CONTRACT_VERSION,
        events: RUNNER_EVENT_CONTRACT_VERSION,
      },
      capabilities: [
        "events.subscribe",
        "mcp.refresh",
        "operator.control",
        "operator.inspect",
        "profile.read",
        "project.manage",
        "run.cancel",
        "run.resume",
        "run.stream",
        "session.read",
        "task.graph",
        "workspace.checkpoint",
      ],
    });

    const unauthorizedResponse = await fetch(`${server.url}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-unauthorized",
        type: "runner.ping",
        metadata: actorMetadata,
        payload: {
          nonce: "ok",
        },
      }),
    });
    const unauthorizedEvent = (await unauthorizedResponse.json()) as {
      type: string;
      payload: { message: string };
    };
    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(unauthorizedEvent.type, "runner.error");
    assert.match(unauthorizedEvent.payload.message, /authorization is required/i);

    const missingActorResponse = await fetch(`${server.url}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-missing-actor",
        type: "runner.ping",
        payload: {
          nonce: "ok",
        },
      }),
    });
    const missingActorEvent = (await missingActorResponse.json()) as {
      type: string;
      payload: { message: string };
    };
    assert.equal(missingActorResponse.status, 400);
    assert.equal(missingActorEvent.type, "runner.error");
    assert.match(missingActorEvent.payload.message, /actor metadata is required/i);
  } finally {
    await server.close();
  }
});

test("runner service http serves unary commands over /commands", async (t) => {
  const server = await createHttpServerOrSkip(t, {
    authToken: "secret-token",
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  if (server === undefined) {
    return;
  }

  try {
    const response = await fetch(`${server.url}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-ping",
        type: "runner.ping",
        metadata: actorMetadata,
        payload: {
          nonce: "ok",
        },
      }),
    });

    const event = (await response.json()) as {
      type: string;
      payload: { nonce?: string | undefined };
    };
    assert.equal(response.status, 200);
    assert.equal(event.type, "runner.pong");
    assert.equal(event.payload.nonce, "ok");
  } finally {
    await server.close();
  }
});

test("runner service http streams run.start over /commands/stream", async (t) => {
  const runtimeFactory = (): RunnerRuntime => ({
    runTurn: async () => ({
      assistantText: null,
      output: {
        status: "COMPLETED",
        sessionId: "session-http",
        runId: "run-http",
        quality: {
          citationCoverage: 1,
          unresolvedClaims: 0,
          reworkRate: 0,
          thrashIndex: 0,
        },
        errors: [],
        telemetry: {
          stepsExecuted: 1,
          toolCalls: 0,
          modelCalls: 0,
          durationMs: 1,
        },
      },
    }),
    close: async () => {},
  });

  const server = await createHttpServerOrSkip(t, {
    authToken: "secret-token",
    runtimeFactory: () => runtimeFactory(),
  });

  if (server === undefined) {
    return;
  }

  try {
    const response = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-run-http",
        type: "run.start",
        metadata: {
          ...actorMetadata,
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-http",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });

    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i);
    assert.match(body, /event: run\.started/);
    assert.match(body, /event: run\.completed/);
    assert.match(body, /"sessionId":"session-http"/);
    assert.match(body, /"runId":"run-http"/);
  } finally {
    await server.close();
  }
});

test("runner service http exposes OpenAI-compatible models and chat streaming", async (t) => {
  let progressListener: ((update: import("../../src/index.js").ProgressUpdateV1) => void) | undefined;
  const server = await createHttpServerOrSkip(t, {
    authToken: "secret-token",
    runtimeFactory: (_profile, _onRunLog, onProgress) => {
      progressListener = onProgress;
      return {
        runTurn: async (input) => {
          progressListener?.({
            version: "v1",
            runId: "run-compat-http",
            sessionId: input.sessionId,
            ts: new Date().toISOString(),
            seq: 1,
            kind: "tool",
            phase: "agent",
            code: "TOOL_CALL_STARTED",
            message: "Calling tool 'internet.search'.",
            tool: {
              name: "internet.search",
              status: "STARTED",
            },
            persist: true,
            toolInput: {
              q: "compat mode",
            },
          } as import("../../src/index.js").ProgressUpdateV1 & { toolInput: Record<string, unknown> });
          return {
            assistantText: "Compatibility HTTP hello",
            output: {
              status: "COMPLETED",
              sessionId: input.sessionId,
              runId: "run-compat-http",
              errors: [],
              quality: {
                citationCoverage: 1,
                unresolvedClaims: 0,
                reworkRate: 0,
                thrashIndex: 0,
              },
              telemetry: {
                stepsExecuted: 1,
                toolCalls: 1,
                modelCalls: 1,
                durationMs: 1,
              },
            },
            finalizedPayload: {
              message: "Compatibility HTTP hello",
            },
          };
        },
        close: async () => {},
      };
    },
  });

  if (server === undefined) {
    return;
  }

  try {
    const modelsResponse = await fetch(`${server.url}/v1/models`, {
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    const models = (await modelsResponse.json()) as { data: Array<{ id: string }> };
    assert.equal(modelsResponse.status, 200);
    assert.equal(models.data[0]?.id, "reference-react");

    const completionResponse = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        model: "reference-react",
        stream: true,
        messages: [
          {
            role: "user",
            content: "hello",
          },
        ],
      }),
    });

    const body = await completionResponse.text();
    assert.equal(completionResponse.status, 200);
    assert.match(completionResponse.headers.get("content-type") ?? "", /text\/event-stream/i);
    assert.match(body, /chat\.completion\.chunk/);
    assert.match(body, /internet\.search/);
    assert.match(body, /Compatibility HTTP hello/);
    assert.match(body, /\[DONE\]/);
  } finally {
    await server.close();
  }
});

test("runner service http cancels OpenAI-compatible streaming runs when the client disconnects", async (t) => {
  let resolveRunTurnEntered: (() => void) | undefined;
  const runTurnEntered = new Promise<void>((resolve) => {
    resolveRunTurnEntered = resolve;
  });
  let resolveAborted: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  const server = await createHttpServerOrSkip(t, {
    authToken: "secret-token",
    runtimeFactory: (): RunnerRuntime => ({
      runTurn: async (_input, options) => {
        resolveRunTurnEntered?.();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            resolveAborted?.();
            resolve();
          }, { once: true });
        });
        throw Object.assign(new Error("cancelled"), { code: "RUN_CANCELLED" });
      },
      close: async () => {},
    }),
  });

  if (server === undefined) {
    return;
  }

  try {
    const controller = new AbortController();
    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        model: "reference-react",
        stream: true,
        messages: [
          {
            role: "user",
            content: "hello",
          },
        ],
      }),
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    await runTurnEntered;
    void response.body?.cancel();
    controller.abort();

    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for OpenAI-compatible stream cancellation")), 2000);
      }),
    ]);
  } finally {
    await server.close();
  }
});

test("runner service http tolerates OpenAI-compatible disconnect after progress has started", async (t) => {
  let progressListener: ((update: import("../../src/index.js").ProgressUpdateV1) => void) | undefined;
  let resolveRunTurnEntered: (() => void) | undefined;
  const runTurnEntered = new Promise<void>((resolve) => {
    resolveRunTurnEntered = resolve;
  });
  let resolveAborted: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  const server = await createHttpServerOrSkip(t, {
    authToken: "secret-token",
    runtimeFactory: (_profile, _onRunLog, onProgress): RunnerRuntime => {
      progressListener = onProgress;
      return {
        runTurn: async (input, options) => {
          resolveRunTurnEntered?.();
          progressListener?.({
            version: "v1",
            runId: "run-compat-disconnect",
            sessionId: input.sessionId,
            ts: new Date().toISOString(),
            seq: 1,
            kind: "tool",
            phase: "agent",
            code: "TOOL_CALL_STARTED",
            message: "Calling tool 'internet.search'.",
            tool: {
              name: "internet.search",
              status: "STARTED",
            },
            persist: true,
          });
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => {
              resolveAborted?.();
              resolve();
            }, { once: true });
          });
          throw Object.assign(new Error("cancelled"), { code: "RUN_CANCELLED" });
        },
        close: async () => {},
      };
    },
  });

  if (server === undefined) {
    return;
  }

  try {
    const controller = new AbortController();
    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        model: "reference-react",
        stream: true,
        messages: [
          {
            role: "user",
            content: "hello",
          },
        ],
      }),
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    await runTurnEntered;
    await reader?.read();
    void reader?.cancel();
    controller.abort();

    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for post-progress OpenAI-compatible stream cancellation")), 2000);
      }),
    ]);
  } finally {
    await server.close();
  }
});

async function createHttpServerOrSkip(
  context: TestContext | undefined,
  options: Parameters<typeof createRunnerServiceServer>[0],
) {
  try {
    return await createRunnerServiceServer(options);
  } catch (error) {
    if (isListenPermissionError(error)) {
      context?.skip("sandbox denied localhost listener setup for runner-service HTTP smoke test");
      return undefined;
    }
    throw error;
  }
}

function isListenPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "EPERM" &&
    /listen/i.test(error.message)
  );
}

async function mountRunnerHandlerOrSkip(
  context: TestContext,
  handler: http.RequestListener,
): Promise<{ server: http.Server; url: string } | undefined> {
  const server = http.createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (isListenPermissionError(error)) {
      context.skip("sandbox denied localhost listener setup for shared runner-service handler test");
      return undefined;
    }
    throw error;
  }
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections?.();
  });
}
