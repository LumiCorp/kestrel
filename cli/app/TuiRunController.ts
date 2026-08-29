import type {
  AgentRunLogLine,
  DelegationTaskMeta,
  TranscriptLine,
  ResolvedWorkspace,
  TuiProfile,
  TuiSessionMeta,
} from "../contracts.js";
import type { RunnerEvent, SessionDescribedEventPayload } from "../protocol/contracts.js";
import { randomUUID } from "node:crypto";
import {
  buildWaitingSystemText,
  extractWaitPrompt,
  readExactReview,
  resolveExactReviewOptionId,
} from "./waitForPrompt.js";
import type { TuiAppContext } from "./TuiAppContext.js";
import {
  createTuiClientCapabilities,
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  normalizeInteractionMode,
  AGENT_STEP_IDS,
  type NormalizedOutput,
} from "../../src/index.js";
import { buildModelHistoryWindow } from "../../src/runtime/submittedHistory.js";
import type { OperatorThreadView } from "../../src/orchestration/contracts.js";
import {
  adaptTuiConversation,
  createTuiConversationCommandAdapter,
  projectTuiTranscript,
  resolveTuiComposerPolicy,
  reduceTuiConversationActivity,
} from "./TuiConversationAdapter.js";
import {
  createModeSwitchRetryGuard,
  type ConversationActivityItem,
  type ConversationMode,
} from "@kestrel-agents/conversation";
import {
  buildChatVisualRows,
  ensureChatCursorVisible,
  resolveChatVisualAnchor,
  resolveChatVisualCursorFromAnchor,
} from "../ink/views/chatRows.js";
import {
  readTuiEnvironmentIdentityFailure,
  readAuthoritativeRunStartRejection,
  resolveTuiSessionEnvironment,
  toResolvedSessionIdentity,
  TuiEnvironmentIdentityError,
  type TuiEnvironmentPresetId,
} from "../session/TuiExecutionEnvironment.js";
import {
  advanceTuiQueueAuthority,
  bindTuiQueueSuccessor,
  exactTuiQueueTailRunId,
  normalizeTuiQueueGraph,
  removeAndRewireTuiQueueRecord,
} from "../session/TuiQueueGraph.js";

export interface StartActiveTurnInput {
  messageId?: string | undefined;
  historyMessageId?: string | undefined;
  submittedMessage: string;
  modelHistoryMessage?: string | undefined;
  resumeBlockedRun?: boolean | undefined;
  forceFreshTurn?: boolean | undefined;
  checkpointRecoveryAttempted?: boolean | undefined;
  queueRequested?: boolean | undefined;
}

class ModeRetryNotAcceptedError extends Error {
  constructor() {
    super("Mode-switch retry was not accepted by Local Core.");
    this.name = "ModeRetryNotAcceptedError";
  }
}

class SubmissionOwnerDeletedError extends Error {
  constructor(sessionId: string) {
    super(`The captured submission owner '${sessionId}' no longer exists.`);
    this.name = "SubmissionOwnerDeletedError";
  }
}

type TuiTerminalResult = Extract<RunnerEvent, { type: "run.completed" }>["payload"]["result"];

interface CapturedSubmissionOwner {
  sessionId: string;
  profile: TuiProfile;
  transcript: TranscriptLine[];
  runnerMetadata: Record<string, unknown>;
}

interface QueueSettlementLease {
  sessionId: string;
}

export interface TuiRunControllerContext extends TuiAppContext {
  getChatWrappedBodyWidth(): number;
  getChatListRows(): number;
  resolveWorkspaceForSession(session: TuiSessionMeta): Promise<ResolvedWorkspace | undefined>;
  appendSessionHistoryLine(
    sessionId: string,
    role: TranscriptLine["role"],
    text: string,
    data?: Record<string, unknown> | undefined,
    output?: NormalizedOutput | undefined,
    eventId?: string | undefined,
  ): Promise<void>;
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
  syncForegroundSessionProgress(input: {
    sessionId: string;
    threadId: string;
    runId: string;
    messageId: string;
  }): Promise<boolean>;
  syncForegroundQueuedTerminal(input: {
    sessionId: string;
    threadId: string;
    runId: string;
    result: TuiTerminalResult;
    authoritativeView?: OperatorThreadView | undefined;
  }): Promise<boolean>;
  setSessionState(
    sessionId: string,
    patch: Partial<TuiSessionMeta>,
  ): Promise<TuiSessionMeta | undefined>;
  commitQueueSessionState(
    sessionId: string,
    patch: Partial<TuiSessionMeta>,
  ): Promise<TuiSessionMeta | undefined>;
  syncBackgroundSessionProgress(input: {
    sessionId: string;
    threadId: string;
    runId: string;
    messageId?: string | undefined;
    requestId?: string | undefined;
    status?: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | undefined;
    waitFor?: TuiSessionMeta["pendingWaitFor"] | undefined;
  }): Promise<void>;
  syncBackgroundSessionResult(
    expectedSessionId: string,
    expectedRunId: string,
    allowUnstartedAcceptance: boolean,
    output: NormalizedOutput,
    assistantText: string | null,
    finalizedPayload: unknown | undefined,
    operatorState?: TuiSessionMeta["operatorState"] | undefined,
  ): Promise<void>;
  syncBackgroundSessionFailure(
    expectedSessionId: string,
    expectedRunId: string,
    outputSessionId: string,
    message: string,
  ): Promise<void>;
  syncSessionFromDescribePayload(payload: SessionDescribedEventPayload): Promise<void>;
  applyTerminalResult(
    sessionId: string,
    result: { assistantText: string | null; output: NormalizedOutput },
    finalizedPayload?: unknown | undefined,
  ): Promise<void>;
  recoverTerminalMessages(session: TuiSessionMeta): Promise<void>;
  pushRunLog(line: AgentRunLogLine): void;
}

export class TuiRunController {
  private readonly context: TuiRunControllerContext;
  private readonly conversationViews = new Map<string, OperatorThreadView>();
  private readonly activityBySession = new Map<string, ConversationActivityItem[]>();
  private readonly observedActiveRunBySession = new Map<string, string>();
  private readonly acceptedRunSourceMessageBySession = new Map<string, Map<string, string | undefined>>();
  private readonly queueJournalTailBySession = new Map<string, Promise<void>>();
  private readonly indeterminateQueueJournalBySession = new Map<
    string,
    NonNullable<TuiSessionMeta["pendingQueueSubmissions"]>
  >();
  private readonly modeSwitchGuard = createModeSwitchRetryGuard();

  constructor(context: TuiRunControllerContext) {
    this.context = context;
    for (const session of context.uiStore.getState().sessions) {
      const indeterminate = session.pendingQueueSubmissions?.filter(
        (submission) => submission.indeterminate === true,
      );
      if (indeterminate !== undefined && indeterminate.length > 0) {
        this.indeterminateQueueJournalBySession.set(session.sessionId, indeterminate);
      }
    }
  }

  getConversationActivity(sessionId: string): ConversationActivityItem[] {
    return (this.activityBySession.get(sessionId) ?? [])
      .filter((item) => item.visible !== false)
      .map((item) => ({ ...item }));
  }

  getConversationRunState(sessionId: string): {
    running: boolean;
    status: "running" | "waiting" | "completed" | "failed" | "ready";
  } {
    const views = [...this.conversationViews.values()].filter(
      (view) => view.thread.sessionId === sessionId,
    );
    const activeView = views.find((view) => view.activeRun !== undefined);
    const observedRunId = this.observedActiveRunBySession.get(sessionId);
    if (
      activeView?.activeRun?.status === "WAITING"
      && (observedRunId === undefined || observedRunId === activeView.activeRun.runId)
    ) {
      return { running: false, status: "waiting" };
    }
    if (observedRunId !== undefined || activeView?.activeRun?.status === "RUNNING") {
      return { running: true, status: "running" };
    }
    if (views.some((view) => view.thread.status === "WAITING")) {
      return { running: false, status: "waiting" };
    }
    const terminalStatus = views
      .map((view) => view.thread.lastRunStatus ?? view.thread.status)
      .find((status) => status === "FAILED" || status === "COMPLETED");
    return terminalStatus === "FAILED"
      ? { running: false, status: "failed" }
      : terminalStatus === "COMPLETED"
        ? { running: false, status: "completed" }
        : { running: false, status: "ready" };
  }

  getConversationComposerPolicy() {
    const state = this.context.uiStore.getState();
    const threadId = state.activeSession.focusedThreadId ?? `thread-main:${state.activeSession.sessionId}`;
    return resolveTuiComposerPolicy(adaptTuiConversation({
      threadId,
      transcript: state.transcript,
      view: this.conversationViews.get(threadId),
    }).snapshot, "ready");
  }

  async cancelActiveRun(): Promise<void> {
    const state = this.context.uiStore.getState();
    const threadId = state.activeSession.focusedThreadId ?? `thread-main:${state.activeSession.sessionId}`;
    const expectedRunId = this.observedActiveRunBySession.get(state.activeSession.sessionId);
    let view = this.conversationViews.get(threadId);
    if (view?.activeRun?.runId === undefined || expectedRunId !== undefined) {
      view = await this.refreshConversationView(threadId);
    }
    const activeRunId = view?.activeRun?.runId;
    if (expectedRunId !== undefined && activeRunId !== expectedRunId) {
      if (activeRunId === undefined && view !== undefined && isStoppedConversationView(view)) {
        await this.reconcileAlreadyStoppedRun(view, expectedRunId);
        return;
      }
      this.context.uiStore.patch({
        statusLine: this.context.withMcpSummary("run changed; stop again"),
      });
      return;
    }
    const activeTurn = activeRunId === undefined
      ? undefined
      : view?.conversationTurns?.find((turn) => turn.activeRunId === activeRunId);
    if (view !== undefined && activeRunId === undefined && isStoppedConversationView(view)) {
      await this.reconcileAlreadyStoppedRun(view, expectedRunId);
      return;
    }
    if (view === undefined || activeTurn === undefined) {
      throw new Error("The active turn has no authoritative run identity.");
    }
    let cancelled: RunnerEvent | undefined;
    const adapter = createTuiConversationCommandAdapter({
      client: this.context.client,
      resolveInterrupt: (target) => {
        const targetView = this.conversationViews.get(target.threadId);
        const turn = targetView?.conversationTurns?.find((candidate) => candidate.turnId === target.turnId);
        return turn?.activeRunId === undefined
          ? undefined
          : {
              sessionId: turn.sessionId,
              runId: turn.activeRunId,
              metadata: this.context.getActiveRunnerMetadata(),
            };
      },
      installInterrupt: (event) => { cancelled = event; },
      switchMode: async () => undefined,
      modeSwitchGuard: this.modeSwitchGuard,
    });
    try {
      await adapter.interruptTurn({ threadId, turnId: activeTurn.turnId });
    } catch (error) {
      const code = runnerErrorCode(error);
      if (code === "RUN_ALREADY_FINALIZING") return;
      if (code === "RUN_CANCEL_NOT_FOUND") {
        const refreshed = await this.refreshConversationView(threadId);
        if (isStoppedConversationView(refreshed)) {
          await this.reconcileAlreadyStoppedRun(refreshed, activeRunId);
          return;
        }
      }
      throw error;
    }
    if (cancelled === undefined) {
      return;
    }
    if (cancelled.type !== "run.cancelled") {
      throw new Error(`Unexpected run cancellation response '${cancelled.type}'`);
    }
    await this.applyTerminalResultAndState(cancelled.payload.result);
    await this.refreshConversationView(threadId);
  }

  private async reconcileAlreadyStoppedRun(
    view: OperatorThreadView,
    expectedRunId: string | undefined,
  ): Promise<void> {
    const sessionId = view.thread.sessionId;
    if (expectedRunId !== undefined && this.observedActiveRunBySession.get(sessionId) === expectedRunId) {
      this.observedActiveRunBySession.delete(sessionId);
    }
    const activity = (this.activityBySession.get(sessionId) ?? []).filter(
      (item) => item.runId !== expectedRunId,
    );
    this.activityBySession.set(sessionId, activity);
    const terminalStatus = view.thread.lastRunStatus
      ?? (view.thread.status === "COMPLETED" || view.thread.status === "FAILED"
        ? view.thread.status
        : undefined);
    if (terminalStatus === "COMPLETED" || terminalStatus === "FAILED") {
      await this.context.recoverTerminalMessages(this.context.uiStore.getState().activeSession);
    }
    if (this.context.uiStore.getState().activeSession.sessionId === sessionId) {
      this.context.uiStore.patch({
        running: false,
        conversationActivity: activity.filter((item) => item.visible !== false),
        statusLine: this.context.withMcpSummary(
          terminalStatus === "FAILED"
            ? "failed"
            : terminalStatus === "COMPLETED" ? "completed" : "ready",
        ),
      });
    }
    await this.context.persistSessionAndUi();
  }

  resolveInteractionTurnId(requestId: string): string | undefined {
    for (const view of this.conversationViews.values()) {
      const item = view.inboxItems?.find((candidate) => candidate.requestId === requestId);
      if (item?.turnId !== undefined) return item.turnId;
    }
    return undefined;
  }

  async switchModeAndRetry(input: {
    recommendationId: string;
    mode: ConversationMode;
    switchMode(mode: ConversationMode): void | Promise<void>;
    retry(): Promise<boolean>;
  }): Promise<void> {
    const adapter = createTuiConversationCommandAdapter({
      client: this.context.client,
      resolveInterrupt: () => undefined,
      installInterrupt: () => undefined,
      switchMode: input.switchMode,
      modeSwitchGuard: this.modeSwitchGuard,
    });
    try {
      await adapter.switchModeAndRetry({
        recommendationId: input.recommendationId,
        mode: input.mode,
        answer: {
          requestId: input.recommendationId,
          execute: async () => {
            if (await input.retry() === false) throw new ModeRetryNotAcceptedError();
          },
        },
      });
    } catch (error) {
      if (error instanceof ModeRetryNotAcceptedError) return;
      throw error;
    }
  }

  async startActiveTurn(input: StartActiveTurnInput): Promise<boolean> {
    return await this.startCapturedTurn(input);
  }

