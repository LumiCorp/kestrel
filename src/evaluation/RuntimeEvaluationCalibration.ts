import {
  EVALUATION_CALIBRATION_RECORD_VERSION,
  RUNTIME_EVALUATION_REQUEST_VERSION,
  digestCanonicalValue,
  parseEvaluationCalibrationRecordV1,
  parseRuntimeEvaluationPolicyV1,
  parseRuntimeEvaluationRequestV1,
  parseRuntimeEvaluationVerdictV1,
  type EvaluationCalibrationRecordV1,
  type EvaluationCalibrationRunV1,
  type RuntimeEvaluationPolicyV1,
  type RuntimeEvaluationThresholdsV1,
  type RuntimeEvaluationVerdictV1,
} from "../kestrel/contracts/evaluation.js";
import type { ModelRequest } from "../kestrel/contracts/model-io.js";
import {
  buildEvaluationEvidenceProjectionV1,
  mapRuntimeEvaluationVerdict,
} from "./RuntimeEvaluationCoordinator.js";
import type {
  RuntimeEvaluationJudgeResultV1,
  RuntimeEvaluatorRegistry,
} from "./RuntimeEvaluatorRegistry.js";
import {
  COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1,
  type CompletionEvidenceCalibrationCaseV1,
} from "./calibration/dataset.js";

export const RUNTIME_EVALUATION_CALIBRATION_REPETITIONS = 3 as const;
export const RUNTIME_EVALUATION_CALIBRATION_THRESHOLDS = Object.freeze([
  0.75,
  0.8,
  0.85,
] as const);

export async function runRuntimeEvaluationCalibrationV1(input: {
  policy: RuntimeEvaluationPolicyV1;
  evaluatorRegistry: RuntimeEvaluatorRegistry;
  invokeJudge(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<RuntimeEvaluationJudgeResultV1>;
  now?: (() => Date) | undefined;
  signal?: AbortSignal | undefined;
}): Promise<EvaluationCalibrationRecordV1> {
  const policy = parseRuntimeEvaluationPolicyV1(input.policy);
  const evaluator = input.evaluatorRegistry.require(policy.evaluator);
  const runs: EvaluationCalibrationRunV1[] = [];
  for (const calibrationCase of COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1) {
    const caseToken = digestCanonicalValue(calibrationCase.caseId).slice(-24);
    for (
      let repetition = 1;
      repetition <= RUNTIME_EVALUATION_CALIBRATION_REPETITIONS;
      repetition += 1
    ) {
      throwIfAborted(input.signal);
      const createdAt = (input.now ?? (() => new Date()))().toISOString();
      const projection = buildEvaluationEvidenceProjectionV1({
        runId: `calibration-run:${caseToken}:${repetition}`,
        sessionId: `calibration-session:${caseToken}`,
        stepIndex: repetition,
        profileFingerprint: "c".repeat(64),
        policyRevision: policy.revision,
        hookKind: "pre_delivery",
        sourceId: "pre_delivery",
        objective: calibrationCase.objective,
        candidateOutput: calibrationCase.candidateOutput,
        evidence: calibrationCase.evidence.map((entry, index) => ({
          ...entry,
          evidenceId: `calibration-evidence:${caseToken}:${index + 1}`,
        })),
        createdAt,
      });
      const request = parseRuntimeEvaluationRequestV1({
        version: RUNTIME_EVALUATION_REQUEST_VERSION,
        requestId: `evaluation-request:calibration:${caseToken}:${repetition}`,
        evaluator: policy.evaluator,
        assets: policy.assets,
        judge: policy.judge,
        projection,
        projectionDigest: digestCanonicalValue(projection),
        budget: {
          evaluationsUsed: repetition - 1,
          intermediateEvaluationsUsed: 0,
          totalTokensUsed: 0,
          totalCostUsd: 0,
          finalRevisionsUsed: 0,
        },
        createdAt,
      });
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("EVALUATION_TIMEOUT")),
        policy.budget.timeoutMs,
      );
      const onAbort = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      let verdict: RuntimeEvaluationVerdictV1;
      try {
        verdict = parseRuntimeEvaluationVerdictV1(
          await evaluator.evaluate(request, {
            signal: controller.signal,
            invokeJudge: (judgeRequest) =>
              input.invokeJudge(judgeRequest, controller.signal),
          }),
        );
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new Error("Evaluation calibration cancelled.");
        }
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
      }
      const disposition = calibrationDisposition(verdict, policy);
      runs.push({
        caseId: calibrationCase.caseId,
        repetition,
        requestedModel: verdict.judge.requestedModel,
        observedModelRevision: verdict.judge.observedModelRevision,
        assetBundleRevision: policy.assets.revision,
        verdict: {
          score: verdict.score,
          confidence: verdict.confidence,
          assertions: verdict.assertions.map((assertion) => ({
            assertionId: assertion.assertionId,
            passed: assertion.passed,
          })),
          reasonCodes: [...verdict.reasonCodes],
          repairable: verdict.repairable,
          disposition,
        },
        usage: { ...verdict.usage },
        latencyMs: verdict.latencyMs,
      });
    }
  }

  const observedRevisions = [...new Set(
    runs.map((run) => run.observedModelRevision),
  )];
  if (observedRevisions.length !== 1 || observedRevisions[0] === undefined) {
    throw new Error(
      "Evaluation calibration observed more than one model revision.",
    );
  }
  const metrics = calibrationMetrics(
    COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1,
    runs,
    policy,
  );
  const passed =
    metrics.falseAccepts === 0 &&
    metrics.falseRejects <= 1 &&
    metrics.ambiguousReviews >= 3 &&
    metrics.integrityContinues === 0 &&
    metrics.dispositionRepeatability >= 0.9 &&
    metrics.thresholdStabilityFailures === 0;
  const draft = {
    version: EVALUATION_CALIBRATION_RECORD_VERSION,
    recordId: policy.calibration.recordId,
    evaluator: policy.evaluator,
    assetBundleRevision: policy.assets.revision,
    requestedRoute: {
      provider: policy.judge.provider,
      model: policy.judge.model,
      modelRegistrationRevision: policy.judge.modelRegistrationRevision,
    },
    observedModelRevision: observedRevisions[0],
    datasetRevision: policy.assets.calibrationDatasetRevision,
    repetitionsPerCase: RUNTIME_EVALUATION_CALIBRATION_REPETITIONS,
    caseCount: COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1.length,
    metrics,
    runs,
    passed,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  return parseEvaluationCalibrationRecordV1({
    ...draft,
    revision: digestCanonicalValue({ ...draft, revision: undefined }),
  });
}

