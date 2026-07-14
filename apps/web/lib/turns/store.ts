import "server-only";

import { and, asc, eq, gt, inArray, max, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { DbThreadTurn, DbThreadTurnEvent } from "@/lib/knowledge/db-types";
import {
  assertThreadTurnTransition,
  type ThreadTurnSource,
  type ThreadTurnTerminalStatus,
  terminalQueueOutcome,
} from "@/lib/turns/contracts";

type TurnTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

export class DurableTurnError extends Error {
  readonly code:
    | "TURN_NOT_FOUND"
    | "TURN_FORBIDDEN"
    | "TURN_CONFLICT"
    | "QUEUE_PAUSED"
    | "INVALID_CONTEXT_REVISION";

  constructor(code: DurableTurnError["code"], message: string) {
    super(message);
    this.name = "DurableTurnError";
    this.code = code;
  }
}

function queueLockKey(threadId: string) {
  return `thread-turn-queue:${threadId}`;
}

async function lockAccessibleThread(
  tx: TurnTransaction,
  input: { threadId: string; organizationId: string; userId: string }
) {
  const [thread] = await tx
    .select()
    .from(schema.threads)
    .where(
      and(
        eq(schema.threads.id, input.threadId),
        eq(schema.threads.organizationId, input.organizationId)
      )
    )
    .limit(1)
    .for("update");
  if (!thread || thread.archivedAt) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Thread not found.");
  }
  if (!thread.projectId) {
    if (thread.createdByUserId !== input.userId) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Thread not found.");
    }
    return thread;
  }
  const [membership] = await tx
    .select({ id: schema.members.id })
    .from(schema.members)
    .innerJoin(
      schema.projectMembers,
      and(
        eq(schema.projectMembers.organizationMemberId, schema.members.id),
        eq(schema.projectMembers.projectId, thread.projectId)
      )
    )
    .where(
      and(
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId)
      )
    )
    .limit(1);
  if (!membership) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Thread not found.");
  }
  return thread;
}

function extractSearchText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractSearchText).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
  }
  return "";
}

