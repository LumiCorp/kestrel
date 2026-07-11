import assert from "node:assert/strict";
import test from "node:test";

import type { TuiProfile } from "../../cli/contracts.js";
import type { DelegationTaskUpdate } from "../../cli/runtime/KestrelChatRuntime.js";
import { createInMemoryRunnerService, createRunnerServiceServer } from "../../cli/runner/RunnerService.js";
import type { RunnerRuntime } from "../../cli/runner/RunnerHost.js";
import type { ProgressUpdateV1, ReasoningUpdateV1, RunLogEntry } from "../../src/index.js";

const profile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

async function readStreamBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  timeoutMessage: string,
): Promise<string> {
  assert.ok(reader);
  const chunk = await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), 5000);
    }),
  ]);
  return new TextDecoder().decode(chunk.value);
}

test("runner service requires actor metadata", async () => {
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-1",
        type: "runner.ping",
        payload: {
          nonce: "ok",
        },
      }),
    });

    const event = JSON.parse(response.body) as { type: string; payload: { message: string } };
    assert.equal(response.statusCode, 400);
    assert.equal(event.type, "runner.error");
    assert.match(event.payload.message, /actor metadata is required/i);
  } finally {
    await service.close();
  }
});

test("runner service enforces bearer auth when configured", async () => {
  const service = createInMemoryRunnerService({
    authToken: "secret-token",
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-2",
        type: "runner.ping",
        metadata: {
          actor: {
            actorId: "alice",
            actorType: "operator",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
        payload: {
          nonce: "ok",
        },
      }),
    });

    const event = JSON.parse(response.body) as { type: string; payload: { message: string } };
    assert.equal(response.statusCode, 401);
    assert.equal(event.type, "runner.error");
    assert.match(event.payload.message, /authorization is required/i);
  } finally {
    await service.close();
  }
});

test("runner service rejects malformed actor metadata with a structured error", async () => {
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-invalid-actor",
        type: "runner.ping",
        metadata: {
          actor: {
            actorId: 123,
            actorType: "end_user",
          },
        },
        payload: {
          nonce: "ok",
        },
      }),
    });

    const event = JSON.parse(response.body) as { type: string; payload: { message: string } };
    assert.equal(response.statusCode, 400);
    assert.equal(event.type, "runner.error");
    assert.match(event.payload.message, /requires actorId/i);
  } finally {
    await service.close();
  }
});

