import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";

import {
  createAnthropicModelGatewayFromEnv,
  createLmStudioModelGatewayFromEnv,
  createOpenAiModelGatewayFromEnv,
  createOllamaModelGatewayFromEnv,
  createOpenRouterModelGatewayFromEnv,
  createSessionStoreFromEnv,
  createProviderReasoningVaultFromEnv,
  DEFAULT_ACT_SUBMODE,
  LocalDevShellService,
  DEFAULT_INTERACTION_MODE,
  DEFAULT_BALANCED_TOOL_ALLOWLIST,
  type GuardrailConfig,
  Kestrel,
  type NormalizedOutput,
  type RunEvent,
  ProductTaskGraphStore,
  createProductProjectActionToolAdapter,
  ProductProjectRuntimeService,
  requireProductProjectRuntimeService,
  ProductProjectStateStore,
  createEmptyProjectSnapshot,
  type RuntimeTurnInput,
  type RuntimeTurnResult,
  type ProgressUpdateV1,
  type ReasoningUpdateV1,
  type ModelReasoningUpdateV1,
  type RunConsoleUpdateV1,
  type RunLogEntry,
  ThreadRuntime,
  type ToolRuntimeStatus,
  type ToolExecutionClass,
  UnifiedToolRegistry,
  WorkspaceCheckpointService,
  RuntimeWorkspaceCheckpointService,
  WorkspaceContextResolver,
  RuntimeTurnCoordinatorService,
  RuntimeThreadedTurnExecutor,
  ManagedTaskWorktreeService,
  applyActiveTaskRuntimeMetadata,
  resolveRuntimeWorkspaceAuthority,
  createTurnExecutor,
  buildRuntimeSessionStateProjection,
  buildRuntimeTaskGraphProjection,
  persistDelegationTaskUpdateToGraph,
  buildOperatorSessionProjection,
  type OperatorAssemblySummary,
  type OperatorChildBlockerChainSummary,
  type OperatorCheckpointSummary,
  type OperatorChildBlockerSummary,
  type OperatorFanInDispositionSummary,
  type OperatorSessionProjection,
  type RuntimeTaskGraphProjection,
  type RuntimeSessionStateProjection,
  type OperatorSupervisionSummary,
  type OperatorSupervisedChildSummary,
  type OperatorInboxSummary,
  type OperatorSteeringSummary,
} from "../../src/index.js";
import type { OperatorCompactionState, OperatorAffordancePayload, WorkspaceRuntimeContext, SkillPackDefinition, TuiProfile } from "../contracts.js";
import { createGatewayManagedModelGateway } from "./gateway-credential-broker.js";
import type { ModelGateway, ModelRequest } from "../../src/kestrel/contracts/model-io.js";
import type { SessionStore } from "../../src/kestrel/contracts/store.js";
import type { RunTurnAttachment } from "../../src/kestrel/contracts/orchestration.js";

import { createToolProviderConfigurationResolverFromEnvironment, type SharedToolContext } from "../../tools/index.js";
import { registerAgent } from "./AgentFactory.js";
import type { DelegationTaskUpdate } from "../../src/orchestration/index.js";
import { getSkillPackById } from "./skillPacks.js";
import { buildExecutionPolicyFromPack } from "./approvalPolicyPacks.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { MacOsDesktopHostOpenService } from "../../src/desktopShell/hostOpen.js";
import { createTerminalBenchDevShellServiceFromEnv } from "../../src/devshell/TerminalBenchDevShellService.js";
import { createRuntimeHeapDiagnosticsFromEnv } from "../../src/runtime/heapDiagnostics.js";
import type {
  ProductProjectAction,
  ProductProjectSnapshot,
  ProductReviewAction,
  ProductReviewDetail,
  ProductReviewTarget,
} from "../../src/project/contracts.js";
import { readWaitResumeStepAgent } from "../../src/runtime/waitState.js";
import type {
  WorkspaceCheckpointCleanupPolicy,
  WorkspaceCheckpointCleanupResult,
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointRecord,
  WorkspaceDiffRecord,
  WorkspacePromotionPreview,
  WorkspacePromotionRecord,
  WorkspaceRestoreRecord,
} from "../../src/workspaceCheckpoints/contracts.js";
import { resolveKestrelCoreHome } from "../../src/localCore/home.js";
import { UserTerminalService, type UserTerminalReadResult, type UserTerminalRecord } from "../../src/terminal/UserTerminalService.js";
import { WorkspaceChangeService } from "../../src/changes/WorkspaceChangeService.js";
import type {
  WorkspaceChangeMutation,
  WorkspaceChangeMutationResult,
  WorkspaceChangeScope,
  WorkspaceChangeSnapshot,
  WorkspaceDiffOptions,
} from "../../src/changes/contracts.js";
import { WorkspaceFeedbackService } from "../../src/review/WorkspaceFeedbackService.js";
import { WorkspaceReviewService, type ProposedWorkspaceReviewFinding } from "../../src/review/WorkspaceReviewService.js";
import type { WorkspaceFeedbackSnapshot, WorkspaceReviewSnapshot } from "../../src/review/contracts.js";
import { WorkspaceValidationService } from "../../src/validation/WorkspaceValidationService.js";
import type { WorkspaceValidationSnapshot } from "../../src/validation/contracts.js";
import { WorkspaceGitService } from "../../src/git/WorkspaceGitService.js";
import type { WorkspaceGitAction, WorkspaceGitSnapshot } from "../../src/git/contracts.js";
export type { DelegationTaskUpdate } from "../../src/orchestration/index.js";

export type RunTurnInput = Omit<RuntimeTurnInput, "workspace" | "skillPack" | "autoCompaction"> & {
  autoCompaction?:
    | {
        enabled?: boolean | undefined;
        state?: OperatorCompactionState | undefined;
        suppressOnce?: boolean | undefined;
      }
    | undefined;
  workspace?: WorkspaceRuntimeContext | undefined;
  skillPack?: SkillPackDefinition | undefined;
};

export type RunTurnResult = RuntimeTurnResult & {
  output: NormalizedOutput;
  operatorAffordance?: OperatorAffordancePayload | undefined;
};

interface RuntimeBootstrap {
  kestrel: Kestrel;
  threadRuntime?: ThreadRuntime | undefined;
  taskGraphStore?: ProductTaskGraphStore | undefined;
  projectStore?: ProductProjectStateStore | undefined;
  workspaceCheckpointService?: WorkspaceCheckpointService | undefined;
  managedTaskWorktreeService?: ManagedTaskWorktreeService | undefined;
  userTerminalService?: UserTerminalService | undefined;
  userTerminalReady?: Promise<void> | undefined;
  workspaceChangeService?: WorkspaceChangeService | undefined;
  workspaceFeedbackService?: WorkspaceFeedbackService | undefined;
  workspaceFeedbackReady?: Promise<void> | undefined;
  workspaceReviewService?: WorkspaceReviewService | undefined;
  workspaceReviewReady?: Promise<void> | undefined;
  workspaceValidationService?: WorkspaceValidationService | undefined;
  workspaceValidationReady?: Promise<void> | undefined;
  workspaceGitService?: WorkspaceGitService | undefined;
  workspaceGitReady?: Promise<void> | undefined;
  close: () => Promise<void>;
  entryStepAgent: string;
  readFinalizedPayload?: ((sessionId: string) => Promise<unknown | undefined>) | undefined;
  prepareHostedMcpRuntime?:
    | ((input: Pick<RunTurnInput, "sessionId" | "mcpContext" | "mcpAuthorization">) => Promise<unknown>)
    | undefined;
  releaseRuntimeAuthorization?: ((sessionId: string) => void) | undefined;
  reasoningPolicyReady?: Promise<unknown> | undefined;
}

const DEFAULT_KCHAT_GUARDRAILS: Partial<GuardrailConfig> = {
  maxStepVisits: 80,
  maxConcurrentToolJobsPerRun: 8,
  maxConcurrentToolJobsGlobal: 24,
  maxQueuedToolJobsPerRun: 50,
  toolBatchCheckpointSize: 10,
  toolCallRetryCount: 1,
};
const LOCAL_OPENAI_COMPATIBLE_MODEL_TIMEOUT_MS = 45_000;
const LOCAL_OPENAI_COMPATIBLE_MODEL_RETRY_COUNT = 0;
export interface RuntimeFactory {
  create(
    profile: TuiProfile,
    onFinalize: (payload: unknown) => unknown,
    onRunLog?: ((entry: RunLogEntry) => void) | undefined,
    onProgress?: ((update: ProgressUpdateV1) => void) | undefined,
    onConsole?: ((update: RunConsoleUpdateV1) => void) | undefined,
    onReasoning?: ((update: ReasoningUpdateV1 | ModelReasoningUpdateV1) => void) | undefined,
    onTaskUpdate?: ((update: DelegationTaskUpdate) => void) | undefined,
    onRunEvent?: ((event: RunEvent) => void) | undefined,
  ): RuntimeBootstrap;
}

export interface KestrelRuntimeEnvironment {
  runtimeEnv: NodeJS.ProcessEnv;
  modelEnv: NodeJS.ProcessEnv;
  internetEnv: NodeJS.ProcessEnv;
  mcpEnv: NodeJS.ProcessEnv;
}

export interface RuntimeFactoryWithStoreOptions {
  resolveEnvironment?: ((profile: TuiProfile) => KestrelRuntimeEnvironment) | undefined;
  enableUserTerminals?: boolean | undefined;
  enableWorkspaceChanges?: boolean | undefined;
  resolveAttachments?: ((threadId: string, attachmentIds: string[]) => Promise<RunTurnAttachment[]>) | undefined;
}

export interface KestrelChatRuntimeOptions {
  onRunLog?: ((entry: RunLogEntry) => void) | undefined;
  onProgress?: ((update: ProgressUpdateV1) => void) | undefined;
  onConsole?: ((update: RunConsoleUpdateV1) => void) | undefined;
  onReasoning?: ((update: ReasoningUpdateV1 | ModelReasoningUpdateV1) => void) | undefined;
  onTaskUpdate?: ((update: DelegationTaskUpdate) => void) | undefined;
  onRunEvent?: ((event: RunEvent) => void) | undefined;
}

export class KestrelChatRuntime {
  private readonly kestrel: Kestrel;
  private readonly threadRuntime: ThreadRuntime | undefined;
  private readonly taskGraphStore: ProductTaskGraphStore | undefined;
  private readonly projectStore: ProductProjectStateStore | undefined;
  private readonly projectRuntimeService: ProductProjectRuntimeService | undefined;
  private readonly workspaceCheckpointService: WorkspaceCheckpointService | undefined;
  private readonly runtimeWorkspaceCheckpointService: RuntimeWorkspaceCheckpointService | undefined;
  private readonly userTerminalService: UserTerminalService | undefined;
  private readonly userTerminalReady: Promise<void>;
  private readonly workspaceChangeService: WorkspaceChangeService | undefined;
  private readonly workspaceFeedbackService: WorkspaceFeedbackService | undefined;
  private readonly workspaceFeedbackReady: Promise<void>;
  private readonly workspaceReviewService: WorkspaceReviewService | undefined;
  private readonly workspaceReviewReady: Promise<void>;
  private readonly workspaceValidationService: WorkspaceValidationService | undefined;
  private readonly workspaceValidationReady: Promise<void>;
  private readonly workspaceGitService: WorkspaceGitService | undefined;
  private readonly workspaceGitReady: Promise<void>;
  private readonly entryStepAgent: string;
  private readonly closePool: () => Promise<void>;
  private readonly toolBatchCheckpointSize: number;
  private readonly defaultInteractionMode: "chat" | "plan" | "build";
  private readonly defaultActSubmode: "strict" | "safe" | "full_auto";
  private readonly forceModeSystemV2: boolean;
  private readonly modeSystemV2Enabled: boolean;
  private readonly defaultExecutionPolicy: RunTurnInput["executionPolicy"];
  private readonly readFinalizedPayload: ((sessionId: string) => Promise<unknown | undefined>) | undefined;
  private readonly turnCoordinator: RuntimeTurnCoordinatorService;
  private readonly prepareHostedMcpRuntime: RuntimeBootstrap["prepareHostedMcpRuntime"];
  private readonly releaseRuntimeAuthorization: RuntimeBootstrap["releaseRuntimeAuthorization"];
  private readonly reasoningPolicyReady: Promise<unknown>;

  private finalizedPayload: unknown;

