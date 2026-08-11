import { createHash } from "node:crypto";

import {
  parseRecoveryModelCredentialReferenceV1,
  type RecoveryModelCandidateV1,
  type RecoveryModelCredentialReferenceV1,
  type RecoveryModelProviderV1,
} from "./recovery.js";

export const RUNTIME_EVALUATION_POLICY_VERSION =
  "runtime_evaluation_policy_v1" as const;
export const EVALUATION_EVIDENCE_PROJECTION_VERSION =
  "evaluation_evidence_projection_v1" as const;
export const RUNTIME_EVALUATION_REQUEST_VERSION =
  "runtime_evaluation_request_v1" as const;
export const RUNTIME_EVALUATION_VERDICT_VERSION =
  "runtime_evaluation_verdict_v1" as const;
export const RUNTIME_EVALUATION_DECISION_VERSION =
  "runtime_evaluation_decision_v1" as const;
export const EVALUATION_CALIBRATION_RECORD_VERSION =
  "evaluation_calibration_record_v1" as const;
export const EVALUATION_REVIEW_BINDING_VERSION =
  "evaluation_review_binding_v1" as const;

export const COMPLETION_EVIDENCE_EVALUATOR_ID = "completion-evidence" as const;
export const COMPLETION_EVIDENCE_EVALUATOR_VERSION = "1.0.0" as const;

export type RuntimeEvaluationHookKindV1 =
  | "after_tool"
  | "milestone"
  | "handoff"
  | "pre_delivery";

export type RuntimeEvaluationDispositionV1 =
  | "continue"
  | "revise"
  | "review"
  | "quarantine"
  | "halt"
  | "skipped";

export interface RuntimeEvaluationAssetBundleRefV1 {
  bundleId: string;
  revision: string;
  rubricRevision: string;
  assertionsRevision: string;
  promptRevision: string;
  schemaRevision: string;
  calibrationDatasetRevision: string;
  evaluatorCodeRevision: string;
}

export interface RuntimeEvaluationJudgeRouteV1 {
  route: "profile_primary";
  provider: RecoveryModelProviderV1;
  model: string;
  modelRegistrationRevision: string;
  capabilities: RecoveryModelCandidateV1["capabilities"];
  credentialReference?: RecoveryModelCredentialReferenceV1 | undefined;
  pricing: {
    priceRevision: string;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  };
}

export interface RuntimeEvaluationHookV1 {
  kind: RuntimeEvaluationHookKindV1;
  mode: "advisory" | "blocking";
  selectorIds: string[];
}

export interface RuntimeEvaluationBudgetV1 {
  maxEvaluationsPerRun: 4;
  maxIntermediateEvaluations: 2;
  reservedFinalEvaluations: 2;
  maxAttemptsPerEvaluation: 1;
  timeoutMs: 15_000;
  maxConcurrentEvaluations: 1;
  maxInputTokensPerEvaluation: 3_500;
  maxOutputTokensPerEvaluation: 500;
  maxTotalTokens: 16_000;
  maxTotalCostUsd: 0.05;
  maxFinalRevisions: 1;
}

export interface RuntimeEvaluationThresholdsV1 {
  passScore: 0.8;
  minimumConfidence: 0.7;
  integrityQuarantineConfidence: 0.7;
}

export interface RuntimeEvaluationPolicyV1 {
  version: typeof RUNTIME_EVALUATION_POLICY_VERSION;
  policyId: string;
  revision: string;
  evaluator: {
    evaluatorId: string;
    evaluatorVersion: string;
  };
  assets: RuntimeEvaluationAssetBundleRefV1;
  judge: RuntimeEvaluationJudgeRouteV1;
  calibration: {
    recordId: string;
    recordRevision: string;
  };
  hooks: RuntimeEvaluationHookV1[];
  budget: RuntimeEvaluationBudgetV1;
  thresholds: RuntimeEvaluationThresholdsV1;
  actions: {
    revisionHandlerId: "evaluation.revise";
    reviewOptionIds: Array<
      "evaluation.accept_once" | "evaluation.revise" | "terminal.fail"
    >;
  };
}

export interface EvaluationReviewBindingV1 {
  version: typeof EVALUATION_REVIEW_BINDING_VERSION;
  requestId: string;
  threadId: string;
  runId: string;
  evaluationDecisionId: string;
  policyRevision: string;
  profileFingerprint: string;
  allowedOptionIds: Array<
    "evaluation.accept_once" | "evaluation.revise" | "terminal.fail"
  >;
  issuedAt: string;
  expiresAt?: string | undefined;
  tenantId?: string | undefined;
}

export function createEvaluationReviewBindingV1(
  input: Omit<EvaluationReviewBindingV1, "version">,
): EvaluationReviewBindingV1 {
  return parseEvaluationReviewBindingV1({
    version: EVALUATION_REVIEW_BINDING_VERSION,
    ...input,
  });
}

export function parseEvaluationReviewBindingV1(
  value: unknown,
): EvaluationReviewBindingV1 {
  const record = requireRecord(value, "Evaluation review binding");
  rejectUnknownFields(
    record,
    new Set([
      "version",
      "requestId",
      "threadId",
      "runId",
      "evaluationDecisionId",
      "policyRevision",
      "profileFingerprint",
      "allowedOptionIds",
      "issuedAt",
      "expiresAt",
      "tenantId",
    ]),
    "Evaluation review binding",
  );
  if (record.version !== EVALUATION_REVIEW_BINDING_VERSION) {
    throw new Error(
      `Evaluation review binding version must be '${EVALUATION_REVIEW_BINDING_VERSION}'.`,
    );
  }
  const allowedOptionIds = requireArray(
    record.allowedOptionIds,
    "Evaluation review binding allowedOptionIds",
  ).map((value, index) =>
    requireExactId(value, `Evaluation review binding allowedOptionIds[${index}]`),
  );
  const supported = new Set([
    "evaluation.accept_once",
    "evaluation.revise",
    "terminal.fail",
  ]);
  if (
    allowedOptionIds.length === 0 ||
    allowedOptionIds.some((optionId) => supported.has(optionId) === false)
  ) {
    throw new Error("Evaluation review binding contains an unsupported option ID.");
  }
  requireUnique(allowedOptionIds, "Evaluation review binding allowedOptionIds");
  return {
    version: EVALUATION_REVIEW_BINDING_VERSION,
    requestId: requireBoundedString(record.requestId, "Evaluation review binding requestId", 512),
    threadId: requireBoundedString(record.threadId, "Evaluation review binding threadId", 512),
    runId: requireBoundedString(record.runId, "Evaluation review binding runId", 512),
    evaluationDecisionId: requireBoundedString(
      record.evaluationDecisionId,
      "Evaluation review binding evaluationDecisionId",
      512,
    ),
    policyRevision: requireBoundedString(
      record.policyRevision,
      "Evaluation review binding policyRevision",
      512,
    ),
    profileFingerprint: requireBoundedString(
      record.profileFingerprint,
      "Evaluation review binding profileFingerprint",
      512,
    ),
    allowedOptionIds: allowedOptionIds as EvaluationReviewBindingV1["allowedOptionIds"],
    issuedAt: requireTimestamp(record.issuedAt, "Evaluation review binding issuedAt"),
    ...(record.expiresAt !== undefined
      ? { expiresAt: requireTimestamp(record.expiresAt, "Evaluation review binding expiresAt") }
      : {}),
    ...(record.tenantId !== undefined
      ? { tenantId: requireBoundedString(record.tenantId, "Evaluation review binding tenantId", 512) }
      : {}),
  };
}

