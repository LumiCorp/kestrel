import "server-only";

import type { KestrelInteractionPresentation } from "@kestrel-agents/ai-sdk";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { DbThreadTurn, DbThreadTurnEvent } from "@/lib/knowledge/db-types";
import {
  type MobileActivityStage,
  mobileActivity,
  mobileActivityForStage,
} from "@/lib/mobile/activity";
import {
  assertThreadTurnTransition,
  type ThreadTurnSource,
  type ThreadTurnTerminalStatus,
  terminalQueueOutcome,
} from "@/lib/turns/contracts";
import type { KestrelOneInteractionMode } from "@/lib/turns/interaction-mode";

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

type MobileActivityMilestone = {
  id: string;
  kind:
    | "accepted"
    | "started"
    | "context_ready"
    | "capability_used"
    | "response_started"
    | "waiting"
    | "retrying"
    | "completed";
  createdAt: string;
};

const milestoneForStage: Record<
  MobileActivityStage,
  MobileActivityMilestone["kind"]
> = {
  queued: "accepted",
  preparing: "started",
  reading_context: "context_ready",
  working: "response_started",
  using_capability: "capability_used",
  finalizing: "completed",
  waiting: "waiting",
  retrying: "retrying",
};

function mobileActivityMilestones(value: unknown): MobileActivityMilestone[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MobileActivityMilestone[] => {
    if (!(entry && typeof entry === "object")) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.id === "string" &&
      typeof record.kind === "string" &&
      typeof record.createdAt === "string"
      ? [record as MobileActivityMilestone]
      : [];
  });
}

async function updateMobileTurnPresentation(
  tx: TurnTransaction,
  input: {
    turnId: string;
    stage: MobileActivityStage;
    now: Date;
    milestoneId?: string;
  }
) {
  const existing = await tx.query.threadTurnPresentations.findFirst({
    where: eq(schema.threadTurnPresentations.turnId, input.turnId),
  });
  const milestone = {
    id: input.milestoneId ?? crypto.randomUUID(),
    kind: milestoneForStage[input.stage],
    createdAt: input.now.toISOString(),
  } satisfies MobileActivityMilestone;
  const existingMilestones = mobileActivityMilestones(existing?.milestones);
  const shouldAppendMilestone =
    existing?.stage !== input.stage &&
    !existingMilestones.some((entry) => entry.id === milestone.id);
  const milestones = (
    shouldAppendMilestone
      ? [...existingMilestones, milestone]
      : existingMilestones
  ).slice(-8);
  await tx
    .insert(schema.threadTurnPresentations)
    .values({
      turnId: input.turnId,
      stage: input.stage,
      milestones,
      startedAt: existing?.startedAt ?? input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: schema.threadTurnPresentations.turnId,
      set: { stage: input.stage, milestones, updatedAt: input.now },
    });
  return existing?.stage !== input.stage;
}

export async function recordMobileTurnRuntimeActivity(input: {
  turnId: string;
  eventId: string;
  eventType: string;
  progressCode?: string;
}) {
  const activity = mobileActivity({
    kind: "runtime_event",
    eventType: input.eventType,
    code: input.progressCode,
  });
  if (!activity) return;
  await knowledgeDb.transaction(async (tx) => {
    const changed = await updateMobileTurnPresentation(tx, {
      turnId: input.turnId,
      stage: activity.stage,
      now: new Date(),
      milestoneId: input.eventId,
    });
    if (changed) {
      await appendTurnEvent(tx, {
        turnId: input.turnId,
        type: "turn.activity",
        data: activity,
      });
    }
  });
}

export async function recordMobileTurnActivity(input: {
  turnId: string;
  stage: MobileActivityStage;
  milestoneId: string;
}) {
  const activity = mobileActivityForStage(input.stage);
  await knowledgeDb.transaction(async (tx) => {
    const changed = await updateMobileTurnPresentation(tx, {
      turnId: input.turnId,
      stage: input.stage,
      now: new Date(),
      milestoneId: input.milestoneId,
    });
    if (changed) {
      await appendTurnEvent(tx, {
        turnId: input.turnId,
        type: "turn.activity",
        data: activity,
      });
    }
  });
}

function queueLockKey(threadId: string) {
  return `thread-turn-queue:${threadId}`;
}