  constructor(profile: TuiProfile, factory: RuntimeFactory = { create: createDefaultRuntime }, options: KestrelChatRuntimeOptions = {}) {
    const bootstrap = factory.create(
      profile,
      (payload) => {
        this.finalizedPayload = payload;
        return payload;
      },
      options.onRunLog,
      options.onProgress,
      options.onConsole,
      options.onReasoning,
      options.onTaskUpdate,
      options.onRunEvent,
    );

    this.kestrel = bootstrap.kestrel;
    this.threadRuntime = bootstrap.threadRuntime;
    this.taskGraphStore = bootstrap.taskGraphStore;
    this.projectStore = bootstrap.projectStore;
    this.projectRuntimeService =
      bootstrap.taskGraphStore !== undefined && bootstrap.projectStore !== undefined
        ? new ProductProjectRuntimeService({
            taskGraphStore: bootstrap.taskGraphStore,
            projectStore: bootstrap.projectStore,
            turnRunner: {
              runTurn: (turn, runOptions) => this.runTurn(turn as RunTurnInput, runOptions),
            },
          })
        : undefined;
    this.workspaceCheckpointService = bootstrap.workspaceCheckpointService;
    this.runtimeWorkspaceCheckpointService =
      bootstrap.workspaceCheckpointService !== undefined && bootstrap.projectStore !== undefined
        ? new RuntimeWorkspaceCheckpointService({
            checkpointService: bootstrap.workspaceCheckpointService,
            resolver: new WorkspaceContextResolver({
              getProjectSnapshot: (input) => this.getProjectSnapshot(input),
              getThreadWorkspace: async ({ threadId }) => {
                const view = await this.getOperatorThreadView(threadId);
                return view?.workspace === undefined
                  ? undefined
                  : {
                      sessionId: view.thread.sessionId,
                      kind: view.workspace.kind,
                      workspaceRoot: view.workspace.workspaceRoot,
                    };
              },
              updateManagedWorktreeBinding: async ({ sessionId, binding }) => {
                await this.kestrel.updateManagedWorktreeBinding(sessionId, binding);
              },
            }),
            ...(bootstrap.managedTaskWorktreeService !== undefined
              ? {
                  managedWorktreeService: bootstrap.managedTaskWorktreeService,
                }
              : {}),
          })
        : undefined;
    this.userTerminalService = bootstrap.userTerminalService;
    this.userTerminalReady = bootstrap.userTerminalReady ?? Promise.resolve();
    this.workspaceChangeService = bootstrap.workspaceChangeService;
    this.workspaceFeedbackService = bootstrap.workspaceFeedbackService;
    this.workspaceFeedbackReady = bootstrap.workspaceFeedbackReady ?? Promise.resolve();
    this.workspaceReviewService = bootstrap.workspaceReviewService;
    this.workspaceReviewReady = bootstrap.workspaceReviewReady ?? Promise.resolve();
    this.workspaceValidationService = bootstrap.workspaceValidationService;
    this.workspaceValidationReady = bootstrap.workspaceValidationReady ?? Promise.resolve();
    this.workspaceGitService = bootstrap.workspaceGitService;
    this.workspaceGitReady = bootstrap.workspaceGitReady ?? Promise.resolve();
    this.entryStepAgent = bootstrap.entryStepAgent;
    this.closePool = bootstrap.close;
    this.readFinalizedPayload = bootstrap.readFinalizedPayload;
    this.prepareHostedMcpRuntime = bootstrap.prepareHostedMcpRuntime;
    this.releaseRuntimeAuthorization = bootstrap.releaseRuntimeAuthorization;
    this.reasoningPolicyReady = bootstrap.reasoningPolicyReady ?? Promise.resolve();
    this.forceModeSystemV2 = profile.agent === "reference-react";
    this.modeSystemV2Enabled = this.forceModeSystemV2 || profile.modeSystemV2Enabled === true;
    this.defaultExecutionPolicy = buildExecutionPolicyFromPack(profile.approvalPolicyPackId);
    this.defaultInteractionMode = profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE;
    this.defaultActSubmode = profile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE;
    this.toolBatchCheckpointSize = normalizePositiveInt(
      profile.toolQueue?.checkpointSize ?? profile.guardrails?.toolBatchCheckpointSize ?? DEFAULT_KCHAT_GUARDRAILS.toolBatchCheckpointSize ?? 5,
      5,
    );
    this.turnCoordinator = new RuntimeTurnCoordinatorService({
      defaults: {
        defaultInteractionMode: this.defaultInteractionMode,
        defaultActSubmode: this.defaultActSubmode,
        modeSystemV2Enabled: this.modeSystemV2Enabled,
        forceModeSystemV2: this.forceModeSystemV2,
        defaultExecutionPolicy: this.defaultExecutionPolicy,
        toolBatchCheckpointSize: this.toolBatchCheckpointSize,
      },
      ...(this.threadRuntime !== undefined ? { threadRuntime: this.threadRuntime } : {}),
      directRun: async (event, runOptions) => this.kestrel.run(event, runOptions),
      getSession: async (sessionId) => (await this.kestrel.getSession(sessionId)) ?? undefined,
      readFinalizedPayload: async (sessionId) => {
        if (this.finalizedPayload !== undefined) {
          return this.finalizedPayload;
        }
        return this.readFinalizedPayload?.(sessionId);
      },
      readPersistedResumeStepAgent: async (sessionId) => {
        const session = await this.kestrel.getSession(sessionId);
        return readResumeStepAgentFromSession(session?.state);
      },
    });
  }

  getEntryStepAgent(): string {
    return this.entryStepAgent;
  }

  async runTurn(input: RunTurnInput, options: { signal?: AbortSignal | undefined } = {}): Promise<RunTurnResult> {
    await this.reasoningPolicyReady;
    this.finalizedPayload = undefined;
    const normalizedInput: RunTurnInput = {
      ...input,
      message: requireRunTurnMessage(input.message),
    };
    const effectiveInput = await applyActiveTaskRuntimeMetadata(normalizedInput, this.taskGraphStore);
    const policyBoundWorkspace = applyRequiredManagedWorkspacePolicy(effectiveInput.workspace);
    const authorizedInput: RunTurnInput = {
      ...effectiveInput,
      ...(policyBoundWorkspace !== undefined
        ? {
            workspace:
              resolveRuntimeWorkspaceAuthority({
                workspace: policyBoundWorkspace,
                interactionMode: effectiveInput.interactionMode,
                actSubmode: effectiveInput.actSubmode,
                defaultInteractionMode: this.defaultInteractionMode,
                defaultActSubmode: this.defaultActSubmode,
              }) ?? policyBoundWorkspace,
          }
        : {}),
    };
    const { mcpAuthorization, ...persistableInput } = authorizedInput;
    try {
      if (mcpAuthorization !== undefined) {
        if (this.prepareHostedMcpRuntime === undefined) {
          throw new Error("Runtime execution authorization is unavailable");
        }
        await this.prepareHostedMcpRuntime({
          sessionId: persistableInput.sessionId,
          ...(persistableInput.mcpContext !== undefined
            ? { mcpContext: persistableInput.mcpContext }
            : {}),
          mcpAuthorization,
        });
      }
      const result = await this.turnCoordinator.runTurn(persistableInput, options);
      if (result.finalizedPayload !== undefined) {
        this.finalizedPayload = result.finalizedPayload;
      }
      return result as RunTurnResult;
    } finally {
      if (mcpAuthorization !== undefined) {
        this.releaseRuntimeAuthorization?.(persistableInput.sessionId);
      }
    }
  }

  async getToolRuntimeStatus(): Promise<ToolRuntimeStatus> {
    return this.kestrel.getToolRuntimeStatus();
  }

  async describeSession(sessionId: string): Promise<
    | {
        sessionId: string;
        version: number;
        threadId?: string | undefined;
        currentStepAgent?: string | undefined;
        updatedAt?: string | undefined;
        waitFor?: NormalizedOutput["waitFor"] | undefined;
        activeAssembly?: OperatorAssemblySummary | undefined;
        operatorInbox?: OperatorInboxSummary | undefined;
        childBlocker?: OperatorChildBlockerSummary | undefined;
        childThreads?: OperatorSupervisedChildSummary[] | undefined;
        childBlockerChainDetails?: OperatorChildBlockerChainSummary[] | undefined;
        blockerChain?: string[] | undefined;
        dominantBlocker?: string | undefined;
        latestCheckpoint?: OperatorCheckpointSummary | undefined;
        latestCheckpointDisposition?: OperatorCheckpointSummary["status"] | undefined;
        latestFanInDisposition?: OperatorFanInDispositionSummary | undefined;
        latestSteering?: OperatorSteeringSummary | undefined;
        latestReasoning?: import("../contracts.js").OperatorReasoningSummary | undefined;
        latestAdaptation?: import("../contracts.js").OperatorAdaptationSummary | undefined;
        latestEvidenceRecovery?: import("../contracts.js").OperatorEvidenceRecoverySummary | undefined;
        supervision?: OperatorSupervisionSummary | undefined;
        nextAction?: string | undefined;
        runtimePlan?: OperatorAffordancePayload["runtimePlan"] | undefined;
        visibleTodos?: import("../../src/runtime/visibleTodos.js").VisibleTodoState | undefined;
        contextPosture?: string | undefined;
        operatorPhase?: import("../../src/orchestration/index.js").OperatorThreadView["operatorPhase"] | undefined;
        modelProvenance?: import("../../src/replay/RunReplayService.js").ReplayModelProvenanceSummary | undefined;
        focusedThreadId?: string | undefined;
        operatorThreadView?: import("../../src/orchestration/index.js").OperatorThreadView | undefined;
      }
    | undefined
  > {
    if (this.threadRuntime !== undefined) {
      await this.ensureMainThread(sessionId);
    }
    const session = await this.kestrel.getSession(sessionId);
    if (session === null) {
      return;
    }
    return this.buildSessionDescription(sessionId, session);
  }

  async getSessionState(sessionId: string): Promise<RuntimeSessionStateProjection | undefined> {
    const session = await this.kestrel.getSession(sessionId);
    if (session === null) {
      return;
    }
    return buildRuntimeSessionStateProjection({
      sessionId,
      session,
      ...(this.threadRuntime !== undefined ? { threadRuntime: this.threadRuntime } : {}),
      ...(this.taskGraphStore !== undefined ? { taskGraphStore: this.taskGraphStore } : {}),
    });
  }

  private async buildSessionDescription(
    sessionId: string,
    session: {
      version: number;
      currentStepAgent?: string | undefined;
      updatedAt?: string | undefined;
      state: Record<string, unknown>;
    },
  ): Promise<OperatorSessionProjection> {
    return buildOperatorSessionProjection({
      sessionId,
      session,
      ...(this.threadRuntime !== undefined ? { threadRuntime: this.threadRuntime } : {}),
    });
  }

  async listOperatorInbox(input: { sessionId?: string | undefined; threadId?: string | undefined }) {
    if (this.threadRuntime === undefined) {
      return {
        items: [],
        summary: {
          total: 0,
          actionable: 0,
          approvals: 0,
          userInputs: 0,
          checkpoints: 0,
          childBlockers: 0,
          stalled: 0,
          assemblyProposals: 0,
          compatibilityAlerts: 0,
        },
      };
    }
    return this.threadRuntime.listOperatorInbox(input);
  }

  async getOperatorThreadView(threadId: string) {
    return this.threadRuntime?.getOperatorThreadView(threadId) ?? null;
  }

  async listOperatorRuns(
    input: {
      sessionId?: string | undefined;
      status?: import("../../src/orchestration/contracts.js").OperatorRunStatus | undefined;
      limit?: number | undefined;
    } = {},
  ) {
    return (
      this.threadRuntime?.listOperatorRuns(input) ?? {
        version: "operator-run-index-v1" as const,
        generatedAt: new Date().toISOString(),
        filters: {
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          limit: Math.max(1, Math.min(input.limit ?? 25, 50)),
        },
        hasMore: false,
        runs: [],
        sessions: [],
      }
    );
  }

  async getOperatorRunView(runId: string) {
    return this.threadRuntime?.getOperatorRunView(runId) ?? null;
  }

  async getTaskGraph(input: { sessionId: string; threadId?: string | undefined }): Promise<RuntimeTaskGraphProjection> {
    const session = await this.kestrel.getSession(input.sessionId);
    return buildRuntimeTaskGraphProjection({
      sessionId: input.sessionId,
      session,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(this.threadRuntime !== undefined ? { threadRuntime: this.threadRuntime } : {}),
      ...(this.taskGraphStore !== undefined ? { taskGraphStore: this.taskGraphStore } : {}),
    });
  }

  async updateTaskGraph(input: { sessionId: string; graph: import("../../src/index.js").ProductTaskGraph; expectedVersion?: number | undefined }) {
    if (this.taskGraphStore === undefined) {
      const session = await this.kestrel.getSession(input.sessionId);
      return {
        sessionId: input.sessionId,
        version: session?.version ?? 0,
        graph: input.graph,
      };
    }
    const persisted = await this.taskGraphStore.saveGraph(input);
    return {
      sessionId: input.sessionId,
      version: persisted.version,
      graph: persisted.graph,
    };
  }

