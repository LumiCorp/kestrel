import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPostToolVerification,
  buildRecoverableToolFailureOutput,
  normalizeEffectResultForTool,
} from "../../agents/reference-react/src/steps/acter/resultShaping.js";
import {
  appendAssistantToolCallsToTranscript,
  appendToolResultToTranscript,
  renderModelTranscriptMessages,
} from "../../src/runtime/modelTranscript.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { buildAgentToolFailedOutputResult } from "../../tools/toolResult.js";

test("failed dev.shell.run output keeps command output and execution context visible", () => {
  const output = buildRecoverableToolFailureOutput({
    toolName: "dev.shell.run",
    toolInput: {
      command: "python -m pytest sympy/printing/tests/test_conventions.py -q",
      cwd: "/testbed",
      workspaceRoot: "/testbed",
    },
    error: createRuntimeFailure("DEV_SHELL_SERVICE_REQUEST_FAILED", "Developer shell service request failed.", {
      recoverable: true,
      command: "python -m pytest sympy/printing/tests/test_conventions.py -q",
      cwd: "/testbed",
      workspaceRoot: "/testbed",
      exitCode: 1,
      text: "/opt/miniconda3/envs/testbed/bin/python: No module named pytest\n",
      stdout: "/opt/miniconda3/envs/testbed/bin/python: No module named pytest\n",
      failureReason: "pytest is not available in this environment.",
      failurePhase: "command",
      commandKind: "multi_line",
      strictModeApplied: true,
      strictModeReason: "multi_line_fail_fast",
    }),
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errorCode, "DEV_SHELL_SERVICE_REQUEST_FAILED");
  assert.equal(output.command, "python -m pytest sympy/printing/tests/test_conventions.py -q");
  assert.equal(output.cwd, "/testbed");
  assert.equal(output.workspaceRoot, "/testbed");
  assert.equal(output.exitCode, 1);
  assert.match(String(output.text), /No module named pytest/u);
  assert.match(String(output.stdout), /No module named pytest/u);
  assert.equal(output.failureReason, "pytest is not available in this environment.");
  assert.equal(output.failurePhase, "command");
  assert.equal(output.commandKind, "multi_line");
  assert.equal(output.strictModeApplied, true);
  assert.equal(output.strictModeReason, "multi_line_fail_fast");
});

test("model transcript renders failed dev.shell.run compactly with failure details visible", () => {
  const toolInput = {
    command: "python -m pytest sympy/printing/tests/test_conventions.py -q",
    cwd: "/testbed",
    workspaceRoot: "/testbed",
  };
  const toolOutput = buildRecoverableToolFailureOutput({
    toolName: "dev.shell.run",
    toolInput,
    error: createRuntimeFailure("DEV_SHELL_SERVICE_REQUEST_FAILED", "Developer shell service request failed.", {
      recoverable: true,
      command: toolInput.command,
      cwd: toolInput.cwd,
      workspaceRoot: toolInput.workspaceRoot,
      exitCode: 1,
      text: "/opt/miniconda3/envs/testbed/bin/python: No module named pytest\n",
      stdout: "/opt/miniconda3/envs/testbed/bin/python: No module named pytest\n",
      stderr: "",
      failureReason: "pytest is not available in this environment.",
      failurePhase: "command",
      commandKind: "multi_line",
      strictModeApplied: true,
      strictModeReason: "multi_line_fail_fast",
    }),
  });
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    toolCalls: [
      {
        id: "call_shell_failed",
        name: "dev.shell.run",
        input: toolInput,
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    toolName: "dev.shell.run",
    toolInput,
    toolOutput,
    toolCallId: "call_shell_failed",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /Tool result: dev\.shell\.run/u);
  assert.match(rendered, /- command: python -m pytest sympy\/printing\/tests\/test_conventions\.py -q/u);
  assert.match(rendered, /- cwd: \/testbed/u);
  assert.match(rendered, /- commandKind: multi_line/u);
  assert.match(rendered, /- status: FAILED/u);
  assert.match(rendered, /- exitCode: 1/u);
  assert.match(rendered, /- errorCode: DEV_SHELL_SERVICE_REQUEST_FAILED/u);
  assert.match(rendered, /- failurePhase: command/u);
  assert.match(rendered, /- failureReason: pytest is not available in this environment\./u);
  assert.match(rendered, /- strictModeReason: multi_line_fail_fast/u);
  assert.match(rendered, /- stdout:\n {2}\/opt\/miniconda3\/envs\/testbed\/bin\/python: No module named pytest/u);
  assert.match(rendered, /Raw output ref: tool-output:[a-f0-9]{16}/u);
  assert.doesNotMatch(rendered, /\nInput:/u);
  assert.doesNotMatch(rendered, /\nOutput:/u);
  assert.doesNotMatch(rendered, /"workspaceRoot"/u);
  assert.doesNotMatch(rendered, /"strictModeApplied": true/u);
  assert.doesNotMatch(rendered, /- text:/u);
});

test("interactive dev.shell.run timeout suggests process APIs in model transcript", () => {
  const toolInput = {
    command: "python3 maze_game.py",
    cwd: "/app",
    workspaceRoot: "/app",
  };
  const toolOutput = buildRecoverableToolFailureOutput({
    toolName: "dev.shell.run",
    toolInput,
    error: createRuntimeFailure("DEV_SHELL_SERVICE_REQUEST_FAILED", "Developer shell service request failed.", {
      recoverable: true,
      command: toolInput.command,
      cwd: toolInput.cwd,
      workspaceRoot: toolInput.workspaceRoot,
      exitCode: 124,
      text: "Welcome to the maze.\nMove? > ",
      stdout: "Welcome to the maze.\nMove? > ",
      stderr: "",
      failureReason: "dev.shell.run timed out after 120000 ms and killed the process.",
      failurePhase: "command",
      commandKind: "single_line",
    }),
  });

  assert.equal(
    toolOutput.nextSuggestedAction,
    "This command is interactive. Restart it with dev.process.start, then use dev.process.write/dev.process.read.",
  );

  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    toolCalls: [
      {
        id: "call_interactive_timeout",
        name: "dev.shell.run",
        input: toolInput,
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    toolName: "dev.shell.run",
    toolInput,
    toolOutput,
    toolCallId: "call_interactive_timeout",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /- exitCode: 124/u);
  assert.match(rendered, /- nextSuggestedAction: This command is interactive\. Restart it with dev\.process\.start, then use dev\.process\.write\/dev\.process\.read\./u);
});

test("model transcript renders running exec_command with session continuation", () => {
  const toolInput = {
    command: "./maze_game.sh",
    cwd: "/app",
  };
  const toolOutput = {
    status: "running",
    sessionId: "tb-proc-1",
    output: "Welcome to the maze.\n> ",
    durationMs: 1002,
    truncated: false,
    cursor: 23,
  };
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    toolCalls: [
      {
        id: "call_exec_running",
        name: "exec_command",
        input: toolInput,
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    toolName: "exec_command",
    toolInput,
    toolOutput,
    toolCallId: "call_exec_running",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /Tool result: exec_command/u);
  assert.match(rendered, /- command: \.\/maze_game\.sh/u);
  assert.match(rendered, /- processId: tb-proc-1/u);
  assert.match(rendered, /- sessionId: tb-proc-1/u);
  assert.match(rendered, /- status: RUNNING/u);
  assert.match(rendered, /- cursor: 23/u);
  assert.match(rendered, /use exec_command with sessionId "tb-proc-1" and stdin to continue it/u);
  assert.match(rendered, /command starts a new independent process/u);
  assert.doesNotMatch(rendered, /dev\.process/u);
});

test("post-tool verification normalizes running exec_command process identity", () => {
  const verification = buildPostToolVerification({
    reactState: {},
    nextCapabilities: {},
    toolName: "exec_command",
    action: {
      kind: "tool",
      name: "exec_command",
      input: {
        command: "./maze_game.sh",
        cwd: "/app",
      },
    },
    output: {
      status: "running",
      sessionId: "tb-proc-1",
      output: "Welcome\n> ",
      durationMs: 1000,
      truncated: false,
      cursor: 10,
    },
  });

  const devShell = verification.devShell as Record<string, unknown>;
  assert.equal(devShell.status, "RUNNING");
  assert.equal(devShell.processId, "tb-proc-1");
  assert.equal(devShell.activeProcessId, "tb-proc-1");
  assert.deepEqual(devShell.liveProcessIds, ["tb-proc-1"]);
  assert.equal(devShell.activeProcessPresent, true);
  assert.equal(devShell.commandLifecycle, "active_streaming");
  assert.equal((devShell.processes as Record<string, Record<string, unknown>>)["tb-proc-1"]?.status, "RUNNING");
});

test("noninteractive dev.shell.run timeout does not suggest process APIs", () => {
  const output = buildRecoverableToolFailureOutput({
    toolName: "dev.shell.run",
    toolInput: {
      command: "sleep 120",
      cwd: "/app",
      workspaceRoot: "/app",
    },
    error: createRuntimeFailure("DEV_SHELL_SERVICE_REQUEST_FAILED", "Developer shell service request failed.", {
      recoverable: true,
      exitCode: 124,
      text: "still running long background work\n",
      stdout: "still running long background work\n",
      failureReason: "dev.shell.run timed out after 120000 ms and killed the process.",
      failurePhase: "command",
    }),
  });

  assert.equal(output.nextSuggestedAction, undefined);
});

test("failed durable tool effects keep nested failure output model-visible", () => {
  const output = normalizeEffectResultForTool({
    toolName: "dev.shell.run",
    toolInput: {
      command: "python -m pytest sympy/printing/tests/test_conventions.py -q -k split_super_sub",
      cwd: "/testbed",
      workspaceRoot: "/testbed",
    },
    effectResult: {
      status: "FAILED",
      error: {
        code: "EFFECT_EXECUTION_FAILED",
        message: "Tool execution failed while collecting shell output.",
        details: {
          recoverable: true,
          output: {
            status: "FAILED",
            exitCode: 1,
            text: "assert split_super_sub(\"w𝟙\") == (\"w\", [], [\"𝟙\"])\n",
            stdout: "assert split_super_sub(\"w𝟙\") == (\"w\", [], [\"𝟙\"])\n",
          },
        },
      },
    },
    collectedOutput: undefined,
  }) as Record<string, unknown>;

  assert.equal(output.status, "FAILED");
  assert.equal(output.errorCode, "EFFECT_EXECUTION_FAILED");
  assert.equal(output.command, "python -m pytest sympy/printing/tests/test_conventions.py -q -k split_super_sub");
  assert.equal(output.exitCode, 1);
  assert.match(String(output.text), /split_super_sub/u);
  assert.match(String(output.stdout), /split_super_sub/u);
});

test("raw failed shell output renders pytest evidence instead of object-string error", () => {
  const toolInput = {
    command: "python -m pytest -q tests/test_build_gettext.py::test_catalog_iter_dedupes_normalized_locations -vv",
    cwd: "/testbed",
    workspaceRoot: "/testbed",
  };
  const failedOutput = {
    status: "FAILED",
    command: toolInput.command,
    cwd: toolInput.cwd,
    workspaceRoot: toolInput.workspaceRoot,
    exitCode: 1,
    text:
      "E       AssertionError: assert [('/testbed/../../manual/modeling/hair.rst', 0)] == [('../../manual/modeling/hair.rst', 0)]\n" +
      "tests/test_build_gettext.py:32: AssertionError\n",
    stdout:
      "E       AssertionError: assert [('/testbed/../../manual/modeling/hair.rst', 0)] == [('../../manual/modeling/hair.rst', 0)]\n" +
      "tests/test_build_gettext.py:32: AssertionError\n",
    stderr: "",
    failureReason: "Strict multi-line shell command failed fast with exit code 1.",
    failurePhase: "command",
    commandKind: "multi_line",
    strictModeReason: "multi_line_fail_fast",
  };
  const toolResult = buildAgentToolFailedOutputResult({
    toolName: "dev.shell.run",
    input: toolInput,
    output: failedOutput,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: { value: "pytest failed" },
    },
  });

  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    toolCalls: [
      {
        id: "call_sphinx_pytest_failed",
        name: "dev.shell.run",
        input: toolInput,
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    toolName: "dev.shell.run",
    toolInput,
    toolOutput: toolResult,
    toolCallId: "call_sphinx_pytest_failed",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /test_catalog_iter_dedupes_normalized_locations/u);
  assert.match(rendered, /AssertionError/u);
  assert.match(rendered, /tests\/test_build_gettext\.py:32/u);
  assert.match(rendered, /- exitCode: 1/u);
  assert.doesNotMatch(rendered, /\[object Object\]/u);
});

test("failed file tool output keeps path and validation details visible", () => {
  const output = buildRecoverableToolFailureOutput({
    toolName: "fs.replace_text",
    toolInput: {
      path: "src/app/page.tsx",
      find: "old",
      replace: "new",
    },
    error: {
      code: "TOOL_INPUT_INVALID",
      message: "Invalid fs.replace_text input.find. Expected non-empty string.",
      details: {
        recoverable: true,
        path: "src/app/page.tsx",
        field: "find",
        expected: "non-empty string",
        validationErrors: [
          {
            instancePath: "/find",
            keyword: "minLength",
            message: "must NOT have fewer than 1 characters",
          },
        ],
      },
    },
  });

  assert.equal(output.path, "src/app/page.tsx");
  assert.equal(output.field, "find");
  assert.equal(output.expected, "non-empty string");
  assert.deepEqual(output.validationErrors, [
    {
      instancePath: "/find",
      keyword: "minLength",
      message: "must NOT have fewer than 1 characters",
    },
  ]);
});

test("model transcript renders failed tool output details instead of a generic failure", () => {
  const toolOutput = buildRecoverableToolFailureOutput({
    toolName: "dev.process.read",
    toolInput: {
      processId: "proc-1",
    },
    error: {
      code: "DEV_PROCESS_READ_FAILED",
      message: "Process read failed.",
      details: {
        processId: "proc-1",
        text: "server crashed on port 3000\n",
        exitCode: 1,
      },
    },
  });
  const transcript = appendToolResultToTranscript({
    transcript: [],
    toolName: "dev.process.read",
    toolInput: { processId: "proc-1" },
    toolOutput,
  });
  const rendered = JSON.stringify(renderModelTranscriptMessages({ transcript }));

  assert.match(rendered, /server crashed on port 3000/u);
  assert.match(rendered, /DEV_PROCESS_READ_FAILED/u);
  assert.match(rendered, /proc-1/u);
});