export interface EvaluationEvidenceProjectionV1 {
  version: typeof EVALUATION_EVIDENCE_PROJECTION_VERSION;
  identity: {
    runId: string;
    sessionId: string;
    threadId?: string | undefined;
    stepIndex: number;
    profileFingerprint: string;
    policyRevision: string;
  };
  hook: {
    kind: RuntimeEvaluationHookKindV1;
    sourceId: string;
  };
  objective: string;
  candidateOutput?: string | undefined;
  evidence: Array<{
    evidenceId: string;
    kind: "tool" | "milestone" | "handoff" | "claim" | "artifact";
    summary: string;
    digest: string;
  }>;
  truncations: Array<{
    field: string;
    originalDigest: string;
    retainedChars: number;
  }>;
  createdAt: string;
}

export interface RuntimeEvaluationRequestV1 {
  version: typeof RUNTIME_EVALUATION_REQUEST_VERSION;
  requestId: string;
  evaluator: RuntimeEvaluationPolicyV1["evaluator"];
  assets: RuntimeEvaluationAssetBundleRefV1;
  judge: RuntimeEvaluationJudgeRouteV1;
  projection: EvaluationEvidenceProjectionV1;
  projectionDigest: string;
  budget: {
    evaluationsUsed: number;
    intermediateEvaluationsUsed: number;
    totalTokensUsed: number;
    totalCostUsd: number;
    finalRevisionsUsed: number;
  };
  createdAt: string;
}

export interface RuntimeEvaluationAssertionV1 {
  assertionId: string;
  required: boolean;
  passed: boolean;
  rationale: string;
  evidenceRefs: string[];
}

export interface RuntimeEvaluationVerdictV1 {
  version: typeof RUNTIME_EVALUATION_VERDICT_VERSION;
  verdictId: string;
  requestId: string;
  evaluator: RuntimeEvaluationPolicyV1["evaluator"];
  judge: {
    provider: RecoveryModelProviderV1;
    requestedModel: string;
    observedModelRevision: string;
    routeIndependence: "shared_primary_route";
  };
  score: number;
  confidence: number;
  assertions: RuntimeEvaluationAssertionV1[];
  rationale: string;
  reasonCodes: string[];
  repairable: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  latencyMs: number;
  createdAt: string;
}

export interface RuntimeEvaluationDecisionV1 {
  version: typeof RUNTIME_EVALUATION_DECISION_VERSION;
  decisionId: string;
  requestId: string;
  verdictId?: string | undefined;
  runId: string;
  sessionId: string;
  profileFingerprint: string;
  policyRevision: string;
  thresholds: RuntimeEvaluationThresholdsV1;
  budget: RuntimeEvaluationRequestV1["budget"];
  disposition: RuntimeEvaluationDispositionV1;
  reasonCode: string;
  /** @deprecated Read compatibility for historical evaluation artifacts. */
  recoveryDecisionId?: string | undefined;
  createdAt: string;
}

export interface EvaluationCalibrationRecordV1 {
  version: typeof EVALUATION_CALIBRATION_RECORD_VERSION;
  recordId: string;
  revision: string;
  evaluator: RuntimeEvaluationPolicyV1["evaluator"];
  assetBundleRevision: string;
  requestedRoute: {
    provider: RecoveryModelProviderV1;
    model: string;
    modelRegistrationRevision: string;
  };
  observedModelRevision: string;
  datasetRevision: string;
  repetitionsPerCase: number;
  caseCount: number;
  metrics: {
    falseAccepts: number;
    falseRejects: number;
    ambiguousReviews: number;
    integrityContinues: number;
    dispositionRepeatability: number;
    thresholdStabilityFailures: number;
  };
  runs?: EvaluationCalibrationRunV1[] | undefined;
  passed: boolean;
  createdAt: string;
}

export interface EvaluationCalibrationRunV1 {
  caseId: string;
  repetition: number;
  requestedModel: string;
  observedModelRevision: string;
  assetBundleRevision: string;
  verdict: {
    score: number;
    confidence: number;
    assertions: Array<{
      assertionId: string;
      passed: boolean;
    }>;
    reasonCodes: string[];
    repairable: boolean;
    disposition: "continue" | "revise" | "review" | "quarantine";
  };
  usage: RuntimeEvaluationVerdictV1["usage"];
  latencyMs: number;
}

export const LEAN_RUNTIME_EVALUATION_BUDGET_V1: RuntimeEvaluationBudgetV1 =
  Object.freeze({
    maxEvaluationsPerRun: 4,
    maxIntermediateEvaluations: 2,
    reservedFinalEvaluations: 2,
    maxAttemptsPerEvaluation: 1,
    timeoutMs: 15_000,
    maxConcurrentEvaluations: 1,
    maxInputTokensPerEvaluation: 3_500,
    maxOutputTokensPerEvaluation: 500,
    maxTotalTokens: 16_000,
    maxTotalCostUsd: 0.05,
    maxFinalRevisions: 1,
  });

export const RUNTIME_EVALUATION_THRESHOLDS_V1: RuntimeEvaluationThresholdsV1 =
  Object.freeze({
    passScore: 0.8,
    minimumConfidence: 0.7,
    integrityQuarantineConfidence: 0.7,
  });

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PROFILE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const EXACT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u;
const POLICY_FIELDS = new Set([
  "version",
  "policyId",
  "revision",
  "evaluator",
  "assets",
  "judge",
  "calibration",
  "hooks",
  "budget",
  "thresholds",
  "actions",
]);

export function createRuntimeEvaluationPolicyV1(
  input: Omit<RuntimeEvaluationPolicyV1, "version" | "revision">,
): RuntimeEvaluationPolicyV1 {
  const draft = {
    version: RUNTIME_EVALUATION_POLICY_VERSION,
    ...structuredClone(input),
    revision: emptyHash(),
  } satisfies RuntimeEvaluationPolicyV1;
  const policy = {
    ...draft,
    revision: digestCanonicalValue({ ...draft, revision: undefined }),
  };
  return parseRuntimeEvaluationPolicyV1(policy);
}

