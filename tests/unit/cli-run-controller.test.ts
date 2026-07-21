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
  AgentProgressUpdateV1,
  NormalizedOutput,
} from "../../src/index.js";
import { contractTest } from "../helpers/contract-test.js";


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
  scripted?: boolean | undefined;
} = {}): {
  controller: TuiRunController;
  uiStore: UiStore;
  commands: Array<{ type: string; payload: Record<string, unknown> }>;
  history: Array<{
    role: string;
    text: string;
    data?: Record<string, unknown> | undefined;
    output?: NormalizedOutput | undefined;
  }>;
  diagnostics: Array<{ scope: string; summary: string; details?: string | undefined }>;
  runLogs: AgentRunLogLine[];
  reasoning: AgentProgressUpdateV1[];
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
  const history: Array<{
    role: string;
    text: string;
    data?: Record<string, unknown> | undefined;
    output?: NormalizedOutput | undefined;
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
    ) => {
      history.push({ role, text, ...(data !== undefined ? { data } : {}), output });
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
    withMcpSummary: (statusLine: string) => statusLine,
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
  };
}

contractTest("runtime.hermetic", "TuiRunController startActiveTurn forwards blocked-run resume and terminal diagnostics", async () => {
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

contractTest("runtime.hermetic", "TuiRunController emits an explicit terminal marker for scripted completion", async () => {
  const harness = createRunHarness({ scripted: true });

  await harness.controller.startActiveTurn({ submittedMessage: "complete the task" });

  assert.deepEqual(
    harness.history.slice(-2).map((line) => [line.role, line.text]),
    [
      ["assistant", "done"],
      ["system", "Run Completed"],
    ],
  );
});

contractTest("runtime.hermetic", "TuiRunController tags and retains only runtime waiting prompts on continuation", async () => {
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

contractTest("runtime.hermetic", "TuiRunController clears submitted wait state while blocked resume is in flight", async () => {
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

contractTest("runtime.hermetic", "TuiRunController forceFreshTurn sends user.message and clears pending wait", async () => {
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

contractTest("runtime.hermetic", "TuiRunController restores submitted wait state when blocked resume dispatch fails", async () => {
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

contractTest("runtime.hermetic", "TuiRunController does not restore stale wait state when fresh turn dispatch fails", async () => {
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

contractTest("runtime.hermetic", "TuiRunController recovers compact context checkpoints and retries the submitted turn once", async () => {
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

contractTest("runtime.hermetic", "TuiRunController does not auto-recover shape-changing context checkpoints", async () => {
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

contractTest("runtime.hermetic", "TuiRunController attempts context checkpoint recovery only once", async () => {
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

contractTest("runtime.hermetic", "TuiRunController cancelActiveRun preserves run.cancel payload shape", async () => {
  const harness = createRunHarness();

  await harness.controller.cancelActiveRun();

  assert.deepEqual(harness.commands[0], {
    type: "run.cancel",
    payload: {
      sessionId: "session-1",
    },
  });
});

contractTest("runtime.hermetic", "TuiRunController separates operational progress, provider reasoning, and agent progress", () => {
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

  assert.equal(harness.uiStore.getState().latestProgressForSession?.message, "Working");
  assert.equal(harness.uiStore.getState().statusLine, "Provider reasoning summary (attempt 1): Provider check");
  assert.equal(harness.runLogs[0]?.eventName, "progress_step");
  assert.equal(harness.reasoning[0]?.message, "Thinking");
});

contractTest("runtime.hermetic", "TuiRunController appendRunFailureDiagnostics records model timeout details", async () => {
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
