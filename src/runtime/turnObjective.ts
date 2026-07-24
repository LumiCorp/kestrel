import {
  readActiveTaskGoalFromTranscript,
} from "./modelTranscript.js";

export interface KestrelTurnObjectiveInput {
  reactState: Record<string, unknown>;
  eventType: string;
  eventPayload: Record<string, unknown>;
  fallbackGoal?: string | undefined;
}

export interface KestrelTurnObjectiveResolution {
  goal: string | undefined;
  source: "fresh-user-message" | "transcript" | "fallback" | "payload";
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

  const transcriptGoal = readActiveTaskGoalFromTranscript(input.reactState.modelTranscript)?.trim();
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
  if (input.eventType !== "user.message") {
    return true;
  }
  if (input.eventPayload.resumeBlockedRun === true) {
    return true;
  }
  return hasExplicitActiveTaskState(input.reactState);
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

function hasExplicitActiveTaskState(reactState: Record<string, unknown>): boolean {
  if (isTerminalAgentTaskState(reactState)) {
    return false;
  }
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
    hasNonEmptyArray(reactState.observations) ||
    hasNonEmptyArray(reactState.evidenceLedger) ||
    transcriptHasTaskExecutionState(reactState.modelTranscript)
  );
}

function isTerminalAgentTaskState(reactState: Record<string, unknown>): boolean {
  return reactState.finalized === true ||
    asString(reactState.phase) === "DONE" ||
    asRecord(reactState.terminal) !== undefined;
}

function transcriptHasTaskExecutionState(value: unknown): boolean {
  const transcript = asRecord(value);
  const items = Array.isArray(transcript?.items) ? transcript.items : [];
  return items.some((item) => {
    const record = asRecord(item);
    return record?.kind === "tool_call" ||
      record?.kind === "tool_result" ||
      record?.kind === "todo_update" ||
      record?.kind === "compaction_summary";
  });
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