export function fingerprintRuntimeEvaluationPolicyV1(
  policy: RuntimeEvaluationPolicyV1,
): string {
  const parsed = parseRuntimeEvaluationPolicyV1(policy);
  return digestCanonicalValue({ ...parsed, revision: undefined });
}

export function parseRuntimeEvaluationPolicyV1(
  value: unknown,
): RuntimeEvaluationPolicyV1 {
  const record = requireRecord(value, "Runtime evaluation policy");
  rejectUnknownFields(record, POLICY_FIELDS, "Runtime evaluation policy");
  if (record.version !== RUNTIME_EVALUATION_POLICY_VERSION) {
    throw new Error(
      `Runtime evaluation policy version must be '${RUNTIME_EVALUATION_POLICY_VERSION}'.`,
    );
  }
  const evaluator = parseEvaluatorRef(
    record.evaluator,
    "Runtime evaluation policy evaluator",
  );
  const assets = parseAssetBundleRef(
    record.assets,
    "Runtime evaluation policy assets",
  );
  const judge = parseJudge(record.judge, "Runtime evaluation policy judge");
  const calibrationRecord = requireRecord(
    record.calibration,
    "Runtime evaluation policy calibration",
  );
  rejectUnknownFields(
    calibrationRecord,
    new Set(["recordId", "recordRevision"]),
    "Runtime evaluation policy calibration",
  );
  const hooks = requireArray(
    record.hooks,
    "Runtime evaluation policy hooks",
  ).map((hook, index) =>
    parseHook(hook, `Runtime evaluation policy hooks[${index}]`),
  );
  requireUnique(
    hooks.map((hook) => hook.kind),
    "Runtime evaluation policy hook kinds",
  );
  const preDelivery = hooks.find((hook) => hook.kind === "pre_delivery");
  if (
    preDelivery === undefined ||
    preDelivery.mode !== "blocking" ||
    preDelivery.selectorIds.length !== 0
  ) {
    throw new Error(
      "Runtime evaluation policy requires one selector-free blocking pre_delivery hook.",
    );
  }
  if (
    hooks.some(
      (hook) => hook.kind !== "pre_delivery" && hook.mode !== "advisory",
    )
  ) {
    throw new Error("Runtime evaluation intermediate hooks must be advisory.");
  }
  const policy: RuntimeEvaluationPolicyV1 = {
    version: RUNTIME_EVALUATION_POLICY_VERSION,
    policyId: requireExactId(
      record.policyId,
      "Runtime evaluation policy policyId",
    ),
    revision: requireHash(
      record.revision,
      "Runtime evaluation policy revision",
    ),
    evaluator,
    assets,
    judge,
    calibration: {
      recordId: requireExactId(
        calibrationRecord.recordId,
        "Runtime evaluation policy calibration recordId",
      ),
      recordRevision: requireHash(
        calibrationRecord.recordRevision,
        "Runtime evaluation policy calibration recordRevision",
      ),
    },
    hooks,
    budget: parseLeanBudget(record.budget),
    thresholds: parseThresholds(record.thresholds),
    actions: parseActions(record.actions),
  };
  const expectedRevision = digestCanonicalValue({
    ...policy,
    revision: undefined,
  });
  if (policy.revision !== expectedRevision) {
    throw new Error(
      "Runtime evaluation policy revision does not match canonical content.",
    );
  }
  return policy;
}

export function parseEvaluationEvidenceProjectionV1(
  value: unknown,
): EvaluationEvidenceProjectionV1 {
  const record = requireRecord(value, "Evaluation evidence projection");
  rejectUnknownFields(
    record,
    new Set([
      "version",
      "identity",
      "hook",
      "objective",
      "candidateOutput",
      "evidence",
      "truncations",
      "createdAt",
    ]),
    "Evaluation evidence projection",
  );
  if (record.version !== EVALUATION_EVIDENCE_PROJECTION_VERSION) {
    throw new Error(
      `Evaluation evidence projection version must be '${EVALUATION_EVIDENCE_PROJECTION_VERSION}'.`,
    );
  }
  const identity = requireRecord(
    record.identity,
    "Evaluation evidence projection identity",
  );
  rejectUnknownFields(
    identity,
    new Set([
      "runId",
      "sessionId",
      "threadId",
      "stepIndex",
      "profileFingerprint",
      "policyRevision",
    ]),
    "Evaluation evidence projection identity",
  );
  const hook = requireRecord(
    record.hook,
    "Evaluation evidence projection hook",
  );
  rejectUnknownFields(
    hook,
    new Set(["kind", "sourceId"]),
    "Evaluation evidence projection hook",
  );
  const candidateOutput = optionalBoundedString(
    record.candidateOutput,
    "Evaluation evidence projection candidateOutput",
    16_000,
  );
  const evidence = requireArray(
    record.evidence,
    "Evaluation evidence projection evidence",
  ).map((item, index) => {
    const entry = requireRecord(
      item,
      `Evaluation evidence projection evidence[${index}]`,
    );
    rejectUnknownFields(
      entry,
      new Set(["evidenceId", "kind", "summary", "digest"]),
      `Evaluation evidence projection evidence[${index}]`,
    );
    if (
      !["tool", "milestone", "handoff", "claim", "artifact"].includes(
        String(entry.kind),
      )
    ) {
      throw new Error(
        `Evaluation evidence projection evidence[${index}] kind is invalid.`,
      );
    }
    return {
      evidenceId: requireExactId(
        entry.evidenceId,
        `Evaluation evidence projection evidence[${index}] evidenceId`,
      ),
      kind: entry.kind as EvaluationEvidenceProjectionV1["evidence"][number]["kind"],
      summary: requireBoundedString(
        entry.summary,
        `Evaluation evidence projection evidence[${index}] summary`,
        2_000,
      ),
      digest: requireHash(
        entry.digest,
        `Evaluation evidence projection evidence[${index}] digest`,
      ),
    };
  });
  if (evidence.length > 64)
    throw new Error(
      "Evaluation evidence projection evidence exceeds 64 entries.",
    );
  requireUnique(
    evidence.map((entry) => entry.evidenceId),
    "Evaluation evidence projection evidence IDs",
  );
  const truncations = requireArray(
    record.truncations,
    "Evaluation evidence projection truncations",
  ).map((item, index) => {
    const entry = requireRecord(
      item,
      `Evaluation evidence projection truncations[${index}]`,
    );
    rejectUnknownFields(
      entry,
      new Set(["field", "originalDigest", "retainedChars"]),
      `Evaluation evidence projection truncations[${index}]`,
    );
    return {
      field: requireExactId(
        entry.field,
        `Evaluation evidence projection truncations[${index}] field`,
      ),
      originalDigest: requireHash(
        entry.originalDigest,
        `Evaluation evidence projection truncations[${index}] originalDigest`,
      ),
      retainedChars: requireNonNegativeInteger(
        entry.retainedChars,
        `Evaluation evidence projection truncations[${index}] retainedChars`,
        16_000,
      ),
    };
  });
  if (truncations.length > 64)
    throw new Error(
      "Evaluation evidence projection truncations exceeds 64 entries.",
    );
  return {
    version: EVALUATION_EVIDENCE_PROJECTION_VERSION,
    identity: {
      runId: requireExactId(
        identity.runId,
        "Evaluation evidence projection identity runId",
      ),
      sessionId: requireExactId(
        identity.sessionId,
        "Evaluation evidence projection identity sessionId",
      ),
      ...(identity.threadId !== undefined
        ? {
            threadId: requireExactId(
              identity.threadId,
              "Evaluation evidence projection identity threadId",
            ),
          }
        : {}),
      stepIndex: requireNonNegativeInteger(
        identity.stepIndex,
        "Evaluation evidence projection identity stepIndex",
        Number.MAX_SAFE_INTEGER,
      ),
      profileFingerprint: requireProfileFingerprint(
        identity.profileFingerprint,
        "Evaluation evidence projection identity profileFingerprint",
      ),
      policyRevision: requireHash(
        identity.policyRevision,
        "Evaluation evidence projection identity policyRevision",
      ),
    },
    hook: {
      kind: requireHookKind(
        hook.kind,
        "Evaluation evidence projection hook kind",
      ),
      sourceId: requireExactId(
        hook.sourceId,
        "Evaluation evidence projection hook sourceId",
      ),
    },
    objective: requireBoundedString(
      record.objective,
      "Evaluation evidence projection objective",
      8_000,
    ),
    ...(candidateOutput !== undefined ? { candidateOutput } : {}),
    evidence,
    truncations,
    createdAt: requireTimestamp(
      record.createdAt,
      "Evaluation evidence projection createdAt",
    ),
  };
}

