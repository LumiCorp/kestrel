export const THREAD_TURN_STATUSES = [
  "queued",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ThreadTurnStatus = (typeof THREAD_TURN_STATUSES)[number];
export type ThreadTurnTerminalStatus = Extract<
  ThreadTurnStatus,
  "completed" | "failed" | "cancelled"
>;
export type ThreadTurnSource = "web" | "mobile" | "api";
export type ThreadQueueState = "running" | "paused";
export type ThreadQueuePauseReason =
  | "turn_failed"
  | "turn_cancelled"
  | "interaction_required";

const ALLOWED_TRANSITIONS: Record<
  ThreadTurnStatus,
  readonly ThreadTurnStatus[]
> = {
  queued: ["running", "cancelled"],
  running: ["waiting_for_input", "completed", "failed", "cancelled"],
  waiting_for_input: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertThreadTurnTransition(
  from: ThreadTurnStatus,
  to: ThreadTurnStatus
) {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid durable turn transition: ${from} -> ${to}`);
  }
}

export function terminalQueueOutcome(status: ThreadTurnTerminalStatus): {
  state: ThreadQueueState;
  pauseReason: ThreadQueuePauseReason | null;
  dispatchNext: boolean;
} {
  if (status === "completed") {
    return { state: "running", pauseReason: null, dispatchNext: true };
  }
  return {
    state: "paused",
    pauseReason: status === "failed" ? "turn_failed" : "turn_cancelled",
    dispatchNext: false,
  };
}

export function encodeTurnEventCursor(turnId: string, sequence: number) {
  return `${turnId}:${sequence}`;
}

export function decodeTurnEventCursor(cursor: string | null | undefined) {
  if (!cursor) {
    return null;
  }
  const separator = cursor.lastIndexOf(":");
  const turnId = cursor.slice(0, separator);
  const sequence = Number(cursor.slice(separator + 1));
  if (!(separator > 0 && Number.isSafeInteger(sequence) && sequence >= 0)) {
    throw new Error("Invalid turn event cursor.");
  }
  return { turnId, sequence };
}
