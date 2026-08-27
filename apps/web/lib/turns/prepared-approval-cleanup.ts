import "server-only";

import { and, eq, max, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { setInteractionPresentationStatus } from "@/lib/turns/interaction-projection";

export const PREPARED_APPROVAL_CLEANUP_VERSION =
  "prepared_approval_cleanup_v1" as const;

export class PreparedApprovalCleanupRetryError extends Error {
  readonly code = "PREPARED_APPROVAL_CLEANUP_RETRY" as const;
  readonly preserveRunningExecution: boolean;

  constructor(input: { preserveRunningExecution?: boolean | undefined } = {}) {
    super("Prepared approval cleanup release will retry.");
    this.name = "PreparedApprovalCleanupRetryError";
    this.preserveRunningExecution =
      input.preserveRunningExecution === true;
  }
}

export function isPreparedApprovalCleanupRetryError(
  error: unknown,
): error is PreparedApprovalCleanupRetryError {
  return error instanceof PreparedApprovalCleanupRetryError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "PREPARED_APPROVAL_CLEANUP_RETRY");
}

export function shouldPreservePreparedApprovalCleanupExecution(
  error: PreparedApprovalCleanupRetryError,
) {
  return error.preserveRunningExecution === true;
}

export function preparedApprovalQueueLockKey(threadId: string) {
  return `thread-turn-queue:${threadId}`;
}

export type PreparedApprovalCleanupFailureCode =
  | "EXTERNAL_APPROVAL_EXPIRED"
  | "EXTERNAL_APPROVAL_IDENTITY_MISMATCH"
  | "EXTERNAL_APPROVAL_POLICY_CHANGED";

export type PreparedApprovalCleanupV1 = {
  version: typeof PREPARED_APPROVAL_CLEANUP_VERSION;
  failureCode: PreparedApprovalCleanupFailureCode;
  failureMessage: string;
};

type CleanupTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

export function preparedApprovalCleanupFailure(
  failureCode: PreparedApprovalCleanupFailureCode,
): PreparedApprovalCleanupV1 {
  return {
    version: PREPARED_APPROVAL_CLEANUP_VERSION,
    failureCode,
    failureMessage:
      failureCode === "EXTERNAL_APPROVAL_EXPIRED"
        ? "The prepared authorization expired before it could execute."
        : failureCode === "EXTERNAL_APPROVAL_POLICY_CHANGED"
          ? "Current policy or provider availability no longer permits this prepared operation."
          : "The approval no longer matches the prepared tool invocation.",
  };
}

export function parsePreparedApprovalCleanup(
  value: unknown,
): PreparedApprovalCleanupV1 | null {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== PREPARED_APPROVAL_CLEANUP_VERSION ||
    (record.failureCode !== "EXTERNAL_APPROVAL_EXPIRED" &&
      record.failureCode !== "EXTERNAL_APPROVAL_IDENTITY_MISMATCH" &&
      record.failureCode !== "EXTERNAL_APPROVAL_POLICY_CHANGED") ||
    typeof record.failureMessage !== "string" ||
    record.failureMessage.length === 0
  ) {
    return null;
  }
  return {
    version: PREPARED_APPROVAL_CLEANUP_VERSION,
    failureCode: record.failureCode,
    failureMessage: record.failureMessage,
  };
}

export function readPreparedApprovalCleanupFromResponse(
  value: unknown,
): PreparedApprovalCleanupV1 | null {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return null;
  }
  return parsePreparedApprovalCleanup(
    (value as Record<string, unknown>).preparedApprovalCleanup,
  );
}

