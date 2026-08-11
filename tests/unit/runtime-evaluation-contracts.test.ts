import test from "node:test";
import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  EVALUATION_CALIBRATION_RECORD_VERSION,
  EVALUATION_EVIDENCE_PROJECTION_VERSION,
  LEAN_RUNTIME_EVALUATION_BUDGET_V1,
  RUNTIME_EVALUATION_REQUEST_VERSION,
  RUNTIME_EVALUATION_THRESHOLDS_V1,
  createRuntimeEvaluationPolicyV1,
  digestCanonicalValue,
  parseEvaluationCalibrationRecordV1,
  parseRuntimeEvaluationPolicyV1,
  parseRuntimeEvaluationRequestV1,
} from "../../src/kestrel/contracts/evaluation.js";
import {
  CompletionEvidenceEvaluator,
  RuntimeEvaluatorRegistry,
  createDefaultRuntimeEvaluatorRegistry,
} from "../../src/evaluation/index.js";
import { COMPLETION_EVIDENCE_ASSET_BUNDLE_V1 } from "../../src/evaluation/assets.js";
import {
  assertEvaluationPrimaryProjection,
  resolveProfileWithEvaluationPolicy,
} from "../../src/profile/evaluationPolicy.js";
import {
  composeKestrelOneProfile,
  fingerprintResolvedProfile,
} from "../../src/profile/kestrelOnePolicy.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const PROFILE_FINGERPRINT = "c".repeat(64);

