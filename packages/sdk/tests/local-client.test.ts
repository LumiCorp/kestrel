import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRunnerHealthV1,
  KestrelClient,
  KestrelConfigurationError,
  KestrelProtocolError,
  type KestrelClientOptions,
  type RunnerEvent,
} from "../src/runner.js";
import { resolveClientTarget } from "../src/internal/clientTarget.js";

const context = {
  actor: {
    actorId: "local-sdk-user",
    actorType: "end_user" as const,
  },
  durability: "continue_on_disconnect" as const,
};

test("KestrelClient dispatches unary, run-stream, and subscription traffic over Local Core", async (t) => {
  const requests: Array<{
    path: string;
    authorization: string | undefined;
    body: Record<string, unknown> | undefined;
  }> = [];
  const { socketPath, close } = await startLocalCoreServer(async (request, response) => {
    const body = request.method === "POST"
      ? JSON.parse(await readRequestBody(request)) as Record<string, unknown>
      : undefined;
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      body,
    });

    if (request.url === "/runtime/v2/health") {
      sendJson(response, createRunnerHealthV1({ serviceVersion: "0.6.0" }));
      return;
    }
    if (request.url === "/runtime/v2/commands") {
      assert.equal(body?.type, "operator.control");
      sendJson(response, {
        id: "evt-local-controlled",
        type: "operator.controlled",
        ts: new Date().toISOString(),
        commandId: body.id,
        threadId: "thread-local",
        payload: {
          threadId: "thread-local",
          result: {
            assistantText: "  Approved locally.  ",
            finalizedPayload: null,
            output: {
              status: "COMPLETED",
              sessionId: "session-local",
              runId: "run-control-local",
              errors: [],
            },
          },
        },
      });
      return;
    }
    if (request.url === "/runtime/v2/commands/stream") {
      if (body?.type === "job.run") {
        const replay = {
          version: "job_replay_pointer_v1",
          sessionId: "session-local-job",
          threadId: "thread-local-job",
          runId: "run-local-job",
          replayQuery: {
            runId: "run-local-job",
            sessionId: "session-local-job",
            threadId: "thread-local-job",
          },
          commands: {
            replay: "replay",
            doctor: "doctor",
            bundle: "bundle",
          },
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(toSse("job.completed", {
          id: "evt-local-job-completed",
          type: "job.completed",
          ts: new Date().toISOString(),
          commandId: body.id,
          sessionId: replay.sessionId,
          threadId: replay.threadId,
          runId: replay.runId,
          payload: {
            output: {
              version: "job_run_result_v1",
              sessionId: replay.sessionId,
              threadId: replay.threadId,
              runId: replay.runId,
              status: "COMPLETED",
              replay,
              result: {
                assistantText: "Local job completed.",
                finalizedPayload: null,
                output: {
                  status: "COMPLETED",
                  sessionId: replay.sessionId,
                  runId: replay.runId,
                  errors: [],
                },
              },
            },
            replay,
          },
        }));
        return;
      }
      assert.equal(body?.type, "run.start");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(toSse("run.started", {
        id: "evt-local-started",
        type: "run.started",
        ts: new Date().toISOString(),
        commandId: body.id,
        sessionId: "session-local",
        payload: {
          sessionId: "session-local",
          eventType: "user.message",
        },
      }));
      response.end(toSse("run.completed", {
        id: "evt-local-completed",
        type: "run.completed",
        ts: new Date().toISOString(),
        commandId: body.id,
        sessionId: "session-local",
        runId: "run-local",
        payload: {
          result: {
            assistantText: "  Deployment completed.  ",
            finalizedPayload: {
              deploymentId: "deployment-local",
              regions: ["iad1"],
            },
            output: {
              status: "COMPLETED",
              sessionId: "session-local",
              runId: "run-local",
              errors: [],
            },
          },
        },
      }));
      return;
    }
    if (request.url === "/runtime/v2/events/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(toSse("run.completed", {
        id: "evt-local-subscribed",
        type: "run.completed",
        ts: new Date().toISOString(),
        sessionId: "session-local",
        runId: "run-subscribed-local",
        payload: {
          result: {
            assistantText: "  Subscription completed.  ",
            output: {
              status: "COMPLETED",
              sessionId: "session-local",
              runId: "run-subscribed-local",
              errors: [],
            },
          },
        },
      }));
      return;
    }

    response.writeHead(404).end();
  });
  t.after(close);

  const client = new KestrelClient({
    target: {
      kind: "local",
      socketPath,
      authToken: "local-bearer-token",
    },
  });
  t.after(async () => client.close());

  const health = await client.getHealth();
  assert.equal(health.service.version, "0.6.0");

  const controlled = await client.controlOperator(
    { action: "reply", threadId: "thread-local", message: "approve" },
    context,
  );
  assert.equal(controlled.result?.assistantText, "Approved locally.");
  assert.equal(controlled.result?.finalizedPayload, null);

  const stream = client.streamRun(
    {
      profileId: "reference",
      turn: {
        sessionId: "session-local",
        message: "deploy",
        eventType: "user.message",
      },
    },
    context,
  );
  const streamedTypes: string[] = [];
  for await (const event of stream) {
    streamedTypes.push(event.type);
  }
  const terminal = await stream.result;
  assert.deepEqual(streamedTypes, ["run.started", "run.completed"]);
  assert.equal(terminal.type, "run.completed");
  assert.equal(terminal.payload.result.assistantText, "Deployment completed.");
  assert.deepEqual(terminal.payload.result.finalizedPayload, {
    deploymentId: "deployment-local",
    regions: ["iad1"],
  });

  const job = await client.runJob({
    profileId: "reference",
    input: {
      version: "job_input_v1",
      turn: {
        sessionId: "session-local-job",
        message: "run local job",
        eventType: "job.run",
      },
    },
  }, context);
  assert.equal(job.type, "job.completed");

  const subscription = client.subscribe({
    sessionId: "session-local",
    sinceEventId: "evt-local-started",
  }, context);
  const subscribed: RunnerEvent[] = [];
  for await (const event of subscription) {
    subscribed.push(event);
  }
  await subscription.result;
  assert.equal(subscribed[0]?.type, "run.completed");
  if (subscribed[0]?.type === "run.completed") {
    assert.equal(subscribed[0].payload.result.assistantText, "Subscription completed.");
  }

  assert.deepEqual(requests.map((request) => request.path), [
    "/runtime/v2/health",
    "/runtime/v2/commands",
    "/runtime/v2/commands/stream",
    "/runtime/v2/commands/stream",
    "/runtime/v2/events/stream",
  ]);
  assert.equal(
    requests.every((request) => request.authorization === "Bearer local-bearer-token"),
    true,
  );
  assert.equal(
    ((requests[4]?.body?.metadata as { actor?: { actorId?: string } } | undefined)?.actor?.actorId),
    "local-sdk-user",
  );
  assert.equal(
    (requests[4]?.body?.filter as { sinceEventId?: string } | undefined)?.sinceEventId,
    "evt-local-started",
  );
  assert.equal(
    (requests[2]?.body?.metadata as { durability?: string } | undefined)?.durability,
    "continue_on_disconnect",
  );
});

