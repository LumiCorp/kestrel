import assert from "node:assert/strict";
import test from "node:test";

import {
  isDevShellLifecycleTool,
  normalizeDevShellLifecycle,
} from "../../src/runtime/devshellLifecycle.js";

test("normalizeDevShellLifecycle maps legacy process tools", () => {
  assert.equal(isDevShellLifecycleTool("dev.process.read"), true);
  assert.deepEqual(
    normalizeDevShellLifecycle(
      "dev.process.write_and_read",
      { processId: "proc-1", data: "move N\n" },
      { processId: "proc-1", status: "RUNNING", text: "moved\n", cursor: 12, truncated: false },
    ),
    {
      toolName: "dev.process.write_and_read",
      kind: "write",
      status: "RUNNING",
      processId: "proc-1",
      stdin: "move N\n",
      outputText: "moved\n",
      truncated: false,
      cursor: 12,
    },
  );
  assert.deepEqual(
    normalizeDevShellLifecycle(
      "dev.process.stop",
      { processId: "proc-1" },
      { processId: "proc-1", status: "STOPPED", text: "stopped", exitCode: 130 },
    ),
    {
      toolName: "dev.process.stop",
      kind: "stop",
      status: "STOPPED",
      processId: "proc-1",
      outputText: "stopped",
      exitCode: 130,
    },
  );
});

test("normalizeDevShellLifecycle maps exec_command shapes and aliases sessionId", () => {
  assert.deepEqual(
    normalizeDevShellLifecycle(
      "exec_command",
      { command: "./maze_game.sh", cwd: "/app" },
      { status: "running", sessionId: "tb-proc-1", output: "Welcome\n> ", truncated: false, cursor: 9 },
    ),
    {
      toolName: "exec_command",
      kind: "start",
      status: "RUNNING",
      processId: "tb-proc-1",
      sessionId: "tb-proc-1",
      command: "./maze_game.sh",
      cwd: "/app",
      outputText: "Welcome\n> ",
      truncated: false,
      cursor: 9,
    },
  );
  assert.deepEqual(
    normalizeDevShellLifecycle(
      "exec_command",
      { sessionId: "tb-proc-1", stdin: "move N\n" },
      { status: "completed", sessionId: "tb-proc-1", output: "done\n", exitCode: 0, truncated: true },
    ),
    {
      toolName: "exec_command",
      kind: "write",
      status: "COMPLETED",
      processId: "tb-proc-1",
      sessionId: "tb-proc-1",
      stdin: "move N\n",
      outputText: "done\n",
      exitCode: 0,
      truncated: true,
    },
  );
  assert.equal(
    normalizeDevShellLifecycle("exec_command", { sessionId: "tb-proc-1", stop: true }, { status: "stopped" })?.kind,
    "stop",
  );
});
