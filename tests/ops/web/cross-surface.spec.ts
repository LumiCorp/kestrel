import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { runRuntimeCli } from "../helpers/runtimeCli.js";
import { runTuiScenario, runTuiScenarioWithSession } from "../helpers/pty.js";
import { resolveOpsTestDatabaseUrl } from "../helpers/database.js";
import { OPS_FIXTURE_IDS } from "../helpers/fixtures.js";
import type {
  DesktopManagedProjectRun,
  DesktopSettings,
} from "../../../src/desktopShell/contracts.js";

const FAKE_OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? "http://127.0.0.1:3116";

test("TUI restored session matches Mission Control run state", async ({ page }) => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    databaseUrl: resolveOpsTestDatabaseUrl(),
    env: fakeModelEnv(),
    timeoutSeconds: 20,
    steps: [
      {
        waitFor: /ops-root · CHAT/i,
      },
      {
        waitFor: /Child thread is waiting for approval\./,
      },
    ],
  });

  expect(transcript).toContain("Child thread is waiting for approval.");
  await expectRunVisibleInMissionControl(page, OPS_FIXTURE_IDS.root.runId, OPS_FIXTURE_IDS.root.sessionId);

  const replay = await runRuntimeCli({
    args: ["replay", "--run-id", OPS_FIXTURE_IDS.root.runId],
    env: {
      ...process.env,
      DATABASE_URL: resolveOpsTestDatabaseUrl(),
    },
  });
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain(`thread=${OPS_FIXTURE_IDS.root.threadId}`);
  expect(replay.stdout).toContain(`run=${OPS_FIXTURE_IDS.root.runId}`);
});

test("fresh TUI chat persists into Mission Control and runtime replay", async ({ page }) => {
  const freshSessionName = `x-tui-${randomUUID().slice(0, 8)}`;
  const result = await runTuiScenarioWithSession({
    sessionName: "ops-root",
    freshSessionName,
    databaseUrl: resolveOpsTestDatabaseUrl(),
    env: fakeModelEnv(),
    timeoutSeconds: 30,
    steps: [
      {
        waitFor: new RegExp(`${freshSessionName} .* (CHAT|READY)`, "i"),
        actions: [
          { typeText: `hello from ${freshSessionName}`, settleMs: 250 },
          { key: "enter", settleMs: 1000 },
        ],
      },
      {
        waitFor: /<< AGENT/i,
      },
    ],
  });

  expect(result.session.name).toBe(freshSessionName);
  expect(result.session.sessionId).toBeTruthy();
  expect(result.transcript).toContain(`hello from ${freshSessionName}`);

  const run = await waitForRunBySession(page.request, result.session.sessionId);
  expect(run.run.status).toBe("COMPLETED");
  await expectRunVisibleInMissionControl(page, run.run.runId, result.session.sessionId);

  const replay = await runRuntimeCli({
    args: ["replay", "--run-id", run.run.runId],
    env: {
      ...process.env,
      DATABASE_URL: resolveOpsTestDatabaseUrl(),
    },
  });
  expect(replay.exitCode, replay.stderr).toBe(0);
  expect(replay.stdout).toContain(`run=${run.run.runId}`);
  expect(replay.stdout).toContain(`thread=thread-main:${run.run.sessionId}`);
});

test("web chat runtime run appears in Mission Control with final output", async ({ page }) => {
  const sessionId = `cross-surface-web-${randomUUID()}`;
  const message = `hello from ${sessionId}`;

  const started = await startWebChatRun(page.request, sessionId, message);
  await subscribeRun(page.request, sessionId, started.runId);
  const run = await waitForRunBySession(page.request, sessionId);
  expect(run.run.status).toBe("COMPLETED");
  await expectRunVisibleInMissionControl(page, run.run.runId, sessionId);
  const detail = await getRunDetail(page.request, run.run.runId);
  expect(JSON.stringify(detail)).toContain("Hello from the fake cross-surface model.");
  expect(JSON.stringify(detail)).toContain("run.completed");
});

