import { AsyncLocalStorage } from "node:async_hooks";

import {
  buildPersistedRuntimeEventFromProgressUpdate,
  readAgentProgressUpdateFromPersistedRuntimeEvent,
  readProgressUpdateFromPersistedRuntimeEvent,
  readReasoningUpdateFromPersistedRuntimeEvent,
  readToolUpdateFromPersistedRuntimeEvent,
} from "../../src/events/RuntimeEventProjections.js";
import type {
  McpStatusSnapshot,
  ManagedTaskWorktreeCleanupResult,
  ManagedTaskWorktreeBinding,
  ManagedTaskWorktreeLifecycleInspection,
  ProductProjectSnapshot,
  ProductReviewDetail,
  ProductTaskGraph,
  ProgressUpdateV1,
  ReasoningUpdateV1,
  ModelReasoningUpdateV1,
  AgentProgressUpdateV1,
  RunConsoleUpdateV1,
  RunEvent,
  RunLogEntry,
  RunToolUpdateV1,
  ToolRuntimeStatus,
  UserTerminalReadResult,
  UserTerminalRecord,
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointRecord,
  WorkspaceDiffRecord,
  WorkspacePromotionPreview,
  WorkspacePromotionRecord,
  WorkspaceRestoreRecord,
  WorkspaceChangeMutationResult,
  WorkspaceChangeSnapshot,
  WorkspaceFeedbackSnapshot,
  WorkspaceReviewSnapshot,
  WorkspaceValidationSnapshot,
  WorkspaceGitSnapshot,
} from "../../src/index.js";
import { maybeBuildDatabaseConnectionFailure } from "../../src/runtime/databasePreflight.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { resolveKestrelHome } from "../config/kestrelHome.js";
import { ProfileStore } from "../config/ProfileStore.js";
import type { OperatorAssemblySummary, TuiProfile } from "../contracts.js";
import { DiagnosticLogStore } from "../diagnostics/DiagnosticLogStore.js";
import {
  buildJobReplayPointer,
  type JobRunResultV1,
} from "../job/contracts.js";
import { readDatabaseUrlSource } from "../localCoreEnv.js";
import type {
  JobRunCommandPayload,
  McpRefreshCommandPayload,
  McpStatusCommandPayload,
  OperatorControlCommandPayload,
  OperatorInboxCommandPayload,
  OperatorRunCommandPayload,
  OperatorRunReasoningCommandPayload,
  OperatorRunsCommandPayload,
  OperatorThreadCommandPayload,
  ProfileGetCommandPayload,
  ProfileListCommandPayload,
  ProjectActionCommandPayload,
  ProjectReviewActionCommandPayload,
  ProjectReviewGetCommandPayload,
  ProjectSnapshotGetCommandPayload,
  ProjectSnapshotUpdateCommandPayload,
  RunCancelCommandPayload,
  RunnerCommandMetadata,
  RunnerPingCommandPayload,
  SessionDescribeCommandPayload,
  SessionStateCommandPayload,
  TaskGraphGetCommandPayload,
  TaskGraphUpdateCommandPayload,
  UserTerminalListCommandPayload,
  UserTerminalReadCommandPayload,
  UserTerminalResizeCommandPayload,
  UserTerminalStartCommandPayload,
  UserTerminalStopCommandPayload,
  UserTerminalWriteCommandPayload,
  WorkspaceChangesInspectCommandPayload,
  WorkspaceChangesMutateCommandPayload,
  WorkspaceFeedbackAddCommandPayload,
  WorkspaceFeedbackListCommandPayload,
  WorkspaceFeedbackRemoveCommandPayload,
  WorkspaceFeedbackSubmitCommandPayload,
  WorkspaceReviewRunCommandPayload,
  WorkspaceReviewListCommandPayload,
  WorkspaceReviewUpdateCommandPayload,
  WorkspaceReviewSubmitCommandPayload,
  WorkspaceValidationInspectCommandPayload,
  WorkspaceValidationRunCommandPayload,
  WorkspaceValidationCancelCommandPayload,
  WorkspaceValidationSubmitCommandPayload,
  WorkspaceGitInspectCommandPayload,
  WorkspaceGitActionCommandPayload,
  WorkspaceCheckpointCaptureCommandPayload,
  WorkspaceCheckpointCleanupCommandPayload,
  WorkspaceCheckpointDiffCommandPayload,
  WorkspaceCheckpointInspectCommandPayload,
  WorkspaceCheckpointListCommandPayload,
  WorkspaceCheckpointRestoreCommandPayload,
  WorkspacePromotionApplyCommandPayload,
  WorkspacePromotionListCommandPayload,
  WorkspacePromotionPreviewCommandPayload,
  WorkspacePromotionUndoLatestCommandPayload,
  WorkspaceManagedCleanupCommandPayload,
  WorkspaceManagedInspectCommandPayload,
  WorkspaceManagedRestoreCommandPayload,
  WorkspaceManagedSetupRetryCommandPayload,
} from "../protocol/contracts.js";
import {
  type DelegationTaskUpdate,
  KestrelChatRuntime,
  type RunTurnInput,
  type RunTurnResult,
} from "../runtime/KestrelChatRuntime.js";
import type { RunnerEventSink } from "./EventWriter.js";

const EMPTY_TOOL_RUNTIME_STATUS: ToolRuntimeStatus = {
  healthy: true,
  checkedAt: new Date(0).toISOString(),
  providers: {},
};

interface RuntimeEntry {
  key: string;
  runtime: RunnerRuntime;
  lease: RuntimeLease;
}

interface RuntimeLease {
  runtime: RunnerRuntime;
  activeUsers: number;
  ownerCount: number;
  state: "active" | "retired" | "closing" | "closed";
}

interface ActiveRunEntry {
  commandId: string;
  profileId: string;
  abortController: AbortController;
  runId?: string | undefined;
  cancelRequested?: boolean | undefined;
}

export interface RunnerProfileProvider {
  listProfiles(): Promise<TuiProfile[]>;
  getProfile(profileId: string): Promise<TuiProfile | undefined>;
}

