import type { UIMessage } from "ai";
import { ensureAssistantFailureVisibility } from "@/lib/utils";

export type KestrelRuntimePersistenceMeta = {
  errorMessage: string | null;
  failureVisible: boolean;
};

export function prepareKestrelRuntimeMessagesForPersistence(
  messages: UIMessage[],
  meta: KestrelRuntimePersistenceMeta
) {
  const persistableMessages = messages.map((message) => {
    const parts = message.parts.filter(
      (part) => part.type !== "data-kestrel-provider-reasoning"
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