export function parseRuntimeEvaluationRequestV1(
  value: unknown,
): RuntimeEvaluationRequestV1 {
  const record = requireRecord(value, "Runtime evaluation request");
  rejectUnknownFields(
    record,
    new Set([
      "version",
      "requestId",
      "evaluator",
      "assets",
      "judge",
      "projection",
      "projectionDigest",
      "budget",
      "createdAt",
    ]),
    "Runtime evaluation request",
  );
  if (record.version !== RUNTIME_EVALUATION_REQUEST_VERSION)
    throw new Error(
      `Runtime evaluation request version must be '${RUNTIME_EVALUATION_REQUEST_VERSION}'.`,
    );
  const projection = parseEvaluationEvidenceProjectionV1(record.projection);
  const projectionDigest = requireHash(
    record.projectionDigest,
    "Runtime evaluation request projectionDigest",
  );
  if (projectionDigest !== digestCanonicalValue(projection))
    throw new Error(
      "Runtime evaluation request projectionDigest does not match projection.",
    );
  return {
    version: RUNTIME_EVALUATION_REQUEST_VERSION,
    requestId: requireExactId(
      record.requestId,
      "Runtime evaluation request requestId",
    ),
    evaluator: parseEvaluatorRef(
      record.evaluator,
      "Runtime evaluation request evaluator",
    ),
    assets: parseAssetBundleRef(
      record.assets,
      "Runtime evaluation request assets",
    ),
    judge: parseJudge(record.judge, "Runtime evaluation request judge"),
    projection,
    projectionDigest,
    budget: parseBudgetSnapshot(
      record.budget,
      "Runtime evaluation request budget",
    ),
    createdAt: requireTimestamp(
      record.createdAt,
      "Runtime evaluation request createdAt",
    ),
  };
}

export function parseRuntimeEvaluationVerdictV1(
  value: unknown,
): RuntimeEvaluationVerdictV1 {
  const record = requireRecord(value, "Runtime evaluation verdict");
  rejectUnknownFields(
    record,
    new Set([
      "version",
      "verdictId",
      "requestId",
      "evaluator",
      "judge",
      "score",
      "confidence",
      "assertions",
      "rationale",
      "reasonCodes",
      "repairable",
      "usage",
      "latencyMs",
      "createdAt",
    ]),
    "Runtime evaluation verdict",
  );
  if (record.version !== RUNTIME_EVALUATION_VERDICT_VERSION)
    throw new Error(
      `Runtime evaluation verdict version must be '${RUNTIME_EVALUATION_VERDICT_VERSION}'.`,
    );
  const judge = requireRecord(record.judge, "Runtime evaluation verdict judge");
  rejectUnknownFields(
    judge,
    new Set([
      "provider",
      "requestedModel",
      "observedModelRevision",
      "routeIndependence",
    ]),
    "Runtime evaluation verdict judge",
  );
  if (judge.routeIndependence !== "shared_primary_route")
    throw new Error(
      "Runtime evaluation verdict judge routeIndependence must be 'shared_primary_route'.",
    );
  const assertions = requireArray(
    record.assertions,
    "Runtime evaluation verdict assertions",
  ).map((item, index) => parseAssertion(item, index));
  if (assertions.length === 0 || assertions.length > 32)
    throw new Error(
      "Runtime evaluation verdict assertions must contain 1 to 32 entries.",
    );
  requireUnique(
    assertions.map((assertion) => assertion.assertionId),
    "Runtime evaluation verdict assertion IDs",
  );
  const usage = requireRecord(record.usage, "Runtime evaluation verdict usage");
  rejectUnknownFields(
    usage,
    new Set(["inputTokens", "outputTokens", "totalTokens", "costUsd"]),
    "Runtime evaluation verdict usage",
  );
  const inputTokens = requireNonNegativeInteger(
    usage.inputTokens,
    "Runtime evaluation verdict usage inputTokens",
    3_500,
  );
  const outputTokens = requireNonNegativeInteger(
    usage.outputTokens,
    "Runtime evaluation verdict usage outputTokens",
    500,
  );
  const totalTokens = requireNonNegativeInteger(
    usage.totalTokens,
    "Runtime evaluation verdict usage totalTokens",
    4_000,
  );
  if (inputTokens + outputTokens !== totalTokens)
    throw new Error(
      "Runtime evaluation verdict usage totalTokens must equal inputTokens plus outputTokens.",
    );
  return {
    version: RUNTIME_EVALUATION_VERDICT_VERSION,
    verdictId: requireExactId(
      record.verdictId,
      "Runtime evaluation verdict verdictId",
    ),
    requestId: requireExactId(
      record.requestId,
      "Runtime evaluation verdict requestId",
    ),
    evaluator: parseEvaluatorRef(
      record.evaluator,
      "Runtime evaluation verdict evaluator",
    ),
    judge: {
      provider: requireProvider(
        judge.provider,
        "Runtime evaluation verdict judge provider",
      ),
      requestedModel: requireBoundedString(
        judge.requestedModel,
        "Runtime evaluation verdict judge requestedModel",
        512,
      ),
      observedModelRevision: requireBoundedString(
        judge.observedModelRevision,
        "Runtime evaluation verdict judge observedModelRevision",
        512,
      ),
      routeIndependence: "shared_primary_route",
    },
    score: requireUnitNumber(record.score, "Runtime evaluation verdict score"),
    confidence: requireUnitNumber(
      record.confidence,
      "Runtime evaluation verdict confidence",
    ),
    assertions,
    rationale: requireBoundedString(
      record.rationale,
      "Runtime evaluation verdict rationale",
      2_000,
    ),
    reasonCodes: parseCodeArray(
      record.reasonCodes,
      "Runtime evaluation verdict reasonCodes",
      16,
    ),
    repairable: requireBoolean(
      record.repairable,
      "Runtime evaluation verdict repairable",
    ),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd: requireNonNegativeNumber(
        usage.costUsd,
        "Runtime evaluation verdict usage costUsd",
        0.05,
      ),
    },
    latencyMs: requireNonNegativeInteger(
      record.latencyMs,
      "Runtime evaluation verdict latencyMs",
      15_000,
    ),
    createdAt: requireTimestamp(
      record.createdAt,
      "Runtime evaluation verdict createdAt",
    ),
  };
}

