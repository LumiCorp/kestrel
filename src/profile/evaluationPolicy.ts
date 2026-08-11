import type { TuiProfile } from "../../cli/contracts.js";
import {
  parseRuntimeEvaluationPolicyV1,
  type RuntimeEvaluationPolicyV1,
} from "../kestrel/contracts/evaluation.js";

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
  return {
    ...structuredClone(profile),
    evaluationPolicy,
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
}