export interface RunnerRuntime {
  runTurn(
    input: RunTurnInput,
    options?: { signal?: AbortSignal | undefined }
  ): Promise<RunTurnResult>;
  cancelActiveRun?:
    | ((sessionId: string) => Promise<{ runId?: string | undefined }>)
    | undefined;
  describeSession?:
    | ((sessionId: string) => Promise<
        | {
            sessionId: string;
            version: number;
            threadId?: string | undefined;
            currentStepAgent?: string | undefined;
            updatedAt?: string | undefined;
            waitFor?: RunTurnResult["output"]["waitFor"] | undefined;
            activeAssembly?: OperatorAssemblySummary | undefined;
            operatorInbox?:
              | import("../contracts.js").OperatorInboxSummary
              | undefined;
            childBlocker?:
              | import("../contracts.js").OperatorChildBlockerSummary
              | undefined;
            latestCheckpoint?:
              | import("../contracts.js").OperatorCheckpointSummary
              | undefined;
            latestSteering?:
              | import("../contracts.js").OperatorSteeringSummary
              | undefined;
            focusedThreadId?: string | undefined;
          }
        | undefined
      >)
    | undefined;
  listOperatorInbox?:
    | ((
        input: OperatorInboxCommandPayload
      ) => Promise<
        import("../../src/orchestration/contracts.js").OperatorInboxSnapshot
      >)
    | undefined;
  listOperatorRuns?:
    | ((
        input: OperatorRunsCommandPayload
      ) => Promise<
        import("../../src/orchestration/contracts.js").OperatorRunIndexView
      >)
    | undefined;
  getOperatorThreadView?:
    | ((
        threadId: string
      ) => Promise<
        import("../../src/orchestration/contracts.js").OperatorThreadView | null
      >)
    | undefined;
  getOperatorRunView?:
    | ((
        runId: string
      ) => Promise<
        import("../../src/orchestration/contracts.js").OperatorRunView | null
      >)
    | undefined;
  getRetainedProviderReasoning?:
    | ((input: { runId: string; sessionId: string; actorRole: string; actorId?: string | undefined }) => Promise<Array<{
        provider: string;
        model: string;
        format: string;
        text: string;
        createdAt: string;
        expiresAt: string;
      }>>)
    | undefined;
  deleteRetainedProviderReasoning?: ((input: { runId: string; sessionId: string; actorRole: string; actorId?: string | undefined }) => Promise<number>) | undefined;
  getProviderReasoningVaultStatus?: (() => { ready: boolean; keyVersion: number; keySource: string }) | undefined;
  performOperatorAction?:
    | ((
        input: OperatorControlCommandPayload & { issuedBy?: string | undefined }
      ) => Promise<{
        sessionId?: string | undefined;
        threadId: string;
        inbox?:
          | import("../../src/orchestration/contracts.js").OperatorInboxSnapshot
          | undefined;
        view?:
          | import("../../src/orchestration/contracts.js").OperatorThreadView
          | undefined;
        result?: RunTurnResult | undefined;
      }>)
    | undefined;
  performAcceptedOperatorAction?:
    | ((input: OperatorControlCommandPayload & {
        action: "approve" | "reject" | "reply";
        issuedBy?: string | undefined;
        signal?: AbortSignal | undefined;
      }) => Promise<{
        accepted: {
          sessionId?: string | undefined;
          threadId: string;
          disposition: "accepted" | "completed";
          runId?: string | undefined;
          inbox?: import("../../src/orchestration/contracts.js").OperatorInboxSnapshot | undefined;
          view?: import("../../src/orchestration/contracts.js").OperatorThreadView | undefined;
          result?: RunTurnResult | undefined;
        };
        completion: Promise<RunTurnResult>;
      }>)
    | undefined;
  getTaskGraph?:
    | ((input: TaskGraphGetCommandPayload) => Promise<{
        sessionId: string;
        version: number;
        graph: ProductTaskGraph;
      }>)
    | undefined;
  updateTaskGraph?:
    | ((input: TaskGraphUpdateCommandPayload) => Promise<{
        sessionId: string;
        version: number;
        graph: ProductTaskGraph;
      }>)
    | undefined;
  captureWorkspaceCheckpoint?:
    | ((input: WorkspaceCheckpointCaptureCommandPayload) => Promise<{
        sessionId: string;
        checkpoint: WorkspaceCheckpointDetail;
      }>)
    | undefined;
  listWorkspaceCheckpoints?:
    | ((input: WorkspaceCheckpointListCommandPayload) => Promise<{
        sessionId: string;
        checkpoints: WorkspaceCheckpointRecord[];
      }>)
    | undefined;
  inspectWorkspaceCheckpoint?:
    | ((input: WorkspaceCheckpointInspectCommandPayload) => Promise<{
        sessionId: string;
        checkpoint: WorkspaceCheckpointDetail;
      }>)
    | undefined;
  diffWorkspaceCheckpoints?:
    | ((
        input: WorkspaceCheckpointDiffCommandPayload
      ) => Promise<{ sessionId: string; diff: WorkspaceDiffRecord }>)
    | undefined;
  restoreWorkspaceCheckpoint?:
    | ((
        input: WorkspaceCheckpointRestoreCommandPayload
      ) => Promise<{ sessionId: string; restore: WorkspaceRestoreRecord }>)
    | undefined;
  cleanupWorkspaceCheckpoints?:
    | ((
        input: import("../protocol/contracts.js").WorkspaceCheckpointCleanupCommandPayload
      ) => Promise<
        {
          sessionId: string;
        } & import("../../src/workspaceCheckpoints/contracts.js").WorkspaceCheckpointCleanupResult
      >)
    | undefined;
  restoreLatestWorkspacePromotion?:
    | ((
        input: WorkspacePromotionUndoLatestCommandPayload
      ) => Promise<{ sessionId: string; restore: WorkspaceRestoreRecord }>)
    | undefined;
  listWorkspacePromotions?:
    | ((input: WorkspacePromotionListCommandPayload) => Promise<{
        sessionId: string;
        promotions: WorkspacePromotionRecord[];
      }>)
    | undefined;
  previewWorkspacePromotion?:
    | ((
        input: WorkspacePromotionPreviewCommandPayload
      ) => Promise<{ sessionId: string; preview: WorkspacePromotionPreview }>)
    | undefined;
  applyWorkspacePromotion?:
    | ((
        input: WorkspacePromotionApplyCommandPayload & {
          appliedBy?: string | undefined;
        }
      ) => Promise<{
        sessionId: string;
        promotion: WorkspacePromotionRecord;
      }>)
    | undefined;
  inspectManagedWorktree?:
    | ((input: WorkspaceManagedInspectCommandPayload) => Promise<{
        sessionId: string;
        inspection: ManagedTaskWorktreeLifecycleInspection;
      }>)
    | undefined;
  cleanupManagedWorktree?:
    | ((input: WorkspaceManagedCleanupCommandPayload & { cleanedBy?: string | undefined }) => Promise<{
        sessionId: string;
        checkpoint: WorkspaceCheckpointDetail;
        cleanup: ManagedTaskWorktreeCleanupResult;
      }>)
    | undefined;
  restoreManagedWorktree?:
    | ((input: WorkspaceManagedRestoreCommandPayload & { restoredBy?: string | undefined }) => Promise<{
        sessionId: string;
        binding: ManagedTaskWorktreeBinding;
        restore: WorkspaceRestoreRecord;
      }>)
    | undefined;
  retryManagedWorktreeSetup?:
    | ((input: WorkspaceManagedSetupRetryCommandPayload) => Promise<{
        sessionId: string;
        inspection: ManagedTaskWorktreeLifecycleInspection;
      }>)
    | undefined;
  startUserTerminal?: ((input: UserTerminalStartCommandPayload) => Promise<UserTerminalRecord>) | undefined;
  listUserTerminals?: ((input: UserTerminalListCommandPayload) => Promise<UserTerminalRecord[]>) | undefined;
  readUserTerminal?: ((input: UserTerminalReadCommandPayload) => Promise<UserTerminalReadResult>) | undefined;
  writeUserTerminal?: ((input: UserTerminalWriteCommandPayload) => Promise<UserTerminalRecord>) | undefined;
  resizeUserTerminal?: ((input: UserTerminalResizeCommandPayload) => Promise<UserTerminalRecord>) | undefined;
  stopUserTerminal?: ((input: UserTerminalStopCommandPayload) => Promise<UserTerminalRecord>) | undefined;
  inspectWorkspaceChanges?: ((input: WorkspaceChangesInspectCommandPayload) => Promise<WorkspaceChangeSnapshot>) | undefined;
  mutateWorkspaceChanges?: ((input: WorkspaceChangesMutateCommandPayload) => Promise<WorkspaceChangeMutationResult>) | undefined;
  addWorkspaceFeedback?: ((input: WorkspaceFeedbackAddCommandPayload) => Promise<WorkspaceFeedbackSnapshot>) | undefined;
  listWorkspaceFeedback?: ((input: WorkspaceFeedbackListCommandPayload) => Promise<WorkspaceFeedbackSnapshot>) | undefined;
  removeWorkspaceFeedback?: ((input: WorkspaceFeedbackRemoveCommandPayload) => Promise<WorkspaceFeedbackSnapshot>) | undefined;
  submitWorkspaceFeedback?: ((input: WorkspaceFeedbackSubmitCommandPayload) => Promise<{ snapshot: WorkspaceFeedbackSnapshot; result: RunTurnResult }>) | undefined;
  runWorkspaceReview?: ((input: WorkspaceReviewRunCommandPayload) => Promise<WorkspaceReviewSnapshot>) | undefined;
  listWorkspaceReviews?: ((input: WorkspaceReviewListCommandPayload) => Promise<WorkspaceReviewSnapshot>) | undefined;
  updateWorkspaceReviewFinding?: ((input: WorkspaceReviewUpdateCommandPayload) => Promise<WorkspaceReviewSnapshot>) | undefined;
  submitWorkspaceReviewFindings?: ((input: WorkspaceReviewSubmitCommandPayload) => Promise<{ snapshot: WorkspaceReviewSnapshot; result: RunTurnResult }>) | undefined;
  inspectWorkspaceValidation?: ((input: WorkspaceValidationInspectCommandPayload) => Promise<WorkspaceValidationSnapshot>) | undefined;
  runWorkspaceValidation?: ((input: WorkspaceValidationRunCommandPayload) => Promise<WorkspaceValidationSnapshot>) | undefined;
  cancelWorkspaceValidation?: ((input: WorkspaceValidationCancelCommandPayload) => Promise<WorkspaceValidationSnapshot>) | undefined;
  submitWorkspaceValidationFailures?: ((input: WorkspaceValidationSubmitCommandPayload) => Promise<{ snapshot: WorkspaceValidationSnapshot; result: RunTurnResult }>) | undefined;
  inspectWorkspaceGit?: ((input: WorkspaceGitInspectCommandPayload) => Promise<WorkspaceGitSnapshot>) | undefined;
  performWorkspaceGitAction?: ((input: WorkspaceGitActionCommandPayload) => Promise<WorkspaceGitSnapshot>) | undefined;
  getSessionState?:
    | ((sessionId: string) => Promise<
        | {
            session: {
              sessionId: string;
              version: number;
              threadId?: string | undefined;
              currentStepAgent?: string | undefined;
              updatedAt?: string | undefined;
              waitFor?: RunTurnResult["output"]["waitFor"] | undefined;
              activeAssembly?: OperatorAssemblySummary | undefined;
              operatorInbox?:
                | import("../contracts.js").OperatorInboxSummary
                | undefined;
              childBlocker?:
                | import("../contracts.js").OperatorChildBlockerSummary
                | undefined;
              latestCheckpoint?:
                | import("../contracts.js").OperatorCheckpointSummary
                | undefined;
              latestSteering?:
                | import("../contracts.js").OperatorSteeringSummary
                | undefined;
              focusedThreadId?: string | undefined;
            };
            version: number;
            graph: ProductTaskGraph;
          }
        | undefined
      >)
    | undefined;
  getProjectSnapshot?:
    | ((
        input: ProjectSnapshotGetCommandPayload
      ) => Promise<{ sessionId: string; snapshot: ProductProjectSnapshot }>)
    | undefined;
  updateProjectSnapshot?:
    | ((
        input: ProjectSnapshotUpdateCommandPayload
      ) => Promise<{ sessionId: string; snapshot: ProductProjectSnapshot }>)
    | undefined;
  performProjectAction?:
    | ((
        input: ProjectActionCommandPayload
      ) => Promise<{ sessionId: string; snapshot: ProductProjectSnapshot }>)
    | undefined;
  getProjectReviewDetail?:
    | ((
        input: ProjectReviewGetCommandPayload
      ) => Promise<{ sessionId: string; detail: ProductReviewDetail }>)
    | undefined;
  performProjectReviewAction?:
    | ((
        input: ProjectReviewActionCommandPayload
      ) => Promise<{ sessionId: string; detail: ProductReviewDetail }>)
    | undefined;
  getToolRuntimeStatus?: (() => Promise<ToolRuntimeStatus>) | undefined;
  refreshToolRuntime?: (() => Promise<ToolRuntimeStatus>) | undefined;
  close(): Promise<void>;
}

type RunnerRuntimeFactory = (
  profile: TuiProfile,
  onRunLog: (entry: RunLogEntry) => void,
  onProgress: (update: ProgressUpdateV1) => void,
  onConsole: (update: RunConsoleUpdateV1) => void,
  onReasoning: (update: ReasoningUpdateV1 | ModelReasoningUpdateV1) => void,
  onTaskUpdate: (update: DelegationTaskUpdate) => void,
  onRunEvent: (event: RunEvent) => void
) => RunnerRuntime;

function normalizeFinalizedResultRunId(
  result: RunTurnResult,
  acceptedRunId: string | undefined
): RunTurnResult {
  if (
    acceptedRunId === undefined ||
    result.finalizedPayload === undefined ||
    result.output.status !== "COMPLETED" ||
    result.output.runId === acceptedRunId
  ) {
    return result;
  }
  return {
    ...result,
    output: {
      ...result.output,
      runId: acceptedRunId,
    },
  };
}

export class RunnerHost {
  private readonly writer: RunnerEventSink;
  private readonly runtimeFactory: RunnerRuntimeFactory;
  private readonly profileProvider: RunnerProfileProvider;
  private readonly diagnosticsStore = new DiagnosticLogStore();
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly commandBySession = new Map<string, string>();
  private readonly commandTypeBySession = new Map<
    string,
    "run.start" | "job.run" | "operator.control"
  >();
  private readonly threadIdBySession = new Map<string, string>();
  private readonly activeRuns = new Map<string, ActiveRunEntry>();
  private readonly activeExecutions = new Set<Promise<void>>();
  private readonly runtimeUsage = new AsyncLocalStorage<Set<RuntimeLease>>();
  private readonly runtimeLeases = new WeakMap<RunnerRuntime, RuntimeLease>();
  private readonly retiredRuntimes = new Set<RuntimeLease>();
  private readonly retiredRuntimeClosures = new Set<Promise<void>>();
  private readonly retiredRuntimeCloseFailures: unknown[] = [];
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(
    writer: RunnerEventSink,
    runtimeFactory: RunnerRuntimeFactory = (
      profile,
      onRunLog,
      _onProgress,
      onConsole,
      _onReasoning,
      onTaskUpdate,
      onRunEvent
    ) =>
      new KestrelChatRuntime(profile, undefined, {
        onRunLog,
        onConsole,
        onTaskUpdate,
        onRunEvent,
      }),
    profileProvider: RunnerProfileProvider = createDefaultProfileProvider()
  ) {
    this.writer = writer;
    this.runtimeFactory = runtimeFactory;
    this.profileProvider = profileProvider;
  }

  async profileList(
    commandId: string,
    _payload: ProfileListCommandPayload
  ): Promise<void> {
    const profiles = await this.profileProvider.listProfiles();
    this.writer.emit("profile.listed", { profiles }, { commandId });
  }

  async profileGet(
    commandId: string,
    payload: ProfileGetCommandPayload
  ): Promise<void> {
    const profile = await this.profileProvider.getProfile(payload.profileId);
    if (profile === undefined) {
      this.writer.emit(
        "runner.error",
        {
          code: "PROFILE_NOT_FOUND",
          message: `Profile '${payload.profileId}' was not found.`,
          details: {
            profileId: payload.profileId,
          },
        },
        { commandId }
      );
      return;
    }
    this.writer.emit("profile.loaded", { profile }, { commandId });
  }

