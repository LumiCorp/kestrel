import type {
  DesktopBridgeInfo,
  DesktopBootState,
  DesktopCapabilityView,
  DesktopCapabilityConfigurationInput,
  DesktopCapabilityConfigurationResult,
  DesktopAttachmentMetadata,
  DesktopDatabaseStatus,
  DesktopDirectoryListing,
  DesktopFileContent,
  DesktopFileReadInput,
  DesktopOpenFileEditorInput,
  DesktopPathTargetInput,
  DesktopFileWriteInput,
  DesktopFileSearchResponse,
  DesktopFollowUpQueueEntry,
  DesktopManagedProjectRun,
  DesktopLegacyUiStateEntries,
  DesktopMicrophoneAccess,
  DesktopMicrophoneAccessState,
  DesktopMcpDiscoveryResult,
  DesktopMcpServerMutationInput,
  DesktopPackageManager,
  DesktopProjectLauncherDescriptor,
  DesktopProjectFilesChangedEvent,
  DesktopProjectAction,
  DesktopProjectRegistration,
  DesktopProjectSnapshotResponse,
  DesktopProviderModelCatalog,
  DesktopRendererSettings,
  DesktopRendererSettingsUpdate,
  DesktopRunCancelRequest,
  DesktopRunnerEvent,
  DesktopRunTurnRequest,
  DesktopRuntimeHealth,
  DesktopRuntimeRunIndex,
  DesktopRuntimeRunIndexQuery,
  DesktopRuntimeRunInspection,
  DesktopRuntimeThreadInspection,
  DesktopOperatorControlRequest,
  DesktopOperatorInboxItem,
  DesktopRuntimeStoreReset,
  DesktopSupportBundle,
  DesktopUiStateSyncResult,
  DesktopUiStateV1,
} from "../../../src/desktopShell/contracts.js";
import type { ModelPolicyV1 } from "../../../src/profile/modelPolicy.js";
export {
  DESKTOP_BRIDGE_CAPABILITIES,
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_LEGACY_UI_STORAGE_KEYS,
  DESKTOP_UI_STATE_SOURCE,
  DESKTOP_UI_STATE_RENDERER_SOURCE,
  DESKTOP_UI_STATE_VERSION,
} from "../../../src/desktopShell/contracts.js";
export type {
  DesktopAttachmentMetadata,
  DesktopCapabilityPackId,
  DesktopCredentialedModelProvider,
  DesktopBridgeCapabilityId,
  DesktopBridgeInfo,
  DesktopBootState,
  DesktopCapability,
  DesktopCapabilityCategory,
  DesktopCapabilityId,
  DesktopCapabilityReadiness,
  DesktopCapabilityRequirement,
  DesktopCapabilityRequirementKind,
  DesktopCapabilitySettingField,
  DesktopCapabilityView,
  DesktopCapabilityConfigurationInput,
  DesktopCapabilityConfigurationResult,
  DesktopCapabilitySettingValue,
  DesktopDatabaseMode,
  DesktopDatabaseStatus,
  DesktopDirectoryListing,
  DesktopFileContent,
  DesktopFileEntry,
  DesktopFileReadInput,
  DesktopOpenFileEditorInput,
  DesktopPathTargetInput,
  DesktopFileWriteInput,
  DesktopFileSearchResult,
  DesktopFileSearchResponse,
  DesktopFollowUpQueueEntry,
  DesktopManagedProjectRun,
  DesktopManagedProjectRunPreviewUrl,
  DesktopLegacyUiStateEntries,
  DesktopMcpDiscoveryDiagnostic,
  DesktopMicrophoneAccess,
  DesktopMicrophoneAccessState,
  DesktopMcpDiscoveryResult,
  DesktopMcpDiscoverySourceKind,
  DesktopMcpCredentialBinding,
  DesktopMcpCredentialKind,
  DesktopMcpCredentialMutationInput,
  DesktopMcpServerConfig,
  DesktopMcpServerMutationInput,
  DesktopMcpToolSummary,
  DesktopModelProvider,
  DesktopPackageManager,
  DesktopProjectLauncherDescriptor,
  DesktopProjectFilesChangedEvent,
  DesktopProjectAction,
  DesktopProjectRegistration,
  DesktopProjectSnapshotResponse,
  DesktopProviderModelCatalog,
  DesktopProviderReadiness,
  DesktopAppearanceTheme,
  DesktopRendererSettings,
  DesktopRendererSettingsUpdate,
  DesktopReadinessView,
  DesktopReadinessItemId,
  DesktopRunHistoryLine,
  DesktopRunCancelRequest,
  DesktopRunnerEvent,
  DesktopRunTurnRequest,
  DesktopRuntimeHealth,
  DesktopRuntimeRunIndex,
  DesktopRuntimeRunIndexEntry,
  DesktopRuntimeRunIndexQuery,
  DesktopRuntimeRunInspection,
  DesktopRuntimeRunStatus,
  DesktopRuntimeRunTimelineEntry,
  DesktopRuntimeSessionIndexEntry,
  DesktopRuntimeThreadBlocker,
  DesktopRuntimeThreadInspection,
  DesktopOperatorControlRequest,
  DesktopOperatorInboxItem,
  DesktopRuntimeThreadNextAction,
  DesktopRuntimeThreadPlan,
  DesktopRuntimeThreadStatus,
  DesktopRuntimeThreadSummary,
  DesktopRuntimeStoreReset,
  DesktopShellPresetId,
  DesktopSettings,
  DesktopSupportBundle,
  DesktopUiStateSyncResult,
  DesktopUiStateV1,
} from "../../../src/desktopShell/contracts.js";
export type {
  DesktopAppDefinition,
  DesktopAppRef,
  DesktopExecutionSelection,
  DesktopModelConfiguration,
  DesktopModelConfigurationRef,
  DesktopModelConfigurationRevision,
} from "../../../src/desktopShell/configuration.js";