  async getProjectSnapshot(input: { sessionId: string }): Promise<{ sessionId: string; snapshot: ProductProjectSnapshot }> {
    if (this.projectRuntimeService !== undefined) {
      return this.projectRuntimeService.getProjectSnapshot(input);
    }
    if (this.projectStore === undefined) {
      return {
        sessionId: input.sessionId,
        snapshot: createEmptyProjectSnapshot(),
      };
    }
    const graph = this.taskGraphStore === undefined ? undefined : await this.taskGraphStore.getGraph({ sessionId: input.sessionId });
    return {
      sessionId: input.sessionId,
      snapshot: await this.projectStore.getSnapshot({
        sessionId: input.sessionId,
        ...(graph !== undefined ? { graph } : {}),
      }),
    };
  }

  async updateProjectSnapshot(input: { sessionId: string; snapshot: ProductProjectSnapshot }) {
    if (this.projectRuntimeService !== undefined) {
      return this.projectRuntimeService.updateProjectSnapshot(input);
    }
    if (this.projectStore === undefined) {
      return {
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      };
    }
    const snapshot = await this.projectStore.saveSnapshot(input.sessionId, input.snapshot);
    return {
      sessionId: input.sessionId,
      snapshot,
    };
  }

  async performProjectAction(input: ProductProjectAction) {
    return requireProductProjectRuntimeService(this.projectRuntimeService).performProjectAction(input);
  }

