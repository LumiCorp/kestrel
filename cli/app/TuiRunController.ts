import { parseFinalizePayload } from "../output/FinalizePayload.js";
import type {
  AgentRunLogLine,
  DelegationTaskMeta,
  TranscriptLine,
  ResolvedWorkspace,
  TuiProfile,
  TuiSessionMeta,
} from "../contracts.js";
import type { RunnerEvent } from "../protocol/contracts.js";
import {
  applySkillPackToProfile,
  getSkillPackById,
} from "../runtime/skillPacks.js";
import {
  buildWaitingSystemText,
  extractWaitPrompt,
} from "./waitForPrompt.js";
import type { TuiAppContext } from "./TuiAppContext.js";
import { toCoreExecutionProfile } from "../client/coreExecutionProfile.js";
import {
  createTuiClientCapabilities,
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  normalizeInteractionMode,
  AGENT_STEP_IDS,
  type NormalizedOutput,
  type ProgressUpdateV1,
  type ReasoningUpdateV1,
} from "../../src/index.js";
import { buildModelHistoryWindow } from "../../src/runtime/submittedHistory.js";

export interface StartActiveTurnInput {
  submittedMessage: string;
  modelHistoryMessage?: string | undefined;
  resumeBlockedRun?: boolean | undefined;
  forceFreshTurn?: boolean | undefined;
  checkpointRecoveryAttempted?: boolean | undefined;
}

export interface TuiRunControllerContext extends TuiAppContext {
  refreshWorkspaceForActiveSession(): Promise<ResolvedWorkspace | undefined>;
  shouldApplyCompactionOnContinuationResume(session: TuiSessionMeta): boolean;
  buildSessionOperatorState(input: {
    session: TuiSessionMeta;
    profile: TuiProfile;
    runtime?: TuiSessionMeta["operatorState"] | undefined;
  }): NonNullable<TuiSessionMeta["operatorState"]>;
  appendDiagnosticsLog(input: {
    scope: string;
    summary: string;
    details?: string | undefined;
  }): Promise<void>;
  handleTaskUpdatedEvent(
    task: DelegationTaskMeta,
    kind: "spawned" | "waiting" | "completed" | "failed",
    assistantText: string | null,
    finalizedPayload: unknown | undefined,
  ): Promise<void>;
  syncBackgroundSessionProgress(sessionId: string): Promise<void>;
  syncBackgroundSessionResult(
    output: NormalizedOutput,
    assistantText: string | null,
    finalizedPayload: unknown | undefined,
    operatorState?: TuiSessionMeta["operatorState"] | undefined,
  ): Promise<void>;
  syncBackgroundSessionFailure(sessionId: string, message: string): Promise<void>;
  clearProgressForRun(runId: string): void;
  pushRunLog(line: AgentRunLogLine): void;
  enqueueReasoningTranscriptUpdate(update: ReasoningUpdateV1): void;
}

export class TuiRunController {
  private readonly context: TuiRunControllerContext;

  constructor(context: TuiRunControllerContext) {
    this.context = context;
  }

  async cancelActiveRun(): Promise<void> {
    const state = this.context.uiStore.getState();
    const cancelled = await this.context.client.sendCommand("run.cancel", {
      sessionId: state.activeSession.sessionId,
    }, this.context.getActiveRunnerMetadata());
    if (cancelled.type !== "run.cancelled") {
      throw new Error(`Unexpected run cancellation response '${cancelled.type}'`);
    }
  }

