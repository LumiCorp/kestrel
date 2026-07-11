import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBootState,
  DesktopBridge,
  DesktopBridgeInfo,
  DesktopLegacyUiStateEntries,
  DesktopManagedProjectRun,
  DesktopPackageManager,
  DesktopProjectAction,
  DesktopProjectFilesChangedEvent,
  DesktopProjectLauncherDescriptor,
  DesktopProjectSnapshotResponse,
  DesktopProviderCredentialInput,
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
  getSettings() {
    return ipcRenderer.invoke("desktop:get-settings");
  },
  saveSettings(settings: DesktopRendererSettingsUpdate) {
    return ipcRenderer.invoke("desktop:save-settings", settings);
  },
  saveProviderCredential(input: DesktopProviderCredentialInput) {
    return ipcRenderer.invoke("desktop:save-provider-credential", input);
  },
  getUiState(): Promise<DesktopUiStateV1 | null> {
    return ipcRenderer.invoke("desktop:get-ui-state");
  },
  syncLegacyUiState(entries: DesktopLegacyUiStateEntries): Promise<DesktopUiStateSyncResult> {
    return ipcRenderer.invoke("desktop:sync-legacy-ui-state", entries);
  },
  saveUiState(entries: DesktopLegacyUiStateEntries): Promise<DesktopUiStateSyncResult> {
    return ipcRenderer.invoke("desktop:save-ui-state", entries);
  },
  runTurn(request: DesktopRunTurnRequest): Promise<DesktopRunnerEvent> {
    return ipcRenderer.invoke("desktop:run-turn", request);
  },
  cancelRun(request: DesktopRunCancelRequest): Promise<DesktopRunnerEvent> {
    return ipcRenderer.invoke("desktop:cancel-run", request);
  },
  onRunnerEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, runnerEvent: DesktopRunnerEvent) => {
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
  saveModelPolicy(policy: ModelPolicyV1) {
    return ipcRenderer.invoke("desktop:save-model-policy", policy);
  },
  getBootState() {
    return ipcRenderer.invoke("desktop:get-boot-state");
  },
  onBootState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopBootState) => {
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
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopRuntimeHealth) => {
      listener(status);
    };
    ipcRenderer.on("desktop:runtime-health", handler);
    return () => {
      ipcRenderer.removeListener("desktop:runtime-health", handler);
    };
  },
  listDirectory(rootPath, directoryPath) {
    return ipcRenderer.invoke("desktop:list-directory", rootPath, directoryPath);
  },
  searchProjectFiles(rootPath, query) {
    return ipcRenderer.invoke("desktop:search-project-files", rootPath, query);
  },
  watchProjectFiles(rootPath) {
    return ipcRenderer.invoke("desktop:watch-project-files", rootPath);
  },
  unwatchProjectFiles(rootPath) {
    return ipcRenderer.invoke("desktop:unwatch-project-files", rootPath);
  },
  onProjectFilesChanged(listener) {
    const handler = (_event: Electron.IpcRendererEvent, changedEvent: DesktopProjectFilesChangedEvent) => {
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
  readProjectLauncher(projectPath, packageManagerOverride) {
    return ipcRenderer.invoke("desktop:read-project-launcher", projectPath, packageManagerOverride);
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
  getProjectSnapshot(sessionId): Promise<DesktopProjectSnapshotResponse> {
    return ipcRenderer.invoke("desktop:get-project-snapshot", sessionId);
  },
  runProjectAction(action: DesktopProjectAction): Promise<DesktopProjectSnapshotResponse> {
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
  onProjectRuns(listener) {
    const handler = (_event: Electron.IpcRendererEvent, runs: DesktopManagedProjectRun[]) => {
      listener(runs);
    };
    ipcRenderer.on("desktop:project-runs", handler);
    return () => {
      ipcRenderer.removeListener("desktop:project-runs", handler);
    };
  },
  onCommand(listener) {
    const handler = (_event: Electron.IpcRendererEvent, command: DesktopShellCommand) => {
      listener(command);
    };
    ipcRenderer.on("desktop:command", handler);
    return () => {
      ipcRenderer.removeListener("desktop:command", handler);
    };
  },
};

contextBridge.exposeInMainWorld("kestrelDesktop", desktopBridge);
