import test from "node:test";
import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import { Kestrel } from "../../src/kestrel/Kestrel.js";
import {
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
  createRuntimeEvaluationPolicyV1,
} from "../../src/kestrel/contracts/evaluation.js";
import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import { COMPLETION_EVIDENCE_ASSET_BUNDLE_V1 } from "../../src/evaluation/assets.js";
import { createDefaultRuntimeEvaluatorRegistry } from "../../src/evaluation/index.js";
import {
  RecoveryModelRegistry,
  RecoveryToolAdapterRegistry,
  RecoveryWorkflowHandlerRegistry,
  createDefaultRecoveryToolResultNormalizers,
  registerDefaultRecoveryWorkflowHandlers,
} from "../../src/engine/recovery/RecoveryRegistries.js";
import { resolveProfileWithEvaluationPolicy } from "../../src/profile/evaluationPolicy.js";
import { fingerprintResolvedProfile } from "../../src/profile/kestrelOnePolicy.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { createTestToolGateway } from "../helpers/createTestToolGateway.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function evaluationPolicy() {
  return createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:runtime-integration",
    evaluator: {
      evaluatorId: "completion-evidence",
      evaluatorVersion: "1.0.0",
    },
    assets: COMPLETION_EVIDENCE_ASSET_BUNDLE_V1,
    judge: {
      route: "profile_primary",
      provider: "openai",
      model: "gpt-5.4-2026-03-05",
      modelRegistrationRevision: HASH_A,
      capabilities: {
        visionInputEnabled: false,
        toolCallingEnabled: true,
        structuredOutputEnabled: true,
        reasoningModes: ["off", "summary", "provider_visible"],
      },
      pricing: {
        priceRevision: HASH_B,
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
      },
    },
    calibration: {
      recordId: "completion-evidence.calibration.openai-gpt-5.4",
      recordRevision: HASH_A,
    },
    hooks: [{ kind: "pre_delivery", mode: "blocking", selectorIds: [] }],
    budget: LEAN_RUNTIME_EVALUATION_BUDGET_V1,
    thresholds: RUNTIME_EVALUATION_THRESHOLDS_V1,
    actions: {
      revisionHandlerId: "evaluation.revise",
      reviewOptionIds: [
        "evaluation.accept_once",
        "evaluation.revise",
        "terminal.fail",
      ],
    },
  });
}

function resolvedProfile(): TuiProfile {
  return resolveProfileWithEvaluationPolicy({
    id: "runtime-evaluation-test",
    label: "Runtime evaluation test",
    agent: "reference-react",
    sessionPrefix: "runtime-evaluation-test",
    modelProvider: "openai",
    model: "gpt-5.4-2026-03-05",
    evaluationPolicy: evaluationPolicy(),
  });
}

function judgeOutput(input: {
  score: number;
  confidence?: number;
  repairable?: boolean;
  integrityPassed?: boolean;
}) {
  const passed = input.score >= 0.8;
  return {
    score: input.score,
    confidence: input.confidence ?? 0.9,
    assertions: [
      {
        assertionId: "outcome_complete",
        passed,
        rationale: passed ? "Complete." : "Incomplete.",
        evidenceRefs: [],
      },
      {
        assertionId: "evidence_consistent",
        passed,
        rationale: passed ? "Consistent." : "Insufficient evidence.",
        evidenceRefs: [],
      },
      {
        assertionId: "evaluation_integrity",
        passed: input.integrityPassed ?? true,
        rationale: "Integrity checked.",
        evidenceRefs: [],
      },
    ],
    rationale: passed ? "Ready to deliver." : "Revise or review.",
    reasonCodes: [passed ? "COMPLETE" : "INCOMPLETE"],
    repairable: input.repairable ?? false,
  };
}

