import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { App } from "../../cli/app/App.js";
import { ProfileStore } from "../../cli/config/ProfileStore.js";
import { DiagnosticLogStore } from "../../cli/diagnostics/DiagnosticLogStore.js";
import { HistoryStore } from "../../cli/history/HistoryStore.js";
import { UiStateStore } from "../../cli/ink/persistence/UiStateStore.js";
import { buildInitialUiRuntimeState, UiStore } from "../../cli/ink/store/UiStore.js";
import { SessionStore } from "../../cli/session/SessionStore.js";
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import { initializeWorkspaceAtRoot } from "../../cli/workspace/WorkspaceResolver.js";
import {
  buildOperatorBootstrapSnapshot,
  buildOperatorBackActionLabel,
  buildOperatorCodeWorkspace,
  buildOperatorDelegationWorkspace,
  buildOperatorMcpWorkspace,
  buildOperatorRecoveryCenter,
  buildOperatorWorkspaceJourney,
} from "../../src/operatorShell.js";
import type { TuiSessionMeta } from "../../cli/contracts.js";

async function createHarness(): Promise<{
  app: App;
  cwd: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-e2e-flow-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const app = new App({
    cwd,
    kestrelHome: home,
    scripted: true,
  });

  const profileStore = new ProfileStore(home);
  const profiles = await profileStore.load();
  const activeProfile = profileStore.getDefault(profiles);
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

  await ((appState.refreshActiveSessionOperatorState as (() => Promise<void>) | undefined)?.() ?? Promise.resolve());
  return { app, cwd };
}

