import test from "node:test";
import assert from "node:assert/strict";

import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import {
  createRecoveryPolicyV1,
  type RecoveryModelCandidateV1,
} from "../../src/kestrel/contracts/recovery.js";
import { RecoveryCoordinator } from "../../src/engine/recovery/RecoveryCoordinator.js";
import {
  RecoveryModelRegistry,
  RecoveryToolAdapterRegistry,
  RecoveryWorkflowHandlerRegistry,
  createDefaultRecoveryToolResultNormalizers,
} from "../../src/engine/recovery/RecoveryRegistries.js";

test("deterministic recovery chaos covers model regression, sandbox loss, tool removal, and evaluator rejection", async () => {
  const primary = candidate("primary", "openai", "gpt-primary", true);
  const regressed = candidate("regressed", "anthropic", "claude-regressed", false);
  const compatible = candidate("compatible", "openrouter", "compatible-model", true);
  const policy = createRecoveryPolicyV1({
    policyId: "recovery:chaos",
    primaryModel: primary,
    stages: [
      {
        stageId: "model.alternate",
        scope: "model_call",
        failureCodes: ["MODEL_REGRESSION"],
        action: "alternate_model",
        candidates: [regressed, compatible],
      },
      {
        stageId: "tool.alternate",
        scope: "tool_call",
        failureCodes: ["SANDBOX_UNAVAILABLE"],
        action: "alternate_tool",
        adapters: [{
          adapterId: "code-to-shell",
          sourceToolId: "code.execute",
          targetToolId: "dev.exec",
        }],
      },
      {
        stageId: "run.terminal",
        scope: "run",
        failureCodes: ["RECOVERY_EXHAUSTED"],
        action: "terminal_failure",
        terminalCode: "RECOVERY_EXHAUSTED",
      },
    ],
  });
  const gateway: ModelGateway = { call: async <T>() => ({}) as T };
  const models = new RecoveryModelRegistry();
  models.register({ candidate: regressed, policyRevision: policy.revision, gateway });
  models.register({ candidate: compatible, policyRevision: policy.revision, gateway });
  const adapters = new RecoveryToolAdapterRegistry();
  adapters.register({
    adapterId: "code-to-shell",
    sourceToolId: "code.execute",
    targetToolId: "dev.exec",
    targetAuthority: {
      toolClass: "sandboxed_only",
      capabilities: ["shell.exec"],
      revision: "dev-exec-v1",
    },
    validateSource: () => {},
    transformInput: (input) => input,
    normalizeResult: (result) => result,
  });
  const events: string[] = [];
  const coordinator = new RecoveryCoordinator({
    policy,
    executionProfileFingerprint: "b".repeat(64),
    modelRegistry: models,
    toolAdapterRegistry: adapters,
    workflowHandlerRegistry: new RecoveryWorkflowHandlerRegistry(),
    appendLifecycleEvent: async (event) => {
      events.push(event.type);
    },
    createId: (() => {
      let id = 0;
      return () => String(++id);
    })(),
    now: () => new Date("2026-08-03T12:00:00.000Z"),
  });

  const modelRegression = await coordinator.decide(trigger({
    scope: "model_call",
    failureCode: "MODEL_REGRESSION",
    currentModelCandidateId: "primary",
    requirements: {
      visionInput: false,
      toolCalling: true,
      structuredOutput: true,
      reasoningMode: "summary",
    },
  }));
  assert.equal(modelRegression.decision.candidates[0]?.reasonCode, "TOOL_CALLING_INCOMPATIBLE");
  assert.equal(modelRegression.decision.outcome.status, "selected");
  assert.equal(modelRegression.decision.outcome.candidateId, "compatible");

  const sandboxLoss = await coordinator.decide(trigger({
    scope: "tool_call",
    failureCode: createDefaultRecoveryToolResultNormalizers()
      .normalize("code.execute", codeExecuteUnavailable()).failureCode!,
    sourceToolId: "code.execute",
  }));
  assert.equal(sandboxLoss.decision.outcome.action, "alternate_tool");
  assert.equal(sandboxLoss.decision.outcome.candidateId, "code-to-shell");

  const removedToolCoordinator = new RecoveryCoordinator({
    policy,
    executionProfileFingerprint: "b".repeat(64),
    modelRegistry: models,
    toolAdapterRegistry: new RecoveryToolAdapterRegistry(),
    workflowHandlerRegistry: new RecoveryWorkflowHandlerRegistry(),
    appendLifecycleEvent: async () => {},
    createId: () => "removed",
    now: () => new Date("2026-08-03T12:00:00.000Z"),
  });
  const toolRemoval = await removedToolCoordinator.decide(trigger({
    scope: "tool_call",
    failureCode: "SANDBOX_UNAVAILABLE",
    sourceToolId: "code.execute",
  }));
  assert.equal(toolRemoval.decision.outcome.status, "exhausted");
  assert.equal(toolRemoval.decision.candidates[0]?.reasonCode, "ADAPTER_UNREGISTERED");

  const evaluatorRejection = await coordinator.decide(trigger({
    scope: "model_call",
    failureCode: "EVALUATOR_REJECTED",
    currentModelCandidateId: "primary",
    automaticRecoveryBlocked: true,
    blockedReasonCode: "EVALUATOR_REJECTED",
  }));
  assert.equal(evaluatorRejection.decision.outcome.status, "exhausted");
  assert.equal(evaluatorRejection.decision.candidates.some((item) => item.disposition === "selected"), false);
  assert.equal(events.includes("recovery.exhausted"), true);
});

function trigger(overrides: Record<string, unknown>) {
  return {
    runId: "run-chaos",
    sessionId: "session-chaos",
    threadId: "thread-chaos",
    scope: "model_call" as const,
    failureCode: "MODEL_REGRESSION",
    visibleOutputStarted: false,
    budget: { remainingMs: 10_000, tokensUsed: 100, toolCallsUsed: 1 },
    ...overrides,
  } as Parameters<RecoveryCoordinator["decide"]>[0];
}

function candidate(
  candidateId: string,
  provider: RecoveryModelCandidateV1["provider"],
  model: string,
  toolCallingEnabled: boolean,
): RecoveryModelCandidateV1 {
  return {
    candidateId,
    provider,
    model,
    capabilities: {
      visionInputEnabled: false,
      toolCallingEnabled,
      structuredOutputEnabled: true,
      reasoningModes: ["off", "summary"],
    },
  };
}

function codeExecuteUnavailable() {
  return {
    toolName: "code.execute",
    status: "OK" as const,
    modelContext: { text: "", rawOutputRef: "chaos", truncated: false },
    auditRecord: {
      toolName: "code.execute",
      input: {},
      output: { status: "runtime_unavailable" },
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      durationMs: 1000,
      status: "OK" as const,
    },
  };
}