  private async startCapturedTurn(
    input: StartActiveTurnInput,
    capturedOwner?: CapturedSubmissionOwner,
    inheritedQueueSettlement?: QueueSettlementLease,
  ): Promise<boolean> {
    const state = this.context.uiStore.getState();
    const submittingSessionId = capturedOwner?.sessionId ?? state.activeSession.sessionId;
    const readSubmittingSession = () => this.context.uiStore.getState().sessions.find(
      (session) => session.sessionId === submittingSessionId,
    );
    const submittingSessionIsActive = () =>
      this.context.uiStore.getState().activeSession.sessionId === submittingSessionId;
    const queueSettlementAlreadyHeld = inheritedQueueSettlement?.sessionId === submittingSessionId;
    const submittingSession = readSubmittingSession();
    if (submittingSession === undefined) return false;
    const submittedPendingWait = submittingSession.pendingWaitFor;
    const pendingWait = input.forceFreshTurn === true ? undefined : submittedPendingWait;
    const exactReview = readExactReview(pendingWait);
    if (input.resumeBlockedRun === true && exactReview.kind === "invalid_review") {
      throw new Error(`${exactReview.error} Use /stop to end the waiting run.`);
    }
    const resumeRequestId = input.resumeBlockedRun === true
      ? pendingWait?.interaction?.requestId?.trim()
      : undefined;
    const recoveryOptionId = input.resumeBlockedRun === true
      ? resolveExactReviewOptionId(pendingWait, input.submittedMessage)
      : undefined;
    if (
      input.resumeBlockedRun === true &&
      exactReview.kind === "structured_review" &&
      recoveryOptionId === undefined
    ) {
      throw new Error("Choose one exact structured-review option.");
    }
    const eventType = pendingWait?.eventType ?? "user.message";
    const effectiveProfile = capturedOwner?.profile ?? state.activeProfile;
    const submittingRunnerMetadata = capturedOwner?.runnerMetadata
      ?? this.context.getActiveRunnerMetadata();
    const ownerTranscript = capturedOwner?.transcript ?? state.transcript;
    const submissionMessageId = input.messageId ?? `tui:${randomUUID()}`;
    const historyMessageId = input.historyMessageId ?? submissionMessageId;
    const priorTranscript = ownerTranscript.filter((line) =>
      line.eventId !== historyMessageId && line.data?.messageId !== historyMessageId
    );
    const baseHistorySource =
      pendingWait !== undefined
        ? priorTranscript.filter((line) =>
            line.role !== "system" || isRuntimeWaitingPromptHistoryLine(line)
          )
        : priorTranscript;
    const historySource =
      input.modelHistoryMessage !== undefined
        ? replaceLatestUserHistoryLine(baseHistorySource, input.modelHistoryMessage)
        : baseHistorySource;
    const modeResolution = normalizeInteractionMode({
      interactionMode: submittingSession.interactionMode ?? effectiveProfile.defaultInteractionMode,
      actSubmode: submittingSession.actSubmode ?? effectiveProfile.defaultActSubmode,
      defaultInteractionMode: effectiveProfile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
      defaultActSubmode: effectiveProfile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
    });
    const manualCompaction =
      submittingSession.pendingManualCompaction === true ||
      (
        pendingWait !== undefined &&
        this.context.shouldApplyCompactionOnContinuationResume(submittingSession)
      );
    const exactDecisionWait = exactReview.kind === "structured_review";
    const clearSubmittedWait = submittedPendingWait !== undefined
      && (exactDecisionWait === false || recoveryOptionId !== undefined);
    const threadId = submittingSession.focusedThreadId ?? `thread-main:${submittingSession.sessionId}`;
    let authoritativeView = this.conversationViews.get(threadId);
    if (authoritativeView === undefined && state.running) {
      authoritativeView = await this.refreshConversationView(threadId);
    }
    const currentConversation = adaptTuiConversation({
      threadId,
      transcript: state.transcript,
      view: authoritativeView,
    });
    const composerPolicy = resolveTuiComposerPolicy(currentConversation.snapshot, "ready");
    const queueSubmission = input.resumeBlockedRun !== true && (
      input.queueRequested === true || composerPolicy.mode === "queue_turn"
    );
    const assertSubmittingOwnerExists = () => {
      if (readSubmittingSession() === undefined) {
        throw new SubmissionOwnerDeletedError(submittingSessionId);
      }
    };
    const setResponseSessionState = async (patch: Partial<TuiSessionMeta>) => {
      assertSubmittingOwnerExists();
      const updated = queueSubmission
        ? await this.context.commitQueueSessionState(submittingSessionId, patch)
        : await this.context.setSessionState(submittingSessionId, patch);
      if (updated === undefined) {
        throw new Error("Queued session authority was not durably committed.");
      }
      assertSubmittingOwnerExists();
    };
    const appendResponseHistoryLine = async (
      role: TranscriptLine["role"],
      text: string,
      data?: Record<string, unknown> | undefined,
      output?: NormalizedOutput | undefined,
      eventId?: string | undefined,
    ) => {
      assertSubmittingOwnerExists();
      await this.context.appendSessionHistoryLine(
        submittingSessionId,
        role,
        text,
        data,
        output,
        eventId,
      );
      assertSubmittingOwnerExists();
    };
    const persistResponseSessionAndUi = async () => {
      assertSubmittingOwnerExists();
      await this.context.persistSessionAndUi();
      assertSubmittingOwnerExists();
    };
    const reservedRunId = resumeRequestId === undefined
      ? `tui-foreground:${randomUUID()}`
      : undefined;
    if (
      input.resumeBlockedRun !== true
      && input.queueRequested !== true
      && composerPolicy.mode === "blocked_interaction"
    ) {
      throw new Error("The active interaction requires an explicit operator control.");
    }

    if (submittingSessionIsActive()) {
      this.context.uiStore.patch(queueSubmission
        ? {
            statusLine: this.context.withMcpSummary("queueing behind current work"),
            quitConfirm: false,
            errorOverlay: undefined,
            errorScrollOffset: 0,
          }
        : {
            running: true,
            statusLine: this.context.withMcpSummary(`running (${eventType})`),
            runLogs: [],
            chatHighlightRunId: undefined,
            quitConfirm: false,
            errorOverlay: undefined,
            errorScrollOffset: 0,
            conversationActivity: [],
          });
    }

    const prepareSubmission = async () => {
      const core = this.context.prepareLocalCoreClient !== undefined
        ? await this.context.prepareLocalCoreClient()
        : this.context.getLocalCoreClient?.();
      if (core === undefined) {
        throw new Error(
          "Kestrel Local Core is required to resolve the active execution profile.",
        );
      }
      const environmentPresetId = await this.resolveSessionEnvironment(submittingSession);
      const executionProfile = await core.resolveExecutionProfile({
        client: "cli",
        profileId: effectiveProfile.id,
        environmentPresetId,
      });
      await this.context.setSessionState(submittingSessionId, {
        ...toResolvedSessionIdentity(executionProfile, environmentPresetId),
        ...(clearSubmittedWait ? { pendingWaitFor: undefined } : {}),
        updatedAt: new Date().toISOString(),
      });
      await this.context.persistSessionAndUi();
      const workspace = await this.context.resolveWorkspaceForSession(submittingSession);
      return { executionProfile, workspace };
    };

    let prepared: Awaited<ReturnType<typeof prepareSubmission>>;
    if (resumeRequestId === undefined && queueSubmission) {
      const prepareQueuedSubmission = async () => {
          if (await this.reconcileIndeterminateQueueJournal(submittingSessionId) === false) {
            return undefined;
          }
          const preflightSession = readSubmittingSession();
          if (preflightSession === undefined) return undefined;
          const preflightGraph = normalizeTuiQueueGraph(preflightSession);
          exactTuiQueueTailRunId({ ...preflightSession, ...preflightGraph }, preflightGraph);
          const preparedSubmission = await prepareSubmission();
          const currentSession = readSubmittingSession();
          if (currentSession === undefined) {
            return {
              preparedSubmission,
              missing: true as const,
              barrierError: undefined,
            };
          }
          const normalizedQueue = normalizeTuiQueueGraph(currentSession);
          const normalizedSession = { ...currentSession, ...normalizedQueue };
          const pendingSubmission = {
            runId: reservedRunId!,
            messageId: submissionMessageId,
            threadId,
            ...(exactTuiQueueTailRunId(normalizedSession, normalizedQueue) !== undefined
              ? { predecessorRunId: exactTuiQueueTailRunId(normalizedSession, normalizedQueue) }
              : {}),
            indeterminate: true as const,
          };
          await this.context.setSessionState(submittingSessionId, {
            pendingQueueSubmissions: appendPendingQueueSubmission(
              normalizedQueue.pendingQueueSubmissions,
              pendingSubmission,
            ),
            queuedRunReservations: normalizedQueue.queuedRunReservations,
            terminalQueuedRuns: normalizedQueue.terminalQueuedRuns,
            updatedAt: new Date().toISOString(),
          });
          try {
            await this.context.persistSessionAndUi({ requireSessionSave: true });
            return {
              preparedSubmission,
              missing: false as const,
              barrierError: undefined,
            };
          } catch (barrierError) {
            const latest = readSubmittingSession();
            const latestGraph = latest === undefined ? undefined : normalizeTuiQueueGraph(latest);
            const rewired = latestGraph === undefined
              ? undefined
              : removeAndRewireTuiQueueRecord(latestGraph, pendingSubmission);
            await this.context.setSessionState(submittingSessionId, {
              pendingQueueSubmissions: rewired?.pendingQueueSubmissions,
              queuedRunReservations: rewired?.queuedRunReservations,
              terminalQueuedRuns: rewired?.terminalQueuedRuns,
              updatedAt: new Date().toISOString(),
            });
            try {
              await this.context.persistSessionAndUi({ requireSessionSave: true });
            } catch (rollbackError) {
              this.context.recordPersistenceFailure("sessions.queue_rollback", rollbackError);
              const unsettled = readSubmittingSession();
              if (unsettled !== undefined) {
                await this.context.setSessionState(submittingSessionId, {
                  pendingQueueSubmissions: appendPendingQueueSubmission(
                    unsettled.pendingQueueSubmissions,
                    pendingSubmission,
                  ),
                  updatedAt: new Date().toISOString(),
                });
                const indeterminate = this.indeterminateQueueJournalBySession.get(
                  submittingSessionId,
                ) ?? [];
                this.indeterminateQueueJournalBySession.set(submittingSessionId, [
                  ...indeterminate.filter((candidate) => candidate.runId !== pendingSubmission.runId),
                  pendingSubmission,
                ]);
              }
            }
            return {
              preparedSubmission,
              missing: false as const,
              barrierError,
            };
          }
        };
      const transaction = queueSettlementAlreadyHeld
        ? await prepareQueuedSubmission()
        : await this.runQueueJournalTransaction(submittingSessionId, prepareQueuedSubmission);
      if (transaction === undefined) return false;
      prepared = transaction.preparedSubmission;
      if (transaction.missing === true) return false;
      if (transaction.barrierError !== undefined) {
        if (submittingSessionIsActive()) {
          const message = transaction.barrierError instanceof Error
            ? transaction.barrierError.message
            : String(transaction.barrierError);
          this.context.uiStore.patch({
            running: state.running,
            statusLine: state.statusLine,
            errorOverlay: { message, code: "SESSION_PERSISTENCE_FAILED" },
            errorScrollOffset: 0,
          });
        }
        return false;
      }
    } else {
      prepared = await prepareSubmission();
      if (resumeRequestId === undefined) {
        await this.context.setSessionState(submittingSessionId, {
          pendingRunId: reservedRunId,
          pendingRunMessageId: submissionMessageId,
          pendingRunThreadId: threadId,
          updatedAt: new Date().toISOString(),
        });
      } else {
        await this.context.setSessionState(submittingSessionId, {
          pendingRunRequestId: resumeRequestId,
          pendingRunThreadId: threadId,
          updatedAt: new Date().toISOString(),
        });
      }
      await this.context.persistSessionAndUi();
    }
    const { executionProfile, workspace } = prepared;

    if (readSubmittingSession() === undefined) {
      await this.context.appendDiagnosticsLog({
        scope: "submission.owner_deleted_before_dispatch",
        summary: "Skipped dispatch because the captured submitting session no longer exists.",
        details: JSON.stringify({ sessionId: submittingSessionId, messageId: submissionMessageId }),
      });
      return false;
    }

    let terminalResponseMeta: Record<string, unknown> | undefined;
    let requestAccepted = false;
    let responseIdentityRejected = false;
    let releaseQueueSettlement: (() => void) | undefined;

    try {
      let response: RunnerEvent | undefined;
      const adapter = createTuiConversationCommandAdapter({
        client: this.context.client,
        resolveInterrupt: (target) => {
          const view = this.conversationViews.get(target.threadId);
          const turn = view?.conversationTurns?.find((candidate) => candidate.turnId === target.turnId);
          const runId = turn?.activeRunId;
          return runId === undefined
            ? undefined
            : {
                sessionId: submittingSessionId,
                runId,
                metadata: submittingRunnerMetadata,
              };
        },
        installInterrupt: (event) => {
          response = event;
        },
        switchMode: async (mode) => {
          await this.context.setSessionState(submittingSessionId, {
            interactionMode: mode,
            updatedAt: new Date().toISOString(),
          });
        },
        modeSwitchGuard: this.modeSwitchGuard,
      });
      const metadata = submittingRunnerMetadata;
      if (resumeRequestId !== undefined) {
        await adapter.answerInteraction({
          requestId: resumeRequestId,
          payload: {
            action: "reply",
            threadId,
            requestId: resumeRequestId,
            message: input.submittedMessage,
            completionMode: "accepted",
            ...(recoveryOptionId !== undefined ? { recoveryOptionId } : {}),
          },
          metadata,
          install: (event) => {
            response = event;
          },
        });
      } else {
        const submission = {
          payload: {
            profileId: executionProfile.profileId,
            threadId,
            messageId: submissionMessageId,
            turn: {
              sessionId: submittingSessionId,
              runId: reservedRunId!,
              message: input.submittedMessage,
              modeSystemV2Enabled: effectiveProfile.modeSystemV2Enabled === true,
              interactionMode: modeResolution.interactionMode,
              ...(modeResolution.actSubmode !== undefined ? { actSubmode: modeResolution.actSubmode } : {}),
              ...(submittingSession.executionPolicy !== undefined
                ? { executionPolicy: submittingSession.executionPolicy }
                : {}),
              clientCapabilities: createTuiClientCapabilities(),
              history: buildModelHistoryWindow(historySource),
              ...(manualCompaction ? { manualCompaction: true } : {}),
              autoCompaction: {
                enabled: submittingSession.autoCompactionEnabled === true,
                state: submittingSession.operatorState?.context?.compactionState ?? "idle",
                suppressOnce: submittingSession.suppressAutoCompactionOnce === true,
              },
              ...(workspace !== undefined ? { workspace: workspace.runtimeContext } : {}),
            },
          },
          metadata,
          install: (event: RunnerEvent) => {
            response = event;
          },
        };
        await (queueSubmission
          ? adapter.queueTurn(submission)
          : adapter.startTurn(submission));
      }
      if (response === undefined) {
        throw new Error("Conversation command completed without a protocol response.");
      }
      if (queueSubmission && queueSettlementAlreadyHeld === false) {
        releaseQueueSettlement = await this.acquireQueueJournalTransaction(submittingSessionId);
      }
      if (readSubmittingSession() === undefined) {
        await this.context.appendDiagnosticsLog({
          scope: "submission.owner_deleted_after_dispatch",
          summary: "Ignored a response because the captured submitting session no longer exists.",
          details: JSON.stringify({
            sessionId: submittingSessionId,
            messageId: submissionMessageId,
            responseType: response.type,
          }),
        });
        return false;
      }
      if (response.type === "conversation.message.routed") {
        const routedRunId = response.payload.runId;
        const activeViewRunId = response.payload.view.activeRun?.runId;
        const startedRoute = response.payload.disposition === "started";
        const queuedRoute = response.payload.disposition === "queued";
        const pendingQueueSubmission = queueSubmission
          ? findPendingQueueSubmission(
              readSubmittingSession()?.pendingQueueSubmissions,
              reservedRunId!,
              threadId,
              submissionMessageId,
            )
          : undefined;
        const responseSession = readSubmittingSession();
        const alreadyAcceptedQueueSubmission = queueSubmission
          && responseSession?.acceptedRunId === reservedRunId
          && responseSession.acceptedRunMessageId === submissionMessageId
          && responseSession.acceptedRunThreadId === threadId;
        const alreadyTerminalQueueSubmission = queueSubmission
          && responseSession?.terminalQueuedRuns?.some((terminal) =>
            terminal.runId === reservedRunId
            && terminal.messageId === submissionMessageId
            && terminal.threadId === threadId
          ) === true;
        const queueSubmissionAlreadySettled = alreadyAcceptedQueueSubmission
          || alreadyTerminalQueueSubmission;
        if (
          response.payload.sessionId !== submittingSessionId
          || response.payload.threadId !== threadId
          || response.payload.messageId !== submissionMessageId
          || response.payload.view.thread.sessionId !== submittingSessionId
          || response.payload.view.thread.threadId !== threadId
          || (
            queueSubmission
            && pendingQueueSubmission === undefined
            && queueSubmissionAlreadySettled === false
          )
          || (
            queuedRoute === false
            && routedRunId !== reservedRunId
          )
          || (
            queuedRoute
            && routedRunId !== undefined
            && routedRunId !== reservedRunId
          )
          || (
            startedRoute
            && (
              routedRunId === undefined
              || activeViewRunId === undefined
              || routedRunId !== activeViewRunId
            )
          )
          || (
            response.payload.disposition !== "queued"
            && response.payload.view.activeRun?.status === "RUNNING"
            && (routedRunId === undefined || routedRunId !== activeViewRunId)
          )
          || (
            routedRunId !== undefined
            && activeViewRunId !== undefined
            && response.payload.disposition !== "queued"
            && routedRunId !== activeViewRunId
          )
        ) {
          responseIdentityRejected = true;
          throw new Error("Local Core returned a route with mismatched session, thread, view, or message identity.");
        }
        requestAccepted = true;
        if (queueSubmissionAlreadySettled) {
          this.clearIndeterminateQueueRecord(
            submittingSessionId,
            reservedRunId!,
            submissionMessageId,
            threadId,
          );
          await persistResponseSessionAndUi();
          return true;
        }
        const disposition = response.payload.disposition;
        const awaitingQueuedRun = disposition === "queued";
        const routedStatus = routedRunId === undefined
          ? undefined
          : exactRunStatusFromView(response.payload.view, routedRunId);
        const authoritativeRunActive = awaitingQueuedRun
          ? response.payload.view.activeRun?.status === "RUNNING"
          : routedStatus === "RUNNING";
        const terminalStatus = routedStatus === "COMPLETED" || routedStatus === "FAILED"
          ? routedStatus
          : undefined;
        const currentSession = readSubmittingSession();
        if (currentSession === undefined) return false;
        const currentQueueGraph = normalizeTuiQueueGraph(currentSession);
        const exactTerminalRoute = terminalStatus === undefined
          || pendingQueueSubmission === undefined
          || hasExactQueuedTerminalTurn(response.payload.view, {
            ...pendingQueueSubmission,
            status: terminalStatus,
          });
        const installAsCurrent = exactTerminalRoute && (
          queueSubmission === false
          || pendingQueueSubmission === undefined
          || queuedEvidenceCanReplaceAcceptedRun(currentSession, pendingQueueSubmission)
        );
        let routedQueueGraph = pendingQueueSubmission === undefined
          ? currentQueueGraph
          : awaitingQueuedRun
            ? {
                pendingQueueSubmissions: removePendingQueueSubmission(
                  currentQueueGraph.pendingQueueSubmissions,
                  pendingQueueSubmission,
                ),
                queuedRunReservations: appendQueuedRunReservation(
                  currentQueueGraph.queuedRunReservations,
                  pendingQueueSubmission,
                ),
                terminalQueuedRuns: currentQueueGraph.terminalQueuedRuns,
              }
            : installAsCurrent
              ? advanceTuiQueueAuthority(currentQueueGraph, pendingQueueSubmission)
              : {
                  ...currentQueueGraph,
                  pendingQueueSubmissions: removePendingQueueSubmission(
                    currentQueueGraph.pendingQueueSubmissions,
                    pendingQueueSubmission,
                  ),
                };
        if (terminalStatus !== undefined && pendingQueueSubmission !== undefined) {
          routedQueueGraph = {
            ...routedQueueGraph,
            pendingQueueSubmissions: removePendingQueueSubmission(
              routedQueueGraph.pendingQueueSubmissions,
              pendingQueueSubmission,
            ),
            queuedRunReservations: removeQueuedRunReservation(
              routedQueueGraph.queuedRunReservations,
              toQueuedRunReservation(pendingQueueSubmission),
            ),
          };
        }
        await setResponseSessionState({
          started: true,
          updatedAt: new Date().toISOString(),
          focusedThreadId: response.payload.threadId,
          pendingManualCompaction: false,
          suppressAutoCompactionOnce: false,
          pendingRunId: undefined,
          pendingRunMessageId: undefined,
          pendingRunThreadId: undefined,
          queuedRunReservations: routedQueueGraph.queuedRunReservations,
          pendingQueueSubmissions: routedQueueGraph.pendingQueueSubmissions,
          ...(awaitingQueuedRun || installAsCurrent === false
            ? {}
            : {
                pendingWaitFor: routedStatus === "WAITING"
                  ? response.payload.view.thread.waitFor
                  : undefined,
                lastRunStatus: routedStatus === "RUNNING" ? undefined : routedStatus,
              }),
          terminalQueuedRuns: terminalStatus === undefined || pendingQueueSubmission === undefined
            ? routedQueueGraph.terminalQueuedRuns
            : appendTerminalQueuedRun(routedQueueGraph.terminalQueuedRuns, {
                ...toQueuedRunReservation(pendingQueueSubmission),
                status: terminalStatus,
              }),
          ...(response.payload.runId !== undefined && awaitingQueuedRun === false && installAsCurrent
            ? {
                acceptedRunId: response.payload.runId,
                acceptedRunMessageId: submissionMessageId,
                acceptedRunThreadId: response.payload.threadId,
                acceptedRunPredecessorId: pendingQueueSubmission === undefined
                  ? undefined
                  : durableAcceptedQueuePredecessorId(pendingQueueSubmission),
              }
            : {}),
        });
        if (
          (awaitingQueuedRun || installAsCurrent)
          && await this.installConversationView(response.payload.view, { preserveSessionLifecycle: queueSubmission }) === false
        ) {
          throw new Error("Local Core returned an incomplete conversation snapshot.");
        }
        if (response.payload.runId !== undefined && response.payload.disposition !== "queued") {
          this.recordAcceptedRunSource(
            submittingSessionId,
            response.payload.runId,
            submissionMessageId,
          );
        }
        if (
          authoritativeRunActive === false
          && (terminalStatus === "COMPLETED" || terminalStatus === "FAILED")
        ) {
          const submittingSession = readSubmittingSession();
          if (submittingSession !== undefined) {
            await this.context.recoverTerminalMessages(submittingSession);
          }
        }
        if (submittingSessionIsActive() && (awaitingQueuedRun || installAsCurrent)) {
          this.context.uiStore.patch({
            running: authoritativeRunActive,
            statusLine: this.context.withMcpSummary(
              disposition === "queued"
                ? "queued behind current work"
                : routedStatus === "WAITING"
                  ? `waiting (${response.payload.view.thread.waitFor?.eventType ?? "input"})`
                  : terminalStatus === "FAILED"
                    ? "failed"
                    : terminalStatus === "COMPLETED"
                      ? "completed"
                      : authoritativeRunActive ? "running" : "ready",
            ),
          });
        }
        await persistResponseSessionAndUi();
        return true;
      }

      if (response.type === "operator.controlled") {
        const resultRunId = response.payload.result?.output.runId;
        const acceptedRunId = response.payload.runId ?? response.runId ?? resultRunId;
        const acceptedViewStatus = acceptedRunId === undefined || response.payload.view === undefined
          ? undefined
          : exactRunStatusFromView(response.payload.view, acceptedRunId);
        if (
          response.payload.threadId !== threadId
          || (response.threadId !== undefined && response.threadId !== threadId)
          || (
            response.payload.sessionId !== undefined
            && response.payload.sessionId !== submittingSessionId
          )
          || (response.sessionId !== undefined && response.sessionId !== submittingSessionId)
          || (
            response.payload.runId !== undefined
            && response.runId !== undefined
            && response.payload.runId !== response.runId
          )
          || (
            response.payload.disposition === "accepted"
            && (
              acceptedRunId === undefined
              || response.payload.sessionId !== submittingSessionId
              || (
                response.payload.view?.activeRun !== undefined
                && response.payload.view.activeRun.runId !== acceptedRunId
              )
            )
          )
          || (
            resultRunId !== undefined
            && acceptedRunId !== undefined
            && resultRunId !== acceptedRunId
          )
          || (
            response.payload.result !== undefined
            && response.payload.result.output.sessionId !== submittingSessionId
          )
          || (
            response.payload.view !== undefined
            && (
              response.payload.view.thread.sessionId !== submittingSessionId
              || response.payload.view.thread.threadId !== threadId
            )
          )
        ) {
          responseIdentityRejected = true;
          throw new Error("Local Core returned operator control with mismatched session, thread, or run identity.");
        }
        requestAccepted = true;
        if (response.payload.view !== undefined) {
          if (await this.installConversationView(response.payload.view) === false) return false;
        }
        if (
          response.payload.disposition === "accepted"
          && acceptedRunId !== undefined
          && resumeRequestId !== undefined
          && readSubmittingSession()?.delegation !== undefined
        ) {
          await this.context.syncBackgroundSessionProgress({
            sessionId: submittingSessionId,
            threadId,
            runId: acceptedRunId,
            messageId: submissionMessageId,
            requestId: resumeRequestId,
            status: acceptedViewStatus ?? "RUNNING",
            waitFor: response.payload.view?.thread.waitFor,
          });
        }
        if (acceptedRunId !== undefined) {
          this.recordAcceptedRunSource(
            submittingSessionId,
            acceptedRunId,
            submissionMessageId,
          );
        }
        const acceptedTerminalStatus = acceptedViewStatus === "COMPLETED" || acceptedViewStatus === "FAILED"
          ? acceptedViewStatus
          : undefined;
        await setResponseSessionState({
          started: true,
          focusedThreadId: threadId,
          pendingWaitFor: acceptedViewStatus === "WAITING"
            ? response.payload.view?.thread.waitFor
            : undefined,
          pendingRunRequestId: undefined,
          pendingRunThreadId: undefined,
          ...(acceptedRunId !== undefined
            ? {
                acceptedRunId,
                acceptedRunMessageId: submissionMessageId,
                acceptedRunThreadId: threadId,
                acceptedRunPredecessorId: undefined,
                lastRunStatus: acceptedTerminalStatus,
              }
            : {}),
          updatedAt: new Date().toISOString(),
        });
        if (response.payload.result !== undefined) {
          await this.applyTerminalResultAndState(response.payload.result);
        } else if (acceptedTerminalStatus !== undefined) {
          const responseOwner = readSubmittingSession();
          if (responseOwner?.delegation === undefined && responseOwner !== undefined) {
            await this.context.recoverTerminalMessages(responseOwner);
          }
          if (submittingSessionIsActive()) this.context.uiStore.patch({
            running: false,
            statusLine: this.context.withMcpSummary(acceptedTerminalStatus.toLowerCase()),
            errorOverlay: undefined,
            errorScrollOffset: 0,
          });
        } else if (response.payload.disposition === "accepted") {
          const waiting = acceptedViewStatus === "WAITING";
          if (submittingSessionIsActive()) this.context.uiStore.patch({
            running: waiting === false,
            statusLine: this.context.withMcpSummary(
              waiting
                ? `waiting (${response.payload.view?.thread.waitFor?.eventType ?? "input"})`
                : "running",
            ),
            errorOverlay: undefined,
            errorScrollOffset: 0,
          });
        } else {
          if (submittingSessionIsActive()) this.context.uiStore.patch({
            running: false,
            statusLine: this.context.withMcpSummary("ready"),
          });
        }
        await persistResponseSessionAndUi();
        return true;
      }

      if (
        response.type !== "run.completed"
        && response.type !== "run.failed"
        && response.type !== "run.cancelled"
      ) {
        throw new Error(`Unexpected run response type '${response.type}'`);
      }
      const terminalOutput = response.payload.result?.output;
      const pendingSession = readSubmittingSession();
      if (pendingSession === undefined) {
        throw new Error("The submitting session no longer exists.");
      }
      const pendingQueueGraph = normalizeTuiQueueGraph(pendingSession);
      const normalizedPendingSession = { ...pendingSession, ...pendingQueueGraph };
      const terminalRunId = terminalOutput?.runId ?? response.runId;
      const exactPendingSubmission = pendingSession.pendingRunMessageId === submissionMessageId
        && pendingSession.pendingRunThreadId === threadId
        && terminalRunId !== undefined
        && pendingSession.pendingRunId === terminalRunId;
      const exactPendingQueueSubmission = queueSubmission && terminalRunId !== undefined
        ? findPendingQueueSubmission(
            pendingQueueGraph.pendingQueueSubmissions,
            terminalRunId,
            threadId,
            submissionMessageId,
          )
        : undefined;
      const exactAlreadyAcceptedSubmission = terminalOutput !== undefined
        && pendingSession.acceptedRunId === terminalOutput.runId
        && pendingSession.acceptedRunMessageId === submissionMessageId
        && pendingSession.acceptedRunThreadId === threadId;
      const retainedRunSource = terminalOutput === undefined
        ? undefined
        : this.acceptedRunSourceMessageBySession.get(submittingSessionId);
      const retainedRunMessageMismatch = terminalOutput !== undefined
        && retainedRunSource?.has(terminalOutput.runId) === true
        && retainedRunSource.get(terminalOutput.runId) !== submissionMessageId;
      if (
        (response.threadId !== undefined && response.threadId !== threadId)
        || (response.sessionId !== undefined && response.sessionId !== submittingSessionId)
        || (
          resumeRequestId === undefined
          && exactPendingSubmission === false
          && exactPendingQueueSubmission === undefined
          && exactAlreadyAcceptedSubmission === false
        )
        || (resumeRequestId === undefined && retainedRunMessageMismatch)
        || (
          terminalOutput !== undefined
          && (
            terminalOutput.sessionId !== submittingSessionId
            || (response.sessionId !== undefined && response.sessionId !== terminalOutput.sessionId)
            || (response.runId !== undefined && response.runId !== terminalOutput.runId)
            || (
              resumeRequestId === undefined
              && terminalOutput.runId === pendingSession.acceptedRunId
              && pendingSession.acceptedRunMessageId !== submissionMessageId
            )
          )
        )
      ) {
        responseIdentityRejected = true;
        throw new Error("Runner terminal response identity did not match the submitted session and run.");
      }
      const directTerminalStatus = terminalOutput?.status === "COMPLETED"
        ? "COMPLETED" as const
        : terminalOutput?.status === "FAILED"
          ? "FAILED" as const
          : undefined;
      if (exactPendingQueueSubmission !== undefined && directTerminalStatus !== undefined) {
        const authoritativeView = await this.requestConversationView(threadId).catch(() => undefined);
        if (
          authoritativeView === undefined
          || authoritativeView.thread.sessionId !== submittingSessionId
          || authoritativeView.thread.threadId !== threadId
          || hasExactQueuedRunEvidence(authoritativeView, {
            ...exactPendingQueueSubmission,
            status: directTerminalStatus,
          }) === false
        ) {
          responseIdentityRejected = true;
          return false;
        }
      }
      const responseCanInstallCurrentLifecycle = exactPendingQueueSubmission === undefined
        || queuedEvidenceCanReplaceAcceptedRun(normalizedPendingSession, exactPendingQueueSubmission);
      const settlePendingQueueGraph = (
        status?: "COMPLETED" | "FAILED" | undefined,
      ) => {
        if (exactPendingQueueSubmission === undefined) return pendingQueueGraph;
        let acceptedGraph = responseCanInstallCurrentLifecycle
          ? advanceTuiQueueAuthority(pendingQueueGraph, exactPendingQueueSubmission)
          : {
              ...pendingQueueGraph,
              pendingQueueSubmissions: removePendingQueueSubmission(
                pendingQueueGraph.pendingQueueSubmissions,
                exactPendingQueueSubmission,
              ),
            };
        if (status !== undefined) {
          acceptedGraph = {
            ...acceptedGraph,
            pendingQueueSubmissions: removePendingQueueSubmission(
              acceptedGraph.pendingQueueSubmissions,
              exactPendingQueueSubmission,
            ),
            queuedRunReservations: removeQueuedRunReservation(
              acceptedGraph.queuedRunReservations,
              toQueuedRunReservation(exactPendingQueueSubmission),
            ),
          };
        }
        return status === undefined
          ? acceptedGraph
          : {
              ...acceptedGraph,
              terminalQueuedRuns: appendTerminalQueuedRun(acceptedGraph.terminalQueuedRuns, {
                ...toQueuedRunReservation(exactPendingQueueSubmission),
                status,
              }),
            };
      };

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

      if (response.type === "run.cancelled") {
        const result = response.payload.result;
        const output = result.output;
        requestAccepted = true;
        const settledQueueGraph = settlePendingQueueGraph("FAILED");
        await setResponseSessionState({
          started: true,
          updatedAt: new Date().toISOString(),
          ...(responseCanInstallCurrentLifecycle
            ? { pendingWaitFor: undefined, lastRunStatus: "FAILED" as const }
            : {}),
          pendingRunRequestId: undefined,
          pendingRunId: undefined,
          pendingRunMessageId: undefined,
          pendingRunThreadId: undefined,
          pendingQueueSubmissions: settledQueueGraph.pendingQueueSubmissions,
          queuedRunReservations: settledQueueGraph.queuedRunReservations,
          ...(responseCanInstallCurrentLifecycle
            ? {
                acceptedRunId: output.runId,
                acceptedRunMessageId: submissionMessageId,
                acceptedRunThreadId: threadId,
                acceptedRunPredecessorId: exactPendingQueueSubmission === undefined
                  ? undefined
                  : durableAcceptedQueuePredecessorId(exactPendingQueueSubmission),
              }
            : {}),
          terminalQueuedRuns: settledQueueGraph.terminalQueuedRuns,
        });
        this.recordAcceptedRunSource(output.sessionId, output.runId, submissionMessageId);
        if (responseCanInstallCurrentLifecycle) {
          await this.context.applyTerminalResult(output.sessionId, result);
        }
        if (submittingSessionIsActive() && responseCanInstallCurrentLifecycle) {
          this.context.uiStore.patch({
            running: false,
            statusLine: this.context.withMcpSummary("failed"),
          });
        }
        await persistResponseSessionAndUi();
        return true;
      }

      if (response.type === "run.failed") {
        const result = response.payload.result;
        const failure = resolveRunFailureSummary(response.payload);
        const resultRunId = result?.output.runId ?? response.runId;
        requestAccepted = result !== undefined
          && resultRunId !== undefined
          && failure.code !== "RUN_START_REJECTED"
          && (
            queueSubmission === false
            || exactPendingSubmission
            || exactPendingQueueSubmission !== undefined
            || exactAlreadyAcceptedSubmission
            || this.acceptedRunSourceMessageBySession
              .get(submittingSessionId)
              ?.has(resultRunId) === true
          );
        if (
          queueSubmission === false
          && submittingSessionIsActive()
          && responseCanInstallCurrentLifecycle
        ) {
          this.context.uiStore.patch({ running: false });
        }
        if (
          failure.code === "CONTEXT_CHECKPOINT_PENDING"
          && result !== undefined
          && exactPendingQueueSubmission !== undefined
          && resultRunId !== undefined
          && responseCanInstallCurrentLifecycle
        ) {
          const settledQueueGraph = settlePendingQueueGraph("FAILED");
          await setResponseSessionState({
            started: true,
            acceptedRunId: resultRunId,
            acceptedRunMessageId: submissionMessageId,
            acceptedRunThreadId: threadId,
            acceptedRunPredecessorId: durableAcceptedQueuePredecessorId(
              exactPendingQueueSubmission!,
            ),
            pendingQueueSubmissions: settledQueueGraph.pendingQueueSubmissions,
            queuedRunReservations: settledQueueGraph.queuedRunReservations,
            terminalQueuedRuns: settledQueueGraph.terminalQueuedRuns,
            lastRunStatus: "FAILED",
            updatedAt: new Date().toISOString(),
          });
          this.recordAcceptedRunSource(
            submittingSessionId,
            resultRunId,
            submissionMessageId,
          );
          if (submittingSessionIsActive()) {
            this.context.uiStore.patch({ running: false });
          }
          await persistResponseSessionAndUi();
        }
        const recovery = responseCanInstallCurrentLifecycle
          && result !== undefined
          && requestAccepted
          ? await this.tryRecoverContextCheckpoint({
              failure,
              details: response.payload.error.details,
              input,
              submittedPendingWait,
              owner: {
                sessionId: submittingSessionId,
                profile: effectiveProfile,
                transcript: ownerTranscript,
                runnerMetadata: submittingRunnerMetadata,
              },
              ...(queueSubmission && (queueSettlementAlreadyHeld || releaseQueueSettlement !== undefined)
                ? { queueSettlement: { sessionId: submittingSessionId } }
                : {}),
            })
          : { recovered: false as const, error: undefined };
        if (recovery.recovered) {
          return true;
        }
        const settledQueueGraph = settlePendingQueueGraph(
          result === undefined ? undefined : "FAILED",
        );
        await setResponseSessionState({
          started: pendingSession.started || requestAccepted,
          updatedAt: new Date().toISOString(),
          ...(responseCanInstallCurrentLifecycle && requestAccepted
            ? { pendingWaitFor: undefined, lastRunStatus: "FAILED" as const }
            : {}),
          pendingManualCompaction: false,
          suppressAutoCompactionOnce: false,
          pendingRunRequestId: undefined,
          pendingRunId: undefined,
          pendingRunMessageId: undefined,
          pendingRunThreadId: undefined,
          pendingQueueSubmissions: settledQueueGraph.pendingQueueSubmissions,
          queuedRunReservations: settledQueueGraph.queuedRunReservations,
          ...(requestAccepted && resultRunId !== undefined && responseCanInstallCurrentLifecycle
            ? {
                acceptedRunId: resultRunId,
                acceptedRunMessageId: submissionMessageId,
                acceptedRunThreadId: threadId,
                acceptedRunPredecessorId: exactPendingQueueSubmission === undefined
                  ? undefined
                  : durableAcceptedQueuePredecessorId(exactPendingQueueSubmission),
              }
            : {}),
          terminalQueuedRuns: settledQueueGraph.terminalQueuedRuns,
        });
        const runFailedLine =
          failure.message === undefined
            ? `Run failed: ${failure.code}`
            : `Run failed: ${failure.code} ${failure.message}`;
        if (
          responseCanInstallCurrentLifecycle
          && (submittingSessionIsActive() || result === undefined || requestAccepted === false)
        ) {
          await appendResponseHistoryLine(
            "system",
            runFailedLine,
            result === undefined || requestAccepted === false ? undefined : {
              kind: "runtime.terminal.v1",
              runId: result.output.runId,
              terminalStatus: "failed",
            },
            requestAccepted ? result?.output : undefined,
            requestAccepted && result?.output.runId !== undefined
              ? `terminal:${result.output.runId}`
              : requestAccepted && response.runId !== undefined
                ? `terminal:${response.runId}`
                : undefined,
          );
        } else if (responseCanInstallCurrentLifecycle && requestAccepted && result !== undefined) {
          await this.context.applyTerminalResult(result.output.sessionId, result);
        }
        await this.appendRunFailureDiagnostics(
          result?.output.errors[0] ?? {
            code: failure.code,
            ...(failure.message !== undefined ? { message: failure.message } : {}),
          },
        );
        if (
          submittingSessionIsActive()
          && responseCanInstallCurrentLifecycle
          && (queueSubmission === false || requestAccepted)
        ) {
          this.context.uiStore.patch({
            running: false,
            statusLine: this.context.withMcpSummary("failed"),
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
        }
        await persistResponseSessionAndUi();
        await this.appendTerminalHandoffDiagnostics({
          scope: "terminal_handoff.persist_completed",
          summary: "TUI persisted failed terminal state for the active run.",
          details: {
            ...(terminalResponseMeta ?? {}),
            branch: "run.failed",
          },
        });
        return requestAccepted;
      }

      const output = response.payload.result.output;
      requestAccepted = true;
      const settledQueueGraph = settlePendingQueueGraph(
        output.status === "COMPLETED" || output.status === "FAILED"
          ? output.status
          : undefined,
      );
      await setResponseSessionState({
        started: true,
        updatedAt: new Date().toISOString(),
        ...(responseCanInstallCurrentLifecycle
          ? {
              pendingWaitFor: output.status === "WAITING" ? output.waitFor : undefined,
              lastRunStatus: output.status,
            }
          : {}),
        pendingManualCompaction: false,
        suppressAutoCompactionOnce: false,
        pendingRunRequestId: undefined,
        pendingRunId: undefined,
        pendingRunMessageId: undefined,
        pendingRunThreadId: undefined,
        pendingQueueSubmissions: settledQueueGraph.pendingQueueSubmissions,
        queuedRunReservations: settledQueueGraph.queuedRunReservations,
        ...(responseCanInstallCurrentLifecycle
          ? {
              acceptedRunId: output.runId,
              acceptedRunMessageId: submissionMessageId,
              acceptedRunThreadId: threadId,
              acceptedRunPredecessorId: exactPendingQueueSubmission === undefined
                ? undefined
                : durableAcceptedQueuePredecessorId(exactPendingQueueSubmission),
            }
          : {}),
        terminalQueuedRuns: settledQueueGraph.terminalQueuedRuns,
        ...(responseCanInstallCurrentLifecycle
          ? {
              operatorState: this.context.buildSessionOperatorState({
                session: pendingSession,
                profile: effectiveProfile,
                runtime: response.payload.result.operatorAffordance,
              }),
            }
          : {}),
      });
      this.recordAcceptedRunSource(output.sessionId, output.runId, submissionMessageId);

      if (output.continuation?.outcome === "granted") {
        if (responseCanInstallCurrentLifecycle) {
          await appendResponseHistoryLine(
            "system",
            "Continuation approved. Resuming from the checkpoint.",
          );
        }
      }

      if (output.status === "WAITING") {
        const waitEvent = output.waitFor?.eventType ?? "unknown";
        const shouldAppendWaitLine = isSameWaitFor(pendingWait, output.waitFor) === false;
        if (shouldAppendWaitLine && responseCanInstallCurrentLifecycle) {
          await this.context.applyTerminalResult(output.sessionId, response.payload.result);
        }
        if (submittingSessionIsActive() && responseCanInstallCurrentLifecycle) {
          this.context.uiStore.patch({
            running: false,
            statusLine: this.context.withMcpSummary(`waiting (${waitEvent})`),
          });
        }
        await persistResponseSessionAndUi();
        await this.appendTerminalHandoffDiagnostics({
          scope: "terminal_handoff.persist_completed",
          summary: "TUI persisted waiting terminal state for the active run.",
          details: {
            ...(terminalResponseMeta ?? {}),
            branch: "waiting",
            waitEvent,
          },
        });
        return true;
      }

      if (output.status === "FAILED") {
        const summary = output.errors[0];
        if (responseCanInstallCurrentLifecycle) {
          await this.context.applyTerminalResult(output.sessionId, response.payload.result);
          await this.appendRunFailureDiagnostics(summary);
        }
        if (submittingSessionIsActive() && responseCanInstallCurrentLifecycle) {
          this.context.uiStore.patch({
            running: false,
            statusLine: this.context.withMcpSummary("failed"),
            errorOverlay: {
              message: summary?.message ?? "Run failed",
              code: summary?.code,
              details: asRecord(summary?.details),
            },
            errorScrollOffset: 0,
          });
        }
        await persistResponseSessionAndUi();
        await this.appendTerminalHandoffDiagnostics({
          scope: "terminal_handoff.persist_completed",
          summary: "TUI persisted failed output state for the active run.",
          details: {
            ...(terminalResponseMeta ?? {}),
            branch: "output_failed",
            errorCode: summary?.code,
          },
        });
        return true;
      }

      const assistantText = response.payload.result.assistantText;
      if (responseCanInstallCurrentLifecycle) {
        await this.context.applyTerminalResult(
          output.sessionId,
          response.payload.result,
          response.payload.result.finalizedPayload,
        );
      }
      if (assistantText !== null && responseCanInstallCurrentLifecycle) {
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

      if (submittingSessionIsActive() && responseCanInstallCurrentLifecycle) {
        this.context.uiStore.patch({
          running: false,
          statusLine: this.context.withMcpSummary("completed"),
        });
      }
      if (
        submittingSessionIsActive()
        && responseCanInstallCurrentLifecycle
        && this.context.options.scripted === true
      ) {
        await appendResponseHistoryLine("system", "Run Completed");
      }
      await persistResponseSessionAndUi();
      await this.appendTerminalHandoffDiagnostics({
        scope: "terminal_handoff.persist_completed",
        summary: "TUI persisted completed terminal state for the active run.",
        details: {
          ...(terminalResponseMeta ?? {}),
          branch: "completed",
        },
      });
      return true;
    } catch (error) {
      try {
      if (
        queueSubmission
        && queueSettlementAlreadyHeld === false
        && releaseQueueSettlement === undefined
      ) {
          releaseQueueSettlement = await this.acquireQueueJournalTransaction(submittingSessionId);
        }
        const authoritativeRejection = readAuthoritativeRunStartRejection(error);
        if (readSubmittingSession() === undefined) {
          await this.context.appendDiagnosticsLog({
            scope: "submission.owner_deleted_during_response",
            summary: "Stopped response recovery because the captured submitting session was deleted.",
            details: JSON.stringify({ sessionId: submittingSessionId, messageId: submissionMessageId }),
          });
          return false;
        }
      if (queueSubmission) {
        if (authoritativeRejection !== undefined) {
          const currentSession = readSubmittingSession();
          const pendingQueueSubmission = findPendingQueueSubmission(
            currentSession?.pendingQueueSubmissions,
            reservedRunId!,
            threadId,
            submissionMessageId,
          );
          const currentGraph = currentSession === undefined
            ? undefined
            : normalizeTuiQueueGraph(currentSession);
          const rewired = currentGraph === undefined || pendingQueueSubmission === undefined
            ? currentGraph
            : removeAndRewireTuiQueueRecord(currentGraph, pendingQueueSubmission);
          await setResponseSessionState({
            pendingRunId: undefined,
            pendingRunMessageId: undefined,
            pendingRunThreadId: undefined,
            pendingQueueSubmissions: rewired?.pendingQueueSubmissions,
            queuedRunReservations: rewired?.queuedRunReservations,
            terminalQueuedRuns: rewired?.terminalQueuedRuns,
            updatedAt: new Date().toISOString(),
          });
          if (submittingSessionIsActive()) {
            this.context.uiStore.patch({
              running: state.running,
              statusLine: state.statusLine,
              errorOverlay: {
                message: authoritativeRejection.message,
                code: authoritativeRejection.code,
                details: authoritativeRejection.details,
              },
              errorScrollOffset: 0,
            });
          }
          await persistResponseSessionAndUi();
          return false;
        }
        const recoveredView = await this.requestConversationView(threadId).catch(() => undefined);
        const recoveredRoutes = recoveredView?.conversationMessageRoutes?.filter(
          (route) => route.messageId === submissionMessageId,
        ) ?? [];
        const recoveredRoute = recoveredRoutes.length === 1 ? recoveredRoutes[0] : undefined;
        const recoveredPendingQueueSubmission = queueSubmission
          ? findPendingQueueSubmission(
              readSubmittingSession()?.pendingQueueSubmissions,
              reservedRunId!,
              threadId,
              submissionMessageId,
            )
          : undefined;
        const recoveredRouteRunId = recoveredRoute?.runId;
        const recoveredRunStatus = recoveredRouteRunId === undefined || recoveredView === undefined
          ? undefined
          : exactRunStatusFromView(recoveredView, recoveredRouteRunId);
        const exactRecoveredRoute = recoveredRoute?.disposition === "queued"
          ? recoveredRouteRunId === undefined || recoveredRouteRunId === reservedRunId
          : recoveredRouteRunId === reservedRunId
            && recoveredRunStatus !== undefined
            && recoveredPendingQueueSubmission !== undefined
            && hasExactQueuedRunEvidence(recoveredView!, {
              ...recoveredPendingQueueSubmission,
              status: recoveredRunStatus,
            });
        if (
          recoveredView !== undefined
          && recoveredView.thread.sessionId === submittingSessionId
          && recoveredView.thread.threadId === threadId
          && recoveredView.conversationMessageRoutes !== undefined
          && recoveredRoute === undefined
        ) {
          const currentSession = readSubmittingSession();
          const pendingQueueSubmission = findPendingQueueSubmission(
            currentSession?.pendingQueueSubmissions,
            reservedRunId!,
            threadId,
            submissionMessageId,
          );
          if (currentSession !== undefined && pendingQueueSubmission !== undefined) {
            const rewired = removeAndRewireTuiQueueRecord(
              normalizeTuiQueueGraph(currentSession),
              pendingQueueSubmission,
            );
            const recoveredStateCommitted = await setResponseSessionState({
              pendingQueueSubmissions: rewired.pendingQueueSubmissions,
              queuedRunReservations: rewired.queuedRunReservations,
              terminalQueuedRuns: rewired.terminalQueuedRuns,
              updatedAt: new Date().toISOString(),
            }).then(() => true, () => false);
            if (recoveredStateCommitted === false) return false;
            this.clearIndeterminateQueueRecord(
              submittingSessionId,
              reservedRunId!,
              submissionMessageId,
              threadId,
            );
            await persistResponseSessionAndUi();
          }
          return false;
        }
        if (
          recoveredView !== undefined
          && recoveredView.thread.sessionId === submittingSessionId
          && recoveredView.thread.threadId === threadId
          && recoveredRoute !== undefined
          && exactRecoveredRoute
        ) {
          const authoritativeRunActive = recoveredView.activeRun?.status === "RUNNING";
          const terminalStatus = recoveredRunStatus === "COMPLETED" || recoveredRunStatus === "FAILED"
            ? recoveredRunStatus
            : undefined;
          const sessionBeforeRecovery = readSubmittingSession();
          const pendingBeforeRecovery = findPendingQueueSubmission(
            sessionBeforeRecovery?.pendingQueueSubmissions,
            reservedRunId!,
            threadId,
            submissionMessageId,
          );
          const recoveredLifecycleConflicts = recoveredRoute.disposition !== "queued"
            && recoveredRouteRunId !== undefined
            && (
              pendingBeforeRecovery === undefined
              || sessionBeforeRecovery === undefined
              || queuedEvidenceCanReplaceAcceptedRun(
                sessionBeforeRecovery,
                pendingBeforeRecovery,
              ) === false
            );
          if (recoveredRoute.disposition === "queued") {
            const currentSession = readSubmittingSession();
            const pendingQueueSubmission = findPendingQueueSubmission(
              currentSession?.pendingQueueSubmissions,
              reservedRunId!,
              threadId,
              submissionMessageId,
            );
            await setResponseSessionState({
              started: true,
              focusedThreadId: recoveredView.thread.threadId,
              pendingRunId: undefined,
              pendingRunMessageId: undefined,
              pendingRunThreadId: undefined,
              queuedRunReservations: appendQueuedRunReservation(
                currentSession?.queuedRunReservations,
                pendingQueueSubmission!,
              ),
              pendingQueueSubmissions: pendingQueueSubmission === undefined
                ? currentSession?.pendingQueueSubmissions
                : removePendingQueueSubmission(
                    currentSession?.pendingQueueSubmissions,
                    pendingQueueSubmission,
                  ),
              updatedAt: new Date().toISOString(),
            });
          } else if (recoveredRouteRunId !== undefined) {
            const currentSession = readSubmittingSession();
            const pendingQueueSubmission = findPendingQueueSubmission(
              currentSession?.pendingQueueSubmissions,
              reservedRunId!,
              threadId,
              submissionMessageId,
            );
            if (recoveredLifecycleConflicts && terminalStatus === undefined) {
              await persistResponseSessionAndUi();
              return false;
            }
            requestAccepted = true;
            const recoveredLifecycleCommitted = await setResponseSessionState({
              started: true,
              focusedThreadId: recoveredView.thread.threadId,
              pendingRunId: undefined,
              pendingRunMessageId: undefined,
              pendingRunThreadId: undefined,
              acceptedRunId: recoveredLifecycleConflicts
                ? currentSession?.acceptedRunId
                : recoveredRouteRunId,
              acceptedRunMessageId: recoveredLifecycleConflicts
                ? currentSession?.acceptedRunMessageId
                : submissionMessageId,
              acceptedRunThreadId: recoveredLifecycleConflicts
                ? currentSession?.acceptedRunThreadId
                : threadId,
              acceptedRunPredecessorId: recoveredLifecycleConflicts
                ? currentSession?.acceptedRunPredecessorId
                : pendingQueueSubmission === undefined
                  ? undefined
                  : durableAcceptedQueuePredecessorId(pendingQueueSubmission),
              pendingWaitFor: recoveredLifecycleConflicts
                ? currentSession?.pendingWaitFor
                : recoveredRunStatus === "WAITING"
                  ? recoveredView.thread.waitFor
                  : undefined,
              lastRunStatus: recoveredLifecycleConflicts
                ? currentSession?.lastRunStatus
                : recoveredRunStatus === "RUNNING"
                  ? undefined
                  : recoveredRunStatus,
              terminalQueuedRuns: terminalStatus === undefined || pendingQueueSubmission === undefined
                ? currentSession?.terminalQueuedRuns
                : appendTerminalQueuedRun(currentSession?.terminalQueuedRuns, {
                    ...toQueuedRunReservation(pendingQueueSubmission),
                    status: terminalStatus,
                  }),
              pendingQueueSubmissions: pendingQueueSubmission === undefined
                ? currentSession?.pendingQueueSubmissions
                : removePendingQueueSubmission(
                    currentSession?.pendingQueueSubmissions,
                    pendingQueueSubmission,
                  ),
              updatedAt: new Date().toISOString(),
            }).then(() => true, () => false);
            if (recoveredLifecycleCommitted === false) return false;
            this.recordAcceptedRunSource(
              submittingSessionId,
              recoveredRouteRunId,
              submissionMessageId,
            );
          }
          if (
            recoveredLifecycleConflicts === false
            && await this.installConversationView(recoveredView, { preserveSessionLifecycle: true }) === false
          ) return false;
          if (
            recoveredLifecycleConflicts === false
            && authoritativeRunActive === false
            && (terminalStatus === "COMPLETED" || terminalStatus === "FAILED")
          ) {
            const submittingSession = readSubmittingSession();
            if (submittingSession !== undefined) {
              await this.context.recoverTerminalMessages(submittingSession);
            }
          }
          if (submittingSessionIsActive() && recoveredLifecycleConflicts === false) {
            this.context.uiStore.patch({
              running: authoritativeRunActive,
              statusLine: this.context.withMcpSummary(
                recoveredRoute.disposition === "queued"
                  ? "queued behind current work"
                  : recoveredRunStatus === "WAITING"
                    ? `waiting (${recoveredView.thread.waitFor?.eventType ?? "input"})`
                  : terminalStatus === "FAILED"
                    ? "failed"
                    : terminalStatus === "COMPLETED"
                      ? "completed"
                      : authoritativeRunActive ? "running" : "ready",
              ),
            });
          }
          await persistResponseSessionAndUi();
          return true;
        }
        const message = error instanceof Error ? error.message : String(error);
        await appendResponseHistoryLine(
          "system",
          `Queue submission could not be confirmed: ${message}`,
        );
        if (submittingSessionIsActive()) {
          this.context.uiStore.patch({
            running: state.running,
            statusLine: state.statusLine,
            errorOverlay: {
              message,
              code: "QUEUE_SUBMISSION_ERROR",
            },
            errorScrollOffset: 0,
          });
        }
        await persistResponseSessionAndUi();
        return false;
      }
      if (
        resumeRequestId !== undefined
        && responseIdentityRejected === false
        && authoritativeRejection === undefined
      ) {
        const recovered = await this.context.client.sendCommand(
          "operator.thread",
          { threadId },
          this.context.getActiveRunnerMetadata(),
        ).catch(() => undefined);
        const recoveredView = recovered?.type === "operator.thread"
          ? recovered.payload.view
          : undefined;
        const exactRoute = recoveredView?.conversationMessageRoutes?.find(
          (route) => route.requestId === resumeRequestId && route.runId !== undefined,
        );
        const exactRunId = exactRoute?.runId;
        const viewIdentityMatches = recoveredView !== undefined
          && recoveredView.thread.sessionId === submittingSessionId
          && recoveredView.thread.threadId === threadId;
        const activeRunMatches = exactRunId !== undefined
          && recoveredView?.activeRun?.runId === exactRunId;
        const recoveredRunStatus = exactRunId === undefined || recoveredView === undefined
          ? undefined
          : exactRunStatusFromView(recoveredView, exactRunId);
        const terminalRunMatches = recoveredRunStatus === "COMPLETED" || recoveredRunStatus === "FAILED";
        if (
          recoveredView !== undefined
          && exactRoute !== undefined
          && exactRunId !== undefined
          && viewIdentityMatches
          && (activeRunMatches || terminalRunMatches)
        ) {
          const waiting = recoveredRunStatus === "WAITING";
          requestAccepted = true;
          if (await this.installConversationView(recoveredView) === false) return false;
          if (readSubmittingSession()?.delegation !== undefined) {
            await this.context.syncBackgroundSessionProgress({
              sessionId: submittingSessionId,
              threadId,
              runId: exactRunId,
              messageId: submissionMessageId,
              requestId: resumeRequestId,
              status: recoveredRunStatus ?? "RUNNING",
              waitFor: recoveredView.thread.waitFor,
            });
          }
          this.recordAcceptedRunSource(
            submittingSessionId,
            exactRunId,
            submissionMessageId,
          );
          await setResponseSessionState({
            started: true,
            focusedThreadId: threadId,
            pendingWaitFor: recoveredView.thread.waitFor,
            pendingRunRequestId: undefined,
            pendingRunThreadId: undefined,
            acceptedRunId: exactRunId,
            acceptedRunMessageId: submissionMessageId,
            acceptedRunThreadId: threadId,
            acceptedRunPredecessorId: undefined,
            lastRunStatus: terminalRunMatches ? recoveredRunStatus : undefined,
            updatedAt: new Date().toISOString(),
          });
          const responseOwner = readSubmittingSession();
          if (terminalRunMatches && responseOwner?.delegation === undefined && responseOwner !== undefined) {
            await this.context.recoverTerminalMessages(responseOwner);
          }
          if (submittingSessionIsActive()) this.context.uiStore.patch({
            running: terminalRunMatches ? false : waiting === false,
            statusLine: this.context.withMcpSummary(
              terminalRunMatches
                ? recoveredRunStatus.toLowerCase()
                : waiting
                ? `waiting (${recoveredView.thread.waitFor?.eventType ?? "input"})`
                : "running",
            ),
            errorOverlay: undefined,
            errorScrollOffset: 0,
          });
          await persistResponseSessionAndUi();
          return true;
        }
        const message = error instanceof Error ? error.message : String(error);
        await appendResponseHistoryLine(
          "system",
          `Reply submission status is still being reconciled: ${message}`,
        );
        await setResponseSessionState({
          pendingWaitFor: undefined,
          pendingRunRequestId: resumeRequestId,
          pendingRunThreadId: threadId,
          updatedAt: new Date().toISOString(),
          pendingManualCompaction: false,
          suppressAutoCompactionOnce: false,
        });
        if (submittingSessionIsActive()) this.context.uiStore.patch({
          running: false,
          statusLine: this.context.withMcpSummary("recovering submission"),
          errorOverlay: {
            message,
            code: "RUN_ACCEPTANCE_UNCONFIRMED",
          },
          errorScrollOffset: 0,
        });
        await persistResponseSessionAndUi();
        return false;
      }
      if (
        resumeRequestId === undefined
        && responseIdentityRejected === false
        && authoritativeRejection === undefined
      ) {
        const recoveredView = await this.requestConversationView(threadId).catch(() => undefined);
        if (
          recoveredView !== undefined
          && recoveredView.thread.sessionId === submittingSessionId
          && recoveredView.thread.threadId === threadId
        ) {
          if (await this.installConversationView(recoveredView) === false) return false;
          await setResponseSessionState({
            started: true,
            focusedThreadId: recoveredView.thread.threadId,
            updatedAt: new Date().toISOString(),
          });
        }
        const recoveredRoutes = recoveredView?.conversationMessageRoutes?.filter(
          (route) => route.messageId === submissionMessageId,
        ) ?? [];
        const recoveredRoute = recoveredRoutes.length === 1 ? recoveredRoutes[0] : undefined;
        const finalRecoveredPendingQueueSubmission = queueSubmission
          ? findPendingQueueSubmission(
              readSubmittingSession()?.pendingQueueSubmissions,
              reservedRunId!,
              threadId,
              submissionMessageId,
            )
          : undefined;
        const exactAcceptedRun = [...(
          this.acceptedRunSourceMessageBySession.get(submittingSessionId)?.entries() ?? []
        )].find(([runId, sourceMessageId]) =>
          runId === reservedRunId && sourceMessageId === submissionMessageId
        );
        const recoveredRouteRunId = recoveredRoute?.runId;
        const recoveredRunStatus = recoveredRouteRunId === undefined || recoveredView === undefined
          ? undefined
          : exactRunStatusFromView(recoveredView, recoveredRouteRunId);
        const exactRecoveredRoute = recoveredRouteRunId === reservedRunId
          && recoveredRunStatus !== undefined
          && (
            finalRecoveredPendingQueueSubmission === undefined
            || hasExactQueuedRunEvidence(recoveredView!, {
              ...finalRecoveredPendingQueueSubmission,
              status: recoveredRunStatus,
            })
          );
        if (
          recoveredView !== undefined
          && recoveredView.thread.sessionId === submittingSessionId
          && recoveredView.thread.threadId === threadId
          && recoveredRoute !== undefined
          && exactRecoveredRoute
        ) {
          if (await this.installConversationView(recoveredView) === false) return false;
          await setResponseSessionState({
            started: true,
            focusedThreadId: recoveredView.thread.threadId,
            updatedAt: new Date().toISOString(),
          });
          const authoritativeRunActive = recoveredView.activeRun?.status === "RUNNING";
          const terminalStatus = recoveredView.thread.lastRunStatus
            ?? (recoveredView.thread.status === "COMPLETED" || recoveredView.thread.status === "FAILED"
              ? recoveredView.thread.status
              : undefined);
          if (
            authoritativeRunActive === false
            && (terminalStatus === "COMPLETED" || terminalStatus === "FAILED")
          ) {
            const responseOwner = readSubmittingSession();
            if (responseOwner !== undefined) await this.context.recoverTerminalMessages(responseOwner);
          }
          requestAccepted = true;
          this.recordAcceptedRunSource(
            submittingSessionId,
            recoveredRouteRunId,
            submissionMessageId,
          );
          await setResponseSessionState({
            pendingRunId: undefined,
            pendingRunMessageId: undefined,
            pendingRunThreadId: undefined,
            acceptedRunId: recoveredRouteRunId,
            acceptedRunMessageId: submissionMessageId,
            acceptedRunThreadId: threadId,
            acceptedRunPredecessorId: finalRecoveredPendingQueueSubmission === undefined
              ? undefined
              : durableAcceptedQueuePredecessorId(finalRecoveredPendingQueueSubmission),
            updatedAt: new Date().toISOString(),
          });
          if (submittingSessionIsActive()) this.context.uiStore.patch({
            running: authoritativeRunActive,
            statusLine: this.context.withMcpSummary(
              terminalStatus === "WAITING"
                ? `waiting (${recoveredView.thread.waitFor?.eventType ?? "input"})`
                : terminalStatus === "FAILED"
                  ? "failed"
                  : terminalStatus === "COMPLETED"
                    ? "completed"
                    : authoritativeRunActive ? "running" : "ready",
            ),
          });
          await persistResponseSessionAndUi();
          return true;
        }
        if (exactAcceptedRun !== undefined) {
          await setResponseSessionState({
            started: true,
            pendingRunId: undefined,
            pendingRunMessageId: undefined,
            pendingRunThreadId: undefined,
            acceptedRunId: exactAcceptedRun[0],
            acceptedRunMessageId: submissionMessageId,
            acceptedRunThreadId: threadId,
            acceptedRunPredecessorId: finalRecoveredPendingQueueSubmission === undefined
              ? undefined
              : durableAcceptedQueuePredecessorId(finalRecoveredPendingQueueSubmission),
            updatedAt: new Date().toISOString(),
          });
          await persistResponseSessionAndUi();
          return true;
        }
        const described = await this.context.client.sendCommand("session.describe", {
          sessionId: submittingSessionId,
        }).catch(() => undefined);
        if (
          described?.type === "session.described"
          && (
            described.payload.threadId !== undefined
            || described.payload.focusedThreadId !== undefined
            || described.payload.activeAssembly !== undefined
          )
        ) {
          await this.context.syncSessionFromDescribePayload(described.payload);
        }
      }
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
      if (resumeRequestId === undefined && requestAccepted === false && authoritativeRejection !== undefined) {
        await appendResponseHistoryLine(
          "system",
          `Run rejected before acceptance: ${authoritativeRejection.message}`,
        );
        await setResponseSessionState({
          started: readSubmittingSession()?.started ?? false,
          pendingRunId: undefined,
          pendingRunMessageId: undefined,
          pendingRunThreadId: undefined,
          lastRunStatus: "FAILED",
          updatedAt: new Date().toISOString(),
          pendingManualCompaction: false,
        });
        if (submittingSessionIsActive()) this.context.uiStore.patch({
          running: false,
          statusLine: this.context.withMcpSummary("failed"),
          errorOverlay: {
            message: authoritativeRejection.message,
            code: authoritativeRejection.code,
            details: authoritativeRejection.details,
          },
          errorScrollOffset: 0,
        });
        await persistResponseSessionAndUi();
        return false;
      }
      if (resumeRequestId === undefined && requestAccepted === false) {
        await appendResponseHistoryLine(
          "system",
          `Run submission status is still being reconciled: ${message}`,
        );
        await setResponseSessionState({
          updatedAt: new Date().toISOString(),
          pendingManualCompaction: false,
          suppressAutoCompactionOnce: false,
        });
        if (submittingSessionIsActive()) this.context.uiStore.patch({
          running: false,
          statusLine: this.context.withMcpSummary("recovering submission"),
          errorOverlay: {
            message,
            code: "RUN_ACCEPTANCE_UNCONFIRMED",
          },
          errorScrollOffset: 0,
        });
        await persistResponseSessionAndUi();
        return false;
      }
      await appendResponseHistoryLine("system", `Runner communication failed: ${message}`);
      await setResponseSessionState({
        started: (readSubmittingSession()?.started ?? false) || requestAccepted,
        updatedAt: new Date().toISOString(),
        ...(input.forceFreshTurn !== true && submittedPendingWait !== undefined && requestAccepted === false
          ? { pendingWaitFor: submittedPendingWait }
          : {}),
        lastRunStatus: "FAILED",
        pendingManualCompaction: false,
      });
      if (submittingSessionIsActive()) this.context.uiStore.patch({
        running: false,
        statusLine: this.context.withMcpSummary("failed"),
        errorOverlay: {
          message,
          code: "RUNNER_RUNTIME_ERROR",
        },
        errorScrollOffset: 0,
      });
        await persistResponseSessionAndUi();
        return requestAccepted;
      } catch (recoveryError) {
        if (recoveryError instanceof SubmissionOwnerDeletedError) {
          await this.context.appendDiagnosticsLog({
            scope: "submission.owner_deleted_during_recovery",
            summary: "Stopped response recovery because the captured submitting session was deleted.",
            details: JSON.stringify({ sessionId: submittingSessionId, messageId: submissionMessageId }),
          });
          return false;
        }
        throw recoveryError;
      }
    } finally {
      releaseQueueSettlement?.();
    }
  }

  private async resolveSessionEnvironment(
    session: TuiSessionMeta,
  ): Promise<TuiEnvironmentPresetId> {
    try {
      if (session.started === false) {
        const environmentPresetId = resolveTuiSessionEnvironment({ session });
        if (session.environmentPresetId !== environmentPresetId) {
          await this.context.setSessionState(session.sessionId, { environmentPresetId });
        }
        return environmentPresetId;
      }
      const response = await this.context.client.sendCommand("session.describe", {
        sessionId: session.sessionId,
      });
      if (response.type !== "session.described") {
        throw new TuiEnvironmentIdentityError(
          "TUI_ENVIRONMENT_UNKNOWN",
          `Environment unknown for session '${session.name}': runtime identity could not be described.`,
        );
      }
      if (response.payload.sessionId !== session.sessionId) {
        throw new TuiEnvironmentIdentityError(
          "TUI_ENVIRONMENT_UNKNOWN",
          `Environment unknown for session '${session.name}': runtime described a different session.`,
        );
      }
      const environmentPresetId = resolveTuiSessionEnvironment({
        session,
        runtimeEnvironmentPresetId: response.payload.activeAssembly?.environmentPresetId,
        requireRuntimeIdentity: true,
      });
      await this.context.setSessionState(session.sessionId, {
        environmentPresetId,
        ...(response.payload.activeAssembly?.bundleId !== undefined
          ? { effectiveAssemblyId: response.payload.activeAssembly.bundleId }
          : {}),
        ...(response.payload.activeAssembly?.label !== undefined
          ? { effectiveAssemblyLabel: response.payload.activeAssembly.label }
          : {}),
      });
      return environmentPresetId;
    } catch (error) {
      const identityError = error instanceof TuiEnvironmentIdentityError
        ? error
        : readTuiEnvironmentIdentityFailure(error) ?? new TuiEnvironmentIdentityError(
            "TUI_ENVIRONMENT_UNKNOWN",
            `Environment unknown for session '${session.name}': runtime identity could not be verified.`,
          );
      await this.context.appendDiagnosticsLog({
        scope: "tui.environment_identity",
        summary: identityError.message,
        details: JSON.stringify({
          code: identityError.code,
          sessionId: session.sessionId,
          persistedEnvironmentPresetId: session.environmentPresetId,
          cause: error instanceof Error ? error.message : String(error),
          ...(identityError.details !== undefined
            ? { failureDetails: identityError.details }
            : {}),
        }),
      });
      throw identityError;
    }
  }

  private async tryRecoverContextCheckpoint(input: {
    failure: { code: string; message?: string | undefined };
    details?: Record<string, unknown> | undefined;
    input: StartActiveTurnInput;
    submittedPendingWait: TuiSessionMeta["pendingWaitFor"];
    owner: CapturedSubmissionOwner;
    queueSettlement?: QueueSettlementLease | undefined;
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
      if (this.context.uiStore.getState().sessions.some(
        (session) => session.sessionId === input.owner.sessionId,
      ) === false) {
        throw new Error("The checkpoint submission owner no longer exists.");
      }
      const response = await this.context.client.sendCommand("operator.control", {
        action: "resolve_context_checkpoint",
        threadId,
        checkpointId,
        actionValue: recommendedAction,
      }, input.owner.runnerMetadata);
      if (response.type !== "operator.controlled") {
        throw new Error(`Unexpected operator checkpoint recovery response '${response.type}'`);
      }
      if (this.context.uiStore.getState().sessions.some(
        (session) => session.sessionId === input.owner.sessionId,
      ) === false) {
        throw new Error("The checkpoint submission owner was deleted during recovery.");
      }
      await this.context.appendSessionHistoryLine(
        input.owner.sessionId,
        "system",
        recommendedAction === "compact"
          ? "Compacted context and continued."
          : "Summarized context forward and continued.",
      );
      if (input.input.forceFreshTurn !== true && input.submittedPendingWait !== undefined) {
        await this.context.setSessionState(input.owner.sessionId, {
          pendingWaitFor: input.submittedPendingWait,
          updatedAt: new Date().toISOString(),
        });
      }
      if (this.context.uiStore.getState().sessions.some(
        (session) => session.sessionId === input.owner.sessionId,
      ) === false) {
        throw new Error("The checkpoint submission owner was deleted before retry.");
      }
      const accepted = await this.startCapturedTurn({
        ...input.input,
        messageId: undefined,
        historyMessageId: input.input.historyMessageId ?? input.input.messageId,
        checkpointRecoveryAttempted: true,
      }, input.owner, input.queueSettlement);
      if (accepted === false) throw new Error("The checkpoint retry was not accepted.");
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
    if (
      event.type === "run.started"
      && (
        (event.sessionId !== undefined && event.sessionId !== event.payload.sessionId)
        || (
          event.runId !== undefined
          && event.payload.runId !== undefined
          && event.runId !== event.payload.runId
        )
      )
    ) return;
    const terminalIdentity = event.type === "run.completed" || event.type === "run.cancelled"
      ? {
          sessionId: event.payload.result.output.sessionId,
          runId: event.payload.result.output.runId,
        }
      : event.type === "run.failed"
        ? {
            sessionId: event.payload.result?.output.sessionId ?? event.sessionId,
            runId: event.payload.result?.output.runId ?? event.runId,
          }
        : undefined;
    if (
      terminalIdentity?.sessionId !== undefined
      && terminalIdentity.runId !== undefined
      && this.terminalEventThreadMatchesAcceptedRun(
        terminalIdentity.sessionId,
        terminalIdentity.runId,
        event.threadId,
      ) === false
    ) return;
    if (event.type === "run.completed" || event.type === "run.cancelled") {
      const output = event.payload.result.output;
      if (
        (event.sessionId !== undefined && event.sessionId !== output.sessionId)
        || (event.runId !== undefined && event.runId !== output.runId)
      ) return;
      const session = this.context.uiStore.getState().sessions.find(
        (candidate) => candidate.sessionId === output.sessionId,
      );
      if (
        session?.delegation !== undefined
        && session.acceptedRunId !== output.runId
        && findQueuedRunReservation(
          session.queuedRunReservations,
          output.runId,
          event.threadId,
        ) === undefined
      ) return;
    }
    if (event.type === "run.failed" && event.payload.result !== undefined) {
      const output = event.payload.result.output;
      if (
        (event.sessionId !== undefined && event.sessionId !== output.sessionId)
        || (event.runId !== undefined && event.runId !== output.runId)
      ) return;
      const session = this.context.uiStore.getState().sessions.find(
        (candidate) => candidate.sessionId === output.sessionId,
      );
      if (
        session?.delegation !== undefined
        && session.acceptedRunId !== output.runId
        && findQueuedRunReservation(
          session.queuedRunReservations,
          output.runId,
          event.threadId,
        ) === undefined
      ) return;
    }
    if (event.type === "run.progress") {
      const update = event.payload.update;
      if (
        (event.sessionId !== undefined && event.sessionId !== update.sessionId)
        || (event.runId !== undefined && event.runId !== update.runId)
      ) return;
      const session = this.context.uiStore.getState().sessions.find(
        (candidate) => candidate.sessionId === update.sessionId,
      );
      if (session?.delegation !== undefined && session.acceptedRunId !== update.runId) return;
    }
    if (
      event.type === "run.started"
      && event.sessionId !== undefined
      && event.runId !== undefined
    ) {
      const session = this.context.uiStore.getState().sessions.find(
        (candidate) => candidate.sessionId === event.sessionId,
      );
      const exactForegroundStart = session?.delegation === undefined
        && event.threadId !== undefined
        && event.payload.sourceMessageId !== undefined
        && session?.pendingRunId === event.runId
        && session?.pendingRunMessageId === event.payload.sourceMessageId
        && session.pendingRunThreadId === event.threadId;
      const exactQueuedForegroundStart = session?.delegation === undefined
        && event.threadId !== undefined
        && event.payload.sourceMessageId !== undefined
        && (
          findQueuedRunReservation(
            session?.queuedRunReservations,
            event.runId,
            event.threadId,
            event.payload.sourceMessageId,
          ) !== undefined
          || findPendingQueueSubmission(
            session?.pendingQueueSubmissions,
            event.runId,
            event.threadId,
            event.payload.sourceMessageId,
          ) !== undefined
        );
      const exactAcceptedForegroundStart = session?.delegation === undefined
        && event.threadId !== undefined
        && event.payload.sourceMessageId !== undefined
        && session?.acceptedRunId === event.runId
        && session.acceptedRunMessageId === event.payload.sourceMessageId
        && session.acceptedRunThreadId === event.threadId;
      const backgroundStatus = session?.delegation?.status;
      const exactPendingBackgroundStart = event.threadId !== undefined
        && session?.pendingRunThreadId === event.threadId
        && (
          session.pendingRunId === event.runId
          || (
            event.payload.sourceMessageId !== undefined
            && session.pendingRunMessageId === event.payload.sourceMessageId
          )
        );
      const exactQueuedBackgroundStart = event.threadId !== undefined
        && findQueuedRunReservation(
          session?.queuedRunReservations,
          event.runId,
          event.threadId,
          event.payload.sourceMessageId,
        ) !== undefined;
      const exactBackgroundStart = session?.delegation !== undefined
        && backgroundStatus !== "COMPLETED"
        && backgroundStatus !== "FAILED"
        && (
          exactPendingBackgroundStart
          || exactQueuedBackgroundStart
          || session.acceptedRunId === event.runId
        );
      if (
        exactForegroundStart === false
          && exactQueuedForegroundStart === false
          && exactAcceptedForegroundStart === false
          && exactBackgroundStart === false
      ) return;
      if (exactBackgroundStart) {
        this.applySharedActivityEvent(event);
        this.observedActiveRunBySession.set(event.sessionId, event.runId);
        const acceptedRuns = this.acceptedRunSourceMessageBySession.get(event.sessionId) ?? new Map();
        acceptedRuns.set(event.runId, event.payload.sourceMessageId);
        this.acceptedRunSourceMessageBySession.set(event.sessionId, acceptedRuns);
      }
      if (exactForegroundStart || exactQueuedForegroundStart || exactAcceptedForegroundStart) {
        void this.runQueueJournalTransaction(event.sessionId, async () => {
          const accepted = await this.context.syncForegroundSessionProgress({
            sessionId: event.sessionId,
            threadId: event.threadId!,
            runId: event.runId,
            messageId: event.payload.sourceMessageId!,
          });
          if (accepted === false) return;
          this.applySharedActivityEvent(event);
          this.observedActiveRunBySession.set(event.sessionId, event.runId);
          const acceptedRuns = this.acceptedRunSourceMessageBySession.get(event.sessionId) ?? new Map();
          acceptedRuns.set(event.runId, event.payload.sourceMessageId);
          this.acceptedRunSourceMessageBySession.set(event.sessionId, acceptedRuns);
        });
      }
      if (exactBackgroundStart) {
        void this.context.syncBackgroundSessionProgress({
          sessionId: event.payload.sessionId,
          threadId: event.threadId!,
          runId: event.runId,
          ...(event.payload.sourceMessageId !== undefined
            ? { messageId: event.payload.sourceMessageId }
            : {}),
        });
      }
    }
    if (
      event.type !== "run.started"
      && event.type !== "run.completed"
      && event.type !== "run.failed"
      && event.type !== "run.cancelled"
    ) this.applySharedActivityEvent(event);
    if (event.type === "operator.thread") {
      void this.installConversationView(event.payload.view);
      return;
    }
    if (event.type === "session.described" && event.payload.operatorThreadView !== undefined) {
      void this.installConversationView(event.payload.operatorThreadView);
    }
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
      if (
        (event.sessionId !== undefined && event.sessionId !== output.sessionId)
        || (event.runId !== undefined && event.runId !== output.runId)
      ) return;
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
      void this.runQueueJournalTransaction(output.sessionId, async () => {
        let terminalOwnsCurrentLifecycle = this.terminalEventOwnsCurrentLifecycle(
          output.sessionId,
          output.runId,
          event.threadId,
        );
        const queuedTerminalEvidence = this.foregroundQueuedTerminalEvidence(
          output.sessionId,
          output.runId,
          event.threadId,
        );
        const terminalWasCommitted = this.terminalLifecycleAlreadyCommitted(
          output.sessionId,
          output.runId,
        );
        const authoritativeView = (queuedTerminalEvidence || terminalOwnsCurrentLifecycle === false)
          && event.threadId !== undefined
          ? await this.requestConversationView(event.threadId).catch(() => undefined)
          : undefined;
        if (queuedTerminalEvidence && event.threadId !== undefined) {
          const synchronizedQueuedTerminal = await this.context.syncForegroundQueuedTerminal({
            sessionId: output.sessionId,
            threadId: event.threadId,
            runId: output.runId,
            result: event.payload.result,
            authoritativeView,
          });
          if (synchronizedQueuedTerminal === false) return;
          terminalOwnsCurrentLifecycle = this.terminalEventOwnsCurrentLifecycle(
            output.sessionId,
            output.runId,
            event.threadId,
          );
          if (terminalOwnsCurrentLifecycle === false) return;
        }
        const terminalOwnsActiveRun = this.recordTerminalEvent(
          output,
          event.ts,
          event.threadId,
          queuedTerminalEvidence && terminalWasCommitted === false,
        );
        if (terminalOwnsActiveRun) {
          this.applySharedActivityEvent(event);
          await this.context.syncBackgroundSessionResult(
            output.sessionId,
            output.runId,
            false,
            output,
            event.payload.result.assistantText,
            event.payload.result.finalizedPayload,
            event.payload.result.operatorAffordance,
          );
          if (queuedTerminalEvidence) {
            await this.context.applyTerminalResult(
              output.sessionId,
              event.payload.result,
              event.payload.result.finalizedPayload,
            );
          } else {
            await this.applyTerminalResultAndState(
              event.payload.result,
              terminalOwnsCurrentLifecycle,
              event.threadId,
            );
          }
        } else if (queuedTerminalEvidence && terminalWasCommitted && terminalOwnsCurrentLifecycle) {
          await this.context.applyTerminalResult(
            output.sessionId,
            event.payload.result,
            event.payload.result.finalizedPayload,
          );
        }
        if (event.threadId !== undefined && terminalOwnsCurrentLifecycle) {
          await this.refreshConversationView(event.threadId).catch(() => undefined);
        }
        if (
          terminalOwnsActiveRun
          && terminalOwnsCurrentLifecycle
          && this.context.uiStore.getState().activeSession.sessionId === output.sessionId
          && this.context.options.scripted === true
          && output.status === "COMPLETED"
        ) {
          await this.context.appendHistoryLine("system", "Run Completed");
        }
        if (
          terminalOwnsActiveRun
          && terminalOwnsCurrentLifecycle
          && this.context.uiStore.getState().activeSession.sessionId === output.sessionId
        ) {
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
        }
        await this.context.persistSessionAndUi();
      });
      return;
    }

    if (event.type === "run.failed") {
      const failedSessionId = event.payload.result?.output.sessionId ?? event.sessionId;
      const failedRunId = event.payload.result?.output.runId ?? event.runId;
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
        const output = event.payload.result.output;
        if (
          (event.sessionId !== undefined && event.sessionId !== output.sessionId)
          || (event.runId !== undefined && event.runId !== output.runId)
        ) return;
        void this.runQueueJournalTransaction(output.sessionId, async () => {
          let terminalOwnsCurrentLifecycle = this.terminalEventOwnsCurrentLifecycle(
            output.sessionId,
            output.runId,
            event.threadId,
          );
          const queuedTerminalEvidence = this.foregroundQueuedTerminalEvidence(
            output.sessionId,
            output.runId,
            event.threadId,
          );
          const terminalWasCommitted = this.terminalLifecycleAlreadyCommitted(
            output.sessionId,
            output.runId,
          );
          const authoritativeView = (queuedTerminalEvidence || terminalOwnsCurrentLifecycle === false)
            && event.threadId !== undefined
            ? await this.requestConversationView(event.threadId).catch(() => undefined)
            : undefined;
          if (queuedTerminalEvidence && event.threadId !== undefined) {
            const synchronizedQueuedTerminal = await this.context.syncForegroundQueuedTerminal({
              sessionId: output.sessionId,
              threadId: event.threadId,
              runId: output.runId,
              result: event.payload.result!,
              authoritativeView,
            });
            if (synchronizedQueuedTerminal === false) return;
            terminalOwnsCurrentLifecycle = this.terminalEventOwnsCurrentLifecycle(
              output.sessionId,
              output.runId,
              event.threadId,
            );
            if (terminalOwnsCurrentLifecycle === false) return;
          }
          const terminalOwnsActiveRun = this.recordTerminalEvent(
            output,
            event.ts,
            event.threadId,
            queuedTerminalEvidence && terminalWasCommitted === false,
          );
          if (terminalOwnsActiveRun) {
            this.applySharedActivityEvent(event);
            await this.context.syncBackgroundSessionFailure(
              output.sessionId,
              output.runId,
              output.sessionId,
              event.payload.error.message,
            );
            if (queuedTerminalEvidence) {
              await this.context.applyTerminalResult(
                output.sessionId,
                event.payload.result!,
                event.payload.result!.finalizedPayload,
              );
            } else {
              await this.applyTerminalResultAndState(
                event.payload.result!,
                terminalOwnsCurrentLifecycle,
                event.threadId,
              );
            }
          } else if (queuedTerminalEvidence && terminalWasCommitted && terminalOwnsCurrentLifecycle) {
            await this.context.applyTerminalResult(
              output.sessionId,
              event.payload.result!,
              event.payload.result!.finalizedPayload,
            );
          }
          if (event.threadId !== undefined && terminalOwnsCurrentLifecycle) {
            await this.refreshConversationView(event.threadId).catch(() => undefined);
          }
          if (
            terminalOwnsActiveRun
            && terminalOwnsCurrentLifecycle
            && this.context.uiStore.getState().activeSession.sessionId === output.sessionId
          ) {
            this.context.pushRunLog({
              timestamp: new Date().toISOString(),
              level: "ERROR",
              eventName: "run_failed",
              metadata: {
                message: event.payload.error.message,
                quality: output.quality,
                finalStep: output.finalStep,
                runId: output.runId,
              },
            });
          }
          await this.context.persistSessionAndUi();
        });
      } else if (failedSessionId !== undefined && failedRunId !== undefined) {
        void this.runQueueJournalTransaction(failedSessionId, async () => {
          if (this.terminalEventOwnsCurrentLifecycle(failedSessionId, failedRunId, event.threadId) === false) {
            return;
          }
          if (this.observedActiveRunBySession.get(failedSessionId) === failedRunId) {
            this.observedActiveRunBySession.delete(failedSessionId);
          }
          if (this.context.uiStore.getState().activeSession.sessionId === failedSessionId) {
            this.context.pushRunLog({
              timestamp: new Date().toISOString(),
              level: "ERROR",
              eventName: "run_failed",
              metadata: { message: event.payload.error.message },
            });
          }
        });
      }
      return;
    }

    if (event.type === "run.cancelled") {
      const output = event.payload.result.output;
      void this.runQueueJournalTransaction(output.sessionId, async () => {
        let terminalOwnsCurrentLifecycle = this.terminalEventOwnsCurrentLifecycle(
          output.sessionId,
          output.runId,
          event.threadId,
        );
        const queuedTerminalEvidence = this.foregroundQueuedTerminalEvidence(
          output.sessionId,
          output.runId,
          event.threadId,
        );
        const terminalWasCommitted = this.terminalLifecycleAlreadyCommitted(
          output.sessionId,
          output.runId,
        );
        const authoritativeView = (queuedTerminalEvidence || terminalOwnsCurrentLifecycle === false)
          && event.threadId !== undefined
          ? await this.requestConversationView(event.threadId).catch(() => undefined)
          : undefined;
        if (queuedTerminalEvidence && event.threadId !== undefined) {
          const synchronizedQueuedTerminal = await this.context.syncForegroundQueuedTerminal({
            sessionId: output.sessionId,
            threadId: event.threadId,
            runId: output.runId,
            result: event.payload.result,
            authoritativeView,
          });
          if (synchronizedQueuedTerminal === false) return;
          terminalOwnsCurrentLifecycle = this.terminalEventOwnsCurrentLifecycle(
            output.sessionId,
            output.runId,
            event.threadId,
          );
          if (terminalOwnsCurrentLifecycle === false) return;
        }
        const terminalOwnsActiveRun = this.recordTerminalEvent(
          output,
          event.ts,
          event.threadId,
          queuedTerminalEvidence && terminalWasCommitted === false,
        );
        if (terminalOwnsActiveRun) {
          this.applySharedActivityEvent(event);
          await this.context.syncBackgroundSessionFailure(
            output.sessionId,
            output.runId,
            output.sessionId,
            output.errors[0]?.message ?? "Run cancelled.",
          );
          if (queuedTerminalEvidence) {
            await this.context.applyTerminalResult(
              output.sessionId,
              event.payload.result,
              event.payload.result.finalizedPayload,
            );
          } else {
            await this.applyTerminalResultAndState(
              event.payload.result,
              terminalOwnsCurrentLifecycle,
              event.threadId,
            );
          }
        } else if (queuedTerminalEvidence && terminalWasCommitted && terminalOwnsCurrentLifecycle) {
          await this.context.applyTerminalResult(
            output.sessionId,
            event.payload.result,
            event.payload.result.finalizedPayload,
          );
        }
        if (event.threadId !== undefined && terminalOwnsCurrentLifecycle) {
          await this.refreshConversationView(event.threadId).catch(() => undefined);
        }
        if (
          terminalOwnsActiveRun
          && terminalOwnsCurrentLifecycle
          && this.context.uiStore.getState().activeSession.sessionId === output.sessionId
        ) {
          this.context.pushRunLog({
            timestamp: new Date().toISOString(),
            level: "INFO",
            eventName: "run_cancelled",
            runId: event.payload.result.output.runId,
          });
        }
        await this.context.persistSessionAndUi();
      });
      return;
    }

    if (event.type === "run.progress") {
      const update = event.payload.update;
      if (
        (event.sessionId !== undefined && event.sessionId !== update.sessionId)
        || (event.runId !== undefined && event.runId !== update.runId)
      ) return;
      const acceptedSession = this.context.uiStore.getState().sessions.find(
        (candidate) => candidate.sessionId === update.sessionId,
      );
      if (
        acceptedSession?.delegation !== undefined
        && acceptedSession.acceptedRunId === update.runId
      ) {
        void this.context.syncBackgroundSessionProgress({
          sessionId: update.sessionId,
          threadId: event.threadId ?? acceptedSession.focusedThreadId ?? update.sessionId,
          runId: update.runId,
        });
      }
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

    if (event.type === "run.agent_progress") {
      return;
    }

    if (event.type === "run.model.reasoning.delta") {
      return;
    }

    if (event.type === "run.model.reasoning.unavailable") {
      return;
    }

    if (
      event.type === "run.model.reasoning.started"
      || event.type === "run.model.reasoning.completed"
      || event.type === "run.model.reasoning.failed"
      || event.type === "run.tool.started"
      || event.type === "run.tool.completed"
      || event.type === "run.tool.failed"
    ) return;

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

  private applySharedActivityEvent(event: RunnerEvent): void {
    const update = asRecord((event.payload as unknown as Record<string, unknown>).update);
    const sessionId = event.sessionId
      ?? (typeof update?.sessionId === "string" ? update.sessionId : undefined);
    if (sessionId === undefined) return;
    const current = this.activityBySession.get(sessionId) ?? [];
    const terminalRunId = event.type === "run.completed"
      ? event.payload.result.output.runId
      : event.type === "run.failed"
        ? event.payload.result?.output.runId ?? event.runId
        : event.type === "run.cancelled"
          ? event.payload.result.output.runId
          : undefined;
    const next = terminalRunId === undefined
      ? reduceTuiConversationActivity(current, event)
      : current.filter((item) => item.runId !== terminalRunId);
    this.activityBySession.set(sessionId, next);
    if (this.context.uiStore.getState().activeSession.sessionId !== sessionId) return;
    const visible = next.filter((item) => item.visible !== false);
    const latest = visible[visible.length - 1];
    this.context.uiStore.patch({
      conversationActivity: visible,
      ...(latest === undefined
        ? {}
        : { statusLine: this.context.withMcpSummary(`${latest.label}: ${latest.text}`) }),
    });
  }

  private recordAcceptedRunSource(
    sessionId: string,
    runId: string,
    sourceMessageId: string | undefined,
  ): void {
    const acceptedRuns = this.acceptedRunSourceMessageBySession.get(sessionId) ?? new Map();
    acceptedRuns.set(runId, sourceMessageId);
    this.acceptedRunSourceMessageBySession.set(sessionId, acceptedRuns);
  }

  private async runQueueJournalTransaction<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queueJournalTailBySession.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.queueJournalTailBySession.set(sessionId, tail);
    try {
      return await current;
    } finally {
      if (this.queueJournalTailBySession.get(sessionId) === tail) {
        this.queueJournalTailBySession.delete(sessionId);
      }
    }
  }

  private async acquireQueueJournalTransaction(sessionId: string): Promise<() => void> {
    const previous = this.queueJournalTailBySession.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => undefined).then(() => gate);
    this.queueJournalTailBySession.set(sessionId, current);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.queueJournalTailBySession.get(sessionId) === current) {
        this.queueJournalTailBySession.delete(sessionId);
      }
    };
  }