async function appendTurnEvent(
  tx: TurnTransaction,
  input: { turnId: string; type: string; data?: unknown }
): Promise<DbThreadTurnEvent> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`thread-turn-events:${input.turnId}`}, 0))`
  );
  const [latest] = await tx
    .select({ sequence: max(schema.threadTurnEvents.sequence) })
    .from(schema.threadTurnEvents)
    .where(eq(schema.threadTurnEvents.turnId, input.turnId));
  const [event] = await tx
    .insert(schema.threadTurnEvents)
    .values({
      id: crypto.randomUUID(),
      turnId: input.turnId,
      sequence: (latest?.sequence ?? 0) + 1,
      type: input.type,
      data: input.data ?? null,
    })
    .returning();
  if (!event) {
    throw new Error("Durable turn event insert failed.");
  }
  return event;
}

async function findNextQueuedTurn(
  tx: TurnTransaction,
  threadId: string
): Promise<DbThreadTurn | null> {
  const [turn] = await tx
    .select()
    .from(schema.threadTurns)
    .where(
      and(
        eq(schema.threadTurns.threadId, threadId),
        eq(schema.threadTurns.status, "queued")
      )
    )
    .orderBy(asc(schema.threadTurns.sequence))
    .limit(1);
  return turn ?? null;
}

type DurableThreadTurnInput = {
  threadId: string;
  organizationId: string;
  authorUserId: string;
  idempotencyKey: string;
  requestedEnvironmentId: string;
  projectContextRevisionId?: string | null;
  requestedModelId?: string | null;
  source: ThreadTurnSource;
} & (
  | {
      messageId: string;
      messageParts: unknown;
      approvalDecision?: undefined;
    }
  | {
      messageId?: null;
      messageParts?: undefined;
      approvalDecision: {
        approvalId: string;
        approved: boolean;
        reason?: string | undefined;
      };
    }
);

export async function createDurableThreadTurn(input: DurableThreadTurnInput) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`
    );
    const thread = await lockAccessibleThread(tx, {
      threadId: input.threadId,
      organizationId: input.organizationId,
      userId: input.authorUserId,
    });
    const [existing] = await tx
      .select()
      .from(schema.threadTurns)
      .where(
        and(
          eq(schema.threadTurns.threadId, input.threadId),
          eq(schema.threadTurns.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1);
    if (existing) {
      const queueState = await tx.query.threadTurnQueueState.findFirst({
        where: eq(schema.threadTurnQueueState.threadId, input.threadId),
      });
      return {
        turn: existing,
        created: false,
        shouldDispatch:
          existing.status === "queued" &&
          queueState?.state === "running" &&
          queueState.activeTurnId === existing.id,
      };
    }
    if (input.projectContextRevisionId) {
      const [revision] = await tx
        .select({ projectId: schema.projectContextRevisions.projectId })
        .from(schema.projectContextRevisions)
        .where(
          eq(schema.projectContextRevisions.id, input.projectContextRevisionId)
        )
        .limit(1);
      if (!(revision && revision.projectId === thread.projectId)) {
        throw new DurableTurnError(
          "INVALID_CONTEXT_REVISION",
          "Project context revision does not belong to this Thread."
        );
      }
    } else if (thread.projectId) {
      throw new DurableTurnError(
        "INVALID_CONTEXT_REVISION",
        "Project Threads require a bound context revision."
      );
    }

    if (input.messageId) {
      const [messageConflict] = await tx
        .select({ id: schema.threadTurns.id })
        .from(schema.threadTurns)
        .where(eq(schema.threadTurns.inputMessageId, input.messageId))
        .limit(1);
      if (messageConflict) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The input message is already bound to another turn."
        );
      }
    }

    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId))
      .limit(1)
      .for("update");
    const sequence = queueState?.nextSequence ?? 1;
    const turnId = crypto.randomUUID();
    const now = new Date();
    if (input.messageId) {
      const [insertedMessage] = await tx
        .insert(schema.threadMessages)
        .values({
          id: input.messageId,
          threadId: input.threadId,
          role: "user",
          authorUserId: input.authorUserId,
          projectContextRevisionId: input.projectContextRevisionId ?? null,
          parts: input.messageParts,
          searchText: extractSearchText(input.messageParts),
          source: input.source,
          createdAt: now,
        })
        .onConflictDoNothing({ target: schema.threadMessages.id })
        .returning({ id: schema.threadMessages.id });
      if (!insertedMessage) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The input message ID is already in use."
        );
      }
    }
    const [turn] = await tx
      .insert(schema.threadTurns)
      .values({
        id: turnId,
        organizationId: input.organizationId,
        threadId: input.threadId,
        authorUserId: input.authorUserId,
        inputMessageId: input.messageId ?? null,
        approvalId: input.approvalDecision?.approvalId ?? null,
        approvalApproved: input.approvalDecision?.approved ?? null,
        approvalReason: input.approvalDecision?.reason ?? null,
        projectContextRevisionId: input.projectContextRevisionId ?? null,
        requestedEnvironmentId: input.requestedEnvironmentId,
        idempotencyKey: input.idempotencyKey,
        sequence,
        source: input.source,
        requestedModelId: input.requestedModelId ?? null,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!turn) {
      throw new Error("Durable turn insert failed.");
    }
    if (input.messageId) {
      await tx
        .update(schema.threadMessages)
        .set({ turnId })
        .where(
          and(
            eq(schema.threadMessages.id, input.messageId),
            eq(schema.threadMessages.threadId, input.threadId)
          )
        );
    }
    await appendTurnEvent(tx, {
      turnId,
      type: "turn.queued",
      data: { status: "queued", sequence },
    });
    const shouldDispatch =
      (!queueState || queueState.state === "running") &&
      !queueState?.activeTurnId;
    await tx
      .insert(schema.threadTurnQueueState)
      .values({
        threadId: input.threadId,
        activeTurnId: shouldDispatch
          ? turnId
          : (queueState?.activeTurnId ?? null),
        nextSequence: sequence + 1,
        state: queueState?.state ?? "running",
        pauseReason: queueState?.pauseReason ?? null,
        version: (queueState?.version ?? 0) + 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.threadTurnQueueState.threadId,
        set: {
          activeTurnId: shouldDispatch
            ? turnId
            : (queueState?.activeTurnId ?? null),
          nextSequence: sequence + 1,
          version: (queueState?.version ?? 0) + 1,
          updatedAt: now,
        },
      });
    await tx
      .update(schema.threads)
      .set({ updatedAt: now })
      .where(eq(schema.threads.id, input.threadId));
    return { turn, created: true, shouldDispatch };
  });
}