export interface DesktopAppInfo {
  name: string;
  version: string;
  isPackaged: boolean;
}

export interface DesktopProtocolTransport {
  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void;
  send(line: string): void;
  stop(): Promise<void>;
}

export interface DesktopRuntimeStatus {
  running: boolean;
  pid?: number | undefined;
  recentStdout: string[];
  recentStderr: string[];
  logPath: string;
}

export interface DesktopRuntimeStoreResetResult extends DesktopRuntimeStoreReset {
  runtimeStatus: DesktopRuntimeStatus;
}

export type DesktopShellCommand =
  | "add-project"
  | "new-thread"
  | "stop-agent"
  | "toggle-left-sidebar"
  | "toggle-right-sidebar"
  | "restart-runtime";

export interface DesktopBridge {
  getBridgeInfo(): Promise<DesktopBridgeInfo>;
  getAppInfo(): Promise<DesktopAppInfo>;
  getSupportBundle(): Promise<DesktopSupportBundle>;
  getCapabilities(): Promise<DesktopCapabilityView>;
  configureCapability(input: DesktopCapabilityConfigurationInput): Promise<DesktopCapabilityConfigurationResult>;
  getSettings(): Promise<DesktopRendererSettings>;
  saveSettings(settings: DesktopRendererSettingsUpdate): Promise<DesktopRendererSettings>;
  getUiState(): Promise<DesktopUiStateV1 | null>;
  syncLegacyUiState(entries: DesktopLegacyUiStateEntries): Promise<DesktopUiStateSyncResult>;
  saveUiState(entries: DesktopLegacyUiStateEntries): Promise<DesktopUiStateSyncResult>;
  runTurn(request: DesktopRunTurnRequest): Promise<DesktopRunnerEvent>;
  selectAttachments(threadId: string): Promise<DesktopAttachmentMetadata[]>;
  listAttachments(threadId: string): Promise<DesktopAttachmentMetadata[]>;
  removeAttachment(threadId: string, attachmentId: string): Promise<boolean>;
  submitOperatorControl(request: DesktopOperatorControlRequest): Promise<DesktopRuntimeThreadInspection>;
  cancelRun(request: DesktopRunCancelRequest): Promise<DesktopRunnerEvent>;
  onRunnerEvent(listener: (event: DesktopRunnerEvent) => void): () => void;
  getModelPolicy(): Promise<ModelPolicyV1>;
  getModelCatalog(provider: DesktopRendererSettings["selectedProvider"]): Promise<DesktopProviderModelCatalog>;
  getBootState(): Promise<DesktopBootState>;
  onBootState(listener: (state: DesktopBootState) => void): () => void;
  pickWorkspace(): Promise<string | undefined>;
  pickProjectFolder(): Promise<DesktopProjectRegistration | undefined>;
  openExternal(url: string): Promise<void>;
  openProjectRunPreview(input: { runId: string; url?: string | undefined }): Promise<void>;
  openFileEditor(input: DesktopOpenFileEditorInput): Promise<void>;
  openPath(input: DesktopPathTargetInput): Promise<void>;
  revealPath(input: DesktopPathTargetInput): Promise<void>;
  restartRuntime(): Promise<DesktopRuntimeStatus>;
  requestMicrophoneAccess(): Promise<DesktopMicrophoneAccess>;
  resetRuntimeStore(): Promise<DesktopRuntimeStoreResetResult>;
  restartApp(): Promise<void>;
  openDiagnostics(): Promise<void>;
  getRuntimeStatus(): Promise<DesktopRuntimeStatus>;
  getRuntimeHealth(): Promise<DesktopRuntimeHealth>;
  getDatabaseStatus(): Promise<DesktopDatabaseStatus>;
  restartDatabase(): Promise<DesktopDatabaseStatus>;
  repairDatabase(): Promise<DesktopDatabaseStatus>;
  revealDatabaseFiles(target: "log" | "data"): Promise<void>;
  onRuntimeHealth(listener: (status: DesktopRuntimeHealth) => void): () => void;
  listDirectory(rootPath: string, directoryPath?: string): Promise<DesktopDirectoryListing>;
  searchProjectFiles(rootPath: string, query: string): Promise<DesktopFileSearchResponse>;
  watchProjectFiles(rootPath: string): Promise<void>;
  unwatchProjectFiles(rootPath: string): Promise<void>;
  onProjectFilesChanged(listener: (event: DesktopProjectFilesChangedEvent) => void): () => void;
  readFile(input: DesktopFileReadInput): Promise<DesktopFileContent>;
  writeFile(input: DesktopFileWriteInput): Promise<DesktopFileContent>;
  discoverMcpServers(): Promise<DesktopMcpDiscoveryResult>;
  saveMcpServer(input: DesktopMcpServerMutationInput): Promise<DesktopMcpDiscoveryResult>;
  deleteMcpServer(id: string): Promise<DesktopMcpDiscoveryResult>;
  readProjectLauncher(projectPath: string, packageManagerOverride?: DesktopPackageManager): Promise<DesktopProjectLauncherDescriptor | undefined>;
  listProjectRuns(): Promise<DesktopManagedProjectRun[]>;
  startProjectRun(input: {
    projectPath: string;
    scriptName: string;
    packageManagerOverride?: DesktopPackageManager | undefined;
  }): Promise<DesktopManagedProjectRun>;
  stopProjectRun(runId: string): Promise<DesktopManagedProjectRun | undefined>;
  restartProjectRun(runId: string): Promise<DesktopManagedProjectRun>;
  getProjectSnapshot(sessionId: string): Promise<DesktopProjectSnapshotResponse>;
  runProjectAction(action: DesktopProjectAction): Promise<DesktopProjectSnapshotResponse>;
  getOperatorThread(threadId: string): Promise<DesktopRuntimeThreadInspection>;
  listOperatorRuns(query?: DesktopRuntimeRunIndexQuery): Promise<DesktopRuntimeRunIndex>;
  getOperatorRun(runId: string): Promise<DesktopRuntimeRunInspection>;
  onProjectRuns(listener: (runs: DesktopManagedProjectRun[]) => void): () => void;
  onCommand(listener: (command: DesktopShellCommand) => void): () => void;
}