export async function schedulePreparedApprovalCleanupInTransaction(
  tx: CleanupTransaction,
  input: {
    interaction: typeof schema.threadInteractions.$inferSelect;
    turn: typeof schema.threadTurns.$inferSelect;
    queueState: typeof schema.threadTurnQueueState.$inferSelect;
    cleanup: PreparedApprovalCleanupV1;
    responseEnvelope: Record<string, unknown>;
    resolvedByUserId?: string | null | undefined;
    resolvedAt?: Date | null | undefined;
    now: Date;
  },
) {
  const existingCleanup = readPreparedApprovalCleanupFromResponse(
    input.interaction.responseEnvelope,
  );
  if (existingCleanup !== null) {
    return { scheduled: false, sequence: 0 };
  }
  const responseEnvelope: Record<string, unknown> = {
    ...input.responseEnvelope,
    preparedApprovalCleanup: input.cleanup,
  };
  await tx
    .update(schema.threadInteractions)
    .set({
      status: "processing",
      responseEnvelope,
      ...(input.resolvedByUserId === undefined
        ? {}
        : { resolvedByUserId: input.resolvedByUserId }),
      ...(input.resolvedAt === undefined ? {} : { resolvedAt: input.resolvedAt }),
      resumedAt: null,
      responseFailureCode: null,
      responseFailureMessage: null,
      effectStatus: null,
      responseRetryable: false,
      updatedAt: input.now,
    })
    .where(eq(schema.threadInteractions.id, input.interaction.id));
  if (input.interaction.runtimeApprovalId) {
    await tx
      .update(schema.appOperationApprovals)
      .set({
        availabilityStatus: "expired",
        payload: sql`jsonb_build_object('redacted', true, 'operation', ${schema.appOperationApprovals.operationKey})`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(
            schema.appOperationApprovals.organizationId,
            input.interaction.organizationId,
          ),
          eq(
            schema.appOperationApprovals.runtimeApprovalId,
            input.interaction.runtimeApprovalId,
          ),
          eq(schema.appOperationApprovals.lifecycleVersion, "interaction_v2"),
          eq(schema.appOperationApprovals.interactionId, input.interaction.id),
          eq(schema.appOperationApprovals.availabilityStatus, "available"),
        ),
      );
  }
  if (input.interaction.assistantMessageId) {
    const message = await tx.query.threadMessages.findFirst({
      where: eq(
        schema.threadMessages.id,
        input.interaction.assistantMessageId,
      ),
      columns: { parts: true },
    });
    if (message) {
      const submittedDecision = responseEnvelope.decision;
      await tx
        .update(schema.threadMessages)
        .set({
          parts: setInteractionPresentationStatus(
            message.parts,
            input.interaction.requestId,
            "processing",
            {
              decision:
                submittedDecision === "approve_once" ||
                submittedDecision === "remember_approval" ||
                responseEnvelope.approved === true
                  ? "approved"
                  : submittedDecision === "decline" ||
                      responseEnvelope.approved === false
                    ? "denied"
                    : "expired",
              authorizationState: "cleanup_pending",
              effectState: "not_started",
              failureCode: input.cleanup.failureCode,
              retryEligible: false,
            },
          ),
        })
        .where(
          eq(
            schema.threadMessages.id,
            input.interaction.assistantMessageId,
          ),
        );
    }
  }
  await tx
    .update(schema.threadTurnQueueState)
    .set({
      state: "running",
      pauseReason: null,
      version: input.queueState.version + 1,
      updatedAt: input.now,
    })
    .where(eq(schema.threadTurnQueueState.threadId, input.turn.threadId));
  const [latest] = await tx
    .select({ sequence: max(schema.threadTurnEvents.sequence) })
    .from(schema.threadTurnEvents)
    .where(eq(schema.threadTurnEvents.turnId, input.turn.id));
  const nextSequence = (latest?.sequence ?? 0) + 1;
  const events = [
    ...(input.resolvedByUserId
      ? [
          {
            id: crypto.randomUUID(),
            turnId: input.turn.id,
            sequence: nextSequence,
            type: "interaction.decision_recorded",
            data: {
              requestId: input.interaction.requestId,
              eventType: input.interaction.eventType,
              status: "processing",
              messageId:
                typeof responseEnvelope.messageId === "string"
                  ? responseEnvelope.messageId
                  : null,
            },
          },
        ]
      : []),
    {
      id: crypto.randomUUID(),
      turnId: input.turn.id,
      sequence: nextSequence + (input.resolvedByUserId ? 1 : 0),
      type: "interaction.cleanup_requested",
      data: {
        requestId: input.interaction.requestId,
        failureCode: input.cleanup.failureCode,
        submittedDecision:
          typeof responseEnvelope.decision === "string"
            ? responseEnvelope.decision
            : null,
      },
    },
  ];
  const inserted = await tx
    .insert(schema.threadTurnEvents)
    .values(events)
    .returning({ sequence: schema.threadTurnEvents.sequence });
  return {
    scheduled: true,
    sequence: inserted.at(-1)?.sequence ?? 0,
  };
}
