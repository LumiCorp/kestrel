import { asArray, asRecord, asString } from "../../shared/valueAccess.js";
import { DecisionCompileError } from "./decision/DecisionCompileError.js";
import type { ReactAction } from "./types.js";
import { findUserVisibleTextViolation } from "./userVisibleTextPolicy.js";

export function validateFinalizationDecision(input: {
  action: ReactAction;
}): void {
  if (input.action.kind !== "finalize" && input.action.kind !== "handoff_to_build" && input.action.kind !== "switch_mode") {
    return;
  }

  const actionInput = input.action.kind === "finalize" ? asRecord(input.action.input) : undefined;
  const message = asString(
    input.action.kind === "handoff_to_build" || input.action.kind === "switch_mode"
      ? input.action.message
      : actionInput?.message,
  )?.trim();
  if (message === undefined || message.length === 0) {
    throw new DecisionCompileError(
      "DECISION_SCHEMA_FAILED",
      "Finalize requires a non-empty user-facing message.",
      "schema",
      {
        reason: "finalize_message_required",
        requiredAction: "call_finalize_with_user_facing_message",
      },
    );
  }
  const userVisibleViolation = findUserVisibleTextViolation({
    field: input.action.kind === "handoff_to_build" ? "handoff_to_build.message" : "finalize.message",
    text: message,
  });
  if (userVisibleViolation !== undefined) {
    throw new DecisionCompileError(
      "DECISION_POLICY_FAILED",
      userVisibleViolation.message,
      "policy",
      userVisibleViolation.details,
    );
  }
  if (input.action.kind !== "finalize") {
    return;
  }
  const data = asRecord(actionInput?.data);
  validateKeepRunningSessionIds(input.action, data);
  if (input.action.finalizeReason !== "goal_satisfied") {
    return;
  }
  const artifactContradiction = readArtifactVerificationContradiction({
    completionState: asString(data?.completionState),
    artifactVerification: data?.artifactVerification,
  });
  if (artifactContradiction !== undefined) {
    throw new DecisionCompileError(
      "DECISION_SCHEMA_FAILED",
      artifactContradiction.message,
      "schema",
      {
        reason: artifactContradiction.reason,
        ...artifactContradiction.details,
      },
    );
  }
  const legacyFields = ["changedFiles", "checksRun", "checksFailed"].filter((field) =>
    Object.hasOwn(data ?? {}, field)
  );
  if (legacyFields.length > 0) {
    throw new DecisionCompileError(
      "DECISION_SCHEMA_FAILED",
      "Finalize data must not include legacy closeout evidence fields.",
      "schema",
      {
        reason: "legacy_finalize_evidence_fields_removed",
        path: "nextAction.data",
        legacyFields,
        requiredCorrection:
          "Call kestrel_finalize again with the same status and user-facing message, but omit changedFiles, checksRun, and checksFailed from data. The runtime derives changed files and validation evidence from observed tool results.",
      },
    );
  }
}

export function readKeepRunningSessionIds(action: ReactAction): string[] {
  if (action.kind !== "finalize") {
    return [];
  }
  const data = asRecord(asRecord(action.input)?.data);
  const value = data?.keepRunningSessionIds;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0);
}

function validateKeepRunningSessionIds(
  action: Extract<ReactAction, { kind: "finalize" }>,
  data: Record<string, unknown> | undefined,
): void {
  const value = data?.keepRunningSessionIds;
  if (value === undefined) {
    return;
  }
  if (action.finalizeReason !== "goal_satisfied") {
    throw new DecisionCompileError(
      "DECISION_SCHEMA_FAILED",
      "Finalize data.keepRunningSessionIds is only valid with status goal_satisfied.",
      "schema",
      {
        reason: "keep_running_sessions_require_goal_satisfied",
        path: "nextAction.data.keepRunningSessionIds",
      },
    );
  }
  if (!Array.isArray(value)) {
    throw invalidKeepRunningSessionIds("keep_running_sessions_must_be_array");
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0 || item !== item.trim()) {
      throw invalidKeepRunningSessionIds("keep_running_session_id_invalid");
    }
    normalized.push(item);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw invalidKeepRunningSessionIds("keep_running_session_ids_duplicate");
  }
}

function invalidKeepRunningSessionIds(reason: string): DecisionCompileError {
  return new DecisionCompileError(
    "DECISION_SCHEMA_FAILED",
    "Finalize data.keepRunningSessionIds must be an array of unique, non-empty exec_command session IDs.",
    "schema",
    {
      reason,
      path: "nextAction.data.keepRunningSessionIds",
    },
  );
}

function readArtifactVerificationContradiction(input: {
  completionState: string | undefined;
  artifactVerification: unknown;
}): {
  message: string;
  reason: string;
  details: Record<string, unknown>;
} | undefined {
  const artifactVerification = asRecord(input.artifactVerification);
  const status = asString(artifactVerification?.status);
  const requirementFailures = readArtifactVerificationFailures(artifactVerification);
  if (
    input.completionState === "implemented_and_verified" &&
    artifactVerification !== undefined &&
    status !== "passed"
  ) {
    return {
      message: "Finalize data cannot claim implemented_and_verified while artifactVerification is not passed.",
      reason: "implemented_and_verified_with_unpassed_artifact_verification",
      details: {
        artifactVerificationStatus: status ?? "missing",
        ...requirementFailures,
      },
    };
  }
  if (status === "passed" && hasArtifactVerificationFailures(requirementFailures)) {
    return {
      message: "Finalize artifactVerification cannot be passed while it also reports failures or non-passing requirements.",
      reason: "artifact_verification_passed_with_failures",
      details: requirementFailures,
    };
  }
  return ;
}

function readArtifactVerificationFailures(
  artifactVerification: Record<string, unknown> | undefined,
): { failingRequirementIds?: string[] | undefined; failureCount?: number | undefined } {
  if (artifactVerification?.status !== "passed") {
    const failures = asArray(artifactVerification?.failures)
      .map((item) => asString(item)?.trim())
      .filter((item): item is string => item !== undefined && item.length > 0);
    const failingRequirementIds = asArray(artifactVerification?.requirements)
      .flatMap((item) => {
        const requirement = asRecord(item);
        const status = asString(requirement?.status);
        if (status === "passed" || status === undefined) {
          return [];
        }
        const id = asString(requirement?.id)?.trim();
        return [id !== undefined && id.length > 0 ? id : status];
      });
    return {
      ...(failures.length > 0 ? { failureCount: failures.length } : {}),
      ...(failingRequirementIds.length > 0 ? { failingRequirementIds } : {}),
    };
  }
  const failures = asArray(artifactVerification.failures)
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0);
  const failingRequirementIds = asArray(artifactVerification.requirements)
    .flatMap((item) => {
      const requirement = asRecord(item);
      const status = asString(requirement?.status);
      if (status === "passed" || status === undefined) {
        return [];
      }
      const id = asString(requirement?.id)?.trim();
      return [id !== undefined && id.length > 0 ? id : status];
    });
  return {
    ...(failures.length > 0 ? { failureCount: failures.length } : {}),
    ...(failingRequirementIds.length > 0 ? { failingRequirementIds } : {}),
  };
}

function hasArtifactVerificationFailures(input: {
  failingRequirementIds?: string[] | undefined;
  failureCount?: number | undefined;
}): boolean {
  return (input.failureCount ?? 0) > 0 || (input.failingRequirementIds?.length ?? 0) > 0;
}