  private async reconcileIndeterminateQueueJournal(sessionId: string): Promise<boolean> {
    const unsettled = this.indeterminateQueueJournalBySession.get(sessionId);
    if (unsettled === undefined) return true;
    for (const pending of unsettled) {
      const session = this.context.uiStore.getState().sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (session === undefined) return false;
      const normalizedQueue = normalizeTuiQueueGraph(session);
      const normalizedSession = { ...session, ...normalizedQueue };
      const currentPending = findPendingQueueSubmission(
        normalizedSession.pendingQueueSubmissions,
        pending.runId,
        pending.threadId,
        pending.messageId,
      );
      if (currentPending === undefined) continue;
      const view = await this.requestConversationView(pending.threadId).catch(() => undefined);
      if (
        view === undefined
        || view.thread.sessionId !== sessionId
        || view.thread.threadId !== pending.threadId
      ) return false;
      const route = view.conversationMessageRoutes?.find(
        (candidate) => candidate.messageId === pending.messageId,
      );
      if (view.conversationMessageRoutes === undefined) return false;
      const current = this.context.uiStore.getState().sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (current === undefined) return false;
      const currentGraph = normalizeTuiQueueGraph(current);
      const currentRecord = findPendingQueueSubmission(
        currentGraph.pendingQueueSubmissions,
        pending.runId,
        pending.threadId,
        pending.messageId,
      );
      if (currentRecord === undefined) continue;
      if (route === undefined) {
        const rewired = removeAndRewireTuiQueueRecord(currentGraph, currentRecord);
        await this.context.setSessionState(sessionId, {
          pendingQueueSubmissions: rewired.pendingQueueSubmissions,
          queuedRunReservations: rewired.queuedRunReservations,
          terminalQueuedRuns: rewired.terminalQueuedRuns,
          updatedAt: new Date().toISOString(),
        });
      } else if (route.disposition === "queued" && (route.runId === undefined || route.runId === pending.runId)) {
        await this.context.setSessionState(sessionId, {
          pendingQueueSubmissions: removePendingQueueSubmission(
            currentGraph.pendingQueueSubmissions,
            currentRecord,
          ),
          queuedRunReservations: appendQueuedRunReservation(
            currentGraph.queuedRunReservations,
            currentRecord,
          ),
          terminalQueuedRuns: currentGraph.terminalQueuedRuns,
          updatedAt: new Date().toISOString(),
        });
      } else if (route.runId === currentRecord.runId) {
        const status = exactRunStatusFromView(view, currentRecord.runId);
        if (status === undefined) return false;
        const normalizedCurrent = { ...current, ...currentGraph };
        const installAsCurrent = queuedEvidenceCanReplaceAcceptedRun(normalizedCurrent, currentRecord);
        const terminalStatus = status === "COMPLETED" || status === "FAILED" ? status : undefined;
        const acceptedGraph = installAsCurrent
          ? advanceTuiQueueAuthority(currentGraph, currentRecord)
          : currentGraph;
        await this.context.setSessionState(sessionId, {
          pendingQueueSubmissions: removePendingQueueSubmission(
            acceptedGraph.pendingQueueSubmissions,
            currentRecord,
          ),
          queuedRunReservations: acceptedGraph.queuedRunReservations,
          ...(installAsCurrent
            ? {
                acceptedRunId: currentRecord.runId,
                acceptedRunMessageId: currentRecord.messageId,
                acceptedRunThreadId: currentRecord.threadId,
                acceptedRunPredecessorId: durableAcceptedQueuePredecessorId(currentRecord),
                pendingWaitFor: status === "WAITING" ? view.thread.waitFor : undefined,
                lastRunStatus: status === "RUNNING" ? undefined : status,
              }
            : {}),
          terminalQueuedRuns: terminalStatus === undefined
            ? acceptedGraph.terminalQueuedRuns
            : appendTerminalQueuedRun(acceptedGraph.terminalQueuedRuns, {
                ...toQueuedRunReservation(currentRecord),
                status: terminalStatus,
              }),
          updatedAt: new Date().toISOString(),
        });
      } else {
        return false;
      }
      try {
        await this.context.persistSessionAndUi({ requireSessionSave: true });
      } catch (error) {
        this.context.recordPersistenceFailure(
          route === undefined ? "sessions.queue_reconcile_absent" : "sessions.queue_reconcile_present",
          error,
        );
        return false;
      }
    }
    this.indeterminateQueueJournalBySession.delete(sessionId);
    return true;
  }