test("runner service exposes profiles and resolves profileId for run.start", async () => {
  let capturedProfileId: string | undefined;
  const service = createInMemoryRunnerService({
    profileProvider: {
      async listProfiles() {
        return [profile];
      },
      async getProfile(profileId) {
        return profileId === profile.id ? profile : undefined;
      },
    },
    runtimeFactory: (resolvedProfile) => ({
      runTurn: async () => {
        capturedProfileId = resolvedProfile.id;
        return {
          output: {
            status: "COMPLETED",
            sessionId: "session-profile-id",
            runId: "run-profile-id",
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

  try {
    const metadata = {
      actor: {
        actorId: "alice",
        actorType: "operator" as const,
      },
    };

    const listed = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-profile-list",
        type: "profile.list",
        metadata,
        payload: {},
      }),
    });
    const listedEvent = JSON.parse(listed.body) as {
      type: string;
      payload: { profiles: Array<{ id: string }> };
    };
    assert.equal(listed.statusCode, 200);
    assert.equal(listedEvent.type, "profile.listed");
    assert.deepEqual(listedEvent.payload.profiles.map((item) => item.id), ["reference"]);

    const runResponse = await service.dispatch({
      method: "POST",
      url: "/commands/stream",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "cmd-run-profile-id",
        type: "run.start",
        metadata,
        payload: {
          profileId: "reference",
          turn: {
            sessionId: "session-profile-id",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });
    assert.equal(runResponse.statusCode, 200);
    assert.match(runResponse.body, /event: run\.completed/);
    assert.equal(capturedProfileId, "reference");
  } finally {
    await service.close();
  }
});

test("runner service streams run events and preserves issuedBy for operator actions", async () => {
  let logListener: ((entry: RunLogEntry) => void) | undefined;
  let progressListener: ((update: ProgressUpdateV1) => void) | undefined;
  let reasoningListener: ((update: ReasoningUpdateV1) => void) | undefined;
  let taskUpdateListener: ((update: DelegationTaskUpdate) => void) | undefined;
  let capturedIssuedBy: string | undefined;

  const runtimeFactory = (): RunnerRuntime => ({
    runTurn: async () => {
      taskUpdateListener?.({
        kind: "waiting",
        task: {
          taskId: "task-1",
          parentSessionId: "session-1",
          title: "Wait for operator input",
          status: "WAITING",
          childSessionId: "child-session-1",
          childSessionName: "Child Session",
          profileId: "reference",
          provider: "openrouter",
          model: "openai/gpt-5.4",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      logListener?.({
        runId: "run-123",
        sessionId: "session-1",
        eventName: "step_started",
        level: "INFO",
      });
      progressListener?.({
        version: "v1",
        runId: "run-123",
        sessionId: "session-1",
        ts: new Date().toISOString(),
        seq: 1,
        kind: "stage",
        phase: "engine",
        code: "RUN_STARTED",
        message: "Run started.",
        persist: true,
      });
      reasoningListener?.({
        version: "v1",
        runId: "run-123",
        sessionId: "session-1",
        ts: new Date().toISOString(),
        seq: 1,
        milestone: "phase_changed",
        message: "Reasoning in progress.",
      });
      return {
        output: {
          status: "COMPLETED",
          sessionId: "session-1",
          runId: "run-123",
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
    performOperatorAction: async (input) => {
      capturedIssuedBy = input.issuedBy;
      return {
        threadId: input.threadId,
      };
    },
    close: async () => {},
  });

  const service = createInMemoryRunnerService({
    authToken: "secret-token",
    runtimeFactory: (_profile, onRunLog, onProgress, _onConsole, onReasoning, onTaskUpdate) => {
      logListener = onRunLog;
      progressListener = onProgress;
      reasoningListener = onReasoning;
      taskUpdateListener = onTaskUpdate;
      return runtimeFactory();
    },
  });

  try {
    const metadata = {
      actor: {
        actorId: "alice",
        actorType: "operator",
        displayName: "Alice",
        tenantId: "internal",
      },
      tenantId: "internal",
    };

    const runResponse = await service.dispatch({
      method: "POST",
      url: "/commands/stream",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-run-1",
        type: "run.start",
        metadata: {
          ...metadata,
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-1",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });

    const sseBody = runResponse.body;
    assert.equal(runResponse.statusCode, 200);
    assert.match(sseBody, /"type":"run\.started"/);
    assert.match(sseBody, /"type":"run\.completed"/);
    assert.doesNotMatch(sseBody, /"type":"task\.updated"/);
    assert.match(sseBody, /"sessionId":"session-1"/);

    const controlResponse = await service.dispatch({
      method: "POST",
      url: "/commands",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-control-1",
        type: "operator.control",
        metadata: {
          ...metadata,
          profile,
        },
        payload: {
          action: "retry",
          threadId: "thread-1",
        },
      }),
    });

    const controlEvent = JSON.parse(controlResponse.body) as { type: string };
    assert.equal(controlEvent.type, "operator.controlled");
    assert.equal(capturedIssuedBy, "Alice");
  } finally {
    await service.close();
  }
});

test("in-memory runner service cancels active runs when a streaming dispatch is aborted", async () => {
  let aborted = false;
  let resolveRunTurnEntered: (() => void) | undefined;
  const runTurnEntered = new Promise<void>((resolve) => {
    resolveRunTurnEntered = resolve;
  });
  let resolveAborted: (() => void) | undefined;
  const abortedPromise = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async (_input, options) => {
        resolveRunTurnEntered?.();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            resolveAborted?.();
            resolve();
          }, { once: true });
        });
        throw Object.assign(new Error("cancelled"), { code: "RUN_CANCELLED" });
      },
      close: async () => {},
    }),
  });

  try {
    const metadata = {
      actor: {
        actorId: "alice",
        actorType: "operator" as const,
        tenantId: "internal",
      },
      tenantId: "internal",
    };
    const controller = new AbortController();
    const responsePromise = service.dispatch({
      method: "POST",
      url: "/commands/stream",
      headers: {
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        id: "cmd-in-memory-stream-disconnect",
        type: "run.start",
        metadata,
        payload: {
          profile,
          turn: {
            sessionId: "session-in-memory-disconnect",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });

    await runTurnEntered;
    controller.abort();
    await Promise.race([
      abortedPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for in-memory run cancellation")), 2000);
      }),
    ]);

    const response = await responsePromise;
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: run\.cancelled/);
    assert.doesNotMatch(response.body, /event: run\.failed/);
    assert.equal(aborted, true);
  } finally {
    await service.close();
  }
});

test("in-memory runner service resolves cleanly when a streaming dispatch is already aborted before start", async () => {
  let runTurnCalled = false;
  const service = createInMemoryRunnerService({
    runtimeFactory: () => ({
      runTurn: async () => {
        runTurnCalled = true;
        throw new Error("should not run");
      },
      close: async () => {},
    }),
  });

  try {
    const metadata = {
      actor: {
        actorId: "alice",
        actorType: "operator" as const,
        tenantId: "internal",
      },
      tenantId: "internal",
    };
    const controller = new AbortController();
    controller.abort();

    const response = await Promise.race([
      service.dispatch({
        method: "POST",
        url: "/commands/stream",
        headers: {
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          id: "cmd-in-memory-stream-pre-aborted",
          type: "run.start",
          metadata,
          payload: {
            profile,
            turn: {
              sessionId: "session-pre-aborted",
              message: "hello",
              eventType: "user.message",
            },
          },
        }),
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for pre-aborted in-memory dispatch")), 2000);
      }),
    ]);

    assert.equal(response.statusCode, 200);
    assert.equal(runTurnCalled, false);
    assert.equal(response.body, "");
  } finally {
    await service.close();
  }
});

test("runner service streams filtered subscription events over /events/stream", async () => {
  const server = await createRunnerServiceServer({
    runtimeFactory: (_profile, _onRunLog, _onProgress, _onConsole, _onReasoning, onTaskUpdate) => ({
      runTurn: async () => {
        onTaskUpdate({
          kind: "waiting",
          task: {
            taskId: "task-subscribe-1",
            parentSessionId: "session-subscribe",
            title: "Wait for operator input",
            status: "WAITING",
            childSessionId: "child-session-1",
            childSessionName: "Child Session",
            profileId: "reference",
            provider: "openrouter",
            model: "openai/gpt-5.4",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
        return {
          output: {
            status: "COMPLETED",
            sessionId: "session-subscribe",
            runId: "run-subscribe",
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

  try {
    const subscription = await fetch(`${server.url}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filter: {
          sessionId: "session-subscribe",
          eventTypes: ["task.updated"],
        },
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
      }),
    });

    assert.equal(subscription.status, 200);
    const reader = subscription.body?.getReader();

    const commandResponse = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-run-subscribe",
        type: "run.start",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-subscribe",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });
    assert.equal(commandResponse.status, 200);

    const firstChunk = await Promise.race([
      reader?.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for durable start event")), 2000);
      }),
    ]);
    const body = new TextDecoder().decode(firstChunk?.value);
    assert.match(body, /"type":"task\.updated"/);
    assert.match(body, /"sessionId":"session-subscribe"/);

    await reader?.cancel();
    await commandResponse.text();
  } finally {
    await server.close();
  }
});

test("runner service cancels active runs when a stream disconnects", async () => {
  let aborted = false;
  let resolveRunTurnEntered: (() => void) | undefined;
  const runTurnEntered = new Promise<void>((resolve) => {
    resolveRunTurnEntered = resolve;
  });
  let resolveAborted: (() => void) | undefined;
  const abortedPromise = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  const server = await createRunnerServiceServer({
    runtimeFactory: () => ({
      runTurn: async (_input, options) => {
        resolveRunTurnEntered?.();
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            aborted = true;
            resolveAborted?.();
            resolve();
          };
          options?.signal?.addEventListener("abort", onAbort, { once: true });
        });
        return {
          output: {
            status: "COMPLETED",
            sessionId: "session-disconnect",
            runId: "run-disconnect",
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

  try {
    const controller = new AbortController();
    const response = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-stream-disconnect",
        type: "run.start",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-disconnect",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    await runTurnEntered;
    await reader?.read();
    await reader?.cancel();
    controller.abort();

    await Promise.race([
      abortedPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for run cancellation")), 2000);
      }),
    ]);

    assert.equal(aborted, true);
  } finally {
    await server.close();
  }
});

test("runner service keeps durable runs active when a stream disconnects", async () => {
  let aborted = false;
  let resolveRunTurnEntered: (() => void) | undefined;
  const runTurnEntered = new Promise<void>((resolve) => {
    resolveRunTurnEntered = resolve;
  });
  let resolveRunTurn: (() => void) | undefined;
  const finishRunTurn = new Promise<void>((resolve) => {
    resolveRunTurn = resolve;
  });

  const server = await createRunnerServiceServer({
    runtimeFactory: () => ({
      runTurn: async (_input, options) => {
        resolveRunTurnEntered?.();
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          resolveRunTurn?.();
        }, { once: true });
        await finishRunTurn;
        return {
          output: {
            status: "COMPLETED",
            sessionId: "session-durable-disconnect",
            runId: "run-durable-disconnect",
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

  try {
    const controller = new AbortController();
    const response = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-durable-disconnect",
        type: "run.start",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
          durability: "continue_on_disconnect",
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-durable-disconnect",
            runId: "run-durable-disconnect",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    await runTurnEntered;
    const firstChunk = await Promise.race([
      reader?.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for durable start event")), 2000);
      }),
    ]);
    const firstBody = new TextDecoder().decode(firstChunk?.value);
    assert.match(firstBody, /"runId":"run-durable-disconnect"/);
    await reader?.cancel();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(aborted, false);

    const replay = await fetch(`${server.url}/events/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filter: {
          runId: "run-durable-disconnect",
          sinceEventId: "missing-cursor",
        },
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
      }),
    });
    assert.equal(replay.status, 200);
    const replayReader = replay.body?.getReader();
    const replayStartedBody = await readStreamBodyChunk(
      replayReader,
      "timed out waiting for replayed durable start event",
    );
    assert.match(replayStartedBody, /"type":"run\.started"/);
    assert.match(replayStartedBody, /"runId":"run-durable-disconnect"/);

    resolveRunTurn?.();
    const replayCompletedBody = await readStreamBodyChunk(
      replayReader,
      "timed out waiting for durable completion event",
    );
    assert.match(replayCompletedBody, /"type":"run\.completed"/);
    assert.match(replayCompletedBody, /"runId":"run-durable-disconnect"/);
    await replayReader?.cancel();
  } finally {
    await server.close();
  }
});

test("runner service emits run.cancelled on the original stream after run.cancel", async () => {
  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });

  const server = await createRunnerServiceServer({
    runtimeFactory: () => ({
      runTurn: async (_input, options) => {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            resolveAbort?.();
            resolve();
          }, { once: true });
        });
        throw Object.assign(new Error("cancelled"), { code: "RUN_ABORTED" });
      },
      close: async () => {},
    }),
  });

  try {
    const streamResponse = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-run-cancelled",
        type: "run.start",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-cancelled",
            message: "hello",
            eventType: "user.message",
          },
        },
      }),
    });
    assert.equal(streamResponse.status, 200);

    const cancelResponse = await fetch(`${server.url}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        id: "cmd-run-cancel",
        type: "run.cancel",
        metadata: {
          actor: {
            actorId: "web-user-1",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
        payload: {
          sessionId: "session-cancelled",
        },
      }),
    });
    assert.equal(cancelResponse.status, 200);

    await aborted;
    const body = await streamResponse.text();
    assert.match(body, /"type":"run\.cancelled"/);
    assert.doesNotMatch(body, /"type":"run\.failed"/);
  } finally {
    await server.close();
  }
});
