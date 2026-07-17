import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentToolFailedOutputResult,
  buildAgentToolSuccessResult,
  isAgentToolResult,
  runAgentTool,
} from "../../tools/toolResult.js";
import {
  RunCancelledError,
  createRuntimeFailure,
} from "../../src/runtime/RuntimeFailure.js";

test("runAgentTool wraps successful output in model context and audit evidence", async () => {
  const result = await runAgentTool({
    toolName: "fs.read_text",
    toolInput: { path: "README.md" },
    handler: async () => ({
      status: "OK",
      path: "README.md",
      content: "hello\n",
      encoding: "utf8",
    }),
  });

  assert.equal(result.toolName, "fs.read_text");
  assert.equal(result.status, "OK");
  assert.match(result.modelContext.text, /^Tool result: fs\.read_text/u);
  assert.match(result.modelContext.text, /- path: README\.md/u);
  assert.match(result.modelContext.text, /- contentBytes: 6/u);
  assert.match(result.modelContext.text, /Raw output ref: tool-output:[a-f0-9]{16}/u);
  assert.equal(result.modelContext.rawOutputRef, result.modelContext.text.match(/tool-output:[a-f0-9]{16}/u)?.[0]);
  assert.equal(result.auditRecord.toolName, "fs.read_text");
  assert.deepEqual(result.auditRecord.input, { path: "README.md" });
  assert.equal((result.auditRecord.output as { content?: string }).content, "hello\n");
  assert.equal(result.auditRecord.status, "OK");
  assert.equal(typeof result.auditRecord.startedAt, "string");
  assert.equal(typeof result.auditRecord.completedAt, "string");
  assert.equal(typeof result.auditRecord.durationMs, "number");
});

test("runAgentTool returns FAILED envelope for recoverable runtime failures", async () => {
  const result = await runAgentTool({
    toolName: "dev.shell.run",
    toolInput: { command: "pytest -q", cwd: "/testbed" },
    handler: async () => {
      throw createRuntimeFailure("DEV_SHELL_SERVICE_REQUEST_FAILED", "shell failed", {
        recoverable: true,
        command: "pytest -q",
        cwd: "/testbed",
        exitCode: 1,
        stdout: "failed output\n",
        stderr: "traceback\n",
        failureReason: "tests failed",
      });
    },
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.auditRecord.status, "FAILED");
  assert.equal((result.auditRecord.error as { code?: string }).code, "DEV_SHELL_SERVICE_REQUEST_FAILED");
  assert.match(result.modelContext.text, /- command: pytest -q/u);
  assert.match(result.modelContext.text, /- cwd: \/testbed/u);
  assert.match(result.modelContext.text, /- exitCode: 1/u);
  assert.match(result.modelContext.text, /- failureReason: tests failed/u);
  assert.match(result.modelContext.text, /- stdout:\n {2}failed output/u);
  assert.match(result.modelContext.text, /- stderr:\n {2}traceback/u);
});

test("runAgentTool preserves nested output from plain object failures", async () => {
  const result = await runAgentTool({
    toolName: "dev.shell.run",
    toolInput: { command: "pytest -q", cwd: "/testbed" },
    handler: async () => {
      throw {
        code: "TOOL_EXECUTION_FAILED",
        message: { text: "pytest failed" },
        output: {
          status: "FAILED",
          command: "pytest -q",
          cwd: "/testbed",
          exitCode: 1,
          stdout: "assert 1 == 2\n",
          stderr: "Traceback\n",
          text: "assert 1 == 2\nTraceback\n",
          failureReason: "tests failed",
        },
      };
    },
  });

  assert.equal(result.status, "FAILED");
  assert.equal((result.auditRecord.error as { message?: unknown }).message, "Tool execution failed.");
  assert.match(result.modelContext.text, /- command: pytest -q/u);
  assert.match(result.modelContext.text, /- cwd: \/testbed/u);
  assert.match(result.modelContext.text, /- exitCode: 1/u);
  assert.match(result.modelContext.text, /- failureReason: tests failed/u);
  assert.match(result.modelContext.text, /- stdout:\n {2}assert 1 == 2/u);
  assert.match(result.modelContext.text, /- stderr:\n {2}Traceback/u);
  assert.doesNotMatch(result.modelContext.text, /\[object Object\]/u);
});

test("buildAgentToolFailedOutputResult preserves raw failed shell output", () => {
  const failedOutput = {
    status: "FAILED",
    command: "python -m pytest -q tests/test_build_gettext.py::test_catalog_iter_dedupes_normalized_locations -vv",
    cwd: "/testbed",
    exitCode: 1,
    text: "E       AssertionError: assert [('/testbed/...hair.rst', 0)] == [('../../manual/...hair.rst', 0)]\n",
    stdout: "E       AssertionError: assert [('/testbed/...hair.rst', 0)] == [('../../manual/...hair.rst', 0)]\n",
    stderr: "",
    failureReason: "Strict multi-line shell command failed fast with exit code 1.",
    failurePhase: "command",
  };

  const result = buildAgentToolFailedOutputResult({
    toolName: "dev.shell.run",
    input: {
      command: failedOutput.command,
      cwd: failedOutput.cwd,
    },
    output: failedOutput,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: "[object Object]",
    },
  });

  assert.equal(result.status, "FAILED");
  assert.deepEqual(result.auditRecord.output, failedOutput);
  assert.match(result.modelContext.text, /AssertionError/u);
  assert.match(result.modelContext.text, /- exitCode: 1/u);
  assert.doesNotMatch(result.modelContext.text, /\[object Object\]/u);
});

test("runAgentTool rethrows cancellation and nonrecoverable runtime failures", async () => {
  await assert.rejects(
    () => runAgentTool({
      toolName: "dev.shell.run",
      toolInput: { command: "sleep 10" },
      handler: async () => {
        throw new RunCancelledError();
      },
    }),
    RunCancelledError,
  );

  await assert.rejects(
    () => runAgentTool({
      toolName: "fs.write_text",
      toolInput: { path: "x.txt" },
      handler: async () => {
        throw createRuntimeFailure("SOURCE_WRITE_FORBIDDEN", "blocked", {
          recoverable: false,
        });
      },
    }),
    /blocked/u,
  );
});

test("generic fallback envelopes unknown dynamic tool shapes", () => {
  const result = buildAgentToolSuccessResult({
    toolName: "mcp.remote.lookup",
    input: { q: "hello" },
    output: {
      ok: true,
      title: "Remote result",
      nested: { ignoredInSummary: true },
    },
  });

  assert.equal(isAgentToolResult(result), true);
  assert.match(result.modelContext.text, /Tool result: mcp\.remote\.lookup/u);
  assert.match(result.modelContext.text, /- status: OK/u);
  assert.match(result.modelContext.text, /- ok: true/u);
  assert.match(result.modelContext.text, /- title: Remote result/u);
  assert.doesNotMatch(result.modelContext.text, /\nInput:/u);
  assert.doesNotMatch(result.modelContext.text, /\nOutput:/u);
  assert.deepEqual(result.auditRecord.output, {
    ok: true,
    title: "Remote result",
    nested: { ignoredInSummary: true },
  });
});
