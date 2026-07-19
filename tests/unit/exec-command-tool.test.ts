import assert from "node:assert/strict";
import test from "node:test";

import type {
  DevProcessReadInput,
  DevProcessReadResult,
  DevProcessStartInput,
  DevProcessStartResult,
  DevProcessStopInput,
  DevProcessStopResult,
  DevProcessWriteAndReadInput,
  DevProcessWriteAndReadResult,
  DevProcessWriteInput,
  DevProcessWriteResult,
  DevShellRunInput,
  DevShellRunResult,
  DevShellServicePort,
} from "../../src/devshell/contracts.js";
import { execCommandTool } from "../../tools/devshell/execCommand.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";
import { artifactReadTool } from "../../tools/runtime/artifactRead.js";

test("exec_command maps one-shot process completion to completed output", async () => {
  const service = new CapturingExecCommandService({
    startResult: {
      status: "COMPLETED",
      text: "done\n",
      truncated: false,
      cursor: 0,
      nextCursor: 5,
      exitCode: 0,
    },
  });

  const output = await runExecCommandForTest({
    fileSystem: { workspaceRoot: "/repo", tempRoots: [] },
    workspace: { appRoot: "app" },
    devShell: { enabled: true },
    devShellService: service,
  }, {
    command: "printf done",
    yieldTimeMs: 25,
    maxOutputBytes: 1024,
  });

  assert.equal(output.status, "completed");
  assert.equal(output.output, "done\n");
  assert.equal(output.exitCode, 0);
  assert.equal(output.sessionId, undefined);
  assert.equal(output.cursor, 5);
  assert.equal(service.runInputs.length, 0);
  assert.equal(service.startInputs.length, 1);
  assert.equal(service.startInputs[0]?.workspaceRoot, "/repo");
  assert.equal(service.startInputs[0]?.cwd, "/repo/app");
  assert.equal(service.startInputs[0]?.command, "printf done");
  assert.equal(service.startInputs[0]?.yieldTimeMs, 25);
  assert.deepEqual(service.startInputs[0]?.sourceWriteGuard, {
    enabled: true,
    mutationPolicy: "reject",
  });
});

test("exec_command capture mode returns an applicable immutable patch artifact", async () => {
  const patch = "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const service = new CapturingExecCommandService({
    startResult: {
      processId: "proc-capture",
      status: "COMPLETED",
      text: "",
      truncated: false,
      cursor: 0,
      nextCursor: 0,
      exitCode: 0,
      sourceWriteGuard: {
        enabled: true,
        mode: "captured_source_write",
        sourceRoots: ["."],
        allowedWriteRoots: [],
        unauthorizedSourceWrites: [{ path: "app.ts", kind: "modified", restored: true }],
        restored: true,
        capturedPatch: patch,
        capturedBaseRevisions: { "app.ts": "sha256:base" },
      },
    },
  });
  const output = await runExecCommandForTest({ devShell: { enabled: true }, devShellService: service }, {
    command: "formatter app.ts",
    sourceMutation: "capture",
  });
  assert.match(String(output.patchRef), /^patch:/u);
  assert.deepEqual(output.baseRevisions, { "app.ts": "sha256:base" });
  assert.equal((output.sourceWriteGuard as { capturedPatch?: unknown }).capturedPatch, undefined);
  assert.equal(service.startInputs[0]?.sourceWriteGuard?.mutationPolicy, "capture");

  const artifact = await artifactReadTool.createHandler({})({ ref: output.patchRef });
  assert.equal((artifact as { content?: string }).content, patch);
});

test("exec_command command shape returns a reusable session when the process is still running", async () => {
  const service = new CapturingExecCommandService({
    startResult: {
      processId: "proc-live",
      status: "RUNNING",
      text: "ready\n",
      truncated: false,
      cursor: 0,
      nextCursor: 6,
    },
  });

  const output = await runExecCommandForTest({
    devShell: { enabled: true },
    devShellService: service,
  }, { command: "./maze_game.sh" });

  assert.equal(output.status, "running");
  assert.equal(output.sessionId, "proc-live");
  assert.equal(output.output, "ready\n");
  assert.equal(service.runInputs.length, 0);
  assert.equal(service.startInputs.length, 1);
});