test("delegation fixture is consistent across Mission Control and runtime replay", async ({ page }) => {
  await expectRunVisibleInMissionControl(page, OPS_FIXTURE_IDS.root.runId, OPS_FIXTURE_IDS.root.sessionId);
  await expect(page.getByRole("heading", { name: "Child supervision" })).toBeVisible();
  await expect(page.getByText(OPS_FIXTURE_IDS.root.delegationId).first()).toBeVisible();
  await expect(page.getByText(OPS_FIXTURE_IDS.approvalChild.threadId).first()).toBeVisible();

  const replay = await runRuntimeCli({
    args: ["replay", "--run-id", OPS_FIXTURE_IDS.root.runId],
    env: {
      ...process.env,
      DATABASE_URL: resolveOpsTestDatabaseUrl(),
    },
  });
  expect(replay.exitCode, replay.stderr).toBe(0);
  expect(replay.stdout).toContain(`delegation id=${OPS_FIXTURE_IDS.root.delegationId}`);
  expect(replay.stdout).toContain(OPS_FIXTURE_IDS.approvalChild.threadId);
});

test("provider failure persists as failed run in Mission Control and runtime doctor", async ({ page }) => {
  const sessionId = `cross-surface-failure-${randomUUID()}`;
  const message = `fake-openrouter-500 ${sessionId}`;

  const started = await startWebChatRun(page.request, sessionId, message);
  await subscribeRun(page.request, sessionId, started.runId);
  const run = await waitForRunBySession(page.request, sessionId);
  expect(run.run.status).toBe("FAILED");

  await expectRunVisibleInMissionControl(page, run.run.runId, sessionId);
  await expect(page.getByText(/failed|error|upstream/i).first()).toBeVisible();
  const detail = await getRunDetail(page.request, run.run.runId);
  const detailText = JSON.stringify(detail);
  expect(detailText).toContain("run.failed");
  expect(detailText).toMatch(/fake upstream failure|OpenRouter|upstream/i);

  const doctor = await runRuntimeCli({
    args: ["doctor", "--run-id", run.run.runId],
    env: {
      ...process.env,
      DATABASE_URL: resolveOpsTestDatabaseUrl(),
    },
  });
  expect(doctor.exitCode, doctor.stderr).toBe(0);
  expect(doctor.stdout).toMatch(/classification=|terminal|failed/i);
});

test("active web run remains discoverable across Mission Control reload", async ({ page }) => {
  const sessionId = `cross-surface-delay-${randomUUID()}`;
  const message = `fake-openrouter-delay ${sessionId}`;

  const started = await startWebChatRun(page.request, sessionId, message);
  const activeRun = await waitForRunBySession(page.request, sessionId, ["RUNNING"]);

  await page.goto("/ops");
  await page.reload();
  await expectRunVisibleInMissionControl(page, activeRun.run.runId, sessionId);

  await subscribeRun(page.request, sessionId, started.runId);
  const completedRun = await waitForRunBySession(page.request, sessionId);
  expect(completedRun.run.status).toBe("COMPLETED");
  await expectRunVisibleInMissionControl(page, completedRun.run.runId, sessionId);
});

