import { asArray, asRecord, asString } from "../../shared/valueAccess.js";
import { DecisionCompileError } from "./decision/DecisionCompileError.js";
import type { ReactAction } from "./types.js";
import { findUserVisibleTextViolation } from "./userVisibleTextPolicy.js";
import { buildModeSwitchMessage } from "./modeSwitch.js";

export function validateFinalizationDecision(input: {
  action: ReactAction;
  lastActionResult?: unknown;
  evidenceLedger?: unknown;
}): void {
  if (
    input.action.kind !== "finalize" &&
    input.action.kind !== "handoff_to_build" &&
    input.action.kind !== "switch_mode"
  ) {
    return;
  }

  const actionInput =
    input.action.kind === "finalize" ? asRecord(input.action.input) : undefined;
  const message = asString(
    input.action.kind === "handoff_to_build"
      ? input.action.message
      : input.action.kind === "switch_mode"
        ? buildModeSwitchMessage(input.action.mode)
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
    field:
      input.action.kind === "handoff_to_build"
        ? "handoff_to_build.message"
        : "finalize.message",
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
  validateWorkspacePreviewUrls({
    message,
    lastActionResult: input.lastActionResult,
    evidenceLedger: input.evidenceLedger,
    keepRunningSessionIds: readKeepRunningSessionIds(input.action),
  });
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
  const legacyFields = ["changedFiles", "checksRun", "checksFailed"].filter(
    (field) => Object.hasOwn(data ?? {}, field),
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

function validateWorkspacePreviewUrls(input: {
  message: string;
  lastActionResult: unknown;
  evidenceLedger: unknown;
  keepRunningSessionIds: string[];
}): void {
  const evidenceUrls = collectWorkspacePreviewEvidenceUrls(input);
  if (evidenceUrls.length === 0) {
    return;
  }
  const evidenceByPreviewId = new Map<string, Set<string>>();
  for (const evidenceUrl of evidenceUrls) {
    const previewId = readWorkspacePreviewId(evidenceUrl);
    if (previewId === undefined) {
      continue;
    }
    const urls = evidenceByPreviewId.get(previewId) ?? new Set<string>();
    urls.add(evidenceUrl);
    evidenceByPreviewId.set(previewId, urls);
  }
  for (const suppliedUrl of extractUrls(input.message)) {
    const previewId = readWorkspacePreviewId(suppliedUrl);
    const expectedUrls =
      previewId === undefined ? undefined : evidenceByPreviewId.get(previewId);
    if (expectedUrls === undefined || expectedUrls.has(suppliedUrl)) {
      if (expectedUrls !== undefined) {
        assertLiveRetainedPreviewEvidence(input, suppliedUrl);
      }
      continue;
    }
    throw new DecisionCompileError(
      "DECISION_SCHEMA_FAILED",
      "Finalize must copy a Workspace preview URL exactly from tool evidence.",
      "schema",
      {
        reason: "workspace_preview_url_not_copied_exactly",
        path: "nextAction.message",
        suppliedUrl,
        expectedUrls: [...expectedUrls],
        requiredCorrection:
          "Call kestrel_finalize again and copy the matching workspace.preview URL byte-for-byte, including its hostname, path, query, and trailing slash.",
      },
    );
  }
}

function assertLiveRetainedPreviewEvidence(
  input: {
    lastActionResult: unknown;
    evidenceLedger: unknown;
    keepRunningSessionIds: string[];
  },
  suppliedUrl: string,
) {
  const snapshots = collectPreviewSnapshots([
    input.evidenceLedger,
    input.lastActionResult,
  ]).filter((snapshot) => snapshot.url === suppliedUrl);
  const latest = snapshots.at(-1);
  if (
    latest?.applicationStatus === "listening" &&
    latest.retentionStatus === "active" &&
    typeof latest.sessionId === "string" &&
    input.keepRunningSessionIds.includes(latest.sessionId)
  )
    return;
  throw new DecisionCompileError(
    "DECISION_POLICY_FAILED",
    "Finalize can present a Workspace preview as live only with current liveness and retention evidence.",
    "policy",
    {
      reason: "workspace_preview_live_evidence_required",
      suppliedUrl,
      requiredCorrection:
        "List or publish the exact preview again, confirm applicationStatus listening and retentionStatus active, and include its sessionId in data.keepRunningSessionIds.",
    },
  );
}

function collectPreviewSnapshots(
  values: unknown[],
  depth = 0,
): Array<Record<string, unknown>> {
  if (depth > 10) return [];
  return values.flatMap((value) => {
    if (Array.isArray(value)) return collectPreviewSnapshots(value, depth + 1);
    const record = asRecord(value);
    if (record === undefined) return [];
    const own =
      typeof record.url === "string" &&
      readWorkspacePreviewId(record.url) !== undefined
        ? [record]
        : [];
    return [
      ...own,
      ...collectPreviewSnapshots(Object.values(record), depth + 1),
    ];
  });
}

function collectWorkspacePreviewEvidenceUrls(input: {
  lastActionResult: unknown;
  evidenceLedger: unknown;
}): string[] {
  const urls = new Set<string>();
  const addPreviewUrls = (value: unknown) => {
    for (const url of extractUrlsFromValue(value)) {
      if (readWorkspacePreviewId(url) !== undefined) {
        urls.add(url);
      }
    }
  };
  const addToolResult = (value: unknown) => {
    const result = asRecord(value);
    if (result === undefined) {
      return;
    }
    const toolName = asString(result.toolName) ?? asString(result.name);
    if (toolName?.startsWith("workspace.preview.") === true) {
      addPreviewUrls(result.output);
      addPreviewUrls(result.outputSummary);
    }
    for (const item of asArray(result.items)) {
      addToolResult(item);
    }
  };
  addToolResult(input.lastActionResult);
  for (const value of asArray(input.evidenceLedger)) {
    const entry = asRecord(value);
    const facts = asRecord(entry?.facts);
    if (asString(facts?.toolName)?.startsWith("workspace.preview.") !== true) {
      continue;
    }
    addPreviewUrls(entry?.summary);
    addPreviewUrls(facts);
    addPreviewUrls(entry?.target);
  }
  return [...urls];
}

function extractUrlsFromValue(value: unknown, depth = 0): string[] {
  if (depth > 8) {
    return [];
  }
  if (typeof value === "string") {
    return extractUrls(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractUrlsFromValue(item, depth + 1));
  }
  const record = asRecord(value);
  return record === undefined
    ? []
    : Object.values(record).flatMap((item) =>
        extractUrlsFromValue(item, depth + 1),
      );
}

function extractUrls(value: string): string[] {
  return (value.match(/https?:\/\/[^\s<>{}\[\]"'`]+/gu) ?? []).map((url) =>
    url.replace(/[),.;:!?]+$/gu, ""),
  );
}

function readWorkspacePreviewId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return;
    }
    const [previewId, previewLabel] = url.hostname.toLowerCase().split(".");
    return /^p-[a-f0-9]{32}$/u.test(previewId ?? "") &&
        previewLabel === "preview"
      ? previewId
      : undefined;
  } catch {
    return;
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
    if (
      typeof item !== "string" ||
      item.trim().length === 0 ||
      item !== item.trim()
    ) {
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
}):
  | {
  message: string;
  reason: string;
  details: Record<string, unknown>;
    }
  | undefined {
  const artifactVerification = asRecord(input.artifactVerification);
  const status = asString(artifactVerification?.status);
  const requirementFailures =
    readArtifactVerificationFailures(artifactVerification);
  if (
    input.completionState === "implemented_and_verified" &&
    artifactVerification !== undefined &&
    status !== "passed"
  ) {
    return {
      message:
        "Finalize data cannot claim implemented_and_verified while artifactVerification is not passed.",
      reason: "implemented_and_verified_with_unpassed_artifact_verification",
      details: {
        artifactVerificationStatus: status ?? "missing",
        ...requirementFailures,
      },
    };
  }
  if (
    status === "passed" &&
    hasArtifactVerificationFailures(requirementFailures)
  ) {
    return {
      message:
        "Finalize artifactVerification cannot be passed while it also reports failures or non-passing requirements.",
      reason: "artifact_verification_passed_with_failures",
      details: requirementFailures,
    };
  }
  return ;
}

function readArtifactVerificationFailures(
  artifactVerification: Record<string, unknown> | undefined,
): {
  failingRequirementIds?: string[] | undefined;
  failureCount?: number | undefined;
} {
  if (artifactVerification?.status !== "passed") {
    const failures = asArray(artifactVerification?.failures)
      .map((item) => asString(item)?.trim())
      .filter((item): item is string => item !== undefined && item.length > 0);
    const failingRequirementIds = asArray(
      artifactVerification?.requirements,
    ).flatMap((item) => {
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
  const failingRequirementIds = asArray(
    artifactVerification.requirements,
  ).flatMap((item) => {
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
  return (
    (input.failureCount ?? 0) > 0 ||
    (input.failingRequirementIds?.length ?? 0) > 0
  );
}