export function parseRuntimeEvaluationDecisionV1(
  value: unknown,
): RuntimeEvaluationDecisionV1 {
  const record = requireRecord(value, "Runtime evaluation decision");
  rejectUnknownFields(
    record,
    new Set([
      "version",
      "decisionId",
      "requestId",
      "verdictId",
      "runId",
      "sessionId",
      "profileFingerprint",
      "policyRevision",
      "thresholds",
      "budget",
      "disposition",
      "reasonCode",
      "recoveryDecisionId",
      "createdAt",
    ]),
    "Runtime evaluation decision",
  );
  if (record.version !== RUNTIME_EVALUATION_DECISION_VERSION)
    throw new Error(
      `Runtime evaluation decision version must be '${RUNTIME_EVALUATION_DECISION_VERSION}'.`,
    );
  if (
    !["continue", "revise", "review", "quarantine", "halt", "skipped"].includes(
      String(record.disposition),
    )
  )
    throw new Error("Runtime evaluation decision disposition is invalid.");
  return {
    version: RUNTIME_EVALUATION_DECISION_VERSION,
    decisionId: requireExactId(
      record.decisionId,
      "Runtime evaluation decision decisionId",
    ),
    requestId: requireExactId(
      record.requestId,
      "Runtime evaluation decision requestId",
    ),
    ...(record.verdictId !== undefined
      ? {
          verdictId: requireExactId(
            record.verdictId,
            "Runtime evaluation decision verdictId",
          ),
        }
      : {}),
    runId: requireExactId(record.runId, "Runtime evaluation decision runId"),
    sessionId: requireExactId(
      record.sessionId,
      "Runtime evaluation decision sessionId",
    ),
    profileFingerprint: requireProfileFingerprint(
      record.profileFingerprint,
      "Runtime evaluation decision profileFingerprint",
    ),
    policyRevision: requireHash(
      record.policyRevision,
      "Runtime evaluation decision policyRevision",
    ),
    thresholds: parseThresholds(record.thresholds),
    budget: parseBudgetSnapshot(
      record.budget,
      "Runtime evaluation decision budget",
    ),
    disposition: record.disposition as RuntimeEvaluationDispositionV1,
    reasonCode: requireExactId(
      record.reasonCode,
      "Runtime evaluation decision reasonCode",
    ),
    ...(record.recoveryDecisionId !== undefined
      ? {
          recoveryDecisionId: requireExactId(
            record.recoveryDecisionId,
            "Runtime evaluation decision recoveryDecisionId",
          ),
        }
      : {}),
    createdAt: requireTimestamp(
      record.createdAt,
      "Runtime evaluation decision createdAt",
    ),
  };
}

export function parseEvaluationCalibrationRecordV1(
  value: unknown,
): EvaluationCalibrationRecordV1 {
  const record = requireRecord(value, "Evaluation calibration record");
  rejectUnknownFields(
    record,
    new Set([
      "version",
      "recordId",
      "revision",
      "evaluator",
      "assetBundleRevision",
      "requestedRoute",
      "observedModelRevision",
      "datasetRevision",
      "repetitionsPerCase",
      "caseCount",
      "metrics",
      "runs",
      "passed",
      "createdAt",
    ]),
    "Evaluation calibration record",
  );
  if (record.version !== EVALUATION_CALIBRATION_RECORD_VERSION)
    throw new Error(
      `Evaluation calibration record version must be '${EVALUATION_CALIBRATION_RECORD_VERSION}'.`,
    );
  const route = requireRecord(
    record.requestedRoute,
    "Evaluation calibration record requestedRoute",
  );
  rejectUnknownFields(
    route,
    new Set(["provider", "model", "modelRegistrationRevision"]),
    "Evaluation calibration record requestedRoute",
  );
  const metrics = requireRecord(
    record.metrics,
    "Evaluation calibration record metrics",
  );
  rejectUnknownFields(
    metrics,
    new Set([
      "falseAccepts",
      "falseRejects",
      "ambiguousReviews",
      "integrityContinues",
      "dispositionRepeatability",
      "thresholdStabilityFailures",
    ]),
    "Evaluation calibration record metrics",
  );
  const parsed: EvaluationCalibrationRecordV1 = {
    version: EVALUATION_CALIBRATION_RECORD_VERSION,
    recordId: requireExactId(
      record.recordId,
      "Evaluation calibration record recordId",
    ),
    revision: requireHash(
      record.revision,
      "Evaluation calibration record revision",
    ),
    evaluator: parseEvaluatorRef(
      record.evaluator,
      "Evaluation calibration record evaluator",
    ),
    assetBundleRevision: requireHash(
      record.assetBundleRevision,
      "Evaluation calibration record assetBundleRevision",
    ),
    requestedRoute: {
      provider: requireProvider(
        route.provider,
        "Evaluation calibration record requestedRoute provider",
      ),
      model: requireBoundedString(
        route.model,
        "Evaluation calibration record requestedRoute model",
        512,
      ),
      modelRegistrationRevision: requireHash(
        route.modelRegistrationRevision,
        "Evaluation calibration record requestedRoute modelRegistrationRevision",
      ),
    },
    observedModelRevision: requireBoundedString(
      record.observedModelRevision,
      "Evaluation calibration record observedModelRevision",
      512,
    ),
    datasetRevision: requireHash(
      record.datasetRevision,
      "Evaluation calibration record datasetRevision",
    ),
    repetitionsPerCase: requirePositiveInteger(
      record.repetitionsPerCase,
      "Evaluation calibration record repetitionsPerCase",
      100,
    ),
    caseCount: requirePositiveInteger(
      record.caseCount,
      "Evaluation calibration record caseCount",
      10_000,
    ),
    metrics: {
      falseAccepts: requireNonNegativeInteger(
        metrics.falseAccepts,
        "Evaluation calibration record metrics falseAccepts",
        10_000,
      ),
      falseRejects: requireNonNegativeInteger(
        metrics.falseRejects,
        "Evaluation calibration record metrics falseRejects",
        10_000,
      ),
      ambiguousReviews: requireNonNegativeInteger(
        metrics.ambiguousReviews,
        "Evaluation calibration record metrics ambiguousReviews",
        10_000,
      ),
      integrityContinues: requireNonNegativeInteger(
        metrics.integrityContinues,
        "Evaluation calibration record metrics integrityContinues",
        10_000,
      ),
      dispositionRepeatability: requireUnitNumber(
        metrics.dispositionRepeatability,
        "Evaluation calibration record metrics dispositionRepeatability",
      ),
      thresholdStabilityFailures: requireNonNegativeInteger(
        metrics.thresholdStabilityFailures,
        "Evaluation calibration record metrics thresholdStabilityFailures",
        10_000,
      ),
    },
    ...(record.runs !== undefined
      ? { runs: parseCalibrationRuns(record.runs) }
      : {}),
    passed: requireBoolean(
      record.passed,
      "Evaluation calibration record passed",
    ),
    createdAt: requireTimestamp(
      record.createdAt,
      "Evaluation calibration record createdAt",
    ),
  };
  const expectedRevision = digestCanonicalValue({
    ...parsed,
    revision: undefined,
  });
  if (parsed.revision !== expectedRevision)
    throw new Error(
      "Evaluation calibration record revision does not match canonical content.",
    );
  return parsed;
}

