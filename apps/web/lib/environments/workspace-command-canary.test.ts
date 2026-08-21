import test from "node:test";
import assert from "node:assert/strict";

import { hasCompletedExecCommandCanaryProof } from "./workspace-command-canary";

test("workspace command canary requires a completed OK exec_command record containing the marker", () => {
  const marker = "kestrel-command-canary-123";
  const messages = [{
    role: "assistant",
    metadata: { kestrelTurnId: "turn-1" },
    parts: [{
      type: "data-kestrel-tool",
      data: {
        toolName: "exec_command",
        phase: "completed",
        output: {
          status: "OK",
          auditRecord: { output: { status: "completed", exitCode: 0, output: marker } },
        },
      },
    }],
  }];

  assert.equal(hasCompletedExecCommandCanaryProof(messages, "turn-1", marker), true);
  assert.equal(hasCompletedExecCommandCanaryProof(messages, "other-turn", marker), false);
  assert.equal(hasCompletedExecCommandCanaryProof(messages, "turn-1", "other-marker"), false);
  assert.equal(
    hasCompletedExecCommandCanaryProof([{
      ...messages[0],
      parts: [{
        type: "data-kestrel-tool",
        data: {
          toolName: "exec_command",
          phase: "completed",
          output: { status: "FAILED", auditRecord: { output: { text: marker } } },
        },
      }],
    }], "turn-1", marker),
    false,
  );
  assert.equal(
    hasCompletedExecCommandCanaryProof([{
      ...messages[0],
      parts: [{
        type: "data-kestrel-tool",
        data: {
          toolName: "exec_command",
          phase: "completed",
          output: {
            status: "OK",
            auditRecord: {
              output: { status: "failed", exitCode: 126 },
              modelContext: { command: `printf ${marker}` },
            },
          },
        },
      }],
    }], "turn-1", marker),
    false,
  );
  assert.equal(
    hasCompletedExecCommandCanaryProof([{
      ...messages[0],
      parts: [{ type: "text", text: `The command succeeded: ${marker}` }],
    }], "turn-1", marker),
    false,
  );
});

test("workspace command canary accepts the persisted direct runtime output shape", () => {
  const marker = "kestrel-command-canary-runtime";
  const message = {
    role: "assistant",
    metadata: { kestrelTurnId: "turn-runtime" },
    parts: [{
      type: "data-kestrel-tool",
      data: {
        toolName: "exec_command",
        phase: "completed",
        output: {
          status: "completed",
          exitCode: 0,
          output: marker,
          command: `printf '%s' '${marker}'`,
        },
      },
    }],
  };

  assert.equal(
    hasCompletedExecCommandCanaryProof([message], "turn-runtime", marker),
    true,
  );
  assert.equal(
    hasCompletedExecCommandCanaryProof([{
      ...message,
      parts: [{
        type: "data-kestrel-tool",
        data: {
          toolName: "exec_command",
          phase: "completed",
          output: { status: "completed", exitCode: 1, output: marker },
        },
      }],
    }], "turn-runtime", marker),
    false,
  );
});
