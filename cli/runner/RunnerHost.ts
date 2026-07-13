import {
  buildPersistedRuntimeEventFromProgressUpdate,
  buildPersistedRuntimeEventFromReasoningUpdate,
  readProgressUpdateFromPersistedRuntimeEvent,
  readReasoningUpdateFromPersistedRuntimeEvent,
  readToolUpdateFromPersistedRuntimeEvent,
} from "../../src/events/RuntimeEventProjections.js";
import type {
  McpStatusSnapshot,
  ProductProjectSnapshot,
  ProductReviewDetail,
  ProductTaskGraph,
  ProgressUpdateV1,
  ReasoningUpdateV1,
  RunConsoleUpdateV1,
  RunEvent,
  RunLogEntry,
  RunToolUpdateV1,
  ToolRuntimeStatus,
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointRecord,
  WorkspaceDiffRecord,
  WorkspacePromotionPreview,
  WorkspacePromotionRecord,
  WorkspaceRestoreRecord,
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
  onReasoning: (update: ReasoningUpdateV1) => void,
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
    "run.start" | "job.run"
  >();
  private readonly threadIdBySession = new Map<string, string>();
  private readonly activeRuns = new Map<string, ActiveRunEntry>();

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

  async runStart(
    commandId: string,
    payload: {
      profile?: TuiProfile | undefined;
      profileId?: string | undefined;
      turn: RunTurnInput;
    },
    metadata?: RunnerCommandMetadata | undefined
  ): Promise<void> {
    const profile = await this.resolveProfileOrThrow(payload, "run.start");
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
    this.commandBySession.set(turn.sessionId, commandId);
    this.commandTypeBySession.set(turn.sessionId, "run.start");
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
            result: terminalResult,
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

  async jobRun(
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
        code: "RUNNER_RUNTIME_ERROR",
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

  async operatorControl(
    commandId: string,
    payload: OperatorControlCommandPayload,
    metadata?: RunnerCommandMetadata
  ): Promise<void> {
    for (const runtime of this.selectRuntimes(metadata)) {
      if (typeof runtime.performOperatorAction === "function") {
        const issuedBy = resolveIssuedBy(metadata);
        const result = await runtime.performOperatorAction({
          ...payload,
          ...(issuedBy !== undefined ? { issuedBy } : {}),
        });
        this.writer.emit("operator.controlled", result, {
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

  async close(
    options: { abortActiveRuns?: boolean | undefined } = {}
  ): Promise<void> {
    if (options.abortActiveRuns === true) {
      for (const active of this.activeRuns.values()) {
        active.cancelRequested = true;
        active.abortController.abort();
      }
    }
    const closeAll = [...this.runtimes.values()].map((entry) =>
      entry.runtime.close()
    );
    await Promise.all(closeAll);
    this.runtimes.clear();
    this.commandBySession.clear();
    this.commandTypeBySession.clear();
    this.threadIdBySession.clear();
  }

  private getRuntime(profile: TuiProfile): RunnerRuntime {
    const key = JSON.stringify(profile);
    const existing = this.runtimes.get(profile.id);
    if (existing !== undefined && existing.key === key) {
      return existing.runtime;
    }

    if (existing !== undefined && this.hasActiveRunForProfile(profile.id)) {
      return existing.runtime;
    }

    if (existing !== undefined) {
      void existing.runtime.close();
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

    this.runtimes.set(profile.id, { key, runtime });
    return runtime;
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
    return [...this.runtimes.values()].map((entry) => entry.runtime);
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
      this.emitReasoningUpdate(reasoning);
    }
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

  private onReasoning(update: ReasoningUpdateV1): void {
    this.onRunEvent(buildPersistedRuntimeEventFromReasoningUpdate(update));
  }

  private emitReasoningUpdate(update: ReasoningUpdateV1): void {
    const normalizedUpdate = this.normalizeActiveRunIdentity(update);
    const commandId = this.commandBySession.get(normalizedUpdate.sessionId);
    this.writer.emit(
      "run.reasoning",
      { update: normalizedUpdate },
      {
        runId: normalizedUpdate.runId,
        sessionId: normalizedUpdate.sessionId,
        ...(commandId !== undefined ? { commandId } : {}),
      }
    );
  }

  private onTaskUpdate(update: DelegationTaskUpdate): void {
    this.writer.emit(
      "task.updated",
      {
        task: update.task,
        kind: update.kind,
        ...(update.finalizedPayload !== undefined
          ? { finalizedPayload: update.finalizedPayload }
          : {}),
      },
      {
        sessionId: update.task.parentSessionId,
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