function parseCalibrationRuns(value: unknown): EvaluationCalibrationRunV1[] {
  const runs = requireArray(value, "Evaluation calibration record runs").map(
    (entry, index) => parseCalibrationRun(entry, index),
  );
  if (runs.length > 1_000)
    throw new Error("Evaluation calibration record runs exceeds 1000 entries.");
  requireUnique(
    runs.map((run) => `${run.caseId}:${run.repetition}`),
    "Evaluation calibration record run identities",
  );
  return runs;
}

function parseCalibrationRun(
  value: unknown,
  index: number,
): EvaluationCalibrationRunV1 {
  const label = `Evaluation calibration record runs[${index}]`;
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set([
      "caseId",
      "repetition",
      "requestedModel",
      "observedModelRevision",
      "assetBundleRevision",
      "verdict",
      "usage",
      "latencyMs",
    ]),
    label,
  );
  const verdict = requireRecord(record.verdict, `${label} verdict`);
  rejectUnknownFields(
    verdict,
    new Set([
      "score",
      "confidence",
      "assertions",
      "reasonCodes",
      "repairable",
      "disposition",
    ]),
    `${label} verdict`,
  );
  const assertions = requireArray(
    verdict.assertions,
    `${label} verdict assertions`,
  ).map((entry, assertionIndex) => {
    const assertion = requireRecord(
      entry,
      `${label} verdict assertions[${assertionIndex}]`,
    );
    rejectUnknownFields(
      assertion,
      new Set(["assertionId", "passed"]),
      `${label} verdict assertions[${assertionIndex}]`,
    );
    return {
      assertionId: requireExactId(
        assertion.assertionId,
        `${label} verdict assertions[${assertionIndex}] assertionId`,
      ),
      passed: requireBoolean(
        assertion.passed,
        `${label} verdict assertions[${assertionIndex}] passed`,
      ),
    };
  });
  if (assertions.length === 0 || assertions.length > 32)
    throw new Error(`${label} verdict assertions must contain 1 to 32 entries.`);
  requireUnique(
    assertions.map((assertion) => assertion.assertionId),
    `${label} verdict assertion IDs`,
  );
  const disposition = verdict.disposition;
  if (
    disposition !== "continue" &&
    disposition !== "revise" &&
    disposition !== "review" &&
    disposition !== "quarantine"
  ) {
    throw new Error(`${label} verdict disposition is invalid.`);
  }
  const usage = requireRecord(record.usage, `${label} usage`);
  rejectUnknownFields(
    usage,
    new Set(["inputTokens", "outputTokens", "totalTokens", "costUsd"]),
    `${label} usage`,
  );
  const inputTokens = requireNonNegativeInteger(
    usage.inputTokens,
    `${label} usage inputTokens`,
    3_500,
  );
  const outputTokens = requireNonNegativeInteger(
    usage.outputTokens,
    `${label} usage outputTokens`,
    500,
  );
  const totalTokens = requireNonNegativeInteger(
    usage.totalTokens,
    `${label} usage totalTokens`,
    4_000,
  );
  if (inputTokens + outputTokens !== totalTokens)
    throw new Error(`${label} usage totalTokens is inconsistent.`);
  return {
    caseId: requireExactId(record.caseId, `${label} caseId`),
    repetition: requirePositiveInteger(
      record.repetition,
      `${label} repetition`,
      100,
    ),
    requestedModel: requireBoundedString(
      record.requestedModel,
      `${label} requestedModel`,
      512,
    ),
    observedModelRevision: requireBoundedString(
      record.observedModelRevision,
      `${label} observedModelRevision`,
      512,
    ),
    assetBundleRevision: requireHash(
      record.assetBundleRevision,
      `${label} assetBundleRevision`,
    ),
    verdict: {
      score: requireUnitNumber(verdict.score, `${label} verdict score`),
      confidence: requireUnitNumber(
        verdict.confidence,
        `${label} verdict confidence`,
      ),
      assertions,
      reasonCodes: parseCodeArray(
        verdict.reasonCodes,
        `${label} verdict reasonCodes`,
        16,
      ),
      repairable: requireBoolean(
        verdict.repairable,
        `${label} verdict repairable`,
      ),
      disposition,
    },
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd: requireNonNegativeNumber(
        usage.costUsd,
        `${label} usage costUsd`,
        0.05,
      ),
    },
    latencyMs: requireNonNegativeInteger(
      record.latencyMs,
      `${label} latencyMs`,
      15_000,
    ),
  };
}

export function digestCanonicalValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function parseEvaluatorRef(
  value: unknown,
  label: string,
): RuntimeEvaluationPolicyV1["evaluator"] {
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set(["evaluatorId", "evaluatorVersion"]),
    label,
  );
  return {
    evaluatorId: requireExactId(record.evaluatorId, `${label} evaluatorId`),
    evaluatorVersion: requireExactId(
      record.evaluatorVersion,
      `${label} evaluatorVersion`,
    ),
  };
}

