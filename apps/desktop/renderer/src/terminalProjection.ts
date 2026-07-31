import {
  acceptRendererPrompt,
  appendRendererTranscript,
  updateRendererThread,
  type DesktopRendererState,
} from "./state";

export interface DesktopTerminalProjectionInput {
  threadId: string;
  runId: string;
  turnId?: string | undefined;
  assistantText: string | null | undefined;
  status: string;
  timestamp: string;
  pendingUser?: { text: string; timestamp: string } | undefined;
  pendingWaitEventType?: string | undefined;
  waitingPrompt?: string | undefined;
  failureMessage?: string | undefined;
  data?: unknown;
}

export interface DesktopTerminalProjection {
  state: DesktopRendererState;
  outcome: "projected" | "duplicate" | "contract_failure";
}

export const DESKTOP_TERMINAL_DELIVERY_ERROR =
  "The run completed, but its final response could not be delivered. Refresh to retry recovery.";

export function getDesktopTerminalDeliveryError(
  input: Pick<DesktopTerminalProjectionInput, "assistantText" | "status">,
): string | undefined {
  return input.status === "COMPLETED" && !hasAssistantText(input.assistantText)
    ? DESKTOP_TERMINAL_DELIVERY_ERROR
    : undefined;
}

export function projectDesktopTerminalMessage(
  state: DesktopRendererState,
  input: DesktopTerminalProjectionInput,
): DesktopTerminalProjection {
  const thread = state.threads.find((entry) => entry.id === input.threadId);
  if (thread === undefined) return { state, outcome: "duplicate" };
  if (thread.transcript.some((line) => terminalRunId(line) === input.runId)) {
    return { state, outcome: "duplicate" };
  }
  let next = state;
  if (input.pendingUser !== undefined) {
    next = appendRendererTranscript(
      acceptRendererPrompt(next, input.threadId, input.pendingUser.text),
      input.threadId,
      { role: "user", text: input.pendingUser.text, timestamp: input.pendingUser.timestamp },
    );
  }
  const deliveryError = getDesktopTerminalDeliveryError(input);
  const failed = input.status === "FAILED";
  const waiting = input.status === "WAITING";
  const assistantText = typeof input.assistantText === "string" ? input.assistantText : "";
  const text = deliveryError
    ?? (failed ? input.failureMessage ?? "Run failed." : undefined)
    ?? (waiting ? input.waitingPrompt ?? waitingText(input.pendingWaitEventType) : undefined)
    ?? assistantText;
  next = appendRendererTranscript(next, input.threadId, {
    role: deliveryError !== undefined || failed || waiting ? "system" : "assistant",
    text,
    timestamp: input.timestamp,
    ...(input.data !== undefined && deliveryError === undefined ? { data: input.data } : {}),
    terminal: {
      runId: input.runId,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    },
  });
  next = updateRendererThread(next, input.threadId, (entry) => ({
    ...entry,
    pendingWaitEventType: input.pendingWaitEventType,
  }));
  return {
    state: next,
    outcome: deliveryError !== undefined ? "contract_failure" : "projected",
  };
}

function hasAssistantText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function waitingText(eventType: string | undefined): string {
  return eventType === undefined ? "Waiting for operator input." : `Waiting for ${eventType}.`;
}

function terminalRunId(line: DesktopRendererState["threads"][number]["transcript"][number]): string | undefined {
  if (line.terminal?.runId !== undefined) return line.terminal.runId;
  if (typeof line.data !== "object" || line.data === null || Array.isArray(line.data)) return undefined;
  const data = line.data as Record<string, unknown>;
  return data.kind === "desktop.terminal-outcome.v1" && typeof data.runId === "string"
    ? data.runId
    : undefined;
}