  private clearIndeterminateQueueRecord(
    sessionId: string,
    runId: string,
    messageId: string,
    threadId: string,
  ): void {
    const remaining = this.indeterminateQueueJournalBySession.get(sessionId)?.filter(
      (record) => record.runId !== runId
        || record.messageId !== messageId
        || record.threadId !== threadId,
    );
    if (remaining === undefined || remaining.length === 0) {
      this.indeterminateQueueJournalBySession.delete(sessionId);
      return;
    }
    this.indeterminateQueueJournalBySession.set(sessionId, remaining);
  }

  private terminalEventThreadMatchesAcceptedRun(
    sessionId: string,
    runId: string,
    threadId: string | undefined,
  ): boolean {
    const session = this.context.uiStore.getState().sessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    const acceptedOwnsRun = session?.acceptedRunId === runId;
    const observedOwnsRun = this.observedActiveRunBySession.get(sessionId) === runId;
    const queuedReservation = findQueuedRunReservation(
      session?.queuedRunReservations,
      runId,
      threadId,
    );
    const queuedRunReserved = session?.queuedRunReservations?.some(
      (reservation) => reservation.runId === runId,
    ) === true;
    const pendingQueueSubmission = session?.pendingQueueSubmissions?.find(
      (submission) => submission.runId === runId && submission.threadId === threadId,
    );
    const pendingRunReserved = session?.pendingQueueSubmissions?.some(
      (submission) => submission.runId === runId,
    ) === true;
    if (queuedRunReserved && queuedReservation === undefined) return false;
    if (pendingRunReserved && pendingQueueSubmission === undefined) return false;
    if (
      acceptedOwnsRun === false
      && observedOwnsRun === false
      && queuedReservation === undefined
      && pendingQueueSubmission === undefined
    ) return true;
    const expectedThreadId = acceptedOwnsRun
      ? session?.acceptedRunThreadId
      : queuedReservation?.threadId
        ?? pendingQueueSubmission?.threadId
        ?? session?.pendingRunThreadId
        ?? session?.focusedThreadId;
    return expectedThreadId !== undefined && threadId === expectedThreadId;
  }