async function lockAccessibleThread(
  tx: TurnTransaction,
  input: {
    threadId: string;
    organizationId: string;
    userId: string;
    includeArchived?: boolean;
  }
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
  if (!thread || (thread.archivedAt && !input.includeArchived)) {
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
    .orderBy(asc(schema.threadTurns.queueOrdinal))
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
  requestedInteractionMode?: KestrelOneInteractionMode;
  source: ThreadTurnSource;
} & (
  | {
      messageId: string;
      messageParts: unknown;
      sourceMessageId?: string | null;
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
  return knowledgeDb.transaction((tx) =>
    createDurableThreadTurnInTransaction(tx, input)
  );
}

async function createDurableThreadTurnInTransaction(
  tx: TurnTransaction,
  input: DurableThreadTurnInput
) {
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
    const shouldDispatch =
      existing.status === "queued" &&
      queueState?.state === "running" &&
      queueState.activeTurnId === existing.id;
    return {
      turn: existing,
      created: false,
      shouldDispatch,
      dispatchTurnId: shouldDispatch ? existing.id : null,
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
    if (input.sourceMessageId) {
      const [sourceMessage] = await tx
        .select({
          id: schema.threadMessages.id,
          sourceMessageId: schema.threadMessages.sourceMessageId,
        })
        .from(schema.threadMessages)
        .where(
          and(
            eq(schema.threadMessages.id, input.sourceMessageId),
            eq(schema.threadMessages.threadId, input.threadId),
            eq(schema.threadMessages.role, "user")
          )
        )
        .limit(1);
      if (
        !sourceMessage ||
        (sourceMessage.sourceMessageId &&
          sourceMessage.sourceMessageId !== sourceMessage.id)
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The retry source message is unavailable."
        );
      }
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
        sourceMessageId: input.sourceMessageId ?? null,
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
      queueOrdinal: sequence,
      source: input.source,
      requestedModelId: input.requestedModelId ?? null,
      requestedInteractionMode: input.requestedInteractionMode ?? "chat",
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!turn) {
    throw new Error("Durable turn insert failed.");
  }
  await updateMobileTurnPresentation(tx, { turnId, stage: "queued", now });
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
  const resumesTerminallyPausedQueue = Boolean(
    input.messageId &&
      queueState?.state === "paused" &&
      (queueState.pauseReason === "turn_failed" ||
        queueState.pauseReason === "turn_cancelled") &&
      !queueState.activeTurnId
  );
  const dispatchTurnId =
    (!queueState || queueState.state === "running") && !queueState?.activeTurnId
      ? turnId
      : resumesTerminallyPausedQueue
        ? ((await findNextQueuedTurn(tx, input.threadId))?.id ?? null)
        : null;
  const shouldDispatch = dispatchTurnId !== null;
  const nextQueueState = resumesTerminallyPausedQueue
    ? "running"
    : (queueState?.state ?? "running");
  const nextPauseReason = resumesTerminallyPausedQueue
    ? null
    : (queueState?.pauseReason ?? null);
  await tx
    .insert(schema.threadTurnQueueState)
    .values({
      threadId: input.threadId,
      activeTurnId: dispatchTurnId ?? queueState?.activeTurnId ?? null,
      nextSequence: sequence + 1,
      state: nextQueueState,
      pauseReason: nextPauseReason,
      version: (queueState?.version ?? 0) + 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.threadTurnQueueState.threadId,
      set: {
        activeTurnId: dispatchTurnId ?? queueState?.activeTurnId ?? null,
        nextSequence: sequence + 1,
        state: nextQueueState,
        pauseReason: nextPauseReason,
        version: (queueState?.version ?? 0) + 1,
        updatedAt: now,
      },
    });
  await tx
    .update(schema.threads)
    .set({ updatedAt: now })
    .where(eq(schema.threads.id, input.threadId));
  return { turn, created: true, shouldDispatch, dispatchTurnId };
}

export async function createMobileThreadWithFirstTurn(
  input: DurableThreadTurnInput & { projectId: string | null }
) {
  return runMobileThreadTransaction(async (tx) => {
    const existing = await tx.query.threads.findFirst({
      where: eq(schema.threads.id, input.threadId),
    });
    if (existing) {
      if (
        existing.origin !== "mobile" ||
        existing.mode !== "chat" ||
        existing.projectId !== input.projectId
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The Thread ID is already in use."
        );
      }
    } else {
      const now = new Date();
      const [thread] = await tx
        .insert(schema.threads)
        .values({
          id: input.threadId,
          createdByUserId: input.authorUserId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          mode: "chat",
          origin: "mobile",
          activeStreamId: null,
          title: "",
          isPublic: false,
          shareToken: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!thread) {
        throw new Error("Thread creation failed.");
      }
      if (input.projectId) {
        await tx.insert(schema.projectAuditEvents).values({
          id: crypto.randomUUID(),
          projectId: input.projectId,
          actorUserId: input.authorUserId,
          action: "thread.created",
          targetType: "thread",
          targetId: input.threadId,
          createdAt: now,
        });
      }
    }
    return createDurableThreadTurnInTransaction(tx, input);
  });
}

async function runMobileThreadTransaction<T>(
  callback: (tx: TurnTransaction) => Promise<T>
): Promise<T> {
  return knowledgeDb.transaction(callback);
}

function branchMessageParts(value: unknown) {
  if (!Array.isArray(value)) return [];
  const durableTypes = new Set([
    "text",
    "source-url",
    "source-document",
    "data-kestrel-citation",
    "data-kestrel-artifact",
  ]);
  return value.filter((part) => {
    if (!(part && typeof part === "object" && !Array.isArray(part))) return false;
    const type = (part as Record<string, unknown>).type;
    return typeof type === "string" && durableTypes.has(type);
  });
}

export async function createMobileThreadBranchWithFirstTurn(
  input: DurableThreadTurnInput & {
    projectId: string | null;
    parentThreadId: string;
    anchorMessageId: string;
  }
) {
  return knowledgeDb.transaction(async (tx) => {
    const parent = await lockAccessibleThread(tx, {
      threadId: input.parentThreadId,
      organizationId: input.organizationId,
      userId: input.authorUserId,
    });
    if (parent.mode !== "chat" || parent.projectId !== input.projectId) {
      throw new DurableTurnError("TURN_CONFLICT", "Branch context changed.");
    }
    const [anchor] = await tx
      .select()
      .from(schema.threadMessages)
      .where(
        and(
          eq(schema.threadMessages.id, input.anchorMessageId),
          eq(schema.threadMessages.threadId, input.parentThreadId)
        )
      )
      .limit(1);
    if (!anchor) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Branch anchor not found.");
    }
    const existing = await tx.query.threads.findFirst({
      where: eq(schema.threads.id, input.threadId),
    });
    if (existing) {
      if (
        existing.origin !== "mobile" ||
        existing.mode !== "chat" ||
        existing.parentThreadId !== input.parentThreadId ||
        existing.branchAnchorMessageId !== input.anchorMessageId
      ) {
        throw new DurableTurnError("TURN_CONFLICT", "The Thread ID is already in use.");
      }
      return createDurableThreadTurnInTransaction(tx, input);
    }

    const now = new Date();
    const [thread] = await tx
      .insert(schema.threads)
      .values({
        id: input.threadId,
        createdByUserId: input.authorUserId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        branchAnchorMessageId: input.anchorMessageId,
        mode: "chat",
        origin: "mobile",
        activeStreamId: null,
        title: "",
        isPublic: false,
        shareToken: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!thread) throw new Error("Branch creation failed.");

    const prefix = await tx
      .select()
      .from(schema.threadMessages)
      .where(
        and(
          eq(schema.threadMessages.threadId, input.parentThreadId),
          or(
            lt(schema.threadMessages.createdAt, anchor.createdAt),
            and(
              eq(schema.threadMessages.createdAt, anchor.createdAt),
              lte(schema.threadMessages.id, anchor.id)
            )
          )
        )
      )
      .orderBy(asc(schema.threadMessages.createdAt), asc(schema.threadMessages.id));
    if (prefix.length > 0) {
      await tx.insert(schema.threadMessages).values(
        prefix.map((message) => ({
          id: crypto.randomUUID(),
          threadId: input.threadId,
          turnId: null,
          role: message.role,
          authorUserId: message.authorUserId,
          projectContextRevisionId: message.projectContextRevisionId,
          parts: branchMessageParts(message.parts),
          searchText: message.searchText,
          source: "mobile" as const,
          sourceMessageId: message.id,
          createdAt: message.createdAt,
        }))
      );
    }
    if (input.projectId) {
      await tx.insert(schema.projectAuditEvents).values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        actorUserId: input.authorUserId,
        action: "thread.created",
        targetType: "thread",
        targetId: input.threadId,
        createdAt: now,
      });
    }
    return createDurableThreadTurnInTransaction(tx, input);
  });
}

