import test from "node:test";
import assert from "node:assert/strict";

import {
  TuiRunController,
  type TuiRunControllerContext,
} from "../../cli/app/TuiRunController.js";
import type {
  AgentRunLogLine,
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
} = {}): {
  controller: TuiRunController;
  uiStore: UiStore;
  commands: Array<{ type: string; payload: Record<string, unknown> }>;
  history: Array<{
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
      : input.legacyEnvironmentMissing === true || input.runtimeEnvironmentPresetId !== undefined
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
        if (type === "session.describe") {
          sessionDescribeCount += 1;
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
          return await input.sendCommand(
            type as never,
            payload as never,
            metadata as never,
          );
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
    getLocalCoreClient: () => ({
      resolveExecutionProfile: async (request: {
        client: "cli";
        profileId: string;
        environmentPresetId: "cli_safe_local" | "cli_dev_local";
      }) => {
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
      history.push({ role, text, ...(data !== undefined ? { data } : {}), output, eventId });
    },
    persistSessionAndUi: async () => { persistCount += 1; },
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
    navigateToView: () => {},
    withMcpSummary: input.withMcpSummary ?? ((statusLine: string) => statusLine),
    recordPersistenceFailure: () => {},
    refreshWorkspaceForActiveSession: async () => {},
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
    syncForegroundSessionProgress: async ({ sessionId, threadId, runId, messageId }) => {
      const state = uiStore.getState();
      const queuedReservation = state.activeSession.queuedRunReservations?.find((reservation) =>
        reservation.runId === runId
        && reservation.messageId === messageId
        && reservation.threadId === threadId
      );
      if (
        state.activeSession.sessionId !== sessionId
        || (
          queuedReservation === undefined
          && (
            state.activeSession.pendingRunId !== runId
            || state.activeSession.pendingRunMessageId !== messageId
            || state.activeSession.pendingRunThreadId !== threadId
          )
        )
      ) return false;
      const accepted = {
          ...state.activeSession,
          started: true,
          focusedThreadId: threadId,
          acceptedRunId: runId,
          acceptedRunMessageId: messageId,
          acceptedRunThreadId: threadId,
          pendingRunId: undefined,
          pendingRunMessageId: undefined,
          pendingRunThreadId: undefined,
          queuedRunReservations: queuedReservation === undefined
            ? state.activeSession.queuedRunReservations
            : (() => {
                const remaining = state.activeSession.queuedRunReservations?.filter((reservation) =>
                  reservation.runId !== queuedReservation.runId
                  || reservation.messageId !== queuedReservation.messageId
                  || reservation.threadId !== queuedReservation.threadId
                );
                return remaining?.length === 0 ? undefined : remaining;
              })(),
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
    },
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
      uiStore.patch({
        activeSession: {
          ...state.activeSession,
          started: true,
          ...(payload.focusedThreadId !== undefined
            ? { focusedThreadId: payload.focusedThreadId }
            : payload.threadId !== undefined
              ? { focusedThreadId: payload.threadId }
              : {}),
          ...(payload.activeAssembly?.bundleId !== undefined
            ? { effectiveAssemblyId: payload.activeAssembly.bundleId }
            : {}),
        },
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
        );
        return;
      }
      if (output.status === "FAILED") {
        await context.appendHistoryLine(
          "system",
          `Run failed: ${output.errors[0]?.message ?? "Run failed."}`,
          undefined,
          output,
        );
        return;
      }
      await context.appendHistoryLine(
        result.assistantText === null ? "system" : "assistant",
        result.assistantText ?? "The run completed, but its final response could not be delivered.",
        undefined,
        output,
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

  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-queued",
    submittedMessage: "next task",
  }), true);

  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.type, "conversation.message.submit");
  assert.equal(commands[0]?.payload.messageId, "message-queued");
  assert.match(queuedReservation ?? "", /^tui-foreground:/u);
  assert.equal(harness.uiStore.getState().activeSession.pendingRunId, undefined);
  assert.deepEqual(harness.uiStore.getState().activeSession.queuedRunReservations, [{
    runId: queuedReservation,
    messageId: "message-queued",
    threadId: "thread-main:session-1",
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
    sendCommand: async (type, payload) => {
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
  }), true);
  assert.equal(await harness.controller.startActiveTurn({
    messageId: "message-queued-b",
    submittedMessage: "queued B",
  }), true);
  assert.deepEqual(
    harness.uiStore.getState().activeSession.queuedRunReservations,
    dispatched.map(({ runId, messageId }) => ({
      runId,
      messageId,
      threadId: "thread-main:session-1",
    })),
  );

  const promoted = dispatched[1]!;
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

  const session = harness.uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, promoted.runId);
  assert.deepEqual(session.queuedRunReservations, [{
    ...dispatched[0]!,
    threadId: "thread-main:session-1",
  }]);
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
          queuedRunReservations: [{ runId, messageId, threadId }],
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
