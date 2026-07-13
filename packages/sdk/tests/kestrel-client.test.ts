import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  KestrelClient,
  KestrelHttpError,
  KestrelProtocolError,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
  RUNNER_HEALTH_VERSION,
  createRunnerHealthV1,
  type RunnerProfile,
} from "../src/runner.js";
import {
  ProtocolClient,
  type ProtocolTransport,
} from "../src/internal/ProtocolClient.js";
import { RemoteRunnerTransport } from "../src/internal/RemoteRunnerTransport.js";

const profile: RunnerProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

const context = {
  actor: {
    actorId: "sdk-user",
    actorType: "end_user" as const,
    displayName: "SDK User",
    tenantId: "internal",
  },
  tenantId: "internal",
};

class ControlledProtocolTransport implements ProtocolTransport {
  private handlers?: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
  };

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
  }): void {
    this.handlers = handlers;
  }

  send(_line: string): void {}

  emit(event: Record<string, unknown>): void {
    this.handlers?.onLine(JSON.stringify(event));
  }

  async stop(): Promise<void> {}
}

function cancelledResult(sessionId: string, runId: string) {
  return {
    assistantText: null,
    output: {
      status: "FAILED",
      sessionId,
      runId,
      errors: [],
    },
  };
}

test("KestrelClient reads and validates runner health", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const client = new KestrelClient({
    baseUrl: "http://runner.internal/path?secret=value",
    authToken: "secret-token",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return Response.json(createRunnerHealthV1({ serviceVersion: "0.5.0-beta.0" }));
    },
  });

  const health = await client.getHealth();

  assert.equal(requests[0]?.url, "http://runner.internal/health");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer secret-token");
  assert.equal(health.version, RUNNER_HEALTH_VERSION);
  assert.equal(health.contracts.command, RUNNER_COMMAND_CONTRACT_VERSION);
  assert.equal(health.contracts.events, RUNNER_EVENT_CONTRACT_VERSION);
  await client.close();
});

test("KestrelClient rejects unversioned runner health", async () => {
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    fetchImpl: async () => Response.json({ ok: true }),
  });

  await assert.rejects(
    client.getHealth(),
    (error: unknown) =>
      error instanceof KestrelProtocolError && error.code === "RUNNER_HEALTH_INVALID",
  );
  await client.close();
});

