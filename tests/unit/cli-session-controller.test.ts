import test from "node:test";
import assert from "node:assert/strict";

import {
  SessionController,
  type SessionControllerContext,
} from "../../cli/app/SessionController.js";
import type { SessionsFile, TuiProfile, TuiSessionMeta } from "../../cli/contracts.js";
import { buildInitialUiRuntimeState, UiStore } from "../../cli/ink/store/UiStore.js";
import { TuiEnvironmentIdentityError } from "../../cli/session/TuiExecutionEnvironment.js";


function makeSession(input: Partial<TuiSessionMeta> & { name: string; sessionId: string }): TuiSessionMeta {
  return {
    name: input.name,
    sessionId: input.sessionId,
    profileId: input.profileId ?? "reference",
    createdAt: input.createdAt ?? "2026-05-14T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-14T00:00:00.000Z",
    started: input.started ?? true,
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
    ...(input.pendingWaitFor !== undefined ? { pendingWaitFor: input.pendingWaitFor } : {}),
    ...(input.lastRunStatus !== undefined ? { lastRunStatus: input.lastRunStatus } : {}),
    ...(input.environmentPresetId !== undefined
      ? { environmentPresetId: input.environmentPresetId }
      : {}),
    ...(input.effectiveAssemblyId !== undefined
      ? { effectiveAssemblyId: input.effectiveAssemblyId }
      : {}),
  };
}

function createControllerForState(state: {
  activeSession: TuiSessionMeta;
  sessions: TuiSessionMeta[];
}): { controller: SessionController; history: string[] } {
  const history: string[] = [];
  const context = {
    uiStore: {
      getState: () => state,
    },
    appendHistoryLine: async (_role: "system", text: string) => {
      history.push(text);
    },
  } as unknown as SessionControllerContext;
  return {
    controller: new SessionController(context),
    history,
  };
}

test("SessionController lists sessions with active, mode, wait, and run status markers", async () => {
  const activeSession = makeSession({
    name: "main",
    sessionId: "s-main",
    interactionMode: "build",
    actSubmode: "safe",
  });
  const waitingSession = makeSession({
    name: "blocked",
    sessionId: "s-blocked",
    interactionMode: "plan",
    pendingWaitFor: { kind: "user", eventType: "user.reply" },
    lastRunStatus: "WAITING",
  });
  const { controller, history } = createControllerForState({
    activeSession,
    sessions: [activeSession, waitingSession],
  });

  await controller.handleSessionsCommand();

  assert.equal(
    history[0],
    [
      "Sessions:",
      "main (active) -> s-main mode:Build",
      "blocked -> s-blocked mode:Plan waiting:user.reply status:waiting",
    ].join("\n"),
  );
});

test("SessionController keeps switch and resume usage copy stable", async () => {
  const activeSession = makeSession({ name: "main", sessionId: "s-main" });
  const { controller, history } = createControllerForState({
    activeSession,
    sessions: [activeSession],
  });

  await controller.handleSwitchOrResumeCommand("switch", []);
  await controller.handleSwitchOrResumeCommand("resume", []);

  assert.deepEqual(history, [
    "Usage: /switch <name|session-id-fragment>",
    "Usage: /resume <name|session-id-fragment|recent>",
  ]);
});

