import test from "node:test";
import assert from "node:assert/strict";

import {
  TuiRunController,
  type TuiRunControllerContext,
} from "../../cli/app/TuiRunController.js";
import type {
  AgentRunLogLine,
  ResolvedWorkspace,
  TranscriptLine,
  TuiProfile,
  TuiSessionMeta,
} from "../../cli/contracts.js";
import { buildInitialUiRuntimeState, UiStore } from "../../cli/ink/store/UiStore.js";
import { createUiDerivedSelectors } from "../../cli/ink/store/selectors.js";
import type { RunnerEvent } from "../../cli/protocol/contracts.js";
import {
  buildWaitingSystemText,
  extractWaitPrompt,
} from "../../cli/app/waitForPrompt.js";
import type {
  AgentProgressUpdateV1,
  NormalizedOutput,
} from "../../src/index.js";
import { evaluationReviewInteractionFixture } from "../fixtures/structured-review-contract.js";
import {
  advanceTuiQueueAuthority,
  bindTuiQueueSuccessor,
  normalizeTuiQueueGraph,
  resolveExactTuiQueuedEvidence,
} from "../../cli/session/TuiQueueGraph.js";


function makeCompletedOutput(sessionId: string, runId: string): NormalizedOutput {
  return {
    status: "COMPLETED",
    sessionId,
    runId,
    quality: {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
    errors: [],
    telemetry: {
      stepsExecuted: 1,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 1,
    },
  };
}

function makeFailedResult(runId: string) {
  return {
    assistantText: null,
    output: {
      ...makeCompletedOutput("session-1", runId),
      status: "FAILED" as const,
    },
  };
}

function makeCompletedResult(runId: string) {
  return {
    assistantText: "Done.",
    output: makeCompletedOutput("session-1", runId),
  };
}

function makeCancelledResult(runId: string) {
  return {
    assistantText: null,
    output: {
      ...makeCompletedOutput("session-1", runId),
      status: "FAILED" as const,
      errors: [{ code: "RUN_CANCELLED", message: "Run cancelled." }],
    },
  };
}

function makeWaitingResult(runId: string) {
  return {
    assistantText: null,
    output: {
      ...makeCompletedOutput("session-1", runId),
      status: "WAITING" as const,
      waitFor: { kind: "user" as const, eventType: "user.reply" },
    },
  };
}

function makeConversationView(input: { active?: boolean; lastRunStatus?: "COMPLETED" | "FAILED" } = {}) {
  const active = input.active === true;
  return {
    thread: {
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      title: "Main",
      status: active ? "RUNNING" as const : input.lastRunStatus ?? "COMPLETED" as const,
      lastRunStatus: input.lastRunStatus ?? (active ? undefined : "COMPLETED" as const),
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:03.000Z",
    },
    childThreads: [],
    childBlockerChain: [],
    conversationTurns: active ? [{
      turnId: "turn-1",
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      sequence: 1,
      status: "RUNNING" as const,
      rootRunId: "run-start-1",
      activeRunId: "run-start-1",
      startedAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:03.000Z",
    }] : [],
    activeRun: active ? { runId: "run-start-1", status: "RUNNING" as const } : undefined,
    followUpQueue: { state: "ready" as const, items: [] },
  };
}

function makeQueuedTerminalAuthorityView(
  terminals: Array<{
    runId: string;
    messageId: string;
    status: "COMPLETED" | "FAILED";
  }>,
) {
  const lastRunStatus = terminals.at(-1)?.status;
  return {
    ...makeConversationView(lastRunStatus === undefined ? {} : { lastRunStatus }),
    conversationTurns: terminals.map((terminal, index) => ({
      turnId: `turn-authority-${terminal.runId}`,
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      sequence: index + 1,
      status: terminal.status,
      rootRunId: terminal.runId,
      sourceMessageId: terminal.messageId,
      terminalRunId: terminal.runId,
      terminalStatus: terminal.status,
      startedAt: "2026-05-14T00:00:00.000Z",
      completedAt: "2026-05-14T00:00:03.000Z",
      updatedAt: "2026-05-14T00:00:03.000Z",
    })),
  };
}

let eventSequence = 0;

function makeRunnerEvent<TType extends RunnerEvent["type"]>(
  event: Omit<Extract<RunnerEvent, { type: TType }>, "id" | "ts"> & { type: TType },
): Extract<RunnerEvent, { type: TType }> {
  eventSequence += 1;
  return {
    id: `event-${eventSequence}`,
    ts: "2026-05-14T00:00:03.000Z",
    ...event,
  } as Extract<RunnerEvent, { type: TType }>;
}

function createRunHarness(input: {
  pendingWaitFor?: TuiSessionMeta["pendingWaitFor"] | undefined;
  pendingManualCompaction?: boolean | undefined;
  sendCommand?: TuiRunControllerContext["client"]["sendCommand"] | undefined;
  recoverTerminalMessages?: TuiRunControllerContext["recoverTerminalMessages"] | undefined;
  withMcpSummary?: TuiRunControllerContext["withMcpSummary"] | undefined;
  scripted?: boolean | undefined;
  started?: boolean | undefined;
  environmentPresetId?: TuiSessionMeta["environmentPresetId"] | undefined;
  runtimeEnvironmentPresetId?: "cli_safe_local" | "cli_dev_local" | undefined;
  legacyEnvironmentMissing?: boolean | undefined;
  workspaceBinding?: TuiSessionMeta["workspaceBinding"] | undefined;
  workspaceRoot?: string | undefined;
  effectiveAssemblyId?: string | undefined;
  omitRuntimeEnvironmentIdentity?: boolean | undefined;
  sessionDescribeWithoutRuntimeEvidence?: boolean | undefined;
  sessionDescribeError?: Error | undefined;
  describedSessionId?: string | undefined;
  activeSessionPatch?: Partial<TuiSessionMeta> | undefined;
  persistenceBarrierError?: Error | undefined;
  persistSessionAndUi?: (
    options?: { requireSessionSave?: boolean | undefined },
  ) => Promise<void>;
  prepareLocalCoreClient?: TuiRunControllerContext["prepareLocalCoreClient"] | undefined;
  beforeSessionDescribe?: (() => Promise<void>) | undefined;
  resolveExecutionProfile?: ((request: {
    client: "cli";
    profileId: string;
    environmentPresetId: "cli_safe_local" | "cli_dev_local";
  }) => Promise<Record<string, unknown>>) | undefined;
  resolveWorkspaceForSession?: ((session: TuiSessionMeta) => Promise<ResolvedWorkspace | undefined>) | undefined;
  beforeSetSessionState?: ((sessionId: string, patch: Partial<TuiSessionMeta>) => Promise<void>) | undefined;
  commitQueueSessionState?: TuiRunControllerContext["commitQueueSessionState"] | undefined;
  syncForegroundSessionProgress?: TuiRunControllerContext["syncForegroundSessionProgress"] | undefined;
  syncForegroundQueuedTerminal?: TuiRunControllerContext["syncForegroundQueuedTerminal"] | undefined;
  disableSynthesizedTerminalAuthority?: boolean | undefined;
} = {}): {
  controller: TuiRunController;
  uiStore: UiStore;
  commands: Array<{ type: string; payload: Record<string, unknown> }>;
  history: Array<{
    sessionId?: string | undefined;
    role: string;
    text: string;
    data?: Record<string, unknown> | undefined;
    output?: NormalizedOutput | undefined;
    eventId?: string | undefined;
  }>;
  diagnostics: Array<{ scope: string; summary: string; details?: string | undefined }>;
  runLogs: AgentRunLogLine[];
  reasoning: AgentProgressUpdateV1[];
  backgroundProgress: Array<{
    sessionId: string;
    threadId: string;
    runId: string;
    messageId?: string | undefined;
    requestId?: string | undefined;
  }>;
  registeredProfileId: string;
  sessionDescribeCount: number;
  persistCount: number;
} {
  const activeProfile: TuiProfile = {
    id: "kestrel",
    label: "Reference",
    agent: "kestrel",
    sessionPrefix: "ref",
  };
  const activeSession: TuiSessionMeta = {
    name: "default",
    sessionId: "session-1",
    profileId: activeProfile.id,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    started: input.started ?? true,
    ...(input.workspaceBinding !== undefined
      ? { workspaceBinding: input.workspaceBinding }
      : {}),
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.legacyEnvironmentMissing === true
      ? {}
      : input.environmentPresetId !== undefined
      ? { environmentPresetId: input.environmentPresetId }
      : { environmentPresetId: "cli_dev_local" }),
    ...(input.effectiveAssemblyId !== undefined
      ? { effectiveAssemblyId: input.effectiveAssemblyId }
      : input.started === false
        || input.legacyEnvironmentMissing === true
        || input.runtimeEnvironmentPresetId !== undefined
        ? {}
        : { effectiveAssemblyId: "bundle:kestrel:cli" }),
    ...(input.pendingWaitFor !== undefined ? { pendingWaitFor: input.pendingWaitFor } : {}),
    ...(input.pendingManualCompaction !== undefined
      ? { pendingManualCompaction: input.pendingManualCompaction }
      : {}),
    ...input.activeSessionPatch,
  };
  const uiStore = new UiStore(
    buildInitialUiRuntimeState({
      profile: activeProfile,
      activeSession,
      sessions: [activeSession],
      transcript: [
        {
          role: "system",
          text: "system note",
          timestamp: "2026-05-14T00:00:00.000Z",
        },
        {
          role: "user",
          text: "prior",
          timestamp: "2026-05-14T00:00:01.000Z",
        },
      ],
    }),
  );

  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let sessionDescribeCount = 0;
  let persistCount = 0;
  const registeredProfileId =
    "kestrel:cli_dev_local:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const history: Array<{
    sessionId?: string | undefined;
    role: string;
    text: string;
    data?: Record<string, unknown> | undefined;
    output?: NormalizedOutput | undefined;
    eventId?: string | undefined;
  }> = [];
  const diagnostics: Array<{ scope: string; summary: string; details?: string | undefined }> = [];
  const runLogs: AgentRunLogLine[] = [];
  const reasoning: AgentProgressUpdateV1[] = [];
  const backgroundProgress: Array<{
    sessionId: string;
    threadId: string;
    runId: string;
    messageId?: string | undefined;
    requestId?: string | undefined;
  }> = [];
  let submittedTerminalAuthority: {
    sessionId: string;
    threadId: string;
    runId: string;
    messageId: string;
    status: "COMPLETED" | "FAILED";
  } | undefined;
  const submittedIdentityByRunId = new Map<string, { messageId: string; threadId: string }>();

  const context: TuiRunControllerContext = {
    options: { cwd: process.cwd(), ...(input.scripted === true ? { scripted: true } : {}) },
    profileStore: undefined,
    sessionStore: undefined,
    workspaceStore: undefined,
    historyStore: undefined,
    diagnosticsStore: {
      getDisplayPath: () => "/tmp/kestrel-diagnostics.log",
    },
    uiStateStore: undefined,
    client: {
      sendCommand: async (
        type: string,
        payload: Record<string, unknown>,
        metadata?: Record<string, unknown> | undefined,
      ) => {
        if (type === "conversation.message.submit") {
          submittedIdentityByRunId.set(String((payload.turn as Record<string, unknown>).runId), {
            messageId: String(payload.messageId),
            threadId: String(payload.threadId),
          });
        }
        if (type === "session.describe") {
          sessionDescribeCount += 1;
          await input.beforeSessionDescribe?.();
          if (input.sessionDescribeError !== undefined) {
            throw input.sessionDescribeError;
          }
          return makeRunnerEvent({
            type: "session.described",
            payload: input.sessionDescribeWithoutRuntimeEvidence === true
              ? {
                  sessionId: input.describedSessionId ?? activeSession.sessionId,
                  version: 0,
                }
              : {
                  sessionId: input.describedSessionId ?? activeSession.sessionId,
                  version: 1,
                  activeAssembly: {
                    mode: "explicit",
                    bundleId: "bundle:kestrel:cli",
                    ...(input.omitRuntimeEnvironmentIdentity === true
                      ? {}
                      : {
                          environmentPresetId:
                            input.runtimeEnvironmentPresetId ??
                            input.environmentPresetId ??
                            "cli_dev_local",
                        }),
                  },
                },
          });
        }
        if (input.sendCommand !== undefined) {
          try {
            const response = await input.sendCommand(
              type as never,
              payload as never,
              metadata as never,
            );
            if (
              response.type === "run.completed"
              || response.type === "run.cancelled"
              || (response.type === "run.failed" && response.payload.result !== undefined)
            ) {
              const output = response.payload.result.output;
              const submittedIdentity = submittedIdentityByRunId.get(output.runId);
              submittedTerminalAuthority = submittedIdentity === undefined
                ? undefined
                : {
                    sessionId: output.sessionId,
                    threadId: submittedIdentity.threadId,
                    runId: output.runId,
                    messageId: submittedIdentity.messageId,
                    status: output.status === "COMPLETED" ? "COMPLETED" : "FAILED",
                  };
            }
            return response;
          } catch (error) {
            if (
              type !== "operator.thread"
              || input.disableSynthesizedTerminalAuthority === true
              || submittedTerminalAuthority === undefined
            ) throw error;
          }
        }
        if (
          type === "operator.thread"
          && input.disableSynthesizedTerminalAuthority !== true
          && submittedTerminalAuthority !== undefined
        ) {
          const authority = submittedTerminalAuthority;
          return makeRunnerEvent({
            type: "operator.thread",
            payload: {
              view: {
                ...makeConversationView({ lastRunStatus: authority.status }),
                thread: {
                  ...makeConversationView().thread,
                  threadId: authority.threadId,
                  sessionId: authority.sessionId,
                  status: authority.status,
                  lastRunStatus: authority.status,
                },
                conversationMessageRoutes: [{
                  messageId: authority.messageId,
                  disposition: "started",
                  runId: authority.runId,
                }],
                conversationTurns: [{
                  turnId: `turn-authority-${authority.runId}`,
                  threadId: authority.threadId,
                  sessionId: authority.sessionId,
                  sequence: 1,
                  status: authority.status,
                  rootRunId: authority.runId,
                  sourceMessageId: authority.messageId,
                  terminalRunId: authority.runId,
                  terminalStatus: authority.status,
                  startedAt: "2026-05-14T00:00:00.000Z",
                  completedAt: "2026-05-14T00:00:03.000Z",
                  updatedAt: "2026-05-14T00:00:03.000Z",
                }],
              },
            },
          });
        }
        commands.push({ type, payload });
        if (type === "run.cancel") {
          return makeRunnerEvent({
            type: "run.cancelled",
            payload: {
              sessionId: activeSession.sessionId,
              result: makeCancelledResult("run-start-1"),
            },
          });
        }
        if (type === "operator.thread") {
          return makeRunnerEvent({
            type: "operator.thread",
            payload: { view: makeConversationView({ lastRunStatus: "FAILED" }) },
          });
        }
        if (type === "operator.control") {
          return makeRunnerEvent({
            type: "operator.controlled",
            payload: {
              threadId: "thread-main:session-1",
              disposition: "completed",
              view: makeConversationView(),
              result: makeCompletedResult("run-resume-1"),
            },
          });
        }
        return makeRunnerEvent({
          type: "conversation.message.routed",
          commandId: "command-1",
          payload: {
            threadId: activeSession.focusedThreadId ?? `thread-main:${activeSession.sessionId}`,
            sessionId: activeSession.sessionId,
            messageId: String(payload.messageId ?? "message-1"),
            disposition: "replied",
            requestId: "request-resume-1",
            runId: String((payload.turn as Record<string, unknown> | undefined)?.runId),
            view: makeConversationView(),
          },
        });
      },
    },
    ...(input.prepareLocalCoreClient !== undefined
      ? { prepareLocalCoreClient: input.prepareLocalCoreClient }
      : {}),
    getLocalCoreClient: () => ({
      resolveExecutionProfile: async (request: {
        client: "cli";
        profileId: string;
        environmentPresetId: "cli_safe_local" | "cli_dev_local";
      }) => {
        if (input.resolveExecutionProfile !== undefined) {
          return await input.resolveExecutionProfile(request) as never;
        }
        const expectedEnvironmentPresetId =
          input.runtimeEnvironmentPresetId ??
          input.environmentPresetId ??
          (input.legacyEnvironmentMissing === true && (input.started ?? true) === false
            ? input.workspaceBinding === "active"
              ? "cli_dev_local"
              : "cli_safe_local"
            : "cli_dev_local");
        assert.deepEqual(request, {
          client: "cli",
          profileId: activeProfile.id,
          environmentPresetId: expectedEnvironmentPresetId,
        });
        return {
          version: 1,
          profileId: registeredProfileId,
          fingerprint:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          policy: { id: "kestrel", version: 2 },
          environmentPreset: { id: expectedEnvironmentPresetId, version: 1 },
          resolvedProfile: {
            ...activeProfile,
            id: registeredProfileId,
            agentProfileId: "kestrel",
            environmentShellKind: "cli",
            environmentPresetId: expectedEnvironmentPresetId,
            environmentCapabilityPackIds:
              expectedEnvironmentPresetId === "cli_dev_local"
                ? ["balanced", "filesystem", "dev_shell"]
                : ["balanced", "filesystem", "sandbox_code"],
          },
        };
      },
    }),
    uiStore,
    selectors: createUiDerivedSelectors(),
    getRuntimeSettings: () => ({ version: 1, defaults: {} }),
    getSessionsFile: () => ({ version: 5, activeSessionName: "default", sessions: [activeSession] }),
    setSessionsFile: () => {},
    getActiveWorkspace: () => {},
    setActiveWorkspace: () => {},
    getLaunchWorkspace: () => {},
    setLaunchWorkspace: () => {},
    appendHistoryLine: async (
      role: TranscriptLine["role"],
      text: string,
      data?: Record<string, unknown> | undefined,
      output?: NormalizedOutput | undefined,
      eventId?: string | undefined,
    ) => {
      if (eventId !== undefined && history.some((line) => line.eventId === eventId)) return;
      history.push({ role, text, ...(data !== undefined ? { data } : {}), output, eventId });
    },
    appendSessionHistoryLine: async (
      sessionId: string,
      role: TranscriptLine["role"],
      text: string,
      data?: Record<string, unknown> | undefined,
      output?: NormalizedOutput | undefined,
      eventId?: string | undefined,
    ) => {
      if (uiStore.getState().activeSession.sessionId === sessionId) {
        await context.appendHistoryLine(role, text, data, output, eventId);
        return;
      }
      if (
        eventId !== undefined
        && history.some((line) => line.sessionId === sessionId && line.eventId === eventId)
      ) return;
      history.push({
        sessionId,
        role,
        text,
        ...(data !== undefined ? { data } : {}),
        output,
        eventId,
      });
    },
    persistSessionAndUi: async (options?: { requireSessionSave?: boolean | undefined }) => {
      persistCount += 1;
      if (input.persistSessionAndUi !== undefined) {
        await input.persistSessionAndUi(options);
        return;
      }
      if (options?.requireSessionSave === true && input.persistenceBarrierError !== undefined) {
        throw input.persistenceBarrierError;
      }
    },
    persistUiState: async () => {},
    persistActiveProfile: async () => {},
    getActiveRunnerMetadata: () => ({ profile: uiStore.getState().activeProfile }),
    setActiveSessionState: async (patch: Partial<TuiSessionMeta>) => {
      const state = uiStore.getState();
      const activeSession = {
        ...state.activeSession,
        ...patch,
      };
      uiStore.patch({
        activeSession,
        sessions: state.sessions.map((session) =>
          session.sessionId === activeSession.sessionId ? activeSession : session
        ),
      });
    },
    setSessionState: async (sessionId: string, patch: Partial<TuiSessionMeta>) => {
      await input.beforeSetSessionState?.(sessionId, patch);
      const state = uiStore.getState();
      const target = state.sessions.find((session) => session.sessionId === sessionId);
      if (target === undefined) return undefined;
      const next = { ...target, ...patch };
      uiStore.patch({
        sessions: state.sessions.map((session) => session.sessionId === sessionId ? next : session),
        ...(state.activeSession.sessionId === sessionId ? { activeSession: next } : {}),
      });
      return next;
    },
    commitQueueSessionState: input.commitQueueSessionState ?? (async (sessionId: string, patch: Partial<TuiSessionMeta>) => {
      const state = uiStore.getState();
      const target = state.sessions.find((session) => session.sessionId === sessionId);
      if (target === undefined) return undefined;
      const next = { ...target, ...patch };
      uiStore.patch({
        sessions: state.sessions.map((session) => session.sessionId === sessionId ? next : session),
        ...(state.activeSession.sessionId === sessionId ? { activeSession: next } : {}),
      });
      persistCount += 1;
      return next;
    }),
    navigateToView: () => {},
    withMcpSummary: input.withMcpSummary ?? ((statusLine: string) => statusLine),
    recordPersistenceFailure: () => {},
    resolveWorkspaceForSession: async (session: TuiSessionMeta) =>
      await input.resolveWorkspaceForSession?.(session),
    shouldApplyCompactionOnContinuationResume: () => true,
    buildSessionOperatorState: ({ runtime }: {
      runtime?: TuiSessionMeta["operatorState"] | undefined;
    }) =>
      (runtime ?? {
        inbox: { items: [] },
      }) as NonNullable<TuiSessionMeta["operatorState"]>,
    appendDiagnosticsLog: async (entry: {
      scope: string;
      summary: string;
      details?: string | undefined;
    }) => {
      diagnostics.push(entry);
    },
    handleTaskUpdatedEvent: async () => {},
    syncForegroundSessionProgress: input.syncForegroundSessionProgress ?? (async ({ sessionId, threadId, runId, messageId }) => {
      const state = uiStore.getState();
      const queuedReservation = state.activeSession.queuedRunReservations?.find((reservation) =>
        reservation.runId === runId
        && reservation.messageId === messageId
        && reservation.threadId === threadId
      );
      const pendingQueueSubmission = state.activeSession.pendingQueueSubmissions?.find((submission) =>
        submission.runId === runId
        && submission.messageId === messageId
        && submission.threadId === threadId
      );
      const exactAcceptedStart = state.activeSession.acceptedRunId === runId
        && state.activeSession.acceptedRunMessageId === messageId
        && state.activeSession.acceptedRunThreadId === threadId;
      if (
        state.activeSession.sessionId !== sessionId
        || (
          exactAcceptedStart === false
          && queuedReservation === undefined
          && pendingQueueSubmission === undefined
          && (
            state.activeSession.pendingRunId !== runId
            || state.activeSession.pendingRunMessageId !== messageId
            || state.activeSession.pendingRunThreadId !== threadId
          )
        )
      ) return false;
      const queueEvidence = queuedReservation ?? pendingQueueSubmission;
      let acceptedGraph = queueEvidence === undefined
        ? normalizeTuiQueueGraph(state.activeSession)
        : advanceTuiQueueAuthority(
            normalizeTuiQueueGraph(state.activeSession),
            queueEvidence,
          );
      if (exactAcceptedStart) {
        const unresolved = [
          ...(acceptedGraph.pendingQueueSubmissions ?? []),
          ...(acceptedGraph.queuedRunReservations ?? []),
        ].filter((candidate) =>
          candidate.runId !== runId
          && candidate.threadId === threadId
          && candidate.predecessorRunId !== runId
          && state.activeSession.acceptedRunPredecessorId !== undefined
          && (candidate.predecessorRunId ?? null)
            === state.activeSession.acceptedRunPredecessorId
        );
        if (unresolved.length !== 1) return false;
        acceptedGraph = bindTuiQueueSuccessor(
          acceptedGraph,
          unresolved[0]!,
          { runId, messageId, threadId },
        );
        const retainedAcceptedRecord = [
          ...(acceptedGraph.pendingQueueSubmissions ?? []),
          ...(acceptedGraph.queuedRunReservations ?? []),
        ].find((candidate) => candidate.runId === runId);
        if (retainedAcceptedRecord !== undefined) {
          acceptedGraph = advanceTuiQueueAuthority(acceptedGraph, retainedAcceptedRecord);
        }
      }
      const accepted = {
          ...state.activeSession,
          started: true,
          focusedThreadId: threadId,
          acceptedRunId: runId,
          acceptedRunMessageId: messageId,
          acceptedRunThreadId: threadId,
          acceptedRunPredecessorId: queueEvidence === undefined
            ? exactAcceptedStart
              ? state.activeSession.acceptedRunPredecessorId
              : undefined
            : queueEvidence.predecessorRunId ?? null,
          pendingRunId: undefined,
          pendingRunMessageId: undefined,
          pendingRunThreadId: undefined,
          queuedRunReservations: acceptedGraph.queuedRunReservations,
          pendingQueueSubmissions: acceptedGraph.pendingQueueSubmissions,
          terminalQueuedRuns: acceptedGraph.terminalQueuedRuns,
          lastRunStatus: undefined,
      };
      uiStore.patch({
        activeSession: accepted,
        sessions: state.sessions.map((session) => session.sessionId === sessionId ? accepted : session),
        running: true,
        statusLine: "running",
        errorOverlay: undefined,
      });
      persistCount += 1;
      return true;
    }),
    syncForegroundQueuedTerminal: input.syncForegroundQueuedTerminal ?? (async (terminalInput: Parameters<
      TuiRunControllerContext["syncForegroundQueuedTerminal"]
    >[0]) => {
      const {
      sessionId,
      threadId,
      runId,
      result,
      authoritativeView,
      } = terminalInput;
      const state = uiStore.getState();
      const session = state.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (session === undefined) return false;
      const resolvedEvidence = resolveExactTuiQueuedEvidence(session, {
        runId,
        threadId,
        messageId: terminalInput.messageId,
      });
      if (resolvedEvidence === undefined) return false;
      const reservation = session.queuedRunReservations?.find((candidate) =>
        candidate.runId === resolvedEvidence.runId
        && candidate.messageId === resolvedEvidence.messageId
        && candidate.threadId === resolvedEvidence.threadId
      );
      const pendingQueueSubmission = session.pendingQueueSubmissions?.find((candidate) =>
        candidate.runId === resolvedEvidence.runId
        && candidate.messageId === resolvedEvidence.messageId
        && candidate.threadId === resolvedEvidence.threadId
      );
      const evidence = reservation ?? pendingQueueSubmission ?? resolvedEvidence;
      const remaining = reservation === undefined
        ? session.queuedRunReservations
        : session.queuedRunReservations?.filter((candidate) =>
            candidate.runId !== reservation.runId
            || candidate.messageId !== reservation.messageId
            || candidate.threadId !== reservation.threadId
          );
      let currentGraph = normalizeTuiQueueGraph(session);
      let orderedEvidence = evidence;
      if (
        authoritativeView !== undefined
        && session.acceptedRunId !== undefined
        && session.acceptedRunMessageId !== undefined
        && session.acceptedRunThreadId === evidence.threadId
        && evidence.predecessorRunId !== session.acceptedRunId
      ) {
        const acceptedTerminal = currentGraph.terminalQueuedRuns?.find((terminal) =>
          terminal.runId === session.acceptedRunId
          && terminal.messageId === session.acceptedRunMessageId
          && terminal.threadId === session.acceptedRunThreadId
          && terminal.predecessorRunId === evidence.predecessorRunId
        );
        const evidenceStatus = result.output.status === "COMPLETED" ? "COMPLETED" : "FAILED";
        const acceptedTurn = authoritativeView.conversationTurns?.filter((turn) =>
          turn.sessionId === sessionId
          && turn.threadId === threadId
          && turn.sourceMessageId === acceptedTerminal?.messageId
          && turn.terminalRunId === acceptedTerminal?.runId
          && turn.status === acceptedTerminal?.status
          && Number.isSafeInteger(turn.sequence)
        ) ?? [];
        const evidenceTurn = authoritativeView.conversationTurns?.filter((turn) =>
          turn.sessionId === sessionId
          && turn.threadId === threadId
          && turn.sourceMessageId === evidence.messageId
          && turn.terminalRunId === evidence.runId
          && turn.status === evidenceStatus
          && Number.isSafeInteger(turn.sequence)
        ) ?? [];
        if (
          acceptedTerminal !== undefined
          && acceptedTurn.length === 1
          && evidenceTurn.length === 1
          && acceptedTurn[0]!.sequence! < evidenceTurn[0]!.sequence!
        ) {
          currentGraph = bindTuiQueueSuccessor(currentGraph, evidence, acceptedTerminal);
          orderedEvidence = [
            ...(currentGraph.pendingQueueSubmissions ?? []),
            ...(currentGraph.queuedRunReservations ?? []),
          ].find((candidate) => candidate.runId === evidence.runId) ?? evidence;
        }
      }
      const installAsCurrent = session.acceptedRunId === undefined
        || session.acceptedRunId === evidence.runId
        || (
          orderedEvidence.predecessorRunId !== undefined
          && session.acceptedRunId === orderedEvidence.predecessorRunId
        );
      let settledGraph = installAsCurrent
        ? advanceTuiQueueAuthority(currentGraph, orderedEvidence)
        : {
            ...currentGraph,
            queuedRunReservations: remaining?.length === 0 ? undefined : remaining,
            pendingQueueSubmissions: pendingQueueSubmission === undefined
              ? currentGraph.pendingQueueSubmissions
              : currentGraph.pendingQueueSubmissions?.filter((candidate) =>
                  candidate.runId !== pendingQueueSubmission.runId
                  || candidate.messageId !== pendingQueueSubmission.messageId
                  || candidate.threadId !== pendingQueueSubmission.threadId
                ),
          };
      const terminalStatus = result.output.status === "COMPLETED"
        ? "COMPLETED" as const
        : result.output.status === "FAILED"
          ? "FAILED" as const
          : undefined;
      if (installAsCurrent && terminalStatus !== undefined) {
        settledGraph = {
          ...settledGraph,
          queuedRunReservations: settledGraph.queuedRunReservations?.filter(
            (candidate) => candidate.runId !== orderedEvidence.runId,
          ),
          pendingQueueSubmissions: settledGraph.pendingQueueSubmissions?.filter(
            (candidate) => candidate.runId !== orderedEvidence.runId,
          ),
        };
        if (settledGraph.queuedRunReservations?.length === 0) settledGraph.queuedRunReservations = undefined;
        if (settledGraph.pendingQueueSubmissions?.length === 0) settledGraph.pendingQueueSubmissions = undefined;
      }
      const accepted = {
        ...session,
        started: true,
        ...(installAsCurrent
          ? {
              acceptedRunId: orderedEvidence.runId,
              acceptedRunMessageId: orderedEvidence.messageId,
              acceptedRunThreadId: orderedEvidence.threadId,
              acceptedRunPredecessorId: orderedEvidence.predecessorRunId ?? null,
              lastRunStatus: result.output.status,
            }
          : {}),
        queuedRunReservations: settledGraph.queuedRunReservations,
        pendingQueueSubmissions: settledGraph.pendingQueueSubmissions,
        terminalQueuedRuns: terminalStatus === undefined
          ? settledGraph.terminalQueuedRuns
          : settledGraph.terminalQueuedRuns?.some((candidate) => candidate.runId === orderedEvidence.runId)
            ? settledGraph.terminalQueuedRuns
            : [
                ...(settledGraph.terminalQueuedRuns ?? []),
                {
                  runId: orderedEvidence.runId,
                  messageId: orderedEvidence.messageId,
                  threadId: orderedEvidence.threadId,
                  ...(orderedEvidence.predecessorRunId !== undefined
                    ? { predecessorRunId: orderedEvidence.predecessorRunId }
                    : {}),
                  status: terminalStatus,
                },
              ],
        ...(session.delegation === undefined
          ? {}
          : {
              delegation: {
                ...session.delegation,
                status: result.output.status === "COMPLETED"
                  ? "COMPLETED" as const
                  : "FAILED" as const,
              },
            }),
      };
      uiStore.patch({
        sessions: state.sessions.map((candidate) =>
          candidate.sessionId === sessionId ? accepted : candidate
        ),
        ...(state.activeSession.sessionId === sessionId ? { activeSession: accepted } : {}),
      });
      persistCount += 1;
      return true;
    }),
    syncBackgroundSessionProgress: async (progress) => {
      backgroundProgress.push(progress);
    },
    syncBackgroundSessionResult: async () => {},
    syncBackgroundSessionFailure: async () => {},
    syncSessionFromDescribePayload: async (
      payload: Parameters<
        TuiRunControllerContext["syncSessionFromDescribePayload"]
      >[0],
    ) => {
      if (
        payload.threadId === undefined
        && payload.focusedThreadId === undefined
        && payload.activeAssembly === undefined
      ) {
        return;
      }
      const state = uiStore.getState();
      const sessionId = payload.sessionId ?? state.activeSession.sessionId;
      const session = state.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (session === undefined) return;
      const describedSession = {
        ...session,
        started: true,
        ...(payload.focusedThreadId !== undefined
          ? { focusedThreadId: payload.focusedThreadId }
          : payload.threadId !== undefined
            ? { focusedThreadId: payload.threadId }
            : {}),
        ...(payload.activeAssembly?.bundleId !== undefined
          ? { effectiveAssemblyId: payload.activeAssembly.bundleId }
          : {}),
      };
      uiStore.patch({
        sessions: state.sessions.map((candidate) =>
          candidate.sessionId === sessionId ? describedSession : candidate
        ),
        ...(state.activeSession.sessionId === sessionId
          ? { activeSession: describedSession }
          : {}),
      });
    },
    applyTerminalResult: async (
      _sessionId: string,
      result: { assistantText: string | null; output: NormalizedOutput },
    ) => {
      const output = result.output;
      if (output.status === "WAITING") {
        const prompt = extractWaitPrompt(output.waitFor);
        await context.appendHistoryLine(
          "system",
          buildWaitingSystemText(output.waitFor),
          {
            kind: "runtime.waiting_prompt",
            runId: output.runId,
            waitEventType: output.waitFor?.eventType ?? "unknown",
            ...(prompt === undefined ? {} : { prompt }),
          },
          output,
          `terminal:${output.runId}`,
        );
        return;
      }
      if (output.status === "FAILED") {
        await context.appendHistoryLine(
          "system",
          `Run failed: ${output.errors[0]?.message ?? "Run failed."}`,
          undefined,
          output,
          `terminal:${output.runId}`,
        );
        return;
      }
      await context.appendHistoryLine(
        result.assistantText === null ? "system" : "assistant",
        result.assistantText ?? "The run completed, but its final response could not be delivered.",
        undefined,
        output,
        `terminal:${output.runId}`,
      );
    },
    recoverTerminalMessages: input.recoverTerminalMessages ?? (async () => {}),
    getChatWrappedBodyWidth: () => 80,
    getChatListRows: () => 20,
    clearProgressForRun: () => {},
    pushRunLog: (line: AgentRunLogLine) => {
      runLogs.push(line);
    },
    enqueueAgentProgressTranscriptUpdate: (update: AgentProgressUpdateV1) => {
      reasoning.push(update);
    },
  } as unknown as TuiRunControllerContext;

  return {
    controller: new TuiRunController(context),
    context,
    uiStore,
    commands,
    history,
    diagnostics,
    runLogs,
    reasoning,
    backgroundProgress,
    registeredProfileId,
    get sessionDescribeCount() {
      return sessionDescribeCount;
    },
    get persistCount() {
      return persistCount;
    },
  };
}

