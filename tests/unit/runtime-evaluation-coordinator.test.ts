import test from "node:test";
import assert from "node:assert/strict";

import {
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
  createRuntimeEvaluationPolicyV1,
} from "../../src/kestrel/contracts/evaluation.js";
import { COMPLETION_EVIDENCE_ASSET_BUNDLE_V1 } from "../../src/evaluation/assets.js";
import {
  RuntimeEvaluationCoordinator,
  RuntimeEvaluationFailure,
  createDefaultRuntimeEvaluatorRegistry,
} from "../../src/evaluation/index.js";
import { ExecutionBoundaryPolicyRuntime } from "../../src/security/ExecutionBoundaryPolicy.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function policy() {
  return createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:coordinator-test",
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
    hooks: [
      { kind: "after_tool", mode: "advisory", selectorIds: ["code.execute"] },
      { kind: "milestone", mode: "advisory", selectorIds: ["research/complete"] },
      { kind: "handoff", mode: "advisory", selectorIds: ["researcher"] },
      { kind: "pre_delivery", mode: "blocking", selectorIds: [] },
    ],
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

function judgeOutput(input: {
  score?: number;
  confidence?: number;
  repairable?: boolean;
  integrityPassed?: boolean;
} = {}) {
  return {
    score: input.score ?? 0.95,
    confidence: input.confidence ?? 0.9,
    assertions: [
      {
        assertionId: "outcome_complete",
        passed: (input.score ?? 0.95) >= 0.8,
        rationale: "Outcome assertion.",
        evidenceRefs: ["final-last-action-result"],
      },
      {
        assertionId: "evidence_consistent",
        passed: (input.score ?? 0.95) >= 0.8,
        rationale: "Evidence assertion.",
        evidenceRefs: ["final-last-action-result"],
      },
      {
        assertionId: "evaluation_integrity",
        passed: input.integrityPassed ?? true,
        rationale: "Integrity assertion.",
        evidenceRefs: [],
      },
    ],
    rationale: "Bounded evaluator rationale.",
    reasonCodes: [(input.score ?? 0.95) >= 0.8 ? "COMPLETE" : "INCOMPLETE"],
    repairable: input.repairable ?? false,
  };
}

function coordinator(
  output: ReturnType<typeof judgeOutput>,
  options: {
    store?: InMemorySessionStore | undefined;
    usage?: { inputTokens: number; outputTokens: number } | undefined;
    now?: (() => Date) | undefined;
  } = {},
) {
  const store = options.store ?? new InMemorySessionStore();
  const events: string[] = [];
  let calls = 0;
  const runtime = new RuntimeEvaluationCoordinator({
    policy: policy(),
    executionProfileFingerprint: "c".repeat(64),
    evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
    store,
    executionBoundaryRuntime: new ExecutionBoundaryPolicyRuntime(),
    appendLifecycleEvent: async (event) => {
      events.push(event.type);
    },
    ...(options.now !== undefined ? { now: options.now } : {}),
    invokeJudge: async (_request, signal) => {
      assert.equal(signal.aborted, false);
      calls += 1;
      return {
        output,
        provider: "openai",
        requestedModel: "gpt-5.4-2026-03-05",
        observedModelRevision: "gpt-5.4-2026-03-05",
        usage: options.usage ?? { inputTokens: 120, outputTokens: 40 },
        latencyMs: 12,
      };
    },
  });
  return { runtime, store, events, calls: () => calls };
}

function finalInput(stepIndex = 1) {
  return {
    runId: "run-evaluation",
    sessionId: "session-evaluation",
    threadId: "thread-evaluation",
    stepIndex,
    hookKind: "pre_delivery" as const,
    sourceId: "pre_delivery",
    objective: "Return the requested result.",
    candidateOutput: "The requested result is complete.",
    evidence: [{
      evidenceId: "final-last-action-result",
      kind: "tool" as const,
      value: { status: "ok" },
    }],
  };
}