  private terminalEventOwnsCurrentLifecycle(
    sessionId: string,
    runId: string,
    threadId: string | undefined,
  ): boolean {
    const session = this.context.uiStore.getState().sessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (session === undefined) return false;
    if (session.acceptedRunId === runId) return true;
    if (this.observedActiveRunBySession.get(sessionId) === runId) return true;
    if ([...this.conversationViews.values()].some((view) =>
      view.thread.sessionId === sessionId
      && view.activeRun?.runId === runId
      && (threadId === undefined || view.thread.threadId === threadId)
    )) return true;
    if (threadId === undefined) return false;
    const queued = findQueuedRunReservation(session.queuedRunReservations, runId, threadId);
    const pending = session.pendingQueueSubmissions?.find(
      (submission) => submission.runId === runId && submission.threadId === threadId,
    );
    const evidence = queued ?? pending;
    return evidence !== undefined && queuedEvidenceCanReplaceAcceptedRun(session, evidence);
  }

  private foregroundQueuedTerminalEvidence(
    sessionId: string,
    runId: string,
    threadId: string | undefined,
  ): boolean {
    if (threadId === undefined) return false;
    const session = this.context.uiStore.getState().sessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (session === undefined) return false;
    return findQueuedRunReservation(session.queuedRunReservations, runId, threadId) !== undefined
      || session.pendingQueueSubmissions?.some(
        (candidate) => candidate.runId === runId && candidate.threadId === threadId,
      ) === true
      || session.terminalQueuedRuns?.some(
        (candidate) => candidate.runId === runId && candidate.threadId === threadId,
      ) === true;
  }