test("TuiRunController backfills a started legacy session from exact runtime identity", async () => {
  const harness = createRunHarness({
    legacyEnvironmentMissing: true,
    runtimeEnvironmentPresetId: "cli_safe_local",
  });

  await harness.controller.startActiveTurn({ submittedMessage: "continue safely" });

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.environmentPresetId, "cli_safe_local");
  assert.equal(session.environmentShellKind, "cli");
  assert.deepEqual(session.environmentCapabilityPackIds, [
    "balanced",
    "filesystem",
    "sandbox_code",
  ]);
  assert.equal(session.effectiveAssemblyId, "bundle:kestrel:cli");
});

test("TuiRunController materializes the safe default for an unstarted detached legacy session", async () => {
  const harness = createRunHarness({
    started: false,
    legacyEnvironmentMissing: true,
    workspaceBinding: "detached",
    workspaceRoot: "/stale/workspace-binding",
  });

  await harness.controller.startActiveTurn({ submittedMessage: "start detached" });

  assert.equal(
    harness.uiStore.getState().activeSession.environmentPresetId,
    "cli_safe_local",
  );
  assert.equal(harness.uiStore.getState().activeSession.started, true);
});

test("TuiRunController starts a new workspace session under its developer environment", async () => {
  const harness = createRunHarness({
    started: false,
    legacyEnvironmentMissing: true,
    workspaceBinding: "active",
    workspaceRoot: "/workspace/project",
  });

  await harness.controller.startActiveTurn({ submittedMessage: "build the project" });

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.environmentPresetId, "cli_dev_local");
  assert.equal(session.started, true);
});

test("TuiRunController describes stale unstarted state with durable assembly evidence before dispatch", async () => {
  const harness = createRunHarness({
    started: false,
    legacyEnvironmentMissing: true,
    effectiveAssemblyId: "bundle:stale-start-assembly",
    runtimeEnvironmentPresetId: "cli_safe_local",
  });

  await harness.controller.startActiveTurn({ submittedMessage: "continue exact runtime" });

  assert.equal(harness.sessionDescribeCount, 1);
  assert.equal(
    harness.uiStore.getState().activeSession.environmentPresetId,
    "cli_safe_local",
  );
});

test("TuiRunController fails closed for stale unstarted accepted-thread evidence without runtime identity", async () => {
  const harness = createRunHarness({
    started: false,
    legacyEnvironmentMissing: true,
    sessionDescribeWithoutRuntimeEvidence: true,
    activeSessionPatch: {
      acceptedRunThreadId: "thread-main:session-1",
    },
  });

  await assert.rejects(
    harness.controller.startActiveTurn({ submittedMessage: "continue accepted runtime" }),
    /runtime-bound session has no exact environment identity/u,
  );
  assert.equal(harness.sessionDescribeCount, 1);
  assert.equal(harness.commands.length, 0);
  assert.equal(harness.uiStore.getState().activeSession.environmentPresetId, undefined);
});

test("TuiRunController requires runtime confirmation even when stale runtime-bound state has persisted identity", async () => {
  const harness = createRunHarness({
    started: false,
    environmentPresetId: "cli_dev_local",
    effectiveAssemblyId: "bundle:stale-start-persisted-environment",
    omitRuntimeEnvironmentIdentity: true,
  });

  await assert.rejects(
    harness.controller.startActiveTurn({ submittedMessage: "confirm exact runtime" }),
    /runtime-bound session has no exact environment identity/u,
  );
  assert.equal(harness.sessionDescribeCount, 1);
  assert.equal(harness.commands.length, 0);
  assert.equal(
    harness.uiStore.getState().activeSession.environmentPresetId,
    "cli_dev_local",
  );
});

test("TuiRunController rejects a stale unstarted queued-runtime environment conflict", async () => {
  const harness = createRunHarness({
    started: false,
    environmentPresetId: "cli_dev_local",
    runtimeEnvironmentPresetId: "cli_safe_local",
    activeSessionPatch: {
      queuedRunReservations: [{
        runId: "run-accepted-queued",
        messageId: "message-accepted-queued",
        threadId: "thread-main:session-1",
      }],
    },
  });

  await assert.rejects(
    harness.controller.startActiveTurn({ submittedMessage: "continue queued runtime" }),
    /Environment consistency failure/u,
  );
  assert.ok(harness.sessionDescribeCount >= 1);
  assert.equal(harness.commands.length, 0);
  assert.equal(
    harness.uiStore.getState().activeSession.environmentPresetId,
    "cli_dev_local",
  );
});

test("TuiRunController fails closed when a started legacy session has no exact environment", async () => {
  const harness = createRunHarness({
    legacyEnvironmentMissing: true,
    omitRuntimeEnvironmentIdentity: true,
  });

  await assert.rejects(
    harness.controller.startActiveTurn({ submittedMessage: "continue" }),
    /Environment unknown/u,
  );
  assert.equal(harness.commands.length, 0);
  assert.equal(harness.diagnostics.at(-1)?.scope, "tui.environment_identity");
  assert.match(harness.diagnostics.at(-1)?.details ?? "", /TUI_ENVIRONMENT_UNKNOWN/u);
});

test("TuiRunController fails closed when persisted and runtime environments conflict", async () => {
  const harness = createRunHarness({
    environmentPresetId: "cli_dev_local",
    runtimeEnvironmentPresetId: "cli_safe_local",
    effectiveAssemblyId: "bundle:kestrel:developer",
    pendingWaitFor: { kind: "user", eventType: "user.reply" },
  });

  await assert.rejects(
    harness.controller.startActiveTurn({
      submittedMessage: "continue",
      resumeBlockedRun: true,
    }),
    /Environment consistency failure/u,
  );
  assert.equal(harness.commands.length, 0);
  assert.equal(harness.diagnostics.at(-1)?.scope, "tui.environment_identity");
  assert.match(harness.diagnostics.at(-1)?.details ?? "", /TUI_ENVIRONMENT_CONFLICT/u);
});

test("TuiRunController re-verifies a started session with cached exact identity and fails closed on transport loss", async () => {
  const harness = createRunHarness({
    environmentPresetId: "cli_dev_local",
    effectiveAssemblyId: "bundle:kestrel:developer",
    sessionDescribeError: new Error("runner unavailable"),
  });

  await assert.rejects(
    harness.controller.startActiveTurn({ submittedMessage: "continue" }),
    /runtime identity could not be verified/u,
  );
  assert.equal(harness.sessionDescribeCount, 1);
  assert.equal(harness.commands.length, 0);
  assert.equal(harness.diagnostics.at(-1)?.scope, "tui.environment_identity");
});

for (const code of [
  "SESSION_ENVIRONMENT_IDENTITY_CONFLICT",
  "SESSION_ENVIRONMENT_IDENTITY_UNSUPPORTED",
] as const) {
  test(`TuiRunController preserves ${code} in ordinary-turn diagnostics`, async () => {
    const expectedDetails = {
      sessionId: "session-1",
      threadId: "thread-main:session-1",
      bundleId: "bundle-environment-failure",
      bundleEnvironmentPresetId: "cli_future_local",
    };
    const details: Record<string, unknown> = { ...expectedDetails };
    details.listenerCycle = details;
    const sessionDescribeError = Object.assign(new Error(`runtime ${code}`), {
      code,
      details,
    });
    const harness = createRunHarness({
      environmentPresetId: "cli_dev_local",
      effectiveAssemblyId: "bundle:kestrel:developer",
      sessionDescribeError,
    });

    await assert.rejects(
      harness.controller.startActiveTurn({ submittedMessage: "continue" }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && error.code === code);
        assert.deepEqual(
          (error as Error & { details?: Record<string, unknown> }).details,
          expectedDetails,
        );
        return true;
      },
    );
    assert.equal(harness.commands.length, 0);
    const diagnostic = JSON.parse(harness.diagnostics.at(-1)?.details ?? "{}") as {
      code?: string;
      failureDetails?: Record<string, unknown>;
    };
    assert.equal(diagnostic.code, code);
    assert.deepEqual(diagnostic.failureDetails, expectedDetails);
  });
}

test("TuiRunController rejects a session.describe response for a different session", async () => {
  const harness = createRunHarness({
    environmentPresetId: "cli_dev_local",
    effectiveAssemblyId: "bundle:kestrel:developer",
    describedSessionId: "different-session",
  });

  await assert.rejects(
    harness.controller.startActiveTurn({ submittedMessage: "continue" }),
    /different session/u,
  );
  assert.equal(harness.commands.length, 0);
  assert.equal(harness.uiStore.getState().activeSession.effectiveAssemblyId, "bundle:kestrel:developer");
});

test("TuiRunController routes blocked-run replies through the interaction command adapter", async () => {
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId: "request-resume-1",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
      },
    },
  });

  await harness.controller.startActiveTurn({
    submittedMessage: "continue",
    resumeBlockedRun: true,
  });

  assert.equal(harness.commands[0]?.type, "operator.control");
  assert.deepEqual(harness.commands[0]?.payload, {
    action: "reply",
    threadId: "thread-main:session-1",
    requestId: "request-resume-1",
    message: "continue",
    completionMode: "accepted",
  });
  assert.equal(harness.history.at(-1)?.text, "Done.");
  assert.equal(harness.uiStore.getState().running, false);
});

test("TuiRunController persists exact accepted operator-control run evidence", async () => {
  const requestId = "request-resume-accepted";
  const runId = "run-resume-accepted";
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId,
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
      },
    },
    sendCommand: async (type) => {
      assert.equal(type, "operator.control");
      const view = makeConversationView({ active: true });
      return makeRunnerEvent({
        type: "operator.controlled",
        sessionId: "session-1",
        threadId,
        runId,
        payload: {
          sessionId: "session-1",
          threadId,
          disposition: "accepted",
          runId,
          view: {
            ...view,
            activeRun: { runId, status: "RUNNING" },
            conversationTurns: [{
              ...view.conversationTurns![0]!,
              rootRunId: runId,
              activeRunId: runId,
            }],
          },
        },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-resume-accepted",
    submittedMessage: "continue",
    resumeBlockedRun: true,
  }), true);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, runId);
  assert.equal(session.acceptedRunMessageId, "message-resume-accepted");
  assert.equal(session.pendingRunRequestId, undefined);
  assert.equal(session.pendingRunThreadId, undefined);
  assert.equal(session.pendingWaitFor, undefined);
  assert.equal(harness.uiStore.getState().running, true);
});

test("TuiRunController forwards exact accepted reply ownership for a delegated waiting child", async () => {
  const requestId = "request-child-reply";
  const runId = "run-child-reply";
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId,
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
      },
    },
    activeSessionPatch: {
      focusedThreadId: threadId,
      acceptedRunId: "run-child-waiting",
      acceptedRunMessageId: "message-child-waiting",
      queuedRunReservations: [{
        runId: "run-queued-through-reply",
        messageId: "message-queued-through-reply",
        threadId,
      }],
      lastRunStatus: "WAITING",
      delegation: {
        taskId: "task-child-reply",
        parentSessionId: "session-parent",
        childSessionId: "session-1",
        childSessionName: "child-reply",
        title: "reply child",
        status: "WAITING",
        profileId: "kestrel",
        provider: "openrouter",
        model: "test-model",
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:02.000Z",
      },
    },
    sendCommand: async (type) => {
      assert.equal(type, "operator.control");
      const view = makeConversationView({ active: true });
      return makeRunnerEvent({
        type: "operator.controlled",
        sessionId: "session-1",
        threadId,
        runId,
        payload: {
          sessionId: "session-1",
          threadId,
          disposition: "accepted",
          runId,
          view: {
            ...view,
            activeRun: { runId, status: "RUNNING" },
            conversationTurns: [{
              ...view.conversationTurns![0]!,
              rootRunId: runId,
              activeRunId: runId,
            }],
          },
        },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-child-reply",
    submittedMessage: "continue",
    resumeBlockedRun: true,
  }), true);
  assert.deepEqual(harness.backgroundProgress, [{
    sessionId: "session-1",
    threadId,
    runId,
    messageId: "message-child-reply",
    requestId,
    status: "RUNNING",
    waitFor: undefined,
  }]);
  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: "run-queued-through-reply",
    messageId: "message-queued-through-reply",
    threadId,
  }]);
});

test("TuiRunController recovers an accepted blocked-run reply from exact durable request evidence", async () => {
  let controller: TuiRunController | undefined;
  const threadId = "thread-main:session-1";
  const requestId = "request-resume-lost";
  const runId = "run-resume-lost";
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId,
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
      },
    },
    sendCommand: async (type) => {
      if (type === "operator.control") {
        const pending = harness.uiStore.getState().activeSession;
        assert.equal(pending.pendingRunRequestId, requestId);
        assert.equal(pending.pendingRunThreadId, threadId);
        controller!.onRunnerEvent(makeRunnerEvent({
          type: "run.started",
          commandId: "command-resume-lost",
          sessionId: "session-1",
          threadId,
          runId,
          payload: {
            sessionId: "session-1",
            runId,
            eventType: "user.reply",
          },
        }));
        const error = new Error("operator response lost") as Error & { code: string };
        error.code = "EPIPE";
        throw error;
      }
      if (type === "operator.thread") {
        const view = makeConversationView({ active: true });
        return makeRunnerEvent({
          type: "operator.thread",
          payload: {
            view: {
              ...view,
              activeRun: { runId, status: "RUNNING" },
              conversationTurns: [{
                ...view.conversationTurns![0]!,
                rootRunId: runId,
                activeRunId: runId,
              }],
              conversationMessageRoutes: [{
                messageId: "reply-message-route",
                disposition: "replied",
                requestId,
                runId,
                createdAt: "2026-05-14T00:00:03.000Z",
              }],
            },
          },
        });
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  controller = harness.controller;

  assert.equal(await controller.startActiveTurn({
    messageId: "message-resume-lost",
    submittedMessage: "continue",
    resumeBlockedRun: true,
  }), true);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.started, true);
  assert.equal(session.acceptedRunId, runId);
  assert.equal(session.acceptedRunMessageId, "message-resume-lost");
  assert.equal(session.pendingRunRequestId, undefined);
  assert.equal(session.pendingRunThreadId, undefined);
  assert.equal(session.pendingWaitFor, undefined);
  assert.equal(session.lastRunStatus, undefined);
  assert.equal(harness.uiStore.getState().running, true);
  assert.equal(harness.history.some((line) => line.text.includes("communication failed")), false);
});

test("TuiRunController recovers exact blocked-run reply routes that are already terminal", async (t) => {
  for (const terminalStatus of ["COMPLETED", "FAILED"] as const) {
    await t.test(terminalStatus, async () => {
      const requestId = `request-resume-terminal-${terminalStatus.toLowerCase()}`;
      const runId = `run-resume-terminal-${terminalStatus.toLowerCase()}`;
      const threadId = "thread-main:session-1";
      const recoveries: string[] = [];
      const harness = createRunHarness({
        pendingWaitFor: {
          kind: "user",
          eventType: "user.reply",
          interaction: {
            version: "v1",
            requestId,
            kind: "user_input",
            eventType: "user.reply",
            prompt: "Continue?",
          },
        },
        recoverTerminalMessages: async (session) => {
          recoveries.push(`${session.acceptedRunId}:${session.lastRunStatus}`);
        },
        sendCommand: async (type) => {
          if (type === "operator.control") {
            throw Object.assign(new Error("operator response lost"), { code: "EPIPE" });
          }
          if (type === "operator.thread") {
            return makeRunnerEvent({
              type: "operator.thread",
              payload: {
                view: {
                  thread: {
                    threadId,
                    sessionId: "session-1",
                    title: "Main",
                    status: terminalStatus,
                    lastRunStatus: terminalStatus,
                    createdAt: "2026-05-14T00:00:00.000Z",
                    updatedAt: "2026-05-14T00:00:03.000Z",
                  },
                  childThreads: [],
                  childBlockerChain: [],
                  conversationTurns: [{
                    turnId: "turn-terminal-reply",
                    threadId,
                    sessionId: "session-1",
                    sequence: 2,
                    status: terminalStatus,
                    rootRunId: runId,
                    terminalRunId: runId,
                    terminalStatus,
                    startedAt: "2026-05-14T00:00:02.000Z",
                    updatedAt: "2026-05-14T00:00:03.000Z",
                    completedAt: "2026-05-14T00:00:03.000Z",
                  }],
                  conversationMessageRoutes: [{
                    messageId: `route-${requestId}`,
                    disposition: "replied",
                    requestId,
                    runId,
                    turnId: "turn-terminal-reply",
                    createdAt: "2026-05-14T00:00:02.000Z",
                  }],
                  followUpQueue: { state: "ready", items: [] },
                },
              },
            });
          }
          throw new Error(`Unexpected command '${type}'.`);
        },
      });

      assert.equal(await harness.controller.startActiveTurn({
        messageId: `message-${requestId}`,
        submittedMessage: "continue",
        resumeBlockedRun: true,
      }), true);
      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.acceptedRunId, runId);
      assert.equal(session.lastRunStatus, terminalStatus);
      assert.equal(session.pendingRunRequestId, undefined);
      assert.equal(harness.uiStore.getState().running, false);
      assert.equal(harness.uiStore.getState().statusLine, terminalStatus.toLowerCase());
      assert.deepEqual(recoveries, [`${runId}:${terminalStatus}`]);
    });
  }
});

test("TuiRunController preserves an already-terminal accepted operator-control view", async () => {
  const requestId = "request-terminal-controlled";
  const runId = "run-terminal-controlled";
  const threadId = "thread-main:session-1";
  const recoveries: string[] = [];
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId,
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
      },
    },
    recoverTerminalMessages: async (session) => {
      recoveries.push(`${session.acceptedRunId}:${session.lastRunStatus}`);
    },
    sendCommand: async () => makeRunnerEvent({
      type: "operator.controlled",
      sessionId: "session-1",
      threadId,
      runId,
      payload: {
        sessionId: "session-1",
        threadId,
        disposition: "accepted",
        runId,
        view: {
          thread: {
            threadId,
            sessionId: "session-1",
            title: "Main",
            status: "COMPLETED",
            lastRunStatus: "COMPLETED",
            createdAt: "2026-05-14T00:00:00.000Z",
            updatedAt: "2026-05-14T00:00:03.000Z",
          },
          childThreads: [],
          childBlockerChain: [],
          conversationTurns: [{
            turnId: "turn-terminal-controlled",
            threadId,
            sessionId: "session-1",
            sequence: 2,
            status: "COMPLETED",
            rootRunId: runId,
            terminalRunId: runId,
            terminalStatus: "COMPLETED",
            startedAt: "2026-05-14T00:00:02.000Z",
            updatedAt: "2026-05-14T00:00:03.000Z",
            completedAt: "2026-05-14T00:00:03.000Z",
          }],
          followUpQueue: { state: "ready", items: [] },
        },
      },
    }),
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-terminal-controlled",
    submittedMessage: "continue",
    resumeBlockedRun: true,
  }), true);
  assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, "COMPLETED");
  assert.equal(harness.uiStore.getState().running, false);
  assert.equal(harness.uiStore.getState().statusLine, "completed");
  assert.deepEqual(recoveries, [`${runId}:COMPLETED`]);
});

test("TuiRunController keeps an unobserved blocked-run reply recoverable without restoring its consumed wait", async () => {
  const requestId = "request-resume-unobserved";
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId,
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
      },
    },
    sendCommand: async (type) => {
      if (type === "operator.control") {
        throw Object.assign(new Error("operator response lost"), { code: "ECONNRESET" });
      }
      if (type === "operator.thread") throw new Error("durable route unavailable");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-resume-unobserved",
    submittedMessage: "continue",
    resumeBlockedRun: true,
  }), false);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.pendingRunRequestId, requestId);
  assert.equal(session.pendingRunMessageId, undefined);
  assert.equal(session.pendingWaitFor, undefined);
  assert.notEqual(session.lastRunStatus, "FAILED");
  assert.equal(harness.uiStore.getState().errorOverlay?.code, "RUN_ACCEPTANCE_UNCONFIRMED");
});

test("TuiRunController reconciles terminal outcomes when routing returns after completion", async () => {
  const recovered: string[] = [];
  const harness = createRunHarness({
    recoverTerminalMessages: async (session) => {
      recovered.push(session.sessionId);
    },
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          threadId: "thread-main:session-1",
          sessionId: "session-1",
          messageId: String(payload.messageId),
          disposition: "replied",
          runId,
          view: {
            ...makeConversationView(),
            conversationTurns: [{
              turnId: "turn-completed-before-route",
              threadId: "thread-main:session-1",
              sessionId: "session-1",
              sequence: 1,
              status: "COMPLETED",
              rootRunId: runId,
              terminalRunId: runId,
              terminalStatus: "COMPLETED",
              startedAt: "2026-05-14T00:00:00.000Z",
              completedAt: "2026-05-14T00:00:03.000Z",
              updatedAt: "2026-05-14T00:00:03.000Z",
            }],
          },
        },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({ submittedMessage: "finish" }), true);

  assert.deepEqual(recovered, ["session-1"]);
  assert.equal(harness.uiStore.getState().running, false);
  assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, "COMPLETED");
  assert.equal(harness.uiStore.getState().statusLine, "completed");
});