test("KestrelClient lists profiles and runs using profileId", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    authToken: "secret-token",
    fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        url: String(input),
        body,
        headers: new Headers(init?.headers),
      });
      if (body.type === "profile.list") {
        return new Response(
          JSON.stringify({
            id: "evt-profile-listed",
            type: "profile.listed",
            ts: new Date().toISOString(),
            commandId: body.id,
            payload: {
              profiles: [profile],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        `event: run.started\ndata: ${JSON.stringify({
          id: "evt-run-started",
          type: "run.started",
          ts: new Date().toISOString(),
          commandId: body.id,
          sessionId: "session-sdk-1",
          payload: {
            sessionId: "session-sdk-1",
            eventType: "user.message",
          },
        })}\n\n` +
          `event: run.completed\ndata: ${JSON.stringify({
            id: "evt-run-completed",
            type: "run.completed",
            ts: new Date().toISOString(),
            commandId: body.id,
            runId: "run-sdk-1",
            sessionId: "session-sdk-1",
            payload: {
              result: {
                assistantText: null,
                output: {
                  status: "COMPLETED",
                  sessionId: "session-sdk-1",
                  runId: "run-sdk-1",
                  errors: [],
                  telemetry: {
                    stepsExecuted: 1,
                    toolCalls: 0,
                    modelCalls: 1,
                    durationMs: 1,
                  },
                },
              },
            },
          })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  const profiles = await client.listProfiles(context);
  const terminal = await client.run(
    {
      profileId: "reference",
      turn: {
        sessionId: "session-sdk-1",
        message: "hello",
        eventType: "user.message",
      },
    },
    context,
  );

  assert.deepEqual(profiles.map((item) => item.id), ["reference"]);
  assert.equal(terminal.type, "run.completed");
  assert.equal(requests[0]?.url, "http://runner.internal/commands");
  assert.equal(requests[1]?.url, "http://runner.internal/commands/stream");
  assert.equal(requests[1]?.headers.get("authorization"), "Bearer secret-token");
  assert.equal((requests[1]?.body.metadata as { actor?: { actorId?: string } })?.actor?.actorId, "sdk-user");
  assert.equal((requests[1]?.body.payload as { profileId?: string }).profileId, "reference");
  await client.close();
});

test("KestrelClient streamRun stays request-scoped", async () => {
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        `event: run.started\ndata: ${JSON.stringify({
          id: "evt-run-started",
          type: "run.started",
          ts: new Date().toISOString(),
          commandId: body.id,
          sessionId: "session-sdk-1",
          payload: {
            sessionId: "session-sdk-1",
            eventType: "user.message",
          },
        })}\n\n` +
          `event: task.updated\ndata: ${JSON.stringify({
            id: "evt-task-updated",
            type: "task.updated",
            ts: new Date().toISOString(),
            sessionId: "session-sdk-1",
            payload: {
              task: {
                taskId: "task-1",
              },
              kind: "waiting",
            },
          })}\n\n` +
          `event: run.completed\ndata: ${JSON.stringify({
            id: "evt-run-completed",
            type: "run.completed",
            ts: new Date().toISOString(),
            commandId: body.id,
            runId: "run-sdk-1",
            sessionId: "session-sdk-1",
            payload: {
              result: {
                assistantText: null,
                output: {
                  status: "COMPLETED",
                  sessionId: "session-sdk-1",
                  runId: "run-sdk-1",
                  errors: [],
                },
              },
            },
          })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  const stream = client.streamRun(
    {
      profileId: "reference",
      turn: {
        sessionId: "session-sdk-1",
        message: "hello",
        eventType: "user.message",
      },
    },
    context,
  );

  const seen: string[] = [];
  for await (const event of stream) {
    seen.push(event.type);
  }
  const terminal = await stream.result;

  assert.deepEqual(seen, ["run.started", "run.completed"]);
  assert.equal(terminal.type, "run.completed");
  await client.close();
});

test("KestrelClient exposes workspace checkpoint helpers", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return new Response(
        JSON.stringify({
          id: "evt-workspace-checkpoint",
          type: "workspace.checkpoint",
          ts: new Date().toISOString(),
          commandId: body.id,
          payload: {
            sessionId: ((body.payload as { sessionId?: string }).sessionId) ?? "session-sdk-1",
            operation: body.type === "workspace.checkpoint.diff"
              ? "diff"
              : body.type === "workspace.checkpoint.restore"
                ? "restore"
                : body.type === "workspace.checkpoint.cleanup"
                  ? "cleanup"
                : body.type === "workspace.checkpoint.list"
                  ? "list"
                  : body.type === "workspace.checkpoint.inspect"
                    ? "inspect"
                    : "capture",
            checkpoint: {
              checkpoint: {
                checkpointId: "checkpoint-1",
                sessionId: "session-sdk-1",
              },
              files: [],
            },
            checkpoints: [],
            diff: {
              diffId: "diff-1",
              sessionId: "session-sdk-1",
              files: [],
            },
            restore: {
              restoreId: "restore-1",
              sessionId: "session-sdk-1",
              checkpointId: "checkpoint-1",
              status: "COMPLETED",
            },
            cleanup: {
              cleanupId: "cleanup-1",
              sessionId: "session-sdk-1",
              trigger: "manual",
            },
            deletedCheckpoints: [],
            remainingCheckpointCount: 1,
            remainingBytes: 0,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const capture = await client.captureWorkspaceCheckpoint({ sessionId: "session-sdk-1", label: "baseline" }, context);
  const list = await client.listWorkspaceCheckpoints({ sessionId: "session-sdk-1" }, context);
  const inspect = await client.inspectWorkspaceCheckpoint({ sessionId: "session-sdk-1", checkpointId: "checkpoint-1" }, context);
  const diff = await client.diffWorkspaceCheckpoints({
    sessionId: "session-sdk-1",
    source: { workingTree: true },
    target: { gitRef: "HEAD" },
  }, context);
  const restore = await client.restoreWorkspaceCheckpoint({ sessionId: "session-sdk-1", checkpointId: "checkpoint-1" }, context);
  const cleanup = await client.cleanupWorkspaceCheckpoints({ sessionId: "session-sdk-1", reason: "trim" }, context);

  assert.equal(capture.checkpoint?.checkpoint.checkpointId, "checkpoint-1");
  assert.deepEqual(list.checkpoints, []);
  assert.equal(inspect.checkpoint?.checkpoint.checkpointId, "checkpoint-1");
  assert.equal(diff.diff?.diffId, "diff-1");
  assert.equal(restore.restore?.restoreId, "restore-1");
  assert.equal(cleanup.cleanup?.cleanupId, "cleanup-1");
  assert.deepEqual(requests.map((request) => request.type), [
    "workspace.checkpoint.capture",
    "workspace.checkpoint.list",
    "workspace.checkpoint.inspect",
    "workspace.checkpoint.diff",
    "workspace.checkpoint.restore",
    "workspace.checkpoint.cleanup",
  ]);
  await client.close();
});

test("KestrelClient cancel resolves the run stream with run.cancelled", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let runController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let runCommandId = "";
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);

      if (body.type === "run.cancel") {
        runController?.enqueue(new TextEncoder().encode(
          `event: run.cancelled\ndata: ${JSON.stringify({
            id: "evt-run-cancelled",
            type: "run.cancelled",
            ts: new Date().toISOString(),
            commandId: runCommandId,
            sessionId: "session-sdk-1",
            payload: {
              sessionId: "session-sdk-1",
              result: cancelledResult("session-sdk-1", runCommandId),
            },
          })}\n\n`,
        ));
        runController?.close();
        return new Response(
          JSON.stringify({
            id: "evt-run-cancel-command",
            type: "run.cancelled",
            ts: new Date().toISOString(),
            commandId: body.id,
            sessionId: "session-sdk-1",
            payload: {
              sessionId: "session-sdk-1",
              result: cancelledResult("session-sdk-1", runCommandId),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      runCommandId = String(body.id);
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          runController = controller;
          controller.enqueue(new TextEncoder().encode(
            `event: run.started\ndata: ${JSON.stringify({
              id: "evt-run-started",
              type: "run.started",
              ts: new Date().toISOString(),
              commandId: body.id,
              sessionId: "session-sdk-1",
              payload: {
                sessionId: "session-sdk-1",
                eventType: "user.message",
              },
            })}\n\n`,
          ));
        },
      });
      return new Response(bodyStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const stream = client.streamRun(
    {
      profileId: "reference",
      turn: {
        sessionId: "session-sdk-1",
        message: "hello",
        eventType: "user.message",
      },
    },
    context,
  );

  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, "run.started");

  await stream.cancel();
  const terminal = await stream.result;

  assert.equal(terminal.type, "run.cancelled");
  assert.equal(requests.some((request) => request.type === "run.cancel"), true);
  const cancelRequest = requests.find((request) => request.type === "run.cancel");
  assert.equal((cancelRequest?.payload as { commandId?: string } | undefined)?.commandId, runCommandId);
  await client.close();
});

test("KestrelClient cancel includes runId after the stream learns it", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let runController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let runCommandId = "";
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);

      if (body.type === "run.cancel") {
        runController?.enqueue(new TextEncoder().encode(
          `event: run.cancelled\ndata: ${JSON.stringify({
            id: "evt-run-cancelled",
            type: "run.cancelled",
            ts: new Date().toISOString(),
            commandId: runCommandId,
            runId: "run-sdk-2",
            sessionId: "session-sdk-2",
            payload: {
              sessionId: "session-sdk-2",
              runId: "run-sdk-2",
              result: cancelledResult("session-sdk-2", "run-sdk-2"),
            },
          })}\n\n`,
        ));
        runController?.close();
        return new Response(
          JSON.stringify({
            id: "evt-run-cancel-command",
            type: "run.cancelled",
            ts: new Date().toISOString(),
            commandId: body.id,
            runId: "run-sdk-2",
            sessionId: "session-sdk-2",
            payload: {
              sessionId: "session-sdk-2",
              runId: "run-sdk-2",
              result: cancelledResult("session-sdk-2", "run-sdk-2"),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      runCommandId = String(body.id);
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          runController = controller;
          controller.enqueue(new TextEncoder().encode(
            `event: run.started\ndata: ${JSON.stringify({
              id: "evt-run-started",
              type: "run.started",
              ts: new Date().toISOString(),
              commandId: body.id,
              sessionId: "session-sdk-2",
              payload: {
                sessionId: "session-sdk-2",
                eventType: "user.message",
              },
            })}\n\n` +
              `event: run.progress\ndata: ${JSON.stringify({
                id: "evt-run-progress",
                type: "run.progress",
                ts: new Date().toISOString(),
                commandId: body.id,
                runId: "run-sdk-2",
                sessionId: "session-sdk-2",
                payload: {
                  update: {
                    version: "v1",
                    runId: "run-sdk-2",
                    sessionId: "session-sdk-2",
                    ts: new Date().toISOString(),
                    seq: 1,
                    kind: "stage",
                    phase: "engine",
                    code: "RUN_ACTIVE",
                    message: "Run active.",
                    persist: true,
                  },
                },
              })}\n\n`,
          ));
        },
      });
      return new Response(bodyStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const stream = client.streamRun(
    {
      profileId: "reference",
      turn: {
        sessionId: "session-sdk-2",
        message: "hello",
        eventType: "user.message",
      },
    },
    context,
  );

  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await stream.cancel();
  const terminal = await stream.result;

  assert.equal(terminal.type, "run.cancelled");
  const cancelRequest = requests.find((request) => request.type === "run.cancel");
  assert.equal((cancelRequest?.payload as { commandId?: string } | undefined)?.commandId, runCommandId);
  assert.equal((cancelRequest?.payload as { runId?: string } | undefined)?.runId, "run-sdk-2");
  await client.close();
});

test("RemoteRunnerTransport does not emit protocol errors when a local close aborts an SSE stream", async () => {
  const events: Array<{ type: string; payload?: { code?: string } }> = [];
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const signal = init?.signal;
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `event: run.started\ndata: ${JSON.stringify({
              id: "evt-run-started",
              type: "run.started",
              ts: new Date().toISOString(),
              commandId: "cmd-transport-abort",
              sessionId: "session-sdk-transport",
              payload: {
                sessionId: "session-sdk-transport",
                eventType: "user.message",
              },
            })}\n\n`,
          ));
          signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(bodyStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const client = new ProtocolClient(transport);
  client.onEvent((event) => {
    events.push(event as { type: string; payload?: { code?: string } });
  });

  const pending = client.sendCommandWithId(
    "cmd-transport-abort",
    "run.start",
    {
      profileId: "reference",
      turn: {
        sessionId: "session-sdk-transport",
        message: "hello",
        eventType: "user.message",
      },
    },
    undefined,
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.close();

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof KestrelProtocolError &&
      /closed before response/i.test(error.message),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started"],
  );
  assert.equal(
    events.some((event) => event.type === "runner.error" && event.payload?.code === "RUNNER_PROTOCOL_ERROR"),
    false,
  );
});

test("ProtocolClient rejects malformed terminal payloads without dangling requests or listeners", async () => {
  const transport = new ControlledProtocolTransport();
  const client = new ProtocolClient(transport);
  const seen: Array<{ type: string; code?: string | undefined }> = [];
  client.onEvent(() => {
    throw new Error("listener failure");
  });
  client.onEvent((event) => {
    seen.push({
      type: event.type,
      ...(event.type === "runner.error" ? { code: event.payload.code } : {}),
    });
  });
  const request = {
    profileId: "reference",
    turn: {
      sessionId: "session-sdk-invalid",
      message: "hello",
      eventType: "user.message",
    },
  };

  const malformed = client.sendCommandWithId(
    "cmd-sdk-invalid",
    "run.start",
    request,
  );
  transport.emit({
    id: "evt-sdk-invalid",
    type: "run.completed",
    ts: new Date().toISOString(),
    commandId: "cmd-sdk-invalid",
    payload: {
      result: {
        output: { status: "COMPLETED" },
      },
    },
  });

  await assert.rejects(
    malformed,
    (error: unknown) =>
      error instanceof KestrelProtocolError &&
      error.code === "RUNNER_PROTOCOL_INVALID" &&
      /assistantText is required/u.test(error.message) &&
      error.details?.eventType === "run.completed",
  );
  assert.deepEqual(seen, [{ type: "runner.error", code: "RUNNER_PROTOCOL_INVALID" }]);

  const recovered = client.sendCommandWithId(
    "cmd-sdk-invalid",
    "run.start",
    request,
  );
  transport.emit({
    id: "evt-sdk-valid",
    type: "run.completed",
    ts: new Date().toISOString(),
    commandId: "cmd-sdk-invalid",
    payload: {
      result: {
        assistantText: "done",
        output: { status: "COMPLETED" },
      },
    },
  });
  assert.equal((await recovered).type, "run.completed");

  await client.close();
  transport.emit({
    id: "evt-after-close",
    type: "runner.pong",
    ts: new Date().toISOString(),
    payload: { nonce: "after-close" },
  });
  assert.deepEqual(
    seen.map((event) => event.type),
    ["runner.error", "run.completed"],
  );
});

test("KestrelClient subscribe uses filtered SSE subscriptions", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let closed = false;
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        url: String(input),
        body,
      });
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          controller.enqueue(new TextEncoder().encode(
            `event: task.updated\ndata: ${JSON.stringify({
              id: "evt-task-updated",
              type: "task.updated",
              ts: new Date().toISOString(),
              sessionId: "session-sdk-1",
              payload: {
                task: {
                  taskId: "task-1",
                },
                kind: "waiting",
              },
            })}\n\n`,
          ));
        },
        cancel() {
          closed = true;
        },
      });
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        closed = true;
        controllerRef?.close();
      }, { once: true });
      return new Response(bodyStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const stream = client.subscribe(
    {
      sessionId: "session-sdk-1",
      eventTypes: ["task.updated"],
    },
    context,
  );

  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, "task.updated");

  await stream.cancel();
  await stream.result;

  assert.equal(requests[0]?.url, "http://runner.internal/events/stream");
  assert.deepEqual((requests[0]?.body.filter as { sessionId?: string }).sessionId, "session-sdk-1");
  assert.equal(closed, true);
  await client.close();
});

