import type {
  ConversationInteraction,
  ConversationMessageLike,
  ConversationSnapshot,
  ConversationTurn,
} from "./contracts.js";

export type ConversationProjectionIssue =
  | {
      code: "MESSAGE_TURN_CONFLICT" | "MISSING_TURN_RECORD";
      message: string;
      messageId: string;
    }
  | {
      code: "TURN_SEQUENCE_CONFLICT" | "TURN_SEQUENCE_MISSING";
      message: string;
      turnId: string;
    }
  | {
      code: "MESSAGE_ORDER_CONFLICT";
      message: string;
      turnId: string;
      messageIds: string[];
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
 *
 * Once ownership is known, message array position is the host's durable
 * transcript preference. Explicit turn and interaction identities can impose
 * causal constraints on that presentation order, but roles and UUIDs cannot.
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
  const conflictingMessageIds = new Set<string>();
  const issues: ConversationProjectionIssue[] = [];
  const turnIdBySequence = new Map<number, string>();

  for (const turn of orderedTurns) {
    if (turn.sequence === null) {
      issues.push({
        code: "TURN_SEQUENCE_MISSING",
        message: `Turn '${turn.id}' has no authoritative conversation sequence.`,
        turnId: turn.id,
      });
      continue;
    }
    const existingTurnId = turnIdBySequence.get(turn.sequence);
    if (existingTurnId !== undefined && existingTurnId !== turn.id) {
      issues.push({
        code: "TURN_SEQUENCE_CONFLICT",
        message: `Turns '${existingTurnId}' and '${turn.id}' share conversation sequence ${turn.sequence}.`,
        turnId: turn.id,
      });
    } else {
      turnIdBySequence.set(turn.sequence, turn.id);
    }
  }

  const bind = (messageId: string | null | undefined, turnId: string | null | undefined) => {
    if (!messageId || !turnId) return;
    const existing = turnIdByMessageId.get(messageId);
    if (existing && existing !== turnId) {
      conflictingMessageIds.add(messageId);
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

  for (const turn of orderedTurns) {
    const messages = messagesByTurnId.get(turn.id);
    if (messages === undefined) continue;
    const ordered = orderTurnMessages({
      messages,
      turn,
      interactions: input.interactions,
      turnIdByMessageId,
      conflictingMessageIds,
    });
    messagesByTurnId.set(turn.id, ordered.messages);
    if (ordered.cycleMessageIds.length > 0) {
      issues.push({
        code: "MESSAGE_ORDER_CONFLICT",
        message: `Durable turn '${turn.id}' has contradictory causal message ordering.`,
        turnId: turn.id,
        messageIds: ordered.cycleMessageIds,
      });
    }
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

function orderTurnMessages<Message extends ConversationMessageLike>(input: {
  messages: readonly Message[];
  turn: ConversationTurn;
  interactions: readonly ConversationInteraction[];
  turnIdByMessageId: ReadonlyMap<string, string>;
  conflictingMessageIds: ReadonlySet<string>;
}): { messages: Message[]; cycleMessageIds: string[] } {
  const messageIndexById = new Map(input.messages.map((message, index) => [message.id, index]));
  const outgoing = input.messages.map(() => new Set<number>());
  const indegree = input.messages.map(() => 0);
  const addEdge = (from: number, to: number) => {
    if (outgoing[from]!.has(to)) return;
    outgoing[from]!.add(to);
    indegree[to] = (indegree[to] ?? 0) + 1;
  };

  const inputIndex = input.turn.inputMessageId === null
    ? undefined
    : messageIndexById.get(input.turn.inputMessageId);
  if (inputIndex !== undefined) {
    for (let index = 0; index < input.messages.length; index += 1) {
      if (index === inputIndex) continue;
      addEdge(inputIndex, index);
    }
  }

  for (const interaction of input.interactions) {
    if (
      interaction.turnId !== input.turn.id ||
      interaction.assistantMessageId === null ||
      interaction.responseMessageId === null ||
      input.conflictingMessageIds.has(interaction.assistantMessageId) ||
      input.conflictingMessageIds.has(interaction.responseMessageId) ||
      input.turnIdByMessageId.get(interaction.assistantMessageId) !== input.turn.id ||
      input.turnIdByMessageId.get(interaction.responseMessageId) !== input.turn.id
    ) continue;
    const assistantIndex = messageIndexById.get(interaction.assistantMessageId);
    const responseIndex = messageIndexById.get(interaction.responseMessageId);
    if (assistantIndex === undefined || responseIndex === undefined) continue;
    addEdge(assistantIndex, responseIndex);
  }

  const ready = indegree.flatMap((degree, index) => degree === 0 ? [index] : []);
  const orderedIndices: number[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    orderedIndices.push(next);
    for (const target of outgoing[next]!) {
      indegree[target] = (indegree[target] ?? 0) - 1;
      if (indegree[target] !== 0) continue;
      insertBySourceOrdinal(ready, target);
    }
  }

  if (orderedIndices.length !== input.messages.length) {
    return {
      messages: [...input.messages],
      cycleMessageIds: findCycleMessageIds(outgoing, input.messages),
    };
  }
  return {
    messages: orderedIndices.map((index) => input.messages[index]!),
    cycleMessageIds: [],
  };
}

function insertBySourceOrdinal(ready: number[], index: number) {
  const insertionPoint = ready.findIndex((candidate) => candidate > index);
  if (insertionPoint === -1) ready.push(index);
  else ready.splice(insertionPoint, 0, index);
}

function findCycleMessageIds<Message extends ConversationMessageLike>(
  outgoing: ReadonlyArray<ReadonlySet<number>>,
  messages: readonly Message[],
): string[] {
  const indexByNode = new Array<number>(messages.length).fill(-1);
  const lowLinkByNode = new Array<number>(messages.length).fill(-1);
  const onStack = new Array<boolean>(messages.length).fill(false);
  const stack: number[] = [];
  const cycleNodes = new Set<number>();
  let nextIndex = 0;

  const visit = (node: number) => {
    indexByNode[node] = nextIndex;
    lowLinkByNode[node] = nextIndex;
    nextIndex += 1;
    stack.push(node);
    onStack[node] = true;

    for (const target of outgoing[node]!) {
      if (indexByNode[target] === -1) {
        visit(target);
        lowLinkByNode[node] = Math.min(lowLinkByNode[node]!, lowLinkByNode[target]!);
      } else if (onStack[target]) {
        lowLinkByNode[node] = Math.min(lowLinkByNode[node]!, indexByNode[target]!);
      }
    }

    if (lowLinkByNode[node] !== indexByNode[node]) return;
    const component: number[] = [];
    let member: number;
    do {
      member = stack.pop()!;
      onStack[member] = false;
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || outgoing[node]!.has(node)) {
      for (const cycleNode of component) cycleNodes.add(cycleNode);
    }
  };

  for (let node = 0; node < messages.length; node += 1) {
    if (indexByNode[node] === -1) visit(node);
  }
  return [...cycleNodes]
    .sort((left, right) => left - right)
    .map((index) => messages[index]!.id);
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
  if (left.sequence === null || right.sequence === null) {
    if (left.sequence === null && right.sequence === null) return left.id.localeCompare(right.id);
    return left.sequence === null ? 1 : -1;
  }
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function clearProcessedDeliveryState<Message extends ConversationMessageLike>(
  message: Message,
  turn: ConversationTurn | undefined,
): Message {
  if (!turn || turn.status === "queued" || message.metadata?.deliveryState === undefined) {
    return message;
  }
  const { deliveryState: _deliveryState, ...metadata } = message.metadata;
  return { ...message, metadata };
}