test("exec_command respects an explicit zero initial observation window", async () => {
  const service = new CapturingExecCommandService();

  await runExecCommandForTest({
    devShell: { enabled: true },
    devShellService: service,
  }, {
    command: "grep -n . /app/maze_map.txt || true",
    yieldTimeMs: 0,
  });

  assert.equal(service.startInputs.length, 1);
  assert.equal(service.runInputs.length, 0);
  assert.equal(service.startInputs[0]?.yieldTimeMs, 0);
});

test("exec_command sends stdin through the existing process and reads the response", async () => {
  const service = new CapturingExecCommandService({
    writeAndReadResult: {
      processId: "proc-1",
      status: "RUNNING",
      text: "moved north\n> ",
      truncated: false,
      cursor: 7,
      nextCursor: 21,
      bytesWritten: 7,
    },
  });

  const output = await runExecCommandForTest({
    devShell: { enabled: true },
    devShellService: service,
  }, {
    sessionId: "proc-1",
    stdin: "move N\n",
    yieldTimeMs: 10,
    maxOutputBytes: 100,
  });

  assert.equal(output.status, "running");
  assert.equal(output.sessionId, "proc-1");
  assert.equal(output.output, "moved north\n> ");
  assert.deepEqual(service.writeAndReadInputs, [
    {
      processId: "proc-1",
      data: "move N\n",
      waitMs: 10,
      maxBytes: 100,
    },
  ]);
  assert.equal(service.startInputs.length, 0);
});

test("exec_command applies default observation wait for continuation stdin", async () => {
  const service = new CapturingExecCommandService({
    writeAndReadResult: {
      processId: "proc-1",
      status: "RUNNING",
      text: "hit wall\n> ",
      truncated: false,
      cursor: 21,
      nextCursor: 33,
      bytesWritten: 7,
    },
  });

  const output = await runExecCommandForTest({
    devShell: { enabled: true },
    devShellService: service,
  }, {
    sessionId: "proc-1",
    stdin: "move W\n",
  });

  assert.equal(output.output, "hit wall\n> ");
  assert.deepEqual(service.writeAndReadInputs, [
    {
      processId: "proc-1",
      data: "move W\n",
      waitMs: 1000,
    },
  ]);
});

test("exec_command respects explicit zero observation wait for continuation stdin", async () => {
  const service = new CapturingExecCommandService();

  await runExecCommandForTest({
    devShell: { enabled: true },
    devShellService: service,
  }, {
    sessionId: "proc-1",
    stdin: "move W\n",
    yieldTimeMs: 0,
  });

  assert.deepEqual(service.writeAndReadInputs, [
    {
      processId: "proc-1",
      data: "move W\n",
      waitMs: 0,
    },
  ]);
});

test("exec_command continuation output is visible in model context", () => {
  const result = buildAgentToolSuccessResult({
    toolName: "exec_command",
    input: {
      sessionId: "proc-1",
      stdin: "move W\n",
    },
    output: {
      status: "running",
      sessionId: "proc-1",
      output: "hit wall\n> ",
      durationMs: 1000,
      truncated: false,
      cursor: 33,
    },
  });

  assert.match(result.modelContext.text, /- sessionId: proc-1/u);
  assert.match(result.modelContext.text, /- stdin: move W/u);
  assert.match(result.modelContext.text, /- text:\n {2}hit wall\n {2}> /u);
});

test("exec_command stops an existing session", async () => {
  const service = new CapturingExecCommandService({
    stopResult: {
      status: "STOPPED",
      text: "terminated\n",
      truncated: false,
      cursor: 0,
      nextCursor: 11,
    },
  });

  const output = await runExecCommandForTest({
    devShell: { enabled: true },
    devShellService: service,
  }, {
    sessionId: "proc-1",
    stop: true,
  });

  assert.equal(output.status, "stopped");
  assert.equal(output.output, "terminated\n");
  assert.deepEqual(service.stopInputs, [{ processId: "proc-1" }]);
});

