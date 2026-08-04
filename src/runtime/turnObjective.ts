import {
  readActiveTaskGoalFromTranscript,
} from "./modelTranscript.js";

export interface KestrelTurnObjectiveInput {
  reactState: Record<string, unknown>;
  eventType: string;
  eventPayload: Record<string, unknown>;
  fallbackGoal?: string | undefined;
  eventId?: string | undefined;
}

export interface KestrelTurnObjectiveResolution {
  goal: string | undefined;
  source: "fresh-user-message" | "active-turn-intent" | "transcript" | "fallback" | "payload";
  preservesTranscriptTask: boolean;
}

export function resolveKestrelTurnObjective(
  input: KestrelTurnObjectiveInput,
): KestrelTurnObjectiveResolution {
  const payloadInstruction = readTurnPayloadInstruction(input.eventPayload);
  const preservesTranscriptTask = shouldPreserveTranscriptTaskForTurn(input);
  if (preservesTranscriptTask === false && payloadInstruction !== undefined) {
    return {
      goal: payloadInstruction,
      source: "fresh-user-message",
      preservesTranscriptTask,
    };
  }

  const activeTurnObjective = readActiveTurnIntent(input.reactState)?.objective.trim();
  if (activeTurnObjective !== undefined && activeTurnObjective.length > 0) {
    return {
      goal: activeTurnObjective,
      source: "active-turn-intent",
      preservesTranscriptTask,
    };
  }

  const transcriptGoal = readActiveTaskGoalFromTranscript(
    input.reactState.modelTranscript,
    readActiveTurnIntent(input.reactState)?.activeTranscriptItemId,
  )?.trim();
  if (transcriptGoal !== undefined && transcriptGoal.length > 0) {
    return {
      goal: transcriptGoal,
      source: "transcript",
      preservesTranscriptTask,
    };
  }

  const isResumeTurn = input.eventPayload.resumeBlockedRun === true;
  const resumeInstruction = isResumeTurn
    ? readTurnPayloadGoal(input.eventPayload)
    : undefined;
  if (resumeInstruction !== undefined) {
    return {
      goal: resumeInstruction,
      source: "payload",
      preservesTranscriptTask,
    };
  }

  const fallbackGoal = input.fallbackGoal?.trim();
  if (fallbackGoal !== undefined && fallbackGoal.length > 0) {
    return {
      goal: fallbackGoal,
      source: "fallback",
      preservesTranscriptTask,
    };
  }

  if (isResumeTurn) {
    return {
      goal: payloadInstruction,
      source: "payload",
      preservesTranscriptTask,
    };
  }

  return {
    goal: undefined,
    source: "payload",
    preservesTranscriptTask,
  };
}

export function shouldStartFreshUserMessageTaskEpoch(input: KestrelTurnObjectiveInput): boolean {
  return shouldPreserveTranscriptTaskForTurn(input) === false &&
    readTurnPayloadInstruction(input.eventPayload) !== undefined;
}

export function shouldPreserveTranscriptTaskForTurn(input: KestrelTurnObjectiveInput): boolean {
  const submissionKind = readSubmissionKind(input.eventPayload);
  const activeIntent = readActiveTurnIntent(input.reactState);
  if (submissionKind === "initial" || submissionKind === "follow_up") {
    return activeIntent !== undefined &&
      input.eventId !== undefined &&
      activeIntent.rootEventId === input.eventId;
  }
  if (submissionKind === "resume" || submissionKind === "steer") return true;
  if (input.eventPayload.resumeBlockedRun === true || input.eventType === "user.reply") return true;
  if (input.eventType !== "user.message") return true;
  if (activeIntent !== undefined && input.eventId !== undefined) {
    return activeIntent.rootEventId === input.eventId || activeIntent.turnId === input.eventId;
  }
  return hasLegacyActiveTaskState(input.reactState);
}

export interface ActiveTurnIntentV1 {
  version: "v1";
  turnId: string;
  rootEventId: string;
  objective: string;
  activeTranscriptItemId: string;
}

