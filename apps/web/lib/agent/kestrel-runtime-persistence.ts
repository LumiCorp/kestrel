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
  if (meta.errorMessage && !meta.failureVisible) {
    return ensureAssistantFailureVisibility(messages, meta.errorMessage);
  }

  return messages;
}
