import test from "node:test";
import assert from "node:assert/strict";

import {
  createRecoveryPolicyV1,
  parseRecoveryDecisionV1,
  parseRecoveryModelCredentialReferenceV1,
  parseRecoveryPolicyV1,
  parseRecoveryReviewBindingV1,
  RECOVERY_DECISION_VERSION,
  RECOVERY_REVIEW_BINDING_VERSION,
  type RecoveryModelCandidateV1,
} from "../../src/kestrel/contracts/recovery.js";
import {
  assertRecoveryPrimaryProjection,
  resolveRecoveryMaxAttempts,
  resolveRecoveryPolicyForProfile,
} from "../../src/profile/recoveryPolicy.js";

const primaryModel: RecoveryModelCandidateV1 = {
  candidateId: "primary",
  provider: "openai",
  model: "gpt-5.4",
  capabilities: {
    visionInputEnabled: false,
    toolCallingEnabled: true,
    structuredOutputEnabled: true,
    reasoningModes: ["off", "summary", "provider_visible"],
  },
  credentialReference: {
    source: "kestrel-one",
    runId: "run-1",
    gatewayId: "gateway-primary",
    organizationId: "org-1",
    environmentId: "env-1",
    rawModelId: "gpt-5.4",
    provider: "openai",
  },
};

function createPolicy() {
  return createRecoveryPolicyV1({
    policyId: "recovery:test",
    primaryModel,
    stages: [
      {
        stageId: "model.retry",
        scope: "model_call",
        failureCodes: ["MODEL_TIMEOUT"],
        action: "retry_same_route",
        maxAttempts: 3,
      },
      {
        stageId: "model.alternate",
        scope: "model_call",
        failureCodes: ["MODEL_TIMEOUT"],
        action: "alternate_model",
        candidates: [],
      },
      {
        stageId: "tool.alternate",
        scope: "tool_call",
        failureCodes: ["SANDBOX_UNAVAILABLE"],
        action: "alternate_tool",
        adapters: [],
      },
      {
        stageId: "run.workflow",
        scope: "run",
        failureCodes: ["NO_PROGRESS_REASONING_LOOP"],
        action: "deterministic_workflow",
        handlerIds: ["run.loop_recovery"],
      },
      {
        stageId: "run.review",
        scope: "run",
        failureCodes: ["RECOVERY_EXHAUSTED"],
        action: "human_review",
        optionIds: ["retry.primary", "terminal.fail"],
      },
      {
        stageId: "run.terminal",
        scope: "run",
        failureCodes: ["RECOVERY_EXHAUSTED"],
        action: "terminal_failure",
        terminalCode: "RECOVERY_EXHAUSTED",
      },
    ],
  });
}

test("RecoveryPolicyV1 canonicalizes deterministically and rejects mutation", () => {
  const policy = createPolicy();
  assert.deepEqual(parseRecoveryPolicyV1(policy), policy);
  assert.equal(createPolicy().revision, policy.revision);

  const stale = structuredClone(policy);
  const retryStage = stale.stages[0];
  if (retryStage?.action !== "retry_same_route") {
    throw new Error("test policy is missing its retry stage");
  }
  retryStage.maxAttempts += 1;
  assert.throws(
    () => parseRecoveryPolicyV1(stale),
    /revision does not match/u,
  );
});

test("RecoveryPolicyV1 rejects unknown fields, duplicate IDs, and ladder reordering", () => {
  const unknown = { ...createPolicy(), score: 1 };
  assert.throws(() => parseRecoveryPolicyV1(unknown), /unknown field 'score'/u);

  const duplicate = structuredClone(createPolicy());
  duplicate.stages[1]!.stageId = duplicate.stages[0]!.stageId;
  assert.throws(
    () => parseRecoveryPolicyV1(duplicate),
    /stage IDs must contain unique values/u,
  );

  const reordered = structuredClone(createPolicy());
  [reordered.stages[0], reordered.stages[1]] = [
    reordered.stages[1]!,
    reordered.stages[0]!,
  ];
  assert.throws(
    () => parseRecoveryPolicyV1(reordered),
    /recovery ladder order/u,
  );
});

test("RecoveryPolicyV1 rejects unbounded attempts and missing terminal stages", () => {
  const unbounded = structuredClone(createPolicy()) as unknown as {
    stages: Array<Record<string, unknown>>;
  };
  unbounded.stages[0]!.maxAttempts = Number.POSITIVE_INFINITY;
  assert.throws(
    () => parseRecoveryPolicyV1(unbounded),
    /positive safe integer/u,
  );

  const missingTerminal = structuredClone(createPolicy());
  missingTerminal.stages.pop();
  assert.throws(
    () => parseRecoveryPolicyV1(missingTerminal),
    /exactly one terminal_failure/u,
  );
});

