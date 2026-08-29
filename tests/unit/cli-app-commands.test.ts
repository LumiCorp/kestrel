import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import React from "react";
import { renderToString } from "ink";

import { App, terminalMessageRecoveryThreadId } from "../../cli/app/App.js";
import {
  bootstrapTuiApp,
  deriveStartupPersistedUiState,
  resolveProfileForStartup,
  runSplashDatabasePreflight,
} from "../../cli/app/TuiBootstrap.js";
import { applyLocalCoreShellEnvironment, formatCliLocalCoreStatus } from "../../cli/localCoreShell.js";
import { parseLocalCorePlatform } from "../../src/localCore/platform.js";
import { createConfiguredCliProtocolClient } from "../../cli/client/configuredClient.js";
import { ProfileStore } from "../../cli/config/ProfileStore.js";
import { writeRuntimeSettings } from "../../cli/config/RuntimeSettings.js";
import { DiagnosticLogStore } from "../../cli/diagnostics/DiagnosticLogStore.js";
import { HistoryStore } from "../../cli/history/HistoryStore.js";
import { UiStateStore } from "../../cli/ink/persistence/UiStateStore.js";
import { buildInitialUiRuntimeState, UiStore } from "../../cli/ink/store/UiStore.js";
import { resolveChatLayoutBudget } from "../../cli/ink/views/chatLayout.js";
import { buildChatVisualRows, ensureChatCursorVisible } from "../../cli/ink/views/chatRows.js";
import { DelegationReviewView } from "../../cli/ink/views/DelegationReviewView.js";
import { SessionsView } from "../../cli/ink/views/SessionsView.js";
import { TasksView } from "../../cli/ink/views/TasksView.js";
import { SessionStore } from "../../cli/session/SessionStore.js";
import { TuiAuthoringProfileError } from "../../cli/session/TuiAuthoringProfile.js";
import {
  exactTuiQueueTailRunId,
  normalizeTuiQueueGraph,
} from "../../cli/session/TuiQueueGraph.js";
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import { initializeWorkspaceAtRoot } from "../../cli/workspace/WorkspaceResolver.js";
import type { PaletteCommand } from "../../cli/app/PaletteController.js";
import type { InkAppController } from "../../cli/ink/AppRoot.js";
import type { SessionsFile, TuiProfile, TuiSessionMeta } from "../../cli/contracts.js";
import type { SessionDescribedEventPayload } from "../../cli/protocol/contracts.js";
import type { OperatorDelegationWorkspaceSnapshot } from "../../src/operatorShell.js";
import type { LocalCoreStatus } from "../../src/localCore/contracts.js";
import { startLocalCoreApiServer } from "../../src/localCore/api.js";
import { resolveLocalCoreBuildIdentity } from "../../src/localCore/buildIdentity.js";


test("Local Core platform parsing accepts exact Node platform values", () => {
  assert.equal(parseLocalCorePlatform("linux"), "linux");
  assert.equal(parseLocalCorePlatform("darwin"), "darwin");
  assert.equal(parseLocalCorePlatform("LINUX"), undefined);
  assert.equal(parseLocalCorePlatform(""), undefined);
});

test("TUI recovery resolves the canonical main thread for a session", () => {
  assert.equal(terminalMessageRecoveryThreadId("session-1"), "thread-main:session-1");
});

test("startup preserves a started session's authoring profile over an explicit profile", async () => {
  const authoringProfile: TuiProfile = {
    id: "authoring-profile",
    label: "Authoring profile",
    agent: "kestrel",
    sessionPrefix: "authoring",
  };
  const explicitProfile: TuiProfile = {
    id: "explicit-profile",
    label: "Explicit profile",
    agent: "kestrel",
    sessionPrefix: "explicit",
  };
  const session: TuiSessionMeta = {
    name: "started-session",
    sessionId: "session-started",
    profileId: authoringProfile.id,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    started: true,
  };
  const profileStore = new ProfileStore(path.join(os.tmpdir(), "tui-authoring-profile-test"));

  const resolved = await resolveProfileForStartup({
    options: { cwd: process.cwd(), profileId: explicitProfile.id },
    profiles: [authoringProfile, explicitProfile],
    runtimeSettings: { version: 1, defaults: {} },
    profileStore,
    session,
    startupNotices: [],
  });

  assert.equal(resolved.id, authoringProfile.id);
});

test("startup preserves a runtime-bound session's authoring profile when started is stale", async () => {
  const authoringProfile: TuiProfile = {
    id: "runtime-bound-authoring-profile",
    label: "Runtime-bound authoring profile",
    agent: "kestrel",
    sessionPrefix: "runtime-bound",
  };
  const explicitProfile: TuiProfile = {
    id: "replacement-profile",
    label: "Replacement profile",
    agent: "kestrel",
    sessionPrefix: "replacement",
  };
  const session: TuiSessionMeta = {
    name: "runtime-bound-session",
    sessionId: "session-runtime-bound",
    profileId: authoringProfile.id,
    effectiveAssemblyId: "bundle:runtime-bound",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    started: false,
  };
  const profileStore = new ProfileStore(path.join(os.tmpdir(), "tui-runtime-bound-profile-test"));

  const resolved = await resolveProfileForStartup({
    options: { cwd: process.cwd(), profileId: explicitProfile.id },
    profiles: [authoringProfile, explicitProfile],
    runtimeSettings: { version: 1, defaults: {} },
    profileStore,
    session,
    startupNotices: [],
  });

  assert.equal(resolved.id, authoringProfile.id);
});

const preAcceptanceProfileScenarios: Array<{
  label: string;
  patch: Partial<TuiSessionMeta>;
}> = [
  {
    label: "pending ordinary-turn correlation",
    patch: {
      pendingRunId: "run-local-pending",
      pendingRunMessageId: "message-local-pending",
      pendingRunThreadId: "thread-main:session-preaccept",
    },
  },
  {
    label: "pending queued-turn correlation",
    patch: {
      pendingQueueSubmissions: [{
        runId: "run-local-queued",
        messageId: "message-local-queued",
        threadId: "thread-main:session-preaccept",
        indeterminate: true,
      }],
    },
  },
];

for (const scenario of preAcceptanceProfileScenarios) {
  test(`startup keeps ${scenario.label} mutable before runtime acceptance`, async () => {
    const authoringProfile: TuiProfile = {
      id: "preaccept-authoring-profile",
      label: "Pre-accept authoring profile",
      agent: "kestrel",
      sessionPrefix: "preaccept",
    };
    const explicitProfile: TuiProfile = {
      id: "preaccept-explicit-profile",
      label: "Pre-accept explicit profile",
      agent: "kestrel",
      sessionPrefix: "preaccept-explicit",
    };
    const session: TuiSessionMeta = {
      name: "preaccept-session",
      sessionId: "session-preaccept",
      profileId: authoringProfile.id,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      started: false,
      ...scenario.patch,
    };
    const profileStore = new ProfileStore(path.join(os.tmpdir(), "tui-preaccept-profile-test"));

    const resolved = await resolveProfileForStartup({
      options: { cwd: process.cwd(), profileId: explicitProfile.id },
      profiles: [authoringProfile, explicitProfile],
      runtimeSettings: { version: 1, defaults: {} },
      profileStore,
      session,
      startupNotices: [],
    });

    assert.equal(resolved.id, explicitProfile.id);
  });
}

test("startup fails closed when a started session's authoring profile is unavailable", async () => {
  const availableProfile: TuiProfile = {
    id: "available-profile",
    label: "Available profile",
    agent: "kestrel",
    sessionPrefix: "available",
  };
  const session: TuiSessionMeta = {
    name: "started-session",
    sessionId: "session-started",
    profileId: "missing-authoring-profile",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    started: true,
  };
  const profileStore = new ProfileStore(path.join(os.tmpdir(), "tui-missing-authoring-profile-test"));

  await assert.rejects(
    resolveProfileForStartup({
      options: { cwd: process.cwd(), profileId: availableProfile.id },
      profiles: [availableProfile],
      runtimeSettings: { version: 1, defaults: {} },
      profileStore,
      session,
      startupNotices: [],
    }),
    (error: unknown) =>
      error instanceof TuiAuthoringProfileError
      && error.sessionId === session.sessionId
      && error.profileId === session.profileId,
  );
});

test("describe projection cannot infer an environment for stale unstarted runtime evidence", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const sessionStore = appState.sessionStore as SessionStore;
  const staleSession: TuiSessionMeta = {
    ...uiStore.getState().activeSession,
    started: false,
    environmentPresetId: undefined,
    effectiveAssemblyId: "bundle:stale-start",
  };
  appState.sessionsFile = sessionStore.upsert(
    appState.sessionsFile as { sessions: TuiSessionMeta[] },
    staleSession,
  );
  uiStore.patch({
    activeSession: staleSession,
    sessions: (appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions,
  });

  await assert.rejects(
    (appState.syncSessionFromDescribePayload as (payload: {
      sessionId: string;
      version: number;
    }) => Promise<void>)({
      sessionId: staleSession.sessionId,
      version: 0,
    }),
    /runtime-bound session has no exact environment identity/u,
  );
  assert.equal(uiStore.getState().activeSession.environmentPresetId, undefined);
});

async function createAppHarness(input: {
  activeProfileId?: string;
  sessionName?: string;
  scripted?: boolean;
  freshSessionName?: string;
} = {}): Promise<{
  app: App;
  home: string;
  cwd: string;
  historyPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-cli-app-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const app = new App({
    cwd,
    kestrelHome: home,
    ...(input.sessionName !== undefined ? { sessionName: input.sessionName } : {}),
    ...(input.scripted === true ? { scripted: true } : {}),
    ...(input.freshSessionName !== undefined ? { freshSessionName: input.freshSessionName } : {}),
  });

  const profileStore = new ProfileStore(home);
  const profiles = await profileStore.load();
  const activeProfile =
    profiles.find((profile) => profile.id === input.activeProfileId) ?? profileStore.getDefault(profiles);
  const sessionStore = new SessionStore(home);
  const workspaceStore = new WorkspaceStore(home);
  const historyStore = new HistoryStore(home);
  const uiStateStore = new UiStateStore(home);
  let sessionsFile = await sessionStore.load();
  const now = new Date().toISOString();
  const activeSession: TuiSessionMeta = {
    name: "default",
    sessionId: "session-1",
    profileId: activeProfile.id,
    environmentPresetId: "cli_dev_local",
    effectiveAssemblyId: "bundle:kestrel:cli",
    createdAt: now,
    updatedAt: now,
    started: true,
  };
  sessionsFile = sessionStore.upsert(sessionsFile, activeSession);
  await sessionStore.save(sessionsFile);

  const uiStore = new UiStore(
    buildInitialUiRuntimeState({
      profile: activeProfile,
      activeSession,
      sessions: sessionsFile.sessions,
      transcript: [],
      persisted: await uiStateStore.load(),
    }),
  );

  const appState = app as unknown as Record<string, unknown>;
  appState.profileStore = profileStore;
  appState.sessionStore = sessionStore;
  appState.workspaceStore = workspaceStore;
  appState.historyStore = historyStore;
  appState.diagnosticsStore = new DiagnosticLogStore(home);
  appState.uiStateStore = uiStateStore;
  appState.sessionsFile = sessionsFile;
  appState.uiStore = uiStore;
  appState.activeWorkspace = undefined;
  appState.launchWorkspace = undefined;
  appState.localCoreStatus = {
    client: {
      resolveExecutionProfile: async (request: {
        client: "cli";
        profileId: string;
        environmentPresetId: "cli_safe_local" | "cli_dev_local";
      }) => {
        assert.deepEqual(request, {
          client: "cli",
          profileId: activeProfile.id,
          environmentPresetId: "cli_dev_local",
        });
        const fingerprint =
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        const profileId = `kestrel:cli_dev_local:${fingerprint}`;
        return {
          version: 1,
          profileId,
          fingerprint,
          policy: { id: "kestrel", version: 2 },
          environmentPreset: { id: "cli_dev_local", version: 1 },
          resolvedProfile: {
            ...activeProfile,
            id: profileId,
            agentProfileId: "kestrel",
            environmentShellKind: "cli",
            environmentPresetId: "cli_dev_local",
            environmentCapabilityPackIds: [
              "balanced",
              "filesystem",
              "dev_shell",
            ],
          },
        };
      },
    },
  };

  await ((appState.refreshActiveSessionOperatorState as (() => Promise<void>) | undefined)?.() ??
    Promise.resolve());

  return {
    app,
    home,
    cwd,
    historyPath: path.join(home, "history.jsonl"),
  };
}

async function waitFor(assertion: () => boolean, timeoutMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not met before timeout");
}

function installBackgroundSession(
  appState: Record<string, unknown>,
  patch: Partial<TuiSessionMeta> = {},
): TuiSessionMeta {
  const uiStore = appState.uiStore as UiStore;
  const parent = uiStore.getState().activeSession;
  const now = "2026-08-28T00:00:00.000Z";
  const sessionId = patch.sessionId ?? "child-exact-lifecycle";
  const child: TuiSessionMeta = {
    ...parent,
    name: patch.name ?? sessionId,
    sessionId,
    createdAt: now,
    updatedAt: now,
    started: false,
    effectiveAssemblyId: undefined,
    delegation: {
      taskId: `task-${sessionId}`,
      parentSessionId: parent.sessionId,
      childSessionId: sessionId,
      childSessionName: sessionId,
      title: "exact lifecycle child",
      status: "PENDING",
      profileId: parent.profileId,
      provider: "openrouter",
      model: "test-model",
      createdAt: now,
      updatedAt: now,
    },
    ...patch,
  };
  const sessionsFile = appState.sessionsFile as {
    version: 5;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: [...sessionsFile.sessions.filter((item) => item.sessionId !== sessionId), child],
  };
  uiStore.patch({
    sessions: [...uiStore.getState().sessions.filter((item) => item.sessionId !== sessionId), child],
  });
  return child;
}

function makeExactTuiSessionDescription() {
  return {
    type: "session.described" as const,
    payload: {
      sessionId: "session-1",
      version: 1,
      activeAssembly: {
        mode: "explicit" as const,
        bundleId: "bundle:kestrel:cli",
        environmentPresetId: "cli_dev_local" as const,
      },
    },
  };
}

function restoreProcessEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function buildManagedLocalCoreStatus(input: {
  state: "healthy" | "blocked";
  summary: string;
  databaseUrl?: string | undefined;
  lastError?: NonNullable<LocalCoreStatus["lastError"]> | undefined;
}): LocalCoreStatus {
  const coreHome = "/tmp/kestrel-core";
  const databaseSocketPath = `${coreHome}/core/postgres/socket`;
  const databaseStatus = input.state === "healthy"
    ? {
        mode: "managed" as const,
        state: "healthy" as const,
        summary: "Kestrel Local Core managed database ready.",
        managed: true,
        initialized: true,
        running: true,
        identityVerified: true,
        socketPath: databaseSocketPath,
        ...(input.databaseUrl !== undefined ? { databaseUrl: input.databaseUrl } : {}),
      }
    : {
        mode: "managed" as const,
        state: "blocked" as const,
        summary: input.summary,
        managed: true,
        initialized: false,
        running: false,
        identityVerified: false,
        dataPath: `${coreHome}/core/postgres/data`,
        socketPath: databaseSocketPath,
        metadataPath: `${coreHome}/core/postgres/metadata.json`,
        logPath: `${coreHome}/core/logs/postgres.log`,
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      };

  return {
    state: input.state,
    summary: input.summary,
    home: {
      productRootPath: coreHome,
      homePath: coreHome,
      stateEpoch: "0.6",
      source: "explicit_core_home",
      isolated: false,
      platform: "darwin",
    },
    lock: {
      state: "live",
      lockPath: `${coreHome}/core/lock.json`,
      lock: {
        version: 1,
        ownerPid: 1234,
        ownerExecutable: "/usr/local/bin/kestrel",
        coreVersion: "0.5.0-beta.0",
        schemaVersion: 1,
        startedAt: "2026-06-17T00:00:00.000Z",
        heartbeatAt: "2026-06-17T00:00:01.000Z",
        socketPath: `${coreHome}/core/api.sock`,
        databaseSocketPath,
      },
    },
    dbMode: "managed",
    database: databaseStatus,
    ...(input.databaseUrl !== undefined ? { databaseUrl: input.databaseUrl } : {}),
    databaseSocketPath,
    settingsReady: input.state === "healthy",
    workspaceRegistryReady: input.state === "healthy",
    diagnosticsPath: `${coreHome}/diagnostics`,
    logsPath: `${coreHome}/core/logs`,
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
  };
}

test("App appends surfaced timeout details to the diagnostics log", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.appendRunFailureDiagnostics as (error: unknown) => Promise<void>)({
    code: "IO_MODEL_TIMEOUT",
    message: "Model call timed out after 30000ms (attempt 2/2)",
    details: {
      runId: "run-timeout",
      phase: "ACT",
      stepAgent: "agent.loop",
      objective: "Investigate Tesla and xAI legal conflict",
      lastToolName: "internet.news",
    },
  });

  const diagnosticsPath = path.join(home, "logs", "tui-diagnostics.log");
  const rawDiagnostics = await readFile(diagnosticsPath, "utf8");
  assert.match(rawDiagnostics, /runtime\.timeout/u);
  assert.match(rawDiagnostics, /IO_MODEL_TIMEOUT/u);
  assert.match(rawDiagnostics, /agent\.loop/u);
  assert.match(rawDiagnostics, /internet\.news/u);
});

test("App serializes terminal identity deduplication across concurrent delivery paths", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const append = appState.appendHistoryLine as (
    role: "assistant",
    text: string,
    data: Record<string, unknown>,
    output: undefined,
    eventId: string,
  ) => Promise<void>;

  await Promise.all([
    append.call(app, "assistant", "Completed once.", { kind: "runtime.terminal.v1" }, undefined, "terminal:run-race"),
    append.call(app, "assistant", "Completed once.", { kind: "runtime.terminal.v1" }, undefined, "terminal:run-race"),
  ]);

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.transcript.filter((line) => line.eventId === "terminal:run-race").length, 1);
  const persisted = await new HistoryStore(home).readTranscript("session-1", 100);
  assert.equal(persisted.filter((line) => line.eventId === "terminal:run-race").length, 1);
});

test("bootstrapTuiApp expands ~/ KESTREL_HOME for default stores", async () => {
  const root = await mkdtemp(path.join("/tmp", "kbth-"));
  const cwd = path.join(root, "cwd");
  const fakeHome = path.join(root, "home");
  const relativeHome = `~/kestrel-bootstrap-home-${Date.now()}`;
  const expandedHome = path.join(fakeHome, relativeHome.slice(2));
  await mkdir(cwd, { recursive: true });
  await mkdir(fakeHome, { recursive: true });

  const previousHome = process.env.KESTREL_HOME;
  const previousUserHome = process.env.HOME;
  const previousDatabaseUrlSource = process.env.KESTREL_DATABASE_URL_SOURCE;
  process.env.HOME = fakeHome;
  process.env.KESTREL_HOME = relativeHome;
  try {
    const bootstrap = await bootstrapTuiApp({ cwd, scripted: true });
    const stateHome = path.join(expandedHome, "state", "0.6");
    assert.equal(bootstrap.home, stateHome);
    assert.equal(bootstrap.profileStore.getBaseDir(), stateHome);
    assert.equal(bootstrap.activeSession.environmentPresetId, "cli_dev_local");
    assert.equal(
      bootstrap.diagnosticsStore.getFilePath(),
      path.join(stateHome, "logs", "tui-diagnostics.log"),
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
    if (previousUserHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousUserHome;
    }
    if (previousDatabaseUrlSource === undefined) {
      delete process.env.KESTREL_DATABASE_URL_SOURCE;
    } else {
      process.env.KESTREL_DATABASE_URL_SOURCE = previousDatabaseUrlSource;
    }
    await rm(expandedHome, { recursive: true, force: true });
  }
});

test("bootstrapTuiApp defaults to shared Local Core home", async () => {
  const root = await mkdtemp(path.join("/tmp", "kbch-"));
  const cwd = path.join(root, "cwd");
  const coreHome = path.join(root, "Kestrel");
  await mkdir(cwd, { recursive: true });

  const previousCoreHome = process.env.KESTREL_CORE_HOME;
  const previousHome = process.env.KESTREL_HOME;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousDatabaseUrlSource = process.env.KESTREL_DATABASE_URL_SOURCE;
  process.env.KESTREL_CORE_HOME = coreHome;
  delete process.env.KESTREL_HOME;
  process.env.DATABASE_URL = "postgres://host-machine.example/kestrel";
  try {
    const bootstrap = await bootstrapTuiApp({ cwd, scripted: true });
    const stateHome = path.join(coreHome, "state", "0.6");
    assert.equal(bootstrap.home, stateHome);
    assert.equal(bootstrap.localCoreStatus.home.source, "explicit_core_home");
    assert.equal(bootstrap.profileStore.getBaseDir(), stateHome);
    assert.equal(process.env.KESTREL_HOME, stateHome);
    assert.equal(process.env.DATABASE_URL, undefined);
    assert.match(bootstrap.startupNotices.join("\n"), /Kestrel Local Core (healthy|blocked)/u);
  } finally {
    if (previousCoreHome === undefined) {
      delete process.env.KESTREL_CORE_HOME;
    } else {
      process.env.KESTREL_CORE_HOME = previousCoreHome;
    }
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousDatabaseUrlSource === undefined) {
      delete process.env.KESTREL_DATABASE_URL_SOURCE;
    } else {
      process.env.KESTREL_DATABASE_URL_SOURCE = previousDatabaseUrlSource;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrapTuiApp ignores legacy client persistence defaults", async () => {
  const root = await mkdtemp(path.join("/tmp", "kestrel-legacy-store-"));
  const cwd = path.join(root, "cwd");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  await writeRuntimeSettings(home, {
    version: 1,
    defaults: {
      profileId: "reference",
      storeDriver: "postgres",
      sqlitePath: "legacy-runtime.db",
    },
  });

  try {
    const bootstrap = await bootstrapTuiApp({ cwd, kestrelHome: home, scripted: true });
    assert.notEqual(bootstrap.activeProfile.storeDriver, "postgres");
    assert.match(
      bootstrap.startupNotices.join("\n"),
      /Legacy client database settings are ignored/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrapTuiApp carries a custom home's resolved Core transport into the App client", async () => {
  const root = await mkdtemp(path.join("/tmp", "kestrel-custom-home-core-"));
  const cwd = path.join(root, "cwd");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  const server = await startLocalCoreApiServer({
    env: { KESTREL_HOME: home },
    platform: "darwin",
    coreVersion: "0.7.0",
    buildIdentity: resolveLocalCoreBuildIdentity({
      runtimeRoot: process.cwd(),
      suiteVersion: "0.7.0",
    }),
    idleTimeoutMs: 0,
  });
  let initialServerClosed = false;
  let bootstrap: Awaited<ReturnType<typeof bootstrapTuiApp>> | undefined;
  let client: ReturnType<typeof createConfiguredCliProtocolClient> | undefined;
  const previousDirect = process.env.KESTREL_LOCAL_CORE_DIRECT;
  const previousSocket = process.env.KESTREL_LOCAL_CORE_API_SOCKET;
  const previousToken = process.env.KESTREL_LOCAL_CORE_API_TOKEN;
  process.env.KESTREL_LOCAL_CORE_DIRECT = "0";
  delete process.env.KESTREL_LOCAL_CORE_API_SOCKET;
  delete process.env.KESTREL_LOCAL_CORE_API_TOKEN;

  try {
    bootstrap = await bootstrapTuiApp({ cwd, kestrelHome: home, scripted: true });
    assert.equal(bootstrap.runnerTransportEnv.KESTREL_LOCAL_CORE_API_SOCKET, server.socketPath);
    assert.equal(bootstrap.runnerTransportEnv.KESTREL_LOCAL_CORE_API_TOKEN, server.token);
    assert.equal(bootstrap.localCoreConnectionManager.current()?.client, bootstrap.localCoreStatus.client);
    client = createConfiguredCliProtocolClient(bootstrap.runnerTransportEnv, {
      beforeSend: bootstrap.prepareRunnerSend,
    });
    const firstPong = await client.sendCommand("runner.ping", { nonce: "custom-home" });
    assert.equal(firstPong.type, "runner.pong");

    await server.close();
    initialServerClosed = true;

    const recoveredPong = await client.sendCommand("runner.ping", { nonce: "custom-home-recovered" });
    assert.equal(recoveredPong.type, "runner.pong");
    assert.equal(existsSync(server.socketPath), true);
  } finally {
    await client?.close();
    await bootstrap?.localCoreConnectionManager.current()?.client.shutdownForUninstall().catch(() => {});
    await waitFor(() => existsSync(server.socketPath) === false, 5000).catch(() => {});
    if (previousDirect === undefined) {
      delete process.env.KESTREL_LOCAL_CORE_DIRECT;
    } else {
      process.env.KESTREL_LOCAL_CORE_DIRECT = previousDirect;
    }
    if (previousSocket === undefined) {
      delete process.env.KESTREL_LOCAL_CORE_API_SOCKET;
    } else {
      process.env.KESTREL_LOCAL_CORE_API_SOCKET = previousSocket;
    }
    if (previousToken === undefined) {
      delete process.env.KESTREL_LOCAL_CORE_API_TOKEN;
    } else {
      process.env.KESTREL_LOCAL_CORE_API_TOKEN = previousToken;
    }
    if (initialServerClosed === false) {
      await server.close();
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("bootstrapTuiApp does not prepare Local Core before remote runner commands", async () => {
  const root = await mkdtemp(path.join("/tmp", "kestrel-remote-runner-core-"));
  const cwd = path.join(root, "cwd");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  const server = await startLocalCoreApiServer({
    env: { KESTREL_HOME: home },
    platform: "darwin",
    coreVersion: "0.7.0",
    idleTimeoutMs: 0,
  });
  const previousRunnerServiceUrl = process.env.KESTREL_RUNNER_SERVICE_URL;
  process.env.KESTREL_RUNNER_SERVICE_URL = "https://runner.example.test";

  try {
    const bootstrap = await bootstrapTuiApp({ cwd, kestrelHome: home, scripted: true });
    assert.equal(bootstrap.runnerTransportEnv.KESTREL_RUNNER_SERVICE_URL, "https://runner.example.test");
    assert.equal(bootstrap.prepareRunnerSend, undefined);
  } finally {
    restoreProcessEnv("KESTREL_RUNNER_SERVICE_URL", previousRunnerServiceUrl);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("applyLocalCoreShellEnvironment exports the Core database URL for runner storage", () => {
  const coreHome = "/tmp/kestrel-core";
  const coreDatabaseUrl = "postgres://kestrel:kestrel@localhost/kestrel?host=%2Ftmp%2Fkestrel-core%2Fcore%2Fpostgres%2Fsocket&port=5432";
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgres://host-machine.example/kestrel",
  };
  const status: LocalCoreStatus = {
    state: "healthy",
    summary: "Kestrel Local Core ready.",
    home: {
      productRootPath: coreHome,
      homePath: coreHome,
      stateEpoch: "0.6",
      source: "explicit_core_home",
      isolated: false,
      platform: "darwin",
    },
    lock: {
      state: "live",
      lockPath: `${coreHome}/core/lock.json`,
      lock: {
        version: 1,
        ownerPid: 1234,
        ownerExecutable: "/usr/local/bin/kestrel",
        coreVersion: "0.5.0-beta.0",
        schemaVersion: 1,
        startedAt: "2026-06-17T00:00:00.000Z",
        heartbeatAt: "2026-06-17T00:00:01.000Z",
        socketPath: `${coreHome}/core/api.sock`,
        databaseSocketPath: `${coreHome}/core/postgres/socket`,
      },
    },
    dbMode: "managed",
    database: {
      mode: "managed",
      state: "healthy",
      summary: "Kestrel Local Core managed database ready.",
      managed: true,
      initialized: true,
      running: true,
      identityVerified: true,
      socketPath: `${coreHome}/core/postgres/socket`,
      databaseUrl: coreDatabaseUrl,
    },
    databaseUrl: coreDatabaseUrl,
    databaseSocketPath: `${coreHome}/core/postgres/socket`,
    settingsReady: true,
    workspaceRegistryReady: true,
    diagnosticsPath: `${coreHome}/diagnostics`,
    logsPath: `${coreHome}/core/logs`,
  };

  applyLocalCoreShellEnvironment(status, env);

  assert.equal(env.KESTREL_CORE_HOME, coreHome);
  assert.equal(env.KESTREL_HOME, coreHome);
  assert.equal(env.DATABASE_URL, coreDatabaseUrl);
  assert.equal(env.KESTREL_DATABASE_URL_SOURCE, "local_core_managed");
});

test("applyLocalCoreShellEnvironment clears untrusted DATABASE_URL when managed Core is blocked", () => {
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgres://host-machine.example/kestrel",
  };
  const status = buildManagedLocalCoreStatus({
    state: "blocked",
    summary: "Kestrel Local Core managed database bundle root is not configured.",
    lastError: {
      code: "LOCAL_CORE_POSTGRES_BUNDLE_ROOT_REQUIRED",
      message: "Managed database mode requires bundled Postgres resources.",
    },
  });

  applyLocalCoreShellEnvironment(status, env);

  assert.equal(env.KESTREL_CORE_HOME, "/tmp/kestrel-core");
  assert.equal(env.KESTREL_HOME, "/tmp/kestrel-core");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.KESTREL_DATABASE_URL_SOURCE, undefined);
});

test("applyLocalCoreShellEnvironment clears stale source marker when managed Core has no URL", () => {
  const env: NodeJS.ProcessEnv = {
    KESTREL_DATABASE_URL_SOURCE: "local_core_managed",
  };
  const status = buildManagedLocalCoreStatus({
    state: "blocked",
    summary: "Kestrel Local Core managed database bundle root is not configured.",
    lastError: {
      code: "LOCAL_CORE_POSTGRES_BUNDLE_ROOT_REQUIRED",
      message: "Managed database mode requires bundled Postgres resources.",
    },
  });

  applyLocalCoreShellEnvironment(status, env);

  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.KESTREL_DATABASE_URL_SOURCE, undefined);
});

test("formatCliLocalCoreStatus reports isolated dev homes visibly", async () => {
  const root = await mkdtemp(path.join("/tmp", "kbih-"));
  const cwd = path.join(root, "cwd");
  const isolatedHome = path.join(root, "isolated");
  await mkdir(cwd, { recursive: true });

  const previousCoreHome = process.env.KESTREL_CORE_HOME;
  const previousHome = process.env.KESTREL_HOME;
  const previousDatabaseUrlSource = process.env.KESTREL_DATABASE_URL_SOURCE;
  delete process.env.KESTREL_CORE_HOME;
  process.env.KESTREL_HOME = isolatedHome;
  try {
    const bootstrap = await bootstrapTuiApp({ cwd, scripted: true });
    const rendered = formatCliLocalCoreStatus(bootstrap.localCoreStatus);
    assert.equal(bootstrap.home, path.join(isolatedHome, "state", "0.6"));
    assert.equal(bootstrap.localCoreStatus.home.source, "isolated_dev_home");
    assert.match(rendered, /Home source: isolated_dev_home \(isolated\/dev\)/u);
  } finally {
    if (previousCoreHome === undefined) {
      delete process.env.KESTREL_CORE_HOME;
    } else {
      process.env.KESTREL_CORE_HOME = previousCoreHome;
    }
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
    if (previousDatabaseUrlSource === undefined) {
      delete process.env.KESTREL_DATABASE_URL_SOURCE;
    } else {
      process.env.KESTREL_DATABASE_URL_SOURCE = previousDatabaseUrlSource;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("runSplashDatabasePreflight auto-starts the default local postgres target by default", async () => {
  const port = await reserveLocalPort();
  const server = createServer();
  const updates: Array<{ state?: string | undefined; detail?: string | undefined }> = [];
  let summary = "";

  try {
    await runSplashDatabasePreflight({
      setSummary(next) {
        summary = next;
      },
      updateCheck(_id, update) {
        updates.push(update);
      },
      truncateDetail(value) {
        return value;
      },
      env: {
        ...process.env,
        DATABASE_URL: `postgres://kestrel:kestrel@127.0.0.1:${port}/kestrel`,
        KESTREL_STORE_DRIVER: "postgres",
        KESTREL_DB_PORT: String(port),
        KCHAT_DB_SELF_HEAL: "",
      },
      requireDatabaseUrl: true,
      autoStart: async () => {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        return {
          ok: true,
          detail: "server started",
        };
      },
    });

    assert.equal(summary, "checking database");
    assert.deepEqual(updates[0], {
      state: "running",
      detail: "probing",
    });
    assert.deepEqual(updates.at(-1), {
      state: "ok",
      detail: `127.0.0.1:${port}/kestrel`,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runSplashDatabasePreflight reports blocked Local Core before missing DATABASE_URL", async () => {
  const updates: Array<{ state?: string | undefined; detail?: string | undefined }> = [];
  const status = buildManagedLocalCoreStatus({
    state: "blocked",
    summary: "Kestrel Local Core managed database bundle root is not configured.",
    lastError: {
      code: "LOCAL_CORE_POSTGRES_BUNDLE_ROOT_REQUIRED",
      message: "Managed database mode requires bundled Postgres resources.",
    },
  });

  await assert.rejects(
    runSplashDatabasePreflight({
      setSummary() {},
      updateCheck(_id, update) {
        updates.push(update);
      },
      truncateDetail(value) {
        return value;
      },
      env: {
        KESTREL_DATABASE_URL_SOURCE: "local_core_managed",
      },
      localCoreStatus: status,
      requireDatabaseUrl: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /LOCAL_CORE_POSTGRES_BUNDLE_ROOT_REQUIRED/u);
      assert.match(error.message, /KESTREL_LOCAL_CORE_POSTGRES_BUNDLE/u);
      assert.doesNotMatch(error.message, /missing DATABASE_URL/u);
      return true;
    },
  );

  assert.deepEqual(updates.at(-1), {
    state: "fail",
    detail:
      "Kestrel Local Core managed database bundle root is not configured. (LOCAL_CORE_POSTGRES_BUNDLE_ROOT_REQUIRED). Source checkout runs need KESTREL_LOCAL_CORE_POSTGRES_BUNDLE pointing at apps/desktop/resources/postgres-bundle; packaged installs should include postgres-bundle in installed resources.",
  });
});

test("runSplashDatabasePreflight trusts healthy managed Local Core instead of probing its socket URL as TCP", async () => {
  const updates: Array<{ state?: string | undefined; detail?: string | undefined }> = [];
  const databaseUrl = "postgres://kestrel:kestrel@localhost/kestrel?host=%2Ftmp%2Fkestrel-core%2Fcore%2Fpostgres%2Fsocket";
  const status = buildManagedLocalCoreStatus({
    state: "healthy",
    summary: "Kestrel Local Core ready.",
    databaseUrl,
  });

  await runSplashDatabasePreflight({
    setSummary() {},
    updateCheck(_id, update) {
      updates.push(update);
    },
    truncateDetail(value) {
      return value;
    },
    env: {
      DATABASE_URL: databaseUrl,
      KESTREL_DATABASE_URL_SOURCE: "local_core_managed",
    },
    localCoreStatus: status,
    requireDatabaseUrl: false,
    autoStart: async () => {
      throw new Error("should not probe or self-heal Local Core managed socket URLs");
    },
  });

  assert.deepEqual(updates.at(-1), {
    state: "ok",
    detail: "Local Core managed at /tmp/kestrel-core",
  });
});

test("runSplashDatabasePreflight still requires DATABASE_URL for explicit postgres store mode", async () => {
  await assert.rejects(
    runSplashDatabasePreflight({
      setSummary() {},
      updateCheck() {},
      truncateDetail(value) {
        return value;
      },
      env: {},
      requireDatabaseUrl: true,
    }),
    /missing DATABASE_URL/u,
  );
});

test("profiles use rebinds the active session and subsequent history to the canonical profile", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  await (appState.setActiveSessionState as (patch: Partial<TuiSessionMeta>) => Promise<void>)({
    started: false,
    effectiveAssemblyId: undefined,
    effectiveAssemblyLabel: undefined,
  });

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "profiles",
    args: ["use", "kestrel"],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeProfile.id, "kestrel");
  assert.equal(state.activeSession.profileId, "kestrel");
  assert.equal(state.sessions[0]?.profileId, "kestrel");

  const rendered = renderToString(
    React.createElement(SessionsView, {
      sessions: state.sessions,
      activeSessionName: state.activeSession.name,
      query: "",
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      listRows: 8,
      detailDrawerOpen: true,
    }),
  );
  assert.match(rendered, /Agent=kestrel/u);
  assert.match(rendered, /Environment=Developer workspace/u);

  const rawHistory = await readFile(historyPath, "utf8");
  const records = rawHistory
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { profileId: string; text: string });
  const lastRecord = records[records.length - 1];
  assert.equal(lastRecord?.profileId, "kestrel");
  assert.match(String(lastRecord?.text), /Agent profile set to 'kestrel'/u);
  assert.doesNotMatch(String(lastRecord?.text), /provider=|openai|anthropic/u);
});

test("environment command reports the product environment and opens its chooser", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "environment",
    args: [],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.paletteOpen, true);
  assert.equal(state.paletteContext, "environment");
  const actions = (appState.getPaletteController as () => {
    getActions(state?: ReturnType<UiStore["getState"]>): PaletteCommand[];
  })().getActions(state);
  assert.equal(actions.some((action) => action.command === "/environment safe"), true);
  assert.equal(actions.some((action) => action.command === "/environment developer"), false);
  const records = (await readFile(historyPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as { text: string });
  const text = records.at(-1)?.text ?? "";
  assert.match(text, /Agent: Kestrel/u);
  assert.match(text, /Environment: Developer workspace/u);
  assert.match(text, /Choosing another environment creates a new session/u);
  assert.doesNotMatch(text, /cli_dev_local|cli_safe_local/u);
});

test("guided palette inserts Environment after workspace and marks Developer as the workspace default", async () => {
  const { app, cwd } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const workspaceRoot = path.join(cwd, "guided-project");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await initializeWorkspaceAtRoot(
    workspaceRoot,
    appState.workspaceStore as WorkspaceStore,
    { label: "guided-project" },
  );
  appState.activeWorkspace = workspace;
  appState.launchWorkspace = workspace;

  await (appState.beginStartTaskJourney as () => Promise<void>)();
  const select = appState.handleStartTaskPaletteSelection as (selected: PaletteCommand) => Promise<boolean>;
  await select.call(app, { id: "start.template.none", label: "Template: None" });
  await select.call(app, { id: "start.preset.none", label: "Preset: None" });
  await select.call(app, { id: "start.workspace.active", label: "Workspace: Active" });

  const uiStore = appState.uiStore as UiStore;
  const state = uiStore.getState();
  assert.equal(state.paletteContext, "start-environment");
  const actions = (appState.getPaletteController as () => {
    getActions(state?: ReturnType<UiStore["getState"]>): PaletteCommand[];
  })().getActions(state);
  assert.equal(
    actions.some((action) => action.id === "start.environment.developer" && action.label.includes("(default)")),
    true,
  );
  assert.equal(actions.some((action) => action.id === "start.environment.safe"), true);
});

test("environment command changes an unstarted session in place", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const originalId = (appState.uiStore as UiStore).getState().activeSession.sessionId;
  await (appState.setActiveSessionState as (patch: Partial<TuiSessionMeta>) => Promise<void>)({
    started: false,
    effectiveAssemblyId: undefined,
    effectiveAssemblyLabel: undefined,
    operatorState: undefined,
  });
  await (appState.persistSessionAndUi as (options?: { requireSessionSave?: boolean }) => Promise<void>)({
    requireSessionSave: true,
  });

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "environment",
    args: ["safe"],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.sessionId, originalId);
  assert.equal(state.activeSession.environmentPresetId, "cli_safe_local");
  assert.equal(state.activeSession.started, false);
  assert.equal(state.activeSession.effectiveAssemblyId, undefined);
  const persisted = await new SessionStore(home).load();
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0]?.environmentPresetId, "cli_safe_local");
});

test("failed environment persistence leaves unstarted memory and disk authority unchanged", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sessionStore = appState.sessionStore as SessionStore;
  await (appState.setActiveSessionState as (patch: Partial<TuiSessionMeta>) => Promise<void>)({
    started: false,
    effectiveAssemblyId: undefined,
    effectiveAssemblyLabel: undefined,
  });
  await (appState.persistSessionAndUi as (options?: { requireSessionSave?: boolean }) => Promise<void>)({
    requireSessionSave: true,
  });
  sessionStore.save = async () => {
    throw new Error("injected environment save failure");
  };

  await assert.rejects(
    (appState.handleEnvironmentCommand as (args: string[]) => Promise<void>)(["safe"]),
    /Environment change was not persisted/u,
  );

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.environmentPresetId, "cli_dev_local");
  assert.equal(
    (appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions[0]?.environmentPresetId,
    "cli_dev_local",
  );
  const persisted = await new SessionStore(home).load();
  assert.equal(persisted.sessions[0]?.environmentPresetId, "cli_dev_local");
});

test("environment command creates a clean Developer workspace session from a started Safe session", async () => {
  const { app, cwd, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const workspaceRoot = path.join(cwd, "developer-project");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await initializeWorkspaceAtRoot(
    workspaceRoot,
    appState.workspaceStore as WorkspaceStore,
    { label: "developer-project" },
  );
  appState.activeWorkspace = workspace;
  appState.launchWorkspace = workspace;
  await (appState.setActiveSessionState as (patch: Partial<TuiSessionMeta>) => Promise<void>)({
    workspaceBinding: "active",
    workspaceId: workspace.manifest.workspaceId,
    workspaceRoot: workspace.rootPath,
    workspaceLabel: workspace.manifest.label,
    environmentPresetId: "cli_safe_local",
    environmentShellKind: "cli",
    effectiveAssemblyId: "bundle:kestrel:safe",
    effectiveAssemblyLabel: "legacy raw safe label",
    started: true,
  });
  await (appState.persistSessionAndUi as (options?: { requireSessionSave?: boolean }) => Promise<void>)({
    requireSessionSave: true,
  });
  const source = uiStore.getState().activeSession;
  const sourceProfile = uiStore.getState().activeProfile;
  const alternateProfile: TuiProfile = {
    ...sourceProfile,
    id: "alternate-agent",
    label: "Alternate agent",
    sessionPrefix: "alternate",
  };
  appState.profileStore = {
    load: async () => [sourceProfile, alternateProfile],
    findById: (profiles: TuiProfile[], profileId: string) =>
      profiles.find((profile) => profile.id === profileId),
  } as unknown as ProfileStore;
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "profiles",
    args: ["use", alternateProfile.id],
  });
  assert.equal(uiStore.getState().activeProfile.id, sourceProfile.id);
  assert.equal(uiStore.getState().activeSession.profileId, source.profileId);
  await (appState.appendHistoryLine as (role: "assistant", text: string) => Promise<void>)(
    "assistant",
    "source-only-history",
  );

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "environment",
    args: ["developer"],
  });

  const state = uiStore.getState();
  const created = state.activeSession;
  const preservedSource = state.sessions.find((session) => session.sessionId === source.sessionId);
  assert.notEqual(created.sessionId, source.sessionId);
  assert.equal(created.environmentPresetId, "cli_dev_local");
  assert.equal(created.workspaceId, workspace.manifest.workspaceId);
  assert.equal(created.workspaceRoot, workspace.rootPath);
  assert.equal(created.profileId, source.profileId);
  assert.notEqual(created.profileId, alternateProfile.id);
  assert.equal(created.started, false);
  assert.equal(created.effectiveAssemblyId, undefined);
  assert.equal(created.acceptedRunId, undefined);
  assert.equal(created.pendingWaitFor, undefined);
  assert.equal(state.transcript.some((line) => line.text.includes("source-only-history")), false);
  assert.equal(preservedSource?.environmentPresetId, "cli_safe_local");
  assert.equal(preservedSource?.effectiveAssemblyId, "bundle:kestrel:safe");
  const persisted = await new SessionStore(home).load();
  assert.equal(persisted.sessions.length, 2);
  assert.equal(
    persisted.sessions.find((session) => session.sessionId === source.sessionId)?.environmentPresetId,
    "cli_safe_local",
  );
});

test("failed started environment replacement publishes no new session or workspace state", async () => {
  const { app, cwd, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const workspaceRoot = path.join(cwd, "durable-project");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await initializeWorkspaceAtRoot(
    workspaceRoot,
    appState.workspaceStore as WorkspaceStore,
    { label: "durable-project" },
  );
  appState.activeWorkspace = workspace;
  appState.launchWorkspace = workspace;
  await (appState.setActiveSessionState as (patch: Partial<TuiSessionMeta>) => Promise<void>)({
    workspaceBinding: "active",
    workspaceId: workspace.manifest.workspaceId,
    workspaceRoot: workspace.rootPath,
    workspaceLabel: workspace.manifest.label,
    environmentPresetId: "cli_safe_local",
    effectiveAssemblyId: "bundle:kestrel:safe",
    started: true,
  });
  await (appState.persistSessionAndUi as (options?: { requireSessionSave?: boolean }) => Promise<void>)({
    requireSessionSave: true,
  });
  const source = uiStore.getState().activeSession;
  (appState.sessionStore as SessionStore).save = async () => {
    throw new Error("injected replacement save failure");
  };

  await assert.rejects(
    (appState.handleEnvironmentCommand as (args: string[]) => Promise<void>)(["developer"]),
    /injected replacement save failure/u,
  );

  const state = uiStore.getState();
  assert.equal(state.activeSession.sessionId, source.sessionId);
  assert.equal(state.activeSession.environmentPresetId, "cli_safe_local");
  assert.equal(state.sessions.length, 1);
  assert.equal((appState.activeWorkspace as { rootPath?: string } | undefined)?.rootPath, workspace.rootPath);
  assert.equal((appState.launchWorkspace as { rootPath?: string } | undefined)?.rootPath, workspace.rootPath);
  const persisted = await new SessionStore(home).load();
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0]?.sessionId, source.sessionId);
  assert.equal(persisted.sessions[0]?.environmentPresetId, "cli_safe_local");
});

test("started environment change fails closed when its bound workspace is unavailable", async () => {
  const { app, cwd, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const missingRoot = path.join(cwd, "moved-workspace");
  await (appState.setActiveSessionState as (patch: Partial<TuiSessionMeta>) => Promise<void>)({
    workspaceBinding: "active",
    workspaceId: "workspace-moved",
    workspaceRoot: missingRoot,
    workspaceLabel: "Moved workspace",
    environmentPresetId: "cli_dev_local",
    effectiveAssemblyId: "bundle:kestrel:developer",
    started: true,
  });
  await (appState.persistSessionAndUi as (options?: { requireSessionSave?: boolean }) => Promise<void>)({
    requireSessionSave: true,
  });

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "environment",
    args: ["safe"],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.activeSession.environmentPresetId, "cli_dev_local");
  assert.equal(state.activeSession.effectiveAssemblyId, "bundle:kestrel:developer");
  assert.match(
    await readFile(historyPath, "utf8"),
    /workspace could not be resolved.*No replacement session was created/u,
  );
});

test("profiles, status, and sessions present Agent and Environment separately", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.client = {
    sendCommand: async (type: string) => {
      if (type === "session.describe") {
        return makeExactTuiSessionDescription();
      }
      if (type === "mcp.status") {
        return {
          type: "mcp.status",
          payload: {
            status: {
              healthy: true,
              checkedAt: "2026-08-29T00:00:00.000Z",
              servers: [],
              tools: [],
            },
          },
        };
      }
      throw new Error(`Unexpected command '${type}'.`);
    },
  };

  for (const [command, args] of [
    ["profiles", ["list"]],
    ["sessions", []],
    ["status", []],
  ] as const) {
    await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
      kind: "command",
      command,
      args,
    });
  }

  const records = (await readFile(historyPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as { text: string });
  const profilesText = records.find((record) => record.text.startsWith("Profiles:"))?.text ?? "";
  const sessionsText = records.find((record) => record.text.startsWith("Sessions:"))?.text ?? "";
  const statusText = records.find((record) => record.text.includes("Agent=Kestrel Environment="))?.text ?? "";
  assert.doesNotMatch(profilesText, /preset=/u);
  assert.match(sessionsText, /agent:Kestrel/u);
  assert.match(sessionsText, /environment:Developer workspace/u);
  assert.match(statusText, /Agent=Kestrel Environment=Developer workspace/u);
  assert.doesNotMatch(`${sessionsText}\n${statusText}`, /cli_dev_local|cli_safe_local/u);
});

