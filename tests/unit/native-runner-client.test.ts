import assert from "node:assert/strict";
import test from "node:test";

import type { ProtocolTransport } from "../../cli/client/ProtocolClient.js";
import { NativeRunnerClient } from "../../cli/sdk/NativeRunnerClient.js";
import type { TuiProfile } from "../../cli/contracts.js";

const profile: TuiProfile = {
  id: "reference-react",
  label: "Reference React",
  agent: "reference-react",
  sessionPrefix: "reference-react",
};

class MockTransport implements ProtocolTransport {
  handlers:
    | {
        onLine: (line: string) => void;
        onExit: (code: number | null) => void;
        onErrorOutput?: ((line: string) => void) | undefined;
      }
    | undefined;

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    const command = JSON.parse(line) as { id: string; type: string; payload: Record<string, unknown> };
    if (command.type === "run.start") {
      this.handlers?.onLine(
        JSON.stringify({
          id: "evt-run-started",
          type: "run.started",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            sessionId: (command.payload.turn as { sessionId: string }).sessionId,
            eventType: "user.message",
          },
        }),
      );
      this.handlers?.onLine(
        JSON.stringify({
          id: "evt-run-completed",
          type: "run.completed",
          ts: new Date().toISOString(),
          commandId: command.id,
          runId: "run-sdk-1",
          payload: {
            result: {
              assistantText: "sdk hello",
              output: {
                status: "COMPLETED",
                sessionId: (command.payload.turn as { sessionId: string }).sessionId,
                runId: "run-sdk-1",
                errors: [],
                telemetry: {
                  stepsExecuted: 1,
                  toolCalls: 0,
                  modelCalls: 1,
                  durationMs: 1,
                },
              },
              finalizedPayload: {
                message: "sdk hello",
              },
            },
          },
        }),
      );
      return;
    }
    if (command.type === "session.describe") {
      this.handlers?.onLine(
        JSON.stringify({
          id: "evt-session",
          type: "session.described",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            sessionId: command.payload.sessionId,
            threadId: "thread-sdk-1",
          },
        }),
      );
      return;
    }
    this.handlers?.onLine(
      JSON.stringify({
        id: "evt-pong",
        type: "runner.pong",
        ts: new Date().toISOString(),
        commandId: command.id,
        payload: {},
      }),
    );
  }

  async stop(): Promise<void> {
    this.handlers?.onExit(0);
  }
}

test("NativeRunnerClient streams run events and returns terminal run response", async () => {
  const transport = new MockTransport();
  const client = new NativeRunnerClient({ transport });
  const seen: string[] = [];

  const response = await client.streamRun(
    {
      profile,
      turn: {
        sessionId: "session-sdk-1",
        message: "hello",
        eventType: "user.message",
      },
      onEvent(event) {
        seen.push(event.type);
      },
    },
    {
      actor: {
        actorId: "sdk-user",
        actorType: "end_user",
      },
      tenantId: "internal",
      profile,
    },
  );

  assert.equal(response.type, "run.completed");
  assert.deepEqual(seen, ["run.started", "run.completed"]);
  await client.close();
});

test("NativeRunnerClient describes sessions over the native protocol", async () => {
  const transport = new MockTransport();
  const client = new NativeRunnerClient({ transport });

  const described = await client.describeSession("session-sdk-1", {
    actor: {
      actorId: "sdk-operator",
      actorType: "operator",
    },
    tenantId: "internal",
  });

  assert.equal(described.sessionId, "session-sdk-1");
  assert.equal(described.threadId, "thread-sdk-1");
  await client.close();
});
