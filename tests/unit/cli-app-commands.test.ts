import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import React from "react";
import { renderToString } from "ink";

import { App } from "../../cli/app/App.js";
import {
  bootstrapTuiApp,
  deriveStartupPersistedUiState,
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
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import { initializeWorkspaceAtRoot } from "../../cli/workspace/WorkspaceResolver.js";
import type { PaletteCommand } from "../../cli/app/PaletteController.js";
import type { InkAppController } from "../../cli/ink/AppRoot.js";
import type { TuiSessionMeta } from "../../cli/contracts.js";
import type { OperatorDelegationWorkspaceSnapshot } from "../../src/operatorShell.js";
import type { LocalCoreStatus } from "../../src/localCore/contracts.js";
import { startLocalCoreApiServer } from "../../src/localCore/api.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.process", "Local Core platform parsing accepts exact Node platform values", () => {
  assert.equal(parseLocalCorePlatform("linux"), "linux");
  assert.equal(parseLocalCorePlatform("darwin"), "darwin");
  assert.equal(parseLocalCorePlatform("LINUX"), undefined);
  assert.equal(parseLocalCorePlatform(""), undefined);
});

async function createAppHarness(input: {
  activeProfileId?: string;
  activeSkillPackId?: string;
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
    createdAt: now,
    updatedAt: now,
    started: true,
    ...(input.activeSkillPackId !== undefined ? { activeSkillPackId: input.activeSkillPackId } : {}),
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

contractTest("runtime.process", "App appends surfaced timeout details to the diagnostics log", async () => {
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

contractTest("runtime.process", "bootstrapTuiApp expands ~/ KESTREL_HOME for default stores", async () => {
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

contractTest("runtime.process", "bootstrapTuiApp defaults to shared Local Core home", async () => {
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

contractTest("runtime.process", "bootstrapTuiApp ignores legacy client persistence defaults", async () => {
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

contractTest("runtime.process", "bootstrapTuiApp carries a custom home's resolved Core transport into the App client", async () => {
  const root = await mkdtemp(path.join("/tmp", "kestrel-custom-home-core-"));
  const cwd = path.join(root, "cwd");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  const server = await startLocalCoreApiServer({
    env: { KESTREL_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.1",
    idleTimeoutMs: 0,
  });
  const previousDirect = process.env.KESTREL_LOCAL_CORE_DIRECT;
  const previousSocket = process.env.KESTREL_LOCAL_CORE_API_SOCKET;
  const previousToken = process.env.KESTREL_LOCAL_CORE_API_TOKEN;
  process.env.KESTREL_LOCAL_CORE_DIRECT = "0";
  delete process.env.KESTREL_LOCAL_CORE_API_SOCKET;
  delete process.env.KESTREL_LOCAL_CORE_API_TOKEN;

  try {
    const bootstrap = await bootstrapTuiApp({ cwd, kestrelHome: home, scripted: true });
    assert.equal(bootstrap.runnerTransportEnv.KESTREL_LOCAL_CORE_API_SOCKET, server.socketPath);
    assert.equal(bootstrap.runnerTransportEnv.KESTREL_LOCAL_CORE_API_TOKEN, server.token);
    const client = createConfiguredCliProtocolClient(bootstrap.runnerTransportEnv);
    try {
      const pong = await client.sendCommand("runner.ping", { nonce: "custom-home" });
      assert.equal(pong.type, "runner.pong");
    } finally {
      await client.close();
    }
  } finally {
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
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

contractTest("runtime.process", "applyLocalCoreShellEnvironment exports the Core database URL for runner storage", () => {
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

contractTest("runtime.process", "applyLocalCoreShellEnvironment clears untrusted DATABASE_URL when managed Core is blocked", () => {
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

contractTest("runtime.process", "applyLocalCoreShellEnvironment clears stale source marker when managed Core has no URL", () => {
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

contractTest("runtime.process", "formatCliLocalCoreStatus reports isolated dev homes visibly", async () => {
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

contractTest("runtime.process", "runSplashDatabasePreflight auto-starts the default local postgres target by default", async () => {
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

contractTest("runtime.process", "runSplashDatabasePreflight reports blocked Local Core before missing DATABASE_URL", async () => {
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

contractTest("runtime.process", "runSplashDatabasePreflight trusts healthy managed Local Core instead of probing its socket URL as TCP", async () => {
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

contractTest("runtime.process", "runSplashDatabasePreflight still requires DATABASE_URL for explicit postgres store mode", async () => {
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

contractTest("runtime.process", "profiles use rebinds the active session and subsequent history to the selected profile", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "profiles",
    args: ["use", "reference"],
  });

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeProfile.id, "reference");
  assert.equal(state.activeSession.profileId, "reference");
  assert.equal(state.sessions[0]?.profileId, "reference");

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
  assert.match(rendered, /profile=reference/u);

  const rawHistory = await readFile(historyPath, "utf8");
  const records = rawHistory
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { profileId: string; text: string });
  const lastRecord = records[records.length - 1];
  assert.equal(lastRecord?.profileId, "reference");
  assert.match(String(lastRecord?.text), /Profile set to 'reference'/u);
  assert.doesNotMatch(String(lastRecord?.text), /provider=|openai|anthropic/u);
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

contractTest("runtime.process", "model commands update shared model policy and refresh the active profile authority", async () => {
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

contractTest("runtime.process", "model command falls back to local policy when cached Local Core client has a missing socket", async () => {
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

contractTest("runtime.process", "model command lists current provider options", async () => {
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
  assert.equal(policy.model, "z-ai/glm-5.2");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Recommended models for 'openrouter':/u);
  assert.match(rawHistory, /\* z-ai\/glm-5\.2/u);
  assert.match(rawHistory, /Use \/model search <query> to browse/u);
});

contractTest("runtime.process", "model command prefers the live OpenRouter catalog when available", async () => {
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

contractTest("runtime.process", "model set-provider requires a follow-up model selection before mutating policy", async () => {
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
    assert.equal(policy.model, "z-ai/glm-5.2");

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

contractTest("runtime.process", "model set-provider uses the live Ollama catalog when available", async () => {
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

contractTest("runtime.process", "model search uses the pending provider during provider selection", async () => {
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

contractTest("runtime.process", "model set rejects values outside the current provider allowlist", async () => {
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

contractTest("runtime.process", "theme command switches persisted theme mode", async () => {
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

contractTest("runtime.process", "start task journey creates a session with selected profile, mode, and launch summary", async () => {
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
  await (appState.handleLine as (line: string) => Promise<void>)("Investigate queue latency");
  await (appState.handleLine as (line: string) => Promise<void>)("reference");
  await (appState.handleLine as (line: string) => Promise<void>)("build");
  await (appState.handleLine as (line: string) => Promise<void>)("skip");

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.name, "Investigate queue latency");
  assert.equal(state.activeSession.profileId, "reference");
  assert.equal(state.activeSession.launchPresetId, "investigation");
  assert.equal(state.activeSession.launchTemplateId, "investigation-task");
  assert.equal(state.activeSession.workspaceBinding, "detached");
  assert.equal(state.activeSession.interactionMode, "build");
  assert.equal(state.activeSession.actSubmode, "safe");
  assert.equal(state.activeProfile.id, "reference");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Start task journey/u);
  assert.match(rawHistory, /Started new session 'Investigate queue latency'\./u);
  assert.match(rawHistory, /Task=Investigate queue latency/u);
});

contractTest("runtime.process", "start task journey clears inherited preset metadata when preset none is selected", async () => {
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
  await (appState.handleLine as (line: string) => Promise<void>)("Investigate queue latency");
  await (appState.handleLine as (line: string) => Promise<void>)("current");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("skip");

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.launchTemplateId, "investigation-task");
  assert.equal(state.activeSession.launchPresetId, undefined);
});

contractTest("runtime.process", "start task journey rejects active workspace binding when no workspace is available", async () => {
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

contractTest("runtime.process", "start task journey treats launch workspace as current when active session is detached", async () => {
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
  await (appState.handleLine as (line: string) => Promise<void>)("Scaffold app");
  await (appState.handleLine as (line: string) => Promise<void>)("current");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("skip");

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.workspaceBinding, "active");
  assert.equal(state.activeSession.workspaceId, workspace.manifest.workspaceId);
  assert.equal(state.activeSession.workspaceRoot, workspace.rootPath);
});

contractTest("runtime.process", "/workspace list shows discovered workspaces and /workspace use binds the active session", async () => {
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

contractTest("runtime.process", "bare /workspace opens workspace journey surface", async () => {
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

contractTest("runtime.process", "start task journey accepts a discovered workspace id", async () => {
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
  await (appState.handleLine as (line: string) => Promise<void>)("Investigate workspace selection");
  await (appState.handleLine as (line: string) => Promise<void>)("current");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("skip");

  const state = (appState.uiStore as UiStore).getState();
  assert.equal(state.activeSession.workspaceId, workspace.manifest.workspaceId);
  assert.equal(state.activeSession.workspaceRoot, workspace.rootPath);
  assert.equal(state.activeSession.workspaceBinding, "active");
});

contractTest("runtime.process", "/mcp opens the MCP workspace and stores the latest MCP snapshot", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  appState.client = {
    sendCommand: async (type: string) => {
      assert.equal(type, "mcp.status");
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

contractTest("runtime.process", "/code opens the code workspace", async () => {
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

contractTest("runtime.process", "/child opens delegation review by default", async () => {
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

contractTest("runtime.process", "guided child mission sends operator control through the active runner profile", async () => {
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
  await (appState.handleLine as (line: string) => Promise<void>)("Investigate the blocker");
  await (appState.handleLine as (line: string) => Promise<void>)("Find the exact runtime failure");
  await (appState.handleLine as (line: string) => Promise<void>)("Return a minimal fix");

  const control = sent.find((entry) => entry.type === "operator.control");
  assert.equal(control?.payload.action, "spawn_child_thread");
  assert.equal((control?.metadata?.profile as { id?: string } | undefined)?.id, "reference");
});

contractTest("runtime.process", "/checkpoint opens recovery center by default and loads workspace checkpoints", async () => {
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

contractTest("runtime.process", "/checkpoint accept refreshes describe before resolving a stale local context checkpoint", async () => {
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

contractTest("runtime.process", "/checkpoint accept falls back to operator inbox when describe has no latest checkpoint", async () => {
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

contractTest("runtime.process", "/checkpoint defer with explicit id resolves via continue", async () => {
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

contractTest("runtime.process", "/snapshot captures a workspace snapshot with an optional label", async () => {
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

contractTest("runtime.process", "/restore opens recovery center without an id and restores explicit snapshots with an id", async () => {
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

contractTest("runtime.process", "/deny aliases the reject operator control path", async () => {
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

contractTest("runtime.process", "SessionsView renders additive assembly state in the detail drawer", async () => {
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

  assert.match(rendered, /assembly=Reference default/u);
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

contractTest("runtime.process", "TasksView renders additive assembly provider, variant, and downgrade markers", async () => {
  const session: TuiSessionMeta = {
    name: "delegated-task",
    sessionId: "task-session-1",
    profileId: "reference",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    started: true,
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

  assert.match(rendered, /Task downgraded bundle/u);
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

contractTest("runtime.process", "SessionsView keeps focused thread and blocker parity in the detail drawer", async () => {
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

contractTest("runtime.process", "SessionsView and TasksView surface stalled attention in row statuses", () => {
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

contractTest("runtime.process", "skill status output remains tool and instruction focused", async () => {
  const { app, historyPath } = await createAppHarness({
    activeSkillPackId: "research",
  });
  const appState = app as unknown as Record<string, unknown>;

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "skill",
    args: ["status"],
  });

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Skill pack: research/u);
  assert.match(rawHistory, /Allowed tools:/u);
  assert.doesNotMatch(rawHistory, /MCP profile/u);
});

contractTest("runtime.process", "palette draft actions seed the composer instead of executing immediately", async () => {
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

contractTest("runtime.process", "stop command aliases to operator steer with a default stop message", async () => {
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
    command: "stop",
    args: [],
  });

  assert.equal(sent[0]?.type, "run.cancel");
  assert.equal(sent[1]?.type, "operator.control");
  assert.equal(sent[1]?.payload.action, "steer");
  assert.equal(
    sent[1]?.payload.message,
    "Stop your current work immediately and wait for further instructions.",
  );
});

contractTest("runtime.process", "stop command cancels the active run before sending steering when the session is running", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  uiStore.patch({ running: true });
  appState.client = {
    sendCommand: async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      return type === "run.cancel"
        ? {
            type: "run.cancelled",
            payload: {
              sessionId: "session-1",
            },
          }
        : {
            type: "operator.controlled",
            payload: {
              threadId: "session-1",
            },
          };
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "stop",
    args: [],
  });

  assert.equal(sent[0]?.type, "run.cancel");
  assert.equal(sent[0]?.payload.sessionId, "session-1");
  assert.equal(sent[1]?.type, "operator.control");
  assert.equal(sent[1]?.payload.action, "steer");
});

contractTest("runtime.process", "interactive operator commands bypass the queued input drain while a run is active", async () => {
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
  assert.equal((sent[0]?.metadata?.profile as { id?: string } | undefined)?.id, "reference");
});

contractTest("runtime.process", "/steer during a pending wait sends operator control instead of resuming the wait", async () => {
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

contractTest("runtime.process", "interactive operator command failures surface in the TUI instead of escaping", async () => {
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

contractTest("runtime.process", "plain submissions during a running turn stay on the queued turn path", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  let queued: string | undefined;

  uiStore.patch({ running: true });
  appState.enqueueInput = (line: string) => {
    queued = line;
  };

  (appState.submitInput as (line: string) => void)("also check the failing test output");

  assert.equal(queued, "also check the failing test output");
});

contractTest("runtime.process", "queue command strips the control prefix before starting the queued turn", async () => {
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

contractTest("runtime.process", "queue command during a running turn waits for queue drain before starting", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;
  const uiStore = appState.uiStore as UiStore;
  const turns: Array<{ submittedMessage: string }> = [];

  uiStore.patch({ running: true });
  appState.startActiveTurn = async (input: { submittedMessage: string }) => {
    turns.push(input);
  };

  await (appState.handleLine as (line: string) => Promise<void>)("/queue also check the failing test output");

  assert.equal(turns.length, 0);

  uiStore.patch({ running: false });
  await (appState.drainQueue as () => Promise<void>).call(app);

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.submittedMessage, "also check the failing test output");
});

contractTest("runtime.process", "delegation workspace renders result-only error and reference child outcomes", async () => {
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

contractTest("runtime.process", "controller submitLine drops duplicate same-event composer submissions", async () => {
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

contractTest("runtime.process", "controller submitLine allows intentional resubmit after the draft changes", async () => {
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

contractTest("runtime.process", "controller submitLine drops duplicate interactive operator commands while running", async () => {
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

contractTest("runtime.process", "closing the palette restores the previously visible region", async () => {
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

contractTest("runtime.process", "workspace status registers the current folder in the catalog", async () => {
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

contractTest("runtime.process", "workspace status preserves an explicit detached session binding", async () => {
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

contractTest("runtime.process", "closing command-bar search restores the prior chat region", async () => {
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

contractTest("runtime.process", "slash palette opens the full command catalog while manual palette stays collapsed", async () => {
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

contractTest("runtime.process", "exact palette commands move the operator back to chat", async () => {
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

contractTest("runtime.process", "startup workspace conflict creates a new session bound to the launch workspace", async () => {
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

contractTest("runtime.process", "startup preserves an explicit detached session instead of binding the launch workspace", async () => {
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

contractTest("runtime.process", "startup repairs a stale active workspace binding to the launch workspace", async () => {
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

contractTest("runtime.process", "startup resolves a unique session id fragment to the matching session", async () => {
  const { app } = await createAppHarness({ sessionName: "3373851798-178" });
  const appState = app as unknown as Record<string, unknown>;
  const sessionStore = appState.sessionStore as SessionStore;
  const profiles = await (appState.profileStore as ProfileStore).load();
  const now = new Date().toISOString();
  const targetSession: TuiSessionMeta = {
    name: "session-1783373851798",
    sessionId: "reference-session-1783373851798-1783373851801",
    profileId: "reference",
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

contractTest("runtime.process", "fresh-session startup ignores restored active session and creates a new active session", async () => {
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

contractTest("runtime.process", "scripted fresh-session startup forces initial chat view without mutating other persisted state", async () => {
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

contractTest("runtime.process", "non-scripted fresh-session startup preserves persisted navigation state", async () => {
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

contractTest("runtime.process", "scripted restored-session startup preserves persisted navigation state", async () => {
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

contractTest("runtime.process", "Esc/goBack from history returns to the previous screen", async () => {
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

contractTest("runtime.process", "goBack closes the detail drawer before changing screens", async () => {
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

contractTest("runtime.process", "workspace navigation clears stale contextual search modes", async () => {
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

contractTest("runtime.process", "delegation and recovery views use workspace action lists for selection", async () => {
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

contractTest("runtime.process", "tasks maintain an independent scroll state from sessions", async () => {
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

contractTest("runtime.process", "splash dismissal stays blocked until pre-flight reaches ready", async () => {
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

contractTest("runtime.process", "scripted mode auto-dismisses splash when pre-flight reaches ready", async () => {
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

contractTest("runtime.process", "scripted mode auto-dismisses splash when pre-flight fails", async () => {
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

contractTest("runtime.process", "assistant replies keep chat pinned to the tail when already following", async () => {
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

contractTest("runtime.process", "assistant replies keep tail-following when tail lock is true but cursor drifted", async () => {
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

contractTest("runtime.process", "natural-language mode switches are forwarded for runtime intent classification", async () => {
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

  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (_type: string, payload: { turn: Record<string, unknown> }) => {
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
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

  assert.equal(capturedTurn?.eventType, "user.reply");
  assert.equal(capturedTurn?.message, "switch to build");
  assert.equal(capturedTurn?.resumeBlockedRun, undefined);

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /switch to build/u);
});

contractTest("runtime.process", "mode command resumes blocked runs with an explicit resume flag", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "route_mode_blocked",
        requiredToolClass: "sandboxed_only",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (_type: string, payload: { turn: Record<string, unknown> }) => {
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
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

  assert.equal(capturedTurn?.eventType, "user.reply");
  assert.equal(capturedTurn?.message, "/mode build");
  assert.equal(capturedTurn?.resumeBlockedRun, true);

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Mode set to Build\. Resuming blocked run\./u);
});

contractTest("runtime.process", "mode build succeeds without a trailing submode and does not print usage", async () => {
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

contractTest("runtime.process", "mode command rejects extra trailing arguments", async () => {
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

contractTest("runtime.process", "mode command resets the TUI input box to the normal composer state", async () => {
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

contractTest("runtime.process", "mode build forwards canonical build mode on run.start", async () => {
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
    sendCommand: async (_type: string, payload: { turn: Record<string, unknown> }) => {
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

contractTest("runtime.process", "re-entering build mode preserves the canonical execution policy", async () => {
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

contractTest("runtime.process", "run completion appends finalize provenance notice when reporting grounding is present", async () => {
  const { app, historyPath } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  appState.client = {
    sendCommand: async () => ({
      type: "run.completed",
      payload: {
        result: {
          assistantText: "Implemented requested repository update.",
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
    }),
  };

  await (appState.handleLine as (line: string) => Promise<void>)("ship it");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Implemented requested repository update\./u);
  assert.match(rawHistory, /Finalize provenance: .*summary=model_authored.*blockers=runtime_linked/iu);
  assert.match(rawHistory, /model_authored are narrative and not runtime-verified facts\./u);
});

contractTest("runtime.process", "continuation grant history line is driven by runtime output", async () => {
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
    sendCommand: async () => ({
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
    }),
  };

  await (appState.handleLine as (line: string) => Promise<void>)("go on");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.match(rawHistory, /Granted 10 more steps\. Resuming run\./u);
});

contractTest("runtime.process", "assembly command resolves the pending proposal id from operator inbox when omitted", async () => {
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

contractTest("runtime.process", "continuation replies are forwarded for runtime intent classification", async () => {
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

  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (_type: string, payload: { turn: Record<string, unknown> }) => {
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

  assert.equal(capturedTurn?.eventType, "user.reply");
  assert.equal(capturedTurn?.message, "resume");
  assert.equal(capturedTurn?.resumeBlockedRun, undefined);
});

contractTest("runtime.process", "non-continuation replies during pending waits start a fresh user turn", async () => {
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

  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (_type: string, payload: { turn: Record<string, unknown> }) => {
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
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

  assert.equal(capturedTurn?.eventType, "user.message");
  assert.equal(capturedTurn?.message, "stop copy edits and inspect the browser");
  assert.equal(capturedTurn?.resumeBlockedRun, undefined);
});

contractTest("runtime.process", "exact continuation replies during pending waits resume the blocked run", async () => {
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

  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (_type: string, payload: { turn: Record<string, unknown> }) => {
      capturedTurn = payload.turn;
      return {
        type: "run.completed",
        payload: {
          result: {
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

  assert.equal(capturedTurn?.eventType, "user.reply");
  assert.equal(capturedTurn?.message, "continue");
  assert.equal(capturedTurn?.resumeBlockedRun, true);
});

contractTest("runtime.process", "approval replies during pending waits resume the blocked run", async () => {
  const { app } = await createAppHarness();
  const appState = app as unknown as Record<string, unknown>;

  await (appState.setActiveSessionState as (patch: Record<string, unknown>) => Promise<void>)({
    pendingWaitFor: {
      kind: "approval",
      eventType: "user.approval",
      metadata: {
        approvalId: "approval-1",
        purpose: "managed_worktree",
      },
    },
    updatedAt: new Date().toISOString(),
  });

  let capturedTurn: Record<string, unknown> | undefined;
  appState.client = {
    sendCommand: async (_type: string, payload: { turn: Record<string, unknown> }) => {
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

  await (appState.handleLine as (line: string) => Promise<void>)("approve");

  assert.equal(capturedTurn?.eventType, "user.approval");
  assert.equal(capturedTurn?.message, "approve");
  assert.equal(capturedTurn?.resumeBlockedRun, true);
});

contractTest("runtime.process", "continuation replies apply manual compaction when adaptation already recommends compact", async () => {
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
    sendCommand: async (_type: string, payload: { turn: Record<string, unknown> }) => {
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

contractTest("runtime.process", "continuation-like replies do not synthesize a grant line without runtime confirmation", async () => {
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
    sendCommand: async () => ({
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
    }),
  };

  await (appState.handleLine as (line: string) => Promise<void>)("go on");

  const rawHistory = await readFile(historyPath, "utf8");
  assert.doesNotMatch(rawHistory, /Granted(?: \d+)? more steps\. Resuming run\./u);
});

contractTest("runtime.process", "run.agent_progress appends durable assistant progress transcript lines", async () => {
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

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = uiStore.getState();
    const last = state.transcript[state.transcript.length - 1];
    if (last?.text === "Evaluating whether context compaction is needed before tool execution.") {
      assert.equal(last.role, "assistant");
      assert.equal(last.data?.agentProgress, true);
      assert.equal(last.data?.label, "Agent progress");
      assert.equal(last.data?.runId, "run-reasoning-1");
      assert.equal(last.data?.seq, 7);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.fail("expected reasoning line to be appended to transcript");
});

contractTest("runtime.process", "run.agent_progress coalesces bursty durable transcript updates", async () => {
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

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const transcript = uiStore.getState().transcript;
    const last = transcript[transcript.length - 1];
    if (last?.text === "Reasoning update 40") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const state = uiStore.getState();
  const reasoningLines = state.transcript.filter((line) => line.data?.agentProgress === true);
  assert.equal(state.runLogs.filter((line) => line.eventName === "reasoning_update").length, 0);
  assert.equal(reasoningLines.length, 2);
  assert.equal(reasoningLines[0]?.text, "Reasoning update 1");
  assert.equal(reasoningLines[1]?.text, "Reasoning update 40");
  assert.equal(reasoningLines[1]?.data?.seq, 40);
  assert.equal(appendCalls, 2);
  assert.equal(maxConcurrentAppends, 1);
});

contractTest("runtime.process", "chat resize and append preserve tail visibility using shared chat layout budget", async () => {
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