async function reserveLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Unable to reserve port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test("model commands update shared model policy and refresh the active profile authority", async () => {
  const { app, home, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "model",
    args: ["set-provider", "openai"],
  });
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "model",
    args: ["set", "gpt-5.4-2026-03-05"],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeProfile.modelProvider, "openai");
  assert.equal(state.activeProfile.model, "gpt-5.4-2026-03-05");

  const policy = JSON.parse(await readFile(path.join(home, "model-policy.json"), "utf8")) as {
    provider: string;
    model: string;
  };
  assert.equal(policy.provider, "openai");
  assert.equal(policy.model, "gpt-5.4-2026-03-05");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Choose a model to finish the switch\./u);
  assert.match(rawHistory, /Model provider set to 'openai'/u);
  assert.doesNotMatch(rawHistory, /Model set to 'gpt-5.4-2026-03-05'/u);
});

test("model command falls back to local policy when cached Local Core client has a missing socket", async () => {
  const { app, home, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const missingSocketPath = path.join(home, "core", "api.sock");
  const previousCoreHome = process.env.KESTREL_CORE_HOME;
  const previousSocket = process.env.KESTREL_LOCAL_CORE_API_SOCKET;
  const previousToken = process.env.KESTREL_LOCAL_CORE_API_TOKEN;
  appState.localCoreStatus = {
    client: {
      getJson() {
        throw Object.assign(new Error(`connect ENOENT ${missingSocketPath}`), { code: "ENOENT" });
      },
      patchJson() {
        throw Object.assign(new Error(`connect ENOENT ${missingSocketPath}`), { code: "ENOENT" });
      },
    },
  };

  try {
    process.env.KESTREL_CORE_HOME = home;
    process.env.KESTREL_LOCAL_CORE_API_SOCKET = missingSocketPath;
    process.env.KESTREL_LOCAL_CORE_API_TOKEN = "token";

    await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
      kind: "command",
      command: "model",
      args: ["set-provider", "openai", "gpt-5.4-2026-03-05"],
    });

    const policy = JSON.parse(await readFile(path.join(home, "model-policy.json"), "utf8")) as {
      provider: string;
      model: string;
    };
    assert.equal(policy.provider, "openai");
    assert.equal(policy.model, "gpt-5.4-2026-03-05");

    const rawHistory = await readFile(historyPath, "utf8");
    assert.match(rawHistory, /Model provider set to 'openai' with model 'gpt-5\.4-2026-03-05'/u);
    assert.doesNotMatch(rawHistory, /connect ENOENT/u);
  } finally {
    restoreProcessEnv("KESTREL_CORE_HOME", previousCoreHome);
    restoreProcessEnv("KESTREL_LOCAL_CORE_API_SOCKET", previousSocket);
    restoreProcessEnv("KESTREL_LOCAL_CORE_API_TOKEN", previousToken);
  }
});

test("model command lists current provider options", async () => {
  const { app, home, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "model",
    args: [],
  });

  const policy = JSON.parse(await readFile(path.join(home, "model-policy.json"), "utf8")) as {
    provider: string;
    model: string;
  };
  assert.equal(policy.provider, "openrouter");
  assert.equal(policy.model, "openai/gpt-5.6-luna");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Recommended models for 'openrouter':/u);
  assert.match(rawHistory, /\* openai\/gpt-5\.6-luna/u);
  assert.match(rawHistory, /Use \/model search <query> to browse/u);
});

test("model command prefers the live OpenRouter catalog when available", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "https://openrouter.ai/api/v1/models");
    return new Response(
      JSON.stringify({
        data: [
          { id: "z-ai/glm-5.2" },
          { id: "google/gemini-2.5-flash" },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
      kind: "command",
      command: "model",
      args: [],
    });

    const rawHistory = await readFile(historyPath, "utf8");
    assert.match(rawHistory, /modelCatalog=live/u);
    assert.match(rawHistory, /Recommended models for 'openrouter':/u);
    assert.match(rawHistory, /additionalAvailableModels=1/u);
    assert.doesNotMatch(rawHistory, /- google\/gemini-2\.5-flash/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  }
});

test("model set-provider requires a follow-up model selection before mutating policy", async () => {
  const { app, home, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "http://127.0.0.1:11434/api/tags");
    return new Response(
      JSON.stringify({
        models: [
          { model: "llama3.2:3b" },
          { model: "qwen2.5-coder" },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
      kind: "command",
      command: "model",
      args: ["set-provider", "ollama"],
    });

    let policy = JSON.parse(await readFile(path.join(home, "model-policy.json"), "utf8")) as {
      provider: string;
      model: string;
    };
    assert.equal(policy.provider, "openrouter");
    assert.equal(policy.model, "openai/gpt-5.6-luna");

    let rawHistory = await readFile(historyPath, "utf8");
    assert.match(rawHistory, /Provider 'ollama' selected\. Choose a model to finish the switch\./u);
    assert.match(rawHistory, /Recommended models for 'ollama':/u);
    assert.match(rawHistory, /Use \/model search <query> to browse/u);

    await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
      kind: "command",
      command: "model",
      args: ["set", "llama3.2:3b"],
    });

    const state = (appState.uiStore as UiStore).getState();
    assert.equal(state.activeProfile.modelProvider, "ollama");
    assert.equal(state.activeProfile.model, "llama3.2:3b");

    policy = JSON.parse(await readFile(path.join(home, "model-policy.json"), "utf8")) as {
      provider: string;
      model: string;
    };
    assert.equal(policy.provider, "ollama");
    assert.equal(policy.model, "llama3.2:3b");

    rawHistory = await readFile(historyPath, "utf8");
    assert.match(rawHistory, /Model provider set to 'ollama'/u);

    const rawUiState = await readFile(path.join(home, "ui-state.json"), "utf8");
    const persisted = JSON.parse(rawUiState) as {
      state: {
        recentModelsByProvider?: Record<string, string[]>;
      };
    };
    assert.deepEqual(persisted.state.recentModelsByProvider?.ollama, ["llama3.2:3b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model set-provider uses the live Ollama catalog when available", async () => {
  const { app, home, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "http://127.0.0.1:11434/api/tags");
    return new Response(
      JSON.stringify({
        models: [
          { model: "qwen2.5-coder" },
          { model: "llama3.2:3b" },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
      kind: "command",
      command: "model",
      args: ["set-provider", "ollama"],
    });
    await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
      kind: "command",
      command: "model",
      args: ["set", "qwen2.5-coder"],
    });

    const policy = JSON.parse(await readFile(path.join(home, "model-policy.json"), "utf8")) as {
      provider: string;
      model: string;
    };
    assert.equal(policy.provider, "ollama");
    assert.equal(policy.model, "qwen2.5-coder");

    const rawHistory = await readFile(historyPath, "utf8");
    assert.match(rawHistory, /modelCatalog=live/u);
    assert.match(rawHistory, /Recommended models for 'ollama':/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model search uses the pending provider during provider selection", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        models: [
          { model: "llama3.2:3b" },
          { model: "qwen2.5-coder" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
      kind: "command",
      command: "model",
      args: ["set-provider", "ollama"],
    });
    await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
      kind: "command",
      command: "model",
      args: ["search", "qwen"],
    });

    const rawHistory = await readFile(historyPath, "utf8");
    assert.match(rawHistory, /pendingProvider=ollama/u);
    assert.match(rawHistory, /Model search results for 'qwen' \(ollama\):/u);
    assert.match(rawHistory, /- qwen2\.5-coder/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model set rejects values outside the current provider allowlist", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "model",
    args: ["set", "gpt-5.4-2026-03-05"],
  });

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Model 'gpt-5\.4-2026-03-05' is not allowed for provider 'openrouter'\./u);
  assert.match(rawHistory, /Recommended models for 'openrouter':/u);
});

test("theme command switches persisted theme mode", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "theme",
    args: ["dark"],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.themeMode, "dark");
  assert.equal(state.resolvedThemeMode, "dark");
  assert.equal(state.themePreset, "midnight-flight");

  const rawUiState = await readFile(path.join(home, "ui-state.json"), "utf8");
  const persisted = JSON.parse(rawUiState) as {
    version: number;
    state: {
      version?: number;
      themeMode?: string;
      themePreset?: string;
    };
  };
  assert.equal(persisted.version, 5);
  assert.equal(persisted.state.version, 5);
  assert.equal(persisted.state.themeMode, "dark");
  assert.equal(persisted.state.themePreset, undefined);
});

test("start task journey creates a session with the canonical profile, mode, and launch summary", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "start",
    args: [],
  });
  await (appState.handleLine as (line: string) => Promise<void>)("investigation-task");
  await (appState.handleLine as (line: string) => Promise<void>)("investigation");
  await (appState.handleLine as (line: string) => Promise<void>)("detached");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("Investigate queue latency");
  await (appState.handleLine as (line: string) => Promise<void>)("kestrel");
  await (appState.handleLine as (line: string) => Promise<void>)("build");
  await (appState.handleLine as (line: string) => Promise<void>)("skip");

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.name, "Investigate queue latency");
  assert.equal(state.activeSession.profileId, "kestrel");
  assert.equal(state.activeSession.launchPresetId, "investigation");
  assert.equal(state.activeSession.launchTemplateId, "investigation-task");
  assert.equal(state.activeSession.workspaceBinding, "detached");
  assert.equal(state.activeSession.environmentPresetId, "cli_safe_local");
  assert.equal(state.activeSession.interactionMode, "build");
  assert.equal(state.activeSession.actSubmode, "safe");
  assert.equal(state.activeProfile.id, "kestrel");
  assert.equal(state.activeSession.started, false);

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Start task journey/u);
  assert.match(rawHistory, /Started new session 'Investigate queue latency'\./u);
  assert.match(rawHistory, /Task=Investigate queue latency/u);
});

test("guided detached creation clears a previously active workspace cache", async () => {
  const { app, cwd } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const workspaceRoot = path.join(cwd, "previous-workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const previousWorkspace = await initializeWorkspaceAtRoot(
    workspaceRoot,
    appState.workspaceStore as WorkspaceStore,
    { label: "previous-workspace" },
  );
  appState.activeWorkspace = previousWorkspace;
  appState.launchWorkspace = previousWorkspace;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "start",
    args: [],
  });
  for (const input of [
    "none",
    "none",
    "detached",
    "default",
    "Detached investigation",
    "current",
    "default",
    "skip",
  ]) {
    await (appState.handleLine as (line: string) => Promise<void>)(input);
  }

  const uiStore = appState.uiStore as UiStore;
  assert.equal(uiStore.getState().activeSession.workspaceBinding, "detached");
  assert.equal(appState.activeWorkspace, undefined);
  assert.equal(appState.launchWorkspace, undefined);
  await (appState.handleEnvironmentCommand as (args: string[]) => Promise<void>)([]);
  const actions = (appState.getPaletteController as () => {
    getActions(state?: ReturnType<UiStore["getState"]>): PaletteCommand[];
  })().getActions(uiStore.getState());
  assert.equal(actions.some((action) => action.command === "/environment developer"), false);
});

test("guided workspace creation replaces the active workspace cache with the selected workspace", async () => {
  const { app, cwd } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const workspaceStore = appState.workspaceStore as WorkspaceStore;
  const firstRoot = path.join(cwd, "workspace-a");
  const secondRoot = path.join(cwd, "workspace-b");
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  const firstWorkspace = await initializeWorkspaceAtRoot(firstRoot, workspaceStore, { label: "workspace-a" });
  const secondWorkspace = await initializeWorkspaceAtRoot(secondRoot, workspaceStore, { label: "workspace-b" });
  appState.activeWorkspace = firstWorkspace;
  appState.launchWorkspace = firstWorkspace;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "start",
    args: [],
  });
  for (const input of [
    "none",
    "none",
    secondWorkspace.manifest.workspaceId,
    "default",
    "Workspace B task",
    "current",
    "default",
    "skip",
  ]) {
    await (appState.handleLine as (line: string) => Promise<void>)(input);
  }

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.workspaceRoot, secondWorkspace.rootPath);
  assert.equal((appState.activeWorkspace as { rootPath?: string } | undefined)?.rootPath, secondWorkspace.rootPath);
  assert.equal((appState.launchWorkspace as { rootPath?: string } | undefined)?.rootPath, secondWorkspace.rootPath);
});

test("failed guided creation leaves the prior session and workspace caches authoritative", async () => {
  const { app, cwd, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const workspaceRoot = path.join(cwd, "authoritative-workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await initializeWorkspaceAtRoot(
    workspaceRoot,
    appState.workspaceStore as WorkspaceStore,
    { label: "authoritative-workspace" },
  );
  appState.activeWorkspace = workspace;
  appState.launchWorkspace = workspace;
  await (appState.setActiveSessionState as (patch: Partial<TuiSessionMeta>) => Promise<void>)({
    workspaceBinding: "active",
    workspaceId: workspace.manifest.workspaceId,
    workspaceRoot: workspace.rootPath,
    workspaceLabel: workspace.manifest.label,
  });
  await (appState.persistSessionAndUi as (options?: { requireSessionSave?: boolean }) => Promise<void>)({
    requireSessionSave: true,
  });
  const source = uiStore.getState().activeSession;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "start",
    args: [],
  });
  for (const input of [
    "none",
    "none",
    "detached",
    "default",
    "Unpersisted task",
    "current",
    "default",
  ]) {
    await (appState.handleLine as (line: string) => Promise<void>)(input);
  }
  (appState.sessionStore as SessionStore).save = async () => {
    throw new Error("injected guided save failure");
  };

  await assert.rejects(
    (appState.handleLine as (line: string) => Promise<void>)("skip"),
    /injected guided save failure/u,
  );

  const state = uiStore.getState();
  assert.equal(state.activeSession.sessionId, source.sessionId);
  assert.equal(state.sessions.length, 1);
  assert.equal((appState.activeWorkspace as { rootPath?: string } | undefined)?.rootPath, workspace.rootPath);
  assert.equal((appState.launchWorkspace as { rootPath?: string } | undefined)?.rootPath, workspace.rootPath);
  const persisted = await new SessionStore(home).load();
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0]?.sessionId, source.sessionId);
});

test("background launch stays pending until run.started proves acceptance", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.client = {
    sendCommand: async () => await new Promise(() => {}),
  };

  await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
    "launch",
    "kestrel",
    "inspect dependencies",
  ]);

  let child = (appState.uiStore as UiStore).getState().sessions.find(
    (session) => session.delegation?.parentSessionId === "session-1",
  );
  assert.equal(child?.delegation?.status, "PENDING");
  assert.equal(child?.started, false);
  assert.equal(child?.environmentPresetId, "cli_dev_local");
  assert.equal(existsSync(historyPath), false);
  const pendingRunId = child?.pendingRunId;
  assert.equal(typeof pendingRunId, "string");
  assert.equal(child?.pendingRunMessageId, undefined);

  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "run-started-background",
    type: "run.started",
    ts: "2026-08-28T00:00:00.000Z",
    commandId: "command-background",
    sessionId: child?.sessionId,
    threadId: child?.sessionId,
    runId: pendingRunId,
    payload: {
      sessionId: child?.sessionId,
      runId: pendingRunId,
      eventType: "user.message",
    },
  });
  await waitFor(() => {
    child = (appState.uiStore as UiStore).getState().sessions.find(
      (session) => session.delegation?.parentSessionId === "session-1",
    );
    return child?.delegation?.status === "RUNNING";
  });

  assert.equal(child?.started, true);
  await waitFor(() => existsSync(historyPath));
  assert.match(await readFile(historyPath, "utf8"), /Background task started/u);
});

test("delegated queued acceptance publishes only after its required session commit", async (t) => {
  for (const failureMode of ["before-write", "after-write"] as const) {
    await t.test(failureMode, async () => {
      const { app, home } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      appState.client = { sendCommand: async () => await new Promise(() => {}) };
      await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
        "launch", "kestrel", "inspect delegated queue",
      ]);
      const uiStore = appState.uiStore as UiStore;
      const child = uiStore.getState().sessions.find(
        (session) => session.delegation?.parentSessionId === "session-1",
      );
      assert.ok(child?.delegation !== undefined);
      const queued: TuiSessionMeta = {
        ...child,
        started: true,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: child.sessionId,
        pendingRunId: undefined,
        queuedRunReservations: [{
          runId: "run-q1",
          messageId: "message-q1",
          threadId: child.sessionId,
          predecessorRunId: "run-r0",
        }],
      };
      const sessionStore = appState.sessionStore as SessionStore;
      const originalSave = sessionStore.save.bind(sessionStore);
      const currentFile = appState.sessionsFile as SessionsFile;
      appState.sessionsFile = sessionStore.upsert(currentFile, queued);
      uiStore.patch({ sessions: (appState.sessionsFile as typeof currentFile).sessions });
      await originalSave(appState.sessionsFile as never);
      sessionStore.save = async (snapshot) => {
        if (failureMode === "after-write") await originalSave(snapshot);
        throw new Error(`delegated queue ${failureMode}`);
      };

      await (appState.syncBackgroundSessionProgress as (input: {
        sessionId: string;
        threadId: string;
        runId: string;
        messageId: string;
      }) => Promise<void>)({
        sessionId: queued.sessionId,
        threadId: queued.sessionId,
        runId: "run-q1",
        messageId: "message-q1",
      });

      const visible = uiStore.getState().sessions.find(
        (session) => session.sessionId === queued.sessionId,
      );
      assert.equal(visible?.acceptedRunId, "run-r0");
      assert.equal(visible?.delegation?.status, "PENDING");
      const reloaded = new SessionStore(home).findByName(
        await new SessionStore(home).load(),
        queued.name,
      );
      assert.equal(reloaded?.acceptedRunId, failureMode === "after-write" ? "run-q1" : "run-r0");
    });
  }
});

test("delegated queued terminals require an exact turn and durable commit", async (t) => {
  for (const terminalKind of ["completed", "failed", "cancelled"] as const) {
    await t.test(terminalKind, async () => {
      const { app } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      appState.client = { sendCommand: async () => await new Promise(() => {}) };
      await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
        "launch", "kestrel", `inspect ${terminalKind}`,
      ]);
      const uiStore = appState.uiStore as UiStore;
      const child = uiStore.getState().sessions.find(
        (session) => session.delegation?.parentSessionId === "session-1",
      );
      assert.ok(child?.delegation !== undefined);
      const queued: TuiSessionMeta = {
        ...child,
        started: true,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: child.sessionId,
        pendingRunId: undefined,
        delegation: { ...child.delegation, status: "RUNNING" },
        queuedRunReservations: [{
          runId: "run-q1",
          messageId: "message-q1",
          threadId: child.sessionId,
          predecessorRunId: "run-r0",
        }],
      };
      const sessionStore = appState.sessionStore as SessionStore;
      const originalSave = sessionStore.save.bind(sessionStore);
      appState.sessionsFile = sessionStore.upsert(appState.sessionsFile as never, queued);
      uiStore.patch({ sessions: (appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions });
      await originalSave(appState.sessionsFile as never);
      const status = terminalKind === "completed" ? "COMPLETED" as const : "FAILED" as const;
      const result = {
        assistantText: terminalKind === "completed" ? "done" : null,
        output: {
          status,
          sessionId: queued.sessionId,
          runId: "run-q1",
          quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
          errors: status === "FAILED" ? [{ code: "RUN_FAILED", message: terminalKind }] : [],
          telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
        },
      };
      const sync = (authoritativeView?: Record<string, unknown>) =>
        (appState.syncForegroundQueuedTerminal as (
          input: Record<string, unknown>,
        ) => Promise<boolean>)({
          sessionId: queued.sessionId,
          threadId: queued.sessionId,
          runId: "run-q1",
          result,
          authoritativeView,
        });
      assert.equal(await sync(), false);
      assert.equal(await sync({
        thread: {
          threadId: queued.sessionId,
          sessionId: queued.sessionId,
          title: "RUNNING only",
          status: "RUNNING",
          createdAt: queued.createdAt,
          updatedAt: queued.updatedAt,
        },
        childThreads: [],
        childBlockerChain: [],
        activeRun: { runId: "run-q1", status: "RUNNING" },
      }), false);
      const exactView = {
        thread: {
          threadId: queued.sessionId,
          sessionId: queued.sessionId,
          title: "Exact delegated terminal",
          status,
          lastRunStatus: status,
          createdAt: queued.createdAt,
          updatedAt: queued.updatedAt,
        },
        childThreads: [],
        childBlockerChain: [],
        conversationTurns: [{
          turnId: "turn-q1",
          threadId: queued.sessionId,
          sessionId: queued.sessionId,
          sequence: 1,
          status,
          rootRunId: "run-q1",
          sourceMessageId: "message-q1",
          terminalRunId: "run-q1",
          terminalStatus: status,
          startedAt: queued.createdAt,
          completedAt: queued.updatedAt,
          updatedAt: queued.updatedAt,
        }],
      };
      sessionStore.save = async () => { throw new Error("delegated terminal save failed"); };
      assert.equal(await sync(exactView), false);
      assert.equal(
        uiStore.getState().sessions.find((session) => session.sessionId === queued.sessionId)?.acceptedRunId,
        "run-r0",
      );
      sessionStore.save = originalSave;
      assert.equal(await sync(exactView), true);
      const accepted = uiStore.getState().sessions.find(
        (session) => session.sessionId === queued.sessionId,
      );
      assert.equal(accepted?.acceptedRunId, "run-q1");
      assert.equal(accepted?.delegation?.status, status === "COMPLETED" ? "COMPLETED" : "FAILED");
    });
  }
});

