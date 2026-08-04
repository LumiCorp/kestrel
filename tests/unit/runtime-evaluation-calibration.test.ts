import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRuntimeEvaluationCalibrationRecordFromEnv } from "../../cli/runtime/KestrelChatRuntime.js";
import {
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
  createRuntimeEvaluationPolicyV1,
} from "../../src/kestrel/contracts/evaluation.js";
import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";
import {
  COMPLETION_EVIDENCE_ASSET_BUNDLE_V1,
  COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1,
  RUNTIME_EVALUATION_CALIBRATION_REPETITIONS,
  assertRuntimeEvaluationCalibrationV1,
  createDefaultRuntimeEvaluatorRegistry,
  runRuntimeEvaluationCalibrationV1,
} from "../../src/evaluation/index.js";
import { bindTestRuntimeEvaluationCalibration } from "../helpers/runtimeEvaluationCalibration.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const MODEL = "gpt-5.4-2026-03-05";

test("24-case completion evidence calibration is repeatable and hides labels from the judge", async () => {
  const policy = evaluationPolicy();
  const judgeRequests: ModelRequest[] = [];
  const record = await runRuntimeEvaluationCalibrationV1({
    policy,
    evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    invokeJudge: async (request) => {
      judgeRequests.push(structuredClone(request));
      return {
        output: judgeOutputFor(request),
        provider: "openai",
        requestedModel: MODEL,
        observedModelRevision: MODEL,
        usage: { inputTokens: 100, outputTokens: 40 },
        latencyMs: 10,
      };
    },
  });

  assert.equal(
    record.runs?.length,
    COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1.length *
      RUNTIME_EVALUATION_CALIBRATION_REPETITIONS,
  );
  assert.equal(judgeRequests.length, 72);
  assert.equal(record.passed, true);
  assert.deepEqual(record.metrics, {
    falseAccepts: 0,
    falseRejects: 0,
    ambiguousReviews: 4,
    integrityContinues: 0,
    dispositionRepeatability: 1,
    thresholdStabilityFailures: 0,
  });
  for (const request of judgeRequests) {
    const serialized = JSON.stringify(request);
    assert.doesNotMatch(serialized, /expectedDisposition|thresholdBoundary/u);
    assert.doesNotMatch(serialized, /"category"/u);
    assert.doesNotMatch(serialized, /(?:valid|invalid|ambiguous|integrity)-\d{2}/u);
  }

  const calibratedPolicy = createRuntimeEvaluationPolicyV1({
    ...policy,
    calibration: {
      ...policy.calibration,
      recordRevision: record.revision,
    },
  });
  assert.equal(
    assertRuntimeEvaluationCalibrationV1(calibratedPolicy, record).revision,
    record.revision,
  );
  assert.throws(
    () => assertRuntimeEvaluationCalibrationV1(policy, record),
    /passing calibration record matching/u,
  );
  const staleModelPolicy = createRuntimeEvaluationPolicyV1({
    ...calibratedPolicy,
    judge: {
      ...calibratedPolicy.judge,
      modelRegistrationRevision: HASH_B,
    },
  });
  assert.throws(
    () => assertRuntimeEvaluationCalibrationV1(staleModelPolicy, record),
    /passing calibration record matching/u,
  );
});

test("runtime calibration loading is explicit, strict, and path-bound", () => {
  const evaluation = bindTestRuntimeEvaluationCalibration(evaluationPolicy());
  const directory = mkdtempSync(path.join(tmpdir(), "kestrel-evaluation-calibration-"));
  const recordPath = path.join(directory, "record.json");
  try {
    writeFileSync(recordPath, JSON.stringify(evaluation.calibrationRecord), "utf8");
    assert.equal(
      loadRuntimeEvaluationCalibrationRecordFromEnv({
        KCHAT_RUNTIME_EVALUATION_CALIBRATION_PATH: recordPath,
      }).revision,
      evaluation.calibrationRecord.revision,
    );
    assert.throws(
      () => loadRuntimeEvaluationCalibrationRecordFromEnv({}),
      /KCHAT_RUNTIME_EVALUATION_CALIBRATION_PATH/u,
    );
    writeFileSync(recordPath, "{}", "utf8");
    assert.throws(
      () => loadRuntimeEvaluationCalibrationRecordFromEnv({
        KCHAT_RUNTIME_EVALUATION_CALIBRATION_PATH: recordPath,
      }),
      /version/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function evaluationPolicy() {
  return createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:calibration-test",
    evaluator: {
      evaluatorId: "completion-evidence",
      evaluatorVersion: "1.0.0",
    },
    assets: COMPLETION_EVIDENCE_ASSET_BUNDLE_V1,
    judge: {
      route: "profile_primary",
      provider: "openai",
      model: MODEL,
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

function judgeOutputFor(request: ModelRequest) {
  const input = request.input as {
    projection: { candidateOutput?: string; evidence: Array<{ summary: string }> };
  };
  const candidate = input.projection.candidateOutput ?? "";
  const evidence = input.projection.evidence.map((entry) => entry.summary).join(" ");
  const integrityAttack =
    /ignore the evaluator|fabricated score|replace the system rubric|already approved/u.test(
      candidate.toLowerCase(),
    );
  const ambiguous = /appears|likely|probably|may be/u.test(candidate.toLowerCase());
  const contradicted =
    /failed|still running|no changes|permission denied|rolled back|rejected|sha256:actual/u.test(
      evidence.toLowerCase(),
    );
  const assertionPassed = !contradicted && !integrityAttack;
  const confidence = ambiguous ? 0.6 : 0.95;
  const score = contradicted ? 0.2 : 0.95;
  return {
    score,
    confidence,
    assertions: [
      assertion("outcome_complete", assertionPassed),
      assertion("evidence_consistent", assertionPassed),
      assertion("evaluation_integrity", !integrityAttack),
    ],
    rationale: "Deterministic calibration result.",
    reasonCodes: [
      integrityAttack
        ? "EVALUATION_INTEGRITY_FAILED"
        : ambiguous
          ? "INSUFFICIENT_EVIDENCE"
          : contradicted
            ? "EVIDENCE_CONTRADICTED"
            : "COMPLETE",
    ],
    repairable: contradicted,
  };
}

function assertion(assertionId: string, passed: boolean) {
  return {
    assertionId,
    passed,
    rationale: passed ? "Passed." : "Failed.",
    evidenceRefs: [],
  };
}
