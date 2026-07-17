import test from "node:test";
import assert from "node:assert/strict";

import {
  OperatorController,
  type OperatorControlApplyAction,
} from "../../cli/app/OperatorController.js";
import type { TuiAppContext } from "../../cli/app/TuiAppContext.js";
import type { TuiProfile, TuiSessionMeta } from "../../cli/contracts.js";
import { buildInitialUiRuntimeState, UiStore } from "../../cli/ink/store/UiStore.js";
import { createUiDerivedSelectors } from "../../cli/ink/store/selectors.js";
import type { OperatorControlledEventPayload } from "../../cli/protocol/contracts.js";

function createOperatorHarness(input: {
  running?: boolean | undefined;
  focusedThreadId?: string | undefined;
} = {}): {
  controller: OperatorController;
  commands: Array<{ type: string; payload: unknown; metadata?: unknown | undefined }>;
  applied: Array<{ action: OperatorControlApplyAction; payload: OperatorControlledEventPayload }>;
  historyLines: string[];
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
    ...(input.focusedThreadId !== undefined ? { focusedThreadId: input.focusedThreadId } : {}),
  };
  const uiStore = new UiStore(
    buildInitialUiRuntimeState({
      profile: activeProfile,
      activeSession,
      sessions: [activeSession],
      transcript: [],
    }),
  );
  uiStore.patch({
    running: input.running === true,
  });

  const commands: Array<{ type: string; payload: unknown; metadata?: unknown | undefined }> = [];
  const applied: Array<{ action: OperatorControlApplyAction; payload: OperatorControlledEventPayload }> = [];
  const historyLines: string[] = [];
  const controlledPayload = {
    threadId: input.focusedThreadId ?? activeSession.sessionId,
  } as OperatorControlledEventPayload;
  const context = {
    options: { cwd: process.cwd() },
    profileStore: undefined,
    sessionStore: undefined,
    workspaceStore: undefined,
    historyStore: undefined,
    diagnosticsStore: undefined,
    uiStateStore: undefined,
    client: {
      sendCommand: async (type: string, payload: unknown, metadata?: unknown) => {
        commands.push({ type, payload, metadata });
        if (type === "run.cancel") {
          return { type: "run.cancelled", payload: { sessionId: activeSession.sessionId } };
        }
        if (type === "operator.inbox") {
          return {
            type: "operator.inbox",
            payload: {
              inbox: {
                items: [
                  {
                    kind: "assembly_change_proposal",
                    metadata: { proposalId: "proposal-1" },
                  },
                ],
              },
            },
          };
        }
        return { type: "operator.controlled", payload: controlledPayload };
      },
    },
    uiStore,
    selectors: createUiDerivedSelectors(),
    getRuntimeSettings: () => ({ version: 1, defaults: {} }),
    getSessionsFile: () => ({ version: 1, active: "default", sessions: [activeSession] }),
    setSessionsFile: () => {},
    getActiveWorkspace: () => {},
    setActiveWorkspace: () => {},
    getLaunchWorkspace: () => {},
    setLaunchWorkspace: () => {},
    appendHistoryLine: async (_role: "system" | "assistant" | "user", text: string) => {
      historyLines.push(text);
    },
    persistSessionAndUi: async () => {},
    persistUiState: async () => {},
    persistActiveProfile: async () => {},
    getActiveRunnerMetadata: () => ({ profile: uiStore.getState().activeProfile }),
    setActiveSessionState: async () => {},
    navigateToView: () => {},
    withMcpSummary: (statusLine: string) => statusLine,
    recordPersistenceFailure: () => {},
    cancelActiveRun: async () => {
      commands.push({
        type: "run.cancel",
        payload: {
          sessionId: activeSession.sessionId,
        },
      });
    },
    applyOperatorControlResponse: async (action: OperatorControlApplyAction, payload: OperatorControlledEventPayload) => {
      applied.push({ action, payload });
    },
    refreshCurrentSessionDescribe: async () => {},
    refreshWorkspaceCheckpointList: async () => {},
    beginChildMissionJourney: async () => {},
  } as unknown as ConstructorParameters<typeof OperatorController>[0] & TuiAppContext;

  return {
    controller: new OperatorController(context),
    commands,
    applied,
    historyLines,
  };
}

test("OperatorController stop cancels an active run before sending default steering", async () => {
  const harness = createOperatorHarness({ running: true, focusedThreadId: "thread-1" });

  await harness.controller.handleOperatorControlCommand("stop", []);

  assert.equal(harness.commands[0]?.type, "run.cancel");
  assert.equal(harness.commands[1]?.type, "operator.control");
  assert.deepEqual(harness.commands[1]?.payload, {
    action: "steer",
    threadId: "thread-1",
    message: "Stop your current work immediately and wait for further instructions.",
  });
  assert.equal((harness.commands[1]?.metadata as { profile?: { id?: string } } | undefined)?.profile?.id, "reference");
  assert.equal(harness.applied[0]?.action, "stop");
});

test("OperatorController stop attempts cancellation before steering even when UI is not running", async () => {
  const harness = createOperatorHarness({ running: false, focusedThreadId: "thread-1" });

  await harness.controller.handleOperatorControlCommand("stop", []);

  assert.equal(harness.commands[0]?.type, "run.cancel");
  assert.equal(harness.commands[1]?.type, "operator.control");
  assert.deepEqual(harness.commands[1]?.payload, {
    action: "steer",
    threadId: "thread-1",
    message: "Stop your current work immediately and wait for further instructions.",
  });
});

test("OperatorController assembly approve resolves missing proposal id from inbox", async () => {
  const harness = createOperatorHarness({ focusedThreadId: "thread-1" });

  await harness.controller.handleAssemblyCommand(["approve", "", "ship", "it"]);

  assert.equal(harness.commands[0]?.type, "operator.inbox");
  assert.equal(harness.commands[1]?.type, "operator.control");
  assert.deepEqual(harness.commands[1]?.payload, {
    action: "approve_assembly_change",
    threadId: "thread-1",
    proposalId: "proposal-1",
    message: "ship it",
  });
  assert.equal((harness.commands[0]?.metadata as { profile?: { id?: string } } | undefined)?.profile?.id, "reference");
  assert.equal((harness.commands[1]?.metadata as { profile?: { id?: string } } | undefined)?.profile?.id, "reference");
  assert.equal(harness.applied[0]?.action, "assembly_approve");
});

test("OperatorController validates reply and steer usage copy", async () => {
  const harness = createOperatorHarness();

  await harness.controller.handleOperatorControlCommand("reply", []);
  await harness.controller.handleOperatorControlCommand("steer", []);

  assert.deepEqual(harness.historyLines, [
    "Usage: /reply <message>",
    "Usage: /steer <message>",
  ]);
  assert.equal(harness.commands.length, 0);
});
