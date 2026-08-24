import type { ApprovalPolicyPackId, StoreDriverId, TuiProfile } from "../contracts.js";
import type { RunTurnInput, RunTurnResult } from "../runtime/KestrelChatRuntime.js";

export interface JobInputV1 {
  version: "job_input_v1";
  turn: RunTurnInput;
  profileId?: string | undefined;
  profile?: TuiProfile | undefined;
  storeDriver?: StoreDriverId | undefined;
  approvalPolicyPackId?: ApprovalPolicyPackId | undefined;
}

export type JobEnvironmentPresetId = "cli_safe_local" | "cli_dev_local";

export interface JobExecutionProfileBindingV1 {
  version: "job_execution_profile_binding_v1";
  authoringProfileId: string;
  environmentPresetId: JobEnvironmentPresetId;
  resolvedProfileId: string;
  profileFingerprint: string;
  policy: {
    id: string;
    version: number;
  };
  approvalPolicyPack: {
    id: ApprovalPolicyPackId;
    version: 1;
    digest: string;
  };
}

export interface JobInputV2 {
  version: "job_input_v2";
  profileId: string;
  environmentPresetId: JobEnvironmentPresetId;
  approvalPolicyPackId: ApprovalPolicyPackId;
  requiredTools: string[];
  turn: RunTurnInput;
  executionProfileBinding?: JobExecutionProfileBindingV1 | undefined;
}

export type JobInput = JobInputV1 | JobInputV2;

export interface JobPreflightV1 {
  version: "job_preflight_v1";
  capability: "local-core.execution-profile-resolution.v2";
  status: "ready" | "setup_required";
  requestedPresetId: JobEnvironmentPresetId;
  resolvedPresetId: JobEnvironmentPresetId;
  profileId: string;
  profileFingerprint: string;
  policyRevision: string;
  approvalPolicyPackId: ApprovalPolicyPackId;
  effectiveTools: string[];
  requiredTools: string[];
  missingTools: string[];
  executionProfileBinding: JobExecutionProfileBindingV1;
  code?: "SETUP_REQUIRED" | undefined;
  remediation?: string | undefined;
}

export interface JobRunRejectionV1 {
  version: "job_run_rejection_v1";
  code: "COMPATIBILITY_ERROR";
  message: string;
  details: {
    mismatches: string[];
  };
}

export interface JobReplayPointerV1 {
  version: "job_replay_pointer_v1";
  sessionId: string;
  threadId: string;
  runId: string;
  replayQuery: {
    runId: string;
    sessionId: string;
    threadId: string;
  };
  commands: {
    replay: string;
    doctor: string;
    bundle: string;
  };
}

export interface JobManagedResultHandleV1 {
  version: "job_managed_result_handle_v1";
  kind: "managed_worktree";
  worktreePath: string;
  sourceWorkspaceRoot: string;
  baseRevision: string;
  candidateRevision: string;
  changedFiles: string[];
  promotionId?: string | undefined;
}

export interface JobRunResultV1 {
  version: "job_run_result_v1";
  sessionId: string;
  threadId: string;
  runId: string;
  status: RunTurnResult["output"]["status"];
  waitFor?: RunTurnResult["output"]["waitFor"] | undefined;
  resultHandle?: JobManagedResultHandleV1 | undefined;
  replay: JobReplayPointerV1;
  result: RunTurnResult;
  error?:
    | {
        code: string;
        message: string;
        details?: Record<string, unknown> | undefined;
      }
    | undefined;
}

export interface JobOutputV1 {
  version: "job_output_v1";
  terminalEventType: "job.completed" | "job.failed";
  job: JobRunResultV1;
}

export function parseJobInputV1(value: unknown): JobInputV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job input must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== "job_input_v1") {
    throw new Error("job input version must be 'job_input_v1'");
  }
  const turn = parseRunTurnInput(record.turn);
  const profileId = readOptionalString(record.profileId);
  const profile = parseOptionalProfile(record.profile);
  const storeDriver = parseOptionalStoreDriver(record.storeDriver);
  const approvalPolicyPackId = parseOptionalApprovalPolicyPack(record.approvalPolicyPackId);
  return {
    version: "job_input_v1",
    turn,
    ...(profileId !== undefined ? { profileId } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(storeDriver !== undefined ? { storeDriver } : {}),
    ...(approvalPolicyPackId !== undefined ? { approvalPolicyPackId } : {}),
  };
}