export type ConversationSubmissionKind = "initial" | "resume" | "steer" | "follow_up";

export function readActiveTurnIntent(state: Record<string, unknown>): ActiveTurnIntentV1 | undefined {
  const value = asRecord(state.activeTurnIntent);
  const turnId = asString(value?.turnId)?.trim();
  const rootEventId = asString(value?.rootEventId)?.trim();
  const objective = asString(value?.objective)?.trim();
  const activeTranscriptItemId = asString(value?.activeTranscriptItemId)?.trim();
  if (
    value?.version !== "v1" || !turnId || !rootEventId || !objective || !activeTranscriptItemId
  ) return undefined;
  return { version: "v1", turnId, rootEventId, objective, activeTranscriptItemId };
}

export function readActiveTaskGoalFromState(state: Record<string, unknown>): string | undefined {
  const intent = readActiveTurnIntent(state);
  return intent?.objective ?? readActiveTaskGoalFromTranscript(
    state.modelTranscript,
    intent?.activeTranscriptItemId,
  );
}

export function readActiveTaskItemIdFromState(state: Record<string, unknown>): string | undefined {
  const intent = readActiveTurnIntent(state);
  if (intent !== undefined) return intent.activeTranscriptItemId;
  const transcript = asRecord(state.modelTranscript);
  const items = Array.isArray(transcript?.items) ? transcript.items : [];
  const item = items.find((candidate) => {
    const record = asRecord(candidate);
    return record?.kind === "user" && Boolean(asString(record.content)?.trim());
  });
  return asString(asRecord(item)?.id);
}

export function readSubmissionKind(eventPayload: Record<string, unknown>): ConversationSubmissionKind | undefined {
  const metadata = asRecord(eventPayload.metadata);
  const value = asString(metadata?.submissionKind);
  return value === "initial" || value === "resume" || value === "steer" || value === "follow_up"
    ? value
    : undefined;
}

function hasLegacyActiveTaskState(reactState: Record<string, unknown>): boolean {
  if (
    reactState.finalized === true ||
    asString(reactState.phase) === "DONE" ||
    asRecord(reactState.terminal) !== undefined
  ) return false;
  return (
    asRecord(reactState.waitingFor) !== undefined ||
    asRecord(reactState.activeContinuation) !== undefined ||
    asRecord(reactState.pendingContinuationOffer) !== undefined ||
    asRecord(reactState.lastAction) !== undefined ||
    asRecord(reactState.lastActionResult) !== undefined ||
    asRecord(reactState.commandBatch) !== undefined ||
    asRecord(reactState.nextAction) !== undefined ||
    asRecord(reactState.retryContext) !== undefined ||
    asRecord(reactState.visibleTodos) !== undefined ||
    (Array.isArray(reactState.observations) && reactState.observations.length > 0) ||
    (Array.isArray(reactState.evidenceLedger) && reactState.evidenceLedger.length > 0) ||
    transcriptHasExecutionState(reactState.modelTranscript)
  );
}

function transcriptHasExecutionState(value: unknown): boolean {
  const transcript = asRecord(value);
  const items = Array.isArray(transcript?.items) ? transcript.items : [];
  return items.some((item) => {
    const kind = asString(asRecord(item)?.kind);
    return kind === "tool_call" || kind === "tool_result" ||
      kind === "todo_update" || kind === "compaction_summary";
  });
}

export function readTurnPayloadInstruction(
  eventPayload: Record<string, unknown>,
): string | undefined {
  const message = asString(eventPayload.message)?.trim();
  if (message !== undefined && message.length > 0) {
    return message;
  }
  const goal = asString(eventPayload.goal)?.trim();
  return goal !== undefined && goal.length > 0 ? goal : undefined;
}

function readTurnPayloadGoal(
  eventPayload: Record<string, unknown>,
): string | undefined {
  const goal = asString(eventPayload.goal)?.trim();
  return goal !== undefined && goal.length > 0 ? goal : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