export async function claimDurableThreadTurn(turnId: string) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, turnId))
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`
    );
    await lockAccessibleThread(tx, {
      threadId: candidate.threadId,
      organizationId: candidate.organizationId,
      userId: candidate.authorUserId,
    });
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, turnId))
      .limit(1)
      .for("update");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, candidate.threadId))
      .limit(1)
      .for("update");
    if (
      !turn ||
      turn.status !== "queued" ||
      queueState?.state !== "running" ||
      queueState.activeTurnId !== turn.id
    ) {
      return null;
    }
    assertThreadTurnTransition(turn.status, "running");
    const now = new Date();
    const [running] = await tx
      .update(schema.threadTurns)
      .set({ status: "running", startedAt: now, updatedAt: now })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "turn.running",
      data: { status: "running" },
    });
    return running ?? null;
  });
}

export async function completeDurableThreadTurn(input: {
  turnId: string;
  status: ThreadTurnTerminalStatus;
  failureCode?: string | null;
  failureMessage?: string | null;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`
    );
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    if (!turn) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    if (["completed", "failed", "cancelled"].includes(turn.status)) {
      return { turn, nextTurnId: null };
    }
    assertThreadTurnTransition(turn.status, input.status);
    const outcome = terminalQueueOutcome(input.status);
    const now = new Date();
    const [terminal] = await tx
      .update(schema.threadTurns)
      .set({
        status: input.status,
        failureCode: input.failureCode ?? null,
        failureMessage: input.failureMessage ?? null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: `turn.${input.status}`,
      data: {
        status: input.status,
        failureCode: input.failureCode ?? null,
      },
    });
    const devices = await tx
      .select({ id: schema.mobileDeviceRegistrations.id })
      .from(schema.mobileDeviceRegistrations)
      .where(
        and(
          eq(schema.mobileDeviceRegistrations.userId, turn.authorUserId),
          eq(schema.mobileDeviceRegistrations.enabled, true)
        )
      );
    if (devices.length > 0) {
      const kind: "completed" | "failed" =
        input.status === "completed" ? "completed" : "failed";
      await tx
        .insert(schema.mobilePushDeliveries)
        .values(
          devices.map((device) => ({
            id: crypto.randomUUID(),
            deviceRegistrationId: device.id,
            organizationId: turn.organizationId,
            threadId: turn.threadId,
            turnId: turn.id,
            kind,
            status: "pending" as const,
          }))
        )
        .onConflictDoNothing({
          target: [
            schema.mobilePushDeliveries.turnId,
            schema.mobilePushDeliveries.deviceRegistrationId,
            schema.mobilePushDeliveries.kind,
          ],
        });
    }
    const next = outcome.dispatchNext
      ? await findNextQueuedTurn(tx, turn.threadId)
      : null;
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId))
      .limit(1)
      .for("update");
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        activeTurnId: next?.id ?? null,
        state: outcome.state,
        pauseReason: outcome.pauseReason,
        version: (queueState?.version ?? 0) + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    return { turn: terminal ?? turn, nextTurnId: next?.id ?? null };
  });
}

export async function listDurableTurnEvents(input: {
  turnId: string;
  afterSequence?: number;
  limit?: number;
}) {
  return knowledgeDb
    .select()
    .from(schema.threadTurnEvents)
    .where(
      and(
        eq(schema.threadTurnEvents.turnId, input.turnId),
        gt(schema.threadTurnEvents.sequence, input.afterSequence ?? 0)
      )
    )
    .orderBy(asc(schema.threadTurnEvents.sequence))
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 500));
}

export async function appendDurableTurnEvent(input: {
  turnId: string;
  type: string;
  data?: unknown;
}) {
  return knowledgeDb.transaction((tx) => appendTurnEvent(tx, input));
}

export async function bindDurableTurnExecution(input: {
  turnId: string;
  executionId: string;
}) {
  const [turn] = await knowledgeDb
    .update(schema.threadTurns)
    .set({
      environmentExecutionId: input.executionId,
      updatedAt: new Date(),
    })
    .where(eq(schema.threadTurns.id, input.turnId))
    .returning();
  return turn ?? null;
}

export async function isDurableTurnCancellationRequested(turnId: string) {
  const turn = await knowledgeDb.query.threadTurns.findFirst({
    where: eq(schema.threadTurns.id, turnId),
    columns: { cancelRequestedAt: true },
  });
  return Boolean(turn?.cancelRequestedAt);
}

