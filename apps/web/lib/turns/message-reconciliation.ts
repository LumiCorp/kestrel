import type { ChatMessage } from "@/lib/types";
import type { ThreadTurnView } from "@/lib/turns/client-contract";
import { reconcileConversationMessages as reconcileSharedConversationMessages } from "@kestrel-agents/conversation";

export function reconcileConversationMessages(input: {
  persistedMessages: ChatMessage[];
  liveMessages: ChatMessage[];
  turns: ThreadTurnView[];
}): ChatMessage[] {
  return reconcileSharedConversationMessages(input);
}

export function removeDurableQueuedMessages(input: {
  queuedMessages: Array<{ message: ChatMessage; turnId: string | null }>;
  persistedMessages: ChatMessage[];
}) {
  const persistedIds = new Set(
    input.persistedMessages.map((message) => message.id),
  );
  return input.queuedMessages.filter(
    (queued) => !persistedIds.has(queued.message.id),
  );
}
