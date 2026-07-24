import assert from "node:assert/strict";

import type { NormalizedOutput } from "../../src/kestrel/contracts/execution.js";
import { finalizeRuntimeAssistantResponse } from "../../src/runtime/assistantResponseContract.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "finalizeRuntimeAssistantResponse canonicalizes a user reply wait over stale assistant text", () => {
  const result = finalizeRuntimeAssistantResponse({
    output: output("WAITING", {
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: { prompt: "Which workspace should I inspect?" },
      },
    }),
    assistantText: "Waiting for user.reply.",
  });

  assert.equal(result.output.status, "WAITING");
  assert.equal(result.assistantText, "Which workspace should I inspect?");
  assert.deepEqual(result.output.waitFor?.interaction, {
    version: "v1",
    requestId: "request-run-contract",
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Which workspace should I inspect?",
  });
});

contractTest("runtime.hermetic", "finalizeRuntimeAssistantResponse canonicalizes an approval wait over stale assistant text", () => {
  const result = finalizeRuntimeAssistantResponse({
    output: output("WAITING", {
      waitFor: {
        kind: "approval",
        eventType: "user.approval",
        metadata: {
          prompt: "Approve writing package.json?",
          toolCallId: "call-package-json",
          toolName: "fs.write_text",
          toolInput: { path: "package.json" },
        },
      },
    }),
    assistantText: "Tool confirmation pending.",
  });

  assert.equal(result.output.status, "WAITING");
  assert.equal(result.assistantText, "Approve writing package.json?");
  assert.deepEqual(result.output.waitFor?.interaction, {
    version: "v1",
    requestId: "request-run-contract",
    kind: "approval",
    eventType: "user.approval",
    prompt: "Approve writing package.json?",
    approval: {
      toolCallId: "call-package-json",
      toolName: "fs.write_text",
      input: { path: "package.json" },
    },
  });
});

contractTest("runtime.hermetic", "finalizeRuntimeAssistantResponse rejects a user-facing wait without a prompt", () => {
  assert.throws(
    () =>
      finalizeRuntimeAssistantResponse({
        output: output("WAITING", {
          waitFor: { kind: "user", eventType: "user.reply" },
        }),
        assistantText: "Waiting for a reply.",
      }),
    /must provide a non-empty interaction prompt/u,
  );
});

contractTest("runtime.hermetic", "finalizeRuntimeAssistantResponse preserves completed and non-user wait behavior", () => {
  const completed = finalizeRuntimeAssistantResponse({
    output: output("COMPLETED"),
    assistantText: "  Completed response.  ",
  });
  const effectWait = finalizeRuntimeAssistantResponse({
    output: output("WAITING", {
      waitFor: { kind: "effect", eventType: "effect.result.available" },
    }),
    assistantText: "Internal effect status.",
  });

  assert.equal(completed.assistantText, "Completed response.");
  assert.equal(effectWait.assistantText, null);
  assert.equal(effectWait.output.waitFor?.interaction, undefined);
});

function output(
  status: NormalizedOutput["status"],
  overrides: Partial<NormalizedOutput> = {},
): NormalizedOutput {
  return {
    status,
    sessionId: "session-contract",
    runId: "run-contract",
    errors: [],
    quality: {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
    telemetry: {
      stepsExecuted: 1,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 1,
    },
    ...overrides,
  };
}