  private terminalLifecycleAlreadyCommitted(sessionId: string, runId: string): boolean {
    const session = this.context.uiStore.getState().sessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    return session?.acceptedRunId === runId
      && (session.lastRunStatus === "COMPLETED" || session.lastRunStatus === "FAILED");
  }

  private recordTerminalEvent(
    output: NormalizedOutput,
    timestamp: string,
    threadId?: string | undefined,
    acceptJustCommitted = false,
  ): boolean {
    const { sessionId, runId } = output;
    const persistedSession = this.context.uiStore.getState().sessions.find(
      (session) => session.sessionId === sessionId,
    );
    const persistedAcceptedRunId = persistedSession?.acceptedRunId;
    if (
      acceptJustCommitted === false
      && persistedAcceptedRunId === runId
      && (
        persistedSession?.lastRunStatus === "COMPLETED"
        || persistedSession?.lastRunStatus === "FAILED"
      )
    ) return false;
    const knownActiveRunIds = new Set([
      ...(persistedAcceptedRunId !== undefined ? [persistedAcceptedRunId] : []),
      ...(findQueuedRunReservation(
        persistedSession?.queuedRunReservations,
        runId,
        threadId,
      ) === undefined ? [] : [runId]),
      ...(persistedSession?.pendingQueueSubmissions?.some(
        (submission) => submission.runId === runId && submission.threadId === threadId,
      ) === true ? [runId] : []),
          ...(
            this.observedActiveRunBySession.get(sessionId) === undefined
              ? []
              : [this.observedActiveRunBySession.get(sessionId)!]
          ),
          ...[...this.conversationViews.values()].flatMap((view) =>
            view.thread.sessionId === sessionId && view.activeRun?.runId !== undefined
              ? [view.activeRun.runId]
              : []),
        ]);
    const ownsActiveRun = knownActiveRunIds.has(runId);
    if (this.observedActiveRunBySession.get(sessionId) === runId) {
      this.observedActiveRunBySession.delete(sessionId);
    }
    const waiting = output.status === "WAITING";
    for (const [threadId, view] of this.conversationViews) {
      if (view.thread.sessionId !== sessionId || view.activeRun?.runId !== runId) continue;
      this.conversationViews.set(threadId, {
        ...view,
        thread: {
          ...view.thread,
          status: output.status,
          lastRunStatus: output.status,
          activeRunId: waiting ? runId : undefined,
          waitFor: waiting ? output.waitFor : undefined,
          updatedAt: timestamp,
        },
        activeRun: waiting ? { runId, status: "WAITING" } : undefined,
        conversationTurns: view.conversationTurns?.map((turn) =>
          turn.activeRunId !== runId
            ? turn
            : {
                ...turn,
                status: output.status,
                activeRunId: waiting ? runId : undefined,
                ...(waiting
                  ? {}
                  : {
                      terminalRunId: runId,
                      terminalStatus: output.status,
                      completedAt: timestamp,
                    }),
                updatedAt: timestamp,
              }),
        inboxItems: waiting
          ? view.inboxItems
          : view.inboxItems?.filter((item) => item.runId !== runId),
      });
    }
    return ownsActiveRun;
  }