test("concurrent delegated queued start and terminal serialize from the committed child", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.client = { sendCommand: async () => await new Promise(() => {}) };
  await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
    "launch", "kestrel", "serialize child lifecycle",
  ]);
  const uiStore = appState.uiStore as UiStore;
  const child = uiStore.getState().sessions.find(
    (session) => session.delegation?.parentSessionId === "session-1",
  );
  assert.ok(child?.delegation !== undefined);
  const queued: TuiSessionMeta = {
    ...child,
    started: true,
    acceptedRunId: "run-r0",
    acceptedRunMessageId: "message-r0",
    acceptedRunThreadId: child.sessionId,
    pendingRunId: undefined,
    queuedRunReservations: [{
      runId: "run-q1",
      messageId: "message-q1",
      threadId: child.sessionId,
      predecessorRunId: "run-r0",
    }],
  };
  const sessionStore = appState.sessionStore as SessionStore;
  const originalSave = sessionStore.save.bind(sessionStore);
  appState.sessionsFile = sessionStore.upsert(appState.sessionsFile as never, queued);
  uiStore.patch({ sessions: (appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions });
  await originalSave(appState.sessionsFile as never);
  let releaseFirstSave: (() => void) | undefined;
  let firstSaveStartedResolve: (() => void) | undefined;
  const firstSaveStarted = new Promise<void>((resolve) => { firstSaveStartedResolve = resolve; });
  const firstSaveRelease = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
  let saveCount = 0;
  sessionStore.save = async (file) => {
    saveCount += 1;
    if (saveCount === 1) {
      firstSaveStartedResolve?.();
      await firstSaveRelease;
    }
    await originalSave(file);
  };
  const start = (appState.syncBackgroundSessionProgress as (input: {
    sessionId: string;
    threadId: string;
    runId: string;
    messageId: string;
  }) => Promise<void>)({
    sessionId: queued.sessionId,
    threadId: queued.sessionId,
    runId: "run-q1",
    messageId: "message-q1",
  });
  await firstSaveStarted;
  const terminal = (appState.syncForegroundQueuedTerminal as (
    input: Record<string, unknown>,
  ) => Promise<boolean>)({
    sessionId: queued.sessionId,
    threadId: queued.sessionId,
    runId: "run-q1",
    result: {
      assistantText: "serialized terminal",
      output: {
        status: "COMPLETED",
        sessionId: queued.sessionId,
        runId: "run-q1",
        quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
        errors: [],
        telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
      },
    },
    authoritativeView: {
      thread: {
        threadId: queued.sessionId,
        sessionId: queued.sessionId,
        title: "serialized terminal",
        status: "COMPLETED",
        lastRunStatus: "COMPLETED",
        createdAt: queued.createdAt,
        updatedAt: queued.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      conversationTurns: [{
        turnId: "turn-q1",
        threadId: queued.sessionId,
        sessionId: queued.sessionId,
        sequence: 1,
        status: "COMPLETED",
        rootRunId: "run-q1",
        sourceMessageId: "message-q1",
        terminalRunId: "run-q1",
        terminalStatus: "COMPLETED",
        startedAt: queued.createdAt,
        completedAt: queued.updatedAt,
        updatedAt: queued.updatedAt,
      }],
    },
  });
  releaseFirstSave?.();
  await start;
  assert.equal(await terminal, true);
  const accepted = uiStore.getState().sessions.find(
    (session) => session.sessionId === queued.sessionId,
  );
  assert.equal(accepted?.acceptedRunId, "run-q1");
  assert.equal(accepted?.lastRunStatus, "COMPLETED");
  assert.equal(accepted?.delegation?.status, "COMPLETED");
  assert.equal(saveCount, 2);
});

test("same-child task and history updates merge after queued commit settlement", async (t) => {
  for (const failureMode of ["success", "before-write", "after-write"] as const) {
    await t.test(failureMode, async () => {
      const { app, home } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      appState.client = { sendCommand: async () => await new Promise(() => {}) };
      await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
        "launch", "kestrel", "merge task update",
      ]);
      const uiStore = appState.uiStore as UiStore;
      const child = uiStore.getState().sessions.find(
        (session) => session.delegation?.parentSessionId === "session-1",
      );
      assert.ok(child?.delegation !== undefined);
      const queued: TuiSessionMeta = {
        ...child,
        started: true,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: child.sessionId,
        pendingRunId: undefined,
        queuedRunReservations: [{
          runId: "run-q1",
          messageId: "message-q1",
          threadId: child.sessionId,
          predecessorRunId: "run-r0",
        }],
      };
      const sessionStore = appState.sessionStore as SessionStore;
      const originalSave = sessionStore.save.bind(sessionStore);
      appState.sessionsFile = sessionStore.upsert(appState.sessionsFile as never, queued);
      uiStore.patch({ sessions: (appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions });
      await originalSave(appState.sessionsFile as never);
      let releaseSave: (() => void) | undefined;
      let saveStartedResolve: (() => void) | undefined;
      const saveStarted = new Promise<void>((resolve) => { saveStartedResolve = resolve; });
      const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
      let saveCount = 0;
      sessionStore.save = async (file) => {
        saveCount += 1;
        if (saveCount === 1) {
          saveStartedResolve?.();
          await saveRelease;
          if (failureMode !== "before-write") await originalSave(file);
          if (failureMode !== "success") throw new Error(`same-child ${failureMode}`);
          return;
        }
        await originalSave(file);
      };
      const start = (appState.syncBackgroundSessionProgress as (input: {
        sessionId: string;
        threadId: string;
        runId: string;
        messageId: string;
      }) => Promise<void>)({
        sessionId: queued.sessionId,
        threadId: queued.sessionId,
        runId: "run-q1",
        messageId: "message-q1",
      });
      await saveStarted;
      const taskUpdate = (appState.updateTaskSessionFromMeta as (
        task: NonNullable<TuiSessionMeta["delegation"]>,
      ) => Promise<void>)({
        ...child.delegation,
        status: "WAITING",
        updatedAt: new Date().toISOString(),
      });
      const historyUpdate = (appState.appendSessionHistoryLine as (
        session: TuiSessionMeta,
        role: "assistant",
        text: string,
      ) => Promise<void>).call(
        app,
        child,
        "assistant",
        `serialized history ${failureMode}`,
      );
      releaseSave?.();
      await start;
      await taskUpdate;
      await historyUpdate;
      const expectedRunId = failureMode === "success" ? "run-q1" : "run-r0";
      const current = uiStore.getState().sessions.find(
        (session) => session.sessionId === queued.sessionId,
      );
      assert.equal(current?.acceptedRunId, expectedRunId);
      assert.equal(current?.delegation?.status, "WAITING");
      assert.equal(current?.lastMessagePreview, `serialized history ${failureMode}`);
      assert.equal(current?.queuedRunReservations?.[0]?.runId, failureMode === "success" ? undefined : "run-q1");
      const persisted = new SessionStore(home).findByName(
        await new SessionStore(home).load(),
        queued.name,
      );
      assert.equal(persisted?.acceptedRunId, expectedRunId);
      assert.equal(persisted?.delegation?.status, "WAITING");
      assert.equal(persisted?.lastMessagePreview, `serialized history ${failureMode}`);
      assert.equal(saveCount, 3);
    });
  }
});

test("queued background start applies after earlier task and history mutations settle", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const child = installBackgroundSession(appState, {
    sessionId: "child-reverse-task-history-start",
    started: true,
    acceptedRunId: "run-r0",
    acceptedRunMessageId: "message-r0",
    acceptedRunThreadId: "thread-main:child-reverse-task-history-start",
    queuedRunReservations: [{
      runId: "run-q1",
      messageId: "message-q1",
      threadId: "thread-main:child-reverse-task-history-start",
      predecessorRunId: "run-r0",
    }],
  });
  const sessionStore = appState.sessionStore as SessionStore;
  const originalSave = sessionStore.save.bind(sessionStore);
  await originalSave(appState.sessionsFile as never);
  let releaseSave: (() => void) | undefined;
  let firstSaveStartedResolve: (() => void) | undefined;
  const firstSaveStarted = new Promise<void>((resolve) => { firstSaveStartedResolve = resolve; });
  const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
  let saveCount = 0;
  sessionStore.save = async (file) => {
    saveCount += 1;
    if (saveCount === 1) {
      firstSaveStartedResolve?.();
      await saveRelease;
    }
    await originalSave(file);
  };

  const taskUpdate = (appState.updateTaskSessionFromMeta as (
    task: NonNullable<TuiSessionMeta["delegation"]>,
  ) => Promise<void>)({
    ...child.delegation!,
    status: "WAITING",
    updatedAt: "2026-08-29T00:00:02.000Z",
  });
  await firstSaveStarted;
  const historyUpdate = (appState.appendSessionHistoryLine as (
    session: TuiSessionMeta,
    role: "assistant",
    text: string,
  ) => Promise<void>)(child, "assistant", "history before exact start");
  const start = (appState.syncBackgroundSessionProgress as (input: {
    sessionId: string;
    threadId: string;
    runId: string;
    messageId: string;
  }) => Promise<void>)({
    sessionId: child.sessionId,
    threadId: "thread-main:child-reverse-task-history-start",
    runId: "run-q1",
    messageId: "message-q1",
  });
  releaseSave?.();
  await taskUpdate;
  await historyUpdate;
  await start;

  const current = uiStore.getState().sessions.find((session) => session.sessionId === child.sessionId);
  assert.equal(current?.acceptedRunId, "run-q1");
  assert.equal(current?.acceptedRunMessageId, "message-q1");
  assert.equal(current?.delegation?.status, "RUNNING");
  assert.equal(current?.lastMessagePreview, "history before exact start");
  assert.equal(current?.queuedRunReservations, undefined);
});

test("older delegated task progress cannot regress an exact terminal child across restart", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const child = installBackgroundSession(appState, {
    sessionId: "child-stale-task-after-terminal",
    started: true,
    acceptedRunId: "run-terminal",
    acceptedRunMessageId: "message-terminal",
    acceptedRunThreadId: "thread-main:child-stale-task-after-terminal",
    lastRunStatus: "COMPLETED",
    delegation: {
      taskId: "task-child-stale-task-after-terminal",
      parentSessionId: "session-1",
      parentRunId: "run-parent",
      childSessionId: "child-stale-task-after-terminal",
      childSessionName: "child-stale-task-after-terminal",
      title: "terminal child",
      status: "COMPLETED",
      profileId: "kestrel",
      provider: "openrouter",
      model: "test-model",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:03.000Z",
    },
    updatedAt: "2026-08-29T00:00:03.000Z",
  });
  const sessionStore = appState.sessionStore as SessionStore;
  await sessionStore.save(appState.sessionsFile as never);

  for (const status of ["RUNNING", "RECOVERING"] as const) {
    await (appState.updateTaskSessionFromMeta as (
      task: NonNullable<TuiSessionMeta["delegation"]>,
    ) => Promise<void>)({
      ...child.delegation!,
      status,
      updatedAt: "2026-08-29T00:00:02.000Z",
    });
  }

  const current = uiStore.getState().sessions.find((session) => session.sessionId === child.sessionId);
  assert.equal(current?.delegation?.status, "COMPLETED");
  assert.equal(current?.lastRunStatus, "COMPLETED");
  assert.equal(current?.acceptedRunId, "run-terminal");
  const restarted = new SessionStore(home).findByName(
    await new SessionStore(home).load(),
    child.name,
  );
  assert.equal(restarted?.delegation?.status, "COMPLETED");
  assert.equal(restarted?.lastRunStatus, "COMPLETED");
  assert.equal(restarted?.acceptedRunId, "run-terminal");
});

test("active history and terminal cursor serialize behind queued acceptance", async (t) => {
  for (const failureMode of ["success", "before-write", "after-write"] as const) {
    await t.test(failureMode, async () => {
      const { app, home } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const initial = uiStore.getState().activeSession;
      const threadId = `thread-main:${initial.sessionId}`;
      const queued: TuiSessionMeta = {
        ...initial,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: threadId,
        queuedRunReservations: [{
          runId: "run-q1",
          messageId: "message-q1",
          threadId,
          predecessorRunId: "run-r0",
        }],
      };
      const sessionStore = appState.sessionStore as SessionStore;
      const originalSave = sessionStore.save.bind(sessionStore);
      appState.sessionsFile = sessionStore.upsert(appState.sessionsFile as never, queued);
      uiStore.patch({
        activeSession: queued,
        sessions: (appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions,
      });
      await originalSave(appState.sessionsFile as never);
      appState.client = {
        sendCommand: async (type: string) => {
          assert.equal(type, "conversation.messages.list");
          return {
            type: "conversation.messages",
            payload: {
              threadId,
              messages: [],
              terminalOutcomes: [],
              nextCursor: "cursor-q1",
              hasMore: false,
            },
          };
        },
      };
      let releaseSave: (() => void) | undefined;
      let saveStartedResolve: (() => void) | undefined;
      const saveStarted = new Promise<void>((resolve) => { saveStartedResolve = resolve; });
      const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
      let saveCount = 0;
      sessionStore.save = async (file) => {
        saveCount += 1;
        if (saveCount === 1) {
          saveStartedResolve?.();
          await saveRelease;
          if (failureMode !== "before-write") await originalSave(file);
          if (failureMode !== "success") throw new Error(`active metadata ${failureMode}`);
          return;
        }
        await originalSave(file);
      };

      const acceptance = (appState.syncForegroundSessionProgress as (input: {
        sessionId: string;
        threadId: string;
        runId: string;
        messageId: string;
      }) => Promise<boolean>)({
        sessionId: queued.sessionId,
        threadId,
        runId: "run-q1",
        messageId: "message-q1",
      });
      await saveStarted;
      const history = (appState.appendHistoryLine as (
        role: "assistant",
        text: string,
        data?: undefined,
        output?: undefined,
        eventId?: string,
      ) => Promise<void>)("assistant", `active metadata ${failureMode}`, undefined, undefined, `active-metadata:${failureMode}`);
      const cursor = (appState.recoverTerminalMessages as (session: TuiSessionMeta) => Promise<void>)(queued);
      releaseSave?.();
      await acceptance;
      await history;
      await cursor;

      const expectedRunId = failureMode === "success" ? "run-q1" : "run-r0";
      const current = uiStore.getState().activeSession;
      assert.equal(saveCount, 3);
      assert.equal(current.acceptedRunId, expectedRunId);
      assert.equal(current.lastMessagePreview, `active metadata ${failureMode}`);
      assert.equal(current.terminalMessageCursor, "cursor-q1");
      assert.equal(uiStore.getState().transcript.filter(
        (line) => line.eventId === `active-metadata:${failureMode}`,
      ).length, 1);
      const restarted = new SessionStore(home).findByName(
        await new SessionStore(home).load(),
        queued.name,
      );
      assert.equal(restarted?.acceptedRunId, expectedRunId);
      assert.equal(restarted?.lastMessagePreview, `active metadata ${failureMode}`);
      assert.equal(restarted?.terminalMessageCursor, "cursor-q1");
    });
  }
});

test("background profile resolution failure leaves a truthful failed unstarted child", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.localCoreStatus = {
    client: {
      resolveExecutionProfile: async () => {
        throw new Error("profile resolution unavailable");
      },
    },
  };

  await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
    "launch",
    "kestrel",
    "inspect dependencies",
  ]);

  const child = (appState.uiStore as UiStore).getState().sessions.find(
    (session) => session.delegation?.parentSessionId === "session-1",
  );
  assert.equal(child?.delegation?.status, "FAILED");
  assert.equal(child?.delegation?.errorMessage, "profile resolution unavailable");
  assert.equal(child?.started, false);
  assert.equal(child?.environmentPresetId, "cli_dev_local");
});

test("background Local Core preparation failure leaves a truthful failed unstarted child", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.prepareLocalCoreClient = async () => {
    throw new Error("local core preparation unavailable");
  };

  await assert.doesNotReject(
    (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
      "launch",
      "kestrel",
      "inspect dependencies",
    ]),
  );

  const child = (appState.uiStore as UiStore).getState().sessions.find(
    (session) => session.delegation?.parentSessionId === "session-1",
  );
  assert.equal(child?.delegation?.status, "FAILED");
  assert.equal(child?.delegation?.errorMessage, "local core preparation unavailable");
  assert.equal(child?.started, false);
});

test("background authoritative environment rejection leaves a truthful failed unstarted child", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      if (type === "run.start") {
        throw Object.assign(new Error("run environment rejected"), {
          code: "SESSION_ENVIRONMENT_IDENTITY_CONFLICT",
          details: { persisted: "cli_dev_local", runtime: "cli_safe_local" },
        });
      }
      assert.equal(type, "session.describe");
      return {
        type: "session.described",
        payload: {
          sessionId: String(payload.sessionId),
          version: 0,
        },
      };
    },
  };

  await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
    "launch",
    "kestrel",
    "inspect dependencies",
  ]);
  await waitFor(() => (appState.uiStore as UiStore).getState().sessions.some(
    (session) => session.delegation?.status === "FAILED",
  ));

  const child = (appState.uiStore as UiStore).getState().sessions.find(
    (session) => session.delegation?.parentSessionId === "session-1",
  );
  assert.equal(child?.delegation?.status, "FAILED");
  assert.equal(child?.delegation?.errorMessage, "run environment rejected");
  assert.equal(child?.started, false);
});

test("background response loss stays recoverable while durable describe is unavailable", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.client = {
    sendCommand: async (type: string) => {
      if (type === "run.start") throw new Error("run response lost");
      throw new Error("describe temporarily unavailable");
    },
  };

  await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
    "launch",
    "kestrel",
    "inspect dependencies",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const child = (appState.uiStore as UiStore).getState().sessions.find(
    (session) => session.delegation?.parentSessionId === "session-1",
  );
  assert.equal(child?.delegation?.status, "PENDING");
  assert.equal(child?.delegation?.errorMessage, undefined);
  assert.equal(child?.lastRunStatus, undefined);
  assert.equal(child?.started, false);
});

test("background pre-run.started failure response stays failed and unstarted", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      assert.equal(type, "run.start");
      const turn = payload.turn as Record<string, unknown>;
      const sessionId = String(turn.sessionId);
      const runId = String(turn.runId);
      return {
        type: "run.failed",
        commandId: "command-preaccept-background",
        payload: {
          result: {
            assistantText: null,
            output: {
              status: "FAILED",
              sessionId,
              runId,
              quality: {
                citationCoverage: 0,
                unresolvedClaims: 0,
                reworkRate: 0,
                thrashIndex: 0,
              },
              errors: [{ code: "RUN_START_REJECTED", message: "Rejected before reservation." }],
              telemetry: { stepsExecuted: 0, toolCalls: 0, modelCalls: 0, durationMs: 0 },
            },
          },
          error: { code: "RUN_START_REJECTED", message: "Rejected before reservation." },
        },
      };
    },
  };

  await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
    "launch",
    "kestrel",
    "inspect dependencies",
  ]);
  await waitFor(() => (appState.uiStore as UiStore).getState().sessions.some(
    (session) => session.delegation?.status === "FAILED",
  ));

  const child = (appState.uiStore as UiStore).getState().sessions.find(
    (session) => session.delegation?.parentSessionId === "session-1",
  );
  assert.equal(child?.started, false);
  assert.equal(child?.lastRunStatus, "FAILED");
  assert.doesNotMatch(existsSync(historyPath) ? await readFile(historyPath, "utf8") : "", /Background task started/u);
});

test("late exact background acceptance clears stale failure evidence idempotently", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  appState.client = { sendCommand: async () => await new Promise(() => {}) };

  await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
    "launch",
    "kestrel",
    "inspect dependencies",
  ]);
  let child = uiStore.getState().sessions.find(
    (session) => session.delegation?.parentSessionId === "session-1",
  )!;
  const failed = {
    ...child,
    started: false,
    lastRunStatus: "FAILED" as const,
    pendingRunId: "run-background",
    pendingRunThreadId: `thread-main:${child.sessionId}`,
    delegation: {
      ...child.delegation!,
      status: "RECOVERING" as const,
      errorCode: "PROVISIONAL_TRANSPORT_FAILURE",
      errorMessage: "response was lost",
    },
  };
  const sessionsFile = appState.sessionsFile as { version: 5; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) => session.sessionId === failed.sessionId ? failed : session),
  };
  uiStore.patch({
    sessions: uiStore.getState().sessions.map((session) => session.sessionId === failed.sessionId ? failed : session),
  });
  const startedEvent = {
    id: "run-started-late-background",
    type: "run.started",
    ts: "2026-08-28T00:00:00.000Z",
    commandId: "command-background",
    sessionId: failed.sessionId,
    threadId: `thread-main:${failed.sessionId}`,
    runId: "run-background",
    payload: {
      sessionId: failed.sessionId,
      runId: "run-background",
      eventType: "user.message",
    },
  };

  (appState.onRunnerEvent as (event: unknown) => void)(startedEvent);
  (appState.onRunnerEvent as (event: unknown) => void)(startedEvent);
  await waitFor(() => uiStore.getState().sessions.find(
    (session) => session.sessionId === failed.sessionId,
  )?.delegation?.status === "RUNNING");
  child = uiStore.getState().sessions.find((session) => session.sessionId === failed.sessionId)!;

  assert.equal(child.started, true);
  assert.equal(child.lastRunStatus, undefined);
  assert.equal(child.delegation?.errorCode, undefined);
  assert.equal(child.delegation?.errorMessage, undefined);
  await waitFor(() => existsSync(historyPath));
  const history = await readFile(historyPath, "utf8");
  assert.equal(history.match(/Background task started/g)?.length, 1);
});

test("startup reconciles every persisted pending child from durable runtime evidence", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const now = "2026-08-28T00:00:00.000Z";
  const parent = uiStore.getState().activeSession;
  const pendingChildren = ["child-one", "child-two"].map((sessionId) => ({
    ...parent,
    name: sessionId,
    sessionId,
    started: false,
    effectiveAssemblyId: undefined,
    createdAt: now,
    updatedAt: now,
    delegation: {
      taskId: `task-${sessionId}`,
      parentSessionId: parent.sessionId,
      childSessionId: sessionId,
      childSessionName: sessionId,
      title: sessionId,
      status: "PENDING" as const,
      profileId: parent.profileId,
      provider: "openrouter" as const,
      model: "test-model",
      createdAt: now,
      updatedAt: now,
    },
  }));
  const sessionsFile = appState.sessionsFile as { version: 5; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = { ...sessionsFile, sessions: [parent, ...pendingChildren] };
  uiStore.patch({ sessions: [parent, ...pendingChildren] });
  const described: string[] = [];
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      assert.equal(type, "session.describe");
      const sessionId = String(payload.sessionId);
      described.push(sessionId);
      return {
        type: "session.described",
        payload: {
          sessionId,
          version: 1,
          threadId: `thread-main:${sessionId}`,
          activeAssembly: {
            mode: "explicit",
            bundleId: `bundle:${sessionId}`,
            environmentPresetId: "cli_dev_local",
          },
          operatorThreadView: {
            thread: {
              threadId: `thread-main:${sessionId}`,
              sessionId,
              title: sessionId,
              status: "RUNNING",
              createdAt: now,
              updatedAt: now,
            },
            childThreads: [],
            childBlockerChain: [],
            activeRun: { runId: `run-${sessionId}`, status: "RUNNING" },
          },
        },
      };
    },
  };

  await (appState.reconcilePendingBackgroundSessions as () => Promise<void>)();

  assert.deepEqual(described.sort(), ["child-one", "child-two"]);
  for (const child of uiStore.getState().sessions.filter((session) => session.delegation !== undefined)) {
    assert.equal(child.delegation?.status, "RUNNING");
    assert.equal(child.started, true);
    assert.equal(child.delegation?.errorMessage, undefined);
  }
});

test("assembly-only background recovery uses an explicit recoverable lifecycle state", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const now = "2026-08-28T00:00:00.000Z";
  const parent = uiStore.getState().activeSession;
  const child: TuiSessionMeta = {
    ...parent,
    name: "child-assembly-only",
    sessionId: "child-assembly-only",
    started: false,
    effectiveAssemblyId: undefined,
    delegation: {
      taskId: "task-child-assembly-only",
      parentSessionId: parent.sessionId,
      childSessionId: "child-assembly-only",
      childSessionName: "child-assembly-only",
      title: "assembly only",
      status: "PENDING",
      profileId: parent.profileId,
      provider: "openrouter",
      model: "test-model",
      createdAt: now,
      updatedAt: now,
    },
  };
  const sessionsFile = appState.sessionsFile as { version: 5; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = { ...sessionsFile, sessions: [parent, child] };
  uiStore.patch({ sessions: [parent, child] });
  const payload = {
    sessionId: child.sessionId,
    version: 1,
    activeAssembly: {
      mode: "explicit" as const,
      bundleId: "bundle:child-assembly-only",
      environmentPresetId: "cli_dev_local" as const,
    },
  };

  await (appState.reconcileBackgroundSessionDescription as (
    describedPayload: SessionDescribedEventPayload,
    appendStartedHistory: boolean,
  ) => Promise<void>)(payload, true);

  const recovered = uiStore.getState().sessions.find((session) => session.sessionId === child.sessionId);
  assert.equal(recovered?.started, true, JSON.stringify(recovered));
  assert.equal(recovered?.delegation?.status, "RECOVERING");
  assert.equal(recovered?.lastRunStatus, undefined);
  assert.equal(recovered?.effectiveAssemblyId, "bundle:child-assembly-only");
});

test("background lifecycle ignores delayed starts after terminal and stale run A terminals during run B", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = installBackgroundSession(appState, {
    sessionId: "child-monotonic",
  });
  const child = installBackgroundSession(appState, {
    ...base,
    started: true,
    focusedThreadId: "child-monotonic",
    acceptedRunId: "run-b",
    acceptedRunMessageId: "message-b",
    acceptedRunThreadId: "child-monotonic",
    delegation: {
      ...base.delegation!,
      status: "RUNNING",
    },
  });
  const completedOutput = {
    status: "COMPLETED" as const,
    sessionId: child.sessionId,
    runId: "run-a",
    quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
    errors: [],
    telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
  };

  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "progress-run-a",
    type: "run.progress",
    ts: "2026-08-28T00:00:00.500Z",
    sessionId: child.sessionId,
    threadId: child.sessionId,
    runId: "run-a",
    payload: {
      update: {
        sessionId: child.sessionId,
        runId: "run-a",
        kind: "step",
        phase: "execute",
        code: "STEP_RUNNING",
        message: "stale progress",
        seq: 1,
      },
    },
  });
  const runController = (appState.getRunController as () => {
    getConversationActivity(sessionId: string): unknown[];
  })();
  assert.deepEqual(runController.getConversationActivity(child.sessionId), []);

  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "terminal-run-a",
    type: "run.completed",
    ts: "2026-08-28T00:00:01.000Z",
    sessionId: child.sessionId,
    threadId: child.sessionId,
    runId: "run-a",
    payload: { result: { assistantText: "stale", output: completedOutput } },
  });
  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "late-start-run-a",
    type: "run.started",
    ts: "2026-08-28T00:00:02.000Z",
    sessionId: child.sessionId,
    threadId: child.sessionId,
    runId: "run-a",
    payload: { sessionId: child.sessionId, runId: "run-a", eventType: "user.message" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const current = uiStore.getState().sessions.find((item) => item.sessionId === child.sessionId);
  assert.equal(current?.acceptedRunId, "run-b");
  assert.equal(current?.delegation?.status, "RUNNING");
  assert.equal(current?.lastRunStatus, undefined);
  assert.doesNotMatch(existsSync(historyPath) ? await readFile(historyPath, "utf8") : "", /stale/u);

  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "terminal-run-b",
    type: "run.completed",
    ts: "2026-08-28T00:00:03.000Z",
    sessionId: child.sessionId,
    threadId: child.sessionId,
    runId: "run-b",
    payload: {
      result: {
        assistantText: "current completion",
        output: { ...completedOutput, runId: "run-b" },
      },
    },
  });
  await waitFor(() => uiStore.getState().sessions.find(
    (item) => item.sessionId === child.sessionId,
  )?.delegation?.status === "COMPLETED");
  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "late-start-after-terminal",
    type: "run.started",
    ts: "2026-08-28T00:00:04.000Z",
    sessionId: child.sessionId,
    threadId: child.sessionId,
    runId: "run-b",
    payload: { sessionId: child.sessionId, runId: "run-b", eventType: "user.message" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const terminal = uiStore.getState().sessions.find((item) => item.sessionId === child.sessionId);
  assert.equal(terminal?.delegation?.status, "COMPLETED");
  assert.equal(terminal?.lastRunStatus, "COMPLETED");
  assert.equal(terminal?.acceptedRunId, "run-b");
});

test("an unsolicited terminal cannot claim a pending background child", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const child = installBackgroundSession(appState, {
    sessionId: "child-pending-terminal",
    pendingRunId: "run-expected",
    pendingRunThreadId: "child-pending-terminal",
  });
  const output = {
    status: "FAILED" as const,
    sessionId: child.sessionId,
    runId: "run-unsolicited",
    quality: { citationCoverage: 0, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
    errors: [{ code: "STALE", message: "stale terminal" }],
    telemetry: { stepsExecuted: 0, toolCalls: 0, modelCalls: 0, durationMs: 0 },
  };

  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "unsolicited-terminal",
    type: "run.failed",
    ts: "2026-08-28T00:00:02.000Z",
    sessionId: child.sessionId,
    threadId: child.sessionId,
    runId: output.runId,
    payload: { result: { assistantText: null, output }, error: output.errors[0] },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const current = uiStore.getState().sessions.find((item) => item.sessionId === child.sessionId);
  assert.equal(current?.delegation?.status, "PENDING");
  assert.equal(current?.started, false);
  assert.equal(current?.acceptedRunId, undefined);
  assert.equal(current?.pendingRunId, "run-expected");
  assert.equal(current?.pendingRunMessageId, undefined);
});

test("stale assembly-only describe cannot regress a newer accepted background run", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = installBackgroundSession(appState, {
    sessionId: "child-stale-describe",
  });
  const child = installBackgroundSession(appState, {
    ...base,
    started: true,
    effectiveAssemblyId: "bundle:new",
    acceptedRunId: "run-new",
    delegation: {
      ...base.delegation!,
      status: "RUNNING",
    },
  });

  await (appState.reconcileBackgroundSessionDescription as (
    payload: Record<string, unknown>,
    appendStartedHistory: boolean,
  ) => Promise<void>)({
    sessionId: child.sessionId,
    version: 1,
    activeAssembly: {
      mode: "explicit",
      bundleId: "bundle:stale",
      environmentPresetId: "cli_dev_local",
    },
  }, false);

  const current = uiStore.getState().sessions.find((item) => item.sessionId === child.sessionId);
  assert.equal(current?.delegation?.status, "RUNNING");
  assert.equal(current?.effectiveAssemblyId, "bundle:new");
  assert.equal(current?.acceptedRunId, "run-new");
});

test("live background acceptance wins over a describe projection delayed by profile loading", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const child = installBackgroundSession(appState, {
    sessionId: "child-interleaved-describe",
    profileId: "profile-loaded-late",
    pendingRunId: "run-live",
    pendingRunMessageId: "message-live",
    pendingRunThreadId: "child-interleaved-describe",
  });
  const persistedStatuses: Array<string | undefined> = [];
  const observedSessionStore = appState.sessionStore as SessionStore;
  const saveSessionsFile = observedSessionStore.save.bind(observedSessionStore);
  observedSessionStore.save = async (file) => {
    persistedStatuses.push(file.sessions.find(
      (session) => session.sessionId === child.sessionId,
    )?.delegation?.status);
    await saveSessionsFile(file);
  };
  let releaseProfileLoad: ((profiles: unknown[]) => void) | undefined;
  let profileLoadStartedResolve: (() => void) | undefined;
  const profileLoadStarted = new Promise<void>((resolve) => {
    profileLoadStartedResolve = resolve;
  });
  appState.profileStore = {
    load: async () => await new Promise<unknown[]>((resolve) => {
      releaseProfileLoad = resolve;
      profileLoadStartedResolve?.();
    }),
  };

  const describing = (appState.reconcileBackgroundSessionDescription as (
    payload: Record<string, unknown>,
    appendStartedHistory: boolean,
  ) => Promise<void>)({
    sessionId: child.sessionId,
    version: 1,
    activeAssembly: {
      mode: "explicit",
      bundleId: "bundle:stale-assembly-only",
      environmentPresetId: "cli_dev_local",
    },
  }, false);
  await profileLoadStarted;

  await (appState.syncBackgroundSessionProgress as (input: {
    sessionId: string;
    threadId: string;
    runId: string;
    messageId?: string | undefined;
  }) => Promise<void>)({
    sessionId: child.sessionId,
    threadId: child.sessionId,
    runId: "run-live",
    messageId: "message-live",
  });
  releaseProfileLoad?.([]);
  await describing;

  const current = uiStore.getState().sessions.find((item) => item.sessionId === child.sessionId);
  assert.equal(current?.delegation?.status, "RUNNING");
  assert.equal(current?.acceptedRunId, "run-live");
  assert.equal(current?.lastRunStatus, undefined);
  assert.deepEqual(persistedStatuses, ["RUNNING", "RUNNING", "RUNNING"]);
});

test("delegated pending and queued starts require exact run, thread, and message identity", async (t) => {
  for (const source of ["pending", "queued"] as const) {
    await t.test(source, async () => {
      const { app } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const sessionId = `child-exact-start-${source}`;
      const threadId = `thread-main:${sessionId}`;
      const child = installBackgroundSession(appState, {
        sessionId,
        started: true,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: threadId,
        ...(source === "pending"
          ? {
              pendingRunId: "run-q1",
              pendingRunMessageId: "message-q1",
              pendingRunThreadId: threadId,
            }
          : {
              queuedRunReservations: [{
                runId: "run-q1",
                messageId: "message-q1",
                threadId,
                predecessorRunId: "run-r0",
              }],
            }),
      });
      const sync = (appState.syncBackgroundSessionProgress as (input: {
        sessionId: string;
        threadId: string;
        runId: string;
        messageId?: string | undefined;
      }) => Promise<void>).bind(app);

      for (const candidate of [
        { runId: "run-q1" },
        { runId: "run-q1", messageId: "message-wrong" },
        { runId: "run-wrong", messageId: "message-q1" },
      ]) {
        await sync({ sessionId, threadId, ...candidate });
        assert.equal(
          uiStore.getState().sessions.find((session) => session.sessionId === child.sessionId)?.acceptedRunId,
          "run-r0",
        );
      }

      (appState.onRunnerEvent as (event: unknown) => void)({
        id: `run-started-exact-${source}`,
        type: "run.started",
        ts: "2026-08-29T00:00:02.000Z",
        sessionId,
        threadId,
        runId: "run-q1",
        payload: {
          sessionId,
          runId: "run-q1",
          eventType: "user.message",
          sourceMessageId: "message-q1",
        },
      });
      await waitFor(() => uiStore.getState().sessions.find(
        (session) => session.sessionId === child.sessionId,
      )?.acceptedRunId === "run-q1");
      const accepted = uiStore.getState().sessions.find((session) => session.sessionId === child.sessionId);
      assert.equal(accepted?.acceptedRunId, "run-q1");
      assert.equal(accepted?.acceptedRunMessageId, "message-q1");
      assert.equal(accepted?.acceptedRunThreadId, threadId);
      assert.equal(accepted?.delegation?.status, "RUNNING");
    });
  }
});