  runStart(
    commandId: string,
    payload: { profile?: TuiProfile | undefined; profileId?: string | undefined; turn: RunTurnInput },
    metadata?: RunnerCommandMetadata | undefined,
  ): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error("Runner host is closing and cannot accept new executions."));
    }
    return this.trackExecution(this.withRuntimeUsage(
      () => this.executeRunStart(commandId, payload, metadata),
    ));
  }

  private async executeRunStart(
    commandId: string,
    payload: {
      profile?: TuiProfile | undefined;
      profileId?: string | undefined;
      turn: RunTurnInput;
    },
    metadata?: RunnerCommandMetadata | undefined
  ): Promise<void> {
    const profile = await this.resolveProfileOrThrow(payload, "run.start");
    this.assertAcceptingExecutions();
    const tenantId = metadata?.actor?.tenantId ?? metadata?.tenantId;
    if (profile.modelCredential) {
      if (!tenantId) {
        throw new Error(
          "Gateway-managed execution requires an authenticated tenant context.",
        );
      }
      if (profile.modelCredential.organizationId !== tenantId) {
        throw new Error(
          "Gateway-managed execution credential does not belong to the authenticated tenant.",
        );
      }
    }
    const turn: RunTurnInput = {
      ...payload.turn,
      ...(metadata?.actor !== undefined
        ? {
            actor: {
              ...metadata.actor,
              ...(metadata.actor.tenantId === undefined &&
              metadata.tenantId !== undefined
                ? { tenantId: metadata.tenantId }
                : {}),
            },
          }
        : {}),
    };
    const requestedRunId =
      typeof turn.runId === "string" && turn.runId.trim().length > 0
        ? turn.runId.trim()
        : undefined;
    const existing = this.activeRuns.get(turn.sessionId);
    if (existing !== undefined) {
      this.writer.emit(
        "run.started",
        {
          sessionId: turn.sessionId,
          ...(existing.runId !== undefined ? { runId: existing.runId } : {}),
          eventType: turn.eventType,
        },
        {
          commandId,
          sessionId: turn.sessionId,
          ...(existing.runId !== undefined ? { runId: existing.runId } : {}),
        }
      );
      return;
    }
    const runtime = this.getRuntime(profile);
    const reasoningVaultStatus = runtime.getProviderReasoningVaultStatus?.();
    this.commandBySession.set(turn.sessionId, commandId);
    this.commandTypeBySession.set(turn.sessionId, "run.start");
    this.threadIdBySession.set(turn.sessionId, turn.sessionId);
    const abortController = new AbortController();
    this.activeRuns.set(turn.sessionId, {
      commandId,
      profileId: profile.id,
      abortController,
      ...(requestedRunId !== undefined ? { runId: requestedRunId } : {}),
    });

    this.writer.emit(
      "run.started",
      {
        sessionId: turn.sessionId,
        ...(requestedRunId !== undefined ? { runId: requestedRunId } : {}),
        eventType: turn.eventType,
        ...(turn.stepAgent !== undefined ? { stepAgent: turn.stepAgent } : {}),
        ...(turn.modeSystemV2Enabled !== undefined
          ? { modeSystemV2Enabled: turn.modeSystemV2Enabled }
          : {}),
        ...(turn.interactionMode !== undefined
          ? { interactionMode: turn.interactionMode }
          : {}),
        ...(turn.actSubmode !== undefined
          ? { actSubmode: turn.actSubmode }
          : {}),
        ...(turn.mcpContext !== undefined
          ? { mcpContext: turn.mcpContext }
          : {}),
        ...(turn.clientCapabilities !== undefined
          ? { clientCapabilities: turn.clientCapabilities }
          : {}),
        ...(turn.executionPolicy !== undefined
          ? { executionPolicy: turn.executionPolicy }
          : {}),
        ...(reasoningVaultStatus !== undefined
          ? { reasoningKeyReady: reasoningVaultStatus.ready, reasoningKeyVersion: reasoningVaultStatus.keyVersion }
          : {}),
      },
      {
        commandId,
        sessionId: turn.sessionId,
        ...(requestedRunId !== undefined ? { runId: requestedRunId } : {}),
      }
    );

    try {
      const result = await runtime.runTurn(turn, {
        signal: abortController.signal,
      });
      const terminalResult = normalizeFinalizedResultRunId(
        result,
        requestedRunId
      );
      const active = this.activeRuns.get(turn.sessionId);
      if (active !== undefined && active.commandId === commandId) {
        active.runId = requestedRunId ?? terminalResult.output.runId;
      }
      const emittedRunId = requestedRunId ?? terminalResult.output.runId;
      if (
        requestedRunId !== undefined &&
        terminalResult.output.runId !== requestedRunId
      ) {
        const error = {
          code: "RUN_ID_MISMATCH",
          message:
            "Runtime returned a different run ID than the accepted runner run ID.",
          details: {
            requestedRunId,
            outputRunId: terminalResult.output.runId,
          },
        };
        this.writer.emit(
          "run.failed",
          {
            result: {
              ...terminalResult,
              assistantText: null,
              output: {
                ...terminalResult.output,
                status: "FAILED",
                errors: [...terminalResult.output.errors, error],
              },
            },
            error,
          },
          {
            commandId,
            runId: emittedRunId,
            sessionId: turn.sessionId,
          }
        );
        return;
      }
      if (terminalResult.output.status === "FAILED") {
        await this.appendTerminalHandoffDiagnostic({
          scope: "terminal_handoff.runner_emit_failed",
          summary: "Runner emitting run.failed.",
          sessionId: turn.sessionId,
          profileId: profile.id,
          details: {
            commandId,
            runId: emittedRunId,
            outputStatus: terminalResult.output.status,
            finalizedPayloadPresent:
              terminalResult.finalizedPayload !== undefined,
            errorCode: terminalResult.output.errors[0]?.code,
            errorMessage: terminalResult.output.errors[0]?.message,
          },
        });
        this.writer.emit(
          "run.failed",
          {
            result: terminalResult,
            error: {
              code: terminalResult.output.errors[0]?.code ?? "RUN_FAILED",
              message: terminalResult.output.errors[0]?.message ?? "Run failed",
            },
          },
          {
            commandId,
            runId: emittedRunId,
            sessionId: turn.sessionId,
          }
        );
        return;
      }

      await this.appendTerminalHandoffDiagnostic({
        scope: "terminal_handoff.runner_emit_completed",
        summary: "Runner emitting run.completed.",
        sessionId: turn.sessionId,
        profileId: profile.id,
        details: {
          commandId,
          runId: emittedRunId,
          outputStatus: terminalResult.output.status,
          finalizedPayloadPresent:
            terminalResult.finalizedPayload !== undefined,
        },
      });
      this.writer.emit(
        "run.completed",
        { result: terminalResult },
        {
          commandId,
          runId: emittedRunId,
          sessionId: turn.sessionId,
        }
      );
    } catch (error) {
      const active = this.activeRuns.get(turn.sessionId);
      if (
        abortController.signal.aborted &&
        active?.commandId === commandId &&
        active.cancelRequested === true
      ) {
        this.writer.emit(
          "run.cancelled",
          {
            sessionId: turn.sessionId,
            ...(active.runId !== undefined ? { runId: active.runId } : {}),
            result: buildNonResponsiveTerminalResult({
              status: "CANCELLED",
              sessionId: turn.sessionId,
              runId: active.runId ?? requestedRunId ?? commandId,
            }),
          },
          {
            commandId,
            ...(active.runId !== undefined ? { runId: active.runId } : {}),
            sessionId: turn.sessionId,
          }
        );
        return;
      }
      const failure = this.normalizeTerminalError(error);
      this.writer.emit(
        "run.failed",
        {
          result: buildNonResponsiveTerminalResult({
            status: "FAILED",
            sessionId: turn.sessionId,
            runId: active?.runId ?? requestedRunId ?? commandId,
            error: failure,
          }),
          error: {
            code: failure.code,
            message: failure.message,
            ...(failure.details !== undefined
              ? { details: failure.details }
              : {}),
          },
        },
        {
          commandId,
          ...(active?.runId !== undefined ? { runId: active.runId } : {}),
          sessionId: turn.sessionId,
        }
      );
      await this.appendTerminalHandoffDiagnostic({
        scope: "terminal_handoff.runner_exception",
        summary: "Runner threw before emitting a terminal result payload.",
        sessionId: turn.sessionId,
        profileId: profile.id,
        details: {
          commandId,
          code: failure.code,
          message: failure.message,
          ...(failure.details !== undefined
            ? { details: failure.details }
            : {}),
        },
      });
    } finally {
      this.commandBySession.delete(turn.sessionId);
      this.commandTypeBySession.delete(turn.sessionId);
      this.activeRuns.delete(turn.sessionId);
    }
  }

  jobRun(commandId: string, payload: JobRunCommandPayload): Promise<void> {
    if (this.closing) {
      return Promise.reject(
        new Error("Runner host is closing and cannot accept new executions.")
      );
    }
    return this.trackExecution(this.withRuntimeUsage(
      () => this.executeJobRun(commandId, payload),
    ));
  }

  private async executeJobRun(
    commandId: string,
    payload: JobRunCommandPayload
  ): Promise<void> {
    const profileInput = payload.profile ?? payload.input.profile;
    const profileIdInput = payload.profileId ?? payload.input.profileId;
    const resolvedProfile = await this.resolveProfileOrThrow(
      {
        ...(profileInput !== undefined ? { profile: profileInput } : {}),
        ...(profileIdInput !== undefined ? { profileId: profileIdInput } : {}),
      },
      "job.run"
    );
    this.assertAcceptingExecutions();
    const profile: TuiProfile = {
      ...resolvedProfile,
      ...(payload.input.storeDriver !== undefined
        ? { storeDriver: payload.input.storeDriver }
        : {}),
      ...(payload.input.approvalPolicyPackId !== undefined
        ? { approvalPolicyPackId: payload.input.approvalPolicyPackId }
        : {}),
    };
    const turn: RunTurnInput = {
      ...payload.input.turn,
      eventType: payload.input.turn.eventType ?? "job.run",
    };
    const runtime = this.getRuntime(profile);
    this.commandBySession.set(turn.sessionId, commandId);
    this.commandTypeBySession.set(turn.sessionId, "job.run");
    const abortController = new AbortController();
    this.activeRuns.set(turn.sessionId, {
      commandId,
      profileId: profile.id,
      abortController,
    });

    const defaultThreadId = turn.sessionId;
    const initialThreadId = await this.resolveThreadIdForSession(
      runtime,
      turn.sessionId,
      defaultThreadId
    );
    this.threadIdBySession.set(turn.sessionId, initialThreadId);
    this.writer.emit(
      "job.started",
      {
        sessionId: turn.sessionId,
        threadId: initialThreadId,
        profileId: profile.id,
      },
      {
        commandId,
        sessionId: turn.sessionId,
        threadId: initialThreadId,
      }
    );
    this.writer.emit(
      "job.progress",
      {
        sessionId: turn.sessionId,
        threadId: initialThreadId,
        stage: "accepted",
        message: "Job accepted by runner host.",
      },
      {
        commandId,
        sessionId: turn.sessionId,
        threadId: initialThreadId,
      }
    );

    try {
      const result = await runtime.runTurn(turn, {
        signal: abortController.signal,
      });
      const active = this.activeRuns.get(turn.sessionId);
      if (active !== undefined && active.commandId === commandId) {
        active.runId = result.output.runId;
      }
      const threadId = await this.resolveThreadIdForSession(
        runtime,
        turn.sessionId,
        defaultThreadId
      );
      this.threadIdBySession.set(turn.sessionId, threadId);
      const replay = buildJobReplayPointer({
        sessionId: turn.sessionId,
        threadId,
        runId: result.output.runId,
      });
      const output: JobRunResultV1 = {
        version: "job_run_result_v1",
        sessionId: turn.sessionId,
        threadId,
        runId: result.output.runId,
        status: result.output.status,
        ...(result.output.waitFor !== undefined
          ? { waitFor: result.output.waitFor }
          : {}),
        replay,
        result,
      };

      this.writer.emit(
        "job.progress",
        {
          sessionId: turn.sessionId,
          threadId,
          runId: result.output.runId,
          stage: "finalizing",
          message: "Run terminal state reached; finalizing job output.",
        },
        {
          commandId,
          sessionId: turn.sessionId,
          threadId,
          runId: result.output.runId,
        }
      );

      if (result.output.status === "FAILED") {
        const error = {
          code: result.output.errors[0]?.code ?? "RUN_FAILED",
          message: result.output.errors[0]?.message ?? "Run failed",
          ...(result.output.errors[0]?.details !== undefined
            ? { details: result.output.errors[0]?.details }
            : {}),
        };
        this.writer.emit(
          "job.failed",
          {
            output: {
              ...output,
              error,
            },
            replay,
            error,
          },
          {
            commandId,
            sessionId: turn.sessionId,
            threadId,
            runId: result.output.runId,
          }
        );
        return;
      }

      this.writer.emit(
        "job.completed",
        {
          output,
          replay,
        },
        {
          commandId,
          sessionId: turn.sessionId,
          threadId,
          runId: result.output.runId,
        }
      );
    } catch (error) {
      const active = this.activeRuns.get(turn.sessionId);
      const runId = active?.runId ?? `job-failed-${commandId}`;
      const threadId = await this.resolveThreadIdForSession(
        runtime,
        turn.sessionId,
        defaultThreadId
      );
      this.threadIdBySession.set(turn.sessionId, threadId);
      const replay = buildJobReplayPointer({
        sessionId: turn.sessionId,
        threadId,
        runId,
      });
      const failure = this.normalizeTerminalError(error);
      const result = buildNonResponsiveTerminalResult({
        status: "FAILED",
        sessionId: turn.sessionId,
        runId,
        error: failure,
      });
      this.writer.emit(
        "job.failed",
        {
          output: {
            version: "job_run_result_v1",
            sessionId: turn.sessionId,
            threadId,
            runId,
            status: "FAILED",
            replay,
            result,
            error: failure,
          },
          replay,
          error: failure,
        },
        {
          commandId,
          sessionId: turn.sessionId,
          threadId,
          runId,
        }
      );
    } finally {
      this.commandBySession.delete(turn.sessionId);
      this.commandTypeBySession.delete(turn.sessionId);
      this.threadIdBySession.delete(turn.sessionId);
      this.activeRuns.delete(turn.sessionId);
    }
  }

  private normalizeTerminalError(error: unknown): {
    code: string;
    message: string;
    details?: Record<string, unknown> | undefined;
  } {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (databaseUrl !== undefined && databaseUrl.length > 0) {
      const databaseFailure = maybeBuildDatabaseConnectionFailure({
        error,
        descriptor: {
          databaseUrl,
          databaseUrlSource: readDatabaseUrlSource(),
        },
        env: process.env,
      });
      if (databaseFailure !== undefined) {
        return {
          code: databaseFailure.code,
          message: databaseFailure.message,
          ...(databaseFailure.details !== undefined
            ? { details: databaseFailure.details }
            : {}),
        };
      }
    }

    const code =
      typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code?: string }).code)
        : "RUNNER_RUNTIME_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const details =
      typeof (error as { details?: unknown })?.details === "object" &&
      (error as { details?: unknown }).details !== null
        ? (error as { details: Record<string, unknown> }).details
        : undefined;
    return {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    };
  }

  async runCancel(
    commandId: string,
    payload: RunCancelCommandPayload,
    metadata?: RunnerCommandMetadata | undefined
  ): Promise<void> {
    const active = this.activeRuns.get(payload.sessionId);
    let cancelledRunId: string | undefined;
    let cancelled = false;
    if (active !== undefined) {
      const matchesRunId =
        payload.runId === undefined ||
        active.runId === undefined ||
        payload.runId === active.runId;
      const matchesCommandId =
        payload.commandId === undefined ||
        payload.commandId === active.commandId;
      if (matchesRunId && matchesCommandId) {
        if (active.runId === undefined && payload.runId !== undefined) {
          active.runId = payload.runId;
        }
        active.cancelRequested = true;
        active.abortController.abort();
        cancelledRunId = active.runId;
        cancelled = true;
      }
    } else {
      cancelledRunId = await this.cancelPersistedActiveRun(
        payload.sessionId,
        metadata
      );
      cancelled = cancelledRunId !== undefined;
    }

    if (cancelled === false) {
      this.writer.emit(
        "runner.error",
        {
          code: "RUN_CANCEL_NOT_FOUND",
          message: "No matching cancellable run was found.",
          details: {
            sessionId: payload.sessionId,
            ...(payload.runId !== undefined ? { runId: payload.runId } : {}),
            ...(payload.commandId !== undefined
              ? { commandId: payload.commandId }
              : {}),
            ...(active?.runId !== undefined
              ? { activeRunId: active.runId }
              : {}),
            ...(active?.commandId !== undefined
              ? { activeCommandId: active.commandId }
              : {}),
          },
        },
        {
          commandId,
          sessionId: payload.sessionId,
          ...(payload.runId !== undefined ? { runId: payload.runId } : {}),
        }
      );
      return;
    }

    this.writer.emit(
      "run.cancelled",
      {
        sessionId: payload.sessionId,
        ...(cancelledRunId !== undefined ? { runId: cancelledRunId } : {}),
        result: buildNonResponsiveTerminalResult({
          status: "CANCELLED",
          sessionId: payload.sessionId,
          runId: cancelledRunId ?? payload.runId ?? active?.runId ?? commandId,
        }),
      },
      {
        commandId,
        sessionId: payload.sessionId,
        ...(cancelledRunId !== undefined ? { runId: cancelledRunId } : {}),
      }
    );
  }

  async describeSession(
    commandId: string,
    payload: SessionDescribeCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.describeSession === "function") {
        const described = await runtime.describeSession(payload.sessionId);
        if (described !== undefined) {
          this.writer.emit("session.described", described, {
            commandId,
            sessionId: described.sessionId,
            ...(described.threadId !== undefined
              ? { threadId: described.threadId }
              : {}),
          });
          return;
        }
      }
    }
    this.writer.emit(
      "session.described",
      {
        sessionId: payload.sessionId,
        version: 0,
      },
      {
        commandId,
        sessionId: payload.sessionId,
      }
    );
  }

  async sessionState(
    commandId: string,
    payload: SessionStateCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.getSessionState === "function") {
        const state = await runtime.getSessionState(payload.sessionId);
        if (state !== undefined) {
          this.writer.emit("session.state", state, {
            commandId,
            sessionId: state.session.sessionId,
            ...(state.session.threadId !== undefined
              ? { threadId: state.session.threadId }
              : {}),
          });
          return;
        }
      }
    }

    this.writer.emit(
      "session.state",
      {
        session: {
          sessionId: payload.sessionId,
          version: 0,
        },
        version: 0,
        graph: { version: 1, rootTaskIds: [], tasks: {} },
      },
      {
        commandId,
        sessionId: payload.sessionId,
      }
    );
  }

  async operatorInbox(
    commandId: string,
    payload: OperatorInboxCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.listOperatorInbox === "function") {
        const inbox = await runtime.listOperatorInbox(payload);
        this.writer.emit(
          "operator.inbox",
          { inbox },
          {
            commandId,
            ...(payload.sessionId !== undefined
              ? { sessionId: payload.sessionId }
              : {}),
            ...(payload.threadId !== undefined
              ? { threadId: payload.threadId }
              : {}),
          }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Operator inbox is unavailable.",
      },
      { commandId }
    );
  }

  async operatorThread(
    commandId: string,
    payload: OperatorThreadCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.getOperatorThreadView === "function") {
        const view = await runtime.getOperatorThreadView(payload.threadId);
        if (view !== null) {
          this.writer.emit(
            "operator.thread",
            { view },
            {
              commandId,
              threadId: payload.threadId,
            }
          );
          return;
        }
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "OPERATOR_THREAD_NOT_FOUND",
        message: `Thread '${payload.threadId}' was not found.`,
      },
      { commandId }
    );
  }

  async operatorRuns(
    commandId: string,
    payload: OperatorRunsCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.listOperatorRuns === "function") {
        const view = await runtime.listOperatorRuns(payload);
        this.writer.emit(
          "operator.runs",
          { view },
          {
            commandId,
            ...(payload.sessionId !== undefined
              ? { sessionId: payload.sessionId }
              : {}),
          }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Operator run index is unavailable.",
      },
      { commandId }
    );
  }

  async operatorRun(
    commandId: string,
    payload: OperatorRunCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.getOperatorRunView === "function") {
        const view = await runtime.getOperatorRunView(payload.runId);
        if (view !== null) {
          this.writer.emit(
            "operator.run",
            { view },
            {
              commandId,
              runId: payload.runId,
              sessionId: view.run.sessionId,
              ...(view.threadId !== undefined
                ? { threadId: view.threadId }
                : {}),
            }
          );
          return;
        }
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: `Run '${payload.runId}' was not found.`,
      },
      { commandId, runId: payload.runId }
    );
  }

  async operatorRunReasoning(
    commandId: string,
    payload: OperatorRunReasoningCommandPayload,
    metadata?: RunnerCommandMetadata,
  ): Promise<void> {
    if (metadata?.actor?.orgRole !== "org_admin") {
      this.writer.emit("runner.error", {
        code: "RUNNER_FORBIDDEN",
        message: "Retained provider reasoning is restricted to organization administrators.",
      }, { commandId, runId: payload.runId });
      return;
    }
    for (const runtime of this.selectRuntimes(metadata)) {
      const action = payload.action ?? "read";
      if (action === "read" && typeof runtime.getRetainedProviderReasoning !== "function") continue;
      if (action === "delete" && typeof runtime.deleteRetainedProviderReasoning !== "function") continue;
      const deletedCount = action === "delete"
        ? await runtime.deleteRetainedProviderReasoning!({ runId: payload.runId, sessionId: payload.sessionId, actorRole: metadata.actor.orgRole, actorId: metadata.actor.actorId })
        : undefined;
      const entries = action === "read"
        ? await runtime.getRetainedProviderReasoning!({ runId: payload.runId, sessionId: payload.sessionId, actorRole: metadata.actor.orgRole, actorId: metadata.actor.actorId })
        : [];
      this.writer.emit("operator.run.reasoning", {
        runId: payload.runId,
        entries,
        action,
        ...(deletedCount !== undefined ? { deletedCount } : {}),
        retention: "provider_visible",
        access: "org_admin",
      }, { commandId, runId: payload.runId });
      return;
    }
    this.writer.emit("runner.error", {
      code: "RUNNER_RUNTIME_ERROR",
      message: "Retained provider reasoning is unavailable.",
    }, { commandId, runId: payload.runId });
  }

  async operatorControl(
    commandId: string,
    payload: OperatorControlCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (payload.completionMode === "accepted") {
        if (
          (payload.action !== "approve" && payload.action !== "reject" && payload.action !== "reply")
          || typeof runtime.performAcceptedOperatorAction !== "function"
        ) {
          this.writer.emit("runner.error", {
            code: "RUNNER_RUNTIME_ERROR",
            message: "Accepted operator control is available only for approval and reply actions.",
          }, { commandId, threadId: payload.threadId });
          return;
        }
        const issuedBy = resolveIssuedBy(metadata);
        const abortController = new AbortController();
        const execution = await runtime.performAcceptedOperatorAction({
          ...payload,
          action: payload.action,
          ...(issuedBy !== undefined ? { issuedBy } : {}),
          signal: abortController.signal,
        });
        const sessionId = execution.accepted.sessionId;
        if (sessionId !== undefined) {
          this.commandBySession.set(sessionId, commandId);
          this.commandTypeBySession.set(sessionId, "operator.control");
          this.threadIdBySession.set(sessionId, payload.threadId);
          this.activeRuns.set(sessionId, {
            commandId,
            profileId: metadata?.profile?.id ?? "operator-control",
            abortController,
            ...(execution.accepted.runId !== undefined ? { runId: execution.accepted.runId } : {}),
          });
        }
        this.writer.emit("operator.controlled", execution.accepted, {
          commandId,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(execution.accepted.runId !== undefined ? { runId: execution.accepted.runId } : {}),
          threadId: payload.threadId,
        });
        if (execution.accepted.disposition === "accepted" && sessionId !== undefined) {
          this.writer.emit("run.started", {
            sessionId,
            eventType: "user.reply",
            ...(payload.interactionMode !== undefined ? { interactionMode: payload.interactionMode } : {}),
            ...(payload.actSubmode !== undefined ? { actSubmode: payload.actSubmode } : {}),
          }, {
            commandId,
            sessionId,
            ...(execution.accepted.runId !== undefined ? { runId: execution.accepted.runId } : {}),
            threadId: payload.threadId,
          });
        }
        const completion = execution.completion
          .then((result) => {
            const completedSessionId = sessionId ?? result.output.sessionId;
            const runId = result.output.runId;
            const active = this.activeRuns.get(completedSessionId);
            if (active?.commandId === commandId && active.cancelRequested === true) {
              this.writer.emit("run.cancelled", {
                sessionId: completedSessionId,
                runId,
                result: buildNonResponsiveTerminalResult({
                  status: "CANCELLED",
                  sessionId: completedSessionId,
                  runId,
                }),
              }, { commandId, sessionId: completedSessionId, runId, threadId: payload.threadId });
              return;
            }
            if (result.output.status === "FAILED") {
              this.writer.emit("run.failed", {
                result,
                error: {
                  code: result.output.errors[0]?.code ?? "RUN_FAILED",
                  message: result.output.errors[0]?.message ?? "Run failed",
                },
              }, { commandId, sessionId: completedSessionId, runId, threadId: payload.threadId });
            } else {
              this.writer.emit("run.completed", { result }, {
                commandId,
                sessionId: completedSessionId,
                runId,
                threadId: payload.threadId,
              });
            }
          })
          .catch((error: unknown) => {
            const failure = this.normalizeTerminalError(error);
            const completedSessionId = sessionId ?? execution.accepted.sessionId;
            const active = completedSessionId !== undefined ? this.activeRuns.get(completedSessionId) : undefined;
            if (completedSessionId !== undefined && active?.commandId === commandId && active.cancelRequested === true) {
              const runId = active.runId ?? execution.accepted.runId ?? commandId;
              this.writer.emit("run.cancelled", {
                sessionId: completedSessionId,
                runId,
                result: buildNonResponsiveTerminalResult({ status: "CANCELLED", sessionId: completedSessionId, runId }),
              }, { commandId, sessionId: completedSessionId, runId, threadId: payload.threadId });
              return;
            }
            this.writer.emit("run.failed", {
              result: buildNonResponsiveTerminalResult({
                status: "FAILED",
                sessionId: completedSessionId ?? payload.threadId,
                runId: execution.accepted.runId ?? commandId,
                error: failure,
              }),
              error: failure,
            }, {
              commandId,
              ...(completedSessionId !== undefined ? { sessionId: completedSessionId } : {}),
              ...(execution.accepted.runId !== undefined ? { runId: execution.accepted.runId } : {}),
              threadId: payload.threadId,
            });
          })
          .finally(() => {
            if (sessionId !== undefined && this.commandBySession.get(sessionId) === commandId) {
              this.commandBySession.delete(sessionId);
              this.commandTypeBySession.delete(sessionId);
              this.threadIdBySession.delete(sessionId);
              this.activeRuns.delete(sessionId);
            }
          });
        void this.trackExecution(completion);
        return;
      }
      if (typeof runtime.performOperatorAction === "function") {
        const issuedBy = resolveIssuedBy(metadata);
        const result = await runtime.performOperatorAction({
          ...payload,
          ...(issuedBy !== undefined ? { issuedBy } : {}),
        });
        this.writer.emit("operator.controlled", { ...result, disposition: "completed" }, {
          commandId,
          ...(result.sessionId !== undefined
            ? { sessionId: result.sessionId }
            : {}),
          threadId: result.threadId,
        });
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Operator control is unavailable.",
      },
      { commandId }
    );
  }

  async taskGraphGet(
    commandId: string,
    payload: TaskGraphGetCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.getTaskGraph === "function") {
        const snapshot = await runtime.getTaskGraph(payload);
        this.writer.emit("task.graph", snapshot, {
          commandId,
          sessionId: snapshot.sessionId,
          ...(payload.threadId !== undefined
            ? { threadId: payload.threadId }
            : {}),
        });
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Task graph is unavailable.",
      },
      { commandId }
    );
  }

  async taskGraphUpdate(
    commandId: string,
    payload: TaskGraphUpdateCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.updateTaskGraph === "function") {
        try {
          const snapshot = await runtime.updateTaskGraph(payload);
          this.writer.emit("task.graph", snapshot, {
            commandId,
            sessionId: snapshot.sessionId,
            ...(payload.threadId !== undefined
              ? { threadId: payload.threadId }
              : {}),
          });
          return;
        } catch (error) {
          if (isSessionVersionConflictError(error)) {
            this.writer.emit(
              "runner.error",
              {
                code: "SESSION_VERSION_CONFLICT",
                message: error.message,
                details: {
                  sessionId: payload.sessionId,
                  ...(payload.expectedVersion !== undefined
                    ? { expectedVersion: payload.expectedVersion }
                    : {}),
                },
              },
              {
                commandId,
                sessionId: payload.sessionId,
                ...(payload.threadId !== undefined
                  ? { threadId: payload.threadId }
                  : {}),
              }
            );
            return;
          }
          throw error;
        }
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Task graph is unavailable.",
      },
      { commandId }
    );
  }

  async projectSnapshotGet(
    commandId: string,
    payload: ProjectSnapshotGetCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.getProjectSnapshot === "function") {
        const snapshot = await runtime.getProjectSnapshot(payload);
        this.writer.emit("project.snapshot", snapshot, {
          commandId,
          sessionId: snapshot.sessionId,
        });
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Project snapshot is unavailable.",
      },
      { commandId }
    );
  }

  async workspaceCheckpointCapture(
    commandId: string,
    payload: WorkspaceCheckpointCaptureCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.captureWorkspaceCheckpoint === "function") {
        const response = await runtime.captureWorkspaceCheckpoint(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "capture",
            checkpoint: response.checkpoint,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace checkpoints are unavailable.",
      },
      { commandId }
    );
  }

  async workspaceCheckpointList(
    commandId: string,
    payload: WorkspaceCheckpointListCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.listWorkspaceCheckpoints === "function") {
        const response = await runtime.listWorkspaceCheckpoints(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "list",
            checkpoints: response.checkpoints,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace checkpoints are unavailable.",
      },
      { commandId }
    );
  }

  async workspaceCheckpointInspect(
    commandId: string,
    payload: WorkspaceCheckpointInspectCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.inspectWorkspaceCheckpoint === "function") {
        const response = await runtime.inspectWorkspaceCheckpoint(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "inspect",
            checkpoint: response.checkpoint,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace checkpoints are unavailable.",
      },
      { commandId }
    );
  }

  async workspaceCheckpointDiff(
    commandId: string,
    payload: WorkspaceCheckpointDiffCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.diffWorkspaceCheckpoints === "function") {
        const response = await runtime.diffWorkspaceCheckpoints(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "diff",
            diff: response.diff,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace checkpoints are unavailable.",
      },
      { commandId }
    );
  }

  async workspaceCheckpointRestore(
    commandId: string,
    payload: WorkspaceCheckpointRestoreCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.restoreWorkspaceCheckpoint === "function") {
        const response = await runtime.restoreWorkspaceCheckpoint(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "restore",
            restore: response.restore,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace checkpoints are unavailable.",
      },
      { commandId }
    );
  }

  async workspaceCheckpointCleanup(
    commandId: string,
    payload: WorkspaceCheckpointCleanupCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.cleanupWorkspaceCheckpoints === "function") {
        const response = await runtime.cleanupWorkspaceCheckpoints(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "cleanup",
            cleanup: response.cleanup,
            deletedCheckpoints: response.deletedCheckpoints,
            remainingCheckpointCount: response.remainingCheckpointCount,
            remainingBytes: response.remainingBytes,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace checkpoints are unavailable.",
      },
      { commandId }
    );
  }

  async workspacePromotionUndoLatest(
    commandId: string,
    payload: WorkspacePromotionUndoLatestCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.restoreLatestWorkspacePromotion === "function") {
        const response = await runtime.restoreLatestWorkspacePromotion(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "promotion.undo_latest",
            restore: response.restore,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace promotion undo is unavailable.",
      },
      { commandId }
    );
  }

  async workspacePromotionList(
    commandId: string,
    payload: WorkspacePromotionListCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.listWorkspacePromotions === "function") {
        const response = await runtime.listWorkspacePromotions(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "promotion.list",
            promotions: response.promotions,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace promotion listing is unavailable.",
      },
      { commandId }
    );
  }

  async workspacePromotionPreview(
    commandId: string,
    payload: WorkspacePromotionPreviewCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.previewWorkspacePromotion === "function") {
        const response = await runtime.previewWorkspacePromotion(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "promotion.preview",
            preview: response.preview,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace promotion preview is unavailable.",
      },
      { commandId }
    );
  }

  async workspacePromotionApply(
    commandId: string,
    payload: WorkspacePromotionApplyCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.applyWorkspacePromotion === "function") {
        const response = await runtime.applyWorkspacePromotion({
          ...payload,
          ...(metadata?.actor?.actorId
            ? { appliedBy: metadata.actor.actorId }
            : {}),
        });
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "promotion.apply",
            promotion: response.promotion,
          },
          { commandId, sessionId: response.sessionId }
        );
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Workspace promotion acceptance is unavailable.",
      },
      { commandId }
    );
  }

  async workspaceManagedInspect(
    commandId: string,
    payload: WorkspaceManagedInspectCommandPayload,
    metadata?: RunnerCommandMetadata,
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.inspectManagedWorktree === "function") {
        const response = await runtime.inspectManagedWorktree(payload);
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "managed.inspect",
            managedInspection: response.inspection,
          },
          { commandId, sessionId: response.sessionId },
        );
        return;
      }
    }
    this.writer.emit("runner.error", {
      code: "RUNNER_RUNTIME_ERROR",
      message: "Managed worktree inspection is unavailable.",
    }, { commandId });
  }

  async workspaceManagedCleanup(
    commandId: string,
    payload: WorkspaceManagedCleanupCommandPayload,
    metadata?: RunnerCommandMetadata,
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.cleanupManagedWorktree === "function") {
        const response = await runtime.cleanupManagedWorktree({
          ...payload,
          ...(metadata?.actor?.actorId ? { cleanedBy: metadata.actor.actorId } : {}),
        });
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "managed.cleanup",
            managedCleanup: response.cleanup,
            cleanupCheckpoint: response.checkpoint,
          },
          { commandId, sessionId: response.sessionId },
        );
        return;
      }
    }
    this.writer.emit("runner.error", {
      code: "RUNNER_RUNTIME_ERROR",
      message: "Managed worktree cleanup is unavailable.",
    }, { commandId });
  }

  async workspaceManagedRestore(
    commandId: string,
    payload: WorkspaceManagedRestoreCommandPayload,
    metadata?: RunnerCommandMetadata,
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.restoreManagedWorktree === "function") {
        const response = await runtime.restoreManagedWorktree({
          ...payload,
          ...(metadata?.actor?.actorId ? { restoredBy: metadata.actor.actorId } : {}),
        });
        this.writer.emit(
          "workspace.checkpoint",
          {
            sessionId: response.sessionId,
            operation: "managed.restore",
            managedBinding: response.binding,
            restore: response.restore,
          },
          { commandId, sessionId: response.sessionId },
        );
        return;
      }
    }
    this.writer.emit("runner.error", {
      code: "RUNNER_RUNTIME_ERROR",
      message: "Managed worktree restore is unavailable.",
    }, { commandId });
  }

  async workspaceManagedSetupRetry(
    commandId: string,
    payload: WorkspaceManagedSetupRetryCommandPayload,
    metadata?: RunnerCommandMetadata,
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.retryManagedWorktreeSetup === "function") {
        const response = await runtime.retryManagedWorktreeSetup(payload);
        this.writer.emit("workspace.checkpoint", {
          sessionId: response.sessionId,
          operation: "managed.setup.retry",
          managedInspection: response.inspection,
        }, { commandId, sessionId: response.sessionId });
        return;
      }
    }
    this.writer.emit("runner.error", {
      code: "RUNNER_RUNTIME_ERROR",
      message: "Managed worktree setup retry is unavailable.",
    }, { commandId });
  }

  async userTerminalStart(commandId: string, payload: UserTerminalStartCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> {
    await this.runUserTerminalCommand(commandId, payload.sessionId, metadata, "start", "startUserTerminal", payload);
  }

  async userTerminalList(commandId: string, payload: UserTerminalListCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> {
    await this.runUserTerminalCommand(commandId, payload.sessionId, metadata, "list", "listUserTerminals", payload);
  }

  async userTerminalRead(commandId: string, payload: UserTerminalReadCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> {
    await this.runUserTerminalCommand(commandId, payload.sessionId, metadata, "read", "readUserTerminal", payload);
  }

  async userTerminalWrite(commandId: string, payload: UserTerminalWriteCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> {
    await this.runUserTerminalCommand(commandId, payload.sessionId, metadata, "write", "writeUserTerminal", payload);
  }

  async userTerminalResize(commandId: string, payload: UserTerminalResizeCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> {
    await this.runUserTerminalCommand(commandId, payload.sessionId, metadata, "resize", "resizeUserTerminal", payload);
  }

  async userTerminalStop(commandId: string, payload: UserTerminalStopCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> {
    await this.runUserTerminalCommand(commandId, payload.sessionId, metadata, "stop", "stopUserTerminal", payload);
  }

  private async runUserTerminalCommand(
    commandId: string,
    sessionId: string,
    metadata: RunnerCommandMetadata | undefined,
    operation: "start" | "list" | "read" | "write" | "resize" | "stop",
    method: "startUserTerminal" | "listUserTerminals" | "readUserTerminal" | "writeUserTerminal" | "resizeUserTerminal" | "stopUserTerminal",
    payload: UserTerminalStartCommandPayload | UserTerminalListCommandPayload | UserTerminalReadCommandPayload | UserTerminalWriteCommandPayload | UserTerminalResizeCommandPayload | UserTerminalStopCommandPayload,
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      const handler = runtime[method] as ((input: typeof payload) => Promise<UserTerminalRecord | UserTerminalRecord[] | UserTerminalReadResult>) | undefined;
      if (typeof handler !== "function") {
        continue;
      }
      const response = await handler.call(runtime, payload);
      const eventPayload = Array.isArray(response)
        ? { sessionId, operation, terminals: response }
        : operation === "read" && "output" in response
          ? { sessionId, operation, terminal: response.terminal, output: response.output, cursor: response.cursor, nextCursor: response.nextCursor, truncated: response.truncated }
          : { sessionId, operation, terminal: response as UserTerminalRecord };
      this.writer.emit("user.terminal", eventPayload, { commandId, sessionId });
      return;
    }
    this.writer.emit("runner.error", {
      code: "RUNNER_RUNTIME_ERROR",
      message: `User terminal ${operation} is unavailable.`,
    }, { commandId, sessionId });
  }

  async workspaceChangesInspect(commandId: string, payload: WorkspaceChangesInspectCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.inspectWorkspaceChanges !== "function") continue;
      const snapshot = await runtime.inspectWorkspaceChanges(payload);
      this.writer.emit("workspace.changes", { sessionId: payload.sessionId, threadId: payload.threadId, operation: "inspect", snapshot }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
      return;
    }
    this.writer.emit("runner.error", { code: "RUNNER_RUNTIME_ERROR", message: "Workspace change inspection is unavailable." }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
  }

  async workspaceChangesMutate(commandId: string, payload: WorkspaceChangesMutateCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.mutateWorkspaceChanges !== "function") continue;
      const result = await runtime.mutateWorkspaceChanges(payload);
      this.writer.emit("workspace.changes", {
        sessionId: payload.sessionId,
        threadId: payload.threadId,
        operation: "mutate",
        snapshot: result.snapshot,
        previousFingerprint: result.previousFingerprint,
        mutationOperation: result.operation,
      }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
      return;
    }
    this.writer.emit("runner.error", { code: "RUNNER_RUNTIME_ERROR", message: "Workspace change mutation is unavailable." }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
  }

  async workspaceFeedbackAdd(commandId: string, payload: WorkspaceFeedbackAddCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceFeedbackCommand(commandId, payload, metadata, "add", "addWorkspaceFeedback"); }
  async workspaceFeedbackList(commandId: string, payload: WorkspaceFeedbackListCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceFeedbackCommand(commandId, payload, metadata, "list", "listWorkspaceFeedback"); }
  async workspaceFeedbackRemove(commandId: string, payload: WorkspaceFeedbackRemoveCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceFeedbackCommand(commandId, payload, metadata, "remove", "removeWorkspaceFeedback"); }
  async workspaceFeedbackSubmit(commandId: string, payload: WorkspaceFeedbackSubmitCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceFeedbackCommand(commandId, payload, metadata, "submit", "submitWorkspaceFeedback"); }

  private async runWorkspaceFeedbackCommand(
    commandId: string,
    payload: WorkspaceFeedbackAddCommandPayload | WorkspaceFeedbackListCommandPayload | WorkspaceFeedbackRemoveCommandPayload | WorkspaceFeedbackSubmitCommandPayload,
    metadata: RunnerCommandMetadata | undefined,
    operation: "add" | "list" | "remove" | "submit",
    method: "addWorkspaceFeedback" | "listWorkspaceFeedback" | "removeWorkspaceFeedback" | "submitWorkspaceFeedback",
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      const handler = runtime[method] as ((input: typeof payload) => Promise<WorkspaceFeedbackSnapshot | { snapshot: WorkspaceFeedbackSnapshot; result: RunTurnResult }>) | undefined;
      if (typeof handler !== "function") continue;
      const response = await handler.call(runtime, payload);
      const snapshot = "snapshot" in response ? response.snapshot : response;
      const submissionRunId = "result" in response ? response.result.output.runId : undefined;
      this.writer.emit("workspace.feedback", { sessionId: payload.sessionId, threadId: payload.threadId, operation, snapshot, ...(submissionRunId ? { submissionRunId } : {}) }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
      return;
    }
    this.writer.emit("runner.error", { code: "RUNNER_RUNTIME_ERROR", message: `Workspace feedback ${operation} is unavailable.` }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
  }

  async workspaceReviewRun(commandId: string, payload: WorkspaceReviewRunCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceReviewCommand(commandId, payload, metadata, "run", "runWorkspaceReview"); }
  async workspaceReviewList(commandId: string, payload: WorkspaceReviewListCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceReviewCommand(commandId, payload, metadata, "list", "listWorkspaceReviews"); }
  async workspaceReviewUpdate(commandId: string, payload: WorkspaceReviewUpdateCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceReviewCommand(commandId, payload, metadata, "update", "updateWorkspaceReviewFinding"); }
  async workspaceReviewSubmit(commandId: string, payload: WorkspaceReviewSubmitCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceReviewCommand(commandId, payload, metadata, "submit", "submitWorkspaceReviewFindings"); }

  private async runWorkspaceReviewCommand(commandId: string, payload: WorkspaceReviewRunCommandPayload | WorkspaceReviewListCommandPayload | WorkspaceReviewUpdateCommandPayload | WorkspaceReviewSubmitCommandPayload, metadata: RunnerCommandMetadata | undefined, operation: "run" | "list" | "update" | "submit", method: "runWorkspaceReview" | "listWorkspaceReviews" | "updateWorkspaceReviewFinding" | "submitWorkspaceReviewFindings"): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      const handler = runtime[method] as ((input: typeof payload) => Promise<WorkspaceReviewSnapshot | { snapshot: WorkspaceReviewSnapshot; result: RunTurnResult }>) | undefined;
      if (typeof handler !== "function") continue;
      const response = await handler.call(runtime, payload); const snapshot = "snapshot" in response ? response.snapshot : response; const runId = "result" in response ? response.result.output.runId : undefined;
      this.writer.emit("workspace.review", { sessionId: payload.sessionId, threadId: payload.threadId, operation, snapshot, ...(runId ? { runId } : {}) }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId }); return;
    }
    this.writer.emit("runner.error", { code: "RUNNER_RUNTIME_ERROR", message: `Workspace review ${operation} is unavailable.` }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
  }

  async workspaceValidationInspect(commandId: string, payload: WorkspaceValidationInspectCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceValidationCommand(commandId, payload, metadata, "inspect", "inspectWorkspaceValidation"); }
  async workspaceValidationRun(commandId: string, payload: WorkspaceValidationRunCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceValidationCommand(commandId, payload, metadata, "run", "runWorkspaceValidation"); }
  async workspaceValidationCancel(commandId: string, payload: WorkspaceValidationCancelCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceValidationCommand(commandId, payload, metadata, "cancel", "cancelWorkspaceValidation"); }
  async workspaceValidationSubmit(commandId: string, payload: WorkspaceValidationSubmitCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceValidationCommand(commandId, payload, metadata, "submit", "submitWorkspaceValidationFailures"); }

  private async runWorkspaceValidationCommand(commandId: string, payload: WorkspaceValidationInspectCommandPayload | WorkspaceValidationRunCommandPayload | WorkspaceValidationCancelCommandPayload | WorkspaceValidationSubmitCommandPayload, metadata: RunnerCommandMetadata | undefined, operation: "inspect" | "run" | "cancel" | "submit", method: "inspectWorkspaceValidation" | "runWorkspaceValidation" | "cancelWorkspaceValidation" | "submitWorkspaceValidationFailures"): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      const handler = runtime[method] as ((input: typeof payload) => Promise<WorkspaceValidationSnapshot | { snapshot: WorkspaceValidationSnapshot; result: RunTurnResult }>) | undefined;
      if (typeof handler !== "function") continue;
      const response = await handler.call(runtime, payload);
      const snapshot = "snapshot" in response ? response.snapshot : response;
      const runId = "result" in response ? response.result.output.runId : undefined;
      this.writer.emit("workspace.validation", { sessionId: payload.sessionId, threadId: payload.threadId, operation, snapshot, ...(runId ? { runId } : {}) }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
      return;
    }
    this.writer.emit("runner.error", { code: "RUNNER_RUNTIME_ERROR", message: `Workspace validation ${operation} is unavailable.` }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
  }

  async workspaceGitInspect(commandId: string, payload: WorkspaceGitInspectCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceGitCommand(commandId, payload, metadata, "inspect", "inspectWorkspaceGit"); }
  async workspaceGitAction(commandId: string, payload: WorkspaceGitActionCommandPayload, metadata?: RunnerCommandMetadata): Promise<void> { await this.runWorkspaceGitCommand(commandId, payload, metadata, "action", "performWorkspaceGitAction"); }

  private async runWorkspaceGitCommand(commandId: string, payload: WorkspaceGitInspectCommandPayload | WorkspaceGitActionCommandPayload, metadata: RunnerCommandMetadata | undefined, operation: "inspect" | "action", method: "inspectWorkspaceGit" | "performWorkspaceGitAction"): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      const handler = runtime[method] as ((input: typeof payload) => Promise<WorkspaceGitSnapshot>) | undefined;
      if (typeof handler !== "function") continue;
      const snapshot = await handler.call(runtime, payload);
      this.writer.emit("workspace.git", { sessionId: payload.sessionId, threadId: payload.threadId, operation, snapshot }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
      return;
    }
    this.writer.emit("runner.error", { code: "RUNNER_RUNTIME_ERROR", message: `Workspace Git ${operation} is unavailable.` }, { commandId, sessionId: payload.sessionId, threadId: payload.threadId });
  }

  async projectSnapshotUpdate(
    commandId: string,
    payload: ProjectSnapshotUpdateCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.updateProjectSnapshot === "function") {
        const snapshot = await runtime.updateProjectSnapshot(payload);
        this.writer.emit("project.snapshot", snapshot, {
          commandId,
          sessionId: snapshot.sessionId,
        });
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Project snapshot is unavailable.",
      },
      { commandId }
    );
  }

  async projectAction(
    commandId: string,
    payload: ProjectActionCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.performProjectAction === "function") {
        try {
          const snapshot = await runtime.performProjectAction(payload);
          this.writer.emit("project.snapshot", snapshot, {
            commandId,
            sessionId: snapshot.sessionId,
          });
        } catch (error) {
          if (isProjectBoardConflictError(error)) {
            this.writer.emit(
              "runner.error",
              {
                code:
                  (error as Error & { code?: string }).code ??
                  "PROJECT_BOARD_CONFLICT",
                message:
                  error instanceof Error
                    ? error.message
                    : "Project board conflict.",
                details: {
                  sessionId: payload.sessionId,
                  ...("expectedBoardVersion" in payload &&
                  typeof payload.expectedBoardVersion === "number"
                    ? { expectedBoardVersion: payload.expectedBoardVersion }
                    : {}),
                },
              },
              {
                commandId,
                sessionId: payload.sessionId,
              }
            );
            return;
          }
          throw error;
        }
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Project actions are unavailable.",
      },
      { commandId }
    );
  }

  async projectReviewGet(
    commandId: string,
    payload: ProjectReviewGetCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.getProjectReviewDetail === "function") {
        const detail = await runtime.getProjectReviewDetail(payload);
        this.writer.emit("project.review", detail, {
          commandId,
          sessionId: detail.sessionId,
        });
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Project review is unavailable.",
      },
      { commandId }
    );
  }

  async projectReviewAction(
    commandId: string,
    payload: ProjectReviewActionCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.performProjectReviewAction === "function") {
        const detail = await runtime.performProjectReviewAction(payload);
        this.writer.emit("project.review", detail, {
          commandId,
          sessionId: detail.sessionId,
        });
        return;
      }
    }
    this.writer.emit(
      "runner.error",
      {
        code: "RUNNER_RUNTIME_ERROR",
        message: "Project review is unavailable.",
      },
      { commandId }
    );
  }

  async ping(
    commandId: string,
    payload: RunnerPingCommandPayload
  ): Promise<void> {
    this.writer.emit(
      "runner.pong",
      {
        ...(payload.nonce !== undefined ? { nonce: payload.nonce } : {}),
      },
      { commandId }
    );
  }

  async mcpStatus(
    commandId: string,
    payload: McpStatusCommandPayload
  ): Promise<void> {
    const profile = await this.resolveProfileOrThrow(payload, "mcp.status");
    const runtime = this.getRuntime(profile);
    const status =
      runtime.getToolRuntimeStatus !== undefined
        ? await runtime.getToolRuntimeStatus()
        : EMPTY_TOOL_RUNTIME_STATUS;

    this.writer.emit(
      "mcp.status",
      {
        status: getMcpStatusSnapshot(status),
      },
      { commandId }
    );
  }

  async mcpRefresh(
    commandId: string,
    payload: McpRefreshCommandPayload
  ): Promise<void> {
    const profile = await this.resolveProfileOrThrow(payload, "mcp.refresh");
    const runtime = this.getRuntime(profile);
    const status =
      runtime.refreshToolRuntime !== undefined
        ? await runtime.refreshToolRuntime()
        : runtime.getToolRuntimeStatus !== undefined
          ? await runtime.getToolRuntimeStatus()
          : EMPTY_TOOL_RUNTIME_STATUS;

    this.writer.emit(
      "mcp.refreshed",
      {
        status: getMcpStatusSnapshot(status),
      },
      { commandId }
    );
  }

  hasActiveExecutions(): boolean {
    return this.activeExecutions.size > 0;
  }

  executeCommand(operation: () => Promise<void>): Promise<void> {
    if (this.closing) {
      return Promise.reject(
        new Error("Runner host is closing and cannot accept new commands.")
      );
    }

    return this.trackExecution(this.withRuntimeUsage(operation));
  }

  close(options: { abortActiveRuns?: boolean | undefined } = {}): Promise<void> {
    this.closePromise ??= this.closeInternal(options);
    return this.closePromise;
  }

  private async closeInternal(options: {
    abortActiveRuns?: boolean | undefined;
  }): Promise<void> {
    this.closing = true;
    if (options.abortActiveRuns === true) {
      for (const active of this.activeRuns.values()) {
        active.cancelRequested = true;
        active.abortController.abort();
      }
    }
    await Promise.allSettled([...this.activeExecutions]);
    this.closeUnusedRetiredRuntimes(true);
    const currentLeases = new Set(
      [...this.runtimes.values()].map((entry) => entry.lease),
    );
    const closeResults = await Promise.allSettled(
      [...currentLeases].map(async (lease) => {
        lease.state = "closing";
        try {
          await lease.runtime.close();
        } finally {
          lease.state = "closed";
        }
      }),
    );
    await Promise.allSettled([...this.retiredRuntimeClosures]);
    const runtimeCloseFailure = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    const retiredRuntimeCloseFailure = this.retiredRuntimeCloseFailures[0];
    this.runtimes.clear();
    this.retiredRuntimes.clear();
    this.retiredRuntimeClosures.clear();
    this.retiredRuntimeCloseFailures.length = 0;
    this.commandBySession.clear();
    this.commandTypeBySession.clear();
    this.threadIdBySession.clear();
    if (runtimeCloseFailure !== undefined) {
      throw runtimeCloseFailure.reason;
    }
    if (retiredRuntimeCloseFailure !== undefined) {
      throw retiredRuntimeCloseFailure;
    }
  }

  private trackExecution(execution: Promise<void>): Promise<void> {
    const tracked = execution.finally(() => {
      this.activeExecutions.delete(tracked);
    });
    this.activeExecutions.add(tracked);
    return tracked;
  }

  private async withRuntimeUsage<T>(operation: () => Promise<T>): Promise<T> {
    if (this.runtimeUsage.getStore() !== undefined) {
      return await operation();
    }
    const leases = new Set<RuntimeLease>();
    return await this.runtimeUsage.run(leases, async () => {
      try {
        return await operation();
      } finally {
        for (const lease of leases) {
          this.releaseRuntime(lease);
        }
        leases.clear();
      }
    });
  }

  private registerRuntimeUsage(entry: RuntimeEntry): void {
    const leases = this.runtimeUsage.getStore();
    if (leases === undefined || leases.has(entry.lease)) {
      return;
    }
    leases.add(entry.lease);
    entry.lease.activeUsers += 1;
  }

  private releaseRuntime(lease: RuntimeLease): void {
    lease.activeUsers = Math.max(0, lease.activeUsers - 1);
    this.closeRetiredRuntimeIfUnused(lease);
  }

  private retireRuntime(entry: RuntimeEntry): void {
    const lease = entry.lease;
    lease.ownerCount = Math.max(0, lease.ownerCount - 1);
    if (lease.ownerCount > 0) {
      return;
    }
    lease.state = "retired";
    this.retiredRuntimes.add(lease);
    this.closeRetiredRuntimeIfUnused(lease);
  }

  private closeUnusedRetiredRuntimes(force = false): void {
    for (const lease of this.retiredRuntimes) {
      this.closeRetiredRuntimeIfUnused(lease, force);
    }
  }

  private closeRetiredRuntimeIfUnused(lease: RuntimeLease, force = false): void {
    if (
      lease.state !== "retired"
      || lease.ownerCount > 0
      || (force === false && lease.activeUsers > 0)
      || this.retiredRuntimes.delete(lease) === false
    ) {
      return;
    }
    lease.state = "closing";
    let closePromise: Promise<void>;
    try {
      closePromise = Promise.resolve(lease.runtime.close());
    } catch (error) {
      closePromise = Promise.reject(error);
    }
    const trackedClose = closePromise
      .catch((error: unknown) => {
        this.retiredRuntimeCloseFailures.push(error);
      })
      .finally(() => {
        lease.state = "closed";
        this.retiredRuntimeClosures.delete(trackedClose);
      });
    this.retiredRuntimeClosures.add(trackedClose);
  }

  private acquireRuntimeLease(runtime: RunnerRuntime): RuntimeLease {
    const existing = this.runtimeLeases.get(runtime);
    if (existing !== undefined) {
      if (existing.state === "closing" || existing.state === "closed") {
        throw new Error(
          "Runner runtime factory returned an instance that has already begun closing.",
        );
      }
      if (existing.state === "retired") {
        this.retiredRuntimes.delete(existing);
        existing.state = "active";
      }
      existing.ownerCount += 1;
      return existing;
    }

    const lease: RuntimeLease = {
      runtime,
      activeUsers: 0,
      ownerCount: 1,
      state: "active",
    };
    this.runtimeLeases.set(runtime, lease);
    return lease;
  }

  private assertAcceptingExecutions(): void {
    if (this.closing) {
      throw new Error("Runner host is closing and cannot accept new executions.");
    }
  }

  private getRuntime(profile: TuiProfile): RunnerRuntime {
    const key = JSON.stringify(profile);
    const existing = this.runtimes.get(profile.id);
    if (existing !== undefined && existing.key === key) {
      this.registerRuntimeUsage(existing);
      return existing.runtime;
    }

    if (existing !== undefined && this.hasActiveRunForProfile(profile.id)) {
      this.registerRuntimeUsage(existing);
      return existing.runtime;
    }

    const runtime = this.runtimeFactory(
      profile,
      (entry) => {
        this.onRunLog(entry);
      },
      (update) => {
        this.onProgress(update);
      },
      (update) => {
        this.onConsole(update);
      },
      (update) => {
        this.onReasoning(update);
      },
      (update) => {
        this.onTaskUpdate(update);
      },
      (event) => {
        this.onRunEvent(event);
      }
    );

    let entry: RuntimeEntry;
    if (existing !== undefined && existing.runtime === runtime) {
      existing.key = key;
      entry = existing;
    } else {
      const lease = this.acquireRuntimeLease(runtime);
      if (existing !== undefined) {
        this.retireRuntime(existing);
      }
      entry = {
        key,
        runtime,
        lease,
      };
    }
    this.runtimes.set(profile.id, entry);
    this.registerRuntimeUsage(entry);
    return entry.runtime;
  }

  private hasActiveRunForProfile(profileId: string): boolean {
    for (const active of this.activeRuns.values()) {
      if (active.profileId === profileId) {
        return true;
      }
    }
    return false;
  }

  private async cancelPersistedActiveRun(
    sessionId: string,
    metadata?: RunnerCommandMetadata | undefined
  ): Promise<string | undefined> {
    for (const runtime of this.selectRuntimes(metadata)) {
      const result = await runtime.cancelActiveRun?.(sessionId);
      if (result?.runId !== undefined) {
        return result.runId;
      }
    }
    return;
  }

  private selectRuntimes(metadata?: RunnerCommandMetadata): RunnerRuntime[] {
    const profile = metadata?.profile;
    if (profile !== undefined) {
      return [this.getRuntime(profile)];
    }
    const entries = [...this.runtimes.values()];
    for (const entry of entries) {
      this.registerRuntimeUsage(entry);
    }
    return entries.map((entry) => entry.runtime);
  }

  private async resolveProfileOrThrow(
    input: {
      profile?: TuiProfile | undefined;
      profileId?: string | undefined;
    },
    commandType: string
  ): Promise<TuiProfile> {
    if (input.profile !== undefined) {
      return input.profile;
    }
    if (input.profileId !== undefined) {
      const profile = await this.profileProvider.getProfile(input.profileId);
      if (profile !== undefined) {
        return profile;
      }
      throw new Error(
        `${commandType} profileId '${input.profileId}' was not found`
      );
    }
    throw new Error(`${commandType} requires profile or profileId`);
  }

  private onRunLog(entry: RunLogEntry): void {
    const normalizedEntry = this.normalizeActiveRunIdentity(entry);
    const commandId = this.commandBySession.get(normalizedEntry.sessionId);
    this.writer.emit(
      "run.log",
      { entry: normalizedEntry },
      {
        runId: normalizedEntry.runId,
        sessionId: normalizedEntry.sessionId,
        ...(commandId !== undefined ? { commandId } : {}),
      }
    );
  }

  private onProgress(update: ProgressUpdateV1): void {
    this.onRunEvent(buildPersistedRuntimeEventFromProgressUpdate(update));
  }

  private onRunEvent(event: RunEvent): void {
    const progress = readProgressUpdateFromPersistedRuntimeEvent(event);
    if (progress !== undefined) {
      this.emitProgressUpdate(progress);
    }
    const reasoning = readReasoningUpdateFromPersistedRuntimeEvent(event);
    if (reasoning !== undefined) {
      // Legacy persisted reasoning is intentionally no longer emitted.
    }
    const agentProgress = readAgentProgressUpdateFromPersistedRuntimeEvent(event);
    if (agentProgress !== undefined) this.emitAgentProgressUpdate(agentProgress);
    const tool = readToolUpdateFromPersistedRuntimeEvent(event);
    if (tool !== undefined) {
      this.emitToolUpdate(tool);
    }
  }

  private emitProgressUpdate(update: ProgressUpdateV1): void {
    const normalizedUpdate = this.normalizeActiveRunIdentity(update);
    const commandId = this.commandBySession.get(normalizedUpdate.sessionId);
    const commandType = this.commandTypeBySession.get(
      normalizedUpdate.sessionId
    );
    const threadId =
      this.threadIdBySession.get(normalizedUpdate.sessionId) ??
      normalizedUpdate.sessionId;
    this.writer.emit(
      "run.progress",
      { update: normalizedUpdate },
      {
        runId: normalizedUpdate.runId,
        sessionId: normalizedUpdate.sessionId,
        ...(commandId !== undefined ? { commandId } : {}),
      }
    );
    if (commandType === "job.run") {
      this.writer.emit(
        "job.progress",
        {
          sessionId: normalizedUpdate.sessionId,
          threadId,
          runId: normalizedUpdate.runId,
          stage: "runtime_progress",
          message: normalizedUpdate.message,
          update: normalizedUpdate,
        },
        {
          runId: normalizedUpdate.runId,
          sessionId: normalizedUpdate.sessionId,
          threadId,
          ...(commandId !== undefined ? { commandId } : {}),
        }
      );
    }
  }

  private onConsole(update: RunConsoleUpdateV1): void {
    const normalizedUpdate = this.normalizeActiveRunIdentity(update);
    const commandId = this.commandBySession.get(normalizedUpdate.sessionId);
    const threadId =
      this.threadIdBySession.get(normalizedUpdate.sessionId) ??
      normalizedUpdate.sessionId;
    this.writer.emit(
      "run.console",
      { update: normalizedUpdate },
      {
        runId: normalizedUpdate.runId,
        sessionId: normalizedUpdate.sessionId,
        threadId,
        ...(commandId !== undefined ? { commandId } : {}),
      }
    );
  }

  private emitToolUpdate(update: RunToolUpdateV1): void {
    const normalizedUpdate = this.normalizeActiveRunIdentity(update);
    const commandId = this.commandBySession.get(normalizedUpdate.sessionId);
    const threadId =
      this.threadIdBySession.get(normalizedUpdate.sessionId) ??
      normalizedUpdate.sessionId;
    const type =
      normalizedUpdate.phase === "started"
        ? "run.tool.started"
        : normalizedUpdate.phase === "completed"
          ? "run.tool.completed"
          : "run.tool.failed";
    this.writer.emit(
      type,
      { update: normalizedUpdate },
      {
        runId: normalizedUpdate.runId,
        sessionId: normalizedUpdate.sessionId,
        threadId,
        ...(commandId !== undefined ? { commandId } : {}),
      }
    );
  }

  private normalizeActiveRunIdentity<
    T extends { sessionId: string; runId: string },
  >(value: T): T {
    const acceptedRunId = this.activeRuns.get(value.sessionId)?.runId;
    if (acceptedRunId === undefined || acceptedRunId === value.runId) {
      return value;
    }
    return {
      ...value,
      runId: acceptedRunId,
    };
  }

  private async resolveThreadIdForSession(
    runtime: RunnerRuntime,
    sessionId: string,
    fallbackThreadId: string
  ): Promise<string> {
    const described = await runtime.describeSession?.(sessionId);
    if (described === undefined) {
      return fallbackThreadId;
    }
    if (
      typeof described.threadId === "string" &&
      described.threadId.length > 0
    ) {
      return described.threadId;
    }
    throw createRuntimeFailure(
      "RUNNER_THREAD_ID_UNAVAILABLE",
      `Session '${sessionId}' did not resolve a canonical thread ID.`,
      {
        sessionId,
      }
    );
  }

  private onReasoning(update: ReasoningUpdateV1 | ModelReasoningUpdateV1): void {
    if ("event" in update) this.emitModelReasoningUpdate(update);
  }

  private emitModelReasoningUpdate(update: ModelReasoningUpdateV1): void {
    const normalizedUpdate = this.normalizeActiveRunIdentity(update);
    const commandId = this.commandBySession.get(normalizedUpdate.sessionId);
    this.writer.emit(
      `run.model.reasoning.${normalizedUpdate.event}` as
        | "run.model.reasoning.started"
        | "run.model.reasoning.delta"
        | "run.model.reasoning.completed"
        | "run.model.reasoning.failed"
        | "run.model.reasoning.unavailable",
      { update: normalizedUpdate },
      {
        runId: normalizedUpdate.runId,
        sessionId: normalizedUpdate.sessionId,
        ...(commandId !== undefined ? { commandId } : {}),
        durability: "live_only",
      }
    );
  }

  private emitAgentProgressUpdate(update: AgentProgressUpdateV1): void {
    const normalizedUpdate = this.normalizeActiveRunIdentity(update);
    const commandId = this.commandBySession.get(normalizedUpdate.sessionId);
    this.writer.emit("run.agent_progress", { update: normalizedUpdate }, {
      runId: normalizedUpdate.runId,
      sessionId: normalizedUpdate.sessionId,
      ...(commandId !== undefined ? { commandId } : {}),
      durability: "durable",
    });
  }

  private onTaskUpdate(update: DelegationTaskUpdate): void {
    const commandId = this.commandBySession.get(update.task.parentSessionId);
    const threadId = this.threadIdBySession.get(update.task.parentSessionId);
    this.writer.emit(
      "task.updated",
      {
        task: update.task,
        kind: update.kind,
        assistantText: update.assistantText,
        ...(update.finalizedPayload !== undefined
          ? { finalizedPayload: update.finalizedPayload }
          : {}),
        ...(update.dialogMessage !== undefined
          ? { dialogMessage: update.dialogMessage }
          : {}),
      },
      {
        sessionId: update.task.parentSessionId,
        ...(threadId !== undefined ? { threadId } : {}),
        ...(commandId !== undefined ? { commandId } : {}),
      }
    );
  }

  private async appendTerminalHandoffDiagnostic(input: {
    scope: string;
    summary: string;
    sessionId: string;
    profileId: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.diagnosticsStore.append({
        scope: input.scope,
        summary: input.summary,
        sessionId: input.sessionId,
        profileId: input.profileId,
        cwd: process.cwd(),
        details: JSON.stringify(input.details, null, 2),
      });
    } catch {
      // Diagnostics must never change terminal handoff behavior.
    }
  }
}

