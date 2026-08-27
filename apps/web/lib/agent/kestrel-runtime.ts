import "server-only";

import { readRequestCorrelation } from "@kestrel-agents/next";
import type { KestrelAgent, RunnerActorMetadata } from "@kestrel-agents/sdk";
import {
  WORKSPACE_HOSTED_APPROVAL_PRESET_VERSION,
  type RunnerPreparedApprovalCleanupV1,
  type RunnerTurnAttachment,
} from "@kestrel-agents/protocol";
import {
  isRunnerRunStreamEvent,
  isRunnerRunTerminalEvent,
  KestrelClient,
  type KestrelRequestContext,
  type ExecutionProfileResolveCommandPayload,
  type ExecutionProfileResolvedEventPayload,
  type RunnerProfile,
  type RunnerRunStreamEvent,
  type RunnerRunTerminalEvent,
  type RunnerStream,
  type RunnerTurnInput,
} from "@kestrel-agents/sdk/runner";
import type { InferUIMessageChunk, UIMessage } from "ai";
import { buildKestrelOneCapabilityDescriptors } from "@/lib/agent/kestrel-capabilities";
import { createRecoveredKestrelOneCompletion } from "@/lib/agent/kestrel-reconnect-stream";
import { generateKestrelOneExternalReplyFromAgent } from "@/lib/agent/kestrel-external-runtime-core";
import {
  adaptKestrelAgentForKestrelOne,
  createKestrelOneAgentResponseFromAgent,
  type KestrelOneAgent,
  type KestrelOneAgentResponsePersistMeta,
} from "@/lib/agent/kestrel-runtime-core";
import {
  isKestrelOneManagedRuntimeModel,
  toKestrelOneRuntimeModelSelection,
  type DesktopLocalRuntimeModelSelection,
  type DirectLocalRuntimeModelSelection,
  type EnvironmentRuntimeModelSelection,
  type KestrelOneRuntimeModelSelection,
} from "@/lib/agent/kestrel-runtime-model";
import {
  KESTREL_ONE_HOSTED_RUNTIME_TOOL_NAMES,
  resolveKestrelOneToolProfileConfiguration,
} from "@/lib/agent/kestrel-tool-profile";
import { getResolvedKestrelRuntimeExecutionModel } from "@/lib/ai/gateways";
import { parseDesktopLocalRuntimeModelId } from "@/lib/ai/gateway-utils";
import { isDesktopModelRoleReady } from "@/lib/environments/desktop-model-readiness";
import { getGatewayResolutionFailureMessage } from "@/lib/ai/surface-policy";
import type { Session } from "@/lib/auth-types";
import { getHostedEnvironmentRuntimeMode } from "@/lib/environments/config";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  persistRuntimeDialogMessage,
  readRuntimeDialogMessage,
} from "@/lib/turns/dialog-messages";
import { listRememberedToolApprovalEvidenceForRuntime } from "@/lib/turns/store";
import {
  activateEnvironmentModelGrant,
  resolveEnvironmentExecutionRoute,
  resolveEnvironmentExecutionCancellationRoute,
  resolveEnvironmentExecutionAuthorizationRoute,
  resolveEnvironmentExecutionRecoveryRoute,
  settleEnvironmentExecutionRuntimeEvent,
  updateEnvironmentExecutionRuntimeCursor,
  updateEnvironmentExecutionRuntimeIdentity,
  updateEnvironmentExecutionStatus,
} from "@/lib/environments/execution-route";
import { recordHostedAppApprovalRequest } from "@/lib/apps/hosted-app-approval-recorder";
import type { ChatMessage } from "@/lib/types";
import type { KestrelOneInteractionMode } from "@/lib/turns/interaction-mode";
import { synchronizeProjectSkills } from "@/lib/projects/skills";
import { issueHostedMcpRunContext } from "@/lib/mcp/grant-service";
import type { ResolvedOciMcpEgressBindingV1 } from "@kestrel/mcp-security";
import {
  resolveThreadRuntimeWorkspace,
  type ThreadWorkspaceMode,
} from "@/lib/threads/workspace-mode";

