import type { TuiProfile } from "../../cli/contracts.js";
import {
  createRecoveryPolicyV1,
  parseRecoveryPolicyV1,
  type RecoveryModelCandidateV1,
  type RecoveryPolicyV1,
  type RecoveryStageV1,
} from "../kestrel/contracts/recovery.js";

export const RECOVERY_TRANSIENT_MODEL_FAILURE_CODES = Object.freeze([
  "MODEL_TIMEOUT",
  "MODEL_RATE_LIMITED",
  "MODEL_PROVIDER_TRANSIENT",
  "MODEL_NETWORK_ERROR",
] as const);

const MANAGED_PROFILE_IDS = new Set(["kestrel", "kestrel-one"]);

export function resolveRecoveryPolicyForProfile(
  profile: TuiProfile,
  options: {
    env?: NodeJS.ProcessEnv | undefined;
    alternateModels?: RecoveryModelCandidateV1[] | undefined;
  } = {},
): RecoveryPolicyV1 {
  if (profile.modelProvider === undefined || profile.model === undefined) {
    throw new Error(
      `Profile '${profile.id}' must resolve provider and model before recovery policy resolution.`,
    );
  }
  if (profile.recoveryPolicy !== undefined) {
    const parsed = parseRecoveryPolicyV1(profile.recoveryPolicy);
    assertRecoveryPrimaryProjection(profile, parsed);
    return parsed;
  }
  const primaryModel = buildPrimaryCandidate(profile);
  const maxAttempts = resolveRecoveryMaxAttempts(
    profile.modelProvider,
    options.env,
  );
  const managed = isManagedProfile(profile);
  const stages: RecoveryStageV1[] = [
    {
      stageId: "model.same_route",
      scope: "model_call",
      failureCodes: [...RECOVERY_TRANSIENT_MODEL_FAILURE_CODES],
      action: "retry_same_route",
      maxAttempts,
    },
  ];
  if (managed) {
    stages.push({
      stageId: "model.pinned_alternates",
      scope: "model_call",
      failureCodes: [...RECOVERY_TRANSIENT_MODEL_FAILURE_CODES],
      action: "alternate_model",
      candidates: structuredClone(options.alternateModels ?? []),
    });
    stages.push(
      {
        stageId: "tool.exact_adapters",
        scope: "tool_call",
        failureCodes: [
          "SANDBOX_TIMEOUT",
          "SANDBOX_UNAVAILABLE",
          "TOOL_EXECUTION_FAILED",
        ],
        action: "alternate_tool",
        adapters: [],
      },
      {
        stageId: "run.deterministic_workflows",
        scope: "run",
        failureCodes: [
          "LOOP_GUARD_TRIGGERED",
          "MAX_MODEL_CALLS_EXCEEDED",
          "MAX_STEPS_EXCEEDED",
          "NO_PROGRESS_REASONING_LOOP",
          "RUNTIME_HEAP_PRESSURE",
          "SANDBOX_TIMEOUT",
          "SANDBOX_UNAVAILABLE",
        ],
        action: "deterministic_workflow",
        handlerIds: [
          "context.compaction",
          "run.continuation",
          "run.loop_recovery",
        ],
      },
      {
        stageId: "operator.recovery_review",
        scope: "run",
        failureCodes: ["RECOVERY_EXHAUSTED"],
        action: "human_review",
        optionIds: ["retry.primary", "terminal.fail"],
      },
    );
  }
  stages.push({
    stageId: "run.terminal_failure",
    scope: "run",
    failureCodes: ["RECOVERY_EXHAUSTED"],
    action: "terminal_failure",
    terminalCode: "RECOVERY_EXHAUSTED",
  });
  return createRecoveryPolicyV1({
    policyId: managed
      ? `recovery:kestrel:${profile.presetId ?? "default"}`
      : `recovery:custom:${profile.id}`,
    primaryModel,
    stages,
  });
}

export function resolveProfileWithRecoveryPolicy(
  profile: TuiProfile,
  options: {
    env?: NodeJS.ProcessEnv | undefined;
    alternateModels?: RecoveryModelCandidateV1[] | undefined;
  } = {},
): TuiProfile {
  return {
    ...structuredClone(profile),
    recoveryPolicy: resolveRecoveryPolicyForProfile(profile, options),
  };
}

export function rebindRecoveryPolicyPrimaryModel(
  profile: TuiProfile,
  policy: RecoveryPolicyV1,
): RecoveryPolicyV1 {
  const parsed = parseRecoveryPolicyV1(policy);
  return createRecoveryPolicyV1({
    policyId: parsed.policyId,
    primaryModel: buildPrimaryCandidate(profile),
    stages: parsed.stages,
  });
}

export function resolveRecoveryMaxAttempts(
  provider: NonNullable<TuiProfile["modelProvider"]>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env.KCHAT_MODEL_RETRY_COUNT;
  if (configured !== undefined && configured.trim().length > 0) {
    const retryCount = Number(configured);
    if (
      Number.isSafeInteger(retryCount) === false ||
      retryCount < 0 ||
      retryCount >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        "KCHAT_MODEL_RETRY_COUNT must be a non-negative safe integer.",
      );
    }
    return retryCount + 1;
  }
  return provider === "ollama" || provider === "lmstudio" ? 1 : 3;
}

export function assertRecoveryPrimaryProjection(
  profile: Pick<
    TuiProfile,
    "id" | "modelProvider" | "model" | "modelCredential"
  >,
  policy: RecoveryPolicyV1,
): void {
  const primary = policy.primaryModel;
  if (
    profile.modelProvider !== primary.provider ||
    profile.model !== primary.model
  ) {
    throw new Error(
      `Profile '${profile.id}' primary model projection does not match recovery policy '${policy.policyId}'.`,
    );
  }
  const projectedCredential = profile.modelCredential;
  if (credentialReferencesMatch(
    projectedCredential,
    primary.credentialReference,
  ) === false) {
    throw new Error(
      `Profile '${profile.id}' primary credential projection does not match recovery policy '${policy.policyId}'.`,
    );
  }
}

function credentialReferencesMatch(
  left: TuiProfile["modelCredential"],
  right: RecoveryModelCandidateV1["credentialReference"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.source === right.source &&
    left.runId === right.runId &&
    left.gatewayId === right.gatewayId &&
    left.organizationId === right.organizationId &&
    left.environmentId === right.environmentId &&
    left.rawModelId === right.rawModelId &&
    left.provider === right.provider
  );
}

function buildPrimaryCandidate(profile: TuiProfile): RecoveryModelCandidateV1 {
  const provider = profile.modelProvider;
  const model = profile.model;
  if (provider === undefined || model === undefined) {
    throw new Error(`Profile '${profile.id}' has no resolved primary model.`);
  }
  return {
    candidateId: "primary",
    provider,
    model,
    capabilities: {
      visionInputEnabled:
        profile.modelCapabilities?.visionInputEnabled === true,
      toolCallingEnabled: true,
      structuredOutputEnabled: true,
      reasoningModes:
        provider === "ollama" || provider === "lmstudio"
          ? ["off", "summary"]
          : ["off", "summary", "provider_visible"],
    },
    ...(profile.modelCredential !== undefined
      ? { credentialReference: structuredClone(profile.modelCredential) }
      : {}),
  };
}

function isManagedProfile(
  profile: Pick<TuiProfile, "id" | "agentProfileId" | "sessionPrefix">,
): boolean {
  return [profile.id, profile.agentProfileId, profile.sessionPrefix].some(
    (value) => value !== undefined && MANAGED_PROFILE_IDS.has(value),
  );
}