test("KestrelClient supports the preferred explicit remote target", async () => {
  let requestedUrl = "";
  const client = new KestrelClient({
    target: {
      kind: "remote",
      baseUrl: "http://runner.internal",
      authToken: "remote-token",
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer remote-token");
        const command = JSON.parse(String(init?.body)) as { id: string };
        return Response.json({
          id: "evt-pong",
          type: "runner.pong",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: { nonce: "explicit-remote" },
        });
      },
    },
  });

  assert.equal((await client.ping({}, context)).nonce, "explicit-remote");
  assert.equal(requestedUrl, "http://runner.internal/commands");
  await client.close();
});

test("KestrelClient cancellation closes local subscriptions without rejecting the result", async (t) => {
  let resolveClosed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const { socketPath, close } = await startLocalCoreServer(async (request, response) => {
    assert.equal(request.url, "/runtime/v2/events/stream");
    await readRequestBody(request);
    response.once("close", resolveClosed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(toSse("task.updated", {
      id: "evt-local-task-updated",
      type: "task.updated",
      ts: new Date().toISOString(),
      sessionId: "session-local",
      payload: {
        task: { taskId: "task-local" },
        kind: "waiting",
        assistantText: null,
      },
    }));
  });
  t.after(close);

  const client = new KestrelClient({
    target: {
      kind: "local",
      socketPath,
      authToken: "local-bearer-token",
    },
  });
  t.after(async () => client.close());

  const stream = client.subscribe({ sessionId: "session-local" }, context);
  const first = await stream[Symbol.asyncIterator]().next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, "task.updated");

  await stream.cancel();
  await stream.result;
  await connectionClosed;
});