test("TuiRunController preserves an authoritative terminal event when the routed response is lost", async () => {
  let controller: TuiRunController | undefined;
  const harness = createRunHarness({
    started: false,
    sendCommand: async (type, payload) => {
      if (type === "conversation.message.submit") {
        const reservedRunId = String((payload.turn as Record<string, unknown>).runId);
        controller!.onRunnerEvent(makeRunnerEvent({
          type: "run.started",
          commandId: "command-route-lost",
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          runId: reservedRunId,
          payload: {
            sessionId: "session-1",
            runId: reservedRunId,
            eventType: "user.message",
            sourceMessageId: "message-route-lost",
          },
        }));
        controller!.onRunnerEvent(makeRunnerEvent({
          type: "run.completed",
          commandId: "command-route-lost",
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          runId: reservedRunId,
          payload: { result: makeCompletedResult(reservedRunId) },
        }));
        throw new Error("route response lost");
      }
      if (type === "operator.thread") throw new Error("transport disconnected");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  controller = harness.controller;

  assert.equal(await controller.startActiveTurn({
    messageId: "message-route-lost",
    submittedMessage: "finish despite disconnect",
  }), true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, "COMPLETED");
  assert.equal(harness.uiStore.getState().activeSession.started, true);
  assert.equal(harness.uiStore.getState().running, false);
  assert.equal(harness.uiStore.getState().errorOverlay, undefined);
  assert.equal(
    harness.history.some((line) => line.text.includes("Runner communication failed")),
    false,
  );
});

test("TuiRunController marks a first turn started when exact route recovery proves acceptance", async () => {
  const messageId = "message-first-route-recovered";
  let reservedRunId: string | undefined;
  const harness = createRunHarness({
    started: false,
    sendCommand: async (type, payload) => {
      if (type === "conversation.message.submit") {
        reservedRunId = String((payload.turn as Record<string, unknown>).runId);
        throw new Error("route response lost");
      }
      if (type === "operator.thread") {
        const view = makeConversationView({ active: true });
        const recoveredView = {
          ...view,
          activeRun: { runId: reservedRunId!, status: "RUNNING" as const },
          conversationTurns: view.conversationTurns.map((turn) => ({
            ...turn,
            rootRunId: reservedRunId!,
            activeRunId: reservedRunId!,
          })),
          conversationMessageRoutes: [{
            messageId,
            disposition: "started" as const,
            runId: reservedRunId!,
            turnId: "turn-1",
            createdAt: "2026-05-14T00:00:04.000Z",
          }],
        };
        return makeRunnerEvent({ type: "operator.thread", payload: { view: recoveredView } });
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId,
    submittedMessage: "start despite disconnect",
  }), true);

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.started, true);
  assert.equal(session.acceptedRunId, reservedRunId);
  assert.equal(session.acceptedRunThreadId, "thread-main:session-1");
  assert.equal(session.focusedThreadId, "thread-main:session-1");
});

test("TuiRunController keeps a rejected first turn unstarted without runtime evidence", async () => {
  const harness = createRunHarness({
    started: false,
    sessionDescribeWithoutRuntimeEvidence: true,
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") throw new Error("submission rejected");
      if (type === "operator.thread") throw new Error("thread not found");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-first-rejected",
    submittedMessage: "do not start",
  }), false);

  assert.equal(harness.uiStore.getState().activeSession.started, false);
  assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, undefined);
  assert.equal(harness.uiStore.getState().errorOverlay?.code, "RUN_ACCEPTANCE_UNCONFIRMED");
});

test("TuiRunController keeps coded transport failures recoverable", async (t) => {
  for (const code of ["ECONNRESET", "EPIPE", "RUNNER_TRANSPORT_ERROR"] as const) {
    await t.test(code, async () => {
      const harness = createRunHarness({
        started: false,
        sessionDescribeError: new Error("describe unavailable"),
        sendCommand: async () => {
          throw Object.assign(new Error(`${code} during response delivery`), { code });
        },
      });

      assert.equal(await harness.controller.startActiveTurn({
        messageId: `message-${code}`,
        submittedMessage: "start work",
      }), false);

      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.started, false);
      assert.equal(session.lastRunStatus, undefined);
      assert.equal(session.pendingRunMessageId, `message-${code}`);
      assert.equal(harness.uiStore.getState().errorOverlay?.code, "RUN_ACCEPTANCE_UNCONFIRMED");
    });
  }
});

test("TuiRunController preserves an explicit environment rejection as preaccept failure", async () => {
  const harness = createRunHarness({
    started: false,
    sessionDescribeError: new Error("describe unavailable"),
    sendCommand: async () => {
      throw Object.assign(new Error("runtime environment conflicts with the session"), {
        code: "SESSION_ENVIRONMENT_IDENTITY_CONFLICT",
        details: { persisted: "cli_dev_local", runtime: "cli_safe_local" },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({ submittedMessage: "start" }), false);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.started, false);
  assert.equal(session.lastRunStatus, "FAILED");
  assert.equal(session.pendingRunMessageId, undefined);
  assert.equal(harness.uiStore.getState().errorOverlay?.code, "SESSION_ENVIRONMENT_IDENTITY_CONFLICT");
  assert.equal(harness.sessionDescribeCount, 0);
});

test("TuiRunController durably accepts one delayed exact foreground run.started", async () => {
  const messageId = "message-delayed-start";
  const harness = createRunHarness({
    started: false,
    sessionDescribeError: new Error("describe unavailable"),
    sendCommand: async () => {
      throw Object.assign(new Error("response lost"), { code: "EPIPE" });
    },
  });
  assert.equal(await harness.controller.startActiveTurn({ messageId, submittedMessage: "start" }), false);
  const reservedRunId = harness.uiStore.getState().activeSession.pendingRunId;
  assert.match(reservedRunId ?? "", /^tui-foreground:/u);
  const beforeAcceptanceWrites = harness.persistCount;
  const event = makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: reservedRunId!,
    payload: {
      sessionId: "session-1",
      runId: reservedRunId!,
      eventType: "user.message",
      sourceMessageId: messageId,
    },
  });

  harness.controller.onRunnerEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.controller.onRunnerEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.started, true);
  assert.equal(session.acceptedRunId, reservedRunId);
  assert.equal(session.acceptedRunThreadId, "thread-main:session-1");
  assert.equal(session.pendingRunId, undefined);
  assert.equal(session.pendingRunMessageId, undefined);
  assert.equal(session.lastRunStatus, undefined);
  assert.equal(harness.uiStore.getState().errorOverlay, undefined);
  assert.equal(harness.persistCount, beforeAcceptanceWrites + 1);
});

test("TuiRunController recovers a persisted pending foreground start after restart and replaces terminal run identity", async () => {
  const harness = createRunHarness({
    started: true,
    activeSessionPatch: {
      pendingRunId: "run-after-restart",
      pendingRunMessageId: "message-after-restart",
      pendingRunThreadId: "thread-main:session-1",
      acceptedRunId: "run-previous",
      acceptedRunMessageId: "message-previous",
      acceptedRunThreadId: "thread-main:session-1",
      lastRunStatus: "COMPLETED",
    },
  });

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: "run-after-restart",
    payload: {
      sessionId: "session-1",
      runId: "run-after-restart",
      eventType: "user.message",
      sourceMessageId: "message-after-restart",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.started, true);
  assert.equal(session.acceptedRunId, "run-after-restart");
  assert.equal(session.acceptedRunMessageId, "message-after-restart");
  assert.equal(session.acceptedRunThreadId, "thread-main:session-1");
  assert.equal(session.pendingRunId, undefined);
  assert.equal(session.pendingRunMessageId, undefined);
  assert.equal(session.lastRunStatus, undefined);
  assert.equal(harness.uiStore.getState().running, true);
  assert.equal(harness.persistCount, 1);
});

test("TuiRunController persists and dispatches one caller-owned foreground run reservation", async () => {
  let persistedReservation: string | undefined;
  let dispatchedReservation: string | undefined;
  let harness: ReturnType<typeof createRunHarness>;
  harness = createRunHarness({
    started: false,
    sendCommand: async (_type, payload) => {
      persistedReservation = harness.uiStore.getState().activeSession.pendingRunId;
      dispatchedReservation = (payload.turn as Record<string, unknown> | undefined)?.runId as string | undefined;
      const view = makeConversationView({ active: true });
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          messageId: String(payload.messageId),
          disposition: "started",
          runId: dispatchedReservation,
          view: {
            ...view,
            activeRun: { runId: dispatchedReservation!, status: "RUNNING" },
            conversationTurns: view.conversationTurns.map((turn) => ({
              ...turn,
              rootRunId: dispatchedReservation!,
              activeRunId: dispatchedReservation!,
            })),
          },
        },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-reserved",
    submittedMessage: "start exactly once",
  }), true);

  assert.match(dispatchedReservation ?? "", /^tui-foreground:/u);
  assert.equal(persistedReservation, dispatchedReservation);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.pendingRunId, undefined);
  assert.equal(session.acceptedRunId, dispatchedReservation);
  assert.equal(session.acceptedRunMessageId, "message-reserved");
  assert.equal(session.acceptedRunThreadId, "thread-main:session-1");
});

test("TuiRunController rejects a routed run that disagrees with its persisted reservation", async () => {
  const harness = createRunHarness({
    started: false,
    sessionDescribeWithoutRuntimeEvidence: true,
    sendCommand: async (_type, payload) => {
      const view = makeConversationView({ active: true });
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          messageId: String(payload.messageId),
          disposition: "started",
          runId: "run-not-reserved",
          view: {
            ...view,
            activeRun: { runId: "run-not-reserved", status: "RUNNING" },
            conversationTurns: view.conversationTurns.map((turn) => ({
              ...turn,
              rootRunId: "run-not-reserved",
              activeRunId: "run-not-reserved",
            })),
          },
        },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-reservation-mismatch",
    submittedMessage: "start",
  }), false);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.started, false);
  assert.equal(session.acceptedRunId, undefined);
  assert.match(session.pendingRunId ?? "", /^tui-foreground:/u);
});

test("TuiRunController drops internally inconsistent run.started identity", async () => {
  const harness = createRunHarness({
    started: false,
    sessionDescribeError: new Error("describe unavailable"),
    sendCommand: async () => { throw new Error("response lost"); },
  });
  await harness.controller.startActiveTurn({ messageId: "message-start", submittedMessage: "start" });

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: "run-envelope",
    payload: {
      sessionId: "session-other",
      runId: "run-payload",
      eventType: "user.message",
      sourceMessageId: "message-start",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.uiStore.getState().activeSession.started, false);
  assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, undefined);
});

test("TuiRunController rejects routed session and thread mismatches before acceptance", async (t) => {
  for (const mismatch of ["session", "thread", "view-session", "view-thread"] as const) {
    await t.test(mismatch, async () => {
      const requestedThread = "thread-main:session-1";
      const view = makeConversationView({ active: true });
      const harness = createRunHarness({
        started: false,
        sessionDescribeWithoutRuntimeEvidence: true,
        sendCommand: async (_type, payload) => makeRunnerEvent({
          type: "conversation.message.routed",
          payload: {
            sessionId: mismatch === "session" ? "session-other" : "session-1",
            threadId: mismatch === "thread" ? "thread-other" : requestedThread,
            messageId: String((payload as Record<string, unknown>).messageId),
            disposition: "started",
            view: {
              ...view,
              thread: {
                ...view.thread,
                sessionId: mismatch === "view-session" ? "session-other" : "session-1",
                threadId: mismatch === "view-thread" ? "thread-other" : requestedThread,
              },
            },
          },
        }),
      });

      assert.equal(await harness.controller.startActiveTurn({ submittedMessage: "start" }), false);
      assert.equal(harness.uiStore.getState().activeSession.started, false);
      assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, undefined);
      assert.equal(harness.sessionDescribeCount, 0);
    });
  }
});

test("TuiRunController rejects started routes without one run identity shared by the route and active view", async (t) => {
  for (const mismatch of ["missing", "conflict"] as const) {
    await t.test(mismatch, async () => {
      const view = makeConversationView({ active: true });
      const harness = createRunHarness({
        started: false,
        sessionDescribeWithoutRuntimeEvidence: true,
        sendCommand: async (_type, payload) => makeRunnerEvent({
          type: "conversation.message.routed",
          payload: {
            sessionId: "session-1",
            threadId: "thread-main:session-1",
            messageId: String((payload as Record<string, unknown>).messageId),
            disposition: "started",
            ...(mismatch === "conflict" ? { runId: "run-route-other" } : {}),
            view,
          },
        }),
      });

      assert.equal(await harness.controller.startActiveTurn({ submittedMessage: "start" }), false);
      assert.equal(harness.uiStore.getState().activeSession.started, false);
      assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, undefined);
      assert.equal(harness.sessionDescribeCount, 0);
    });
  }
});

test("TuiRunController rejects a terminal response with cross-session output before acceptance", async () => {
  const harness = createRunHarness({
    started: false,
    sendCommand: async () => makeRunnerEvent({
      type: "run.completed",
      sessionId: "session-1",
      runId: "run-cross-session",
      payload: {
        result: {
          assistantText: "wrong session",
          output: makeCompletedOutput("session-other", "run-cross-session"),
        },
      },
    }),
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-cross-session",
    submittedMessage: "start",
  }), false);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.started, false);
  assert.equal(session.acceptedRunId, undefined);
  assert.equal(session.pendingRunMessageId, "message-cross-session");
  assert.equal(harness.sessionDescribeCount, 0);
});

test("TuiRunController rejects stale prior-run and wrong-thread foreground terminal responses", async (t) => {
  for (const mismatch of ["prior-run", "thread"] as const) {
    await t.test(mismatch, async () => {
      const expectedRunId = mismatch === "prior-run" ? "run-prior" : "run-new";
      const harness = createRunHarness({
        activeSessionPatch: {
          acceptedRunId: "run-prior",
          acceptedRunMessageId: "message-prior",
          lastRunStatus: "COMPLETED",
        },
        sendCommand: async () => makeRunnerEvent({
          type: "run.completed",
          sessionId: "session-1",
          runId: expectedRunId,
          threadId: mismatch === "thread" ? "thread-other" : "thread-main:session-1",
          payload: { result: makeCompletedResult(expectedRunId) },
        }),
      });

      assert.equal(await harness.controller.startActiveTurn({
        messageId: "message-new",
        submittedMessage: "new work",
      }), false);
      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.acceptedRunId, "run-prior");
      assert.equal(session.acceptedRunMessageId, "message-prior");
      assert.equal(session.pendingRunMessageId, "message-new");
      assert.equal(harness.history.some((line) => line.text === "Done."), false);
      assert.equal(harness.sessionDescribeCount, 1);
    });
  }
});

test("TuiRunController does not accept a new submission from an unrelated terminal event", async () => {
  let controller: TuiRunController | undefined;
  const harness = createRunHarness({
    started: false,
    sessionDescribeWithoutRuntimeEvidence: true,
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") {
        controller!.onRunnerEvent(makeRunnerEvent({
          type: "run.completed",
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          runId: "run-older",
          payload: { result: makeCompletedResult("run-older") },
        }));
        throw new Error("new submission response lost");
      }
      if (type === "operator.thread") throw new Error("thread unavailable");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  controller = harness.controller;

  assert.equal(await controller.startActiveTurn({
    messageId: "message-new",
    submittedMessage: "new work",
  }), false);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.uiStore.getState().activeSession.started, false);
});

test("TuiRunController keeps a pre-run.started protocol failure unstarted", async () => {
  let rejectedReservation: string | undefined;
  const harness = createRunHarness({
    started: false,
    sendCommand: async (_type, payload) => {
      rejectedReservation = (payload.turn as Record<string, unknown> | undefined)?.runId as string | undefined;
      return makeRunnerEvent({
        type: "run.failed",
        commandId: "command-preaccept-failure",
        runId: rejectedReservation,
        payload: {
          result: makeFailedResult(rejectedReservation ?? "missing-reservation"),
          error: { code: "RUN_START_REJECTED", message: "Run was rejected before acceptance." },
        },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-preaccept-failure",
    submittedMessage: "start work",
  }), false);

  assert.match(rejectedReservation ?? "", /^tui-foreground:/u);
  assert.equal(harness.uiStore.getState().activeSession.started, false);
  assert.equal(harness.uiStore.getState().activeSession.pendingRunId, undefined);
  assert.equal(
    harness.history.some((line) => line.data?.kind === "runtime.terminal.v1"),
    false,
  );
});

test("TuiRunController preserves durable thread start evidence when message acceptance is unconfirmed", async () => {
  const harness = createRunHarness({
    started: false,
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") throw new Error("route response lost");
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: { view: makeConversationView({ active: true }) },
        });
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-thread-recovered",
    submittedMessage: "start with durable thread",
  }), false);

  assert.equal(harness.uiStore.getState().activeSession.started, true);
  assert.equal(harness.uiStore.getState().activeSession.focusedThreadId, "thread-main:session-1");
  assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, undefined);
});

test("TuiRunController preserves durable assembly start evidence when routing recovery is unavailable", async () => {
  const harness = createRunHarness({
    started: false,
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") throw new Error("route response lost");
      if (type === "operator.thread") throw new Error("thread transport unavailable");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-assembly-recovered",
    submittedMessage: "start with durable assembly",
  }), false);

  assert.equal(harness.uiStore.getState().activeSession.started, true);
  assert.equal(harness.uiStore.getState().activeSession.effectiveAssemblyId, "bundle:kestrel:cli");
  assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, undefined);
});

test("TuiRunController sends active-run input to Local Core queue authority immediately", async () => {
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let queuedReservation: string | undefined;
  const activeView = makeConversationView({ active: true });
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-start-1",
      acceptedRunMessageId: "message-current",
      acceptedRunThreadId: "thread-main:session-1",
    },
    sendCommand: async (type, payload) => {
      commands.push({ type, payload: payload as Record<string, unknown> });
      queuedReservation = (payload.turn as Record<string, unknown> | undefined)?.runId as string | undefined;
      return makeRunnerEvent({
        type: "conversation.message.routed",
        commandId: "command-queued",
        payload: {
          threadId: "thread-main:session-1",
          sessionId: "session-1",
          messageId: String((payload as Record<string, unknown>).messageId),
          disposition: "queued",
          followUpId: "follow-up:message-queued",
          view: {
            ...activeView,
            conversationMessageRoutes: [{
              messageId: String((payload as Record<string, unknown>).messageId),
              disposition: "queued",
              followUpId: "follow-up:message-queued",
              createdAt: "2026-05-14T00:00:04.000Z",
            }],
            followUpQueue: {
              state: "ready",
              items: [{
                followUpId: "follow-up:message-queued",
                message: "next task",
                attachmentIds: [],
                createdAt: "2026-05-14T00:00:04.000Z",
                state: "queued",
                source: "human",
                sourceMessageId: String((payload as Record<string, unknown>).messageId),
              }],
            },
          },
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  const accepted = await harness.controller.startActiveTurn({
    messageId: "message-queued",
    submittedMessage: "next task",
  });
  assert.equal(accepted, true, JSON.stringify({
    activeSession: harness.uiStore.getState().activeSession,
    errorOverlay: harness.uiStore.getState().errorOverlay,
    history: harness.history,
  }));

  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.type, "conversation.message.submit");
  assert.equal(commands[0]?.payload.messageId, "message-queued");
  assert.match(queuedReservation ?? "", /^tui-foreground:/u);
  assert.equal(harness.uiStore.getState().activeSession.pendingRunId, undefined);
  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: queuedReservation,
    messageId: "message-queued",
    threadId: "thread-main:session-1",
    predecessorRunId: "run-start-1",
  }]);
  assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, "run-start-1");
  assert.equal(harness.uiStore.getState().running, true);
  assert.match(harness.uiStore.getState().statusLine, /queued behind current work/u);

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: queuedReservation!,
    payload: {
      sessionId: "session-1",
      runId: queuedReservation!,
      eventType: "user.message",
      sourceMessageId: "message-queued",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const promoted = harness.uiStore.getState().activeSession;
  assert.equal(promoted.pendingRunId, undefined);
  assert.equal(promoted.queuedRunReservations, undefined);
  assert.equal(promoted.acceptedRunId, queuedReservation);
  assert.equal(promoted.acceptedRunMessageId, "message-queued");
  assert.equal(promoted.acceptedRunThreadId, "thread-main:session-1");
});

test("TuiRunController retains two exact queued reservations and consumes only the promoted run", async () => {
  const activeView = makeConversationView({ active: true });
  const dispatched: Array<{ runId: string; messageId: string }> = [];
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: "thread-main:session-1",
    },
    sendCommand: async (type, payload) => {
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: {
            view: {
              ...makeConversationView({ active: true }),
              activeRun: { runId: "run-r0", status: "RUNNING" },
            },
          },
        });
      }
      assert.equal(type, "conversation.message.submit");
      const messageId = String((payload as Record<string, unknown>).messageId);
      const runId = String((payload.turn as Record<string, unknown>).runId);
      dispatched.push({ runId, messageId });
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          threadId: "thread-main:session-1",
          sessionId: "session-1",
          messageId,
          disposition: "queued",
          followUpId: `follow-up:${messageId}`,
          view: activeView,
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-queued-a",
    submittedMessage: "queued A",
    queueRequested: true,
  }), true);
  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-queued-b",
    submittedMessage: "queued B",
    queueRequested: true,
  }), true);
  assert.deepEqual(
    harness.uiStore.getState().activeSession.queuedRunReservations,
    [{
      ...dispatched[0]!,
      threadId: "thread-main:session-1",
      predecessorRunId: "run-r0",
    }, {
      ...dispatched[1]!,
      threadId: "thread-main:session-1",
      predecessorRunId: dispatched[0]!.runId,
    }],
  );

  for (const promoted of dispatched) {
    harness.controller.onRunnerEvent(makeRunnerEvent({
      type: "run.started",
      sessionId: "session-1",
      threadId: "thread-main:session-1",
      runId: promoted.runId,
      payload: {
        sessionId: "session-1",
        runId: promoted.runId,
        eventType: "user.message",
        sourceMessageId: promoted.messageId,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, dispatched[1]!.runId);
  assert.equal(session.queuedRunReservations, undefined);
});

test("TuiRunController preserves an exact queued reservation when the route response is lost", async () => {
  let reservedRunId = "";
  const messageId = "message-queued-response-loss";
  const activeView = makeConversationView({ active: true });
  const harness = createRunHarness({
    sendCommand: async (type, payload) => {
      if (type === "conversation.message.submit") {
        reservedRunId = String((payload.turn as Record<string, unknown>).runId);
        throw Object.assign(new Error("route response lost"), { code: "ECONNRESET" });
      }
      assert.equal(type, "operator.thread");
      return makeRunnerEvent({
        type: "operator.thread",
        payload: {
          view: {
            ...activeView,
            conversationMessageRoutes: [{
              messageId,
              runId: reservedRunId,
              disposition: "queued",
              followUpId: "follow-up:response-loss",
              createdAt: "2026-05-14T00:00:04.000Z",
            }],
          },
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId,
    submittedMessage: "queue despite response loss",
  }), true);
  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: reservedRunId,
    messageId,
    threadId: "thread-main:session-1",
  }]);
  assert.equal(harness.uiStore.getState().activeSession.pendingRunId, undefined);
});

test("TuiRunController keeps two pre-confirmation queue submissions independently recoverable", async () => {
  const pendingResponses = new Map<
    string,
    { runId: string; resolve: (event: RunnerEvent) => void; reject: (error: Error) => void }
  >();
  const activeView = makeConversationView({ active: true });
  const harness = createRunHarness({
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      const messageId = String((payload as Record<string, unknown>).messageId);
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return await new Promise<RunnerEvent>((resolve, reject) => {
        pendingResponses.set(messageId, { runId, resolve, reject });
      });
    },
  });
  const waitForPendingCount = async (count: number) => {
    for (let attempt = 0; attempt < 20 && pendingResponses.size < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(pendingResponses.size, count);
  };

  const first = harness.controller.startActiveTurn({
    messageId: "message-preconfirm-a",
    submittedMessage: "queued A",
    queueRequested: true,
  });
  await waitForPendingCount(1);
  const second = harness.controller.startActiveTurn({
    messageId: "message-preconfirm-b",
    submittedMessage: "queued B",
    queueRequested: true,
  });
  await waitForPendingCount(2);

  assert.deepEqual(
    harness.uiStore.getState().activeSession.pendingQueueSubmissions,
    [{
      runId: pendingResponses.get("message-preconfirm-a")!.runId,
      messageId: "message-preconfirm-a",
      threadId: "thread-main:session-1",
      indeterminate: true,
    }, {
      runId: pendingResponses.get("message-preconfirm-b")!.runId,
      messageId: "message-preconfirm-b",
      threadId: "thread-main:session-1",
      predecessorRunId: pendingResponses.get("message-preconfirm-a")!.runId,
      indeterminate: true,
    }],
  );

  const accepted = pendingResponses.get("message-preconfirm-a")!;
  accepted.resolve(makeRunnerEvent({
    type: "conversation.message.routed",
    payload: {
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      messageId: "message-preconfirm-a",
      disposition: "queued",
      followUpId: "follow-up:preconfirm-a",
      view: activeView,
    },
  }));
  assert.equal(await first, true);
  assert.deepEqual(harness.uiStore.getState().activeSession.pendingQueueSubmissions, [{
    runId: pendingResponses.get("message-preconfirm-b")!.runId,
    messageId: "message-preconfirm-b",
    threadId: "thread-main:session-1",
    predecessorRunId: accepted.runId,
    indeterminate: true,
  }]);
  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: accepted.runId,
    messageId: "message-preconfirm-a",
    threadId: "thread-main:session-1",
  }]);

  const rejected = pendingResponses.get("message-preconfirm-b")!;
  rejected.reject(Object.assign(new Error("queue B rejected"), {
    code: "SESSION_ENVIRONMENT_IDENTITY_CONFLICT",
  }));
  assert.equal(await second, false);
  assert.equal(harness.uiStore.getState().activeSession.pendingQueueSubmissions, undefined);
  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: accepted.runId,
    messageId: "message-preconfirm-a",
    threadId: "thread-main:session-1",
  }]);
});

test("TuiRunController rewires a successor when its live predecessor is rejected", async () => {
  const pendingResponses = new Map<
    string,
    { runId: string; resolve: (event: RunnerEvent) => void; reject: (error: Error) => void }
  >();
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
    },
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      const messageId = String(payload.messageId);
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return await new Promise<RunnerEvent>((resolve, reject) => {
        pendingResponses.set(messageId, { runId, resolve, reject });
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });
  const waitForPendingCount = async (count: number) => {
    for (let attempt = 0; attempt < 20 && pendingResponses.size < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(pendingResponses.size, count);
  };

  const q1 = harness.controller.startActiveTurn({
    messageId: "message-rewire-q1",
    submittedMessage: "Q1",
    queueRequested: true,
  });
  await waitForPendingCount(1);
  const q2 = harness.controller.startActiveTurn({
    messageId: "message-rewire-q2",
    submittedMessage: "Q2",
    queueRequested: true,
  });
  await waitForPendingCount(2);

  pendingResponses.get("message-rewire-q1")!.reject(Object.assign(
    new Error("Q1 rejected"),
    { code: "SESSION_ENVIRONMENT_IDENTITY_CONFLICT" },
  ));
  assert.equal(await q1, false);
  const q2Response = pendingResponses.get("message-rewire-q2")!;
  q2Response.resolve(makeRunnerEvent({
    type: "conversation.message.routed",
    payload: {
      sessionId: "session-1",
      threadId,
      messageId: "message-rewire-q2",
      disposition: "queued",
      runId: q2Response.runId,
      followUpId: "follow-up:rewire-q2",
      view: makeConversationView({ active: true }),
    },
  }));
  assert.equal(await q2, true);
  assert.equal(
    harness.uiStore.getState().activeSession.queuedRunReservations?.[0]?.predecessorRunId,
    "run-r0",
  );

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId,
    runId: q2Response.runId,
    payload: {
      sessionId: "session-1",
      runId: q2Response.runId,
      eventType: "user.message",
      sourceMessageId: "message-rewire-q2",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, q2Response.runId);
});

test("TuiRunController removes a response-lost absent route before queuing its successor", async () => {
  let submissionCount = 0;
  let q2RunId = "";
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
    },
    sendCommand: async (type, payload) => {
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: {
            view: {
              ...makeConversationView({ active: true }),
              conversationMessageRoutes: [],
            },
          },
        });
      }
      assert.equal(type, "conversation.message.submit");
      submissionCount += 1;
      if (submissionCount === 1) throw new Error("Q1 route response lost");
      q2RunId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId,
          messageId: "message-response-loss-q2",
          disposition: "queued",
          runId: q2RunId,
          followUpId: "follow-up:response-loss-q2",
          view: makeConversationView({ active: true }),
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-response-loss-q1",
    submittedMessage: "Q1",
    queueRequested: true,
  }), false);
  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-response-loss-q2",
    submittedMessage: "Q2",
    queueRequested: true,
  }), true);

  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: q2RunId,
    messageId: "message-response-loss-q2",
    threadId,
    predecessorRunId: "run-r0",
  }]);
});

test("TuiRunController preserves exact pending predecessors across reverse queue responses", async () => {
  const pendingResponses = new Map<
    string,
    { runId: string; resolve: (event: RunnerEvent) => void }
  >();
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: "thread-main:session-1",
    },
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      const messageId = String((payload as Record<string, unknown>).messageId);
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return await new Promise<RunnerEvent>((resolve) => {
        pendingResponses.set(messageId, { runId, resolve });
      });
    },
  });
  const waitForPendingCount = async (count: number) => {
    for (let attempt = 0; attempt < 20 && pendingResponses.size < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(pendingResponses.size, count);
  };
  const first = harness.controller.startActiveTurn({
    messageId: "message-reverse-q1",
    submittedMessage: "queue one",
    queueRequested: true,
  });
  await waitForPendingCount(1);
  const second = harness.controller.startActiveTurn({
    messageId: "message-reverse-q2",
    submittedMessage: "queue two",
    queueRequested: true,
  });
  await waitForPendingCount(2);

  const respond = (messageId: string) => {
    const pending = pendingResponses.get(messageId)!;
    pending.resolve(makeRunnerEvent({
      type: "conversation.message.routed",
      payload: {
        threadId: "thread-main:session-1",
        sessionId: "session-1",
        messageId,
        disposition: "queued",
        followUpId: `follow-up:${messageId}`,
        view: makeConversationView({ active: true }),
      },
    }));
  };
  respond("message-reverse-q2");
  assert.equal(await second, true);
  respond("message-reverse-q1");
  assert.equal(await first, true);

  const q1 = pendingResponses.get("message-reverse-q1")!;
  const q2 = pendingResponses.get("message-reverse-q2")!;
  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: q1.runId,
    messageId: "message-reverse-q1",
    threadId: "thread-main:session-1",
    predecessorRunId: "run-r0",
  }, {
    runId: q2.runId,
    messageId: "message-reverse-q2",
    threadId: "thread-main:session-1",
    predecessorRunId: q1.runId,
  }]);

  const third = harness.controller.startActiveTurn({
    messageId: "message-reverse-q3",
    submittedMessage: "queue three",
    queueRequested: true,
  });
  await waitForPendingCount(3);
  respond("message-reverse-q3");
  assert.equal(await third, true);
  const q3 = pendingResponses.get("message-reverse-q3")!;
  assert.equal(
    harness.uiStore.getState().activeSession.queuedRunReservations?.at(-1)?.predecessorRunId,
    q2.runId,
  );
});

