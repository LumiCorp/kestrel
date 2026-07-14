import "server-only";

import { readRequestCorrelation } from "@kestrel-agents/next";
import type { KestrelAgent, RunnerActorMetadata } from "@kestrel-agents/sdk";
import {
  KestrelClient,
  isRunnerRunStreamEvent,
  isRunnerRunTerminalEvent,
  type KestrelRequestContext,
  type RunnerProfile,
  type RunnerRunStreamEvent,
  type RunnerRunTerminalEvent,
  type RunnerStream,
  type RunnerTurnInput,
} from "@kestrel-agents/sdk/runner";
import type { UIMessage } from "ai";
import { buildKestrelOneCapabilityDescriptors } from "@/lib/agent/kestrel-capabilities";
import {
  createProfileBoundExternalReplyAgent,
  generateKestrelOneExternalReplyFromAgent,
} from "@/lib/agent/kestrel-external-runtime-core";
import {
  adaptKestrelAgentForKestrelOne,
  createKestrelOneAgentResponseFromAgent,
  type KestrelOneAgent,
  type KestrelOneAgentResponsePersistMeta,
  resolveKestrelOneTurnEventType,
} from "@/lib/agent/kestrel-runtime-core";
import {
  applyKestrelOneModelToProfile,
  toKestrelOneRuntimeModelSelection,
} from "@/lib/agent/kestrel-runtime-model";
import { getResolvedKestrelRuntimeExecutionModel } from "@/lib/ai/gateways";
import { getGatewayResolutionFailureMessage } from "@/lib/ai/surface-policy";
import type { Session } from "@/lib/auth-types";
import {
  resolveEnvironmentExecutionRoute,
  updateEnvironmentExecutionStatus,
} from "@/lib/environments/execution-route";
import { recordGitHubActionApprovalRequest } from "@/lib/integrations/github-action-approvals";

const DEFAULT_PROFILE_ID = "kestrel-one";

class KestrelOneRunnerClient extends KestrelClient {
  runWithProfile(
    input: { profile: RunnerProfile; turn: RunnerTurnInput },
    context: KestrelRequestContext
  ): Promise<RunnerRunTerminalEvent> {
    return this.sendCommand(
      "run.start",
      { profile: input.profile, turn: input.turn },
      context
    );
  }

  streamRunWithProfile(
    input: {
      profile: RunnerProfile;
      turn: RunnerTurnInput;
      signal?: AbortSignal | undefined;
    },
    context: KestrelRequestContext
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
            context
          );
        },
      }
    );
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
  threadId: string;
  messages: UIMessage[];
  approvalDecision?:
    | {
        approvalId: string;
        approved: boolean;
        reason?: string | undefined;
      }
    | undefined;
  modelId?: string;
  projectContext?: {
    projectId: string;
    contextRevisionId: string;
    contextRevision: number;
    grantId: string;
    systemContext: string;
  };
  transientTitle?: Promise<string | null> | null;
  onFinishPersist?: (
    messages: UIMessage[],
    meta: KestrelOneAgentResponsePersistMeta
  ) => Promise<void>;
};