export async function reorderDurableThreadQueue(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  expectedVersion: number;
  orderedQueuedTurnIds: string[];
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
    if (!queueState || queueState.version !== input.expectedVersion) {
      throw new DurableTurnError("TURN_CONFLICT", "Queue version changed.");
    }
    const queued = await tx
      .select()
      .from(schema.threadTurns)
      .where(
        and(
          eq(schema.threadTurns.threadId, input.threadId),
          eq(schema.threadTurns.status, "queued")
        )
      )
      .orderBy(asc(schema.threadTurns.queueOrdinal));
    const currentIds = queued.map((turn) => turn.id);
    if (
      currentIds.length !== input.orderedQueuedTurnIds.length ||
      currentIds.some((id) => !input.orderedQueuedTurnIds.includes(id))
    ) {
      throw new DurableTurnError("TURN_CONFLICT", "Queued Turns changed.");
    }
    const ordinals = queued.map((turn) => turn.queueOrdinal).sort((a, b) => a - b);
    for (const [index, turnId] of input.orderedQueuedTurnIds.entries()) {
      await tx
        .update(schema.threadTurns)
        .set({ queueOrdinal: ordinals[index], updatedAt: new Date() })
        .where(eq(schema.threadTurns.id, turnId));
    }
    const now = new Date();
    await tx
      .update(schema.threadTurnQueueState)
      .set({ version: queueState.version + 1, updatedAt: now })
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId));
    if (queueState.activeTurnId) {
      await appendTurnEvent(tx, {
        turnId: queueState.activeTurnId,
        type: "queue.reordered",
        data: { version: queueState.version + 1 },
      });
    }
    return { threadId: input.threadId, version: queueState.version + 1 };
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
      queueState?.state !== "running" ||
      queueState.activeTurnId !== turn.id
    ) {
      return null;
    }
    const isInitialClaim = turn.status === "queued";
    const interaction =
      turn.status === "waiting_for_input"
        ? await tx.query.threadInteractions.findFirst({
            where: and(
              eq(schema.threadInteractions.turnId, turn.id),
              eq(schema.threadInteractions.source, "runtime"),
              eq(schema.threadInteractions.status, "resolved"),
              isNull(schema.threadInteractions.resumedAt)
            ),
            orderBy: (table, { asc }) => [asc(table.resolvedAt)],
          })
        : null;
    if (!(isInitialClaim || interaction)) {
      return null;
    }
    assertThreadTurnTransition(turn.status, "running");
    const now = new Date();
    const [running] = await tx
      .update(schema.threadTurns)
      .set({
        status: "running",
        startedAt: turn.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "turn.running",
      data: {
        status: "running",
        ...(interaction ? { resumedRequestId: interaction.requestId } : {}),
      },
    });
    await updateMobileTurnPresentation(tx, {
      turnId: turn.id,
      stage: interaction ? "retrying" : "preparing",
      now,
    });
    if (interaction) {
      await tx
        .update(schema.threadInteractions)
        .set({ resumedAt: now, updatedAt: now })
        .where(eq(schema.threadInteractions.id, interaction.id));
    }
    const response = interaction?.responseEnvelope;
    return running
      ? {
          ...running,
          interactionResponse:
            response &&
            typeof response.eventType === "string" &&
            typeof response.message === "string"
              ? {
                  requestId: interaction.requestId,
                  eventType: response.eventType,
                  message: response.message,
                  ...(typeof response.approved === "boolean"
                    ? { approved: response.approved }
                    : {}),
                  ...(typeof response.reason === "string"
                    ? { reason: response.reason }
                    : {}),
                }
              : null,
        }
      : null;
  });
}