  async captureWorkspaceCheckpoint(input: {
    sessionId: string;
    label?: string | undefined;
    reason?: string | undefined;
    threadId?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
  }): Promise<{ sessionId: string; checkpoint: WorkspaceCheckpointDetail }> {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).capture(input);
  }

  async listWorkspaceCheckpoints(input: { sessionId: string }): Promise<{ sessionId: string; checkpoints: WorkspaceCheckpointRecord[] }> {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).list(input);
  }

  async inspectWorkspaceCheckpoint(input: { sessionId: string; checkpointId: string }): Promise<{ sessionId: string; checkpoint: WorkspaceCheckpointDetail }> {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).inspect(input);
  }

  async diffWorkspaceCheckpoints(input: {
    sessionId: string;
    source: {
      checkpointId?: string | undefined;
      gitRef?: string | undefined;
      workingTree?: boolean | undefined;
    };
    target: {
      checkpointId?: string | undefined;
      gitRef?: string | undefined;
      workingTree?: boolean | undefined;
    };
    includeHunks?: boolean | undefined;
  }): Promise<{ sessionId: string; diff: WorkspaceDiffRecord }> {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).diff(input);
  }

  async restoreWorkspaceCheckpoint(input: {
    sessionId: string;
    checkpointId: string;
    reason?: string | undefined;
    threadId?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
  }): Promise<{ sessionId: string; restore: WorkspaceRestoreRecord }> {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).restore(input);
  }

  async cleanupWorkspaceCheckpoints(input: {
    sessionId: string;
    reason?: string | undefined;
    policyOverride?: Partial<WorkspaceCheckpointCleanupPolicy> | undefined;
  }): Promise<{ sessionId: string } & WorkspaceCheckpointCleanupResult> {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).cleanup(input);
  }

  async restoreLatestWorkspacePromotion(input: {
    sessionId: string;
    reason?: string | undefined;
  }): Promise<{ sessionId: string; restore: WorkspaceRestoreRecord }> {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).restoreLatestPromotion(input);
  }

  async listWorkspacePromotions(input: { sessionId: string }): Promise<{ sessionId: string; promotions: WorkspacePromotionRecord[] }> {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).listPromotions(input);
  }

  async previewWorkspacePromotion(input: { sessionId: string; promotionId: string }): Promise<{ sessionId: string; preview: WorkspacePromotionPreview }> {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).previewPromotion(input);
  }

  async applyWorkspacePromotion(input: { sessionId: string; promotionId: string; candidateFingerprint: string; appliedBy?: string | undefined }) {
    if (this.workspaceValidationService !== undefined) await this.assertWorkspaceDeliveryReady({ sessionId: input.sessionId, threadId: input.sessionId }, "promotion");
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).applyPromotion(input);
  }

  async inspectManagedWorktree(input: { sessionId: string; threadId: string }) {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).inspectManagedWorktree(input);
  }

  async cleanupManagedWorktree(input: { sessionId: string; threadId: string; reason: string; cleanedBy?: string | undefined }) {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).cleanupManagedWorktree(input);
  }

  async restoreManagedWorktree(input: {
    sessionId: string;
    threadId: string;
    checkpointId: string;
    reason?: string | undefined;
    restoredBy?: string | undefined;
  }) {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).restoreManagedWorktree(input);
  }

  async retryManagedWorktreeSetup(input: { sessionId: string; threadId: string }) {
    return requireRuntimeWorkspaceCheckpointService(this.runtimeWorkspaceCheckpointService).retryManagedWorktreeSetup(input);
  }

  async startUserTerminal(input: { sessionId: string; threadId: string; cols?: number | undefined; rows?: number | undefined }): Promise<UserTerminalRecord> {
    await this.userTerminalReady;
    const service = requireUserTerminalService(this.userTerminalService);
    const workspaceRoot = await this.resolveAuthoritativeWorkspace(input);
    return service.start({ ...input, workspaceRoot });
  }

  async listUserTerminals(input: { sessionId: string; threadId?: string | undefined }): Promise<UserTerminalRecord[]> {
    await this.userTerminalReady;
    return requireUserTerminalService(this.userTerminalService).list(input);
  }

  async readUserTerminal(input: { sessionId: string; terminalId: string; cursor?: number | undefined }): Promise<UserTerminalReadResult> {
    await this.userTerminalReady;
    return requireUserTerminalService(this.userTerminalService).read(input);
  }

  async writeUserTerminal(input: { sessionId: string; terminalId: string; data: string }): Promise<UserTerminalRecord> {
    await this.userTerminalReady;
    return requireUserTerminalService(this.userTerminalService).write(input);
  }

  async resizeUserTerminal(input: { sessionId: string; terminalId: string; cols: number; rows: number }): Promise<UserTerminalRecord> {
    await this.userTerminalReady;
    return requireUserTerminalService(this.userTerminalService).resize(input);
  }

  async stopUserTerminal(input: { sessionId: string; terminalId: string }): Promise<UserTerminalRecord> {
    await this.userTerminalReady;
    return requireUserTerminalService(this.userTerminalService).stop(input);
  }

  async inspectWorkspaceChanges(input: {
    sessionId: string;
    threadId: string;
    scope: WorkspaceChangeScope;
    options?: Partial<WorkspaceDiffOptions> | undefined;
  }): Promise<WorkspaceChangeSnapshot> {
    if (input.scope.kind === "latest_turn") {
      const requestedTurnId = input.scope.turnId;
      const service = requireWorkspaceChangeService(this.workspaceChangeService);
      const checkpointService = this.workspaceCheckpointService;
      const threadRuntime = this.threadRuntime;
      if (!(checkpointService && threadRuntime))
        throw createRuntimeFailure("WORKSPACE_CHANGE_TURN_SCOPE_UNAVAILABLE", "Conversation-turn checkpoints are unavailable.", {
          subsystem: "workspace",
          classification: "configuration",
          recoverable: true,
        });
      const turns = (
        await threadRuntime.listConversationTurns({
          threadId: input.threadId,
          sessionId: input.sessionId,
          limit: 50,
        })
      ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      const turn = requestedTurnId ? turns.find((candidate) => candidate.turnId === requestedTurnId) : turns[0];
      if (!turn)
        throw createRuntimeFailure("WORKSPACE_CHANGE_TURN_NOT_FOUND", "No conversation turn is available for this coding thread.", {
          subsystem: "workspace",
          classification: "state",
          recoverable: true,
          turnId: requestedTurnId,
        });
      const segments = await threadRuntime.listConversationTurnSegments(turn.turnId);
      const runIds = new Set(
        [turn.rootRunId, turn.activeRunId, turn.terminalRunId, ...segments.map((segment) => segment.runId)].filter(
          (value): value is string => typeof value === "string",
        ),
      );
      const checkpoints = (await checkpointService.list({ sessionId: input.sessionId }))
        .filter((checkpoint) => checkpoint.runId !== undefined && runIds.has(checkpoint.runId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (checkpoints.length === 0)
        throw createRuntimeFailure("WORKSPACE_CHANGE_TURN_CHECKPOINTS_NOT_FOUND", "The selected turn has no workspace mutation checkpoints.", {
          subsystem: "workspace",
          classification: "state",
          recoverable: true,
          turnId: turn.turnId,
        });
      const source = checkpoints[0]!;
      const target = checkpoints.at(-1)!;
      const workspaceRoot = await this.resolveAuthoritativeWorkspace(input);
      if (path.resolve(source.workspaceRoot) !== path.resolve(workspaceRoot) || path.resolve(target.workspaceRoot) !== path.resolve(workspaceRoot))
        throw createRuntimeFailure("WORKSPACE_CHANGE_TURN_AUTHORITY_MISMATCH", "Turn checkpoints do not belong to the authoritative thread workspace.", {
          subsystem: "workspace",
          classification: "authorization",
          recoverable: false,
          turnId: turn.turnId,
        });
      return service.inspectGitRange({
        ...input,
        scope: { kind: "latest_turn", turnId: turn.turnId },
        workspaceRoot,
        baseRef: source.gitRef,
        targetRef: target.gitRef,
      });
    }
    if (input.scope.kind === "latest_run") {
      const service = requireWorkspaceChangeService(this.workspaceChangeService);
      const checkpointService = this.workspaceCheckpointService;
      if (!checkpointService)
        throw createRuntimeFailure("WORKSPACE_CHANGE_RUN_SCOPE_UNAVAILABLE", "Run checkpoints are unavailable.", {
          subsystem: "workspace",
          classification: "configuration",
          recoverable: true,
        });
      const runs = await this.listOperatorRuns({
        sessionId: input.sessionId,
        limit: 50,
      });
      const permittedRunIds = runs.runs
        .filter((entry) => entry.threadId === input.threadId)
        .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))
        .map((entry) => entry.run.runId);
      const runId = input.scope.runId ?? permittedRunIds[0];
      if (!(runId && permittedRunIds.includes(runId)))
        throw createRuntimeFailure("WORKSPACE_CHANGE_RUN_NOT_FOUND", "No checkpointed run is available for this coding thread.", {
          subsystem: "workspace",
          classification: "state",
          recoverable: true,
          threadId: input.threadId,
          runId,
        });
      const checkpoints = (await checkpointService.list({ sessionId: input.sessionId }))
        .filter((checkpoint) => checkpoint.runId === runId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (checkpoints.length === 0)
        throw createRuntimeFailure("WORKSPACE_CHANGE_RUN_CHECKPOINTS_NOT_FOUND", "The selected run has no workspace mutation checkpoints.", {
          subsystem: "workspace",
          classification: "state",
          recoverable: true,
          runId,
        });
      const source = checkpoints[0]!;
      const target = checkpoints.at(-1)!;
      const workspaceRoot = await this.resolveAuthoritativeWorkspace(input);
      if (path.resolve(source.workspaceRoot) !== path.resolve(workspaceRoot) || path.resolve(target.workspaceRoot) !== path.resolve(workspaceRoot))
        throw createRuntimeFailure("WORKSPACE_CHANGE_RUN_AUTHORITY_MISMATCH", "Run checkpoints do not belong to the authoritative thread workspace.", {
          subsystem: "workspace",
          classification: "authorization",
          recoverable: false,
          runId,
        });
      return service.inspectGitRange({
        ...input,
        scope: { kind: "latest_run", runId },
        workspaceRoot,
        baseRef: source.gitRef,
        targetRef: target.gitRef,
      });
    }
    if (input.scope.kind === "promotion") {
      const preview = await this.previewWorkspacePromotion({
        sessionId: input.sessionId,
        promotionId: input.scope.promotionId,
      });
      const promotion = preview.preview.promotion;
      const authoritative = await this.resolveAuthoritativeWorkspace(input);
      if (path.resolve(promotion.managedWorktreeRoot) !== path.resolve(authoritative))
        throw createRuntimeFailure(
          "WORKSPACE_CHANGE_PROMOTION_AUTHORITY_MISMATCH",
          "Promotion candidate does not belong to the authoritative thread workspace.",
          {
            subsystem: "workspace",
            classification: "authorization",
            recoverable: false,
            promotionId: input.scope.promotionId,
          },
        );
      return requireWorkspaceChangeService(this.workspaceChangeService).inspectGitRange({
        ...input,
        workspaceRoot: promotion.managedWorktreeRoot,
        baseRef: promotion.baseHead,
        ...(preview.preview.candidateFingerprint ? { candidateFingerprint: preview.preview.candidateFingerprint } : {}),
      });
    }
    const workspaceRoot = await this.resolveAuthoritativeWorkspace(input);
    return requireWorkspaceChangeService(this.workspaceChangeService).inspect({
      ...input,
      workspaceRoot,
    });
  }

  async mutateWorkspaceChanges(input: {
    sessionId: string;
    threadId: string;
    expectedFingerprint: string;
    mutation: WorkspaceChangeMutation;
    scope?: WorkspaceChangeScope | undefined;
    options?: Partial<WorkspaceDiffOptions> | undefined;
  }): Promise<WorkspaceChangeMutationResult> {
    const workspaceRoot = await this.resolveAuthoritativeWorkspace(input);
    return requireWorkspaceChangeService(this.workspaceChangeService).mutate({
      ...input,
      workspaceRoot,
    });
  }

  async addWorkspaceFeedback(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
  }): Promise<WorkspaceFeedbackSnapshot> {
    const actual = await this.inspectWorkspaceChanges({
      sessionId: input.sessionId,
      threadId: input.threadId,
      scope: { kind: "uncommitted" },
    });
    assertCandidateFingerprint(input.candidateFingerprint, actual.candidateFingerprint);
    await this.workspaceFeedbackReady;
    return requireWorkspaceFeedbackService(this.workspaceFeedbackService).add(input);
  }

  async listWorkspaceFeedback(input: { sessionId: string; threadId: string }): Promise<WorkspaceFeedbackSnapshot> {
    const actual = await this.inspectWorkspaceChanges({
      sessionId: input.sessionId,
      threadId: input.threadId,
      scope: { kind: "uncommitted" },
    });
    await this.workspaceFeedbackReady;
    return requireWorkspaceFeedbackService(this.workspaceFeedbackService).list({
      ...input,
      candidateFingerprint: actual.candidateFingerprint,
    });
  }

  async removeWorkspaceFeedback(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    commentId: string;
  }): Promise<WorkspaceFeedbackSnapshot> {
    const actual = await this.inspectWorkspaceChanges({
      sessionId: input.sessionId,
      threadId: input.threadId,
      scope: { kind: "uncommitted" },
    });
    assertCandidateFingerprint(input.candidateFingerprint, actual.candidateFingerprint);
    await this.workspaceFeedbackReady;
    return requireWorkspaceFeedbackService(this.workspaceFeedbackService).remove(input);
  }

  async submitWorkspaceFeedback(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    commentIds: string[];
  }): Promise<{ snapshot: WorkspaceFeedbackSnapshot; result: RunTurnResult }> {
    const actual = await this.inspectWorkspaceChanges({
      sessionId: input.sessionId,
      threadId: input.threadId,
      scope: { kind: "uncommitted" },
    });
    assertCandidateFingerprint(input.candidateFingerprint, actual.candidateFingerprint);
    await this.workspaceFeedbackReady;
    const service = requireWorkspaceFeedbackService(this.workspaceFeedbackService);
    const comments = await service.prepareSubmission(input);
    const result = await this.runTurn({
      sessionId: input.sessionId,
      eventType: "desktop.diff.feedback",
      interactionMode: "build",
      message: [
        "Please address this candidate-bound Desktop diff feedback. Keep each item connected to its file and line, then validate the resulting changes.",
        "",
        ...comments.map((comment, index) => `${index + 1}. ${comment.path}:${comment.line} (${comment.side}) — ${comment.body}`),
        "",
        `Candidate fingerprint at submission: ${input.candidateFingerprint}`,
      ].join("\n"),
      actor: { actorType: "operator", actorId: "desktop-shell" },
    });
    return {
      result,
      snapshot: await service.markSubmitted({
        ...input,
        runId: result.output.runId,
      }),
    };
  }

  async runWorkspaceReview(input: {
    sessionId: string;
    threadId: string;
    scope: WorkspaceChangeScope;
    mode?: "current_thread" | "detached_thread" | undefined;
    reviewerProfileId?: string | undefined;
    reviewerModel?: string | undefined;
  }): Promise<WorkspaceReviewSnapshot> {
    const mode = input.mode ?? "current_thread";
    if (mode === "current_thread" && (input.reviewerProfileId || input.reviewerModel))
      throw createRuntimeFailure("WORKSPACE_REVIEW_PROFILE_UNAVAILABLE", "Dedicated reviewer profile selection is available through detached review threads.", {
        subsystem: "review",
        classification: "configuration",
        recoverable: true,
      });
    const candidate = await this.inspectWorkspaceChanges({
      sessionId: input.sessionId,
      threadId: input.threadId,
      scope: input.scope,
    });
    await this.workspaceReviewReady;
    const service = requireWorkspaceReviewService(this.workspaceReviewService);
    const review = await service.begin({
      ...input,
      scope: candidate.scope,
      candidateFingerprint: candidate.candidateFingerprint,
      scopeLabel: workspaceReviewScopeLabel(candidate.scope),
      mode,
    });
    try {
      const repositoryInstructions = await readRepositoryReviewInstructions(candidate.repoRoot);
      if (mode === "detached_thread") {
        const threadRuntime = this.threadRuntime;
        if (!threadRuntime)
          throw createRuntimeFailure("WORKSPACE_REVIEW_DETACHED_UNAVAILABLE", "Detached review threads are unavailable.", {
            subsystem: "review",
            classification: "configuration",
            recoverable: true,
          });
        const handle = await threadRuntime.spawnChildThread({
          threadId: input.threadId,
          title: `Review ${workspaceReviewScopeLabel(candidate.scope)}`,
          prompt: workspaceReviewPrompt(candidate.diff, candidate.candidateFingerprint),
          rolePrompt: ["You are a bounded, strictly read-only code reviewer.", ...repositoryInstructions].join("\n\n"),
          goal: "Return typed actionable findings for the supplied candidate without changing any state.",
          resultContract: "Return only the requested JSON findings object.",
          reconciliationIntent: "manual_review",
          ...(input.reviewerProfileId ? { profileId: input.reviewerProfileId } : {}),
          ...(input.reviewerModel ? { model: input.reviewerModel } : {}),
          budget: {
            maxTurns: 1,
            maxRuntimeMs: 300_000,
            allowApprovalInheritance: false,
          },
          policy: {
            allowedToolClasses: ["read_only"],
            allowedCapabilities: ["workspace.read"],
          },
          issuedBy: "desktop-review",
        });
        await service.attachDelegation({
          reviewId: review.reviewId,
          sessionId: input.sessionId,
          threadId: input.threadId,
          delegationId: handle.delegationId,
          childThreadId: handle.childThreadId,
        });
        return service.list({
          ...input,
          candidateFingerprint: candidate.candidateFingerprint,
        });
      }
      const result = await this.runTurn({
        sessionId: input.sessionId,
        eventType: "desktop.workspace.review",
        interactionMode: "chat",
        message: workspaceReviewPrompt(candidate.diff, candidate.candidateFingerprint),
        actor: { actorType: "operator", actorId: "desktop-review" },
        executionPolicy: {
          toolClassPolicy: {
            read_only: true,
            planning_write: false,
            sandboxed_only: false,
            external_side_effect: false,
          },
          capabilityPolicy: {
            "workspace.write": false,
            "shell.exec": false,
            "code.execute": false,
            "network.call": false,
            "mcp.invoke": false,
            "external.confirm": false,
          },
        },
        systemInstructions: repositoryInstructions,
      });
      const after = await this.inspectWorkspaceChanges({
        sessionId: input.sessionId,
        threadId: input.threadId,
        scope: input.scope,
      });
      if (after.candidateFingerprint !== candidate.candidateFingerprint)
        throw createRuntimeFailure(
          "WORKSPACE_REVIEW_READ_ONLY_VIOLATION",
          "The candidate changed while a read-only review was running. The review was discarded.",
          {
            subsystem: "review",
            classification: "state",
            recoverable: false,
            before: candidate.candidateFingerprint,
            after: after.candidateFingerprint,
          },
        );
      return await service.complete({
        reviewId: review.reviewId,
        sessionId: input.sessionId,
        threadId: input.threadId,
        candidateFingerprint: candidate.candidateFingerprint,
        runId: result.output.runId,
        findings: parseWorkspaceReviewFindings(result.finalizedPayload ?? result.assistantText),
      });
    } catch (cause) {
      await service.fail({
        reviewId: review.reviewId,
        sessionId: input.sessionId,
        threadId: input.threadId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
  }

  async listWorkspaceReviews(input: { sessionId: string; threadId: string }): Promise<WorkspaceReviewSnapshot> {
    const actual = await this.inspectWorkspaceChanges({
      sessionId: input.sessionId,
      threadId: input.threadId,
      scope: { kind: "uncommitted" },
    });
    await this.workspaceReviewReady;
    const service = requireWorkspaceReviewService(this.workspaceReviewService);
    const reviewFingerprints: Record<string, string> = {};
    for (const review of service.records(input)) {
      try {
        const current = await this.inspectWorkspaceChanges({
          ...input,
          scope: review.scope,
        });
        reviewFingerprints[review.reviewId] = current.candidateFingerprint;
        if (review.status === "running" && review.mode === "detached_thread" && review.delegationId && this.threadRuntime) {
          const delegation = (await this.threadRuntime.listDelegations(input.threadId)).find((candidate) => candidate.delegationId === review.delegationId);
          if (delegation?.status === "COMPLETED" && delegation.result?.result) {
            if (current.candidateFingerprint !== review.candidateFingerprint) continue;
            try {
              await service.complete({
                reviewId: review.reviewId,
                sessionId: input.sessionId,
                threadId: input.threadId,
                candidateFingerprint: review.candidateFingerprint,
                runId: delegation.childRunId ?? delegation.delegationId,
                findings: parseWorkspaceReviewFindings(delegation.result.result),
              });
            } catch (cause) {
              await service.fail({
                reviewId: review.reviewId,
                sessionId: input.sessionId,
                threadId: input.threadId,
                error: cause instanceof Error ? cause.message : String(cause),
              });
            }
          } else if (delegation?.status === "FAILED" || delegation?.status === "CANCELLED")
            await service.fail({
              reviewId: review.reviewId,
              sessionId: input.sessionId,
              threadId: input.threadId,
              error: delegation.errorMessage ?? `Detached review ${delegation.status.toLowerCase()}.`,
            });
        }
      } catch {
        reviewFingerprints[review.reviewId] = "unavailable";
      }
    }
    return service.list({
      ...input,
      candidateFingerprint: actual.candidateFingerprint,
      reviewFingerprints,
    });
  }

  async updateWorkspaceReviewFinding(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    reviewId: string;
    findingId: string;
    action: "accept" | "dismiss" | "reopen" | "mark_fixed";
    reason?: string | undefined;
  }): Promise<WorkspaceReviewSnapshot> {
    await this.workspaceReviewReady;
    const service = requireWorkspaceReviewService(this.workspaceReviewService);
    const review = service.get(input);
    const actual = await this.inspectWorkspaceChanges({
      sessionId: input.sessionId,
      threadId: input.threadId,
      scope: review.scope,
    });
    assertCandidateFingerprint(input.candidateFingerprint, actual.candidateFingerprint);
    await service.updateFinding(input);
    return this.listWorkspaceReviews(input);
  }

  async submitWorkspaceReviewFindings(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    reviewId: string;
    findingIds: string[];
    request: "address" | "more_evidence" | "verify";
  }): Promise<{ snapshot: WorkspaceReviewSnapshot; result: RunTurnResult }> {
    await this.workspaceReviewReady;
    const service = requireWorkspaceReviewService(this.workspaceReviewService);
    const review = service.get(input);
    const actual = await this.inspectWorkspaceChanges({
      sessionId: input.sessionId,
      threadId: input.threadId,
      scope: input.request === "verify" && review.status === "stale" ? { kind: "uncommitted" } : review.scope,
    });
    assertCandidateFingerprint(input.candidateFingerprint, actual.candidateFingerprint);
    const findings = service.selected({
      ...input,
      allowStaleAccepted: input.request === "verify",
    });
    const instruction =
      input.request === "address"
        ? "Address these accepted review findings and validate the changes."
        : input.request === "more_evidence"
          ? "Gather and return more concrete evidence for these review findings without changing source files."
          : "Verify these accepted findings against the current candidate and report whether each is fixed.";
    const result = await this.runTurn({
      sessionId: input.sessionId,
      eventType: `desktop.workspace.review.${input.request}`,
      interactionMode: input.request === "address" ? "build" : "chat",
      message: [
        instruction,
        "",
        ...findings.map(
          (finding, index) =>
            `${index + 1}. [${finding.severity}] ${finding.path}:${finding.line} — ${finding.problem}\nEvidence: ${finding.evidence}\nVerification: ${finding.verification}`,
        ),
        "",
        `Candidate fingerprint: ${input.candidateFingerprint}`,
      ].join("\n"),
      actor: { actorType: "operator", actorId: "desktop-review" },
      ...(input.request !== "address"
        ? {
            executionPolicy: {
              toolClassPolicy: {
                read_only: true,
                planning_write: false,
                sandboxed_only: false,
                external_side_effect: false,
              },
              capabilityPolicy: {
                "workspace.write": false,
                "shell.exec": false,
                "code.execute": false,
                "network.call": false,
                "mcp.invoke": false,
                "external.confirm": false,
              },
            },
          }
        : {}),
    });
    await service.recordSubmission({
      ...input,
      runId: result.output.runId,
      allowStaleAccepted: input.request === "verify",
    });
    return { result, snapshot: await this.listWorkspaceReviews(input) };
  }

  async inspectWorkspaceValidation(input: {
    sessionId: string;
    threadId: string;
  }): Promise<WorkspaceValidationSnapshot> {
    await this.workspaceValidationReady;
    const changes = await this.inspectWorkspaceChanges({
      ...input,
      scope: { kind: "uncommitted" },
    });
    return requireWorkspaceValidationService(this.workspaceValidationService).inspect({
      ...input,
      workspaceRoot: changes.workspaceRoot,
      candidateFingerprint: changes.candidateFingerprint,
    });
  }

  async runWorkspaceValidation(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    actionId?: string | undefined;
    suiteId?: string | undefined;
  }): Promise<WorkspaceValidationSnapshot> {
    await this.workspaceValidationReady;
    const changes = await this.inspectWorkspaceChanges({
      ...input,
      scope: { kind: "uncommitted" },
    });
    assertCandidateFingerprint(input.candidateFingerprint, changes.candidateFingerprint);
    const service = requireWorkspaceValidationService(this.workspaceValidationService);
    const base = {
      sessionId: input.sessionId,
      threadId: input.threadId,
      workspaceRoot: changes.workspaceRoot,
      candidateFingerprint: changes.candidateFingerprint,
    };
    if (input.actionId && !input.suiteId)
      return service.runAction({ ...base, actionId: input.actionId });
    if (input.suiteId && !input.actionId)
      return service.runSuite({ ...base, suiteId: input.suiteId });
    throw createRuntimeFailure(
      "WORKSPACE_VALIDATION_TARGET_INVALID",
      "Select exactly one validation action or suite.",
      { subsystem: "validation", classification: "contract", recoverable: true },
    );
  }

  async cancelWorkspaceValidation(input: {
    sessionId: string;
    threadId: string;
    resultId: string;
  }): Promise<WorkspaceValidationSnapshot> {
    await this.workspaceValidationReady;
    await requireWorkspaceValidationService(this.workspaceValidationService).cancel(input);
    return this.inspectWorkspaceValidation(input);
  }

  async submitWorkspaceValidationFailures(input: {
    sessionId: string;
    threadId: string;
    resultIds: string[];
  }): Promise<{ snapshot: WorkspaceValidationSnapshot; result: RunTurnResult }> {
    await this.workspaceValidationReady;
    const service = requireWorkspaceValidationService(this.workspaceValidationService);
    const selected = service.selected(input);
    const result = await this.runTurn({
      sessionId: input.sessionId,
      eventType: "desktop.workspace.validation.address",
      interactionMode: "build",
      message: [
        "Address these candidate-bound validation failures, then rerun the relevant checks.",
        "",
        ...selected.map(
          (failure, index) =>
            `${index + 1}. ${failure.actionLabel} (${failure.outcome})\nCommand: ${failure.command} ${failure.args.join(" ")}\nCandidate: ${failure.candidateFingerprint}\nOutput:\n${failure.output.map((entry) => entry.text).join("").slice(-32_768)}`,
        ),
      ].join("\n"),
      actor: { actorType: "operator", actorId: "desktop-validation" },
    });
    await service.markSubmitted({
      ...input,
      runId: result.output.runId,
    });
    return { result, snapshot: await this.inspectWorkspaceValidation(input) };
  }

  async inspectWorkspaceGit(input: { sessionId: string; threadId: string }): Promise<WorkspaceGitSnapshot> {
    await Promise.all([this.workspaceValidationReady, this.workspaceGitReady]);
    const [changes, validation] = await Promise.all([
      this.inspectWorkspaceChanges({ ...input, scope: { kind: "uncommitted" } }),
      this.inspectWorkspaceValidation(input),
    ]);
    return requireWorkspaceGitService(this.workspaceGitService).inspect({
      ...input,
      workspaceRoot: changes.workspaceRoot,
      candidateFingerprint: changes.candidateFingerprint,
      validationReadiness: validation.candidateFingerprint === changes.candidateFingerprint ? validation.readiness.state : "stale",
    });
  }

  async performWorkspaceGitAction(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    expectedHeadSha?: string | undefined;
    action: WorkspaceGitAction;
  }): Promise<WorkspaceGitSnapshot> {
    await this.workspaceGitReady;
    const changes = await this.inspectWorkspaceChanges({ sessionId: input.sessionId, threadId: input.threadId, scope: { kind: "uncommitted" } });
    assertCandidateFingerprint(input.candidateFingerprint, changes.candidateFingerprint);
    const base = {
      sessionId: input.sessionId,
      threadId: input.threadId,
      workspaceRoot: changes.workspaceRoot,
      candidateFingerprint: changes.candidateFingerprint,
      ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}),
    };
    const service = requireWorkspaceGitService(this.workspaceGitService);
    if (input.action.kind === "commit" || input.action.kind === "push" || input.action.kind === "pr_ready" || (input.action.kind === "pr_create" && !input.action.draft))
      await this.assertWorkspaceDeliveryReady(input, input.action.kind === "pr_ready" || input.action.kind === "pr_create" ? "pull request readiness" : input.action.kind);
    switch (input.action.kind) {
      case "branch_create": await service.createBranch({ ...base, branchName: input.action.branchName }); break;
      case "fetch": await service.fetch({ ...base, remote: input.action.remote }); break;
      case "commit": await service.commit({ ...base, message: input.action.message, paths: input.action.paths }); break;
      case "push": await service.push({ ...base, remote: input.action.remote, branch: input.action.branch, setUpstream: input.action.setUpstream }); break;
      case "pr_create": await service.createPullRequest({ ...base, title: input.action.title, body: input.action.body, baseBranch: input.action.baseBranch, draft: input.action.draft }); break;
      case "pr_ready": await service.markPullRequestReady({ ...base, number: input.action.number }); break;
      case "pr_comment": await service.commentOnPullRequest({ ...base, number: input.action.number, body: input.action.body, ...(input.action.path ? { path: input.action.path } : {}), ...(input.action.line ? { line: input.action.line } : {}), ...(input.action.side ? { side: input.action.side } : {}) }); break;
    }
    return this.inspectWorkspaceGit(input);
  }

  private async assertWorkspaceDeliveryReady(input: { sessionId: string; threadId: string }, operation: string): Promise<void> {
    const validation = await this.inspectWorkspaceValidation(input);
    if (validation.readiness.state !== "ready") throw createRuntimeFailure("WORKSPACE_DELIVERY_VALIDATION_REQUIRED", `Current candidate validation is ${validation.readiness.state.replace("_", " ")}; ${operation} requires fresh passing evidence.`, { subsystem: "validation", classification: "state", recoverable: true, candidateFingerprint: validation.candidateFingerprint, readiness: validation.readiness.state, operation });
  }

  async getProjectReviewDetail(input: { sessionId: string; target: ProductReviewTarget }): Promise<{ sessionId: string; detail: ProductReviewDetail }> {
    return requireProductProjectRuntimeService(this.projectRuntimeService).getProjectReviewDetail(input);
  }

  async performProjectReviewAction(input: { sessionId: string; action: ProductReviewAction }): Promise<{ sessionId: string; detail: ProductReviewDetail }> {
    return requireProductProjectRuntimeService(this.projectRuntimeService).performProjectReviewAction(input);
  }

  async performOperatorAction(input: {
    action:
      | "approve"
      | "reject"
      | "reply"
      | "steer"
      | "retry"
      | "continue_waiting"
      | "focus_thread"
      | "resolve_context_checkpoint"
      | "approve_assembly_change"
      | "reject_assembly_change"
      | "spawn_child_thread"
      | "supersede_child_thread"
      | "resolve_fan_in_checkpoint"
      | "enqueue_follow_up"
      | "edit_follow_up"
      | "cancel_follow_up"
      | "resume_follow_up_queue";
    threadId: string;
    followUpId?: string | undefined;
    requestId?: string | undefined;
    proposalId?: string | undefined;
    checkpointId?: string | undefined;
    delegationId?: string | undefined;
    actionValue?: "continue" | "compact" | "summarize_forward" | "handoff" | "split_into_child_thread" | "operator_checkpoint" | "accept" | "defer" | undefined;
    message?: string | undefined;
    attachments?: RunTurnAttachment[] | undefined;
    attachmentIds?: string[] | undefined;
    interactionMode?: "chat" | "plan" | "build" | undefined;
    actSubmode?: "strict" | "safe" | "full_auto" | undefined;
    title?: string | undefined;
    rolePrompt?: string | undefined;
    goal?: string | undefined;
    profileId?: string | undefined;
    provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
    model?: string | undefined;
    skillPackId?: string | undefined;
    maxTurns?: number | undefined;
    maxRuntimeMs?: number | undefined;
    allowApprovalInheritance?: boolean | undefined;
    allowToolClasses?: ToolExecutionClass[] | undefined;
    allowCapabilities?: string[] | undefined;
    issuedBy?: string | undefined;
    completionMode?: "terminal" | "accepted" | undefined;
  }): Promise<{
    sessionId?: string | undefined;
    threadId: string;
    inbox?: import("../../src/orchestration/index.js").OperatorInboxSnapshot | undefined;
    view?: import("../../src/orchestration/index.js").OperatorThreadView | undefined;
    result?: RunTurnResult | undefined;
  }> {
    const threadRuntime = this.threadRuntime;
    if (threadRuntime === undefined) {
      throw createRuntimeFailure("OPERATOR_CONTROL_UNAVAILABLE", "Thread runtime is not configured.");
    }
    const operatorIssuedBy = input.issuedBy ?? "operator";
    let result: RunTurnResult | undefined;
    if (input.action === "approve" || input.action === "reject" || input.action === "reply") {
      const requestId = input.requestId ?? (await threadRuntime.getThreadStatus(input.threadId))?.openRequests[0]?.requestId;
      if (requestId === undefined) {
        throw createRuntimeFailure("OPERATOR_REQUEST_NOT_FOUND", `No pending request found for thread '${input.threadId}'.`, {
          threadId: input.threadId,
          action: input.action,
        });
      }
      result = await threadRuntime.replyToRequest({
        threadId: input.threadId,
        requestId,
        message: input.message ?? (input.action === "reject" ? "Rejected." : "Approved."),
        issuedBy: operatorIssuedBy,
        approve: input.action !== "reject",
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        ...(input.allowToolClasses !== undefined ? { allowedToolClasses: input.allowToolClasses } : {}),
        ...(input.allowCapabilities !== undefined ? { allowedCapabilities: input.allowCapabilities } : {}),
      });
    } else if (input.action === "steer") {
      const steering = await threadRuntime.steerThread({
        threadId: input.threadId,
        message: input.message ?? "Apply operator steering.",
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        issuedBy: operatorIssuedBy,
      });
      result = steering.result;
    } else if (input.action === "retry") {
      result = await threadRuntime.retryThread({
        threadId: input.threadId,
        reason: input.message,
      });
    } else if (input.action === "continue_waiting") {
      await threadRuntime.continueWaiting({ threadId: input.threadId });
    } else if (input.action === "focus_thread") {
      await threadRuntime.focusThread({
        threadId: input.threadId,
      });
    } else if (input.action === "approve_assembly_change") {
      if (input.proposalId === undefined) {
        throw createRuntimeFailure("OPERATOR_ASSEMBLY_PROPOSAL_INPUT_INVALID", "Approving an assembly change requires proposalId.", {
          threadId: input.threadId,
          proposalId: input.proposalId,
        });
      }
      result = await threadRuntime.approveAssemblyChange({
        threadId: input.threadId,
        proposalId: input.proposalId,
        issuedBy: operatorIssuedBy,
        reason: input.message,
      });
    } else if (input.action === "reject_assembly_change") {
      if (input.proposalId === undefined) {
        throw createRuntimeFailure("OPERATOR_ASSEMBLY_PROPOSAL_INPUT_INVALID", "Rejecting an assembly change requires proposalId.", {
          threadId: input.threadId,
          proposalId: input.proposalId,
        });
      }
      await threadRuntime.rejectAssemblyChange({
        threadId: input.threadId,
        proposalId: input.proposalId,
        issuedBy: operatorIssuedBy,
        reason: input.message,
      });
    } else if (input.action === "spawn_child_thread") {
      const prompt = input.message?.trim() ?? "";
      if (prompt.length === 0) {
        throw createRuntimeFailure("OPERATOR_CHILD_THREAD_INPUT_INVALID", "Spawning a child thread requires a prompt message.", { threadId: input.threadId });
      }
      await threadRuntime.spawnChildThread({
        threadId: input.threadId,
        prompt,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.rolePrompt !== undefined ? { rolePrompt: input.rolePrompt } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.skillPackId !== undefined ? { skillPackId: input.skillPackId } : {}),
        ...(input.maxTurns !== undefined || input.maxRuntimeMs !== undefined || input.allowApprovalInheritance !== undefined
          ? {
              budget: {
                ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
                ...(input.maxRuntimeMs !== undefined ? { maxRuntimeMs: input.maxRuntimeMs } : {}),
                ...(input.allowApprovalInheritance !== undefined ? { allowApprovalInheritance: input.allowApprovalInheritance } : {}),
              },
            }
          : {}),
        ...(input.allowToolClasses !== undefined || input.allowCapabilities !== undefined
          ? {
              policy: {
                ...(input.allowToolClasses !== undefined ? { allowedToolClasses: input.allowToolClasses } : {}),
                ...(input.allowCapabilities !== undefined ? { allowedCapabilities: input.allowCapabilities } : {}),
              },
            }
          : {}),
        issuedBy: operatorIssuedBy,
      });
    } else if (input.action === "supersede_child_thread") {
      if (input.delegationId === undefined) {
        throw createRuntimeFailure("OPERATOR_CHILD_THREAD_INPUT_INVALID", "Superseding a child thread requires delegationId.", {
          threadId: input.threadId,
          delegationId: input.delegationId,
        });
      }
      await threadRuntime.supersedeChildThread({
        threadId: input.threadId,
        delegationId: input.delegationId,
        issuedBy: operatorIssuedBy,
        reason: input.message,
      });
    } else if (input.action === "resolve_fan_in_checkpoint") {
      if (input.checkpointId === undefined || (input.actionValue !== "accept" && input.actionValue !== "defer")) {
        throw createRuntimeFailure("OPERATOR_FAN_IN_INPUT_INVALID", "Fan-in resolution requires checkpointId and actionValue=accept|defer.", {
          threadId: input.threadId,
          checkpointId: input.checkpointId,
          actionValue: input.actionValue,
        });
      }
      await threadRuntime.resolveFanInCheckpoint({
        threadId: input.threadId,
        checkpointId: input.checkpointId,
        disposition: input.actionValue,
        issuedBy: operatorIssuedBy,
      });
    } else if (input.action === "enqueue_follow_up") {
      const followUpId = input.followUpId?.trim();
      const message = input.message?.trim();
      if (followUpId === undefined || followUpId.length === 0 || message === undefined || message.length === 0) {
        throw createRuntimeFailure(
          "OPERATOR_FOLLOW_UP_INPUT_INVALID",
          "Enqueuing a follow-up requires followUpId and message.",
          { threadId: input.threadId },
        );
      }
      await threadRuntime.enqueueFollowUp({
        threadId: input.threadId,
        followUpId,
        message: input.message!,
        ...(input.attachmentIds !== undefined ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
        issuedBy: operatorIssuedBy,
      });
    } else if (input.action === "edit_follow_up") {
      const followUpId = input.followUpId?.trim();
      const message = input.message?.trim();
      if (followUpId === undefined || followUpId.length === 0 || message === undefined || message.length === 0) {
        throw createRuntimeFailure("OPERATOR_FOLLOW_UP_INPUT_INVALID", "Editing a follow-up requires followUpId and message.");
      }
      await threadRuntime.editFollowUp({ threadId: input.threadId, followUpId, message });
    } else if (input.action === "cancel_follow_up") {
      const followUpId = input.followUpId?.trim();
      if (followUpId === undefined || followUpId.length === 0) {
        throw createRuntimeFailure("OPERATOR_FOLLOW_UP_INPUT_INVALID", "Cancelling a follow-up requires followUpId.");
      }
      await threadRuntime.cancelFollowUp({ threadId: input.threadId, followUpId });
    } else if (input.action === "resume_follow_up_queue") {
      await threadRuntime.resumeFollowUpQueue({ threadId: input.threadId });
    } else if (input.action === "resolve_context_checkpoint") {
      const checkpointAction = input.actionValue;
      if (
        input.checkpointId === undefined ||
        (checkpointAction !== "continue" &&
          checkpointAction !== "compact" &&
          checkpointAction !== "summarize_forward" &&
          checkpointAction !== "handoff" &&
          checkpointAction !== "split_into_child_thread" &&
          checkpointAction !== "operator_checkpoint")
      ) {
        throw createRuntimeFailure("OPERATOR_CONTEXT_CHECKPOINT_INPUT_INVALID", "Context checkpoint resolution requires checkpointId and actionValue.", {
          threadId: input.threadId,
          checkpointId: input.checkpointId,
          actionValue: input.actionValue,
        });
      }
      await threadRuntime.resolveContextCheckpoint({
        threadId: input.threadId,
        checkpointId: input.checkpointId,
        action: checkpointAction,
        issuedBy: operatorIssuedBy,
      });
    }
    const view = await threadRuntime.getOperatorThreadView(input.threadId);
    return {
      ...(view !== null ? { sessionId: view.thread.sessionId } : {}),
      threadId: input.threadId,
      ...(result !== undefined ? { result } : {}),
      ...(view !== null ? { view } : {}),
      ...(view !== null
        ? {
            inbox: await threadRuntime.listOperatorInbox({
              sessionId: view.thread.sessionId,
            }),
          }
        : {}),
    };
  }

  async performAcceptedOperatorAction(input: {
    action: "approve" | "reject" | "reply";
    threadId: string;
    requestId?: string | undefined;
    message?: string | undefined;
    attachments?: RunTurnAttachment[] | undefined;
    interactionMode?: "chat" | "plan" | "build" | undefined;
    actSubmode?: "strict" | "safe" | "full_auto" | undefined;
    allowToolClasses?: ToolExecutionClass[] | undefined;
    allowCapabilities?: string[] | undefined;
    issuedBy?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{
    accepted: {
      sessionId?: string | undefined;
      threadId: string;
      disposition: "accepted" | "completed";
      runId?: string | undefined;
      inbox?: import("../../src/orchestration/index.js").OperatorInboxSnapshot | undefined;
      view?: import("../../src/orchestration/index.js").OperatorThreadView | undefined;
      result?: RunTurnResult | undefined;
    };
    completion: Promise<RunTurnResult>;
  }> {
    const threadRuntime = this.threadRuntime;
    if (threadRuntime === undefined) {
      throw createRuntimeFailure("OPERATOR_CONTROL_UNAVAILABLE", "Thread runtime is not configured.");
    }
    const status = await threadRuntime.getThreadStatus(input.threadId);
    const requestId = input.requestId ?? status?.openRequests[0]?.requestId;
    const request = status?.openRequests.find((candidate) => candidate.requestId === requestId);
    if (requestId === undefined || request === undefined || status === null) {
      throw createRuntimeFailure("OPERATOR_REQUEST_NOT_FOUND", `No pending request found for thread '${input.threadId}'.`, {
        threadId: input.threadId,
        action: input.action,
      });
    }
    const message = input.message ?? (input.action === "reject" ? "Rejected." : "Approved.");
    const runId = randomUUID();

    let resolveSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => {
      resolveSubmitted = resolve;
    });
    const subscription = threadRuntime.subscribe({ threadId: input.threadId }, (event) => {
      if (event.type === "thread.turn_submitted") {
        resolveSubmitted();
      }
    });
    const completion = threadRuntime.replyToRequest({
      threadId: input.threadId,
      requestId,
      message,
      issuedBy: input.issuedBy ?? "operator",
      approve: input.action !== "reject",
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.allowToolClasses !== undefined ? { allowedToolClasses: input.allowToolClasses } : {}),
      ...(input.allowCapabilities !== undefined ? { allowedCapabilities: input.allowCapabilities } : {}),
      runtimeTurn: {
        sessionId: status.thread.sessionId,
        runId,
        message,
        eventType: request.eventType,
      },
    });

    try {
      const outcome = await Promise.race([
        submitted.then(() => ({ disposition: "accepted" as const })),
        completion.then((result) => ({ disposition: "completed" as const, result })),
      ]);
      const view = await threadRuntime.getOperatorThreadView(input.threadId);
      const sessionId = view?.thread.sessionId;
      return {
        accepted: {
          ...(sessionId !== undefined ? { sessionId } : {}),
          threadId: input.threadId,
          disposition: outcome.disposition,
          runId: outcome.disposition === "completed" ? outcome.result.output.runId : runId,
          ...(outcome.disposition === "completed" ? { result: outcome.result } : {}),
          ...(view !== null ? { view } : {}),
          ...(sessionId !== undefined
            ? { inbox: await threadRuntime.listOperatorInbox({ sessionId }) }
            : {}),
        },
        completion,
      };
    } finally {
      subscription.unsubscribe();
    }
  }

  async refreshToolRuntime(): Promise<ToolRuntimeStatus> {
    return this.kestrel.refreshToolRuntime();
  }

  async cancelActiveRun(sessionId: string): Promise<{ runId?: string | undefined }> {
    const result = await this.kestrel.cancelActiveRun(sessionId);
    const thread = await this.ensureMainThread(sessionId);
    if (thread !== undefined && this.threadRuntime !== undefined) {
      await this.threadRuntime.pauseFollowUpQueue({ threadId: thread.threadId, reason: "cancelled" });
    }
    return result;
  }

  async getRetainedProviderReasoning(input: { runId: string; sessionId: string; actorRole: string; actorId?: string | undefined }) {
    await this.reasoningPolicyReady;
    return this.kestrel.getRetainedProviderReasoning(input);
  }

  async deleteRetainedProviderReasoning(input: { runId: string; sessionId: string; actorRole: string; actorId?: string | undefined }) {
    await this.reasoningPolicyReady;
    return this.kestrel.deleteRetainedProviderReasoning(input);
  }

  getProviderReasoningVaultStatus() {
    return this.kestrel.getProviderReasoningVaultStatus();
  }

  async close(): Promise<void> {
    await this.closePool();
  }

  private async resolveAuthoritativeWorkspace(input: { sessionId: string; threadId: string }): Promise<string> {
    const view = await this.getOperatorThreadView(input.threadId);
    if (view == null || view.thread.sessionId !== input.sessionId || view.workspace === undefined) {
      throw createRuntimeFailure("USER_TERMINAL_WORKSPACE_UNAVAILABLE", "Authoritative thread workspace is unavailable for this terminal.", {
        subsystem: "terminal",
        classification: "authorization",
        recoverable: true,
        sessionId: input.sessionId,
        threadId: input.threadId,
      });
    }
    return view.workspace.workspaceRoot;
  }

  private async ensureMainThread(sessionId: string) {
    const threadRuntime = this.threadRuntime;
    if (threadRuntime === undefined) {
      return;
    }
    if (
      typeof (
        threadRuntime as {
          ensureMainThreadForSession?: unknown;
        }
      ).ensureMainThreadForSession === "function"
    ) {
      return threadRuntime.ensureMainThreadForSession({
        sessionId,
        title: sessionId,
      });
    }
    const existing = await threadRuntime.getThreadStatus(sessionId);
    if (existing !== null) {
      return existing.thread;
    }
    return threadRuntime.startThread({
      threadId: sessionId,
      sessionId,
      title: sessionId,
      metadata: {
        legacyImported: true,
      },
    });
  }
}