const DEFAULT_PROFILE_ID = "kestrel";
const DEFAULT_HOSTED_AGENT_ID = "kestrel-one";
const LEGACY_HOSTED_WORKSPACE_PRESET_VERSION = 2;
const HOSTED_WORKSPACE_POLICY_ID = "kestrel";
const HOSTED_WORKSPACE_POLICY_VERSION = 4;
const HOSTED_MODEL_ECONOMICS_PROFILE_REQUIRED_CODE =
  "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED";
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

  async runWithProfileIdObservingRuntimeIdentity(
    input: { profileId: string; turn: RunnerTurnInput },
    context: KestrelRequestContext,
    onRuntimeIdentity: (identity: {
      runId: string;
      reasoningKeyReady?: boolean | undefined;
    }) => void | Promise<void>,
  ): Promise<RunnerRunTerminalEvent> {
    const stream = this.streamRun(input, context);
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
      abortBehavior?: "cancel" | "detach" | undefined;
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
        abortBehavior: input.abortBehavior,
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

export interface HostedKestrelExecutionProfileResolver {
  resolveExecutionProfile(
    input: ExecutionProfileResolveCommandPayload,
    context: KestrelRequestContext,
  ): Promise<ExecutionProfileResolvedEventPayload>;
}

const INTERRUPTED_RUN_CANCEL_TIMEOUT_MS = 5000;

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
    const deadline = Date.now() + INTERRUPTED_RUN_CANCEL_TIMEOUT_MS;
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
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (!route.lastRuntimeEventId || Date.now() >= deadline) return false;
    const abort = new AbortController();
    const remaining = setTimeout(
      () => abort.abort(),
      Math.max(1, deadline - Date.now()),
    );
    try {
      const stream = client.reattachRun(
        {
          sessionId: route.sessionId,
          runId: route.runtimeRunId,
          sinceEventId: route.lastRuntimeEventId,
          signal: abort.signal,
          abortBehavior: "detach",
        },
        {
          tenantId: input.organizationId,
          actor: {
            actorId: route.actorId,
            actorType: "operator",
            tenantId: input.organizationId,
            orgRole: "org_admin",
          },
        },
      );
      for await (const event of stream) {
        const terminalStatus = runtimeTerminalStatus(event.type);
        await settleEnvironmentExecutionRuntimeEvent({
          organizationId: input.organizationId,
          executionId: input.executionId,
          eventId: event.id,
          ...(terminalStatus !== undefined ? { terminalStatus } : {}),
        });
        if (terminalStatus !== undefined) return terminalStatus === "cancelled";
      }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(remaining);
    }
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
    const event = await client.readRetainedReasoning(
      input.runtimeRunId,
      input.sessionId,
      input.action ?? "read",
      baseContext,
    );
    return event.payload;
  } finally {
    await client.close();
  }
}

function getKestrelOneProfileId() {
  return process.env.KESTREL_ONE_PROFILE_ID?.trim() || DEFAULT_PROFILE_ID;
}

export function getKestrelOneHostedAgentId() {
  return process.env.KESTREL_ONE_AGENT_ID?.trim() || DEFAULT_HOSTED_AGENT_ID;
}

