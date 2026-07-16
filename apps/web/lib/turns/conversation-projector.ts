import type {
  ThreadConversationState,
  ThreadInteractionView,
  ThreadTurnView,
} from "@/lib/turns/client-contract";
import type { ChatMessage } from "@/lib/types";

export type ConversationProjectionIssue = {
  code: "MESSAGE_TURN_CONFLICT" | "MISSING_TURN_RECORD";
  message: string;
  messageId: string;
};

export type ProjectedConversationItem =
  | {
      kind: "durable_turn";
      id: string;
      turnId: string;
      turn: ThreadTurnView | null;
      messages: ChatMessage[];
      interactions: ThreadInteractionView[];
    }
  | {
      kind: "standalone_message";
      id: string;
      message: ChatMessage;
    };

export type ProjectedConversation = {
  items: ProjectedConversationItem[];
  issues: ConversationProjectionIssue[];
};

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
  const turnsById = new Map(
    input.conversationState.turns.map((turn) => [turn.id, turn])
  );
  const turnIdByMessageId = new Map<string, string>();
  const issues: ConversationProjectionIssue[] = [];

  const bindMessage = (messageId: string | null, turnId: string | null) => {
    if (!(messageId && turnId)) return;
    const existing = turnIdByMessageId.get(messageId);
    if (existing && existing !== turnId) {
      issues.push({
        code: "MESSAGE_TURN_CONFLICT",
        message: `Message '${messageId}' is bound to multiple durable turns.`,
        messageId,
      });
      return;
    }
    turnIdByMessageId.set(messageId, turnId);
  };

  for (const turn of input.conversationState.turns) {
    bindMessage(turn.inputMessageId, turn.id);
  }
  for (const interaction of input.conversationState.interactions) {
    bindMessage(interaction.assistantMessageId, interaction.turnId);
    bindMessage(interaction.responseMessageId, interaction.turnId);
  }
  for (const message of input.messages) {
    bindMessage(message.id, message.metadata?.kestrelTurnId ?? null);
  }

  const messagesByTurnId = new Map<string, ChatMessage[]>();
  for (const message of input.messages) {
    const turnId = turnIdByMessageId.get(message.id);
    if (!turnId) continue;
    const current = messagesByTurnId.get(turnId) ?? [];
    current.push(message);
    messagesByTurnId.set(turnId, current);
    if (
      !turnsById.has(turnId) &&
      message.metadata?.deliveryState !== "sending" &&
      message.metadata?.deliveryState !== "queued" &&
      input.conversationState.queue.activeTurnId !== turnId
    ) {
      issues.push({
        code: "MISSING_TURN_RECORD",
        message: `Message '${message.id}' references missing durable turn '${turnId}'.`,
        messageId: message.id,
      });
    }
  }

  const interactionsByTurnId = new Map<string, ThreadInteractionView[]>();
  for (const interaction of input.conversationState.interactions) {
    if (!interaction.turnId) continue;
    const current = interactionsByTurnId.get(interaction.turnId) ?? [];
    current.push(interaction);
    interactionsByTurnId.set(interaction.turnId, current);
  }

  const emittedTurnIds = new Set<string>();
  const items: ProjectedConversationItem[] = [];
  for (const message of input.messages) {
    const turnId = turnIdByMessageId.get(message.id);
    if (!turnId) {
      items.push({
        kind: "standalone_message",
        id: `message:${message.id}`,
        message,
      });
      continue;
    }
    if (emittedTurnIds.has(turnId)) continue;
    emittedTurnIds.add(turnId);
    items.push({
      kind: "durable_turn",
      id: `turn:${turnId}`,
      turnId,
      turn: turnsById.get(turnId) ?? null,
      messages: messagesByTurnId.get(turnId) ?? [],
      interactions: interactionsByTurnId.get(turnId) ?? [],
    });
  }

  return { items, issues };
}
