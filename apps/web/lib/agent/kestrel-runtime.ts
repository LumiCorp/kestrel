import "server-only";

import { readRequestCorrelation } from "@kestrel-agents/next";
import type { KestrelAgent, RunnerActorMetadata } from "@kestrel-agents/sdk";
import {
  isRunnerRunStreamEvent,
  isRunnerRunTerminalEvent,
  KestrelClient,
  type KestrelRequestContext,
  type RunnerProfile,
  type RunnerRunStreamEvent,
  type RunnerRunTerminalEvent,
  type RunnerStream,
  type RunnerTurnInput,
} from "@kestrel-agents/sdk/runner";
import type { InferUIMessageChunk, UIMessage } from "ai";
import { buildKestrelOneCapabilityDescriptors } from "@/lib/agent/kestrel-capabilities";
import { recordEmailAppApprovalRequest } from "@/lib/apps/email-app-approvals";
import {
  createProfileBoundExternalReplyAgent,
  generateKestrelOneExternalReplyFromAgent,
} from "@/lib/agent/kestrel-external-runtime-core";
import {
  adaptKestrelAgentForKestrelOne,
  createKestrelOneAgentResponseFromAgent,
  type KestrelOneAgent,
  type KestrelOneAgentResponsePersistMeta,
} from "@/lib/agent/kestrel-runtime-core";
import {
  applyKestrelOneModelToProfile,
  toKestrelOneRuntimeModelSelection,
} from "@/lib/agent/kestrel-runtime-model";
import { restrictKestrelOneProfileTools } from "@/lib/agent/kestrel-tool-profile";
import { getResolvedKestrelRuntimeExecutionModel } from "@/lib/ai/gateways";
import { getGatewayResolutionFailureMessage } from "@/lib/ai/surface-policy";
import type { Session } from "@/lib/auth-types";
import {
  persistRuntimeDialogMessage,
  readRuntimeDialogMessage,
} from "@/lib/turns/dialog-messages";
import {
  activateEnvironmentModelGrant,
  resolveEnvironmentExecutionRoute,
  resolveEnvironmentExecutionCancellationRoute,
  updateEnvironmentExecutionRuntimeIdentity,
  updateEnvironmentExecutionStatus,
} from "@/lib/environments/execution-route";
import { recordGitHubActionApprovalRequest } from "@/lib/integrations/github-action-approvals";
import type { ChatMessage } from "@/lib/types";
import type { KestrelOneInteractionMode } from "@/lib/turns/interaction-mode";

const DEFAULT_PROFILE_ID = "kestrel-one";
type KestrelUiStreamChunk = InferUIMessageChunk<ChatMessage>;

class KestrelOneRunnerClient extends KestrelClient {
  readRetainedReasoning(
    runId: string,
    sessionId: string,
    action: "read" | "delete",
    context: KestrelRequestContext,
  ) {
    return this.sendCommand(
      "operator.run.reasoning",
      { runId, sessionId, action },
      context,
    );
  }
  runWithProfile(
    input: { profile: RunnerProfile; turn: RunnerTurnInput },
    context: KestrelRequestContext,
  ): Promise<RunnerRunTerminalEvent> {
    return this.sendCommand(
      "run.start",
      { profile: input.profile, turn: input.turn },
      context,
    );
  }

  async runWithProfileObservingRuntimeIdentity(
    input: { profile: RunnerProfile; turn: RunnerTurnInput },
    context: KestrelRequestContext,
    onRuntimeIdentity: (identity: {
      runId: string;
      reasoningKeyReady?: boolean | undefined;
    }) => void | Promise<void>,
  ): Promise<RunnerRunTerminalEvent> {
    const stream = this.streamRunWithProfile(input, context);
    let observedRuntimeIdentity = false;
    let reasoningKeyReady: boolean | undefined;
    for await (const event of stream) {
      if (event.type === "run.started") {
        reasoningKeyReady = event.payload.reasoningKeyReady;
      }
      if (!observedRuntimeIdentity && event.runId) {
        await onRuntimeIdentity({
          runId: event.runId,
          ...(reasoningKeyReady !== undefined ? { reasoningKeyReady } : {}),
        });
        observedRuntimeIdentity = true;
      }
    }
    return await stream.result;
  }