  private async installConversationView(
    view: OperatorThreadView,
    options: { preserveSessionLifecycle?: boolean | undefined } = {},
  ): Promise<boolean> {
    if (view.thread?.threadId === undefined || view.thread.sessionId === undefined) {
      void this.context.appendDiagnosticsLog({
        scope: "conversation.snapshot_contract",
        summary: "Ignored an incomplete operator conversation snapshot.",
      });
      return false;
    }
    let state = this.context.uiStore.getState();
    this.conversationViews.set(view.thread.threadId, view);
    if (state.sessions.some((session) => session.sessionId === view.thread.sessionId) === false) {
      this.conversationViews.delete(view.thread.threadId);
      return false;
    }
    if (
      state.activeSession.sessionId === view.thread.sessionId
      && options.preserveSessionLifecycle !== true
    ) {
      await this.context.setSessionState(view.thread.sessionId, {
        focusedThreadId: view.thread.threadId,
        pendingWaitFor: view.thread.waitFor,
        lastRunStatus: view.thread.lastRunStatus,
        updatedAt: view.thread.updatedAt,
      });
    }
    state = this.context.uiStore.getState();
    if (state.sessions.some((session) => session.sessionId === view.thread.sessionId) === false) {
      this.conversationViews.delete(view.thread.threadId);
      return false;
    }
    if (view.activeRun === undefined && view.thread.status !== "RUNNING" && view.thread.status !== "WAITING") {
      this.observedActiveRunBySession.delete(view.thread.sessionId);
    }
    if (state.activeSession.sessionId !== view.thread.sessionId) return true;
    const runState = this.getConversationRunState(view.thread.sessionId);
    const adapted = adaptTuiConversation({
      threadId: view.thread.threadId,
      transcript: state.transcript,
      view,
    });
    const nextTranscript = projectTuiTranscript(state.transcript, adapted).slice(-400);
    const wrappedBodyWidth = this.context.getChatWrappedBodyWidth();
    const previousRows = buildChatVisualRows(state.transcript, wrappedBodyWidth);
    const nextRows = buildChatVisualRows(nextTranscript, wrappedBodyWidth);
    const previousAnchor = resolveChatVisualAnchor(previousRows, state.scroll.chat.cursor);
    const previousEventId = previousAnchor === undefined
      ? undefined
      : state.transcript[previousAnchor.transcriptIndex]?.eventId;
    const nextTranscriptIndex = previousEventId === undefined
      ? -1
      : nextTranscript.findIndex((line) => line.eventId === previousEventId);
    const followTail = state.scroll.chat.tailLocked
      || state.scroll.chat.cursor >= Math.max(0, previousRows.length - 1);
    const nextCursor = followTail
      ? Math.max(0, nextRows.length - 1)
      : previousAnchor !== undefined && nextTranscriptIndex >= 0
        ? resolveChatVisualCursorFromAnchor(nextRows, {
            transcriptIndex: nextTranscriptIndex,
            wrappedLineIndex: previousAnchor.wrappedLineIndex,
          })
        : Math.max(0, Math.min(state.scroll.chat.cursor, nextRows.length - 1));
    const nextScroll = ensureChatCursorVisible(
      nextRows,
      {
        ...state.scroll.chat,
        cursor: nextCursor,
        tailLocked: followTail,
      },
      this.context.getChatListRows(),
    );
    this.context.uiStore.patch({
      transcript: nextTranscript,
      running: runState.running,
      scroll: {
        ...state.scroll,
        chat: nextScroll,
      },
    });
    if (adapted.issues.length > 0 || adapted.projection.issues.length > 0) {
      void this.context.appendDiagnosticsLog({
        scope: "conversation.projection_contract",
        summary: "TUI conversation projection reported authority gaps.",
        details: JSON.stringify({
          adapterIssues: adapted.issues,
          projectionIssues: adapted.projection.issues,
        }, null, 2),
      });
    }
    return true;
  }