function createModelAwareKestrelOneAgent(input: {
  organizationId: string;
  threadId: string;
  actorUserId: string;
  projectContextRevisionId?: string | undefined;
}): KestrelOneAgent {
  const clients = new Set<KestrelOneRunnerClient>();
  return {
    stream(turnInput, context, runtimeModel) {
      const routed = new EnvironmentRoutedRunnerStream();
      void (async () => {
        let client: KestrelOneRunnerClient | null = null;
        let executionId: string | null = null;
        try {
          const route = await resolveEnvironmentExecutionRoute({
            organizationId: input.organizationId,
            threadId: input.threadId,
            actorUserId: input.actorUserId,
            agentId: getKestrelOneProfileId(),
            recordExecution: {
              projectContextRevisionId: input.projectContextRevisionId,
            },
            onProgress: (progress) =>
              routed.push({
                id: crypto.randomUUID(),
                type: "run.progress",
                ts: new Date().toISOString(),
                payload: { update: { message: progress.detail } },
              }),
          });
          executionId = route.runId;
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
          const { signal, ...turn } = turnInput;
          const requestedEventType = turn.eventType || "user.message";
          const eventType = await resolveEnvironmentTurnEventType({
            client,
            context,
            sessionId: turn.sessionId,
            requestedEventType,
            hasHistory: (turn.history?.length ?? 0) > 0,
          });
          const normalizedTurn = {
            ...turn,
            eventType,
            ...(route.mcpContext ? { mcpContext: route.mcpContext } : {}),
            mcpAuthorization: { executionTicket: route.authToken },
          };
          const downstream = runtimeModel
            ? client.streamRunWithProfile(
                {
                  profile: applyKestrelOneModelToProfile(
                    await client.getProfile(getKestrelOneProfileId(), context),
                    runtimeModel
                  ),
                  turn: normalizedTurn,
                  ...(signal ? { signal } : {}),
                },
                context
              )
            : client.streamRun(
                {
                  profileId: getKestrelOneProfileId(),
                  turn: normalizedTurn,
                  ...(signal ? { signal } : {}),
                },
                context
              );
          routed.attachCancel(() => downstream.cancel());
          for await (const event of downstream) {
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
              event,
            });
            routed.push(event);
          }
          const terminal = await downstream.result;
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
            clients.delete(client);
            await client.close();
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

async function resolveEnvironmentTurnEventType(input: {
  client: KestrelOneRunnerClient;
  context: KestrelRequestContext;
  sessionId: string;
  requestedEventType: string;
  hasHistory: boolean;
}) {
  if (input.requestedEventType !== "user.message" || !input.hasHistory) {
    return input.requestedEventType;
  }

  try {
    const session = await input.client.describeSession(
      input.sessionId,
      input.context
    );
    return resolveKestrelOneTurnEventType({
      requestedEventType: input.requestedEventType,
      waitFor: session.waitFor,
    });
  } catch (error) {
    if (isMissingRunnerSession(error)) {
      return input.requestedEventType;
    }
    throw error;
  }
}

function isMissingRunnerSession(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "STORE_SESSION_NOT_FOUND"
  );
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
      this.waiters.push({ resolve, reject })
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
    });
    if (!resolvedModel) {
      throw new Error(
        getGatewayResolutionFailureMessage({
          surface: "chat",
        })
      );
    }
    const baseProfile = await client.getProfile(
      getKestrelOneProfileId(),
      context
    );
    const profile = applyKestrelOneModelToProfile(
      baseProfile,
      toKestrelOneRuntimeModelSelection({
        ...resolvedModel.model,
        organizationId: input.organizationId,
      })
    );
    const result = await generateKestrelOneExternalReplyFromAgent({
      agent: createProfileBoundExternalReplyAgent({
        profile,
        run: (request, requestContext) =>
          client.runWithProfile(request, requestContext),
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
      mcpAuthorization: { executionTicket: route.authToken },
      mcpContext: route.mcpContext,
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
  input: KestrelOneAgentResponseInput
) {
  const resolvedModel = await getResolvedKestrelRuntimeExecutionModel({
    selection: input.modelId,
    organizationId: input.organizationId,
  });
  if (!resolvedModel) {
    throw new Error(
      getGatewayResolutionFailureMessage({
        surface: "chat",
        modelId: input.modelId,
      })
    );
  }

  const runtimeModel = toKestrelOneRuntimeModelSelection({
    ...resolvedModel.model,
    organizationId: input.organizationId,
  });
  const agent = input.agent;
  const runtimeAgent = agent
    ? adaptKestrelAgentForKestrelOne(agent)
    : createModelAwareKestrelOneAgent({
        organizationId: input.organizationId,
        threadId: input.threadId,
        actorUserId: input.session.user.id,
        projectContextRevisionId: input.projectContext?.contextRevisionId,
      });

  return createKestrelOneAgentResponseFromAgent({
    request: input.request,
    agent: runtimeAgent,
    ownsAgent: input.agent === undefined,
    session: input.session,
    organizationId: input.organizationId,
    correlation: readRequestCorrelation(input.request),
    threadId: input.threadId,
    messages: input.messages,
    approvalDecision: input.approvalDecision,
    modelId: resolvedModel.model.id,
    runtimeModel,
    projectContext: input.projectContext,
    transientTitle: input.transientTitle,
    onFinishPersist: input.onFinishPersist,
  });
}

function terminalExecutionStatus(
  terminal: RunnerRunTerminalEvent
): "completed" | "failed" | "cancelled" {
  if (terminal.type === "run.cancelled") return "cancelled";
  if (terminal.type === "run.failed") return "failed";
  return "completed";
}

function externalFailureExecutionStatus(
  error: unknown
): "failed" | "cancelled" {
  return error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "RUN_CANCELLED"
    ? "cancelled"
    : "failed";
}
