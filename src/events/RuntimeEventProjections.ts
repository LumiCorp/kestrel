import type { RunEventType } from "../kestrel/contracts/base.js";
import type {
  PersistedRuntimeEvent,
  ProgressKind,
  ProgressPhase,
  ProgressUpdateV1,
  ReasoningMilestone,
  ReasoningUpdateV1,
  RunToolPhase,
  RunToolUpdateV1,
} from "../kestrel/contracts/events.js";

export function buildPersistedRuntimeEventFromProgressUpdate(
  update: ProgressUpdateV1,
): PersistedRuntimeEvent {
  return {
    runId: update.runId,
    sessionId: update.sessionId,
    ...(update.stepIndex !== undefined ? { stepIndex: update.stepIndex } : {}),
    type: toProgressRunEventType(update.kind),
    level: update.code.endsWith("FAILED") ? "ERROR" : "INFO",
    timestamp: update.ts,
    metadata: {
      phase: update.phase,
      code: update.code,
      message: update.message,
      ts: update.ts,
      persist: update.persist,
      ...(update.stepAgent !== undefined ? { stepAgent: update.stepAgent } : {}),
      ...(update.tool !== undefined ? { tool: update.tool } : {}),
      ...(update.waitFor !== undefined ? { waitFor: update.waitFor } : {}),
      ...(update.queueDepthRun !== undefined ? { queueDepthRun: update.queueDepthRun } : {}),
      ...(update.queueDepthGlobal !== undefined ? { queueDepthGlobal: update.queueDepthGlobal } : {}),
      ...(update.queueWaitMs !== undefined ? { queueWaitMs: update.queueWaitMs } : {}),
      ...(update.chunkIndex !== undefined ? { chunkIndex: update.chunkIndex } : {}),
      ...(update.chunkSize !== undefined ? { chunkSize: update.chunkSize } : {}),
      ...(update.progress !== undefined ? { progress: update.progress } : {}),
      seq: update.seq,
    },
  };
}

export function readProgressUpdateFromPersistedRuntimeEvent(
  event: PersistedRuntimeEvent,
): ProgressUpdateV1 | undefined {
  const kind = readProgressKindFromRunEventType(event.type);
  if (kind === undefined) {
    return undefined;
  }
  const metadata = asRecord(event.metadata);
  const phase = readString(metadata?.phase);
  const code = readString(metadata?.code);
  const message = readString(metadata?.message);
  const seq = readNumber(metadata?.seq);
  if (phase === undefined || code === undefined || message === undefined || seq === undefined) {
    return undefined;
  }
  return {
    version: "v1",
    runId: event.runId,
    sessionId: event.sessionId,
    ts: readString(metadata?.ts) ?? event.timestamp,
    seq,
    kind,
    phase: phase as ProgressPhase,
    code: code as ProgressUpdateV1["code"],
    message,
    ...(event.stepIndex !== undefined ? { stepIndex: event.stepIndex } : {}),
    ...(readString(metadata?.stepAgent) !== undefined ? { stepAgent: readString(metadata?.stepAgent) } : {}),
    ...(asRecord(metadata?.tool) !== undefined ? { tool: metadata?.tool as ProgressUpdateV1["tool"] } : {}),
    ...(asRecord(metadata?.waitFor) !== undefined ? { waitFor: metadata?.waitFor as ProgressUpdateV1["waitFor"] } : {}),
    ...(readNumber(metadata?.queueDepthRun) !== undefined ? { queueDepthRun: readNumber(metadata?.queueDepthRun) } : {}),
    ...(readNumber(metadata?.queueDepthGlobal) !== undefined
      ? { queueDepthGlobal: readNumber(metadata?.queueDepthGlobal) }
      : {}),
    ...(readNumber(metadata?.queueWaitMs) !== undefined ? { queueWaitMs: readNumber(metadata?.queueWaitMs) } : {}),
    ...(readNumber(metadata?.chunkIndex) !== undefined ? { chunkIndex: readNumber(metadata?.chunkIndex) } : {}),
    ...(readNumber(metadata?.chunkSize) !== undefined ? { chunkSize: readNumber(metadata?.chunkSize) } : {}),
    ...(asRecord(metadata?.progress) !== undefined
      ? { progress: metadata?.progress as ProgressUpdateV1["progress"] }
      : {}),
    persist: readBoolean(metadata?.persist) ?? true,
  };
}

export function buildPersistedRuntimeEventFromReasoningUpdate(
  update: ReasoningUpdateV1,
): PersistedRuntimeEvent {
  return {
    runId: update.runId,
    sessionId: update.sessionId,
    ...(update.stepIndex !== undefined ? { stepIndex: update.stepIndex } : {}),
    type: "reasoning.update",
    level: "INFO",
    timestamp: update.ts,
    metadata: {
      milestone: update.milestone,
      message: update.message,
      seq: update.seq,
      ts: update.ts,
      ...(update.stepAgent !== undefined ? { stepAgent: update.stepAgent } : {}),
      ...(update.model !== undefined ? { model: update.model } : {}),
    },
  };
}