function parseAssetBundleRef(
  value: unknown,
  label: string,
): RuntimeEvaluationAssetBundleRefV1 {
  const record = requireRecord(value, label);
  const fields = new Set([
    "bundleId",
    "revision",
    "rubricRevision",
    "assertionsRevision",
    "promptRevision",
    "schemaRevision",
    "calibrationDatasetRevision",
    "evaluatorCodeRevision",
  ]);
  rejectUnknownFields(record, fields, label);
  return {
    bundleId: requireExactId(record.bundleId, `${label} bundleId`),
    revision: requireHash(record.revision, `${label} revision`),
    rubricRevision: requireHash(
      record.rubricRevision,
      `${label} rubricRevision`,
    ),
    assertionsRevision: requireHash(
      record.assertionsRevision,
      `${label} assertionsRevision`,
    ),
    promptRevision: requireHash(
      record.promptRevision,
      `${label} promptRevision`,
    ),
    schemaRevision: requireHash(
      record.schemaRevision,
      `${label} schemaRevision`,
    ),
    calibrationDatasetRevision: requireHash(
      record.calibrationDatasetRevision,
      `${label} calibrationDatasetRevision`,
    ),
    evaluatorCodeRevision: requireHash(
      record.evaluatorCodeRevision,
      `${label} evaluatorCodeRevision`,
    ),
  };
}

function parseJudge(
  value: unknown,
  label: string,
): RuntimeEvaluationJudgeRouteV1 {
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set([
      "route",
      "provider",
      "model",
      "modelRegistrationRevision",
      "capabilities",
      "credentialReference",
      "pricing",
    ]),
    label,
  );
  if (record.route !== "profile_primary")
    throw new Error(`${label} route must be 'profile_primary'.`);
  const provider = requireProvider(record.provider, `${label} provider`);
  const model = requireBoundedString(record.model, `${label} model`, 512);
  const capabilities = parseJudgeCapabilities(
    record.capabilities,
    `${label} capabilities`,
  );
  if (capabilities.structuredOutputEnabled !== true)
    throw new Error(`${label} structured output capability must be enabled.`);
  const credentialReference =
    record.credentialReference === undefined
      ? undefined
      : parseRecoveryModelCredentialReferenceV1(record.credentialReference);
  if (
    credentialReference !== undefined &&
    (credentialReference.provider !== provider ||
      credentialReference.rawModelId !== model)
  ) {
    throw new Error(
      `${label} credentialReference must match provider and model.`,
    );
  }
  const pricing = requireRecord(record.pricing, `${label} pricing`);
  rejectUnknownFields(
    pricing,
    new Set([
      "priceRevision",
      "inputUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
    ]),
    `${label} pricing`,
  );
  const inputPrice = requireNonNegativeNumber(
    pricing.inputUsdPerMillionTokens,
    `${label} pricing inputUsdPerMillionTokens`,
    1_000_000,
  );
  const outputPrice = requireNonNegativeNumber(
    pricing.outputUsdPerMillionTokens,
    `${label} pricing outputUsdPerMillionTokens`,
    1_000_000,
  );
  if (
    (provider === "ollama" || provider === "lmstudio") &&
    (inputPrice !== 0 || outputPrice !== 0)
  ) {
    throw new Error(`${label} local provider pricing must be explicit zero.`);
  }
  if (
    provider !== "ollama" &&
    provider !== "lmstudio" &&
    inputPrice === 0 &&
    outputPrice === 0
  ) {
    throw new Error(
      `${label} remote provider pricing must be pinned and non-zero.`,
    );
  }
  return {
    route: "profile_primary",
    provider,
    model,
    modelRegistrationRevision: requireHash(
      record.modelRegistrationRevision,
      `${label} modelRegistrationRevision`,
    ),
    capabilities,
    ...(credentialReference !== undefined ? { credentialReference } : {}),
    pricing: {
      priceRevision: requireHash(
        pricing.priceRevision,
        `${label} pricing priceRevision`,
      ),
      inputUsdPerMillionTokens: inputPrice,
      outputUsdPerMillionTokens: outputPrice,
    },
  };
}

function parseJudgeCapabilities(
  value: unknown,
  label: string,
): RecoveryModelCandidateV1["capabilities"] {
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set([
      "visionInputEnabled",
      "toolCallingEnabled",
      "structuredOutputEnabled",
      "reasoningModes",
    ]),
    label,
  );
  if (
    typeof record.visionInputEnabled !== "boolean" ||
    typeof record.toolCallingEnabled !== "boolean" ||
    typeof record.structuredOutputEnabled !== "boolean"
  ) {
    throw new Error(`${label} capability flags must be booleans.`);
  }
  const reasoningModes = requireArray(
    record.reasoningModes,
    `${label} reasoningModes`,
  ).map((mode, index) => {
    if (
      mode !== "off" &&
      mode !== "summary" &&
      mode !== "provider_visible"
    ) {
      throw new Error(`${label} reasoningModes[${index}] is invalid.`);
    }
    return mode;
  });
  if (reasoningModes.length === 0)
    throw new Error(`${label} reasoningModes cannot be empty.`);
  requireUnique(reasoningModes, `${label} reasoningModes`);
  return {
    visionInputEnabled: record.visionInputEnabled,
    toolCallingEnabled: record.toolCallingEnabled,
    structuredOutputEnabled: record.structuredOutputEnabled,
    reasoningModes,
  };
}

function parseHook(value: unknown, label: string): RuntimeEvaluationHookV1 {
  const record = requireRecord(value, label);
  rejectUnknownFields(record, new Set(["kind", "mode", "selectorIds"]), label);
  const kind = requireHookKind(record.kind, `${label} kind`);
  if (record.mode !== "advisory" && record.mode !== "blocking")
    throw new Error(`${label} mode is invalid.`);
  const selectorIds = requireArray(
    record.selectorIds,
    `${label} selectorIds`,
  ).map((id, index) => requireExactId(id, `${label} selectorIds[${index}]`));
  if (selectorIds.length > 64)
    throw new Error(`${label} selectorIds exceeds 64 entries.`);
  requireUnique(selectorIds, `${label} selectorIds`);
  return { kind, mode: record.mode, selectorIds };
}

function parseLeanBudget(value: unknown): RuntimeEvaluationBudgetV1 {
  const record = requireRecord(value, "Runtime evaluation policy budget");
  rejectUnknownFields(
    record,
    new Set(Object.keys(LEAN_RUNTIME_EVALUATION_BUDGET_V1)),
    "Runtime evaluation policy budget",
  );
  for (const [field, expected] of Object.entries(
    LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  )) {
    if (record[field] !== expected)
      throw new Error(
        `Runtime evaluation policy budget ${field} must be ${expected}.`,
      );
  }
  return { ...LEAN_RUNTIME_EVALUATION_BUDGET_V1 };
}