test("same-run background progress cannot regress WAITING to RUNNING", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const child = installBackgroundSession(appState, {
    sessionId: "child-waiting-monotonic",
    started: true,
    acceptedRunId: "run-waiting",
    lastRunStatus: "WAITING",
    delegation: {
      taskId: "task-child-waiting-monotonic",
      parentSessionId: "session-1",
      childSessionId: "child-waiting-monotonic",
      childSessionName: "child-waiting-monotonic",
      title: "waiting child",
      status: "WAITING",
      profileId: "kestrel",
      provider: "openrouter",
      model: "test-model",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  });

  await (appState.syncBackgroundSessionProgress as (input: {
    sessionId: string;
    threadId: string;
    runId: string;
  }) => Promise<void>)({
    sessionId: child.sessionId,
    threadId: child.sessionId,
    runId: "run-waiting",
  });

  const current = uiStore.getState().sessions.find((item) => item.sessionId === child.sessionId);
  assert.equal(current?.delegation?.status, "WAITING");
  assert.equal(current?.lastRunStatus, "WAITING");
});

test("exact accepted reply advances a delegated WAITING child to its new run", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const threadId = "thread-main:child-waiting-reply";
  const child = installBackgroundSession(appState, {
    sessionId: "child-waiting-reply",
    started: true,
    focusedThreadId: threadId,
    acceptedRunId: "run-waiting-old",
    acceptedRunMessageId: "message-waiting-old",
    pendingRunRequestId: "request-waiting-reply",
    pendingRunThreadId: threadId,
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId: "request-waiting-reply",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
      },
    },
    lastRunStatus: "WAITING",
    delegation: {
      taskId: "task-child-waiting-reply",
      parentSessionId: "session-1",
      childSessionId: "child-waiting-reply",
      childSessionName: "child-waiting-reply",
      title: "waiting reply child",
      status: "WAITING",
      profileId: "kestrel",
      provider: "openrouter",
      model: "test-model",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  });

  await (appState.syncBackgroundSessionProgress as (input: {
    sessionId: string;
    threadId: string;
    runId: string;
    requestId?: string | undefined;
  }) => Promise<void>)({
    sessionId: child.sessionId,
    threadId,
    runId: "run-waiting-new",
    requestId: "request-waiting-reply",
  });

  const current = uiStore.getState().sessions.find((item) => item.sessionId === child.sessionId);
  assert.equal(current?.delegation?.status, "RUNNING");
  assert.equal(current?.acceptedRunId, "run-waiting-new");
  assert.equal(current?.acceptedRunThreadId, threadId);
  assert.equal(current?.pendingRunRequestId, undefined);
  assert.equal(current?.pendingRunThreadId, undefined);
  assert.equal(current?.pendingWaitFor, undefined);
  assert.equal(current?.lastRunStatus, undefined);
});

test("exact describe acceptance persists identity and lifecycle in one session write", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const child = installBackgroundSession(appState, {
    sessionId: "child-atomic-acceptance",
    pendingRunId: "run-atomic",
    pendingRunThreadId: "thread-main:child-atomic-acceptance",
  });
  const snapshots: TuiSessionMeta[][] = [];
  const observedSessionStore = appState.sessionStore as SessionStore;
  const saveSessionsFile = observedSessionStore.save.bind(observedSessionStore);
  observedSessionStore.save = async (file) => {
    snapshots.push(file.sessions.map((session) => ({ ...session })));
    await saveSessionsFile(file);
  };

  await (appState.reconcileBackgroundSessionDescription as (
    payload: Record<string, unknown>,
    appendStartedHistory: boolean,
  ) => Promise<void>)({
    sessionId: child.sessionId,
    version: 1,
    threadId: "thread-main:child-atomic-acceptance",
    activeAssembly: {
      mode: "explicit",
      bundleId: "bundle:atomic",
      environmentPresetId: "cli_dev_local",
    },
    operatorThreadView: {
      thread: {
        threadId: "thread-main:child-atomic-acceptance",
        sessionId: child.sessionId,
        title: "atomic",
        status: "RUNNING",
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-atomic", status: "RUNNING" },
    },
  }, false);

  assert.equal(snapshots.length, 1);
  const persisted = snapshots[0]?.find((item) => item.sessionId === child.sessionId);
  assert.equal(persisted?.started, true);
  assert.equal(persisted?.delegation?.status, "RUNNING");
  assert.equal(persisted?.effectiveAssemblyId, "bundle:atomic");
  assert.equal(persisted?.acceptedRunId, "run-atomic");
  assert.equal(persisted?.acceptedRunThreadId, "thread-main:child-atomic-acceptance");
  assert.equal(persisted?.pendingRunId, undefined);
  assert.equal(persisted?.pendingRunMessageId, undefined);
  assert.equal(snapshots.some((snapshot) => snapshot.some(
    (item) => item.sessionId === child.sessionId && item.started && item.delegation?.status === "PENDING",
  )), false);
});

test("startup reconciles an active pending child atomically before generic describe persistence", async () => {
  const { app } = await createAppHarness({ scripted: true });
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const child = installBackgroundSession(appState, {
    sessionId: "child-active-startup",
    pendingRunId: "run-active-startup",
    pendingRunThreadId: "child-active-startup",
  });
  const sessionsFile = appState.sessionsFile as {
    version: 5;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = { ...sessionsFile, activeSessionName: child.name };
  uiStore.patch({
    activeSession: child,
    sessions: (appState.sessionsFile as SessionsFile).sessions,
  });
  const persisted: TuiSessionMeta[][] = [];
  const observedSessionStore = appState.sessionStore as SessionStore;
  const saveSessionsFile = observedSessionStore.save.bind(observedSessionStore);
  observedSessionStore.save = async (file) => {
    persisted.push(file.sessions.map(
      (session) => structuredClone(session),
    ));
    await saveSessionsFile(file);
  };
  appState.client = {
    start: () => {},
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      assert.equal(type, "session.describe");
      assert.equal(payload.sessionId, child.sessionId);
      return {
        type: "session.described",
        payload: {
          sessionId: child.sessionId,
          version: 1,
          threadId: child.sessionId,
          activeAssembly: {
            mode: "explicit",
            bundleId: "bundle:startup",
            environmentPresetId: "cli_dev_local",
          },
          operatorThreadView: {
            thread: {
              threadId: child.sessionId,
              sessionId: child.sessionId,
              title: "startup child",
              status: "RUNNING",
              createdAt: child.createdAt,
              updatedAt: child.updatedAt,
            },
            childThreads: [],
            childBlockerChain: [],
            activeRun: { runId: "run-active-startup", status: "RUNNING" },
          },
        },
      };
    },
  };
  appState.runnerUsesLocalCore = true;
  const localCoreStatus = appState.localCoreStatus as { client: Record<string, unknown> };
  localCoreStatus.client.providerReadiness = async () => ({
    ok: true,
    providerReadiness: {
      openrouter: { ready: true, credential: "configured" },
    },
    toolReadiness: {
      tavily: { ready: true, credential: "configured" },
    },
  });
  appState.runSplashDatabaseCheck = async () => {};
  appState.runSplashMcpCheck = async () => {};

  await (appState.runSplashPreflight as () => Promise<void>)();

  assert.equal(persisted.length > 0, true);
  assert.equal(persisted.some((snapshot) => snapshot.some((session) =>
    session.sessionId === child.sessionId
    && session.started === true
    && session.delegation?.status === "PENDING"
  )), false);
  const current = uiStore.getState().sessions.find((session) => session.sessionId === child.sessionId);
  assert.equal(current?.delegation?.status, "RUNNING");
  assert.equal(current?.acceptedRunId, "run-active-startup");
});

test("background direct terminal response must match the expected child thread", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const child = installBackgroundSession(appState, {
    sessionId: "child-thread-bound-response",
    pendingRunId: "run-thread-bound",
    pendingRunThreadId: "thread-main:child-thread-bound-response",
  });
  const output = {
    status: "COMPLETED" as const,
    sessionId: child.sessionId,
    runId: "run-thread-bound",
    quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
    errors: [],
    telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
  };

  await (appState.syncBackgroundLaunchResponse as (
    sessionId: string,
    threadId: string,
    runId: string,
    response: Record<string, unknown>,
  ) => Promise<void>)(child.sessionId, "thread-main:child-thread-bound-response", output.runId, {
    type: "run.completed",
    sessionId: child.sessionId,
    threadId: "thread-wrong",
    runId: output.runId,
    payload: { result: { assistantText: "wrong thread", output } },
  });

  const current = uiStore.getState().sessions.find((session) => session.sessionId === child.sessionId);
  assert.equal(current?.delegation?.status, "PENDING");
  assert.equal(current?.started, false);
  assert.equal(current?.acceptedRunId, undefined);
});

test("background launch drops a cross-session terminal response", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      assert.equal(type, "run.start");
      const turn = payload.turn as Record<string, unknown>;
      const runId = String(turn.runId);
      return {
        type: "run.completed",
        sessionId: String(turn.sessionId),
        runId,
        payload: {
          result: {
            assistantText: "wrong session",
            output: {
              status: "COMPLETED",
              sessionId: "child-other",
              runId,
              quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
              errors: [],
              telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
            },
          },
        },
      };
    },
  };

  await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
    "launch",
    "kestrel",
    "inspect dependencies",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const child = (appState.uiStore as UiStore).getState().sessions.find(
    (session) => session.delegation?.parentSessionId === "session-1",
  );
  assert.equal(child?.delegation?.status, "PENDING");
  assert.equal(child?.started, false);
  assert.equal(child?.acceptedRunId, undefined);
  assert.equal(typeof child?.pendingRunId, "string");
  assert.equal(child?.pendingRunMessageId, undefined);
});

test("background response loss reconciles authoritative running state", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  let childSessionId: string | undefined;
  let childRunId: string | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      if (type === "run.start") {
        const turn = payload.turn as Record<string, unknown>;
        childSessionId = String(turn.sessionId);
        childRunId = String(turn.runId);
        throw new Error("run response lost");
      }
      assert.equal(type, "session.describe");
      const sessionId = String(payload.sessionId);
      assert.equal(sessionId, childSessionId);
      return {
        type: "session.described",
        payload: {
          sessionId,
          version: 1,
          threadId: sessionId,
          activeAssembly: {
            mode: "explicit",
            bundleId: "bundle:kestrel:cli",
            environmentPresetId: "cli_dev_local",
          },
          operatorThreadView: {
            thread: {
              threadId: sessionId,
              sessionId,
              title: "Background",
              status: "RUNNING",
              createdAt: "2026-08-28T00:00:00.000Z",
              updatedAt: "2026-08-28T00:00:01.000Z",
            },
            childThreads: [],
            childBlockerChain: [],
            activeRun: { runId: childRunId, status: "RUNNING" },
          },
        },
      };
    },
  };

  await (appState.handleTasksCommand as (args: string[]) => Promise<void>)([
    "launch",
    "kestrel",
    "inspect dependencies",
  ]);
  await waitFor(() => (appState.uiStore as UiStore).getState().sessions.some(
    (session) => session.delegation?.status === "RUNNING",
  ));

  const child = (appState.uiStore as UiStore).getState().sessions.find(
    (session) => session.sessionId === childSessionId,
  );
  assert.equal(child?.delegation?.status, "RUNNING");
  assert.equal(child?.started, true);
  assert.equal(child?.lastRunStatus, undefined);
  assert.equal(child?.environmentPresetId, "cli_dev_local");
  assert.equal(child?.effectiveAssemblyId, "bundle:kestrel:cli");
});

test("session description marks an unstarted session started from durable thread or assembly evidence", async (t) => {
  for (const evidence of ["thread", "assembly"] as const) {
    await t.test(evidence, async () => {
      const { app } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const unstarted = {
        ...uiStore.getState().activeSession,
        started: false,
        effectiveAssemblyId: undefined,
      };
      const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
      appState.sessionsFile = {
        ...sessionsFile,
        sessions: sessionsFile.sessions.map((session) =>
          session.sessionId === unstarted.sessionId ? unstarted : session
        ),
      };
      uiStore.patch({ activeSession: unstarted, sessions: [unstarted] });

      await (appState.syncSessionFromDescribePayload as (payload: Record<string, unknown>) => Promise<void>)({
        sessionId: unstarted.sessionId,
        version: 1,
        ...(evidence === "thread"
          ? { threadId: `thread-main:${unstarted.sessionId}` }
          : {
              activeAssembly: {
                mode: "explicit",
                bundleId: "bundle:kestrel:cli",
                environmentPresetId: "cli_dev_local",
              },
            }),
      });

      assert.equal(uiStore.getState().activeSession.started, true);
      assert.equal(uiStore.getState().activeSession.environmentPresetId, "cli_dev_local");
    });
  }
});

test("session description backfills legacy accepted thread ownership only from an exact active or terminal run", async (t) => {
  for (const evidence of ["foreground-active", "delegated-terminal"] as const) {
    await t.test(evidence, async () => {
      const { app } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const acceptedRunId = `run-legacy:${evidence}`;
      const threadId = `thread-exact:${evidence}`;
      const base = uiStore.getState().activeSession;
      const legacy: TuiSessionMeta = {
        ...base,
        started: true,
        acceptedRunId,
        acceptedRunMessageId: `message-legacy:${evidence}`,
        acceptedRunThreadId: undefined,
        ...(evidence === "delegated-terminal"
          ? {
              delegation: {
                taskId: "task-legacy-thread",
                parentSessionId: "parent-legacy-thread",
                childSessionId: base.sessionId,
                childSessionName: base.name,
                title: "legacy accepted thread",
                status: "RUNNING" as const,
                profileId: base.profileId,
                provider: "openrouter",
                model: "test-model",
                createdAt: base.createdAt,
                updatedAt: base.updatedAt,
              },
            }
          : {}),
      };
      const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
      appState.sessionsFile = {
        ...sessionsFile,
        sessions: sessionsFile.sessions.map((session) =>
          session.sessionId === legacy.sessionId ? legacy : session
        ),
      };
      uiStore.patch({ activeSession: legacy, sessions: [legacy] });

      await (appState.syncSessionFromDescribePayload as (payload: Record<string, unknown>) => Promise<void>)({
        sessionId: legacy.sessionId,
        version: 1,
        threadId,
        operatorThreadView: {
          thread: {
            threadId,
            sessionId: legacy.sessionId,
            title: "Legacy accepted thread",
            status: evidence === "foreground-active" ? "RUNNING" : "COMPLETED",
            lastRunStatus: evidence === "foreground-active" ? undefined : "COMPLETED",
            createdAt: legacy.createdAt,
            updatedAt: legacy.updatedAt,
          },
          childThreads: [],
          childBlockerChain: [],
          ...(evidence === "foreground-active"
            ? { activeRun: { runId: acceptedRunId, status: "RUNNING" } }
            : {
                conversationTurns: [{
                  turnId: "turn-legacy-thread",
                  threadId,
                  sessionId: legacy.sessionId,
                  sequence: 1,
                  status: "COMPLETED",
                  rootRunId: acceptedRunId,
                  terminalRunId: acceptedRunId,
                  terminalStatus: "COMPLETED",
                  startedAt: legacy.createdAt,
                  completedAt: legacy.updatedAt,
                  updatedAt: legacy.updatedAt,
                }],
              }),
        },
      });

      assert.equal(uiStore.getState().activeSession.acceptedRunThreadId, threadId);
    });
  }
});

test("session description never backfills accepted thread ownership from a mismatched run or mutable focus", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const legacy: TuiSessionMeta = {
    ...base,
    started: true,
    focusedThreadId: "thread-focus:legacy",
    acceptedRunId: "run-accepted:legacy",
    acceptedRunMessageId: "message-accepted:legacy",
    acceptedRunThreadId: undefined,
  };
  const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === legacy.sessionId ? legacy : session
    ),
  };
  uiStore.patch({ activeSession: legacy, sessions: [legacy] });

  await (appState.syncSessionFromDescribePayload as (payload: Record<string, unknown>) => Promise<void>)({
    sessionId: legacy.sessionId,
    version: 1,
    threadId: "thread-described:legacy",
    focusedThreadId: "thread-focus:legacy",
    operatorThreadView: {
      thread: {
        threadId: "thread-described:legacy",
        sessionId: legacy.sessionId,
        title: "Mismatched run",
        status: "RUNNING",
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-other:legacy", status: "RUNNING" },
      conversationTurns: [{
        turnId: "turn-historical-accepted",
        threadId: "thread-described:legacy",
        sessionId: legacy.sessionId,
        sequence: 1,
        status: "COMPLETED",
        rootRunId: "run-accepted:legacy",
        terminalRunId: "run-accepted:legacy",
        terminalStatus: "COMPLETED",
        startedAt: legacy.createdAt,
        completedAt: legacy.updatedAt,
        updatedAt: legacy.updatedAt,
      }],
    },
  });

  assert.equal(uiStore.getState().activeSession.acceptedRunThreadId, undefined);
});

test("restart recovers a run-less queued route without letting its delayed start replace an intervening reply", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const queuedRunId = "run-restart-runless-queue";
  const queuedMessageId = "message-restart-runless-queue";
  const recovering: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-current-before-queue",
    acceptedRunMessageId: "message-current-before-queue",
    acceptedRunThreadId: threadId,
    pendingQueueSubmissions: [{
      runId: queuedRunId,
      messageId: queuedMessageId,
      threadId,
      predecessorRunId: "run-current-before-queue",
    }],
    pendingRunRequestId: "request-intervening-reply",
    pendingRunThreadId: threadId,
  };
  const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === recovering.sessionId ? recovering : session
    ),
  };
  uiStore.patch({ activeSession: recovering, sessions: [recovering] });

  await (appState.syncSessionFromDescribePayload as (payload: Record<string, unknown>) => Promise<void>)({
    sessionId: recovering.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: recovering.sessionId,
        title: "Recovered queue",
        status: "RUNNING",
        createdAt: recovering.createdAt,
        updatedAt: recovering.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-current-before-queue", status: "RUNNING" },
      conversationMessageRoutes: [{
        messageId: queuedMessageId,
        disposition: "queued",
        followUpId: "follow-up:restart-runless-queue",
        createdAt: "2026-08-29T00:00:00.000Z",
      }],
    },
  });

  let session = uiStore.getState().activeSession;
  assert.equal(session.pendingQueueSubmissions, undefined);
  assert.deepEqual(session.queuedRunReservations, [{
    runId: queuedRunId,
    messageId: queuedMessageId,
    threadId,
    predecessorRunId: "run-current-before-queue",
  }]);
  assert.equal(session.pendingRunRequestId, "request-intervening-reply");

  await (appState.setActiveSessionState as (patch: Partial<TuiSessionMeta>) => Promise<void>)({
    pendingRunRequestId: undefined,
    pendingRunThreadId: undefined,
    acceptedRunId: "run-intervening-reply",
    acceptedRunMessageId: "message-intervening-reply",
    acceptedRunThreadId: threadId,
    lastRunStatus: "WAITING",
  });
  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "run-started-recovered-queue",
    type: "run.started",
    ts: "2026-08-29T00:00:01.000Z",
    sessionId: recovering.sessionId,
    threadId,
    runId: queuedRunId,
    payload: {
      sessionId: recovering.sessionId,
      runId: queuedRunId,
      eventType: "user.message",
      sourceMessageId: queuedMessageId,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  session = uiStore.getState().activeSession;
  assert.deepEqual(session.queuedRunReservations, [{
    runId: queuedRunId,
    messageId: queuedMessageId,
    threadId,
    predecessorRunId: "run-current-before-queue",
  }]);
  assert.equal(session.acceptedRunId, "run-intervening-reply");
  assert.equal(session.acceptedRunMessageId, "message-intervening-reply");
  assert.equal(session.acceptedRunThreadId, threadId);
  assert.equal(session.lastRunStatus, "WAITING");
});

test("a promoted queued run replaces only its exact accepted predecessor", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const promoted: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-predecessor",
    acceptedRunMessageId: "message-predecessor",
    acceptedRunThreadId: threadId,
    queuedRunReservations: [{
      runId: "run-promoted",
      messageId: "message-promoted",
      threadId,
      predecessorRunId: "run-predecessor",
    }],
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === promoted.sessionId ? promoted : session
    ),
  };
  uiStore.patch({ activeSession: promoted, sessions: [promoted] });

  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "run-started-exact-predecessor",
    type: "run.started",
    ts: "2026-08-29T00:00:01.000Z",
    sessionId: promoted.sessionId,
    threadId,
    runId: "run-promoted",
    payload: {
      sessionId: promoted.sessionId,
      runId: "run-promoted",
      eventType: "user.message",
      sourceMessageId: "message-promoted",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const session = uiStore.getState().activeSession;
  assert.equal(session.queuedRunReservations, undefined);
  assert.equal(session.acceptedRunId, "run-promoted");
  assert.equal(session.acceptedRunMessageId, "message-promoted");
  assert.equal(session.acceptedRunThreadId, threadId);
});

test("restart reconciliation does not order a reverse legacy fork from active-run arrival alone", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const chained: TuiSessionMeta = {
    ...base,
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
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === chained.sessionId ? chained : session
    ),
  };
  uiStore.patch({ activeSession: chained, sessions: [chained] });

  for (const runId of ["run-q1", "run-q2"]) {
    await (appState.syncSessionFromDescribePayload as (
      payload: Record<string, unknown>,
    ) => Promise<void>)({
      sessionId: chained.sessionId,
      version: 1,
      threadId,
      operatorThreadView: {
        thread: {
          threadId,
          sessionId: chained.sessionId,
          title: "Queued chain",
          status: "RUNNING",
          createdAt: chained.createdAt,
          updatedAt: chained.updatedAt,
        },
        childThreads: [],
        childBlockerChain: [],
        activeRun: { runId, status: "RUNNING" },
        conversationMessageRoutes: runId === "run-q1"
          ? [{
              messageId: "message-q2",
              disposition: "queued",
              runId: "run-q2",
              createdAt: chained.createdAt,
            }]
          : [],
      },
    });
  }

  const session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q1");
  assert.equal(session.acceptedRunMessageId, "message-q1");
  assert.equal(session.acceptedRunThreadId, threadId);
  assert.deepEqual(session.queuedRunReservations, [{
    runId: "run-q2",
    messageId: "message-q2",
    threadId,
    predecessorRunId: "run-r0",
  }, {
    runId: "run-q1",
    messageId: "message-q1",
    threadId,
    predecessorRunId: "run-r0",
  }]);
});

test("restart reconciliation repairs an active sibling from accepted terminal authority", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const recovering: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-q1",
    acceptedRunMessageId: "message-q1",
    acceptedRunThreadId: threadId,
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
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === recovering.sessionId ? recovering : session
    ),
  };
  uiStore.patch({ activeSession: recovering, sessions: [recovering] });

  await (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: recovering.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: recovering.sessionId,
        title: "Terminal authority repair",
        status: "RUNNING",
        createdAt: recovering.createdAt,
        updatedAt: recovering.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-q2", status: "RUNNING" },
    },
  });

  const session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q2");
  assert.equal(session.acceptedRunMessageId, "message-q2");
  assert.equal(session.queuedRunReservations, undefined);
  assert.equal(session.terminalQueuedRuns?.[0]?.runId, "run-q1");
});

test("restart reconciliation does not rebind an accepted-active queue record with a missing predecessor", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const recovering: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-q1",
    acceptedRunMessageId: "message-q1",
    acceptedRunThreadId: threadId,
    queuedRunReservations: [{
      runId: "run-q2",
      messageId: "message-q2",
      threadId,
      predecessorRunId: "run-r0",
    }],
    terminalQueuedRuns: undefined,
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === recovering.sessionId ? recovering : session
    ),
  };
  uiStore.patch({ activeSession: recovering, sessions: [recovering] });

  await (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: recovering.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: recovering.sessionId,
        title: "Accepted active fork repair",
        status: "RUNNING",
        createdAt: recovering.createdAt,
        updatedAt: recovering.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-q1", status: "RUNNING" },
      conversationMessageRoutes: [{
        messageId: "message-q2",
        disposition: "queued",
        runId: "run-q2",
        createdAt: recovering.createdAt,
      }],
    },
  });

  let session = uiStore.getState().activeSession;
  assert.deepEqual(session.queuedRunReservations, [{
    runId: "run-q2",
    messageId: "message-q2",
    threadId,
    predecessorRunId: "run-r0",
  }]);
  assert.deepEqual(
    new SessionStore(home).findByName(await new SessionStore(home).load(), recovering.name)
      ?.queuedRunReservations,
    session.queuedRunReservations,
  );

  await (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: recovering.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: recovering.sessionId,
        title: "Accepted active fork repair",
        status: "RUNNING",
        createdAt: recovering.createdAt,
        updatedAt: recovering.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-q2", status: "RUNNING" },
      conversationMessageRoutes: [],
    },
  });
  session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q1");
  assert.equal(session.queuedRunReservations?.[0]?.predecessorRunId, "run-r0");
});

test("restart reconciliation preserves explicit Q2 predecessor authority after a delayed Q1 terminal", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const recovering: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-q2",
    acceptedRunMessageId: "message-q2",
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
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === recovering.sessionId ? recovering : session
    ),
  };
  uiStore.patch({ activeSession: recovering, sessions: [recovering] });

  assert.equal(await (appState.syncForegroundQueuedTerminal as (
    input: Record<string, unknown>,
  ) => Promise<boolean>)({
    sessionId: recovering.sessionId,
    threadId,
    runId: "run-q1",
    result: {
      assistantText: "Delayed Q1",
      output: {
        status: "COMPLETED",
        sessionId: recovering.sessionId,
        runId: "run-q1",
        quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
        errors: [],
        telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
      },
    },
    authoritativeView: {
      thread: {
        threadId,
        sessionId: recovering.sessionId,
        title: "Delayed exact Q1",
        status: "RUNNING",
        createdAt: recovering.createdAt,
        updatedAt: recovering.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-q2", status: "RUNNING" },
      conversationTurns: [{
        turnId: "turn-q1-direct",
        threadId,
        sessionId: recovering.sessionId,
        sequence: 1,
        status: "COMPLETED",
        rootRunId: "run-q1",
        sourceMessageId: "message-q1",
        terminalRunId: "run-q1",
        terminalStatus: "COMPLETED",
        startedAt: recovering.createdAt,
        completedAt: recovering.updatedAt,
        updatedAt: recovering.updatedAt,
      }],
    },
  }), true);
  let session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q2");
  assert.equal(session.acceptedRunPredecessorId, "run-r0");
  assert.equal(session.queuedRunReservations, undefined);
  assert.equal(session.terminalQueuedRuns?.[0]?.runId, "run-q1");

  await (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: recovering.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: recovering.sessionId,
        title: "Q2 accepted after Q1",
        status: "RUNNING",
        createdAt: recovering.createdAt,
        updatedAt: recovering.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-q2", status: "RUNNING" },
      conversationTurns: [{
        turnId: "turn-q1",
        threadId,
        sessionId: recovering.sessionId,
        sequence: 1,
        status: "COMPLETED",
        rootRunId: "run-q1",
        sourceMessageId: "message-q1",
        terminalRunId: "run-q1",
        terminalStatus: "COMPLETED",
        startedAt: recovering.createdAt,
        completedAt: recovering.updatedAt,
        updatedAt: recovering.updatedAt,
      }],
    },
  });

  session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q2");
  assert.equal(session.acceptedRunPredecessorId, "run-r0");
  assert.equal(session.queuedRunReservations, undefined);
  assert.equal(session.terminalQueuedRuns?.[0]?.runId, "run-q1");
  const persisted = new SessionStore(home).findByName(
    await new SessionStore(home).load(),
    recovering.name,
  );
  assert.equal(persisted?.acceptedRunPredecessorId, "run-r0");
  assert.equal(persisted?.queuedRunReservations, undefined);
});

test("queued start authority is not published when its required session save fails", async (t) => {
  for (const failureMode of ["before-write", "after-write"] as const) {
    await t.test(failureMode, async () => {
      const { app, home } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const base = uiStore.getState().activeSession;
      const threadId = `thread-main:${base.sessionId}`;
      const queued: TuiSessionMeta = {
        ...base,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: threadId,
        queuedRunReservations: [{
          runId: "run-q1",
          messageId: "message-q1",
          threadId,
          predecessorRunId: "run-r0",
        }],
      };
      const sessionStore = appState.sessionStore as SessionStore;
      const originalSave = sessionStore.save.bind(sessionStore);
      const sessionsFile = appState.sessionsFile as {
        version: number;
        activeSessionName?: string;
        sessions: TuiSessionMeta[];
      };
      appState.sessionsFile = {
        ...sessionsFile,
        sessions: sessionsFile.sessions.map((session) =>
          session.sessionId === queued.sessionId ? queued : session
        ),
      };
      uiStore.patch({ activeSession: queued, sessions: [queued], running: false });
      await originalSave(appState.sessionsFile as never);
      sessionStore.save = async (file) => {
        if (failureMode === "after-write") await originalSave(file);
        throw new Error(`required save failed ${failureMode}`);
      };

      assert.equal(await (appState.syncForegroundSessionProgress as (
        input: { sessionId: string; threadId: string; runId: string; messageId: string },
      ) => Promise<boolean>)({
        sessionId: queued.sessionId,
        threadId,
        runId: "run-q1",
        messageId: "message-q1",
      }), false);
      assert.equal(uiStore.getState().activeSession.acceptedRunId, "run-r0");
      assert.equal(uiStore.getState().running, false);

      const reloaded = new SessionStore(home).findByName(
        await new SessionStore(home).load(),
        queued.name,
      );
      assert.equal(
        reloaded?.acceptedRunId,
        failureMode === "after-write" ? "run-q1" : "run-r0",
      );
      assert.equal(
        reloaded?.acceptedRunPredecessorId,
        failureMode === "after-write" ? "run-r0" : undefined,
      );
    });
  }
});

test("a deferred failed queue commit exposes no staged authority to concurrent describe reconciliation", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const queued: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-r0",
    acceptedRunMessageId: "message-r0",
    acceptedRunThreadId: threadId,
    queuedRunReservations: [{
      runId: "run-q1",
      messageId: "message-q1",
      threadId,
      predecessorRunId: "run-r0",
    }],
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === queued.sessionId ? queued : session
    ),
  };
  uiStore.patch({ activeSession: queued, sessions: [queued], running: false });
  const sessionStore = appState.sessionStore as SessionStore;
  const originalSave = sessionStore.save.bind(sessionStore);
  await originalSave(appState.sessionsFile as never);
  let releaseFirstSave: (() => void) | undefined;
  let firstSaveStartedResolve: (() => void) | undefined;
  const firstSaveStarted = new Promise<void>((resolve) => { firstSaveStartedResolve = resolve; });
  const firstSaveRelease = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
  let saveCount = 0;
  sessionStore.save = async (file) => {
    saveCount += 1;
    if (saveCount === 1) {
      firstSaveStartedResolve?.();
      await firstSaveRelease;
      throw new Error("deferred queue commit failed before write");
    }
    await originalSave(file);
  };

  const startCommit = (appState.syncForegroundSessionProgress as (
    input: { sessionId: string; threadId: string; runId: string; messageId: string },
  ) => Promise<boolean>)({
    sessionId: queued.sessionId,
    threadId,
    runId: "run-q1",
    messageId: "message-q1",
  });
  await firstSaveStarted;
  const describeCommit = (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: queued.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: queued.sessionId,
        title: "Concurrent exact Q1",
        status: "RUNNING",
        createdAt: queued.createdAt,
        updatedAt: queued.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-q1", status: "RUNNING" },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(uiStore.getState().activeSession.acceptedRunId, "run-r0");
  assert.equal(
    (appState.sessionsFile as typeof sessionsFile).sessions.find(
      (session) => session.sessionId === queued.sessionId,
    )?.acceptedRunId,
    "run-r0",
  );

  releaseFirstSave?.();
  assert.equal(await startCommit, false);
  await describeCommit;
  assert.equal(uiStore.getState().activeSession.acceptedRunId, "run-q1");
  assert.equal(saveCount, 2);
  assert.equal(
    new SessionStore(home).findByName(await new SessionStore(home).load(), queued.name)
      ?.acceptedRunId,
    "run-q1",
  );
});

test("the global sessions-file coordinator preserves an interleaved ordinary session update", async (t) => {
  for (const failureMode of ["success", "before-write", "after-write"] as const) {
    await t.test(failureMode, async () => {
      const { app, home } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const base = uiStore.getState().activeSession;
      const threadId = `thread-main:${base.sessionId}`;
      const queued: TuiSessionMeta = {
        ...base,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: threadId,
        queuedRunReservations: [{
          runId: "run-q1",
          messageId: "message-q1",
          threadId,
          predecessorRunId: "run-r0",
        }],
      };
      const ordinary: TuiSessionMeta = {
        ...base,
        name: "ordinary-b",
        sessionId: "session-b",
        updatedAt: base.updatedAt,
      };
      const sessionStore = appState.sessionStore as SessionStore;
      const originalSave = sessionStore.save.bind(sessionStore);
      let file = appState.sessionsFile as SessionsFile;
      file = sessionStore.upsert(file, queued);
      file = sessionStore.upsert(file, ordinary);
      appState.sessionsFile = file;
      uiStore.patch({ activeSession: queued, sessions: file.sessions, running: false });
      await originalSave(file as never);

      let releaseSave: (() => void) | undefined;
      let saveStartedResolve: (() => void) | undefined;
      const saveStarted = new Promise<void>((resolve) => { saveStartedResolve = resolve; });
      const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
      let saveCount = 0;
      sessionStore.save = async (snapshot) => {
        saveCount += 1;
        if (saveCount === 1) {
          saveStartedResolve?.();
          await saveRelease;
          if (failureMode !== "before-write") await originalSave(snapshot);
          if (failureMode !== "success") throw new Error(`queue ${failureMode}`);
          return;
        }
        await originalSave(snapshot);
      };

      const queueCommit = (appState.syncForegroundSessionProgress as (
        input: { sessionId: string; threadId: string; runId: string; messageId: string },
      ) => Promise<boolean>)({
        sessionId: queued.sessionId,
        threadId,
        runId: "run-q1",
        messageId: "message-q1",
      });
      await saveStarted;
      await (appState.setSessionState as (
        sessionId: string,
        patch: Partial<TuiSessionMeta>,
      ) => Promise<TuiSessionMeta | undefined>)(ordinary.sessionId, { lastRunStatus: "WAITING" });
      const ordinarySave = (appState.saveSessionsFile as (
        options?: { requireSessionSave?: boolean },
      ) => Promise<void>)({ requireSessionSave: true });
      releaseSave?.();
      assert.equal(await queueCommit, failureMode === "success");
      await ordinarySave;

      const reloaded = await new SessionStore(home).load();
      assert.equal(
        reloaded.sessions.find((session) => session.sessionId === ordinary.sessionId)?.lastRunStatus,
        "WAITING",
      );
      assert.equal(
        reloaded.sessions.find((session) => session.sessionId === queued.sessionId)?.acceptedRunId,
        failureMode === "success" ? "run-q1" : "run-r0",
      );
      assert.equal(
        (appState.sessionsFile as typeof file).sessions.find(
          (session) => session.sessionId === queued.sessionId,
        )?.acceptedRunId,
        failureMode === "success" ? "run-q1" : "run-r0",
      );
      assert.equal(saveCount, 2);
    });
  }
});

