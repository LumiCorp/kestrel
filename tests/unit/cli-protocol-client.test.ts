import test from "node:test";
import assert from "node:assert/strict";

import { ProtocolClient, type ProtocolTransport } from "../../cli/client/ProtocolClient.js";

class MockTransport implements ProtocolTransport {
  private handlers?:
    | {
        onLine: (line: string) => void;
        onExit: (code: number | null) => void;
        onErrorOutput?: ((line: string) => void) | undefined;
      }
    | undefined;
  sent: string[] = [];

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    this.sent.push(line);
    const command = JSON.parse(line) as { id: string; type: string };
    if (this.handlers === undefined) {
      throw new Error("transport not started");
    }

    if (command.type === "runner.ping") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-1",
          type: "runner.pong",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            nonce: "abc",
          },
        }),
      );
      return;
    }

    if (command.type === "mcp.status") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-mcp-1",
          type: "mcp.status",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            status: {
              healthy: true,
              checkedAt: new Date().toISOString(),
              servers: [],
              tools: [],
            },
          },
        }),
      );
      return;
    }

    if (command.type === "session.describe") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-session-1",
          type: "session.described",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            sessionId: "session-123",
            updatedAt: new Date().toISOString(),
          },
        }),
      );
      return;
    }

    if (command.type === "operator.inbox") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-operator-inbox-1",
          type: "operator.inbox",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            inbox: {
              focusThreadId: "thread-main",
              items: [],
              summary: {
                total: 0,
                actionable: 0,
                approvals: 0,
                userInputs: 0,
                checkpoints: 0,
                childBlockers: 0,
                stalled: 0,
                assemblyProposals: 0,
                compatibilityAlerts: 0,
              },
            },
          },
        }),
      );
      return;
    }

    if (command.type === "operator.thread") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-operator-thread-1",
          type: "operator.thread",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            view: {
              thread: {
                threadId: "thread-main",
                sessionId: "session-123",
                title: "Main",
                status: "WAITING",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              childThreads: [],
            },
          },
        }),
      );
      return;
    }

    if (command.type === "operator.control") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-operator-controlled-1",
          type: "operator.controlled",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            threadId: "thread-main",
          },
        }),
      );
      return;
    }

    this.handlers.onLine(
      JSON.stringify({
        id: "evt-progress",
        type: "run.progress",
        ts: new Date().toISOString(),
        commandId: command.id,
        runId: "run-1",
        payload: {
          update: {
            version: "v1",
            runId: "run-1",
            sessionId: "s-1",
            ts: new Date().toISOString(),
            seq: 1,
            kind: "stage",
            phase: "engine",
            code: "RUN_STARTED",
            message: "Run started.",
            persist: true,
          },
        },
      }),
    );

    this.handlers.onLine(
      JSON.stringify({
        id: "evt-2",
        type: "run.completed",
        ts: new Date().toISOString(),
        commandId: command.id,
        runId: "run-1",
        payload: {
          result: {
            output: {
              status: "COMPLETED",
              sessionId: "s-1",
              runId: "run-1",
              errors: [],
              telemetry: {
                stepsExecuted: 1,
                toolCalls: 0,
                modelCalls: 0,
                durationMs: 1,
              },
            },
            finalizedPayload: { message: "done" },
          },
        },
      }),
    );
  }

  async stop(): Promise<void> {
    this.handlers?.onExit(0);
  }
}

class ControlledExitTransport implements ProtocolTransport {
  private handlers?:
    | {
        onLine: (line: string) => void;
        onExit: (code: number | null) => void;
        onErrorOutput?: ((line: string) => void) | undefined;
      }
    | undefined;
  startCount = 0;
  respondToPing = true;

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void {
    this.handlers = handlers;
    this.startCount += 1;
  }

  send(line: string): void {
    if (this.handlers === undefined) {
      throw new Error("transport not started");
    }
    const command = JSON.parse(line) as { id: string; type: string };
    if (command.type === "runner.ping" && this.respondToPing) {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-restartable-pong",
          type: "runner.pong",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            nonce: "second",
          },
        }),
      );
    }
  }

  emitExit(code: number): void {
    this.handlers?.onExit(code);
  }

  emitErrorOutput(line: string): void {
    this.handlers?.onErrorOutput?.(line);
  }

  emitRunnerError(
    message: string,
    details?: Record<string, unknown>,
    commandId?: string,
  ): void {
    this.handlers?.onLine(
      JSON.stringify({
        id: "evt-runner-error",
        type: "runner.error",
        ts: new Date().toISOString(),
        ...(commandId !== undefined ? { commandId } : {}),
        payload: {
          code: "RUNNER_RUNTIME_ERROR",
          message,
          ...(details !== undefined ? { details } : {}),
        },
      }),
    );
  }

  emitEvent(event: Record<string, unknown>): void {
    this.handlers?.onLine(JSON.stringify(event));
  }

  async stop(): Promise<void> {
    this.handlers?.onExit(0);
  }
}