function parseThresholds(value: unknown): RuntimeEvaluationThresholdsV1 {
  const record = requireRecord(value, "Runtime evaluation thresholds");
  rejectUnknownFields(
    record,
    new Set(Object.keys(RUNTIME_EVALUATION_THRESHOLDS_V1)),
    "Runtime evaluation thresholds",
  );
  for (const [field, expected] of Object.entries(
    RUNTIME_EVALUATION_THRESHOLDS_V1,
  )) {
    if (record[field] !== expected)
      throw new Error(
        `Runtime evaluation thresholds ${field} must be ${expected}.`,
      );
  }
  return { ...RUNTIME_EVALUATION_THRESHOLDS_V1 };
}

function parseActions(value: unknown): RuntimeEvaluationPolicyV1["actions"] {
  const record = requireRecord(value, "Runtime evaluation policy actions");
  rejectUnknownFields(
    record,
    new Set(["revisionHandlerId", "reviewOptionIds"]),
    "Runtime evaluation policy actions",
  );
  if (record.revisionHandlerId !== "evaluation.revise")
    throw new Error(
      "Runtime evaluation policy revisionHandlerId must be 'evaluation.revise'.",
    );
  const reviewOptionIds = requireArray(
    record.reviewOptionIds,
    "Runtime evaluation policy reviewOptionIds",
  ).map((id, index) =>
    requireExactId(id, `Runtime evaluation policy reviewOptionIds[${index}]`),
  );
  const expected = [
    "evaluation.accept_once",
    "evaluation.revise",
    "terminal.fail",
  ];
  if (
    reviewOptionIds.length !== expected.length ||
    reviewOptionIds.some((id, index) => id !== expected[index])
  ) {
    throw new Error(
      `Runtime evaluation policy reviewOptionIds must be ${expected.join(", ")} in order.`,
    );
  }
  return {
    revisionHandlerId: "evaluation.revise",
    reviewOptionIds:
      expected as RuntimeEvaluationPolicyV1["actions"]["reviewOptionIds"],
  };
}

function parseBudgetSnapshot(
  value: unknown,
  label: string,
): RuntimeEvaluationRequestV1["budget"] {
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set([
      "evaluationsUsed",
      "intermediateEvaluationsUsed",
      "totalTokensUsed",
      "totalCostUsd",
      "finalRevisionsUsed",
    ]),
    label,
  );
  return {
    evaluationsUsed: requireNonNegativeInteger(
      record.evaluationsUsed,
      `${label} evaluationsUsed`,
      4,
    ),
    intermediateEvaluationsUsed: requireNonNegativeInteger(
      record.intermediateEvaluationsUsed,
      `${label} intermediateEvaluationsUsed`,
      2,
    ),
    totalTokensUsed: requireNonNegativeInteger(
      record.totalTokensUsed,
      `${label} totalTokensUsed`,
      16_000,
    ),
    totalCostUsd: requireNonNegativeNumber(
      record.totalCostUsd,
      `${label} totalCostUsd`,
      0.05,
    ),
    finalRevisionsUsed: requireNonNegativeInteger(
      record.finalRevisionsUsed,
      `${label} finalRevisionsUsed`,
      1,
    ),
  };
}

function parseAssertion(
  value: unknown,
  index: number,
): RuntimeEvaluationAssertionV1 {
  const label = `Runtime evaluation verdict assertions[${index}]`;
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set(["assertionId", "required", "passed", "rationale", "evidenceRefs"]),
    label,
  );
  const evidenceRefs = requireArray(
    record.evidenceRefs,
    `${label} evidenceRefs`,
  ).map((ref, refIndex) =>
    requireExactId(ref, `${label} evidenceRefs[${refIndex}]`),
  );
  if (evidenceRefs.length > 32)
    throw new Error(`${label} evidenceRefs exceeds 32 entries.`);
  requireUnique(evidenceRefs, `${label} evidenceRefs`);
  return {
    assertionId: requireExactId(record.assertionId, `${label} assertionId`),
    required: requireBoolean(record.required, `${label} required`),
    passed: requireBoolean(record.passed, `${label} passed`),
    rationale: requireBoundedString(
      record.rationale,
      `${label} rationale`,
      1_000,
    ),
    evidenceRefs,
  };
}

function requireHookKind(
  value: unknown,
  label: string,
): RuntimeEvaluationHookKindV1 {
  if (
    value !== "after_tool" &&
    value !== "milestone" &&
    value !== "handoff" &&
    value !== "pre_delivery"
  )
    throw new Error(`${label} is invalid.`);
  return value;
}

function requireProvider(
  value: unknown,
  label: string,
): RecoveryModelProviderV1 {
  if (
    value !== "openrouter" &&
    value !== "openai" &&
    value !== "anthropic" &&
    value !== "ollama" &&
    value !== "lmstudio"
  )
    throw new Error(`${label} is invalid.`);
  return value;
}

function parseCodeArray(value: unknown, label: string, max: number): string[] {
  const codes = requireArray(value, label).map((code, index) =>
    requireExactId(code, `${label}[${index}]`),
  );
  if (codes.length > max) throw new Error(`${label} exceeds ${max} entries.`);
  requireUnique(codes, label);
  return codes;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown !== undefined)
    throw new Error(`${label} contains unknown field '${unknown}'.`);
}

function requireExactId(value: unknown, label: string): string {
  const id = requireBoundedString(value, label, 256);
  if (!EXACT_ID_PATTERN.test(id) || /[*?\[\]{}()]/u.test(id))
    throw new Error(`${label} must be an exact identifier without patterns.`);
  return id;
}

function requireBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  )
    throw new Error(
      `${label} must be a non-empty string of at most ${maxLength} characters.`,
    );
  return value;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  return value === undefined
    ? undefined
    : requireBoundedString(value, label, maxLength);
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value))
    throw new Error(`${label} must be a sha256 digest.`);
  return value;
}

function requireProfileFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROFILE_FINGERPRINT_PATTERN.test(value))
    throw new Error(`${label} must be a profile fingerprint.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`${label} must be a boolean.`);
  return value;
}

function requireUnitNumber(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    Number.isFinite(value) === false ||
    value < 0 ||
    value > 1
  )
    throw new Error(`${label} must be between 0 and 1.`);
  return value;
}

function requireNonNegativeNumber(
  value: unknown,
  label: string,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    Number.isFinite(value) === false ||
    value < 0 ||
    value > max
  )
    throw new Error(`${label} must be between 0 and ${max}.`);
  return value;
}

function requireNonNegativeInteger(
  value: unknown,
  label: string,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new Error(
      `${label} must be a non-negative safe integer no greater than ${max}.`,
    );
  return value;
}

function requirePositiveInteger(
  value: unknown,
  label: string,
  max: number,
): number {
  const parsed = requireNonNegativeInteger(value, label, max);
  if (parsed === 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireBoundedString(value, label, 64);
  if (Number.isNaN(Date.parse(timestamp)))
    throw new Error(`${label} must be an ISO timestamp.`);
  return timestamp;
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} must not contain duplicates.`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortCanonical(entry)]),
  );
}

function emptyHash(): string {
  return `sha256:${"0".repeat(64)}`;
}
