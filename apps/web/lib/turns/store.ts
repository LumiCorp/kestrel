import "server-only";

import type { KestrelInteractionPresentation } from "@kestrel-agents/ai-sdk";
import { parseRunnerStructuredReviewInteractionV1 } from "@kestrel-agents/protocol";
import { Ajv } from "ajv";
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
import { shouldInvalidateGatewayCredential } from "@/lib/ai/gateway-credential-health";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { meterPersistedModelMessages } from "@/lib/costs/metering";
import type { DbThreadTurn, DbThreadTurnEvent } from "@/lib/knowledge/db-types";
import {
  type MobileActivityStage,
  mobileActivity,
  mobileActivityForStage,
} from "@/lib/mobile/activity";
import {
  assertThreadTurnTransition,
  DURABLE_TURN_STOP_GRACE_MS,
  type ThreadTurnSource,
  type ThreadTurnTerminalStatus,
  terminalQueueOutcome,
} from "@/lib/turns/contracts";
import type { KestrelOneInteractionMode } from "@/lib/turns/interaction-mode";

type TurnTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

const interactionSchemaValidator = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: false,
});

export class DurableTurnError extends Error {
  readonly code:
    | "TURN_NOT_FOUND"
    | "TURN_FORBIDDEN"
    | "TURN_CONFLICT"
    | "RUNTIME_BINDING_IMMUTABLE"
    | "RUNTIME_BINDING_DEGRADED"
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
  },
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
  },
) {
  const [thread] = await tx
    .select()
    .from(schema.threads)
    .where(
      and(
        eq(schema.threads.id, input.threadId),
        eq(schema.threads.organizationId, input.organizationId),
      ),
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
        eq(schema.projectMembers.projectId, thread.projectId),
      ),
    )
    .where(
      and(
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId),
      ),
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
  input: { turnId: string; type: string; data?: unknown },
): Promise<DbThreadTurnEvent> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`thread-turn-events:${input.turnId}`}, 0))`,
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
  threadId: string,
): Promise<DbThreadTurn | null> {
  const [turn] = await tx
    .select()
    .from(schema.threadTurns)
    .where(
      and(
        eq(schema.threadTurns.threadId, threadId),
        eq(schema.threadTurns.status, "queued"),
      ),
    )
    .orderBy(asc(schema.threadTurns.queueOrdinal))
    .limit(1);
  return turn ?? null;
}

export type RuntimeAdmissionProof = {
  runtimeId: "codex" | "claude";
  environmentId: string;
  capabilityDigest: string;
  selectedModelId: string;
  observedAt: string;
  readinessExpiresAt?: string | undefined;
};

export type DurableThreadTurnInput = {
  threadId: string;
  organizationId: string;
  authorUserId: string;
  idempotencyKey: string;
  requestedEnvironmentId: string;
  projectContextRevisionId?: string | null;
  requestedModelId?: string | null;
  requestedRuntimeId?: "kestrel" | "codex" | "claude" | undefined;
  runtimeAdmission?: RuntimeAdmissionProof | undefined;
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
    createDurableThreadTurnInTransaction(tx, input),
  );
}

async function readExistingDurableTurn(
  tx: TurnTransaction,
  input: Pick<DurableThreadTurnInput, "threadId" | "idempotencyKey">,
) {
  const [existing] = await tx
    .select()
    .from(schema.threadTurns)
    .where(and(
      eq(schema.threadTurns.threadId, input.threadId),
      eq(schema.threadTurns.idempotencyKey, input.idempotencyKey),
    ))
    .limit(1);
  if (!existing) return null;
  const queueState = await tx.query.threadTurnQueueState.findFirst({
    where: eq(schema.threadTurnQueueState.threadId, input.threadId),
  });
  const shouldDispatch = existing.status === "queued" &&
    queueState?.state === "running" && queueState.activeTurnId === existing.id;
  return {
    turn: existing,
    created: false,
    shouldDispatch,
    dispatchTurnId: shouldDispatch ? existing.id : null,
  };
}

export async function getExistingDurableThreadTurnForAdmission(input: {
  threadId: string;
  organizationId: string;
  authorUserId: string;
  idempotencyKey: string;
  requestedRuntimeId: "kestrel" | "codex" | "claude";
}) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
    );
    const thread = await lockAccessibleThread(tx, {
      threadId: input.threadId,
      organizationId: input.organizationId,
      userId: input.authorUserId,
    });
    if (thread.runtimeId !== input.requestedRuntimeId) {
      throw new DurableTurnError(
        "RUNTIME_BINDING_IMMUTABLE",
        "The Runtime for an existing Thread cannot be changed.",
      );
    }
    return readExistingDurableTurn(tx, input);
  });
}

async function createDurableThreadTurnInTransaction(
  tx: TurnTransaction,
  input: DurableThreadTurnInput,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
  );
  let thread = await lockAccessibleThread(tx, {
    threadId: input.threadId,
    organizationId: input.organizationId,
    userId: input.authorUserId,
  });
  const requestedRuntimeId = input.requestedRuntimeId ?? "kestrel";
  if (thread.runtimeId !== requestedRuntimeId) {
    throw new DurableTurnError(
      "RUNTIME_BINDING_IMMUTABLE",
      "The Runtime for an existing Thread cannot be changed.",
    );
  }
  const existingTurn = await readExistingDurableTurn(tx, input);
  if (existingTurn) return existingTurn;
  if (!thread.runtimeBindingId) {
    const now = new Date();
    const runtimeId = thread.runtimeId ?? "kestrel";
    const participantId = `runtime:${thread.organizationId}:${runtimeId}`;
    const runtimeBindingId = `binding:${thread.id}`;
    await tx
      .insert(schema.runtimeParticipants)
      .values({
        id: participantId,
        organizationId: thread.organizationId,
        runtimeId,
        displayName:
          runtimeId === "kestrel"
            ? "Kestrel"
            : runtimeId === "codex"
              ? "Codex"
              : "Claude Code",
        createdAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(schema.runtimeBindings)
      .values({
        id: runtimeBindingId,
        threadId: thread.id,
        participantId,
        runtimeId,
        adapterContractVersion: 1,
        capabilityDigest:
          input.runtimeAdmission?.runtimeId === runtimeId
            ? input.runtimeAdmission.capabilityDigest
            : null,
        environmentId:
          input.runtimeAdmission?.runtimeId === runtimeId
            ? input.runtimeAdmission.environmentId
            : input.requestedEnvironmentId,
        selectedModelId:
          input.runtimeAdmission?.runtimeId === runtimeId
            ? input.runtimeAdmission.selectedModelId
            : input.requestedModelId ?? null,
        status: "ready",
        nativeSessionState: runtimeId === "kestrel" ? "ready" : "uninitialized",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: schema.runtimeBindings.threadId });
    const [binding] = await tx
      .select({ id: schema.runtimeBindings.id })
      .from(schema.runtimeBindings)
      .where(eq(schema.runtimeBindings.threadId, thread.id))
      .limit(1);
    if (!binding) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Thread Runtime binding could not be materialized.",
      );
    }
    const [updatedThread] = await tx
      .update(schema.threads)
      .set({ runtimeId, runtimeBindingId: binding.id, updatedAt: now })
      .where(eq(schema.threads.id, thread.id))
      .returning();
    if (!updatedThread) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Thread not found.");
    }
    thread = updatedThread;
  }
  const [runtimeBinding] = await tx
    .select()
    .from(schema.runtimeBindings)
    .where(eq(schema.runtimeBindings.threadId, thread.id))
    .limit(1)
    .for("update");
  if (!runtimeBinding || runtimeBinding.runtimeId !== requestedRuntimeId) {
    throw new DurableTurnError(
      "RUNTIME_BINDING_IMMUTABLE",
      "The Thread Runtime binding does not match the requested Runtime.",
    );
  }
  if (
    runtimeBinding.environmentId !== null &&
    runtimeBinding.environmentId !== input.requestedEnvironmentId
  ) {
    throw new DurableTurnError(
      "RUNTIME_BINDING_IMMUTABLE",
      "The Environment for an existing Runtime binding cannot be changed.",
    );
  }
  if (
    runtimeBinding.selectedModelId !== null &&
    runtimeBinding.selectedModelId !== (input.requestedModelId ?? null)
  ) {
    throw new DurableTurnError(
      "RUNTIME_BINDING_IMMUTABLE",
      "The model route for an existing Runtime binding cannot be changed.",
    );
  }
  if (
    runtimeBinding.status === "degraded" ||
    runtimeBinding.status === "released" ||
    runtimeBinding.nativeSessionState === "degraded" ||
    runtimeBinding.nativeSessionState === "released"
  ) {
    throw new DurableTurnError(
      "RUNTIME_BINDING_DEGRADED",
      "This Thread is read-only. Create the offered recovery fork to continue.",
    );
  }
  if (requestedRuntimeId !== "kestrel" && runtimeBinding.nativeSessionState === "uninitialized") {
    const proof = input.runtimeAdmission;
    const observedAt = proof ? Date.parse(proof.observedAt) : Number.NaN;
    const expiresAt = proof?.readinessExpiresAt
      ? Date.parse(proof.readinessExpiresAt)
      : Number.POSITIVE_INFINITY;
    if (
      !proof ||
      proof.runtimeId !== requestedRuntimeId ||
      proof.environmentId !== input.requestedEnvironmentId ||
      proof.selectedModelId !== input.requestedModelId ||
      !Number.isFinite(observedAt) ||
      observedAt < Date.now() - 60_000 ||
      observedAt > Date.now() + 60_000 ||
      expiresAt <= Date.now()
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A fresh matching Runtime readiness proof is required for the first Turn.",
      );
    }
    if (
      runtimeBinding.capabilityDigest !== null &&
      runtimeBinding.capabilityDigest !== proof.capabilityDigest
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Runtime readiness changed after this Thread was bound.",
      );
    }
    if (runtimeBinding.capabilityDigest === null) {
      await tx
        .update(schema.runtimeBindings)
        .set({
          capabilityDigest: proof.capabilityDigest,
          environmentId: proof.environmentId,
          selectedModelId: proof.selectedModelId,
          updatedAt: new Date(),
        })
        .where(eq(schema.runtimeBindings.id, runtimeBinding.id));
    }
  }
  if (input.projectContextRevisionId) {
    const [revision] = await tx
      .select({ projectId: schema.projectContextRevisions.projectId })
      .from(schema.projectContextRevisions)
      .where(
        eq(schema.projectContextRevisions.id, input.projectContextRevisionId),
      )
      .limit(1);
    if (!(revision && revision.projectId === thread.projectId)) {
      throw new DurableTurnError(
        "INVALID_CONTEXT_REVISION",
        "Project context revision does not belong to this Thread.",
      );
    }
  } else if (thread.projectId) {
    throw new DurableTurnError(
      "INVALID_CONTEXT_REVISION",
      "Project Threads require a bound context revision.",
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
        "The input message is already bound to another turn.",
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
            eq(schema.threadMessages.role, "user"),
          ),
        )
        .limit(1);
      if (
        !sourceMessage ||
        (sourceMessage.sourceMessageId &&
          sourceMessage.sourceMessageId !== sourceMessage.id)
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The retry source message is unavailable.",
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
  const requestedInteractionMode = input.requestedInteractionMode ?? "chat";
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
        "The input message ID is already in use.",
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
      requestedInteractionMode,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!turn) {
    throw new Error("Durable turn insert failed.");
  }
  await tx
    .update(schema.threads)
    .set({ interactionMode: requestedInteractionMode, updatedAt: now })
    .where(eq(schema.threads.id, input.threadId));
  await updateMobileTurnPresentation(tx, { turnId, stage: "queued", now });
  if (input.messageId) {
    await tx
      .update(schema.threadMessages)
      .set({ turnId })
      .where(
        and(
          eq(schema.threadMessages.id, input.messageId),
          eq(schema.threadMessages.threadId, input.threadId),
        ),
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
    !queueState.activeTurnId,
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
  input: DurableThreadTurnInput & { projectId: string | null },
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
          "The Thread ID is already in use.",
        );
      }
    } else {
      const now = new Date();
      const participantId = `runtime:${input.organizationId}:kestrel`;
      const runtimeBindingId = `binding:${input.threadId}`;
      await tx
        .insert(schema.runtimeParticipants)
        .values({
          id: participantId,
          organizationId: input.organizationId,
          runtimeId: "kestrel",
          displayName: "Kestrel",
          createdAt: now,
        })
        .onConflictDoNothing();
      const [thread] = await tx
        .insert(schema.threads)
        .values({
          id: input.threadId,
          createdByUserId: input.authorUserId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          mode: "chat",
          origin: "mobile",
          runtimeId: "kestrel",
          runtimeBindingId,
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
      await tx.insert(schema.runtimeBindings).values({
        id: runtimeBindingId,
        threadId: thread.id,
        participantId,
        runtimeId: "kestrel",
        adapterContractVersion: 1,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      });
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

export async function createWebThreadWithFirstTurn(
  input: DurableThreadTurnInput & { projectId: string | null },
) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
    );
    const requestedRuntimeId = input.requestedRuntimeId ?? "kestrel";
    const existing = await tx.query.threads.findFirst({
      where: eq(schema.threads.id, input.threadId),
    });
    if (existing) {
      if (
        existing.organizationId !== input.organizationId ||
        existing.createdByUserId !== input.authorUserId ||
        existing.origin !== "web" ||
        existing.mode !== "chat" ||
        existing.projectId !== input.projectId ||
        existing.runtimeId !== requestedRuntimeId
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The Thread ID is already in use.",
        );
      }
      return createDurableThreadTurnInTransaction(tx, input);
    }
    if (
      requestedRuntimeId !== "kestrel" &&
      (!input.runtimeAdmission ||
        input.runtimeAdmission.runtimeId !== requestedRuntimeId ||
        input.runtimeAdmission.environmentId !== input.requestedEnvironmentId ||
        input.runtimeAdmission.selectedModelId !== input.requestedModelId)
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A fresh matching Runtime readiness proof is required before Thread creation.",
      );
    }
    const now = new Date();
    const participantId = `runtime:${input.organizationId}:${requestedRuntimeId}`;
    const runtimeBindingId = `binding:${input.threadId}`;
    await tx
      .insert(schema.runtimeParticipants)
      .values({
        id: participantId,
        organizationId: input.organizationId,
        runtimeId: requestedRuntimeId,
        displayName:
          requestedRuntimeId === "kestrel"
            ? "Kestrel"
            : requestedRuntimeId === "codex"
              ? "Codex"
              : "Claude Code",
        createdAt: now,
      })
      .onConflictDoNothing();
    const [thread] = await tx
      .insert(schema.threads)
      .values({
        id: input.threadId,
        createdByUserId: input.authorUserId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        mode: "chat",
        origin: "web",
        runtimeId: requestedRuntimeId,
        runtimeBindingId,
        activeStreamId: null,
        title: "",
        isPublic: false,
        shareToken: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!thread) throw new Error("Thread creation failed.");
    await tx.insert(schema.runtimeBindings).values({
      id: runtimeBindingId,
      threadId: thread.id,
      participantId,
      runtimeId: requestedRuntimeId,
      adapterContractVersion: 1,
      capabilityDigest: input.runtimeAdmission?.capabilityDigest ?? null,
      environmentId: input.requestedEnvironmentId,
      selectedModelId:
        requestedRuntimeId === "kestrel"
          ? null
          : input.requestedModelId ?? null,
      status: "ready",
      nativeSessionState:
        requestedRuntimeId === "kestrel" ? "ready" : "uninitialized",
      createdAt: now,
      updatedAt: now,
    });
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

async function runMobileThreadTransaction<T>(
  callback: (tx: TurnTransaction) => Promise<T>,
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
    if (!(part && typeof part === "object" && !Array.isArray(part)))
      return false;
    const type = (part as Record<string, unknown>).type;
    return typeof type === "string" && durableTypes.has(type);
  });
}

export async function createMobileThreadBranchWithFirstTurn(
  input: DurableThreadTurnInput & {
    projectId: string | null;
    parentThreadId: string;
    anchorMessageId: string;
  },
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
    const requestedRuntimeId = input.requestedRuntimeId ?? "kestrel";
    const [parentBinding] = parent.runtimeBindingId
      ? await tx
          .select()
          .from(schema.runtimeBindings)
          .where(
            and(
              eq(schema.runtimeBindings.id, parent.runtimeBindingId),
              eq(schema.runtimeBindings.threadId, parent.id),
              eq(schema.runtimeBindings.runtimeId, parent.runtimeId),
            ),
          )
          .limit(1)
          .for("update")
      : [];
    if (!parentBinding) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The parent Thread Runtime binding is unavailable.",
      );
    }
    if (
      parentBinding.status === "degraded" ||
      parentBinding.status === "released" ||
      parentBinding.nativeSessionState === "degraded" ||
      parentBinding.nativeSessionState === "released"
    ) {
      throw new DurableTurnError(
        "RUNTIME_BINDING_DEGRADED",
        "This Thread is read-only. Create the offered recovery fork to continue.",
      );
    }
    if (
      requestedRuntimeId !== parent.runtimeId ||
      (parent.runtimeId !== "kestrel" &&
        (parentBinding.environmentId !== input.requestedEnvironmentId ||
          parentBinding.selectedModelId !== input.requestedModelId))
    ) {
      throw new DurableTurnError(
        "RUNTIME_BINDING_IMMUTABLE",
        "The branch Runtime route must match its parent Thread.",
      );
    }
    const [anchor] = await tx
      .select()
      .from(schema.threadMessages)
      .where(
        and(
          eq(schema.threadMessages.id, input.anchorMessageId),
          eq(schema.threadMessages.threadId, input.parentThreadId),
        ),
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
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The Thread ID is already in use.",
        );
      }
      return createDurableThreadTurnInTransaction(tx, input);
    }

    const now = new Date();
    const participantId = `runtime:${input.organizationId}:${parent.runtimeId}`;
    const runtimeBindingId = `binding:${input.threadId}`;
    await tx
      .insert(schema.runtimeParticipants)
      .values({
        id: participantId,
        organizationId: input.organizationId,
        runtimeId: parent.runtimeId,
        displayName:
          parent.runtimeId === "kestrel"
            ? "Kestrel"
            : parent.runtimeId === "codex"
              ? "Codex"
              : "Claude Code",
        createdAt: now,
      })
      .onConflictDoNothing();
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
        runtimeId: parent.runtimeId,
        runtimeBindingId,
        activeStreamId: null,
        title: "",
        isPublic: false,
        shareToken: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!thread) throw new Error("Branch creation failed.");
    await tx.insert(schema.runtimeBindings).values({
      id: runtimeBindingId,
      threadId: thread.id,
      participantId,
      runtimeId: parent.runtimeId,
      adapterContractVersion: 1,
      capabilityDigest: input.runtimeAdmission?.capabilityDigest ?? null,
      environmentId:
        input.runtimeAdmission?.environmentId ?? input.requestedEnvironmentId,
      selectedModelId:
        input.runtimeAdmission?.selectedModelId ?? input.requestedModelId ?? null,
      status: "ready",
      nativeSessionState: parent.runtimeId === "kestrel" ? "ready" : "uninitialized",
      createdAt: now,
      updatedAt: now,
    });

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
              lte(schema.threadMessages.id, anchor.id),
            ),
          ),
        ),
      )
      .orderBy(
        asc(schema.threadMessages.createdAt),
        asc(schema.threadMessages.id),
      );
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
        })),
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
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
    );
    const lockedThread = await lockAccessibleThread(tx, input);
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
          eq(schema.threadTurns.status, "queued"),
        ),
      )
      .orderBy(asc(schema.threadTurns.queueOrdinal));
    const currentIds = queued.map((turn) => turn.id);
    if (
      currentIds.length !== input.orderedQueuedTurnIds.length ||
      currentIds.some((id) => !input.orderedQueuedTurnIds.includes(id))
    ) {
      throw new DurableTurnError("TURN_CONFLICT", "Queued Turns changed.");
    }
    const ordinals = queued
      .map((turn) => turn.queueOrdinal)
      .sort((a, b) => a - b);
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

export async function claimDurableThreadTurn(
  turnId: string,
  options: { resumeRunning?: boolean } = {},
) {
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
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
    );
    const lockedThread = await lockAccessibleThread(tx, {
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
              eq(schema.threadInteractions.status, "processing"),
              isNull(schema.threadInteractions.resumedAt),
            ),
            orderBy: (table, { asc }) => [asc(table.answeredAt)],
          })
        : null;
    const isRunningResume = options.resumeRunning && turn.status === "running";
    if (!(isInitialClaim || interaction || isRunningResume)) {
      return null;
    }
    const binding = lockedThread.runtimeBindingId
      ? await tx.query.runtimeBindings.findFirst({
          where: eq(schema.runtimeBindings.id, lockedThread.runtimeBindingId),
        })
      : null;
    if (isRunningResume) {
      return {
        ...turn,
        runtimeId: lockedThread.runtimeId,
        runtimeBindingId: lockedThread.runtimeBindingId,
        runtimeBindingStatus: binding?.status ?? "ready",
        runtimeNativeSessionState: binding?.nativeSessionState ?? "uninitialized",
        participantId: `runtime:${lockedThread.organizationId}:${lockedThread.runtimeId}`,
        interactionResponse: null,
      };
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
    const response = interaction?.responseEnvelope;
    return running
      ? {
          ...running,
          runtimeId: lockedThread.runtimeId,
          runtimeBindingId: lockedThread.runtimeBindingId,
          runtimeBindingStatus: binding?.status ?? "ready",
          runtimeNativeSessionState: binding?.nativeSessionState ?? "uninitialized",
          participantId: `runtime:${lockedThread.organizationId}:${lockedThread.runtimeId}`,
          interactionResponse:
            response &&
            typeof response.eventType === "string" &&
            (typeof response.message === "string" ||
              readAnswerMap(response.answers) !== undefined)
              ? {
                  requestId: interaction.requestId,
                  eventType: response.eventType,
                  ...(typeof response.message === "string"
                    ? { message: response.message }
                    : {}),
                  ...(readAnswerMap(response.answers) !== undefined
                    ? { answers: readAnswerMap(response.answers)! }
                    : {}),
                  ...(typeof response.approved === "boolean"
                    ? { approved: response.approved }
                    : {}),
                  ...(typeof response.reason === "string"
                    ? { reason: response.reason }
                    : {}),
                  ...(typeof response.recoveryOptionId === "string"
                    ? { recoveryOptionId: response.recoveryOptionId }
                    : {}),
                }
              : null,
        }
      : null;
  });
}

export type DurableAssistantOutcomeMessage = {
  id: string;
  parts: unknown;
  model: string;
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  durationMs?: number | undefined;
  source: ThreadTurnSource;
  projectContextRevisionId: string | null;
};

export type DurableReplayChunk = {
  type: string;
  [key: string]: unknown;
};

async function appendDurableReplayChunks(
  tx: TurnTransaction,
  turnId: string,
  chunks: readonly DurableReplayChunk[],
) {
  for (const chunk of chunks) {
    await appendTurnEvent(tx, {
      turnId,
      type: "ui.message",
      data: chunk,
    });
  }
}

async function persistDurableAssistantMessages(
  tx: TurnTransaction,
  input: {
    turn: DbThreadTurn;
    messages: DurableAssistantOutcomeMessage[];
    now: Date;
    bindMcpInteractions: boolean;
  },
) {
  const mcpInteractions = await tx.query.threadInteractions.findMany({
    where: and(
      eq(schema.threadInteractions.turnId, input.turn.id),
      eq(schema.threadInteractions.source, "mcp"),
    ),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
  const messages = input.messages
    .flatMap(splitDialogPresentationMessages)
    .map((message) => ({
      ...message,
      parts:
        message.dialog === undefined
          ? appendInteractionPresentationParts(
              message.parts,
              mcpInteractions.map((interaction) => ({
                requestId: interaction.requestId,
                kind: interaction.kind,
                eventType: interaction.eventType,
                prompt: interaction.prompt,
                requestEnvelope: interaction.requestEnvelope,
                source: "mcp" as const,
                status: interaction.status,
              })),
            )
          : message.parts,
    }));
  const turnMessages = messages.filter(
    (message) => message.dialog === undefined,
  );
  const dialogs = [
    ...new Map(
      messages.flatMap((message) =>
        message.dialog === undefined
          ? []
          : [[message.dialog.dialogId, message.dialog] as const],
      ),
    ).values(),
  ];
  if (dialogs.length > 0) {
    await tx
      .insert(schema.threadDialogs)
      .values(
        dialogs.map((dialog) => ({
          id: dialog.dialogId,
          threadId: input.turn.threadId,
          runtimeChildThreadId: dialog.childSessionId,
          name: dialog.name,
          status: dialog.status,
          createdAt: dialog.createdAt,
          updatedAt: input.now,
        })),
      )
      .onConflictDoUpdate({
        target: schema.threadDialogs.id,
        set: {
          name: sql`excluded.name`,
          status: sql`excluded.status`,
          updatedAt: input.now,
        },
      });
  }
  if (messages.length > 0) {
    await tx
      .insert(schema.threadMessages)
      .values(
        messages.map((message) => ({
          id: message.id,
          threadId: input.turn.threadId,
          turnId: message.dialog === undefined ? input.turn.id : null,
          role: "assistant" as const,
          authorUserId: null,
          projectContextRevisionId: message.projectContextRevisionId,
          parts: message.parts,
          searchText: extractSearchText(message.parts),
          model: message.model,
          inputTokens: message.inputTokens ?? null,
          cachedInputTokens: message.cachedInputTokens ?? null,
          outputTokens: message.outputTokens ?? null,
          reasoningTokens: message.reasoningTokens ?? null,
          durationMs: message.durationMs ?? null,
          source: message.source,
          ...(message.dialog !== undefined
            ? {
                dialogId: message.dialog.dialogId,
                dialogMessageId: message.dialog.messageId,
                dialogName: message.dialog.name,
                dialogSender: message.dialog.sender,
              }
            : {}),
          createdAt: message.dialog?.createdAt ?? input.now,
        })),
      )
      .onConflictDoUpdate({
        target: schema.threadMessages.id,
        set: {
          parts: sql`excluded.parts`,
          searchText: sql`excluded.search_text`,
          model: sql`excluded.model`,
          inputTokens: sql`excluded.input_tokens`,
          cachedInputTokens: sql`excluded.cached_input_tokens`,
          outputTokens: sql`excluded.output_tokens`,
          reasoningTokens: sql`excluded.reasoning_tokens`,
          durationMs: sql`excluded.duration_ms`,
          turnId: sql`excluded.turn_id`,
        },
      });
    await tx
      .update(schema.threadTurns)
      .set({
        outputMessageId: turnMessages.at(-1)?.id ?? null,
        updatedAt: input.now,
      })
      .where(eq(schema.threadTurns.id, input.turn.id));
  }
  await tx
    .update(schema.threads)
    .set({ updatedAt: input.now })
    .where(eq(schema.threads.id, input.turn.threadId));

  const assistantMessageId = turnMessages.at(-1)?.id ?? null;
  if (
    input.bindMcpInteractions &&
    assistantMessageId &&
    mcpInteractions.length > 0
  ) {
    await tx
      .update(schema.threadInteractions)
      .set({ assistantMessageId, updatedAt: input.now })
      .where(
        and(
          eq(schema.threadInteractions.turnId, input.turn.id),
          eq(schema.threadInteractions.source, "mcp"),
        ),
      );
  }
  return assistantMessageId;
}

async function meterDurableAssistantMessages(
  messages: DurableAssistantOutcomeMessage[],
) {
  await meterPersistedModelMessages(messages.map((message) => message.id)).catch(
    (error) => {
      console.error(
        "Model usage metering will retry from the durable message ledger.",
        {
          message:
            error instanceof Error ? error.message : "Unknown error",
        },
      );
    },
  );
}

export async function persistDurableAssistantOutcome(input: {
  turnId: string;
  messages: DurableAssistantOutcomeMessage[];
  interaction: KestrelInteractionPresentation | null;
  replayChunks?: readonly DurableReplayChunk[];
}) {
  const result = await knowledgeDb.transaction(async (tx) => {
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
    const assistantMessageId = await persistDurableAssistantMessages(tx, {
      turn,
      messages: input.messages,
      now,
      bindMcpInteractions: !input.interaction,
    });

    if (!input.interaction) {
      await appendDurableReplayChunks(tx, turn.id, input.replayChunks ?? []);
      return { turn, interaction: null };
    }
    if (turn.status !== "running") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Only a running turn can publish a pending interaction.",
      );
    }
    if (!assistantMessageId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A pending interaction must be attached to an assistant message.",
      );
    }
    if (
      input.interaction.kind !== "user_input" &&
      input.interaction.kind !== "approval"
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A runtime turn can only publish a runtime interaction kind.",
      );
    }
    const [requestConflict] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        eq(schema.threadInteractions.requestId, input.interaction.requestId),
      )
      .limit(1);
    if (requestConflict && requestConflict.turnId !== turn.id) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The runtime interaction request ID is already in use.",
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
      ...(input.interaction.metadata
        ? { metadata: input.interaction.metadata }
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
        privateRuntimeMetadata: input.interaction.privateRuntimeMetadata ?? null,
        createdAt: requestConflict?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.threadInteractions.requestId,
        set: {
          assistantMessageId,
          prompt: input.interaction.prompt,
          requestEnvelope,
          privateRuntimeMetadata: input.interaction.privateRuntimeMetadata ?? null,
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
        "The waiting turn is no longer active.",
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
    await appendDurableReplayChunks(tx, turn.id, input.replayChunks ?? []);
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
          eq(schema.mobileDeviceRegistrations.enabled, true),
        ),
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
          })),
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
  await meterDurableAssistantMessages(input.messages);
  return result;
}

function splitDialogPresentationMessages<
  T extends { id: string; parts: unknown },
>(
  message: T,
): Array<
  T & {
    dialog?: {
      dialogId: string;
      messageId: string;
      name: string;
      childSessionId: string;
      sender: "kestrel" | "collaborator" | "system";
      createdAt: Date;
      status: "open" | "closed";
    };
  }
> {
  if (!Array.isArray(message.parts)) return [message];
  const dialogParts = message.parts.filter((part) =>
    isDialogPresentationPart(part),
  );
  if (dialogParts.length === 0) return [message];
  const ordinaryParts = message.parts.filter(
    (part) => !isDialogPresentationPart(part),
  );
  const result: Array<
    T & {
      dialog?: {
        dialogId: string;
        messageId: string;
        name: string;
        childSessionId: string;
        sender: "kestrel" | "collaborator" | "system";
        createdAt: Date;
        status: "open" | "closed";
      };
    }
  > = [];
  if (ordinaryParts.length > 0)
    result.push({ ...message, parts: ordinaryParts });
  for (const part of dialogParts) {
    const data = (
      part as {
        data: {
          dialogId: string;
          messageId: string;
          name: string;
          childSessionId: string;
          sender: "kestrel" | "collaborator" | "system";
          createdAt: string;
          dialogStatus: "open" | "closed";
          status?: "failed" | "cancelled";
        };
      }
    ).data;
    result.push({
      ...message,
      id: data.messageId,
      parts: [part],
      dialog: {
        dialogId: data.dialogId,
        messageId: data.messageId,
        name: data.name,
        childSessionId: data.childSessionId,
        sender: data.sender,
        createdAt: new Date(data.createdAt),
        status: data.dialogStatus,
      },
    });
  }
  return result;
}

function isDialogPresentationPart(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const part = value as Record<string, unknown>;
  if (
    part.type !== "data-kestrel-dialog-message" ||
    typeof part.data !== "object" ||
    part.data === null ||
    Array.isArray(part.data)
  )
    return false;
  const data = part.data as Record<string, unknown>;
  return (
    typeof data.dialogId === "string" &&
    typeof data.messageId === "string" &&
    typeof data.name === "string" &&
    typeof data.childSessionId === "string" &&
    (data.sender === "kestrel" ||
      data.sender === "collaborator" ||
      data.sender === "system") &&
    typeof data.createdAt === "string" &&
    (data.dialogStatus === "open" || data.dialogStatus === "closed")
  );
}

export async function resolveDurableRuntimeInteraction(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  requestId: string;
  eventType: string;
  message?: string | undefined;
  answers?: Record<string, string[]> | undefined;
  approved?: boolean | undefined;
  reason?: string | undefined;
  recoveryOptionId?: string | undefined;
  messageId: string;
  source: ThreadTurnSource;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
    );
    const lockedThread = await lockAccessibleThread(tx, input);
    const [interaction] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        and(
          eq(schema.threadInteractions.requestId, input.requestId),
          eq(schema.threadInteractions.threadId, input.threadId),
          eq(schema.threadInteractions.organizationId, input.organizationId),
          eq(schema.threadInteractions.source, "runtime"),
        ),
      )
      .limit(1)
      .for("update");
    if (!interaction?.turnId) {
      throw new DurableTurnError(
        "TURN_NOT_FOUND",
        "Pending runtime interaction not found.",
      );
    }
    if (interaction.eventType !== input.eventType) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The interaction response event type does not match the pending request.",
      );
    }
    if (interaction.status === "resolved" || interaction.status === "processing") {
      const replayType =
        interaction.status === "resolved"
          ? "interaction.resolved"
          : "interaction.answered";
      const [resolvedEvent] = await tx
        .select({ sequence: schema.threadTurnEvents.sequence })
        .from(schema.threadTurnEvents)
        .where(
          and(
            eq(schema.threadTurnEvents.turnId, interaction.turnId),
            eq(schema.threadTurnEvents.type, replayType),
            sql`${schema.threadTurnEvents.data}->>'requestId' = ${input.requestId}`,
          ),
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
        "The runtime interaction is no longer pending.",
      );
    }
    if (
      interaction.kind === "approval" &&
      typeof input.approved !== "boolean"
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "An approval interaction requires an explicit decision.",
      );
    }
    const structuredReview = parseRunnerStructuredReviewInteractionV1(
      interaction.requestEnvelope,
    );
    if (structuredReview.kind === "invalid_review") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "This structured review cannot be answered safely. End the waiting turn.",
      );
    }
    if (
      structuredReview.kind === "structured_review" &&
      (input.recoveryOptionId === undefined ||
        !structuredReview.allowedOptionIds.some(
          (optionId) => optionId === input.recoveryOptionId,
        ))
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The interaction response must select one exact allowed recovery option.",
      );
    }
    const inputSchema = readPlainRecord(interaction.requestEnvelope)?.inputSchema;
    const inputContract = readPlainRecord(inputSchema);
    const normalizedAnswers = interaction.kind === "user_input"
      ? validateRuntimeInteractionAnswers({
          inputSchema: inputContract,
          answers: input.answers,
          legacyMessage: input.recoveryOptionId ?? input.message,
        })
      : input.answers;
    const properties = readPlainRecord(inputContract?.properties);
    const optionSchema = readPlainRecord(properties?.recoveryOptionId);
    const allowedOptionIds = Array.isArray(optionSchema?.enum)
      ? optionSchema.enum.filter((value): value is string => typeof value === "string")
      : [];
    const requiresRecoveryOption = Array.isArray(inputContract?.required) &&
      inputContract.required.includes("recoveryOptionId");
    if (
      (structuredReview.kind === "ordinary" &&
        requiresRecoveryOption &&
        input.recoveryOptionId === undefined) ||
      (input.recoveryOptionId !== undefined &&
        allowedOptionIds.includes(input.recoveryOptionId) === false)
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The interaction response must select one exact allowed recovery option.",
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
        "The pending interaction does not own the active waiting turn.",
      );
    }
    const now = new Date();
    const responseEnvelope = {
      requestId: input.requestId,
      eventType: input.eventType,
      ...(input.message !== undefined ? { message: input.message } : {}),
      messageId: input.messageId,
      ...(normalizedAnswers !== undefined
        ? { answers: normalizedAnswers }
        : {}),
      ...(typeof input.approved === "boolean"
        ? { approved: input.approved }
        : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.recoveryOptionId !== undefined
        ? { recoveryOptionId: input.recoveryOptionId }
        : {}),
    };
    await tx.insert(schema.threadMessages).values({
      id: input.messageId,
      threadId: input.threadId,
      turnId: turn.id,
      role: "user",
      authorUserId: input.userId,
      projectContextRevisionId: turn.projectContextRevisionId,
      parts: [{
        type: "text",
        text: input.message ?? formatStructuredRuntimeAnswers(normalizedAnswers),
      }],
      searchText: input.message ?? formatStructuredRuntimeAnswers(normalizedAnswers),
      source: input.source,
      createdAt: now,
    });
    await tx
      .update(schema.threadInteractions)
      .set({
        status: "processing",
        responseEnvelope,
        resolvedByUserId: input.userId,
        answeredAt: now,
        updatedAt: now,
      })
      .where(eq(schema.threadInteractions.id, interaction.id));
    if (!lockedThread.runtimeBindingId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Thread Runtime binding is missing.",
      );
    }
    if (!turn.environmentExecutionId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime interaction is missing its environment execution.",
      );
    }
    const [environmentExecution] = await tx
      .select({ runtimeRunId: schema.environmentRunExecutions.runtimeRunId })
      .from(schema.environmentRunExecutions)
      .where(eq(schema.environmentRunExecutions.id, turn.environmentExecutionId))
      .limit(1)
      .for("update");
    if (!environmentExecution?.runtimeRunId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime interaction is missing its native run correlation.",
      );
    }
    const strategy =
      lockedThread.runtimeId === "codex"
        ? "live_connection"
        : lockedThread.runtimeId === "claude"
          ? "live_callback"
          : "kestrel_continuation";
    await tx
      .insert(schema.runtimeInteractionDeliveries)
      .values({
        id: crypto.randomUUID(),
        interactionId: interaction.id,
        turnId: turn.id,
        bindingId: lockedThread.runtimeBindingId,
        requestId: input.requestId,
        environmentExecutionId: turn.environmentExecutionId,
        runtimeRunId: environmentExecution.runtimeRunId,
        strategy,
        nativeCorrelation: interaction.privateRuntimeMetadata ?? {},
        attempt: 1,
        idempotencyKey: `${interaction.id}:1`,
        state: "delivering",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.runtimeInteractionDeliveries.interactionId,
        set: {
          state: "delivering",
          failureCode: null,
          failureMessage: null,
          updatedAt: now,
        },
      });
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
              "processing",
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
      type: "interaction.answered",
      data: {
        requestId: input.requestId,
        eventType: input.eventType,
        status: "processing",
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

export async function acknowledgeDurableRuntimeInteractionDelivery(input: {
  turnId: string;
  requestId: string;
  bindingId: string;
  environmentExecutionId: string;
  runtimeRunId: string;
  acknowledgementEventId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [interaction] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        and(
          eq(schema.threadInteractions.turnId, input.turnId),
          eq(schema.threadInteractions.requestId, input.requestId),
          eq(schema.threadInteractions.source, "runtime"),
        ),
      )
      .limit(1)
      .for("update");
    if (!interaction) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime acknowledgement does not match a durable interaction.",
      );
    }
    const [delivery] = await tx
      .select()
      .from(schema.runtimeInteractionDeliveries)
      .where(eq(schema.runtimeInteractionDeliveries.interactionId, interaction.id))
      .limit(1)
      .for("update");
    if (!delivery) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime interaction delivery ledger is missing.",
      );
    }
    const correlationMatches =
      delivery.turnId === input.turnId &&
      delivery.requestId === input.requestId &&
      delivery.bindingId === input.bindingId &&
      delivery.environmentExecutionId === input.environmentExecutionId &&
      delivery.runtimeRunId === input.runtimeRunId;
    if (!correlationMatches) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime acknowledgement correlation does not match the pending delivery.",
      );
    }
    if (interaction.status === "resolved" || delivery.state === "delivered") {
      if (delivery.acknowledgementEventId === input.acknowledgementEventId) {
        return interaction;
      }
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A different Runtime event already acknowledged this delivery.",
      );
    }
    if (interaction.status !== "processing") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The runtime interaction is not awaiting delivery acknowledgement.",
      );
    }
    const now = new Date();
    const [resolved] = await tx
      .update(schema.threadInteractions)
      .set({
        status: "resolved",
        resolvedAt: now,
        resumedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.threadInteractions.id, interaction.id))
      .returning();
    await tx
      .update(schema.runtimeInteractionDeliveries)
      .set({
        state: "delivered",
        acknowledgedAt: now,
        acknowledgementEventId: input.acknowledgementEventId,
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.runtimeInteractionDeliveries.interactionId, interaction.id));
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
              "resolved",
            ),
          })
          .where(eq(schema.threadMessages.id, interaction.assistantMessageId));
      }
    }
    await appendTurnEvent(tx, {
      turnId: input.turnId,
      type: "interaction.resolved",
      data: {
        requestId: input.requestId,
        eventType: interaction.eventType,
        status: "resolved",
      },
    });
    return resolved ?? null;
  });
}

export async function bindDurableRuntimeInteractionDeliveryExecution(input: {
  turnId: string;
  requestId: string;
  bindingId: string;
  environmentExecutionId: string;
  runtimeRunId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [interaction] = await tx
      .select({ id: schema.threadInteractions.id })
      .from(schema.threadInteractions)
      .where(
        and(
          eq(schema.threadInteractions.turnId, input.turnId),
          eq(schema.threadInteractions.requestId, input.requestId),
          eq(schema.threadInteractions.source, "runtime"),
        ),
      )
      .limit(1)
      .for("update");
    if (!interaction) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime delivery execution does not match a durable interaction.",
      );
    }
    const [delivery] = await tx
      .select()
      .from(schema.runtimeInteractionDeliveries)
      .where(eq(schema.runtimeInteractionDeliveries.interactionId, interaction.id))
      .limit(1)
      .for("update");
    if (!delivery || delivery.bindingId !== input.bindingId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime delivery execution does not match the pending binding.",
      );
    }
    const sameExecution =
      delivery.environmentExecutionId === input.environmentExecutionId &&
      delivery.runtimeRunId === input.runtimeRunId;
    if (delivery.state === "delivered") {
      if (sameExecution) return delivery;
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A delivered Runtime response cannot be rebound to another execution.",
      );
    }
    if (delivery.state !== "delivering") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime response is not awaiting delivery.",
      );
    }
    if (delivery.dispatchExecutionBoundAt !== null) {
      if (sameExecution) return delivery;
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A Runtime response cannot be rebound to another execution.",
      );
    }
    const [correlation] = await tx
      .select({
        threadId: schema.threadTurns.threadId,
        organizationId: schema.threadTurns.organizationId,
        requestedEnvironmentId: schema.threadTurns.requestedEnvironmentId,
        currentExecutionId: schema.threadTurns.environmentExecutionId,
        runtimeBindingId: schema.threads.runtimeBindingId,
        executionThreadId: schema.environmentRunExecutions.threadId,
        executionOrganizationId: schema.environmentRunExecutions.organizationId,
        executionEnvironmentId: schema.environmentRunExecutions.environmentId,
        executionRuntimeRunId: schema.environmentRunExecutions.runtimeRunId,
      })
      .from(schema.threadTurns)
      .innerJoin(
        schema.threads,
        eq(schema.threads.id, schema.threadTurns.threadId),
      )
      .innerJoin(
        schema.environmentRunExecutions,
        eq(schema.environmentRunExecutions.id, input.environmentExecutionId),
      )
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    if (
      !correlation ||
      correlation.runtimeBindingId !== input.bindingId ||
      correlation.currentExecutionId !== input.environmentExecutionId ||
      correlation.executionOrganizationId !== correlation.organizationId ||
      correlation.executionThreadId !== correlation.threadId ||
      correlation.executionEnvironmentId !== correlation.requestedEnvironmentId ||
      correlation.executionRuntimeRunId !== input.runtimeRunId
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime delivery execution does not match the active Turn authority.",
      );
    }
    const [updated] = await tx
      .update(schema.runtimeInteractionDeliveries)
      .set({
        environmentExecutionId: input.environmentExecutionId,
        runtimeRunId: input.runtimeRunId,
        dispatchExecutionBoundAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.runtimeInteractionDeliveries.id, delivery.id),
        isNull(schema.runtimeInteractionDeliveries.dispatchExecutionBoundAt),
      ))
      .returning();
    if (!updated) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime delivery execution was already bound.",
      );
    }
    return updated;
  });
}

export async function markRuntimeNativeSessionEstablished(input: {
  threadId: string;
  bindingId: string;
  runtimeId: "codex" | "claude";
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [binding] = await tx
      .select()
      .from(schema.runtimeBindings)
      .where(and(
        eq(schema.runtimeBindings.id, input.bindingId),
        eq(schema.runtimeBindings.threadId, input.threadId),
        eq(schema.runtimeBindings.runtimeId, input.runtimeId),
      ))
      .limit(1)
      .for("update");
    if (!binding) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime native session does not match a durable binding.",
      );
    }
    if (
      binding.status !== "ready" ||
      binding.nativeSessionState === "degraded" ||
      binding.nativeSessionState === "released"
    ) {
      throw new DurableTurnError(
        "RUNTIME_BINDING_DEGRADED",
        "A degraded or released Runtime binding cannot be re-established.",
      );
    }
    if (binding.nativeSessionState === "ready") return binding;
    const [updated] = await tx
      .update(schema.runtimeBindings)
      .set({ nativeSessionState: "ready", updatedAt: new Date() })
      .where(and(
        eq(schema.runtimeBindings.id, binding.id),
        eq(schema.runtimeBindings.nativeSessionState, "uninitialized"),
      ))
      .returning();
    if (!updated) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime native session lifecycle changed concurrently.",
      );
    }
    return updated;
  });
}

export async function failDurableRuntimeInteractionDelivery(input: {
  turnId: string;
  requestId: string;
  code: string;
  message: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [interaction] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        and(
          eq(schema.threadInteractions.turnId, input.turnId),
          eq(schema.threadInteractions.requestId, input.requestId),
          eq(schema.threadInteractions.source, "runtime"),
        ),
      )
      .limit(1)
      .for("update");
    if (!interaction) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The lost Runtime wait does not match a durable interaction.",
      );
    }
    const [delivery] = await tx
      .select()
      .from(schema.runtimeInteractionDeliveries)
      .where(eq(schema.runtimeInteractionDeliveries.interactionId, interaction.id))
      .limit(1)
      .for("update");
    if (!delivery) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The lost Runtime wait is missing its durable delivery ledger.",
      );
    }
    if (interaction.status === "failed" && delivery.state === "failed") {
      if (delivery.failureCode === input.code) return interaction;
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A different failure already settled this Runtime delivery.",
      );
    }
    if (interaction.status !== "processing" || delivery.state !== "delivering") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Runtime interaction is not awaiting native delivery proof.",
      );
    }
    const now = new Date();
    await tx
      .update(schema.runtimeInteractionDeliveries)
      .set({
        state: "failed",
        failureCode: input.code,
        failureMessage: input.message,
        updatedAt: now,
      })
      .where(eq(schema.runtimeInteractionDeliveries.interactionId, interaction.id));
    const [failed] = await tx
      .update(schema.threadInteractions)
      .set({ status: "failed", updatedAt: now })
      .where(eq(schema.threadInteractions.id, interaction.id))
      .returning();
    return failed ?? null;
  });
}

function validateRuntimeInteractionAnswers(input: {
  inputSchema: Record<string, unknown> | null;
  answers?: Record<string, string[]> | undefined;
  legacyMessage?: string | undefined;
}): Record<string, string[]> {
  if (input.inputSchema === null) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "The runtime question is missing its answer contract.",
    );
  }
  const required = Array.isArray(input.inputSchema.required)
    ? input.inputSchema.required.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const properties = readPlainRecord(input.inputSchema.properties);
  const propertyIds = properties ? Object.keys(properties) : [];
  const legacyQuestionId = input.answers === undefined &&
      input.legacyMessage !== undefined &&
      required.length === 1 &&
      propertyIds.length === 1 &&
      propertyIds[0] === required[0]
    ? required[0]
    : undefined;
  const answers = input.answers ??
    (legacyQuestionId !== undefined && input.legacyMessage !== undefined
      ? { [legacyQuestionId]: [input.legacyMessage] }
      : undefined);
  if (answers === undefined) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "This runtime question requires structured answers for every question.",
    );
  }
  if (
    Object.keys(answers).some((questionId) => !propertyIds.includes(questionId)) ||
    required.some((questionId) => !(questionId in answers)) ||
    Object.values(answers).some(
      (selections) =>
        !Array.isArray(selections) ||
        selections.length === 0 ||
        selections.some((selection) => typeof selection !== "string"),
    )
  ) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "The interaction response does not match the pending runtime question.",
    );
  }
  let validate;
  try {
    validate = interactionSchemaValidator.compile(input.inputSchema);
  } catch {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "The runtime question contains an invalid answer contract.",
    );
  }
  const legacyQuestionSchema = legacyQuestionId === undefined
    ? null
    : readPlainRecord(properties?.[legacyQuestionId]);
  const schemaValue = legacyQuestionId !== undefined && legacyQuestionSchema?.type === "string"
    ? { [legacyQuestionId]: input.legacyMessage }
    : answers;
  if (!validate(schemaValue)) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "The interaction response does not match the pending runtime question.",
    );
  }
  return answers;
}

function formatStructuredRuntimeAnswers(
  answers: Record<string, string[]> | undefined,
): string {
  if (!answers) return "Interaction response submitted.";
  return Object.entries(answers)
    .map(([questionId, selections]) => `${questionId}: ${selections.join(", ")}`)
    .join("\n");
}

function readPlainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readAnswerMap(value: unknown): Record<string, string[]> | undefined {
  const record = readPlainRecord(value);
  if (record === null) return;
  const answers: Record<string, string[]> = {};
  for (const [questionId, selections] of Object.entries(record)) {
    if (
      questionId.trim().length === 0 ||
      !Array.isArray(selections) ||
      selections.length === 0 ||
      selections.some((selection) => typeof selection !== "string")
    ) {
      return;
    }
    answers[questionId] = selections as string[];
  }
  return answers;
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
  }>,
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
    }),
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
        ...(interaction.requestEnvelope.metadata
          ? { metadata: interaction.requestEnvelope.metadata }
          : {}),
      },
    });
  }
  return parts;
}

function setInteractionPresentationStatus(
  value: unknown,
  requestId: string,
  status: "processing" | "resolved" | "cancelled",
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
          .filter((turnId): turnId is string => Boolean(turnId)),
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
                eq(schema.threadTurnEvents.type, "interaction.resolved"),
              ),
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
      const {
        privateRuntimeMetadata: _privateRuntimeMetadata,
        ...publicInteraction
      } = interaction;
      const responseEnvelope = interaction.responseEnvelope;
      const envelopeMessageId =
        responseEnvelope && typeof responseEnvelope.messageId === "string"
          ? responseEnvelope.messageId
          : null;
      return {
        ...publicInteraction,
        responseMessageId:
          envelopeMessageId ??
          responseMessageIds.get(interaction.requestId) ??
          null,
      };
    });
  });
}

async function terminalizeTurnEnvironmentExecution(
  tx: TurnTransaction,
  turn: {
    environmentExecutionId: string | null;
    organizationId: string;
  },
  status: ThreadTurnTerminalStatus,
  now: Date,
) {
  if (!turn.environmentExecutionId) return;
  const executionStatus =
    status === "completed"
      ? "completed"
      : status === "cancelled"
        ? "cancelled"
        : "failed";
  await tx
    .update(schema.environmentRunExecutions)
    .set({ status: executionStatus, completedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.environmentRunExecutions.id, turn.environmentExecutionId),
        eq(schema.environmentRunExecutions.organizationId, turn.organizationId),
        inArray(schema.environmentRunExecutions.status, ["routed", "running"]),
      ),
    );
  await tx
    .update(schema.environmentModelGrants)
    .set({ status: "closed", closedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.environmentModelGrants.runId, turn.environmentExecutionId),
        eq(schema.environmentModelGrants.organizationId, turn.organizationId),
        eq(schema.environmentModelGrants.status, "active"),
      ),
    );
  await tx
    .update(schema.mcpRunGrants)
    .set({ status: "revoked", revokedAt: now })
    .where(
      and(
        eq(schema.mcpRunGrants.runExecutionId, turn.environmentExecutionId),
        eq(schema.mcpRunGrants.organizationId, turn.organizationId),
        inArray(schema.mcpRunGrants.status, ["issued", "active"]),
      ),
    );
}

async function invalidateTurnGatewayCredentialForAuthFailure(
  tx: TurnTransaction,
  turn: {
    environmentExecutionId: string | null;
    organizationId: string;
  },
  failureCode: string | null | undefined,
  now: Date
) {
  if (!(turn.environmentExecutionId && failureCode === "MODEL_AUTH_ERROR")) {
    return;
  }
  const [leased] = await tx
    .select({
      gatewayId: schema.environmentModelGrants.gatewayId,
      grantCredentialRevision:
        schema.environmentModelGrants.gatewayCredentialRevision,
      gatewayCredentialRevision: schema.aiGateways.credentialRevision,
    })
    .from(schema.environmentModelGrants)
    .innerJoin(
      schema.aiGateways,
      eq(schema.aiGateways.id, schema.environmentModelGrants.gatewayId)
    )
    .where(
      and(
        eq(
          schema.environmentModelGrants.runId,
          turn.environmentExecutionId
        ),
        eq(
          schema.environmentModelGrants.organizationId,
          turn.organizationId
        ),
        eq(schema.environmentModelGrants.status, "active")
      )
    )
    .limit(1);
  if (
    !(
      leased &&
      shouldInvalidateGatewayCredential({
        failureCode,
        grantCredentialRevision: leased.grantCredentialRevision,
        gatewayCredentialRevision: leased.gatewayCredentialRevision,
      })
    )
  ) {
    return;
  }
  const [invalidated] = await tx
    .update(schema.aiGateways)
    .set({
      credentialStatus: "invalid",
      credentialValidatedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.aiGateways.id, leased.gatewayId),
        eq(schema.aiGateways.organizationId, turn.organizationId),
        eq(
          schema.aiGateways.credentialRevision,
          leased.grantCredentialRevision!
        )
      )
    )
    .returning({ id: schema.aiGateways.id });
  if (invalidated) {
    await tx.insert(schema.adminEventLogs).values({
      id: crypto.randomUUID(),
      organizationId: turn.organizationId,
      actorUserId: null,
      level: "warn",
      category: "ai_gateway",
      action: "gateway.credential.invalidated",
      targetType: "ai_gateway",
      targetId: invalidated.id,
      message: "Invalidated an AI gateway credential after a model authentication failure.",
      metadata: {
        failureCode: "MODEL_AUTH_ERROR",
        credentialRevision: leased.grantCredentialRevision,
      },
      createdAt: now,
    });
  }
}

export async function completeDurableThreadTurn(input: {
  turnId: string;
  status: ThreadTurnTerminalStatus;
  failureCode?: string | null;
  failureMessage?: string | null;
  messages?: DurableAssistantOutcomeMessage[];
  replayChunks?: readonly DurableReplayChunk[];
}) {
  let persistedMessages = false;
  const result = await knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
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
      await terminalizeTurnEnvironmentExecution(
        tx,
        turn,
        turn.status as ThreadTurnTerminalStatus,
        new Date(),
      );
      return { turn, nextTurnId: null };
    }
    assertThreadTurnTransition(turn.status, input.status);
    const outcome = terminalQueueOutcome(input.status);
    const now = new Date();
    if (input.messages && input.messages.length > 0) {
      await persistDurableAssistantMessages(tx, {
        turn,
        messages: input.messages,
        now,
        bindMcpInteractions: true,
      });
      persistedMessages = true;
    }
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
    if (input.status === "failed") {
      await invalidateTurnGatewayCredentialForAuthFailure(
        tx,
        turn,
        input.failureCode,
        now
      );
    }
    if (
      input.failureCode === "RUNTIME_NATIVE_SESSION_LOST" ||
      input.failureCode === "RUNTIME_LIVE_WAIT_LOST"
    ) {
      const owningThread = await tx.query.threads.findFirst({
        where: eq(schema.threads.id, turn.threadId),
        columns: { runtimeBindingId: true },
      });
      if (owningThread?.runtimeBindingId) {
        const [binding] = await tx
          .update(schema.runtimeBindings)
          .set({
            status: "degraded",
            ...(input.failureCode === "RUNTIME_NATIVE_SESSION_LOST"
              ? { nativeSessionState: "degraded" as const }
              : {}),
            updatedAt: now,
          })
          .where(eq(schema.runtimeBindings.id, owningThread.runtimeBindingId))
          .returning();
        if (
          binding &&
          (binding.runtimeId === "codex" || binding.runtimeId === "claude") &&
          turn.environmentExecutionId
        ) {
          const execution = await tx.query.environmentRunExecutions.findFirst({
            where: eq(schema.environmentRunExecutions.id, turn.environmentExecutionId),
          });
          if (execution) {
            await tx
              .insert(schema.runtimeBindingReleaseOutbox)
              .values({
                id: crypto.randomUUID(),
                organizationId: turn.organizationId,
                runtimeId: binding.runtimeId,
                bindingId: binding.id,
                participantId: binding.participantId,
                threadId: turn.threadId,
                environmentId: execution.environmentId,
                workspaceId: execution.workspaceId,
                actorUserId: execution.actorId,
                idempotencyKey: `runtime-release:${binding.id}`,
                state: "pending",
                attempts: 0,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing({
                target: schema.runtimeBindingReleaseOutbox.idempotencyKey,
              });
          }
        }
      }
    }
    await terminalizeTurnEnvironmentExecution(tx, turn, input.status, now);
    await appendDurableReplayChunks(tx, turn.id, input.replayChunks ?? []);
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
          eq(schema.mobileDeviceRegistrations.enabled, true),
        ),
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
          })),
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
  if (persistedMessages && input.messages) {
    await meterDurableAssistantMessages(input.messages);
  }
  return result;
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
        gt(schema.threadTurnEvents.sequence, input.afterSequence ?? 0),
      ),
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
        sql`${schema.threadTurnEvents.data}->>'type' = 'finish'`,
      ),
    )
    .orderBy(desc(schema.threadTurnEvents.sequence))
    .limit(1);
  return event?.sequence ?? 0;
}

export async function getDurableTurnOpenReplayScaffold(turnId: string) {
  const events = await knowledgeDb
    .select({ data: schema.threadTurnEvents.data })
    .from(schema.threadTurnEvents)
    .where(
      and(
        eq(schema.threadTurnEvents.turnId, turnId),
        eq(schema.threadTurnEvents.type, "ui.message"),
        sql`${schema.threadTurnEvents.data}->>'type' IN ('start', 'text-start', 'finish')`,
      ),
    )
    .orderBy(asc(schema.threadTurnEvents.sequence));
  let assistantMessageId: string | null = null;
  let textPartId: string | null = null;
  for (const event of events) {
    if (!(event.data && typeof event.data === "object")) continue;
    const chunk = event.data as Record<string, unknown>;
    if (chunk.type === "finish") {
      assistantMessageId = null;
      textPartId = null;
    } else if (chunk.type === "start" && typeof chunk.messageId === "string") {
      assistantMessageId = chunk.messageId;
    } else if (chunk.type === "text-start" && typeof chunk.id === "string") {
      textPartId = chunk.id;
    }
  }
  return { assistantMessageId, textPartId };
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
        sql`${schema.threadTurns.sequence} <= ${turn.sequence}`,
      ),
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
            lte(schema.threadMessages.createdAt, turn.createdAt),
          ),
        ),
      ),
    )
    .orderBy(
      asc(schema.threadMessages.createdAt),
      asc(schema.threadMessages.id),
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
      eq(schema.threadTurns.organizationId, input.organizationId),
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
      "Only a failed or stopped message can be retried.",
    );
  }
  const message = await knowledgeDb.query.threadMessages.findFirst({
    where: and(
      eq(schema.threadMessages.id, turn.inputMessageId),
      eq(schema.threadMessages.threadId, turn.threadId),
      eq(schema.threadMessages.role, "user"),
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

export async function markRuntimeEventReconciliationPending(input: {
  turnId: string;
  code?: string | undefined;
}) {
  const [turn] = await knowledgeDb
    .select({ environmentExecutionId: schema.threadTurns.environmentExecutionId })
    .from(schema.threadTurns)
    .where(eq(schema.threadTurns.id, input.turnId))
    .limit(1);
  if (!turn?.environmentExecutionId) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "The Runtime event cannot be reconciled without an Environment execution.",
    );
  }
  const [updated] = await knowledgeDb
    .update(schema.environmentRunExecutions)
    .set({
      runtimeEventReconciliationState: "pending",
      runtimeEventReconciliationAttempts:
        sql`${schema.environmentRunExecutions.runtimeEventReconciliationAttempts} + 1`,
      runtimeEventReconciliationCode:
        input.code ?? "RUNTIME_EVENT_PERSISTENCE_FAILED",
      runtimeEventReconciliationAttemptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.environmentRunExecutions.id, turn.environmentExecutionId),
      inArray(schema.environmentRunExecutions.status, ["routed", "running"]),
    ))
    .returning({ id: schema.environmentRunExecutions.id });
  if (!updated) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "The Runtime event reconciliation execution is no longer active.",
    );
  }
  return true;
}

export async function clearRuntimeEventReconciliation(input: {
  environmentExecutionId: string;
}) {
  const [updated] = await knowledgeDb
    .update(schema.environmentRunExecutions)
    .set({
      runtimeEventReconciliationState: "idle",
      runtimeEventReconciliationCode: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.environmentRunExecutions.id, input.environmentExecutionId),
      inArray(schema.environmentRunExecutions.status, ["routed", "running"]),
    ))
    .returning({ id: schema.environmentRunExecutions.id });
  if (!updated) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "The Runtime event reconciliation execution is no longer active.",
    );
  }
}

export async function getActiveDurableTurnForThread(threadId: string) {
  const [active] = await knowledgeDb
    .select({ turn: schema.threadTurns })
    .from(schema.threadTurnQueueState)
    .innerJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.threadTurnQueueState.activeTurnId),
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
          eq(schema.threadTurns.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
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
        "Only an active turn can be stopped.",
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
              eq(schema.threadInteractions.status, "pending"),
            ),
          );
      }
      await appendTurnEvent(tx, {
        turnId: turn.id,
        type: "turn.cancelled",
        data: {
          status: "cancelled",
          requestedByUserId: input.userId,
          interruptMode: "immediate",
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
        interruptMode: "safe_boundary_deadline",
        interruptDeadlineAt: new Date(
          now.getTime() + DURABLE_TURN_STOP_GRACE_MS,
        ).toISOString(),
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
          eq(schema.threadTurns.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
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
        "Only a queued turn can be removed.",
      );
    }
    if (turn.authorUserId !== input.userId) {
      throw new DurableTurnError(
        "TURN_FORBIDDEN",
        "Only the queued turn author can remove it.",
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
            eq(schema.threadMessages.threadId, turn.threadId),
          ),
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
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
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
        "The Thread already has an active turn.",
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
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
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
            eq(schema.mobileDeviceRegistrations.enabled, true),
          ),
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
            })),
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
