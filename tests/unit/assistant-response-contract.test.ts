import test from "node:test";
import assert from "node:assert/strict";

import type { NormalizedOutput } from "../../src/kestrel/contracts/execution.js";
import { enforceRuntimeAssistantResponseBoundary, finalizeRuntimeAssistantResponse } from "../../src/runtime/assistantResponseContract.js";
import { ExecutionBoundaryPolicyRuntime } from "../../src/security/ExecutionBoundaryPolicy.js";

test("finalizeRuntimeAssistantResponse canonicalizes a user reply wait over stale assistant text", () => {
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

test("finalizeRuntimeAssistantResponse canonicalizes an approval wait over stale assistant text", () => {
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

test("finalizeRuntimeAssistantResponse rejects a user-facing wait without a prompt", () => {
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

test("finalizeRuntimeAssistantResponse preserves completed and non-user wait behavior", () => {
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

test("assistant response boundary redacts registered values before durable output", async () => {
  const runtime = new ExecutionBoundaryPolicyRuntime();
  runtime.sensitiveValues.register({
    reference: {
      referenceId: "credential:assistant",
      kind: "credential",
      scope: "test",
    },
    value: "assistant-secret",
  });
  const persisted: unknown[] = [];
  const result = await enforceRuntimeAssistantResponseBoundary({
    output: output("COMPLETED"),
    assistantText: "The value is assistant-secret.",
    executionBoundaryRuntime: runtime,
    persist: (decision) => {
      persisted.push(decision);
    },
  });
  assert.equal(result.assistantText, "The value is [REDACTED].");
  assert.equal(persisted.length, 1);
  assert.equal(JSON.stringify(persisted).includes("assistant-secret"), false);
});

test("assistant output does not settle before its boundary decision persists", async () => {
  const runtime = new ExecutionBoundaryPolicyRuntime();
  let releasePersistence: (() => void) | undefined;
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let settled = false;
  const pending = enforceRuntimeAssistantResponseBoundary({
    output: output("COMPLETED"),
    assistantText: "Safe response.",
    executionBoundaryRuntime: runtime,
    persist: () => persistenceGate,
  }).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  releasePersistence?.();
  await pending;
  assert.equal(settled, true);
});

test("assistant response reuses an exact persisted evaluation boundary decision", async () => {
  const runtime = new ExecutionBoundaryPolicyRuntime();
  const persistedDecision = runtime.evaluate({
    boundary: "assistant_output",
    identity: { runId: "run-contract", sessionId: "session-contract" },
    source: "runtime",
    trust: "data",
    sourceId: "evaluation-candidate:run-contract:1",
    value: { assistantText: "Safe response." },
  }).decision;
  let newPersistenceCalls = 0;
  const reused = await enforceRuntimeAssistantResponseBoundary({
    output: output("COMPLETED"),
    assistantText: "Safe response.",
    persistedAssistantOutputDecision: persistedDecision,
    executionBoundaryRuntime: runtime,
    persist: () => {
      newPersistenceCalls += 1;
    },
  });
  assert.equal(reused.assistantText, "Safe response.");
  assert.equal(newPersistenceCalls, 0);

  await enforceRuntimeAssistantResponseBoundary({
    output: output("COMPLETED"),
    assistantText: "Changed response.",
    persistedAssistantOutputDecision: persistedDecision,
    executionBoundaryRuntime: runtime,
    persist: () => {
      newPersistenceCalls += 1;
    },
  });
  assert.equal(newPersistenceCalls, 1);
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
