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
import { resolveProfileWithEvaluationPolicy } from "../../src/profile/evaluationPolicy.js";
import { fingerprintResolvedProfile } from "../../src/profile/kestrelOnePolicy.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { createTestToolGateway } from "../helpers/createTestToolGateway.js";
import { bindTestRuntimeEvaluationCalibration } from "../helpers/runtimeEvaluationCalibration.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function evaluationPolicy() {
  const policy = createRuntimeEvaluationPolicyV1({
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
  return bindTestRuntimeEvaluationCalibration(policy).policy;
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

function createHarness(
  outputs: Array<ReturnType<typeof judgeOutput>>,
  options: {
    store?: InMemorySessionStore | undefined;
    callState?: { count: number } | undefined;
  } = {},
) {
  const profile = resolvedProfile();
  const store = options.store ?? new InMemorySessionStore();
  const callState = options.callState ?? { count: 0 };
  const gateway: ModelGateway = { call: async <T>() => ({}) as T };
  const events: string[] = [];
  const fingerprint = fingerprintResolvedProfile(profile);
  const kestrel = new Kestrel({
    store,
    modelGateway: gateway,
    toolGateway: createTestToolGateway({}),
    runEventListener: (event) => {
      events.push(event.type);
    },
    evaluationRuntime: {
      policy: profile.evaluationPolicy!,
      calibrationRecord: bindTestRuntimeEvaluationCalibration(
        profile.evaluationPolicy!,
      ).calibrationRecord,
      executionProfileFingerprint: fingerprint,
      evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
      invokeJudge: async () => {
        const output = outputs[callState.count];
        callState.count += 1;
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
  return { kestrel, store, events, evaluationCalls: () => callState.count };
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
  assert.equal(harness.events.includes("evaluation.action.selected"), true);
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
  assert.equal(evaluationDecision.recoveryDecisionId, undefined);

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

test("integrity quarantine never exposes the candidate through the normal session projection", async () => {
  const harness = createHarness([
    judgeOutput({ score: 0.95, integrityPassed: false }),
  ]);
  harness.kestrel.registerStep("agent.loop", async (context) => ({
    status: "COMPLETED",
    statePatch: {
      agent: completedAgentState(
        context.session.state,
        "Quarantined candidate must remain hidden.",
      ),
    },
  }));

  const waiting = await harness.kestrel.run({
    id: "evaluation-quarantine-event",
    type: "user.message",
    sessionId: "evaluation-quarantine-session",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a checked result.",
      metadata: {
        threadId: "evaluation-quarantine-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });

  assert.equal(waiting.status, "WAITING");
  const session = await harness.kestrel.getSession(
    "evaluation-quarantine-session",
  );
  const agent = session?.state.agent as Record<string, unknown>;
  assert.equal(agent.assistantText, null);
  assert.equal(agent.finalOutput, undefined);
  const pending = (agent.exec as Record<string, unknown>)
    .pendingEvaluation as Record<string, unknown>;
  assert.equal(pending.status, "quarantined");
  assert.equal(
    pending.candidate,
    "Quarantined candidate must remain hidden.",
  );
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

test("durable evaluation review survives restart and accept-once settles the exact candidate", async () => {
  const store = new InMemorySessionStore();
  const callState = { count: 0 };
  const first = createHarness(
    [judgeOutput({ score: 0.3, repairable: false })],
    { store, callState },
  );
  first.kestrel.registerStep("agent.loop", async (context) => ({
    status: "COMPLETED",
    statePatch: {
      agent: completedAgentState(context.session.state, "Restart-withheld result."),
    },
  }));
  const waiting = await first.kestrel.run({
    id: "evaluation-restart-accept-event",
    type: "user.message",
    sessionId: "evaluation-restart-accept-session",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a reviewed result.",
      metadata: {
        threadId: "evaluation-restart-accept-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });
  assert.equal(waiting.status, "WAITING");
  assert.equal((await store.getRun(waiting.runId))?.status, "WAITING");

  const restarted = createHarness(
    [judgeOutput({ score: 0.3, repairable: false })],
    { store, callState },
  );
  const accepted = await restarted.kestrel.run({
    id: "evaluation-restart-accept-response",
    type: "user.reply",
    sessionId: "evaluation-restart-accept-session",
    payload: {
      recoveryOptionId: "evaluation.accept_once",
      metadata: {
        threadId: "evaluation-restart-accept-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });
  assert.equal(accepted.status, "COMPLETED");
  assert.equal(callState.count, 1);
  assert.equal(
    ((await restarted.kestrel.getSession("evaluation-restart-accept-session"))
      ?.state.agent as Record<string, unknown>).assistantText,
    "Restart-withheld result.",
  );
});

test("operator-selected evaluation revision resumes the exact action after restart", async () => {
  const store = new InMemorySessionStore();
  const callState = { count: 0 };
  const outputs = [
    judgeOutput({ score: 0.3, repairable: false }),
    judgeOutput({ score: 0.95 }),
  ];
  const first = createHarness(outputs, { store, callState });
  first.kestrel.registerStep("agent.loop", async (context) => ({
    status: "COMPLETED",
    statePatch: {
      agent: completedAgentState(context.session.state, "Initial review result."),
    },
  }));
  const waiting = await first.kestrel.run({
    id: "evaluation-restart-revise-event",
    type: "user.message",
    sessionId: "evaluation-restart-revise-session",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a revised result.",
      metadata: {
        threadId: "evaluation-restart-revise-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });
  assert.equal(waiting.status, "WAITING");

  const restarted = createHarness(outputs, { store, callState });
  let revisedStepCalls = 0;
  restarted.kestrel.registerStep("agent.loop", async (context) => {
    revisedStepCalls += 1;
    return {
      status: "COMPLETED",
      statePatch: {
        agent: completedAgentState(
          context.session.state,
          "Restart-revised complete result.",
        ),
      },
    };
  });
  const completed = await restarted.kestrel.run({
    id: "evaluation-restart-revise-response",
    type: "user.reply",
    sessionId: "evaluation-restart-revise-session",
    payload: {
      recoveryOptionId: "evaluation.revise",
      metadata: {
        threadId: "evaluation-restart-revise-thread",
        actor: {
          actorId: "operator-1",
          actorType: "operator",
          tenantId: "tenant-1",
        },
      },
    },
  });
  assert.equal(completed.status, "COMPLETED", JSON.stringify(completed));
  assert.equal(revisedStepCalls, 1);
  assert.equal(callState.count, 2);
  assert.equal((await store.getRun(completed.runId))?.status, "COMPLETED");
  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.equal(eventTypes.includes("evaluation.action.selected"), true);
  assert.equal(eventTypes.includes("evaluation.completed"), true);
  assert.equal(eventTypes.includes("run.completed"), true);
});