test("operator shell deterministic journey e2e covers start, inspect, delegation, recovery, and relaunch", async () => {
  const { app, cwd } = await createHarness();
  const appState = app as unknown as Record<string, unknown>;
  const workspaceStore = appState.workspaceStore as WorkspaceStore;
  const workspaceRoot = path.join(cwd, "workspace-a");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await initializeWorkspaceAtRoot(workspaceRoot, workspaceStore, { label: "workspace-a" });

  const bootstrap = buildOperatorBootstrapSnapshot({
    hasWorkspace: true,
    profileLabel: "Default",
    presetCount: 4,
    runnerPreflightStatus: "ready",
    hasPriorSessionContext: false,
    hasWaitingOrFailed: false,
  });
  assert.equal(bootstrap.recommendedInitialDestination, "start");

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "start",
    args: [],
  });
  await (appState.handleLine as (line: string) => Promise<void>)("orchestration-task");
  await (appState.handleLine as (line: string) => Promise<void>)("orchestration");
  await (appState.handleLine as (line: string) => Promise<void>)(workspace.manifest.workspaceId);
  await (appState.handleLine as (line: string) => Promise<void>)("Run deterministic shell journey");
  await (appState.handleLine as (line: string) => Promise<void>)("current");
  await (appState.handleLine as (line: string) => Promise<void>)("default");
  await (appState.handleLine as (line: string) => Promise<void>)("skip");

  {
    const state = (appState.uiStore as UiStore).getState();
    assert.equal(state.activeSession.name, "Run deterministic shell journey");
    assert.equal(state.activeSession.workspaceId, workspace.manifest.workspaceId);
    assert.equal(state.activeSession.launchTemplateId, "orchestration-task");
    assert.equal(state.activeSession.launchPresetId, "orchestration");
  }

  appState.client = {
    sendCommand: async (type: string) => {
      if (type === "mcp.status") {
        return {
          type: "mcp.status",
          payload: {
            status: {
              healthy: false,
              checkedAt: "2026-03-22T10:00:00.000Z",
              servers: [
                {
                  serverId: "primary",
                  transport: "stdio",
                  healthy: false,
                  connected: false,
                  enabled: true,
                  toolCount: 0,
                  checkedAt: "2026-03-22T10:00:00.000Z",
                  error: "connection refused",
                },
              ],
              tools: [],
            },
          },
        };
      }
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
                checkpointId: "ws-restore-1",
                sessionId: "session-1",
                workspaceRoot,
                repoRoot: workspaceRoot,
                label: "Before workspace restore",
                isExplicitLabel: true,
                reason: "manual anchor",
                createdBy: "operator",
                createdAt: "2026-03-22T10:01:00.000Z",
                storageKind: "git_ref_v1",
                gitRef: "refs/kestrel/checkpoints/thread-1/ws-restore-1",
                kind: "manual",
                retentionClass: "manual",
                captureStatus: "CAPTURED",
                manifestHash: "abc",
                fileCount: 2,
                totalBytes: 900,
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected command ${type}`);
    },
  };

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({ kind: "command", command: "mcp", args: [] });
  {
    const state = (appState.uiStore as UiStore).getState();
    assert.equal(state.activeView, "mcp");
    assert.equal(state.mcpStatus?.healthy, false);
  }

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({ kind: "command", command: "code", args: [] });
  assert.equal((appState.uiStore as UiStore).getState().activeView, "code");

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({ kind: "command", command: "child", args: [] });
  assert.equal((appState.uiStore as UiStore).getState().activeView, "delegation");
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({ kind: "command", command: "fanin", args: [] });
  assert.equal((appState.uiStore as UiStore).getState().activeView, "delegation");

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "checkpoint",
    args: [],
  });
  assert.equal((appState.uiStore as UiStore).getState().activeView, "recovery");

  const recovery = buildOperatorRecoveryCenter({
    sessionTitle: "Run deterministic shell journey",
    profileLabel: "Default",
    workspaceLabel: "workspace=workspace-a",
    workspaceRoot,
    interactionMode: "plan",
    isActive: true,
    recovery: {
      latestCheckpoint: {
        checkpointId: "ctx-1",
        status: "PENDING",
        recommendedAction: "continue",
        reason: "checkpoint pending",
      },
      latestPreview: "Latest evidence preview",
      childOutcomes: ["child-1: completed"],
      launchSummary: "Task=Run deterministic shell journey",
      setupSummary: "Default · workspace=workspace-a",
    },
    checkpoints: [
      {
        checkpointId: "ws-restore-1",
        sessionId: "session-1",
        workspaceRoot,
        repoRoot: workspaceRoot,
        label: "Before workspace restore",
        isExplicitLabel: true,
        reason: "manual anchor",
        createdBy: "operator",
        createdAt: "2026-03-22T10:01:00.000Z",
        storageKind: "git_ref_v1",
        gitRef: "refs/kestrel/checkpoints/thread-1/ws-restore-1",
        kind: "manual",
        retentionClass: "manual",
        captureStatus: "CAPTURED",
        manifestHash: "abc",
        fileCount: 2,
        totalBytes: 900,
      },
    ],
  });
  assert.match(recovery.restorePreview?.summary ?? "", /restore preview targets/i);
  assert.match(recovery.restorePreview?.consequence ?? "", /does not replay the run/i);
  assert.equal(
    recovery.timeline.some((entry) => /runtime\/orchestration state/i.test(entry.actionConsequence)),
    true,
  );
  assert.equal(recovery.postRunSummary.childOutcomes.length > 0, true);
  assert.equal(recovery.notebook.length > 0, true);

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({ kind: "command", command: "resume", args: ["recent"] });
  const finalState = (appState.uiStore as UiStore).getState();
  assert.equal(finalState.activeView, "chat");
  assert.equal(finalState.activeSession.name, "Run deterministic shell journey");
});

test("operator shell workspace journey e2e keeps binding and mismatch state explicit", async () => {
  const { app, cwd } = await createHarness();
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
    args: ["use", alpha.manifest.workspaceId],
  });
  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "workspace",
    args: [],
  });
  {
    const state = (appState.uiStore as UiStore).getState();
    assert.equal(state.activeView, "workspace");
    assert.equal(state.activeSession.workspaceId, alpha.manifest.workspaceId);
  }

  const workspaceSnapshot = buildOperatorWorkspaceJourney({
    sessionTitle: "default",
    profileLabel: "Default",
    workspaceLabel: `workspace=${alpha.manifest.workspaceId}`,
    launchWorkspaceLabel: `workspace=${beta.manifest.workspaceId}`,
    interactionMode: "plan",
    discoveredWorkspaces: [
      {
        workspaceId: alpha.manifest.workspaceId,
        label: `workspace=${alpha.manifest.workspaceId}`,
        rootPath: alpha.rootPath,
        isCurrentBinding: true,
        isLaunchWorkspace: false,
      },
      {
        workspaceId: beta.manifest.workspaceId,
        label: `workspace=${beta.manifest.workspaceId}`,
        rootPath: beta.rootPath,
        isCurrentBinding: false,
        isLaunchWorkspace: true,
      },
    ],
  });
  assert.match(workspaceSnapshot.mismatchSummary ?? "", /differs from session workspace/i);
  assert.equal(workspaceSnapshot.nextActions?.destination, "workspace");
  assert.equal(workspaceSnapshot.discoveredWorkspaces.length, 2);

  await (appState.handleCommand as (parsed: unknown) => Promise<void>)({
    kind: "command",
    command: "workspace",
    args: ["use", "detached"],
  });
  {
    const state = (appState.uiStore as UiStore).getState();
    assert.equal(state.activeSession.workspaceId, undefined);
    assert.equal(state.activeSession.workspaceRoot, undefined);
  }

  assert.equal(buildOperatorBackActionLabel("history"), "Back to History");
  assert.equal(buildOperatorBackActionLabel(undefined), "Back to Chat");
});

test("operator shell derives deterministic bootstrap and next actions across journeys", async () => {
  const firstRunBootstrap = buildOperatorBootstrapSnapshot({
    hasWorkspace: false,
    profileLabel: "Default",
    presetCount: 4,
    runnerPreflightStatus: "ready",
    hasPriorSessionContext: false,
    hasWaitingOrFailed: false,
  });
  assert.equal(firstRunBootstrap.recommendedInitialDestination, "start");
  assert.match(firstRunBootstrap.summary, /next start/i);

  const returningBootstrap = buildOperatorBootstrapSnapshot({
    hasWorkspace: true,
    profileLabel: "Default",
    presetCount: 4,
    runnerPreflightStatus: "ready",
    hasPriorSessionContext: true,
    hasWaitingOrFailed: true,
  });
  assert.equal(returningBootstrap.recommendedInitialDestination, "history");
  assert.match(returningBootstrap.summary, /next history/i);
  const workspaceJourney = buildOperatorWorkspaceJourney({
    sessionTitle: "session-a",
    profileLabel: "Default",
    workspaceLabel: "workspace=alpha",
    launchWorkspaceLabel: "workspace=beta",
    discoveredWorkspaces: [],
  });
  assert.equal(workspaceJourney.nextActions?.orderedActions[0]?.command, "/workspace status");

  const mcpWorkspace = buildOperatorMcpWorkspace({
    sessionTitle: "session-a",
    profileLabel: "Default",
    workspaceLabel: "workspace=alpha",
    status: {
      healthy: false,
      checkedAt: "2026-03-22T10:00:00.000Z",
      servers: [],
      tools: [],
    },
  });
  assert.equal(mcpWorkspace.nextActions?.orderedActions[0]?.command, "/mcp refresh");

  const codeWorkspace = buildOperatorCodeWorkspace({
    sessionTitle: "session-a",
    profileLabel: "Default",
    workspaceLabel: "workspace=alpha",
    codeMode: {
      enabled: false,
      approvalMode: "auto",
      sandbox: {
        executor: "docker",
        timeoutMs: 30_000,
        memoryMb: 1024,
        networkDefault: "off",
        cpuShares: 128,
        allowDependencyInstall: false,
        maxOutputBytes: 65_536,
        maxArtifacts: 5,
        maxArtifactBytes: 2_000_000,
      },
      retention: {
        persistSummary: true,
        persistArtifacts: true,
      },
      languages: ["javascript"],
    },
  });
  assert.equal(codeWorkspace.nextActions?.orderedActions[0]?.command, "/code enable");

  const delegationWorkspace = buildOperatorDelegationWorkspace({
    sessionTitle: "session-a",
    profileLabel: "Default",
    workspaceLabel: "workspace=alpha",
    delegation: {
      childOutcomes: [],
      fanInDisposition: {
        status: "pending",
        checkpointId: "fanin-1",
      },
    },
  });
  assert.equal(delegationWorkspace.nextActions?.orderedActions[0]?.draft, "/child spawn ");

  const recoveryWorkspace = buildOperatorRecoveryCenter({
    sessionTitle: "session-a",
    profileLabel: "Default",
    workspaceLabel: "workspace=alpha",
    workspaceRoot: "/tmp/alpha",
    recovery: {
      latestCheckpoint: {
        checkpointId: "ctx-1",
        status: "PENDING",
        recommendedAction: "restore",
        reason: "needs operator decision",
      },
    },
    checkpoints: [],
  });
  assert.equal(recoveryWorkspace.nextActions?.orderedActions[0]?.command, "/checkpoint accept");
});