  streamRunWithProfile(
    input: {
      profile: RunnerProfile;
      turn: RunnerTurnInput;
      signal?: AbortSignal | undefined;
    },
    context: KestrelRequestContext,
  ): RunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent> {
    return this.createStream(
      "run.start",
      {
        profile: input.profile,
        turn: input.turn,
      },
      context,
      {
        signal: input.signal,
        isStreamEvent: isRunnerRunStreamEvent,
        isTerminalEvent: isRunnerRunTerminalEvent,
        onCancel: async (runId, commandId) => {
          await this.cancelRun(
            {
              sessionId: input.turn.sessionId,
              ...(runId !== undefined ? { runId } : {}),
              commandId,
            },
            context,
          );
        },
      },
    );
  }
}

const INTERRUPTED_RUN_CANCEL_TIMEOUT_MS = 5_000;

export async function cancelInterruptedKestrelOneExecution(input: {
  organizationId: string;
  executionId: string;
}) {
  const route = await resolveEnvironmentExecutionCancellationRoute(input);
  if (!route) return false;
  const client = new KestrelOneRunnerClient({
    target: {
      kind: "remote",
      baseUrl: route.baseUrl,
      authToken: route.authToken,
    },
  });
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.cancelRun(
          { sessionId: route.sessionId, runId: route.runtimeRunId },
          {
            tenantId: input.organizationId,
            actor: {
              actorId: route.actorId,
              actorType: "operator",
              tenantId: input.organizationId,
              orgRole: "org_admin",
            },
          },
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("Interrupted runtime cancellation timed out.")),
            INTERRUPTED_RUN_CANCEL_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return true;
  } finally {
    await client.close();
  }
}

export async function readKestrelOneRetainedReasoning(input: {
  baseUrl: string;
  authToken: string;
  organizationId: string;
  actorUserId: string;
  runtimeRunId: string;
  sessionId: string;
  reasoningPolicy: NonNullable<RunnerProfile["reasoning"]>;
  action?: "read" | "delete" | undefined;
}) {
  const client = new KestrelOneRunnerClient({
    target: {
      kind: "remote",
      baseUrl: input.baseUrl,
      authToken: input.authToken,
    },
  });
  try {
    const baseContext: KestrelRequestContext = {
      tenantId: input.organizationId,
      actor: {
        actorId: input.actorUserId,
        actorType: "operator",
        tenantId: input.organizationId,
        orgRole: "org_admin",
      },
    };
    const baseProfile = await client.getProfile(
      getKestrelOneProfileId(),
      baseContext,
    );
    const event = await client.readRetainedReasoning(
      input.runtimeRunId,
      input.sessionId,
      input.action ?? "read",
      {
        ...baseContext,
        profile: {
          ...baseProfile,
          reasoning: input.reasoningPolicy,
        },
      },
    );
    return event.payload;
  } finally {
    await client.close();
  }
}

function getKestrelOneProfileId() {
  return process.env.KESTREL_ONE_PROFILE_ID?.trim() || DEFAULT_PROFILE_ID;
}

export type KestrelOneAgentResponseInput = {
  request: Request;
  agent?: KestrelAgent;
  session: Session;
  organizationId: string;
  environmentId: string;
  threadId: string;
  durableTurnId?: string | undefined;
  messages: UIMessage[];
  approvalDecision?:
    | {
        approvalId: string;
        approved: boolean;
        reason?: string | undefined;
      }
    | undefined;
  interactionResponse?:
    | {
        requestId: string;
        eventType: string;
        message: string;
        approved?: boolean | undefined;
        reason?: string | undefined;
      }
    | undefined;
  modelId?: string;
  interactionMode: KestrelOneInteractionMode;
  projectContext?: {
    projectId: string;
    contextRevisionId: string;
    contextRevision: number;
    grantId: string;
    systemContext: string;
  };
  transientTitle?: Promise<string | null> | null;
  signal?: AbortSignal;
  onExecutionRouted?: (executionId: string) => Promise<void> | void;
  onUiChunk?: (chunk: KestrelUiStreamChunk) => void;
  onRuntimeEvent?: (event: RunnerRunStreamEvent) => void;
  onFinishPersist?: (
    messages: UIMessage[],
    meta: KestrelOneAgentResponsePersistMeta,
  ) => Promise<void>;
};