test("desktop project runs render through the mocked desktop bridge", async ({ page }) => {
  const projectPath = "/tmp/kestrel-cross-app-desktop";
  await page.addInitScript((injectedProjectPath: string) => {
    const run: DesktopManagedProjectRun = {
      runId: "desktop-bridge-run",
      projectPath: injectedProjectPath,
      manifestPath: `${injectedProjectPath}/package.json`,
      scriptName: "dev",
      packageManager: "pnpm",
      command: "pnpm dev",
      status: "running",
      startedAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:00:05.000Z",
      stdoutTail: ["ready on http://127.0.0.1:4173"],
      stderrTail: [],
      primaryPreviewUrl: "http://127.0.0.1:4173",
    };
    const workspace = {
      version: 4,
      projects: [{ path: injectedProjectPath, label: "Bridge app", addedAt: "2026-05-19T12:00:00.000Z" }],
      panes: [{ id: "pane-1", tabIds: [], size: 1 }],
      tabs: {},
      activePaneId: "pane-1",
      leftSidebarCollapsed: false,
      rightSidebarCollapsed: false,
      leftSidebarWidthRem: 20.5,
      rightSidebarWidthRem: 20.5,
      expandedProjectPaths: [injectedProjectPath],
      projectShowMorePaths: [],
      fileInspector: { expandedPaths: [], searchQuery: "" },
      projectLauncherPrefs: { [injectedProjectPath]: { selectedScript: "dev" } },
      processDrawer: { open: false },
    };
    try {
      globalThis.localStorage.setItem("kestrel:desktop-workspace:v4", JSON.stringify(workspace));
    } catch {
      // The script can also run in pre-navigation contexts where storage is unavailable.
    }
    Object.defineProperty(globalThis, "kestrelDesktop", {
      configurable: true,
      value: {
      getSettings: async () => ({
        selectedProvider: "openrouter",
        databaseMode: "default",
        presetId: "desktop_dev_local",
        capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
        projects: [{ path: injectedProjectPath, label: "Bridge app" }],
        advancedWorkspaceEnabled: true,
      }),
      saveSettings: async (settings: DesktopSettings) => settings,
      listProjectRuns: async () => [run],
      onProjectRuns: (listener: (runs: DesktopManagedProjectRun[]) => void) => {
        listener([run]);
        return () => {};
      },
      readProjectLauncher: async () => ({
        projectPath: injectedProjectPath,
        packageManager: "pnpm",
        packageManagerSelectionRequired: false,
        scripts: [{ name: "dev", command: "vite --host 127.0.0.1" }],
      }),
      startProjectRun: async () => run,
      stopProjectRun: async () => ({ ...run, status: "stopped" }),
      restartProjectRun: async () => ({ ...run, runId: "desktop-bridge-run-restarted" }),
      openProjectRunPreview: async (input: { runId: string; url?: string | undefined }) => {
        (globalThis as typeof globalThis & { __openedDesktopPreview?: unknown }).__openedDesktopPreview = input;
      },
      getBridgeInfo: async () => ({
        connected: true,
        version: "1",
        capabilities: ["settings", "project_files", "project_runs", "project_run_preview"],
      }),
      onCommand: () => () => {},
      getSupportBundle: async () => ({ generatedAt: "2026-05-19T12:00:00.000Z" }),
      getBootState: async () => ({ phase: "ready", message: "Ready" }),
      onBootState: () => () => {},
      pickProjectFolder: async () => {},
      openExternal: async () => {},
      openPath: async () => {},
      revealPath: async () => {},
      restartRuntime: async () => ({ running: true, recentStdout: [], recentStderr: [], logPath: "/tmp/runtime.log" }),
      requestMicrophoneAccess: async () => ({ state: "granted", granted: true }),
      resetRuntimeStore: async () => ({ archived: false, runtimeStatus: { running: true, recentStdout: [], recentStderr: [], logPath: "/tmp/runtime.log" } }),
      restartApp: async () => {},
      openDiagnostics: async () => {},
      getRuntimeStatus: async () => ({ running: true, recentStdout: [], recentStderr: [], logPath: "/tmp/runtime.log" }),
      getRuntimeHealth: async () => ({ state: "ready", summary: "Ready", running: true }),
      getDatabaseStatus: async () => ({ state: "ready", summary: "Ready", managed: true, initialized: true, running: true }),
      restartDatabase: async () => ({ state: "ready", summary: "Ready", managed: true, initialized: true, running: true }),
      repairDatabase: async () => ({ state: "ready", summary: "Ready", managed: true, initialized: true, running: true }),
      revealDatabaseFiles: async () => {},
      listDirectory: async () => ({ rootPath: injectedProjectPath, directoryPath: injectedProjectPath, entries: [] }),
      searchProjectFiles: async (rootPath: string, query: string) => ({
        rootPath,
        query,
        results: [],
        truncated: false,
        fullSearchAvailable: false,
      }),
      },
    });
  }, projectPath);

  await page.goto("/mission-control");
  await expect(page.getByRole("heading", { name: "Mission Control" })).toBeVisible();
});

function fakeModelEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENROUTER_MODEL: "openai/gpt-5.2-chat",
    OPENROUTER_BASE_URL: FAKE_OPENROUTER_BASE_URL,
  };
}

async function subscribeRun(request: APIRequestContext, sessionId: string, runId: string): Promise<void> {
  const response = await request.post("/api/kchat/thread-runs/subscribe", {
    data: {
      threadId: sessionId,
      sessionId,
      runId,
    },
    timeout: 20_000,
  });
  expect(response.ok()).toBe(true);
  await response.text();
}

async function waitForRunBySession(
  request: APIRequestContext,
  sessionId: string,
  statuses: Array<OpsRunSummary["run"]["status"]> = ["COMPLETED", "FAILED", "WAITING"],
): Promise<OpsRunSummary> {
  const deadline = Date.now() + 20_000;
  let latestBody = "";
  while (Date.now() < deadline) {
    const response = await request.get(`/api/kchat/runs?sessionId=${encodeURIComponent(sessionId)}&limit=5`);
    latestBody = await response.text();
    expect(response.ok()).toBe(true);
    const body = JSON.parse(latestBody) as { runs?: OpsRunSummary[] | undefined };
    const run = body.runs?.[0];
    if (run !== undefined && statuses.includes(run.run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ops run for ${sessionId}. Last body: ${latestBody}`);
}

async function startWebChatRun(
  request: APIRequestContext,
  sessionId: string,
  message: string,
): Promise<{ runId: string; sessionId: string }> {
  const start = await request.post("/api/kchat/thread-runs/start", {
    data: {
      sessionId,
      message,
      eventType: "user.message",
      interactionMode: "chat",
      history: [{ role: "user", text: message, timestamp: new Date().toISOString() }],
    },
  });

  const startText = await start.text();
  expect(start.ok(), startText).toBe(true);
  const startBody = JSON.parse(startText) as {
    ok?: boolean;
    run?: { runId?: string | undefined; sessionId?: string | undefined } | undefined;
  };
  expect(startBody.ok).toBe(true);
  expect(startBody.run?.runId).toBeTruthy();
  expect(startBody.run?.sessionId).toBe(sessionId);
  return {
    runId: startBody.run!.runId!,
    sessionId,
  };
}

async function getRunDetail(request: APIRequestContext, runId: string): Promise<unknown> {
  const response = await request.get(`/api/kchat/runs/${encodeURIComponent(runId)}`);
  const text = await response.text();
  expect(response.ok(), text).toBe(true);
  return JSON.parse(text) as unknown;
}

async function expectRunVisibleInMissionControl(page: Page, runId: string, sessionId: string): Promise<void> {
  const listResponse = await page.request.get(`/api/kchat/runs?sessionId=${encodeURIComponent(sessionId)}&limit=10`);
  const listText = await listResponse.text();
  expect(listResponse.ok(), listText).toBe(true);
  const listBody = JSON.parse(listText) as { runs?: OpsRunSummary[] | undefined };
  expect(listBody.runs?.some((entry) => entry.run.runId === runId)).toBe(true);

  await page.goto("/ops");
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();

  await page.goto(`/ops/runs/${runId}`);
  await expect(page.getByText(`Run ${runId}`).first()).toBeVisible();
  await expect(page.getByText(runId).first()).toBeVisible();
  await expect(page.getByText(sessionId).first()).toBeVisible();
}

interface OpsRunSummary {
  run: {
    runId: string;
    sessionId: string;
    status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  };
}
