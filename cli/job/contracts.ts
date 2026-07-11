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

export interface JobRunResultV1 {
  version: "job_run_result_v1";
  sessionId: string;
  threadId: string;
  runId: string;
  status: RunTurnResult["output"]["status"];
  waitFor?: RunTurnResult["output"]["waitFor"] | undefined;
  replay: JobReplayPointerV1;
  result?: RunTurnResult | undefined;
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
    return undefined;
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
  if (record.agent !== "reference-react") {
    throw new Error("job input profile.agent must be 'reference-react'");
  }
  if (typeof record.sessionPrefix !== "string" || record.sessionPrefix.trim().length === 0) {
    throw new Error("job input profile.sessionPrefix must be a non-empty string");
  }
  return value as TuiProfile;
}

function parseOptionalStoreDriver(value: unknown): StoreDriverId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "auto" || value === "postgres" || value === "sqlite") {
    return value;
  }
  throw new Error("job input storeDriver must be auto|postgres|sqlite when present");
}

function parseOptionalApprovalPolicyPack(value: unknown): ApprovalPolicyPackId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "dev" || value === "ci_bot" || value === "production") {
    return value;
  }
  throw new Error("job input approvalPolicyPackId must be dev|ci_bot|production when present");
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\"'\"'")}'`;
}