export function parseJobInput(value: unknown): JobInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job input must be an object");
  }
  return (value as Record<string, unknown>).version === "job_input_v2"
    ? parseJobInputV2(value)
    : parseJobInputV1(value);
}

export function parseJobInputV2(value: unknown): JobInputV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job input must be an object");
  }
  const record = value as Record<string, unknown>;
  rejectUnknownFields(
    record,
    new Set([
      "version",
      "profileId",
      "environmentPresetId",
      "approvalPolicyPackId",
      "requiredTools",
      "turn",
      "executionProfileBinding",
    ]),
    "job input v2",
  );
  if (record.version !== "job_input_v2") {
    throw new Error("job input version must be 'job_input_v2'");
  }
  const profileId = readRequiredString(record.profileId, "job input profileId");
  const environmentPresetId = parseEnvironmentPresetId(record.environmentPresetId);
  const approvalPolicyPackId = parseRequiredApprovalPolicyPack(record.approvalPolicyPackId);
  const requiredTools = parseSortedUniqueStrings(record.requiredTools, "job input requiredTools");
  const executionProfileBinding = record.executionProfileBinding === undefined
    ? undefined
    : parseExecutionProfileBinding(record.executionProfileBinding);
  return {
    version: "job_input_v2",
    profileId,
    environmentPresetId,
    approvalPolicyPackId,
    requiredTools,
    turn: parseRunTurnInput(record.turn),
    ...(executionProfileBinding !== undefined ? { executionProfileBinding } : {}),
  };
}

export function buildJobReplayPointer(input: {
  sessionId: string;
  threadId: string;
  runId: string;
}): JobReplayPointerV1 {
  return {
    version: "job_replay_pointer_v1",
    sessionId: input.sessionId,
    threadId: input.threadId,
    runId: input.runId,
    replayQuery: {
      runId: input.runId,
      sessionId: input.sessionId,
      threadId: input.threadId,
    },
    commands: {
      replay: `kestrel runtime replay --run-id ${shellQuote(input.runId)}`,
      doctor: `kestrel runtime doctor --run-id ${shellQuote(input.runId)}`,
      bundle: `kestrel runtime bundle --run-id ${shellQuote(input.runId)} --out <bundle.json>`,
    },
  };
}

function parseRunTurnInput(value: unknown): RunTurnInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job input turn must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    throw new Error("job input turn.sessionId must be a non-empty string");
  }
  if (typeof record.message !== "string") {
    throw new Error("job input turn.message must be a string");
  }
  if (record.eventType !== undefined && (typeof record.eventType !== "string" || record.eventType.trim().length === 0)) {
    throw new Error("job input turn.eventType must be a non-empty string when present");
  }
  if (
    record.interactionMode !== undefined &&
    record.interactionMode !== "chat" &&
    record.interactionMode !== "plan" &&
    record.interactionMode !== "build"
  ) {
    throw new Error("job input turn.interactionMode must be one of chat, plan, build when present");
  }
  if (
    record.actSubmode !== undefined &&
    record.actSubmode !== "strict" &&
    record.actSubmode !== "safe" &&
    record.actSubmode !== "full_auto"
  ) {
    throw new Error("job input turn.actSubmode must be one of strict, safe, full_auto when present");
  }
  return {
    ...record,
    sessionId: record.sessionId,
    message: record.message,
    eventType: typeof record.eventType === "string" ? record.eventType : "job.run",
  } as RunTurnInput;
}

function parseOptionalProfile(value: unknown): TuiProfile | undefined {
  if (value === undefined) {
    return ;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job input profile must be an object when present");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    throw new Error("job input profile.id must be a non-empty string");
  }
  if (typeof record.label !== "string" || record.label.trim().length === 0) {
    throw new Error("job input profile.label must be a non-empty string");
  }
  if (record.agent !== "kestrel") {
    throw new Error("job input profile.agent must be 'kestrel'");
  }
  if (typeof record.sessionPrefix !== "string" || record.sessionPrefix.trim().length === 0) {
    throw new Error("job input profile.sessionPrefix must be a non-empty string");
  }
  return value as TuiProfile;
}