function createHarness(outputs: Array<ReturnType<typeof judgeOutput>>) {
  const profile = resolvedProfile();
  const recoveryPolicy = profile.recoveryPolicy!;
  const store = new InMemorySessionStore();
  const gateway: ModelGateway = { call: async <T>() => ({}) as T };
  const modelRegistry = new RecoveryModelRegistry();
  modelRegistry.register({
    candidate: recoveryPolicy.primaryModel,
    policyRevision: recoveryPolicy.revision,
    gateway,
  });
  const workflowHandlerRegistry = new RecoveryWorkflowHandlerRegistry();
  registerDefaultRecoveryWorkflowHandlers(workflowHandlerRegistry);
  const events: string[] = [];
  let evaluationCalls = 0;
  const fingerprint = fingerprintResolvedProfile(profile);
  const kestrel = new Kestrel({
    store,
    modelGateway: gateway,
    toolGateway: createTestToolGateway({}),
    runEventListener: (event) => {
      events.push(event.type);
    },
    recoveryRuntime: {
      policy: recoveryPolicy,
      executionProfileFingerprint: fingerprint,
      modelRegistry,
      toolAdapterRegistry: new RecoveryToolAdapterRegistry(),
      toolResultNormalizerRegistry: createDefaultRecoveryToolResultNormalizers(),
      workflowHandlerRegistry,
    },
    evaluationRuntime: {
      policy: profile.evaluationPolicy!,
      executionProfileFingerprint: fingerprint,
      evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
      invokeJudge: async () => {
        const output = outputs[evaluationCalls];
        evaluationCalls += 1;
        if (output === undefined) throw new Error("Unexpected evaluator call.");
        return {
          output,
          provider: "openai",
          requestedModel: "gpt-5.4-2026-03-05",
          observedModelRevision: "gpt-5.4-2026-03-05",
          usage: { inputTokens: 100, outputTokens: 40 },
          latencyMs: 10,
        };
      },
    },
  });
  return { kestrel, store, events, evaluationCalls: () => evaluationCalls };
}

function completedAgentState(
  state: Record<string, unknown>,
  candidate: string,
): Record<string, unknown> {
  const agent = state.agent as Record<string, unknown>;
  return {
    ...agent,
    assistantText: candidate,
    finalOutput: { message: candidate },
  };
}

