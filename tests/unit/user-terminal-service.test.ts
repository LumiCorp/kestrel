import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { UserTerminalService } from "../../src/terminal/UserTerminalService.js";

test("UserTerminalService runs an interactive PTY with bounded output and secret-free persisted metadata", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-user-terminal-"));
  const workspaceRoot = path.join(root, "workspace");
  const metadataPath = path.join(root, "terminal-state.json");
  await mkdir(workspaceRoot);
  const service = new UserTerminalService({ metadataPath, maxOutputBytes: 4096 });
  await service.initialize();
  context.after(async () => service.close());

  const terminal = await service.start({
    sessionId: "session-1",
    threadId: "thread-1",
    workspaceRoot,
    shellPath: "/bin/sh",
    cols: 80,
    rows: 24,
  });
  assert.equal(terminal.kind, "user_terminal");
  assert.equal(terminal.status, "running");
  assert.equal(terminal.cwd, terminal.workspaceRoot);

  service.write({
    terminalId: terminal.terminalId,
    sessionId: "session-1",
    data: "printf 'PTY_READY:%s\\n' \"$PWD\"\n",
  });
  const ready = await waitForTerminal(service, terminal.terminalId, (output) => output.includes("PTY_READY:"));
  assert.match(ready.output, /PTY_READY:/u);
  assert.match(ready.output, new RegExp(escapeRegExp(terminal.workspaceRoot), "u"));

  const resized = service.resize({
    terminalId: terminal.terminalId,
    sessionId: "session-1",
    cols: 132,
    rows: 40,
  });
  assert.equal(resized.cols, 132);
  assert.equal(resized.rows, 40);

  service.write({ terminalId: terminal.terminalId, sessionId: "session-1", data: "exit 7\n" });
  const exited = await waitForRecord(service, terminal.terminalId, (record) => record.status === "exited");
  assert.equal(exited.exitCode, 7);
  assert.equal(typeof exited.durationMs, "number");

  const persisted = await readFile(metadataPath, "utf8");
  assert.doesNotMatch(persisted, /PTY_READY|printf|exit 7/u);
  await service.close();
});

test("UserTerminalService rejects working directories outside the authoritative workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-user-terminal-path-"));
  const workspaceRoot = path.join(root, "workspace");
  const outsideRoot = path.join(root, "outside");
  await mkdir(workspaceRoot);
  await mkdir(outsideRoot);
  const service = new UserTerminalService({ metadataPath: path.join(root, "terminal-state.json") });
  await service.initialize();

  await assert.rejects(
    service.start({
      sessionId: "session-1",
      threadId: "thread-1",
      workspaceRoot,
      cwd: outsideRoot,
      shellPath: "/bin/sh",
    }),
    (error) => {
      assert.equal((error as { code?: string }).code, "USER_TERMINAL_PATH_OUTSIDE_WORKSPACE");
      return true;
    },
  );
  await service.close();
});

test("UserTerminalService marks previously running metadata lost after Local Core relaunch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-user-terminal-recovery-"));
  const metadataPath = path.join(root, "terminal-state.json");
  const startedAt = "2026-07-20T12:00:00.000Z";
  await writeFile(metadataPath, JSON.stringify({
    version: 1,
    terminals: [{
      terminalId: "terminal-before-restart",
      kind: "user_terminal",
      sessionId: "session-1",
      threadId: "thread-1",
      workspaceRoot: root,
      cwd: root,
      shellPath: "/bin/sh",
      pid: 123,
      status: "running",
      cols: 80,
      rows: 24,
      startedAt,
      updatedAt: startedAt,
    }],
  }), "utf8");
  const service = new UserTerminalService({
    metadataPath,
    now: () => new Date("2026-07-20T12:01:00.000Z"),
  });

  await service.initialize();

  const [recovered] = service.list({ sessionId: "session-1", threadId: "thread-1" });
  assert.equal(recovered?.status, "lost");
  assert.equal(recovered?.durationMs, 60_000);
  await service.close();
});

async function waitForTerminal(
  service: UserTerminalService,
  terminalId: string,
  predicate: (output: string) => boolean,
) {
  let cursor = 0;
  let output = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const next = service.read({ terminalId, sessionId: "session-1", cursor });
    output += next.output;
    cursor = next.nextCursor;
    if (predicate(output)) {
      return { ...next, output };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for terminal output: ${output}`);
}

async function waitForRecord(
  service: UserTerminalService,
  terminalId: string,
  predicate: (record: ReturnType<UserTerminalService["list"]>[number]) => boolean,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const record = service.list({ sessionId: "session-1" }).find((candidate) => candidate.terminalId === terminalId);
    if (record !== undefined && predicate(record)) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for terminal state.");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