export type KestrelOneAgentResponseInput = {
  request: Request;
  agent?: KestrelAgent;
  session: Session;
  organizationId: string;
  environmentId: string;
  threadId: string;
  workspaceMode: ThreadWorkspaceMode;
  workspaceBaseRef?: string | null;
  parentThreadId?: string | null;
  durableTurnId?: string | undefined;
  messages: UIMessage[];
  resolvedAttachments?: RunnerTurnAttachment[] | null | undefined;
  threadFileInventory?: Array<{
    fileId: string;
    filename: string;
    mediaType: string | null;
    sizeBytes: number;
  }>;
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
        decision?: "decline" | "approve_once" | "remember_approval" | undefined;
        decidingActor?: RunnerActorMetadata | undefined;
        preparedApprovalCleanup?: RunnerPreparedApprovalCleanupV1 | undefined;
        reason?: string | undefined;
        recoveryOptionId?: string | undefined;
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
  abortBehavior?: "cancel" | "detach" | undefined;
  onExecutionRouted?: (executionId: string) => Promise<void> | void;
  onApplicationProgress?: (progress: {
    stage: string;
    detail: string;
    status: string;
  }) => Promise<void> | void;
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
  workspaceMode: ThreadWorkspaceMode;
  workspaceBaseRef?: string | null;
  parentThreadId?: string | null;
  actorUserId: string;
  durableTurnId?: string | undefined;
  projectContextRevisionId?: string | undefined;
  projectContextGrantId?: string | undefined;
  onExecutionRouted?: (executionId: string) => Promise<void> | void;
  onApplicationProgress?: (progress: {
    stage: string;
    detail: string;
    status: string;
  }) => Promise<void> | void;
}): KestrelOneAgent {
  const clients = new Set<KestrelOneRunnerClient>();
  return {
    stream(turnInput, context, runtimeModel) {
      const routed = new EnvironmentRoutedRunnerStream();
      void (async () => {
        let client: KestrelOneRunnerClient | null = null;
        let executionId: string | null = null;
        const hostedAgentId = getKestrelOneHostedAgentId();
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
            agentId: hostedAgentId,
            recordExecution: {
              projectContextRevisionId: input.projectContextRevisionId,
              projectContextGrantId: input.projectContextGrantId,
              durableTurnId: input.durableTurnId,
            },
            onProgress: (progress) => input.onApplicationProgress?.(progress),
          });
          executionId = route.runId;
          await input.onExecutionRouted?.(executionId);
          const projectSkills =
            route.provider !== "desktop" && route.projectId
              ? await synchronizeProjectSkills({
                  organizationId: input.organizationId,
                  projectId: route.projectId,
                  actorUserId: input.actorUserId,
                  route: {
                    baseUrl: route.baseUrl,
                    authToken: route.authToken,
                  },
                })
              : null;
          if (runtimeModel && isKestrelOneManagedRuntimeModel(runtimeModel)) {
            await activateEnvironmentModelGrant({
              organizationId: input.organizationId,
              environmentId: route.environmentId,
              workspaceId: route.workspaceId,
              threadId: input.threadId,
              runId: route.runId,
              gatewayId: runtimeModel.gatewayId,
              rawModelId: runtimeModel.model,
              routeBinding: runtimeModel.routeBinding,
            });
          }
          if (route.provider !== "desktop") {
            await updateEnvironmentExecutionStatus({
              organizationId: input.organizationId,
              executionId,
              status: "running",
            });
          }
          client = new KestrelOneRunnerClient({
            target: {
              kind: "remote",
              baseUrl: route.baseUrl,
              ...(route.provider === "fly"
                ? {
                    authTokenProvider: createExecutionAuthTokenProvider({
                      organizationId: input.organizationId,
                      executionId: route.runId,
                    }),
                    onTransportEvent: createExecutionTransportObserver({
                      organizationId: input.organizationId,
                      executionId: route.runId,
                    }),
                  }
                : {
                    authToken: route.authToken,
                    ...(route.provider === "desktop"
                      ? { fetchImpl: route.fetchImpl }
                      : {}),
                  }),
            },
          });
          clients.add(client);
          if (route.provider !== "desktop") {
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
                  console.error(
                    "Collaborator dialog subscription failed",
                    error,
                  );
                }
              }
            })();
          }
          const { signal, abortBehavior, resumeRequestId, ...turn } = turnInput;
          const eventType = turn.eventType || "user.message";
          const rememberedToolApprovalEvidence =
            await listRememberedToolApprovalEvidenceForRuntime({
              organizationId: input.organizationId,
              threadId: input.threadId,
              userId: input.actorUserId,
            });
          const resolvedProfile = await resolveHostedKestrelExecutionProfile({
            client,
            context,
            route: {
              runId: route.runId,
              environmentId: route.environmentId,
              effectiveCapabilities: route.effectiveCapabilities,
              approvalPolicies: route.approvalPolicies,
              reasoningPolicy: route.reasoningPolicy,
              ociMcpEgressBindings: route.mcpPolicy?.ociEgressBindings,
              rememberedToolApprovalEvidence,
            },
            ...(runtimeModel !== undefined
              ? { runtimeModels: [runtimeModel] }
              : {}),
          });
          const mcpContext = route.mcpPolicy
            ? await issueHostedMcpRunContext({
                runExecutionId: route.runId,
                threadId: turn.sessionId,
                executionProfileId: resolvedProfile.profileId,
                executionProfileFingerprint: resolvedProfile.fingerprint,
                resolvedPolicy: route.mcpPolicy,
              })
            : undefined;
          const runtimeWorkspace = resolveThreadRuntimeWorkspace(
            input.workspaceMode,
            input.parentThreadId,
            input.workspaceBaseRef,
          );
          const normalizedTurn = {
            ...turn,
            eventType,
            ...(route.projectId
              ? {
                  hostedApprovalAuthority: {
                    version: "runner_hosted_approval_authority_v1" as const,
                    organizationId: input.organizationId,
                    environmentId: route.environmentId,
                    projectId: route.projectId,
                    threadId: input.threadId,
                  },
                }
              : {}),
            ...(runtimeWorkspace ? { workspace: runtimeWorkspace } : {}),
            ...(projectSkills
              ? { workspaceSkills: projectSkills.catalog }
              : {}),
            ...(resumeRequestId !== undefined
              ? {
                  resumeBlockedRun: true,
                  resumeRequestId,
                }
              : {}),
            ...(mcpContext ? { mcpContext } : {}),
            ...(route.executionTicket
              ? {
                  mcpAuthorization: {
                    executionTicket: route.executionTicket,
                    ...(route.authorizationRenewal
                      ? { renewal: route.authorizationRenewal }
                      : {}),
                  },
                }
              : {}),
          };
          const downstream = client.streamRun(
            {
              profileId: resolvedProfile.profileId,
              turn: normalizedTurn,
              ...(signal ? { signal } : {}),
              ...(abortBehavior ? { abortBehavior } : {}),
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
            await settleEnvironmentExecutionRuntimeEvent({
              organizationId: input.organizationId,
              executionId: route.runId,
              eventId: event.id,
              ...(runtimeTerminalStatus(event.type) !== undefined
                ? { terminalStatus: runtimeTerminalStatus(event.type) }
                : {}),
            });
            routed.push(event);
          }
          const terminal = await downstream.result;
          mainTerminal = true;
          if (pendingDialogs.size === 0) dialogAbort.abort();
          else retainClientForDialog = true;
          await recordHostedAppApprovalRequest({
            organizationId: input.organizationId,
            environmentId: route.environmentId,
            workspaceId: route.workspaceId,
            threadId: input.threadId,
            actorUserId: input.actorUserId,
            agentId: hostedAgentId,
            requestedExecutionId: route.runId,
            event: terminal,
          });
          await updateEnvironmentExecutionStatus({
            organizationId: input.organizationId,
            executionId,
            status: terminalExecutionStatus(terminal),
            ...terminalFailureEvidence(terminal),
          });
          routed.complete(terminal);
        } catch (error) {
          if (
            executionId &&
            readRuntimeErrorCode(error) !== "RUNNER_TRANSPORT_DETACHED"
          ) {
            await updateEnvironmentExecutionStatus({
              organizationId: input.organizationId,
              executionId,
              status: "failed",
              failureCode: readRuntimeErrorCode(error) ?? "RUNTIME_FAILED",
              failureMessage:
                error instanceof Error
                  ? error.message
                  : "Runtime execution failed.",
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

export async function resolveHostedKestrelExecutionProfile(input: {
  client: HostedKestrelExecutionProfileResolver;
  context: KestrelRequestContext;
  route: {
    runId: string;
    organizationId?: string | undefined;
    environmentId: string;
    effectiveCapabilities: string[];
    approvalPolicies?:
      | import("@/lib/agent/kestrel-tool-profile").KestrelOneCapabilityApprovalPolicyEvidence[]
      | undefined;
    reasoningPolicy?: RunnerProfile["reasoning"] | undefined;
    ociMcpEgressBindings?: ResolvedOciMcpEgressBindingV1[] | undefined;
    rememberedToolApprovalEvidence?:
      | import("@kestrel-agents/protocol").RememberedToolApprovalEvidenceV1[]
      | undefined;
  };
  runtimeModels?:
    | readonly [
        EnvironmentRuntimeModelSelection,
        ...EnvironmentRuntimeModelSelection[],
      ]
    | undefined;
  exactToolName?: string | undefined;
}) {
  const primaryRuntimeModel = input.runtimeModels?.[0];
  const environmentPresetId =
    primaryRuntimeModel !== undefined &&
    !isKestrelOneManagedRuntimeModel(primaryRuntimeModel)
      ? "cli_dev_local"
      : "workspace_hosted";
  const toolConfiguration = resolveKestrelOneToolProfileConfiguration({
    availableToolNames: [...KESTREL_ONE_HOSTED_RUNTIME_TOOL_NAMES],
    effectiveCapabilities: input.route.effectiveCapabilities,
    approvalPolicies: input.route.approvalPolicies,
  });
  try {
    const resolution = await input.client.resolveExecutionProfile(
      {
        environmentPresetId,
        ...(environmentPresetId === "workspace_hosted" &&
        input.exactToolName !== undefined
          ? { exactToolNames: [input.exactToolName] }
          : {}),
        managedConfiguration: {
          label: "Kestrel One",
          additionalToolNames: toolConfiguration.additionalToolNames,
          kestrelOneAppApprovalModes:
            toolConfiguration.kestrelOneAppApprovalModes,
          kestrelOneAppApprovalPolicies:
            toolConfiguration.kestrelOneAppApprovalPolicies,
          rememberedToolApprovalEvidence:
            input.route.rememberedToolApprovalEvidence ?? [],
          ...(input.route.reasoningPolicy !== undefined
            ? { reasoning: input.route.reasoningPolicy }
            : {}),
          ...(input.route.ociMcpEgressBindings !== undefined
            ? { ociMcpEgressBindings: input.route.ociMcpEgressBindings }
            : {}),
          ...(primaryRuntimeModel !== undefined
            ? {
                modelProvider: primaryRuntimeModel.provider,
                model: primaryRuntimeModel.model,
                agentStageConfig: {
                  modelByStage: {
                    "agent.loop": primaryRuntimeModel.model,
                  },
                },
                ...(isKestrelOneManagedRuntimeModel(primaryRuntimeModel)
                  ? {
                      modelCredential: {
                        source: "kestrel-one",
                        runId: input.route.runId,
                        gatewayId: primaryRuntimeModel.gatewayId,
                        organizationId: primaryRuntimeModel.organizationId,
                        environmentId: primaryRuntimeModel.environmentId,
                        rawModelId: primaryRuntimeModel.model,
                        provider: primaryRuntimeModel.provider,
                      },
                    }
                  : {}),
                ...(isKestrelOneManagedRuntimeModel(primaryRuntimeModel) &&
                primaryRuntimeModel.economicsProfile !== undefined
                  ? {
                      modelEconomicsProfile:
                        primaryRuntimeModel.economicsProfile,
                    }
                  : {}),
                default: false,
              }
            : {}),
        },
      },
      input.context,
    );
    if (environmentPresetId === "workspace_hosted") {
      assertHostedWorkspaceProfileCompatibility(resolution);
    }
    if (input.exactToolName !== undefined) {
      assertHostedWorkspaceExactToolPreflight(
        resolution,
        input.exactToolName,
      );
    }
    return resolution;
  } catch (error) {
    throw mapHostedKestrelProfileResolutionError(error, primaryRuntimeModel);
  }
}

export function assertHostedWorkspaceProfileCompatibility(
  resolution: Awaited<ReturnType<HostedKestrelExecutionProfileResolver["resolveExecutionProfile"]>>,
): void {
  const preset4ProducerSupported =
    resolution.environmentPreset.version ===
      WORKSPACE_HOSTED_APPROVAL_PRESET_VERSION &&
    (resolution.hostedApprovalProducerProtocol === "v2" ||
      resolution.hostedApprovalProducerProtocol === "v4");
  const deployedPreset2BridgeSupported =
    resolution.environmentPreset.version ===
      LEGACY_HOSTED_WORKSPACE_PRESET_VERSION &&
    resolution.hostedApprovalProducerProtocol === undefined;
  const policyIdentitySupported =
    resolution.policy.id === HOSTED_WORKSPACE_POLICY_ID &&
    resolution.policy.version === HOSTED_WORKSPACE_POLICY_VERSION &&
    resolution.resolvedProfile.approvalPolicyPackId === "hosted_workspace";
  const expectedProfileId =
    `kestrel:workspace_hosted:${resolution.fingerprint}`;
  const profileIdentitySupported =
    resolution.profileId === expectedProfileId &&
    resolution.resolvedProfile.id === expectedProfileId;
  if (
    resolution.environmentPreset.id !== "workspace_hosted" ||
    !(preset4ProducerSupported || deployedPreset2BridgeSupported) ||
    !policyIdentitySupported ||
    !profileIdentitySupported
  ) {
    throw Object.assign(
      new Error("The runner does not support the current hosted approval contract."),
      {
        code: "HOSTED_PROFILE_CONTRACT_INCOMPATIBLE",
        details: {
          environmentPreset: resolution.environmentPreset,
          approvalPolicyPackId:
            resolution.resolvedProfile.approvalPolicyPackId ?? null,
          profileId: resolution.profileId,
          requiredPresetVersion: WORKSPACE_HOSTED_APPROVAL_PRESET_VERSION,
          policy: resolution.policy,
          hostedApprovalProducerProtocol:
            resolution.hostedApprovalProducerProtocol ?? null,
          acceptedPresetVersions: [
            LEGACY_HOSTED_WORKSPACE_PRESET_VERSION,
            WORKSPACE_HOSTED_APPROVAL_PRESET_VERSION,
          ],
        },
      },
    );
  }
}

export function assertHostedWorkspaceExactToolPreflight(
  resolution: Awaited<ReturnType<HostedKestrelExecutionProfileResolver["resolveExecutionProfile"]>>,
  requiredTool: string,
): void {
  if (resolution.environmentPreset.id !== "workspace_hosted") {
    return;
  }
  assertHostedWorkspaceProfileCompatibility(resolution);
  if (
    resolution.resolvedProfile.approvalPolicyPackId !== "hosted_workspace" ||
    resolution.exactToolDecisions?.[requiredTool]?.available !== true
  ) {
    throw Object.assign(
      new Error(
        `Hosted no-spend preflight rejected required tool '${requiredTool}' before model execution.`,
      ),
      {
        code: "HOSTED_REQUIRED_TOOL_UNAVAILABLE",
        details: {
          requiredTool,
          approvalPolicyPackId:
            resolution.resolvedProfile.approvalPolicyPackId ?? null,
          exactToolDecision:
            resolution.exactToolDecisions?.[requiredTool] ?? null,
        },
      },
    );
  }
}

class EnvironmentRoutedRunnerStream
  implements
    RunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent>,
    AsyncIterator<RunnerRunStreamEvent>
{
  readonly ready = Promise.resolve();
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
  const thread = await knowledgeDb.query.threads.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.sessionId),
        eq(table.organizationId, input.organizationId),
      ),
    columns: {
      workspaceMode: true,
      workspaceBaseRef: true,
      parentThreadId: true,
    },
  });
  if (!thread) throw new Error("Thread workspace mode is unavailable.");
  const route = await resolveEnvironmentExecutionRoute({
    organizationId: input.organizationId,
    threadId: input.sessionId,
    actorUserId: input.actor.actorId,
    agentId: getKestrelOneHostedAgentId(),
    recordExecution: {},
  });
  const client = new KestrelOneRunnerClient({
    target: {
      kind: "remote",
      baseUrl: route.baseUrl,
      ...(route.provider === "fly"
        ? {
            authTokenProvider: createExecutionAuthTokenProvider({
              organizationId: input.organizationId,
              executionId: route.runId,
            }),
            onTransportEvent: createExecutionTransportObserver({
              organizationId: input.organizationId,
              executionId: route.runId,
            }),
          }
        : {
            authToken: route.authToken,
            ...(route.provider === "desktop"
              ? { fetchImpl: route.fetchImpl }
              : {}),
          }),
    },
  });
  const context: KestrelRequestContext = {
    actor: input.actor,
    tenantId: input.organizationId,
    durability: "continue_on_disconnect",
  };

  try {
    const projectSkills =
      route.provider !== "desktop" && route.projectId
        ? await synchronizeProjectSkills({
            organizationId: input.organizationId,
            projectId: route.projectId,
            actorUserId: input.actor.actorId,
            route: {
              baseUrl: route.baseUrl,
              authToken: route.authToken,
            },
          })
        : null;
    if (route.provider !== "desktop") {
      await updateEnvironmentExecutionStatus({
        organizationId: input.organizationId,
        executionId: route.runId,
        status: "running",
      });
    }
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
      credentialRevision: resolvedModel.gateway.credentialRevision,
    });
    await activateEnvironmentModelGrant({
      organizationId: input.organizationId,
      environmentId: route.environmentId,
      workspaceId: route.workspaceId,
      threadId: input.sessionId,
      runId: route.runId,
      gatewayId: runtimeModel.gatewayId,
      rawModelId: runtimeModel.model,
      routeBinding: runtimeModel.routeBinding,
    });
    const rememberedToolApprovalEvidence =
      await listRememberedToolApprovalEvidenceForRuntime({
        organizationId: input.organizationId,
        threadId: input.sessionId,
        userId: input.actor.actorId,
      });
    const resolvedProfile = await resolveHostedKestrelExecutionProfile({
      client,
      context,
      route: {
        runId: route.runId,
        environmentId: route.environmentId,
        effectiveCapabilities: route.effectiveCapabilities,
        approvalPolicies: route.approvalPolicies,
        reasoningPolicy: route.reasoningPolicy,
        ociMcpEgressBindings: route.mcpPolicy?.ociEgressBindings,
        rememberedToolApprovalEvidence,
      },
      runtimeModels: [runtimeModel],
    });
    const mcpContext = route.mcpPolicy
      ? await issueHostedMcpRunContext({
          runExecutionId: route.runId,
          threadId: input.sessionId,
          executionProfileId: resolvedProfile.profileId,
          executionProfileFingerprint: resolvedProfile.fingerprint,
          resolvedPolicy: route.mcpPolicy,
        })
      : undefined;
    const runtimeWorkspace = resolveThreadRuntimeWorkspace(
      thread.workspaceMode,
      thread.parentThreadId,
      thread.workspaceBaseRef,
    );
    const result = await generateKestrelOneExternalReplyFromAgent({
      agent: {
        run: (turn, requestContext) =>
          client.runWithProfileIdObservingRuntimeIdentity(
            {
              profileId: resolvedProfile.profileId,
              turn: {
                ...turn,
                eventType: turn.eventType || "user.message",
                ...(route.projectId
                  ? {
                      hostedApprovalAuthority: {
                        version: "runner_hosted_approval_authority_v1" as const,
                        organizationId: input.organizationId,
                        environmentId: route.environmentId,
                        projectId: route.projectId,
                        threadId: input.sessionId,
                      },
                    }
                  : {}),
                ...(runtimeWorkspace ? { workspace: runtimeWorkspace } : {}),
              },
            },
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
      },
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
      ...(projectSkills ? { workspaceSkills: projectSkills.catalog } : {}),
      ...(mcpContext && route.executionTicket
        ? {
            mcpContext,
          }
        : {}),
      ...(route.executionTicket
        ? {
            mcpAuthorization: {
              executionTicket: route.executionTicket,
              ...(route.authorizationRenewal
                ? { renewal: route.authorizationRenewal }
                : {}),
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
      failureCode: readRuntimeErrorCode(error) ?? "RUNTIME_FAILED",
      failureMessage:
        error instanceof Error ? error.message : "Runtime execution failed.",
    }).catch(() => {});
    throw error;
  } finally {
    await client.close();
  }
}

function createExecutionAuthTokenProvider(input: {
  organizationId: string;
  executionId: string;
}) {
  return async () => {
    const route = await resolveEnvironmentExecutionAuthorizationRoute(input);
    if (!route) {
      throw new Error(
        "Environment execution authorization is no longer active.",
      );
    }
    return route.authToken;
  };
}

function createExecutionTransportObserver(input: {
  organizationId: string;
  executionId: string;
}) {
  return (event: { type: string; [key: string]: unknown }) => {
    process.stdout.write(
      `${JSON.stringify({
        ...event,
        type: `agent.runtime.${event.type}`,
        organizationId: input.organizationId,
        executionId: input.executionId,
        occurredAt: new Date().toISOString(),
      })}\n`,
    );
  };
}

export async function createKestrelOneAgentResponse(
  input: KestrelOneAgentResponseInput,
) {
  const desktopLocalModel = input.modelId
    ? await resolveDesktopLocalRuntimeModel({
        selection: input.modelId,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
      })
    : null;
  const resolvedModel = desktopLocalModel
    ? null
    : await getResolvedKestrelRuntimeExecutionModel({
        selection: input.modelId,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
      });
  if (!(desktopLocalModel || resolvedModel)) {
    throw new Error(
      getGatewayResolutionFailureMessage({
        surface: "chat",
        modelId: input.modelId,
      }),
    );
  }

  const managedRuntimeModel = resolvedModel
    ? toKestrelOneRuntimeModelSelection({
        ...resolvedModel.model,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        credentialRevision: resolvedModel.gateway.credentialRevision,
      })
    : null;
  const runtimeModel =
    desktopLocalModel ??
    (getHostedEnvironmentRuntimeMode() === "local"
      ? toDirectLocalRuntimeModelSelection(managedRuntimeModel!)
      : managedRuntimeModel!);
  const agent = input.agent;
  const runtimeAgent = agent
    ? adaptKestrelAgentForKestrelOne(agent)
    : createModelAwareKestrelOneAgent({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        threadId: input.threadId,
        workspaceMode: input.workspaceMode,
        workspaceBaseRef: input.workspaceBaseRef,
        parentThreadId: input.parentThreadId,
        actorUserId: input.session.user.id,
        durableTurnId: input.durableTurnId,
        projectContextRevisionId: input.projectContext?.contextRevisionId,
        projectContextGrantId: input.projectContext?.grantId,
        onExecutionRouted: input.onExecutionRouted,
        onApplicationProgress: input.onApplicationProgress,
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
    resolvedAttachments: input.resolvedAttachments,
    threadFileInventory: input.threadFileInventory,
    approvalDecision: input.approvalDecision,
    interactionResponse: input.interactionResponse,
    modelId: desktopLocalModel?.id ?? resolvedModel!.model.id,
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

export async function createKestrelOneReattachmentResponse(
  input: Omit<KestrelOneAgentResponseInput, "agent" | "onExecutionRouted"> & {
    executionId: string;
  },
) {
  let cursorWrites = Promise.resolve();
  let executionSettlement = Promise.resolve();
  const route = await resolveEnvironmentExecutionAuthorizationRoute({
    organizationId: input.organizationId,
    executionId: input.executionId,
  });
  if (!(route?.runtimeRunId && route.lastRuntimeEventId)) {
    throw connectionInterruptedError(
      "The connection to the agent was interrupted before completion and no durable event cursor was available.",
      "RUNNER_EVENT_CURSOR_UNAVAILABLE",
    );
  }
  const client = new KestrelOneRunnerClient({
    target: {
      kind: "remote",
      baseUrl: route.baseUrl,
      authTokenProvider: createExecutionAuthTokenProvider({
        organizationId: input.organizationId,
        executionId: input.executionId,
      }),
      onTransportEvent: createExecutionTransportObserver({
        organizationId: input.organizationId,
        executionId: input.executionId,
      }),
    },
  });
  const agent: KestrelOneAgent = {
    stream(turn, context) {
      const stream = client.reattachRun(
        {
          sessionId: route.sessionId,
          runId: route.runtimeRunId!,
          sinceEventId: route.lastRuntimeEventId!,
          signal: turn.signal,
          abortBehavior: turn.abortBehavior,
        },
        context,
      );
      executionSettlement = stream.result.then(
        async (terminal) => {
          await cursorWrites;
          await updateEnvironmentExecutionStatus({
            organizationId: input.organizationId,
            executionId: input.executionId,
            status: terminalExecutionStatus(terminal),
            ...terminalFailureEvidence(terminal),
          });
        },
        async (error: unknown) => {
          const code = readRuntimeErrorCode(error);
          if (
            code !== "RUNNER_EVENT_CURSOR_EXPIRED" &&
            code !== "RUNNER_EVENT_CURSOR_UNKNOWN"
          ) {
            // A transport interruption leaves the execution active for the
            // next durable worker lease to reattach.
            return;
          }
          await cursorWrites;
          await updateEnvironmentExecutionStatus({
            organizationId: input.organizationId,
            executionId: input.executionId,
            status: "failed",
            failureCode: code ?? "RUNTIME_FAILED",
            failureMessage:
              error instanceof Error
                ? error.message
                : "Runtime execution failed.",
          });
        },
      );
      void executionSettlement.catch(() => {});
      return stream;
    },
    close: () => client.close(),
  };
  return createKestrelOneAgentResponseFromAgent({
    request: input.request,
    agent,
    ownsAgent: true,
    session: input.session,
    organizationId: input.organizationId,
    correlation: readRequestCorrelation(input.request),
    threadId: input.threadId,
    durableTurnId: input.durableTurnId,
    messages: input.messages,
    resolvedAttachments: input.resolvedAttachments,
    approvalDecision: input.approvalDecision,
    interactionResponse: input.interactionResponse,
    modelId: input.modelId ?? "kestrel",
    interactionMode: input.interactionMode,
    projectContext: input.projectContext,
    transientTitle: null,
    signal: input.signal,
    onUiChunk: input.onUiChunk,
    onRuntimeEvent: (event) => {
      cursorWrites = cursorWrites.then(() =>
        settleEnvironmentExecutionRuntimeEvent({
          organizationId: input.organizationId,
          executionId: input.executionId,
          eventId: event.id,
          ...(runtimeTerminalStatus(event.type) !== undefined
            ? { terminalStatus: runtimeTerminalStatus(event.type) }
            : {}),
        }),
      );
      void cursorWrites.catch(() => {});
      input.onRuntimeEvent?.(event);
    },
    onFinishPersist: async (messages, meta) => {
      await cursorWrites;
      await executionSettlement;
      await input.onFinishPersist?.(messages, meta);
    },
  });
}

export async function createKestrelOneRecoveredCompletionResponse(
  input: Omit<KestrelOneAgentResponseInput, "agent" | "onExecutionRouted"> & {
    executionId: string;
  },
) {
  const route = await resolveEnvironmentExecutionRecoveryRoute({
    organizationId: input.organizationId,
    executionId: input.executionId,
  });
  if (!(route?.runtimeRunId && route.lastRuntimeEventId && route.completedAt)) {
    throw connectionInterruptedError(
      "The completed agent result is unavailable for durable recovery.",
      "RUNNER_TERMINAL_RESULT_UNAVAILABLE",
    );
  }
  const client = new KestrelOneRunnerClient({
    target: {
      kind: "remote",
      baseUrl: route.baseUrl,
      authToken: route.authToken,
    },
  });
  let terminal: RunnerRunTerminalEvent;
  try {
    const event = await client.sendCommand(
      "conversation.messages.list",
      {
        threadId: route.sessionId,
        limit: 100,
        includeFinalizedPayload: true,
      },
      {
        tenantId: input.organizationId,
        actor: {
          actorId: route.actorId,
          actorType: "operator",
          tenantId: input.organizationId,
          orgRole: "org_admin",
        },
      },
    );
    terminal = createRecoveredKestrelOneCompletion({
      runtimeRunId: route.runtimeRunId,
      sessionId: route.sessionId,
      terminalEventId: route.lastRuntimeEventId,
      completedAt: route.completedAt.toISOString(),
      messages: event.payload.messages,
    });
  } finally {
    await client.close();
  }

  const agent: KestrelOneAgent = {
    stream() {
      return {
        ready: Promise.resolve(),
        result: Promise.resolve(terminal),
        cancel: async () => {},
        async *[Symbol.asyncIterator]() {
          yield terminal;
        },
      };
    },
    close: async () => {},
  };
  return createKestrelOneAgentResponseFromAgent({
    request: input.request,
    agent,
    ownsAgent: true,
    session: input.session,
    organizationId: input.organizationId,
    correlation: readRequestCorrelation(input.request),
    threadId: input.threadId,
    durableTurnId: input.durableTurnId,
    messages: input.messages,
    resolvedAttachments: input.resolvedAttachments,
    approvalDecision: input.approvalDecision,
    interactionResponse: input.interactionResponse,
    modelId: input.modelId ?? "kestrel",
    interactionMode: input.interactionMode,
    projectContext: input.projectContext,
    transientTitle: null,
    signal: input.signal,
    onUiChunk: input.onUiChunk,
    onRuntimeEvent: input.onRuntimeEvent,
    onFinishPersist: input.onFinishPersist,
  });
}

function runtimeTerminalStatus(eventType: string) {
  if (eventType === "run.completed") return "completed" as const;
  if (eventType === "run.failed") return "failed" as const;
  if (eventType === "run.cancelled") return "cancelled" as const;
  return;
}

function connectionInterruptedError(message: string, detailCode: string) {
  const error = new Error(message) as Error & {
    code: string;
    details: { code: string };
  };
  error.name = "KestrelConnectionInterruptedError";
  error.code = "AGENT_CONNECTION_INTERRUPTED";
  error.details = { code: detailCode };
  return error;
}

function terminalExecutionStatus(
  terminal: RunnerRunTerminalEvent,
): "completed" | "failed" | "cancelled" {
  if (terminal.type === "run.cancelled") return "cancelled";
  if (terminal.type === "run.failed") return "failed";
  return "completed";
}

function terminalFailureEvidence(terminal: RunnerRunTerminalEvent) {
  return terminal.type === "run.failed"
    ? {
        failureCode: terminal.payload.error.code,
        failureMessage: terminal.payload.error.message,
      }
    : {};
}

function readRuntimeErrorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function mapHostedKestrelProfileResolutionError(
  error: unknown,
  selection: EnvironmentRuntimeModelSelection | undefined,
): unknown {
  if (
    readRuntimeErrorCode(error) !== HOSTED_MODEL_ECONOMICS_PROFILE_REQUIRED_CODE
  ) {
    return error;
  }
  const details =
    error !== null &&
    typeof error === "object" &&
    "details" in error &&
    typeof error.details === "object" &&
    error.details !== null
      ? (error.details as Record<string, unknown>)
      : undefined;
  const provider =
    typeof details?.provider === "string"
      ? details.provider
      : selection?.provider;
  const model =
    typeof details?.model === "string" ? details.model : selection?.model;
  const message =
    provider !== undefined && model !== undefined
      ? `Kestrel One cannot start with ${provider}/${model} because that exact hosted model does not have a Kestrel economics profile. Choose a supported model and try again.`
      : "Kestrel One cannot start because its hosted model route is not pinned to an exact supported provider and model. Choose a supported model and try again.";
  const mapped = new Error(message) as Error & {
    code: string;
    details?: Record<string, unknown> | undefined;
  };
  mapped.name = "KestrelHostedModelProfileError";
  mapped.code = HOSTED_MODEL_ECONOMICS_PROFILE_REQUIRED_CODE;
  if (details !== undefined) mapped.details = details;
  return mapped;
}

async function resolveDesktopLocalRuntimeModel(input: {
  selection: string;
  organizationId: string;
  environmentId: string;
}): Promise<DesktopLocalRuntimeModelSelection | null> {
  const selection = parseDesktopLocalRuntimeModelId(input.selection);
  if (!selection) return null;
  const { model, provider } = selection;
  const connection =
    await knowledgeDb.query.desktopEnvironmentConnections.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          eq(table.status, "active"),
        ),
      columns: { advertisedModels: true },
    });
  const advertised = connection?.advertisedModels.some((candidate) =>
    isDesktopModelRoleReady({
      model: candidate,
      provider,
      modelId: model,
      role: "agent.loop",
    }),
  );
  if (!advertised) {
    throw new Error(
      `Desktop-local model '${provider}/${model}' is unavailable. No fallback was selected.`,
    );
  }
  return {
    desktopLocal: true,
    id: input.selection,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    provider,
    model,
  };
}

function toDirectLocalRuntimeModelSelection(
  selection: KestrelOneRuntimeModelSelection,
): DirectLocalRuntimeModelSelection {
  return {
    directLocal: true,
    id: selection.id,
    organizationId: selection.organizationId,
    environmentId: selection.environmentId,
    provider: selection.provider,
    model: selection.model,
    ...(selection.economicsProfile !== undefined
      ? { economicsProfile: selection.economicsProfile }
      : {}),
  };
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
