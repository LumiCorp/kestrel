import assert from "node:assert/strict";
import test from "node:test";

import type { LocalCoreClient } from "../../../src/localCore/client.js";
import type { LocalCoreConnectionManager } from "../../../src/localCore/connectionManager.js";
import { LocalCoreRunnerTransport } from "../src/localCoreRunnerTransport.js";

test("LocalCoreRunnerTransport sends Desktop protocol commands through Local Core", async () => {
  const sent: string[] = [];
  let restartCalls = 0;
  const client = {
    async sendRunnerCommand(line: string, input: { onLine(line: string): void }): Promise<void> {
      sent.push(line);
      const command = JSON.parse(line) as { id: string; payload: { nonce: string } };
      input.onLine(JSON.stringify({
        id: "event-1",
        type: "runner.pong",
        commandId: command.id,
        payload: { nonce: command.payload.nonce },
      }));
    },
    async restart(): Promise<Record<string, never>> {
      restartCalls += 1;
      return {};
    },
  } as unknown as LocalCoreClient;
  const transport = new LocalCoreRunnerTransport({
    connectionManager: createConnectionManager(client),
    logPath: "/tmp/kestrel-core.log",
  });
  const events: string[] = [];
  transport.observe({ onLine: (line) => events.push(line) });
  transport.ensureStarted();

  transport.send(JSON.stringify({ id: "command-1", type: "runner.ping", payload: { nonce: "desktop" } }));
  await waitFor(() => events.length === 1);

  assert.equal(sent.length, 1);
  assert.equal((JSON.parse(events[0] ?? "{}") as { type?: string }).type, "runner.pong");
  assert.equal(transport.getStatus().running, true);
  assert.equal((await transport.restart()).running, true);
  assert.equal(restartCalls, 1);
});

test("LocalCoreRunnerTransport reports Core request failures as protocol events", async () => {
  const client = {
    async sendRunnerCommand(): Promise<void> {
      throw new Error("socket unavailable");
    },
  } as unknown as LocalCoreClient;
  const transport = new LocalCoreRunnerTransport({
    connectionManager: createConnectionManager(client),
    logPath: "/tmp/kestrel-core.log",
  });
  const events: Array<{ type?: string; commandId?: string }> = [];
  transport.observe({
    onLine: (line) => events.push(JSON.parse(line) as { type?: string; commandId?: string }),
  });
  transport.ensureStarted();

  transport.send(JSON.stringify({ id: "command-2", type: "runner.ping", payload: { nonce: "desktop" } }));
  await waitFor(() => events.length === 1);

  assert.equal(events[0]?.type, "runner.error");
  assert.equal(events[0]?.commandId, "command-2");
  assert.deepEqual(transport.getStatus().recentStderr, ["socket unavailable"]);
});

test("LocalCoreRunnerTransport forwards streamed run updates before the terminal event", async () => {
  let releaseTerminal: (() => void) | undefined;
  const terminalBarrier = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  const client = {
    async sendRunnerCommand(
      line: string,
      input: { onLine(line: string): void },
    ): Promise<void> {
      const command = JSON.parse(line) as { id: string };
      input.onLine(JSON.stringify({
        id: "event-started",
        type: "run.started",
        commandId: command.id,
        payload: { sessionId: "session-1", eventType: "user.message" },
      }));
      input.onLine(JSON.stringify({
        id: "event-progress",
        type: "run.progress",
        commandId: command.id,
        payload: { update: { message: "Inspecting the project." } },
      }));
      await terminalBarrier;
      input.onLine(JSON.stringify({
        id: "event-completed",
        type: "run.completed",
        commandId: command.id,
        payload: { result: { assistantText: "Done." } },
      }));
    },
  } as unknown as LocalCoreClient;
  const transport = new LocalCoreRunnerTransport({
    connectionManager: createConnectionManager(client),
    logPath: "/tmp/kestrel-core.log",
  });
  const eventTypes: string[] = [];
  transport.observe({
    onLine: (line) => eventTypes.push((JSON.parse(line) as { type: string }).type),
  });
  transport.ensureStarted();

  transport.send(JSON.stringify({
    id: "command-stream",
    type: "run.start",
    payload: { sessionId: "session-1", message: "Inspect this project." },
  }));

  await waitFor(() => eventTypes.length === 2);
  assert.deepEqual(eventTypes, ["run.started", "run.progress"]);

  releaseTerminal?.();
  await waitFor(() => eventTypes.length === 3);
  assert.deepEqual(eventTypes, ["run.started", "run.progress", "run.completed"]);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}

function createConnectionManager(
  client: LocalCoreClient,
): Pick<LocalCoreConnectionManager, "executeOnce"> {
  return {
    async executeOnce<T>(operation: (current: LocalCoreClient) => Promise<T>): Promise<T> {
      return await operation(client);
    },
  };
}
