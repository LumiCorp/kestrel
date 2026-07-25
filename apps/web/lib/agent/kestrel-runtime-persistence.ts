import type { UIMessage } from "ai";
import { ensureAssistantFailureVisibility } from "@/lib/utils";

export type KestrelRuntimePersistenceMeta = {
  errorMessage: string | null;
  failureVisible: boolean;
};

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