export async function persistDurableAssistantOutcome(input: {
  turnId: string;
  messages: Array<{
    id: string;
    parts: unknown;
    model: string;
    source: ThreadTurnSource;
    projectContextRevisionId: string | null;
  }>;
  interaction: KestrelInteractionPresentation | null;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    if (!turn) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    const now = new Date();
    const mcpInteractions = await tx.query.threadInteractions.findMany({
      where: and(
        eq(schema.threadInteractions.turnId, turn.id),
        eq(schema.threadInteractions.source, "mcp")
      ),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    const messages = input.messages.map((message) => ({
      ...message,
      parts: appendInteractionPresentationParts(
        message.parts,
        mcpInteractions.map((interaction) => ({
          requestId: interaction.requestId,
          kind: interaction.kind,
          eventType: interaction.eventType,
          prompt: interaction.prompt,
          requestEnvelope: interaction.requestEnvelope,
          source: "mcp" as const,
          status: interaction.status,
        }))
      ),
    }));
    if (messages.length > 0) {
      await tx
        .insert(schema.threadMessages)
        .values(
          messages.map((message) => ({
            id: message.id,
            threadId: turn.threadId,
            turnId: turn.id,
            role: "assistant" as const,
            authorUserId: null,
            projectContextRevisionId: message.projectContextRevisionId,
            parts: message.parts,
            searchText: extractSearchText(message.parts),
            model: message.model,
            source: message.source,
            createdAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: schema.threadMessages.id,
          set: {
            parts: sql`excluded.parts`,
            searchText: sql`excluded.search_text`,
            model: sql`excluded.model`,
            turnId: sql`excluded.turn_id`,
          },
        });
      await tx
        .update(schema.threadTurns)
        .set({ outputMessageId: messages.at(-1)?.id ?? null, updatedAt: now })
        .where(eq(schema.threadTurns.id, turn.id));
    }
    await tx
      .update(schema.threads)
      .set({ updatedAt: now })
      .where(eq(schema.threads.id, turn.threadId));

    if (!input.interaction) {
      const assistantMessageId = messages.at(-1)?.id;
      if (assistantMessageId && mcpInteractions.length > 0) {
        await tx
          .update(schema.threadInteractions)
          .set({ assistantMessageId, updatedAt: now })
          .where(
            and(
              eq(schema.threadInteractions.turnId, turn.id),
              eq(schema.threadInteractions.source, "mcp")
            )
          );
      }
      return { turn, interaction: null };
    }
    if (turn.status !== "running") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Only a running turn can publish a pending interaction."
      );
    }
    const assistantMessageId = messages.at(-1)?.id;
    if (!assistantMessageId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A pending interaction must be attached to an assistant message."
      );
    }
    if (
      input.interaction.kind !== "user_input" &&
      input.interaction.kind !== "approval"
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A runtime turn can only publish a runtime interaction kind."
      );
    }
    const [requestConflict] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        eq(schema.threadInteractions.requestId, input.interaction.requestId)
      )
      .limit(1);
    if (requestConflict && requestConflict.turnId !== turn.id) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The runtime interaction request ID is already in use."
      );
    }
    const requestEnvelope = {
      version: input.interaction.version,
      requestId: input.interaction.requestId,
      kind: input.interaction.kind,
      eventType: input.interaction.eventType,
      prompt: input.interaction.prompt,
      ...(input.interaction.inputSchema
        ? { inputSchema: input.interaction.inputSchema }
        : {}),
      ...(input.interaction.approval
        ? { approval: input.interaction.approval }
        : {}),
    };
    const [interaction] = await tx
      .insert(schema.threadInteractions)
      .values({
        id: requestConflict?.id ?? crypto.randomUUID(),
        requestId: input.interaction.requestId,
        organizationId: turn.organizationId,
        threadId: turn.threadId,
        turnId: turn.id,
        assistantMessageId,
        source: "runtime",
        kind: input.interaction.kind,
        eventType: input.interaction.eventType,
        prompt: input.interaction.prompt,
        status: "pending",
        requestEnvelope,
        createdAt: requestConflict?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.threadInteractions.requestId,
        set: {
          assistantMessageId,
          prompt: input.interaction.prompt,
          requestEnvelope,
          updatedAt: now,
        },
      })
      .returning();
    assertThreadTurnTransition(turn.status, "waiting_for_input");
    const [waiting] = await tx
      .update(schema.threadTurns)
      .set({ status: "waiting_for_input", updatedAt: now })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId))
      .limit(1)
      .for("update");
    if (queueState?.activeTurnId !== turn.id) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The waiting turn is no longer active."
      );
    }
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        state: "paused",
        pauseReason: "interaction_required",
        version: queueState.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "interaction.required",
      data: {
        requestId: input.interaction.requestId,
        kind: input.interaction.kind,
        eventType: input.interaction.eventType,
        assistantMessageId,
        status: "waiting_for_input",
      },
    });
    await updateMobileTurnPresentation(tx, {
      turnId: turn.id,
      stage: "waiting",
      now,
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
    return { turn: waiting ?? turn, interaction: interaction ?? null };
  });
}