function parseOptionalStoreDriver(value: unknown): StoreDriverId | undefined {
  if (value === undefined) {
    return ;
  }
  if (value === "auto" || value === "postgres" || value === "sqlite") {
    return value;
  }
  throw new Error("job input storeDriver must be auto|postgres|sqlite when present");
}

function parseOptionalApprovalPolicyPack(value: unknown): ApprovalPolicyPackId | undefined {
  if (value === undefined) {
    return ;
  }
  if (value === "dev" || value === "ci_bot" || value === "production") {
    return value;
  }
  throw new Error("job input approvalPolicyPackId must be dev|ci_bot|production when present");
}

function parseRequiredApprovalPolicyPack(value: unknown): ApprovalPolicyPackId {
  const parsed = parseOptionalApprovalPolicyPack(value);
  if (parsed === undefined) {
    throw new Error("job input approvalPolicyPackId must be dev|ci_bot|production");
  }
  return parsed;
}

function parseEnvironmentPresetId(value: unknown): JobEnvironmentPresetId {
  if (value === "cli_safe_local" || value === "cli_dev_local") {
    return value;
  }
  throw new Error("job input environmentPresetId must be cli_safe_local|cli_dev_local");
}

function parseExecutionProfileBinding(value: unknown): JobExecutionProfileBindingV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job input executionProfileBinding must be an object");
  }
  const record = value as Record<string, unknown>;
  rejectUnknownFields(
    record,
    new Set([
      "version",
      "authoringProfileId",
      "environmentPresetId",
      "resolvedProfileId",
      "profileFingerprint",
      "policy",
      "approvalPolicyPack",
    ]),
    "job input executionProfileBinding",
  );
  if (record.version !== "job_execution_profile_binding_v1") {
    throw new Error("job input executionProfileBinding.version must be 'job_execution_profile_binding_v1'");
  }
  const fingerprint = readSha256(record.profileFingerprint, "job input executionProfileBinding.profileFingerprint");
  const policy = parseBindingPolicy(record.policy);
  const approvalPolicyPack = parseBindingApprovalPack(record.approvalPolicyPack);
  return {
    version: "job_execution_profile_binding_v1",
    authoringProfileId: readRequiredString(record.authoringProfileId, "job input executionProfileBinding.authoringProfileId"),
    environmentPresetId: parseEnvironmentPresetId(record.environmentPresetId),
    resolvedProfileId: readRequiredString(record.resolvedProfileId, "job input executionProfileBinding.resolvedProfileId"),
    profileFingerprint: fingerprint,
    policy,
    approvalPolicyPack,
  };
}

function parseBindingPolicy(value: unknown): JobExecutionProfileBindingV1["policy"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job input executionProfileBinding.policy must be an object");
  }
  const record = value as Record<string, unknown>;
  rejectUnknownFields(record, new Set(["id", "version"]), "job input executionProfileBinding.policy");
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) {
    throw new Error("job input executionProfileBinding.policy.version must be a positive integer");
  }
  return {
    id: readRequiredString(record.id, "job input executionProfileBinding.policy.id"),
    version: record.version as number,
  };
}

function parseBindingApprovalPack(value: unknown): JobExecutionProfileBindingV1["approvalPolicyPack"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job input executionProfileBinding.approvalPolicyPack must be an object");
  }
  const record = value as Record<string, unknown>;
  rejectUnknownFields(
    record,
    new Set(["id", "version", "digest"]),
    "job input executionProfileBinding.approvalPolicyPack",
  );
  if (record.version !== 1) {
    throw new Error("job input executionProfileBinding.approvalPolicyPack.version must be 1");
  }
  return {
    id: parseRequiredApprovalPolicyPack(record.id),
    version: 1,
    digest: readSha256(record.digest, "job input executionProfileBinding.approvalPolicyPack.digest"),
  };
}

function parseSortedUniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const normalized = [...new Set(value.map((item) => (item as string).trim()))].sort();
  if (normalized.length !== value.length || normalized.some((item, index) => item !== value[index])) {
    throw new Error(`${label} must be sorted and contain unique values`);
  }
  return normalized;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readSha256(value: unknown, label: string): string {
  const digest = readRequiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknown.sort().join(", ")}`);
  }
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\"'\"'")}'`;
}