function buildNonResponsiveTerminalResult(input: {
  status: "FAILED" | "CANCELLED";
  sessionId: string;
  runId: string;
  error?: { code: string; message: string; details?: Record<string, unknown> | undefined } | undefined;
}): RunTurnResult {
  return {
    assistantText: null,
    output: {
      status: "FAILED",
      sessionId: input.sessionId,
      runId: input.runId,
      quality: {
        citationCoverage: 0,
        unresolvedClaims: 0,
        reworkRate: 0,
        thrashIndex: 0,
      },
      errors: input.error === undefined
        ? []
        : [{
            code: input.error.code,
            message: input.error.message,
            ...(input.error.details !== undefined ? { details: input.error.details } : {}),
          }],
      telemetry: {
        stepsExecuted: 0,
        toolCalls: 0,
        modelCalls: 0,
        durationMs: 0,
      },
    },
  };
}

function isSessionVersionConflictError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === "string" &&
    (error as Error & { code: string }).code === "SESSION_VERSION_CONFLICT"
  );
}

function isProjectBoardConflictError(error: unknown): error is Error {
  if (
    !(error instanceof Error) ||
    typeof (error as Error & { code?: unknown }).code !== "string"
  ) {
    return false;
  }
  const code = (error as Error & { code: string }).code;
  return (
    code === "SESSION_VERSION_CONFLICT" ||
    code === "PROJECT_BOARD_VERSION_CONFLICT"
  );
}