test("exec_command rejects ambiguous lifecycle input", async () => {
  const handler = execCommandTool.createHandler({
    devShell: { enabled: true },
    devShellService: new CapturingExecCommandService(),
  });

  await assert.rejects(() => handler({}), /Expected exactly one/u);
  await assert.rejects(() => handler({ command: "echo ok", sessionId: "proc-1" }), /Expected exactly one/u);
  await assert.rejects(() => handler({ command: "echo ok", stdin: "x\n" }), /cannot be combined/u);
  await assert.rejects(() => handler({ sessionId: "proc-1", stdin: "x\n", stop: true }), /cannot be combined/u);
});

test("exec_command accepts only workspace-relative cwd and keeps the workspace root authoritative", async () => {
  const service = new CapturingExecCommandService();
  const handler = execCommandTool.createHandler({
    fileSystem: { workspaceRoot: "/repo", tempRoots: [] },
    devShell: { enabled: true },
    devShellService: service,
  });

  await handler({ command: "pwd", cwd: "coding-fixture" });
  assert.equal(service.startInputs[0]?.workspaceRoot, "/repo");
  assert.equal(service.startInputs[0]?.cwd, "coding-fixture");

  await assert.rejects(
    () => handler({ command: "pwd", cwd: "/host-only/worktree" }),
    /cwd must be relative to the active workspace/u,
  );
  await assert.rejects(
    () => handler({ command: "pwd", cwd: "../outside" }),
    /must not escape it/u,
  );
  assert.equal(service.startInputs.length, 1);
});

test("exec_command model schema does not expose host workspaceRoot input", () => {
  assert.doesNotMatch(JSON.stringify(execCommandTool.definition.inputSchema), /workspaceRoot/u);
  assert.match(JSON.stringify(execCommandTool.definition.inputSchema), /Workspace-relative working directory/u);
});

async function runExecCommandForTest(
  context: Parameters<typeof execCommandTool.createHandler>[0],
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await execCommandTool.createHandler(context)(input) as Record<string, unknown>;
}

class CapturingExecCommandService implements DevShellServicePort {
  readonly runInputs: DevShellRunInput[] = [];
  readonly startInputs: DevProcessStartInput[] = [];
  readonly writeAndReadInputs: DevProcessWriteAndReadInput[] = [];
  readonly readInputs: DevProcessReadInput[] = [];
  readonly stopInputs: DevProcessStopInput[] = [];

  constructor(
    private readonly results: {
      runResult?: DevShellRunResult | undefined;
      startResult?: DevProcessStartResult | undefined;
      writeAndReadResult?: DevProcessWriteAndReadResult | undefined;
      readResult?: DevProcessReadResult | undefined;
      stopResult?: DevProcessStopResult | undefined;
    } = {},
  ) {}

  async runCommand(input: DevShellRunInput): Promise<DevShellRunResult> {
    this.runInputs.push(input);
    return this.results.runResult ?? {
      status: "COMPLETED",
      stdout: "",
      text: "",
      truncated: false,
      exitCode: 0,
    };
  }

  async startProcess(input: DevProcessStartInput): Promise<DevProcessStartResult> {
    this.startInputs.push(input);
    return this.results.startResult ?? {
      processId: "proc-default",
      status: "RUNNING",
      text: "",
      truncated: false,
      cursor: 0,
      nextCursor: 0,
    };
  }

  async writeProcess(_input: DevProcessWriteInput): Promise<DevProcessWriteResult> {
    throw new Error("exec_command must not call writeProcess directly");
  }

  async writeAndReadProcess(input: DevProcessWriteAndReadInput): Promise<DevProcessWriteAndReadResult> {
    this.writeAndReadInputs.push(input);
    return this.results.writeAndReadResult ?? {
      processId: input.processId,
      status: "RUNNING",
      text: "",
      truncated: false,
      cursor: 0,
      nextCursor: 0,
      bytesWritten: input.data.length,
    };
  }

  async readProcess(input: DevProcessReadInput): Promise<DevProcessReadResult> {
    this.readInputs.push(input);
    return this.results.readResult ?? {
      processId: input.processId,
      status: "RUNNING",
      text: "",
      truncated: false,
      cursor: 0,
      nextCursor: 0,
    };
  }

  async stopProcess(input: DevProcessStopInput): Promise<DevProcessStopResult> {
    this.stopInputs.push(input);
    return this.results.stopResult ?? {
      status: "STOPPED",
      text: "",
      truncated: false,
      cursor: 0,
      nextCursor: 0,
    };
  }
}
