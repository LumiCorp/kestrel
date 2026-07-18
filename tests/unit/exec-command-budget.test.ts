import test from "node:test";
import assert from "node:assert/strict";

import { applyExternalDeadlineToolBudget } from "../../src/engine/ExecutionEngineSupport.js";

test("exec_command clamps only its observation wait and preserves the absolute timeout", () => {
  const result = applyExternalDeadlineToolBudget({
    toolName: "exec_command",
    input: {
      command: "pnpm test",
      yieldTimeMs: 30_000,
      timeoutMs: 120_000,
    },
    runtimeBudgetRemainingMs: 65_000,
  });

  assert.deepEqual(result.input, {
    command: "pnpm test",
    yieldTimeMs: 5000,
    timeoutMs: 120_000,
  });
  assert.equal(result.shortCircuitResult, undefined);
});

test("exec_command rejects a new observation before dispatch when closeout reserve is exhausted", () => {
  const result = applyExternalDeadlineToolBudget({
    toolName: "exec_command",
    input: { command: "pnpm test" },
    runtimeBudgetRemainingMs: 62_000,
  });

  assert.equal((result.shortCircuitResult as Record<string, unknown>).status, "failed");
  assert.equal(result.metadata.toolDeadlineAdmission, "deadline_exhausted");
});

test("exec_command stop remains available during closeout", () => {
  const input = { sessionId: "proc-1", stop: true };
  const result = applyExternalDeadlineToolBudget({
    toolName: "exec_command",
    input,
    runtimeBudgetRemainingMs: 1,
  });

  assert.equal(result.input, input);
  assert.equal(result.shortCircuitResult, undefined);
});