test("TuiRunController settles reverse queued terminal responses exactly once", async () => {
  const pendingResponses = new Map<
    string,
    { runId: string; resolve: (event: RunnerEvent) => void }
  >();
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: "thread-main:session-1",
    },
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      const messageId = String((payload as Record<string, unknown>).messageId);
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return await new Promise<RunnerEvent>((resolve) => {
        pendingResponses.set(messageId, { runId, resolve });
      });
    },
  });
  const waitForPendingCount = async (count: number) => {
    for (let attempt = 0; attempt < 20 && pendingResponses.size < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(pendingResponses.size, count);
  };
  const first = harness.controller.startActiveTurn({
    messageId: "message-terminal-q1",
    submittedMessage: "terminal one",
    queueRequested: true,
  });
  await waitForPendingCount(1);
  const second = harness.controller.startActiveTurn({
    messageId: "message-terminal-q2",
    submittedMessage: "terminal two",
    queueRequested: true,
  });
  await waitForPendingCount(2);

  const q1 = pendingResponses.get("message-terminal-q1")!;
  const q2 = pendingResponses.get("message-terminal-q2")!;
  q2.resolve(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: q2.runId,
    payload: { result: makeCompletedResult(q2.runId) },
  }));
  assert.equal(await second, true);
  q1.resolve(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: q1.runId,
    payload: { result: makeCompletedResult(q1.runId) },
  }));
  assert.equal(await first, true);

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.pendingQueueSubmissions, undefined);
  assert.equal(session.acceptedRunId, q2.runId);
  assert.deepEqual(
    session.terminalQueuedRuns?.map((terminal) => ({
      runId: terminal.runId,
      messageId: terminal.messageId,
      predecessorRunId: terminal.predecessorRunId,
    })),
    [{
      runId: q2.runId,
      messageId: "message-terminal-q2",
      predecessorRunId: q1.runId,
    }, {
      runId: q1.runId,
      messageId: "message-terminal-q1",
      predecessorRunId: "run-r0",
    }],
  );
  assert.equal(harness.history.filter((line) => line.text === "Done.").length, 1);
});

test("TuiRunController blocks Q3 until exact authority resolves an issue19 fork", async () => {
  let q3RunId = "";
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
      queuedRunReservations: [{
        runId: "run-q2",
        messageId: "message-q2",
        threadId,
        predecessorRunId: "run-r0",
      }, {
        runId: "run-q1",
        messageId: "message-q1",
        threadId,
        predecessorRunId: "run-r0",
      }],
    },
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      q3RunId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId,
          messageId: "message-q3",
          disposition: "queued",
          runId: q3RunId,
          followUpId: "follow-up:q3",
          view: makeConversationView({ active: true }),
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  await assert.rejects(() => harness.controller.startActiveTurn({
    messageId: "message-q3-blocked",
    submittedMessage: "Q3 blocked",
    queueRequested: true,
  }), /unresolved queue fork/u);
  assert.equal(q3RunId, "");

  for (const [runId, messageId] of [
    ["run-q1", "message-q1"],
    ["run-q1", "message-q1"],
    ["run-q2", "message-q2"],
  ] as const) {
    harness.controller.onRunnerEvent(makeRunnerEvent({
      type: "run.started",
      sessionId: "session-1",
      threadId,
      runId,
      payload: {
        sessionId: "session-1",
        runId,
        eventType: "user.message",
        sourceMessageId: messageId,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-q3",
    submittedMessage: "Q3",
    queueRequested: true,
  }), true);

  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: q3RunId,
    messageId: "message-q3",
    threadId,
    predecessorRunId: "run-q2",
  }]);
});

test("TuiRunController preserves Q2 authority when delayed Q1 cannot order the legacy fork", async () => {
  const threadId = "thread-main:session-1";
  let dispatches = 0;
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
      queuedRunReservations: [{
        runId: "run-q1",
        messageId: "message-q1",
        threadId,
        predecessorRunId: "run-r0",
      }, {
        runId: "run-q2",
        messageId: "message-q2",
        threadId,
        predecessorRunId: "run-r0",
      }],
    },
    sendCommand: async (type) => {
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: {
            view: {
              ...makeConversationView({ active: true }),
              activeRun: { runId: "run-q2", status: "RUNNING" },
            },
          },
        });
      }
      dispatches += 1;
      throw new Error("must not dispatch Q3");
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId,
    runId: "run-q2",
    payload: {
      sessionId: "session-1",
      runId: "run-q2",
      eventType: "user.message",
      sourceMessageId: "message-q2",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, "run-q2");

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId,
    runId: "run-q1",
    payload: { result: makeCompletedResult("run-q1") },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q2");
  assert.equal(session.queuedRunReservations?.[0]?.runId, "run-q2");
  assert.equal(session.terminalQueuedRuns?.[0]?.runId, "run-q1");
  assert.equal(harness.history.some((line) => line.output?.runId === "run-q1"), false);
  await assert.rejects(() => harness.controller.startActiveTurn({
    messageId: "message-q3",
    submittedMessage: "Q3 stays blocked",
    queueRequested: true,
  }), /unresolved queue fork/u);
  assert.equal(dispatches, 0);
});

test("TuiRunController repairs an accepted-active Q1 fork from a duplicate exact start", async () => {
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-q1",
      acceptedRunMessageId: "message-q1",
      acceptedRunThreadId: threadId,
      acceptedRunPredecessorId: "run-r0",
      queuedRunReservations: [{
        runId: "run-q1",
        messageId: "message-q1",
        threadId,
        predecessorRunId: "run-r0",
      }, {
        runId: "run-q2",
        messageId: "message-q2",
        threadId,
        predecessorRunId: "run-r0",
      }],
    },
  });
  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId,
    runId: "run-q1",
    payload: {
      sessionId: "session-1",
      runId: "run-q1",
      eventType: "user.message",
      sourceMessageId: "message-q1",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: "run-q2",
    messageId: "message-q2",
    threadId,
    predecessorRunId: "run-q1",
  }]);

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId,
    runId: "run-q2",
    payload: {
      sessionId: "session-1",
      runId: "run-q2",
      eventType: "user.message",
      sourceMessageId: "message-q2",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, "run-q2");
  assert.equal(harness.uiStore.getState().activeSession.queuedRunReservations, undefined);
});

test("TuiRunController promotes a direct Q2 terminal after durable Q1 terminal authority", async () => {
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-q1",
      acceptedRunMessageId: "message-q1",
      acceptedRunThreadId: threadId,
      acceptedRunPredecessorId: "run-r0",
      queuedRunReservations: [{
        runId: "run-q2",
        messageId: "message-q2",
        threadId,
        predecessorRunId: "run-r0",
      }],
      terminalQueuedRuns: [{
        runId: "run-q1",
        messageId: "message-q1",
        threadId,
        predecessorRunId: "run-r0",
        status: "COMPLETED",
      }],
    },
    sendCommand: async (type) => {
      assert.equal(type, "operator.thread");
      return makeRunnerEvent({
        type: "operator.thread",
        payload: {
          view: makeQueuedTerminalAuthorityView([
            { runId: "run-q1", messageId: "message-q1", status: "COMPLETED" },
            { runId: "run-q2", messageId: "message-q2", status: "COMPLETED" },
          ]),
        },
      });
    },
  });

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId,
    runId: "run-q2",
    payload: { result: makeCompletedResult("run-q2") },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, "run-q2");
  assert.equal(harness.uiStore.getState().activeSession.queuedRunReservations, undefined);
  assert.equal(harness.history.filter((line) => line.output?.runId === "run-q2").length, 1);
});

test("TuiRunController reconciles a tombstoned terminal after lookup recovery and publishes once", async () => {
  const threadId = "thread-main:session-1";
  let lookupCount = 0;
  let syncCount = 0;
  let harness!: ReturnType<typeof createRunHarness>;
  harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-q1",
      acceptedRunMessageId: "message-q1",
      acceptedRunThreadId: threadId,
      acceptedRunPredecessorId: "run-r0",
      queuedRunReservations: [{
        runId: "run-q2",
        messageId: "message-q2",
        threadId,
        predecessorRunId: "run-r0",
      }],
      terminalQueuedRuns: [{
        runId: "run-q1",
        messageId: "message-q1",
        threadId,
        predecessorRunId: "run-r0",
        status: "COMPLETED",
      }],
    },
    sendCommand: async (type) => {
      assert.equal(type, "operator.thread");
      lookupCount += 1;
      if (lookupCount === 1) throw new Error("authority temporarily unavailable");
      return makeRunnerEvent({
        type: "operator.thread",
        payload: {
          view: makeQueuedTerminalAuthorityView([
            { runId: "run-q1", messageId: "message-q1", status: "COMPLETED" },
            { runId: "run-q2", messageId: "message-q2", status: "COMPLETED" },
          ]),
        },
      });
    },
    syncForegroundQueuedTerminal: async ({ authoritativeView }) => {
      syncCount += 1;
      const state = harness.uiStore.getState();
      if (syncCount === 1) {
        assert.equal(authoritativeView, undefined);
        const tombstoned = {
          ...state.activeSession,
          queuedRunReservations: undefined,
          terminalQueuedRuns: [...(state.activeSession.terminalQueuedRuns ?? []), {
            runId: "run-q2",
            messageId: "message-q2",
            threadId,
            predecessorRunId: "run-r0",
            status: "COMPLETED" as const,
          }],
        };
        harness.uiStore.patch({ activeSession: tombstoned, sessions: [tombstoned] });
        return true;
      }
      if (syncCount === 2) {
        assert.notEqual(authoritativeView, undefined);
        const accepted = {
          ...state.activeSession,
          acceptedRunId: "run-q2",
          acceptedRunMessageId: "message-q2",
          acceptedRunThreadId: threadId,
          acceptedRunPredecessorId: "run-q1",
          lastRunStatus: "COMPLETED" as const,
          terminalQueuedRuns: state.activeSession.terminalQueuedRuns?.map((terminal) =>
            terminal.runId === "run-q2"
              ? { ...terminal, predecessorRunId: "run-q1" }
              : terminal
          ),
        };
        harness.uiStore.patch({ activeSession: accepted, sessions: [accepted] });
        return true;
      }
      return true;
    },
  });
  const terminalEvent = () => makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId,
    runId: "run-q2",
    payload: { result: makeCompletedResult("run-q2") },
  });

  harness.controller.onRunnerEvent(terminalEvent());
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, "run-q1");
  assert.equal(harness.history.some((line) => line.output?.runId === "run-q2"), false);

  harness.controller.onRunnerEvent(terminalEvent());
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, "run-q2");
  assert.equal(harness.history.filter((line) => line.output?.runId === "run-q2").length, 1);
  const committedOutputIndex = harness.history.findIndex((line) => line.output?.runId === "run-q2");
  harness.history.splice(committedOutputIndex, 1);

  harness.controller.onRunnerEvent(terminalEvent());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.history.filter((line) => line.output?.runId === "run-q2").length, 1);
  harness.controller.onRunnerEvent(terminalEvent());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.history.filter((line) => line.output?.runId === "run-q2").length, 1);
  assert.equal(harness.runLogs.filter((line) => line.runId === "run-q2").length, 1);
  assert.equal(lookupCount >= 2, true);
  assert.equal(syncCount, 4);
});