export type { RunTurnResult };

function getMcpStatusSnapshot(status: ToolRuntimeStatus): McpStatusSnapshot {
  const providerStatus = status.providers.mcp;
  if (isMcpStatusSnapshot(providerStatus)) {
    return providerStatus;
  }

  return {
    healthy: status.healthy,
    checkedAt: status.checkedAt,
    servers: [],
    tools: [],
  };
}

function isMcpStatusSnapshot(value: unknown): value is McpStatusSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.healthy === "boolean" &&
    typeof record.checkedAt === "string" &&
    Array.isArray(record.servers) &&
    Array.isArray(record.tools)
  );
}

function resolveIssuedBy(
  metadata: RunnerCommandMetadata | undefined
): string | undefined {
  const actor = metadata?.actor;
  if (actor === undefined) {
    return;
  }
  const displayName = actor.displayName?.trim();
  if (displayName !== undefined && displayName.length > 0) {
    return displayName;
  }
  const actorId = actor.actorId.trim();
  return actorId.length > 0 ? actorId : undefined;
}

function createDefaultProfileProvider(): RunnerProfileProvider {
  const store = new ProfileStore(resolveKestrelHome());
  return {
    async listProfiles(): Promise<TuiProfile[]> {
      return store.load();
    },
    async getProfile(profileId: string): Promise<TuiProfile | undefined> {
      const profiles = await store.load();
      return store.findById(profiles, profileId);
    },
  };
}
