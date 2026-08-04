import type { TuiProfile } from "../../cli/contracts.js";
import {
  parseRuntimeEvaluationPolicyV1,
  type RuntimeEvaluationPolicyV1,
} from "../kestrel/contracts/evaluation.js";
import {
  createRecoveryPolicyV1,
  parseRecoveryPolicyV1,
  type RecoveryHumanReviewStageV1,
  type RecoveryDeterministicWorkflowStageV1,
  type RecoveryPolicyV1,
  type RecoveryStageV1,
} from "../kestrel/contracts/recovery.js";
import { resolveRecoveryPolicyForProfile } from "./recoveryPolicy.js";

const EVALUATION_REVISION_FAILURE_CODES = ["EVALUATION_REJECTED"];
const EVALUATION_REVIEW_FAILURE_CODES = [
  "EVALUATION_REJECTED_AFTER_REVISION",
  "EVALUATION_LOW_CONFIDENCE",
  "EVALUATION_UNAVAILABLE",
  "EVALUATION_QUARANTINED",
];

export function resolveProfileWithEvaluationPolicy(
  profile: TuiProfile,
): TuiProfile {
  if (profile.evaluationPolicy === undefined) {
    return profile;
  }
  const evaluationPolicy = parseRuntimeEvaluationPolicyV1(
    profile.evaluationPolicy,
  );
  assertEvaluationPrimaryProjection(profile, evaluationPolicy);
  const recoveryPolicy = materializeEvaluationRecoveryPolicy({
    profile,
    evaluationPolicy,
  });
  return {
    ...structuredClone(profile),
    evaluationPolicy,
    recoveryPolicy,
  };
}

export function assertEvaluationPrimaryProjection(
  profile: Pick<
    TuiProfile,
    | "id"
    | "modelProvider"
    | "model"
    | "modelCredential"
    | "modelCapabilities"
    | "recoveryPolicy"
  >,
  policy: RuntimeEvaluationPolicyV1,
): void {
  if (
    profile.modelProvider !== policy.judge.provider ||
    profile.model !== policy.judge.model
  ) {
    throw new Error(
      `Profile '${profile.id}' primary model projection does not match evaluation policy '${policy.policyId}'.`,
    );
  }
  if (
    JSON.stringify(profile.modelCredential ?? null) !==
    JSON.stringify(policy.judge.credentialReference ?? null)
  ) {
    throw new Error(
      `Profile '${profile.id}' primary credential projection does not match evaluation policy '${policy.policyId}'.`,
    );
  }
  if (
    policy.judge.capabilities.visionInputEnabled !==
    (profile.modelCapabilities?.visionInputEnabled === true)
  ) {
    throw new Error(
      `Profile '${profile.id}' primary capability projection does not match evaluation policy '${policy.policyId}'.`,
    );
  }
  if (profile.recoveryPolicy !== undefined) {
    const recovery = parseRecoveryPolicyV1(profile.recoveryPolicy);
    if (
      recovery.primaryModel.provider !== policy.judge.provider ||
      recovery.primaryModel.model !== policy.judge.model ||
      JSON.stringify(recovery.primaryModel.capabilities) !==
        JSON.stringify(policy.judge.capabilities)
    ) {
      throw new Error(
        `Profile '${profile.id}' recovery primary route is incompatible with evaluation policy '${policy.policyId}'.`,
      );
    }
  }
}

export function materializeEvaluationRecoveryPolicy(input: {
  profile: TuiProfile;
  evaluationPolicy: RuntimeEvaluationPolicyV1;
}): RecoveryPolicyV1 {
  const base =
    input.profile.recoveryPolicy === undefined
      ? resolveRecoveryPolicyForProfile(input.profile)
      : parseRecoveryPolicyV1(input.profile.recoveryPolicy);
  assertEvaluationStageIdCompatibility(base);
  const stages = base.stages.map((stage) => structuredClone(stage));
  upsertRevisionStage(stages, input.evaluationPolicy);
  upsertReviewStage(stages, input.evaluationPolicy);
  return createRecoveryPolicyV1({
    policyId: base.policyId,
    primaryModel: base.primaryModel,
    stages,
  });
}

function upsertRevisionStage(
  stages: RecoveryStageV1[],
  policy: RuntimeEvaluationPolicyV1,
): void {
  const existing = stages.find(
    (stage): stage is RecoveryDeterministicWorkflowStageV1 =>
      stage.action === "deterministic_workflow",
  );
  if (existing !== undefined) {
    existing.failureCodes = appendUnique(
      existing.failureCodes,
      EVALUATION_REVISION_FAILURE_CODES,
    );
    existing.handlerIds = appendUnique(existing.handlerIds, [
      policy.actions.revisionHandlerId,
    ]);
    return;
  }
  const terminalIndex = stages.findIndex(
    (stage) => stage.action === "terminal_failure",
  );
  stages.splice(terminalIndex, 0, {
    stageId: "evaluation.deterministic_revision",
    scope: "run",
    failureCodes: [...EVALUATION_REVISION_FAILURE_CODES],
    action: "deterministic_workflow",
    handlerIds: [policy.actions.revisionHandlerId],
  });
}

function upsertReviewStage(
  stages: RecoveryStageV1[],
  policy: RuntimeEvaluationPolicyV1,
): void {
  const existing = stages.find(
    (stage): stage is RecoveryHumanReviewStageV1 =>
      stage.action === "human_review",
  );
  if (existing !== undefined) {
    existing.failureCodes = appendUnique(
      existing.failureCodes,
      EVALUATION_REVIEW_FAILURE_CODES,
    );
    existing.optionIds = appendUnique(
      existing.optionIds,
      policy.actions.reviewOptionIds,
    );
    return;
  }
  const terminalIndex = stages.findIndex(
    (stage) => stage.action === "terminal_failure",
  );
  stages.splice(terminalIndex, 0, {
    stageId: "evaluation.operator_review",
    scope: "run",
    failureCodes: [...EVALUATION_REVIEW_FAILURE_CODES],
    action: "human_review",
    optionIds: [...policy.actions.reviewOptionIds],
  });
}

function assertEvaluationStageIdCompatibility(policy: RecoveryPolicyV1): void {
  const expected = new Map([
    ["evaluation.deterministic_revision", "deterministic_workflow"],
    ["evaluation.operator_review", "human_review"],
  ]);
  for (const stage of policy.stages) {
    const action = expected.get(stage.stageId);
    if (action !== undefined && stage.action !== action) {
      throw new Error(
        `Recovery stage '${stage.stageId}' conflicts with runtime evaluation composition.`,
      );
    }
  }
}

function appendUnique<T extends string>(
  current: readonly T[],
  additions: readonly T[],
): T[] {
  return [...new Set([...current, ...additions])];
}