  private async refreshConversationView(threadId: string): Promise<OperatorThreadView> {
    const view = await this.requestConversationView(threadId);
    await this.installConversationView(view);
    return view;
  }

  private async requestConversationView(threadId: string): Promise<OperatorThreadView> {
    const response = await this.context.client.sendCommand(
      "operator.thread",
      { threadId },
      this.context.getActiveRunnerMetadata(),
    );
    if (response.type !== "operator.thread") {
      throw new Error(`Unexpected operator thread response '${response.type}'.`);
    }
    return response.payload.view;
  }

  private async applyTerminalResultAndState(
    result: TuiTerminalResult,
    terminalOwnsActiveRun?: boolean | undefined,
    terminalThreadId?: string | undefined,
  ): Promise<void> {
    const output = result.output;
    const state = this.context.uiStore.getState();
    const activeRunId = this.observedActiveRunBySession.get(output.sessionId)
      ?? [...this.conversationViews.values()].find(
        (view) => view.thread.sessionId === output.sessionId && view.activeRun !== undefined,
      )?.activeRun?.runId;
    const ownsActiveSessionState = state.activeSession.sessionId === output.sessionId
      && (terminalOwnsActiveRun ?? (activeRunId === undefined || activeRunId === output.runId));
    if (ownsActiveSessionState) {
      const queuedReservation = terminalThreadId === undefined
        ? undefined
        : findQueuedRunReservation(
            state.activeSession.queuedRunReservations,
            output.runId,
            terminalThreadId,
          );
      await this.context.setActiveSessionState({
        started: true,
        updatedAt: new Date().toISOString(),
        pendingWaitFor: output.status === "WAITING" ? output.waitFor : undefined,
        lastRunStatus: output.status,
        pendingManualCompaction: false,
        suppressAutoCompactionOnce: false,
        ...(queuedReservation !== undefined
          ? {
              acceptedRunId: queuedReservation.runId,
              acceptedRunMessageId: queuedReservation.messageId,
              acceptedRunThreadId: queuedReservation.threadId,
              acceptedRunPredecessorId: durableAcceptedQueuePredecessorId(queuedReservation),
              queuedRunReservations: removeQueuedRunReservation(
                state.activeSession.queuedRunReservations,
                queuedReservation,
              ),
            }
          : {}),
        operatorState: this.context.buildSessionOperatorState({
          session: state.activeSession,
          profile: state.activeProfile,
          runtime: result.operatorAffordance,
        }),
      });
    }
    if (terminalOwnsActiveRun !== false) {
      await this.context.applyTerminalResult(
        output.sessionId,
        result,
        result.finalizedPayload,
      );
    }
    if (ownsActiveSessionState) {
      const cancelled = output.errors.some((error) => error.code === "RUN_CANCELLED");
      this.context.uiStore.patch({
        running: false,
        statusLine: this.context.withMcpSummary(
          cancelled
            ? "cancelled"
            : output.status === "WAITING"
              ? `waiting (${output.waitFor?.eventType ?? "input"})`
              : output.status === "FAILED" ? "failed" : "completed",
        ),
      });
    }
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

function appendQueuedRunReservation(
  reservations: TuiSessionMeta["queuedRunReservations"],
  reservation: NonNullable<TuiSessionMeta["pendingQueueSubmissions"]>[number],
): NonNullable<TuiSessionMeta["queuedRunReservations"]> {
  const existing = reservations ?? [];
  const normalized = toQueuedRunReservation(reservation);
  const exact = existing.find((candidate) => candidate.runId === reservation.runId);
  if (exact !== undefined) {
    if (
      exact.messageId !== reservation.messageId
      || exact.threadId !== reservation.threadId
      || exact.predecessorRunId !== reservation.predecessorRunId
    ) {
      throw new Error("Queued run reservation identity conflicted with persisted evidence.");
    }
    return existing;
  }
  const successorIndex = existing.findIndex(
    (candidate) => candidate.predecessorRunId === normalized.runId,
  );
  if (successorIndex >= 0) {
    return [
      ...existing.slice(0, successorIndex),
      normalized,
      ...existing.slice(successorIndex),
    ];
  }
  return [...existing, normalized];
}

function toQueuedRunReservation(
  submission: NonNullable<TuiSessionMeta["pendingQueueSubmissions"]>[number],
): NonNullable<TuiSessionMeta["queuedRunReservations"]>[number] {
  return {
    runId: submission.runId,
    messageId: submission.messageId,
    threadId: submission.threadId,
    ...(submission.predecessorRunId !== undefined
      ? { predecessorRunId: submission.predecessorRunId }
      : {}),
  };
}

function appendPendingQueueSubmission(
  submissions: TuiSessionMeta["pendingQueueSubmissions"],
  submission: NonNullable<TuiSessionMeta["pendingQueueSubmissions"]>[number],
): NonNullable<TuiSessionMeta["pendingQueueSubmissions"]> {
  const existing = submissions ?? [];
  const exact = existing.find((candidate) => candidate.runId === submission.runId);
  if (exact !== undefined) {
    if (
      exact.messageId !== submission.messageId
      || exact.threadId !== submission.threadId
      || exact.predecessorRunId !== submission.predecessorRunId
      || exact.indeterminate !== submission.indeterminate
    ) {
      throw new Error("Pending queue submission identity conflicted with persisted evidence.");
    }
    return existing;
  }
  return [...existing, submission];
}

function findPendingQueueSubmission(
  submissions: TuiSessionMeta["pendingQueueSubmissions"],
  runId: string,
  threadId: string,
  messageId: string,
): NonNullable<TuiSessionMeta["pendingQueueSubmissions"]>[number] | undefined {
  return submissions?.find((submission) =>
    submission.runId === runId
    && submission.threadId === threadId
    && submission.messageId === messageId
  );
}

function removePendingQueueSubmission(
  submissions: TuiSessionMeta["pendingQueueSubmissions"],
  submission: NonNullable<TuiSessionMeta["pendingQueueSubmissions"]>[number],
): TuiSessionMeta["pendingQueueSubmissions"] {
  const remaining = submissions?.filter((candidate) =>
    candidate.runId !== submission.runId
    || candidate.messageId !== submission.messageId
    || candidate.threadId !== submission.threadId
  );
  return remaining === undefined || remaining.length === 0 ? undefined : remaining;
}

function findQueuedRunReservation(
  reservations: TuiSessionMeta["queuedRunReservations"],
  runId: string,
  threadId?: string | undefined,
  messageId?: string | undefined,
): NonNullable<TuiSessionMeta["queuedRunReservations"]>[number] | undefined {
  return reservations?.find((reservation) =>
    reservation.runId === runId
    && (threadId === undefined || reservation.threadId === threadId)
    && (messageId === undefined || reservation.messageId === messageId)
  );
}

function removeQueuedRunReservation(
  reservations: TuiSessionMeta["queuedRunReservations"],
  reservation: NonNullable<TuiSessionMeta["queuedRunReservations"]>[number],
): TuiSessionMeta["queuedRunReservations"] {
  const remaining = reservations?.filter((candidate) =>
    candidate.runId !== reservation.runId
    || candidate.messageId !== reservation.messageId
    || candidate.threadId !== reservation.threadId
  );
  return remaining === undefined || remaining.length === 0 ? undefined : remaining;
}

function appendTerminalQueuedRun(
  terminalRuns: TuiSessionMeta["terminalQueuedRuns"],
  terminal: NonNullable<TuiSessionMeta["terminalQueuedRuns"]>[number],
): NonNullable<TuiSessionMeta["terminalQueuedRuns"]> {
  const existing = terminalRuns ?? [];
  const sameRun = existing.find((candidate) => candidate.runId === terminal.runId);
  if (sameRun !== undefined) {
    if (
      sameRun.messageId !== terminal.messageId
      || sameRun.threadId !== terminal.threadId
      || sameRun.status !== terminal.status
      || sameRun.predecessorRunId !== terminal.predecessorRunId
    ) {
      throw new Error("Terminal queued run identity conflicted with exact lifecycle evidence.");
    }
    return existing;
  }
  return [...existing, terminal];
}

function queuedEvidenceCanReplaceAcceptedRun(
  session: TuiSessionMeta,
  evidence: NonNullable<TuiSessionMeta["pendingQueueSubmissions"]>[number],
): boolean {
  if (session.acceptedRunId === undefined || session.acceptedRunId === evidence.runId) return true;
  let predecessorRunId = evidence.predecessorRunId;
  const visited = new Set<string>();
  while (predecessorRunId !== undefined && visited.has(predecessorRunId) === false) {
    if (predecessorRunId === session.acceptedRunId) return true;
    visited.add(predecessorRunId);
    const predecessor = [
      ...(session.pendingQueueSubmissions ?? []),
      ...(session.queuedRunReservations ?? []),
      ...(session.terminalQueuedRuns ?? []),
    ].find((candidate) => candidate.runId === predecessorRunId);
    predecessorRunId = predecessor?.predecessorRunId;
  }
  return false;
}

function durableAcceptedQueuePredecessorId(
  evidence: { predecessorRunId?: string | undefined },
): string | null {
  return evidence.predecessorRunId ?? null;
}

function runnerErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function isStoppedConversationView(view: OperatorThreadView): boolean {
  return view.activeRun === undefined
    && (view.thread.status === "IDLE" || view.thread.status === "COMPLETED" || view.thread.status === "FAILED");
}

function exactRunStatusFromView(
  view: OperatorThreadView,
  runId: string,
): "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | undefined {
  if (view.activeRun?.runId === runId) {
    return view.activeRun.status;
  }
  const terminalTurn = view.conversationTurns?.find(
    (turn) => turn.terminalRunId === runId
      && (turn.status === "COMPLETED" || turn.status === "FAILED"),
  );
  return terminalTurn?.status;
}

function hasExactQueuedTerminalTurn(
  view: OperatorThreadView,
  candidate: {
    runId: string;
    messageId: string;
    threadId: string;
    status: "COMPLETED" | "FAILED";
  },
): boolean {
  const matchingTurns = view.conversationTurns?.filter((turn) =>
    turn.sessionId === view.thread.sessionId
    && turn.threadId === candidate.threadId
    && turn.sourceMessageId === candidate.messageId
    && turn.terminalRunId === candidate.runId
    && turn.status === candidate.status
    && (turn.terminalStatus === undefined || turn.terminalStatus === candidate.status)
    && turn.sequence !== null
    && Number.isSafeInteger(turn.sequence)
  ) ?? [];
  return matchingTurns.length === 1;
}

function hasExactQueuedRunEvidence(
  view: OperatorThreadView,
  candidate: {
    runId: string;
    messageId: string;
    threadId: string;
    status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  },
): boolean {
  const matchingRoutes = view.conversationMessageRoutes?.filter((route) =>
    route.messageId === candidate.messageId
    && route.runId === candidate.runId
  ) ?? [];
  if (matchingRoutes.length !== 1) return false;
  if (candidate.status === "COMPLETED" || candidate.status === "FAILED") {
    return hasExactQueuedTerminalTurn(view, candidate);
  }
  return view.activeRun?.runId === candidate.runId
    && view.activeRun.status === candidate.status;
}

function getEntryStepAgent(profile: TuiProfile): string {
  if (profile.agent === "kestrel") {
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
    return ;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }

  return value as Record<string, unknown>;
}

function isRuntimeWaitingPromptHistoryLine(line: TranscriptLine): boolean {
  return line.role === "system" && asRecord(line.data)?.kind === "runtime.waiting_prompt";
}

function stringifyDiagnosticDetails(value: unknown): string | undefined {
  if (value === undefined) {
    return ;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDiagnosticError(error: unknown): string | undefined {
  if (error === undefined) {
    return ;
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
    return ;
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
