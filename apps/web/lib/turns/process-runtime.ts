import "server-only";

import type {
  KestrelInteractionPresentation,
  KestrelTerminalStatus,
} from "@kestrel-agents/ai-sdk";
import type { UIMessage } from "ai";
import { eq } from "drizzle-orm";
import {
  cancelInterruptedKestrelOneExecution,
  createKestrelOneAgentResponse,
} from "@/lib/agent/kestrel-runtime";
import { prepareKestrelRuntimeMessagesForPersistence } from "@/lib/agent/kestrel-runtime-persistence";
import type { Session } from "@/lib/auth-types";
import { generateTitleForOrganization } from "@/lib/chat/title";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  issueProjectContextGrant,
  revokeProjectContextGrant,
} from "@/lib/projects/context-grants";
import { formatProjectSystemContext } from "@/lib/projects/runtime-context";
import { updateThreadTitleForUser } from "@/lib/threads/store";
import { assertVisibleCompletedOutcome } from "@/lib/turns/outcome-invariant";
import { DURABLE_TURN_STOP_GRACE_MS } from "@/lib/turns/contracts";
import {
  appendDurableTurnEvent,
  claimDurableThreadTurn,
  completeDurableThreadTurn,
  isDurableTurnCancellationRequested,
  listMessagesForDurableTurn,
  persistDurableAssistantOutcome,
  recordMobileTurnActivity,
  recordMobileTurnRuntimeActivity,
} from "@/lib/turns/store";
import {
  convertToUIMessages,
  isPersistableAssistantMessage,
} from "@/lib/utils";

function workerRequest(turnId: string) {
  const baseUrl =
    process.env.KESTREL_ONE_APP_URL?.trim() || "http://localhost:43103";
  return new Request(new URL(`/internal/turn-worker/${turnId}`, baseUrl), {
    headers: {
      "x-correlation-id": turnId,
      "x-request-id": crypto.randomUUID(),
    },
  });
}

async function drainResponse(response: Response) {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) {
      return;
    }
  }
}

function terminalTurnStatus(status: KestrelTerminalStatus) {
  if (status === "cancelled") {
    return "cancelled" as const;
  }
  if (status === "failed" || status === "contract_failure") {
    return "failed" as const;
  }
  if (status === "completed") {
    return "completed" as const;
  }
  return "failed" as const;
}

async function loadWorkerSession(userId: string): Promise<Session> {
  const user = await knowledgeDb.query.users.findFirst({
    where: eq(schema.users.id, userId),
  });
  if (!user) {
    throw new Error("The durable turn author no longer exists.");
  }
  return {
    user,
    session: {
      id: `durable-turn:${crypto.randomUUID()}`,
      userId,
      token: "server-owned-durable-turn",
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ipAddress: null,
      userAgent: "kestrel-one-turn-worker",
      activeOrganizationId: null,
      impersonatedBy: null,
    },
  } as unknown as Session;
}

async function loadBoundProjectContext(turn: {
  id: string;
  threadId: string;
  organizationId: string;
  authorUserId: string;
  projectContextRevisionId: string | null;
}) {
  if (!turn.projectContextRevisionId) {
    return null;
  }
  const [bound] = await knowledgeDb
    .select({
      projectId: schema.projects.id,
      organizationId: schema.projects.organizationId,
      revisionId: schema.projectContextRevisions.id,
      revision: schema.projectContextRevisions.revision,
      projectName: schema.projectContextRevisions.projectName,
      instructions: schema.projectContextRevisions.instructions,
    })
    .from(schema.projectContextRevisions)
    .innerJoin(
      schema.projects,
      eq(schema.projects.id, schema.projectContextRevisions.projectId),
    )
    .where(eq(schema.projectContextRevisions.id, turn.projectContextRevisionId))
    .limit(1);
  if (!(bound && bound.organizationId === turn.organizationId)) {
    throw new Error("The bound Project context revision is unavailable.");
  }
  const grant = await issueProjectContextGrant({
    organizationId: turn.organizationId,
    projectId: bound.projectId,
    threadId: turn.threadId,
    actorUserId: turn.authorUserId,
    contextRevisionId: bound.revisionId,
    contextRevision: bound.revision,
  });
  return {
    grantId: grant.grantId,
    projectId: bound.projectId,
    contextRevisionId: bound.revisionId,
    contextRevision: bound.revision,
    systemContext: formatProjectSystemContext({
      projectName: bound.projectName,
      instructions: bound.instructions,
      revision: bound.revision,
    }),
  };
}