function createModelAwareKestrelOneAgent(input: {
  organizationId: string;
  environmentId: string;
  threadId: string;
  actorUserId: string;
  durableTurnId?: string | undefined;
  projectContextRevisionId?: string | undefined;
  onExecutionRouted?: (executionId: string) => Promise<void> | void;
}): KestrelOneAgent {
  const clients = new Set<KestrelOneRunnerClient>();
  return {
    stream(turnInput, context, runtimeModel) {
      const routed = new EnvironmentRoutedRunnerStream();
      void (async () => {
        let client: KestrelOneRunnerClient | null = null;
        let executionId: string | null = null;
        let environmentProgressSequence = 0;
        const pendingDialogs = new Set<string>();
        const dialogAbort = new AbortController();
        let dialogDrain: Promise<void> | null = null;
        let mainTerminal = false;
        let retainClientForDialog = false;
        const handleDialogEvent = async (
          event: Parameters<typeof readRuntimeDialogMessage>[0],
        ) => {
          const message = readRuntimeDialogMessage(event);
          if (message === null) return;
          if (message.sender === "kestrel" && message.status === undefined)
            pendingDialogs.add(message.dialogId);
          else pendingDialogs.delete(message.dialogId);
          await persistRuntimeDialogMessage({
            threadId: input.threadId,
            message,
          });
          if (mainTerminal && pendingDialogs.size === 0) dialogAbort.abort();
        };
        try {
          const route = await resolveEnvironmentExecutionRoute({
            organizationId: input.organizationId,
            expectedEnvironmentId: input.environmentId,
            threadId: input.threadId,
            actorUserId: input.actorUserId,
            agentId: getKestrelOneProfileId(),
            recordExecution: {
              projectContextRevisionId: input.projectContextRevisionId,
              durableTurnId: input.durableTurnId,
            },
            onProgress: (progress) =>
              routed.push({
                id: crypto.randomUUID(),
                type: "run.agent_progress",
                ts: new Date().toISOString(),
                runId: `environment:${input.threadId}`,
                sessionId: input.threadId,
                payload: {
                  update: {
                    version: "v1",
                    runId: `environment:${input.threadId}`,
                    sessionId: input.threadId,
                    ts: new Date().toISOString(),
                    seq: (environmentProgressSequence += 1),
                    message: progress.detail,
                    stepIndex: 0,
                    stepAgent: "environment.route",
                  },
                },
              }),
          });
          executionId = route.runId;
          await input.onExecutionRouted?.(executionId);
          if (runtimeModel) {
            await activateEnvironmentModelGrant({
              organizationId: input.organizationId,
              environmentId: route.environmentId,
              workspaceId: route.workspaceId,
              threadId: input.threadId,
              runId: route.runId,
              gatewayId: runtimeModel.gatewayId,
              rawModelId: runtimeModel.model,
            });
          }
          await updateEnvironmentExecutionStatus({
            organizationId: input.organizationId,
            executionId,
            status: "running",
          });
          client = new KestrelOneRunnerClient({
            target: {
              kind: "remote",
              baseUrl: route.baseUrl,
              authToken: route.authToken,
            },
          });
          clients.add(client);
          const dialogEvents = client.subscribe(
            { threadId: input.threadId, eventTypes: ["task.updated"] },
            context,
            { signal: dialogAbort.signal },
          );
          dialogDrain = (async () => {
            try {
              for await (const event of dialogEvents)
                await handleDialogEvent(event);
            } catch (error) {
              if (!dialogAbort.signal.aborted) {
                console.error("Collaborator dialog subscription failed", error);
              }
            }
          })();
          const { signal, resumeRequestId, ...turn } = turnInput;
          const eventType = turn.eventType || "user.message";
          const normalizedTurn = {
            ...turn,
            eventType,
            ...(resumeRequestId !== undefined
              ? {
                  resumeBlockedRun: true,
                  resumeRequestId,
                }
              : {}),
            ...(route.mcpContext ? { mcpContext: route.mcpContext } : {}),
            ...(route.executionTicket
              ? {
                  mcpAuthorization: {
                    executionTicket: route.executionTicket,
                  },
                }
              : {}),
          };
          const baseProfile = await client.getProfile(
            getKestrelOneProfileId(),
            context,
          );
          const selectedProfile = runtimeModel
            ? applyKestrelOneModelToProfile(
                baseProfile,
                runtimeModel,
                route.runId,
              )
            : baseProfile;
          const downstream = client.streamRunWithProfile(
            {
              profile: restrictKestrelOneProfileTools({
                profile: {
                  ...selectedProfile,
                  reasoning: route.reasoningPolicy,
                },
                effectiveCapabilities: route.effectiveCapabilities,
              }),
              turn: normalizedTurn,
              ...(signal ? { signal } : {}),
            },
            context,
          );
          routed.attachCancel(() => downstream.cancel());
          let observedRuntimeIdentity = false;
          let reasoningKeyReady: boolean | undefined;
          for await (const event of downstream) {
            if (event.type === "task.updated") await handleDialogEvent(event);
            if (event.type === "run.started") {
              reasoningKeyReady = event.payload.reasoningKeyReady;
            }
            if (!observedRuntimeIdentity && event.runId) {
              await updateEnvironmentExecutionRuntimeIdentity({
                organizationId: input.organizationId,
                executionId: route.runId,
                runtimeRunId: event.runId,
                ...(reasoningKeyReady !== undefined
                  ? { reasoningKeyReady }
                  : {}),
              });
              observedRuntimeIdentity = true;
            }
            routed.push(event);
          }
          const terminal = await downstream.result;
          mainTerminal = true;
          if (pendingDialogs.size === 0) dialogAbort.abort();
          else retainClientForDialog = true;
          await recordGitHubActionApprovalRequest({
            identity: {
              organizationId: input.organizationId,
              environmentId: route.environmentId,
              workspaceId: route.workspaceId,
              threadId: input.threadId,
              actorId: input.actorUserId,
              agentId: getKestrelOneProfileId(),
            },
            requestedExecutionId: route.runId,
            event: terminal,
          });
          await recordEmailAppApprovalRequest({
            organizationId: input.organizationId,
            environmentId: route.environmentId,
            workspaceId: route.workspaceId,
            threadId: input.threadId,
            actorUserId: input.actorUserId,
            agentId: getKestrelOneProfileId(),
            requestedExecutionId: route.runId,
            event: terminal,
          });
          await updateEnvironmentExecutionStatus({
            organizationId: input.organizationId,
            executionId,
            status: terminalExecutionStatus(terminal),
          });
          routed.complete(terminal);
        } catch (error) {
          if (executionId) {
            await updateEnvironmentExecutionStatus({
              organizationId: input.organizationId,
              executionId,
              status: "failed",
            }).catch(() => {});
          }
          routed.fail(error);
        } finally {
          if (client) {
            if (retainClientForDialog && dialogDrain !== null) {
              const retainedClient = client;
              void dialogDrain.finally(async () => {
                clients.delete(retainedClient);
                await retainedClient.close();
              });
            } else {
              dialogAbort.abort();
              await dialogDrain?.catch(() => {});
              clients.delete(client);
              await client.close();
            }
          }
        }
      })();
      return routed;
    },
    async close() {
      await Promise.all([...clients].map((client) => client.close()));
      clients.clear();
    },
  };
}

