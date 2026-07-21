import assert from "node:assert/strict";
import test from "node:test";

import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import { runDesktopUserTerminalCommand } from "../src/userTerminal.js";

const context: WebRunnerRequestContext = { actor: { actorId: "desktop-shell", actorType: "operator" } };
const now = "2026-07-20T12:00:00.000Z";
const terminal = {
  terminalId: "terminal-1",
  kind: "user_terminal" as const,
  sessionId: "session-1",
  threadId: "thread-1",
  workspaceRoot: "/repo",
  cwd: "/repo",
  shellPath: "/bin/sh",
  status: "running" as const,
  cols: 120,
  rows: 32,
  startedAt: now,
  updatedAt: now,
};

test("Desktop user terminal bridge preserves raw terminal input and validates Local Core responses", async () => {
  const calls: unknown[] = [];
  const adapter = {
    sendControl: async (command: { type: string; sessionId: string; data?: string }) => {
      calls.push(command);
      return {
        id: "event-1",
        type: "user.terminal" as const,
        ts: now,
        payload: { sessionId: command.sessionId, operation: command.type.split(".").at(-1), terminal },
      };
    },
  } as Pick<WebRunnerAdapter, "sendControl">;
  const result = await runDesktopUserTerminalCommand({
    adapter,
    request: { sessionId: "session-1", terminalId: "terminal-1", data: " " },
    operation: "write",
    context,
  });
  assert.equal((result as typeof terminal).terminalId, "terminal-1");
  assert.equal((calls[0] as { data: string }).data, " ");
});

test("Desktop user terminal bridge rejects mismatched session responses", async () => {
  const adapter = {
    sendControl: async () => ({
      id: "event-1",
      type: "user.terminal" as const,
      ts: now,
      payload: { sessionId: "session-other", operation: "list" as const, terminals: [] },
    }),
  } as Pick<WebRunnerAdapter, "sendControl">;
  await assert.rejects(
    runDesktopUserTerminalCommand({ adapter, request: { sessionId: "session-1" }, operation: "list", context }),
    /invalid user terminal response/u,
  );
});
