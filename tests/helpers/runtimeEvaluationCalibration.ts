import {
  EVALUATION_CALIBRATION_RECORD_VERSION,
  createRuntimeEvaluationPolicyV1,
  digestCanonicalValue,
  parseEvaluationCalibrationRecordV1,
  type EvaluationCalibrationRecordV1,
  type EvaluationCalibrationRunV1,
  type RuntimeEvaluationPolicyV1,
} from "../../src/kestrel/contracts/evaluation.js";
import {
  RUNTIME_EVALUATION_CALIBRATION_REPETITIONS,
} from "../../src/evaluation/RuntimeEvaluationCalibration.js";
import {
  COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1,
} from "../../src/evaluation/calibration/dataset.js";

export function bindTestRuntimeEvaluationCalibration(
  policyInput: RuntimeEvaluationPolicyV1,
  observedModelRevision = policyInput.judge.model,
): {
  policy: RuntimeEvaluationPolicyV1;
  calibrationRecord: EvaluationCalibrationRecordV1;
} {
  const runs: EvaluationCalibrationRunV1[] =
    COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1.flatMap((calibrationCase) =>
      Array.from(
        { length: RUNTIME_EVALUATION_CALIBRATION_REPETITIONS },
        (_, index) => ({
          caseId: calibrationCase.caseId,
          repetition: index + 1,
          requestedModel: policyInput.judge.model,
          observedModelRevision,
          assetBundleRevision: policyInput.assets.revision,
          verdict: {
            score: 0.95,
            confidence: 0.95,
            assertions: [{ assertionId: "outcome_complete", passed: true }],
            reasonCodes: ["TEST_CALIBRATION"],
            repairable: false,
            disposition: "continue" as const,
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            costUsd: 0,
          },
          latencyMs: 1,
        }),
      ),
    );
  const draft = {
    version: EVALUATION_CALIBRATION_RECORD_VERSION,
    recordId: policyInput.calibration.recordId,
    evaluator: policyInput.evaluator,
    assetBundleRevision: policyInput.assets.revision,
    requestedRoute: {
      provider: policyInput.judge.provider,
      model: policyInput.judge.model,
      modelRegistrationRevision: policyInput.judge.modelRegistrationRevision,
    },
    observedModelRevision,
    datasetRevision: policyInput.assets.calibrationDatasetRevision,
    repetitionsPerCase: RUNTIME_EVALUATION_CALIBRATION_REPETITIONS,
    caseCount: COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1.length,
    metrics: {
      falseAccepts: 0,
      falseRejects: 0,
      ambiguousReviews: 4,
      integrityContinues: 0,
      dispositionRepeatability: 1,
      thresholdStabilityFailures: 0,
    },
    runs,
    passed: true,
    createdAt: "2026-08-04T12:00:00.000Z",
  };
  const calibrationRecord = parseEvaluationCalibrationRecordV1({
    ...draft,
    revision: digestCanonicalValue({ ...draft, revision: undefined }),
  });
  const policy = createRuntimeEvaluationPolicyV1({
    ...policyInput,
    calibration: {
      ...policyInput.calibration,
      recordRevision: calibrationRecord.revision,
    },
  });
  return { policy, calibrationRecord };
}