test("SessionController restores cached activity when switching to a background session", async () => {
  const profile: TuiProfile = {
    id: "reference",
    label: "Reference",
    agent: "reference-react",
    sessionPrefix: "ref",
  };
  const main = makeSession({
    name: "main",
    sessionId: "s-main",
    started: false,
    environmentPresetId: "cli_dev_local",
  });
  const background = makeSession({
    name: "background",
    sessionId: "s-background",
    started: false,
    environmentPresetId: "cli_dev_local",
  });
  let sessionsFile: SessionsFile = {
    version: 5,
    activeSessionName: main.name,
    sessions: [main, background],
  };
  const uiStore = new UiStore(buildInitialUiRuntimeState({
    profile,
    activeSession: main,
    sessions: sessionsFile.sessions,
    transcript: [],
  }));
  const cachedActivity = [{
    id: "progress-background",
    kind: "agent_progress" as const,
    label: "Agent progress",
    text: "Inspecting the workspace",
    timestamp: "2026-05-14T00:00:02.000Z",
    status: "active" as const,
    runId: "run-background",
    sequence: 2,
  }];
  const context = {
    uiStore,
    profileStore: {
      load: async () => [profile],
      findById: () => profile,
    },
    sessionStore: {
      resolveSelector: (_file: SessionsFile, selector: string) => ({
        status: "matched",
        session: selector === background.name ? background : main,
      }),
      setActive: (file: SessionsFile, name: string) => ({ ...file, activeSessionName: name }),
      upsert: (file: SessionsFile, session: TuiSessionMeta) => ({
        ...file,
        sessions: file.sessions.map((entry) => entry.sessionId === session.sessionId ? session : entry),
      }),
    },
    historyStore: { readTranscript: async () => [] },
    client: { sendCommand: async () => { throw new Error("unstarted sessions must not describe runtime state"); } },
    getSessionsFile: () => sessionsFile,
    setSessionsFile: (next: SessionsFile) => { sessionsFile = next; },
    saveSessionsFile: async () => {},
    resolveWorkspaceForSession: async () => undefined,
    setActiveWorkspace: () => {},
    buildSessionOperatorState: () => ({ inbox: { items: [] } }),
    getChatWrappedBodyWidth: () => 80,
    getChatListRows: () => 20,
    getConversationActivity: (sessionId: string) =>
      sessionId === background.sessionId ? cachedActivity : [],
    getConversationRunState: (sessionId: string) =>
      sessionId === background.sessionId
        ? { running: true, status: "running" as const }
        : { running: false, status: "ready" as const },
    withMcpSummary: (status: string) => `${status} | mcp ready`,
    recoverTerminalMessages: async () => {},
    appendHistoryLine: async () => {},
    persistUiState: async () => {},
  } as unknown as SessionControllerContext;

  const controller = new SessionController(context);
  await controller.switchSession(background.name);

  assert.deepEqual(uiStore.getState().conversationActivity, cachedActivity);
  assert.equal(uiStore.getState().running, true);
  assert.equal(
    uiStore.getState().statusLine,
    "Agent progress: Inspecting the workspace | mcp ready",
  );

  await controller.switchSession(main.name);

  assert.deepEqual(uiStore.getState().conversationActivity, []);
  assert.equal(uiStore.getState().running, false);
  assert.equal(uiStore.getState().statusLine, "resumed 'main' | mcp ready");
});

test("SessionController fails closed when a started target cannot be described", async () => {
  const main = makeSession({ name: "main", sessionId: "s-main" });
  const target = makeSession({
    name: "target",
    sessionId: "s-target",
    environmentPresetId: "cli_dev_local",
    effectiveAssemblyId: "assembly-dev",
  });
  const sessionsFile: SessionsFile = {
    version: 5,
    activeSessionName: main.name,
    sessions: [main, target],
  };
  let changedActiveSession = false;
  const context = {
    uiStore: { getState: () => ({ activeSession: main }) },
    sessionStore: {
      resolveSelector: () => ({ status: "matched", session: target }),
      setActive: () => {
        changedActiveSession = true;
        return sessionsFile;
      },
    },
    getSessionsFile: () => sessionsFile,
    client: { sendCommand: async () => { throw new Error("runner unavailable"); } },
  } as unknown as SessionControllerContext;

  await assert.rejects(
    new SessionController(context).switchSession(target.name),
    (error: unknown) =>
      error instanceof TuiEnvironmentIdentityError
      && error.code === "TUI_ENVIRONMENT_UNKNOWN",
  );
  assert.equal(changedActiveSession, false);
});

