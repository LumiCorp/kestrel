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
  createKestrelOneReattachmentResponse,
  type KestrelOneAgentResponseInput,
} from "@/lib/agent/kestrel-runtime";
import {
  appendKestrelUiChunkIfDurable,
  buildKestrelFailureReplayChunks,
  isLiveOnlyKestrelUiChunk,
  prepareKestrelRuntimeMessagesForPersistence,
  readKestrelReplayScaffoldChunk,
  readTerminalKestrelUiChunk,
} from "@/lib/agent/kestrel-runtime-persistence";
import type { Session } from "@/lib/auth-types";
import { generateTitleForOrganization } from "@/lib/chat/title";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { resolveActiveProjectWorkflowContext } from "@/lib/apps/project-service";
import {
  issueProjectContextGrant,
  revokeProjectContextGrant,
} from "@/lib/projects/context-grants";
import { formatProjectSystemContext } from "@/lib/projects/runtime-context";
import {
  updateThreadInteractionModeForUser,
  updateThreadTitleForUser,
} from "@/lib/threads/store";
import { assertVisibleCompletedOutcome } from "@/lib/turns/outcome-invariant";
import { DURABLE_TURN_STOP_GRACE_MS } from "@/lib/turns/contracts";
import {
  appendDurableTurnEvent,
  claimDurableThreadTurn,
  completeDurableThreadTurn,
  type DurableAssistantOutcomeMessage,
  type DurableReplayChunk,
  getDurableTurn,
  getDurableTurnOpenReplayScaffold,
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

const TITLE_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,119}$/u;

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

function assistantText(message: UIMessage) {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function buildFailurePresentation(input: {
  errorMessage: string;
  status: "failed" | "cancelled";
  turn: {
    id: string;
    projectContextRevisionId: string | null;
    requestedModelId: string | null;
    source: "web" | "mobile" | "api";
  };
  assistantMessageId: string | null;
  textPartId: string | null;
}) {
  const [generated] = (
    input.status === "cancelled"
      ? [
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            parts: [
              {
                type: "text" as const,
                text: "The response was stopped before completion.",
              },
            ],
          },
        ]
      : prepareKestrelRuntimeMessagesForPersistence([], {
          errorMessage: input.errorMessage,
          failureVisible: false,
        })
  ).filter(
    (candidate): candidate is UIMessage =>
      candidate.role === "assistant" &&
      isPersistableAssistantMessage(candidate),
  );
  if (!generated) {
    throw new Error("The durable failure presentation could not be created.");
  }
  const messageId = input.assistantMessageId ?? generated.id;
  const message = { ...generated, id: messageId };
  const textPartId = input.textPartId ?? crypto.randomUUID();
  const messages: DurableAssistantOutcomeMessage[] = [
    {
      id: message.id,
      projectContextRevisionId: input.turn.projectContextRevisionId,
      parts: message.parts,
      model: input.turn.requestedModelId ?? "unknown",
      inputTokens: undefined,
      cachedInputTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
      durationMs: undefined,
      source: input.turn.source,
    },
  ];
  return {
    messages,
    replayChunks: buildKestrelFailureReplayChunks({
      assistantMessageId: message.id,
      textPartId,
      turnId: input.turn.id,
      status: input.status,
      text: assistantText(message),
      errorMessage: input.status === "failed" ? input.errorMessage : null,
      includeStart: input.assistantMessageId === null,
      includeTextStart: input.textPartId === null,
    }) as DurableReplayChunk[],
  };
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
  const workflowContext = await resolveActiveProjectWorkflowContext({
    organizationId: turn.organizationId,
    projectId: bound.projectId,
    userId: turn.authorUserId,
  });
  const projectSystemContext = formatProjectSystemContext({
    projectName: bound.projectName,
    instructions: bound.instructions,
    revision: bound.revision,
  });
  return {
    grantId: grant.grantId,
    projectId: bound.projectId,
    contextRevisionId: bound.revisionId,
    contextRevision: bound.revision,
    systemContext: workflowContext
      ? `${projectSystemContext}\n\n${workflowContext}`
      : projectSystemContext,
  };
}

