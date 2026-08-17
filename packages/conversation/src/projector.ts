import type {
  ConversationInteraction,
  ConversationMessageLike,
  ConversationSnapshot,
  ConversationTurn,
} from "./contracts.js";

export type ConversationProjectionIssue = {
  code: "MESSAGE_TURN_CONFLICT" | "MISSING_TURN_RECORD";
  message: string;
  messageId: string;
};

export type ProjectedConversationItem<Message, Turn, Interaction> =
  | {
      kind: "durable_turn";
      id: string;
      turnId: string;
      turn: Turn | null;
      messages: Message[];
      interactions: Interaction[];
    }
  | { kind: "standalone_message"; id: string; message: Message };

export type ProjectedConversation<Message, Turn, Interaction> = {
  items: Array<ProjectedConversationItem<Message, Turn, Interaction>>;
  issues: ConversationProjectionIssue[];
};

/**
 * Projects conversation ownership from durable identities only. Timestamps,
 * text and array adjacency are deliberately never used to infer a turn.
 */
export function projectConversation<
  Message extends ConversationMessageLike,
  Turn extends ConversationTurn,
  Interaction extends ConversationInteraction,
>(input: {
  messages: readonly Message[];
  turns: readonly Turn[];
  interactions: readonly Interaction[];
}): ProjectedConversation<Message, Turn, Interaction> {
  const orderedTurns = [...input.turns].sort(compareTurns);
  const turnsById = new Map(orderedTurns.map((turn) => [turn.id, turn]));
  const turnIdByMessageId = new Map<string, string>();
  const issues: ConversationProjectionIssue[] = [];

  const bind = (messageId: string | null | undefined, turnId: string | null | undefined) => {
    if (!messageId || !turnId) return;
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

  for (const turn of orderedTurns) bind(turn.inputMessageId, turn.id);
  for (const interaction of input.interactions) {
    bind(interaction.assistantMessageId, interaction.turnId);
    bind(interaction.responseMessageId, interaction.turnId);
  }
  for (const message of input.messages) {
    bind(message.id, message.metadata?.kestrelTurnId);
  }

  const messagesByTurnId = new Map<string, Message[]>();
  const inputOrdinalByMessageId = new Map(
    input.messages.map((message, index) => [message.id, index]),
  );
  for (const message of input.messages) {
    const turnId = turnIdByMessageId.get(message.id);
    if (!turnId) continue;
    const current = messagesByTurnId.get(turnId) ?? [];
    current.push(clearProcessedDeliveryState(message, turnsById.get(turnId)));
    messagesByTurnId.set(turnId, current);
    if (
      !turnsById.has(turnId) &&
      message.metadata?.deliveryState !== "submitting" &&
      message.metadata?.deliveryState !== "sending" &&
      message.metadata?.deliveryState !== "queued"
    ) {
      issues.push({
        code: "MISSING_TURN_RECORD",
        message: `Message '${message.id}' references missing durable turn '${turnId}'.`,
        messageId: message.id,
      });
    }
  }

  const interactionAssistantIds = new Set(
    input.interactions.flatMap((interaction) =>
      interaction.assistantMessageId === null ? [] : [interaction.assistantMessageId]),
  );
  const interactionResponseIds = new Set(
    input.interactions.flatMap((interaction) =>
      interaction.responseMessageId === null ? [] : [interaction.responseMessageId]),
  );
  for (const turn of orderedTurns) {
    const messages = messagesByTurnId.get(turn.id);
    if (messages === undefined) continue;
    messages.sort((left, right) =>
      messagePhase(left, turn, interactionAssistantIds, interactionResponseIds) -
        messagePhase(right, turn, interactionAssistantIds, interactionResponseIds) ||
      (inputOrdinalByMessageId.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (inputOrdinalByMessageId.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
    );
  }

  const interactionsByTurnId = new Map<string, Interaction[]>();
  for (const interaction of input.interactions) {
    if (!interaction.turnId) continue;
    const current = interactionsByTurnId.get(interaction.turnId) ?? [];
    current.push(interaction);
    interactionsByTurnId.set(interaction.turnId, current);
  }

  const items: Array<ProjectedConversationItem<Message, Turn, Interaction>> = [];
  const emittedTurnIds = new Set<string>();
  for (const turn of orderedTurns) {
    emittedTurnIds.add(turn.id);
    items.push({
      kind: "durable_turn",
      id: `turn:${turn.id}`,
      turnId: turn.id,
      turn,
      messages: messagesByTurnId.get(turn.id) ?? [],
      interactions: interactionsByTurnId.get(turn.id) ?? [],
    });
  }
  for (const message of input.messages) {
    const turnId = turnIdByMessageId.get(message.id);
    if (turnId && emittedTurnIds.has(turnId)) continue;
    items.push({ kind: "standalone_message", id: `message:${message.id}`, message });
  }
  return { items, issues };
}

function messagePhase(
  message: ConversationMessageLike,
  turn: ConversationTurn,
  interactionAssistantIds: ReadonlySet<string>,
  interactionResponseIds: ReadonlySet<string>,
): number {
  if (message.id === turn.inputMessageId) return 0;
  if (interactionAssistantIds.has(message.id)) return 1;
  if (interactionResponseIds.has(message.id)) return 2;
  if (message.role === "user") return 2;
  return 3;
}

export function projectConversationSnapshot<Message extends ConversationMessageLike>(
  snapshot: ConversationSnapshot<Message>,
) {
  return projectConversation({
    messages: snapshot.messages,
    turns: snapshot.turns,
    interactions: snapshot.interactions,
  });
}

export function reconcileConversationMessages<Message extends ConversationMessageLike>(input: {
  persistedMessages: readonly Message[];
  liveMessages: readonly Message[];
  turns: readonly ConversationTurn[];
}): Message[] {
  const terminal = new Set<ConversationTurn["status"]>([
    "waiting_for_input",
    "completed",
    "failed",
    "cancelled",
  ]);
  const statusByTurnId = new Map(input.turns.map((turn) => [turn.id, turn.status]));
  const liveById = new Map(input.liveMessages.map((message) => [message.id, message]));
  const persistedIds = new Set(input.persistedMessages.map((message) => message.id));
  const result = input.persistedMessages.map((persisted) => {
    const live = liveById.get(persisted.id);
    if (!live) return persisted;
    const status = persisted.metadata?.kestrelTurnId
      ? statusByTurnId.get(persisted.metadata.kestrelTurnId)
      : undefined;
    return status === "running" ? live : persisted;
  });
  for (const live of input.liveMessages) {
    if (persistedIds.has(live.id)) continue;
    const status = live.metadata?.kestrelTurnId
      ? statusByTurnId.get(live.metadata.kestrelTurnId)
      : undefined;
    if (status && terminal.has(status)) continue;
    result.push(live);
  }
  return result;
}

function compareTurns(left: ConversationTurn, right: ConversationTurn) {
  return left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function clearProcessedDeliveryState<Message extends ConversationMessageLike>(
  message: Message,
  turn: ConversationTurn | undefined,
): Message {
  if (!turn || turn.status === "queued" || turn.inputMessageId !== message.id || message.metadata?.deliveryState === undefined) {
    return message;
  }
  const { deliveryState: _deliveryState, ...metadata } = message.metadata;
  return { ...message, metadata };
}
