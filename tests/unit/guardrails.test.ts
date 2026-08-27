import test from "node:test";
import assert from "node:assert/strict";

import { Guardrails, GuardrailViolationError } from "../../src/engine/Guardrails.js";


test("Guardrails enforce model and tool call limits", () => {
  const guardrails = new Guardrails({
    maxStepsPerRun: 5,
    maxToolCallsPerRun: 1,
    maxModelCallsPerRun: 1,
    maxStepVisits: 2,
    maxConcurrentToolJobsPerRun: 2,
    maxConcurrentToolJobsGlobal: 4,
    maxQueuedToolJobsPerRun: 10,
    toolBatchCheckpointSize: 5,
    toolCallRetryCount: 1,
  });

  guardrails.onStep("alpha");
  guardrails.onToolCall();
  guardrails.onModelCall();

  assert.throws(() => guardrails.onToolCall(), GuardrailViolationError);
  assert.throws(() => guardrails.onModelCall(), GuardrailViolationError);
});

test("Guardrails count model-selected workspace tools, not runtime-internal tools", () => {
  const guardrails = new Guardrails({
    maxStepsPerRun: 5,
    maxToolCallsPerRun: 1,
    maxModelCallsPerRun: 5,
    maxStepVisits: 2,
    maxConcurrentToolJobsPerRun: 2,
    maxConcurrentToolJobsGlobal: 4,
    maxQueuedToolJobsPerRun: 10,
    toolBatchCheckpointSize: 5,
    toolCallRetryCount: 1,
  });

  guardrails.onToolCall("effect_result_lookup");
  guardrails.onToolCall("FinalizeAnswer");
  guardrails.onToolCall("planning.note");

  assert.equal(guardrails.telemetry().toolCalls, 0);

  guardrails.onToolCall("fs.read_text");
  assert.equal(guardrails.telemetry().toolCalls, 1);
  assert.throws(
    () => guardrails.onToolCall("fs.search_text"),
    (error) => error instanceof GuardrailViolationError && error.code === "MAX_TOOL_CALLS_EXCEEDED",
  );
});

test("Guardrails count model-authored effect-dispatched tool calls", () => {
  const guardrails = new Guardrails({
    maxStepsPerRun: 5,
    maxToolCallsPerRun: 1,
    maxModelCallsPerRun: 5,
    maxStepVisits: 2,
    maxConcurrentToolJobsPerRun: 2,
    maxConcurrentToolJobsGlobal: 4,
    maxQueuedToolJobsPerRun: 10,
    toolBatchCheckpointSize: 5,
    toolCallRetryCount: 1,
  });

  guardrails.onEffectToolCall("effect_result_lookup");
  assert.equal(guardrails.telemetry().toolCalls, 0);
  assert.equal(guardrails.telemetry().effectToolCalls, undefined);

  guardrails.onEffectToolCall("exec_command");
  assert.equal(guardrails.telemetry().toolCalls, 1);
  assert.equal(guardrails.telemetry().effectToolCalls, 1);
  assert.throws(
    () => guardrails.onEffectToolCall("fs.read_text"),
    (error) => error instanceof GuardrailViolationError && error.code === "MAX_TOOL_CALLS_EXCEEDED",
  );
});

test("Guardrails count maintenance model calls separately from action calls", () => {
  const guardrails = new Guardrails({
    maxStepsPerRun: 5,
    maxToolCallsPerRun: 5,
    maxModelCallsPerRun: 1,
    maxStepVisits: 2,
    maxMaintenanceModelCallsPerRun: 8,
    maxConcurrentToolJobsPerRun: 2,
    maxConcurrentToolJobsGlobal: 4,
    maxQueuedToolJobsPerRun: 10,
    toolBatchCheckpointSize: 5,
    toolCallRetryCount: 1,
  });

  for (let count = 0; count < 8; count += 1) {
    guardrails.onModelCall("maintenance");
  }
  guardrails.onModelCall("action");

  const telemetry = guardrails.telemetry();
  assert.equal(telemetry.modelCalls, 9);
  assert.equal(telemetry.actionModelCalls, 1);
  assert.equal(telemetry.maintenanceModelCalls, 8);
  assert.throws(
    () => guardrails.onModelCall("action"),
    (error) => error instanceof GuardrailViolationError && error.code === "MAX_MODEL_CALLS_EXCEEDED",
  );
  const telemetryAfterActionRejection = guardrails.telemetry();
  assert.equal(
    telemetryAfterActionRejection.actionModelCalls,
    (telemetry.actionModelCalls ?? 0) + 1,
  );
  assert.equal(
    telemetryAfterActionRejection.modelCalls,
    telemetry.modelCalls + 1,
  );
  assert.ok(telemetryAfterActionRejection.durationMs >= telemetry.durationMs);
  assert.throws(
    () => guardrails.onModelCall("maintenance"),
    (error) =>
      error instanceof GuardrailViolationError && error.code === "MAX_MAINTENANCE_MODEL_CALLS_EXCEEDED",
  );
  const telemetryAfterMaintenanceRejection = guardrails.telemetry();
  assert.deepEqual(
    mutationCounters(telemetryAfterMaintenanceRejection),
    mutationCounters(telemetryAfterActionRejection),
  );
  assert.ok(
    telemetryAfterMaintenanceRejection.durationMs >=
      telemetryAfterActionRejection.durationMs,
  );
});

