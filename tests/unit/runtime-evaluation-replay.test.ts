import test from "node:test";
import assert from "node:assert/strict";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import {
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
  createRuntimeEvaluationPolicyV1,
} from "../../src/kestrel/contracts/evaluation.js";
import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import {
  buildRecordedRuntimeEvaluationEvidenceV1,
  createDefaultRuntimeEvaluatorRegistry,
  EVALUATION_EVIDENCE_INCOMPLETE,
  reevaluateRecordedRuntimeEvaluationV1,
} from "../../src/evaluation/index.js";
import { COMPLETION_EVIDENCE_ASSET_BUNDLE_V1 } from "../../src/evaluation/assets.js";
import { buildRuntimeReplayBundle } from "../../src/replay/RuntimeReplayBundle.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { createTestToolGateway } from "../helpers/createTestToolGateway.js";
import { bindTestRuntimeEvaluationCalibration } from "../helpers/runtimeEvaluationCalibration.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

test("recorded replay consumes persisted evaluation evidence without rerunning execution", async () => {
  const store = new InMemorySessionStore();
  let actingModelCalls = 0;
  let liveEvaluationCalls = 0;
  const modelGateway: ModelGateway = {
    call: async <T>() => {
      actingModelCalls += 1;
      return {} as T;
    },
  };
  const evaluation = bindTestRuntimeEvaluationCalibration(evaluationPolicy());
  const policy = evaluation.policy;
  const runtime = new Kestrel({
    store,
    modelGateway,
    toolGateway: createTestToolGateway({}),
    evaluationRuntime: {
      policy,
      calibrationRecord: evaluation.calibrationRecord,
      executionProfileFingerprint: "c".repeat(64),
      evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
      invokeJudge: async () => {
        liveEvaluationCalls += 1;
        return judgeResult();
      },
    },
  });
  runtime.registerStep("agent.loop", async (context) => ({
    status: "COMPLETED",
    statePatch: {
      agent: {
        ...(context.session.state.agent as Record<string, unknown>),
        assistantText: "Recorded checked result.",
        finalOutput: { message: "Recorded checked result." },
      },
    },
  }));

  const output = await runtime.run({
    id: "event-evaluation-replay",
    type: "user.message",
    sessionId: "session-evaluation-replay",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a checked result.",
      metadata: { threadId: "thread-evaluation-replay" },
    },
  });
  assert.equal(output.status, "COMPLETED");
  assert.equal(liveEvaluationCalls, 1);

  const { bundle } = await buildRuntimeReplayBundle(store, {
    runId: output.runId,
  });
  assert.equal(bundle.evaluation?.status, "complete");
  assert.equal(bundle.evaluation?.entries.length, 1);
  assert.equal(
    bundle.evaluation?.entries[0]?.projectionDigest,
    bundle.evaluation?.entries[0]?.request.projectionDigest,
  );
  assert.equal(liveEvaluationCalls, 1);
  assert.equal(actingModelCalls, 0);

  let offlineEvaluationCalls = 0;
  const verdict = await reevaluateRecordedRuntimeEvaluationV1({
    entry: bundle.evaluation!.entries[0]!,
    evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
    budget: LEAN_RUNTIME_EVALUATION_BUDGET_V1,
    invokeJudge: async () => {
      offlineEvaluationCalls += 1;
      return judgeResult();
    },
  });
  assert.equal(verdict.requestId, bundle.evaluation?.entries[0]?.request.requestId);
  assert.equal(offlineEvaluationCalls, 1);
  assert.equal(liveEvaluationCalls, 1);
  assert.equal(actingModelCalls, 0);
});

test("recorded replay returns EVALUATION_EVIDENCE_INCOMPLETE for projection drift", async () => {
  const store = new InMemorySessionStore();
  const evaluation = bindTestRuntimeEvaluationCalibration(evaluationPolicy());
  const runtime = new Kestrel({
    store,
    modelGateway: { call: async <T>() => ({}) as T },
    toolGateway: createTestToolGateway({}),
    evaluationRuntime: {
      policy: evaluation.policy,
      calibrationRecord: evaluation.calibrationRecord,
      executionProfileFingerprint: "d".repeat(64),
      evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
      invokeJudge: async () => judgeResult(),
    },
  });
  runtime.registerStep("agent.loop", async (context) => ({
    status: "COMPLETED",
    statePatch: {
      agent: {
        ...(context.session.state.agent as Record<string, unknown>),
        assistantText: "Checked result.",
        finalOutput: { message: "Checked result." },
      },
    },
  }));
  const output = await runtime.run({
    id: "event-evaluation-drift",
    type: "user.message",
    sessionId: "session-evaluation-drift",
    stepAgent: "agent.loop",
    payload: {
      message: "Return a checked result.",
      metadata: { threadId: "thread-evaluation-drift" },
    },
  });
  const artifacts = await store.listArtifacts({
    sessionId: "session-evaluation-drift",
    runId: output.runId,
  });
  const drifted = structuredClone(artifacts);
  const requestArtifact = drifted.find(
    (artifact) => artifact.type === "runtime_evaluation.request.v1",
  );
  const request = requestArtifact?.payload.request as Record<string, unknown>;
  request.projectionDigest = HASH_A;

  const evidence = await buildRecordedRuntimeEvaluationEvidenceV1({
    store: { listArtifacts: async () => drifted },
    sessionId: "session-evaluation-drift",
    runId: output.runId,
    waits: [],
  });
  assert.deepEqual(evidence, {
    status: "incomplete",
    errorCode: EVALUATION_EVIDENCE_INCOMPLETE,
    entries: [],
    reviews: [],
  });
});

function evaluationPolicy() {
  return createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:replay-test",
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

function judgeResult() {
  return {
    output: {
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
    },
    provider: "openai" as const,
    requestedModel: "gpt-5.4-2026-03-05",
    observedModelRevision: "gpt-5.4-2026-03-05",
    usage: { inputTokens: 100, outputTokens: 40 },
    latencyMs: 10,
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
