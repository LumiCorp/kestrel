import "server-only";

import { parseRunnerStructuredReviewInteractionV1 } from "@kestrel-agents/protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import { resolveRuntimeApprovalPolicies } from "@/lib/apps/runtime-approval-policy";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { ProjectRole } from "@/lib/projects/access";
import { projectRoleAllows } from "@/lib/projects/access";
import type { ThreadAccess } from "@/lib/threads/store";
import type { ThreadConversationSnapshot } from "@/lib/turns/client-contract";
import { projectSafeThreadInteraction } from "@/lib/turns/interaction-projection";
import { convertToUIMessages } from "@/lib/utils";

type ConversationSnapshotRead = {
  thread: typeof schema.threads.$inferSelect & {
    messages: Array<
      typeof schema.threadMessages.$inferSelect & {
        authorName: string | null;
        authorEmail: string | null;
      }
    >;
    emailReceipt: {
      id: string;
      state: "materialized";
      receivedAt: Date;
      trigger: { id: string; name: string } | null;
    } | null;
    access: ThreadAccess;
  };
  snapshot: ThreadConversationSnapshot;
};

export class ThreadConversationSnapshotError extends Error {
  readonly code = "THREAD_CONVERSATION_SNAPSHOT_INCONSISTENT";

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ThreadConversationSnapshotError";
  }
}

