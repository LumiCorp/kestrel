import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";
import { normalizeTimestampString } from "./timestamps.js";

const SUBMITTED_HISTORY_WINDOW_LIMIT = 64;

export interface SubmittedHistoryLine {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  attachments?: RunTurnAttachment[] | undefined;
  data?: { kind: "runtime.waiting_prompt" } | undefined;
}

export function normalizeSubmittedHistory(history: unknown): SubmittedHistoryLine[] | undefined {
  if (history === undefined) {
    return undefined;
  }
  if (Array.isArray(history) === false) {
    return undefined;
  }

  return preserveInitialUserHistoryLine(
    history.flatMap((line) => {
      const normalized = normalizeSubmittedHistoryLine(line);
      return normalized === undefined ? [] : [normalized];
    }),
    SUBMITTED_HISTORY_WINDOW_LIMIT,
  );
}

export function buildModelHistoryWindow(
  history: unknown,
  limit = SUBMITTED_HISTORY_WINDOW_LIMIT,
): SubmittedHistoryLine[] {
  if (Array.isArray(history) === false) {
    return [];
  }
  return preserveInitialUserHistoryLine(
    history.flatMap((line) => {
      const normalized = normalizeSubmittedHistoryLine(line);
      return normalized === undefined ? [] : [normalized];
    }),
    limit,
  );
}

function normalizeSubmittedHistoryLine(line: unknown): SubmittedHistoryLine | undefined {
  if (isRecord(line) === false) {
    return undefined;
  }
  const data = isRecord(line.data) ? line.data : undefined;
  const isRuntimeWaitingPrompt = line.role === "system" && data?.kind === "runtime.waiting_prompt";
  if (line.role !== "user" && line.role !== "assistant" && isRuntimeWaitingPrompt === false) {
    return undefined;
  }
  if (typeof line.text !== "string" || typeof line.timestamp !== "string") {
    return undefined;
  }
  if (line.role === "assistant" && isRecord(line.data) && line.data.reasoning === true) {
    return undefined;
  }

  return {
    role: line.role as SubmittedHistoryLine["role"],
    text: line.text,
    timestamp: normalizeTimestampString(line.timestamp),
    ...(Array.isArray(line.attachments) ? { attachments: line.attachments as RunTurnAttachment[] } : {}),
    ...(isRuntimeWaitingPrompt ? { data: { kind: "runtime.waiting_prompt" as const } } : {}),
  };
}

function preserveInitialUserHistoryLine(
  lines: SubmittedHistoryLine[],
  limit: number,
): SubmittedHistoryLine[] {
  if (lines.length <= limit) {
    return lines;
  }
  const recent = lines.slice(-limit);
  const firstUser = lines.find((line) => line.role === "user");
  if (
    firstUser === undefined ||
    recent.some((line) => line === firstUser)
  ) {
    return recent;
  }
  return [firstUser, ...lines.slice(-(limit - 1))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}
