import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";

import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { assertRuntimeAdmissionReady } from "@/lib/runtimes/descriptor-service";
import { assertRuntimeReleased } from "@/lib/runtimes/release-gate";
import {
  getThreadAccessForUser,
  getThreadWithMessagesForUser,
} from "@/lib/threads/store";
import {
  readLostRuntimeInteractionPresentation,
  stripLostRuntimeInteractionParts,
} from "@/lib/threads/runtime-recovery-sanitizer";
import { selectForeignRuntimeRecoveryRoute } from "@/lib/threads/runtime-recovery-route";

export type RuntimeRecoveryFailureCode =
  | "RUNTIME_NATIVE_SESSION_LOST"
  | "RUNTIME_LIVE_WAIT_LOST";

export class RuntimeRecoveryError extends Error {
  readonly code = "RUNTIME_RECOVERY_UNAVAILABLE";
  readonly status = 409;
}

export async function createRuntimeRecoveryFork(input: {
  sourceThreadId: string;
  organizationId: string;
  userId: string;
  failureCode: RuntimeRecoveryFailureCode;
}) {
  const access = await getThreadAccessForUser(
    input.sourceThreadId,
    input.userId,
    input.organizationId,
    true,
  );
  if (!access?.canManage) throw new RuntimeRecoveryError("Thread not found.");
  const source = await getThreadWithMessagesForUser(
    input.sourceThreadId,
    input.userId,
    input.organizationId,
    true,
  );
  if (!source?.runtimeBindingId) {
    throw new RuntimeRecoveryError("The source Runtime binding is unavailable.");
  }
  const latestTurn = await knowledgeDb.query.threadTurns.findFirst({
    where: eq(schema.threadTurns.threadId, source.id),
    orderBy: [desc(schema.threadTurns.sequence)],
  });
  if (
    !latestTurn ||
    latestTurn.status !== "failed" ||
    latestTurn.failureCode !== input.failureCode
  ) {
    throw new RuntimeRecoveryError(
      "The requested loss is not the latest terminal Thread outcome.",
    );
  }
  const sourceBinding = await knowledgeDb.query.runtimeBindings.findFirst({
    where: and(
      eq(schema.runtimeBindings.id, source.runtimeBindingId),
      eq(schema.runtimeBindings.threadId, source.id),
      eq(schema.runtimeBindings.runtimeId, source.runtimeId),
    ),
  });
  if (!sourceBinding) {
    throw new RuntimeRecoveryError("The source Runtime binding changed.");
  }
  const existingThreadId = await findRuntimeRecoveryForkId({
    sourceBindingId: sourceBinding.id,
    failureCode: input.failureCode,
  });
  if (existingThreadId) {
    return requireRecoveryThread(existingThreadId, input);
  }

  const targetRuntimeId = input.failureCode === "RUNTIME_NATIVE_SESSION_LOST"
    ? "kestrel"
    : source.runtimeId;
  assertRuntimeReleased(targetRuntimeId);
  // Readiness is intentionally outside the product transaction. The browser
  // never supplies this proof; the transaction below revalidates the source
  // loss and immutable Runtime/model identity. The fresh descriptor owns the
  // new binding's Environment and capability route.
  const runtimeResolution = targetRuntimeId === "kestrel"
    ? undefined
    : await assertRuntimeAdmissionReady({
        organizationId: input.organizationId,
        userId: input.userId,
        runtimeId: targetRuntimeId,
        modelId: sourceBinding.selectedModelId ?? undefined,
        projectId: source.projectId,
      });
  const targetRoute = runtimeResolution && targetRuntimeId !== "kestrel"
    ? selectForeignRuntimeRecoveryRoute({
        targetRuntimeId,
        sourceRuntimeId: sourceBinding.runtimeId,
        sourceSelectedModelId: sourceBinding.selectedModelId,
        resolution: runtimeResolution,
      })
    : null;
  if (runtimeResolution && !targetRoute) {
    throw new RuntimeRecoveryError(
      "Runtime readiness no longer matches the source binding Runtime and model.",
    );
  }
  const targetId = crypto.randomUUID();

  try {
    const committedTargetId = await knowledgeDb.transaction(async (tx) => {
      const [lockedSource] = await tx
        .select()
        .from(schema.threads)
        .where(and(
          eq(schema.threads.id, source.id),
          eq(schema.threads.organizationId, input.organizationId),
          eq(schema.threads.runtimeBindingId, sourceBinding.id),
          eq(schema.threads.runtimeId, sourceBinding.runtimeId),
        ))
        .limit(1)
        .for("update");
      const [lockedBinding] = await tx
        .select()
        .from(schema.runtimeBindings)
        .where(and(
          eq(schema.runtimeBindings.id, sourceBinding.id),
          eq(schema.runtimeBindings.threadId, source.id),
          eq(schema.runtimeBindings.runtimeId, source.runtimeId),
        ))
        .limit(1)
        .for("update");
      const [lockedLatestTurn] = await tx
        .select()
        .from(schema.threadTurns)
        .where(eq(schema.threadTurns.threadId, source.id))
        .orderBy(desc(schema.threadTurns.sequence))
        .limit(1)
        .for("update");
      if (
        !(lockedSource && lockedBinding && lockedLatestTurn) ||
        lockedLatestTurn.id !== latestTurn.id ||
        lockedLatestTurn.status !== "failed" ||
        lockedLatestTurn.failureCode !== input.failureCode ||
        lockedBinding.status === "released" ||
        lockedBinding.nativeSessionState === "released"
      ) {
        throw new RuntimeRecoveryError("The source Thread changed during recovery.");
      }
      const existingBinding = await tx.query.runtimeBindings.findFirst({
        where: and(
          eq(schema.runtimeBindings.recoverySourceBindingId, sourceBinding.id),
          eq(schema.runtimeBindings.recoveryFailureCode, input.failureCode),
        ),
      });
      if (existingBinding) return existingBinding.threadId;
      if (
        targetRoute &&
        (lockedBinding.runtimeId !== targetRuntimeId ||
          lockedBinding.selectedModelId !== targetRoute.selectedModelId)
      ) {
        throw new RuntimeRecoveryError(
          "Runtime readiness no longer matches the locked source Runtime and model.",
        );
      }
      const lostInteractions = input.failureCode === "RUNTIME_LIVE_WAIT_LOST"
        ? await tx
            .select({
              requestId: schema.threadInteractions.requestId,
              assistantMessageId: schema.threadInteractions.assistantMessageId,
              responseEnvelope: schema.threadInteractions.responseEnvelope,
            })
            .from(schema.runtimeInteractionDeliveries)
            .innerJoin(
              schema.threadInteractions,
              and(
                eq(
                  schema.threadInteractions.id,
                  schema.runtimeInteractionDeliveries.interactionId,
                ),
                eq(schema.threadInteractions.turnId, lockedLatestTurn.id),
                eq(schema.threadInteractions.source, "runtime"),
              ),
            )
            .where(
              and(
                eq(
                  schema.runtimeInteractionDeliveries.bindingId,
                  sourceBinding.id,
                ),
                eq(
                  schema.runtimeInteractionDeliveries.turnId,
                  lockedLatestTurn.id,
                ),
                eq(schema.runtimeInteractionDeliveries.state, "failed"),
                eq(
                  schema.runtimeInteractionDeliveries.failureCode,
                  "RUNTIME_LIVE_WAIT_LOST",
                ),
              ),
            )
            .orderBy(
              desc(schema.runtimeInteractionDeliveries.updatedAt),
              desc(schema.runtimeInteractionDeliveries.id),
            )
            .limit(2)
        : [];
      if (
        input.failureCode === "RUNTIME_LIVE_WAIT_LOST" &&
        lostInteractions.length !== 1
      ) {
        throw new RuntimeRecoveryError(
          "The lost Runtime interaction could not be identified exactly.",
        );
      }
      const lostPresentation = readLostRuntimeInteractionPresentation(
        lostInteractions,
      );
      const messages = await tx
        .select()
        .from(schema.threadMessages)
        .where(eq(schema.threadMessages.threadId, source.id))
        .orderBy(
          asc(schema.threadMessages.createdAt),
          asc(schema.threadMessages.id),
        );
      const releaseExecution = sourceBinding.runtimeId === "kestrel"
        ? undefined
        : await tx.query.environmentRunExecutions.findFirst({
            where: and(
              eq(schema.environmentRunExecutions.threadId, source.id),
              ...(sourceBinding.environmentId
                ? [eq(
                    schema.environmentRunExecutions.environmentId,
                    sourceBinding.environmentId,
                  )]
                : []),
            ),
            orderBy: [desc(schema.environmentRunExecutions.createdAt)],
          });
      if (sourceBinding.runtimeId !== "kestrel" && !releaseExecution) {
        throw new RuntimeRecoveryError(
          "The source Environment release route is unavailable.",
        );
      }

      const now = new Date();
      const participantId = `runtime:${input.organizationId}:${targetRuntimeId}`;
      const targetBindingId = `binding:${targetId}`;
      await tx
        .insert(schema.runtimeParticipants)
        .values({
          id: participantId,
          organizationId: input.organizationId,
          runtimeId: targetRuntimeId,
          displayName: targetRuntimeId === "kestrel"
            ? "Kestrel"
            : targetRuntimeId === "codex"
              ? "Codex"
              : "Claude Code",
          createdAt: now,
        })
        .onConflictDoNothing();
      await tx.insert(schema.threads).values({
        id: targetId,
        createdByUserId: input.userId,
        organizationId: input.organizationId,
        projectId: lockedSource.projectId,
        parentThreadId: lockedSource.id,
        mode: lockedSource.mode,
        origin: lockedSource.origin,
        title: `${lockedSource.title || "New thread"} recovery`,
        interactionMode: lockedSource.interactionMode,
        runtimeId: targetRuntimeId,
        runtimeBindingId: targetBindingId,
        isPublic: false,
        shareToken: null,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(schema.runtimeBindings).values({
        id: targetBindingId,
        threadId: targetId,
        participantId,
        runtimeId: targetRuntimeId,
        adapterContractVersion: 1,
        capabilityDigest: targetRoute?.capabilityDigest ?? null,
        environmentId: targetRoute?.environmentId ?? sourceBinding.environmentId,
        selectedModelId:
          targetRoute?.selectedModelId ?? sourceBinding.selectedModelId,
        recoverySourceBindingId: sourceBinding.id,
        recoveryFailureCode: input.failureCode,
        recoverySourceTurnId: latestTurn.id,
        status: "ready",
        nativeSessionState: targetRuntimeId === "kestrel" ? "ready" : "uninitialized",
        createdAt: now,
        updatedAt: now,
      });
      const visibleMessages = messages.flatMap((message) => {
        if (lostPresentation.responseMessageIds.has(message.id)) return [];
        const requestIds = lostPresentation.requestsByAssistantMessage.get(
          message.id,
        );
        if (!requestIds) return [message];
        const parts = stripLostRuntimeInteractionParts(message.parts, requestIds);
        return parts.length > 0 ? [{ ...message, parts }] : [];
      });
      if (visibleMessages.length > 0) {
        await tx.insert(schema.threadMessages).values(
          visibleMessages.map((message, index) => ({
            id: crypto.randomUUID(),
            threadId: targetId,
            turnId: null,
            role: message.role,
            authorUserId: message.authorUserId,
            projectContextRevisionId: message.projectContextRevisionId,
            parts: message.parts,
            searchText: message.searchText,
            source: message.source,
            sourceMessageId: message.id,
            createdAt: new Date(now.getTime() + index),
          })),
        );
      }
      await tx
        .update(schema.runtimeBindings)
        .set({
          status: "degraded",
          nativeSessionState: "degraded",
          updatedAt: now,
        })
        .where(eq(schema.runtimeBindings.id, sourceBinding.id));
      if (releaseExecution && sourceBinding.runtimeId !== "kestrel") {
        await tx
          .insert(schema.runtimeBindingReleaseOutbox)
          .values({
            id: crypto.randomUUID(),
            organizationId: input.organizationId,
            runtimeId: sourceBinding.runtimeId,
            bindingId: sourceBinding.id,
            participantId: sourceBinding.participantId,
            threadId: source.id,
            environmentId: releaseExecution.environmentId,
            workspaceId: releaseExecution.workspaceId,
            actorUserId: releaseExecution.actorId,
            idempotencyKey: `runtime-release:${sourceBinding.id}`,
            state: "pending",
            attempts: 0,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: schema.runtimeBindingReleaseOutbox.idempotencyKey,
          });
      }
      if (lockedSource.projectId) {
        await tx.insert(schema.projectAuditEvents).values({
          id: crypto.randomUUID(),
          projectId: lockedSource.projectId,
          actorUserId: input.userId,
          action: "thread.created",
          targetType: "thread",
          targetId,
          createdAt: now,
        });
      }
      return targetId;
    });
    return requireRecoveryThread(committedTargetId, input);
  } catch (error) {
    const racedThreadId = await findRuntimeRecoveryForkId({
      sourceBindingId: sourceBinding.id,
      failureCode: input.failureCode,
    });
    if (racedThreadId) return requireRecoveryThread(racedThreadId, input);
    throw error;
  }
}

async function findRuntimeRecoveryForkId(input: {
  sourceBindingId: string;
  failureCode: RuntimeRecoveryFailureCode;
}) {
  const binding = await knowledgeDb.query.runtimeBindings.findFirst({
    where: and(
      eq(schema.runtimeBindings.recoverySourceBindingId, input.sourceBindingId),
      eq(schema.runtimeBindings.recoveryFailureCode, input.failureCode),
    ),
    columns: { threadId: true },
  });
  return binding?.threadId;
}

async function requireRecoveryThread(
  threadId: string,
  input: Pick<
    Parameters<typeof createRuntimeRecoveryFork>[0],
    "userId" | "organizationId"
  >,
) {
  const thread = await getThreadWithMessagesForUser(
    threadId,
    input.userId,
    input.organizationId,
    true,
  );
  if (!thread) throw new RuntimeRecoveryError("The recovery fork is unavailable.");
  return thread;
}