test("blocking runtime evaluation persists a pass before delivery", async () => {
  const harness = coordinator(judgeOutput());
  const result = await harness.runtime.evaluateHook(finalInput());

  assert.equal(result?.decision.disposition, "continue");
  assert.equal(result?.decision.reasonCode, "EVALUATION_PASSED");
  assert.equal(result?.sanitizedCandidate, "The requested result is complete.");
  assert.equal(harness.calls(), 1);
  assert.deepEqual(harness.events.slice(-4), [
    "evaluation.requested",
    "evaluation.started",
    "evaluation.completed",
    "evaluation.action.selected",
  ]);
  const artifacts = await harness.store.listArtifacts({
    sessionId: "session-evaluation",
    runId: "run-evaluation",
  });
  assert.equal(
    artifacts.some((artifact) => artifact.type === "runtime_evaluation.decision.v1"),
    true,
  );
});

test("blocking runtime evaluation maps repairable failure, low confidence, and integrity attacks deterministically", async () => {
  const repairable = await coordinator(
    judgeOutput({ score: 0.4, repairable: true }),
  ).runtime.evaluateHook(finalInput());
  assert.equal(repairable?.decision.disposition, "revise");
  assert.equal(repairable?.decision.reasonCode, "EVALUATION_REJECTED");

  const lowConfidence = await coordinator(
    judgeOutput({ score: 0.95, confidence: 0.69 }),
  ).runtime.evaluateHook(finalInput());
  assert.equal(lowConfidence?.decision.disposition, "review");
  assert.equal(lowConfidence?.decision.reasonCode, "EVALUATION_LOW_CONFIDENCE");

  const integrity = await coordinator(
    judgeOutput({ integrityPassed: false, score: 0.95 }),
  ).runtime.evaluateHook(finalInput());
  assert.equal(integrity?.decision.disposition, "quarantine");
  assert.equal(integrity?.decision.reasonCode, "EVALUATION_QUARANTINED");
});

test("intermediate runtime evaluation is advisory and reserves both final slots", async () => {
  const harness = coordinator(judgeOutput({ score: 0.2, repairable: true }));
  for (let stepIndex = 1; stepIndex <= 3; stepIndex += 1) {
    const result = await harness.runtime.evaluateHook({
      runId: "run-evaluation",
      sessionId: "session-evaluation",
      threadId: "thread-evaluation",
      stepIndex,
      hookKind: "after_tool",
      sourceId: "code.execute",
      objective: "Run the requested check.",
      evidence: [{
        evidenceId: `tool-${stepIndex}`,
        kind: "tool",
        value: { status: "ok", stepIndex },
      }],
    });
    assert.equal(
      result?.decision.disposition,
      stepIndex === 3 ? "skipped" : "continue",
    );
    if (stepIndex === 3) {
      assert.equal(result?.decision.reasonCode, "FINAL_CAPACITY_RESERVED");
    }
  }
  assert.equal(harness.calls(), 2);
  assert.equal(harness.events.includes("evaluation.skipped"), true);
});