export async function processDurableThreadTurn(
  turnId: string,
  options: { retryCount?: number; workerSignal?: AbortSignal } = {},
) {
  if ((options.retryCount ?? 0) > 0) {
    const interrupted = await knowledgeDb.query.threadTurns.findFirst({
      where: eq(schema.threadTurns.id, turnId),
      columns: {
        status: true,
        organizationId: true,
        environmentExecutionId: true,
        cancelRequestedAt: true,
      },
    });
    if (interrupted?.status === "running") {
      if (interrupted.environmentExecutionId) {
        await cancelInterruptedKestrelOneExecution({
          organizationId: interrupted.organizationId,
          executionId: interrupted.environmentExecutionId,
        }).catch((error) => {
          console.error(
            "Interrupted Environment execution cancellation failed.",
            {
              turnId,
              executionId: interrupted.environmentExecutionId,
              message: error instanceof Error ? error.message : "Unknown error",
            },
          );
        });
      }
      const stopped = Boolean(interrupted.cancelRequestedAt);
      const completion = await completeDurableThreadTurn({
        turnId,
        status: stopped ? "cancelled" : "failed",
        failureCode: stopped ? "TURN_STOPPED" : "TURN_WORKER_INTERRUPTED",
        failureMessage: stopped
          ? null
          : "The Kestrel agent was interrupted before this turn finished. Please try again.",
      });
      return { processed: true, nextTurnId: completion.nextTurnId };
    }
  }
  const turn = await claimDurableThreadTurn(turnId);
  if (!turn) {
    return { processed: false, nextTurnId: null };
  }

  let projectContext: Awaited<ReturnType<typeof loadBoundProjectContext>> =
    null;
  let eventWrites = Promise.resolve();
  let persistedAssistantMessageCount = 0;
  let environmentExecutionId = turn.environmentExecutionId;
  let runtimeStartedRecorded = false;
  let runtimeStartedEventId: string | null = null;
  let effectiveInteractionMode: string | null = null;
  const cancellation = new AbortController();
  let cancellationRequested = false;
  let workerInterrupted = false;
  let cancellationDeadline: ReturnType<typeof setTimeout> | null = null;
  const scheduleCancellationDeadline = () => {
    if (cancellationDeadline || cancellation.signal.aborted) return;
    cancellationDeadline = setTimeout(() => {
      cancellation.abort(
        new Error(
          "The user interrupted this turn after the safe-boundary deadline.",
        ),
      );
    }, DURABLE_TURN_STOP_GRACE_MS);
  };
  const cancellationPoll = setInterval(() => {
    void isDurableTurnCancellationRequested(turn.id)
      .then((requested) => {
        if (requested) {
          cancellationRequested = true;
          scheduleCancellationDeadline();
        }
      })
      .catch(() => {});
  }, 1000);
  const interruptForWorkerLoss = () => {
    workerInterrupted = true;
    cancellation.abort(new Error("The durable turn worker lease ended."));
  };
  if (options.workerSignal?.aborted) interruptForWorkerLoss();
  else
    options.workerSignal?.addEventListener("abort", interruptForWorkerLoss, {
      once: true,
    });
  const terminal: {
    status: KestrelTerminalStatus;
    error: string | null;
    interaction: KestrelInteractionPresentation | null;
  } = {
    status: "contract_failure",
    error: null,
    interaction: null,
  };
  try {
    const [session, storedMessages] = await Promise.all([
      loadWorkerSession(turn.authorUserId),
      listMessagesForDurableTurn(turn.id),
    ]);
    const messages = convertToUIMessages(storedMessages);
    const submittedUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    if (!turn.requestedEnvironmentId) {
      throw new Error("Durable turn is missing its requested Environment.");
    }
    await recordMobileTurnActivity({
      turnId: turn.id,
      stage: "reading_context",
      milestoneId: `turn:${turn.id}:context`,
    });
    projectContext = await loadBoundProjectContext(turn);
    const response = await createKestrelOneAgentResponse({
      request: workerRequest(turn.id),
      session,
      organizationId: turn.organizationId,
      environmentId: turn.requestedEnvironmentId,
      threadId: turn.threadId,
      durableTurnId: turn.id,
      messages,
      modelId: turn.requestedModelId ?? undefined,
      interactionMode: turn.requestedInteractionMode,
      approvalDecision:
        turn.approvalId && turn.approvalApproved !== null
          ? {
              approvalId: turn.approvalId,
              approved: turn.approvalApproved,
              ...(turn.approvalReason ? { reason: turn.approvalReason } : {}),
            }
          : undefined,
      interactionResponse: turn.interactionResponse ?? undefined,
      projectContext: projectContext ?? undefined,
      transientTitle: turn.approvalId
        ? null
        : submittedUserMessage
          ? generateTitleForOrganization({
              message: submittedUserMessage,
              modelId: turn.requestedModelId ?? undefined,
              organizationId: turn.organizationId,
            }).catch(() => null)
          : null,
      signal: cancellation.signal,
      onExecutionRouted: (executionId) => {
        environmentExecutionId = executionId;
      },
      onRuntimeEvent(event) {
        eventWrites = eventWrites.then(async () => {
          try {
            if (event.type === "run.started") {
              runtimeStartedEventId = event.id;
              effectiveInteractionMode = event.payload.interactionMode ?? null;
            }
            if (
              !runtimeStartedRecorded &&
              environmentExecutionId &&
              event.runId
            ) {
              await appendDurableTurnEvent({
                turnId: turn.id,
                type: "runtime.started",
                data: {
                  eventId: runtimeStartedEventId ?? event.id,
                  executionId: environmentExecutionId,
                  runtimeRunId: event.runId,
                  requestedInteractionMode: turn.requestedInteractionMode,
                  effectiveInteractionMode,
                },
              });
              runtimeStartedRecorded = true;
            }
            if (event.type === "run.started") return;
            await recordMobileTurnRuntimeActivity({
              turnId: turn.id,
              eventId: event.id,
              eventType: event.type,
              progressCode:
                event.type === "run.progress"
                  ? event.payload.update.code
                  : undefined,
            });
          } catch {
            // Runtime telemetry is best effort and must not fail the turn.
          }
        });
        if (cancellationRequested && isSafeInterruptBoundary(event.type)) {
          cancellation.abort(
            new Error("The user interrupted this turn at a safe boundary."),
          );
        }
      },
      onUiChunk(chunk) {
        eventWrites = eventWrites.then(() =>
          appendDurableTurnEvent({
            turnId: turn.id,
            type: "ui.message",
            data: chunk,
          }).then(() => {}),
        );
      },
      onFinishPersist: async (finishedMessages, meta) => {
        await eventWrites;
        terminal.status = meta.terminalStatus;
        terminal.error = meta.errorMessage;
        terminal.interaction = meta.interaction;
        const messagesForPersistence =
          prepareKestrelRuntimeMessagesForPersistence(finishedMessages, meta);
        const assistantMessages = messagesForPersistence.filter(
          (message): message is UIMessage =>
            message.role === "assistant" &&
            isPersistableAssistantMessage(message),
        );
        persistedAssistantMessageCount = assistantMessages.length;
        await persistDurableAssistantOutcome({
          turnId: turn.id,
          interaction: meta.interaction,
          messages: assistantMessages.map((message) => ({
            id: message.id,
            projectContextRevisionId: turn.projectContextRevisionId,
            parts: message.parts,
            model: meta.model,
            source: turn.source,
          })),
        });
        if (meta.title) {
          await updateThreadTitleForUser({
            id: turn.threadId,
            userId: turn.authorUserId,
            organizationId: turn.organizationId,
            title: meta.title,
          });
        }
      },
    });
    await drainResponse(response);
    await eventWrites;
    assertVisibleCompletedOutcome(
      terminal.status,
      persistedAssistantMessageCount,
    );
    if (terminal.status === "waiting" && terminal.interaction) {
      return { processed: true, nextTurnId: null };
    }
    const completionStatus = workerInterrupted
      ? "failed"
      : terminalTurnStatus(terminal.status);
    const completion = await completeDurableThreadTurn({
      turnId: turn.id,
      status: completionStatus,
      failureCode: workerInterrupted
        ? "TURN_WORKER_INTERRUPTED"
        : completionStatus === "failed"
          ? terminal.status === "contract_failure"
            ? "PRESENTATION_CONTRACT_FAILURE"
            : "RUNTIME_FAILED"
          : null,
      failureMessage: terminal.error,
    });
    return { processed: true, nextTurnId: completion.nextTurnId };
  } catch (error) {
    await eventWrites.catch(() => {});
    const message =
      error instanceof Error ? error.message : "Durable turn execution failed.";
    const visibleFailure = prepareKestrelRuntimeMessagesForPersistence([], {
      errorMessage: message,
      failureVisible: false,
    }).filter(
      (candidate): candidate is UIMessage =>
        candidate.role === "assistant" &&
        isPersistableAssistantMessage(candidate),
    );
    await persistDurableAssistantOutcome({
      turnId: turn.id,
      interaction: null,
      messages: visibleFailure.map((assistantMessage) => ({
        id: assistantMessage.id,
        projectContextRevisionId: turn.projectContextRevisionId,
        parts: assistantMessage.parts,
        model: turn.requestedModelId ?? "unknown",
        source: turn.source,
      })),
    });
    const stopped =
      cancellationRequested ||
      (await isDurableTurnCancellationRequested(turn.id).catch(() => false));
    const completion = await completeDurableThreadTurn({
      turnId: turn.id,
      status: stopped ? "cancelled" : "failed",
      failureCode: stopped
        ? "TURN_STOPPED"
        : workerInterrupted
          ? "TURN_WORKER_INTERRUPTED"
          : "TURN_WORKER_FAILED",
      failureMessage: stopped ? null : message,
    });
    return { processed: true, nextTurnId: completion.nextTurnId };
  } finally {
    clearInterval(cancellationPoll);
    if (cancellationDeadline) clearTimeout(cancellationDeadline);
    options.workerSignal?.removeEventListener("abort", interruptForWorkerLoss);
    if (projectContext) {
      await revokeProjectContextGrant(projectContext.grantId).catch(() => {});
    }
  }
}

function isSafeInterruptBoundary(eventType: string) {
  return (
    eventType === "run.started" ||
    eventType === "run.model.completed" ||
    eventType === "run.model.failed" ||
    eventType === "run.tool.completed" ||
    eventType === "run.tool.failed"
  );
}