function createDefaultRuntime(
  profile: TuiProfile,
  onFinalize: (payload: unknown) => unknown,
  onRunLog?: ((entry: RunLogEntry) => void) | undefined,
  onProgress?: ((update: ProgressUpdateV1) => void) | undefined,
  onConsole?: ((update: RunConsoleUpdateV1) => void) | undefined,
  onReasoning?: ((update: ReasoningUpdateV1 | ModelReasoningUpdateV1) => void) | undefined,
  onTaskUpdate?: ((update: DelegationTaskUpdate) => void) | undefined,
  onRunEvent?: ((event: RunEvent) => void) | undefined,
): RuntimeBootstrap {
  const storeHandle = createSessionStoreFromEnv({
    ...(profile.storeDriver !== undefined ? { driver: profile.storeDriver } : {}),
  });
  return createRuntimeWithStore(
    profile,
    onFinalize,
    onRunLog,
    onProgress,
    onConsole,
    onReasoning,
    onTaskUpdate,
    onRunEvent,
    storeHandle.store,
    storeHandle.close,
  );
}

/**
 * Creates runtimes that share a host-owned persistence boundary.
 *
 * Local Core owns and closes this store once for the lifetime of the host;
 * individual profile runtimes only release their profile-specific resources.
 */
export function createRuntimeFactoryWithStore(store: SessionStore, options: RuntimeFactoryWithStoreOptions = {}): RuntimeFactory {
  return {
    create(profile, onFinalize, onRunLog, onProgress, onConsole, onReasoning, onTaskUpdate, onRunEvent) {
      const environment = options.resolveEnvironment?.(profile);
      return createRuntimeWithStore(
        profile,
        onFinalize,
        onRunLog,
        onProgress,
        onConsole,
        onReasoning,
        onTaskUpdate,
        onRunEvent,
        store,
        async () => {},
        environment,
        options.enableUserTerminals === true,
        options.enableWorkspaceChanges === true,
        options.resolveAttachments,
      );
    },
  };
}

