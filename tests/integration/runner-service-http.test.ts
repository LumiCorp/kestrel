import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { TuiProfile } from "../../cli/contracts.js";
import { createRunnerServiceServer } from "../../cli/runner/RunnerService.js";
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