class EnvironmentRoutedRunnerStream
  implements
    RunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent>,
    AsyncIterator<RunnerRunStreamEvent>
{
  readonly result: Promise<RunnerRunTerminalEvent>;
  private resolveResult!: (value: RunnerRunTerminalEvent) => void;
  private rejectResult!: (error: unknown) => void;
  private readonly queue: RunnerRunStreamEvent[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<RunnerRunStreamEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private cancelImpl: () => Promise<void> = async () => {};
  private finished = false;

  constructor() {
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    void this.result.catch(() => {});
  }

  push(event: RunnerRunStreamEvent) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.queue.push(event);
  }

  attachCancel(cancel: () => Promise<void>) {
    this.cancelImpl = cancel;
  }

  complete(event: RunnerRunTerminalEvent) {
    this.resolveResult(event);
    this.finishWaiters();
  }

  fail(error: unknown) {
    this.rejectResult(error);
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  cancel() {
    return this.cancelImpl();
  }

  next(): Promise<IteratorResult<RunnerRunStreamEvent>> {
    const event = this.queue.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    if (this.finished) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  private finishWaiters() {
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}

export async function generateKestrelOneExternalReply(input: {
  organizationId: string;
  apiUrl: string;
  sessionId: string;
  prompt: string;
  actor: RunnerActorMetadata;
}) {
  const route = await resolveEnvironmentExecutionRoute({
    organizationId: input.organizationId,
    threadId: input.sessionId,
    actorUserId: input.actor.actorId,
    agentId: getKestrelOneProfileId(),
    recordExecution: {},
  });
  const client = new KestrelOneRunnerClient({
    target: {
      kind: "remote",
      baseUrl: route.baseUrl,
      authToken: route.authToken,
    },
  });
  const context: KestrelRequestContext = {
    actor: input.actor,
    tenantId: input.organizationId,
  };

  try {
    await updateEnvironmentExecutionStatus({
      organizationId: input.organizationId,
      executionId: route.runId,
      status: "running",
    });
    const resolvedModel = await getResolvedKestrelRuntimeExecutionModel({
      organizationId: input.organizationId,
      environmentId: route.environmentId,
    });
    if (!resolvedModel) {
      throw new Error(
        getGatewayResolutionFailureMessage({
          surface: "chat",
        }),
      );
    }
    const runtimeModel = toKestrelOneRuntimeModelSelection({
      ...resolvedModel.model,
      organizationId: input.organizationId,
      environmentId: route.environmentId,
    });
    await activateEnvironmentModelGrant({
      organizationId: input.organizationId,
      environmentId: route.environmentId,
      workspaceId: route.workspaceId,
      threadId: input.sessionId,
      runId: route.runId,
      gatewayId: runtimeModel.gatewayId,
      rawModelId: runtimeModel.model,
    });
    const baseProfile = await client.getProfile(
      getKestrelOneProfileId(),
      context,
    );
    const profile = restrictKestrelOneProfileTools({
      profile: applyKestrelOneModelToProfile(
        { ...baseProfile, reasoning: route.reasoningPolicy },
        runtimeModel,
        route.runId,
      ),
      effectiveCapabilities: route.effectiveCapabilities,
    });
    const result = await generateKestrelOneExternalReplyFromAgent({
      agent: createProfileBoundExternalReplyAgent({
        profile,
        run: (request, requestContext) =>
          client.runWithProfileObservingRuntimeIdentity(
            request,
            requestContext,
            async (identity) => {
              await updateEnvironmentExecutionRuntimeIdentity({
                organizationId: input.organizationId,
                executionId: route.runId,
                runtimeRunId: identity.runId,
                ...(identity.reasoningKeyReady !== undefined
                  ? { reasoningKeyReady: identity.reasoningKeyReady }
                  : {}),
              });
            },
          ),
      }),
      sessionId: input.sessionId,
      prompt: input.prompt,
      context,
      clientCapabilities: {
        kestrelOne: {
          tenantId: input.organizationId,
          capabilities: buildKestrelOneCapabilityDescriptors({
            request: new Request(new URL("/", input.apiUrl)),
          }),
        },
      },
      ...(route.mcpContext && route.executionTicket
        ? {
            mcpContext: route.mcpContext,
          }
        : {}),
      ...(route.executionTicket
        ? {
            mcpAuthorization: {
              executionTicket: route.executionTicket,
            },
          }
        : {}),
    });
    await updateEnvironmentExecutionStatus({
      organizationId: input.organizationId,
      executionId: route.runId,
      status: "completed",
    });
    return result;
  } catch (error) {
    await updateEnvironmentExecutionStatus({
      organizationId: input.organizationId,
      executionId: route.runId,
      status: externalFailureExecutionStatus(error),
    }).catch(() => {});
    throw error;
  } finally {
    await client.close();
  }
}

export async function createKestrelOneAgentResponse(
  input: KestrelOneAgentResponseInput,
) {
  const resolvedModel = await getResolvedKestrelRuntimeExecutionModel({
    selection: input.modelId,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  if (!resolvedModel) {
    throw new Error(
      getGatewayResolutionFailureMessage({
        surface: "chat",
        modelId: input.modelId,
      }),
    );
  }

  const runtimeModel = toKestrelOneRuntimeModelSelection({
    ...resolvedModel.model,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  const agent = input.agent;
  const runtimeAgent = agent
    ? adaptKestrelAgentForKestrelOne(agent)
    : createModelAwareKestrelOneAgent({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        threadId: input.threadId,
        actorUserId: input.session.user.id,
        durableTurnId: input.durableTurnId,
        projectContextRevisionId: input.projectContext?.contextRevisionId,
        onExecutionRouted: input.onExecutionRouted,
      });

  return createKestrelOneAgentResponseFromAgent({
    request: input.request,
    agent: runtimeAgent,
    ownsAgent: input.agent === undefined,
    session: input.session,
    organizationId: input.organizationId,
    correlation: readRequestCorrelation(input.request),
    threadId: input.threadId,
    durableTurnId: input.durableTurnId,
    messages: input.messages,
    approvalDecision: input.approvalDecision,
    interactionResponse: input.interactionResponse,
    modelId: resolvedModel.model.id,
    interactionMode: input.interactionMode,
    runtimeModel,
    projectContext: input.projectContext,
    transientTitle: input.transientTitle,
    signal: input.signal,
    onUiChunk: input.onUiChunk,
    onRuntimeEvent: input.onRuntimeEvent,
    onFinishPersist: input.onFinishPersist,
  });
}

function terminalExecutionStatus(
  terminal: RunnerRunTerminalEvent,
): "completed" | "failed" | "cancelled" {
  if (terminal.type === "run.cancelled") return "cancelled";
  if (terminal.type === "run.failed") return "failed";
  return "completed";
}

function externalFailureExecutionStatus(
  error: unknown,
): "failed" | "cancelled" {
  return error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "RUN_CANCELLED"
    ? "cancelled"
    : "failed";
}