test("managed and custom profiles receive deterministic owned recovery ladders", () => {
  const managed = resolveRecoveryPolicyForProfile({
    id: "kestrel",
    label: "Kestrel",
    agent: "reference-react",
    sessionPrefix: "kestrel",
    modelProvider: "openai",
    model: "gpt-5.4",
  });
  const custom = resolveRecoveryPolicyForProfile({
    id: "custom",
    label: "Custom",
    agent: "reference-react",
    sessionPrefix: "custom",
    modelProvider: "openai",
    model: "gpt-5.4",
  });

  assert.deepEqual(
    managed.stages.map((stage) => stage.action),
    [
      "retry_same_route",
      "alternate_model",
      "alternate_tool",
      "deterministic_workflow",
      "terminal_failure",
    ],
  );
  assert.deepEqual(
    custom.stages.map((stage) => stage.action),
    ["retry_same_route", "terminal_failure"],
  );
  assert.equal(resolveRecoveryPolicyForProfile({
    id: "kestrel",
    label: "Kestrel",
    agent: "reference-react",
    sessionPrefix: "kestrel",
    modelProvider: "openai",
    model: "gpt-5.4",
  }).revision, managed.revision);
});

test("retry counts materialize into total attempts before fingerprinting", () => {
  assert.equal(resolveRecoveryMaxAttempts("openai", {}), 3);
  assert.equal(resolveRecoveryMaxAttempts("ollama", {}), 1);
  assert.equal(
    resolveRecoveryMaxAttempts("openrouter", {
      KCHAT_MODEL_RETRY_COUNT: "4",
    }),
    5,
  );
  assert.throws(
    () =>
      resolveRecoveryMaxAttempts("openai", {
        KCHAT_MODEL_RETRY_COUNT: String(Number.MAX_SAFE_INTEGER),
      }),
    /non-negative safe integer/u,
  );
});

test("credential references and primary projections are exact and secret-free", () => {
  assert.deepEqual(
    parseRecoveryModelCredentialReferenceV1(
      primaryModel.credentialReference,
    ),
    primaryModel.credentialReference,
  );
  assert.throws(
    () =>
      parseRecoveryModelCredentialReferenceV1({
        ...primaryModel.credentialReference,
        apiKey: "secret",
      }),
    /unknown field 'apiKey'/u,
  );

  const policy = createPolicy();
  assert.doesNotThrow(() =>
    assertRecoveryPrimaryProjection(
      {
        id: "kestrel",
        modelProvider: "openai",
        model: "gpt-5.4",
        modelCredential: primaryModel.credentialReference,
      },
      policy,
    ),
  );
  assert.throws(
    () =>
      assertRecoveryPrimaryProjection(
        {
          id: "kestrel",
          modelProvider: "openai",
          model: "gpt-5.4-mini",
          modelCredential: primaryModel.credentialReference,
        },
        policy,
      ),
    /primary model projection/u,
  );
});

test("RecoveryDecisionV1 and RecoveryReviewBindingV1 parse immutable identities", () => {
  const policy = createPolicy();
  const profileFingerprint = "a".repeat(64);
  const decision = parseRecoveryDecisionV1({
    version: RECOVERY_DECISION_VERSION,
    decisionId: "decision-1",
    runId: "run-1",
    sessionId: "session-1",
    callId: "call-1",
    policyId: policy.policyId,
    policyRevision: policy.revision,
    executionProfileFingerprint: profileFingerprint,
    trigger: {
      scope: "model_call",
      failureCode: "MODEL_TIMEOUT",
      visibleOutputStarted: false,
    },
    candidates: [
      {
        stageId: "model.retry",
        candidateId: "primary",
        disposition: "selected",
        reasonCode: "ELIGIBLE",
      },
    ],
    budget: { remainingMs: 10_000, tokensUsed: 12, toolCallsUsed: 1 },
    compatibility: { status: "compatible", profile: "default" },
    outcome: {
      status: "selected",
      action: "retry_same_route",
      stageId: "model.retry",
      candidateId: "primary",
    },
    createdAt: "2026-08-03T12:00:00.000Z",
  });
  assert.equal(decision.executionProfileFingerprint, profileFingerprint);

  const binding = parseRecoveryReviewBindingV1({
    version: RECOVERY_REVIEW_BINDING_VERSION,
    bindingId: "binding-1",
    decisionId: decision.decisionId,
    threadId: "thread-1",
    runId: decision.runId,
    executionProfileFingerprint: profileFingerprint,
    policyRevision: policy.revision,
    allowedOptionIds: ["retry.primary", "terminal.fail"],
    requestedAt: "2026-08-03T12:00:00.000Z",
  });
  assert.equal(binding.expiresAt, undefined);
  assert.equal("toolAuthority" in binding, false);
});