test("a first queued successor needs an exact terminal turn before promotion", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const queued: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-r0",
    acceptedRunMessageId: "message-r0",
    acceptedRunThreadId: threadId,
    queuedRunReservations: [{
      runId: "run-q1",
      messageId: "message-q1",
      threadId,
      predecessorRunId: "run-r0",
    }],
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === queued.sessionId ? queued : session
    ),
  };
  uiStore.patch({ activeSession: queued, sessions: [queued] });
  const result = {
    assistantText: "Q1 complete",
    output: {
      status: "COMPLETED" as const,
      sessionId: queued.sessionId,
      runId: "run-q1",
      quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
      errors: [],
      telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
    },
  };
  const staleView = {
    thread: {
      threadId,
      sessionId: queued.sessionId,
      title: "Stale Q1 active",
      status: "RUNNING" as const,
      createdAt: queued.createdAt,
      updatedAt: queued.updatedAt,
    },
    childThreads: [],
    childBlockerChain: [],
    activeRun: { runId: "run-q1", status: "RUNNING" as const },
  };

  assert.equal(await (appState.syncForegroundQueuedTerminal as (
    input: Record<string, unknown>,
  ) => Promise<boolean>)({
    sessionId: queued.sessionId,
    threadId,
    runId: "run-q1",
    result,
    authoritativeView: staleView,
  }), false);
  assert.equal(uiStore.getState().activeSession.acceptedRunId, "run-r0");
  assert.equal(uiStore.getState().activeSession.terminalQueuedRuns?.some(
    (terminal) => terminal.runId === "run-q1",
  ) ?? false, false);

  const exactView = {
    ...staleView,
    thread: { ...staleView.thread, status: "COMPLETED" as const, lastRunStatus: "COMPLETED" as const },
    activeRun: undefined,
    conversationTurns: [{
      turnId: "turn-q1",
      threadId,
      sessionId: queued.sessionId,
      sequence: 1,
      status: "COMPLETED" as const,
      rootRunId: "run-q1",
      sourceMessageId: "message-q1",
      terminalRunId: "run-q1",
      terminalStatus: "COMPLETED" as const,
      startedAt: queued.createdAt,
      completedAt: queued.updatedAt,
      updatedAt: queued.updatedAt,
    }],
  };
  assert.equal(await (appState.syncForegroundQueuedTerminal as (
    input: Record<string, unknown>,
  ) => Promise<boolean>)({
    sessionId: queued.sessionId,
    threadId,
    runId: "run-q1",
    result,
    authoritativeView: exactView,
  }), true);
  assert.equal(uiStore.getState().activeSession.acceptedRunId, "run-q1");
  assert.equal(uiStore.getState().activeSession.acceptedRunPredecessorId, "run-r0");
  const reloaded = new SessionStore(home).findByName(
    await new SessionStore(home).load(),
    queued.name,
  );
  assert.equal(reloaded?.acceptedRunId, "run-q1");
});

test("queued terminal authority is not published when its required session save fails", async (t) => {
  for (const failureMode of ["before-write", "after-write"] as const) {
    await t.test(failureMode, async () => {
      const { app, home } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const base = uiStore.getState().activeSession;
      const threadId = `thread-main:${base.sessionId}`;
      const queued: TuiSessionMeta = {
        ...base,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: threadId,
        queuedRunReservations: [{
          runId: "run-q1",
          messageId: "message-q1",
          threadId,
          predecessorRunId: "run-r0",
        }],
      };
      const result = {
        assistantText: "Q1 complete",
        output: {
          status: "COMPLETED" as const,
          sessionId: queued.sessionId,
          runId: "run-q1",
          quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
          errors: [],
          telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
        },
      };
      const sessionStore = appState.sessionStore as SessionStore;
      const originalSave = sessionStore.save.bind(sessionStore);
      const sessionsFile = appState.sessionsFile as {
        version: number;
        activeSessionName?: string;
        sessions: TuiSessionMeta[];
      };
      appState.sessionsFile = {
        ...sessionsFile,
        sessions: sessionsFile.sessions.map((session) =>
          session.sessionId === queued.sessionId ? queued : session
        ),
      };
      uiStore.patch({ activeSession: queued, sessions: [queued] });
      await originalSave(appState.sessionsFile as never);
      sessionStore.save = async (file) => {
        if (failureMode === "after-write") await originalSave(file);
        throw new Error(`terminal save failed ${failureMode}`);
      };

      assert.equal(await (appState.syncForegroundQueuedTerminal as (
        input: Record<string, unknown>,
      ) => Promise<boolean>)({
        sessionId: queued.sessionId,
        threadId,
        runId: "run-q1",
        result,
      }), false);
      assert.equal(uiStore.getState().activeSession.acceptedRunId, "run-r0");
      assert.equal(uiStore.getState().activeSession.lastRunStatus, undefined);

      const reloaded = new SessionStore(home).findByName(
        await new SessionStore(home).load(),
        queued.name,
      );
      assert.equal(
        reloaded?.acceptedRunId,
        "run-r0",
      );
      assert.equal(
        reloaded?.lastRunStatus,
        undefined,
      );

      sessionStore.save = originalSave;
      const exactView = {
        thread: {
          threadId,
          sessionId: queued.sessionId,
          title: "Q1 terminal authority",
          status: "COMPLETED" as const,
          lastRunStatus: "COMPLETED" as const,
          createdAt: queued.createdAt,
          updatedAt: queued.updatedAt,
        },
        childThreads: [],
        childBlockerChain: [],
        conversationTurns: [{
          turnId: "turn-q1",
          threadId,
          sessionId: queued.sessionId,
          sequence: 1,
          status: "COMPLETED" as const,
          rootRunId: "run-q1",
          sourceMessageId: "message-q1",
          terminalRunId: "run-q1",
          terminalStatus: "COMPLETED" as const,
          startedAt: queued.createdAt,
          completedAt: queued.updatedAt,
          updatedAt: queued.updatedAt,
        }],
      };
      assert.equal(await (appState.syncForegroundQueuedTerminal as (
        input: Record<string, unknown>,
      ) => Promise<boolean>)({
        sessionId: queued.sessionId,
        threadId,
        runId: "run-q1",
        result,
        authoritativeView: exactView,
      }), true);
      assert.equal(uiStore.getState().activeSession.acceptedRunId, "run-q1");
      assert.equal(uiStore.getState().activeSession.lastRunStatus, "COMPLETED");
    });
  }
});

test("duplicate accepted start preserves an already ordered Q1 to Q2 to Q3 queue", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const ordered: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-q1",
    acceptedRunMessageId: "message-q1",
    acceptedRunThreadId: threadId,
    acceptedRunPredecessorId: "run-r0",
    queuedRunReservations: [{
      runId: "run-q2",
      messageId: "message-q2",
      threadId,
      predecessorRunId: "run-q1",
    }, {
      runId: "run-q3",
      messageId: "message-q3",
      threadId,
      predecessorRunId: "run-q2",
    }],
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === ordered.sessionId ? ordered : session
    ),
  };
  uiStore.patch({ activeSession: ordered, sessions: [ordered] });

  assert.equal(await (appState.syncForegroundSessionProgress as (
    input: { sessionId: string; threadId: string; runId: string; messageId: string },
  ) => Promise<boolean>)({
    sessionId: ordered.sessionId,
    threadId,
    runId: "run-q1",
    messageId: "message-q1",
  }), true);
  assert.deepEqual(uiStore.getState().activeSession.queuedRunReservations, ordered.queuedRunReservations);
  assert.equal(uiStore.getState().activeSession.acceptedRunPredecessorId, "run-r0");
});

test("describe preserves an explicit accepted-predecessor conflict and does not bind the active successor", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const conflicted: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-q1",
    acceptedRunMessageId: "message-q1",
    acceptedRunThreadId: threadId,
    acceptedRunPredecessorId: "run-r0",
    queuedRunReservations: [{
      runId: "run-q2",
      messageId: "message-q2",
      threadId,
      predecessorRunId: "run-other",
    }],
  };
  const sessionsFile = appState.sessionsFile as SessionsFile;
  appState.sessionsFile = (appState.sessionStore as SessionStore).upsert(sessionsFile, conflicted);
  uiStore.patch({ activeSession: conflicted, sessions: (appState.sessionsFile as typeof sessionsFile).sessions });
  appState.recoverTerminalMessages = async () => {};

  await (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: conflicted.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: conflicted.sessionId,
        title: "Conflicted queue",
        status: "RUNNING",
        createdAt: conflicted.createdAt,
        updatedAt: conflicted.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-q2", status: "RUNNING" },
      conversationTurns: [{
        turnId: "turn-q1",
        threadId,
        sessionId: conflicted.sessionId,
        sequence: 1,
        status: "COMPLETED",
        rootRunId: "run-q1",
        sourceMessageId: "message-q1",
        terminalRunId: "run-q1",
        terminalStatus: "COMPLETED",
        startedAt: conflicted.createdAt,
        completedAt: conflicted.updatedAt,
        updatedAt: conflicted.updatedAt,
      }],
      conversationMessageRoutes: [{
        messageId: "message-q2",
        disposition: "queued",
        runId: "run-q2",
      }],
    },
  });

  const session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q1");
  assert.equal(session.acceptedRunPredecessorId, "run-r0");
  assert.equal(session.queuedRunReservations?.[0]?.predecessorRunId, "run-other");
});

test("describe preserves a legacy undefined-predecessor conflict without a complete successor turn sequence", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const conflicted: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-q1",
    acceptedRunMessageId: "message-q1",
    acceptedRunThreadId: threadId,
    acceptedRunPredecessorId: undefined,
    queuedRunReservations: [{
      runId: "run-q2",
      messageId: "message-q2",
      threadId,
      predecessorRunId: "run-other",
    }],
  };
  const sessionsFile = appState.sessionsFile as SessionsFile;
  appState.sessionsFile = (appState.sessionStore as SessionStore).upsert(sessionsFile, conflicted);
  uiStore.patch({ activeSession: conflicted, sessions: (appState.sessionsFile as typeof sessionsFile).sessions });
  appState.recoverTerminalMessages = async () => {};

  await (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: conflicted.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: conflicted.sessionId,
        title: "Legacy predecessor conflict",
        status: "RUNNING",
        createdAt: conflicted.createdAt,
        updatedAt: conflicted.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-q2", status: "RUNNING" },
      conversationTurns: [{
        turnId: "turn-q1",
        threadId,
        sessionId: conflicted.sessionId,
        sequence: 1,
        status: "COMPLETED",
        rootRunId: "run-q1",
        sourceMessageId: "message-q1",
        terminalRunId: "run-q1",
        terminalStatus: "COMPLETED",
        startedAt: conflicted.createdAt,
        completedAt: conflicted.updatedAt,
        updatedAt: conflicted.updatedAt,
      }],
      conversationMessageRoutes: [{
        messageId: "message-q2",
        disposition: "queued",
        runId: "run-q2",
      }],
    },
  });

  const session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q1");
  assert.equal(session.acceptedRunPredecessorId, undefined);
  assert.equal(session.queuedRunReservations?.[0]?.predecessorRunId, "run-other");
  assert.equal(session.terminalQueuedRuns, undefined);
});

test("incremental exact terminal reconciliation extends Q1 to Q2 with Q3", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const queued: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-r0",
    acceptedRunMessageId: "message-r0",
    acceptedRunThreadId: threadId,
    queuedRunReservations: ["q1", "q2", "q3"].map((suffix) => ({
      runId: `run-${suffix}`,
      messageId: `message-${suffix}`,
      threadId,
      predecessorRunId: "run-r0",
    })),
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === queued.sessionId ? queued : session
    ),
  };
  uiStore.patch({ activeSession: queued, sessions: [queued] });
  appState.recoverTerminalMessages = async () => {};
  const describe = async (terminalCount: number): Promise<void> => {
    await (appState.syncSessionFromDescribePayload as (
      payload: Record<string, unknown>,
    ) => Promise<void>)({
      sessionId: queued.sessionId,
      version: 1,
      threadId,
      operatorThreadView: {
        thread: {
          threadId,
          sessionId: queued.sessionId,
          title: "Incremental exact queue",
          status: "COMPLETED",
          lastRunStatus: "COMPLETED",
          createdAt: queued.createdAt,
          updatedAt: queued.updatedAt,
        },
        childThreads: [],
        childBlockerChain: [],
        conversationTurns: Array.from({ length: terminalCount }, (_, index) => ({
          turnId: `turn-q${index + 1}`,
          threadId,
          sessionId: queued.sessionId,
          sequence: index + 1,
          status: "COMPLETED",
          rootRunId: `run-q${index + 1}`,
          sourceMessageId: `message-q${index + 1}`,
          terminalRunId: `run-q${index + 1}`,
          terminalStatus: "COMPLETED",
          startedAt: queued.createdAt,
          completedAt: queued.updatedAt,
          updatedAt: queued.updatedAt,
        })),
      },
    });
  };

  await describe(2);
  let session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q2");
  assert.equal(session.acceptedRunPredecessorId, "run-q1");
  assert.equal(session.queuedRunReservations?.[0]?.runId, "run-q3");
  assert.deepEqual(session.terminalQueuedRuns?.map((record) => [
    record.runId,
    record.predecessorRunId,
  ]), [["run-q1", "run-r0"], ["run-q2", "run-q1"]]);

  await describe(3);
  session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q3");
  assert.equal(session.acceptedRunPredecessorId, "run-q2");
  assert.equal(session.queuedRunReservations, undefined);
  assert.deepEqual(session.terminalQueuedRuns?.map((record) => [
    record.runId,
    record.predecessorRunId,
  ]), [["run-q1", "run-r0"], ["run-q2", "run-q1"], ["run-q3", "run-q2"]]);
});

test("exact terminal sequence does not chain queued runs from distinct durable epochs", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const queued: TuiSessionMeta = {
    ...base,
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
      predecessorRunId: "run-r1",
    }],
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === queued.sessionId ? queued : session
    ),
  };
  uiStore.patch({ activeSession: queued, sessions: [queued] });
  appState.recoverTerminalMessages = async () => {};

  await (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: queued.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: queued.sessionId,
        title: "Distinct queue epochs",
        status: "COMPLETED",
        lastRunStatus: "COMPLETED",
        createdAt: queued.createdAt,
        updatedAt: queued.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      conversationTurns: [
        { runId: "run-q1", messageId: "message-q1", sequence: 1 },
        { runId: "run-q2", messageId: "message-q2", sequence: 2 },
      ].map((turn) => ({
        turnId: `turn-${turn.runId}`,
        threadId,
        sessionId: queued.sessionId,
        sequence: turn.sequence,
        status: "COMPLETED",
        rootRunId: turn.runId,
        sourceMessageId: turn.messageId,
        terminalRunId: turn.runId,
        terminalStatus: "COMPLETED",
        startedAt: queued.createdAt,
        completedAt: queued.updatedAt,
        updatedAt: queued.updatedAt,
      })),
    },
  });

  const session = uiStore.getState().activeSession;
  assert.equal(session.acceptedRunId, "run-q1");
  assert.deepEqual(session.terminalQueuedRuns?.map((record) => [
    record.runId,
    record.predecessorRunId,
  ]), [["run-q1", "run-r0"], ["run-q2", "run-r1"]]);
  assert.equal(
    session.terminalQueuedRuns?.find((record) => record.runId === "run-q2")?.predecessorRunId,
    "run-r1",
  );
});

test("legacy partial route evidence preserves an existing deep Q1 to Q2 to Q3 chain", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const queuedRunReservations = [{
    runId: "run-q2",
    messageId: "message-q2",
    threadId,
    predecessorRunId: "run-q1",
  }, {
    runId: "run-q3",
    messageId: "message-q3",
    threadId,
    predecessorRunId: "run-q2",
  }];
  const legacy: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-q1",
    acceptedRunMessageId: "message-q1",
    acceptedRunThreadId: threadId,
    acceptedRunPredecessorId: undefined,
    queuedRunReservations,
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === legacy.sessionId ? legacy : session
    ),
  };
  uiStore.patch({ activeSession: legacy, sessions: [legacy] });

  await (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: legacy.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: legacy.sessionId,
        title: "Legacy partial route",
        status: "RUNNING",
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-q1", status: "RUNNING" },
      conversationMessageRoutes: [{
        messageId: "message-q3",
        disposition: "queued",
        runId: "run-q3",
        createdAt: legacy.updatedAt,
      }],
    },
  });

  assert.equal(uiStore.getState().activeSession.acceptedRunId, "run-q1");
  assert.equal(uiStore.getState().activeSession.acceptedRunPredecessorId, undefined);
  assert.deepEqual(uiStore.getState().activeSession.queuedRunReservations, queuedRunReservations);
});

test("restart reconciliation orders a terminal fork only from exact conversation-turn sequence", async (t) => {
  for (const exact of [true, false]) {
    await t.test(exact ? "exact" : "ambiguous", async () => {
      const { app, home } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const base = uiStore.getState().activeSession;
      const threadId = `thread-main:${base.sessionId}`;
      const reservations = [{
        runId: "run-q1",
        messageId: "message-q1",
        threadId,
        predecessorRunId: "run-r0",
      }, {
        runId: "run-q2",
        messageId: "message-q2",
        threadId,
        predecessorRunId: "run-r0",
      }];
      const recovering: TuiSessionMeta = {
        ...base,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: threadId,
        queuedRunReservations: reservations,
        terminalQueuedRuns: undefined,
      };
      const sessionsFile = appState.sessionsFile as {
        version: number;
        activeSessionName?: string;
        sessions: TuiSessionMeta[];
      };
      appState.sessionsFile = {
        ...sessionsFile,
        sessions: sessionsFile.sessions.map((session) =>
          session.sessionId === recovering.sessionId ? recovering : session
        ),
      };
      uiStore.patch({ activeSession: recovering, sessions: [recovering] });
      appState.recoverTerminalMessages = async () => {};

      await (appState.syncSessionFromDescribePayload as (
        payload: Record<string, unknown>,
      ) => Promise<void>)({
        sessionId: recovering.sessionId,
        version: 1,
        threadId,
        operatorThreadView: {
          thread: {
            threadId,
            sessionId: recovering.sessionId,
            title: "Terminal fork",
            status: "COMPLETED",
            createdAt: recovering.createdAt,
            updatedAt: recovering.updatedAt,
          },
          childThreads: [],
          childBlockerChain: [],
          conversationTurns: [{
            turnId: "turn-q2",
            threadId,
            sessionId: recovering.sessionId,
            sequence: 2,
            status: "COMPLETED",
            rootRunId: "run-q2",
            sourceMessageId: "message-q2",
            terminalRunId: "run-q2",
            terminalStatus: "COMPLETED",
            startedAt: recovering.createdAt,
            completedAt: recovering.updatedAt,
            updatedAt: recovering.updatedAt,
          }, {
            turnId: "turn-q1",
            threadId,
            sessionId: recovering.sessionId,
            sequence: exact ? 1 : 2,
            status: "COMPLETED",
            rootRunId: "run-q1",
            ...(exact ? { sourceMessageId: "message-q1" } : {}),
            terminalRunId: "run-q1",
            terminalStatus: "COMPLETED",
            startedAt: recovering.createdAt,
            completedAt: recovering.updatedAt,
            updatedAt: recovering.updatedAt,
          }],
        },
      });

      const session = uiStore.getState().activeSession;
      const reloaded = new SessionStore(home).findByName(
        await new SessionStore(home).load(),
        recovering.name,
      );
      if (exact) {
        assert.equal(session.acceptedRunId, "run-q2");
        assert.equal(session.acceptedRunPredecessorId, "run-q1");
        assert.equal(session.queuedRunReservations, undefined);
        assert.deepEqual(session.terminalQueuedRuns, [{
          ...reservations[0]!,
          status: "COMPLETED",
        }, {
          ...reservations[1]!,
          predecessorRunId: "run-q1",
          status: "COMPLETED",
        }]);
        assert.deepEqual(reloaded?.terminalQueuedRuns, session.terminalQueuedRuns);
      } else {
        assert.equal(session.acceptedRunId, "run-r0");
        assert.deepEqual(session.queuedRunReservations, reservations);
        assert.equal(session.terminalQueuedRuns, undefined);
        assert.throws(
          () => exactTuiQueueTailRunId(session, normalizeTuiQueueGraph(session)),
          /unresolved queue fork/u,
        );
        assert.deepEqual(reloaded?.queuedRunReservations, reservations);
      }
    });
  }
});

test("restart reconciliation rejects a single terminal candidate without its exact source message", async (t) => {
  for (const sourceMessageId of [undefined, "message-wrong"] as const) {
    await t.test(sourceMessageId === undefined ? "missing" : "wrong", async () => {
      const { app } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const base = uiStore.getState().activeSession;
      const threadId = `thread-main:${base.sessionId}`;
      const recovering: TuiSessionMeta = {
        ...base,
        acceptedRunId: "run-r0",
        acceptedRunMessageId: "message-r0",
        acceptedRunThreadId: threadId,
        queuedRunReservations: [{
          runId: "run-q1",
          messageId: "message-q1",
          threadId,
          predecessorRunId: "run-r0",
        }],
      };
      const sessionsFile = appState.sessionsFile as {
        version: number;
        activeSessionName?: string;
        sessions: TuiSessionMeta[];
      };
      appState.sessionsFile = {
        ...sessionsFile,
        sessions: sessionsFile.sessions.map((session) =>
          session.sessionId === recovering.sessionId ? recovering : session
        ),
      };
      uiStore.patch({ activeSession: recovering, sessions: [recovering] });

      await (appState.syncSessionFromDescribePayload as (
        payload: Record<string, unknown>,
      ) => Promise<void>)({
        sessionId: recovering.sessionId,
        version: 1,
        threadId,
        operatorThreadView: {
          thread: {
            threadId,
            sessionId: recovering.sessionId,
            title: "Single terminal correlation",
            status: "COMPLETED",
            createdAt: recovering.createdAt,
            updatedAt: recovering.updatedAt,
          },
          childThreads: [],
          childBlockerChain: [],
          conversationTurns: [{
            turnId: "turn-q1",
            threadId,
            sessionId: recovering.sessionId,
            sequence: 1,
            status: "COMPLETED",
            rootRunId: "run-q1",
            ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
            terminalRunId: "run-q1",
            terminalStatus: "COMPLETED",
            startedAt: recovering.createdAt,
            completedAt: recovering.updatedAt,
            updatedAt: recovering.updatedAt,
          }],
        },
      });

      const session = uiStore.getState().activeSession;
      assert.equal(session.acceptedRunId, "run-r0");
      assert.equal(session.terminalQueuedRuns, undefined);
      assert.equal(session.queuedRunReservations?.[0]?.runId, "run-q1");
    });
  }
});

test("restart reconciliation rewires an absent queued predecessor before promoting its successor", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const recovering: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-r0",
    acceptedRunMessageId: "message-r0",
    acceptedRunThreadId: threadId,
    pendingQueueSubmissions: [{
      runId: "run-absent-q1",
      messageId: "message-absent-q1",
      threadId,
      predecessorRunId: "run-r0",
      indeterminate: true,
    }, {
      runId: "run-accepted-q2",
      messageId: "message-accepted-q2",
      threadId,
      predecessorRunId: "run-absent-q1",
      indeterminate: true,
    }],
  };
  const sessionsFile = appState.sessionsFile as {
    version: number;
    activeSessionName?: string;
    sessions: TuiSessionMeta[];
  };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === recovering.sessionId ? recovering : session
    ),
  };
  uiStore.patch({ activeSession: recovering, sessions: [recovering] });

  await (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: recovering.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: recovering.sessionId,
        title: "Rewired queue",
        status: "RUNNING",
        createdAt: recovering.createdAt,
        updatedAt: recovering.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-r0", status: "RUNNING" },
      conversationMessageRoutes: [{
        messageId: "message-accepted-q2",
        disposition: "queued",
        runId: "run-accepted-q2",
        createdAt: recovering.updatedAt,
      }],
    },
  });

  const rewired = uiStore.getState().activeSession;
  assert.equal(rewired.pendingQueueSubmissions, undefined);
  assert.deepEqual(rewired.queuedRunReservations, [{
    runId: "run-accepted-q2",
    messageId: "message-accepted-q2",
    threadId,
    predecessorRunId: "run-r0",
  }]);

  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "run-started-rewired-q2",
    type: "run.started",
    ts: "2026-08-29T00:00:02.000Z",
    sessionId: recovering.sessionId,
    threadId,
    runId: "run-accepted-q2",
    payload: {
      sessionId: recovering.sessionId,
      runId: "run-accepted-q2",
      eventType: "user.message",
      sourceMessageId: "message-accepted-q2",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(uiStore.getState().activeSession.acceptedRunId, "run-accepted-q2");
});

test("restart reconciles an exact pending queue submission already active, waiting, or terminal", async (t) => {
  for (const status of ["RUNNING", "WAITING", "COMPLETED", "FAILED"] as const) {
    await t.test(status, async () => {
      const { app } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const base = uiStore.getState().activeSession;
      const threadId = `thread-main:${base.sessionId}`;
      const runId = `run-pending-promoted:${status}`;
      const messageId = `message-pending-promoted:${status}`;
      const recovering: TuiSessionMeta = {
        ...base,
        pendingQueueSubmissions: [{ runId, messageId, threadId }],
      };
      const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
      appState.sessionsFile = {
        ...sessionsFile,
        sessions: sessionsFile.sessions.map((session) =>
          session.sessionId === recovering.sessionId ? recovering : session
        ),
      };
      uiStore.patch({ activeSession: recovering, sessions: [recovering] });
      const recoveredTerminals: string[] = [];
      appState.recoverTerminalMessages = async (session: TuiSessionMeta) => {
        recoveredTerminals.push(session.acceptedRunId ?? "missing");
      };

      await (appState.syncSessionFromDescribePayload as (payload: Record<string, unknown>) => Promise<void>)({
        sessionId: recovering.sessionId,
        version: 1,
        threadId,
        operatorThreadView: {
          thread: {
            threadId,
            sessionId: recovering.sessionId,
            title: "Promoted queued submission",
            status,
            ...(status === "WAITING" ? { waitFor: { kind: "user", eventType: "user.reply" } } : {}),
            createdAt: recovering.createdAt,
            updatedAt: recovering.updatedAt,
          },
          childThreads: [],
          childBlockerChain: [],
          ...(status === "RUNNING" || status === "WAITING"
            ? { activeRun: { runId, status } }
            : {
                conversationTurns: [{
                  turnId: `turn:${status}`,
                  threadId,
                  sessionId: recovering.sessionId,
                  sequence: 1,
                  status,
                  sourceMessageId: messageId,
                  rootRunId: runId,
                  terminalRunId: runId,
                  terminalStatus: status,
                  startedAt: recovering.createdAt,
                  completedAt: recovering.updatedAt,
                  updatedAt: recovering.updatedAt,
                }],
              }),
          conversationMessageRoutes: [{
            messageId,
            disposition: "started",
            runId,
            turnId: `turn:${status}`,
            createdAt: recovering.createdAt,
          }],
        },
      });

      const session = uiStore.getState().activeSession;
      assert.equal(session.pendingQueueSubmissions, undefined);
      assert.equal(session.queuedRunReservations, undefined);
      assert.equal(session.acceptedRunId, runId);
      assert.equal(session.acceptedRunMessageId, messageId);
      assert.equal(session.acceptedRunThreadId, threadId);
      assert.equal(session.lastRunStatus, status === "RUNNING" ? undefined : status);
      assert.deepEqual(
        recoveredTerminals,
        status === "COMPLETED" || status === "FAILED" ? [runId] : [],
      );
    });
  }
});

test("restart reconciles an exact terminal for a confirmed queued reservation and rejects delayed start", async (t) => {
  for (const terminal of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
    await t.test(terminal, async () => {
      const { app } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const base = uiStore.getState().activeSession;
      const threadId = `thread-main:${base.sessionId}`;
      const runId = `run-confirmed-terminal:${terminal}`;
      const messageId = `message-confirmed-terminal:${terminal}`;
      const queued: TuiSessionMeta = {
        ...base,
        queuedRunReservations: [{ runId, messageId, threadId }],
      };
      const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
      appState.sessionsFile = {
        ...sessionsFile,
        sessions: sessionsFile.sessions.map((session) =>
          session.sessionId === queued.sessionId ? queued : session
        ),
      };
      uiStore.patch({ activeSession: queued, sessions: [queued] });
      const recoveredTerminals: string[] = [];
      appState.recoverTerminalMessages = async (session: TuiSessionMeta) => {
        recoveredTerminals.push(session.acceptedRunId ?? "missing");
      };
      const durableStatus = terminal === "COMPLETED" ? "COMPLETED" : "FAILED";

      await (appState.syncSessionFromDescribePayload as (payload: Record<string, unknown>) => Promise<void>)({
        sessionId: queued.sessionId,
        version: 1,
        threadId,
        operatorThreadView: {
          thread: {
            threadId,
            sessionId: queued.sessionId,
            title: "Queued terminal before callback save",
            status: durableStatus,
            createdAt: queued.createdAt,
            updatedAt: queued.updatedAt,
          },
          childThreads: [],
          childBlockerChain: [],
          conversationTurns: [{
            turnId: `turn:${terminal}`,
            threadId,
            sessionId: queued.sessionId,
            sequence: 1,
            status: durableStatus,
            sourceMessageId: messageId,
            rootRunId: runId,
            terminalRunId: runId,
            terminalStatus: durableStatus,
            startedAt: queued.createdAt,
            completedAt: queued.updatedAt,
            updatedAt: queued.updatedAt,
          }],
        },
      });

      let session = uiStore.getState().activeSession;
      assert.equal(session.queuedRunReservations, undefined);
      assert.equal(session.acceptedRunId, runId);
      assert.equal(session.acceptedRunMessageId, messageId);
      assert.equal(session.acceptedRunThreadId, threadId);
      assert.equal(session.lastRunStatus, durableStatus);
      assert.deepEqual(recoveredTerminals, [runId]);

      (appState.onRunnerEvent as (event: unknown) => void)({
        id: `delayed-start:${terminal}`,
        type: "run.started",
        ts: "2026-08-29T00:00:01.000Z",
        sessionId: queued.sessionId,
        threadId,
        runId,
        payload: {
          sessionId: queued.sessionId,
          runId,
          eventType: "user.message",
          sourceMessageId: messageId,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      session = uiStore.getState().activeSession;
      assert.equal(session.lastRunStatus, durableStatus);
      assert.equal(uiStore.getState().running, false);
    });
  }
});

test("startup scans inactive foreground queue evidence by exact session identity", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const visible = uiStore.getState().activeSession;
  const ownerSessionId = "inactive-queue-restart-owner";
  const threadId = `thread-main:${ownerSessionId}`;
  const runId = "run-inactive-restart-owner";
  const messageId = "message-inactive-restart-owner";
  const owner: TuiSessionMeta = {
    ...visible,
    name: "inactive-queue-owner",
    sessionId: ownerSessionId,
    pendingQueueSubmissions: [{ runId, messageId, threadId }],
  };
  const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: [...sessionsFile.sessions, owner],
  };
  uiStore.patch({ sessions: [...uiStore.getState().sessions, owner] });
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      assert.equal(type, "session.describe");
      assert.equal(payload.sessionId, ownerSessionId);
      return {
        type: "session.described",
        payload: {
          sessionId: ownerSessionId,
          version: 1,
          threadId,
          operatorThreadView: {
            thread: {
              threadId,
              sessionId: ownerSessionId,
              title: "Inactive promoted queue",
              status: "RUNNING",
              createdAt: owner.createdAt,
              updatedAt: owner.updatedAt,
            },
            childThreads: [],
            childBlockerChain: [],
            activeRun: { runId, status: "RUNNING" },
            conversationMessageRoutes: [{
              messageId,
              disposition: "started",
              runId,
              createdAt: owner.createdAt,
            }],
          },
        },
      };
    },
  };

  await (appState.reconcilePendingForegroundQueueSessions as (
    skipSessionId?: string,
  ) => Promise<void>)(visible.sessionId);

  const reconciled = uiStore.getState().sessions.find(
    (session) => session.sessionId === ownerSessionId,
  );
  assert.equal(reconciled?.pendingQueueSubmissions, undefined);
  assert.equal(reconciled?.acceptedRunId, runId);
  assert.equal(reconciled?.acceptedRunMessageId, messageId);
  assert.equal(reconciled?.acceptedRunThreadId, threadId);
  assert.equal(uiStore.getState().activeSession.sessionId, visible.sessionId);
  assert.equal(
    (appState.sessionsFile as { activeSessionName?: string }).activeSessionName,
    visible.name,
  );
});

test("session-scoped inactive start mutation preserves visible and durable active selection", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const visible = uiStore.getState().activeSession;
  const inactive: TuiSessionMeta = {
    ...visible,
    name: "inactive-start-owner",
    sessionId: "inactive-start-owner",
    started: false,
  };
  const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = { ...sessionsFile, sessions: [...sessionsFile.sessions, inactive] };
  uiStore.patch({ sessions: [...uiStore.getState().sessions, inactive] });

  await (appState.setSessionState as (
    sessionId: string,
    patch: Partial<TuiSessionMeta>,
  ) => Promise<TuiSessionMeta | undefined>)(inactive.sessionId, {
    started: true,
    acceptedRunId: "run-inactive-start",
  });

  assert.equal(uiStore.getState().activeSession.sessionId, visible.sessionId);
  assert.equal(
    (appState.sessionsFile as { activeSessionName?: string }).activeSessionName,
    visible.name,
  );
  assert.equal(
    uiStore.getState().sessions.find((session) => session.sessionId === inactive.sessionId)?.acceptedRunId,
    "run-inactive-start",
  );
});