export async function listMessagesForDurableTurn(turnId: string) {
  const turn = await knowledgeDb.query.threadTurns.findFirst({
    where: eq(schema.threadTurns.id, turnId),
  });
  if (!turn) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
  }
  const priorTurnIds = knowledgeDb
    .select({ id: schema.threadTurns.id })
    .from(schema.threadTurns)
    .where(
      and(
        eq(schema.threadTurns.threadId, turn.threadId),
        sql`${schema.threadTurns.sequence} <= ${turn.sequence}`
      )
    );
  return knowledgeDb
    .select()
    .from(schema.threadMessages)
    .where(
      and(
        eq(schema.threadMessages.threadId, turn.threadId),
        sql`(
          ${schema.threadMessages.turnId} IN (${priorTurnIds})
          OR (
            ${schema.threadMessages.turnId} IS NULL
            AND ${schema.threadMessages.createdAt} <= ${turn.createdAt}
          )
        )`
      )
    )
    .orderBy(
      asc(schema.threadMessages.createdAt),
      asc(schema.threadMessages.id)
    );
}

export async function getDurableTurnForUser(input: {
  turnId: string;
  organizationId: string;
  userId: string;
}) {
  const turn = await knowledgeDb.query.threadTurns.findFirst({
    where: and(
      eq(schema.threadTurns.id, input.turnId),
      eq(schema.threadTurns.organizationId, input.organizationId)
    ),
  });
  if (!turn) {
    return null;
  }
  return knowledgeDb.transaction(async (tx) => {
    await lockAccessibleThread(tx, {
      threadId: turn.threadId,
      organizationId: input.organizationId,
      userId: input.userId,
    });
    return turn;
  });
}

export async function listDurableThreadQueueForUser(input: {
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await lockAccessibleThread(tx, input);
    const [turns, queueState] = await Promise.all([
      tx
        .select()
        .from(schema.threadTurns)
        .where(
          and(
            eq(schema.threadTurns.threadId, input.threadId),
            inArray(schema.threadTurns.status, [
              "queued",
              "running",
              "waiting_for_input",
            ])
          )
        )
        .orderBy(asc(schema.threadTurns.sequence)),
      tx.query.threadTurnQueueState.findFirst({
        where: eq(schema.threadTurnQueueState.threadId, input.threadId),
      }),
    ]);
    return {
      turns,
      queue: {
        state: queueState?.state ?? "running",
        pauseReason: queueState?.pauseReason ?? null,
      },
    };
  });
}

export async function getDurableTurn(turnId: string) {
  return (
    (await knowledgeDb.query.threadTurns.findFirst({
      where: eq(schema.threadTurns.id, turnId),
    })) ?? null
  );
}

export async function getActiveDurableTurnForThread(threadId: string) {
  const [active] = await knowledgeDb
    .select({ turn: schema.threadTurns })
    .from(schema.threadTurnQueueState)
    .innerJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.threadTurnQueueState.activeTurnId)
    )
    .where(eq(schema.threadTurnQueueState.threadId, threadId))
    .limit(1);
  return active?.turn ?? null;
}