  async startActiveTurn(input: StartActiveTurnInput): Promise<void> {
    const state = this.context.uiStore.getState();
    const submittedPendingWait = state.activeSession.pendingWaitFor;
    const pendingWait = input.forceFreshTurn === true ? undefined : submittedPendingWait;
    const eventType = pendingWait?.eventType ?? "user.message";
    const stepAgent = pendingWait !== undefined ? undefined : getEntryStepAgent(state.activeProfile);
    const activeSkillPack = getSkillPackById(state.activeSession.activeSkillPackId);
    const effectiveProfile = toCoreExecutionProfile(
      applySkillPackToProfile(state.activeProfile, activeSkillPack),
    );
    const workspace = await this.context.refreshWorkspaceForActiveSession();
    const baseHistorySource =
      pendingWait !== undefined
        ? state.transcript.filter((line) =>
            line.role !== "system" || isRuntimeWaitingPromptHistoryLine(line)
          )
        : state.transcript;
    const historySource =
      input.modelHistoryMessage !== undefined
        ? replaceLatestUserHistoryLine(baseHistorySource, input.modelHistoryMessage)
        : baseHistorySource;
    const modeResolution = normalizeInteractionMode({
      interactionMode: state.activeSession.interactionMode ?? state.activeProfile.defaultInteractionMode,
      actSubmode: state.activeSession.actSubmode ?? state.activeProfile.defaultActSubmode,
      defaultInteractionMode: state.activeProfile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
      defaultActSubmode: state.activeProfile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
    });
    const manualCompaction =
      state.activeSession.pendingManualCompaction === true ||
      (
        pendingWait !== undefined &&
        this.context.shouldApplyCompactionOnContinuationResume(state.activeSession)
      );
    if (submittedPendingWait !== undefined) {
      await this.context.setActiveSessionState({
        pendingWaitFor: undefined,
        updatedAt: new Date().toISOString(),
      });
    }

    this.context.uiStore.patch({
      running: true,
      statusLine: this.context.withMcpSummary(`running (${eventType})`),
      runLogs: [],
      chatHighlightRunId: undefined,
      quitConfirm: false,
      errorOverlay: undefined,
      errorScrollOffset: 0,
      activeProgressByRun: {},
      latestProgressForSession: undefined,
      latestReasoningForSession: undefined,
    });

    let terminalResponseMeta: Record<string, unknown> | undefined;
    let requestAccepted = false;

    try {
      const response = await this.context.client.sendCommand("run.start", {
        profile: effectiveProfile,
        turn: {
          sessionId: state.activeSession.sessionId,
          message: input.submittedMessage,
          eventType,
          ...(input.resumeBlockedRun === true ? { resumeBlockedRun: true } : {}),
          modeSystemV2Enabled: state.activeProfile.modeSystemV2Enabled === true,
          interactionMode: modeResolution.interactionMode,
          ...(modeResolution.actSubmode !== undefined ? { actSubmode: modeResolution.actSubmode } : {}),
          ...(state.activeSession.executionPolicy !== undefined
            ? { executionPolicy: state.activeSession.executionPolicy }
            : {}),
          clientCapabilities: createTuiClientCapabilities(),
          history: buildModelHistoryWindow(historySource),
          ...(manualCompaction ? { manualCompaction: true } : {}),
          autoCompaction: {
            enabled: state.activeSession.autoCompactionEnabled === true,
            state: state.activeSession.operatorState?.context?.compactionState ?? "idle",
            suppressOnce: state.activeSession.suppressAutoCompactionOnce === true,
          },
          ...(workspace !== undefined ? { workspace: workspace.runtimeContext } : {}),
          ...(activeSkillPack !== undefined ? { skillPack: activeSkillPack } : {}),
          ...(stepAgent !== undefined ? { stepAgent } : {}),
        },
      });
      requestAccepted = true;

      if (response.type !== "run.completed" && response.type !== "run.failed") {
        throw new Error(`Unexpected run response type '${response.type}'`);
      }

      terminalResponseMeta = {
        responseType: response.type,
        commandId: response.commandId,
        runId: response.payload.result?.output.runId,
        status: response.payload.result?.output.status,
        finalizedPayloadPresent: response.payload.result?.finalizedPayload !== undefined,
      };
      await this.appendTerminalHandoffDiagnostics({
        scope: "terminal_handoff.tui_response_received",
        summary: "TUI received terminal response for the active run.",
        details: terminalResponseMeta,
      });

      if (response.type === "run.failed") {
        const result = response.payload.result;
        const failure = resolveRunFailureSummary(response.payload);
        const recovery = await this.tryRecoverContextCheckpoint({
          failure,
          details: response.payload.error.details,
          input,
          submittedPendingWait,
        });
        if (recovery.recovered) {
          return;
        }
        const runFailedLine =
          failure.message === undefined
            ? `Run failed: ${failure.code}`
            : `Run failed: ${failure.code} ${failure.message}`;
        await this.context.appendHistoryLine("system", runFailedLine, undefined, result?.output);
        await this.appendRunFailureDiagnostics(
          result?.output.errors[0] ?? {
            code: failure.code,
            ...(failure.message !== undefined ? { message: failure.message } : {}),
          },
        );
        await this.context.setActiveSessionState({
          started: true,
          updatedAt: new Date().toISOString(),
          pendingWaitFor: undefined,
          lastRunStatus: "FAILED",
          pendingManualCompaction: false,
          suppressAutoCompactionOnce: false,
        });
        this.context.uiStore.patch({
          running: false,
          statusLine: this.context.withMcpSummary("failed"),
          activeProgressByRun: {},
          latestProgressForSession: undefined,
          latestReasoningForSession: undefined,
          errorOverlay: {
            message: failure.message ?? "Run failed",
            code: failure.code,
            details: {
              ...(asRecord(response.payload.error.details) ?? {}),
              ...(asRecord(result?.output.errors[0]?.details) ?? {}),
              ...(recovery.error !== undefined ? { checkpointRecoveryError: formatDiagnosticError(recovery.error) } : {}),
            },
          },
          errorScrollOffset: 0,
        });
        await this.context.persistSessionAndUi();
        await this.appendTerminalHandoffDiagnostics({
          scope: "terminal_handoff.persist_completed",
          summary: "TUI persisted failed terminal state for the active run.",
          details: {
            ...(terminalResponseMeta ?? {}),
            branch: "run.failed",
          },
        });
        return;
      }

      const output = response.payload.result.output;
      await this.context.setActiveSessionState({
        started: true,
        updatedAt: new Date().toISOString(),
        pendingWaitFor: output.status === "WAITING" ? output.waitFor : undefined,
        lastRunStatus: output.status,
        pendingManualCompaction: false,
        suppressAutoCompactionOnce: false,
        operatorState: this.context.buildSessionOperatorState({
          session: state.activeSession,
          profile: state.activeProfile,
          runtime: response.payload.result.operatorAffordance,
        }),
      });

      if (output.continuation?.outcome === "granted") {
        const extraStepsGranted = output.continuation.extraStepsGranted;
        const grantMessage =
          typeof extraStepsGranted === "number"
            ? `Granted ${extraStepsGranted} more steps. Resuming run.`
            : "Granted more steps. Resuming run.";
        await this.context.appendHistoryLine("system", grantMessage);
      }

      if (output.status === "WAITING") {
        const waitEvent = output.waitFor?.eventType ?? "unknown";
        const waitPrompt = extractWaitPrompt(output.waitFor);
        const shouldAppendWaitLine = isSameWaitFor(pendingWait, output.waitFor) === false;
        if (shouldAppendWaitLine) {
          const waitLineData = {
            waitEventType: waitEvent,
            ...(waitPrompt === undefined
              ? {}
              : {
                  kind: "runtime.waiting_prompt" as const,
                  runId: output.runId,
                  prompt: waitPrompt,
                }),
          };
          await this.context.appendHistoryLine(
            "system",
            buildWaitingSystemText(output.waitFor),
            waitLineData,
            output,
          );
        }
        this.context.uiStore.patch({
          running: false,
          statusLine: this.context.withMcpSummary(`waiting (${waitEvent})`),
          activeProgressByRun: {},
          latestProgressForSession: undefined,
          latestReasoningForSession: undefined,
        });
        await this.context.persistSessionAndUi();
        await this.appendTerminalHandoffDiagnostics({
          scope: "terminal_handoff.persist_completed",
          summary: "TUI persisted waiting terminal state for the active run.",
          details: {
            ...(terminalResponseMeta ?? {}),
            branch: "waiting",
            waitEvent,
          },
        });
        return;
      }

      if (output.status === "FAILED") {
        const summary = output.errors[0];
        await this.context.appendHistoryLine(
          "system",
          `Run failed: ${summary?.code ?? "UNKNOWN"} ${summary?.message ?? ""}`.trim(),
          undefined,
          output,
        );
        await this.appendRunFailureDiagnostics(summary);
        this.context.uiStore.patch({
          running: false,
          statusLine: this.context.withMcpSummary("failed"),
          activeProgressByRun: {},
          latestProgressForSession: undefined,
          latestReasoningForSession: undefined,
          errorOverlay: {
            message: summary?.message ?? "Run failed",
            code: summary?.code,
            details: asRecord(summary?.details),
          },
          errorScrollOffset: 0,
        });
        await this.context.persistSessionAndUi();
        await this.appendTerminalHandoffDiagnostics({
          scope: "terminal_handoff.persist_completed",
          summary: "TUI persisted failed output state for the active run.",
          details: {
            ...(terminalResponseMeta ?? {}),
            branch: "output_failed",
            errorCode: summary?.code,
          },
        });
        return;
      }

      const parsedFinalize = parseFinalizePayload(response.payload.result.finalizedPayload);
      const assistantText = response.payload.result.assistantText;
      if (assistantText !== null) {
        const structuredData = parsedFinalize.ok && parsedFinalize.payload !== undefined
          ? parsedFinalize.payload.data
          : undefined;
        await this.context.appendHistoryLine(
          "assistant",
          assistantText,
          structuredData,
          output,
        );
        const reportingGroundingNotice = structuredData === undefined
          ? undefined
          : buildFinalizeReportingGroundingNotice(structuredData);
        if (reportingGroundingNotice !== undefined) {
          await this.context.appendHistoryLine("system", reportingGroundingNotice, undefined, output);
        }
        await this.appendTerminalHandoffDiagnostics({
          scope: "terminal_handoff.final_message_appended",
          summary: "TUI appended the finalized assistant message for the active run.",
          details: {
            ...(terminalResponseMeta ?? {}),
            branch: "assistant_message",
            messageLength: assistantText.length,
          },
        });
      }

      this.context.uiStore.patch({
        running: false,
        statusLine: this.context.withMcpSummary("completed"),
        activeProgressByRun: {},
        latestProgressForSession: undefined,
        latestReasoningForSession: undefined,
      });
      await this.context.persistSessionAndUi();
      await this.appendTerminalHandoffDiagnostics({
        scope: "terminal_handoff.persist_completed",
        summary: "TUI persisted completed terminal state for the active run.",
        details: {
          ...(terminalResponseMeta ?? {}),
          branch: "completed",
        },
      });
    } catch (error) {
      if (terminalResponseMeta !== undefined) {
        await this.appendTerminalHandoffDiagnostics({
          scope: "terminal_handoff.processing_failed",
          summary: "TUI failed while processing a terminal response for the active run.",
          details: {
            ...terminalResponseMeta,
            error: formatDiagnosticError(error),
          },
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.context.appendHistoryLine("system", `Runner communication failed: ${message}`);
      await this.context.setActiveSessionState({
        started: true,
        updatedAt: new Date().toISOString(),
        ...(input.forceFreshTurn !== true && submittedPendingWait !== undefined && requestAccepted === false
          ? { pendingWaitFor: submittedPendingWait }
          : {}),
        lastRunStatus: "FAILED",
        pendingManualCompaction: false,
      });
      this.context.uiStore.patch({
        running: false,
        statusLine: this.context.withMcpSummary("failed"),
        activeProgressByRun: {},
        latestProgressForSession: undefined,
        latestReasoningForSession: undefined,
        errorOverlay: {
          message,
          code: "RUNNER_RUNTIME_ERROR",
        },
        errorScrollOffset: 0,
      });
      await this.context.persistSessionAndUi();
    }
  }

  private async tryRecoverContextCheckpoint(input: {
    failure: { code: string; message?: string | undefined };
    details?: Record<string, unknown> | undefined;
    input: StartActiveTurnInput;
    submittedPendingWait: TuiSessionMeta["pendingWaitFor"];
  }): Promise<{ recovered: true } | { recovered: false; error?: unknown | undefined }> {
    if (input.failure.code !== "CONTEXT_CHECKPOINT_PENDING" || input.input.checkpointRecoveryAttempted === true) {
      return { recovered: false };
    }
    const details = asRecord(input.details);
    const threadId = readNonEmptyText(details?.threadId);
    const checkpointId = readNonEmptyText(details?.checkpointId);
    const recommendedAction = readNonEmptyText(details?.recommendedAction);
    if (
      threadId === undefined ||
      checkpointId === undefined ||
      (recommendedAction !== "compact" && recommendedAction !== "summarize_forward")
    ) {
      return { recovered: false };
    }

    try {
      const response = await this.context.client.sendCommand("operator.control", {
        action: "resolve_context_checkpoint",
        threadId,
        checkpointId,
        actionValue: recommendedAction,
      }, this.context.getActiveRunnerMetadata());
      if (response.type !== "operator.controlled") {
        throw new Error(`Unexpected operator checkpoint recovery response '${response.type}'`);
      }
      await this.context.appendHistoryLine(
        "system",
        recommendedAction === "compact"
          ? "Compacted context and continued."
          : "Summarized context forward and continued.",
      );
      if (input.input.forceFreshTurn !== true && input.submittedPendingWait !== undefined) {
        await this.context.setActiveSessionState({
          pendingWaitFor: input.submittedPendingWait,
          updatedAt: new Date().toISOString(),
        });
      }
      await this.startActiveTurn({
        ...input.input,
        checkpointRecoveryAttempted: true,
      });
      return { recovered: true };
    } catch (error) {
      await this.appendTerminalHandoffDiagnostics({
        scope: "terminal_handoff.context_checkpoint_recovery_failed",
        summary: "TUI failed to recover a pending context checkpoint.",
        details: {
          threadId,
          checkpointId,
          recommendedAction,
          error: formatDiagnosticError(error),
        },
      });
      return { recovered: false, error };
    }
  }

  onRunnerEvent(event: RunnerEvent): void {
    if (event.type === "runner.error" && event.commandId === undefined) {
      const state = this.context.uiStore.getState();
      const diagnosticsLog = this.context.diagnosticsStore.getDisplayPath();
      void this.context.appendDiagnosticsLog({
        scope: "runner.unhandled",
        summary: event.payload.message,
        details: stringifyDiagnosticDetails({
          code: event.payload.code,
          message: event.payload.message,
          details: event.payload.details,
        }),
      });
      const line: TranscriptLine = {
        role: "system",
        text: `Runner error: ${event.payload.message}`,
        timestamp: new Date().toISOString(),
      };
      this.context.uiStore.patch({
        transcript: [
          ...state.transcript,
          line,
        ].slice(-400),
        statusLine: this.context.withMcpSummary("failed"),
        running: false,
        activeProgressByRun: {},
        latestProgressForSession: undefined,
        latestReasoningForSession: undefined,
        errorOverlay: {
          message: event.payload.message,
          code: event.payload.code,
          details: {
            ...(asRecord(event.payload.details) ?? {}),
            diagnosticsLog,
          },
        },
        errorScrollOffset: 0,
      });
      return;
    }

    if (event.type === "task.updated") {
      void this.context.handleTaskUpdatedEvent(
        event.payload.task,
        event.payload.kind,
        event.payload.assistantText,
        event.payload.finalizedPayload,
      );
      this.context.pushRunLog({
        timestamp: new Date().toISOString(),
        level: event.payload.kind === "failed" ? "ERROR" : "INFO",
        eventName: `task_${event.payload.kind}`,
        metadata: {
          taskId: event.payload.task.taskId,
          childSessionId: event.payload.task.childSessionId,
          parentSessionId: event.payload.task.parentSessionId,
          status: event.payload.task.status,
        },
      });
      return;
    }

    if (event.type === "run.completed") {
      const output = event.payload.result.output;
      void this.appendTerminalHandoffDiagnostics({
        scope: "terminal_handoff.event_received_completed",
        summary: "TUI event stream received run.completed.",
        details: {
          commandId: event.commandId,
          sessionId: output.sessionId,
          runId: output.runId,
          status: output.status,
          finalizedPayloadPresent: event.payload.result.finalizedPayload !== undefined,
        },
      });
      void this.context.syncBackgroundSessionResult(
        output,
        event.payload.result.assistantText,
        event.payload.result.finalizedPayload,
        event.payload.result.operatorAffordance,
      );
      this.context.clearProgressForRun(output.runId);
      this.context.pushRunLog({
        timestamp: new Date().toISOString(),
        level: "INFO",
        eventName: "run_completed",
        runId: output.runId,
        metadata: {
          status: output.status,
          finalStep: output.finalStep,
          waitFor: output.waitFor,
          checkpoint: output.checkpoint,
          quality: output.quality,
        },
      });
      return;
    }

    if (event.type === "run.failed") {
      void this.appendTerminalHandoffDiagnostics({
        scope: "terminal_handoff.event_received_failed",
        summary: "TUI event stream received run.failed.",
        details: {
          commandId: event.commandId,
          sessionId: event.payload.result?.output.sessionId,
          runId: event.payload.result?.output.runId ?? event.runId,
          errorCode: event.payload.error.code,
          errorMessage: event.payload.error.message,
        },
      });
      if (event.payload.result !== undefined) {
        void this.context.syncBackgroundSessionFailure(
          event.payload.result.output.sessionId,
          event.payload.error.message,
        );
        this.context.clearProgressForRun(event.payload.result.output.runId);
      } else if (event.runId !== undefined) {
        this.context.clearProgressForRun(event.runId);
      }
      this.context.pushRunLog({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        eventName: "run_failed",
        metadata: {
          message: event.payload.error.message,
          ...(event.payload.result !== undefined
            ? {
                quality: event.payload.result.output.quality,
                finalStep: event.payload.result.output.finalStep,
                runId: event.payload.result.output.runId,
              }
            : {}),
        },
      });
      return;
    }

    if (event.type === "run.progress") {
      const update = event.payload.update;
      void this.context.syncBackgroundSessionProgress(update.sessionId);
      const state = this.context.uiStore.getState();
      this.context.uiStore.patch({
        activeProgressByRun: {
          ...state.activeProgressByRun,
          [update.runId]: update,
        },
        latestProgressForSession:
          state.activeSession.sessionId === update.sessionId
            ? update
            : state.latestProgressForSession,
      });
      this.context.pushRunLog({
        timestamp: new Date().toISOString(),
        level: update.code.endsWith("FAILED") ? "ERROR" : "INFO",
        eventName: `progress_${update.kind}`,
        runId: update.runId,
        ...(update.stepIndex !== undefined ? { stepIndex: update.stepIndex } : {}),
        metadata: {
          phase: update.phase,
          code: update.code,
          message: update.message,
          seq: update.seq,
          ...(update.tool !== undefined ? { tool: update.tool } : {}),
          ...(update.waitFor !== undefined ? { waitFor: update.waitFor } : {}),
          ...(update.queueDepthRun !== undefined ? { queueDepthRun: update.queueDepthRun } : {}),
          ...(update.queueDepthGlobal !== undefined
            ? { queueDepthGlobal: update.queueDepthGlobal }
            : {}),
          ...(update.queueWaitMs !== undefined ? { queueWaitMs: update.queueWaitMs } : {}),
          ...(update.chunkIndex !== undefined ? { chunkIndex: update.chunkIndex } : {}),
          ...(update.chunkSize !== undefined ? { chunkSize: update.chunkSize } : {}),
          ...(update.progress !== undefined ? { progress: update.progress } : {}),
        },
      });
      return;
    }

    if (event.type === "run.reasoning") {
      const update = event.payload.update;
      const state = this.context.uiStore.getState();
      this.context.uiStore.patch({
        latestReasoningForSession:
          state.activeSession.sessionId === update.sessionId
            ? update
            : state.latestReasoningForSession,
      });
      this.context.pushRunLog({
        timestamp: new Date().toISOString(),
        level: "INFO",
        eventName: "reasoning_update",
        runId: update.runId,
        ...(update.stepIndex !== undefined ? { stepIndex: update.stepIndex } : {}),
        metadata: {
          message: update.message,
          milestone: update.milestone,
          seq: update.seq,
          ...(update.stepAgent !== undefined ? { stepAgent: update.stepAgent } : {}),
          ...(update.model !== undefined ? { model: update.model } : {}),
        },
      });
      this.context.enqueueReasoningTranscriptUpdate(update);
      return;
    }

    if (event.type !== "run.log") {
      return;
    }

    const entry = event.payload.entry;
    this.context.pushRunLog({
      timestamp: new Date().toISOString(),
      level: entry.level,
      eventName: entry.eventName,
      runId: entry.runId,
      ...(entry.stepIndex !== undefined ? { stepIndex: entry.stepIndex } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    });
  }

  async appendRunFailureDiagnostics(
    error: {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    } | undefined,
  ): Promise<void> {
    if (error?.code !== "IO_MODEL_TIMEOUT") {
      return;
    }

    const detailRecord = asRecord(error.details);
    const detailLines = [
      `code: ${String(error.code)}`,
      `message: ${typeof error.message === "string" ? error.message : "Model call timed out."}`,
      ...(detailRecord !== undefined ? ["details:", JSON.stringify(detailRecord, null, 2)] : []),
    ];
    await this.context.appendDiagnosticsLog({
      scope: "runtime.timeout",
      summary: "Model timeout surfaced in the TUI",
      details: detailLines.join("\n"),
    });
  }

  async appendTerminalHandoffDiagnostics(input: {
    scope: string;
    summary: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    await this.context.appendDiagnosticsLog({
      scope: input.scope,
      summary: input.summary,
      details: JSON.stringify(input.details, null, 2),
    });
  }
}

function getEntryStepAgent(profile: TuiProfile): string {
  if (profile.agent === "reference-react") {
    return AGENT_STEP_IDS.loop;
  }

  throw new Error(`Unsupported profile agent '${profile.agent}'`);
}

export function resolveRunFailureSummary(payload: {
  result?:
    | {
        output?: {
          errors?: Array<{
            code?: unknown;
            message?: unknown;
          }>;
        };
      }
    | undefined;
  error?: {
    code?: unknown;
    message?: unknown;
  } | undefined;
}): {
  code: string;
  message?: string | undefined;
} {
  const primary = payload.result?.output?.errors?.[0];
  const code =
    readNonEmptyText(primary?.code) ??
    readNonEmptyText(payload.error?.code) ??
    "RUN_FAILED";
  const message =
    readNonEmptyText(primary?.message) ??
    readNonEmptyText(payload.error?.message);

  return {
    code,
    ...(message !== undefined ? { message } : {}),
  };
}

function readNonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function replaceLatestUserHistoryLine(
  lines: TranscriptLine[],
  text: string,
): TranscriptLine[] {
  let latestUserIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex === -1) {
    return lines;
  }
  return lines.map((line, index) =>
    index === latestUserIndex
      ? {
          ...line,
          text,
        }
      : line,
  );
}

function isSameWaitFor(
  left: Exclude<NormalizedOutput["waitFor"], undefined> | undefined,
  right: Exclude<NormalizedOutput["waitFor"], undefined> | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  if (left.eventType !== right.eventType) {
    return false;
  }

  const leftPrompt = extractWaitPrompt(left);
  const rightPrompt = extractWaitPrompt(right);
  return leftPrompt === rightPrompt;
}

const FINALIZE_REPORTING_GROUNDING_FIELDS = [
  "summary",
  "blockers",
  "residualRisks",
  "completionState",
] as const;

type FinalizeReportingGroundingLabel = "model_authored" | "runtime_linked" | "inferred_from_workplan";

function buildFinalizeReportingGroundingNotice(
  data: Record<string, unknown> | undefined,
): string | undefined {
  const reportingGrounding = asRecord(data?.reportingGrounding);
  if (reportingGrounding === undefined) {
    return undefined;
  }
  const labeledFields = FINALIZE_REPORTING_GROUNDING_FIELDS
    .map((field) => {
      const label = asReportingGroundingLabel(reportingGrounding[field]);
      return label === undefined ? undefined : `${field}=${label}`;
    })
    .filter((entry): entry is string => entry !== undefined);
  if (labeledFields.length === 0) {
    return undefined;
  }
  return [
    `Finalize provenance: ${labeledFields.join(", ")}.`,
    "Fields labeled model_authored are narrative and not runtime-verified facts.",
  ].join(" ");
}

function asReportingGroundingLabel(value: unknown): FinalizeReportingGroundingLabel | undefined {
  return value === "model_authored" || value === "runtime_linked" || value === "inferred_from_workplan"
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function isRuntimeWaitingPromptHistoryLine(line: TranscriptLine): boolean {
  return line.role === "system" && asRecord(line.data)?.kind === "runtime.waiting_prompt";
}

function stringifyDiagnosticDetails(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDiagnosticError(error: unknown): string | undefined {
  if (error === undefined) {
    return undefined;
  }
  if (error instanceof Error) {
    const diagnostics = asRunnerExitDiagnostics(error);
    if (diagnostics !== undefined) {
      return [
        error.stack ?? error.message,
        "",
        "runner diagnostics:",
        ...(diagnostics.lastProcessError !== undefined
          ? [`lastProcessError: ${diagnostics.lastProcessError}`]
          : []),
        ...diagnostics.recentStderr.map((line) => `stderr: ${line}`),
      ].join("\n");
    }
    return error.stack ?? error.message;
  }
  return String(error);
}

function asRunnerExitDiagnostics(
  error: Error,
): { lastProcessError?: string | undefined; recentStderr: string[] } | undefined {
  const candidate = (error as Error & {
    runnerExitDiagnostics?: { lastProcessError?: string | undefined; recentStderr?: unknown };
  }).runnerExitDiagnostics;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const recentStderr = Array.isArray(candidate.recentStderr)
    ? candidate.recentStderr.filter((line): line is string => typeof line === "string")
    : [];
  return {
    ...(typeof candidate.lastProcessError === "string"
      ? { lastProcessError: candidate.lastProcessError }
      : {}),
    recentStderr,
  };
}
