import type { UIMessage } from "ai";
import { ensureAssistantFailureVisibility } from "@/lib/utils";

export type KestrelRuntimePersistenceMeta = {
  errorMessage: string | null;
  failureVisible: boolean;
};

type DurableReplayChunk = {
  type: string;
  [key: string]: unknown;
};

const TERMINAL_REPLAY_CHUNK_TYPES = new Set([
  "data-chat-title",
  "data-interaction-mode",
  "data-kestrel-interaction",
  "data-kestrel-status",
  "finish",
  "message-metadata",
  "text-delta",
  "text-end",
]);

function readReplayChunk(chunk: unknown): DurableReplayChunk | null {
  if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) {
    return null;
  }
  const record = chunk as Record<string, unknown>;
  return typeof record.type === "string"
    ? ({ ...record, type: record.type } as DurableReplayChunk)
    : null;
}

export function readTerminalKestrelUiChunk(
  chunk: unknown,
): DurableReplayChunk | null {
  const replayChunk = readReplayChunk(chunk);
  if (!replayChunk) return null;
  if (
    replayChunk.type === "finish" &&
    typeof replayChunk.finishReason !== "string"
  ) {
    throw new Error("The durable replay finish reason is invalid.");
  }
  return TERMINAL_REPLAY_CHUNK_TYPES.has(replayChunk.type)
    ? replayChunk
    : null;
}

export function readKestrelReplayScaffoldChunk(chunk: unknown): {
  assistantMessageId?: string;
  textPartId?: string;
} {
  const replayChunk = readReplayChunk(chunk);
  if (!replayChunk) return {};
  if (
    replayChunk.type === "start" &&
    typeof replayChunk.messageId === "string"
  ) {
    return { assistantMessageId: replayChunk.messageId };
  }
  if (replayChunk.type === "text-start" && typeof replayChunk.id === "string") {
    return { textPartId: replayChunk.id };
  }
  return {};
}

export function buildKestrelFailureReplayChunks(input: {
  assistantMessageId: string;
  textPartId: string;
  turnId: string;
  status: "failed" | "cancelled";
  text: string;
  errorMessage?: string | null;
  includeStart: boolean;
  includeTextStart: boolean;
}): DurableReplayChunk[] {
  return [
    ...(input.includeStart
      ? [{ type: "start", messageId: input.assistantMessageId }]
      : []),
    ...(input.includeTextStart
      ? [{ type: "text-start", id: input.textPartId }]
      : []),
    {
      type: "data-kestrel-status",
      id: `status:${input.assistantMessageId}`,
      data: {
        status: input.status,
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      },
    },
    { type: "text-delta", id: input.textPartId, delta: input.text },
    { type: "text-end", id: input.textPartId },
    {
      type: "message-metadata",
      messageMetadata: {
        kestrelTerminalStatus: input.status,
        kestrelTurnId: input.turnId,
      },
    },
    { type: "finish", finishReason: "stop" },
  ];
}

export function isLiveOnlyKestrelUiChunk(chunk: unknown): boolean {
  if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) {
    return false;
  }
  const record = chunk as { type?: unknown; data?: unknown };
  if (record.type === "data-kestrel-provider-reasoning") {
    return true;
  }
  if (
    record.type !== "data-kestrel-progress" ||
    typeof record.data !== "object" ||
    record.data === null ||
    Array.isArray(record.data)
  ) {
    return false;
  }
  return (record.data as { persist?: unknown }).persist === false;
}

export async function appendKestrelUiChunkIfDurable<T>(
  chunk: T,
  append: (chunk: T) => Promise<void>,
): Promise<boolean> {
  if (isLiveOnlyKestrelUiChunk(chunk)) {
    return false;
  }
  await append(chunk);
  return true;
}

export function prepareKestrelRuntimeMessagesForPersistence(
  messages: UIMessage[],
  meta: KestrelRuntimePersistenceMeta
) {
  const persistableMessages = messages.map((message) => {
    const parts = message.parts.filter(
      (part) => !isLiveOnlyKestrelUiChunk(part)
    );

    return parts.length === message.parts.length
      ? message
      : { ...message, parts };
  });

  // `failureVisible` describes the live stream. It cannot prove that the
  // durable assistant message contains failure text.
  if (meta.errorMessage) {
    return ensureAssistantFailureVisibility(
      persistableMessages,
      meta.errorMessage
    );
  }

  return persistableMessages;
}