test("ProtocolClient resolves runner.ping command", async () => {
  const transport = new MockTransport();
  const client = new ProtocolClient(transport);

  const response = await client.sendCommand("runner.ping", { nonce: "abc" });
  if (response.type !== "runner.pong") {
    throw new Error("expected runner.pong");
  }
  assert.equal(response.payload.nonce, "abc");

  await client.close();
});

test("ProtocolClient resolves run.start command with completed response", async () => {
  const transport = new MockTransport();
  const client = new ProtocolClient(transport);
  const seenEventTypes: string[] = [];
  client.onEvent((event) => {
    seenEventTypes.push(event.type);
  });

  const response = await client.sendCommand("run.start", {
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
    },
    turn: {
      sessionId: "s-1",
      message: "hiya",
      eventType: "user.message",
      stepAgent: "react.deliberate",
    },
  });

  if (response.type !== "run.completed") {
    throw new Error("expected completed response");
  }
  assert.equal(response.payload.result.output.status, "COMPLETED");
  assert.equal(seenEventTypes.includes("run.progress"), true);

  await client.close();
});

test("ProtocolClient resolves mcp.status command", async () => {
  const transport = new MockTransport();
  const client = new ProtocolClient(transport);

  const response = await client.sendCommand("mcp.status", {
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
      mcpServers: [],
    },
  });

  if (response.type !== "mcp.status") {
    throw new Error("expected mcp.status");
  }
  assert.equal(response.payload.status.healthy, true);
  await client.close();
});

test("ProtocolClient resolves session.describe command", async () => {
  const transport = new MockTransport();
  const client = new ProtocolClient(transport);

  const response = await client.sendCommand("session.describe", {
    sessionId: "session-123",
  });

  if (response.type !== "session.described") {
    throw new Error("expected session.described");
  }
  assert.equal(response.payload.sessionId, "session-123");
  await client.close();
});

test("ProtocolClient resolves operator command terminal events", async () => {
  const transport = new MockTransport();
  const client = new ProtocolClient(transport);

  const inbox = await client.sendCommand("operator.inbox", {
    sessionId: "session-123",
  });
  if (inbox.type !== "operator.inbox") {
    throw new Error("expected operator.inbox");
  }
  assert.equal(inbox.payload.inbox.focusThreadId, "thread-main");

  const view = await client.sendCommand("operator.thread", {
    threadId: "thread-main",
  });
  if (view.type !== "operator.thread") {
    throw new Error("expected operator.thread");
  }
  assert.equal(view.payload.view.thread.threadId, "thread-main");

  const controlled = await client.sendCommand("operator.control", {
    action: "retry",
    threadId: "thread-main",
    message: "retry",
  });
  if (controlled.type !== "operator.controlled") {
    throw new Error("expected operator.controlled");
  }
  assert.equal(controlled.payload.threadId, "thread-main");

  await client.close();
});

test("ProtocolClient restarts transport after runner exit", async () => {
  const transport = new ControlledExitTransport();
  const client = new ProtocolClient(transport);

  transport.respondToPing = false;
  const first = client.sendCommand("runner.ping", { nonce: "first" });
  await tick();
  transport.emitExit(1);
  await assert.rejects(first, /Runner process exited with code 1/);
  assert.equal(transport.startCount, 1);

  transport.respondToPing = true;
  const second = await client.sendCommand("runner.ping", { nonce: "second" });
  if (second.type !== "runner.pong") {
    throw new Error("expected runner.pong");
  }
  assert.equal(second.payload.nonce, "second");
  assert.equal(transport.startCount, 2);
  await client.close();
});

test("ProtocolClient includes recent stderr detail in runner exit failures", async () => {
  const transport = new ControlledExitTransport();
  const client = new ProtocolClient(transport);

  transport.respondToPing = false;
  const pending = client.sendCommand("runner.ping", { nonce: "first" });
  await tick();
  transport.emitErrorOutput("Error: Cannot find module './missing-runner-dependency.js'");
  transport.emitExit(1);

  await assert.rejects(
    pending,
    /Runner process exited with code 1: Error: Cannot find module '\.\/missing-runner-dependency\.js'/,
  );
});

