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
  registeredProfileId: string;
  sessionDescribeCount: number;
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
    persistSessionAndUi: async () => {},
    persistUiState: async () => {},
    persistActiveProfile: async () => {},
    getActiveRunnerMetadata: () => ({ profile: uiStore.getState().activeProfile }),
    setActiveSessionState: async (patch: Partial<TuiSessionMeta>) => {
      const state = uiStore.getState();
      uiStore.patch({
        activeSession: {
          ...state.activeSession,
          ...patch,
        },
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
    syncBackgroundSessionProgress: async () => {},
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
    registeredProfileId,
    get sessionDescribeCount() {
      return sessionDescribeCount;
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
  });
  assert.equal(harness.history.at(-1)?.text, "Done.");
  assert.equal(harness.uiStore.getState().running, false);
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
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") {
        controller!.onRunnerEvent(makeRunnerEvent({
          type: "run.completed",
          commandId: "command-route-lost",
          sessionId: "session-1",
          threadId: "thread-main:session-1",
          runId: "run-route-lost",
          payload: { result: makeCompletedResult("run-route-lost") },
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
  const recoveredView = {
    ...makeConversationView({ active: true }),
    conversationMessageRoutes: [{
      messageId,
      disposition: "started" as const,
      runId: "run-start-1",
      turnId: "turn-1",
      createdAt: "2026-05-14T00:00:04.000Z",
    }],
  };
  const harness = createRunHarness({
    started: false,
    sendCommand: async (type) => {
      if (type === "conversation.message.submit") throw new Error("route response lost");
      if (type === "operator.thread") {
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
});

test("TuiRunController sends active-run input to Local Core queue authority immediately", async () => {
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const activeView = makeConversationView({ active: true });
  const harness = createRunHarness({
    sendCommand: async (type, payload) => {
      commands.push({ type, payload: payload as Record<string, unknown> });
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
  assert.equal(harness.uiStore.getState().running, true);
  assert.match(harness.uiStore.getState().statusLine, /queued behind current work/u);
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
  const harness = createRunHarness({ scripted: true });

  await harness.controller.startActiveTurn({ submittedMessage: "complete the task" });
  harness.controller.onRunnerEvent(makeRunnerEvent({
    type: "run.completed",
    commandId: "command-scripted",
    payload: {
      result: {
        assistantText: "done",
        output: makeCompletedOutput("session-1", "run-scripted"),
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
  const harness = createRunHarness({
    sendCommand: async (type, payload) => {
      harness.commands.push({ type, payload: payload as unknown as Record<string, unknown> });
      callCount += 1;
      return makeRunnerEvent({
        type: "run.completed",
        commandId: `command-${callCount}`,
        payload: {
          result: callCount === 1
            ? {
                assistantText: null,
                output: {
                  ...makeCompletedOutput("session-1", "run-waiting"),
                  status: "WAITING" as const,
                  waitFor,
                },
              }
            : {
                assistantText: "done",
                output: makeCompletedOutput("session-1", "run-resumed"),
              },
        },
      });
    },
  });

  await harness.controller.startActiveTurn({ submittedMessage: "Inspect the workspace" });
  const waitingLine = harness.history.at(-1);
  assert.deepEqual(waitingLine?.data, {
    kind: "runtime.waiting_prompt",
    runId: "run-waiting",
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
      data: { kind: "runtime.waiting_prompt", runId: "run-waiting" },
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

test("TuiRunController restores submitted wait state when blocked resume dispatch fails", async () => {
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
  assert.deepEqual(harness.uiStore.getState().activeSession.pendingWaitFor, submittedWait);
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
        return makeRunnerEvent({
          type: "run.failed",
          commandId: "command-checkpoint",
          payload: {
            result: makeFailedResult("command-checkpoint"),
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
      return makeRunnerEvent({
        type: "run.completed",
        commandId: "command-retry",
        payload: {
          result: {
            assistantText: null,
            output: makeCompletedOutput("session-1", "run-retry"),
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
    sendCommand: async () => makeRunnerEvent({
      type: "run.failed",
      commandId: "command-checkpoint",
      payload: {
        result: makeFailedResult("command-checkpoint"),
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
    }),
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
      return makeRunnerEvent({
        type: "run.failed",
        commandId: "command-checkpoint",
        payload: {
          result: makeFailedResult("command-checkpoint"),
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
  const harness = createRunHarness({
    sendCommand: async () => makeRunnerEvent({
      type: "run.failed",
      commandId: "command-stable-failure",
      runId: "run-stable-failure",
      payload: {
        result: makeFailedResult("run-stable-failure"),
        error: { code: "RUN_FAILED", message: "Provider failed." },
      },
    }),
  });

  assert.equal(await harness.controller.startActiveTurn({ submittedMessage: "continue" }), true);
  const failure = harness.history.find((line) => line.text.includes("Provider failed."));
  assert.equal(failure?.eventId, "terminal:run-stable-failure");
  assert.equal(failure?.data?.kind, "runtime.terminal.v1");
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
    payload: { sessionId: "session-1", runId: "run-start-1", eventType: "user.message" },
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