function createRuntimeWithStore(
  profile: TuiProfile,
  onFinalize: (payload: unknown) => unknown,
  onRunLog: ((entry: RunLogEntry) => void) | undefined,
  onProgress: ((update: ProgressUpdateV1) => void) | undefined,
  onConsole: ((update: RunConsoleUpdateV1) => void) | undefined,
  onReasoning: ((update: ReasoningUpdateV1 | ModelReasoningUpdateV1) => void) | undefined,
  onTaskUpdate: ((update: DelegationTaskUpdate) => void) | undefined,
  onRunEvent: ((event: RunEvent) => void) | undefined,
  store: SessionStore,
  closeStore: () => Promise<void>,
  environment?: KestrelRuntimeEnvironment | undefined,
  enableUserTerminals = false,
  enableWorkspaceChanges = false,
  resolveAttachments?: RuntimeFactoryWithStoreOptions["resolveAttachments"],
): RuntimeBootstrap {
  const runtimeEnv = environment?.runtimeEnv ?? process.env;
  const modelEnv = environment?.modelEnv ?? process.env;
  const internetEnv = environment?.internetEnv;
  const mcpEnv = environment?.mcpEnv ?? process.env;
  const taskGraphStore = new ProductTaskGraphStore(store);
  const projectStore = new ProductProjectStateStore(store);
  const workspaceCheckpointService = new WorkspaceCheckpointService(store);
  const userTerminalService = enableUserTerminals
    ? new UserTerminalService({
        metadataPath: path.join(resolveKestrelCoreHome(runtimeEnv).homePath, "terminals", "metadata.json"),
      })
    : undefined;
  const workspaceChangeService = enableWorkspaceChanges ? new WorkspaceChangeService() : undefined;
  const workspaceFeedbackService = enableWorkspaceChanges
    ? new WorkspaceFeedbackService(path.join(resolveKestrelCoreHome(runtimeEnv).homePath, "review", "feedback.json"))
    : undefined;
  const workspaceFeedbackReady = workspaceFeedbackService?.initialize();
  const workspaceReviewService = enableWorkspaceChanges
    ? new WorkspaceReviewService(path.join(resolveKestrelCoreHome(runtimeEnv).homePath, "review", "reviews.json"))
    : undefined;
  const workspaceReviewReady = workspaceReviewService?.initialize();
  const workspaceValidationService = enableWorkspaceChanges
    ? new WorkspaceValidationService(
        path.join(
          resolveKestrelCoreHome(runtimeEnv).homePath,
          "validation",
          "results.json",
        ),
      )
    : undefined;
  const workspaceValidationReady = workspaceValidationService?.initialize();
  const workspaceGitService = enableWorkspaceChanges
    ? new WorkspaceGitService(path.join(resolveKestrelCoreHome(runtimeEnv).homePath, "git", "workspace.json"))
    : undefined;
  const workspaceGitReady = workspaceGitService?.initialize();
  const userTerminalReady = userTerminalService?.initialize();
  const managedTaskWorktreeService =
    profile.shellKind === "desktop" || resolveManagedWorktreesEnabledForRuntime(runtimeEnv)
      ? new ManagedTaskWorktreeService()
      : undefined;
  const devShellService = resolveDevShellServiceForProfile(profile, runtimeEnv);
  const toolContext: SharedToolContext = {
    store,
    onFinalize,
    codeMode: profile.codeMode,
    devShell: profile.devShell,
    kestrelOne: {
      appUrl: parseEnvString("KESTREL_ONE_APP_URL", runtimeEnv),
      toolToken: parseEnvString("KESTREL_ONE_TOOL_TOKEN", runtimeEnv),
      appApprovalModes: profile.kestrelOneAppApprovalModes,
    },
    providerConfigurations: createToolProviderConfigurationResolverFromEnvironment(internetEnv ?? process.env),
    ...(devShellService !== undefined ? { devShellService } : {}),
    ...(profile.shellKind === "desktop"
      ? { desktopHostOpenService: new MacOsDesktopHostOpenService() }
      : {}),
    ...(managedTaskWorktreeService !== undefined ? { managedTaskWorktreeService } : {}),
    projectActions: createProductProjectActionToolAdapter({
      taskGraphStore,
      projectStore,
    }),
    delegationService: undefined,
  };

  const toolRegistry = new UnifiedToolRegistry({
    allowlist: profile.toolAllowlist ?? [...DEFAULT_BALANCED_TOOL_ALLOWLIST],
    context: toolContext,
    mcpServers: profile.mcpServers ?? [],
    env: mcpEnv,
  });

  const modelGateway = createModelGatewayForProfile(profile, { env: modelEnv });
  const providerReasoningVault = createProviderReasoningVaultFromEnv(store, runtimeEnv);
  const reasoningPolicyReady = Promise.all([
    providerReasoningVault.purgeExpired(),
    providerReasoningVault.applyRetentionPolicy(profile.id, profile.reasoning?.retention ?? { mode: "live_only", days: 7 }),
  ]);
  void reasoningPolicyReady.catch(() => {});
  const providerReasoningPurgeTimer = setInterval(
    () => {
      void providerReasoningVault.purgeExpired().catch(() => {});
    },
    60 * 60 * 1000,
  );
  providerReasoningPurgeTimer.unref();

  const kestrel = new Kestrel({
    store,
    modelGateway,
    providerReasoningVault,
    toolGateway: toolRegistry,
    workspaceCheckpointService,
    ...(managedTaskWorktreeService !== undefined ? { managedTaskWorktreeService } : {}),
    guardrails: {
      ...DEFAULT_KCHAT_GUARDRAILS,
      ...(profile.guardrails ?? {}),
      ...(profile.toolQueue?.perRunConcurrency !== undefined ? { maxConcurrentToolJobsPerRun: profile.toolQueue.perRunConcurrency } : {}),
      ...(profile.toolQueue?.globalConcurrency !== undefined ? { maxConcurrentToolJobsGlobal: profile.toolQueue.globalConcurrency } : {}),
      ...(profile.toolQueue?.maxQueuedJobsPerRun !== undefined ? { maxQueuedToolJobsPerRun: profile.toolQueue.maxQueuedJobsPerRun } : {}),
      ...(profile.toolQueue?.checkpointSize !== undefined ? { toolBatchCheckpointSize: profile.toolQueue.checkpointSize } : {}),
      ...(profile.toolQueue?.retryCount !== undefined ? { toolCallRetryCount: profile.toolQueue.retryCount } : {}),
    },
    ...(onRunLog !== undefined ? { runLogListener: onRunLog } : {}),
    ...(onProgress !== undefined ? { progressListener: onProgress } : {}),
    ...(onConsole !== undefined ? { consoleListener: onConsole } : {}),
    ...(onReasoning !== undefined ? { reasoningListener: onReasoning } : {}),
    ...(onRunEvent !== undefined ? { runEventListener: onRunEvent } : {}),
    heapDiagnostics: createRuntimeHeapDiagnosticsFromEnv(runtimeEnv, {
      processRole: runtimeEnv.KESTREL_RUNNER_PROCESS_ROLE ?? "ks-runtime",
    }),
  });

  const registration = registerAgent(kestrel, profile.agent, {
    ...(profile.modelProvider !== undefined ? { agentProvider: profile.modelProvider } : {}),
    thinkerToolsProvider: (ctx) =>
      toolRegistry.getModelTools({
        runContext: {
          runId: ctx.runId,
          sessionId: ctx.session.sessionId,
          payload: ctx.event.payload,
          sessionState: ctx.session.state,
        },
      }),
    capabilityManifestProvider: (ctx) =>
      toolRegistry.getCapabilityManifest({
        runContext: {
          runId: ctx.runId,
          sessionId: ctx.session.sessionId,
          payload: ctx.event.payload,
          sessionState: ctx.session.state,
        },
      }),
    ...(managedTaskWorktreeService !== undefined
      ? {
          managedWorktreeProposalProvider: (request: Parameters<ManagedTaskWorktreeService["prepare"]>[0]) => managedTaskWorktreeService.prepare(request),
        }
      : {}),
    agentStageModelByStage: profile.agentStageConfig?.modelByStage,
    reasoningRequest: profile.reasoning?.request ?? {
      mode: "provider_visible",
    },
    reasoningRetention: profile.reasoning?.retention ?? {
      mode: "live_only",
      days: 7,
    },
    reasoningRetentionScope: profile.id,
  });
  let threadRuntime: ThreadRuntime | undefined;
  const threadedTurnExecutor = new RuntimeThreadedTurnExecutor({
    entryStepAgent: registration.entryStepAgent,
    defaults: {
      defaultInteractionMode: profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
      defaultActSubmode: profile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
      defaultToolAllowlist: profile.toolAllowlist ?? [...DEFAULT_BALANCED_TOOL_ALLOWLIST],
      toolBatchCheckpointSize:
        profile.toolQueue?.checkpointSize ?? profile.guardrails?.toolBatchCheckpointSize ?? DEFAULT_KCHAT_GUARDRAILS.toolBatchCheckpointSize ?? 5,
    },
    getSession: (sessionId) => kestrel.getSession(sessionId),
    runKernel: (event, runOptions) => kestrel.run(event, runOptions),
    refreshToolRuntime: (input) => (input?.mcpContext !== undefined ? toolRegistry.refreshForRuntimeTurn(input) : toolRegistry.refreshRuntime()),
    resolveAvailableToolAllowlist: (allowlist, input, options) =>
      input?.mcpContext !== undefined
        ? toolRegistry.resolveAvailableAllowlistForRuntimeTurn(allowlist, input, {
            includeGrantedMcpTools: options?.includeGrantedMcpTools === true,
          })
        : toolRegistry.resolveAvailableAllowlist(allowlist),
    resolveSkillPackById: (skillPackId) => getSkillPackById(skillPackId),
    handleCapabilityLoss: (input) => {
      if (threadRuntime === undefined) {
        return Promise.resolve(null);
      }
      return threadRuntime.handleCapabilityLoss(input);
    },
  });
  threadRuntime = new ThreadRuntime({
    sessionStore: store,
    orchestrationStore: store,
    executor: createTurnExecutor({
      runTurn: (input) => threadedTurnExecutor.executeTurn(input),
      getSession: (sessionId) => kestrel.getSession(sessionId),
    }),
    profile,
    ...(resolveAttachments !== undefined ? { resolveAttachments } : {}),
    onTaskUpdate: (update) => {
      void persistDelegationTaskUpdateToGraph(taskGraphStore, update).catch(() => {
        // Task graph persistence is additive and should not block runtime task updates.
      });
      onTaskUpdate?.(update);
    },
  });
  toolContext.delegationService = threadRuntime.getDelegationService();

  return {
    kestrel,
    threadRuntime,
    taskGraphStore,
    projectStore,
    workspaceCheckpointService,
    ...(managedTaskWorktreeService !== undefined ? { managedTaskWorktreeService } : {}),
    ...(userTerminalService !== undefined ? { userTerminalService } : {}),
    ...(userTerminalReady !== undefined ? { userTerminalReady } : {}),
    ...(workspaceChangeService !== undefined ? { workspaceChangeService } : {}),
    ...(workspaceFeedbackService !== undefined ? { workspaceFeedbackService } : {}),
    ...(workspaceFeedbackReady !== undefined ? { workspaceFeedbackReady } : {}),
    ...(workspaceReviewService !== undefined ? { workspaceReviewService } : {}),
    ...(workspaceReviewReady !== undefined ? { workspaceReviewReady } : {}),
    ...(workspaceValidationService !== undefined
      ? { workspaceValidationService }
      : {}),
    ...(workspaceValidationReady !== undefined
      ? { workspaceValidationReady }
      : {}),
    ...(workspaceGitService !== undefined ? { workspaceGitService } : {}),
    ...(workspaceGitReady !== undefined ? { workspaceGitReady } : {}),
    entryStepAgent: registration.entryStepAgent,
    reasoningPolicyReady,
    readFinalizedPayload: async (sessionId: string) => {
      const session = await kestrel.getSession(sessionId);
      return asRecord(session?.state.agent)?.finalOutput;
    },
    prepareHostedMcpRuntime: (input) => toolRegistry.refreshForRuntimeTurn(input),
    releaseRuntimeAuthorization: (sessionId) => toolRegistry.clearRuntimeTurnAuthorization(sessionId),
    close: async () => {
      clearInterval(providerReasoningPurgeTimer);
      await userTerminalReady?.catch(() => {});
      await workspaceFeedbackReady?.catch(() => {});
      await workspaceReviewReady?.catch(() => {});
      await workspaceValidationReady?.catch(() => {});
      await workspaceGitReady?.catch(() => {});
      await userTerminalService?.close();
      await closeRuntimeResources(
        toolRegistry.close.bind(toolRegistry),
        closeStore,
        devShellService instanceof LocalDevShellService ? devShellService.close.bind(devShellService) : undefined,
      );
    },
  };
}

