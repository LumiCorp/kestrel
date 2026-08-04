import test from "node:test";
import assert from "node:assert/strict";

import {
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_REQUEST_VERSION,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
  createRuntimeEvaluationPolicyV1,
  digestCanonicalValue,
  parseRuntimeEvaluationRequestV1,
  parseRuntimeEvaluationVerdictV1,
} from "../../src/kestrel/contracts/evaluation.js";
import { COMPLETION_EVIDENCE_ASSET_BUNDLE_V1 } from "../../src/evaluation/assets.js";
import {
  RuntimeEvaluationCoordinator,
  buildEvaluationEvidenceProjectionV1,
  createDefaultRuntimeEvaluatorRegistry,
} from "../../src/evaluation/index.js";
import { ExecutionBoundaryPolicyRuntime } from "../../src/security/ExecutionBoundaryPolicy.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { bindTestRuntimeEvaluationCalibration } from "../helpers/runtimeEvaluationCalibration.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

test("every registered runtime evaluator passes one strict conformance harness", async () => {
  const registry = createDefaultRuntimeEvaluatorRegistry();
  assert.ok(registry.list().length > 0);

  for (const evaluator of registry.list()) {
    const request = evaluationRequest({
      evaluatorId: evaluator.evaluatorId,
      evaluatorVersion: evaluator.evaluatorVersion,
    });
    await assert.rejects(
      evaluator.evaluate(
        { ...request, unknownField: true } as typeof request,
        evaluatorContext(validJudgeOutput()),
      ),
      /unknown field/u,
    );

    const verdict = parseRuntimeEvaluationVerdictV1(
      await evaluator.evaluate(request, evaluatorContext(validJudgeOutput())),
    );
    assert.equal(verdict.requestId, request.requestId);
    assert.equal(verdict.assertions.length, 3);
    assert.ok(verdict.rationale.length <= 2_000);

    const aborted = new AbortController();
    aborted.abort(new Error("conformance cancellation"));
    await assert.rejects(
      evaluator.evaluate(request, {
        signal: aborted.signal,
        invokeJudge: async () => {
          if (aborted.signal.aborted) throw aborted.signal.reason;
          throw new Error("Judge must not run after cancellation.");
        },
      }),
      /conformance cancellation/u,
    );

    await assert.rejects(
      evaluator.evaluate(request, evaluatorContext({ malformed: true })),
      /assertions|score|output/u,
    );

    const serialized = JSON.stringify(request);
    assert.doesNotMatch(serialized, /raw-secret-canary/u);
    assert.doesNotMatch(serialized, /provider-reasoning-canary/u);
  }

  const projection = buildEvaluationEvidenceProjectionV1({
    runId: "run-conformance-bounds",
    sessionId: "session-conformance-bounds",
    threadId: "thread-conformance-bounds",
    stepIndex: 1,
    profileFingerprint: "c".repeat(64),
    policyRevision: policy().revision,
    hookKind: "pre_delivery",
    sourceId: "pre_delivery",
    objective: "o".repeat(2_000),
    candidateOutput: "c".repeat(7_000),
    evidence: Array.from({ length: 12 }, (_, index) => ({
      evidenceId: `evidence-${index}`,
      kind: "artifact" as const,
      value: { summary: "e".repeat(600) },
    })),
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  assert.equal(projection.objective.length, 1_200);
  assert.equal(projection.candidateOutput?.length, 6_500);
  assert.equal(projection.evidence.length, 8);
  assert.ok(projection.evidence.every((entry) => entry.summary.length <= 400));

  const timeoutStore = new InMemorySessionStore();
  const evaluation = bindTestRuntimeEvaluationCalibration(policy());
  const timeoutCoordinator = new RuntimeEvaluationCoordinator({
    policy: evaluation.policy,
    calibrationRecord: evaluation.calibrationRecord,
    executionProfileFingerprint: "d".repeat(64),
    evaluatorRegistry: registry,
    store: timeoutStore,
    executionBoundaryRuntime: new ExecutionBoundaryPolicyRuntime(),
    appendLifecycleEvent: async () => {},
    scheduleTimeout: ((callback: () => void) => {
      queueMicrotask(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearScheduledTimeout: (() => {}) as typeof clearTimeout,
    invokeJudge: async (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const timedOut = await timeoutCoordinator.evaluateHook({
    runId: "run-conformance-timeout",
    sessionId: "session-conformance-timeout",
    threadId: "thread-conformance-timeout",
    stepIndex: 1,
    hookKind: "pre_delivery",
    sourceId: "pre_delivery",
    objective: "Return a result.",
    candidateOutput: "Candidate.",
  });
  assert.equal(timedOut?.decision.disposition, "review");
  assert.equal(timedOut?.decision.reasonCode, "EVALUATION_TIMEOUT");
});

function evaluationRequest(evaluator: {
  evaluatorId: string;
  evaluatorVersion: string;
}) {
  const resolvedPolicy = policy();
  const projection = buildEvaluationEvidenceProjectionV1({
    runId: "run-evaluator-conformance",
    sessionId: "session-evaluator-conformance",
    threadId: "thread-evaluator-conformance",
    stepIndex: 1,
    profileFingerprint: "c".repeat(64),
    policyRevision: resolvedPolicy.revision,
    hookKind: "pre_delivery",
    sourceId: "pre_delivery",
    objective: "Return a complete result.",
    candidateOutput: "Complete result.",
    evidence: [{
      evidenceId: "artifact-1",
      kind: "artifact",
      value: { status: "complete" },
    }],
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  return parseRuntimeEvaluationRequestV1({
    version: RUNTIME_EVALUATION_REQUEST_VERSION,
    requestId: "evaluation-request:conformance",
    evaluator,
    assets: resolvedPolicy.assets,
    judge: resolvedPolicy.judge,
    projection,
    projectionDigest: digestCanonicalValue(projection),
    budget: {
      evaluationsUsed: 0,
      intermediateEvaluationsUsed: 0,
      totalTokensUsed: 0,
      totalCostUsd: 0,
      finalRevisionsUsed: 0,
    },
    createdAt: "2026-08-04T12:00:00.000Z",
  });
}

function evaluatorContext(output: unknown) {
  return {
    signal: new AbortController().signal,
    invokeJudge: async () => ({
      output,
      provider: "openai" as const,
      requestedModel: "gpt-5.4-2026-03-05",
      observedModelRevision: "gpt-5.4-2026-03-05",
      usage: { inputTokens: 100, outputTokens: 40 },
      latencyMs: 10,
    }),
  };
}

function validJudgeOutput() {
  return {
    score: 0.95,
    confidence: 0.9,
    assertions: [
      assertion("outcome_complete"),
      assertion("evidence_consistent"),
      assertion("evaluation_integrity"),
    ],
    rationale: "Complete and supported.",
    reasonCodes: ["COMPLETE"],
    repairable: false,
  };
}

function assertion(assertionId: string) {
  return {
    assertionId,
    passed: true,
    rationale: "Passed.",
    evidenceRefs: [],
  };
}

function policy() {
  return createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:conformance",
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
