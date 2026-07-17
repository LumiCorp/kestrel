import "server-only";

import { eq, inArray } from "drizzle-orm";
import {
  mobileMessageParts,
  mobileV2DurablePartTypes,
} from "@/lib/mobile/message-parts";
import {
  mobileInteractionDto,
  mobileThreadDtos,
  mobileTurnDto,
} from "@/lib/mobile/dto";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  listDurableThreadQueueForUser,
  listThreadInteractionsForUser,
} from "@/lib/turns/store";
import { getMobileV2MessageWindow, getMobileV2ReadState } from "./store";

function messageDto(message: typeof schema.threadMessages.$inferSelect) {
  return {
    id: message.id,
    turnId: message.turnId ?? null,
    sourceMessageId: message.sourceMessageId ?? null,
    role: message.role,
    parts: mobileMessageParts(message.parts).filter((part) =>
      mobileV2DurablePartTypes.has(part.type)
    ),
    createdAt: message.createdAt.toISOString(),
  };
}

export async function getMobileV2ThreadSnapshot(input: {
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  const thread = await knowledgeDb.query.threads.findFirst({
    where: eq(schema.threads.id, input.threadId),
  });
  if (!thread || thread.mode !== "chat") return null;

  const [queueState, interactions, readState, mobileThreads, parentThread] =
    await Promise.all([
      listDurableThreadQueueForUser(input),
      listThreadInteractionsForUser(input),
      getMobileV2ReadState(input),
      mobileThreadDtos([thread]),
      thread.parentThreadId
        ? knowledgeDb.query.threads.findFirst({
            where: eq(schema.threads.id, thread.parentThreadId),
          })
        : Promise.resolve(undefined),
    ]);
  const visibleTurns = queueState.turns.filter(
    (turn) => turn.failureCode !== "TURN_REMOVED"
  );
  const presentations = visibleTurns.length
    ? await knowledgeDb
        .select()
        .from(schema.threadTurnPresentations)
        .where(
          inArray(
            schema.threadTurnPresentations.turnId,
            visibleTurns.map((turn) => turn.id)
          )
        )
    : [];
  const presentationByTurn = new Map(
    presentations.map((presentation) => [presentation.turnId, presentation])
  );
  // A waiting persistence transaction publishes its assistant message, turn state,
  // and interaction together. Read the message window after the durable state so a
  // snapshot cannot report a waiting turn while retaining a pre-commit window.
  // The window lookup also enforces the thread access boundary before we return it.
  const window = await getMobileV2MessageWindow(input);
  if (!window) return null;
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
  const latestReadRevision = readState?.updatedAt
    ? new Date(readState.updatedAt)
    : latestInteractionRevision;

  return {
    snapshotVersion: `${latestReadRevision.toISOString()}:${queueState.queue.version}`,
    thread: {
      ...mobileThreads[0],
      lineage: thread.parentThreadId
        ? {
            parentThreadId: thread.parentThreadId,
            parentTitle: parentThread?.title || "Conversation",
            anchorMessageId: thread.branchAnchorMessageId,
          }
        : null,
    },
    messageWindow: {
      items: window.messages.map(messageDto),
      nextCursor: window.nextCursor,
    },
    turns: visibleTurns.map((turn) => {
      const presentation = presentationByTurn.get(turn.id);
      return {
        ...mobileTurnDto(turn),
        queueOrdinal: turn.queueOrdinal,
        outputMessageId: turn.outputMessageId,
        activity: {
          stage: presentation?.stage ?? (turn.status === "queued" ? "queued" : "working"),
          milestones: presentation?.milestones ?? [],
          updatedAt: (presentation?.updatedAt ?? turn.updatedAt).toISOString(),
        },
      };
    }),
    queue: {
      state: queueState.queue.state,
      pauseReason: queueState.queue.pauseReason,
      activeTurnId: queueState.queue.activeTurnId,
      version: queueState.queue.version,
      orderedQueuedTurnIds: visibleTurns
        .filter((turn) => turn.status === "queued")
        .sort((a, b) => a.queueOrdinal - b.queueOrdinal)
        .map((turn) => turn.id),
    },
    interactions: interactions
      .filter((interaction) => interaction.status === "pending")
      .flatMap((interaction) => {
        const turnId = interaction.turnId ?? queueState.queue.activeTurnId;
        return turnId ? [{ ...mobileInteractionDto(interaction), turnId }] : [];
      }),
    readState,
  };
}