export function createModelGatewayForProfile(
  profile: TuiProfile,
  options: {
    createGatewayManaged?: ((profile: TuiProfile) => ModelGateway) | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  } = {},
) {
  if (profile.modelCredential) {
    return (options.createGatewayManaged ?? createGatewayManagedModelGateway)(profile);
  }
  const env = options.env ?? process.env;
  const timeoutMs = resolveModelTimeoutMs(profile, env);
  const retryCount = resolveModelRetryCount(profile, env);
  const provider = profile.modelProvider ?? "openrouter";
  const gatewayOptions = {
    env,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
    ...(profile.model !== undefined ? { envConfig: { model: profile.model } } : {}),
  };
  return createLazyModelGateway(() =>
    provider === "openai"
      ? createOpenAiModelGatewayFromEnv(gatewayOptions)
      : provider === "anthropic"
        ? createAnthropicModelGatewayFromEnv(gatewayOptions)
        : provider === "ollama"
          ? createOllamaModelGatewayFromEnv(gatewayOptions)
          : provider === "lmstudio"
            ? createLmStudioModelGatewayFromEnv(gatewayOptions)
            : createOpenRouterModelGatewayFromEnv(gatewayOptions),
  );
}

function createLazyModelGateway(factory: () => ModelGateway): ModelGateway {
  let delegate: ModelGateway | undefined;
  return {
    async call<T>(request: ModelRequest, options?: { signal?: AbortSignal | undefined }): Promise<T> {
      delegate ??= factory();
      return await delegate.call<T>(request, options);
    },
  };
}

