import test from "node:test";
import assert from "node:assert/strict";

import { InlineEffectRunner } from "../../src/effects/EffectRunner.js";
import { EffectRegistry } from "../../src/effects/EffectRegistry.js";
import { Kestrel } from "../../src/kestrel/Kestrel.js";
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
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { AllowlistedToolGateway } from "../../src/io/ToolGateway.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

test("recovery interruption before decision persistence or action start fails closed", async () => {
  const primary = candidate("primary", "openai", "gpt-primary");
  const policy = createRecoveryPolicyV1({
    policyId: "recovery:interruption-order",
    primaryModel: primary,
    stages: [
      {
        stageId: "model.retry",
        scope: "model_call",
        failureCodes: ["MODEL_TIMEOUT"],
        action: "retry_same_route",
        maxAttempts: 2,
      },
      terminalStage(),
    ],
  });
  const gateway: ModelGateway = { call: async <T>() => ({}) as T };
  const modelRegistry = new RecoveryModelRegistry();
  modelRegistry.register({ candidate: primary, policyRevision: policy.revision, gateway });
  const trigger = {
    runId: "run-interrupted",
    sessionId: "session-interrupted",
    threadId: "thread-interrupted",
    scope: "model_call" as const,
    failureCode: "MODEL_TIMEOUT",
    visibleOutputStarted: false,
    attempt: 1,
    currentModelCandidateId: "primary",
    budget: { remainingMs: 10_000, tokensUsed: 0, toolCallsUsed: 0 },
  };

  const persistenceInterrupted = coordinator({
    policy,
    modelRegistry,
    append: async (event) => {
      if (event.type === "recovery.decision.persisted") throw new Error("crash before persistence");
    },
  });
  await assert.rejects(() => persistenceInterrupted.decide(trigger), /crash before persistence/u);

  const persistedEvents: string[] = [];
  const actionStartInterrupted = coordinator({
    policy,
    modelRegistry,
    append: async (event) => {
      if (event.type === "recovery.action.started") throw new Error("crash before action start");
      persistedEvents.push(event.type);
    },
  });
  const selection = await actionStartInterrupted.decide(trigger);
  let actionCalls = 0;
  await assert.rejects(async () => {
    await actionStartInterrupted.markActionStarted(selection.decision);
    actionCalls += 1;
  }, /crash before action start/u);
  assert.equal(actionCalls, 0);
  assert.deepEqual(persistedEvents, ["recovery.decision.persisted"]);
});

test("model failure capture is coordinator-visible and streaming output forbids another attempt", async () => {
  let capturedFailureCode: string | undefined;
  const events: Array<{ type: string; willRetry?: boolean; visibleOutputStarted?: boolean }> = [];
  const captureGateway = new RetryingModelGateway(async () => {
    const error = new Error("provider unavailable") as Error & { code: string; status: number };
    error.code = "MODEL_PROVIDER_ERROR";
    error.status = 503;
    throw error;
  }, { retryCount: 1 });
  await assert.rejects(() => captureGateway.call({ input: "capture" }, {
    authorizeRetry: async (input) => {
      capturedFailureCode = input.failureCode;
      return false;
    },
    onEvent: async (event) => {
      events.push(event);
    },
  }));
  assert.equal(capturedFailureCode, "MODEL_PROVIDER_ERROR");
  assert.equal(events.find((event) => event.type === "attempt.failed")?.willRetry, false);

  let streamingCalls = 0;
  let authorizationCalls = 0;
  const streamingGateway = new RetryingModelGateway(async (_request, options) => {
    streamingCalls += 1;
    await options?.onEvent?.({ type: "output.delta", attempt: 1, delta: "visible" });
    const error = new Error("stream interrupted") as Error & { code: string; status: number };
    error.code = "MODEL_PROVIDER_ERROR";
    error.status = 503;
    throw error;
  }, { retryCount: 1 });
  const streamingEvents: Array<{ type: string; willRetry?: boolean; visibleOutputStarted?: boolean }> = [];
  await assert.rejects(() => streamingGateway.call({ input: "stream" }, {
    authorizeRetry: async () => {
      authorizationCalls += 1;
      return true;
    },
    onEvent: async (event) => {
      streamingEvents.push(event);
    },
  }));
  assert.equal(streamingCalls, 1);
  assert.equal(authorizationCalls, 0);
  const failure = streamingEvents.find((event) => event.type === "attempt.failed");
  assert.equal(failure?.visibleOutputStarted, true);
  assert.equal(failure?.willRetry, false);
});