export async function resolveDurableRuntimeInteraction(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  requestId: string;
  eventType: string;
  message: string;
  approved?: boolean | undefined;
  reason?: string | undefined;
  messageId: string;
  source: ThreadTurnSource;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`
    );
    await lockAccessibleThread(tx, input);
    const [interaction] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        and(
          eq(schema.threadInteractions.requestId, input.requestId),
          eq(schema.threadInteractions.threadId, input.threadId),
          eq(schema.threadInteractions.organizationId, input.organizationId),
          eq(schema.threadInteractions.source, "runtime")
        )
      )
      .limit(1)
      .for("update");
    if (!interaction?.turnId) {
      throw new DurableTurnError(
        "TURN_NOT_FOUND",
        "Pending runtime interaction not found."
      );
    }
    if (interaction.eventType !== input.eventType) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The interaction response event type does not match the pending request."
      );
    }
    if (interaction.status === "resolved") {
      const [resolvedEvent] = await tx
        .select({ sequence: schema.threadTurnEvents.sequence })
        .from(schema.threadTurnEvents)
        .where(
          and(
            eq(schema.threadTurnEvents.turnId, interaction.turnId),
            eq(schema.threadTurnEvents.type, "interaction.resolved"),
            sql`${schema.threadTurnEvents.data}->>'requestId' = ${input.requestId}`
          )
        )
        .orderBy(desc(schema.threadTurnEvents.sequence))
        .limit(1);
      return {
        turnId: interaction.turnId,
        shouldDispatch: false,
        replayAfterSequence: resolvedEvent?.sequence ?? 0,
      };
    }
    if (interaction.status !== "pending") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The runtime interaction is no longer pending."
      );
    }
    if (
      interaction.kind === "approval" &&
      typeof input.approved !== "boolean"
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "An approval interaction requires an explicit decision."
      );
    }
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, interaction.turnId))
      .limit(1)
      .for("update");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId))
      .limit(1)
      .for("update");
    if (
      turn?.status !== "waiting_for_input" ||
      queueState?.activeTurnId !== turn.id ||
      queueState.state !== "paused" ||
      queueState.pauseReason !== "interaction_required"
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The pending interaction does not own the active waiting turn."
      );
    }
    const now = new Date();
    const responseEnvelope = {
      requestId: input.requestId,
      eventType: input.eventType,
      message: input.message,
      messageId: input.messageId,
      ...(typeof input.approved === "boolean"
        ? { approved: input.approved }
        : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    await tx.insert(schema.threadMessages).values({
      id: input.messageId,
      threadId: input.threadId,
      turnId: turn.id,
      role: "user",
      authorUserId: input.userId,
      projectContextRevisionId: turn.projectContextRevisionId,
      parts: [{ type: "text", text: input.message }],
      searchText: input.message,
      source: input.source,
      createdAt: now,
    });
    await tx
      .update(schema.threadInteractions)
      .set({
        status: "resolved",
        responseEnvelope,
        resolvedByUserId: input.userId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.threadInteractions.id, interaction.id));
    if (interaction.assistantMessageId) {
      const [assistantMessage] = await tx
        .select({ parts: schema.threadMessages.parts })
        .from(schema.threadMessages)
        .where(eq(schema.threadMessages.id, interaction.assistantMessageId))
        .limit(1)
        .for("update");
      if (assistantMessage) {
        await tx
          .update(schema.threadMessages)
          .set({
            parts: setInteractionPresentationStatus(
              assistantMessage.parts,
              interaction.requestId,
              "resolved"
            ),
          })
          .where(eq(schema.threadMessages.id, interaction.assistantMessageId));
      }
    }
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        state: "running",
        pauseReason: null,
        version: queueState.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId));
    const resolvedEvent = await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "interaction.resolved",
      data: {
        requestId: input.requestId,
        eventType: input.eventType,
        status: "resolved",
        messageId: input.messageId,
      },
    });
    return {
      turnId: turn.id,
      shouldDispatch: true,
      replayAfterSequence: resolvedEvent.sequence,
    };
  });
}

function appendInteractionPresentationParts(
  value: unknown,
  interactions: Array<{
    requestId: string;
    kind: string;
    eventType: string;
    prompt: string;
    requestEnvelope: Record<string, unknown>;
    source: "mcp";
    status: string;
  }>
) {
  const parts = Array.isArray(value) ? [...value] : [];
  const existingRequestIds = new Set(
    parts.flatMap((part) => {
      if (!(part && typeof part === "object" && !Array.isArray(part)))
        return [];
      const record = part as Record<string, unknown>;
      const data =
        record.data &&
        typeof record.data === "object" &&
        !Array.isArray(record.data)
          ? (record.data as Record<string, unknown>)
          : null;
      return record.type === "data-kestrel-interaction" &&
        typeof data?.requestId === "string"
        ? [data.requestId]
        : [];
    })
  );
  for (const interaction of interactions) {
    if (existingRequestIds.has(interaction.requestId)) continue;
    const status =
      interaction.status === "resolved"
        ? "resolved"
        : interaction.status === "cancelled" || interaction.status === "failed"
          ? "cancelled"
          : "pending";
    parts.push({
      type: "data-kestrel-interaction",
      id: `interaction:${interaction.requestId}`,
      data: {
        version: "v1",
        requestId: interaction.requestId,
        kind: interaction.kind,
        eventType: interaction.eventType,
        prompt: interaction.prompt,
        source: interaction.source,
        status,
        ...(interaction.requestEnvelope.inputSchema
          ? { inputSchema: interaction.requestEnvelope.inputSchema }
          : {}),
      },
    });
  }
  return parts;
}

function setInteractionPresentationStatus(
  value: unknown,
  requestId: string,
  status: "resolved" | "cancelled"
) {
  if (!Array.isArray(value)) return value;
  return value.map((part) => {
    if (!(part && typeof part === "object" && !Array.isArray(part)))
      return part;
    const record = part as Record<string, unknown>;
    const data =
      record.data &&
      typeof record.data === "object" &&
      !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : null;
    if (
      record.type !== "data-kestrel-interaction" ||
      data?.requestId !== requestId
    ) {
      return part;
    }
    return { ...record, data: { ...data, status } };
  });
}

export async function listThreadInteractionsForUser(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  includeArchived?: boolean;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await lockAccessibleThread(tx, input);
    const interactions = await tx.query.threadInteractions.findMany({
      where: eq(schema.threadInteractions.threadId, input.threadId),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    const turnIds = [
      ...new Set(
        interactions
          .map((interaction) => interaction.turnId)
          .filter((turnId): turnId is string => Boolean(turnId))
      ),
    ];
    const resolvedEvents =
      turnIds.length === 0
        ? []
        : await tx
            .select({ data: schema.threadTurnEvents.data })
            .from(schema.threadTurnEvents)
            .where(
              and(
                inArray(schema.threadTurnEvents.turnId, turnIds),
                eq(schema.threadTurnEvents.type, "interaction.resolved")
              )
            );
    const responseMessageIds = new Map<string, string>();
    for (const event of resolvedEvents) {
      if (!(event.data && typeof event.data === "object")) continue;
      const data = event.data as Record<string, unknown>;
      if (
        typeof data.requestId === "string" &&
        typeof data.messageId === "string"
      ) {
        responseMessageIds.set(data.requestId, data.messageId);
      }
    }
    return interactions.map((interaction) => {
      const responseEnvelope = interaction.responseEnvelope;
      const envelopeMessageId =
        responseEnvelope && typeof responseEnvelope.messageId === "string"
          ? responseEnvelope.messageId
          : null;
      return {
        ...interaction,
        responseMessageId:
          envelopeMessageId ??
          responseMessageIds.get(interaction.requestId) ??
          null,
      };
    });
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
    await updateMobileTurnPresentation(tx, {
      turnId: turn.id,
      stage: input.status === "completed" ? "finalizing" : "working",
      now,
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

/**
 * Returns the last completed UI stream segment for a durable turn. A turn can
 * have multiple stream segments when it waits for an interaction and resumes;
 * reconnecting without a client cursor must start after the prior segment so
 * persisted assistant messages are never appended to the live list again.
 */
export async function getDurableTurnReplayBoundary(turnId: string) {
  const [event] = await knowledgeDb
    .select({ sequence: schema.threadTurnEvents.sequence })
    .from(schema.threadTurnEvents)
    .where(
      and(
        eq(schema.threadTurnEvents.turnId, turnId),
        eq(schema.threadTurnEvents.type, "ui.message"),
        sql`${schema.threadTurnEvents.data}->>'type' = 'finish'`
      )
    )
    .orderBy(desc(schema.threadTurnEvents.sequence))
    .limit(1);
  return event?.sequence ?? 0;
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
        or(
          inArray(schema.threadMessages.turnId, priorTurnIds),
          and(
            isNull(schema.threadMessages.turnId),
            lte(schema.threadMessages.createdAt, turn.createdAt)
          )
        )
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

export async function getDurableTurnRetrySourceForUser(input: {
  turnId: string;
  organizationId: string;
  userId: string;
}) {
  const turn = await getDurableTurnForUser(input);
  if (!turn) return null;
  if (
    !["failed", "cancelled"].includes(turn.status) ||
    turn.failureCode === "TURN_REMOVED" ||
    !turn.inputMessageId
  ) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "Only a failed or stopped message can be retried."
    );
  }
  const message = await knowledgeDb.query.threadMessages.findFirst({
    where: and(
      eq(schema.threadMessages.id, turn.inputMessageId),
      eq(schema.threadMessages.threadId, turn.threadId),
      eq(schema.threadMessages.role, "user")
    ),
  });
  if (!message) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Retry message not found.");
  }
  const sourceMessageId = message.sourceMessageId ?? message.id;
  return { turn, messageParts: message.parts, sourceMessageId };
}

export async function listDurableThreadQueueForUser(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  includeArchived?: boolean;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await lockAccessibleThread(tx, input);
    const [turns, queueState] = await Promise.all([
      tx
        .select()
        .from(schema.threadTurns)
        .where(eq(schema.threadTurns.threadId, input.threadId))
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
        activeTurnId: queueState?.activeTurnId ?? null,
        version: queueState?.version ?? 0,
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
  threadId?: string | undefined;
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
          ...(input.threadId
            ? [eq(schema.threadTurns.threadId, input.threadId)]
            : []),
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
    if (turn.status === "queued" || turn.status === "waiting_for_input") {
      assertThreadTurnTransition(turn.status, "cancelled");
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
      if (turn.status === "waiting_for_input") {
        await tx
          .update(schema.threadInteractions)
          .set({ status: "cancelled", resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.threadInteractions.turnId, turn.id),
              eq(schema.threadInteractions.status, "pending")
            )
          );
      }
      await appendTurnEvent(tx, {
        turnId: turn.id,
        type: "turn.cancelled",
        data: {
          status: "cancelled",
          requestedByUserId: input.userId,
          interruptMode: "safe_boundary",
        },
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
      data: {
        requestedByUserId: input.userId,
        interruptMode: "safe_boundary",
      },
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
    const removedActiveTurn = queueState?.activeTurnId === turn.id;
    await tx
      .delete(schema.threadTurns)
      .where(eq(schema.threadTurns.id, turn.id));
    const next = removedActiveTurn
      ? await findNextQueuedTurn(tx, turn.threadId)
      : null;
    if (queueState) {
      await tx
        .update(schema.threadTurnQueueState)
        .set({
          activeTurnId: removedActiveTurn
            ? (next?.id ?? null)
            : queueState.activeTurnId,
          version: queueState.version + 1,
          updatedAt: now,
        })
        .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    }
    if (turn.inputMessageId) {
      await tx
        .delete(schema.threadMessages)
        .where(
          and(
            eq(schema.threadMessages.id, turn.inputMessageId),
            eq(schema.threadMessages.threadId, turn.threadId)
          )
        );
    }
    return {
      turn: {
        ...turn,
        status: "cancelled" as const,
        failureCode: "TURN_REMOVED",
        finishedAt: now,
        updatedAt: now,
      },
      nextTurnId: next?.id ?? null,
    };
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
    await updateMobileTurnPresentation(tx, {
      turnId: turn.id,
      stage: input.waiting ? "waiting" : "retrying",
      now,
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
