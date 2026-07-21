import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import { ProtocolClient } from "../../cli/client/ProtocolClient.js";
import { RemoteRunnerTransport } from "../../cli/client/RemoteRunnerTransport.js";
import type { RunnerCommand } from "../../cli/protocol/contracts.js";
import { contractTest } from "../helpers/contract-test.js";


const profile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

contractTest("runtime.hermetic", "RemoteRunnerTransport sends unary commands over HTTP with auth", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined; command: RunnerCommand }> = [];
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    authToken: "secret-token",
    fetchImpl: async (input, init) => {
      const command = JSON.parse(String(init?.body)) as RunnerCommand;
      requests.push({ url: String(input), init, command });
      return new Response(
        JSON.stringify({
          id: "evt-pong",
          type: "runner.pong",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            nonce: "ok",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });
  const client = new ProtocolClient(transport);

  const response = await client.sendCommand(
    "runner.ping",
    { nonce: "ok" },
    {
      actor: {
        actorId: "web-demo-user",
        actorType: "end_user",
        displayName: "Web Demo User",
        tenantId: "internal",
      },
      tenantId: "internal",
    },
  );

  assert.equal(response.type, "runner.pong");
  assert.equal(requests[0]?.url, "http://runner.internal/commands");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, "Bearer secret-token");
  assert.equal(requests[0]?.command.metadata?.actor?.actorId, "web-demo-user");
  await client.close();
});

contractTest("runtime.hermetic", "RemoteRunnerTransport rejects unary responses with a mismatched command id", async () => {
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    fetchImpl: async () => Response.json({
      id: "evt-wrong-command-id",
      type: "runner.pong",
      ts: new Date().toISOString(),
      commandId: "another-command",
      payload: { nonce: "ok" },
    }),
  });
  const client = new ProtocolClient(transport);

  await assert.rejects(
    client.sendCommand("runner.ping", { nonce: "ok" }),
    /unexpected command or response type/i,
  );
  await client.close();
});