test("evaluator outage enters final review and advisory evaluation continues", async () => {
  const store = new InMemorySessionStore();
  const runtime = new RuntimeEvaluationCoordinator({
    policy: policy(),
    executionProfileFingerprint: "d".repeat(64),
    evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
    store,
    executionBoundaryRuntime: new ExecutionBoundaryPolicyRuntime(),
    appendLifecycleEvent: async () => {},
    invokeJudge: async () => {
      throw new RuntimeEvaluationFailure(
        "EVALUATION_TIMEOUT",
        "Simulated exact timeout.",
      );
    },
  });
  const final = await runtime.evaluateHook(finalInput());
  assert.equal(final?.decision.disposition, "review");
  assert.equal(final?.decision.reasonCode, "EVALUATION_TIMEOUT");

  const advisory = await runtime.evaluateHook({
    runId: "run-advisory-outage",
    sessionId: "session-evaluation",
    threadId: "thread-evaluation",
    stepIndex: 1,
    hookKind: "after_tool",
    sourceId: "code.execute",
    objective: "Run a check.",
    evidence: [{ evidenceId: "tool-outage", kind: "tool", value: {} }],
  });
  assert.equal(advisory?.decision.disposition, "continue");
  assert.equal(advisory?.decision.reasonCode, "ADVISORY_EVALUATION_TIMEOUT");

  const untypedRuntime = new RuntimeEvaluationCoordinator({
    policy: policy(),
    executionProfileFingerprint: "f".repeat(64),
    evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
    store: new InMemorySessionStore(),
    executionBoundaryRuntime: new ExecutionBoundaryPolicyRuntime(),
    appendLifecycleEvent: async () => {},
    invokeJudge: async () => {
      throw new Error("timeout unavailable");
    },
  });
  const untyped = await untypedRuntime.evaluateHook({
    ...finalInput(),
    runId: "run-untyped-evaluator-failure",
    sessionId: "session-untyped-evaluator-failure",
  });
  assert.equal(untyped?.decision.disposition, "review");
  assert.equal(untyped?.decision.reasonCode, "EVALUATOR_OUTPUT_MALFORMED");
});

test("persisted evaluation identity consumes the same decision without another judge call", async () => {
  let clock = 0;
  const harness = coordinator(judgeOutput(), {
    now: () => new Date(`2026-08-04T12:00:0${clock++}.000Z`),
  });
  const first = await harness.runtime.evaluateHook(finalInput());
  const replayed = await harness.runtime.evaluateHook(finalInput());

  assert.equal(harness.calls(), 1);
  assert.equal(replayed?.request.requestId, first?.request.requestId);
  assert.equal(replayed?.decision.decisionId, first?.decision.decisionId);
});

test("an uncertain persisted judge attempt enters review instead of calling again", async () => {
  const store = new InMemorySessionStore();
  const firstRuntime = new RuntimeEvaluationCoordinator({
    policy: policy(),
    executionProfileFingerprint: "e".repeat(64),
    evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
    store,
    executionBoundaryRuntime: new ExecutionBoundaryPolicyRuntime(),
    appendLifecycleEvent: async () => {},
    invokeJudge: async (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      }),
  });
  const interruption = new AbortController();
  const firstAttempt = firstRuntime.evaluateHook({
    ...finalInput(),
    signal: interruption.signal,
  });
  await waitForEvaluationAttempt(store);
  interruption.abort(new Error("Simulated process interruption."));
  await assert.rejects(firstAttempt, /Simulated process interruption/u);

  let resumedCalls = 0;
  const resumedRuntime = new RuntimeEvaluationCoordinator({
    policy: policy(),
    executionProfileFingerprint: "e".repeat(64),
    evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
    store,
    executionBoundaryRuntime: new ExecutionBoundaryPolicyRuntime(),
    appendLifecycleEvent: async () => {},
    invokeJudge: async () => {
      resumedCalls += 1;
      throw new Error("The judge must not be called after an uncertain attempt.");
    },
  });
  const result = await resumedRuntime.evaluateHook(finalInput());

  assert.equal(resumedCalls, 0);
  assert.equal(result?.decision.disposition, "review");
  assert.equal(result?.decision.reasonCode, "EVALUATION_CALL_INTERRUPTED");
});

test("provider-reported per-call budget overage fails closed into final review", async () => {
  const harness = coordinator(judgeOutput(), {
    usage: { inputTokens: 3_501, outputTokens: 40 },
  });
  const result = await harness.runtime.evaluateHook(finalInput());

  assert.equal(result?.decision.disposition, "review");
  assert.equal(result?.decision.reasonCode, "EVALUATION_BUDGET_EXCEEDED");
});

async function waitForEvaluationAttempt(store: InMemorySessionStore): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const artifacts = await store.listArtifacts({
      sessionId: "session-evaluation",
      runId: "run-evaluation",
      type: "runtime_evaluation.attempt.v1",
    });
    if (artifacts.length > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for the persisted evaluation attempt.");
}