test("KestrelClient can close immediately after a completed local run stream", async (t) => {
  let markConnectionClosed: (() => void) | undefined;
  const connectionClosed = new Promise<void>((resolve) => {
    markConnectionClosed = resolve;
  });
  const { socketPath, close } = await startLocalCoreServer(async (request, response) => {
    assert.equal(request.url, "/runtime/v2/commands/stream");
    const command = JSON.parse(await readRequestBody(request)) as { id: string };
    response.once("close", () => markConnectionClosed?.());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(toSse("run.completed", {
      id: "evt-local-immediate-close",
      type: "run.completed",
      ts: new Date().toISOString(),
      commandId: command.id,
      sessionId: "session-local-immediate-close",
      runId: "run-local-immediate-close",
      payload: {
        result: {
          assistantText: "Completed before close.",
          finalizedPayload: null,
          output: {
            status: "COMPLETED",
            sessionId: "session-local-immediate-close",
            runId: "run-local-immediate-close",
            errors: [],
          },
        },
      },
    }));
  });
  t.after(close);

  const client = new KestrelClient({
    target: {
      kind: "local",
      socketPath,
      authToken: "local-bearer-token",
    },
  });
  t.after(async () => client.close());

  const stream = client.streamRun({
    profileId: "reference",
    turn: {
      sessionId: "session-local-immediate-close",
      message: "complete and close",
      eventType: "user.message",
    },
  }, context);
  for await (const _event of stream) {
    // Drain through the terminal event before closing the client.
  }
  const terminal = await stream.result;
  assert.equal(terminal.type, "run.completed");

  await client.close();
  await connectionClosed;
});

test("KestrelClient rejects a local run stream that ends before a terminal event", async (t) => {
  const { socketPath, close } = await startLocalCoreServer(async (request, response) => {
    assert.equal(request.url, "/runtime/v2/commands/stream");
    const command = JSON.parse(await readRequestBody(request)) as { id: string };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(toSse("run.started", {
      id: "evt-local-truncated-started",
      type: "run.started",
      ts: new Date().toISOString(),
      commandId: command.id,
      sessionId: "session-local-truncated",
      payload: {
        sessionId: "session-local-truncated",
        eventType: "user.message",
      },
    }));
  });
  t.after(close);

  const client = new KestrelClient({
    target: {
      kind: "local",
      socketPath,
      authToken: "local-bearer-token",
    },
  });
  t.after(async () => client.close());

  await assert.rejects(
    client.run({
      profileId: "reference",
      turn: {
        sessionId: "session-local-truncated",
        message: "run until disconnected",
        eventType: "user.message",
      },
    }, context),
    (error: unknown) =>
      error instanceof KestrelProtocolError &&
      error.code === "RUNNER_PROTOCOL_ERROR" &&
      /ended before a terminal event/u.test(error.message),
  );
});