function mutationCounters(telemetry: ReturnType<Guardrails["telemetry"]>) {
  const { durationMs: _durationMs, ...counters } = telemetry;
  return counters;
}

test("Guardrails leave repeated-step intervention to the loop coordinator", () => {
  const guardrails = new Guardrails({
    maxStepsPerRun: 10,
    maxToolCallsPerRun: 10,
    maxModelCallsPerRun: 10,
    maxStepVisits: 1,
    maxConcurrentToolJobsPerRun: 2,
    maxConcurrentToolJobsGlobal: 4,
    maxQueuedToolJobsPerRun: 10,
    toolBatchCheckpointSize: 5,
    toolCallRetryCount: 1,
  });

  guardrails.onStep("repeat");
  guardrails.onStep("repeat");
  assert.equal(guardrails.telemetry().stepsExecuted, 2);
});

test("Guardrails report finite remaining time from an external deadline", () => {
  const guardrails = new Guardrails(
    {
      maxStepsPerRun: 10,
      maxToolCallsPerRun: 10,
      maxModelCallsPerRun: 10,
      maxConcurrentToolJobsPerRun: 2,
      maxConcurrentToolJobsGlobal: 4,
      maxQueuedToolJobsPerRun: 10,
      toolBatchCheckpointSize: 5,
      toolCallRetryCount: 1,
    },
    undefined,
    { externalDeadlineMs: Date.now() + 60_000 },
  );

  const remainingMs = guardrails.budgetSnapshot().remainingMs;
  assert.ok(remainingMs > 0);
  assert.ok(remainingMs <= 60_000);
  assert.notEqual(remainingMs, Number.MAX_SAFE_INTEGER);
});

test("Guardrails preserve completed model usage, price, and validation rejection evidence", () => {
  const guardrails = new Guardrails({
    maxStepsPerRun: 10,
    maxToolCallsPerRun: 10,
    maxModelCallsPerRun: 10,
    maxConcurrentToolJobsPerRun: 2,
    maxConcurrentToolJobsGlobal: 4,
    maxQueuedToolJobsPerRun: 10,
    toolBatchCheckpointSize: 5,
    toolCallRetryCount: 1,
  });

  guardrails.onModelCall();
  guardrails.onModelUsage({
    inputTokens: 120,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 5,
    outputTokens: 30,
    reasoningTokens: 10,
    totalTokens: 150,
  });
  guardrails.onModelCost(0.0042);
  guardrails.onValidationRejection();

  assert.deepEqual(
    { ...guardrails.telemetry(), durationMs: 0 },
    {
      stepsExecuted: 0,
      toolCalls: 0,
      modelCalls: 1,
      durationMs: 0,
      inputTokens: 120,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 150,
      pricedCostUsd: 0.0042,
      validationRejections: 1,
    },
  );
});

test("Guardrails distinguish exact zero-dollar pricing from unavailable pricing", () => {
  const config = {
    maxStepsPerRun: 10,
    maxToolCallsPerRun: 10,
    maxModelCallsPerRun: 10,
    maxConcurrentToolJobsPerRun: 2,
    maxConcurrentToolJobsGlobal: 4,
    maxQueuedToolJobsPerRun: 10,
    toolBatchCheckpointSize: 5,
    toolCallRetryCount: 1,
  };

  const unpriced = new Guardrails(config);
  unpriced.onModelCost(undefined);
  assert.equal(unpriced.telemetry().pricedCostUsd, undefined);

  const priced = new Guardrails(config);
  priced.onModelCost(0);
  assert.equal(priced.telemetry().pricedCostUsd, 0);
  priced.onModelCost(undefined);
  priced.onModelCost(0);
  assert.equal(priced.telemetry().pricedCostUsd, 0);
  priced.onModelCost(0.0042);
  priced.onModelCost(undefined);
  priced.onModelCost(0.0018);
  assert.equal(priced.telemetry().pricedCostUsd, 0.006);
});
