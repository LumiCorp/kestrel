import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalCoreApiError,
  LocalCoreClient,
  resolveLocalCorePaths,
  startLocalCoreApiServer,
} from "../../src/localCore/index.js";
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import { SessionStore } from "../../cli/session/SessionStore.js";
import { ProfileStore } from "../../cli/config/ProfileStore.js";
import { HistoryStore } from "../../cli/history/HistoryStore.js";
import { UiStateStore } from "../../cli/ink/persistence/UiStateStore.js";
import { KcronStateStore } from "../../cli/kcron/state.js";
import { readRuntimeSettings, writeRuntimeSettings } from "../../cli/config/RuntimeSettings.js";

test("Local Core API serves health/status with bearer token auth", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const paths = resolveLocalCorePaths(home);
    assert.equal(server.socketPath, paths.apiSocketPath);
    assert.equal((await readFile(paths.apiTokenPath, "utf8")).trim(), server.token);

    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    assert.deepEqual(await client.health(), { ok: true });
    const status = await client.status();
    assert.equal(status.state, "healthy");
    assert.equal(status.home.homePath, home);
    assert.equal(status.lock.state, "live");
    assert.equal(status.lock.lock.socketPath, paths.apiSocketPath);

    const bundleResponse = await client.supportBundle() as {
      supportBundle?: {
        runtime?: {
          home?: { homePath?: string | undefined } | undefined;
          manifest?: { coreVersion?: string | undefined } | null | undefined;
          dbMode?: string | undefined;
          migrations?: unknown;
          socketPresence?: { apiSocketPath?: string | undefined; apiSocketPresent?: boolean | undefined } | undefined;
        } | undefined;
        extra?: { legacyState?: { coreHome?: string | undefined } | undefined } | undefined;
      } | undefined;
    };
    assert.match(bundleResponse.supportBundle?.runtime?.home?.homePath ?? "", /kestrel-core-api-/u);
    assert.equal(bundleResponse.supportBundle?.runtime?.manifest?.coreVersion, "0.5.0-beta.0");
    assert.equal(bundleResponse.supportBundle?.runtime?.dbMode, "external");
    assert.equal("migrations" in (bundleResponse.supportBundle?.runtime ?? {}), true);
    assert.match(bundleResponse.supportBundle?.runtime?.socketPresence?.apiSocketPath ?? "", /core\/api\.sock$/u);
    assert.equal(bundleResponse.supportBundle?.runtime?.socketPresence?.apiSocketPresent, true);
    assert.match(bundleResponse.supportBundle?.extra?.legacyState?.coreHome ?? "", /kestrel-core-api-/u);

    const unauthorized = new LocalCoreClient({ socketPath: server.socketPath, token: "wrong" });
    await assert.rejects(
      () => unauthorized.status(),
      (error) => error instanceof LocalCoreApiError && error.statusCode === 401,
    );
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API exposes shared workspace and legacy-state endpoints", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-workspaces-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-workspace-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    await client.addWorkspace({
      workspaceId: "ws-api",
      rootPath: workspaceRoot,
      label: "API Workspace",
    });
    const workspaces = await client.workspaces() as {
      workspaces?: Array<{ workspaceId: string; rootPath: string; label?: string | undefined }>;
    };
    assert.equal(workspaces.workspaces?.[0]?.workspaceId, "ws-api");
    assert.equal(workspaces.workspaces?.[0]?.rootPath, workspaceRoot);
    assert.equal(workspaces.workspaces?.[0]?.label, "API Workspace");

    const legacy = await client.legacyState() as {
      legacyState?: { coreHome?: string | undefined; entries?: Array<{ name: string; status: string }> | undefined };
    };
    assert.equal(legacy.legacyState?.coreHome, home);
    assert.equal(legacy.legacyState?.entries?.some((entry) => entry.name === "local_core" && entry.status === "present"), true);
  } finally {
    await server.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API owns default shell stores through client-backed adapters", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-stores-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  const previousCoreHome = process.env.KESTREL_CORE_HOME;
  const previousSocket = process.env.KESTREL_LOCAL_CORE_API_SOCKET;
  const previousToken = process.env.KESTREL_LOCAL_CORE_API_TOKEN;
  try {
    process.env.KESTREL_CORE_HOME = home;
    process.env.KESTREL_LOCAL_CORE_API_SOCKET = server.socketPath;
    process.env.KESTREL_LOCAL_CORE_API_TOKEN = server.token;

    const workspaceStore = new WorkspaceStore(home);
    await workspaceStore.save({
      version: 3,
      workspaces: [{
        workspaceId: "ws-core",
        rootPath: home,
        automationEnabled: true,
        discoveredAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      }],
    });
    assert.equal((await new WorkspaceStore(home).load()).workspaces[0]?.workspaceId, "ws-core");

    const sessionStore = new SessionStore(home);
    await sessionStore.save({
      version: 5,
      activeSessionName: "shell",
      sessions: [{
        name: "shell",
        sessionId: "session-shell",
        profileId: "reference",
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
        started: true,
      }],
    });
    assert.equal((await new SessionStore(home).load()).activeSessionName, "shell");

    const profiles = await new ProfileStore(home).load();
    assert.equal(profiles.some((profile) => profile.id === "reference"), true);

    await new HistoryStore(home).append({
      source: "runner",
      eventId: "event-1",
      sessionId: "session-shell",
      sessionName: "shell",
      profileId: "reference",
      timestamp: "2026-06-17T00:00:00.000Z",
      role: "assistant",
      text: "hello from Core",
    });
    assert.equal((await new HistoryStore(home).readTranscript("session-shell"))[0]?.text, "hello from Core");

    await new UiStateStore(home).save({
      version: 5,
      activeView: "chat",
      activeRegion: "composer",
      layoutMode: "minimal",
      paneSizes: { sessions: 0.28, chat: 0.44, logs: 0.28 },
      themeMode: "system",
      splashVisible: false,
      densityMode: "dense",
      layoutProfile: "wide",
      overlayLayout: "adaptive",
      logFilters: {
        level: "ALL",
        eventQuery: "",
        runIdQuery: "",
        paused: false,
        grouped: true,
      },
      scroll: {
        chat: { offset: 0, cursor: 0, tailLocked: false },
        logs: { offset: 0, cursor: 0, tailLocked: false },
        sessions: { offset: 0, cursor: 0, tailLocked: false },
      },
      detailDrawer: {
        open: false,
        source: "chat",
        expanded: false,
      },
      paletteRecentCommands: [],
    });
    assert.equal((await new UiStateStore(home).load())?.activeView, "chat");

    await writeRuntimeSettings(home, {
      version: 1,
      defaults: { minimalMode: true },
    });
    assert.equal((await readRuntimeSettings(home)).defaults.minimalMode, true);

    await new KcronStateStore(home).save({
      version: 1,
      daemon: {
        pid: process.pid,
        startedAt: "2026-06-17T00:00:00.000Z",
        heartbeatAt: "2026-06-17T00:00:01.000Z",
      },
      workspaces: {},
    });
    assert.equal((await new KcronStateStore(home).load()).daemon?.pid, process.pid);
  } finally {
    restoreEnv("KESTREL_CORE_HOME", previousCoreHome);
    restoreEnv("KESTREL_LOCAL_CORE_API_SOCKET", previousSocket);
    restoreEnv("KESTREL_LOCAL_CORE_API_TOKEN", previousToken);
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API owns kcron duplicate lease decisions", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-kcron-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    const acquired = await client.postJson("/v1/kcron/lease/acquire", { ownerPid: process.pid }) as { acquired?: boolean };
    assert.equal(acquired.acquired, true);

    const duplicate = await client.postJson("/v1/kcron/lease/acquire", { ownerPid: process.pid + 1 }) as {
      acquired?: boolean;
      reason?: string | undefined;
    };
    assert.equal(duplicate.acquired, false);
    assert.match(duplicate.reason ?? "", /already running/u);

    await client.postJson("/v1/kcron/lease/release", { ownerPid: process.pid });
    const state = await new KcronStateStore(home).load();
    assert.equal(state.daemon, undefined);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API owns Desktop settings and model policy", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-desktop-settings-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    const saved = await client.patchDesktopSettings({
      selectedProvider: "ollama",
      databaseMode: "default",
      projects: [],
      modelPolicy: {
        version: 1,
        provider: "ollama",
        model: "llama3.2",
        modelByStage: {},
        modelCapabilities: {
          visionInputEnabled: false,
        },
      },
    });

    assert.equal(saved.settings.selectedProvider, "ollama");
    assert.equal(saved.modelPolicy.provider, "ollama");
    assert.equal(saved.modelPolicy.model, "llama3.2");

    const restored = await client.desktopSettings();
    assert.equal(restored.settings.selectedProvider, "ollama");
    assert.equal(restored.modelPolicy.provider, "ollama");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API mirrors Desktop UI state without overwriting TUI state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-desktop-ui-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.1",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    assert.equal(await client.getDesktopUiState(), null);

    const first = await client.syncDesktopUiState({
      version: "desktop-ui-state-v1",
      source: "legacy-local-storage",
      sourceAppVersion: "0.5.1",
      capturedAt: "2026-07-09T12:00:00.000Z",
      entries: {
        "kchat:web:theme-mode": "dark",
        "kchat:web:threads:v2": "{\"summaries\":[],\"states\":{}}",
      },
    });
    assert.equal(first.updated, true);

    const repeated = await client.syncDesktopUiState({
      ...first.state,
      capturedAt: "2026-07-09T12:01:00.000Z",
    });
    assert.equal(repeated.updated, false);
    assert.equal(repeated.state.capturedAt, "2026-07-09T12:00:00.000Z");

    const changed = await client.syncDesktopUiState({
      ...first.state,
      capturedAt: "2026-07-09T12:02:00.000Z",
      entries: {
        ...first.state.entries,
        "kchat:web:theme-mode": "light",
      },
    });
    assert.equal(changed.updated, true);
    assert.equal((await client.getDesktopUiState())?.entries["kchat:web:theme-mode"], "light");

    const tuiState = await client.getJson("/v1/ui-state") as { state?: unknown };
    assert.equal(tuiState.state, null);
    const persisted = JSON.parse(
      await readFile(path.join(home, "settings", "desktop-ui-state.json"), "utf8"),
    ) as { version?: string };
    assert.equal(persisted.version, "desktop-ui-state-v1");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API restart recomputes database status from Desktop settings", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcad-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    await client.patchDesktopSettings({
      databaseMode: "external",
      databaseUrl: "",
    });

    const missingUrlStatus = await client.restart();

    assert.equal(missingUrlStatus.state, "blocked");
    assert.equal(missingUrlStatus.dbMode, "external");
    assert.equal(missingUrlStatus.lastError?.code, "LOCAL_CORE_EXTERNAL_DATABASE_URL_REQUIRED");

    await client.patchDesktopSettings({
      databaseMode: "external",
      databaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    });

    const configuredStatus = await client.restart();

    assert.equal(configuredStatus.state, "healthy");
    assert.equal(configuredStatus.dbMode, "external");
    assert.equal(configuredStatus.databaseUrl, "postgres://kestrel:kestrel@example.invalid/kestrel");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API owns Desktop project runs and streams changes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-desktop-runs-"));
  const project = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-project-"));
  await writeFile(path.join(project, "package.json"), JSON.stringify({
    scripts: {
      dev: "node -e \"console.log('http://127.0.0.1:4123'); setTimeout(() => {}, 60000)\"",
    },
    packageManager: "npm",
  }, null, 2), "utf8");

  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  const events: Array<{ runs: Array<{ runId: string; status: string; primaryPreviewUrl?: string | undefined }> }> = [];
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    const unsubscribe = client.subscribeDesktopProjectRuns({
      onRuns(runs) {
        events.push({ runs });
      },
    });
    try {
      const launcher = await client.readDesktopProjectLauncher({ projectPath: project });
      assert.equal(launcher?.packageManager, "npm");
      assert.equal(launcher?.scripts.some((script) => script.name === "dev"), true);

      const run = await client.startDesktopProjectRun({ projectPath: project, scriptName: "dev" });
      assert.equal(run.status, "running");

      await waitFor(() => events.some((event) => event.runs.some((entry) => entry.runId === run.runId)));
      await waitFor(async () => {
        const runs = await client.listDesktopProjectRuns();
        return runs.some((entry) => entry.runId === run.runId && entry.primaryPreviewUrl === "http://127.0.0.1:4123/");
      });

      const stopped = await client.stopDesktopProjectRun(run.runId);
      assert.equal(stopped?.runId, run.runId);
      await waitFor(() => events.some((event) => event.runs.some((entry) => entry.runId === run.runId && entry.status === "stopped")));
    } finally {
      unsubscribe();
    }
  } finally {
    await server.close();
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for expected Local Core API state.");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