export async function processDurableThreadTurn(
  turnId: string,
  options: { retryCount?: number; workerSignal?: AbortSignal } = {},
) {
  let reattachExecutionId: string | null = null;
  if ((options.retryCount ?? 0) > 0) {
    const interrupted = await knowledgeDb.query.threadTurns.findFirst({
      where: eq(schema.threadTurns.id, turnId),
      columns: {
        status: true,
        organizationId: true,
        environmentExecutionId: true,
        cancelRequestedAt: true,
        projectContextRevisionId: true,
        requestedModelId: true,
        source: true,
      },
    });
    if (interrupted?.status === "running") {
      if (interrupted.cancelRequestedAt && interrupted.environmentExecutionId) {
        const confirmed = await cancelInterruptedKestrelOneExecution({
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
        if (confirmed !== true) {
          throw new Error(
            "Interrupted cancellation remains active pending terminal runtime confirmation.",
          );
        }
      }
      const stopped = Boolean(interrupted.cancelRequestedAt);
      if (!stopped && interrupted.environmentExecutionId) {
        reattachExecutionId = interrupted.environmentExecutionId;
        await appendDurableTurnEvent({
          turnId,
          type: "turn.activity",
          data: {
            stage: "runtime.reconnecting",
            message:
              "Connection interrupted; reconnecting to the running agent.",
            executionId: reattachExecutionId,
          },
        });
      }
      if (!stopped && reattachExecutionId) {
        // The execution remains owned by the durable runner. Continue below
        // with journal reattachment; never replay the original run.start.
      } else {
        const failureMessage = stopped
          ? "The user stopped this turn before it finished."
          : "The connection to the agent was interrupted before completion.";
        const scaffold = await getDurableTurnOpenReplayScaffold(turnId);
        const presentation = buildFailurePresentation({
          errorMessage: failureMessage,
          status: stopped ? "cancelled" : "failed",
          turn: {
            id: turnId,
            projectContextRevisionId: interrupted.projectContextRevisionId,
            requestedModelId: interrupted.requestedModelId,
            source: interrupted.source,
          },
          assistantMessageId: scaffold.assistantMessageId,
          textPartId: scaffold.textPartId,
        });
        const completion = await completeDurableThreadTurn({
          turnId,
          status: stopped ? "cancelled" : "failed",
          messages: presentation.messages,
          replayChunks: presentation.replayChunks,
          failureCode: stopped ? "TURN_STOPPED" : "TURN_WORKER_INTERRUPTED",
          failureMessage: stopped ? null : failureMessage,
        });
        return { processed: true, nextTurnId: completion.nextTurnId };
      }
    }
  }
  const turn = reattachExecutionId
    ? await claimDurableThreadTurn(turnId, { resumeRunning: true })
    : await claimDurableThreadTurn(turnId);
  if (!turn) {
    return { processed: false, nextTurnId: null };
  }

  let projectContext: Awaited<ReturnType<typeof loadBoundProjectContext>> =
    null;
  let eventWrites = Promise.resolve();
  let persistedAssistantMessageCount = 0;
  let environmentExecutionId = turn.environmentExecutionId;
  let runtimeStartedRecorded = false;
  let runtimeTerminalObserved = false;
  let runtimeStartedEvent: {
    eventId: string;
    runtimeRunId: string;
    effectiveInteractionMode: string | null;
  } | null = null;
  const recordRuntimeStarted = async () => {
    if (
      runtimeStartedRecorded ||
      !environmentExecutionId ||
      !runtimeStartedEvent
    ) {
      return;
    }
    await appendDurableTurnEvent({
      turnId: turn.id,
      type: "runtime.started",
      data: {
        eventId: runtimeStartedEvent.eventId,
        executionId: environmentExecutionId,
        runtimeRunId: runtimeStartedEvent.runtimeRunId,
        requestedInteractionMode: turn.requestedInteractionMode,
        effectiveInteractionMode: runtimeStartedEvent.effectiveInteractionMode,
      },
    });
    runtimeStartedRecorded = true;
  };
  const cancellation = new AbortController();
  let cancellationRequested = false;
  let runtimeCancellationSent = false;
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
          if (environmentExecutionId && !runtimeCancellationSent) {
            runtimeCancellationSent = true;
            void cancelInterruptedKestrelOneExecution({
              organizationId: turn.organizationId,
              executionId: environmentExecutionId,
            }).catch(() => {});
          }
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
    errorCode: string | null;
    interaction: KestrelInteractionPresentation | null;
    messages: DurableAssistantOutcomeMessage[];
    replayChunks: DurableReplayChunk[];
    assistantMessageId: string | null;
    textPartId: string | null;
  } = {
    status: "contract_failure",
    error: null,
    errorCode: null,
    interaction: null,
    messages: [],
    replayChunks: [],
    assistantMessageId: null,
    textPartId: null,
  };
  let waitingCommitted = false;
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
    const responseInput: KestrelOneAgentResponseInput = {
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
              environmentId: turn.requestedEnvironmentId,
            }).catch(async (error: unknown) => {
              const code =
                error &&
                typeof error === "object" &&
                "code" in error &&
                typeof error.code === "string" &&
                TITLE_FAILURE_CODE_PATTERN.test(error.code)
                  ? error.code
                  : "TITLE_GENERATION_FAILED";
              console.error("Kestrel One title generation failed.", {
                turnId: turn.id,
                threadId: turn.threadId,
                organizationId: turn.organizationId,
                environmentId: turn.requestedEnvironmentId,
                code,
              });
              await appendDurableTurnEvent({
                turnId: turn.id,
                type: "turn.activity",
                data: { stage: "thread.title.failed", code },
              }).catch(() => {});
              return null;
            })
          : null,
      signal: cancellation.signal,
      abortBehavior: "detach",
      onExecutionRouted: (executionId) => {
        environmentExecutionId = executionId;
        eventWrites = eventWrites.then(recordRuntimeStarted);
      },
      onRuntimeEvent(event) {
        if (
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled"
        ) {
          runtimeTerminalObserved = true;
        }
        eventWrites = eventWrites.then(async () => {
          try {
            if (event.type === "run.started") {
              if (event.runId) {
                runtimeStartedEvent = {
                  eventId: event.id,
                  runtimeRunId: event.runId,
                  effectiveInteractionMode:
                    event.payload.interactionMode ?? null,
                };
              }
              await recordRuntimeStarted();
              return;
            }
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
        if (workerInterrupted) {
          return;
        }
        const scaffold = readKestrelReplayScaffoldChunk(chunk);
        if (scaffold.assistantMessageId) {
          terminal.assistantMessageId = scaffold.assistantMessageId;
        }
        if (scaffold.textPartId) {
          terminal.textPartId = scaffold.textPartId;
        }
        const terminalChunk = readTerminalKestrelUiChunk(chunk);
        if (terminalChunk) {
          terminal.replayChunks.push(terminalChunk as DurableReplayChunk);
          return;
        }
        if (isLiveOnlyKestrelUiChunk(chunk)) {
          return;
        }
        eventWrites = eventWrites.then(() =>
          appendKestrelUiChunkIfDurable(chunk, async (durableChunk) => {
            await appendDurableTurnEvent({
              turnId: turn.id,
              type: "ui.message",
              data: durableChunk,
            });
          }).then(() => {}),
        );
      },
      onFinishPersist: async (finishedMessages, meta) => {
        await eventWrites;
        terminal.status = meta.terminalStatus;
        terminal.error = meta.errorMessage;
        terminal.errorCode = meta.errorCode ?? null;
        terminal.interaction = meta.interaction;
        const messagesForPersistence =
          prepareKestrelRuntimeMessagesForPersistence(finishedMessages, meta);
        const assistantMessages = messagesForPersistence.filter(
          (message): message is UIMessage =>
            message.role === "assistant" &&
            isPersistableAssistantMessage(message),
        );
        terminal.messages = assistantMessages.map((message) => ({
          id: message.id,
          projectContextRevisionId: turn.projectContextRevisionId,
          parts: message.parts,
          model: meta.model,
          inputTokens: meta.telemetry?.inputTokens,
          cachedInputTokens: meta.telemetry?.cachedInputTokens,
          outputTokens: meta.telemetry?.outputTokens,
          reasoningTokens: meta.telemetry?.reasoningTokens,
          durationMs: meta.telemetry?.durationMs,
          source: turn.source,
        }));
        persistedAssistantMessageCount = terminal.messages.length;
        if (meta.terminalStatus === "waiting" && meta.interaction) {
          await persistDurableAssistantOutcome({
            turnId: turn.id,
            interaction: meta.interaction,
            messages: terminal.messages,
            replayChunks: terminal.replayChunks,
          });
          waitingCommitted = true;
        }
        if (meta.title) {
          await updateThreadTitleForUser({
            id: turn.threadId,
            userId: turn.authorUserId,
            organizationId: turn.organizationId,
            title: meta.title,
            onlyIfUntitled: true,
          });
        }
        if (meta.selectedInteractionMode) {
          await updateThreadInteractionModeForUser({
            id: turn.threadId,
            userId: turn.authorUserId,
            organizationId: turn.organizationId,
            interactionMode: meta.selectedInteractionMode,
          });
        }
      },
    };
    const response = reattachExecutionId
      ? await createKestrelOneReattachmentResponse({
          ...responseInput,
          executionId: reattachExecutionId,
        })
      : await createKestrelOneAgentResponse(responseInput);
    await drainResponse(response);
    await eventWrites;
    if (
      workerInterrupted &&
      environmentExecutionId &&
      !runtimeTerminalObserved &&
      !cancellationRequested
    ) {
      throw new Error("The durable turn worker lease ended during execution.");
    }
    assertVisibleCompletedOutcome(
      terminal.status,
      persistedAssistantMessageCount,
    );
    if (terminal.status === "waiting" && terminal.interaction) {
      return { processed: true, nextTurnId: null };
    }
    // Once the runtime has produced a complete terminal presentation, that
    // result is authoritative even if the worker lease ends immediately after
    // it. Earlier worker loss reaches the failed/catch paths instead.
    const completionStatus = terminalTurnStatus(terminal.status);
    const completion = await completeDurableThreadTurn({
      turnId: turn.id,
      status: completionStatus,
      messages: terminal.messages,
      replayChunks: terminal.replayChunks,
      failureCode:
        completionStatus === "failed"
          ? workerInterrupted
            ? "TURN_WORKER_INTERRUPTED"
            : terminal.errorCode === "MODEL_AUTH_ERROR"
              ? terminal.errorCode
            : terminal.errorCode === "AGENT_CONNECTION_INTERRUPTED"
              ? "AGENT_CONNECTION_INTERRUPTED"
            : terminal.errorCode === "RUNNER_EVENT_CURSOR_EXPIRED" ||
                terminal.errorCode === "RUNNER_EVENT_CURSOR_UNKNOWN"
              ? terminal.errorCode
            : terminal.status === "contract_failure"
              ? "PRESENTATION_CONTRACT_FAILURE"
              : "RUNTIME_FAILED"
          : null,
      failureMessage: terminal.error,
    });
    return { processed: true, nextTurnId: completion.nextTurnId };
  } catch (error) {
    await eventWrites.catch(() => {});
    if (
      workerInterrupted &&
      environmentExecutionId &&
      !runtimeTerminalObserved &&
      !cancellationRequested
    ) {
      // The runner owns a continue-on-disconnect execution. Leave the durable
      // turn running so the queue retry can reattach from its persisted cursor.
      throw error;
    }
    if (
      waitingCommitted ||
      (await getDurableTurn(turn.id).catch(() => null))?.status ===
        "waiting_for_input"
    ) {
      return { processed: true, nextTurnId: null };
    }
    const message =
      error instanceof Error ? error.message : "Durable turn execution failed.";
    const errorCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    const stopped =
      cancellationRequested ||
      (await isDurableTurnCancellationRequested(turn.id).catch(() => false));
    if (stopped && !runtimeTerminalObserved && environmentExecutionId) {
      // Cancellation acknowledgement is not terminal authority. Preserve the
      // active turn so the next worker can reattach from the durable cursor.
      throw error;
    }
    const failurePresentation = buildFailurePresentation({
      errorMessage: message,
      status: stopped ? "cancelled" : "failed",
      turn,
      assistantMessageId: terminal.assistantMessageId,
      textPartId: terminal.textPartId,
    });
    const completion = await completeDurableThreadTurn({
      turnId: turn.id,
      status: stopped ? "cancelled" : "failed",
      messages: failurePresentation.messages,
      replayChunks: failurePresentation.replayChunks,
      failureCode: stopped
        ? "TURN_STOPPED"
          : workerInterrupted
          ? "TURN_WORKER_INTERRUPTED"
          : errorCode === "MODEL_AUTH_ERROR"
            ? errorCode
          : errorCode === "AGENT_CONNECTION_INTERRUPTED"
            ? "AGENT_CONNECTION_INTERRUPTED"
          : errorCode === "RUNNER_EVENT_CURSOR_EXPIRED" ||
              errorCode === "RUNNER_EVENT_CURSOR_UNKNOWN"
            ? errorCode
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