export async function requestDurableTurnStop(input: {
  turnId: string;
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(
        and(
          eq(schema.threadTurns.id, input.turnId),
          eq(schema.threadTurns.organizationId, input.organizationId)
        )
      )
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`
    );
    await lockAccessibleThread(tx, {
      threadId: candidate.threadId,
      organizationId: input.organizationId,
      userId: input.userId,
    });
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, candidate.threadId))
      .limit(1)
      .for("update");
    if (
      !(
        turn && ["queued", "running", "waiting_for_input"].includes(turn.status)
      ) ||
      queueState?.activeTurnId !== turn.id
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Only an active turn can be stopped."
      );
    }
    if (turn.cancelRequestedAt) {
      return turn;
    }
    const now = new Date();
    if (turn.status === "queued") {
      assertThreadTurnTransition("queued", "cancelled");
      const [cancelled] = await tx
        .update(schema.threadTurns)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          failureCode: "TURN_STOPPED",
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.threadTurns.id, turn.id))
        .returning();
      await tx
        .update(schema.threadTurnQueueState)
        .set({
          activeTurnId: null,
          state: "paused",
          pauseReason: "turn_cancelled",
          version: (queueState?.version ?? 0) + 1,
          updatedAt: now,
        })
        .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
      await appendTurnEvent(tx, {
        turnId: turn.id,
        type: "turn.cancelled",
        data: { status: "cancelled", requestedByUserId: input.userId },
      });
      return cancelled ?? turn;
    }
    const [updated] = await tx
      .update(schema.threadTurns)
      .set({ cancelRequestedAt: now, updatedAt: now })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "turn.stop_requested",
      data: { requestedByUserId: input.userId },
    });
    return updated ?? turn;
  });
}

export async function removeQueuedDurableTurn(input: {
  turnId: string;
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(
        and(
          eq(schema.threadTurns.id, input.turnId),
          eq(schema.threadTurns.organizationId, input.organizationId)
        )
      )
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`
    );
    await lockAccessibleThread(tx, {
      threadId: candidate.threadId,
      organizationId: input.organizationId,
      userId: input.userId,
    });
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    if (!(turn && turn.status === "queued")) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Only a queued turn can be removed."
      );
    }
    if (turn.authorUserId !== input.userId) {
      throw new DurableTurnError(
        "TURN_FORBIDDEN",
        "Only the queued turn author can remove it."
      );
    }
    assertThreadTurnTransition("queued", "cancelled");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId))
      .limit(1)
      .for("update");
    const now = new Date();
    const [removed] = await tx
      .update(schema.threadTurns)
      .set({
        status: "cancelled",
        failureCode: "TURN_REMOVED",
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "turn.removed",
      data: { removedByUserId: input.userId },
    });
    const removedActiveTurn = queueState?.activeTurnId === turn.id;
    const next = removedActiveTurn
      ? await findNextQueuedTurn(tx, turn.threadId)
      : null;
    if (queueState && removedActiveTurn) {
      await tx
        .update(schema.threadTurnQueueState)
        .set({
          activeTurnId: next?.id ?? null,
          version: queueState.version + 1,
          updatedAt: now,
        })
        .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    }
    return { turn: removed ?? turn, nextTurnId: next?.id ?? null };
  });
}

export async function resumeDurableThreadQueue(input: {
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`
    );
    await lockAccessibleThread(tx, input);
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId))
      .limit(1)
      .for("update");
    if (!queueState) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn queue not found.");
    }
    if (queueState.activeTurnId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Thread already has an active turn."
      );
    }
    const next = await findNextQueuedTurn(tx, input.threadId);
    const now = new Date();
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        activeTurnId: next?.id ?? null,
        state: "running",
        pauseReason: null,
        version: queueState.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId));
    return { nextTurnId: next?.id ?? null };
  });
}

export async function syncDurableTurnInteractionState(input: {
  turnId: string;
  waiting: boolean;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1);
    if (!candidate) {
      return null;
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`
    );
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, candidate.id))
      .limit(1)
      .for("update");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, candidate.threadId))
      .limit(1)
      .for("update");
    if (!(turn && queueState?.activeTurnId === turn.id)) {
      return null;
    }
    const targetStatus = input.waiting ? "waiting_for_input" : "running";
    if (turn.status === targetStatus) {
      return turn;
    }
    if (
      (input.waiting && turn.status !== "running") ||
      (!input.waiting && turn.status !== "waiting_for_input")
    ) {
      return null;
    }
    assertThreadTurnTransition(turn.status, targetStatus);
    const now = new Date();
    const [updated] = await tx
      .update(schema.threadTurns)
      .set({ status: targetStatus, updatedAt: now })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        state: input.waiting ? "paused" : "running",
        pauseReason: input.waiting ? "interaction_required" : null,
        version: queueState.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: input.waiting ? "interaction.required" : "interaction.resolved",
      data: { status: targetStatus },
    });
    if (input.waiting) {
      const devices = await tx
        .select({ id: schema.mobileDeviceRegistrations.id })
        .from(schema.mobileDeviceRegistrations)
        .where(
          and(
            eq(schema.mobileDeviceRegistrations.userId, turn.authorUserId),
            eq(schema.mobileDeviceRegistrations.enabled, true)
          )
        );
      if (devices.length > 0) {
        await tx
          .insert(schema.mobilePushDeliveries)
          .values(
            devices.map((device) => ({
              id: crypto.randomUUID(),
              deviceRegistrationId: device.id,
              organizationId: turn.organizationId,
              threadId: turn.threadId,
              turnId: turn.id,
              kind: "attention" as const,
              status: "pending" as const,
            }))
          )
          .onConflictDoNothing({
            target: [
              schema.mobilePushDeliveries.turnId,
              schema.mobilePushDeliveries.deviceRegistrationId,
              schema.mobilePushDeliveries.kind,
            ],
          });
      }
    }
    return updated ?? turn;
  });
}
