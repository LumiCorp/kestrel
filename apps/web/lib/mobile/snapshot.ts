import "server-only";

import { mobileMessageParts } from "@/lib/mobile/message-parts";
import {
  mobileInteractionDto,
  mobileThreadDtos,
  mobileTurnDto,
} from "@/lib/mobile/dto";
import { getThreadWithMessagesForUser } from "@/lib/threads/store";
import {
  listDurableThreadQueueForUser,
  listThreadInteractionsForUser,
} from "@/lib/turns/store";

type StoredMessage = NonNullable<
  Awaited<ReturnType<typeof getThreadWithMessagesForUser>>
>["messages"][number];

function mobileMessageDto(message: StoredMessage) {
  return {
    id: message.id,
    turnId: message.turnId ?? null,
    role: message.role,
    parts: mobileMessageParts(message.parts),
    createdAt: message.createdAt.toISOString(),
  };
}

export async function getMobileThreadSnapshot(input: {
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  const thread = await getThreadWithMessagesForUser(
    input.threadId,
    input.userId,
    input.organizationId
  );
  if (!thread || thread.mode !== "chat") return null;
  const [queueState, interactions, mobileThreads] = await Promise.all([
    listDurableThreadQueueForUser(input),
    listThreadInteractionsForUser(input),
    mobileThreadDtos([thread]),
  ]);
  const visibleTurns = queueState.turns.filter(
    (turn) => turn.failureCode !== "TURN_REMOVED"
  );
  const latestTurnRevision = visibleTurns.reduce(
    (latest, turn) =>
      turn.updatedAt.getTime() > latest.getTime() ? turn.updatedAt : latest,
    thread.updatedAt
  );
  const latestInteractionRevision = interactions.reduce(
    (latest, interaction) =>
      interaction.updatedAt.getTime() > latest.getTime()
        ? interaction.updatedAt
        : latest,
    latestTurnRevision
  );
  return {
    snapshotVersion: `${latestInteractionRevision.toISOString()}:${queueState.queue.version}`,
    thread: mobileThreads[0],
    messages: thread.messages.map(mobileMessageDto),
    turns: visibleTurns.map(mobileTurnDto),
    queue: {
      state: queueState.queue.state,
      pauseReason: queueState.queue.pauseReason,
      activeTurnId: queueState.queue.activeTurnId,
      version: queueState.queue.version,
      orderedTurnIds: visibleTurns
        .filter((turn) =>
          ["queued", "running", "waiting_for_input"].includes(turn.status)
        )
        .map((turn) => turn.id),
    },
    interactions: interactions
      .filter((interaction) => interaction.status === "pending")
      .map(mobileInteractionDto),
  };
}