test("KestrelClient rejects a local terminal SSE event without a command id", async (t) => {
  const { socketPath, close } = await startLocalCoreServer(async (request, response) => {
    assert.equal(request.url, "/runtime/v2/commands/stream");
    await readRequestBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(toSse("run.completed", {
      id: "evt-local-unscoped-terminal",
      type: "run.completed",
      ts: new Date().toISOString(),
      sessionId: "session-local-unscoped",
      runId: "run-local-unscoped",
      payload: {
        result: {
          assistantText: "Unscoped terminal.",
          finalizedPayload: null,
          output: {
            status: "COMPLETED",
            sessionId: "session-local-unscoped",
            runId: "run-local-unscoped",
            errors: [],
          },
        },
      },
    }));
  });
  t.after(close);

  const client = new KestrelClient({
    target: {
      kind: "local",
      socketPath,
      authToken: "local-bearer-token",
    },
  });
  t.after(async () => client.close());

  await assert.rejects(
    Promise.race([
      client.run({
        profileId: "reference",
        turn: {
          sessionId: "session-local-unscoped",
          message: "receive an unscoped terminal",
          eventType: "user.message",
        },
      }, context),
      rejectAfter(500, "Local unscoped-terminal request did not settle."),
    ]),
    (error: unknown) => {
      assert.ok(error instanceof KestrelProtocolError);
      assert.equal(error.code, "RUNNER_PROTOCOL_ERROR");
      assert.equal(typeof error.details?.expectedCommandId, "string");
      assert.equal(error.details?.receivedCommandId, null);
      return true;
    },
  );
});

test("KestrelClient rejects a local nonterminal SSE event for another command", async (t) => {
  const { socketPath, close } = await startLocalCoreServer(async (request, response) => {
    assert.equal(request.url, "/runtime/v2/commands/stream");
    await readRequestBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(toSse("run.started", {
      id: "evt-local-wrong-progress-command",
      type: "run.started",
      ts: new Date().toISOString(),
      commandId: "another-command",
      sessionId: "session-local-wrong-progress",
      payload: {
        sessionId: "session-local-wrong-progress",
        eventType: "user.message",
      },
    }));
  });
  t.after(close);

  const client = new KestrelClient({
    target: {
      kind: "local",
      socketPath,
      authToken: "local-bearer-token",
    },
  });
  t.after(async () => client.close());

  await assert.rejects(
    client.run({
      profileId: "reference",
      turn: {
        sessionId: "session-local-wrong-progress",
        message: "receive mismatched progress",
        eventType: "user.message",
      },
    }, context),
    (error: unknown) =>
      error instanceof KestrelProtocolError
      && error.code === "RUNNER_PROTOCOL_ERROR"
      && error.details?.receivedCommandId === "another-command",
  );
});

