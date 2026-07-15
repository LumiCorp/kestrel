import type {
  RunnerAssistantTextHistoryDataV2,
  RunnerWaitingPromptHistoryDataV2,
} from "@kestrel-agents/protocol";
import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";
import { normalizeTimestampString } from "./timestamps.js";

const SUBMITTED_HISTORY_WINDOW_LIMIT = 64;

interface SubmittedHistoryLineBase {
  text: string;
  timestamp: string;
  attachments?: RunTurnAttachment[] | undefined;
}

export type SubmittedHistoryLine = SubmittedHistoryLineBase & (
  | {
      role: "user";
      data?: undefined;
    }
  | {
      role: "assistant";
      data?: RunnerAssistantTextHistoryDataV2 | undefined;
    }
  | {
      role: "system";
      data: RunnerWaitingPromptHistoryDataV2;
    }
);

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

  const normalized = {
    text: line.text,
    timestamp: normalizeTimestampString(line.timestamp),
    ...(Array.isArray(line.attachments) ? { attachments: line.attachments as RunTurnAttachment[] } : {}),
  };
  if (isRuntimeWaitingPrompt) {
    const runId = typeof data?.runId === "string" && data.runId.trim().length > 0
      ? data.runId.trim()
      : undefined;
    return {
      ...normalized,
      role: "system",
      data: {
        kind: "runtime.waiting_prompt",
        ...(runId !== undefined ? { runId } : {}),
      },
    };
  }
  if (line.role === "assistant" && data?.kind === "runtime.assistant_text") {
    const runId = typeof data.runId === "string" && data.runId.trim().length > 0
      ? data.runId.trim()
      : undefined;
    if (runId !== undefined) {
      return {
        ...normalized,
        role: "assistant",
        data: { kind: "runtime.assistant_text", runId },
      };
    }
  }
  return {
    ...normalized,
    role: line.role as "user" | "assistant",
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