test("restart tombstones exact undefined-root terminals without inventing queue order", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const terminals = ["COMPLETED", "FAILED", "COMPLETED"] as const;
  const reservations = terminals.map((status, index) => ({
    runId: `run-offline-terminal-${index}`,
    messageId: `message-offline-terminal-${index}`,
    threadId,
    status,
  }));
  const recovering: TuiSessionMeta = {
    ...base,
    acceptedRunId: "run-current",
    acceptedRunMessageId: "message-current",
    acceptedRunThreadId: threadId,
    queuedRunReservations: reservations.map(({ status: _status, ...identity }) => identity),
  };
  const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === recovering.sessionId ? recovering : session
    ),
  };
  uiStore.patch({ activeSession: recovering, sessions: [recovering] });
  appState.recoverTerminalMessages = async () => {};

  await (appState.syncSessionFromDescribePayload as (payload: Record<string, unknown>) => Promise<void>)({
    sessionId: recovering.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: recovering.sessionId,
        title: "Multiple offline queue terminals",
        status: "RUNNING",
        createdAt: recovering.createdAt,
        updatedAt: recovering.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-current", status: "RUNNING" },
      conversationTurns: reservations.map((terminal, index) => ({
        turnId: `turn-offline-terminal-${index}`,
        threadId,
        sessionId: recovering.sessionId,
        sequence: index + 1,
        status: terminal.status,
        rootRunId: terminal.runId,
        sourceMessageId: terminal.messageId,
        terminalRunId: terminal.runId,
        terminalStatus: terminal.status,
        startedAt: recovering.createdAt,
        completedAt: recovering.updatedAt,
        updatedAt: recovering.updatedAt,
      })),
    },
  });

  const reconciled = uiStore.getState().activeSession as TuiSessionMeta & {
    terminalQueuedRuns?: Array<{ runId: string; messageId: string; threadId: string; status: string }>;
  };
  assert.equal(reconciled.acceptedRunId, "run-current");
  assert.equal(reconciled.acceptedRunMessageId, "message-current");
  assert.equal(reconciled.queuedRunReservations, undefined);
  const orderedTerminals = reservations;
  assert.deepEqual(reconciled.terminalQueuedRuns, orderedTerminals);
  const reloaded = new SessionStore(home).findByName(
    await new SessionStore(home).load(),
    recovering.name,
  );
  assert.deepEqual(reloaded?.terminalQueuedRuns, orderedTerminals);
  for (const terminal of reservations) {
    assert.equal(await (appState.syncForegroundSessionProgress as (
      input: { sessionId: string; threadId: string; runId: string; messageId: string },
    ) => Promise<boolean>)({
      sessionId: recovering.sessionId,
      threadId: terminal.threadId,
      runId: terminal.runId,
      messageId: terminal.messageId,
    }), false);
  }
  assert.deepEqual(
    (uiStore.getState().activeSession as TuiSessionMeta).terminalQueuedRuns,
    orderedTerminals,
  );
});

test("startup scans delegated running and waiting queue owners without changing active selection", async (t) => {
  for (const status of ["RUNNING", "WAITING"] as const) {
    await t.test(status, async () => {
      const { app } = await createAppHarness();
      const appState = app as unknown as Record<string, unknown>;
      const uiStore = appState.uiStore as UiStore;
      const visible = uiStore.getState().activeSession;
      const ownerSessionId = `delegated-queue-${status.toLowerCase()}`;
      const threadId = `thread-main:${ownerSessionId}`;
      const runId = `run-delegated-${status.toLowerCase()}`;
      const messageId = `message-delegated-${status.toLowerCase()}`;
      const now = visible.updatedAt;
      const owner: TuiSessionMeta = {
        ...visible,
        name: `delegated-${status.toLowerCase()}`,
        sessionId: ownerSessionId,
        queuedRunReservations: [{ runId, messageId, threadId }],
        delegation: {
          taskId: `task-${ownerSessionId}`,
          title: "Delegated queued owner",
          status,
          childSessionId: ownerSessionId,
          childSessionName: `delegated-${status.toLowerCase()}`,
          profileId: visible.profileId,
          provider: "openrouter",
          model: "test-model",
          createdAt: now,
          updatedAt: now,
        },
      };
      const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
      appState.sessionsFile = { ...sessionsFile, sessions: [...sessionsFile.sessions, owner] };
      uiStore.patch({ sessions: [...uiStore.getState().sessions, owner] });
      appState.client = {
        sendCommand: async (type: string, payload: Record<string, unknown>) => {
          assert.equal(type, "session.describe");
          assert.equal(payload.sessionId, ownerSessionId);
          return {
            type: "session.described",
            payload: {
              sessionId: ownerSessionId,
              version: 1,
              threadId,
              operatorThreadView: {
                thread: {
                  threadId,
                  sessionId: ownerSessionId,
                  title: "Delegated queue owner",
                  status,
                  waitFor: status === "WAITING" ? { kind: "user", eventType: "user.reply" } : undefined,
                  createdAt: now,
                  updatedAt: now,
                },
                childThreads: [],
                childBlockerChain: [],
                activeRun: { runId, status },
              },
            },
          };
        },
      };

      await (appState.reconcilePendingForegroundQueueSessions as (
        skipSessionId?: string,
      ) => Promise<void>)(visible.sessionId);

      const reconciled = uiStore.getState().sessions.find(
        (session) => session.sessionId === ownerSessionId,
      );
      assert.equal(reconciled?.queuedRunReservations, undefined);
      assert.equal(reconciled?.acceptedRunId, runId);
      assert.equal(reconciled?.acceptedRunMessageId, messageId);
      assert.equal(reconciled?.delegation?.status, status);
      assert.equal(uiStore.getState().activeSession.sessionId, visible.sessionId);
      assert.equal(
        (appState.sessionsFile as { activeSessionName?: string }).activeSessionName,
        visible.name,
      );
    });
  }
});

test("queued-route restart recovery rejects conflicts and removes an exactly absent route", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const base = uiStore.getState().activeSession;
  const threadId = `thread-main:${base.sessionId}`;
  const pendingQueueSubmissions = [{
    runId: "run-wrong-thread",
    messageId: "message-wrong-thread",
    threadId: `thread-other:${base.sessionId}`,
  }, {
    runId: "run-wrong-message",
    messageId: "message-without-route",
    threadId,
  }, {
    runId: "run-conflicting-route",
    messageId: "message-conflicting-route",
    threadId,
  }];
  const recovering: TuiSessionMeta = { ...base, pendingQueueSubmissions };
  const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: sessionsFile.sessions.map((session) =>
      session.sessionId === recovering.sessionId ? recovering : session
    ),
  };
  uiStore.patch({ activeSession: recovering, sessions: [recovering] });

  await (appState.syncSessionFromDescribePayload as (payload: Record<string, unknown>) => Promise<void>)({
    sessionId: recovering.sessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: recovering.sessionId,
        title: "Conflicting queue routes",
        status: "RUNNING",
        createdAt: recovering.createdAt,
        updatedAt: recovering.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-current", status: "RUNNING" },
      conversationMessageRoutes: [{
        messageId: "message-wrong-thread",
        disposition: "queued",
        followUpId: "follow-up:wrong-thread",
        createdAt: "2026-08-29T00:00:00.000Z",
      }, {
        messageId: "message-conflicting-route",
        disposition: "queued",
        runId: "run-different",
        followUpId: "follow-up:conflicting-run",
        createdAt: "2026-08-29T00:00:01.000Z",
      }],
    },
  });

  assert.deepEqual(uiStore.getState().activeSession.pendingQueueSubmissions, [{
    ...pendingQueueSubmissions[0],
  }, {
    ...pendingQueueSubmissions[2],
    predecessorRunId: "run-wrong-thread",
  }]);
  assert.equal(uiStore.getState().activeSession.queuedRunReservations, undefined);
});

test("inactive foreground queued terminal ownership is written to the owning session file", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const visible = uiStore.getState().activeSession;
  const activeProfile = uiStore.getState().activeProfile;
  const owningProfile = {
    ...activeProfile,
    id: "inactive-owner-profile",
    modelProvider: "openai" as const,
    model: "owner-profile-model",
  };
  appState.profileStore = {
    load: async () => [owningProfile],
    findById: (profiles: typeof owningProfile[], id: string) =>
      profiles.find((profile) => profile.id === id),
  };
  const ownerSessionId = "inactive-foreground-owner";
  const threadId = `thread-main:${ownerSessionId}`;
  const runId = "run-inactive-owner-terminal";
  const messageId = "message-inactive-owner-terminal";
  const owner: TuiSessionMeta = {
    ...visible,
    name: "inactive-owner",
    sessionId: ownerSessionId,
    profileId: owningProfile.id,
    queuedRunReservations: [{ runId, messageId, threadId }],
  };
  const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: [...sessionsFile.sessions, owner],
  };
  uiStore.patch({ sessions: [...uiStore.getState().sessions, owner] });

  assert.equal(await (appState.syncForegroundQueuedTerminal as (input: Record<string, unknown>) => Promise<boolean>)({
    sessionId: ownerSessionId,
    threadId,
    runId,
    result: {
      assistantText: "Inactive result",
      output: {
        status: "COMPLETED",
        sessionId: ownerSessionId,
        runId,
        quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
        errors: [],
        telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
      },
      operatorAffordance: {
        interactionMode: "plan",
        allowedToolClasses: ["read_only"],
      },
    },
    authoritativeView: {
      thread: {
        threadId,
        sessionId: ownerSessionId,
        title: "Inactive exact terminal",
        status: "COMPLETED",
        lastRunStatus: "COMPLETED",
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      conversationTurns: [{
        turnId: `turn-${runId}`,
        threadId,
        sessionId: ownerSessionId,
        sequence: 1,
        status: "COMPLETED",
        rootRunId: runId,
        sourceMessageId: messageId,
        terminalRunId: runId,
        terminalStatus: "COMPLETED",
        startedAt: owner.createdAt,
        completedAt: owner.updatedAt,
        updatedAt: owner.updatedAt,
      }],
    },
  }), true);

  assert.equal(uiStore.getState().activeSession.sessionId, visible.sessionId);
  const reloadedFile = await new SessionStore(home).load();
  const persisted = new SessionStore(home).findByName(
    reloadedFile,
    owner.name,
  );
  assert.equal(reloadedFile.activeSessionName, visible.name);
  assert.equal(persisted?.queuedRunReservations, undefined);
  assert.equal(persisted?.acceptedRunId, runId);
  assert.equal(persisted?.acceptedRunMessageId, messageId);
  assert.equal(persisted?.acceptedRunThreadId, threadId);
  assert.equal(persisted?.lastRunStatus, "COMPLETED");
  assert.deepEqual(persisted?.terminalQueuedRuns, [{
    runId,
    messageId,
    threadId,
    status: "COMPLETED",
  }]);
  assert.deepEqual(persisted?.operatorState?.provider, {
    id: "openai",
    model: "owner-profile-model",
  });
});

test("inactive queued terminal wins over a stale describe delayed by owner profile loading", async () => {
  const { app, home } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const visible = uiStore.getState().activeSession;
  const ownerSessionId = "inactive-terminal-interleaved-describe";
  const threadId = `thread-main:${ownerSessionId}`;
  const runId = "run-terminal-interleaved-describe";
  const messageId = "message-terminal-interleaved-describe";
  const owner: TuiSessionMeta = {
    ...visible,
    name: "inactive-interleaved-owner",
    sessionId: ownerSessionId,
    profileId: "profile-loaded-after-terminal",
    queuedRunReservations: [{ runId, messageId, threadId }],
  };
  const sessionsFile = appState.sessionsFile as { version: number; activeSessionName?: string; sessions: TuiSessionMeta[] };
  appState.sessionsFile = {
    ...sessionsFile,
    sessions: [...sessionsFile.sessions, owner],
  };
  uiStore.patch({ sessions: [...uiStore.getState().sessions, owner] });

  const persistedStatuses: Array<string | undefined> = [];
  const sessionStore = appState.sessionStore as SessionStore;
  const saveSessionsFile = sessionStore.save.bind(sessionStore);
  sessionStore.save = async (file) => {
    persistedStatuses.push(file.sessions.find(
      (session) => session.sessionId === ownerSessionId,
    )?.lastRunStatus);
    await saveSessionsFile(file);
  };
  let releaseProfileLoad: ((profiles: unknown[]) => void) | undefined;
  let profileLoadStartedResolve: (() => void) | undefined;
  const profileLoadStarted = new Promise<void>((resolve) => {
    profileLoadStartedResolve = resolve;
  });
  appState.profileStore = {
    load: async () => await new Promise<unknown[]>((resolve) => {
      releaseProfileLoad = resolve;
      profileLoadStartedResolve?.();
    }),
    findById: (profiles: Array<{ id: string }>, id: string) =>
      profiles.find((profile) => profile.id === id),
  };

  const describing = (appState.syncSessionFromDescribePayload as (
    payload: Record<string, unknown>,
  ) => Promise<void>)({
    sessionId: ownerSessionId,
    version: 1,
    threadId,
    operatorThreadView: {
      thread: {
        threadId,
        sessionId: ownerSessionId,
        title: "Stale queued description",
        status: "RUNNING",
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      activeRun: { runId: "run-other-active", status: "RUNNING" },
      conversationMessageRoutes: [{
        messageId,
        disposition: "queued",
        followUpId: "follow-up:stale-queued-description",
        createdAt: owner.updatedAt,
      }],
    },
  });
  await profileLoadStarted;

  assert.equal(await (appState.syncForegroundQueuedTerminal as (input: Record<string, unknown>) => Promise<boolean>)({
    sessionId: ownerSessionId,
    threadId,
    runId,
    result: {
      assistantText: "Terminal wins",
      output: {
        status: "COMPLETED",
        sessionId: ownerSessionId,
        runId,
        quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
        errors: [],
        telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
      },
    },
    authoritativeView: {
      thread: {
        threadId,
        sessionId: ownerSessionId,
        title: "Interleaved exact terminal",
        status: "COMPLETED",
        lastRunStatus: "COMPLETED",
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
      },
      childThreads: [],
      childBlockerChain: [],
      conversationTurns: [{
        turnId: `turn-${runId}`,
        threadId,
        sessionId: ownerSessionId,
        sequence: 1,
        status: "COMPLETED",
        rootRunId: runId,
        sourceMessageId: messageId,
        terminalRunId: runId,
        terminalStatus: "COMPLETED",
        startedAt: owner.createdAt,
        completedAt: owner.updatedAt,
        updatedAt: owner.updatedAt,
      }],
    },
  }), true);
  releaseProfileLoad?.([{
    ...uiStore.getState().activeProfile,
    id: owner.profileId,
  }]);
  await describing;

  const current = uiStore.getState().sessions.find((session) => session.sessionId === ownerSessionId);
  assert.equal(current?.queuedRunReservations, undefined);
  assert.equal(current?.acceptedRunId, runId);
  assert.equal(current?.acceptedRunMessageId, messageId);
  assert.equal(current?.acceptedRunThreadId, threadId);
  assert.equal(current?.lastRunStatus, "COMPLETED");
  assert.equal(uiStore.getState().activeSession.sessionId, visible.sessionId);
  assert.deepEqual(persistedStatuses, ["COMPLETED"]);
  const persistedFile = await new SessionStore(home).load();
  assert.equal(persistedFile.activeSessionName, visible.name);
  assert.equal(
    persistedFile.sessions.find((session) => session.sessionId === ownerSessionId)?.lastRunStatus,
    "COMPLETED",
  );
});

test("start task journey clears inherited preset metadata when preset none is selected", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "start",
    args: [],
  });
  await (appState.handleLine as (line: string) => Promise<void>)("investigation-task");
  await (appState.handleLine as (line: string) => Promise<void>)("none");
  await (appState.handleLine as (line: string) => Promise<void>)("detached");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("Investigate queue latency");
  await (appState.handleLine as (line: string) => Promise<void>)("current");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("skip");

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.launchTemplateId, "investigation-task");
  assert.equal(state.activeSession.launchPresetId, undefined);
});

test("start task journey rejects active workspace binding when no workspace is available", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "start",
    args: [],
  });
  await (appState.handleLine as (line: string) => Promise<void>)("none");
  await (appState.handleLine as (line: string) => Promise<void>)("none");
  await (appState.handleLine as (line: string) => Promise<void>)("active");

  const stateAfterInvalidBinding = (appState.uiStore as UiStore).getState();
  assert.equal(stateAfterInvalidBinding.activeSession.sessionId, "session-1");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /No active workspace is available\. Use detached or a discovered workspace id\/root\./u);
});

test("start task journey treats launch workspace as current when active session is detached", async () => {
  const { app, cwd } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const workspaceRoot = path.join(cwd, "launch-project");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await initializeWorkspaceAtRoot(
    workspaceRoot,
    appState.workspaceStore as WorkspaceStore,
    { label: "launch-project" },
  );
  appState.activeWorkspace = undefined;
  appState.launchWorkspace = workspace;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "start",
    args: [],
  });
  await (appState.handleLine as (line: string) => Promise<void>)("none");
  await (appState.handleLine as (line: string) => Promise<void>)("none");
  await (appState.handleLine as (line: string) => Promise<void>)("current");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("Scaffold app");
  await (appState.handleLine as (line: string) => Promise<void>)("current");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("skip");

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.workspaceBinding, "active");
  assert.equal(state.activeSession.environmentPresetId, "cli_dev_local");
  assert.equal(state.activeSession.workspaceId, workspace.manifest.workspaceId);
  assert.equal(state.activeSession.workspaceRoot, workspace.rootPath);
});

test("/workspace list shows discovered workspaces and /workspace use binds the active session", async () => {
  const { app, cwd, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const workspaceStore = appState.workspaceStore as WorkspaceStore;
  const alphaRoot = path.join(cwd, "alpha");
  const betaRoot = path.join(cwd, "beta");
  await mkdir(alphaRoot, { recursive: true });
  await mkdir(betaRoot, { recursive: true });
  const alpha = await initializeWorkspaceAtRoot(alphaRoot, workspaceStore, { label: "alpha" });
  const beta = await initializeWorkspaceAtRoot(betaRoot, workspaceStore, { label: "beta" });

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "workspace",
    args: ["list"],
  });
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "workspace",
    args: ["use", beta.manifest.workspaceId],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.workspaceId, beta.manifest.workspaceId);
  assert.equal(state.activeSession.workspaceRoot, beta.rootPath);
  assert.equal((appState.activeWorkspace as { rootPath: string } | undefined)?.rootPath, beta.rootPath);

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, new RegExp(alpha.manifest.workspaceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  assert.match(rawHistory, new RegExp(beta.manifest.workspaceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  assert.match(rawHistory, /Bound the active session to workspace/u);
});

test("bare /workspace opens workspace journey surface", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "workspace",
    args: [],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeView, "workspace");
  assert.equal(state.activeRegion, "sessions");
});

test("start task journey accepts a discovered workspace id", async () => {
  const { app, cwd } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const workspaceStore = appState.workspaceStore as WorkspaceStore;
  const workspaceRoot = path.join(cwd, "project-space");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await initializeWorkspaceAtRoot(workspaceRoot, workspaceStore, { label: "project-space" });

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "start",
    args: [],
  });
  await (appState.handleLine as (line: string) => Promise<void>)("none");
  await (appState.handleLine as (line: string) => Promise<void>)("none");
  await (appState.handleLine as (line: string) => Promise<void>)(workspace.manifest.workspaceId);
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("Investigate workspace selection");
  await (appState.handleLine as (line: string) => Promise<void>)("current");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("skip");

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.workspaceId, workspace.manifest.workspaceId);
  assert.equal(state.activeSession.workspaceRoot, workspace.rootPath);
  assert.equal(state.activeSession.workspaceBinding, "active");
});

test("operator-launched background sessions inherit the parent environment", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const initialState = (appState.uiStore as UiStore).getState();
  let runProfileId: string | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      assert.equal(type, "run.start");
      runProfileId = typeof payload.profileId === "string" ? payload.profileId : undefined;
      return { type: "run.completed", payload: {} };
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "tasks",
    args: ["launch", initialState.activeProfile.id, "inspect", "the", "workspace"],
  });

  const state = (appState.uiStore as UiStore).getState();
  const background = state.sessions.find((session) =>
    session.delegation?.parentSessionId === initialState.activeSession.sessionId
  );
  assert.equal(background?.environmentPresetId, "cli_dev_local");
  assert.equal(
    runProfileId,
    "kestrel:cli_dev_local:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  );
});

test("/mcp opens the MCP workspace and stores the latest MCP snapshot", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      assert.equal(type, "mcp.status");
      assert.equal(
        payload.profileId,
        "kestrel:cli_dev_local:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      );
      assert.equal("profile" in payload, false);
      return {
        type: "mcp.status",
        payload: {
          status: {
            healthy: true,
            checkedAt: "2026-03-21T11:00:00.000Z",
            servers: [],
            tools: [],
          },
        },
      };
    },
  };
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "mcp",
    args: [],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeView, "mcp");
  assert.equal(state.mcpStatus?.healthy, true);
});

test("/code opens the code workspace", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "code",
    args: [],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeView, "code");
});

test("/child opens delegation review by default", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  appState.client = {
    sendCommand: async (type: string) => {
      if (type === "session.describe") {
        return {
          type: "session.described",
          payload: {
            sessionId: "session-1",
            updatedAt: new Date().toISOString(),
          },
        };
      }
      throw new Error(`Unexpected command ${type}`);
    },
  };
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "child",
    args: [],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeView, "delegation");
});

test("manual child mission spawning remains unavailable", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{
    type: string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown> | undefined;
  }> = [];

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>, metadata?: Record<string, unknown>) => {
      sent.push({ type, payload, metadata });
      return {
        type: "operator.controlled",
        payload: {
          threadId: "session-1",
        },
      };
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "child",
    args: ["spawn"],
  });
  assert.equal(sent.length, 0);
  const state = (appState.uiStore as UiStore).getState();
  assert.match(
    state.transcript.at(-1)?.text ?? "",
    /Collaborator dialogs are opened by Kestrel in the conversation/,
  );
});