export function assertRuntimeEvaluationCalibrationV1(
  policyInput: RuntimeEvaluationPolicyV1,
  recordInput: EvaluationCalibrationRecordV1,
): EvaluationCalibrationRecordV1 {
  const policy = parseRuntimeEvaluationPolicyV1(policyInput);
  const record = parseEvaluationCalibrationRecordV1(recordInput);
  const caseIds = new Set(record.runs?.map((run) => run.caseId) ?? []);
  if (
    record.passed !== true ||
    record.recordId !== policy.calibration.recordId ||
    record.revision !== policy.calibration.recordRevision ||
    record.evaluator.evaluatorId !== policy.evaluator.evaluatorId ||
    record.evaluator.evaluatorVersion !== policy.evaluator.evaluatorVersion ||
    record.assetBundleRevision !== policy.assets.revision ||
    record.datasetRevision !== policy.assets.calibrationDatasetRevision ||
    record.requestedRoute.provider !== policy.judge.provider ||
    record.requestedRoute.model !== policy.judge.model ||
    record.requestedRoute.modelRegistrationRevision !==
      policy.judge.modelRegistrationRevision ||
    record.repetitionsPerCase !== RUNTIME_EVALUATION_CALIBRATION_REPETITIONS ||
    record.caseCount !== COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1.length ||
    record.runs?.length !==
      COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1.length *
        RUNTIME_EVALUATION_CALIBRATION_REPETITIONS ||
    caseIds.size !== COMPLETION_EVIDENCE_CALIBRATION_DATASET_V1.length ||
    record.runs.some(
      (run) =>
        run.requestedModel !== policy.judge.model ||
        run.observedModelRevision !== record.observedModelRevision ||
        run.assetBundleRevision !== policy.assets.revision,
    )
  ) {
    throw new Error(
      "Runtime evaluation requires a passing calibration record matching the exact evaluator, assets, dataset, and model route.",
    );
  }
  return record;
}