export function resolveDevShellServiceForProfile(profile: TuiProfile, env: NodeJS.ProcessEnv = process.env) {
  if (profile.devShell?.enabled !== true) {
    return;
  }
  return createTerminalBenchDevShellServiceFromEnv(env) ?? new LocalDevShellService();
}

function requireRuntimeWorkspaceCheckpointService(service: RuntimeWorkspaceCheckpointService | undefined): RuntimeWorkspaceCheckpointService {
  if (service === undefined) {
    throw createRuntimeFailure("WORKSPACE_CHECKPOINT_UNAVAILABLE", "Workspace checkpoints are unavailable.");
  }
  return service;
}

function requireUserTerminalService(service: UserTerminalService | undefined): UserTerminalService {
  if (service === undefined) {
    throw createRuntimeFailure("USER_TERMINAL_UNAVAILABLE", "Interactive terminals are unavailable.", {
      subsystem: "terminal",
      classification: "configuration",
      recoverable: true,
    });
  }
  return service;
}

function requireWorkspaceChangeService(service: WorkspaceChangeService | undefined): WorkspaceChangeService {
  if (service === undefined) {
    throw createRuntimeFailure("WORKSPACE_CHANGE_UNAVAILABLE", "Workspace changes are unavailable.", {
      subsystem: "workspace",
      classification: "configuration",
      recoverable: true,
    });
  }
  return service;
}

function requireWorkspaceFeedbackService(service: WorkspaceFeedbackService | undefined): WorkspaceFeedbackService {
  if (service === undefined) {
    throw createRuntimeFailure("WORKSPACE_FEEDBACK_UNAVAILABLE", "Workspace feedback is unavailable.", {
      subsystem: "review",
      classification: "configuration",
      recoverable: true,
    });
  }
  return service;
}

function requireWorkspaceReviewService(service: WorkspaceReviewService | undefined): WorkspaceReviewService {
  if (service === undefined)
    throw createRuntimeFailure("WORKSPACE_REVIEW_UNAVAILABLE", "Workspace review is unavailable.", {
      subsystem: "review",
      classification: "configuration",
      recoverable: true,
    });
  return service;
}

function requireWorkspaceValidationService(
  service: WorkspaceValidationService | undefined,
): WorkspaceValidationService {
  if (service === undefined)
    throw createRuntimeFailure(
      "WORKSPACE_VALIDATION_UNAVAILABLE",
      "Workspace validation is unavailable.",
      {
        subsystem: "validation",
        classification: "configuration",
        recoverable: true,
      },
    );
  return service;
}

function requireWorkspaceGitService(service: WorkspaceGitService | undefined): WorkspaceGitService {
  if (service === undefined)
    throw createRuntimeFailure("WORKSPACE_GIT_UNAVAILABLE", "Workspace Git delivery is unavailable.", {
      subsystem: "git",
      classification: "configuration",
      recoverable: true,
    });
  return service;
}

function workspaceReviewScopeLabel(scope: WorkspaceChangeScope): string {
  return scope.kind === "branch"
    ? `branch:${scope.baseRef}`
    : scope.kind === "commit"
      ? `commit:${scope.commitSha}`
      : scope.kind === "pull_request"
        ? `pull_request:${scope.number ?? "current"}`
        : scope.kind === "latest_run"
          ? `run:${scope.runId ?? "latest"}`
          : scope.kind === "latest_turn"
            ? `turn:${scope.turnId ?? "latest"}`
            : scope.kind === "promotion"
              ? `promotion:${scope.promotionId}`
              : scope.kind;
}

async function readRepositoryReviewInstructions(repoRoot: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of ["AGENTS.md", "REVIEW.md", ".github/copilot-instructions.md"]) {
    try {
      const candidate = await realpath(path.join(repoRoot, name));
      const relative = path.relative(repoRoot, candidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const content = await readFile(candidate, "utf8");
      if (content.trim()) result.push(`Repository review instructions from ${name}:\n${content.slice(0, 64 * 1024)}`);
    } catch {
      /* Optional instructions. */
    }
  }
  return result;
}

function workspaceReviewPrompt(diff: string, fingerprint: string): string {
  return [
    "Perform a strictly read-only code review of the supplied candidate diff. Do not edit files, run shell commands, use network tools, or mutate external systems.",
    'Return only JSON with this shape: {"findings":[{"severity":"critical|high|medium|low","confidence":0.0,"path":"relative/path","line":1,"problem":"...","impact":"...","evidence":"...","remediation":"...","verification":"..."}]}. Return {"findings":[]} when there are no actionable defects.',
    `Candidate fingerprint: ${fingerprint}`,
    "",
    diff.slice(0, 512 * 1024),
  ].join("\n");
}

function parseWorkspaceReviewFindings(value: unknown): ProposedWorkspaceReviewFinding[] {
  let parsed = value;
  if (typeof value === "string") {
    const normalized = value
      .trim()
      .replace(/^```(?:json)?\s*/u, "")
      .replace(/\s*```$/u, "");
    try {
      parsed = JSON.parse(normalized);
    } catch {
      throw createRuntimeFailure("WORKSPACE_REVIEW_OUTPUT_INVALID", "Reviewer output was not valid JSON.", {
        subsystem: "review",
        classification: "contract",
        recoverable: true,
      });
    }
  }
  const record = asRecord(parsed);
  const data = asRecord(record?.data);
  const candidate = Array.isArray(record?.findings) ? record : Array.isArray(data?.findings) ? data : undefined;
  if (!(candidate && Array.isArray(candidate.findings)))
    throw createRuntimeFailure("WORKSPACE_REVIEW_OUTPUT_INVALID", "Reviewer output did not contain typed findings.", {
      subsystem: "review",
      classification: "contract",
      recoverable: true,
    });
  return candidate.findings.map((entry) => {
    const finding = asRecord(entry);
    if (!finding)
      throw createRuntimeFailure("WORKSPACE_REVIEW_OUTPUT_INVALID", "Reviewer returned a malformed finding.", {
        subsystem: "review",
        classification: "contract",
        recoverable: true,
      });
    return finding as unknown as ProposedWorkspaceReviewFinding;
  });
}

function assertCandidateFingerprint(expected: string, actual: string): void {
  if (expected !== actual) {
    throw createRuntimeFailure("WORKSPACE_FEEDBACK_STALE", "The workspace changed after this feedback was created. Refresh before continuing.", {
      subsystem: "review",
      classification: "state",
      recoverable: true,
      expectedFingerprint: expected,
      actualFingerprint: actual,
    });
  }
}

function readResumeStepAgentFromSession(state: Record<string, unknown> | undefined): string | undefined {
  return readWaitResumeStepAgent(asRecord(state?.agent));
}

export function resolveModelTimeoutMs(profile: Pick<TuiProfile, "modelProvider" | "modelTimeoutMs">, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const profileTimeout = normalizeOptionalPositiveInt(profile.modelTimeoutMs);
  if (profileTimeout !== undefined) {
    return profileTimeout;
  }
  const envTimeout = parseEnvInt("KCHAT_MODEL_TIMEOUT_MS", env);
  if (envTimeout !== undefined) {
    return envTimeout;
  }
  return profile.modelProvider === "ollama" || profile.modelProvider === "lmstudio" ? LOCAL_OPENAI_COMPATIBLE_MODEL_TIMEOUT_MS : undefined;
}

export function resolveModelRetryCount(profile: Pick<TuiProfile, "modelProvider">, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const envRetryCount = parseEnvInt("KCHAT_MODEL_RETRY_COUNT", env);
  if (envRetryCount !== undefined) {
    return envRetryCount;
  }
  return profile.modelProvider === "ollama" || profile.modelProvider === "lmstudio" ? LOCAL_OPENAI_COMPATIBLE_MODEL_RETRY_COUNT : undefined;
}

export function resolveManagedWorktreesEnabledForRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvBoolean("KESTREL_ENABLE_MANAGED_WORKTREES", env) === true;
}

export function applyRequiredManagedWorkspacePolicy(
  workspace: WorkspaceRuntimeContext | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceRuntimeContext | undefined {
  if (parseEnvBoolean("KESTREL_REQUIRE_MANAGED_WORKTREE", env) !== true) {
    return workspace;
  }
  const workspaceId = parseEnvString("KESTREL_WORKSPACE_ID", env);
  const workspaceRoot = parseEnvString("KESTREL_WORKSPACE_ROOT", env);
  if (workspaceId === undefined || workspaceRoot === undefined) {
    throw new Error("KESTREL_REQUIRE_MANAGED_WORKTREE requires KESTREL_WORKSPACE_ID and KESTREL_WORKSPACE_ROOT.");
  }
  const isolation = parseEnvString("KESTREL_MANAGED_WORKTREE_ISOLATION", env);
  if (isolation !== undefined && isolation !== "scoped" && isolation !== "session") {
    throw new Error("KESTREL_MANAGED_WORKTREE_ISOLATION must be 'scoped' or 'session'.");
  }
  return {
    workspaceId,
    workspaceRoot,
    appRoot: ".",
    commands: {},
    ...(workspace?.label !== undefined ? { label: workspace.label } : {}),
    managedWorktreeRequired: true,
    sourceWorkspaceRoot: workspaceRoot,
    ...(isolation !== undefined ? { managedWorktreeIsolation: isolation } : {}),
  };
}

function parseEnvInt(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseEnvBoolean(name: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return;
}

function parseEnvString(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return;
  }
  if (Number.isFinite(value) === false || value <= 0) {
    return;
  }
  return Math.floor(value);
}

export async function closeRuntimeResources(
  closeToolRegistry: () => Promise<void>,
  closePool: () => Promise<void>,
  closeDevShellService?: (() => Promise<void>) | undefined,
): Promise<void> {
  const errors: Error[] = [];

  try {
    await closeToolRegistry();
  } catch (error) {
    errors.push(asError(error, "toolRegistry.close failed"));
  }

  if (closeDevShellService !== undefined) {
    try {
      await closeDevShellService();
    } catch (error) {
      errors.push(asError(error, "devShellService.close failed"));
    }
  }

  try {
    await closePool();
  } catch (error) {
    errors.push(asError(error, "pool.end failed"));
  }

  if (errors.length === 1) {
    throw errors[0]!;
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, "Failed to close runtime resources");
  }
}

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}

function requireRunTurnMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  throw createRuntimeFailure("RUN_TURN_INPUT_INVALID", "KestrelChatRuntime runTurn requires turn.message to be a string.", {
    subsystem: "cli",
    classification: "schema",
    recoverable: false,
    statePath: "turn.message",
    actualType: Array.isArray(value) ? "array" : typeof value,
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