for (const code of [
  "SESSION_ENVIRONMENT_IDENTITY_CONFLICT",
  "SESSION_ENVIRONMENT_IDENTITY_UNSUPPORTED",
] as const) {
  test(`SessionController preserves ${code} while aborting a started-session switch`, async () => {
    const main = makeSession({ name: "main", sessionId: "s-main" });
    const target = makeSession({
      name: "target",
      sessionId: "s-target",
      environmentPresetId: "cli_dev_local",
    });
    const sessionsFile: SessionsFile = {
      version: 5,
      activeSessionName: main.name,
      sessions: [main, target],
    };
    let changedActiveSession = false;
    const runtimeError = Object.assign(new Error(`runtime ${code}`), { code });
    const context = {
      uiStore: { getState: () => ({ activeSession: main }) },
      sessionStore: {
        resolveSelector: () => ({ status: "matched", session: target }),
        setActive: () => {
          changedActiveSession = true;
          return sessionsFile;
        },
      },
      getSessionsFile: () => sessionsFile,
      client: { sendCommand: async () => { throw runtimeError; } },
    } as unknown as SessionControllerContext;

    await assert.rejects(
      new SessionController(context).switchSession(target.name),
      (error: unknown) =>
        error instanceof TuiEnvironmentIdentityError
        && error.code === code,
    );
    assert.equal(changedActiveSession, false);
  });
}

for (const scenario of [
  { label: "missing", runtimeEnvironmentPresetId: undefined },
  { label: "unsupported", runtimeEnvironmentPresetId: "workspace_hosted" },
] as const) {
  test(`SessionController fails closed when a started target has ${scenario.label} runtime identity`, async () => {
    const main = makeSession({ name: "main", sessionId: "s-main" });
    const target = makeSession({
      name: "target",
      sessionId: "s-target",
      environmentPresetId: "cli_dev_local",
      effectiveAssemblyId: "assembly-dev",
    });
    const sessionsFile: SessionsFile = {
      version: 5,
      activeSessionName: main.name,
      sessions: [main, target],
    };
    let changedActiveSession = false;
    const context = {
      uiStore: { getState: () => ({ activeSession: main }) },
      sessionStore: {
        resolveSelector: () => ({ status: "matched", session: target }),
        setActive: () => {
          changedActiveSession = true;
          return sessionsFile;
        },
      },
      getSessionsFile: () => sessionsFile,
      client: {
        sendCommand: async () => ({
          type: "session.described",
          payload: {
            sessionId: target.sessionId,
            version: 1,
            activeAssembly: {
              mode: "explicit",
              ...(scenario.runtimeEnvironmentPresetId === undefined
                ? {}
                : { environmentPresetId: scenario.runtimeEnvironmentPresetId }),
            },
          },
        }),
      },
    } as unknown as SessionControllerContext;

    await assert.rejects(
      new SessionController(context).switchSession(target.name),
      (error: unknown) =>
        error instanceof TuiEnvironmentIdentityError
        && error.code === "TUI_ENVIRONMENT_UNKNOWN",
    );
    assert.equal(changedActiveSession, false);
  });
}

test("SessionController aborts a switch when runtime environment identity conflicts", async () => {
  const main = makeSession({ name: "main", sessionId: "s-main" });
  const target = makeSession({ name: "target", sessionId: "s-target" });
  const sessionsFile: SessionsFile = {
    version: 5,
    activeSessionName: main.name,
    sessions: [main, target],
  };
  let changedActiveSession = false;
  const context = {
    uiStore: {
      getState: () => ({ activeSession: main }),
    },
    sessionStore: {
      resolveSelector: () => ({ status: "matched", session: target }),
      setActive: () => {
        changedActiveSession = true;
        return sessionsFile;
      },
    },
    getSessionsFile: () => sessionsFile,
    client: {
      sendCommand: async () => ({
        type: "session.described",
        payload: {
          sessionId: target.sessionId,
          version: 1,
          activeAssembly: {
            mode: "explicit",
            environmentPresetId: "cli_safe_local",
          },
        },
      }),
    },
    syncSessionFromDescribePayload: async () => {
      throw new TuiEnvironmentIdentityError(
        "TUI_ENVIRONMENT_CONFLICT",
        "Environment consistency failure for session 'target'.",
      );
    },
  } as unknown as SessionControllerContext;

  await assert.rejects(
    new SessionController(context).switchSession(target.name),
    /Environment consistency failure/u,
  );
  assert.equal(changedActiveSession, false);
});