test("/checkpoint opens recovery center by default and loads workspace checkpoints", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  appState.client = {
    sendCommand: async (type: string) => {
      if (type === "session.describe") {
        return {
          type: "session.described",
          payload: {
            sessionId: "session-1",
            updatedAt: new Date().toISOString(),
          },
        };
      }
      if (type === "workspace.checkpoint.list") {
        return {
          type: "workspace.checkpoint",
          payload: {
            sessionId: "session-1",
            operation: "list",
            checkpoints: [
              {
                checkpointId: "ws-1",
                sessionId: "session-1",
                workspaceRoot: "/tmp/demo",
                repoRoot: "/tmp/demo",
                label: "Before restore",
                isExplicitLabel: true,
                reason: "manual anchor",
                createdBy: "operator",
                createdAt: "2026-03-21T12:00:00.000Z",
                storageKind: "git_ref_v1",
                gitRef: "refs/kestrel/checkpoints/thread-main/checkpoint-1",
                kind: "manual",
                retentionClass: "manual",
                captureStatus: "CAPTURED",
                manifestHash: "abc",
                fileCount: 3,
                totalBytes: 1200,
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected command ${type}`);
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "checkpoint",
    args: [],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeView, "recovery");
  assert.equal(state.workspaceCheckpoints?.length, 1);
});

test("/checkpoint accept refreshes describe before resolving a stale local context checkpoint", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      if (type === "session.describe") {
        return {
          type: "session.described",
          payload: {
            sessionId: "session-1",
            version: 1,
            updatedAt: new Date().toISOString(),
            focusedThreadId: "thread-main",
            latestCheckpoint: {
              checkpointId: "checkpoint-1",
              status: "PENDING",
              recommendedAction: "compact",
              reason: "Context pressure",
            },
          },
        };
      }
      if (type === "operator.control") {
        return {
          type: "operator.controlled",
          payload: {
            threadId: "thread-main",
          },
        };
      }
      if (type === "operator.inbox") {
        return {
          type: "operator.inbox",
          payload: {
            inbox: {
              items: [],
              summary: {
                total: 0,
                actionable: 0,
                approvals: 0,
                userInputs: 0,
                checkpoints: 0,
                childBlockers: 0,
                stalled: 0,
                assemblyProposals: 0,
                compatibilityAlerts: 0,
              },
            },
          },
        };
      }
      throw new Error(`Unexpected command ${type}`);
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "checkpoint",
    args: ["accept"],
  });

  const control = sent.find((entry) => entry.type === "operator.control");
  assert.equal(control?.payload.action, "resolve_context_checkpoint");
  assert.equal(control?.payload.threadId, "thread-main");
  assert.equal(control?.payload.checkpointId, "checkpoint-1");
  assert.equal(control?.payload.actionValue, "compact");
});

test("/checkpoint accept falls back to operator inbox when describe has no latest checkpoint", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      if (type === "session.describe") {
        return {
          type: "session.described",
          payload: {
            sessionId: "session-1",
            version: 1,
            updatedAt: new Date().toISOString(),
            focusedThreadId: "thread-main",
          },
        };
      }
      if (type === "operator.inbox") {
        return {
          type: "operator.inbox",
          payload: {
            inbox: {
              items: [
                {
                  itemId: "checkpoint-item-1",
                  kind: "context_checkpoint",
                  threadId: "thread-main",
                  sessionId: "session-1",
                  title: "Context pressure",
                  actionable: true,
                  createdAt: new Date().toISOString(),
                  checkpointId: "checkpoint-2",
                  recommendedAction: "summarize_forward",
                },
              ],
              summary: {
                total: 1,
                actionable: 1,
                approvals: 0,
                userInputs: 0,
                checkpoints: 1,
                childBlockers: 0,
                stalled: 0,
                assemblyProposals: 0,
                compatibilityAlerts: 0,
              },
            },
          },
        };
      }
      if (type === "operator.control") {
        return {
          type: "operator.controlled",
          payload: {
            threadId: "thread-main",
          },
        };
      }
      throw new Error(`Unexpected command ${type}`);
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "checkpoint",
    args: ["accept"],
  });

  const control = sent.find((entry) => entry.type === "operator.control");
  assert.equal(control?.payload.checkpointId, "checkpoint-2");
  assert.equal(control?.payload.actionValue, "summarize_forward");
});

test("/checkpoint defer with explicit id resolves via continue", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      if (type === "session.describe") {
        return {
          type: "session.described",
          payload: {
            sessionId: "session-1",
            version: 1,
            updatedAt: new Date().toISOString(),
            focusedThreadId: "thread-main",
          },
        };
      }
      if (type === "operator.inbox") {
        return {
          type: "operator.inbox",
          payload: {
            inbox: {
              items: [
                {
                  itemId: "checkpoint-item-1",
                  kind: "context_checkpoint",
                  threadId: "thread-main",
                  sessionId: "session-1",
                  title: "Context pressure",
                  actionable: true,
                  createdAt: new Date().toISOString(),
                  checkpointId: "checkpoint-explicit",
                  recommendedAction: "compact",
                },
              ],
              summary: {
                total: 1,
                actionable: 1,
                approvals: 0,
                userInputs: 0,
                checkpoints: 1,
                childBlockers: 0,
                stalled: 0,
                assemblyProposals: 0,
                compatibilityAlerts: 0,
              },
            },
          },
        };
      }
      if (type === "operator.control") {
        return {
          type: "operator.controlled",
          payload: {
            threadId: "thread-main",
          },
        };
      }
      throw new Error(`Unexpected command ${type}`);
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "checkpoint",
    args: ["defer", "checkpoint-explicit"],
  });

  const control = sent.find((entry) => entry.type === "operator.control");
  assert.equal(control?.payload.checkpointId, "checkpoint-explicit");
  assert.equal(control?.payload.actionValue, "continue");
});

test("/snapshot captures a workspace snapshot with an optional label", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      if (type === "workspace.checkpoint.capture") {
        return {
          type: "workspace.checkpoint",
          payload: {
            sessionId: "session-1",
            operation: "capture",
            checkpoint: {
              checkpoint: {
                checkpointId: "snapshot-1",
                sessionId: "session-1",
                workspaceRoot: "/tmp/demo",
                repoRoot: "/tmp/demo",
                label: "before changes",
                isExplicitLabel: true,
                reason: "manual anchor",
                createdBy: "operator",
                createdAt: new Date().toISOString(),
                storageKind: "git_ref_v1",
                gitRef: "refs/kestrel/checkpoints/thread-main/snapshot-1",
                kind: "manual",
                retentionClass: "manual",
                captureStatus: "CAPTURED",
                manifestHash: "abc",
                fileCount: 1,
                totalBytes: 12,
              },
              files: [],
            },
            checkpoints: [],
          },
        };
      }
      throw new Error(`Unexpected command ${type}`);
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "snapshot",
    args: ["before", "changes"],
  });

  assert.equal(sent[0]?.type, "workspace.checkpoint.capture");
  assert.equal(sent[0]?.payload.sessionId, "session-1");
  assert.equal(sent[0]?.payload.threadId, "session-1");
  assert.equal(sent[0]?.payload.label, "before changes");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Saved snapshot before changes/u);
});

test("/restore opens recovery center without an id and restores explicit snapshots with an id", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      if (type === "session.describe") {
        return {
          type: "session.described",
          payload: {
            sessionId: "session-1",
            updatedAt: new Date().toISOString(),
          },
        };
      }
      if (type === "workspace.checkpoint.list") {
        return {
          type: "workspace.checkpoint",
          payload: {
            sessionId: "session-1",
            operation: "list",
            checkpoints: [],
          },
        };
      }
      if (type === "workspace.checkpoint.restore") {
        return {
          type: "workspace.checkpoint",
          payload: {
            sessionId: "session-1",
            operation: "restore",
            restore: {
              restoreId: "restore-1",
              checkpointId: "snapshot-1",
              sessionId: "session-1",
              status: "RESTORED",
              restoredAt: new Date().toISOString(),
              restoredBy: "operator",
              reason: "try older version",
            },
          },
        };
      }
      throw new Error(`Unexpected command ${type}`);
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "restore",
    args: [],
  });

  assert.equal((appState.uiStore as UiStore).getState().activeView, "recovery");
  assert.equal(sent.some((entry) => entry.type === "workspace.checkpoint.list"), true);

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "restore",
    args: ["snapshot-1", "try", "older", "version"],
  });

  const restore = sent.find((entry) => entry.type === "workspace.checkpoint.restore");
  assert.equal(restore?.payload.checkpointId, "snapshot-1");
  assert.equal(restore?.payload.threadId, "session-1");
  assert.equal(restore?.payload.reason, "try older version");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Restore restored for snapshot 'snapshot-1'/u);
});

test("/deny aliases the reject operator control path", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      if (type === "run.cancel") {
        return {
          type: "run.cancelled",
          payload: {
            sessionId: "session-1",
          },
        };
      }
      return {
        type: "operator.controlled",
        payload: {
          threadId: "session-1",
        },
      };
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "deny",
    args: [],
  });

  assert.equal(sent[0]?.type, "operator.control");
  assert.equal(sent[0]?.payload.action, "reject");
  assert.equal(sent[0]?.payload.threadId, "session-1");
});

test("SessionsView renders additive assembly state in the detail drawer", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const state = uiStore.getState();

  uiStore.patch({
    sessions: state.sessions.map((session) => ({
      ...session,
      operatorState: {
        ...session.operatorState,
        interactionMode: "plan",
        allowedToolClasses: ["read_only"],
        assembly: {
          mode: "explicit",
          threadId: session.sessionId,
          bundleId: "bundle:reference:default",
          label: "Reference default",
          environmentPresetId: "cli_dev_local",
          authority: "profile",
          cause: "thread_start",
          provider: {
            id: "openrouter",
            model: "google/gemini-3.1-flash-lite-preview",
            promptVariant: "reference-react:plan",
          },
          compatibility: {
            status: "downgraded",
            decisionSource: "policy",
            compatibilityProfile: "reference-default",
            downgradeReason: "provider_variant_unavailable",
            capabilityLossReason: "structured_output_unavailable",
          },
        },
        latestReasoning: {
          message: "Checking the current thread assembly before resuming work.",
          at: new Date().toISOString(),
        },
        latestAdaptation: {
          status: "pending_checkpoint",
          recommendedAction: "compact",
          reason: "Context pressure exceeded threshold.",
          at: new Date().toISOString(),
        },
        latestEvidenceRecovery: {
          attempts: 4,
          lowSignalAttempts: 2,
          consecutiveLowSignal: 1,
          broadenedSearchUsed: true,
          targetedFetchUsed: true,
          latestQuality: "mixed",
          latestIssues: ["missing_source_diversity"],
          terminalOutcome: "soft_finalize",
        },
        childThreads: [
          {
            threadId: `${session.sessionId}-child-waiting`,
            title: "Waiting child",
            status: "WAITING",
            updatedAt: new Date().toISOString(),
            waitEventType: "user.approval",
            delegationId: "delegation-1",
            delegationStatus: "WAITING",
          },
          {
            threadId: `${session.sessionId}-child-complete`,
            title: "Completed child",
            status: "COMPLETED",
            updatedAt: new Date().toISOString(),
            delegationId: "delegation-2",
            delegationStatus: "COMPLETED",
            outcomeSummary: "Completed subtask.",
          },
          {
            threadId: `${session.sessionId}-child-superseded`,
            title: "Superseded child",
            status: "COMPLETED",
            updatedAt: new Date().toISOString(),
            delegationId: "delegation-3",
            delegationStatus: "CANCELLED",
            superseded: true,
          },
        ],
        childBlockerChainDetails: [
          {
            threadId: `${session.sessionId}-child-waiting`,
            title: "Waiting child",
            status: "WAITING",
            delegationId: "delegation-1",
            waitEventType: "user.approval",
            reason: "Waiting for approval.",
          },
        ],
      },
    })),
  });

  const refreshed = uiStore.getState();
  const rendered = renderToString(
    React.createElement(SessionsView, {
      sessions: refreshed.sessions,
      activeSessionName: refreshed.activeSession.name,
      query: "",
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      listRows: 8,
      detailDrawerOpen: true,
    }),
  );

  assert.match(rendered, /assembly=Kestrel on Developer workspace/u);
  assert.doesNotMatch(rendered, /bundle:reference:default|cli_dev_local/u);
  assert.match(rendered, /openrouter\/google\/gemini-3\.1-flash-lite-preview/u);
  assert.match(rendered, /variant:reference-react:plan/u);
  assert.match(rendered, /compat:downgraded/u);
  assert.match(rendered, /downgrade:provider_variant_unavailable/u);
  assert.match(rendered, /downgraded/u);
  assert.match(rendered, /next:send_message/u);
  assert.match(rendered, /childAgents:1\/3/u);
  assert.match(rendered, /evidence=attempts:4 lowSignal:2 quality:mixed outcome:soft_finalize/u);
  assert.match(rendered, /childThreads=total:3 running:0 waiting:1 completed:2 failed:0 cancelled:1/u);
});

test("TasksView renders additive assembly provider, variant, and downgrade markers", async () => {
  const session: TuiSessionMeta = {
    name: "delegated-task",
    sessionId: "task-session-1",
    profileId: "reference",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    started: true,
    pendingRunId: "internal-pending-run-id",
    pendingRunRequestId: "internal-pending-request-id",
    pendingRunMessageId: "internal-pending-message-id",
    pendingRunThreadId: "internal-pending-thread-id",
    queuedRunReservations: [{
      runId: "internal-queued-run-id",
      messageId: "internal-queued-message-id",
      threadId: "internal-queued-thread-id",
    }],
    pendingQueueSubmissions: [{
      runId: "internal-pending-queue-run-id",
      messageId: "internal-pending-queue-message-id",
      threadId: "internal-pending-queue-thread-id",
    }],
    acceptedRunId: "internal-accepted-run-id",
    acceptedRunMessageId: "internal-accepted-message-id",
    acceptedRunThreadId: "internal-accepted-thread-id",
    delegation: {
      taskId: "task-1",
      title: "Delegated compatibility check",
      status: "WAITING",
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite-preview",
      profileId: "reference",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    operatorState: {
      interactionMode: "plan",
      allowedToolClasses: ["read_only"],
      assembly: {
        mode: "explicit",
        threadId: "task-thread-1",
        bundleId: "bundle:ops:task",
        label: "Task downgraded bundle",
        environmentPresetId: "workspace_hosted",
        authority: "policy",
        cause: "capability_loss",
        provider: {
          id: "openrouter",
          model: "google/gemini-3.1-flash-lite-preview",
          promptVariant: "ops.approval",
        },
        compatibility: {
          status: "downgraded",
          decisionSource: "policy",
          downgradeReason: "task_prompt_variant_unavailable",
        },
      },
      latestAdaptation: {
        status: "auto_applied",
        recommendedAction: "compact",
        reason: "Auto compaction applied.",
        at: new Date(0).toISOString(),
      },
      latestEvidenceRecovery: {
        attempts: 3,
        lowSignalAttempts: 1,
        consecutiveLowSignal: 1,
        broadenedSearchUsed: true,
        targetedFetchUsed: false,
        latestQuality: "high",
        latestIssues: ["targeted_fetch_not_required"],
        terminalOutcome: "continue",
      },
      childThreads: [
        {
          threadId: "task-thread-child",
          title: "Task child",
          status: "WAITING",
          updatedAt: new Date(0).toISOString(),
          waitEventType: "user.reply",
          delegationId: "task-delegation-child",
          delegationStatus: "WAITING",
        },
        {
          threadId: "task-thread-superseded",
          title: "Superseded task child",
          status: "COMPLETED",
          updatedAt: new Date(0).toISOString(),
          delegationId: "task-delegation-superseded",
          delegationStatus: "CANCELLED",
          superseded: true,
        },
      ],
      childResults: [
        {
          threadId: "task-thread-child",
          title: "Task child",
          status: "COMPLETED",
          updatedAt: new Date(0).toISOString(),
          delegationId: "task-delegation-child",
          resultStatus: "completed",
          result: "Child result ready.",
        },
      ],
      childBlocker: {
        delegationId: "task-delegation-child",
        childThreadId: "task-thread-child",
        status: "WAITING",
        reason: "Waiting for user.reply",
      },
    },
  };

  const rendered = renderToString(
    React.createElement(TasksView, {
      tasks: [session],
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      listRows: 8,
      detailDrawerOpen: true,
    }),
  );

  assert.match(rendered, /Kestrel on Developer workspace \(hosted\)/u);
  assert.doesNotMatch(rendered, /bundle:ops:task|workspace_hosted/u);
  assert.match(rendered, /var:ops\.approval/u);
  assert.match(rendered, /!downgraded/u);
  assert.match(rendered, /assemblyProvider=openrouter\/google\/gemini-3\.1-flash-lite-preview/u);
  assert.match(rendered, /assemblyVariant=ops\.approval/u);
  assert.match(rendered, /compatibility=downgraded/u);
  assert.match(rendered, /downgradeReason=task_prompt_variant_unavailable/u);
  assert.match(rendered, /adapt:auto_applied/u);
  assert.match(rendered, /\[WAITING:delegation\]/u);
  assert.match(rendered, /children:1\/2/u);
  assert.match(rendered, /superseded:1/u);
  assert.match(rendered, /ev:3/u);
  assert.match(rendered, /childThreads=total:2 running:0 waiting:1 completed:1 failed:0 cancelled:1/u);
  assert.doesNotMatch(rendered, /internal-(?:pending|queued|accepted)/u);
  assert.match(
    rendered,
    /childResults=task-thread-child status=COMPLETED resultStatus=completed[\s\S]*result=Child result ready\./u,
  );
  assert.match(rendered, /supersededChildren=task-thread-superseded/u);
  assert.match(rendered, /adaptation=auto_applied action=compact/u);
  assert.match(rendered, /evidenceRecovery=attempts:3 lowSignal:1 consecutiveLowSignal:1/u);
  assert.match(rendered, /evidenceQuality=high/u);
  assert.match(rendered, /evidenceIssues=targeted_fetch_not_required/u);
  assert.match(rendered, /evidenceOutcome=continue/u);
});

test("SessionsView keeps focused thread and blocker parity in the detail drawer", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const state = uiStore.getState();

  uiStore.patch({
    sessions: state.sessions.map((session) => ({
      ...session,
      focusedThreadId: `${session.sessionId}-child`,
      operatorState: {
        ...session.operatorState,
        interactionMode: "build",
        actSubmode: "safe",
        blockReason: {
          code: "delegation_wait",
          summary: "Child agent is blocked on user input.",
        },
        childBlocker: {
          delegationId: "delegation-1",
          childThreadId: `${session.sessionId}-child`,
          status: "WAITING",
          reason: "Waiting for user.reply",
        },
        latestCheckpoint: {
          checkpointId: "checkpoint-1",
          status: "PENDING",
          recommendedAction: "compact",
          reason: "Context pressure",
        },
        recommendedAction: {
          code: "switch_thread",
          summary: "Open child thread and resolve the wait.",
        },
      },
    })),
  });

  const refreshed = uiStore.getState();
  const rendered = renderToString(
    React.createElement(SessionsView, {
      sessions: refreshed.sessions,
      activeSessionName: refreshed.activeSession.name,
      query: "",
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      listRows: 8,
      detailDrawerOpen: true,
    }),
  );

  assert.match(rendered, /focusedThread=.*-child/u);
  assert.match(rendered, /\[WAITING:checkpoint\]/u);
  assert.match(rendered, /blocker=Child agent is blocked on user input\./u);
  assert.match(rendered, /blockerDiagnostics=child:.*-child delegation:delegation-1/u);
  assert.match(rendered, /status:waiting reason:Waiting for user\.reply/u);
  assert.match(rendered, /checkpoint=pending:compact/u);
  assert.match(rendered, /activity=next:switch_thread/u);
});

test("SessionsView and TasksView surface stalled attention in row statuses", () => {
  const now = new Date(0).toISOString();
  const session: TuiSessionMeta = {
    name: "stalled-session",
    sessionId: "stalled-session",
    profileId: "reference",
    createdAt: now,
    updatedAt: now,
    started: true,
    delegation: {
      taskId: "stalled-task",
      title: "Stalled delegated task",
      status: "RUNNING",
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite-preview",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
    },
    operatorState: {
      interactionMode: "build",
      allowedToolClasses: ["read_only"],
      inbox: {
        total: 1,
        actionable: 1,
        approvals: 0,
        userInputs: 0,
        checkpoints: 0,
        childBlockers: 0,
        stalled: 1,
        assemblyProposals: 0,
        compatibilityAlerts: 0,
      },
    },
  };

  const sessionsRendered = renderToString(
    React.createElement(SessionsView, {
      sessions: [session],
      activeSessionName: session.name,
      query: "",
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      listRows: 8,
      detailDrawerOpen: false,
    }),
  );
  const tasksRendered = renderToString(
    React.createElement(TasksView, {
      tasks: [session],
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      listRows: 8,
      detailDrawerOpen: false,
    }),
  );

  assert.match(sessionsRendered, /\[WAITING:stalled\]/u);
  assert.match(tasksRendered, /\[WAITING:stalled\]/u);
});

test("palette draft actions seed the composer instead of executing immediately", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const state = uiStore.getState();

  (appState.activatePaletteAction as (selected: PaletteCommand, state: ReturnType<UiStore["getState"]>) => void)(
    {
      id: "draft.mode.build",
      label: "Insert /mode build",
      detail: "Insert a slash command into the composer",
      draft: "/mode build",
    },
    state,
  );

  const next = uiStore.getState();
  assert.equal(next.chatDraft, "/mode build");
  assert.equal(next.activeRegion, "composer");
  assert.equal(next.paletteOpen, false);
});

test("stop command cancels the authoritative active run without synthesizing steering", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      if (type === "run.cancel") {
        return {
          type: "run.cancelled",
          payload: {
            sessionId: "session-1",
            result: makeAppCancelledResult("run-stop-1"),
          },
        };
      }
      assert.equal(type, "operator.thread");
      return { type: "operator.thread", payload: { view: makeAppConversationView(false) } };
    },
  };
  installAppActiveConversationView(appState);

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "stop",
    args: [],
  });

  assert.equal(sent[0]?.type, "run.cancel");
  assert.equal(sent[1]?.type, "operator.thread");
  assert.equal(sent.some((command) => command.type === "operator.control"), false);
});

test("stop command reconciles cancellation before refreshing the thread", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  uiStore.patch({ running: true });
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      return type === "run.cancel" ? {
            type: "run.cancelled",
            payload: {
              sessionId: "session-1",
              result: makeAppCancelledResult("run-stop-1"),
            },
          } : { type: "operator.thread", payload: { view: makeAppConversationView(false) } };
    },
  };
  installAppActiveConversationView(appState);

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "stop",
    args: [],
  });

  assert.equal(sent[0]?.type, "run.cancel");
  assert.equal(sent[0]?.payload.sessionId, "session-1");
  assert.equal(sent[0]?.payload.runId, "run-stop-1");
  assert.equal(sent[1]?.type, "operator.thread");
  assert.equal(uiStore.getState().running, false);
  assert.equal(uiStore.getState().statusLine.includes("cancelled"), true);
});

function makeAppCancelledResult(runId: string) {
  return {
    assistantText: null,
    output: {
      status: "FAILED",
      sessionId: "session-1",
      runId,
      quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
      errors: [{ code: "RUN_CANCELLED", message: "Run cancelled." }],
      telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
    },
  };
}

function makeAppConversationView(active: boolean) {
  return {
    thread: {
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      title: "Main",
      status: active ? "RUNNING" : "FAILED",
      lastRunStatus: active ? undefined : "FAILED",
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:01.000Z",
    },
    childThreads: [],
    childBlockerChain: [],
    conversationTurns: active ? [{
      turnId: "turn-stop-1",
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      sequence: 1,
      status: "RUNNING",
      rootRunId: "run-stop-1",
      activeRunId: "run-stop-1",
      startedAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    }] : [{
      turnId: "turn-stop-1",
      threadId: "thread-main:session-1",
      sessionId: "session-1",
      sequence: 1,
      status: "FAILED",
      rootRunId: "run-stop-1",
      terminalRunId: "run-stop-1",
      startedAt: "2026-08-17T10:00:00.000Z",
      completedAt: "2026-08-17T10:00:01.000Z",
      updatedAt: "2026-08-17T10:00:01.000Z",
    }],
    activeRun: active ? { runId: "run-stop-1", status: "RUNNING" } : undefined,
    followUpQueue: { state: active ? "ready" : "paused", pauseReason: active ? undefined : "cancelled", items: [] },
  };
}

function installAppActiveConversationView(appState: Record<string, unknown>): void {
  (appState.onRunnerEvent as (event: unknown) => void)({
    id: "operator-thread-stop",
    type: "operator.thread",
    ts: "2026-08-17T10:00:00.000Z",
    payload: {
      view: makeAppConversationView(true),
    },
  });
}

test("interactive operator commands bypass the queued input drain while a run is active", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const sent: Array<{ type: string; payload: Record<string, unknown>; metadata?: Record<string, unknown> | undefined }> = [];

  uiStore.patch({ running: true });
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>, metadata?: Record<string, unknown>) => {
      sent.push({ type, payload, metadata });
      return {
        type: "operator.controlled",
        payload: {
          threadId: "session-1",
        },
      };
    },
  };
  appState.drainQueue = async () => {
    throw new Error("queue should not be used for interactive operator commands");
  };

  (appState.submitInput as (line: string) => void)("/steer stop after the current step");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent[0]?.type, "operator.control");
  assert.equal(sent[0]?.payload.action, "steer");
  assert.equal("profile" in (sent[0]?.metadata ?? {}), false);
});

test("/steer during a pending wait sends operator control instead of resuming the wait", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "loop_visit_stall",
        resumeReply: "continue",
      },
    },
    updatedAt: new Date().toISOString(),
  });
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      return {
        type: "operator.controlled",
        payload: {
          threadId: "session-1",
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("/steer stop doing copy edits");

  assert.equal(sent.some((command) => command.type === "run.start"), false);
  const operatorControl = sent.find((command) => command.type === "operator.control");
  assert.equal(operatorControl?.payload.action, "steer");
  assert.equal(operatorControl?.payload.message, "stop doing copy edits");
});

test("interactive operator command failures surface in the TUI instead of escaping", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const failure = new Error("Postgres is not reachable at localhost:55432/kestrel. (OPERATOR_THREAD_NOT_FOUND)") as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  failure.code = "OPERATOR_THREAD_NOT_FOUND";
  failure.details = {
    threadId: "reference-session-1779158579980-1779158580001",
    storeDriver: "postgres",
  };

  uiStore.patch({ running: true });
  appState.client = {
    sendCommand: async () => {
      throw failure;
    },
  };

  (appState.submitInput as (line: string) => void)("/steer stop the loop");
  await waitFor(() => uiStore.getState().errorOverlay?.code === "OPERATOR_THREAD_NOT_FOUND");

  const state = uiStore.getState();
  assert.equal(state.running, false);
  assert.match(state.errorOverlay?.message ?? "", /Postgres is not reachable/u);
  assert.equal(state.errorOverlay?.details?.threadId, "reference-session-1779158579980-1779158580001");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Input failed: Postgres is not reachable/u);
});

test("primary session selection surfaces an unavailable authoring profile", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const sessionStore = appState.sessionStore as SessionStore;
  const activeSession = uiStore.getState().activeSession;
  const target: TuiSessionMeta = {
    ...activeSession,
    name: "missing-profile-session",
    sessionId: "session-missing-profile",
    profileId: "missing-authoring-profile",
    effectiveAssemblyId: "bundle:missing-profile",
    started: true,
  };
  appState.sessionsFile = sessionStore.upsert(
    appState.sessionsFile as { sessions: TuiSessionMeta[] },
    target,
  );
  uiStore.patch({
    activeView: "chat",
    activeRegion: "sessions",
    focusRegion: "sessions",
    sessions: [target],
    scroll: {
      ...uiStore.getState().scroll,
      sessions: {
        ...uiStore.getState().scroll.sessions,
        cursor: 0,
      },
    },
  });
  appState.client = {
    sendCommand: async () => ({
      type: "session.described",
      payload: {
        sessionId: target.sessionId,
        version: 1,
        activeAssembly: {
          mode: "explicit",
          bundleId: target.effectiveAssemblyId,
          environmentPresetId: target.environmentPresetId,
        },
      },
    }),
  };

  const controller = (appState.buildController as () => InkAppController)();
  controller.activatePrimaryAction();

  await waitFor(() =>
    uiStore.getState().errorOverlay?.code === "TUI_AUTHORING_PROFILE_UNAVAILABLE"
  );
  assert.equal(uiStore.getState().activeSession.sessionId, activeSession.sessionId);
  assert.match(
    uiStore.getState().errorOverlay?.message ?? "",
    /authoring profile 'missing-authoring-profile' is unavailable/u,
  );
});

test("plain submissions during a running turn reach authoritative conversation routing immediately", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  let handled: string | undefined;

  uiStore.patch({ running: true });
  appState.handleLine = async (line: string) => {
    handled = line;
  };

  (appState.submitInput as (line: string) => void)("also check the failing test output");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(handled, "also check the failing test output");
});

test("queue command strips the control prefix before starting the queued turn", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const turns: Array<{ submittedMessage: string }> = [];

  appState.startActiveTurn = async (input: { submittedMessage: string }) => {
    turns.push(input);
  };

  await (appState.handleLine as (line: string) => Promise<void>)("/queue also check the failing test output");

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.submittedMessage, "also check the failing test output");
});

test("queue command during a running turn delegates immediately with explicit queue intent", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const turns: Array<{ submittedMessage: string; queueRequested?: boolean }> = [];

  uiStore.patch({ running: true });
  appState.startActiveTurn = async (input: { submittedMessage: string; queueRequested?: boolean }) => {
    turns.push(input);
  };

  await (appState.handleLine as (line: string) => Promise<void>)("/queue also check the failing test output");

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.submittedMessage, "also check the failing test output");
  assert.equal(turns[0]?.queueRequested, true);
});

test("queued dispatch stops at the acknowledged App session-save barrier", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sessionStore = appState.sessionStore as SessionStore;
  const save = sessionStore.save.bind(sessionStore);
  sessionStore.save = async (file) => {
    if (file.sessions.some((session) => (session.pendingQueueSubmissions?.length ?? 0) > 0)) {
      throw new Error("injected pending queue save failure");
    }
    await save(file);
  };
  let submissionCount = 0;
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      if (type === "session.describe") {
        return {
          type: "session.described",
          payload: {
            sessionId: String(payload.sessionId),
            version: 1,
            threadId: `thread-main:${String(payload.sessionId)}`,
            activeAssembly: {
              mode: "explicit",
              bundleId: "bundle:kestrel:cli",
              environmentPresetId: "cli_dev_local",
            },
          },
        };
      }
      if (type === "conversation.message.submit") submissionCount += 1;
      throw new Error(`Unexpected command '${type}'.`);
    },
  };
  const runController = (appState.getRunController as () => {
    startActiveTurn(input: {
      messageId: string;
      submittedMessage: string;
      queueRequested: boolean;
    }): Promise<boolean>;
  })();

  assert.equal(await runController.startActiveTurn({
    messageId: "message-app-save-barrier",
    submittedMessage: "must remain local",
    queueRequested: true,
  }), false);
  assert.equal(submissionCount, 0);
  assert.equal(
    (appState.uiStore as UiStore).getState().activeSession.pendingQueueSubmissions,
    undefined,
  );
  assert.match(
    (appState.uiStore as UiStore).getState().errorOverlay?.message ?? "",
    /injected pending queue save failure/u,
  );
});

test("delegation workspace renders result-only error and reference child outcomes", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const state = uiStore.getState();
  const now = new Date(0).toISOString();

  uiStore.patch({
    activeSession: {
      ...state.activeSession,
      operatorState: {
        ...state.activeSession.operatorState,
        interactionMode: "build",
        childThreads: [
          {
            threadId: "child-result",
            title: "Result only",
            status: "COMPLETED",
            updatedAt: now,
            result: {
              status: "completed",
              result: "Result payload ready.",
              references: ["file:///tmp/result.md"],
            },
          },
          {
            threadId: "child-error",
            title: "Error only",
            status: "FAILED",
            updatedAt: now,
            errorCode: "CHILD_FAILED",
            errorMessage: "Child run failed.",
          },
          {
            threadId: "child-reference",
            title: "Reference only",
            status: "COMPLETED",
            updatedAt: now,
            references: ["file:///tmp/reference.md"],
          },
          {
            threadId: "child-outcome-state",
            title: "Outcome state only",
            status: "COMPLETED",
            updatedAt: now,
            outcomeState: "partial",
          },
        ],
      },
    },
  });

  const snapshot = (appState.buildDelegationWorkspaceSnapshot as (
    runtimeState: typeof state,
  ) => OperatorDelegationWorkspaceSnapshot)(uiStore.getState());
  assert.deepEqual(snapshot.childOutcomes.map((child) => child.threadId), [
    "child-result",
    "child-error",
    "child-reference",
    "child-outcome-state",
  ]);

  const rendered = renderToString(
    React.createElement(DelegationReviewView, {
      snapshot,
      scroll: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
      listRows: 8,
      detailDrawerOpen: true,
    }),
  );

  assert.match(
    rendered,
    /Result only status=COMPLETED resultStatus=completed result=Result payload[\s\S]*ready\. references=file:\/\/\/tmp\/result\.md/u,
  );
  assert.match(rendered, /Error only status=FAILED errorCode=CHILD_FAILED error=Child run failed\./u);
  assert.match(rendered, /Reference only status=COMPLETED references=file:\/\/\/tmp\/reference\.md/u);
  assert.match(rendered, /Outcome state only status=COMPLETED/u);
});

test("controller submitLine drops duplicate same-event composer submissions", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();
  const turns: Array<{ submittedMessage: string; resumeBlockedRun?: boolean }> = [];

  appState.startActiveTurn = async (input: { submittedMessage: string; resumeBlockedRun?: boolean }) => {
    turns.push(input);
  };

  controller.submitLine("hello world");
  controller.submitLine("hello world");
  await waitFor(() => turns.length === 1);

  const state = uiStore.getState();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.submittedMessage, "hello world");
  assert.equal(state.chatDraft, "");
});

test("controller submitLine allows intentional resubmit after the draft changes", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const controller = (appState.buildController as () => InkAppController)();
  const turns: Array<{ submittedMessage: string; resumeBlockedRun?: boolean }> = [];

  appState.startActiveTurn = async (input: { submittedMessage: string; resumeBlockedRun?: boolean }) => {
    turns.push(input);
  };

  controller.submitLine("hello world");
  await waitFor(() => turns.length === 1);
  controller.setDraft("hello world");
  controller.submitLine("hello world");
  await waitFor(() => turns.length === 2);

  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.submittedMessage), ["hello world", "hello world"]);
});

test("controller submitLine drops duplicate interactive operator commands while running", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  uiStore.patch({ running: true, chatDraft: "/steer stop after the current step" });
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      return {
        type: "operator.controlled",
        payload: {
          threadId: "session-1",
        },
      };
    },
  };

  controller.submitLine("/steer stop after the current step");
  controller.submitLine("/steer stop after the current step");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const operatorCommands = sent.filter((entry) => entry.type === "operator.control");
  assert.equal(operatorCommands.length, 1);
  assert.equal(operatorCommands[0]?.payload.action, "steer");
});

test("closing the palette restores the previously visible region", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();

  uiStore.patch({
    activeView: "logs",
    activeRegion: "logs",
    focusRegion: "logs",
  });

  controller.openPalette();
  controller.closePalette();

  const next = uiStore.getState();
  assert.equal(next.activeView, "logs");
  assert.equal(next.activeRegion, "logs");
  assert.equal(next.focusRegion, "logs");
});

test("workspace status registers the current folder in the catalog", async () => {
  const { app, home, cwd, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const expectedCwd = await realpath(cwd);

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "workspace",
    args: ["status"],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(typeof state.activeSession.workspaceId, "string");
  assert.equal(state.activeSession.workspaceRoot, expectedCwd);

  const workspaces = await new WorkspaceStore(home).load();
  assert.equal(workspaces.workspaces[0]?.rootPath, expectedCwd);
  assert.equal(workspaces.workspaces[0]?.automationEnabled, false);
  await assert.rejects(() => readFile(path.join(cwd, ".kestrel"), "utf8"), /ENOENT/u);

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Workspace: local:/u);
});

test("workspace status preserves an explicit detached session binding", async () => {
  const { app, home, cwd, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const expectedCwd = await realpath(cwd);

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "workspace",
    args: ["use", "detached"],
  });
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "workspace",
    args: ["status"],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.workspaceBinding, "detached");
  assert.equal(state.activeSession.workspaceId, undefined);
  assert.equal(state.activeSession.workspaceRoot, undefined);
  assert.equal(appState.activeWorkspace, undefined);

  const workspaces = await new WorkspaceStore(home).load();
  assert.equal(workspaces.workspaces[0]?.rootPath, expectedCwd);

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Detached the active session from any workspace\./u);
  assert.match(rawHistory, /Session binding: detached/u);
});

test("closing command-bar search restores the prior chat region", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();

  uiStore.patch({
    activeView: "chat",
    activeRegion: "chat_list",
    focusRegion: "chat_list",
  });

  controller.openContextSearch();
  controller.closeContextSearch();

  const next = uiStore.getState();
  assert.equal(next.activeView, "chat");
  assert.equal(next.activeRegion, "chat_list");
  assert.equal(next.focusRegion, "chat_list");
});

test("slash palette opens the full command catalog while manual palette stays collapsed", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();

  uiStore.patch({
    activeView: "chat",
    activeRegion: "chat_list",
    focusRegion: "chat_list",
  });

  controller.openPalette();
  controller.setPaletteQuery("checkpoint");
  assert.equal(
    controller.getPaletteActions().some((action) => action.command === "/checkpoint"),
    false,
  );

  controller.openSlashPalette();
  controller.setPaletteQuery("snapshot");
  const next = uiStore.getState();
  assert.equal(next.paletteOpen, true);
  assert.equal(next.paletteSource, "slash");
  assert.equal(next.activeRegion, "command_bar");
  assert.equal(
    controller.getPaletteActions().some((action) => action.command === "/checkpoint"),
    false,
  );
  assert.equal(
    controller.getPaletteActions().some((action) => action.command === "/snapshot"),
    true,
  );

  controller.setPaletteQuery("restore");
  assert.equal(
    controller.getPaletteActions().some((action) => action.command === "/restore"),
    true,
  );
  assert.equal(
    controller.getPaletteActions().some((action) => action.command === "/checkpoint"),
    false,
  );

  controller.setPaletteQuery("deny");
  assert.equal(
    controller.getPaletteActions().some((action) => action.command === "/deny"),
    true,
  );
  assert.equal(
    controller.getPaletteActions().some((action) => action.command === "/reject"),
    false,
  );
});

test("exact palette commands move the operator back to chat", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;

  let captured: string | undefined;
  appState.enqueueInput = (line: string) => {
    captured = line;
  };

  uiStore.patch({
    activeView: "logs",
    activeRegion: "logs",
    focusRegion: "logs",
  });

  (appState.activatePaletteAction as (selected: PaletteCommand, state: ReturnType<UiStore["getState"]>) => void)(
    {
      id: "cmd.mode.build",
      label: "/mode build",
      command: "/mode build",
    },
    uiStore.getState(),
  );

  const next = uiStore.getState();
  assert.equal(captured, "/mode build");
  assert.equal(next.activeView, "chat");
  assert.equal(next.activeRegion, "composer");
});

test("startup workspace conflict creates a new session bound to the launch workspace", async () => {
  const { app, cwd, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const workspaceStore = appState.workspaceStore as WorkspaceStore;
  const sessionStore = appState.sessionStore as SessionStore;
  const profiles = await (appState.profileStore as ProfileStore).load();
  const activeProfile = (appState.uiStore as UiStore).getState().activeProfile;

  const restoredRoot = path.join(cwd, "wk-sp-2");
  const launchRoot = path.join(cwd, "workspace-test");
  await mkdir(restoredRoot, { recursive: true });
  await mkdir(launchRoot, { recursive: true });
  const restoredWorkspace = await initializeWorkspaceAtRoot(restoredRoot, workspaceStore, { label: "wk-sp-2" });
  const launchWorkspace = await initializeWorkspaceAtRoot(launchRoot, workspaceStore, { label: "workspace-test" });

  appState.launchWorkspace = launchWorkspace;
  appState.sessionsFile = sessionStore.upsert(
    appState.sessionsFile as { sessions: TuiSessionMeta[] },
    {
      ...(appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions[0]!,
      workspaceId: restoredWorkspace.manifest.workspaceId,
      workspaceRoot: restoredWorkspace.rootPath,
    },
  );

  const selection = await (appState.resolveInitialSelection as (profiles: unknown[]) => Promise<{
    session: TuiSessionMeta;
    workspace?: { rootPath: string };
  }>)(profiles);

  const sessions = (appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions;
  assert.equal(selection.workspace?.rootPath, launchWorkspace.rootPath);
  assert.equal(selection.session.workspaceRoot, launchWorkspace.rootPath);
  assert.notEqual(selection.session.name, "default");
  assert.equal(sessions.length, 2);
  assert.equal(sessions.some((session) => session.workspaceRoot === restoredWorkspace.rootPath), true);
  assert.equal(sessions.some((session) => session.workspaceRoot === launchWorkspace.rootPath), true);

  const uiStore = new UiStore(
    buildInitialUiRuntimeState({
      profile: activeProfile,
      activeSession: selection.session,
      sessions,
      transcript: [],
    }),
  );
  appState.uiStore = uiStore;
  await (appState.appendHistoryLine as (role: "system", text: string) => Promise<void>)(
    "system",
    `Started new session '${selection.session.name}' because launch workspace '${launchWorkspace.manifest.workspaceId}' differed from restored session workspace '${restoredWorkspace.manifest.workspaceId}'.`,
  );
  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Started new session/u);
  assert.match(rawHistory, /launch workspace/u);
});

test("startup preserves an explicit detached session instead of binding the launch workspace", async () => {
  const { app, cwd } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sessionStore = appState.sessionStore as SessionStore;
  const profiles = await (appState.profileStore as ProfileStore).load();

  const launchRoot = path.join(cwd, "workspace-test");
  await mkdir(launchRoot, { recursive: true });
  const launchWorkspace = await initializeWorkspaceAtRoot(launchRoot, appState.workspaceStore as WorkspaceStore, {
    label: "workspace-test",
  });
  appState.launchWorkspace = launchWorkspace;
  appState.sessionsFile = sessionStore.upsert(
    appState.sessionsFile as { sessions: TuiSessionMeta[] },
    {
      ...(appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions[0]!,
      workspaceBinding: "detached",
      workspaceId: "local:stale",
      workspaceRoot: path.join(cwd, "missing-workspace"),
    },
  );

  const selection = await (appState.resolveInitialSelection as (profiles: unknown[]) => Promise<{
    session: TuiSessionMeta;
    workspace?: { rootPath: string };
  }>)(profiles);

  assert.equal(selection.workspace, undefined);
  assert.equal(selection.session.workspaceBinding, "detached");
  assert.equal(selection.session.workspaceId, undefined);
  assert.equal(selection.session.workspaceRoot, undefined);
});

test("startup repairs a stale active workspace binding to the launch workspace", async () => {
  const { app, cwd } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sessionStore = appState.sessionStore as SessionStore;
  const profiles = await (appState.profileStore as ProfileStore).load();

  const launchRoot = path.join(cwd, "workspace-test");
  await mkdir(launchRoot, { recursive: true });
  const launchWorkspace = await initializeWorkspaceAtRoot(launchRoot, appState.workspaceStore as WorkspaceStore, {
    label: "workspace-test",
  });
  appState.launchWorkspace = launchWorkspace;
  appState.sessionsFile = sessionStore.upsert(
    appState.sessionsFile as { sessions: TuiSessionMeta[] },
    {
      ...(appState.sessionsFile as { sessions: TuiSessionMeta[] }).sessions[0]!,
      workspaceBinding: "active",
      workspaceId: "local:stale",
      workspaceRoot: path.join(cwd, "missing-workspace"),
    },
  );

  const selection = await (appState.resolveInitialSelection as (profiles: unknown[]) => Promise<{
    session: TuiSessionMeta;
    workspace?: { rootPath: string };
  }>)(profiles);

  assert.equal(selection.workspace?.rootPath, launchWorkspace.rootPath);
  assert.equal(selection.session.name, "default");
  assert.equal(selection.session.workspaceBinding, "active");
  assert.equal(selection.session.workspaceId, launchWorkspace.manifest.workspaceId);
  assert.equal(selection.session.workspaceRoot, launchWorkspace.rootPath);
  assert.match(
    (appState.startupNotices as string[]).join("\n"),
    /Workspace binding for session 'default' was stale; bound to launch workspace/u,
  );
});

test("startup resolves a unique session id fragment to the matching session", async () => {
  const { app } = await createAppHarness({ sessionName: "3373851798-178" });
  const appState = app as unknown as Record<string, unknown>;
  const sessionStore = appState.sessionStore as SessionStore;
  const profiles = await (appState.profileStore as ProfileStore).load();
  const activeProfile = (appState.uiStore as UiStore).getState().activeProfile;
  const now = new Date().toISOString();
  const targetSession: TuiSessionMeta = {
    name: "session-1783373851798",
    sessionId: "reference-session-1783373851798-1783373851801",
    profileId: activeProfile.id,
    createdAt: now,
    updatedAt: now,
    started: true,
  };
  appState.sessionsFile = sessionStore.upsert(
    appState.sessionsFile as { sessions: TuiSessionMeta[] },
    targetSession,
  );

  const selection = await (appState.resolveInitialSelection as (profiles: unknown[]) => Promise<{
    session: TuiSessionMeta;
  }>)(profiles);
  const sessionsFile = appState.sessionsFile as { activeSessionName?: string; sessions: TuiSessionMeta[] };

  assert.equal(selection.session.name, targetSession.name);
  assert.equal(sessionsFile.activeSessionName, targetSession.name);
});

test("fresh-session startup ignores restored active session and creates a new active session", async () => {
  const { app, cwd } = await createAppHarness({ freshSessionName: "fresh-session" });
  const appState = app as unknown as Record<string, unknown>;
  const sessionStore = appState.sessionStore as SessionStore;
  const profiles = await (appState.profileStore as ProfileStore).load();

  const workspaceRoot = path.join(cwd, "workspace-test");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await initializeWorkspaceAtRoot(workspaceRoot, appState.workspaceStore as WorkspaceStore, {
    label: "workspace-test",
  });
  appState.launchWorkspace = workspace;

  const selection = await (appState.resolveInitialSelection as (profiles: unknown[]) => Promise<{
    session: TuiSessionMeta;
    workspace?: { rootPath: string };
  }>)(profiles);

  const sessionsFile = appState.sessionsFile as { activeSessionName?: string; sessions: TuiSessionMeta[] };
  assert.equal(selection.session.name, "fresh-session");
  assert.equal(selection.workspace?.rootPath, workspace.rootPath);
  assert.equal(selection.session.workspaceRoot, workspace.rootPath);
  assert.equal(sessionsFile.activeSessionName, selection.session.name);
  assert.equal(sessionsFile.sessions.some((session) => session.name === "default"), true);
  assert.equal(sessionsFile.sessions.some((session) => session.name === "fresh-session"), true);
  assert.equal(sessionStore.getActive(sessionsFile)?.name, "fresh-session");
});

test("scripted fresh-session startup forces initial chat view without mutating other persisted state", async () => {
  const derived = deriveStartupPersistedUiState(
    { freshSessionName: "fresh-session", scripted: true },
    {
      activeView: "workspace",
      activeRegion: "sessions",
      themeMode: "dark",
      lastSelectedSession: "default",
    },
  );

  assert.ok(derived);
  assert.equal(derived.activeView, "chat");
  assert.equal(derived.activeRegion, "composer");
  assert.equal(derived.themeMode, "dark");
  assert.equal(derived.lastSelectedSession, "default");
});

test("non-scripted fresh-session startup preserves persisted navigation state", async () => {
  const derived = deriveStartupPersistedUiState(
    { freshSessionName: "fresh-session" },
    {
      activeView: "workspace",
      activeRegion: "sessions",
    },
  );

  assert.ok(derived);
  assert.equal(derived.activeView, "workspace");
  assert.equal(derived.activeRegion, "sessions");
});

test("scripted restored-session startup preserves persisted navigation state", async () => {
  const derived = deriveStartupPersistedUiState(
    { scripted: true },
    {
      activeView: "workspace",
      activeRegion: "sessions",
    },
  );

  assert.ok(derived);
  assert.equal(derived.activeView, "workspace");
  assert.equal(derived.activeRegion, "sessions");
});

test("Esc/goBack from history returns to the previous screen", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();

  uiStore.patch({
    activeView: "history",
    activeRegion: "sessions",
    focusRegion: "sessions",
    navigationStack: ["chat"],
  });

  controller.goBack();

  const next = uiStore.getState();
  assert.equal(next.activeView, "chat");
  assert.equal(next.activeRegion, "chat_list");
  assert.equal(next.focusRegion, "chat_list");
  assert.deepEqual(next.navigationStack, []);
});

test("goBack closes the detail drawer before changing screens", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();

  uiStore.patch({
    activeView: "recovery",
    activeRegion: "details",
    focusRegion: "details",
    navigationStack: ["chat"],
    detailDrawer: {
      ...uiStore.getState().detailDrawer,
      open: true,
      source: "recovery",
    },
  });

  controller.goBack();

  const next = uiStore.getState();
  assert.equal(next.activeView, "recovery");
  assert.equal(next.detailDrawer.open, false);
  assert.equal(next.activeRegion, "sessions");
  assert.equal(next.focusRegion, "sessions");
});

test("workspace navigation clears stale contextual search modes", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const navigateToView = appState.navigateToView as (
    this: unknown,
    view: string,
    options?: { remember?: boolean; region?: string; resetStack?: boolean },
  ) => void;

  uiStore.patch({
    activeView: "history",
    activeRegion: "sessions",
    focusRegion: "sessions",
    sessionsSearchMode: true,
    logsFilterMode: true,
  });

  navigateToView.call(appState, "workspace", { remember: true });

  const next = uiStore.getState();
  assert.equal(next.activeView, "workspace");
  assert.equal(next.activeRegion, "sessions");
  assert.equal(next.focusRegion, "sessions");
  assert.equal(next.sessionsSearchMode, false);
  assert.equal(next.logsFilterMode, false);
});

test("delegation and recovery views use workspace action lists for selection", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();

  uiStore.patch({
    activeView: "delegation",
    activeRegion: "sessions",
    focusRegion: "sessions",
    scroll: {
      ...uiStore.getState().scroll,
      sessions: {
        offset: 0,
        cursor: 0,
        tailLocked: false,
      },
    },
  });
  controller.moveActiveSelection(1);
  assert.equal(uiStore.getState().scroll.sessions.cursor, 1);

  uiStore.patch({
    activeView: "recovery",
    activeRegion: "sessions",
    focusRegion: "sessions",
    scroll: {
      ...uiStore.getState().scroll,
      sessions: {
        offset: 0,
        cursor: 0,
        tailLocked: false,
      },
    },
  });
  controller.moveActiveSelection(1);
  assert.equal(uiStore.getState().scroll.sessions.cursor, 1);
});

test("tasks maintain an independent scroll state from sessions", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();
  const state = uiStore.getState();
  const childOne: TuiSessionMeta = {
    name: "task-one",
    sessionId: "task-1",
    profileId: state.activeProfile.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    started: true,
    delegation: {
      taskId: "task-1",
      parentSessionId: state.activeSession.sessionId,
      title: "Task one",
      status: "RUNNING",
      childSessionId: "task-1",
      childSessionName: "task-one",
      profileId: state.activeProfile.id,
      provider: "openrouter",
      model: "gpt",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  const childTwo: TuiSessionMeta = {
    ...childOne,
    name: "task-two",
    sessionId: "task-2",
    delegation: {
      ...childOne.delegation!,
      taskId: "task-2",
      title: "Task two",
      childSessionId: "task-2",
      childSessionName: "task-two",
    },
  };

  uiStore.patch({
    sessions: [state.activeSession, childOne, childTwo],
    activeView: "tasks",
    activeRegion: "sessions",
    focusRegion: "sessions",
    scroll: {
      ...state.scroll,
      sessions: {
        offset: 0,
        cursor: 0,
        tailLocked: false,
      },
    },
    taskScroll: {
      offset: 0,
      cursor: 0,
      tailLocked: false,
    },
  });
  appState.sessionsFile = {
    ...(appState.sessionsFile as { activeSessionName?: string; sessions: TuiSessionMeta[] }),
    sessions: [state.activeSession, childOne, childTwo],
  };

  controller.moveActiveSelection(1);

  const next = uiStore.getState();
  assert.equal(next.taskScroll.cursor, 1);
  assert.equal(next.scroll.sessions.cursor, 0);
});

test("splash dismissal stays blocked until pre-flight reaches ready", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();

  uiStore.patch({
    splashVisible: true,
    splashPreflight: {
      phase: "running",
      summary: "handshaking session",
      checks: [
        { id: "runner", label: "runner", state: "ok", detail: "child" },
        { id: "handshake", label: "handshake", state: "running", detail: "session-1" },
      ],
    },
  });

  controller.dismissSplash();
  assert.equal(uiStore.getState().splashVisible, true);

  uiStore.patch({
    splashPreflight: {
      phase: "ready",
      summary: "pre-flight complete",
      checks: [
        { id: "runner", label: "runner", state: "ok", detail: "child" },
        { id: "handshake", label: "handshake", state: "ok", detail: "session linked" },
      ],
    },
  });

  controller.dismissSplash();
  assert.equal(uiStore.getState().splashVisible, false);
});

test("splash preflight trusts Local Core provider readiness over the TUI environment", async () => {
  const { app } = await createAppHarness({ scripted: true });
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const previousOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  let providerReadinessCalls = 0;

  process.env.OPENROUTER_API_KEY = "tui-only-openrouter-key";
  uiStore.patch({
    splashVisible: true,
    splashPreflight: {
      phase: "running",
      summary: "starting pre-flight",
      checks: [
        { id: "profiles", label: "profiles", state: "ok", detail: "reference" },
        { id: "session", label: "session", state: "ok", detail: "default" },
        { id: "theme", label: "theme", state: "ok", detail: "system" },
        { id: "runner", label: "runner", state: "pending", detail: "waiting" },
        { id: "handshake", label: "handshake", state: "pending", detail: "session-1" },
        { id: "database", label: "database", state: "pending", detail: "waiting" },
        { id: "provider", label: "credentials", state: "pending", detail: "openrouter" },
        { id: "mcp", label: "mcp", state: "pending", detail: "waiting" },
      ],
    },
  });
  appState.client = {
    start: () => {},
    sendCommand: async (type: string) => {
      assert.equal(type, "session.describe");
      return {
        type: "session.described",
        payload: {
          sessionId: "session-1",
          updatedAt: new Date().toISOString(),
        },
      };
    },
  };
  const localCoreStatus = appState.localCoreStatus as {
    client: Record<string, unknown>;
  };
  appState.runnerUsesLocalCore = true;
  localCoreStatus.client.providerReadiness = async () => {
    providerReadinessCalls += 1;
    return {
      ok: true,
      providerReadiness: {
        openrouter: { ready: false, credential: "missing" },
        openai: { ready: true, credential: "configured" },
        anthropic: { ready: false, credential: "missing" },
        ollama: { ready: true, credential: "not_required", beta: true },
        lmstudio: { ready: true, credential: "not_required", beta: true },
      },
      toolReadiness: {
        tavily: { ready: true, credential: "configured" },
      },
    };
  };

  try {
    await (appState.runSplashPreflight as () => Promise<void>)();

    const next = uiStore.getState();
    assert.equal(providerReadinessCalls, 1);
    assert.equal(next.splashPreflight.phase, "failed");
    assert.match(next.splashPreflight.summary, /Local Core.*openrouter.*missing/iu);
    assert.equal(
      next.splashPreflight.checks.find((check) => check.id === "provider")?.state,
      "fail",
    );
  } finally {
    restoreProcessEnv("OPENROUTER_API_KEY", previousOpenRouterApiKey);
  }
});

test("splash preflight trusts Local Core Tavily readiness over the TUI environment in both directions", async () => {
  const { app } = await createAppHarness({ scripted: true });
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const previousTavilyApiKey = process.env.TAVILY_API_KEY;
  let providerReadinessCalls = 0;
  let tavilyReady = false;

  process.env.TAVILY_API_KEY = "tui-only-tavily-key";
  uiStore.patch({
    splashVisible: true,
    splashPreflight: {
      phase: "running",
      summary: "starting pre-flight",
      checks: [
        { id: "profiles", label: "profiles", state: "ok", detail: "reference" },
        { id: "session", label: "session", state: "ok", detail: "default" },
        { id: "theme", label: "theme", state: "ok", detail: "system" },
        { id: "runner", label: "runner", state: "pending", detail: "waiting" },
        { id: "handshake", label: "handshake", state: "pending", detail: "session-1" },
        { id: "database", label: "database", state: "pending", detail: "waiting" },
        { id: "provider", label: "credentials", state: "pending", detail: "openrouter" },
        { id: "mcp", label: "mcp", state: "pending", detail: "waiting" },
      ],
    },
  });
  appState.client = {
    start: () => {},
    sendCommand: async () => ({
      type: "session.described",
      payload: {
        sessionId: "session-1",
        updatedAt: new Date().toISOString(),
      },
    }),
  };
  appState.runnerUsesLocalCore = true;
  appState.runSplashDatabaseCheck = async () => {};
  appState.runSplashMcpCheck = async () => {};
  const localCoreStatus = appState.localCoreStatus as {
    client: Record<string, unknown>;
  };
  localCoreStatus.client.providerReadiness = async () => {
    providerReadinessCalls += 1;
    return {
      ok: true,
      providerReadiness: {
        openrouter: { ready: true, credential: "configured" },
        openai: { ready: false, credential: "missing" },
        anthropic: { ready: false, credential: "missing" },
        ollama: { ready: true, credential: "not_required", beta: true },
        lmstudio: { ready: true, credential: "not_required", beta: true },
      },
      toolReadiness: {
        tavily: tavilyReady
          ? { ready: true, credential: "configured" }
          : { ready: false, credential: "missing" },
      },
    };
  };

  try {
    await (appState.runSplashPreflight as () => Promise<void>)();

    const next = uiStore.getState();
    assert.equal(providerReadinessCalls, 1);
    assert.equal(next.splashPreflight.phase, "failed");
    assert.match(next.splashPreflight.summary, /Local Core.*Tavily.*missing/iu);
    assert.equal(
      next.splashPreflight.checks.find((check) => check.id === "provider")?.state,
      "fail",
    );

    delete process.env.TAVILY_API_KEY;
    tavilyReady = true;
    uiStore.patch({
      splashVisible: true,
      splashPreflight: {
        ...next.splashPreflight,
        phase: "running",
        summary: "starting pre-flight",
        checks: next.splashPreflight.checks.map((check) =>
          check.id === "provider"
            ? { ...check, state: "pending", detail: "openrouter" }
            : check
        ),
      },
    });

    await (appState.runSplashPreflight as () => Promise<void>)();

    const ready = uiStore.getState();
    assert.equal(providerReadinessCalls, 2);
    assert.equal(ready.splashPreflight.phase, "ready");
    assert.equal(
      ready.splashPreflight.checks.find((check) => check.id === "provider")?.state,
      "ok",
    );
  } finally {
    restoreProcessEnv("TAVILY_API_KEY", previousTavilyApiKey);
  }
});

test("scripted mode auto-dismisses splash when pre-flight reaches ready", async () => {
  const { app } = await createAppHarness({ scripted: true });
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;

  uiStore.patch({
    splashVisible: true,
    splashPreflight: {
      phase: "running",
      summary: "refreshing mcp",
      checks: [
        { id: "runner", label: "runner", state: "ok", detail: "child" },
        { id: "mcp", label: "mcp", state: "running", detail: "refreshing" },
      ],
    },
  });

  await (appState.finalizeSplashPreflightPhase as (input: {
    phase: "ready" | "failed";
    summary: string;
    statusLine?: string;
  }) => Promise<void>)({
    phase: "ready",
    summary: "pre-flight complete",
  });

  const next = uiStore.getState();
  assert.equal(next.splashVisible, false);
  assert.equal(next.splashPreflight.phase, "ready");
  assert.equal(next.splashPreflight.summary, "pre-flight complete");
});

test("scripted mode auto-dismisses splash when pre-flight fails", async () => {
  const { app } = await createAppHarness({ scripted: true });
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;

  uiStore.patch({
    splashVisible: true,
    splashPreflight: {
      phase: "running",
      summary: "verifying credentials",
      checks: [
        { id: "runner", label: "runner", state: "ok", detail: "child" },
        { id: "provider", label: "provider", state: "fail", detail: "missing OPENAI_API_KEY" },
      ],
    },
  });

  await (appState.finalizeSplashPreflightPhase as (input: {
    phase: "ready" | "failed";
    summary: string;
    statusLine?: string;
  }) => Promise<void>)({
    phase: "failed",
    summary: "missing OPENAI_API_KEY",
    statusLine: "startup failed | mcp:unknown",
  });

  const next = uiStore.getState();
  assert.equal(next.splashVisible, false);
  assert.equal(next.splashPreflight.phase, "failed");
  assert.equal(next.splashPreflight.summary, "missing OPENAI_API_KEY");
  assert.equal(next.statusLine, "startup failed | mcp:unknown");
});

test("assistant replies keep chat pinned to the tail when already following", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const state = uiStore.getState();

  uiStore.patch({
    transcript: [
      {
        role: "user",
        text: "start",
        timestamp: new Date().toISOString(),
      },
    ],
    scroll: {
      ...state.scroll,
      chat: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
    },
  });

  await (appState.appendHistoryLine as (
    role: "assistant" | "user" | "system",
    text: string,
  ) => Promise<void>)(
    "assistant",
    "This is a long assistant reply that should wrap across multiple transcript rows and still leave the operator anchored at the bottom of the chat view.",
  );

  const next = uiStore.getState();
  const totalRows = (appState.getChatVisualRowCount as (state: ReturnType<UiStore["getState"]>) => number)(next);
  assert.equal(next.scroll.chat.tailLocked, true);
  assert.equal(next.scroll.chat.cursor, Math.max(0, totalRows - 1));
});

test("assistant replies keep tail-following when tail lock is true but cursor drifted", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const state = uiStore.getState();

  uiStore.patch({
    transcript: [
      {
        role: "assistant",
        text: "existing line one that wraps enough to create multiple visual rows in narrow layouts",
        timestamp: new Date().toISOString(),
      },
      {
        role: "assistant",
        text: "existing line two that also wraps and can leave the cursor slightly behind the final row",
        timestamp: new Date().toISOString(),
      },
    ],
  });

  const totalBefore = (appState.getChatVisualRowCount as (state: ReturnType<UiStore["getState"]>) => number)(
    uiStore.getState(),
  );
  const driftedCursor = Math.max(0, totalBefore - 2);
  uiStore.patch({
    scroll: {
      ...state.scroll,
      chat: {
        offset: Math.max(0, driftedCursor - 1),
        cursor: driftedCursor,
        tailLocked: true,
      },
    },
  });

  await (appState.appendHistoryLine as (
    role: "assistant" | "user" | "system",
    text: string,
  ) => Promise<void>)(
    "assistant",
    "new assistant output should still keep the view pinned to the newest rows when tail lock remains enabled",
  );

  const next = uiStore.getState();
  const totalAfter = (appState.getChatVisualRowCount as (state: ReturnType<UiStore["getState"]>) => number)(next);
  assert.equal(next.scroll.chat.tailLocked, true);
  assert.equal(next.scroll.chat.cursor, Math.max(0, totalAfter - 1));
});

test("chat paging leaves the live tail and preserves the reading position during new output", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();

  uiStore.patch({
    activeView: "chat",
    activeRegion: "composer",
    transcript: [
      {
        role: "assistant",
        text: Array.from(
          { length: 80 },
          (_, index) => `long-output-section-${index + 1}`,
        ).join(" "),
        timestamp: new Date().toISOString(),
      },
    ],
  });
  controller.updateViewport(80, 20);

  controller.pageActiveSelection("up");

  const browsing = uiStore.getState();
  const visualCountBeforeAppend = (
    appState.getChatVisualRowCount as (state: ReturnType<UiStore["getState"]>) => number
  )(browsing);
  assert.equal(browsing.scroll.chat.cursor < visualCountBeforeAppend - 1, true);
  assert.equal(browsing.scroll.chat.tailLocked, false);
  const readingCursor = browsing.scroll.chat.cursor;

  await (appState.appendHistoryLine as (
    role: "assistant" | "user" | "system",
    text: string,
  ) => Promise<void>)("assistant", "New output arrived while the operator was reading history.");

  const appended = uiStore.getState();
  assert.equal(appended.scroll.chat.tailLocked, false);
  assert.equal(appended.scroll.chat.cursor, readingCursor);

  controller.jumpActiveSelection("end");

  const caughtUp = uiStore.getState();
  const visualCountAfterAppend = (
    appState.getChatVisualRowCount as (state: ReturnType<UiStore["getState"]>) => number
  )(caughtUp);
  assert.equal(caughtUp.scroll.chat.tailLocked, true);
  assert.equal(caughtUp.scroll.chat.cursor, visualCountAfterAppend - 1);
});

test("natural-language mode switches are forwarded for runtime intent classification", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "planner_mode_blocked",
        requiredToolClass: "sandboxed_only",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  let capturedCommandType: string | undefined;
  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: { turn: Record<string, unknown> }) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      capturedCommandType = type;
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
            assistantText: null,
            output: {
              status: "COMPLETED",
              sessionId: "session-1",
              runId: "run-1",
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
            },
            finalizedPayload: {
              message: "done",
            },
          },
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("switch to build");

  assert.equal(capturedCommandType, "conversation.message.submit");
  assert.equal(capturedTurn?.eventType, undefined);
  assert.equal(capturedTurn?.message, "switch to build");
  assert.equal(capturedTurn?.resumeBlockedRun, undefined);

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /switch to build/u);
});

test("mode command resumes blocked runs with an explicit resume flag", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId: "request-mode-command",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Choose a mode.",
      },
      metadata: {
        reason: "route_mode_blocked",
        requiredToolClass: "sandboxed_only",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  let capturedCommandType: string | undefined;
  let capturedPayload: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      capturedCommandType = type;
      capturedPayload = payload;
      return {
        type: "operator.controlled",
        payload: {
          threadId: "thread-main:session-1",
          disposition: "completed",
          result: {
            assistantText: null,
            output: {
              status: "COMPLETED",
              sessionId: "session-1",
              runId: "run-2",
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
            },
            finalizedPayload: {
              message: "done",
            },
          },
        },
      };
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "mode",
    args: ["build"],
  });

  assert.equal(capturedCommandType, "operator.control");
  assert.equal(capturedPayload?.action, "reply");
  assert.equal(capturedPayload?.requestId, "request-mode-command");
  assert.equal(capturedPayload?.message, "/mode build");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Mode set to Build\. Resuming blocked run\./u);
});

test("mode build succeeds without a trailing submode and does not print usage", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "mode",
    args: ["build"],
  });

  const state = uiStore.getState().activeSession;
  assert.equal(state.interactionMode, "build");
  assert.equal(state.actSubmode, undefined);
  assert.equal(state.executionPolicy?.toolClassPolicy?.external_side_effect, undefined);

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Mode set to Build\./u);
  assert.doesNotMatch(rawHistory, /Usage: \/mode build(?: \[ask\|guarded\|auto\])?/u);
});

test("mode command rejects extra trailing arguments", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "mode",
    args: ["build", "ask", "now"],
  });
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "mode",
    args: ["chat", "now"],
  });

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Usage: \/mode status \| \/mode chat \| \/mode plan \| \/mode build/u);
  assert.doesNotMatch(rawHistory, /Mode set to Build: Ask First/u);
  assert.doesNotMatch(rawHistory, /Mode set to Chat/u);
});

test("mode command resets the TUI input box to the normal composer state", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;

  uiStore.patch({
    activeView: "logs",
    activeRegion: "command_bar",
    focusRegion: "command_bar",
    chatDraft: "/mode build",
    chatDraftExpanded: true,
    paletteOpen: true,
    paletteSource: "slash",
    paletteQuery: "mode act",
    paletteSelectedIndex: 1,
    logsFilterMode: true,
    sessionsSearchMode: true,
    commandBarReturnRegion: "logs",
    helpOpen: true,
    quitConfirm: true,
    navigationStack: ["logs"],
  });

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "mode",
    args: ["build"],
  });

  const next = uiStore.getState();
  assert.equal(next.chatDraft, "");
  assert.equal(next.chatDraftExpanded, false);
  assert.equal(next.paletteOpen, false);
  assert.equal(next.paletteSource, undefined);
  assert.equal(next.paletteQuery, "");
  assert.equal(next.logsFilterMode, false);
  assert.equal(next.sessionsSearchMode, false);
  assert.equal(next.commandBarReturnRegion, undefined);
  assert.equal(next.helpOpen, false);
  assert.equal(next.quitConfirm, false);
  assert.equal(next.activeView, "chat");
  assert.equal(next.activeRegion, "composer");
  assert.equal(next.focusRegion, "composer");
  assert.deepEqual(next.navigationStack, []);
});

test("mode build forwards canonical build mode on run.start", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "mode",
    args: ["build"],
  });

  const afterMode = uiStore.getState().activeSession;
  assert.equal(afterMode.interactionMode, "build");
  assert.equal(afterMode.actSubmode, undefined);
  assert.equal(afterMode.executionPolicy?.toolClassPolicy?.external_side_effect, undefined);

  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: { turn?: Record<string, unknown> }) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
            output: {
              status: "COMPLETED",
              sessionId: "session-1",
              runId: "run-mode-full-auto",
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
            },
            finalizedPayload: {
              message: "done",
            },
          },
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("run a shell command");
  assert.equal(
    (capturedTurn?.executionPolicy as { toolClassPolicy?: { external_side_effect?: boolean } } | undefined)
      ?.toolClassPolicy?.external_side_effect,
    undefined,
  );
});

test("re-entering build mode preserves the canonical execution policy", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "mode",
    args: ["build"],
  });
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "mode",
    args: ["build"],
  });

  const state = uiStore.getState().activeSession;
  assert.equal(state.interactionMode, "build");
  assert.equal(state.actSubmode, undefined);
  assert.equal(state.executionPolicy?.toolClassPolicy?.external_side_effect, undefined);
});

test("run completion appends finalize provenance notice when reporting grounding is present", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return {
        type: "run.completed",
        runId,
        payload: {
          result: {
            assistantText: "Implemented requested repository update.",
            output: {
              status: "COMPLETED",
              sessionId: "session-1",
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
                toolCalls: 1,
                modelCalls: 1,
                durationMs: 1,
              },
            },
            finalizedPayload: {
              message: "Implemented requested repository update.",
              data: {
                reportingGrounding: {
                  summary: "model_authored",
                  blockers: "runtime_linked",
                  residualRisks: "model_authored",
                  completionState: "inferred_from_workplan",
                },
              },
            },
          },
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("ship it");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Implemented requested repository update\./u);
  assert.match(rawHistory, /Finalize provenance: .*summary=model_authored.*blockers=runtime_linked/iu);
  assert.match(rawHistory, /model_authored are narrative and not runtime-verified facts\./u);
});

test("continuation grant history line confirms resumption without raw counters", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "max_steps_continuation",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      const runId = String((payload.turn as Record<string, unknown>).runId);
      return {
        type: "run.completed",
        runId,
        payload: {
          result: {
            output: {
              status: "WAITING",
              sessionId: "session-1",
              runId,
              waitFor: {
                kind: "user",
                eventType: "user.reply",
                metadata: {
                  reason: "max_steps_continuation",
                },
              },
              continuation: {
                outcome: "granted",
                extraStepsGranted: 10,
                continuationCount: 1,
              },
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
            },
          },
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("go on");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Continuation approved\. Resuming from the checkpoint\./u);
  assert.doesNotMatch(rawHistory, /10 more steps/u);
});

test("assembly command resolves the pending proposal id from operator inbox when omitted", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      if (type === "operator.inbox") {
        return {
          type: "operator.inbox",
          payload: {
            inbox: {
              items: [
                {
                  itemId: "proposal:assembly-proposal-1",
                  kind: "assembly_change_proposal",
                  title: "Review assembly change",
                  actionable: true,
                  createdAt: new Date().toISOString(),
                  metadata: {
                    proposalId: "assembly-proposal-1",
                  },
                },
              ],
              summary: {
                total: 1,
                actionable: 1,
                approvals: 0,
                userInputs: 0,
                checkpoints: 0,
                childBlockers: 0,
                stalled: 0,
                assemblyProposals: 1,
                compatibilityAlerts: 0,
              },
            },
          },
        };
      }
      return {
        type: "operator.controlled",
        payload: {
          threadId: "session-1",
        },
      };
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "assembly",
    args: ["approve"],
  });

  assert.equal(sent[0]?.type, "operator.inbox");
  assert.equal(sent[1]?.type, "operator.control");
  assert.equal(sent[1]?.payload.action, "approve_assembly_change");
  assert.equal(sent[1]?.payload.proposalId, "assembly-proposal-1");
});

test("continuation replies are forwarded for runtime intent classification", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "max_steps_continuation",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  let capturedCommandType: string | undefined;
  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: { turn: Record<string, unknown> }) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      capturedCommandType = type;
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
            output: {
              status: "WAITING",
              sessionId: "session-1",
              runId: "run-1",
              waitFor: {
                kind: "user",
                eventType: "user.reply",
                metadata: {
                  reason: "max_steps_continuation",
                },
              },
              continuation: {
                outcome: "granted",
                extraStepsGranted: 50,
                continuationCount: 1,
              },
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
            },
          },
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("resume");

  assert.equal(capturedCommandType, "conversation.message.submit");
  assert.equal(capturedTurn?.eventType, undefined);
  assert.equal(capturedTurn?.message, "resume");
  assert.equal(capturedTurn?.resumeBlockedRun, undefined);
});

test("non-continuation text during an ordinary wait leaves routing to the runtime", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "loop_visit_stall",
        resumeReply: "continue",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  let capturedCommandType: string | undefined;
  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: { turn: Record<string, unknown> }) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      capturedCommandType = type;
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
            assistantText: null,
            output: {
              status: "COMPLETED",
              sessionId: "session-1",
              runId: "run-fresh-wait-reply",
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
            },
            finalizedPayload: {
              message: "done",
            },
          },
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("stop copy edits and inspect the browser");

  assert.equal(capturedCommandType, "conversation.message.submit");
  assert.equal(capturedTurn?.eventType, undefined);
  assert.equal(capturedTurn?.message, "stop copy edits and inspect the browser");
  assert.equal(capturedTurn?.resumeBlockedRun, undefined);
});

test("exact continuation text during ordinary waits is routed by the runtime", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId: "request-continuation",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Continue?",
      },
      metadata: {
        reason: "loop_visit_stall",
        resumeReply: "continue",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  let capturedCommandType: string | undefined;
  let capturedPayload: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      capturedCommandType = type;
      capturedPayload = payload;
      return {
        type: "operator.controlled",
        payload: {
          threadId: "thread-main:session-1",
          disposition: "completed",
          result: {
            assistantText: null,
            output: {
              status: "COMPLETED",
              sessionId: "session-1",
              runId: "run-continuation-reply",
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
            },
            finalizedPayload: {
              message: "done",
            },
          },
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("continue");

  assert.equal(capturedCommandType, "operator.control");
  assert.equal(capturedPayload?.action, "reply");
  assert.equal(capturedPayload?.requestId, "request-continuation");
  assert.equal(capturedPayload?.message, "continue");
});

test("ordinary approval text does not forge or persist an approval reply", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "approval",
      eventType: "runtime.assembly_change",
      interaction: {
        version: "v1",
        requestId: "request-approval",
        kind: "approval",
        eventType: "runtime.assembly_change",
        prompt: "Approve?",
      },
      metadata: {
        approvalId: "approval-1",
        purpose: "managed_worktree",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  let capturedCommandType: string | undefined;
  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: { turn: Record<string, unknown> }) => {
      capturedCommandType = type;
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
            output: {
              status: "COMPLETED",
              sessionId: "session-1",
              runId: "run-approval-reply",
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
            },
            finalizedPayload: {
              message: "approved",
            },
          },
        },
      };
    },
  };
  (appState.uiStore as UiStore).patch({ chatDraft: "approve" });
  const transcriptLength = (appState.uiStore as UiStore).getState().transcript.length;

  await (appState.handleLine as (line: string) => Promise<void>)("approve");

  assert.equal(capturedCommandType, undefined);
  assert.equal(capturedTurn, undefined);
  assert.equal((appState.uiStore as UiStore).getState().chatDraft, "approve");
  assert.equal((appState.uiStore as UiStore).getState().transcript.length, transcriptLength);
  assert.match(
    (appState.uiStore as UiStore).getState().statusLine,
    /explicit \/approve or \/reject/u,
  );
});

test("continuation replies apply manual compaction when adaptation already recommends compact", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "max_steps_continuation",
      },
    },
    operatorState: {
      interactionMode: "plan",
      allowedToolClasses: ["read_only"],
      latestAdaptation: {
        status: "pending_checkpoint",
        recommendedAction: "compact",
        reason: "Thread is thrashing and should compact before more work continues.",
        at: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  });

  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (type: string, payload: { turn: Record<string, unknown> }) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
            output: {
              status: "WAITING",
              sessionId: "session-1",
              runId: "run-2",
              waitFor: {
                kind: "user",
                eventType: "user.reply",
                metadata: {
                  reason: "max_steps_continuation",
                },
              },
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
            },
            operatorAffordance: {
              interactionMode: "plan",
              allowedToolClasses: ["read_only"],
              context: {
                promptBudgetChars: 12_000,
                estimatedChars: 4000,
                degradationMode: "compact",
                droppedSections: ["observations.compact"],
                manualCompactionApplied: true,
              },
            },
          },
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("continue");

  assert.equal(capturedTurn?.resumeBlockedRun, undefined);
  assert.equal(capturedTurn?.manualCompaction, true);
});

test("continuation-like replies do not synthesize a grant line without runtime confirmation", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "max_steps_continuation",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  appState.client = {
    sendCommand: async (type: string) => {
      if (type === "session.describe") return makeExactTuiSessionDescription();
      return {
        type: "run.completed",
        payload: {
          result: {
            output: {
              status: "WAITING",
              sessionId: "session-1",
              runId: "run-2",
              waitFor: {
                kind: "user",
                eventType: "user.reply",
                metadata: {
                  reason: "max_steps_continuation",
                },
              },
              continuation: {
                outcome: "requested",
                extraStepsRequested: 50,
                continuationCount: 0,
              },
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
            },
          },
        },
      };
    },
  };

  await (appState.handleLine as (line: string) => Promise<void>)("go on");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.doesNotMatch(rawHistory, /Granted(?: \d+)? more steps\. Resuming run\./u);
});

test("run.agent_progress reduces into shared conversation activity", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;

  (appState.onRunnerEvent as (event: unknown) => void)({
    type: "run.agent_progress",
    payload: {
      update: {
        version: "v1",
        runId: "run-reasoning-1",
        sessionId: "session-1",
        ts: new Date().toISOString(),
        seq: 7,
        message: "Evaluating whether context compaction is needed before tool execution.",
        stepIndex: 2,
        stepAgent: "acter",
      },
    },
  });

  const activity = uiStore.getState().conversationActivity;
  assert.equal(activity.length, 1);
  assert.equal(activity[0]?.kind, "agent_progress");
  assert.equal(activity[0]?.text, "Evaluating whether context compaction is needed before tool execution.");
  assert.equal(activity[0]?.runId, "run-reasoning-1");
  assert.equal(activity[0]?.sequence, 7);
});

test("run.agent_progress coalesces bursty shared activity without history writes", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const historyStore = appState.historyStore as HistoryStore;

  let releaseAppend!: () => void;
  const appendGate = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  const originalAppend = historyStore.append.bind(historyStore);
  let appendCalls = 0;
  let concurrentAppends = 0;
  let maxConcurrentAppends = 0;
  let firstAppendBlocked = false;
  historyStore.append = (async (...args: Parameters<HistoryStore["append"]>) => {
    appendCalls += 1;
    concurrentAppends += 1;
    maxConcurrentAppends = Math.max(maxConcurrentAppends, concurrentAppends);
    try {
      if (firstAppendBlocked === false) {
        firstAppendBlocked = true;
        await appendGate;
      }
      return await originalAppend(...args);
    } finally {
      concurrentAppends -= 1;
    }
  }) as HistoryStore["append"];

  for (let index = 0; index < 40; index += 1) {
    (appState.onRunnerEvent as (event: unknown) => void)({
      type: "run.agent_progress",
      payload: {
        update: {
          version: "v1",
          runId: "run-reasoning-burst",
          sessionId: "session-1",
          ts: new Date().toISOString(),
          seq: index + 1,
          message: `Reasoning update ${index + 1}`,
          stepIndex: index,
          stepAgent: "agent.exec.collect",
        },
      },
    });
  }

  releaseAppend();

  const state = uiStore.getState();
  assert.equal(state.runLogs.filter((line) => line.eventName === "reasoning_update").length, 0);
  assert.equal(state.conversationActivity.length, 1);
  assert.equal(state.conversationActivity[0]?.text, "Reasoning update 40");
  assert.equal(state.conversationActivity[0]?.sequence, 40);
  assert.equal(appendCalls, 0);
  assert.equal(maxConcurrentAppends, 0);
});

test("chat resize and append preserve tail visibility using shared chat layout budget", async () => {
  const { app } = await createAppHarness({ scripted: true });
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const controller = (appState.buildController as () => InkAppController)();

  const longReply =
    "This assistant response is intentionally verbose so wrapping depends on the body width budget used by chat scroll calculations and rendered transcript rows.";
  uiStore.patch({
    transcript: [
      {
        role: "assistant",
        text: longReply,
        timestamp: new Date().toISOString(),
      },
    ],
    scroll: {
      ...uiStore.getState().scroll,
      chat: {
        offset: 0,
        cursor: 0,
        tailLocked: true,
      },
    },
  });

  controller.updateViewport(92, 24);
  const resizedState = uiStore.getState();
  const resizedLayout = resolveChatLayoutBudget({
    viewportColumns: resizedState.viewport.columns,
    viewportRows: resizedState.viewport.rows,
    detailDrawerOpen: false,
  });
  const resizedRows = buildChatVisualRows(resizedState.transcript, resizedLayout.wrappedBodyWidth);
  const expectedAfterResize = ensureChatCursorVisible(
    resizedRows,
    {
      ...resizedState.scroll.chat,
      cursor: resizedRows.length - 1,
      tailLocked: true,
    },
    resizedLayout.transcriptRows,
  );
  assert.deepEqual(resizedState.scroll.chat, expectedAfterResize);

  await (appState.appendHistoryLine as (role: "assistant", text: string) => Promise<void>)(
    "assistant",
    `${longReply} Additional wrapped rows are appended for regression coverage.`,
  );

  const appendedState = uiStore.getState();
  const appendedLayout = resolveChatLayoutBudget({
    viewportColumns: appendedState.viewport.columns,
    viewportRows: appendedState.viewport.rows,
    detailDrawerOpen: false,
  });
  const appendedRows = buildChatVisualRows(appendedState.transcript, appendedLayout.wrappedBodyWidth);
  const expectedAfterAppend = ensureChatCursorVisible(
    appendedRows,
    {
      ...appendedState.scroll.chat,
      cursor: appendedRows.length - 1,
      tailLocked: true,
    },
    appendedLayout.transcriptRows,
  );
  assert.deepEqual(appendedState.scroll.chat, expectedAfterAppend);
});