test("KestrelClient rejects mismatched local terminal events without cross-settling another run", async (t) => {
  let victimCommandId: string | undefined;
  let sourceCommandId: string | undefined;
  let markVictimReady!: () => void;
  const victimReady = new Promise<void>((resolve) => {
    markVictimReady = resolve;
  });
  const { socketPath, close } = await startLocalCoreServer(async (request, response) => {
    assert.equal(request.url, "/runtime/v2/commands/stream");
    const command = JSON.parse(await readRequestBody(request)) as {
      id: string;
      payload: { turn: { sessionId: string } };
    };
    if (command.payload.turn.sessionId === "session-local-victim") {
      victimCommandId = command.id;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      markVictimReady();
      return;
    }

    assert.equal(typeof victimCommandId, "string");
    sourceCommandId = command.id;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(toSse("run.completed", {
      id: "evt-local-cross-terminal",
      type: "run.completed",
      ts: new Date().toISOString(),
      commandId: victimCommandId,
      sessionId: "session-local-source",
      runId: "run-local-source",
      payload: {
        result: {
          assistantText: "Wrongly scoped terminal.",
          finalizedPayload: null,
          output: {
            status: "COMPLETED",
            sessionId: "session-local-source",
            runId: "run-local-source",
            errors: [],
          },
        },
      },
    }));
  });
  t.after(close);

  const client = new KestrelClient({
    target: {
      kind: "local",
      socketPath,
      authToken: "local-bearer-token",
    },
  });
  t.after(async () => client.close());

  const victimOutcome = client.run({
    profileId: "reference",
    turn: {
      sessionId: "session-local-victim",
      message: "wait for the correct terminal",
      eventType: "user.message",
    },
  }, context).then(
    () => ({ status: "resolved" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  await victimReady;

  await assert.rejects(
    Promise.race([
      client.run({
        profileId: "reference",
        turn: {
          sessionId: "session-local-source",
          message: "receive a mismatched terminal",
          eventType: "user.message",
        },
      }, context),
      rejectAfter(500, "Local mismatched-terminal request did not settle."),
    ]),
    (error: unknown) => {
      assert.ok(error instanceof KestrelProtocolError);
      assert.equal(error.code, "RUNNER_PROTOCOL_ERROR");
      assert.match(error.message, /unexpected command/u);
      assert.equal(error.details?.expectedCommandId, sourceCommandId);
      assert.equal(error.details?.receivedCommandId, victimCommandId);
      return true;
    },
  );
  assert.equal(
    await Promise.race([
      victimOutcome.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]),
    "pending",
  );

  await client.close();
  const closedVictim = await victimOutcome;
  assert.equal(closedVictim.status, "rejected");
});

test("local KestrelClient does not connect for an already-aborted job", async () => {
  const client = new KestrelClient({
    target: {
      kind: "local",
      socketPath: "/tmp/kestrel-sdk-pre-aborted-missing.sock",
      authToken: "local-test-token",
    },
  });
  const controller = new AbortController();
  controller.abort();
  const stream = client.streamJob({
    signal: controller.signal,
    profileId: "reference",
    input: {
      version: "job_input_v1",
      turn: {
        sessionId: "session-local-pre-aborted-job",
        message: "must not run",
      },
    },
  }, context);

  await assert.rejects(
    stream.result,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  await client.close();
});

test("local KestrelClient rejects unary responses with a mismatched command id", async (t) => {
  const { socketPath, close } = await startLocalCoreServer(async (_request, response) => {
    sendJson(response, {
      id: "evt-local-wrong-command-id",
      type: "runner.pong",
      ts: new Date().toISOString(),
      commandId: "another-command",
      payload: { nonce: "pong" },
    });
  });
  t.after(close);
  const client = new KestrelClient({
    target: {
      kind: "local",
      socketPath,
      authToken: "local-test-token",
    },
  });

  await assert.rejects(
    client.ping({ nonce: "ping" }, context),
    (error: unknown) =>
      error instanceof KestrelProtocolError &&
      error.code === "RUNNER_PROTOCOL_ERROR",
  );
  await client.close();
});

test("KestrelClient requires an explicit target and rejects local targets outside Node", () => {
  const originalRunnerUrl = process.env.KESTREL_RUNNER_SERVICE_URL;
  process.env.KESTREL_RUNNER_SERVICE_URL = "http://environment-must-not-be-used.internal";
  try {
    assert.throws(
      () => new KestrelClient({} as KestrelClientOptions),
      (error: unknown) =>
        error instanceof KestrelConfigurationError &&
        /requires an explicit local or remote target/u.test(error.message),
    );
  } finally {
    if (originalRunnerUrl === undefined) {
      delete process.env.KESTREL_RUNNER_SERVICE_URL;
    } else {
      process.env.KESTREL_RUNNER_SERVICE_URL = originalRunnerUrl;
    }
  }

  assert.throws(
    () => new KestrelClient({
      target: {
        kind: "remote",
        baseUrl: "http://runner.internal",
      },
      baseUrl: "http://legacy.internal",
    } as unknown as KestrelClientOptions),
    (error: unknown) =>
      error instanceof KestrelConfigurationError &&
      /no longer accepts top-level baseUrl/u.test(error.message),
  );

  assert.throws(
    () => resolveClientTarget(
      {
        target: {
          kind: "local",
          socketPath: "/tmp/kestrel.sock",
          authToken: "token",
        },
      },
      { isNode: false },
    ),
    (error: unknown) =>
      error instanceof KestrelConfigurationError &&
      /require a Node.js server runtime/u.test(error.message),
  );
});

async function startLocalCoreServer(
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "ksdk-"));
  const socketPath = path.join(directory, "core.sock");
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(socketPath);
  await once(server, "listening");

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function toSse(eventType: string, value: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(value)}\n\n`;
}

function rejectAfter(milliseconds: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
  });
}