test("TuiRunController promotes direct failed and cancelled Q2 after durable Q1 authority", async (t) => {
  for (const eventType of ["run.failed", "run.cancelled"] as const) {
    await t.test(eventType, async () => {
      const threadId = "thread-main:session-1";
      const runId = `run-q2:${eventType}`;
      const messageId = `message-q2:${eventType}`;
      const harness = createRunHarness({
        activeSessionPatch: {
          acceptedRunId: "run-q1",
          acceptedRunMessageId: "message-q1",
          acceptedRunThreadId: threadId,
          acceptedRunPredecessorId: "run-r0",
          queuedRunReservations: [{
            runId,
            messageId,
            threadId,
            predecessorRunId: "run-r0",
          }],
          terminalQueuedRuns: [{
            runId: "run-q1",
            messageId: "message-q1",
            threadId,
            predecessorRunId: "run-r0",
            status: "COMPLETED",
          }],
        },
        sendCommand: async (type) => {
          assert.equal(type, "operator.thread");
          return makeRunnerEvent({
            type: "operator.thread",
            payload: {
              view: makeQueuedTerminalAuthorityView([
                { runId: "run-q1", messageId: "message-q1", status: "COMPLETED" },
                { runId, messageId, status: "FAILED" },
              ]),
            },
          });
        },
      });
      harness.controller.onRunnerEvent(eventType === "run.failed"
        ? makeRunnerEvent({
            type: eventType,
            sessionId: "session-1",
            threadId,
            runId,
            payload: {
              result: makeFailedResult(runId),
              error: { code: "RUN_FAILED", message: "Q2 failed" },
            },
          })
        : makeRunnerEvent({
            type: eventType,
            sessionId: "session-1",
            threadId,
            runId,
            payload: { sessionId: "session-1", result: makeCancelledResult(runId) },
          }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.acceptedRunId, runId);
      assert.equal(session.queuedRunReservations, undefined);
      assert.equal(session.lastRunStatus, "FAILED");
      assert.equal(harness.history.filter((line) => line.output?.runId === runId).length, 1);
    });
  }
});

test("TuiRunController orders sequential Q1 then Q2 queued terminals from exact runtime authority", async (t) => {
  for (const eventType of ["run.completed", "run.failed", "run.cancelled"] as const) {
    await t.test(eventType, async () => {
      const threadId = "thread-main:session-1";
      const q2Status = eventType === "run.completed" ? "COMPLETED" as const : "FAILED" as const;
      const harness = createRunHarness({
        activeSessionPatch: {
          acceptedRunId: "run-r0",
          acceptedRunMessageId: "message-r0",
          acceptedRunThreadId: threadId,
          queuedRunReservations: [{
            runId: "run-q1",
            messageId: "message-q1",
            threadId,
            predecessorRunId: "run-r0",
          }, {
            runId: "run-q2",
            messageId: "message-q2",
            threadId,
            predecessorRunId: "run-r0",
          }],
        },
        sendCommand: async (type) => {
          assert.equal(type, "operator.thread");
          return makeRunnerEvent({
            type: "operator.thread",
            payload: {
              view: makeQueuedTerminalAuthorityView([
                { runId: "run-q1", messageId: "message-q1", status: "COMPLETED" },
                { runId: "run-q2", messageId: "message-q2", status: q2Status },
              ]),
            },
          });
        },
      });

      harness.controller.onRunnerEvent(makeRunnerEvent({
        type: "run.completed",
        sessionId: "session-1",
        threadId,
        runId: "run-q1",
        payload: { result: makeCompletedResult("run-q1") },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, "run-q1");
      assert.equal(harness.uiStore.getState().activeSession.acceptedRunPredecessorId, "run-r0");

      harness.controller.onRunnerEvent(eventType === "run.completed"
        ? makeRunnerEvent({
            type: eventType,
            sessionId: "session-1",
            threadId,
            runId: "run-q2",
            payload: { result: makeCompletedResult("run-q2") },
          })
        : eventType === "run.failed"
          ? makeRunnerEvent({
              type: eventType,
              sessionId: "session-1",
              threadId,
              runId: "run-q2",
              payload: {
                result: makeFailedResult("run-q2"),
                error: { code: "RUN_FAILED", message: "Q2 failed" },
              },
            })
          : makeRunnerEvent({
              type: eventType,
              sessionId: "session-1",
              threadId,
              runId: "run-q2",
              payload: { sessionId: "session-1", result: makeCancelledResult("run-q2") },
            }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.acceptedRunId, "run-q2");
      assert.equal(session.acceptedRunPredecessorId, "run-q1");
      assert.equal(session.queuedRunReservations, undefined);
      assert.equal(harness.history.filter((line) => line.output?.runId === "run-q1").length, 1);
      assert.equal(harness.history.filter((line) => line.output?.runId === "run-q2").length, 1);
    });
  }
});

test("TuiRunController rejects a dangling queue root before dispatch", async () => {
  let dispatches = 0;
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
      queuedRunReservations: [{
        runId: "run-q2",
        messageId: "message-q2",
        threadId,
        predecessorRunId: "run-missing-q1",
      }],
    },
    sendCommand: async () => {
      dispatches += 1;
      throw new Error("must not dispatch");
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  await assert.rejects(() => harness.controller.startActiveTurn({
    messageId: "message-q3",
    submittedMessage: "Q3",
    queueRequested: true,
  }), /dangling predecessor/u);
  assert.equal(dispatches, 0);
});

test("TuiRunController does not dispatch a queued turn when the pending reservation durability barrier fails", async () => {
  let submissionCount = 0;
  let requiredSaveCount = 0;
  const harness = createRunHarness({
    persistSessionAndUi: async (options) => {
      if (options?.requireSessionSave !== true) return;
      requiredSaveCount += 1;
      if (requiredSaveCount === 1) throw new Error("sessions save failed");
    },
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") submissionCount += 1;
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-barrier-failure",
    submittedMessage: "must not dispatch",
    queueRequested: true,
  }), false);
  assert.equal(submissionCount, 0);
  assert.equal(harness.uiStore.getState().activeSession.pendingQueueSubmissions, undefined);
  assert.match(harness.uiStore.getState().errorOverlay?.message ?? "", /sessions save failed/u);
});

test("TuiRunController serializes the full queue journal so a failed first barrier cannot enter the second snapshot", async () => {
  let harness: ReturnType<typeof createRunHarness>;
  let barrierCalls = 0;
  let releaseFirst: (() => void) | undefined;
  let firstEnteredResolve: (() => void) | undefined;
  const firstEntered = new Promise<void>((resolve) => {
    firstEnteredResolve = resolve;
  });
  const barrierSnapshots: string[][] = [];
  const dispatched: string[] = [];
  harness = createRunHarness({
    persistSessionAndUi: async (options) => {
      if (options?.requireSessionSave !== true) return;
      barrierCalls += 1;
      barrierSnapshots.push(
        harness.uiStore.getState().sessions
          .find((session) => session.sessionId === "session-1")
          ?.pendingQueueSubmissions
          ?.map((submission) => submission.messageId) ?? [],
      );
      if (barrierCalls === 1) {
        firstEnteredResolve?.();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        throw new Error("Q1 barrier failed");
      }
    },
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      const messageId = String(payload.messageId);
      dispatched.push(messageId);
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          threadId: "thread-main:session-1",
          sessionId: "session-1",
          messageId,
          disposition: "queued",
          followUpId: `follow-up:${messageId}`,
          view: makeConversationView({ active: true }),
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  const first = harness.controller.startActiveTurn({
    messageId: "message-journal-q1",
    submittedMessage: "Q1",
    queueRequested: true,
  });
  await firstEntered;
  const second = harness.controller.startActiveTurn({
    messageId: "message-journal-q2",
    submittedMessage: "Q2",
    queueRequested: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondEnteredBeforeRollback = barrierCalls > 1;
  releaseFirst?.();

  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(secondEnteredBeforeRollback, false);
  assert.deepEqual(barrierSnapshots, [
    ["message-journal-q1"],
    [],
    ["message-journal-q2"],
  ]);
  assert.deepEqual(dispatched, ["message-journal-q2"]);
});

test("TuiRunController keeps queue preparation bound to session A across every pre-dispatch await", async (t) => {
  for (const stage of ["core", "environment", "profile", "workspace", "persistence"] as const) {
    await t.test(stage, async () => {
      let releaseStage: (() => void) | undefined;
      let stageEnteredResolve: (() => void) | undefined;
      const stageEntered = new Promise<void>((resolve) => {
        stageEnteredResolve = resolve;
      });
      let stageReleased = false;
      const waitAtStage = async (candidate: typeof stage) => {
        if (candidate !== stage || stageReleased) return;
        stageEnteredResolve?.();
        await new Promise<void>((resolve) => {
          releaseStage = resolve;
        });
        stageReleased = true;
      };
      let submitted: { payload: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
      let harness: ReturnType<typeof createRunHarness>;
      const workspaceA = {
        rootPath: "/workspace/a",
        manifest: { workspaceId: "workspace-a" },
        registryEntry: {
          workspaceId: "workspace-a",
          rootPath: "/workspace/a",
          automationEnabled: false,
          discoveredAt: "2026-08-29T00:00:00.000Z",
          updatedAt: "2026-08-29T00:00:00.000Z",
        },
        runtimeContext: {
          workspaceId: "workspace-a",
          workspaceRoot: "/workspace/a",
          appRoot: "/workspace/a",
          commands: {},
        },
      } as ResolvedWorkspace;
      const buildResolution = (request: {
        client: "cli";
        profileId: string;
        environmentPresetId: "cli_safe_local" | "cli_dev_local";
      }) => ({
        version: 1,
        profileId: "resolved-profile-a",
        fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        policy: { id: "kestrel", version: 2 },
        environmentPreset: { id: request.environmentPresetId, version: 1 },
        resolvedProfile: {
          id: "resolved-profile-a",
          label: "Resolved A",
          agent: "kestrel",
          sessionPrefix: "ref",
          agentProfileId: "kestrel",
          environmentShellKind: "cli",
          environmentPresetId: request.environmentPresetId,
          environmentCapabilityPackIds: ["balanced", "filesystem", "dev_shell"],
        },
      });
      const resolveProfile = async (request: {
        client: "cli";
        profileId: string;
        environmentPresetId: "cli_safe_local" | "cli_dev_local";
      }) => {
        await waitAtStage("profile");
        assert.equal(request.profileId, "kestrel");
        assert.equal(request.environmentPresetId, "cli_dev_local");
        return buildResolution(request);
      };
      harness = createRunHarness({
        workspaceBinding: "active",
        workspaceRoot: "/workspace/a",
        prepareLocalCoreClient: async () => {
          await waitAtStage("core");
          return { resolveExecutionProfile: resolveProfile } as never;
        },
        beforeSessionDescribe: async () => await waitAtStage("environment"),
        resolveExecutionProfile: resolveProfile,
        resolveWorkspaceForSession: async (session) => {
          assert.equal(session.sessionId, "session-1");
          assert.equal(session.workspaceRoot, "/workspace/a");
          await waitAtStage("workspace");
          return workspaceA;
        },
        persistSessionAndUi: async () => await waitAtStage("persistence"),
        sendCommand: async (type, payload, metadata) => {
          assert.equal(type, "conversation.message.submit");
          submitted = { payload, metadata };
          return makeRunnerEvent({
            type: "conversation.message.routed",
            payload: {
              threadId: "thread-main:session-1",
              sessionId: "session-1",
              messageId: "message-preawait-a",
              disposition: "queued",
              followUpId: "follow-up:preawait-a",
              view: makeConversationView({ active: true }),
            },
          });
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });
      const submission = harness.controller.startActiveTurn({
        messageId: "message-preawait-a",
        submittedMessage: "queue from A",
        queueRequested: true,
      });
      await stageEntered;

      const sessionA = harness.uiStore.getState().sessions.find(
        (session) => session.sessionId === "session-1",
      )!;
      const sessionB: TuiSessionMeta = {
        ...sessionA,
        name: "session-b",
        sessionId: "session-b",
        profileId: "profile-b",
        environmentPresetId: "cli_safe_local",
        workspaceRoot: "/workspace/b",
        pendingQueueSubmissions: undefined,
        queuedRunReservations: undefined,
      };
      harness.uiStore.patch({
        activeProfile: {
          ...harness.uiStore.getState().activeProfile,
          id: "profile-b",
          label: "Profile B",
        },
        activeSession: sessionB,
        sessions: [sessionA, sessionB],
        running: false,
        statusLine: "session B ready",
      });
      releaseStage?.();

      assert.equal(await submission, true);
      const turn = submitted?.payload.turn as Record<string, unknown>;
      assert.equal(turn.sessionId, "session-1");
      assert.equal((turn.workspace as Record<string, unknown>).workspaceId, "workspace-a");
      assert.equal(submitted?.payload.profileId, "resolved-profile-a");
      assert.equal((submitted?.metadata?.profile as TuiProfile | undefined)?.id, "kestrel");
      const currentA = harness.uiStore.getState().sessions.find(
        (session) => session.sessionId === "session-1",
      );
      assert.deepEqual(currentA?.queuedRunReservations?.map((item) => item.messageId), [
        "message-preawait-a",
      ]);
      assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-b");
      assert.equal(harness.uiStore.getState().statusLine, "session B ready");
    });
  }
});

test("TuiRunController applies queued response and response-loss recovery to the submitting session after focus changes", async (t) => {
  for (const recovery of [false, true]) {
    await t.test(recovery ? "response loss" : "routed response", async () => {
      let releaseSubmission: ((value: RunnerEvent) => void) | undefined;
      let rejectSubmission: ((error: Error) => void) | undefined;
      let submittedRunId: string | undefined;
      let submissionStartedResolve: (() => void) | undefined;
      const submissionStarted = new Promise<void>((resolve) => {
        submissionStartedResolve = resolve;
      });
      const harness = createRunHarness({
        sendCommand: async (type, payload) => {
          if (type === "conversation.message.submit") {
            submittedRunId = String((payload.turn as Record<string, unknown>).runId);
            submissionStartedResolve?.();
            return await new Promise<RunnerEvent>((resolve, reject) => {
              releaseSubmission = resolve;
              rejectSubmission = reject;
            });
          }
          if (type === "operator.thread" && recovery) {
            return makeRunnerEvent({
              type: "operator.thread",
              payload: {
                view: {
                  ...makeConversationView({ active: true }),
                  conversationMessageRoutes: [{
                    messageId: "message-focus-switch",
                    disposition: "queued",
                    followUpId: "follow-up:focus-switch",
                    createdAt: "2026-08-29T00:00:00.000Z",
                  }],
                },
              },
            });
          }
          throw new Error(`Unexpected command '${type}'.`);
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });
      const submission = harness.controller.startActiveTurn({
        messageId: "message-focus-switch",
        submittedMessage: "queue from A",
        queueRequested: true,
      });
      await submissionStarted;

      const sessionA = harness.uiStore.getState().activeSession;
      const sessionB: TuiSessionMeta = {
        ...sessionA,
        name: "session-b",
        sessionId: "session-b",
        pendingQueueSubmissions: undefined,
        queuedRunReservations: undefined,
      };
      harness.uiStore.patch({
        activeSession: sessionB,
        sessions: [sessionA, sessionB],
        running: false,
        statusLine: "session B ready",
      });

      if (recovery) {
        rejectSubmission?.(new Error("response lost"));
      } else {
        releaseSubmission?.(makeRunnerEvent({
          type: "conversation.message.routed",
          payload: {
            threadId: "thread-main:session-1",
            sessionId: "session-1",
            messageId: "message-focus-switch",
            disposition: "queued",
            followUpId: "follow-up:focus-switch",
            view: makeConversationView({ active: true }),
          },
        }));
      }
      assert.equal(await submission, true);

      const currentA = harness.uiStore.getState().sessions.find(
        (session) => session.sessionId === "session-1",
      );
      assert.equal(currentA?.pendingQueueSubmissions, undefined);
      assert.deepEqual(currentA?.queuedRunReservations, [{
        runId: submittedRunId,
        messageId: "message-focus-switch",
        threadId: "thread-main:session-1",
      }]);
      assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-b");
      assert.equal(harness.uiStore.getState().statusLine, "session B ready");
    });
  }
});

test("TuiRunController applies a direct queued terminal to the submitting session after focus changes", async () => {
  let releaseSubmission: ((value: RunnerEvent) => void) | undefined;
  let submittedRunId: string | undefined;
  let submissionStartedResolve: (() => void) | undefined;
  const submissionStarted = new Promise<void>((resolve) => {
    submissionStartedResolve = resolve;
  });
  const harness = createRunHarness({
    scripted: true,
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      submittedRunId = String((payload.turn as Record<string, unknown>).runId);
      submissionStartedResolve?.();
      return await new Promise<RunnerEvent>((resolve) => {
        releaseSubmission = resolve;
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });
  const submission = harness.controller.startActiveTurn({
    messageId: "message-focus-terminal",
    submittedMessage: "queue from A",
    queueRequested: true,
  });
  await submissionStarted;

  const sessionA = harness.uiStore.getState().activeSession;
  const sessionB: TuiSessionMeta = {
    ...sessionA,
    name: "session-b",
    sessionId: "session-b",
    pendingQueueSubmissions: undefined,
    queuedRunReservations: undefined,
  };
  harness.uiStore.patch({
    activeSession: sessionB,
    sessions: [sessionA, sessionB],
    running: false,
    statusLine: "session B ready",
  });
  const visibleTranscript = harness.uiStore.getState().transcript;

  releaseSubmission?.(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: submittedRunId,
    payload: { result: makeCompletedResult(submittedRunId!) },
  }));
  assert.equal(await submission, true);

  const currentA = harness.uiStore.getState().sessions.find(
    (session) => session.sessionId === "session-1",
  );
  assert.equal(currentA?.pendingQueueSubmissions, undefined);
  assert.equal(currentA?.acceptedRunId, submittedRunId);
  assert.equal(currentA?.acceptedRunMessageId, "message-focus-terminal");
  assert.equal(currentA?.acceptedRunThreadId, "thread-main:session-1");
  assert.equal(currentA?.lastRunStatus, "COMPLETED");
  assert.deepEqual(currentA?.terminalQueuedRuns, [{
    runId: submittedRunId,
    messageId: "message-focus-terminal",
    threadId: "thread-main:session-1",
    status: "COMPLETED",
  }]);
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-b");
  assert.equal(harness.uiStore.getState().statusLine, "session B ready");
  assert.deepEqual(harness.uiStore.getState().transcript, visibleTranscript);
  assert.equal(harness.history.some((line) => line.text === "Run Completed"), false);
});

test("TuiRunController installs exact direct queued lifecycle ownership for waiting, failed, and cancelled responses", async (t) => {
  for (const outcome of ["WAITING", "FAILED", "CANCELLED"] as const) {
    await t.test(outcome, async () => {
      let submittedRunId: string | undefined;
      const harness = createRunHarness({
        sendCommand: async (type, payload) => {
          assert.equal(type, "conversation.message.submit");
          submittedRunId = String((payload.turn as Record<string, unknown>).runId);
          const base = {
            sessionId: "session-1",
            threadId: "thread-main:session-1",
            runId: submittedRunId,
          };
          if (outcome === "WAITING") {
            return makeRunnerEvent({
              ...base,
              type: "run.completed",
              payload: { result: makeWaitingResult(submittedRunId) },
            });
          }
          if (outcome === "FAILED") {
            return makeRunnerEvent({
              ...base,
              type: "run.failed",
              payload: {
                result: makeFailedResult(submittedRunId),
                error: { code: "RUN_FAILED", message: "direct queue failure" },
              },
            });
          }
          return makeRunnerEvent({
            ...base,
            type: "run.cancelled",
            payload: {
              sessionId: "session-1",
              result: makeCancelledResult(submittedRunId),
            },
          });
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });

      assert.equal(await harness.controller.startActiveTurn({
        messageId: `message-direct-${outcome.toLowerCase()}`,
        submittedMessage: `queue ${outcome}`,
        queueRequested: true,
      }), true);

      const session = harness.uiStore.getState().activeSession as TuiSessionMeta & {
        terminalQueuedRuns?: Array<{ runId: string; messageId: string; threadId: string; status: string }>;
      };
      assert.equal(session.pendingQueueSubmissions, undefined);
      assert.equal(session.acceptedRunId, submittedRunId);
      assert.equal(session.acceptedRunMessageId, `message-direct-${outcome.toLowerCase()}`);
      assert.equal(session.acceptedRunThreadId, "thread-main:session-1");
      assert.equal(session.lastRunStatus, outcome === "CANCELLED" ? "FAILED" : outcome);
      if (outcome === "WAITING") {
        assert.equal(session.pendingWaitFor?.eventType, "user.reply");
        assert.equal(session.terminalQueuedRuns, undefined);
      } else {
        assert.deepEqual(session.terminalQueuedRuns, [{
          runId: submittedRunId,
          messageId: `message-direct-${outcome.toLowerCase()}`,
          threadId: "thread-main:session-1",
          status: "FAILED",
        }]);
      }
    });
  }
});

test("TuiRunController applies direct queued waiting, failed, and cancelled responses only to inactive owner A", async (t) => {
  for (const outcome of ["WAITING", "FAILED", "CANCELLED"] as const) {
    await t.test(outcome, async () => {
      let harness: ReturnType<typeof createRunHarness>;
      let submittedRunId: string | undefined;
      harness = createRunHarness({
        scripted: true,
        sendCommand: async (type, payload) => {
          assert.equal(type, "conversation.message.submit");
          submittedRunId = String((payload.turn as Record<string, unknown>).runId);
          const owner = harness.uiStore.getState().sessions.find(
            (session) => session.sessionId === "session-1",
          )!;
          const visible: TuiSessionMeta = {
            ...owner,
            name: "session-b",
            sessionId: "session-b",
            pendingQueueSubmissions: undefined,
            queuedRunReservations: undefined,
          };
          harness.uiStore.patch({
            activeSession: visible,
            sessions: [owner, visible],
            running: false,
            statusLine: "session B ready",
          });
          const base = {
            sessionId: "session-1",
            threadId: "thread-main:session-1",
            runId: submittedRunId,
          };
          if (outcome === "WAITING") {
            return makeRunnerEvent({
              ...base,
              type: "run.completed",
              payload: { result: makeWaitingResult(submittedRunId) },
            });
          }
          if (outcome === "FAILED") {
            return makeRunnerEvent({
              ...base,
              type: "run.failed",
              payload: {
                result: makeFailedResult(submittedRunId),
                error: { code: "RUN_FAILED", message: "inactive direct failure" },
              },
            });
          }
          return makeRunnerEvent({
            ...base,
            type: "run.cancelled",
            payload: { sessionId: "session-1", result: makeCancelledResult(submittedRunId) },
          });
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });

      assert.equal(await harness.controller.startActiveTurn({
        messageId: `message-inactive-direct-${outcome.toLowerCase()}`,
        submittedMessage: `queue inactive ${outcome}`,
        queueRequested: true,
      }), true);

      const owner = harness.uiStore.getState().sessions.find(
        (session) => session.sessionId === "session-1",
      );
      assert.equal(owner?.acceptedRunId, submittedRunId);
      assert.equal(owner?.acceptedRunMessageId, `message-inactive-direct-${outcome.toLowerCase()}`);
      assert.equal(owner?.lastRunStatus, outcome === "CANCELLED" ? "FAILED" : outcome);
      assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-b");
      assert.equal(harness.uiStore.getState().statusLine, "session B ready");
      assert.equal(harness.history.some((line) => line.text === "Run Completed"), false);
    });
  }
});

test("TuiRunController response-loss recovery installs exact active, waiting, and terminal queue lifecycle", async (t) => {
  for (const status of ["RUNNING", "WAITING", "COMPLETED", "FAILED"] as const) {
    await t.test(status, async () => {
      let submittedRunId: string | undefined;
      const messageId = `message-recovered-${status.toLowerCase()}`;
      const threadId = "thread-main:session-1";
      const harness = createRunHarness({
        sendCommand: async (type, payload) => {
          if (type === "conversation.message.submit") {
            submittedRunId = String((payload.turn as Record<string, unknown>).runId);
            throw new Error("response lost");
          }
          if (type === "operator.thread") {
            const terminal = status === "COMPLETED" || status === "FAILED";
            return makeRunnerEvent({
              type: "operator.thread",
              payload: {
                view: {
                  thread: {
                    threadId,
                    sessionId: "session-1",
                    title: "Recovered queue lifecycle",
                    status: terminal ? status : status,
                    lastRunStatus: terminal ? status : undefined,
                    waitFor: status === "WAITING"
                      ? { kind: "user", eventType: "user.reply" }
                      : undefined,
                    createdAt: "2026-08-29T00:00:00.000Z",
                    updatedAt: "2026-08-29T00:00:01.000Z",
                  },
                  childThreads: [],
                  childBlockerChain: [],
                  activeRun: terminal ? undefined : { runId: submittedRunId, status },
                  conversationTurns: terminal ? [{
                    turnId: `turn-${status.toLowerCase()}`,
                    threadId,
                    sessionId: "session-1",
                    sequence: 1,
                    status,
                    rootRunId: submittedRunId,
                    sourceMessageId: messageId,
                    terminalRunId: submittedRunId,
                    terminalStatus: status,
                    startedAt: "2026-08-29T00:00:00.000Z",
                    completedAt: "2026-08-29T00:00:01.000Z",
                    updatedAt: "2026-08-29T00:00:01.000Z",
                  }] : [],
                  conversationMessageRoutes: [{
                    messageId,
                    disposition: "started",
                    runId: submittedRunId,
                    createdAt: "2026-08-29T00:00:00.000Z",
                  }],
                },
              },
            });
          }
          throw new Error(`Unexpected command '${type}'.`);
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });

      assert.equal(await harness.controller.startActiveTurn({
        messageId,
        submittedMessage: `recover ${status}`,
        queueRequested: true,
      }), true);

      const session = harness.uiStore.getState().activeSession as TuiSessionMeta & {
        terminalQueuedRuns?: Array<{ runId: string; messageId: string; threadId: string; status: string }>;
      };
      assert.equal(session.pendingQueueSubmissions, undefined);
      assert.equal(session.acceptedRunId, submittedRunId);
      assert.equal(session.acceptedRunMessageId, messageId);
      assert.equal(session.acceptedRunThreadId, threadId);
      assert.equal(
        session.lastRunStatus,
        status === "RUNNING" ? undefined : status,
      );
      assert.equal(
        session.pendingWaitFor?.eventType,
        status === "WAITING" ? "user.reply" : undefined,
      );
      if (status === "COMPLETED" || status === "FAILED") {
        assert.deepEqual(session.terminalQueuedRuns, [{
          runId: submittedRunId,
          messageId,
          threadId,
          status,
        }]);
      }
    });
  }
});

test("TuiRunController requires exact routed terminal evidence for direct and response-loss queue settlement", async (t) => {
  for (const responseKind of ["direct", "response-loss"] as const) {
    const mismatches = responseKind === "direct"
      ? ["running-only", "wrong-message", "wrong-thread", "wrong-session", "duplicate"] as const
      : ["wrong-message", "wrong-thread", "wrong-session", "duplicate"] as const;
    for (const mismatch of mismatches) {
      await t.test(`${responseKind} ${mismatch}`, async () => {
        let submittedRunId: string | undefined;
        const messageId = `message-${responseKind}-${mismatch}`;
        const threadId = "thread-main:session-1";
        let harness: ReturnType<typeof createRunHarness>;
        harness = createRunHarness({
          disableSynthesizedTerminalAuthority: true,
          activeSessionPatch: {
            acceptedRunId: "run-r0",
            acceptedRunMessageId: "message-r0",
            acceptedRunThreadId: threadId,
          },
          sendCommand: async (type, payload) => {
            if (type === "conversation.message.submit") {
              submittedRunId = String((payload.turn as Record<string, unknown>).runId);
              harness.controller.onRunnerEvent(makeRunnerEvent({
                type: "run.started",
                sessionId: "session-1",
                threadId,
                runId: submittedRunId,
                payload: {
                  sessionId: "session-1",
                  runId: submittedRunId,
                  eventType: "user.message",
                  sourceMessageId: messageId,
                },
              }));
              await new Promise((resolve) => setTimeout(resolve, 0));
              await new Promise((resolve) => setTimeout(resolve, 0));
              if (responseKind === "response-loss") throw new Error("response lost");
              return makeRunnerEvent({
                type: "run.completed",
                sessionId: "session-1",
                threadId,
                runId: submittedRunId,
                payload: { result: makeCompletedResult(submittedRunId) },
              });
            }
            if (type === "operator.thread") {
              const terminalTurn = {
                turnId: `turn-${responseKind}-${mismatch}`,
                threadId: mismatch === "wrong-thread" ? "thread-wrong" : threadId,
                sessionId: mismatch === "wrong-session" ? "session-wrong" : "session-1",
                sequence: 1,
                status: "COMPLETED" as const,
                rootRunId: submittedRunId,
                sourceMessageId: mismatch === "wrong-message" ? "message-wrong" : messageId,
                terminalRunId: submittedRunId,
                terminalStatus: "COMPLETED" as const,
                startedAt: "2026-08-29T00:00:00.000Z",
                completedAt: "2026-08-29T00:00:01.000Z",
                updatedAt: "2026-08-29T00:00:01.000Z",
              };
              return makeRunnerEvent({
                type: "operator.thread",
                payload: {
                  view: {
                    thread: {
                      threadId: mismatch === "wrong-thread" ? "thread-wrong" : threadId,
                      sessionId: mismatch === "wrong-session" ? "session-wrong" : "session-1",
                      title: "Mismatched terminal authority",
                      status: mismatch === "running-only" ? "RUNNING" : "COMPLETED",
                      lastRunStatus: mismatch === "running-only" ? undefined : "COMPLETED",
                      createdAt: "2026-08-29T00:00:00.000Z",
                      updatedAt: "2026-08-29T00:00:01.000Z",
                    },
                    childThreads: [],
                    childBlockerChain: [],
                    activeRun: mismatch === "running-only"
                      ? { runId: submittedRunId, status: "RUNNING" as const }
                      : undefined,
                    conversationMessageRoutes: [{
                      messageId,
                      disposition: "started" as const,
                      runId: submittedRunId,
                    }],
                    conversationTurns: mismatch === "running-only"
                      ? []
                      : mismatch === "duplicate"
                        ? [terminalTurn, { ...terminalTurn, turnId: `${terminalTurn.turnId}-duplicate`, sequence: 2 }]
                        : [terminalTurn],
                  },
                },
              });
            }
            throw new Error(`Unexpected command '${type}'.`);
          },
        });
        installActiveConversationView(harness.controller);
        harness.uiStore.patch({ running: true });

        assert.equal(await harness.controller.startActiveTurn({
          messageId,
          submittedMessage: "do not settle without exact terminal evidence",
          queueRequested: true,
        }), false);
        const session = harness.uiStore.getState().activeSession;
        assert.equal(session.acceptedRunId, submittedRunId);
        assert.equal(session.acceptedRunMessageId, messageId);
        assert.equal(session.lastRunStatus, undefined);
        assert.equal(session.terminalQueuedRuns?.some((item) => item.runId === submittedRunId) ?? false, false);
        assert.equal(harness.history.some((line) => line.output?.runId === submittedRunId), false);
      });
    }
  }
});

test("TuiRunController validates direct and response-loss terminals after pre-route queued acceptance", async (t) => {
  for (const responseKind of ["direct", "response-loss"] as const) {
    for (const outcome of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      await t.test(`${responseKind} ${outcome}`, async () => {
        let submittedRunId = "";
        let recoveryCount = 0;
        const messageId = `message-pre-route-${responseKind}-${outcome.toLowerCase()}`;
        const threadId = "thread-main:session-1";
        let harness: ReturnType<typeof createRunHarness>;
        harness = createRunHarness({
          disableSynthesizedTerminalAuthority: true,
          activeSessionPatch: {
            acceptedRunId: "run-r0",
            acceptedRunMessageId: "message-r0",
            acceptedRunThreadId: threadId,
          },
          recoverTerminalMessages: async () => { recoveryCount += 1; },
          sendCommand: async (type, payload) => {
            if (type === "conversation.message.submit") {
              submittedRunId = String((payload.turn as Record<string, unknown>).runId);
              harness.controller.onRunnerEvent(makeRunnerEvent({
                type: "run.started",
                sessionId: "session-1",
                threadId,
                runId: submittedRunId,
                payload: {
                  sessionId: "session-1",
                  runId: submittedRunId,
                  eventType: "user.message",
                  sourceMessageId: messageId,
                },
              }));
              await new Promise((resolve) => setTimeout(resolve, 0));
              await new Promise((resolve) => setTimeout(resolve, 0));
              if (responseKind === "response-loss") throw new Error("response lost");
              if (outcome === "COMPLETED") {
                return makeRunnerEvent({
                  type: "run.completed",
                  sessionId: "session-1",
                  threadId,
                  runId: submittedRunId,
                  payload: { result: makeCompletedResult(submittedRunId) },
                });
              }
              if (outcome === "FAILED") {
                return makeRunnerEvent({
                  type: "run.failed",
                  sessionId: "session-1",
                  threadId,
                  runId: submittedRunId,
                  payload: {
                    result: makeFailedResult(submittedRunId),
                    error: { code: "RUN_FAILED", message: "pre-route direct failure" },
                  },
                });
              }
              return makeRunnerEvent({
                type: "run.cancelled",
                sessionId: "session-1",
                threadId,
                runId: submittedRunId,
                payload: { sessionId: "session-1", result: makeCancelledResult(submittedRunId) },
              });
            }
            if (type === "operator.thread") {
              const status = outcome === "COMPLETED" ? "COMPLETED" : "FAILED";
              return makeRunnerEvent({
                type: "operator.thread",
                payload: {
                  view: {
                    thread: {
                      threadId,
                      sessionId: "session-1",
                      title: "Pre-route terminal authority",
                      status,
                      lastRunStatus: status,
                      createdAt: "2026-08-29T00:00:00.000Z",
                      updatedAt: "2026-08-29T00:00:01.000Z",
                    },
                    childThreads: [],
                    childBlockerChain: [],
                    conversationMessageRoutes: [{
                      messageId,
                      disposition: "started",
                      runId: submittedRunId,
                    }],
                    conversationTurns: [{
                      turnId: `turn-pre-route-${responseKind}-${outcome.toLowerCase()}`,
                      threadId,
                      sessionId: "session-1",
                      sequence: 1,
                      status,
                      rootRunId: submittedRunId,
                      sourceMessageId: messageId,
                      terminalRunId: submittedRunId,
                      terminalStatus: status,
                      startedAt: "2026-08-29T00:00:00.000Z",
                      completedAt: "2026-08-29T00:00:01.000Z",
                      updatedAt: "2026-08-29T00:00:01.000Z",
                    }],
                  },
                },
              });
            }
            throw new Error(`Unexpected command '${type}'.`);
          },
        });
        installActiveConversationView(harness.controller);
        harness.uiStore.patch({ running: true });

        assert.equal(await harness.controller.startActiveTurn({
          messageId,
          submittedMessage: "settle after pre-route acceptance",
          queueRequested: true,
        }), true);
        const session = harness.uiStore.getState().activeSession;
        assert.equal(session.acceptedRunId, submittedRunId);
        assert.equal(session.acceptedRunMessageId, messageId);
        assert.equal(session.lastRunStatus, outcome === "COMPLETED" ? "COMPLETED" : "FAILED");
        assert.equal(
          harness.history.filter((line) => line.output?.runId === submittedRunId).length + recoveryCount,
          1,
        );
      });
    }
  }
});

test("TuiRunController response-loss terminal recovery preserves a newer accepted run", async () => {
  let submittedRunId: string | undefined;
  const messageId = "message-recovered-prior-terminal";
  const threadId = "thread-main:session-1";
  let harness: ReturnType<typeof createRunHarness>;
  harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-predecessor",
      acceptedRunMessageId: "message-predecessor",
      acceptedRunThreadId: threadId,
      lastRunStatus: undefined,
    },
    sendCommand: async (type, payload) => {
      if (type === "conversation.message.submit") {
        submittedRunId = String((payload.turn as Record<string, unknown>).runId);
        const state = harness.uiStore.getState();
        const owner = state.sessions.find((session) => session.sessionId === "session-1")!;
        const newer = {
          ...owner,
          acceptedRunId: "run-newer",
          acceptedRunMessageId: "message-newer",
          acceptedRunThreadId: threadId,
        };
        harness.uiStore.patch({
          activeSession: newer,
          sessions: state.sessions.map((session) => session.sessionId === "session-1" ? newer : session),
        });
        throw new Error("response lost");
      }
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: {
            view: {
              thread: {
                threadId,
                sessionId: "session-1",
                title: "Recovered prior queue terminal",
                status: "COMPLETED",
                lastRunStatus: "COMPLETED",
                createdAt: "2026-08-29T00:00:00.000Z",
                updatedAt: "2026-08-29T00:00:01.000Z",
              },
              childThreads: [],
              childBlockerChain: [],
              conversationTurns: [{
                turnId: "turn-recovered-prior-terminal",
                threadId,
                sessionId: "session-1",
                sequence: 1,
                status: "COMPLETED",
                rootRunId: submittedRunId,
                sourceMessageId: messageId,
                terminalRunId: submittedRunId,
                terminalStatus: "COMPLETED",
                startedAt: "2026-08-29T00:00:00.000Z",
                completedAt: "2026-08-29T00:00:01.000Z",
                updatedAt: "2026-08-29T00:00:01.000Z",
              }],
              conversationMessageRoutes: [{
                messageId,
                disposition: "started",
                runId: submittedRunId,
                createdAt: "2026-08-29T00:00:00.000Z",
              }],
            },
          },
        });
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId,
    submittedMessage: "recover prior queued terminal",
    queueRequested: true,
  }), true);

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-newer");
  assert.equal(session.acceptedRunMessageId, "message-newer");
  assert.equal(session.acceptedRunThreadId, threadId);
  assert.equal(session.lastRunStatus, undefined);
  assert.equal(session.pendingQueueSubmissions, undefined);
  assert.deepEqual(session.terminalQueuedRuns, [{
    runId: submittedRunId,
    messageId,
    threadId,
    status: "COMPLETED",
    predecessorRunId: "run-predecessor",
  }]);
});

test("TuiRunController delayed direct queue outcomes preserve a newer accepted run", async (t) => {
  for (const outcome of ["WAITING", "COMPLETED", "FAILED", "CANCELLED"] as const) {
    await t.test(outcome, async () => {
      let submittedRunId: string | undefined;
      let release: ((event: RunnerEvent) => void) | undefined;
      let dispatchedResolve: (() => void) | undefined;
      const dispatched = new Promise<void>((resolve) => { dispatchedResolve = resolve; });
      const messageId = `message-delayed-${outcome.toLowerCase()}`;
      const threadId = "thread-main:session-1";
      const harness = createRunHarness({
        activeSessionPatch: {
          acceptedRunId: "run-predecessor",
          acceptedRunMessageId: "message-predecessor",
          acceptedRunThreadId: threadId,
        },
        sendCommand: async (type, payload) => {
          assert.equal(type, "conversation.message.submit");
          submittedRunId = String((payload.turn as Record<string, unknown>).runId);
          dispatchedResolve?.();
          return await new Promise<RunnerEvent>((resolve) => { release = resolve; });
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });
      const pending = harness.controller.startActiveTurn({
        messageId,
        submittedMessage: `delayed ${outcome}`,
        queueRequested: true,
      });
      await dispatched;
      await harness.uiStore.getState();
      await (harness.controller as unknown as { context: TuiRunControllerContext }).context.setSessionState(
        "session-1",
        {
          acceptedRunId: "run-newer",
          acceptedRunMessageId: "message-newer",
          acceptedRunThreadId: threadId,
          lastRunStatus: undefined,
        },
      );
      const base = { sessionId: "session-1", threadId, runId: submittedRunId };
      release?.(outcome === "WAITING"
        ? makeRunnerEvent({
            ...base,
            type: "run.completed",
            payload: { result: makeWaitingResult(submittedRunId!) },
          })
        : outcome === "COMPLETED"
          ? makeRunnerEvent({
              ...base,
              type: "run.completed",
              payload: { result: makeCompletedResult(submittedRunId!) },
            })
          : outcome === "FAILED"
            ? makeRunnerEvent({
                ...base,
                type: "run.failed",
                payload: {
                  result: makeFailedResult(submittedRunId!),
                  error: { code: "RUN_FAILED", message: "older queue failed" },
                },
              })
            : makeRunnerEvent({
                ...base,
                type: "run.cancelled",
                payload: { sessionId: "session-1", result: makeCancelledResult(submittedRunId!) },
              }));

      const accepted = await pending;
      assert.equal(accepted, true, JSON.stringify({
        session: harness.uiStore.getState().activeSession,
        error: harness.uiStore.getState().errorOverlay,
        history: harness.history,
      }));
      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.acceptedRunId, "run-newer");
      assert.equal(session.acceptedRunMessageId, "message-newer");
      assert.equal(session.lastRunStatus, undefined);
      assert.equal(session.pendingQueueSubmissions, undefined);
      assert.equal(harness.uiStore.getState().running, true);
      if (outcome === "COMPLETED" || outcome === "FAILED" || outcome === "CANCELLED") {
        assert.equal(session.terminalQueuedRuns?.[0]?.runId, submittedRunId);
      }
    });
  }
});

test("TuiRunController delayed routed queue outcomes preserve a newer accepted run", async (t) => {
  for (const status of ["WAITING", "COMPLETED"] as const) {
    await t.test(status, async () => {
      let submittedRunId: string | undefined;
      let release: ((event: RunnerEvent) => void) | undefined;
      let dispatchedResolve: (() => void) | undefined;
      const dispatched = new Promise<void>((resolve) => { dispatchedResolve = resolve; });
      const messageId = `message-routed-older-${status.toLowerCase()}`;
      const threadId = "thread-main:session-1";
      const harness = createRunHarness({
        activeSessionPatch: {
          acceptedRunId: "run-predecessor",
          acceptedRunMessageId: "message-predecessor",
          acceptedRunThreadId: threadId,
        },
        sendCommand: async (type, payload) => {
          assert.equal(type, "conversation.message.submit");
          submittedRunId = String((payload.turn as Record<string, unknown>).runId);
          dispatchedResolve?.();
          return await new Promise<RunnerEvent>((resolve) => { release = resolve; });
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });
      const pending = harness.controller.startActiveTurn({
        messageId,
        submittedMessage: `routed older ${status}`,
        queueRequested: true,
      });
      await dispatched;
      const state = harness.uiStore.getState();
      const owner = state.sessions.find((session) => session.sessionId === "session-1")!;
      const newer = {
        ...owner,
        acceptedRunId: "run-newer",
        acceptedRunMessageId: "message-newer",
        acceptedRunThreadId: threadId,
        lastRunStatus: undefined,
      };
      harness.uiStore.patch({
        activeSession: newer,
        sessions: state.sessions.map((session) => session.sessionId === "session-1" ? newer : session),
      });
      const waiting = status === "WAITING";
      release?.(makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          threadId,
          sessionId: "session-1",
          messageId,
          disposition: "replied",
          runId: submittedRunId,
          view: {
            thread: {
              threadId,
              sessionId: "session-1",
              title: "Older routed queue",
              status,
              lastRunStatus: waiting ? undefined : "COMPLETED",
              waitFor: waiting ? { kind: "user", eventType: "user.reply" } : undefined,
              createdAt: "2026-08-29T00:00:00.000Z",
              updatedAt: "2026-08-29T00:00:01.000Z",
            },
            childThreads: [],
            childBlockerChain: [],
            activeRun: waiting ? { runId: submittedRunId!, status: "WAITING" } : undefined,
            conversationTurns: [{
              turnId: `turn-routed-${status.toLowerCase()}`,
              threadId,
              sessionId: "session-1",
              sequence: 1,
              status,
              rootRunId: submittedRunId,
              sourceMessageId: messageId,
              activeRunId: waiting ? submittedRunId : undefined,
              terminalRunId: waiting ? undefined : submittedRunId,
              terminalStatus: waiting ? undefined : "COMPLETED",
              startedAt: "2026-08-29T00:00:00.000Z",
              completedAt: waiting ? undefined : "2026-08-29T00:00:01.000Z",
              updatedAt: "2026-08-29T00:00:01.000Z",
            }],
            conversationMessageRoutes: [{
              messageId,
              disposition: "started",
              runId: submittedRunId,
              createdAt: "2026-08-29T00:00:00.000Z",
            }],
          },
        },
      }));

      assert.equal(await pending, true);
      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.acceptedRunId, "run-newer");
      assert.equal(session.acceptedRunMessageId, "message-newer");
      assert.equal(session.lastRunStatus, undefined);
      assert.equal(session.pendingQueueSubmissions, undefined);
      assert.equal(harness.uiStore.getState().running, true);
      if (status === "COMPLETED") assert.equal(session.terminalQueuedRuns?.[0]?.runId, submittedRunId);
    });
  }
});

test("TuiRunController keeps newer visible state when an older completed response carries FAILED output", async () => {
  let release: ((event: RunnerEvent) => void) | undefined;
  let dispatchedResolve: (() => void) | undefined;
  let submittedRunId: string | undefined;
  const dispatched = new Promise<void>((resolve) => { dispatchedResolve = resolve; });
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
    },
    sendCommand: async (type, payload) => {
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: {
            view: {
              ...makeConversationView({ active: true }),
              thread: {
                ...makeConversationView({ active: true }).thread,
                threadId,
                sessionId: "session-1",
              },
              activeRun: { runId: "run-r2", status: "RUNNING" },
              conversationMessageRoutes: [{
                messageId: "message-older-failed-output",
                disposition: "started",
                runId: submittedRunId,
              }],
              conversationTurns: [{
                turnId: "turn-older-failed-output",
                threadId,
                sessionId: "session-1",
                sequence: 1,
                status: "FAILED",
                rootRunId: submittedRunId,
                sourceMessageId: "message-older-failed-output",
                terminalRunId: submittedRunId,
                terminalStatus: "FAILED",
                startedAt: "2026-08-29T00:00:00.000Z",
                completedAt: "2026-08-29T00:00:01.000Z",
                updatedAt: "2026-08-29T00:00:01.000Z",
              }],
            },
          },
        });
      }
      assert.equal(type, "conversation.message.submit");
      submittedRunId = String((payload.turn as Record<string, unknown>).runId);
      dispatchedResolve?.();
      return await new Promise<RunnerEvent>((resolve) => { release = resolve; });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true, statusLine: "R2 running", errorOverlay: undefined });
  const pending = harness.controller.startActiveTurn({
    messageId: "message-older-failed-output",
    submittedMessage: "older queue",
    queueRequested: true,
  });
  await dispatched;
  await (harness.controller as unknown as { context: TuiRunControllerContext }).context.setSessionState(
    "session-1",
    {
      acceptedRunId: "run-r2",
      acceptedRunMessageId: "message-r2",
      acceptedRunThreadId: threadId,
    },
  );
  harness.uiStore.patch({ running: true, statusLine: "R2 running", errorOverlay: undefined });
  release?.(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId,
    runId: submittedRunId,
    payload: { result: makeFailedResult(submittedRunId!) },
  }));

  assert.equal(await pending, true);
  const state = harness.uiStore.getState();
  assert.equal(state.activeSession.acceptedRunId, "run-r2");
  assert.equal(state.activeSession.lastRunStatus, undefined);
  assert.equal(state.running, true);
  assert.equal(state.statusLine, "R2 running");
  assert.equal(state.errorOverlay, undefined);
  assert.equal(harness.history.some((line) => line.output?.runId === submittedRunId), false);
});

