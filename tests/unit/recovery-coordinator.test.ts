import test from "node:test";
import assert from "node:assert/strict";

import {
  createRecoveryPolicyV1,
  type RecoveryModelCandidateV1,
} from "../../src/kestrel/contracts/recovery.js";
import type { AgentToolResult, ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import {
  RecoveryCoordinator,
  createRecoveryExternalApprovalBinding,
  createRecoveryExternalAuthorityRevision,
  normalizeRecoveryFailureCode,
} from "../../src/engine/recovery/RecoveryCoordinator.js";
import {
  RecoveryModelRegistry,
  RecoveryToolAdapterRegistry,
  RecoveryWorkflowHandlerRegistry,
  createDefaultRecoveryToolResultNormalizers,
} from "../../src/engine/recovery/RecoveryRegistries.js";

const primary = candidate("primary", "openai", "gpt-primary");
const alternateA: RecoveryModelCandidateV1 = {
  ...candidate("alternate-a", "anthropic", "claude-a"),
  credentialReference: {
    source: "kestrel-one",
    runId: "run-1",
    gatewayId: "gateway-a",
    organizationId: "org-1",
    environmentId: "env-1",
    rawModelId: "claude-a",
    provider: "anthropic",
  },
};
const alternateB = candidate("alternate-b", "openrouter", "model-b");

function candidate(
  candidateId: string,
  provider: RecoveryModelCandidateV1["provider"],
  model: string,
): RecoveryModelCandidateV1 {
  return {
    candidateId,
    provider,
    model,
    capabilities: {
      visionInputEnabled: false,
      toolCallingEnabled: true,
      structuredOutputEnabled: true,
      reasoningModes: ["off", "summary"],
    },
  };
}

function policy(reviewTimeoutMs?: number) {
  return createRecoveryPolicyV1({
    policyId: "recovery:runtime-test",
    primaryModel: primary,
    stages: [
      {
        stageId: "model.retry",
        scope: "model_call",
        failureCodes: ["MODEL_TIMEOUT"],
        action: "retry_same_route",
        maxAttempts: 3,
      },
      {
        stageId: "model.alternate",
        scope: "model_call",
        failureCodes: ["MODEL_TIMEOUT"],
        action: "alternate_model",
        candidates: [alternateA, alternateB],
      },
      {
        stageId: "tool.alternate",
        scope: "tool_call",
        failureCodes: ["SANDBOX_UNAVAILABLE", "SANDBOX_TIMEOUT"],
        action: "alternate_tool",
        adapters: [{ adapterId: "code-to-shell", sourceToolId: "code.execute", targetToolId: "dev.exec" }],
      },
      {
        stageId: "run.workflow",
        scope: "run",
        failureCodes: ["NO_PROGRESS_REASONING_LOOP"],
        action: "deterministic_workflow",
        handlerIds: ["run.loop_recovery"],
      },
      {
        stageId: "run.review",
        scope: "run",
        failureCodes: ["RECOVERY_EXHAUSTED"],
        action: "human_review",
        optionIds: ["retry.primary", "terminal.fail"],
        ...(reviewTimeoutMs !== undefined ? { timeoutMs: reviewTimeoutMs } : {}),
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
}

function harness(input: {
  registerAlternateA?: boolean;
  registerAlternateB?: boolean;
  registerAdapter?: boolean;
  registerWorkflow?: boolean;
  credentialValid?: boolean;
  reviewTimeoutMs?: number;
} = {}) {
  const recoveryPolicy = policy(input.reviewTimeoutMs);
  const modelRegistry = new RecoveryModelRegistry();
  const gateway: ModelGateway = { call: async <T>() => undefined as T };
  if (input.registerAlternateA !== false) {
    modelRegistry.register({ candidate: alternateA, policyRevision: recoveryPolicy.revision, gateway });
  }
  if (input.registerAlternateB !== false) {
    modelRegistry.register({ candidate: alternateB, policyRevision: recoveryPolicy.revision, gateway });
  }
  const toolAdapterRegistry = new RecoveryToolAdapterRegistry();
  if (input.registerAdapter === true) {
    toolAdapterRegistry.register({
      adapterId: "code-to-shell",
      sourceToolId: "code.execute",
      targetToolId: "dev.exec",
      targetAuthority: {
        toolClass: "sandboxed_only",
        capabilities: ["shell.exec"],
        revision: "tool-authority-v1",
      },
      validateSource: () => {},
      transformInput: (value) => value,
      normalizeResult: (result) => result,
    });
  }
  const workflowHandlerRegistry = new RecoveryWorkflowHandlerRegistry();
  if (input.registerWorkflow === true) {
    workflowHandlerRegistry.register("run.loop_recovery", async () => "handled");
  }
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  let nextId = 0;
  const coordinator = new RecoveryCoordinator({
    policy: recoveryPolicy,
    executionProfileFingerprint: "a".repeat(64),
    modelRegistry,
    toolAdapterRegistry,
    workflowHandlerRegistry,
    appendLifecycleEvent: async (event) => {
      events.push({ type: event.type, metadata: event.metadata });
    },
    validateCredential: () => input.credentialValid !== false,
    now: () => new Date("2026-08-03T12:00:00.000Z"),
    createId: () => String(++nextId),
  });
  return { coordinator, events, recoveryPolicy };
}

function trigger(overrides: Partial<Parameters<RecoveryCoordinator["decide"]>[0]> = {}) {
  return {
    runId: "run-1",
    sessionId: "session-1",
    threadId: "thread-1",
    scope: "model_call" as const,
    failureCode: "MODEL_TIMEOUT",
    visibleOutputStarted: false,
    attempt: 1,
    currentModelCandidateId: "primary",
    budget: { remainingMs: 10_000, tokensUsed: 20, toolCallsUsed: 1 },
    requirements: {
      visionInput: false,
      toolCalling: true,
      structuredOutput: true,
      reasoningMode: "summary" as const,
    },
    ...overrides,
  };
}

test("RecoveryCoordinator authorizes same-route retry within the authored attempt bound", async () => {
  const { coordinator, events } = harness();
  const selection = await coordinator.decide(trigger({ attempt: 1 }));
  assert.deepEqual(selection.decision.outcome, {
    status: "selected",
    action: "retry_same_route",
    stageId: "model.retry",
    candidateId: "primary",
  });
  assert.equal(events[0]?.type, "recovery.decision.persisted");
});

test("RecoveryCoordinator selects registered alternate models in declared order", async () => {
  const { coordinator } = harness();
  const selection = await coordinator.decide(trigger({ attempt: 3 }));
  assert.equal(selection.decision.outcome.status, "selected");
  assert.equal(selection.decision.outcome.action, "alternate_model");
  assert.equal(selection.decision.outcome.candidateId, "alternate-a");
  assert.deepEqual(
    selection.decision.candidates.map(({ candidateId, disposition }) => ({ candidateId, disposition })),
    [
      { candidateId: "primary", disposition: "rejected" },
      { candidateId: "alternate-a", disposition: "selected" },
      { candidateId: "alternate-b", disposition: "skipped" },
    ],
  );
});

test("RecoveryCoordinator rejects unregistered and incompatible candidates before using the next pin", async () => {
  const { coordinator } = harness({ registerAlternateA: false });
  const alternateBWithVision = await coordinator.decide(trigger({
    attempt: 3,
    requirements: {
      visionInput: false,
      toolCalling: true,
      structuredOutput: true,
      reasoningMode: "summary",
    },
  }));
  assert.equal(alternateBWithVision.decision.outcome.status, "selected");
  assert.equal(alternateBWithVision.decision.outcome.candidateId, "alternate-b");
  assert.equal(alternateBWithVision.decision.candidates[1]?.reasonCode, "CANDIDATE_UNREGISTERED_OR_STALE");

  const exhausted = await coordinator.decide(trigger({
    attempt: 3,
    requirements: {
      visionInput: true,
      toolCalling: true,
      structuredOutput: true,
      reasoningMode: "summary",
    },
  }));
  assert.equal(exhausted.decision.outcome.status, "exhausted");
  assert.equal(exhausted.decision.compatibility?.status, "incompatible");
});

test("RecoveryCoordinator rejects credential-invalid pins before selecting the next declared candidate", async () => {
  const { coordinator } = harness({ credentialValid: false });
  const selection = await coordinator.decide(trigger({ attempt: 3 }));
  assert.equal(selection.decision.outcome.status, "selected");
  assert.equal(selection.decision.outcome.candidateId, "alternate-b");
  assert.equal(selection.decision.candidates[1]?.reasonCode, "CREDENTIAL_INVALID");
});

test("RecoveryCoordinator blocks route changes after visible output, cancellation, stale policy, or exhausted budget", async () => {
  for (const override of [
    { visibleOutputStarted: true },
    { automaticRecoveryBlocked: true, blockedReasonCode: "run_cancelled" },
    { expectedPolicyRevision: "sha256:" + "b".repeat(64) },
    { budget: { remainingMs: 0, tokensUsed: 20, toolCallsUsed: 1 } },
  ]) {
    const { coordinator } = harness();
    const selection = await coordinator.decide(trigger({ attempt: 3, ...override }));
    assert.equal(selection.decision.outcome.status, "exhausted");
    assert.equal(
      selection.decision.candidates.some((item) => item.disposition === "selected"),
      false,
    );
  }
});

test("RecoveryCoordinator tool adapters and workflow handlers fail closed when absent", async () => {
  const missing = harness();
  const tool = await missing.coordinator.decide(trigger({
    scope: "tool_call",
    failureCode: "SANDBOX_UNAVAILABLE",
    sourceToolId: "code.execute",
    attempt: undefined,
  }));
  assert.equal(tool.decision.outcome.status, "exhausted");
  assert.equal(tool.decision.candidates[0]?.reasonCode, "ADAPTER_UNREGISTERED");

  const registered = harness({ registerAdapter: true, registerWorkflow: true });
  const adapter = await registered.coordinator.decide(trigger({
    scope: "tool_call",
    failureCode: "SANDBOX_TIMEOUT",
    sourceToolId: "code.execute",
    attempt: undefined,
  }));
  assert.equal(adapter.decision.outcome.action, "alternate_tool");
  const workflow = await registered.coordinator.decide(trigger({
    scope: "run",
    failureCode: "NO_PROGRESS_REASONING_LOOP",
    attempt: undefined,
  }));
  assert.equal(workflow.decision.outcome.action, "deterministic_workflow");
});

test("RecoveryCoordinator creates durable review binding and validates exact resume authority", async () => {
  const { coordinator } = harness();
  const selection = await coordinator.decide(trigger({
    scope: "run",
    failureCode: "RECOVERY_EXHAUSTED",
    attempt: undefined,
  }));
  assert.equal(selection.decision.outcome.status, "waiting");
  assert.ok(selection.reviewBinding);
  assert.equal(selection.reviewBinding.expiresAt, undefined);
  assert.equal(coordinator.validateReviewResume({
    binding: selection.reviewBinding,
    decision: selection.decision,
    threadId: "thread-1",
    runId: "run-1",
    optionId: "retry.primary",
    actor: { actorId: "operator-1", actorType: "operator", tenantId: "tenant-1" },
    expectedTenantId: "tenant-1",
  }), "approved");
  assert.equal(coordinator.validateReviewResume({
    binding: selection.reviewBinding,
    decision: selection.decision,
    threadId: "thread-1",
    runId: "run-1",
    optionId: "terminal.fail",
    actor: { actorId: "operator-1", actorType: "operator" },
  }), "declined");
  assert.throws(() => coordinator.validateReviewResume({
    binding: selection.reviewBinding!,
    decision: selection.decision,
    threadId: "other-thread",
    runId: "run-1",
    optionId: "retry.primary",
    actor: { actorId: "operator-1", actorType: "operator" },
  }), /RECOVERY_REVIEW_STALE/u);
  assert.throws(() => coordinator.validateReviewResume({
    binding: selection.reviewBinding!,
    decision: selection.decision,
    threadId: "thread-1",
    runId: "run-1",
    optionId: "retry.primary",
    actor: { actorId: "service-1", actorType: "service" },
  }), /RECOVERY_ACTOR_INVALID/u);
  assert.throws(() => coordinator.validateReviewResume({
    binding: selection.reviewBinding!,
    decision: selection.decision,
    threadId: "thread-1",
    runId: "run-1",
    optionId: "retry.primary",
    actor: { actorId: "operator-1", actorType: "operator", tenantId: "other-tenant" },
    expectedTenantId: "tenant-1",
  }), /RECOVERY_TENANT_MISMATCH/u);
});

test("authored recovery review expiry fails closed with RECOVERY_WAIT_EXPIRED", async () => {
  const { coordinator } = harness({ reviewTimeoutMs: 1000 });
  const selection = await coordinator.decide(trigger({
    scope: "run",
    failureCode: "RECOVERY_EXHAUSTED",
    attempt: undefined,
  }));
  assert.ok(selection.reviewBinding?.expiresAt);
  assert.throws(() => coordinator.validateReviewResume({
    binding: selection.reviewBinding!,
    decision: selection.decision,
    threadId: "thread-1",
    runId: "run-1",
    optionId: "retry.primary",
    actor: { actorId: "operator-1", actorType: "operator" },
    now: new Date("2026-08-03T12:00:02.000Z"),
  }), /RECOVERY_WAIT_EXPIRED/u);
});

test("registered code.execute normalizer uses the output contract statuses", () => {
  const registry = createDefaultRecoveryToolResultNormalizers();
  assert.deepEqual(registry.normalize("code.execute", toolResult("runtime_unavailable")), {
    status: "failure",
    failureCode: "SANDBOX_UNAVAILABLE",
  });
  assert.deepEqual(registry.normalize("code.execute", toolResult("timeout")), {
    status: "failure",
    failureCode: "SANDBOX_TIMEOUT",
  });
  assert.deepEqual(registry.normalize("code.execute", toolResult("ok")), { status: "success" });
  const failed = toolResult("error");
  failed.status = "FAILED";
  failed.auditRecord.status = "FAILED";
  failed.auditRecord.error = { code: "SANDBOX_UNAVAILABLE", message: "sandbox unavailable" };
  assert.deepEqual(registry.normalize("code.execute", failed), {
    status: "failure",
    failureCode: "SANDBOX_UNAVAILABLE",
  });
});

test("normalization and external approval authority revisions are exact and deterministic", () => {
  assert.equal(normalizeRecoveryFailureCode("IO_MODEL_TIMEOUT"), "MODEL_TIMEOUT");
  const first = createRecoveryExternalAuthorityRevision({
    targetToolAuthority: { toolId: "dev.exec", capabilities: ["shell.exec"] },
    recoveryPolicyRevision: "sha256:" + "a".repeat(64),
    adapterId: "code-to-shell",
  });
  const second = createRecoveryExternalAuthorityRevision({
    adapterId: "code-to-shell",
    recoveryPolicyRevision: "sha256:" + "a".repeat(64),
    targetToolAuthority: { capabilities: ["shell.exec"], toolId: "dev.exec" },
  });
  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/u);
});

test("external-effect recovery creates a fresh action-bound approval binding", async () => {
  const { coordinator } = harness({ registerAdapter: true });
  const selection = await coordinator.decide(trigger({
    scope: "tool_call",
    failureCode: "SANDBOX_UNAVAILABLE",
    sourceToolId: "code.execute",
    attempt: undefined,
  }));
  const adapter = {
    adapterId: "code-to-shell",
    sourceToolId: "code.execute",
    targetToolId: "dev.exec",
    targetAuthority: {
      toolClass: "external_side_effect" as const,
      capabilities: ["deploy.write"],
      revision: "deploy-authority-v2",
    },
    validateSource: () => {},
    transformInput: (value: unknown) => value,
    normalizeResult: (result: AgentToolResult) => result,
  };
  const binding = createRecoveryExternalApprovalBinding({
    decision: selection.decision,
    adapter,
    threadId: "thread-1",
    targetInput: { deploymentId: "deploy-1" },
    requestedAt: new Date("2026-08-03T12:00:00.000Z"),
    approvalId: "recovery-approval-1",
  });
  assert.ok(binding);
  assert.equal(binding.approvalId, "recovery-approval-1");
  assert.equal(binding.runId, "run-1");
  assert.equal(binding.actionKey, "dev.exec");
  assert.match(binding.payloadHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(binding.authorityRevision, /^sha256:[0-9a-f]{64}$/u);
});

function toolResult(status: string): AgentToolResult {
  return {
    toolName: "code.execute",
    status: "OK",
    modelContext: { text: "", rawOutputRef: "ref", truncated: false },
    auditRecord: {
      toolName: "code.execute",
      input: {},
      output: { status },
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      durationMs: 1000,
      status: "OK",
    },
  };
}