export function readReasoningUpdateFromPersistedRuntimeEvent(
  event: PersistedRuntimeEvent,
): ReasoningUpdateV1 | undefined {
  if (event.type !== "reasoning.update") {
    return undefined;
  }
  const metadata = asRecord(event.metadata);
  const milestone = readString(metadata?.milestone);
  const message = readString(metadata?.message);
  const seq = readNumber(metadata?.seq);
  if (milestone === undefined || message === undefined || seq === undefined) {
    return undefined;
  }
  return {
    version: "v1",
    runId: event.runId,
    sessionId: event.sessionId,
    ts: readString(metadata?.ts) ?? event.timestamp,
    seq,
    milestone: milestone as ReasoningMilestone,
    message,
    ...(event.stepIndex !== undefined ? { stepIndex: event.stepIndex } : {}),
    ...(readString(metadata?.stepAgent) !== undefined ? { stepAgent: readString(metadata?.stepAgent) } : {}),
    ...(asRecord(metadata?.model) !== undefined ? { model: metadata?.model as ReasoningUpdateV1["model"] } : {}),
  };
}

export function buildPersistedRuntimeEventFromToolUpdate(
  update: RunToolUpdateV1,
): PersistedRuntimeEvent {
  return {
    runId: update.runId,
    sessionId: update.sessionId,
    ...(update.stepIndex !== undefined ? { stepIndex: update.stepIndex } : {}),
    type: toToolRunEventType(update.phase),
    level: update.phase === "failed" ? "ERROR" : "INFO",
    timestamp: update.ts,
    metadata: {
      version: update.version,
      seq: update.seq,
      ts: update.ts,
      toolCallId: update.toolCallId,
      toolName: update.toolName,
      phase: update.phase,
      ...(update.stepAgent !== undefined ? { stepAgent: update.stepAgent } : {}),
      ...(update.displayName !== undefined ? { displayName: update.displayName } : {}),
      ...(update.toolFamily !== undefined ? { toolFamily: update.toolFamily } : {}),
      ...(update.provider !== undefined ? { provider: update.provider } : {}),
      ...(update.input !== undefined ? { input: update.input } : {}),
      ...(update.output !== undefined ? { output: update.output } : {}),
      ...(update.error !== undefined ? { error: update.error } : {}),
      ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
    },
  };
}

export function readToolUpdateFromPersistedRuntimeEvent(
  event: PersistedRuntimeEvent,
): RunToolUpdateV1 | undefined {
  const phase = readToolPhaseFromRunEventType(event.type);
  if (phase === undefined) {
    return undefined;
  }
  const metadata = asRecord(event.metadata);
  const seq = readNumber(metadata?.seq);
  const toolCallId = readString(metadata?.toolCallId);
  const toolName = readString(metadata?.toolName);
  if (seq === undefined || toolCallId === undefined || toolName === undefined) {
    return undefined;
  }

  return {
    version: "v1",
    runId: event.runId,
    sessionId: event.sessionId,
    ts: readString(metadata?.ts) ?? event.timestamp,
    seq,
    toolCallId,
    toolName,
    phase,
    ...(event.stepIndex !== undefined ? { stepIndex: event.stepIndex } : {}),
    ...(readString(metadata?.stepAgent) !== undefined ? { stepAgent: readString(metadata?.stepAgent) } : {}),
    ...(readString(metadata?.displayName) !== undefined ? { displayName: readString(metadata?.displayName) } : {}),
    ...(readString(metadata?.toolFamily) !== undefined ? { toolFamily: readString(metadata?.toolFamily) } : {}),
    ...(readString(metadata?.provider) !== undefined ? { provider: readString(metadata?.provider) } : {}),
    ...(metadata !== undefined && "input" in metadata ? { input: metadata.input } : {}),
    ...(metadata !== undefined && "output" in metadata ? { output: metadata.output } : {}),
    ...(asRecord(metadata?.error) !== undefined
      ? { error: metadata?.error as RunToolUpdateV1["error"] }
      : {}),
    ...(readNumber(metadata?.durationMs) !== undefined ? { durationMs: readNumber(metadata?.durationMs) } : {}),
  };
}

function toProgressRunEventType(kind: ProgressKind): RunEventType {
  if (kind === "stage") {
    return "progress.stage";
  }
  if (kind === "tool") {
    return "progress.tool";
  }
  if (kind === "waiting") {
    return "progress.waiting";
  }
  return "progress.heartbeat";
}

function toToolRunEventType(phase: RunToolPhase): RunEventType {
  if (phase === "started") {
    return "run.tool.started";
  }
  if (phase === "completed") {
    return "run.tool.completed";
  }
  return "run.tool.failed";
}

function readToolPhaseFromRunEventType(type: RunEventType): RunToolPhase | undefined {
  if (type === "run.tool.started") {
    return "started";
  }
  if (type === "run.tool.completed") {
    return "completed";
  }
  if (type === "run.tool.failed") {
    return "failed";
  }
  return undefined;
}

function readProgressKindFromRunEventType(type: RunEventType): ProgressKind | undefined {
  if (type === "progress.stage") {
    return "stage";
  }
  if (type === "progress.tool") {
    return "tool";
  }
  if (type === "progress.waiting") {
    return "waiting";
  }
  if (type === "progress.heartbeat") {
    return "heartbeat";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
