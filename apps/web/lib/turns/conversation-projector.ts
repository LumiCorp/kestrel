import type {
  ThreadConversationState,
  ThreadInteractionView,
  ThreadTurnView,
} from "@/lib/turns/client-contract";
import type { ChatMessage } from "@/lib/types";
import {
  projectConversation,
} from "@kestrel-agents/conversation";

export type ConversationProjectionIssue = import("@kestrel-agents/conversation").ConversationProjectionIssue;
export type ProjectedConversationItem = import("@kestrel-agents/conversation").ProjectedConversationItem<ChatMessage, ThreadTurnView, ThreadInteractionView>;
export type ProjectedConversation = import("@kestrel-agents/conversation").ProjectedConversation<ChatMessage, ThreadTurnView, ThreadInteractionView>;

export function collectDurableTurnPresentationParts(messages: ChatMessage[]) {
  const seen = new Set<string>();
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    const parts = message.parts.filter((part) => {
      if (!part.type.startsWith("data-kestrel-")) return false;
      const id = "id" in part && typeof part.id === "string" ? part.id : null;
      if (id && seen.has(id)) return false;
      if (id) seen.add(id);
      return true;
    });
    const waitingStatuses = parts.filter(
      (part) =>
        part.type === "data-kestrel-status" && part.data.status === "waiting"
    );
    if (waitingStatuses.length === 0) return parts;
    const interactions = parts.filter(
      (part) => part.type === "data-kestrel-interaction"
    );
    const waitingPartSet = new Set<ChatMessage["parts"][number]>(
      waitingStatuses
    );
    const interactionPartSet = new Set<ChatMessage["parts"][number]>(
      interactions
    );
    return [
      ...parts.filter(
        (part) => !(waitingPartSet.has(part) || interactionPartSet.has(part))
      ),
      ...waitingStatuses,
      ...interactions,
    ];
  });
}

/**
 * Projects the durable conversation from explicit protocol and database
 * identities only. Message ordering, timestamps, and text are never used to
 * infer turn ownership.
 */
export function projectThreadConversation(input: {
  messages: ChatMessage[];
  conversationState: ThreadConversationState;
}): ProjectedConversation {
  return projectConversation({
    messages: input.messages,
    turns: input.conversationState.turns,
    interactions: input.conversationState.interactions,
  });
}