export async function readThreadConversationSnapshotForUser(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  includeArchived?: boolean;
}): Promise<ConversationSnapshotRead | null> {
  try {
    const read = await knowledgeDb.transaction(
      async (tx) => {
        const thread = await tx.query.threads.findFirst({
          where: and(
            eq(schema.threads.id, input.threadId),
            eq(schema.threads.organizationId, input.organizationId),
          ),
        });
        if (!thread || (thread.archivedAt && !input.includeArchived)) {
          return null;
        }

        let projectRole: ProjectRole | null = null;
        if (thread.projectId === null) {
          if (thread.createdByUserId !== input.userId) return null;
        } else {
          const [membership] = await tx
            .select({
              role: schema.projectMembers.role,
              projectArchivedAt: schema.projects.archivedAt,
            })
            .from(schema.projects)
            .innerJoin(
              schema.projectMembers,
              eq(schema.projectMembers.projectId, schema.projects.id),
            )
            .innerJoin(
              schema.members,
              and(
                eq(
                  schema.members.id,
                  schema.projectMembers.organizationMemberId,
                ),
                eq(schema.members.organizationId, input.organizationId),
                eq(schema.members.userId, input.userId),
              ),
            )
            .where(
              and(
                eq(schema.projects.id, thread.projectId),
                eq(schema.projects.organizationId, input.organizationId),
              ),
            )
            .limit(1);
          if (
            !membership ||
            (membership.projectArchivedAt && !input.includeArchived)
          ) {
            return null;
          }
          projectRole = membership.role;
        }

        const messages = await tx.query.threadMessages.findMany({
          where: eq(schema.threadMessages.threadId, thread.id),
          orderBy: [
            asc(schema.threadMessages.createdAt),
            asc(schema.threadMessages.id),
          ],
        });
        const authorIds = [
          ...new Set(
            messages
              .map((message) => message.authorUserId)
              .filter((authorId): authorId is string => Boolean(authorId)),
          ),
        ];
        const authors =
          authorIds.length === 0
            ? []
            : await tx
                .select({
                  id: schema.users.id,
                  name: schema.users.name,
                  email: schema.users.email,
                })
                .from(schema.users)
                .where(inArray(schema.users.id, authorIds));
        const authorsById = new Map(
          authors.map((author) => [author.id, author]),
        );
        const [emailReceipt] = await tx
          .select({
            id: schema.emailDeliveryReceipts.id,
            state: schema.emailDeliveryReceipts.state,
            receivedAt: schema.emailDeliveryReceipts.eventAt,
            triggerId: schema.projectEmailTriggers.id,
            triggerName: schema.projectEmailTriggers.name,
          })
          .from(schema.emailDeliveryReceipts)
          .leftJoin(
            schema.projectEmailTriggers,
            and(
              eq(
                schema.projectEmailTriggers.id,
                schema.emailDeliveryReceipts.triggerId,
              ),
              eq(
                schema.projectEmailTriggers.organizationId,
                schema.emailDeliveryReceipts.organizationId,
              ),
            ),
          )
          .where(
            and(
              eq(
                schema.emailDeliveryReceipts.organizationId,
                input.organizationId,
              ),
              eq(schema.emailDeliveryReceipts.materializedThreadId, thread.id),
              eq(schema.emailDeliveryReceipts.state, "materialized"),
            ),
          )
          .limit(1);
        const messagesWithAuthors = messages.map((message) => ({
          ...message,
          authorName: message.authorUserId
            ? (authorsById.get(message.authorUserId)?.name ?? null)
            : null,
          authorEmail: message.authorUserId
            ? (authorsById.get(message.authorUserId)?.email ?? null)
            : null,
        }));

        const interactions = await tx.query.threadInteractions.findMany({
          where: eq(schema.threadInteractions.threadId, thread.id),
          orderBy: [asc(schema.threadInteractions.createdAt)],
        });
        const turns = await tx.query.threadTurns.findMany({
          where: eq(schema.threadTurns.threadId, thread.id),
          orderBy: [asc(schema.threadTurns.sequence)],
        });
        const queueState = await tx.query.threadTurnQueueState.findFirst({
          where: eq(schema.threadTurnQueueState.threadId, thread.id),
        });
        const resolvedEvents =
          turns.length === 0
            ? []
            : await tx
                .select({ data: schema.threadTurnEvents.data })
                .from(schema.threadTurnEvents)
                .where(
                  and(
                    inArray(
                      schema.threadTurnEvents.turnId,
                      turns.map((turn) => turn.id),
                    ),
                    eq(
                      schema.threadTurnEvents.type,
                      "interaction.resolved",
                    ),
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

        assertPendingOrdinaryInteractionMessages({
          threadId: thread.id,
          interactions,
          messages,
          turns,
        });

        const access: ThreadAccess = {
          thread,
          projectRole,
          canManage:
            thread.createdByUserId === input.userId ||
            (projectRole !== null && projectRoleAllows(projectRole, "editor")),
          canPublish:
            projectRole === null || projectRoleAllows(projectRole, "editor"),
        };
        const snapshot: ThreadConversationSnapshot = {
          messages: convertToUIMessages(messagesWithAuthors),
          interactions: interactions.map((interaction) => {
            const responseEnvelope = interaction.responseEnvelope;
            const envelopeMessageId =
              responseEnvelope &&
              typeof responseEnvelope === "object" &&
              typeof responseEnvelope.messageId === "string"
                ? responseEnvelope.messageId
                : null;
            const projected = projectSafeThreadInteraction(
              interaction,
                envelopeMessageId ??
                responseMessageIds.get(interaction.requestId) ??
                null,
            );
            return {
              ...projected,
              createdAt: projected.createdAt.toISOString(),
              resolvedAt: projected.resolvedAt?.toISOString() ?? null,
            };
          }),
          turns: turns.map((turn) => ({
            id: turn.id,
            sequence: turn.sequence,
            inputMessageId: turn.inputMessageId,
            status: turn.status,
            failureCode: turn.failureCode,
            failureMessage: turn.failureMessage,
            cancelRequestedAt: turn.cancelRequestedAt?.toISOString() ?? null,
            startedAt: turn.startedAt?.toISOString() ?? null,
            finishedAt: turn.finishedAt?.toISOString() ?? null,
            createdAt: turn.createdAt.toISOString(),
            updatedAt: turn.updatedAt.toISOString(),
          })),
          queue: {
            state: queueState?.state ?? "running",
            pauseReason:
              queueState?.pauseReason === "turn_failed" ||
              queueState?.pauseReason === "turn_cancelled" ||
              queueState?.pauseReason === "interaction_required"
                ? queueState.pauseReason
                : null,
            activeTurnId: queueState?.activeTurnId ?? null,
            version: queueState?.version ?? 0,
          },
        };
        return {
          thread: {
            ...thread,
            messages: messagesWithAuthors,
            emailReceipt:
              emailReceipt?.state === "materialized"
                ? {
                    id: emailReceipt.id,
                    state: emailReceipt.state,
                    receivedAt: emailReceipt.receivedAt,
                    trigger:
                      emailReceipt.triggerId && emailReceipt.triggerName
                        ? {
                            id: emailReceipt.triggerId,
                            name: emailReceipt.triggerName,
                          }
                        : null,
                  }
                : null,
            access,
          },
          snapshot,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (!read?.thread.projectId) return read;

    const approvalPolicies = await resolveRuntimeApprovalPolicies({
      threadId: input.threadId,
      organizationId: input.organizationId,
      projectId: read.thread.projectId,
      userId: input.userId,
      canEditProject:
        read.thread.access.projectRole !== null &&
        projectRoleAllows(read.thread.access.projectRole, "editor"),
      interactions: read.snapshot.interactions,
    });
    if (approvalPolicies.size === 0) return read;
    return {
      ...read,
      snapshot: {
        ...read.snapshot,
        interactions: read.snapshot.interactions.map((interaction) => ({
          ...interaction,
          ...(approvalPolicies.has(interaction.requestId)
            ? { approvalPolicy: approvalPolicies.get(interaction.requestId) }
            : {}),
        })),
      },
    };
  } catch (error) {
    if (error instanceof ThreadConversationSnapshotError) {
      console.error("Thread conversation snapshot rejected.", {
        code: error.code,
        ...error.details,
      });
    }
    throw error;
  }
}

function assertPendingOrdinaryInteractionMessages(input: {
  threadId: string;
  interactions: Array<typeof schema.threadInteractions.$inferSelect>;
  messages: Array<typeof schema.threadMessages.$inferSelect>;
  turns: Array<typeof schema.threadTurns.$inferSelect>;
}) {
  const messagesById = new Map(
    input.messages.map((message) => [message.id, message]),
  );
  const turnIds = new Set(input.turns.map((turn) => turn.id));
  for (const interaction of input.interactions) {
    if (
      interaction.status !== "pending" ||
      interaction.source !== "runtime" ||
      interaction.kind !== "user_input" ||
      parseRunnerStructuredReviewInteractionV1(interaction.requestEnvelope)
        .kind !== "ordinary"
    ) {
      continue;
    }
    const message = interaction.assistantMessageId
      ? messagesById.get(interaction.assistantMessageId)
      : undefined;
    if (
      interaction.turnId === null ||
      !turnIds.has(interaction.turnId) ||
      message?.role !== "assistant" ||
      message.turnId !== interaction.turnId
    ) {
      throw new ThreadConversationSnapshotError(
        "A pending ordinary runtime interaction is missing its assistant message.",
        {
          threadId: input.threadId,
          interactionId: interaction.id,
          requestId: interaction.requestId,
          turnId: interaction.turnId,
          assistantMessageId: interaction.assistantMessageId,
        },
      );
    }
  }
}