test("TuiRunController does not let a rejected delayed start poison later terminal ownership", async () => {
  const threadId = "thread-main:session-1";
  const queuedRunId = "run-rejected-delayed-start";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r2",
      acceptedRunMessageId: "message-r2",
      acceptedRunThreadId: threadId,
      queuedRunReservations: [{
        runId: queuedRunId,
        messageId: "message-rejected-delayed-start",
        threadId,
        predecessorRunId: "run-r0",
      }],
    },
    syncForegroundSessionProgress: async () => false,
  });
  harness.uiStore.patch({ running: true, statusLine: "R2 running" });
  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId,
    runId: queuedRunId,
    payload: {
      sessionId: "session-1",
      runId: queuedRunId,
      eventType: "user.message",
      sourceMessageId: "message-rejected-delayed-start",
    },
  }));
  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId,
    runId: queuedRunId,
    payload: { result: makeCompletedResult(queuedRunId) },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = harness.uiStore.getState();
  assert.equal(state.activeSession.acceptedRunId, "run-r2");
  assert.equal(state.activeSession.lastRunStatus, undefined);
  assert.equal(state.running, true);
  assert.equal(state.statusLine, "R2 running");
  assert.equal(harness.history.some((line) => line.output?.runId === queuedRunId), false);
});

test("TuiRunController publishes no queued terminal output before durable ownership commits", async () => {
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
      queuedRunReservations: [{
        runId: "run-q1",
        messageId: "message-q1",
        threadId,
        predecessorRunId: "run-r0",
      }],
    },
    syncForegroundQueuedTerminal: async () => false,
  });
  harness.uiStore.patch({
    running: true,
    statusLine: "R0 running",
    conversationActivity: [{
      id: "activity-q1",
      runId: "run-q1",
      kind: "status",
      label: "Run",
      text: "queued",
      visible: true,
      updatedAt: "2026-05-14T00:00:02.000Z",
    }],
  });

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId,
    runId: "run-q1",
    payload: { result: makeCompletedResult("run-q1") },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = harness.uiStore.getState();
  assert.equal(state.activeSession.acceptedRunId, "run-r0");
  assert.equal(state.running, true);
  assert.equal(state.statusLine, "R0 running");
  assert.equal(state.conversationActivity.some((item) => item.runId === "run-q1"), true);
  assert.equal(harness.history.some((line) => line.output?.runId === "run-q1"), false);
  assert.equal(harness.runLogs.some((line) => line.runId === "run-q1"), false);
});

test("TuiRunController publishes no routed or direct queue response before its required commit", async (t) => {
  for (const responseKind of ["routed", "direct"] as const) {
    for (const failureMode of ["before-write", "applied-then-thrown"] as const) {
      await t.test(`${responseKind} ${failureMode}`, async () => {
        const threadId = "thread-main:session-1";
        let reservedRunId: string | undefined;
        let durableAcceptedRunId: string | undefined;
        let harness!: ReturnType<typeof createRunHarness>;
        harness = createRunHarness({
          activeSessionPatch: {
            acceptedRunId: "run-r0",
            acceptedRunMessageId: "message-r0",
            acceptedRunThreadId: threadId,
          },
          commitQueueSessionState: async (_sessionId, patch) => {
            if (failureMode === "applied-then-thrown") {
              durableAcceptedRunId = patch.acceptedRunId;
            }
            return undefined;
          },
          sendCommand: async (type, payload) => {
            if (type === "operator.thread") throw new Error("reconciliation unavailable");
            assert.equal(type, "conversation.message.submit");
            reservedRunId = String((payload.turn as Record<string, unknown>).runId);
            if (responseKind === "direct") {
              return makeRunnerEvent({
                type: "run.completed",
                commandId: "command-direct-required",
                sessionId: "session-1",
                threadId,
                runId: reservedRunId,
                payload: { result: makeCompletedResult(reservedRunId) },
              });
            }
            const view = makeConversationView({ active: true });
            return makeRunnerEvent({
              type: "conversation.message.routed",
              commandId: "command-routed-required",
              payload: {
                sessionId: "session-1",
                threadId,
                messageId: String(payload.messageId),
                disposition: "started",
                runId: reservedRunId,
                view: {
                  ...view,
                  activeRun: { runId: reservedRunId, status: "RUNNING" },
                  conversationTurns: view.conversationTurns.map((turn) => ({
                    ...turn,
                    rootRunId: reservedRunId!,
                    activeRunId: reservedRunId,
                    sourceMessageId: String(payload.messageId),
                  })),
                },
              },
            });
          },
        });
        installActiveConversationView(harness.controller);
        harness.uiStore.patch({ running: true });

        assert.equal(await harness.controller.startActiveTurn({
          messageId: `message-${responseKind}-${failureMode}`,
          submittedMessage: "queue behind R0",
          queueRequested: true,
        }), false);
        assert.equal(harness.uiStore.getState().activeSession.acceptedRunId, "run-r0");
        assert.equal(harness.history.some((line) => line.output?.runId === reservedRunId), false);
        assert.equal(
          durableAcceptedRunId,
          failureMode === "applied-then-thrown" ? reservedRunId : undefined,
        );
      });
    }
  }
});

test("TuiRunController rejects a result-less failed response with the wrong top-level session", async () => {
  let reservedRunId: string | undefined;
  const harness = createRunHarness({
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      reservedRunId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "run.failed",
        sessionId: "session-wrong",
        threadId: "thread-main:session-1",
        runId: reservedRunId,
        payload: { error: { code: "RUN_FAILED", message: "wrong session" } },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-wrong-resultless",
    submittedMessage: "do not cross sessions",
  }), false);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.pendingRunId, reservedRunId);
  assert.equal(session.pendingRunMessageId, "message-wrong-resultless");
  assert.notEqual(session.lastRunStatus, "FAILED");
  assert.equal(session.terminalQueuedRuns, undefined);
});

test("TuiRunController treats an exact result-less queued failure as preaccept rejection", async () => {
  let reservedRunId: string | undefined;
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
    },
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      reservedRunId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "run.failed",
        sessionId: "session-1",
        threadId,
        runId: reservedRunId,
        payload: { error: { code: "RUN_START_REJECTED", message: "rejected before acceptance" } },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-resultless-queued",
    submittedMessage: "queue then reject",
    queueRequested: true,
  }), false);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-r0");
  assert.equal(session.acceptedRunMessageId, "message-r0");
  assert.equal(session.pendingQueueSubmissions?.some((item) => item.runId === reservedRunId) ?? false, false);
  assert.equal(session.queuedRunReservations?.some((item) => item.runId === reservedRunId) ?? false, false);
  assert.equal(session.terminalQueuedRuns?.some((item) => item.runId === reservedRunId) ?? false, false);
  assert.equal(harness.history.some((line) => line.output?.runId === reservedRunId), false);
});

test("TuiRunController does not treat a result-less checkpoint failure as accepted queue authority", async () => {
  let reservedRunId: string | undefined;
  const commands: string[] = [];
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
    },
    sendCommand: async (type, payload) => {
      commands.push(type);
      assert.equal(type, "conversation.message.submit");
      reservedRunId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "run.failed",
        sessionId: "session-1",
        threadId,
        runId: reservedRunId,
        payload: {
          error: {
            code: "CONTEXT_CHECKPOINT_PENDING",
            message: "checkpoint was rejected before run acceptance",
            details: {
              threadId,
              checkpointId: "checkpoint-resultless",
              recommendedAction: "compact",
            },
          },
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-resultless-checkpoint",
    submittedMessage: "do not recover an unaccepted checkpoint",
    queueRequested: true,
  }), false);
  const session = harness.uiStore.getState().activeSession;
  assert.deepEqual(commands, ["conversation.message.submit"]);
  assert.equal(session.acceptedRunId, "run-r0");
  assert.equal(session.pendingQueueSubmissions?.some((item) => item.runId === reservedRunId) ?? false, false);
  assert.equal(session.terminalQueuedRuns?.some((item) => item.runId === reservedRunId) ?? false, false);
  assert.equal(harness.history.some((line) => line.output?.runId === reservedRunId), false);
});

test("TuiRunController prevents dispatch when the captured queue owner is deleted after its barrier", async () => {
  let dispatched = 0;
  let harness: ReturnType<typeof createRunHarness>;
  harness = createRunHarness({
    persistSessionAndUi: async (options) => {
      if (options?.requireSessionSave !== true) return;
      const owner = harness.uiStore.getState().activeSession;
      const visible = { ...owner, name: "visible", sessionId: "session-visible" };
      harness.uiStore.patch({ activeSession: visible, sessions: [visible] });
    },
    sendCommand: async () => {
      dispatched += 1;
      throw new Error("deleted submission must not dispatch");
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-owner-deleted",
    submittedMessage: "queue then delete",
    queueRequested: true,
  }), false);
  assert.equal(dispatched, 0);
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-visible");
});

test("TuiRunController rejects a response after its captured owner is deleted", async () => {
  let release: ((event: RunnerEvent) => void) | undefined;
  let dispatchedResolve: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => { dispatchedResolve = resolve; });
  let reservedRunId: string | undefined;
  const harness = createRunHarness({
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      reservedRunId = String((payload.turn as Record<string, unknown>).runId);
      dispatchedResolve?.();
      return await new Promise<RunnerEvent>((resolve) => { release = resolve; });
    },
  });
  const pending = harness.controller.startActiveTurn({
    messageId: "message-deleted-after-dispatch",
    submittedMessage: "delete after dispatch",
  });
  await dispatched;
  const owner = harness.uiStore.getState().activeSession;
  const visible: TuiSessionMeta = { ...owner, name: "visible", sessionId: "session-visible" };
  harness.uiStore.patch({
    activeSession: visible,
    sessions: [visible],
    running: false,
    statusLine: "visible ready",
  });
  release?.(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: reservedRunId,
    payload: { result: makeCompletedResult(reservedRunId!) },
  }));

  assert.equal(await pending, false);
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-visible");
  assert.equal(harness.uiStore.getState().statusLine, "visible ready");
  assert.equal(harness.diagnostics.some((entry) =>
    entry.scope === "submission.owner_deleted_after_dispatch"
  ), true);
});

test("TuiRunController rejects ownership when deletion occurs during awaited view installation", async () => {
  let harness: ReturnType<typeof createRunHarness>;
  let deleteDuringInstall = false;
  harness = createRunHarness({
    beforeSetSessionState: async (sessionId, patch) => {
      if (deleteDuringInstall === false || sessionId !== "session-1" || patch.focusedThreadId === undefined) return;
      deleteDuringInstall = false;
      const owner = harness.uiStore.getState().activeSession;
      const visible: TuiSessionMeta = { ...owner, name: "visible", sessionId: "session-visible" };
      harness.uiStore.patch({
        activeSession: visible,
        sessions: [visible],
        running: false,
        statusLine: "visible ready",
      });
    },
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      const runId = String((payload.turn as Record<string, unknown>).runId);
      deleteDuringInstall = true;
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          messageId: String(payload.messageId),
          disposition: "replied",
          runId,
          view: {
            ...makeConversationView({ active: true }),
            activeRun: { runId, status: "RUNNING" },
          },
        },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-delete-during-install",
    submittedMessage: "delete during install",
  }), false);
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-visible");
  assert.equal(harness.uiStore.getState().statusLine, "visible ready");
  assert.equal(harness.history.some((line) => line.output !== undefined), false);
});

test("TuiRunController rejects ownership when deletion occurs during response persistence", async () => {
  let harness: ReturnType<typeof createRunHarness>;
  harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: "thread-main:session-1",
    },
    persistSessionAndUi: async (options) => {
      if (options?.requireSessionSave === true) return;
      const owner = harness.uiStore.getState().activeSession;
      const visible: TuiSessionMeta = { ...owner, name: "visible", sessionId: "session-visible" };
      harness.uiStore.patch({
        activeSession: visible,
        sessions: [visible],
        running: false,
        statusLine: "visible ready",
      });
    },
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          messageId: String(payload.messageId),
          disposition: "queued",
          followUpId: `follow-up:${String(payload.messageId)}`,
          view: makeConversationView({ active: true }),
        },
      });
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-delete-during-persist",
    submittedMessage: "delete during persist",
    queueRequested: true,
  }), false);
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-visible");
  assert.equal(harness.uiStore.getState().statusLine, "visible ready");
});

test("TuiRunController keeps an indeterminate failed queue rollback ahead of later submissions", async () => {
  let requiredSave = 0;
  let submissions = 0;
  const harness = createRunHarness({
    persistSessionAndUi: async (options) => {
      if (options?.requireSessionSave !== true) return;
      requiredSave += 1;
      if (requiredSave <= 2) throw new Error(requiredSave === 1 ? "save response lost" : "rollback failed");
    },
    sendCommand: async (type) => {
      if (type === "operator.thread") throw new Error("exact route unavailable");
      submissions += 1;
      throw new Error("later queue must remain blocked");
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-indeterminate-q1",
    submittedMessage: "Q1",
    queueRequested: true,
  }), false);
  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-indeterminate-q2",
    submittedMessage: "Q2",
    queueRequested: true,
  }), false);
  assert.equal(submissions, 0);
  assert.equal(harness.uiStore.getState().activeSession.pendingQueueSubmissions?.[0]?.messageId, "message-indeterminate-q1");
});

test("TuiRunController exactly settles an indeterminate queue journal before releasing the next queue", async (t) => {
  for (const routeState of ["absent", "queued"] as const) {
    await t.test(routeState, async () => {
      let requiredSave = 0;
      let q1RunId: string | undefined;
      const submittedMessages: string[] = [];
      const threadId = "thread-main:session-1";
      const harness = createRunHarness({
        persistSessionAndUi: async (options) => {
          if (options?.requireSessionSave !== true) return;
          requiredSave += 1;
          if (requiredSave <= 2) throw new Error(requiredSave === 1 ? "save response lost" : "rollback failed");
        },
        sendCommand: async (type, payload) => {
          if (type === "operator.thread") {
            return makeRunnerEvent({
              type: "operator.thread",
              payload: {
                view: {
                  ...makeConversationView({ active: true }),
                  conversationMessageRoutes: routeState === "queued"
                    ? [{
                        messageId: "message-settle-q1",
                        disposition: "queued",
                        runId: q1RunId,
                        createdAt: "2026-08-29T00:00:00.000Z",
                      }]
                    : [],
                },
              },
            });
          }
          assert.equal(type, "conversation.message.submit");
          const messageId = String(payload.messageId);
          const runId = String((payload.turn as Record<string, unknown>).runId);
          submittedMessages.push(messageId);
          return makeRunnerEvent({
            type: "conversation.message.routed",
            payload: {
              threadId,
              sessionId: "session-1",
              messageId,
              disposition: "queued",
              runId,
              view: {
                ...makeConversationView({ active: true }),
                conversationMessageRoutes: [{
                  messageId,
                  disposition: "queued",
                  runId,
                  createdAt: "2026-08-29T00:00:01.000Z",
                }],
              },
            },
          });
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });

      const q1 = harness.controller.startActiveTurn({
        messageId: "message-settle-q1",
        submittedMessage: "Q1",
        queueRequested: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      q1RunId = harness.uiStore.getState().activeSession.pendingQueueSubmissions?.[0]?.runId;
      assert.equal(await q1, false);
      assert.equal(await harness.controller.startActiveTurn({
        messageId: "message-settle-q2",
        submittedMessage: "Q2",
        queueRequested: true,
      }), true);

      assert.deepEqual(submittedMessages, ["message-settle-q2"]);
      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.pendingQueueSubmissions, undefined);
      assert.deepEqual(
        session.queuedRunReservations?.map((reservation) => reservation.messageId),
        routeState === "queued"
          ? ["message-settle-q1", "message-settle-q2"]
          : ["message-settle-q2"],
      );
    });
  }
});

test("TuiRunController settles mixed indeterminate records from their current normalized identity", async () => {
  const threadId = "thread-main:session-1";
  const q1 = {
    runId: "run-mixed-q1",
    messageId: "message-mixed-q1",
    threadId,
    predecessorRunId: "run-r0",
    indeterminate: true as const,
  };
  const q2 = {
    runId: "run-mixed-q2",
    messageId: "message-mixed-q2",
    threadId,
    predecessorRunId: "run-r0",
    indeterminate: true as const,
  };
  let q3RunId = "";
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: threadId,
      pendingQueueSubmissions: [q1, q2],
    },
    sendCommand: async (type, payload) => {
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: {
            view: {
              ...makeConversationView({ active: true }),
              conversationMessageRoutes: [q1, q2].map((record) => ({
                messageId: record.messageId,
                disposition: "queued" as const,
                runId: record.runId,
                createdAt: "2026-08-29T00:00:00.000Z",
              })),
            },
          },
        });
      }
      assert.equal(type, "conversation.message.submit");
      q3RunId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId,
          messageId: String(payload.messageId),
          disposition: "queued",
          runId: q3RunId,
          followUpId: "follow-up:mixed-q3",
          view: makeConversationView({ active: true }),
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-mixed-q3",
    submittedMessage: "Q3",
    queueRequested: true,
  }), true);
  assert.deepEqual(
    harness.uiStore.getState().activeSession.queuedRunReservations?.map((record) => ({
      runId: record.runId,
      predecessorRunId: record.predecessorRunId,
    })),
    [{ runId: q1.runId, predecessorRunId: "run-r0" },
      { runId: q2.runId, predecessorRunId: q1.runId },
      { runId: q3RunId, predecessorRunId: q2.runId }],
  );
});

test("TuiRunController reconstructs an indeterminate queue barrier after restart", async () => {
  const threadId = "thread-main:session-1";
  const q1 = {
    runId: "run-restart-indeterminate-q1",
    messageId: "message-restart-indeterminate-q1",
    threadId,
    indeterminate: true as const,
  };
  const commands: string[] = [];
  const harness = createRunHarness({
    activeSessionPatch: { pendingQueueSubmissions: [q1] },
    sendCommand: async (type, payload) => {
      commands.push(type);
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: { view: { ...makeConversationView({ active: true }), conversationMessageRoutes: [] } },
        });
      }
      assert.equal(type, "conversation.message.submit");
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId,
          messageId: String(payload.messageId),
          disposition: "queued",
          runId,
          view: makeConversationView({ active: true }),
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-restart-indeterminate-q2",
    submittedMessage: "Q2 after restart",
    queueRequested: true,
  }), true);

  assert.equal(commands[0], "operator.thread");
  assert.equal(
    harness.uiStore.getState().activeSession.pendingQueueSubmissions
      ?.some((submission) => submission.messageId === q1.messageId) ?? false,
    false,
  );
});

test("TuiRunController preserves a restarted indeterminate barrier until routes are observed", async () => {
  const threadId = "thread-main:session-1";
  const q1 = {
    runId: "run-restart-unobserved-q1",
    messageId: "message-restart-unobserved-q1",
    threadId,
    indeterminate: true as const,
  };
  const commands: string[] = [];
  const harness = createRunHarness({
    activeSessionPatch: { pendingQueueSubmissions: [q1] },
    sendCommand: async (type) => {
      commands.push(type);
      assert.equal(type, "operator.thread");
      return makeRunnerEvent({
        type: "operator.thread",
        payload: { view: makeConversationView({ active: true }) },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-restart-unobserved-q2",
    submittedMessage: "Q2 remains blocked",
    queueRequested: true,
  }), false);

  assert.deepEqual(commands, ["operator.thread"]);
  assert.deepEqual(harness.uiStore.getState().activeSession.pendingQueueSubmissions, [q1]);
});

test("TuiRunController applies a delayed fresh terminal to captured A after focus moves to B", async () => {
  let release: ((event: RunnerEvent) => void) | undefined;
  let reservedRunId: string | undefined;
  let dispatchedResolve: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => { dispatchedResolve = resolve; });
  const harness = createRunHarness({
    sendCommand: async (type, payload) => {
      assert.equal(type, "conversation.message.submit");
      reservedRunId = String((payload.turn as Record<string, unknown>).runId);
      dispatchedResolve?.();
      return await new Promise<RunnerEvent>((resolve) => { release = resolve; });
    },
  });
  const pending = harness.controller.startActiveTurn({
    messageId: "message-fresh-focus",
    submittedMessage: "finish on A",
  });
  await dispatched;
  const owner = harness.uiStore.getState().activeSession;
  const visible: TuiSessionMeta = {
    ...owner,
    name: "visible",
    sessionId: "session-visible",
    pendingRunId: undefined,
    pendingRunMessageId: undefined,
    pendingRunThreadId: undefined,
  };
  harness.uiStore.patch({
    activeSession: visible,
    sessions: [owner, visible],
    running: false,
    statusLine: "visible ready",
  });
  release?.(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: reservedRunId,
    payload: { result: makeCompletedResult(reservedRunId!) },
  }));

  assert.equal(await pending, true);
  const persistedA = harness.uiStore.getState().sessions.find((session) => session.sessionId === "session-1");
  assert.equal(persistedA?.acceptedRunId, reservedRunId);
  assert.equal(persistedA?.lastRunStatus, "COMPLETED");
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-visible");
  assert.equal(harness.uiStore.getState().statusLine, "visible ready");
});

test("TuiRunController recovers a fresh submission on captured A after focus moves to B", async () => {
  let reservedRunId: string | undefined;
  let harness: ReturnType<typeof createRunHarness>;
  const messageId = "message-fresh-recovery-focus";
  const threadId = "thread-main:session-1";
  harness = createRunHarness({
    sendCommand: async (type, payload) => {
      if (type === "conversation.message.submit") {
        reservedRunId = String((payload.turn as Record<string, unknown>).runId);
        const owner = harness.uiStore.getState().activeSession;
        const visible: TuiSessionMeta = {
          ...owner,
          name: "visible",
          sessionId: "session-visible",
          pendingRunId: undefined,
          pendingRunMessageId: undefined,
          pendingRunThreadId: undefined,
        };
        harness.uiStore.patch({
          activeSession: visible,
          sessions: [owner, visible],
          running: false,
          statusLine: "visible ready",
        });
        throw new Error("route response lost");
      }
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: {
            view: {
              thread: {
                threadId,
                sessionId: "session-1",
                title: "Recovered A",
                status: "RUNNING",
                createdAt: "2026-08-29T00:00:00.000Z",
                updatedAt: "2026-08-29T00:00:01.000Z",
              },
              childThreads: [],
              childBlockerChain: [],
              activeRun: { runId: reservedRunId!, status: "RUNNING" },
              conversationTurns: [{
                turnId: "turn-fresh-recovery-focus",
                threadId,
                sessionId: "session-1",
                sequence: 1,
                status: "RUNNING",
                rootRunId: reservedRunId,
                activeRunId: reservedRunId,
                sourceMessageId: messageId,
                startedAt: "2026-08-29T00:00:00.000Z",
                updatedAt: "2026-08-29T00:00:01.000Z",
              }],
              conversationMessageRoutes: [{
                messageId,
                disposition: "started",
                runId: reservedRunId,
                createdAt: "2026-08-29T00:00:00.000Z",
              }],
            },
          },
        });
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId,
    submittedMessage: "recover on A",
  }), true);
  const owner = harness.uiStore.getState().sessions.find((session) => session.sessionId === "session-1");
  assert.equal(owner?.acceptedRunId, reservedRunId);
  assert.equal(owner?.acceptedRunMessageId, messageId);
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-visible");
  assert.equal(harness.uiStore.getState().statusLine, "visible ready");
});

test("TuiRunController applies a delayed operator-control reply to captured A after focus moves to B", async () => {
  let release: ((event: RunnerEvent) => void) | undefined;
  let dispatchedResolve: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => { dispatchedResolve = resolve; });
  const requestId = "request-reply-focus";
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId,
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
      },
    },
    sendCommand: async (type) => {
      assert.equal(type, "operator.control");
      dispatchedResolve?.();
      return await new Promise<RunnerEvent>((resolve) => { release = resolve; });
    },
  });
  const pending = harness.controller.startActiveTurn({
    messageId: "message-reply-focus",
    submittedMessage: "continue",
    resumeBlockedRun: true,
  });
  await dispatched;
  const owner = harness.uiStore.getState().activeSession;
  const visible: TuiSessionMeta = {
    ...owner,
    name: "visible",
    sessionId: "session-visible",
    pendingWaitFor: undefined,
    pendingRunRequestId: undefined,
  };
  harness.uiStore.patch({
    activeSession: visible,
    sessions: [owner, visible],
    running: false,
    statusLine: "visible ready",
  });
  release?.(makeRunnerEvent({
    type: "operator.controlled",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: "run-reply-focus",
    payload: {
      sessionId: "session-1",
      threadId: "thread-main:session-1",
      disposition: "accepted",
      requestId,
      runId: "run-reply-focus",
      view: {
        ...makeConversationView({ active: true }),
        activeRun: { runId: "run-reply-focus", status: "RUNNING" },
        conversationTurns: [{
          turnId: "turn-reply-focus",
          threadId: "thread-main:session-1",
          sessionId: "session-1",
          sequence: 2,
          status: "RUNNING",
          rootRunId: "run-reply-focus",
          activeRunId: "run-reply-focus",
          startedAt: "2026-05-14T00:00:04.000Z",
          updatedAt: "2026-05-14T00:00:04.000Z",
        }],
      },
    },
  }));

  assert.equal(await pending, true);
  const persistedA = harness.uiStore.getState().sessions.find((session) => session.sessionId === "session-1");
  assert.equal(persistedA?.acceptedRunId, "run-reply-focus");
  assert.equal(persistedA?.pendingRunRequestId, undefined);
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-visible");
  assert.equal(harness.uiStore.getState().statusLine, "visible ready");
});