test("ProtocolClient preserves full runner stderr diagnostics on exit errors", async () => {
  const transport = new ControlledExitTransport();
  const client = new ProtocolClient(transport);

  transport.respondToPing = false;
  const pending = client.sendCommand("runner.ping", { nonce: "first" });
  await tick();
  transport.emitErrorOutput("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /Users/example");
  transport.emitErrorOutput("    at packageResolve (node:internal/modules/esm/resolve:873:9)");
  transport.emitExit(1);

  await assert.rejects(async () => pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    const diagnostics = (error as Error & {
      runnerExitDiagnostics?: { lastProcessError?: string; recentStderr?: string[] };
    }).runnerExitDiagnostics;
    assert.equal(diagnostics?.recentStderr?.[0], "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /Users/example");
    assert.equal(diagnostics?.recentStderr?.[1], "at packageResolve (node:internal/modules/esm/resolve:873:9)");
    return true;
  });
});

test("ProtocolClient keeps the root module-resolution line from longer Node stacks", async () => {
  const transport = new ControlledExitTransport();
  const client = new ProtocolClient(transport);

  transport.respondToPing = false;
  const pending = client.sendCommand("runner.ping", { nonce: "first" });
  await tick();
  transport.emitErrorOutput("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /workspace");
  for (let index = 0; index < 12; index += 1) {
    transport.emitErrorOutput(`    at frame${index} (node:internal/modules/esm/loader:${700 + index}:1)`);
  }
  transport.emitErrorOutput("{");
  transport.emitErrorOutput("  code: 'ERR_MODULE_NOT_FOUND'");
  transport.emitErrorOutput("}");
  transport.emitErrorOutput("Node.js v22.15.0");
  transport.emitExit(1);

  await assert.rejects(async () => pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Cannot find package 'tsx'/);
    const diagnostics = (error as Error & {
      runnerExitDiagnostics?: { recentStderr?: string[] };
    }).runnerExitDiagnostics;
    assert.equal(
      diagnostics?.recentStderr?.[0],
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /workspace",
    );
    assert.equal(diagnostics?.recentStderr?.at(-1), "Node.js v22.15.0");
    return true;
  });
});

test("ProtocolClient prefers top-level runner.error detail when the runner exits", async () => {
  const transport = new ControlledExitTransport();
  const client = new ProtocolClient(transport);

  transport.respondToPing = false;
  const pending = client.sendCommand("runner.ping", { nonce: "first" });
  await tick();
  transport.emitRunnerError("Workspace registry failed to load");
  transport.emitErrorOutput("Error: EACCES: permission denied, open '/tmp/workspaces.json'");
  transport.emitExit(1);

  await assert.rejects(
    pending,
    /Runner process exited with code 1: Workspace registry failed to load \| stderr: Error: EACCES: permission denied, open '\/tmp\/workspaces\.json'/,
  );
});

test("ProtocolClient preserves runner.error details on terminal command failures", async () => {
  const transport = new ControlledExitTransport();
  const client = new ProtocolClient(transport);
  transport.respondToPing = false;

  const pending = client.sendCommandWithId("cmd-details", "runner.ping", { nonce: "first" });
  await tick();
  transport.emitRunnerError("Local Postgres is not reachable at localhost:55432/kestrel.", {
    host: "localhost",
    port: 55432,
    database: "kestrel",
    recommendedAction: "Start the local database with `pnpm run db:up`.",
  }, "cmd-details");

  await assert.rejects(async () => pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    const typed = error as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    assert.equal(typed.code, "RUNNER_RUNTIME_ERROR");
    assert.equal(typed.details?.host, "localhost");
    assert.equal(typed.details?.port, 55432);
    assert.equal(typed.details?.database, "kestrel");
    return true;
  });

  await client.close();
});

test("ProtocolClient close releases event listeners", async () => {
  const transport = new ControlledExitTransport();
  const client = new ProtocolClient(transport);
  const seen: string[] = [];

  client.onEvent((event) => {
    seen.push(event.type);
  });

  await client.sendCommand("runner.ping", { nonce: "first" });
  assert.deepEqual(seen, ["runner.pong"]);

  await client.close();
  transport.emitEvent({
    id: "evt-after-close",
    type: "runner.pong",
    ts: new Date().toISOString(),
    payload: {
      nonce: "late",
    },
  });

  assert.deepEqual(seen, ["runner.pong"]);
  assert.equal(((client as unknown as { listeners: Set<unknown> }).listeners).size, 0);
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