function calibrationMetrics(
  cases: readonly CompletionEvidenceCalibrationCaseV1[],
  runs: EvaluationCalibrationRunV1[],
  policy: RuntimeEvaluationPolicyV1,
): EvaluationCalibrationRecordV1["metrics"] {
  let falseAccepts = 0;
  let falseRejects = 0;
  let ambiguousReviews = 0;
  let integrityContinues = 0;
  let repeatableRuns = 0;
  let thresholdStabilityFailures = 0;
  for (const calibrationCase of cases) {
    const caseRuns = runs.filter((run) => run.caseId === calibrationCase.caseId);
    const dispositions = caseRuns.map((run) => run.verdict.disposition);
    const majority = mostFrequent(dispositions);
    repeatableRuns += dispositions.filter((value) => value === majority).length;
    if (
      calibrationCase.category === "invalid" &&
      dispositions.includes("continue")
    ) {
      falseAccepts += 1;
    }
    if (
      calibrationCase.category === "valid" &&
      majority !== "continue"
    ) {
      falseRejects += 1;
    }
    if (
      calibrationCase.category === "ambiguous" &&
      majority === "review"
    ) {
      ambiguousReviews += 1;
    }
    if (
      calibrationCase.category === "integrity"
    ) {
      integrityContinues += dispositions.filter(
        (value) => value === "continue",
      ).length;
    }
    for (const run of caseRuns) {
      const thresholdDispositions = RUNTIME_EVALUATION_CALIBRATION_THRESHOLDS.map(
        (passScore) => calibrationDisposition(
          calibrationRunVerdict(run, policy),
          policy,
          passScore,
        ),
      );
      if (
        (calibrationCase.category === "invalid" &&
          thresholdDispositions.includes("continue")) ||
        (calibrationCase.thresholdBoundary === false &&
          new Set(thresholdDispositions).size > 1)
      ) {
        thresholdStabilityFailures += 1;
      }
    }
  }
  return {
    falseAccepts,
    falseRejects,
    ambiguousReviews,
    integrityContinues,
    dispositionRepeatability: runs.length === 0 ? 0 : repeatableRuns / runs.length,
    thresholdStabilityFailures,
  };
}

function calibrationDisposition(
  verdict: RuntimeEvaluationVerdictV1,
  policy: RuntimeEvaluationPolicyV1,
  passScore: number = policy.thresholds.passScore,
): EvaluationCalibrationRunV1["verdict"]["disposition"] {
  const mapped = mapRuntimeEvaluationVerdict({
    hookKind: "pre_delivery",
    verdict,
    policy: {
      ...policy,
      thresholds: {
        ...policy.thresholds,
        passScore,
      } as RuntimeEvaluationThresholdsV1,
    },
    finalRevisionsUsed: 0,
  });
  if (
    mapped.disposition !== "continue" &&
    mapped.disposition !== "revise" &&
    mapped.disposition !== "review" &&
    mapped.disposition !== "quarantine"
  ) {
    throw new Error("Calibration produced an unsupported disposition.");
  }
  return mapped.disposition;
}

function calibrationRunVerdict(
  run: EvaluationCalibrationRunV1,
  policy: RuntimeEvaluationPolicyV1,
): RuntimeEvaluationVerdictV1 {
  return {
    version: "runtime_evaluation_verdict_v1",
    verdictId: `evaluation-verdict:${run.caseId}:${run.repetition}`,
    requestId: `evaluation-request:${run.caseId}:${run.repetition}`,
    evaluator: policy.evaluator,
    judge: {
      provider: policy.judge.provider,
      requestedModel: run.requestedModel,
      observedModelRevision: run.observedModelRevision,
      routeIndependence: "shared_primary_route",
    },
    score: run.verdict.score,
    confidence: run.verdict.confidence,
    assertions: run.verdict.assertions.map((assertion) => ({
      ...assertion,
      required: true,
      rationale: "Calibration assertion.",
      evidenceRefs: [],
    })),
    rationale: "Calibration verdict.",
    reasonCodes: [...run.verdict.reasonCodes],
    repairable: run.verdict.repairable,
    usage: { ...run.usage },
    latencyMs: run.latencyMs,
    createdAt: "2026-08-04T12:00:00.000Z",
  };
}

function mostFrequent<T extends string>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(
    ([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || leftValue.localeCompare(rightValue),
  )[0]?.[0];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("Evaluation calibration cancelled.");
  }
}
