import type {
  DesktopBridgeInfo,
  DesktopBootState,
  DesktopDatabaseStatus,
  DesktopDirectoryListing,
  DesktopFileContent,
  DesktopFileContentSearchResponse,
  DesktopFileReadInput,
  DesktopOpenFileEditorInput,
  DesktopPathTargetInput,
  DesktopFileWriteInput,
  DesktopFileSearchResponse,
  DesktopManagedProjectRun,
  DesktopPreviewDiagnostic,
  DesktopManagedWorktreeCleanupResult,
  DesktopManagedWorktreeInspectionResult,
  DesktopManagedWorktreeRestoreResult,
  DesktopLegacyUiStateEntries,
  DesktopMicrophoneAccess,
  DesktopMcpDiscoveryResult,
  DesktopPackageManager,
  DesktopProjectLauncherDescriptor,
  DesktopProjectFilesChangedEvent,
  DesktopProjectAction,
  DesktopProjectRegistration,
  DesktopProjectSnapshotResponse,
  DesktopProviderCredentialInput,
  DesktopToolCredentialInput,
  DesktopToolCredentialProvider,
  DesktopToolCredentialStatus,
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
  RunTurnAttachment,
  DesktopThreadWorkspaceContext,
  DesktopWorkspaceCheckpointCaptureResult,
  DesktopWorkspaceCheckpointDiffResult,
  DesktopWorkspaceCheckpointCleanupResult,
  DesktopWorkspaceCheckpointInspectResult,
  DesktopWorkspaceCheckpointRestoreResult,
  DesktopWorkspaceLifecycleState,
  DesktopWorkspacePromotionApplyResult,
  DesktopWorkspacePromotionPreviewResult,
  DesktopWorkspacePromotionUndoResult,
  DesktopRuntimeStoreReset,
  DesktopSupportBundle,
  DesktopUiStateSyncResult,
  DesktopUiStateV1,
  DesktopUserTerminal,
  DesktopUserTerminalReadResult,
  DesktopWorkspaceChangeMutation,
  DesktopWorkspaceChangeMutationResult,
  DesktopWorkspaceChangeScope,
  DesktopWorkspaceDiffOptions,
  DesktopWorkspaceChangeSnapshot,
  DesktopWorkspaceFeedbackSnapshot,
  DesktopWorkspaceReviewSnapshot,
  DesktopWorkspaceValidationSnapshot,
  DesktopWorkspaceGitAction,
  DesktopWorkspaceGitSnapshot,
  DesktopWorkspaceFeedbackSubmitResult,
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
  DesktopCapabilityPackId,
  DesktopCredentialedModelProvider,
  DesktopBridgeCapabilityId,
  DesktopBridgeInfo,
  DesktopBootState,
  DesktopDatabaseMode,
  DesktopDatabaseStatus,
  DesktopDirectoryListing,
  DesktopFileContent,
  DesktopFileContentSearchResult,
  DesktopFileContentSearchResponse,
  DesktopFileEntry,
  DesktopFileReadInput,
  DesktopOpenFileEditorInput,
  DesktopPathTargetInput,
  DesktopFileWriteInput,
  DesktopFileSearchResult,
  DesktopFileSearchResponse,
  DesktopManagedProjectRun,
  DesktopPreviewDiagnostic,
  DesktopManagedWorktreeCleanupResult,
  DesktopManagedWorktreeInspectionResult,
  DesktopManagedWorktreeRestoreResult,
  DesktopUserTerminal,
  DesktopUserTerminalReadResult,
  DesktopWorkspaceChangeMutation,
  DesktopWorkspaceChangeMutationResult,
  DesktopWorkspaceChangeScope,
  DesktopWorkspaceDiffOptions,
  DesktopWorkspaceChangeSnapshot,
  DesktopWorkspaceFeedbackSnapshot,
  DesktopWorkspaceReviewSnapshot,
  DesktopWorkspaceValidationSnapshot,
  DesktopWorkspaceGitAction,
  DesktopWorkspaceGitSnapshot,
  DesktopWorkspaceFeedbackSubmitResult,
  DesktopManagedProjectRunPreviewUrl,
  DesktopLegacyUiStateEntries,
  DesktopMcpDiscoveryDiagnostic,
  DesktopMicrophoneAccess,
  DesktopMcpDiscoveryResult,
  DesktopMcpDiscoverySourceKind,
  DesktopMcpServerConfig,
  DesktopMcpToolSummary,
  DesktopModelProvider,
  DesktopPackageManager,
  DesktopProjectLauncherDescriptor,
  DesktopProjectFilesChangedEvent,
  DesktopProjectAction,
  DesktopProjectRegistration,
  DesktopProjectSnapshotResponse,
  DesktopProviderCredentialInput,
  DesktopToolCredentialInput,
  DesktopToolCredentialProvider,
  DesktopToolCredentialStatus,
  DesktopRendererSettings,
  DesktopRendererSettingsUpdate,
  DesktopReadinessView,
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
  RunTurnAttachment,
  DesktopRuntimeThreadNextAction,
  DesktopRuntimeThreadPlan,
  DesktopRuntimeThreadStatus,
  DesktopRuntimeThreadSummary,
  DesktopThreadWorkspaceContext,
  DesktopWorkspaceCheckpointCaptureResult,
  DesktopWorkspaceCheckpointDiffResult,
  DesktopWorkspaceCheckpointCleanupResult,
  DesktopWorkspaceCheckpointInspectResult,
  DesktopWorkspaceCheckpointRestoreResult,
  DesktopWorkspaceLifecycleState,
  DesktopWorkspacePromotionApplyResult,
  DesktopWorkspacePromotionPreviewResult,
  DesktopWorkspacePromotionUndoResult,
  DesktopRuntimeStoreReset,
  DesktopShellPresetId,
  DesktopSettings,
  DesktopSupportBundle,
  DesktopUiStateSyncResult,
  DesktopUiStateV1,
} from "../../../src/desktopShell/contracts.js";

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
  getSettings(): Promise<DesktopRendererSettings>;
  saveSettings(settings: DesktopRendererSettingsUpdate): Promise<DesktopRendererSettings>;
  saveProviderCredential(input: DesktopProviderCredentialInput): Promise<DesktopRendererSettings>;
  getToolCredentialStatus(provider: DesktopToolCredentialProvider): Promise<DesktopToolCredentialStatus>;
  saveToolCredential(input: DesktopToolCredentialInput): Promise<DesktopToolCredentialStatus>;
  deleteToolCredential(provider: DesktopToolCredentialProvider): Promise<DesktopToolCredentialStatus>;
  getUiState(): Promise<DesktopUiStateV1 | null>;
  syncLegacyUiState(entries: DesktopLegacyUiStateEntries): Promise<DesktopUiStateSyncResult>;
  saveUiState(entries: DesktopLegacyUiStateEntries): Promise<DesktopUiStateSyncResult>;
  runTurn(request: DesktopRunTurnRequest): Promise<DesktopRunnerEvent>;
  cancelRun(request: DesktopRunCancelRequest): Promise<DesktopRunnerEvent>;
  onRunnerEvent(listener: (event: DesktopRunnerEvent) => void): () => void;
  getModelPolicy(): Promise<ModelPolicyV1>;
  saveModelPolicy(policy: ModelPolicyV1): Promise<ModelPolicyV1>;
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
  listDirectory(rootPath: string, directoryPath?: string, threadId?: string): Promise<DesktopDirectoryListing>;
  searchProjectFiles(rootPath: string, query: string, threadId?: string): Promise<DesktopFileSearchResponse>;
  searchProjectContent(rootPath: string, query: string, threadId?: string): Promise<DesktopFileContentSearchResponse>;
  watchProjectFiles(rootPath: string, threadId?: string): Promise<void>;
  unwatchProjectFiles(rootPath: string): Promise<void>;
  onProjectFilesChanged(listener: (event: DesktopProjectFilesChangedEvent) => void): () => void;
  readFile(input: DesktopFileReadInput): Promise<DesktopFileContent>;
  writeFile(input: DesktopFileWriteInput): Promise<DesktopFileContent>;
  discoverMcpServers(): Promise<DesktopMcpDiscoveryResult>;
  readProjectLauncher(projectPath: string, packageManagerOverride?: DesktopPackageManager, threadId?: string): Promise<DesktopProjectLauncherDescriptor | undefined>;
  listProjectRuns(): Promise<DesktopManagedProjectRun[]>;
  startProjectRun(input: {
    projectPath: string;
    scriptName: string;
    packageManagerOverride?: DesktopPackageManager | undefined;
    threadId?: string | undefined;
  }): Promise<DesktopManagedProjectRun>;
  stopProjectRun(runId: string): Promise<DesktopManagedProjectRun | undefined>;
  restartProjectRun(runId: string): Promise<DesktopManagedProjectRun>;
  onPreviewDiagnostic(listener: (diagnostic: DesktopPreviewDiagnostic) => void): () => void;
  getProjectSnapshot(sessionId: string): Promise<DesktopProjectSnapshotResponse>;
  runProjectAction(action: DesktopProjectAction): Promise<DesktopProjectSnapshotResponse>;
  getOperatorThread(threadId: string): Promise<DesktopRuntimeThreadInspection>;
  listOperatorRuns(query?: DesktopRuntimeRunIndexQuery): Promise<DesktopRuntimeRunIndex>;
  getOperatorRun(runId: string): Promise<DesktopRuntimeRunInspection>;
  getWorkspaceLifecycle(sessionId: string): Promise<DesktopWorkspaceLifecycleState>;
  captureWorkspaceCheckpoint(input: {
    sessionId: string;
    label: string;
    threadId?: string | undefined;
  }): Promise<DesktopWorkspaceCheckpointCaptureResult>;
  restoreWorkspaceCheckpoint(input: {
    sessionId: string;
    checkpointId: string;
    reason: string;
    threadId?: string | undefined;
  }): Promise<DesktopWorkspaceCheckpointRestoreResult>;
  inspectWorkspaceCheckpoint(input: {
    sessionId: string;
    checkpointId: string;
  }): Promise<DesktopWorkspaceCheckpointInspectResult>;
  compareWorkspaceCheckpoint(input: {
    sessionId: string;
    sourceCheckpointId: string;
    targetCheckpointId?: string | undefined;
    targetGitRef?: string | undefined;
  }): Promise<DesktopWorkspaceCheckpointDiffResult>;
  cleanupWorkspaceCheckpoints(input: { sessionId: string; reason?: string }): Promise<DesktopWorkspaceCheckpointCleanupResult>;
  previewWorkspacePromotion(input: {
    sessionId: string;
    promotionId: string;
  }): Promise<DesktopWorkspacePromotionPreviewResult>;
  applyWorkspacePromotion(input: {
    sessionId: string;
    promotionId: string;
    candidateFingerprint: string;
  }): Promise<DesktopWorkspacePromotionApplyResult>;
  undoLatestWorkspacePromotion(input: {
    sessionId: string;
    reason?: string | undefined;
  }): Promise<DesktopWorkspacePromotionUndoResult>;
  inspectManagedWorktree(input: {
    sessionId: string;
    threadId: string;
  }): Promise<DesktopManagedWorktreeInspectionResult>;
  cleanupManagedWorktree(input: {
    sessionId: string;
    threadId: string;
    reason: string;
  }): Promise<DesktopManagedWorktreeCleanupResult>;
  restoreManagedWorktree(input: {
    sessionId: string;
    threadId: string;
    checkpointId: string;
    reason?: string | undefined;
  }): Promise<DesktopManagedWorktreeRestoreResult>;
  retryManagedWorktreeSetup(input: {
    sessionId: string;
    threadId: string;
  }): Promise<DesktopManagedWorktreeInspectionResult>;
  startUserTerminal(input: { sessionId: string; threadId: string; cols?: number; rows?: number }): Promise<DesktopUserTerminal>;
  listUserTerminals(input: { sessionId: string; threadId?: string }): Promise<DesktopUserTerminal[]>;
  readUserTerminal(input: { sessionId: string; terminalId: string; cursor?: number }): Promise<DesktopUserTerminalReadResult>;
  writeUserTerminal(input: { sessionId: string; terminalId: string; data: string }): Promise<DesktopUserTerminal>;
  resizeUserTerminal(input: { sessionId: string; terminalId: string; cols: number; rows: number }): Promise<DesktopUserTerminal>;
  stopUserTerminal(input: { sessionId: string; terminalId: string }): Promise<DesktopUserTerminal>;
  inspectWorkspaceChanges(input: { sessionId: string; threadId: string; scope: DesktopWorkspaceChangeScope; options?: Partial<DesktopWorkspaceDiffOptions> }): Promise<DesktopWorkspaceChangeSnapshot>;
  mutateWorkspaceChanges(input: { sessionId: string; threadId: string; expectedFingerprint: string; scope?: DesktopWorkspaceChangeScope; options?: Partial<DesktopWorkspaceDiffOptions>; mutation: DesktopWorkspaceChangeMutation }): Promise<DesktopWorkspaceChangeMutationResult>;
  addWorkspaceFeedback(input: { sessionId: string; threadId: string; candidateFingerprint: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string }): Promise<DesktopWorkspaceFeedbackSnapshot>;
  listWorkspaceFeedback(input: { sessionId: string; threadId: string }): Promise<DesktopWorkspaceFeedbackSnapshot>;
  removeWorkspaceFeedback(input: { sessionId: string; threadId: string; candidateFingerprint: string; commentId: string }): Promise<DesktopWorkspaceFeedbackSnapshot>;
  submitWorkspaceFeedback(input: { sessionId: string; threadId: string; candidateFingerprint: string; commentIds: string[] }): Promise<DesktopWorkspaceFeedbackSubmitResult>;
  runWorkspaceReview(input: { sessionId: string; threadId: string; scope: DesktopWorkspaceChangeScope; mode?: "current_thread" | "detached_thread"; reviewerProfileId?: string; reviewerModel?: string }): Promise<DesktopWorkspaceReviewSnapshot>;
  listWorkspaceReviews(input: { sessionId: string; threadId: string }): Promise<DesktopWorkspaceReviewSnapshot>;
  updateWorkspaceReviewFinding(input: { sessionId: string; threadId: string; candidateFingerprint: string; reviewId: string; findingId: string; action: "accept" | "dismiss" | "reopen" | "mark_fixed"; reason?: string }): Promise<DesktopWorkspaceReviewSnapshot>;
  submitWorkspaceReviewFindings(input: { sessionId: string; threadId: string; candidateFingerprint: string; reviewId: string; findingIds: string[]; request: "address" | "more_evidence" | "verify" }): Promise<{ snapshot: DesktopWorkspaceReviewSnapshot; runId: string }>;
  inspectWorkspaceValidation(input: { sessionId: string; threadId: string }): Promise<DesktopWorkspaceValidationSnapshot>;
  runWorkspaceValidation(input: { sessionId: string; threadId: string; candidateFingerprint: string; actionId?: string; suiteId?: string }): Promise<DesktopWorkspaceValidationSnapshot>;
  cancelWorkspaceValidation(input: { sessionId: string; threadId: string; resultId: string }): Promise<DesktopWorkspaceValidationSnapshot>;
  submitWorkspaceValidationFailures(input: { sessionId: string; threadId: string; resultIds: string[] }): Promise<{ snapshot: DesktopWorkspaceValidationSnapshot; runId: string }>;
  inspectWorkspaceGit(input: { sessionId: string; threadId: string }): Promise<DesktopWorkspaceGitSnapshot>;
  performWorkspaceGitAction(input: { sessionId: string; threadId: string; candidateFingerprint: string; expectedHeadSha?: string; action: DesktopWorkspaceGitAction }): Promise<DesktopWorkspaceGitSnapshot>;
  onProjectRuns(listener: (runs: DesktopManagedProjectRun[]) => void): () => void;
  onCommand(listener: (command: DesktopShellCommand) => void): () => void;
}