test("TuiRunController applies an exact queued terminal once and rejects its delayed start", async (t) => {
  for (const eventType of ["run.completed", "run.failed", "run.cancelled"] as const) {
    await t.test(eventType, async () => {
      const runId = `run-queued-terminal:${eventType}`;
      const messageId = `message-queued-terminal:${eventType}`;
      const threadId = "thread-main:session-1";
      const harness = createRunHarness({
        activeSessionPatch: {
          acceptedRunId: "run-prior",
          acceptedRunMessageId: "message-prior",
          acceptedRunThreadId: threadId,
          queuedRunReservations: [{
            runId,
            messageId,
            threadId,
            predecessorRunId: "run-prior",
          }],
        },
        sendCommand: async (type) => {
          if (type === "operator.thread") throw new Error("authority unavailable");
          throw new Error(`Unexpected command '${type}'.`);
        },
      });
      const base = {
        sessionId: "session-1",
        threadId,
        runId,
      };
      const terminal = eventType === "run.completed"
        ? makeRunnerEvent({ ...base, type: eventType, payload: { result: makeCompletedResult(runId) } })
        : eventType === "run.failed"
          ? makeRunnerEvent({
              ...base,
              type: eventType,
              payload: {
                result: makeFailedResult(runId),
                error: { code: "RUN_FAILED", message: "queued failure" },
              },
            })
          : makeRunnerEvent({
              ...base,
              type: eventType,
              payload: { sessionId: "session-1", result: makeCancelledResult(runId) },
            });

      harness.controller.onRunnerEvent(terminal);
      harness.controller.onRunnerEvent(terminal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const terminalSession = harness.uiStore.getState().activeSession;
      assert.equal(terminalSession.acceptedRunId, runId);
      assert.equal(terminalSession.acceptedRunMessageId, messageId);
      assert.equal(terminalSession.acceptedRunThreadId, threadId);
      assert.equal(terminalSession.queuedRunReservations, undefined);
      assert.equal(terminalSession.lastRunStatus, eventType === "run.completed" ? "COMPLETED" : "FAILED");
      assert.equal(harness.history.length, 1);

      harness.controller.onRunnerEvent(makeRunnerEvent({
        type: "run.started",
        sessionId: "session-1",
        threadId,
        runId,
        payload: {
          sessionId: "session-1",
          runId,
          eventType: "user.message",
          sourceMessageId: messageId,
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, terminalSession.lastRunStatus);
      assert.equal(harness.history.length, 1);
    });
  }
});

test("TuiRunController settles pre-route queued start and terminal before a delayed route", async (t) => {
  for (const eventType of ["run.completed", "run.failed", "run.cancelled"] as const) {
    await t.test(eventType, async () => {
      let releaseRoute: ((event: RunnerEvent) => void) | undefined;
      let dispatchedResolve: (() => void) | undefined;
      const dispatched = new Promise<void>((resolve) => { dispatchedResolve = resolve; });
      let runId = "";
      const messageId = `message-pre-route:${eventType}`;
      const threadId = "thread-main:session-1";
      const harness = createRunHarness({
        activeSessionPatch: {
          acceptedRunId: "run-r0",
          acceptedRunMessageId: "message-r0",
          acceptedRunThreadId: threadId,
        },
        sendCommand: async (type, payload) => {
          if (type === "operator.thread") {
            const status = eventType === "run.completed" ? "COMPLETED" : "FAILED";
            return makeRunnerEvent({
              type: "operator.thread",
              payload: {
                view: {
                  thread: {
                    threadId,
                    sessionId: "session-1",
                    title: "Pre-route terminal authority",
                    status,
                    lastRunStatus: status,
                    createdAt: "2026-08-29T00:00:00.000Z",
                    updatedAt: "2026-08-29T00:00:01.000Z",
                  },
                  childThreads: [],
                  childBlockerChain: [],
                  conversationMessageRoutes: [{
                    messageId,
                    disposition: "started",
                    runId,
                  }],
                  conversationTurns: [{
                    turnId: `turn-pre-route:${eventType}`,
                    threadId,
                    sessionId: "session-1",
                    sequence: 1,
                    status,
                    rootRunId: runId,
                    sourceMessageId: messageId,
                    terminalRunId: runId,
                    terminalStatus: status,
                    startedAt: "2026-08-29T00:00:00.000Z",
                    completedAt: "2026-08-29T00:00:01.000Z",
                    updatedAt: "2026-08-29T00:00:01.000Z",
                  }],
                },
              },
            });
          }
          assert.equal(type, "conversation.message.submit");
          runId = String((payload.turn as Record<string, unknown>).runId);
          dispatchedResolve?.();
          return await new Promise<RunnerEvent>((resolve) => { releaseRoute = resolve; });
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });
      const submission = harness.controller.startActiveTurn({
        messageId,
        submittedMessage: "pre-route terminal",
        queueRequested: true,
      });
      await dispatched;

      harness.controller.onRunnerEvent(makeRunnerEvent({
        type: "run.started",
        sessionId: "session-1",
        threadId,
        runId,
        payload: {
          sessionId: "session-1",
          runId,
          eventType: "user.message",
          sourceMessageId: messageId,
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const terminal = eventType === "run.completed"
        ? makeRunnerEvent({
            type: eventType,
            sessionId: "session-1",
            threadId,
            runId,
            payload: { result: makeCompletedResult(runId) },
          })
        : eventType === "run.failed"
          ? makeRunnerEvent({
              type: eventType,
              sessionId: "session-1",
              threadId,
              runId,
              payload: {
                result: makeFailedResult(runId),
                error: { code: "RUN_FAILED", message: "pre-route failed" },
              },
            })
          : makeRunnerEvent({
              type: eventType,
              sessionId: "session-1",
              threadId,
              runId,
              payload: { sessionId: "session-1", result: makeCancelledResult(runId) },
            });
      harness.controller.onRunnerEvent(terminal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      releaseRoute?.(makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId,
          messageId,
          disposition: "queued",
          runId,
          followUpId: `follow-up:${messageId}`,
          view: makeConversationView({ active: true }),
        },
      }));

      assert.equal(await submission, true);
      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.acceptedRunId, runId);
      assert.equal(session.pendingQueueSubmissions, undefined);
      assert.equal(session.queuedRunReservations, undefined);
      assert.equal(session.lastRunStatus, eventType === "run.completed" ? "COMPLETED" : "FAILED");
      assert.equal(harness.history.length, 1);
    });
  }
});

test("TuiRunController settles an exact pending queued terminal before its route", async (t) => {
  for (const eventType of ["run.completed", "run.failed", "run.cancelled"] as const) {
    await t.test(eventType, async () => {
      let releaseRoute: ((event: RunnerEvent) => void) | undefined;
      let dispatchedResolve: (() => void) | undefined;
      const dispatched = new Promise<void>((resolve) => { dispatchedResolve = resolve; });
      let runId = "";
      const messageId = `message-pending-terminal:${eventType}`;
      const threadId = "thread-main:session-1";
      const harness = createRunHarness({
        activeSessionPatch: {
          acceptedRunId: "run-r0",
          acceptedRunMessageId: "message-r0",
          acceptedRunThreadId: threadId,
        },
        sendCommand: async (type, payload) => {
          assert.equal(type, "conversation.message.submit");
          runId = String((payload.turn as Record<string, unknown>).runId);
          dispatchedResolve?.();
          return await new Promise<RunnerEvent>((resolve) => { releaseRoute = resolve; });
        },
      });
      installActiveConversationView(harness.controller);
      harness.uiStore.patch({ running: true });
      const submission = harness.controller.startActiveTurn({
        messageId,
        submittedMessage: "terminal before route",
        queueRequested: true,
      });
      await dispatched;

      const terminal = eventType === "run.completed"
        ? makeRunnerEvent({
            type: eventType,
            sessionId: "session-1",
            threadId,
            runId,
            payload: { result: makeCompletedResult(runId) },
          })
        : eventType === "run.failed"
          ? makeRunnerEvent({
              type: eventType,
              sessionId: "session-1",
              threadId,
              runId,
              payload: {
                result: makeFailedResult(runId),
                error: { code: "RUN_FAILED", message: "pending failed" },
              },
            })
          : makeRunnerEvent({
              type: eventType,
              sessionId: "session-1",
              threadId,
              runId,
              payload: { sessionId: "session-1", result: makeCancelledResult(runId) },
            });
      harness.controller.onRunnerEvent(terminal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseRoute?.(makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId,
          messageId,
          disposition: "queued",
          runId,
          followUpId: `follow-up:${messageId}`,
          view: makeConversationView({ active: true }),
        },
      }));

      assert.equal(await submission, true);
      const session = harness.uiStore.getState().activeSession;
      assert.equal(session.acceptedRunId, runId);
      assert.equal(session.pendingQueueSubmissions, undefined);
      assert.equal(session.queuedRunReservations, undefined);
      assert.equal(session.terminalQueuedRuns?.filter((terminalRun) =>
        terminalRun.runId === runId
      ).length, 1);
      assert.equal(harness.history.length, 1);
    });
  }
});

test("TuiRunController tombstones an older queued event without stopping a newer accepted run", async () => {
  const runId = "run-older-queued-event";
  const messageId = "message-older-queued-event";
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    scripted: true,
    activeSessionPatch: {
      acceptedRunId: "run-newer",
      acceptedRunMessageId: "message-newer",
      acceptedRunThreadId: threadId,
      queuedRunReservations: [{
        runId,
        messageId,
        threadId,
        predecessorRunId: "run-predecessor",
      }],
    },
  });
  harness.uiStore.patch({ running: true, statusLine: "running newer" });
  const visibleTranscript = harness.uiStore.getState().transcript;

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId,
    runId,
    payload: { result: makeCompletedResult(runId) },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-newer");
  assert.equal(session.acceptedRunMessageId, "message-newer");
  assert.equal(session.lastRunStatus, undefined);
  assert.equal(session.queuedRunReservations, undefined);
  assert.equal(session.terminalQueuedRuns?.[0]?.runId, runId);
  assert.equal(harness.uiStore.getState().running, true);
  assert.equal(harness.uiStore.getState().statusLine, "running newer");
  assert.deepEqual(harness.uiStore.getState().transcript, visibleTranscript);
  assert.equal(harness.history.some((line) => line.text === "Run Completed"), false);
});

test("TuiRunController rejects wrong-thread queued terminals without consuming their reservation", async (t) => {
  for (const eventType of ["run.completed", "run.failed", "run.cancelled"] as const) {
    await t.test(eventType, async () => {
      const runId = `run-queued-wrong-thread:${eventType}`;
      const messageId = `message-queued-wrong-thread:${eventType}`;
      const threadId = "thread-owned:session-1";
      const harness = createRunHarness({
        activeSessionPatch: {
          queuedRunReservations: [{ runId, messageId, threadId }],
        },
      });
      const base = {
        sessionId: "session-1",
        threadId: "thread-wrong:session-1",
        runId,
      };
      const terminal = eventType === "run.completed"
        ? makeRunnerEvent({ ...base, type: eventType, payload: { result: makeCompletedResult(runId) } })
        : eventType === "run.failed"
          ? makeRunnerEvent({
              ...base,
              type: eventType,
              payload: {
                result: makeFailedResult(runId),
                error: { code: "RUN_FAILED", message: "wrong thread" },
              },
            })
          : makeRunnerEvent({
              ...base,
              type: eventType,
              payload: { sessionId: "session-1", result: makeCancelledResult(runId) },
            });

      harness.controller.onRunnerEvent(terminal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const session = harness.uiStore.getState().activeSession;
      assert.deepEqual(session.queuedRunReservations, [{ runId, messageId, threadId }]);
      assert.equal(session.acceptedRunId, undefined);
      assert.equal(session.lastRunStatus, undefined);
      assert.deepEqual(harness.history, []);
    });
  }
});

test("TuiRunController durably applies an inactive foreground queued terminal without changing visible state", async (t) => {
  for (const eventType of ["run.completed", "run.failed", "run.cancelled"] as const) {
    await t.test(eventType, async () => {
      const runId = `run-inactive-queued:${eventType}`;
      const messageId = `message-inactive-queued:${eventType}`;
      const threadId = "thread-owner:session-1";
      const harness = createRunHarness({ scripted: true });
      const owner = {
        ...harness.uiStore.getState().activeSession,
        queuedRunReservations: [{ runId, messageId, threadId }],
      };
      const visible = {
        ...owner,
        name: "visible",
        sessionId: "session-visible",
        queuedRunReservations: undefined,
      };
      harness.uiStore.patch({
        activeSession: visible,
        sessions: [visible, owner],
        running: true,
        statusLine: "visible session running",
      });
      const visibleTranscript = harness.uiStore.getState().transcript;
      const base = { sessionId: "session-1", threadId, runId };
      const terminal = eventType === "run.completed"
        ? makeRunnerEvent({ ...base, type: eventType, payload: { result: makeCompletedResult(runId) } })
        : eventType === "run.failed"
          ? makeRunnerEvent({
              ...base,
              type: eventType,
              payload: {
                result: makeFailedResult(runId),
                error: { code: "RUN_FAILED", message: "inactive failure" },
              },
            })
          : makeRunnerEvent({
              ...base,
              type: eventType,
              payload: { sessionId: "session-1", result: makeCancelledResult(runId) },
            });

      harness.controller.onRunnerEvent(terminal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const persisted = harness.uiStore.getState().sessions.find(
        (session) => session.sessionId === "session-1",
      );
      assert.equal(persisted?.queuedRunReservations, undefined);
      assert.equal(persisted?.acceptedRunId, runId);
      assert.equal(persisted?.acceptedRunMessageId, messageId);
      assert.equal(persisted?.acceptedRunThreadId, threadId);
      assert.equal(persisted?.lastRunStatus, eventType === "run.completed" ? "COMPLETED" : "FAILED");
      assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-visible");
      assert.equal(harness.uiStore.getState().running, true);
      assert.equal(harness.uiStore.getState().statusLine, "visible session running");
      assert.deepEqual(harness.uiStore.getState().transcript, visibleTranscript);
      assert.equal(harness.history.some((line) => line.text === "Run Completed"), false);
      assert.deepEqual(harness.runLogs, []);

      const restarted = createRunHarness({
        activeSessionPatch: {
          acceptedRunId: runId,
          acceptedRunMessageId: messageId,
          acceptedRunThreadId: threadId,
          lastRunStatus: persisted?.lastRunStatus,
        },
      });
      restarted.controller.onRunnerEvent(makeRunnerEvent({
        type: "run.started",
        sessionId: "session-1",
        threadId,
        runId,
        payload: {
          sessionId: "session-1",
          runId,
          eventType: "user.message",
          sourceMessageId: messageId,
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(restarted.uiStore.getState().activeSession.lastRunStatus, persisted?.lastRunStatus);
      assert.equal(restarted.uiStore.getState().running, false);
    });
  }
});

test("TuiRunController preserves the active run when queue submission is rejected", async () => {
  const activeView = makeConversationView({ active: true });
  const harness = createRunHarness({
    pendingManualCompaction: true,
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") throw new Error("queue transport failed");
      if (type === "operator.thread") {
        return makeRunnerEvent({ type: "operator.thread", payload: { view: activeView } });
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true, statusLine: "active run" });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-queue-failed",
    submittedMessage: "next task",
  }), false);

  const state = harness.uiStore.getState();
  assert.equal(state.running, true);
  assert.equal(state.statusLine, "active run");
  assert.notEqual(state.activeSession.lastRunStatus, "FAILED");
  assert.equal(state.activeSession.pendingManualCompaction, true);
  assert.equal(state.errorOverlay?.code, "QUEUE_SUBMISSION_ERROR");
  assert.match(harness.history.at(-1)?.text ?? "", /Queue submission could not be confirmed/u);
});

test("TuiRunController excludes the exact optimistic message from submitted model history", async () => {
  const harness = createRunHarness();
  const messageId = "message-optimistic-exact";
  harness.uiStore.patch({
    transcript: [
      ...harness.uiStore.getState().transcript,
      {
        role: "user",
        text: "next task",
        timestamp: "2026-05-14T00:00:02.000Z",
        eventId: messageId,
        data: {
          kind: "tui.user-message.v1",
          messageId,
          deliveryState: "submitting",
        },
      },
    ],
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId,
    submittedMessage: "next task",
  }), true);

  const turn = harness.commands[0]?.payload.turn as { history?: Array<{ text: string }> } | undefined;
  assert.equal(turn?.history?.some((line) => line.text === "next task"), false);
  assert.equal(turn?.history?.some((line) => line.text === "prior"), true);
});

test("TuiRunController recovers an accepted queue submission by exact message identity", async () => {
  const messageId = "message-queue-recovered";
  const activeView = makeConversationView({ active: true });
  const recoveredView = {
    ...activeView,
    conversationMessageRoutes: [{
      messageId,
      disposition: "queued" as const,
      followUpId: "follow-up:message-queue-recovered",
      turnId: "turn-queued",
      createdAt: "2026-05-14T00:00:04.000Z",
    }],
  };
  const harness = createRunHarness({
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") throw new Error("route response lost");
      if (type === "operator.thread") {
        return makeRunnerEvent({ type: "operator.thread", payload: { view: recoveredView } });
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  assert.equal(await harness.controller.startActiveTurn({
    messageId,
    submittedMessage: "next task",
  }), true);

  assert.equal(harness.uiStore.getState().running, true);
  assert.match(harness.uiStore.getState().statusLine, /queued behind current work/u);
  assert.equal(harness.history.some((line) => /could not be confirmed/u.test(line.text)), false);
});

test("TuiRunController forwards an exact evaluation review option", async () => {
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "evaluation_review",
        allowedOptionIds: [
          "evaluation.accept_once",
          "evaluation.revise",
          "terminal.fail",
        ],
      },
      interaction: structuredClone(evaluationReviewInteractionFixture),
    },
  });

  await harness.controller.startActiveTurn({
    submittedMessage: "evaluation.accept_once",
    resumeBlockedRun: true,
  });

  assert.equal(harness.commands[0]?.type, "operator.control");
  assert.equal(harness.commands[0]?.payload.action, "reply");
  assert.equal(harness.commands[0]?.payload.requestId, "evaluation-review-fixture");
  assert.equal(harness.commands[0]?.payload.recoveryOptionId, "evaluation.accept_once");
});

test("TuiRunController blocks a legacy review without a canonical envelope", async () => {
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: { reason: "recovery_review" },
    },
  });

  await assert.rejects(
    () => harness.controller.startActiveTurn({
      submittedMessage: "retry.primary",
      resumeBlockedRun: true,
    }),
    /cannot be answered safely/u,
  );
  assert.equal(harness.commands.length, 0);
});

test("TuiRunController falls back to authoritative conversation routing when a legacy wait lacks request identity", async () => {
  const pendingWaitFor = {
    kind: "user" as const,
    eventType: "user.reply",
  };
  const harness = createRunHarness({ pendingWaitFor });

  await harness.controller.startActiveTurn({
    submittedMessage: "continue",
    resumeBlockedRun: true,
  });

  assert.equal(harness.commands[0]?.type, "conversation.message.submit");
  assert.equal((harness.commands[0]?.payload.turn as Record<string, unknown>).message, "continue");
  assert.equal(harness.uiStore.getState().activeSession.pendingWaitFor, undefined);
});

test("TuiRunController emits an explicit terminal marker for scripted completion", async () => {
  let runId: string | undefined;
  const harness = createRunHarness({
    scripted: true,
    sendCommand: async (_type, payload) => {
      runId = String((payload.turn as Record<string, unknown>).runId);
      const view = makeConversationView({ active: true });
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          threadId: "thread-main:session-1",
          sessionId: "session-1",
          messageId: String((payload as Record<string, unknown>).messageId),
          disposition: "started",
          runId,
          view: {
            ...view,
            activeRun: { runId, status: "RUNNING" },
            conversationTurns: view.conversationTurns.map((turn) => ({
              ...turn,
              rootRunId: runId!,
              activeRunId: runId!,
            })),
          },
        },
      });
    },
  });

  await harness.controller.startActiveTurn({ submittedMessage: "complete the task" });
  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    commandId: "command-scripted",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: runId!,
    payload: {
      result: {
        assistantText: "done",
        output: makeCompletedOutput("session-1", runId!),
      },
    },
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    harness.history.slice(-2).map((line) => [line.role, line.text]),
    [
      ["assistant", "done"],
      ["system", "Run Completed"],
    ],
  );
});

test("TuiRunController tags and retains only runtime waiting prompts on continuation", async () => {
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: { prompt: "Which workspace should I inspect?" },
  };
  let callCount = 0;
  const runIds: string[] = [];
  const harness = createRunHarness({
    sendCommand: async (type, payload) => {
      harness.commands.push({ type, payload: payload as unknown as Record<string, unknown> });
      callCount += 1;
      const runId = String((payload.turn as Record<string, unknown>).runId);
      runIds.push(runId);
      return makeRunnerEvent({
        type: "run.completed",
        commandId: `command-${callCount}`,
        runId,
        payload: {
          result: callCount === 1
            ? {
                assistantText: null,
                output: {
                  ...makeCompletedOutput("session-1", runId),
                  status: "WAITING" as const,
                  waitFor,
                },
              }
            : {
                assistantText: "done",
                output: makeCompletedOutput("session-1", runId),
              },
        },
      });
    },
  });

  await harness.controller.startActiveTurn({ submittedMessage: "Inspect the workspace" });
  const waitingLine = harness.history.at(-1);
  assert.deepEqual(waitingLine?.data, {
    kind: "runtime.waiting_prompt",
    runId: runIds[0],
    waitEventType: "user.reply",
    prompt: "Which workspace should I inspect?",
  });

  harness.uiStore.patch({
    transcript: [
      {
        role: "system",
        text: "Local status: connected",
        timestamp: "2026-05-14T00:00:00.000Z",
      },
      {
        role: "user",
        text: "Inspect the workspace",
        timestamp: "2026-05-14T00:00:01.000Z",
      },
      {
        role: "system",
        text: waitingLine!.text,
        timestamp: "2026-05-14T00:00:02.000Z",
        data: waitingLine!.data,
      },
    ],
  });

  await harness.controller.startActiveTurn({ submittedMessage: "Use this one" });
  const resumedTurn = harness.commands[1]?.payload.turn as Record<string, unknown>;
  assert.deepEqual(resumedTurn.history, [
    {
      role: "user",
      text: "Inspect the workspace",
      timestamp: "2026-05-14T00:00:01.000Z",
    },
    {
      role: "system",
      text: waitingLine!.text,
      timestamp: "2026-05-14T00:00:02.000Z",
      data: { kind: "runtime.waiting_prompt", runId: runIds[0] },
    },
  ]);
});

test("TuiRunController clears submitted wait state while blocked resume is in flight", async () => {
  let resolveRun:
    | ((value: Awaited<ReturnType<TuiRunControllerContext["client"]["sendCommand"]>>) => void)
    | undefined;
  const pendingRun = new Promise<Awaited<ReturnType<TuiRunControllerContext["client"]["sendCommand"]>>>((resolve) => {
    resolveRun = resolve;
  });
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId: "request-mode-blocked",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Choose a mode.",
      },
      metadata: {
        reason: "route_mode_blocked",
      },
    },
    sendCommand: async (type, payload) => {
      harness.commands.push({ type, payload: payload as unknown as Record<string, unknown> });
      return pendingRun;
    },
  });

  const started = harness.controller.startActiveTurn({
    submittedMessage: "/mode build",
    resumeBlockedRun: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.uiStore.getState().running, true);
  assert.equal(harness.uiStore.getState().activeSession.pendingWaitFor, undefined);

  resolveRun?.({
    id: "event-wait-clear",
    type: "run.completed",
    ts: "2026-05-14T00:00:03.000Z",
    commandId: "command-wait-clear",
    payload: {
      result: {
        assistantText: null,
        output: makeCompletedOutput("session-1", "run-wait-clear"),
        finalizedPayload: {
          message: "done",
        },
      },
    },
  });
  await started;

  assert.equal(harness.uiStore.getState().running, false);
  assert.equal(harness.uiStore.getState().activeSession.pendingWaitFor, undefined);
});

test("TuiRunController forceFreshTurn sends user.message and clears pending wait", async () => {
  const submittedWait: TuiSessionMeta["pendingWaitFor"] = {
    kind: "user",
    eventType: "user.reply",
    interaction: {
      version: "v1",
      requestId: "request-mode-dispatch",
      kind: "user_input",
      eventType: "user.reply",
      prompt: "Choose a mode.",
    },
    metadata: {
      reason: "loop_visit_stall",
      resumeReply: "continue",
    },
  };
  const harness = createRunHarness({
    pendingWaitFor: submittedWait,
  });

  await harness.controller.startActiveTurn({
    submittedMessage: "stop editing copy and inspect the rendered app",
    forceFreshTurn: true,
  });

  assert.equal(harness.commands[0]?.type, "conversation.message.submit");
  const turn = harness.commands[0]?.payload.turn as Record<string, unknown>;
  assert.equal(turn.eventType, undefined);
  assert.equal(turn.message, "stop editing copy and inspect the rendered app");
  assert.equal(turn.resumeBlockedRun, undefined);
  assert.equal(turn.manualCompaction, undefined);
  assert.equal(harness.uiStore.getState().activeSession.pendingWaitFor, undefined);
});

test("TuiRunController keeps a failed blocked resume recoverable without restoring the consumed wait", async () => {
  const submittedWait: TuiSessionMeta["pendingWaitFor"] = {
    kind: "user",
    eventType: "user.reply",
    interaction: {
      version: "v1",
      requestId: "request-mode-dispatch-failure",
      kind: "user_input",
      eventType: "user.reply",
      prompt: "Choose a mode.",
    },
    metadata: {
      reason: "route_mode_blocked",
    },
  };
  const harness = createRunHarness({
    pendingWaitFor: submittedWait,
    sendCommand: async (type, payload) => {
      harness.commands.push({ type, payload: payload as unknown as Record<string, unknown> });
      throw new Error("runner unavailable");
    },
  });

  await harness.controller.startActiveTurn({
    submittedMessage: "/mode build",
    resumeBlockedRun: true,
  });

  assert.equal(harness.uiStore.getState().running, false);
  assert.equal(harness.uiStore.getState().activeSession.pendingWaitFor, undefined);
  assert.equal(
    harness.uiStore.getState().activeSession.pendingRunRequestId,
    "request-mode-dispatch-failure",
  );
  assert.equal(harness.uiStore.getState().errorOverlay?.code, "RUN_ACCEPTANCE_UNCONFIRMED");
  assert.equal(harness.uiStore.getState().errorOverlay?.message, "runner unavailable");
});

test("TuiRunController unlocks a mode recommendation when its retry was not accepted", async () => {
  const submittedWait: TuiSessionMeta["pendingWaitFor"] = {
    kind: "user",
    eventType: "user.reply",
    interaction: {
      version: "v1",
      requestId: "request-mode-retry",
      kind: "user_input",
      eventType: "user.reply",
      prompt: "Choose a mode.",
    },
    metadata: { reason: "route_mode_blocked" },
  };
  let attempts = 0;
  let switches = 0;
  const harness = createRunHarness({
    pendingWaitFor: submittedWait,
    sendCommand: async (type, payload) => {
      harness.commands.push({ type, payload: payload as unknown as Record<string, unknown> });
      if (type === "operator.thread") throw new Error("durable route unavailable");
      attempts += 1;
      if (attempts === 1) throw new Error("runner unavailable");
      return makeRunnerEvent({
        type: "conversation.message.routed",
        commandId: "command-mode-retry",
        payload: {
          threadId: "thread-main:session-1",
          sessionId: "session-1",
          messageId: "message-mode-retry",
          disposition: "replied",
          requestId: "request-mode-retry",
          view: {} as never,
        },
      });
    },
  });
  const input = {
    recommendationId: "request-mode-retry",
    mode: "build" as const,
    switchMode: async () => { switches += 1; },
    retry: () => harness.controller.startActiveTurn({
      submittedMessage: "/mode build",
      resumeBlockedRun: true,
    }),
  };

  await harness.controller.switchModeAndRetry(input);
  await harness.controller.switchModeAndRetry(input);

  assert.equal(attempts, 2);
  assert.equal(switches, 2);
});

test("TuiRunController does not restore stale wait state when fresh turn dispatch fails", async () => {
  const submittedWait: TuiSessionMeta["pendingWaitFor"] = {
    kind: "user",
    eventType: "user.reply",
    metadata: {
      reason: "loop_visit_stall",
      resumeReply: "continue",
    },
  };
  const harness = createRunHarness({
    pendingWaitFor: submittedWait,
    sendCommand: async (type, payload) => {
      harness.commands.push({ type, payload: payload as unknown as Record<string, unknown> });
      throw new Error("runner unavailable");
    },
  });

  await harness.controller.startActiveTurn({
    submittedMessage: "new objective",
    forceFreshTurn: true,
  });

  assert.equal(harness.uiStore.getState().running, false);
  assert.equal(harness.uiStore.getState().activeSession.pendingWaitFor, undefined);
  assert.equal(harness.uiStore.getState().errorOverlay?.message, "runner unavailable");
});

test("TuiRunController recovers compact context checkpoints and retries the submitted turn once", async () => {
  const commands: Array<{
    type: string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown> | undefined;
  }> = [];
  const harness = createRunHarness({
    sendCommand: async (type, payload, metadata) => {
      commands.push({
        type,
        payload: payload as Record<string, unknown>,
        metadata: metadata as Record<string, unknown> | undefined,
      });
      if (type === "operator.control") {
        return makeRunnerEvent({
          type: "operator.controlled",
          payload: {
            threadId: "thread-main",
          },
        });
      }
      if (commands.filter((command) => command.type === "conversation.message.submit").length === 1) {
        const runId = String((payload.turn as Record<string, unknown>).runId);
        return makeRunnerEvent({
          type: "run.failed",
          commandId: "command-checkpoint",
          runId,
          payload: {
            result: makeFailedResult(runId),
            error: {
              code: "CONTEXT_CHECKPOINT_PENDING",
              message: "Thread has a pending context checkpoint.",
              details: {
                threadId: "thread-main",
                checkpointId: "checkpoint-1",
                recommendedAction: "compact",
              },
            },
          },
        });
      }
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "run.completed",
        commandId: "command-retry",
        runId,
        payload: {
          result: {
            assistantText: null,
            output: makeCompletedOutput("session-1", runId),
            finalizedPayload: {
              message: "done after recovery",
            },
          },
        },
      });
    },
  });

  await harness.controller.startActiveTurn({
    submittedMessage: "approve",
  });

  assert.equal(commands[0]?.type, "conversation.message.submit");
  assert.equal((commands[0]?.payload.turn as Record<string, unknown>).eventType, undefined);
  assert.equal(commands[1]?.type, "operator.control");
  assert.deepEqual(commands[1]?.payload, {
    action: "resolve_context_checkpoint",
    threadId: "thread-main",
    checkpointId: "checkpoint-1",
    actionValue: "compact",
  });
  assert.equal((commands[1]?.metadata?.profile as { id?: string } | undefined)?.id, "kestrel");
  assert.equal(commands[2]?.type, "conversation.message.submit");
  assert.equal((commands[2]?.payload.turn as Record<string, unknown>).eventType, undefined);
  assert.equal((commands[2]?.payload.turn as Record<string, unknown>).resumeBlockedRun, undefined);
  assert.equal(harness.uiStore.getState().errorOverlay, undefined);
  assert.match(harness.history.find((line) => line.role === "system")?.text ?? "", /Compacted context and continued/u);
});

