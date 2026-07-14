import "server-only";

import type { UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { createKestrelOneAgentResponse } from "@/lib/agent/kestrel-runtime";
import { prepareKestrelRuntimeMessagesForPersistence } from "@/lib/agent/kestrel-runtime-persistence";
import type { KestrelTerminalStatus } from "@/lib/agent/kestrel-stream-events";
import type { Session } from "@/lib/auth-types";
import { generateTitleFromUserMessage } from "@/lib/chat/actions";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  issueProjectContextGrant,
  revokeProjectContextGrant,
} from "@/lib/projects/context-grants";
import { formatProjectSystemContext } from "@/lib/projects/runtime-context";
import {
  saveThreadMessages,
  updateThreadTitleForUser,
} from "@/lib/threads/store";
import {
  appendDurableTurnEvent,
  bindDurableTurnExecution,
  claimDurableThreadTurn,
  completeDurableThreadTurn,
  isDurableTurnCancellationRequested,
  listMessagesForDurableTurn,
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
  if (status === "failed" || status === "runner_error") {
    return "failed" as const;
  }
  return "completed" as const;
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
      eq(schema.projects.id, schema.projectContextRevisions.projectId)
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

export async function processDurableThreadTurn(turnId: string) {
  const turn = await claimDurableThreadTurn(turnId);
  if (!turn) {
    return { processed: false, nextTurnId: null };
  }

  let projectContext: Awaited<ReturnType<typeof loadBoundProjectContext>> =
    null;
  let eventWrites = Promise.resolve();
  const cancellation = new AbortController();
  const cancellationPoll = setInterval(() => {
    void isDurableTurnCancellationRequested(turn.id).then((requested) => {
      if (requested) {
        cancellation.abort();
      }
    });
  }, 1000);
  let terminalStatus: KestrelTerminalStatus = "runner_error";
  let terminalError: string | null = null;
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
    projectContext = await loadBoundProjectContext(turn);
    const response = await createKestrelOneAgentResponse({
      request: workerRequest(turn.id),
      session,
      organizationId: turn.organizationId,
      environmentId: turn.requestedEnvironmentId,
      threadId: turn.threadId,
      messages,
      modelId: turn.requestedModelId ?? undefined,
      approvalDecision:
        turn.approvalId && turn.approvalApproved !== null
          ? {
              approvalId: turn.approvalId,
              approved: turn.approvalApproved,
              ...(turn.approvalReason ? { reason: turn.approvalReason } : {}),
            }
          : undefined,
      projectContext: projectContext ?? undefined,
      transientTitle: turn.approvalId
        ? null
        : submittedUserMessage
          ? generateTitleFromUserMessage({
              message: submittedUserMessage,
              modelId: turn.requestedModelId ?? undefined,
            }).catch(() => null)
          : null,
      signal: cancellation.signal,
      onExecutionRouted: (executionId) =>
        bindDurableTurnExecution({ turnId: turn.id, executionId }).then(
          () => {}
        ),
      onUiChunk(chunk) {
        eventWrites = eventWrites.then(() =>
          appendDurableTurnEvent({
            turnId: turn.id,
            type: "ui.message",
            data: chunk,
          }).then(() => {})
        );
      },
      onFinishPersist: async (finishedMessages, meta) => {
        await eventWrites;
        terminalStatus = meta.terminalStatus;
        terminalError = meta.errorMessage;
        const messagesForPersistence =
          prepareKestrelRuntimeMessagesForPersistence(finishedMessages, meta);
        const assistantMessages = messagesForPersistence.filter(
          (message): message is UIMessage =>
            message.role === "assistant" &&
            isPersistableAssistantMessage(message)
        );
        await saveThreadMessages(
          assistantMessages.map((message) => ({
            id: message.id,
            threadId: turn.threadId,
            turnId: turn.id,
            role: "assistant" as const,
            authorUserId: null,
            projectContextRevisionId: turn.projectContextRevisionId,
            parts: message.parts,
            model: meta.model,
            source: turn.source,
          }))
        );
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
    const completion = await completeDurableThreadTurn({
      turnId: turn.id,
      status: terminalTurnStatus(terminalStatus),
      failureCode:
        terminalTurnStatus(terminalStatus) === "failed"
          ? "RUNTIME_FAILED"
          : null,
      failureMessage: terminalError,
    });
    return { processed: true, nextTurnId: completion.nextTurnId };
  } catch (error) {
    await eventWrites.catch(() => {});
    const message =
      error instanceof Error ? error.message : "Durable turn execution failed.";
    const completion = await completeDurableThreadTurn({
      turnId: turn.id,
      status: "failed",
      failureCode: "TURN_WORKER_FAILED",
      failureMessage: message,
    });
    return { processed: true, nextTurnId: completion.nextTurnId };
  } finally {
    clearInterval(cancellationPoll);
    if (projectContext) {
      await revokeProjectContextGrant(projectContext.grantId).catch(() => {});
    }
  }
}
