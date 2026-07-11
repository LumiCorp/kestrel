import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppView, ResolvedWorkspace, SessionsFile, TranscriptLine, TuiProfile, TuiSessionMeta } from "../../cli/contracts.js";
import { WorkspaceController, type WorkspaceControllerContext } from "../../cli/app/WorkspaceController.js";
import { ProfileStore } from "../../cli/config/ProfileStore.js";
import { DiagnosticLogStore } from "../../cli/diagnostics/DiagnosticLogStore.js";
import { HistoryStore } from "../../cli/history/HistoryStore.js";
import { UiStateStore } from "../../cli/ink/persistence/UiStateStore.js";
import { buildInitialUiRuntimeState, UiStore } from "../../cli/ink/store/UiStore.js";
import { createUiDerivedSelectors } from "../../cli/ink/store/selectors.js";
import { SessionStore } from "../../cli/session/SessionStore.js";
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import { initializeWorkspaceAtRoot } from "../../cli/workspace/WorkspaceResolver.js";

async function createWorkspaceControllerHarness(): Promise<{
  controller: WorkspaceController;
  cwd: string;
  workspaceStore: WorkspaceStore;
  historyLines: string[];
  getActiveWorkspaceId(): string | undefined;
  getActiveSession(): TuiSessionMeta;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-controller-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const profileStore = new ProfileStore(home);
  const profiles = await profileStore.load();
  const activeProfile = profileStore.getDefault(profiles);
  const sessionStore = new SessionStore(home);
  const workspaceStore = new WorkspaceStore(home);
  const historyStore = new HistoryStore(home);
  const uiStateStore = new UiStateStore(home);
  const now = new Date().toISOString();
  const activeSession: TuiSessionMeta = {
    name: "default",
    sessionId: "session-1",
    profileId: activeProfile.id,
    createdAt: now,
    updatedAt: now,
    started: true,
  };
  let sessionsFile = sessionStore.upsert(await sessionStore.load(), activeSession);
  const uiStore = new UiStore(
    buildInitialUiRuntimeState({
      profile: activeProfile,
      activeSession,
      sessions: sessionsFile.sessions,
      transcript: [],
      persisted: await uiStateStore.load(),
    }),
  );

  let activeWorkspace: ResolvedWorkspace | undefined;
  let launchWorkspace: ResolvedWorkspace | undefined;
  const historyLines: string[] = [];
  const context = {
    options: { cwd },
    profileStore,
    sessionStore,
    workspaceStore,
    historyStore,
    diagnosticsStore: new DiagnosticLogStore(home),
    uiStateStore,
    client: undefined,
    uiStore,
    selectors: createUiDerivedSelectors(),
    getRuntimeSettings: () => ({ version: 1, defaults: {} }),
    getSessionsFile: () => sessionsFile,
    setSessionsFile: (next: SessionsFile) => {
      sessionsFile = next;
    },
    getActiveWorkspace: () => activeWorkspace,
    setActiveWorkspace: (next: ResolvedWorkspace | undefined) => {
      activeWorkspace = next;
    },
    getLaunchWorkspace: () => launchWorkspace,
    setLaunchWorkspace: (next: ResolvedWorkspace | undefined) => {
      launchWorkspace = next;
    },
    appendHistoryLine: async (_role: TranscriptLine["role"], text: string) => {
      historyLines.push(text);
    },
    persistSessionAndUi: async () => undefined,
    persistUiState: async () => undefined,
    persistActiveProfile: async (profile: TuiProfile) => {
      uiStore.patch({ activeProfile: profile });
    },
    setActiveSessionState: async (patch: Partial<TuiSessionMeta>) => {
      const nextSession = {
        ...uiStore.getState().activeSession,
        ...patch,
      };
      sessionsFile = sessionStore.upsert(sessionsFile, nextSession);
      uiStore.patch({
        activeSession: nextSession,
        sessions: sessionsFile.sessions,
      });
    },
    navigateToView: (view: AppView) => {
      uiStore.patch({ activeView: view });
    },
    withMcpSummary: (statusLine: string) => statusLine,
    recordPersistenceFailure: () => undefined,
    recordStartupNotices: () => undefined,
  } as unknown as WorkspaceControllerContext;

  return {
    controller: new WorkspaceController(context),
    cwd,
    workspaceStore,
    historyLines,
    getActiveWorkspaceId: () => activeWorkspace?.manifest.workspaceId,
    getActiveSession: () => uiStore.getState().activeSession,
  };
}

test("WorkspaceController lists discovered workspaces and binds the active session", async () => {
  const harness = await createWorkspaceControllerHarness();
  const alphaRoot = path.join(harness.cwd, "alpha");
  const betaRoot = path.join(harness.cwd, "beta");
  await mkdir(alphaRoot, { recursive: true });
  await mkdir(betaRoot, { recursive: true });
  const alpha = await initializeWorkspaceAtRoot(alphaRoot, harness.workspaceStore, { label: "alpha" });
  const beta = await initializeWorkspaceAtRoot(betaRoot, harness.workspaceStore, { label: "beta" });

  await harness.controller.handleWorkspaceCommand(["list"]);
  await harness.controller.handleWorkspaceCommand(["use", beta.manifest.workspaceId]);

  const activeSession = harness.getActiveSession();
  assert.equal(activeSession.workspaceId, beta.manifest.workspaceId);
  assert.equal(activeSession.workspaceRoot, beta.rootPath);
  assert.equal(harness.getActiveWorkspaceId(), beta.manifest.workspaceId);
  assert.match(harness.historyLines.join("\n"), new RegExp(alpha.manifest.workspaceId, "u"));
  assert.match(harness.historyLines.join("\n"), new RegExp(beta.manifest.workspaceId, "u"));
  assert.match(harness.historyLines.join("\n"), /Bound the active session to workspace/u);
});

test("WorkspaceController detaches the active session from workspace state", async () => {
  const harness = await createWorkspaceControllerHarness();
  const workspaceRoot = path.join(harness.cwd, "beta");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await initializeWorkspaceAtRoot(workspaceRoot, harness.workspaceStore, { label: "beta" });

  await harness.controller.handleWorkspaceCommand(["use", workspace.manifest.workspaceId]);
  await harness.controller.handleWorkspaceCommand(["use", "detached"]);

  const activeSession = harness.getActiveSession();
  assert.equal(activeSession.workspaceId, undefined);
  assert.equal(activeSession.workspaceRoot, undefined);
  assert.equal(activeSession.workspaceLabel, "Detached workspace");
  assert.equal(harness.getActiveWorkspaceId(), undefined);
  assert.match(harness.historyLines.join("\n"), /Detached the active session from any workspace\./u);
});