test("TuiRunController gives a queued checkpoint retry fresh identity across later queue reconstruction", async () => {
  const commands: string[] = [];
  const submissionIdentities: Array<{ messageId: string; runId: string }> = [];
  let submissionCount = 0;
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-r0",
      acceptedRunMessageId: "message-r0",
      acceptedRunThreadId: "thread-main:session-1",
    },
    sendCommand: async (type, payload) => {
      commands.push(type);
      if (type === "operator.control") {
        return makeRunnerEvent({
          type: "operator.controlled",
          payload: { threadId: "thread-main:session-1" },
        });
      }
      assert.equal(type, "conversation.message.submit");
      submissionCount += 1;
      const runId = String((payload.turn as Record<string, unknown>).runId);
      submissionIdentities.push({ messageId: String(payload.messageId), runId });
      if (submissionCount === 1) {
        return makeRunnerEvent({
          type: "run.failed",
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          runId,
          payload: {
            result: makeFailedResult(runId),
            error: {
              code: "CONTEXT_CHECKPOINT_PENDING",
              message: "queued checkpoint",
              details: {
                threadId: "thread-main:session-1",
                checkpointId: "checkpoint-queued",
                recommendedAction: "compact",
              },
            },
          },
        });
      }
      if (submissionCount === 2) {
        return makeRunnerEvent({
          type: "run.completed",
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          runId,
          payload: { result: makeCompletedResult(runId) },
        });
      }
      return makeRunnerEvent({
        type: "conversation.message.routed",
        payload: {
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          messageId: String(payload.messageId),
          disposition: "queued",
          runId,
          followUpId: `follow-up:${String(payload.messageId)}`,
          view: makeConversationView({ active: true }),
        },
      });
    },
  });
  installActiveConversationView(harness.controller);
  harness.uiStore.patch({ running: true });

  const result = await Promise.race([
    harness.controller.startActiveTurn({
      messageId: "message-queued-checkpoint",
      submittedMessage: "recover queued checkpoint",
      queueRequested: true,
    }),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
  ]);

  assert.equal(result, true);
  assert.deepEqual(commands, [
    "conversation.message.submit",
    "operator.thread",
    "operator.control",
    "conversation.message.submit",
    "operator.thread",
  ]);
  assert.notEqual(submissionIdentities[0]?.messageId, submissionIdentities[1]?.messageId);
  assert.notEqual(submissionIdentities[0]?.runId, submissionIdentities[1]?.runId);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.pendingQueueSubmissions, undefined);
  assert.equal(session.lastRunStatus, "COMPLETED");
  assert.equal(harness.history.filter((line) => line.text === "Done.").length, 1);

  harness.uiStore.patch({ running: true });
  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-after-checkpoint",
    submittedMessage: "queue after checkpoint",
    queueRequested: true,
  }), true);
  const reconstructed = new TuiRunController(harness.context);
  installActiveConversationView(reconstructed);
  assert.equal(await reconstructed.startActiveTurn({
    messageId: "message-after-reconstruction",
    submittedMessage: "queue after reconstruction",
    queueRequested: true,
  }), true);
  assert.equal(submissionIdentities[3]?.messageId, "message-after-reconstruction");
  assert.equal(
    harness.uiStore.getState().activeSession.queuedRunReservations?.at(-1)?.predecessorRunId,
    submissionIdentities[2]?.runId,
  );
});

test("TuiRunController keeps checkpoint recovery bound to captured A after focus moves to B", async () => {
  let harness: ReturnType<typeof createRunHarness>;
  let releaseControl: (() => void) | undefined;
  let controlStartedResolve: (() => void) | undefined;
  const controlStarted = new Promise<void>((resolve) => { controlStartedResolve = resolve; });
  const submittedSessions: string[] = [];
  const resolvedWorkspaces: string[] = [];
  let restoredWait = false;
  let submissionCount = 0;
  harness = createRunHarness({
    pendingWaitFor: { kind: "user", eventType: "user.reply" },
    resolveWorkspaceForSession: async (session) => {
      resolvedWorkspaces.push(session.sessionId);
      return {
        binding: "active",
        workspaceId: "workspace-a",
        root: "/workspace/a",
        runtimeContext: { root: "/workspace/a" },
      } as ResolvedWorkspace;
    },
    beforeSetSessionState: async (sessionId, patch) => {
      if (sessionId === "session-1" && patch.pendingWaitFor?.eventType === "user.reply") {
        restoredWait = true;
      }
    },
    sendCommand: async (type, payload) => {
      if (type === "operator.control") {
        controlStartedResolve?.();
        await new Promise<void>((resolve) => { releaseControl = resolve; });
        return makeRunnerEvent({
          type: "operator.controlled",
          payload: { threadId: "thread-main:session-1" },
        });
      }
      assert.equal(type, "conversation.message.submit");
      submissionCount += 1;
      const turn = payload.turn as Record<string, unknown>;
      submittedSessions.push(String(turn.sessionId));
      const runId = String(turn.runId);
      if (submissionCount === 1) {
        return makeRunnerEvent({
          type: "run.failed",
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          runId,
          payload: {
            result: makeFailedResult(runId),
            error: {
              code: "CONTEXT_CHECKPOINT_PENDING",
              message: "checkpoint",
              details: {
                threadId: "thread-main:session-1",
                checkpointId: "checkpoint-a",
                recommendedAction: "compact",
              },
            },
          },
        });
      }
      return makeRunnerEvent({
        type: "run.completed",
        sessionId: "session-1",
        threadId: "thread-main:session-1",
        runId,
        payload: { result: makeCompletedResult(runId) },
      });
    },
  });
  const pending = harness.controller.startActiveTurn({ submittedMessage: "retry A" });
  await controlStarted;
  const owner = harness.uiStore.getState().activeSession;
  const visible: TuiSessionMeta = {
    ...owner,
    name: "visible-b",
    sessionId: "session-b",
    profileId: "profile-b",
    pendingWaitFor: undefined,
  };
  harness.uiStore.patch({ activeSession: visible, sessions: [owner, visible], statusLine: "B ready" });
  releaseControl?.();

  assert.equal(await pending, true);
  assert.deepEqual(submittedSessions, ["session-1", "session-1"]);
  assert.deepEqual(resolvedWorkspaces, ["session-1", "session-1"]);
  assert.equal(restoredWait, true);
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-b");
  assert.equal(harness.uiStore.getState().statusLine, "B ready");
  assert.equal(harness.history.some((line) =>
    line.sessionId === "session-1" && /Compacted context/u.test(line.text)
  ), true);
});

test("TuiRunController does not auto-recover shape-changing context checkpoints", async () => {
  const harness = createRunHarness({
    sendCommand: async (_type, payload) => {
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "run.failed",
        commandId: "command-checkpoint",
        runId,
        payload: {
          result: makeFailedResult(runId),
          error: {
            code: "CONTEXT_CHECKPOINT_PENDING",
            message: "Thread has a pending context checkpoint.",
            details: {
              threadId: "thread-main",
              checkpointId: "checkpoint-1",
              recommendedAction: "handoff",
            },
          },
        },
      });
    },
  });

  await harness.controller.startActiveTurn({
    submittedMessage: "continue",
  });

  assert.equal(harness.uiStore.getState().errorOverlay?.code, "CONTEXT_CHECKPOINT_PENDING");
  assert.equal(harness.uiStore.getState().errorOverlay?.details?.recommendedAction, "handoff");
});

test("TuiRunController attempts context checkpoint recovery only once", async () => {
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const harness = createRunHarness({
    sendCommand: async (type, payload) => {
      commands.push({ type, payload: payload as Record<string, unknown> });
      if (type === "operator.control") {
        return makeRunnerEvent({
          type: "operator.controlled",
          payload: {
            threadId: "thread-main",
          },
        });
      }
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return makeRunnerEvent({
        type: "run.failed",
        commandId: "command-checkpoint",
        runId,
        payload: {
          result: makeFailedResult(runId),
          error: {
            code: "CONTEXT_CHECKPOINT_PENDING",
            message: "Thread has a pending context checkpoint.",
            details: {
              threadId: "thread-main",
              checkpointId: "checkpoint-1",
              recommendedAction: "compact",
            },
          },
        },
      });
    },
  });

  await harness.controller.startActiveTurn({
    submittedMessage: "continue",
  });

  assert.equal(commands.filter((command) => command.type === "operator.control").length, 1);
  assert.equal(commands.filter((command) => command.type === "conversation.message.submit").length, 2);
  assert.equal(harness.uiStore.getState().errorOverlay?.code, "CONTEXT_CHECKPOINT_PENDING");
});

test("TuiRunController gives direct run failures a stable terminal identity", async () => {
  let controller: TuiRunController | undefined;
  const harness = createRunHarness({
    sendCommand: async (_type, payload) => {
      const runId = String((payload.turn as Record<string, unknown>).runId);
      controller!.onRunnerEvent(makeRunnerEvent({
        type: "run.started",
        commandId: "command-stable-failure",
        sessionId: "session-1",
        threadId: "thread-main:session-1",
        runId,
        payload: {
          sessionId: "session-1",
          runId,
          eventType: "user.message",
          sourceMessageId: "message-stable-failure",
        },
      }));
      return makeRunnerEvent({
        type: "run.failed",
        commandId: "command-stable-failure",
        runId,
        payload: {
          result: makeFailedResult(runId),
          error: { code: "RUN_FAILED", message: "Provider failed." },
        },
      });
    },
  });
  controller = harness.controller;

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-stable-failure",
    submittedMessage: "continue",
  }), true);
  const failure = harness.history.find((line) => line.text.includes("Provider failed."));
  assert.match(failure?.eventId ?? "", /^terminal:tui-foreground:/u);
  assert.equal(failure?.data?.kind, "runtime.terminal.v1");
});

test("TuiRunController rejects a retained run A terminal for new message B after accepted run C", async () => {
  let controller: TuiRunController | undefined;
  const threadId = "thread-main:session-1";
  const harness = createRunHarness({
    activeSessionPatch: {
      pendingRunId: "run-A",
      pendingRunMessageId: "message-A",
      pendingRunThreadId: threadId,
    },
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") {
        return makeRunnerEvent({
          type: "run.completed",
          sessionId: "session-1",
          threadId,
          runId: "run-A",
          payload: { result: makeCompletedResult("run-A") },
        });
      }
      if (type === "operator.thread") throw new Error("authority unavailable");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  controller = harness.controller;

  const patchActiveSession = (patch: Partial<TuiSessionMeta>) => {
    const state = harness.uiStore.getState();
    const activeSession = { ...state.activeSession, ...patch };
    harness.uiStore.patch({
      activeSession,
      sessions: state.sessions.map((session) => session.sessionId === activeSession.sessionId
        ? activeSession
        : session),
    });
  };
  const accept = async (runId: string, messageId: string) => {
    patchActiveSession({
      pendingRunId: runId,
      pendingRunMessageId: messageId,
      pendingRunThreadId: threadId,
    });
    controller!.onRunnerEvent(makeRunnerEvent({
      type: "run.started",
      sessionId: "session-1",
      threadId,
      runId,
      payload: {
        sessionId: "session-1",
        runId,
        eventType: "user.message",
        sourceMessageId: messageId,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  await accept("run-A", "message-A");
  patchActiveSession({
    pendingRunId: "run-C",
    pendingRunMessageId: "message-C",
    pendingRunThreadId: threadId,
    lastRunStatus: undefined,
  });
  await accept("run-C", "message-C");
  controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId,
    runId: "run-C",
    payload: { result: makeCompletedResult("run-C") },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(await controller.startActiveTurn({
    messageId: "message-B",
    submittedMessage: "new submission B",
  }), false);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-C");
  assert.equal(session.acceptedRunMessageId, "message-C");
  assert.equal(harness.history.some((line) => line.output?.runId === "run-A"), false);
});

test("TuiRunController rejects run A claiming reserved message B after restart and accepted run C", async () => {
  let dispatchedReservation: string | undefined;
  const harness = createRunHarness({
    activeSessionPatch: {
      acceptedRunId: "run-C",
      acceptedRunMessageId: "message-C",
      acceptedRunThreadId: "thread-main:session-1",
      lastRunStatus: "COMPLETED",
    },
    sendCommand: async (type, payload) => {
      if (type === "conversation.message.submit") {
        dispatchedReservation = (payload.turn as Record<string, unknown> | undefined)?.runId as string | undefined;
        return makeRunnerEvent({
          type: "run.completed",
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          runId: "run-A",
          payload: { result: makeCompletedResult("run-A") },
        });
      }
      if (type === "operator.thread") throw new Error("authority unavailable");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-B",
    submittedMessage: "new submission B",
  }), false);

  assert.match(dispatchedReservation ?? "", /^tui-foreground:/u);
  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-C");
  assert.equal(session.acceptedRunMessageId, "message-C");
  assert.equal(session.acceptedRunThreadId, "thread-main:session-1");
  assert.equal(session.pendingRunId, dispatchedReservation);
  assert.equal(harness.history.some((line) => line.output?.runId === "run-A"), false);
});

test("TuiRunController cancelActiveRun uses the authoritative turn run identity", async () => {
  const harness = createRunHarness();
  installActiveConversationView(harness.controller);

  await harness.controller.cancelActiveRun();

  assert.deepEqual(harness.commands[0], {
    type: "run.cancel",
    payload: {
      sessionId: "session-1",
      runId: "run-start-1",
    },
  });
});

test("TuiRunController refreshes stale authority before stopping a promoted queued run", async () => {
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const promotedView = {
    ...makeConversationView({ active: true }),
    conversationTurns: [{
      turnId: "turn-promoted",
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      sequence: 2,
      status: "RUNNING" as const,
      sourceMessageId: "message-promoted",
      rootRunId: "run-promoted",
      activeRunId: "run-promoted",
      startedAt: "2026-05-14T00:00:04.000Z",
      updatedAt: "2026-05-14T00:00:04.000Z",
    }],
    activeRun: { runId: "run-promoted", status: "RUNNING" as const },
  };
  const harness = createRunHarness({
    activeSessionPatch: {
      pendingRunId: "run-promoted",
      pendingRunMessageId: "message-promoted",
      pendingRunThreadId: "thread-main:session-1",
    },
    sendCommand: async (type, payload) => {
      commands.push({ type, payload: payload as Record<string, unknown> });
      if (type === "operator.thread") {
        return makeRunnerEvent({ type: "operator.thread", payload: { view: promotedView } });
      }
      if (type === "run.cancel") {
        return makeRunnerEvent({
          type: "run.cancelled",
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          runId: "run-promoted",
          payload: {
            sessionId: "session-1",
            result: makeCancelledResult("run-promoted"),
          },
        });
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  installActiveConversationView(harness.controller);
  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: "run-promoted",
    payload: {
      sessionId: "session-1",
      runId: "run-promoted",
      eventType: "user.follow_up",
      sourceMessageId: "message-promoted",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  await harness.controller.cancelActiveRun();

  assert.equal(commands[0]?.type, "operator.thread");
  assert.deepEqual(commands[1], {
    type: "run.cancel",
    payload: { sessionId: "session-1", runId: "run-promoted" },
  });
});

test("TuiRunController keeps a finalizing run active when cancellation is rejected", async () => {
  const harness = createRunHarness({
    sendCommand: async () => {
      throw Object.assign(new Error("The run is finalizing."), {
        code: "RUN_ALREADY_FINALIZING",
      });
    },
  });
  installActiveConversationView(harness.controller);

  await assert.doesNotReject(harness.controller.cancelActiveRun());
  assert.equal(harness.uiStore.getState().activeSession.sessionId, "session-1");
});

test("TuiRunController treats an authority-confirmed terminal run as already stopped", async () => {
  let recoveries = 0;
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const harness = createRunHarness({
    activeSessionPatch: {
      pendingRunId: "run-start-1",
      pendingRunMessageId: "message-run-start-1",
      pendingRunThreadId: "thread-main:session-1",
    },
    recoverTerminalMessages: async () => { recoveries += 1; },
    sendCommand: async (type, payload) => {
      commands.push({ type, payload: payload as Record<string, unknown> });
      if (type === "operator.thread") {
        return makeRunnerEvent({
          type: "operator.thread",
          payload: { view: makeConversationView({ active: false, lastRunStatus: "COMPLETED" }) },
        });
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  installActiveConversationView(harness.controller);
  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.started",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: "run-start-1",
    payload: {
      sessionId: "session-1",
      runId: "run-start-1",
      eventType: "user.message",
      sourceMessageId: "message-run-start-1",
    },
  }));
  harness.uiStore.patch({ running: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  await harness.controller.cancelActiveRun();

  assert.deepEqual(commands.map((command) => command.type), ["operator.thread"]);
  assert.equal(harness.uiStore.getState().running, false);
  assert.match(harness.uiStore.getState().statusLine, /completed/u);
  assert.equal(recoveries, 1);
});

test("TuiRunController terminal events retire only their matching cached run", async () => {
  const harness = createRunHarness({
    sendCommand: async (type) => {
      if (type === "operator.thread") throw new Error("authority unavailable");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });
  installActiveConversationView(harness.controller);
  await new Promise((resolve) => setTimeout(resolve, 0));

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: "run-older",
    payload: {
      result: {
        assistantText: "Older result",
        output: makeCompletedOutput("session-1", "run-older"),
      },
    },
  }));
  assert.deepEqual(harness.controller.getConversationRunState("session-1"), {
    running: true,
    status: "running",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.uiStore.getState().running, true);

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: "run-start-1",
    payload: {
      result: {
        assistantText: "Done",
        output: makeCompletedOutput("session-1", "run-start-1"),
      },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.controller.getConversationRunState("session-1"), {
    running: false,
    status: "completed",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.uiStore.getState().running, false);
});

test("TuiRunController keeps the first same-run terminal outcome immutable", async () => {
  const harness = createRunHarness({
    activeSessionPatch: {
      focusedThreadId: "thread-main:session-1",
      acceptedRunId: "run-terminal-once",
      acceptedRunMessageId: "message-terminal-once",
      acceptedRunThreadId: "thread-main:session-1",
    },
    sendCommand: async (type) => {
      if (type === "operator.thread") throw new Error("authority unavailable");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: "run-terminal-once",
    payload: {
      result: {
        assistantText: "First outcome",
        output: makeCompletedOutput("session-1", "run-terminal-once"),
      },
    },
  }));
  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.failed",
    sessionId: "session-1",
    threadId: "thread-main:session-1",
    runId: "run-terminal-once",
    payload: {
      result: makeFailedResult("run-terminal-once"),
      error: { code: "RUN_FAILED", message: "Conflicting duplicate" },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, "COMPLETED");
  assert.equal(harness.uiStore.getState().statusLine, "completed");
  assert.deepEqual(harness.history.map((line) => line.text), ["First outcome"]);
});

test("TuiRunController keeps accepted terminal ownership when focus moves to another thread", async () => {
  const acceptedThreadId = "thread-accepted:session-1";
  const focusedThreadId = "thread-focused:session-1";
  const runId = "run-focus-drift";
  const harness = createRunHarness({
    activeSessionPatch: {
      focusedThreadId,
      acceptedRunId: runId,
      acceptedRunMessageId: "message-focus-drift",
      acceptedRunThreadId: acceptedThreadId,
    },
    sendCommand: async (type) => {
      if (type === "operator.thread") throw new Error("authority unavailable");
      throw new Error(`Unexpected command '${type}'.`);
    },
  });

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: acceptedThreadId,
    runId,
    payload: { result: makeCompletedResult(runId) },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, "COMPLETED");
  assert.equal(harness.uiStore.getState().activeSession.focusedThreadId, focusedThreadId);
  assert.equal(harness.history.some((line) => line.output?.runId === runId), true);
});

test("TuiRunController rejects a terminal labeled with newly focused rather than accepted thread", async () => {
  const acceptedThreadId = "thread-accepted:session-1";
  const focusedThreadId = "thread-focused:session-1";
  const runId = "run-focus-drift-malformed";
  const harness = createRunHarness({
    activeSessionPatch: {
      focusedThreadId,
      acceptedRunId: runId,
      acceptedRunMessageId: "message-focus-drift-malformed",
      acceptedRunThreadId: acceptedThreadId,
    },
  });

  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    sessionId: "session-1",
    threadId: focusedThreadId,
    runId,
    payload: { result: makeCompletedResult(runId) },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, undefined);
  assert.deepEqual(harness.history, []);
});

test("TuiRunController rejects wrong-thread live terminal events for foreground and background runs", async (t) => {
  for (const delegated of [false, true] as const) {
    for (const eventType of ["run.completed", "run.failed", "run.cancelled"] as const) {
      await t.test(`${delegated ? "background" : "foreground"} ${eventType}`, async () => {
        const runId = `run-${delegated ? "background" : "foreground"}-${eventType}`;
        let refreshes = 0;
        const harness = createRunHarness({
          activeSessionPatch: {
            focusedThreadId: "thread-main:session-1",
            acceptedRunId: runId,
            acceptedRunMessageId: `message-${runId}`,
            acceptedRunThreadId: "thread-main:session-1",
            lastRunStatus: undefined,
            ...(delegated
              ? {
                  delegation: {
                    taskId: `task-${runId}`,
                    parentSessionId: "session-parent",
                    childSessionId: "session-1",
                    childSessionName: "child-terminal-thread",
                    title: "terminal thread child",
                    status: "RUNNING" as const,
                    profileId: "kestrel",
                    provider: "openrouter",
                    model: "test-model",
                    createdAt: "2026-05-14T00:00:00.000Z",
                    updatedAt: "2026-05-14T00:00:02.000Z",
                  },
                }
              : {}),
          },
          sendCommand: async (type) => {
            if (type === "operator.thread") {
              refreshes += 1;
              throw new Error("wrong-thread refresh must not run");
            }
            throw new Error(`Unexpected command '${type}'.`);
          },
        });
        const base = {
          type: eventType,
          sessionId: "session-1",
          threadId: "thread-wrong:session-1",
          runId,
        };
        const event = eventType === "run.completed"
          ? makeRunnerEvent({
              ...base,
              type: eventType,
              payload: { result: makeCompletedResult(runId) },
            })
          : eventType === "run.failed"
            ? makeRunnerEvent({
                ...base,
                type: eventType,
                payload: {
                  result: makeFailedResult(runId),
                  error: { code: "RUN_FAILED", message: "wrong-thread failure" },
                },
              })
            : makeRunnerEvent({
                ...base,
                type: eventType,
                payload: {
                  sessionId: "session-1",
                  result: makeCancelledResult(runId),
                },
              });

        harness.controller.onRunnerEvent(event);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(harness.uiStore.getState().activeSession.lastRunStatus, undefined);
        assert.equal(harness.uiStore.getState().running, false);
        assert.deepEqual(harness.history, []);
        assert.equal(refreshes, 0);
      });
    }
  }
});

function installActiveConversationView(controller: TuiRunController): void {
  controller.onRunnerEvent(makeRunnerEvent({
    type: "operator.thread",
    payload: {
      view: {
        thread: {
          threadId: "thread-main:session-1",
          sessionId: "session-1",
          title: "Main",
          status: "RUNNING",
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
        childThreads: [],
        childBlockerChain: [],
        conversationTurns: [{
          turnId: "turn-1",
          threadId: "thread-main:session-1",
          sessionId: "session-1",
          sequence: 1,
          status: "RUNNING",
          rootRunId: "run-start-1",
          activeRunId: "run-start-1",
          startedAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        }],
        activeRun: { runId: "run-start-1", status: "RUNNING" },
        followUpQueue: { state: "ready", items: [] },
      },
    },
  }));
}

test("TuiRunController preserves the selected message identity across projection reordering", async () => {
  const harness = createRunHarness();
  harness.uiStore.patch({
    transcript: [{
      eventId: "message-2",
      role: "user",
      text: "second",
      timestamp: "2026-05-14T00:00:02.000Z",
    }, {
      eventId: "message-1",
      role: "user",
      text: "first",
      timestamp: "2026-05-14T00:00:01.000Z",
    }],
    scroll: {
      ...harness.uiStore.getState().scroll,
      chat: { offset: 0, cursor: 0, tailLocked: false },
    },
  });
  const view = {
    thread: {
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      title: "Main",
      status: "RUNNING" as const,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:02.000Z",
    },
    childThreads: [],
    childBlockerChain: [],
    conversationTurns: [{
      turnId: "turn-1",
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      sequence: 1,
      status: "COMPLETED" as const,
      sourceMessageId: "message-1",
      startedAt: "2026-05-14T00:00:01.000Z",
      updatedAt: "2026-05-14T00:00:01.000Z",
    }, {
      turnId: "turn-2",
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      sequence: 2,
      status: "RUNNING" as const,
      sourceMessageId: "message-2",
      activeRunId: "run-2",
      startedAt: "2026-05-14T00:00:02.000Z",
      updatedAt: "2026-05-14T00:00:02.000Z",
    }],
    conversationMessageRoutes: [{
      messageId: "message-1",
      disposition: "started" as const,
      createdAt: "2026-05-14T00:00:01.000Z",
      turnId: "turn-1",
    }, {
      messageId: "message-2",
      disposition: "started" as const,
      createdAt: "2026-05-14T00:00:02.000Z",
      turnId: "turn-2",
      runId: "run-2",
    }],
    activeRun: { runId: "run-2", status: "RUNNING" as const },
    followUpQueue: { state: "ready" as const, items: [] },
  };

  harness.controller.onRunnerEvent(makeRunnerEvent({ type: "operator.thread", payload: { view } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.uiStore.getState().transcript.map((line) => line.eventId), ["message-1", "message-2"]);
  assert.equal(harness.uiStore.getState().scroll.chat.cursor, 1);

  harness.uiStore.patch({
    scroll: {
      ...harness.uiStore.getState().scroll,
      chat: { offset: 0, cursor: 0, tailLocked: true },
    },
  });
  harness.controller.onRunnerEvent(makeRunnerEvent({ type: "operator.thread", payload: { view } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.uiStore.getState().scroll.chat.cursor, 1);
  assert.equal(harness.uiStore.getState().scroll.chat.tailLocked, true);
});

test("TuiRunController separates operational progress, provider reasoning, and agent progress", () => {
  const harness = createRunHarness();

  harness.controller.onRunnerEvent({
    type: "run.progress",
    payload: {
      update: {
        sessionId: "session-1",
        runId: "run-progress-1",
        kind: "step",
        phase: "execute",
        code: "STEP_RUNNING",
        message: "Working",
        seq: 1,
      },
    },
  } as unknown as RunnerEvent);
  harness.controller.onRunnerEvent({
    type: "run.agent_progress",
    payload: {
      update: {
        version: "v1",
        sessionId: "session-1",
        runId: "run-progress-1",
        message: "Thinking",
        ts: new Date().toISOString(),
        seq: 2,
        stepIndex: 1,
        stepAgent: "agent.loop",
      },
    },
  } as unknown as RunnerEvent);
  harness.controller.onRunnerEvent({
    type: "run.model.reasoning.delta",
    payload: {
      update: {
        version: "v1",
        sessionId: "session-1",
        runId: "run-progress-1",
        ts: new Date().toISOString(),
        seq: 3,
        event: "delta",
        attempt: 1,
        format: "summary",
        delta: "Provider check",
        contentState: "live",
      },
    },
  } as unknown as RunnerEvent);

  assert.deepEqual(
    harness.uiStore.getState().conversationActivity.map((item) => [item.kind, item.text]),
    [
      ["status", "Working"],
      ["agent_progress", "Thinking"],
      ["reasoning", "Provider check"],
    ],
  );
  assert.equal(harness.uiStore.getState().statusLine, "Provider reasoning summary: Provider check");
  assert.equal(harness.runLogs[0]?.eventName, "progress_step");
  assert.equal(harness.reasoning.length, 0);
});

test("TuiRunController preserves the MCP summary during live activity", () => {
  const harness = createRunHarness({
    withMcpSummary: (statusLine) => `${statusLine} | MCP connected`,
  });

  harness.controller.onRunnerEvent({
    type: "run.agent_progress",
    payload: {
      update: {
        version: "v1",
        sessionId: "session-1",
        runId: "run-progress-1",
        message: "Thinking",
        ts: "2026-05-14T00:00:03.000Z",
        seq: 1,
        stepIndex: 1,
        stepAgent: "agent.loop",
      },
    },
  } as unknown as RunnerEvent);

  assert.equal(harness.uiStore.getState().statusLine, "Agent progress: Thinking | MCP connected");
});

test("TuiRunController retains background activity for later session restoration", () => {
  const harness = createRunHarness();
  harness.controller.onRunnerEvent({
    type: "run.agent_progress",
    payload: {
      update: {
        version: "v1",
        sessionId: "session-background",
        runId: "run-background",
        message: "Background work",
        ts: "2026-05-14T00:00:03.000Z",
        seq: 4,
        stepIndex: 1,
        stepAgent: "agent.loop",
      },
    },
  } as unknown as RunnerEvent);

  assert.equal(harness.uiStore.getState().conversationActivity.length, 0);
  const restored = harness.controller.getConversationActivity("session-background");
  assert.deepEqual(restored.map((item) => [item.text, item.sequence]), [["Background work", 4]]);
  restored[0]!.text = "mutated copy";
  assert.equal(
    harness.controller.getConversationActivity("session-background")[0]?.text,
    "Background work",
  );
});

test("TuiRunController appendRunFailureDiagnostics records model timeout details", async () => {
  const harness = createRunHarness();

  await harness.controller.appendRunFailureDiagnostics({
    code: "IO_MODEL_TIMEOUT",
    message: "timeout",
    details: { provider: "openrouter" },
  });

  assert.deepEqual(harness.diagnostics[0], {
    scope: "runtime.timeout",
    summary: "Model timeout surfaced in the TUI",
    details: [
      "code: IO_MODEL_TIMEOUT",
      "message: timeout",
      "details:",
      JSON.stringify({ provider: "openrouter" }, null, 2),
    ].join("\n"),
  });
});
