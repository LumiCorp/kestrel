import assert from "node:assert/strict";
import test from "node:test";

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
