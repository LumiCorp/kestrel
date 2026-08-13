import type { ChatMessage } from "@/lib/types";
import type { ThreadTurnView } from "@/lib/turns/client-contract";

const AUTHORITATIVE_PERSISTED_TURN_STATUSES = new Set<
  ThreadTurnView["status"]
>(["waiting_for_input", "completed", "failed", "cancelled"]);

export function reconcileConversationMessages(input: {
  persistedMessages: ChatMessage[];
  liveMessages: ChatMessage[];
  turns: ThreadTurnView[];
}): ChatMessage[] {
  const turnStatusById = new Map(
    input.turns.map((turn) => [turn.id, turn.status]),
  );
  const liveById = new Map(
    input.liveMessages.map((message) => [message.id, message]),
  );
  const persistedIds = new Set(
    input.persistedMessages.map((message) => message.id),
  );

  const reconciled = input.persistedMessages.map((persisted) => {
    const live = liveById.get(persisted.id);
    if (!live) return persisted;
    const turnId = persisted.metadata?.kestrelTurnId;
    const turnStatus = turnId ? turnStatusById.get(turnId) : undefined;
    return turnStatus === "running" ? live : persisted;
  });

  for (const live of input.liveMessages) {
    if (persistedIds.has(live.id)) continue;
    const turnId = live.metadata?.kestrelTurnId;
    const turnStatus = turnId ? turnStatusById.get(turnId) : undefined;
    if (
      turnStatus !== undefined &&
      AUTHORITATIVE_PERSISTED_TURN_STATUSES.has(turnStatus)
    ) {
      continue;
    }
    reconciled.push(live);
  }
  return reconciled;
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
