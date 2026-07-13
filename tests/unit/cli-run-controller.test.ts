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
import type {
  NormalizedOutput,
  ReasoningUpdateV1,
} from "../../src/index.js";

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
} = {}): {
  controller: TuiRunController;
  uiStore: UiStore;
  commands: Array<{ type: string; payload: Record<string, unknown> }>;
  history: Array<{ role: string; text: string; output?: NormalizedOutput | undefined }>;
  diagnostics: Array<{ scope: string; summary: string; details?: string | undefined }>;
  runLogs: AgentRunLogLine[];
  reasoning: ReasoningUpdateV1[];
} {
  const activeProfile: TuiProfile = {
    id: "reference",
    label: "Reference",
    agent: "reference-react",
    sessionPrefix: "ref",
  };
  const activeSession: TuiSessionMeta = {
    name: "default",
    sessionId: "session-1",
    profileId: activeProfile.id,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    started: true,
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
  const history: Array<{ role: string; text: string; output?: NormalizedOutput | undefined }> = [];
  const diagnostics: Array<{ scope: string; summary: string; details?: string | undefined }> = [];
  const runLogs: AgentRunLogLine[] = [];
  const reasoning: ReasoningUpdateV1[] = [];

  const context: TuiRunControllerContext = {
    options: { cwd: process.cwd() },
    profileStore: undefined,
    sessionStore: undefined,
    workspaceStore: undefined,
    historyStore: undefined,
    diagnosticsStore: {
      getDisplayPath: () => "/tmp/kestrel-diagnostics.log",
    },
    uiStateStore: undefined,
    client: {
      sendCommand: input.sendCommand ?? (async (type: string, payload: Record<string, unknown>) => {
        commands.push({ type, payload });
        if (type === "run.cancel") {
          return makeRunnerEvent({
            type: "run.cancelled",
            payload: {
              sessionId: activeSession.sessionId,
              result: makeFailedResult("run-start-1"),
            },
          });
        }
        return makeRunnerEvent({
          type: "run.completed",
          commandId: "command-1",
          payload: {
            result: {
              assistantText: "done",
              output: makeCompletedOutput(activeSession.sessionId, "run-start-1"),
              finalizedPayload: {
                message: "done",
              },
            },
          },
        });
      }),
    },
    uiStore,
    selectors: createUiDerivedSelectors(),
    getRuntimeSettings: () => ({ version: 1, defaults: {} }),
    getSessionsFile: () => ({ version: 5, activeSessionName: "default", sessions: [activeSession] }),
    setSessionsFile: () => undefined,
    getActiveWorkspace: () => undefined,
    setActiveWorkspace: () => undefined,
    getLaunchWorkspace: () => undefined,
    setLaunchWorkspace: () => undefined,
    appendHistoryLine: async (
      role: TranscriptLine["role"],
      text: string,
      _data?: Record<string, unknown> | undefined,
      output?: NormalizedOutput | undefined,
    ) => {
      history.push({ role, text, output });
    },
    persistSessionAndUi: async () => undefined,
    persistUiState: async () => undefined,
    persistActiveProfile: async () => undefined,
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
    navigateToView: () => undefined,
    withMcpSummary: (statusLine: string) => statusLine,
    recordPersistenceFailure: () => undefined,
    refreshWorkspaceForActiveSession: async () => undefined,
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
    handleTaskUpdatedEvent: async () => undefined,
    syncBackgroundSessionProgress: async () => undefined,
    syncBackgroundSessionResult: async () => undefined,
    syncBackgroundSessionFailure: async () => undefined,
    clearProgressForRun: () => undefined,
    pushRunLog: (line: AgentRunLogLine) => {
      runLogs.push(line);
    },
    enqueueReasoningTranscriptUpdate: (update: ReasoningUpdateV1) => {
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
  };
}

test("TuiRunController startActiveTurn forwards blocked-run resume and terminal diagnostics", async () => {
  const harness = createRunHarness({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
    },
  });

  await harness.controller.startActiveTurn({
    submittedMessage: "continue",
    resumeBlockedRun: true,
  });

  assert.equal(harness.commands[0]?.type, "run.start");
  const turn = harness.commands[0]?.payload.turn as Record<string, unknown>;
  assert.equal(turn.sessionId, "session-1");
  assert.equal(turn.message, "continue");
  assert.equal(turn.eventType, "user.reply");
  assert.equal(turn.resumeBlockedRun, true);
  assert.equal(turn.manualCompaction, true);
  assert.deepEqual(
    (turn.history as Array<{ role: string; text: string }>).map((line) => line.role),
    ["user"],
  );
  assert.equal(harness.history.at(-1)?.text, "done");
  assert.ok(harness.history.at(-1)?.output);
  assert.ok(harness.diagnostics.some((entry) => entry.scope === "terminal_handoff.tui_response_received"));
  assert.ok(harness.diagnostics.some((entry) => entry.scope === "terminal_handoff.persist_completed"));
  assert.equal(harness.uiStore.getState().running, false);
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

  assert.equal(harness.commands[0]?.type, "run.start");
  const turn = harness.commands[0]?.payload.turn as Record<string, unknown>;
  assert.equal(turn.eventType, "user.message");
  assert.equal(turn.message, "stop editing copy and inspect the rendered app");
  assert.equal(turn.resumeBlockedRun, undefined);
  assert.equal(turn.manualCompaction, undefined);
  assert.equal(harness.uiStore.getState().activeSession.pendingWaitFor, undefined);
});

test("TuiRunController restores submitted wait state when blocked resume dispatch fails", async () => {
  const submittedWait: TuiSessionMeta["pendingWaitFor"] = {
    kind: "user",
    eventType: "user.reply",
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
  const pendingWait: TuiSessionMeta["pendingWaitFor"] = {
    kind: "user",
    eventType: "user.approval",
    metadata: {
      approvalId: "approval-1",
    },
  };
  const commands: Array<{
    type: string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown> | undefined;
  }> = [];
  const harness = createRunHarness({
    pendingWaitFor: pendingWait,
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
      if (commands.filter((command) => command.type === "run.start").length === 1) {
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
    resumeBlockedRun: true,
  });

  assert.equal(commands[0]?.type, "run.start");
  assert.equal((commands[0]?.payload.turn as Record<string, unknown>).eventType, "user.approval");
  assert.equal(commands[1]?.type, "operator.control");
  assert.deepEqual(commands[1]?.payload, {
    action: "resolve_context_checkpoint",
    threadId: "thread-main",
    checkpointId: "checkpoint-1",
    actionValue: "compact",
  });
  assert.equal((commands[1]?.metadata?.profile as { id?: string } | undefined)?.id, "reference");
  assert.equal(commands[2]?.type, "run.start");
  assert.equal((commands[2]?.payload.turn as Record<string, unknown>).eventType, "user.approval");
  assert.equal((commands[2]?.payload.turn as Record<string, unknown>).resumeBlockedRun, true);
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
  assert.equal(commands.filter((command) => command.type === "run.start").length, 2);
  assert.equal(harness.uiStore.getState().errorOverlay?.code, "CONTEXT_CHECKPOINT_PENDING");
});

test("TuiRunController cancelActiveRun preserves run.cancel payload shape", async () => {
  const harness = createRunHarness();

  await harness.controller.cancelActiveRun();

  assert.deepEqual(harness.commands[0], {
    type: "run.cancel",
    payload: {
      sessionId: "session-1",
    },
  });
});

test("TuiRunController runner events update progress, reasoning, and run logs", () => {
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
    type: "run.reasoning",
    payload: {
      update: {
        sessionId: "session-1",
        runId: "run-progress-1",
        message: "Thinking",
        milestone: "route",
        seq: 2,
      },
    },
  } as unknown as RunnerEvent);

  assert.equal(harness.uiStore.getState().latestProgressForSession?.message, "Working");
  assert.equal(harness.uiStore.getState().latestReasoningForSession?.message, "Thinking");
  assert.equal(harness.runLogs[0]?.eventName, "progress_step");
  assert.equal(harness.runLogs[1]?.eventName, "reasoning_update");
  assert.equal(harness.reasoning[0]?.message, "Thinking");
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