function policy() {
  return createRuntimeEvaluationPolicyV1({
    policyId: "evaluation:test",
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
      {
        kind: "milestone",
        mode: "advisory",
        selectorIds: ["research.complete"],
      },
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

function profileWithPolicy(): TuiProfile {
  return resolveProfileWithEvaluationPolicy({
    id: "custom-evaluation",
    label: "Custom Evaluation",
    agent: "reference-react",
    sessionPrefix: "custom-evaluation",
    modelProvider: "openai",
    model: "gpt-5.4-2026-03-05",
    evaluationPolicy: policy(),
  });
}

function request() {
  const evaluationPolicy = policy();
  const projection = {
    version: EVALUATION_EVIDENCE_PROJECTION_VERSION,
    identity: {
      runId: "run-1",
      sessionId: "session-1",
      threadId: "thread-1",
      stepIndex: 3,
      profileFingerprint: PROFILE_FINGERPRINT,
      policyRevision: evaluationPolicy.revision,
    },
    hook: { kind: "pre_delivery" as const, sourceId: "agent.final" },
    objective: "Return an evidence-backed answer.",
    candidateOutput: "The requested result is complete.",
    evidence: [
      {
        evidenceId: "tool-result-1",
        kind: "tool" as const,
        summary: "The tool completed successfully.",
        digest: HASH_A,
      },
    ],
    truncations: [],
    createdAt: "2026-08-03T12:00:00.000Z",
  };
  return parseRuntimeEvaluationRequestV1({
    version: RUNTIME_EVALUATION_REQUEST_VERSION,
    requestId: "evaluation-request:run-1:final",
    evaluator: evaluationPolicy.evaluator,
    assets: evaluationPolicy.assets,
    judge: evaluationPolicy.judge,
    projection,
    projectionDigest: digestCanonicalValue(projection),
    budget: {
      evaluationsUsed: 0,
      intermediateEvaluationsUsed: 0,
      totalTokensUsed: 0,
      totalCostUsd: 0,
      finalRevisionsUsed: 0,
    },
    createdAt: "2026-08-03T12:00:00.000Z",
  });
}

test("runtime evaluation policy is canonical, strict, exact-ID only, and bounded", () => {
  const parsed = policy();
  assert.deepEqual(parseRuntimeEvaluationPolicyV1(parsed), parsed);
  assert.equal(
    parsed.revision,
    digestCanonicalValue({ ...parsed, revision: undefined }),
  );

  assert.throws(
    () => parseRuntimeEvaluationPolicyV1({ ...parsed, score: 0.9 }),
    /unknown field 'score'/u,
  );
  assert.throws(
    () =>
      parseRuntimeEvaluationPolicyV1({
        ...parsed,
        hooks: [
          ...parsed.hooks,
          { kind: "after_tool", mode: "advisory", selectorIds: ["fs.read"] },
        ],
      }),
    /hook kinds must not contain duplicates/u,
  );
  assert.throws(
    () =>
      createRuntimeEvaluationPolicyV1({
        ...parsed,
        hooks: [
          { kind: "after_tool", mode: "advisory", selectorIds: ["code.*"] },
          { kind: "pre_delivery", mode: "blocking", selectorIds: [] },
        ],
      }),
    /without patterns/u,
  );
  assert.throws(
    () =>
      parseRuntimeEvaluationPolicyV1({
        ...parsed,
        budget: { ...parsed.budget, maxEvaluationsPerRun: 5 },
      }),
    /maxEvaluationsPerRun must be 4/u,
  );
  assert.throws(
    () =>
      createRuntimeEvaluationPolicyV1({
        ...parsed,
        hooks: [
          {
            kind: "after_tool",
            mode: "advisory",
            selectorIds: ["code.execute"],
          },
        ],
      }),
    /blocking pre_delivery/u,
  );
});

test("evaluation profile composition is opt-in and never creates recovery stages", () => {
  const base = profileWithPolicy();
  const resolved = resolveProfileWithEvaluationPolicy(base);
  assert.equal(resolved.evaluationPolicy?.revision, policy().revision);
  assert.equal(resolved.recoveryPolicy, undefined);
  assert.deepEqual(resolveProfileWithEvaluationPolicy(resolved), resolved);

  const disabled = {
    id: "disabled",
    label: "Disabled",
    agent: "reference-react",
    sessionPrefix: "disabled",
    modelProvider: "openai",
    model: "gpt-5.4-2026-03-05",
  } satisfies TuiProfile;
  assert.equal(resolveProfileWithEvaluationPolicy(disabled), disabled);
});

test("evaluation primary route and credentials cannot disagree with the profile", () => {
  const evaluationPolicy = policy();
  assert.doesNotThrow(() =>
    assertEvaluationPrimaryProjection(profileWithPolicy(), evaluationPolicy),
  );
  assert.throws(
    () =>
      assertEvaluationPrimaryProjection(
        { ...profileWithPolicy(), model: "gpt-5-mini" },
        evaluationPolicy,
      ),
    /primary model projection does not match/u,
  );
  assert.throws(
    () =>
      assertEvaluationPrimaryProjection(
        {
          ...profileWithPolicy(),
          modelCapabilities: { visionInputEnabled: true },
        },
        evaluationPolicy,
      ),
    /primary capability projection does not match/u,
  );
});

test("managed evaluation composition is deterministic and tenant-bound credentials fail closed", () => {
  const credential = {
    source: "kestrel-one" as const,
    runId: "run-managed",
    gatewayId: "gateway-1",
    organizationId: "org-a",
    environmentId: "environment-1",
    rawModelId: "gpt-5.4-2026-03-05",
    provider: "openai" as const,
  };
  const base = policy();
  const managedPolicy = createRuntimeEvaluationPolicyV1({
    ...base,
    judge: { ...base.judge, credentialReference: credential },
  });
  const input = {
    environmentPresetId: "workspace_hosted" as const,
    overlay: {
      modelProvider: "openai" as const,
      model: "gpt-5.4-2026-03-05",
      modelCredential: credential,
      evaluationPolicy: managedPolicy,
    },
    resolvedProfileId: "kestrel",
  };
  const first = composeKestrelOneProfile(input).profile;
  const second = composeKestrelOneProfile(input).profile;
  assert.deepEqual(first, second);
  assert.equal(first.recoveryPolicy, undefined);

  assert.throws(
    () =>
      assertEvaluationPrimaryProjection(
        {
          ...first,
          modelCredential: { ...credential, organizationId: "org-b" },
        },
        managedPolicy,
      ),
    /primary credential projection does not match/u,
  );
});

test("resolved profile fingerprints include the evaluation policy revision", () => {
  const first = resolveProfileWithEvaluationPolicy(profileWithPolicy());
  const current = policy();
  const changedPolicy = createRuntimeEvaluationPolicyV1({
    ...current,
    calibration: {
      ...current.calibration,
      recordRevision: HASH_B,
    },
  });
  const second = resolveProfileWithEvaluationPolicy({
    ...profileWithPolicy(),
    evaluationPolicy: changedPolicy,
  });
  assert.notEqual(
    fingerprintResolvedProfile(first),
    fingerprintResolvedProfile(second),
  );
});

test("runtime evaluator registry is exact-versioned and fails closed", () => {
  const registry = createDefaultRuntimeEvaluatorRegistry();
  assert.ok(
    registry.require({
      evaluatorId: "completion-evidence",
      evaluatorVersion: "1.0.0",
    }) instanceof CompletionEvidenceEvaluator,
  );
  assert.throws(
    () =>
      registry.require({
        evaluatorId: "completion-evidence",
        evaluatorVersion: "2.0.0",
      }),
    /is not registered/u,
  );
  assert.throws(
    () => registry.register(new CompletionEvidenceEvaluator()),
    /already registered/u,
  );
  assert.throws(
    () =>
      new RuntimeEvaluatorRegistry().register({
        evaluatorId: "completion-*",
        evaluatorVersion: "1.0.0",
        evaluate: async () => {
          throw new Error("not reached");
        },
      }),
    /without patterns/u,
  );
  assert.equal(new RuntimeEvaluatorRegistry().list().length, 0);
});

test("completion-evidence evaluator uses the pinned route and returns the typed verdict", async () => {
  const evaluationRequest = request();
  let observedModelRequest: unknown;
  const verdict = await new CompletionEvidenceEvaluator().evaluate(
    evaluationRequest,
    {
      signal: new AbortController().signal,
      invokeJudge: async (modelRequest) => {
        observedModelRequest = modelRequest;
        return {
          output: {
            score: 0.92,
            confidence: 0.88,
            assertions: [
              {
                assertionId: "outcome_complete",
                passed: true,
                rationale: "Complete.",
                evidenceRefs: ["tool-result-1"],
              },
              {
                assertionId: "evidence_consistent",
                passed: true,
                rationale: "Supported.",
                evidenceRefs: ["tool-result-1"],
              },
              {
                assertionId: "evaluation_integrity",
                passed: true,
                rationale: "No manipulation.",
                evidenceRefs: [],
              },
            ],
            rationale: "The candidate is complete and supported.",
            reasonCodes: ["EVALUATION_PASSED"],
            repairable: false,
          },
          provider: "openai",
          requestedModel: "gpt-5.4-2026-03-05",
          observedModelRevision: "gpt-5.4-2026-03-05",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          latencyMs: 250,
        };
      },
    },
  );
  assert.equal(verdict.score, 0.92);
  assert.equal(verdict.assertions.length, 3);
  assert.equal(verdict.judge.routeIndependence, "shared_primary_route");
  assert.equal(
    (observedModelRequest as { tools?: unknown[] }).tools?.length,
    0,
  );
  assert.equal(
    (observedModelRequest as { responseFormat?: string }).responseFormat,
    "json",
  );
  assert.equal(
    (observedModelRequest as {
      providerOptions?: { openai?: { maxTokens?: number } };
    }).providerOptions?.openai?.maxTokens,
    500,
  );
});

test("calibration records are canonical and bind evaluator, assets, dataset, and model", () => {
  const draft = {
    version: EVALUATION_CALIBRATION_RECORD_VERSION,
    recordId: "completion-evidence.calibration.openai-gpt-5.4",
    revision: HASH_A,
    evaluator: policy().evaluator,
    assetBundleRevision: policy().assets.revision,
    requestedRoute: {
      provider: "openai" as const,
      model: "gpt-5.4-2026-03-05",
      modelRegistrationRevision: HASH_A,
    },
    observedModelRevision: "gpt-5.4-2026-03-05",
    datasetRevision: policy().assets.calibrationDatasetRevision,
    repetitionsPerCase: 3,
    caseCount: 24,
    metrics: {
      falseAccepts: 0,
      falseRejects: 1,
      ambiguousReviews: 4,
      integrityContinues: 0,
      dispositionRepeatability: 0.95,
      thresholdStabilityFailures: 0,
    },
    passed: true,
    createdAt: "2026-08-03T12:00:00.000Z",
  };
  const record = {
    ...draft,
    revision: digestCanonicalValue({ ...draft, revision: undefined }),
  };
  assert.deepEqual(parseEvaluationCalibrationRecordV1(record), record);
  assert.throws(
    () => parseEvaluationCalibrationRecordV1({ ...record, passed: false }),
    /revision does not match/u,
  );
});
