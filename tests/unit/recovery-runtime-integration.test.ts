import test from "node:test";
import assert from "node:assert/strict";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { createRecoveryPolicyV1, type RecoveryModelCandidateV1 } from "../../src/kestrel/contracts/recovery.js";
import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import {
  RecoveryModelRegistry,
  RecoveryToolAdapterRegistry,
  RecoveryWorkflowHandlerRegistry,
  createDefaultRecoveryToolResultNormalizers,
  registerDefaultRecoveryWorkflowHandlers,
} from "../../src/engine/recovery/RecoveryRegistries.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { createTestToolGateway } from "../helpers/createTestToolGateway.js";

test("runtime persists recovery evidence and routes to the first compatible pinned model", async () => {
  const primary = modelCandidate("primary", "openai", "primary-model");
  const alternate = modelCandidate("alternate", "anthropic", "alternate-model");
  const policy = createRecoveryPolicyV1({
    policyId: "recovery:runtime-integration",
    primaryModel: primary,
    stages: [
      {
        stageId: "model.retry",
        scope: "model_call",
        failureCodes: ["MODEL_TIMEOUT"],
        action: "retry_same_route",
        maxAttempts: 2,
      },
      {
        stageId: "model.alternate",
        scope: "model_call",
        failureCodes: ["MODEL_TIMEOUT"],
        action: "alternate_model",
        candidates: [alternate],
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
  let primaryCalls = 0;
  let alternateCalls = 0;
  const primaryGateway = new RetryingModelGateway(async () => {
    primaryCalls += 1;
    const error = new Error("primary timeout") as Error & { code: string };
    error.code = "MODEL_TIMEOUT";
    throw error;
  }, { retryCount: 1, timeoutMs: 1000 });
  const alternateGateway: ModelGateway = {
    call: async <T>() => {
      alternateCalls += 1;
      return { summary: "alternate succeeded" } as T;
    },
  };
  const modelRegistry = new RecoveryModelRegistry();
  modelRegistry.register({ candidate: primary, policyRevision: policy.revision, gateway: primaryGateway });
  modelRegistry.register({ candidate: alternate, policyRevision: policy.revision, gateway: alternateGateway });
  const workflowHandlerRegistry = new RecoveryWorkflowHandlerRegistry();
  registerDefaultRecoveryWorkflowHandlers(workflowHandlerRegistry);
  const store = new InMemorySessionStore();
  const events: string[] = [];
  const kestrel = new Kestrel({
    store,
    modelGateway: primaryGateway,
    toolGateway: createTestToolGateway({}),
    runEventListener: (event) => {
      events.push(event.type);
    },
    recoveryRuntime: {
      policy,
      executionProfileFingerprint: "a".repeat(64),
      modelRegistry,
      toolAdapterRegistry: new RecoveryToolAdapterRegistry(),
      toolResultNormalizerRegistry: createDefaultRecoveryToolResultNormalizers(),
      workflowHandlerRegistry,
    },
  });
  kestrel.registerStep("recovery.model", async (_context, io) => {
    const response = await io.useModel<{ summary: string }>({
      input: "recover",
      model: "primary-model",
      metadata: { requestedProvider: "openai", threadId: "thread-1" },
    }) as { summary: string };
    return {
      status: "COMPLETED",
      statePatch: { response: response.summary },
    };
  });

  const output = await kestrel.run({
    id: "event-recovery-runtime",
    type: "user.message",
    sessionId: "session-recovery-runtime",
    stepAgent: "recovery.model",
    payload: {
      message: "recover",
      metadata: { threadId: "thread-1" },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(primaryCalls, 2);
  assert.equal(alternateCalls, 1);
  assert.equal(events.includes("recovery.decision.persisted"), true);
  assert.equal(events.includes("recovery.action.started"), true);
  assert.equal(events.includes("recovery.action.completed"), true);
  assert.equal(events.includes("recovery.action.failed"), true);
});

test("alternate tools are committed as typed effects and traverse normal gateway validation", async () => {
  const primary = modelCandidate("primary", "openai", "primary-model");
  const policy = createRecoveryPolicyV1({
    policyId: "recovery:tool-integration",
    primaryModel: primary,
    stages: [
      {
        stageId: "tool.alternate",
        scope: "tool_call",
        failureCodes: ["SANDBOX_UNAVAILABLE"],
        action: "alternate_tool",
        adapters: [{
          adapterId: "code-to-fallback",
          sourceToolId: "code.execute",
          targetToolId: "fallback.exec",
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
  const modelRegistry = new RecoveryModelRegistry();
  modelRegistry.register({ candidate: primary, policyRevision: policy.revision, gateway });
  const toolAdapterRegistry = new RecoveryToolAdapterRegistry();
  let normalizedResults = 0;
  toolAdapterRegistry.register({
    adapterId: "code-to-fallback",
    sourceToolId: "code.execute",
    targetToolId: "fallback.exec",
    targetAuthority: {
      toolClass: "sandboxed_only",
      capabilities: ["shell.exec"],
      revision: "fallback-authority-v1",
    },
    validateSource: (value) => {
      assert.equal(typeof value, "object");
    },
    transformInput: () => ({ command: "fallback" }),
    normalizeResult: (result) => {
      normalizedResults += 1;
      return result;
    },
  });
  let sourceCalls = 0;
  let targetCalls = 0;
  const toolGateway = createTestToolGateway({
    "code.execute": async () => {
      sourceCalls += 1;
      if (sourceCalls === 1) return { status: "runtime_unavailable" };
      const error = new Error("sandbox unavailable") as Error & { code: string };
      error.code = "SANDBOX_UNAVAILABLE";
      throw error;
    },
    "fallback.exec": async (input) => {
      targetCalls += 1;
      assert.deepEqual(input, { command: "fallback" });
      return { status: "ok" };
    },
  });
  const workflowHandlerRegistry = new RecoveryWorkflowHandlerRegistry();
  registerDefaultRecoveryWorkflowHandlers(workflowHandlerRegistry);
  const events: string[] = [];
  const kestrel = new Kestrel({
    store: new InMemorySessionStore(),
    modelGateway: gateway,
    toolGateway,
    runEventListener: (event) => {
      events.push(event.type);
    },
    recoveryRuntime: {
      policy,
      executionProfileFingerprint: "b".repeat(64),
      modelRegistry,
      toolAdapterRegistry,
      toolResultNormalizerRegistry: createDefaultRecoveryToolResultNormalizers(),
      workflowHandlerRegistry,
    },
  });
  kestrel.registerStep("recovery.tool", async (context, io) => {
    const agent = context.session.state.agent as Record<string, unknown> | undefined;
    if (agent?.recovery !== undefined) {
      return { status: "COMPLETED", statePatch: { recovered: true } };
    }
    await io.useTool!("code.execute", { code: "print('hello')" });
    throw new Error("source tool should have requested a recovery transition");
  });

  const output = await kestrel.run({
    id: "event-recovery-tool",
    type: "user.message",
    sessionId: "session-recovery-tool",
    stepAgent: "recovery.tool",
    payload: { message: "recover tool", metadata: { threadId: "thread-tool" } },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(sourceCalls, 1);
  assert.equal(targetCalls, 1);
  assert.equal(normalizedResults, 1);
  assert.equal(events.includes("recovery.action.completed"), true);

  const thrownFailureOutput = await kestrel.run({
    id: "event-recovery-tool-thrown",
    type: "user.message",
    sessionId: "session-recovery-tool-thrown",
    stepAgent: "recovery.tool",
    payload: { message: "recover thrown tool failure", metadata: { threadId: "thread-tool-thrown" } },
  });
  assert.equal(thrownFailureOutput.status, "COMPLETED", JSON.stringify(thrownFailureOutput));
  assert.equal(sourceCalls, 2);
  assert.equal(targetCalls, 2);
  assert.equal(normalizedResults, 2);
});

test("external-effect recovery waits for a fresh exact approval before committing the target effect", async () => {
  const primary = modelCandidate("primary", "openai", "primary-model");
  const policy = createRecoveryPolicyV1({
    policyId: "recovery:external-tool-integration",
    primaryModel: primary,
    stages: [
      {
        stageId: "tool.external",
        scope: "tool_call",
        failureCodes: ["SANDBOX_UNAVAILABLE"],
        action: "alternate_tool",
        adapters: [{
          adapterId: "code-to-deploy",
          sourceToolId: "code.execute",
          targetToolId: "deploy.execute",
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
  const modelRegistry = new RecoveryModelRegistry();
  modelRegistry.register({ candidate: primary, policyRevision: policy.revision, gateway });
  const toolAdapterRegistry = new RecoveryToolAdapterRegistry();
  toolAdapterRegistry.register({
    adapterId: "code-to-deploy",
    sourceToolId: "code.execute",
    targetToolId: "deploy.execute",
    targetAuthority: {
      toolClass: "external_side_effect",
      capabilities: ["deploy.write"],
      revision: "deploy-authority-v1",
    },
    validateSource: () => {},
    transformInput: () => ({ deploymentId: "deployment-1" }),
    normalizeResult: (result) => result,
  });
  let targetCalls = 0;
  const store = new InMemorySessionStore();
  const events: string[] = [];
  const kestrel = new Kestrel({
    store,
    modelGateway: gateway,
    toolGateway: createTestToolGateway({
      "code.execute": async () => ({ status: "runtime_unavailable" }),
      "deploy.execute": async () => {
        targetCalls += 1;
        return { status: "ok" };
      },
    }),
    runEventListener: (event) => {
      events.push(event.type);
    },
    recoveryRuntime: {
      policy,
      executionProfileFingerprint: "d".repeat(64),
      modelRegistry,
      toolAdapterRegistry,
      toolResultNormalizerRegistry: createDefaultRecoveryToolResultNormalizers(),
      workflowHandlerRegistry: new RecoveryWorkflowHandlerRegistry(),
    },
  });
  kestrel.registerStep("recovery.external", async (context, io) => {
    const agent = context.session.state.agent as Record<string, unknown> | undefined;
    if (agent?.recovery !== undefined) {
      return { status: "COMPLETED", statePatch: { recovered: true } };
    }
    await io.useTool!("code.execute", { code: "deploy()" });
    throw new Error("source tool should have requested approval");
  });

  const waiting = await kestrel.run({
    id: "event-recovery-external",
    type: "user.message",
    sessionId: "session-recovery-external",
    stepAgent: "recovery.external",
    payload: { message: "recover external tool", metadata: { threadId: "thread-external" } },
  });
  assert.equal(waiting.status, "WAITING");
  assert.equal(waiting.waitFor?.kind, "approval");
  assert.equal(targetCalls, 0);
  const approvalId = waiting.waitFor?.metadata?.approvalId;
  const binding = waiting.waitFor?.metadata?.externalApprovalBinding as Record<string, unknown>;
  assert.equal(typeof approvalId, "string");
  assert.equal(binding.actionKey, "deploy.execute");
  assert.equal(events.includes("recovery.waiting"), true);

  const approved = await kestrel.run({
    id: "event-recovery-external-approved",
    type: "user.approval",
    sessionId: "session-recovery-external",
    payload: {
      approvalId,
      userReplyIntent: { kind: "approval_decision", decision: "approve", confidence: "high" },
      metadata: {
        threadId: "thread-external",
        actor: { actorId: "operator-1", actorType: "operator", tenantId: "tenant-1" },
      },
    },
  });
  assert.equal(approved.status, "COMPLETED", JSON.stringify(approved));
  assert.equal(targetCalls, 1);
  assert.equal(events.includes("interaction.resolved"), true);
  assert.equal(events.includes("recovery.action.completed"), true);
});

test("managed recovery review waits durably and exact decline settles RECOVERY_DECLINED", async () => {
  const primary = modelCandidate("primary", "openai", "primary-model");
  const policy = createRecoveryPolicyV1({
    policyId: "recovery:review-integration",
    primaryModel: primary,
    stages: [
      {
        stageId: "run.review",
        scope: "run",
        failureCodes: ["RECOVERY_EXHAUSTED"],
        action: "human_review",
        optionIds: ["retry.primary", "terminal.fail"],
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
  const modelRegistry = new RecoveryModelRegistry();
  modelRegistry.register({ candidate: primary, policyRevision: policy.revision, gateway });
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    modelGateway: gateway,
    toolGateway: createTestToolGateway({}),
    recoveryRuntime: {
      policy,
      executionProfileFingerprint: "c".repeat(64),
      modelRegistry,
      toolAdapterRegistry: new RecoveryToolAdapterRegistry(),
      toolResultNormalizerRegistry: createDefaultRecoveryToolResultNormalizers(),
      workflowHandlerRegistry: new RecoveryWorkflowHandlerRegistry(),
    },
  });
  kestrel.registerStep("recovery.review", async () => {
    const error = new Error("terminal test failure") as Error & { code: string };
    error.code = "UNRECOVERABLE_TEST";
    throw error;
  });

  const waiting = await kestrel.run({
    id: "event-recovery-review",
    type: "user.message",
    sessionId: "session-recovery-review",
    stepAgent: "recovery.review",
    payload: {
      message: "fail",
      metadata: {
        threadId: "thread-review",
        actor: { actorId: "user-1", actorType: "end_user", tenantId: "tenant-1" },
      },
    },
  });
  assert.equal(waiting.status, "WAITING");
  assert.equal(waiting.waitFor?.kind, "user");
  const waitingSession = await store.getSession("session-recovery-review");
  const review = ((waitingSession?.state.agent as Record<string, unknown>)?.recovery as Record<string, unknown>)?.review as Record<string, unknown>;
  const binding = review.binding as Record<string, unknown>;
  assert.equal(binding.expiresAt, undefined);

  const declined = await kestrel.run({
    id: "event-recovery-review-decline",
    type: "user.reply",
    sessionId: "session-recovery-review",
    payload: {
      recoveryOptionId: "terminal.fail",
      metadata: {
        threadId: "thread-review",
        actor: { actorId: "operator-1", actorType: "operator", tenantId: "tenant-1" },
      },
    },
  });
  assert.equal(declined.status, "FAILED");
  assert.equal(declined.errors.some((error) => error.code === "RECOVERY_DECLINED"), true);
});

function modelCandidate(
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