test("KestrelClient subscribe surfaces runner errors through async iteration", async () => {
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    fetchImpl: async () => new Response(
      `event: runner.error\ndata: ${JSON.stringify({
        id: "evt-runner-error",
        type: "runner.error",
        ts: new Date().toISOString(),
        payload: {
          code: "SUBSCRIPTION_DENIED",
          message: "Subscription denied.",
        },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });

  const stream = client.subscribe(
    {
      sessionId: "session-sdk-1",
    },
    context,
  );

  await assert.rejects(
    (async () => {
      for await (const _event of stream) {
        // Exhaust the stream.
      }
    })(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "SUBSCRIPTION_DENIED",
  );

  await client.close();
});

test("KestrelClient getSessionState returns an atomic session snapshot", async () => {
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.type, "session.state");
      return new Response(
        JSON.stringify({
          id: "evt-session-state",
          type: "session.state",
          ts: new Date().toISOString(),
          commandId: body.id,
          sessionId: "session-sdk-2",
          threadId: "thread-sdk-2",
          payload: {
            session: {
              sessionId: "session-sdk-2",
              version: 7,
              threadId: "thread-sdk-2",
            },
            version: 7,
            graph: {
              version: 1,
              rootTaskIds: ["task:thread:thread-sdk-2"],
              tasks: {},
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const state = await client.getSessionState("session-sdk-2", context);

  assert.equal(state.session.sessionId, "session-sdk-2");
  assert.equal(state.version, 7);
  assert.equal(state.graph.version, 1);
  await client.close();
});

test("KestrelClient preserves structured HTTP and service errors", async () => {
  const client = new KestrelClient({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.type === "profile.get" && (body.payload as { profileId?: string }).profileId === "reference") {
        return new Response("forbidden", {
          status: 403,
          headers: {
            "content-type": "text/plain",
          },
        });
      }
      return new Response(
        JSON.stringify({
          id: "evt-runner-error",
          type: "runner.error",
          ts: new Date().toISOString(),
          commandId: body.id,
          payload: {
            code: "PROFILE_NOT_FOUND",
            message: "Profile missing.",
            details: {
              profileId: "missing",
            },
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
  });

  await assert.rejects(() => client.getProfile("reference", context), (error: unknown) => {
    assert.ok(error instanceof KestrelHttpError);
    assert.equal(error.status, 403);
    assert.equal(error.body, "forbidden");
    return true;
  });

  await assert.rejects(() => client.sendCommand("profile.get", { profileId: "missing" }, context), (error: unknown) => {
    assert.equal(
      error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined,
      "PROFILE_NOT_FOUND",
    );
    return true;
  });

  await client.close();
});

test("SDK package manifest and README are publish-ready", async () => {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as {
    license?: string;
    homepage?: string;
    repository?: unknown;
    bugs?: unknown;
    keywords?: unknown;
  };
  const readme = await readFile(path.join(packageDir, "README.md"), "utf8");

  assert.equal(manifest.license, "MIT");
  assert.equal(typeof manifest.homepage, "string");
  assert.equal(typeof manifest.repository, "object");
  assert.equal(typeof manifest.bugs, "object");
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
  assert.match(readme, /pnpm add @kestrel-agents\/sdk/u);
  assert.match(readme, /npm install @kestrel-agents\/sdk/u);
  assert.match(readme, /yarn add @kestrel-agents\/sdk/u);
  assert.match(readme, /bun add @kestrel-agents\/sdk/u);
  assert.match(readme, /Browser and edge-runtime usage are not supported/u);
});
