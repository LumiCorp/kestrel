import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBootState,
  DesktopBridge,
  DesktopBridgeInfo,
  DesktopCapabilityView,
  DesktopCapabilityConfigurationInput,
  DesktopLegacyUiStateEntries,
  DesktopManagedProjectRun,
  DesktopMcpServerMutationInput,
  DesktopAppConnectionSession,
  DesktopStandardAppConnectionInput,
  DesktopPackageManager,
  DesktopProjectAction,
  DesktopProjectFilesChangedEvent,
  DesktopProjectSnapshotResponse,
  DesktopRendererSettingsUpdate,
  DesktopRunCancelRequest,
  DesktopRunnerEvent,
  DesktopRunTurnRequest,
  DesktopRuntimeHealth,
  DesktopSupportBundle,
  DesktopShellCommand,
  DesktopUiStateSyncResult,
  DesktopUiStateV1,
} from "./contracts.js";
import type { ModelPolicyV1 } from "../../../src/profile/modelPolicy.js";

const desktopBridge: DesktopBridge = {
  getBridgeInfo(): Promise<DesktopBridgeInfo> {
    return ipcRenderer.invoke("desktop:get-bridge-info");
  },
  getAppInfo() {
    return ipcRenderer.invoke("desktop:get-app-info");
  },
  getSupportBundle(): Promise<DesktopSupportBundle> {
    return ipcRenderer.invoke("desktop:get-support-bundle");
  },
  getCapabilities(): Promise<DesktopCapabilityView> {
    return ipcRenderer.invoke("desktop:get-capabilities");
  },
  configureCapability(input: DesktopCapabilityConfigurationInput) {
    return ipcRenderer.invoke("desktop:configure-capability", input);
  },
  getSettings() {
    return ipcRenderer.invoke("desktop:get-settings");
  },
  saveSettings(settings: DesktopRendererSettingsUpdate) {
    return ipcRenderer.invoke("desktop:save-settings", settings);
  },
  getUiState(): Promise<DesktopUiStateV1 | null> {
    return ipcRenderer.invoke("desktop:get-ui-state");
  },
  syncLegacyUiState(
    entries: DesktopLegacyUiStateEntries,
  ): Promise<DesktopUiStateSyncResult> {
    return ipcRenderer.invoke("desktop:sync-legacy-ui-state", entries);
  },
  saveUiState(
    entries: DesktopLegacyUiStateEntries,
  ): Promise<DesktopUiStateSyncResult> {
    return ipcRenderer.invoke("desktop:save-ui-state", entries);
  },
  runTurn(request: DesktopRunTurnRequest): Promise<DesktopRunnerEvent> {
    return ipcRenderer.invoke("desktop:run-turn", request);
  },
  selectAttachments(threadId) {
    return ipcRenderer.invoke("desktop:select-attachments", threadId);
  },
  listAttachments(threadId) {
    return ipcRenderer.invoke("desktop:list-attachments", threadId);
  },
  removeAttachment(threadId, attachmentId) {
    return ipcRenderer.invoke(
      "desktop:remove-attachment",
      threadId,
      attachmentId,
    );
  },
  submitOperatorControl(request) {
    return ipcRenderer.invoke("desktop:operator-control", request);
  },
  cancelRun(request: DesktopRunCancelRequest): Promise<DesktopRunnerEvent> {
    return ipcRenderer.invoke("desktop:cancel-run", request);
  },
  onRunnerEvent(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runnerEvent: DesktopRunnerEvent,
    ) => {
      listener(runnerEvent);
    };
    ipcRenderer.on("desktop:runner-event", handler);
    return () => {
      ipcRenderer.removeListener("desktop:runner-event", handler);
    };
  },
  getModelPolicy(): Promise<ModelPolicyV1> {
    return ipcRenderer.invoke("desktop:get-model-policy");
  },
  getModelCatalog(provider) {
    return ipcRenderer.invoke("desktop:get-model-catalog", provider);
  },
  getBootState() {
    return ipcRenderer.invoke("desktop:get-boot-state");
  },
  onBootState(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: DesktopBootState,
    ) => {
      listener(state);
    };
    ipcRenderer.on("desktop:boot-state", handler);
    return () => {
      ipcRenderer.removeListener("desktop:boot-state", handler);
    };
  },
  pickWorkspace() {
    return ipcRenderer.invoke("desktop:pick-workspace");
  },
  pickProjectFolder() {
    return ipcRenderer.invoke("desktop:pick-project-folder");
  },
  openExternal(url) {
    return ipcRenderer.invoke("desktop:open-external", url);
  },
  openProjectRunPreview(input) {
    return ipcRenderer.invoke("desktop:open-project-run-preview", input);
  },
  openFileEditor(input) {
    return ipcRenderer.invoke("desktop:open-file-editor", input);
  },
  openPath(input) {
    return ipcRenderer.invoke("desktop:open-path", input);
  },
  revealPath(input) {
    return ipcRenderer.invoke("desktop:reveal-path", input);
  },
  restartRuntime() {
    return ipcRenderer.invoke("desktop:restart-runtime");
  },
  requestMicrophoneAccess() {
    return ipcRenderer.invoke("desktop:request-microphone-access");
  },
  resetRuntimeStore() {
    return ipcRenderer.invoke("desktop:reset-runtime-store");
  },
  restartApp() {
    return ipcRenderer.invoke("desktop:restart-app");
  },
  openDiagnostics() {
    return ipcRenderer.invoke("desktop:open-diagnostics");
  },
  getRuntimeStatus() {
    return ipcRenderer.invoke("desktop:get-runtime-status");
  },
  getRuntimeHealth() {
    return ipcRenderer.invoke("desktop:get-runtime-health");
  },
  getDatabaseStatus() {
    return ipcRenderer.invoke("desktop:get-database-status");
  },
  restartDatabase() {
    return ipcRenderer.invoke("desktop:restart-database");
  },
  repairDatabase() {
    return ipcRenderer.invoke("desktop:repair-database");
  },
  revealDatabaseFiles(target: "log" | "data") {
    return ipcRenderer.invoke("desktop:reveal-database-files", target);
  },
  onRuntimeHealth(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      status: DesktopRuntimeHealth,
    ) => {
      listener(status);
    };
    ipcRenderer.on("desktop:runtime-health", handler);
    return () => {
      ipcRenderer.removeListener("desktop:runtime-health", handler);
    };
  },
  listDirectory(rootPath, directoryPath, threadId) {
    return ipcRenderer.invoke(
      "desktop:list-directory",
      rootPath,
      directoryPath,
      threadId,
    );
  },
  searchProjectFiles(rootPath, query, threadId) {
    return ipcRenderer.invoke(
      "desktop:search-project-files",
      rootPath,
      query,
      threadId,
    );
  },
  searchProjectContent(rootPath, query, threadId) {
    return ipcRenderer.invoke(
      "desktop:search-project-content",
      rootPath,
      query,
      threadId,
    );
  },
  watchProjectFiles(rootPath, threadId) {
    return ipcRenderer.invoke(
      "desktop:watch-project-files",
      rootPath,
      threadId,
    );
  },
  unwatchProjectFiles(rootPath) {
    return ipcRenderer.invoke("desktop:unwatch-project-files", rootPath);
  },
  onProjectFilesChanged(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      changedEvent: DesktopProjectFilesChangedEvent,
    ) => {
      listener(changedEvent);
    };
    ipcRenderer.on("desktop:project-files-changed", handler);
    return () => {
      ipcRenderer.removeListener("desktop:project-files-changed", handler);
    };
  },
  readFile(input) {
    return ipcRenderer.invoke("desktop:read-file", input);
  },
  writeFile(input) {
    return ipcRenderer.invoke("desktop:write-file", input);
  },
  discoverMcpServers() {
    return ipcRenderer.invoke("desktop:discover-mcp-servers");
  },
  startStandardAppConnection(
    input: DesktopStandardAppConnectionInput,
  ): Promise<DesktopAppConnectionSession> {
    return ipcRenderer.invoke("desktop:start-standard-app-connection", input);
  },
  getStandardAppConnectionStatus(
    sessionId: string,
  ): Promise<DesktopAppConnectionSession> {
    return ipcRenderer.invoke(
      "desktop:get-standard-app-connection-status",
      sessionId,
    );
  },
  saveMcpServer(input: DesktopMcpServerMutationInput) {
    return ipcRenderer.invoke("desktop:save-mcp-server", input);
  },
  deleteMcpServer(id: string) {
    return ipcRenderer.invoke("desktop:delete-mcp-server", id);
  },
  readProjectLauncher(projectPath, packageManagerOverride, threadId?: string) {
    return ipcRenderer.invoke(
      "desktop:read-project-launcher",
      projectPath,
      packageManagerOverride,
      threadId,
    );
  },
  listWorkspaceSkills(projectPath) {
    return ipcRenderer.invoke("desktop:list-workspace-skills", projectPath);
  },
  installWorkspaceSkill(projectPath, source) {
    return ipcRenderer.invoke("desktop:install-workspace-skill", projectPath, source);
  },
  updateWorkspaceSkill(projectPath, installationId, source) {
    return ipcRenderer.invoke("desktop:update-workspace-skill", projectPath, installationId, source);
  },
  syncWorkspaceSkills(projectPath) {
    return ipcRenderer.invoke("desktop:sync-workspace-skills", projectPath);
  },
  removeWorkspaceSkill(projectPath, installationId) {
    return ipcRenderer.invoke("desktop:remove-workspace-skill", projectPath, installationId);
  },
  listProjectRuns() {
    return ipcRenderer.invoke("desktop:list-project-runs");
  },
  startProjectRun(input: {
    projectPath: string;
    scriptName: string;
    packageManagerOverride?: DesktopPackageManager | undefined;
  }) {
    return ipcRenderer.invoke("desktop:start-project-run", input);
  },
  stopProjectRun(runId) {
    return ipcRenderer.invoke("desktop:stop-project-run", runId);
  },
  restartProjectRun(runId) {
    return ipcRenderer.invoke("desktop:restart-project-run", runId);
  },
  onPreviewDiagnostic(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      diagnostic: import("./contracts.js").DesktopPreviewDiagnostic,
    ) => listener(diagnostic);
    ipcRenderer.on("desktop:preview-diagnostic", handler);
    return () =>
      ipcRenderer.removeListener("desktop:preview-diagnostic", handler);
  },
  getProjectSnapshot(sessionId): Promise<DesktopProjectSnapshotResponse> {
    return ipcRenderer.invoke("desktop:get-project-snapshot", sessionId);
  },
  runProjectAction(
    action: DesktopProjectAction,
  ): Promise<DesktopProjectSnapshotResponse> {
    return ipcRenderer.invoke("desktop:run-project-action", action);
  },
  getOperatorThread(threadId) {
    return ipcRenderer.invoke("desktop:get-operator-thread", threadId);
  },
  listOperatorRuns(query) {
    return ipcRenderer.invoke("desktop:list-operator-runs", query);
  },
  getOperatorRun(runId) {
    return ipcRenderer.invoke("desktop:get-operator-run", runId);
  },
  getWorkspaceLifecycle(sessionId) {
    return ipcRenderer.invoke("desktop:get-workspace-lifecycle", sessionId);
  },
  captureWorkspaceCheckpoint(input) {
    return ipcRenderer.invoke("desktop:capture-workspace-checkpoint", input);
  },
  restoreWorkspaceCheckpoint(input) {
    return ipcRenderer.invoke("desktop:restore-workspace-checkpoint", input);
  },
  inspectWorkspaceCheckpoint(input) {
    return ipcRenderer.invoke("desktop:inspect-workspace-checkpoint", input);
  },
  compareWorkspaceCheckpoint(input) {
    return ipcRenderer.invoke("desktop:compare-workspace-checkpoint", input);
  },
  cleanupWorkspaceCheckpoints(input) {
    return ipcRenderer.invoke("desktop:cleanup-workspace-checkpoints", input);
  },
  previewWorkspacePromotion(input) {
    return ipcRenderer.invoke("desktop:preview-workspace-promotion", input);
  },
  applyWorkspacePromotion(input) {
    return ipcRenderer.invoke("desktop:apply-workspace-promotion", input);
  },
  undoLatestWorkspacePromotion(input) {
    return ipcRenderer.invoke("desktop:undo-latest-workspace-promotion", input);
  },
  inspectManagedWorktree(input) {
    return ipcRenderer.invoke("desktop:inspect-managed-worktree", input);
  },
  cleanupManagedWorktree(input) {
    return ipcRenderer.invoke("desktop:cleanup-managed-worktree", input);
  },
  restoreManagedWorktree(input) {
    return ipcRenderer.invoke("desktop:restore-managed-worktree", input);
  },
  retryManagedWorktreeSetup(input) {
    return ipcRenderer.invoke("desktop:retry-managed-worktree-setup", input);
  },
  startUserTerminal(input) {
    return ipcRenderer.invoke("desktop:start-user-terminal", input);
  },
  listUserTerminals(input) {
    return ipcRenderer.invoke("desktop:list-user-terminals", input);
  },
  readUserTerminal(input) {
    return ipcRenderer.invoke("desktop:read-user-terminal", input);
  },
  writeUserTerminal(input) {
    return ipcRenderer.invoke("desktop:write-user-terminal", input);
  },
  resizeUserTerminal(input) {
    return ipcRenderer.invoke("desktop:resize-user-terminal", input);
  },
  stopUserTerminal(input) {
    return ipcRenderer.invoke("desktop:stop-user-terminal", input);
  },
  inspectWorkspaceChanges(input) {
    return ipcRenderer.invoke("desktop:inspect-workspace-changes", input);
  },
  mutateWorkspaceChanges(input) {
    return ipcRenderer.invoke("desktop:mutate-workspace-changes", input);
  },
  addWorkspaceFeedback(input) {
    return ipcRenderer.invoke("desktop:add-workspace-feedback", input);
  },
  listWorkspaceFeedback(input) {
    return ipcRenderer.invoke("desktop:list-workspace-feedback", input);
  },
  removeWorkspaceFeedback(input) {
    return ipcRenderer.invoke("desktop:remove-workspace-feedback", input);
  },
  submitWorkspaceFeedback(input) {
    return ipcRenderer.invoke("desktop:submit-workspace-feedback", input);
  },
  runWorkspaceReview(input) {
    return ipcRenderer.invoke("desktop:run-workspace-review", input);
  },
  listWorkspaceReviews(input) {
    return ipcRenderer.invoke("desktop:list-workspace-review", input);
  },
  updateWorkspaceReviewFinding(input) {
    return ipcRenderer.invoke("desktop:update-workspace-review", input);
  },
  submitWorkspaceReviewFindings(input) {
    return ipcRenderer.invoke("desktop:submit-workspace-review", input);
  },
  inspectWorkspaceValidation(input) {
    return ipcRenderer.invoke("desktop:inspect-workspace-validation", input);
  },
  runWorkspaceValidation(input) {
    return ipcRenderer.invoke("desktop:run-workspace-validation", input);
  },
  cancelWorkspaceValidation(input) {
    return ipcRenderer.invoke("desktop:cancel-workspace-validation", input);
  },
  submitWorkspaceValidationFailures(input) {
    return ipcRenderer.invoke("desktop:submit-workspace-validation", input);
  },
  inspectWorkspaceGit(input) {
    return ipcRenderer.invoke("desktop:inspect-workspace-git", input);
  },
  performWorkspaceGitAction(input) {
    return ipcRenderer.invoke("desktop:action-workspace-git", input);
  },
  onProjectRuns(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runs: DesktopManagedProjectRun[],
    ) => {
      listener(runs);
    };
    ipcRenderer.on("desktop:project-runs", handler);
    return () => {
      ipcRenderer.removeListener("desktop:project-runs", handler);
    };
  },
  onCommand(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      command: DesktopShellCommand,
    ) => {
      listener(command);
    };
    ipcRenderer.on("desktop:command", handler);
    return () => {
      ipcRenderer.removeListener("desktop:command", handler);
    };
  },
};

contextBridge.exposeInMainWorld("kestrelDesktop", desktopBridge);