test("durable recovery review remains waiting across restart and resumes the exact operator option", async () => {
  const primary = candidate("primary", "openai", "gpt-primary");
  const policy = createRecoveryPolicyV1({
    policyId: "recovery:restart-review",
    primaryModel: primary,
    stages: [
      {
        stageId: "run.review",
        scope: "run",
        failureCodes: ["RECOVERY_EXHAUSTED"],
        action: "human_review",
        optionIds: ["retry.primary", "terminal.fail"],
      },
      terminalStage(),
    ],
  });
  const store = new InMemorySessionStore();
  let stepCalls = 0;
  const createRuntime = () => {
    const gateway: ModelGateway = { call: async <T>() => ({}) as T };
    const models = new RecoveryModelRegistry();
    models.register({ candidate: primary, policyRevision: policy.revision, gateway });
    const runtime = new Kestrel({
      store,
      modelGateway: gateway,
      toolGateway: new AllowlistedToolGateway({}),
      recoveryRuntime: {
        policy,
        executionProfileFingerprint: "d".repeat(64),
        modelRegistry: models,
        toolAdapterRegistry: new RecoveryToolAdapterRegistry(),
        toolResultNormalizerRegistry: createDefaultRecoveryToolResultNormalizers(),
        workflowHandlerRegistry: new RecoveryWorkflowHandlerRegistry(),
      },
    });
    runtime.registerStep("recovery.restart", async () => {
      stepCalls += 1;
      if (stepCalls === 1) {
        const error = new Error("injected terminal failure") as Error & { code: string };
        error.code = "INJECTED_TERMINAL_FAILURE";
        throw error;
      }
      return { status: "COMPLETED", statePatch: { recoveredAfterRestart: true } };
    });
    return runtime;
  };

  const waiting = await createRuntime().run({
    id: "event-recovery-restart",
    type: "user.message",
    sessionId: "session-recovery-restart",
    stepAgent: "recovery.restart",
    payload: {
      message: "recover across restart",
      metadata: {
        threadId: "thread-recovery-restart",
        actor: { actorId: "user-1", actorType: "end_user", tenantId: "tenant-1" },
      },
    },
  });
  assert.equal(waiting.status, "WAITING");
  assert.equal((await store.getRun(waiting.runId))?.status, "WAITING");

  const resumed = await createRuntime().run({
    id: "event-recovery-resume",
    type: "user.reply",
    sessionId: "session-recovery-restart",
    payload: {
      recoveryOptionId: "retry.primary",
      metadata: {
        threadId: "thread-recovery-restart",
        actor: { actorId: "operator-1", actorType: "operator", tenantId: "tenant-1" },
      },
    },
  });
  assert.equal(resumed.status, "COMPLETED", JSON.stringify(resumed));
  assert.equal(stepCalls, 2);
  assert.equal((await store.getRun(resumed.runId))?.status, "COMPLETED");
  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.equal(eventTypes.includes("recovery.waiting"), true);
  assert.equal(eventTypes.includes("interaction.resolved"), true);
  assert.equal(eventTypes.includes("run.resumed"), true);
  assert.equal(eventTypes.includes("run.completed"), true);
});

test("recorded recovery tool result replay never repeats the consumed external effect", async () => {
  const store = new InMemorySessionStore();
  const registry = new EffectRegistry();
  let externalCalls = 0;
  registry.register("tool.execute", async () => {
    externalCalls += 1;
    return { deploymentId: "deployment-1", status: "completed" };
  });
  const effect = {
    runId: "run-recovery-effect",
    sessionId: "session-recovery-effect",
    stepIndex: 2,
    type: "tool.execute",
    payload: {
      toolName: "deploy.execute",
      toolInput: { deploymentId: "deployment-1" },
      recoveryDecision: { decisionId: "recovery:decision-1" },
      recoveryAdapterId: "code-to-deploy",
    },
    idempotencyKey: "recovery:decision-1:tool:deploy.execute",
    failurePolicy: "STOP" as const,
    status: "PENDING" as const,
    createdAt: "2026-08-03T12:00:00.000Z",
  };

  const firstRunner = new InlineEffectRunner(store, registry);
  assert.equal((await firstRunner.runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  })).stop, false);
  const restartedRunner = new InlineEffectRunner(store, registry);
  assert.equal((await restartedRunner.runEffects([effect], {
    runId: effect.runId,
    sessionId: effect.sessionId,
    stepIndex: effect.stepIndex,
  })).stop, false);
  assert.equal(externalCalls, 1);
  assert.equal(store.getEffectResults()[0]?.idempotencyKey, effect.idempotencyKey);
});

function coordinator(input: {
  policy: ReturnType<typeof createRecoveryPolicyV1>;
  modelRegistry: RecoveryModelRegistry;
  append: ConstructorParameters<typeof RecoveryCoordinator>[0]["appendLifecycleEvent"];
}) {
  return new RecoveryCoordinator({
    policy: input.policy,
    executionProfileFingerprint: "c".repeat(64),
    modelRegistry: input.modelRegistry,
    toolAdapterRegistry: new RecoveryToolAdapterRegistry(),
    workflowHandlerRegistry: new RecoveryWorkflowHandlerRegistry(),
    appendLifecycleEvent: input.append,
    createId: () => "interruption",
    now: () => new Date("2026-08-03T12:00:00.000Z"),
  });
}

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

function terminalStage() {
  return {
    stageId: "run.terminal",
    scope: "run" as const,
    failureCodes: ["RECOVERY_EXHAUSTED"],
    action: "terminal_failure" as const,
    terminalCode: "RECOVERY_EXHAUSTED",
  };
}