contractTest("runtime.hermetic", "RemoteRunnerTransport preserves streamed runner events over SSE", async () => {
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const command = JSON.parse(String(init?.body)) as RunnerCommand;
      const started = {
        id: "evt-started",
        type: "run.started",
        ts: new Date().toISOString(),
        commandId: command.id,
        payload: {
          sessionId: "session-1",
          eventType: "user.message",
        },
      };
      const completed = {
        id: "evt-completed",
        type: "run.completed",
        ts: new Date().toISOString(),
        commandId: command.id,
        runId: "run-1",
        payload: {
          result: {
            assistantText: "Remote runner completed.",
            output: {
              status: "COMPLETED",
              sessionId: "session-1",
              runId: "run-1",
              errors: [],
              telemetry: {
                stepsExecuted: 1,
                toolCalls: 0,
                modelCalls: 0,
                durationMs: 1,
              },
            },
          },
        },
      };
      return new Response(
        `event: run.started\ndata: ${JSON.stringify(started)}\n\n` +
          `event: run.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      );
    },
  });
  const client = new ProtocolClient(transport);
  const seen: string[] = [];
  const unsubscribe = client.onEvent((event) => {
    seen.push(event.type);
  });

  const response = await client.sendCommandWithId(
    "cmd-run-1",
    "run.start",
    {
      profile,
      turn: {
        sessionId: "session-1",
        message: "hello",
        eventType: "user.message",
      },
    },
    {
      actor: {
        actorId: "web-demo-user",
        actorType: "end_user",
        tenantId: "internal",
      },
      tenantId: "internal",
    },
  );

  assert.equal(response.type, "run.completed");
  assert.deepEqual(seen, ["run.started", "run.completed"]);
  unsubscribe();
  await client.close();
});

contractTest("runtime.hermetic", "RemoteRunnerTransport rejects nonterminal SSE events for another command", async () => {
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    fetchImpl: async () => new Response(
      `event: run.started\ndata: ${JSON.stringify({
        id: "evt-wrong-progress-command",
        type: "run.started",
        ts: new Date().toISOString(),
        commandId: "another-command",
        payload: {
          sessionId: "session-wrong-progress",
          eventType: "user.message",
        },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });
  const client = new ProtocolClient(transport);

  await assert.rejects(
    client.sendCommandWithId("cmd-wrong-progress", "run.start", {
      profile,
      turn: {
        sessionId: "session-wrong-progress",
        message: "receive mismatched progress",
        eventType: "user.message",
      },
    }),
    /unexpected command or response type/i,
  );
  await client.close();
});

contractTest("runtime.hermetic", "RemoteRunnerTransport routes job.run through the canonical streaming endpoint", async () => {
  const requests: Array<{ url: string; accept: string | undefined; command: RunnerCommand }> = [];
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal/",
    fetchImpl: async (input, init) => {
      const command = JSON.parse(String(init?.body)) as RunnerCommand;
      requests.push({
        url: String(input),
        accept: (init?.headers as Record<string, string> | undefined)?.Accept,
        command,
      });
      const replay = {
        version: "job_replay_pointer_v1",
        sessionId: "session-job-1",
        threadId: "thread-job-1",
        runId: "run-job-1",
        replayQuery: {
          sessionId: "session-job-1",
          threadId: "thread-job-1",
          runId: "run-job-1",
        },
        commands: {
          replay: "kestrel runtime replay --run-id run-job-1",
          doctor: "kestrel runtime doctor --run-id run-job-1",
          bundle: "kestrel runtime bundle --run-id run-job-1 --out bundle.json",
        },
      } as const;
      const completed = {
        id: "evt-job-completed",
        type: "job.completed",
        ts: new Date().toISOString(),
        commandId: command.id,
        payload: {
          output: {
            version: "job_run_result_v1",
            sessionId: "session-job-1",
            threadId: "thread-job-1",
            runId: "run-job-1",
            status: "COMPLETED",
            replay,
            result: {
              assistantText: "Job completed.",
              finalizedPayload: null,
              output: {
                status: "COMPLETED",
                sessionId: "session-job-1",
                runId: "run-job-1",
                errors: [],
              },
            },
          },
          replay,
        },
      };
      return new Response(
        `event: job.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      );
    },
  });
  const client = new ProtocolClient(transport);

  const response = await client.sendCommandWithId("cmd-job-1", "job.run", {
    profile,
    input: {
      version: "job_input_v1",
      turn: {
        sessionId: "session-job-1",
        message: "run unattended",
        eventType: "job.run",
      },
    },
  });

  assert.equal(response.type, "job.completed");
  assert.equal(requests[0]?.url, "http://runner.internal/commands/stream");
  assert.equal(requests[0]?.accept, "text/event-stream, application/json");
  assert.equal(requests[0]?.command.type, "job.run");
  await client.close();
});

contractTest("runtime.hermetic", "RemoteRunnerTransport rejects unreadable unary responses with a synthetic runner error", async () => {
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    fetchImpl: async () =>
      new Response("not-json", {
        status: 502,
        headers: {
          "content-type": "text/plain",
        },
      }),
  });
  const client = new ProtocolClient(transport);

  await assert.rejects(
    () =>
      client.sendCommand(
        "runner.ping",
        { nonce: "ok" },
        {
          actor: {
            actorId: "web-demo-user",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
      ),
    /unreadable response \(502\)/i,
  );

  await client.close();
});

contractTest("runtime.hermetic", "RemoteRunnerTransport rejects schema-invalid runner events", async () => {
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const command = JSON.parse(String(init?.body)) as RunnerCommand;
      return new Response(
        JSON.stringify({
          id: "evt-malformed-pong",
          type: "runner.pong",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            nonce: 42,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });
  const client = new ProtocolClient(transport);

  await assert.rejects(
    () => client.sendCommand("runner.ping", { nonce: "ok" }),
    /payload\.nonce must be a string/u,
  );

  await client.close();
});

contractTest("runtime.hermetic", "RemoteRunnerTransport rejects invalid SSE payloads with a synthetic runner error", async () => {
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    fetchImpl: async () =>
      new Response("event: run.started\ndata: not-json\n\n", {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      }),
  });
  const client = new ProtocolClient(transport);

  await assert.rejects(
    () =>
      client.sendCommandWithId(
        "cmd-run-invalid-sse",
        "run.start",
        {
          profile,
          turn: {
            sessionId: "session-1",
            message: "hello",
            eventType: "user.message",
          },
        },
        {
          actor: {
            actorId: "web-demo-user",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
      ),
    /invalid sse payload/i,
  );

  await client.close();
});

contractTest("runtime.hermetic", "RemoteRunnerTransport surfaces runner.error events even on non-200 responses", async () => {
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const command = JSON.parse(String(init?.body)) as RunnerCommand;
      return new Response(
        JSON.stringify({
          id: "evt-error",
          type: "runner.error",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            code: "RUNNER_RUNTIME_ERROR",
            message: "Runner service authorization is required.",
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });
  const client = new ProtocolClient(transport);

  await assert.rejects(
    () =>
      client.sendCommand(
        "runner.ping",
        { nonce: "ok" },
        {
          actor: {
            actorId: "web-demo-user",
            actorType: "end_user",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
      ),
    /authorization is required/i,
  );

  await client.close();
});

contractTest("runtime.hermetic", "RemoteRunnerTransport stop aborts inflight requests and releases handlers", async () => {
  let aborted = false;
  const transport = new RemoteRunnerTransport({
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      return await new Promise<Response>(() => {
        // Intentionally unresolved until the transport aborts the request.
      });
    },
  });
  const client = new ProtocolClient(transport);

  const pending = client.sendCommand(
    "runner.ping",
    { nonce: "ok" },
    {
      actor: {
        actorId: "web-demo-user",
        actorType: "end_user",
        tenantId: "internal",
      },
      tenantId: "internal",
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(((transport as unknown as { controllers: Map<string, AbortController> }).controllers).size, 1);

  await client.close();
  await assert.rejects(pending, /Protocol client closed before response/);

  assert.equal(aborted, true);
  assert.equal(((transport as unknown as { controllers: Map<string, AbortController> }).controllers).size, 0);
  assert.equal(((transport as unknown as { handlers?: unknown }).handlers), undefined);
});