test("pre-delivery evaluation prevents visibility until the persisted pass", async () => {
  const harness = createHarness([judgeOutput({ score: 0.95 })]);
  harness.kestrel.registerStep("agent.loop", async (context) => ({
    status: "COMPLETED",
    statePatch: {
      agent: completedAgentState(context.session.state, "Authorized result."),
    },
  }));

  const output = await harness.kestrel.run({
    id: "evaluation-pass-event",
    type: "user.message",
    sessionId: "evaluation-pass-session",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a checked result.",
      metadata: { threadId: "evaluation-pass-thread" },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(harness.evaluationCalls(), 1);
  const session = await harness.kestrel.getSession("evaluation-pass-session");
  assert.equal(
    (session?.state.agent as Record<string, unknown>).assistantText,
    "Authorized result.",
  );
  assert.ok(
    harness.events.indexOf("evaluation.completed") <
      harness.events.indexOf("run.completed"),
  );
});

test("one evaluation revision clears the withheld candidate and reevaluates once", async () => {
  const harness = createHarness([
    judgeOutput({ score: 0.4, repairable: true }),
    judgeOutput({ score: 0.95 }),
  ]);
  let stepCalls = 0;
  harness.kestrel.registerStep("agent.loop", async (context) => {
    stepCalls += 1;
    const agent = context.session.state.agent as Record<string, unknown>;
    if (stepCalls === 2) {
      assert.notEqual(agent.retryContext, undefined);
      assert.equal(agent.assistantText, null);
    }
    return {
      status: "COMPLETED",
      statePatch: {
        agent: completedAgentState(
          context.session.state,
          stepCalls === 1 ? "Incomplete result." : "Revised complete result.",
        ),
      },
    };
  });

  const output = await harness.kestrel.run({
    id: "evaluation-revision-event",
    type: "user.message",
    sessionId: "evaluation-revision-session",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a revised checked result.",
      metadata: { threadId: "evaluation-revision-thread" },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(stepCalls, 2);
  assert.equal(harness.evaluationCalls(), 2);
  const session = await harness.kestrel.getSession("evaluation-revision-session");
  assert.equal(
    (session?.state.agent as Record<string, unknown>).assistantText,
    "Revised complete result.",
  );
  assert.equal(harness.events.includes("recovery.action.completed"), true);
});

test("evaluation review withholds the candidate and accept-once delivers the exact stored result", async () => {
  const harness = createHarness([
    judgeOutput({ score: 0.3, repairable: false }),
  ]);
  harness.kestrel.registerStep("agent.loop", async (context) => ({
    status: "COMPLETED",
    statePatch: {
      agent: completedAgentState(context.session.state, "Withheld result."),
    },
  }));

  const waiting = await harness.kestrel.run({
    id: "evaluation-review-event",
    type: "user.message",
    sessionId: "evaluation-review-session",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a result that needs review.",
      metadata: {
        threadId: "evaluation-review-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });

  assert.equal(waiting.status, "WAITING");
  assert.equal(waiting.waitFor?.metadata?.reason, "evaluation_review");
  const withheld = await harness.kestrel.getSession("evaluation-review-session");
  const withheldAgent = withheld?.state.agent as Record<string, unknown>;
  assert.equal(withheldAgent.assistantText, null);
  assert.equal(withheldAgent.finalOutput, undefined);
  assert.equal(
    typeof (withheldAgent.exec as Record<string, unknown>).pendingEvaluation,
    "object",
  );
  const pendingEvaluation = (withheldAgent.exec as Record<string, unknown>)
    .pendingEvaluation as Record<string, unknown>;
  const evaluationDecision = pendingEvaluation.evaluationDecision as Record<string, unknown>;
  const recoveryDecision = pendingEvaluation.recoveryDecision as Record<string, unknown>;
  assert.equal(
    evaluationDecision.recoveryDecisionId,
    recoveryDecision.decisionId,
  );

  const accepted = await harness.kestrel.run({
    id: "evaluation-review-resume-event",
    type: "user.reply",
    sessionId: "evaluation-review-session",
    payload: {
      recoveryOptionId: "evaluation.accept_once",
      metadata: {
        threadId: "evaluation-review-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });

  assert.equal(accepted.status, "COMPLETED");
  assert.equal(harness.evaluationCalls(), 1);
  const delivered = await harness.kestrel.getSession("evaluation-review-session");
  assert.equal(
    (delivered?.state.agent as Record<string, unknown>).assistantText,
    "Withheld result.",
  );
});

test("a second rejection enters review without offering another revision", async () => {
  const harness = createHarness([
    judgeOutput({ score: 0.3, repairable: true }),
    judgeOutput({ score: 0.3, repairable: true }),
  ]);
  let stepCalls = 0;
  harness.kestrel.registerStep("agent.loop", async (context) => {
    stepCalls += 1;
    return {
      status: "COMPLETED",
      statePatch: {
        agent: completedAgentState(
          context.session.state,
          stepCalls === 1 ? "First result." : "Still incomplete.",
        ),
      },
    };
  });

  const waiting = await harness.kestrel.run({
    id: "evaluation-second-rejection-event",
    type: "user.message",
    sessionId: "evaluation-second-rejection-session",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a checked result.",
      metadata: {
        threadId: "evaluation-second-rejection-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });

  assert.equal(waiting.status, "WAITING");
  assert.deepEqual(waiting.waitFor?.metadata?.allowedOptionIds, [
    "evaluation.accept_once",
    "terminal.fail",
  ]);
  assert.equal(stepCalls, 2);
  assert.equal(harness.evaluationCalls(), 2);
});

test("the exact terminal review option fails with EVALUATION_DECLINED", async () => {
  const harness = createHarness([
    judgeOutput({ score: 0.3, repairable: false }),
  ]);
  harness.kestrel.registerStep("agent.loop", async (context) => ({
    status: "COMPLETED",
    statePatch: {
      agent: completedAgentState(context.session.state, "Declined result."),
    },
  }));
  await harness.kestrel.run({
    id: "evaluation-decline-event",
    type: "user.message",
    sessionId: "evaluation-decline-session",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a checked result.",
      metadata: {
        threadId: "evaluation-decline-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });

  const declined = await harness.kestrel.run({
    id: "evaluation-decline-resume-event",
    type: "user.reply",
    sessionId: "evaluation-decline-session",
    payload: {
      recoveryOptionId: "terminal.fail",
      metadata: {
        threadId: "evaluation-decline-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });

  assert.equal(declined.status, "FAILED");
  assert.equal(declined.errors[0]?.code, "EVALUATION_DECLINED");
  assert.equal(harness.evaluationCalls(), 1);
});
