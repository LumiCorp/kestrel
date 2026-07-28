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
  DesktopFileContentSearchResponse,
  DesktopFileReadInput,
  DesktopOpenFileEditorInput,
  DesktopPathTargetInput,
  DesktopFileWriteInput,
  DesktopFileSearchResponse,
  DesktopFollowUpQueueEntry,
  DesktopManagedProjectRun,
  DesktopPreviewDiagnostic,
  DesktopManagedWorktreeCleanupResult,
  DesktopManagedWorktreeInspectionResult,
  DesktopManagedWorktreeRestoreResult,
  DesktopLegacyUiStateEntries,
  DesktopMicrophoneAccess,
  DesktopMicrophoneAccessState,
  DesktopMcpDiscoveryResult,
  DesktopAppConnectionSession,
  DesktopStandardAppConnectionInput,
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
  DesktopOperatorControlRequest,
  DesktopOperatorInboxItem,
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
import type { DesktopEnvironmentStatusProjection } from "../../../src/localCore/desktopEnvironmentConnector.js";
import type {
  KestrelOneAccountStatus,
  KestrelOneAuthorizationSessionView,
  KestrelOneDesktopPreview,
  KestrelOneSubmittedTurn,
  KestrelOneThreadSnapshot,
} from "../../../src/localCore/kestrelOneAccount.js";
import type {
  KestrelUninstallApplyResultV1,
  KestrelUninstallPlanOptions,
  KestrelUninstallPlanV1,
  KestrelUninstallScope,
} from "../../../src/uninstall/contracts.js";
import type {
  WorkspaceSkillInstallation,
  WorkspaceSkillSource,
} from "../../../src/skills/contracts.js";
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
  DesktopFileContentSearchResult,
  DesktopFileContentSearchResponse,
  DesktopFileEntry,
  DesktopFileReadInput,
  DesktopOpenFileEditorInput,
  DesktopPathTargetInput,
  DesktopFileWriteInput,
  DesktopFileSearchResult,
  DesktopFileSearchResponse,
  DesktopFollowUpQueueEntry,
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
  DesktopManagedProjectRunOutputLine,
  DesktopLegacyUiStateEntries,
  DesktopMcpDiscoveryDiagnostic,
  DesktopMicrophoneAccess,
  DesktopMicrophoneAccessState,
  DesktopMcpDiscoveryResult,
  DesktopAppConnectionSession,
  DesktopStandardAppConnectionInput,
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
  RunTurnAttachment,
  DesktopOperatorControlRequest,
  DesktopOperatorInboxItem,
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
export type {
  WorkspaceSkillInstallation,
  WorkspaceSkillSource,
} from "../../../src/skills/contracts.js";
export type { DesktopEnvironmentStatusProjection } from "../../../src/localCore/desktopEnvironmentConnector.js";
export type {
  KestrelOneAccountProjection,
  KestrelOneAccountStatus,
  KestrelOneAuthorizationSessionView,
  KestrelOneDesktopPreview,
  KestrelOneSubmittedTurn,
  KestrelOneThreadSnapshot,
} from "../../../src/localCore/kestrelOneAccount.js";
export type {
  KestrelUninstallApplyResultV1,
  KestrelUninstallPlanOptions,
  KestrelUninstallPlanV1,
  KestrelUninstallScope,
} from "../../../src/uninstall/contracts.js";

export interface DesktopUninstallApplyInput {
  plan: KestrelUninstallPlanV1;
  confirmPlanId: string;
  deleteDataPhrase?: string | undefined;
  discardWorktreesPhrase?: string | undefined;
}
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

export type DesktopUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "blocked"
  | "installing"
  | "error";

export interface DesktopUpdateBlocker {
  source: "desktop" | "local_core";
  code: string;
  message: string;
  count: number;
}

export interface DesktopUpdateState {
  supported: boolean;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  targetVersion?: string | undefined;
  progressPercent?: number | undefined;
  blockers: DesktopUpdateBlocker[];
  message: string;
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
  | "restart-runtime"
  | "uninstall";

export type DesktopRunCancellationResult =
  | { status: "cancelled"; event: DesktopRunnerEvent }
  | { status: "already_stopped" }
  | {
      status: "run_changed";
      activeRunId?: string | undefined;
      activeCommandId?: string | undefined;
    };

export type DesktopThreadAuthorityResult =
  | { status: "available"; view: DesktopRuntimeThreadInspection }
  | { status: "missing" };

export interface DesktopAttachmentImportInput {
  threadId: string;
  filename: string;
  mimeType?: string | undefined;
  data: string;
  sha256?: string | undefined;
}

export interface DesktopBridge {
  getBridgeInfo(): Promise<DesktopBridgeInfo>;
  getAppInfo(): Promise<DesktopAppInfo>;
  getSupportBundle(): Promise<DesktopSupportBundle>;
  createUninstallPlan(input: {
    scope: KestrelUninstallScope;
    options?: KestrelUninstallPlanOptions | undefined;
  }): Promise<KestrelUninstallPlanV1>;
  applyUninstallPlan(
    input: DesktopUninstallApplyInput,
  ): Promise<KestrelUninstallApplyResultV1>;
  getPendingUninstallResult(): Promise<KestrelUninstallApplyResultV1 | undefined>;
  getCapabilities(): Promise<DesktopCapabilityView>;
  configureCapability(
    input: DesktopCapabilityConfigurationInput,
  ): Promise<DesktopCapabilityConfigurationResult>;
  getSettings(): Promise<DesktopRendererSettings>;
  getKestrelOneAccount(): Promise<KestrelOneAccountStatus>;
  startKestrelOneAuthorization(input: {
    baseUrl: string;
  }): Promise<KestrelOneAuthorizationSessionView>;
  getKestrelOneAuthorizationStatus(
    sessionId: string,
  ): Promise<KestrelOneAuthorizationSessionView>;
  signOutKestrelOneAccount(): Promise<KestrelOneAccountStatus>;
  getKestrelOneThread(threadId: string): Promise<KestrelOneThreadSnapshot>;
  submitKestrelOneTurn(input: {
    threadId: string;
    text: string;
    interactionMode: "chat" | "plan" | "build";
    model?: string | undefined;
  }): Promise<KestrelOneSubmittedTurn>;
  publishKestrelOnePreview(input: {
    projectId: string;
    connectionId: string;
    localRunRef: string;
    localUrl: string;
    name?: string | undefined;
  }): Promise<KestrelOneDesktopPreview>;
  renewKestrelOnePreview(previewId: string): Promise<KestrelOneDesktopPreview>;
  unpublishKestrelOnePreview(previewId: string): Promise<void>;
  getKestrelOneEnvironments(): Promise<DesktopEnvironmentStatusProjection>;
  startKestrelOneEnrollment(input: {
    baseUrl: string;
    desktopName: string;
  }): Promise<DesktopEnvironmentStatusProjection>;
  refreshKestrelOneEnrollments(): Promise<DesktopEnvironmentStatusProjection>;
  setKestrelOneCapacity(
    capacity: number,
  ): Promise<DesktopEnvironmentStatusProjection>;
  disconnectKestrelOneEnvironment(
    connectionId: string,
  ): Promise<DesktopEnvironmentStatusProjection>;
  saveSettings(
    settings: DesktopRendererSettingsUpdate,
  ): Promise<DesktopRendererSettings>;
  getUiState(): Promise<DesktopUiStateV1 | null>;
  syncLegacyUiState(
    entries: DesktopLegacyUiStateEntries,
  ): Promise<DesktopUiStateSyncResult>;
  saveUiState(
    entries: DesktopLegacyUiStateEntries,
  ): Promise<DesktopUiStateSyncResult>;
  runTurn(request: DesktopRunTurnRequest): Promise<DesktopRunnerEvent>;
  selectAttachments(threadId: string): Promise<DesktopAttachmentMetadata[]>;
  importAttachment(
    input: DesktopAttachmentImportInput,
  ): Promise<DesktopAttachmentMetadata>;
  listAttachments(threadId: string): Promise<DesktopAttachmentMetadata[]>;
  removeAttachment(threadId: string, attachmentId: string): Promise<boolean>;
  submitOperatorControl(
    request: DesktopOperatorControlRequest,
  ): Promise<DesktopRuntimeThreadInspection>;
  cancelRun(
    request: DesktopRunCancelRequest,
  ): Promise<DesktopRunCancellationResult>;
  onRunnerEvent(listener: (event: DesktopRunnerEvent) => void): () => void;
  getModelPolicy(): Promise<ModelPolicyV1>;
  getModelCatalog(
    provider: DesktopRendererSettings["selectedProvider"],
  ): Promise<DesktopProviderModelCatalog>;
  getBootState(): Promise<DesktopBootState>;
  onBootState(listener: (state: DesktopBootState) => void): () => void;
  pickWorkspace(): Promise<string | undefined>;
  pickProjectFolder(): Promise<DesktopProjectRegistration | undefined>;
  openExternal(url: string): Promise<void>;
  openProjectRunPreview(input: {
    runId: string;
    url?: string | undefined;
  }): Promise<void>;
  openFileEditor(input: DesktopOpenFileEditorInput): Promise<void>;
  openPath(input: DesktopPathTargetInput): Promise<void>;
  revealPath(input: DesktopPathTargetInput): Promise<void>;
  restartRuntime(): Promise<DesktopRuntimeStatus>;
  requestMicrophoneAccess(): Promise<DesktopMicrophoneAccess>;
  resetRuntimeStore(): Promise<DesktopRuntimeStoreResetResult>;
  restartApp(): Promise<void>;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
  openDiagnostics(): Promise<void>;
  getRuntimeStatus(): Promise<DesktopRuntimeStatus>;
  getRuntimeHealth(): Promise<DesktopRuntimeHealth>;
  getDatabaseStatus(): Promise<DesktopDatabaseStatus>;
  restartDatabase(): Promise<DesktopDatabaseStatus>;
  repairDatabase(): Promise<DesktopDatabaseStatus>;
  revealDatabaseFiles(target: "log" | "data"): Promise<void>;
  onRuntimeHealth(listener: (status: DesktopRuntimeHealth) => void): () => void;
  listDirectory(
    rootPath: string,
    directoryPath?: string,
    threadId?: string,
  ): Promise<DesktopDirectoryListing>;
  searchProjectFiles(
    rootPath: string,
    query: string,
    threadId?: string,
  ): Promise<DesktopFileSearchResponse>;
  searchProjectContent(
    rootPath: string,
    query: string,
    threadId?: string,
  ): Promise<DesktopFileContentSearchResponse>;
  watchProjectFiles(rootPath: string, threadId?: string): Promise<void>;
  unwatchProjectFiles(rootPath: string): Promise<void>;
  onProjectFilesChanged(
    listener: (event: DesktopProjectFilesChangedEvent) => void,
  ): () => void;
  readFile(input: DesktopFileReadInput): Promise<DesktopFileContent>;
  writeFile(input: DesktopFileWriteInput): Promise<DesktopFileContent>;
  discoverMcpServers(): Promise<DesktopMcpDiscoveryResult>;
  startStandardAppConnection(
    input: DesktopStandardAppConnectionInput,
  ): Promise<DesktopAppConnectionSession>;
  getStandardAppConnectionStatus(
    sessionId: string,
  ): Promise<DesktopAppConnectionSession>;
  saveMcpServer(
    input: DesktopMcpServerMutationInput,
  ): Promise<DesktopMcpDiscoveryResult>;
  deleteMcpServer(id: string): Promise<DesktopMcpDiscoveryResult>;
  readProjectLauncher(
    projectPath: string,
    packageManagerOverride?: DesktopPackageManager,
    threadId?: string,
  ): Promise<DesktopProjectLauncherDescriptor | undefined>;
  listWorkspaceSkills(
    projectPath: string,
  ): Promise<WorkspaceSkillInstallation[]>;
  installWorkspaceSkill(
    projectPath: string,
    source: WorkspaceSkillSource,
  ): Promise<WorkspaceSkillInstallation>;
  updateWorkspaceSkill(
    projectPath: string,
    installationId: string,
    source: WorkspaceSkillSource,
  ): Promise<WorkspaceSkillInstallation>;
  syncWorkspaceSkills(
    projectPath: string,
  ): Promise<WorkspaceSkillInstallation[]>;
  removeWorkspaceSkill(
    projectPath: string,
    installationId: string,
  ): Promise<WorkspaceSkillInstallation[]>;
  listProjectRuns(): Promise<DesktopManagedProjectRun[]>;
  startProjectRun(input: {
    projectPath: string;
    scriptName: string;
    packageManagerOverride?: DesktopPackageManager | undefined;
    threadId?: string | undefined;
  }): Promise<DesktopManagedProjectRun>;
  stopProjectRun(runId: string): Promise<DesktopManagedProjectRun | undefined>;
  restartProjectRun(runId: string): Promise<DesktopManagedProjectRun>;
  onPreviewDiagnostic(
    listener: (diagnostic: DesktopPreviewDiagnostic) => void,
  ): () => void;
  getProjectSnapshot(
    sessionId: string,
  ): Promise<DesktopProjectSnapshotResponse>;
  runProjectAction(
    action: DesktopProjectAction,
  ): Promise<DesktopProjectSnapshotResponse>;
  getOperatorThread(threadId: string): Promise<DesktopRuntimeThreadInspection>;
  inspectThreadAuthority(
    threadId: string,
  ): Promise<DesktopThreadAuthorityResult>;
  listOperatorRuns(
    query?: DesktopRuntimeRunIndexQuery,
  ): Promise<DesktopRuntimeRunIndex>;
  getOperatorRun(runId: string): Promise<DesktopRuntimeRunInspection>;
  getWorkspaceLifecycle(
    sessionId: string,
  ): Promise<DesktopWorkspaceLifecycleState>;
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
  cleanupWorkspaceCheckpoints(input: {
    sessionId: string;
    reason?: string;
  }): Promise<DesktopWorkspaceCheckpointCleanupResult>;
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
  startUserTerminal(input: {
    sessionId: string;
    threadId: string;
    cols?: number;
    rows?: number;
  }): Promise<DesktopUserTerminal>;
  listUserTerminals(input: {
    sessionId: string;
    threadId?: string;
  }): Promise<DesktopUserTerminal[]>;
  readUserTerminal(input: {
    sessionId: string;
    terminalId: string;
    cursor?: number;
  }): Promise<DesktopUserTerminalReadResult>;
  writeUserTerminal(input: {
    sessionId: string;
    terminalId: string;
    data: string;
  }): Promise<DesktopUserTerminal>;
  resizeUserTerminal(input: {
    sessionId: string;
    terminalId: string;
    cols: number;
    rows: number;
  }): Promise<DesktopUserTerminal>;
  stopUserTerminal(input: {
    sessionId: string;
    terminalId: string;
  }): Promise<DesktopUserTerminal>;
  inspectWorkspaceChanges(input: {
    sessionId: string;
    threadId: string;
    projectPath?: string;
    scope: DesktopWorkspaceChangeScope;
    options?: Partial<DesktopWorkspaceDiffOptions>;
  }): Promise<DesktopWorkspaceChangeSnapshot>;
  mutateWorkspaceChanges(input: {
    sessionId: string;
    threadId: string;
    expectedFingerprint: string;
    scope?: DesktopWorkspaceChangeScope;
    options?: Partial<DesktopWorkspaceDiffOptions>;
    mutation: DesktopWorkspaceChangeMutation;
  }): Promise<DesktopWorkspaceChangeMutationResult>;
  addWorkspaceFeedback(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
  }): Promise<DesktopWorkspaceFeedbackSnapshot>;
  listWorkspaceFeedback(input: {
    sessionId: string;
    threadId: string;
  }): Promise<DesktopWorkspaceFeedbackSnapshot>;
  removeWorkspaceFeedback(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    commentId: string;
  }): Promise<DesktopWorkspaceFeedbackSnapshot>;
  submitWorkspaceFeedback(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    commentIds: string[];
  }): Promise<DesktopWorkspaceFeedbackSubmitResult>;
  runWorkspaceReview(input: {
    sessionId: string;
    threadId: string;
    scope: DesktopWorkspaceChangeScope;
    mode?: "current_thread" | "detached_thread";
    reviewerProfileId?: string;
    reviewerModel?: string;
  }): Promise<DesktopWorkspaceReviewSnapshot>;
  listWorkspaceReviews(input: {
    sessionId: string;
    threadId: string;
  }): Promise<DesktopWorkspaceReviewSnapshot>;
  updateWorkspaceReviewFinding(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    reviewId: string;
    findingId: string;
    action: "accept" | "dismiss" | "reopen" | "mark_fixed";
    reason?: string;
  }): Promise<DesktopWorkspaceReviewSnapshot>;
  submitWorkspaceReviewFindings(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    reviewId: string;
    findingIds: string[];
    request: "address" | "more_evidence" | "verify";
  }): Promise<{ snapshot: DesktopWorkspaceReviewSnapshot; runId: string }>;
  inspectWorkspaceValidation(input: {
    sessionId: string;
    threadId: string;
  }): Promise<DesktopWorkspaceValidationSnapshot>;
  runWorkspaceValidation(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    actionId?: string;
    suiteId?: string;
  }): Promise<DesktopWorkspaceValidationSnapshot>;
  cancelWorkspaceValidation(input: {
    sessionId: string;
    threadId: string;
    resultId: string;
  }): Promise<DesktopWorkspaceValidationSnapshot>;
  submitWorkspaceValidationFailures(input: {
    sessionId: string;
    threadId: string;
    resultIds: string[];
  }): Promise<{ snapshot: DesktopWorkspaceValidationSnapshot; runId: string }>;
  inspectWorkspaceGit(input: {
    sessionId: string;
    threadId: string;
  }): Promise<DesktopWorkspaceGitSnapshot>;
  performWorkspaceGitAction(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    expectedHeadSha?: string;
    action: DesktopWorkspaceGitAction;
  }): Promise<DesktopWorkspaceGitSnapshot>;
  onProjectRuns(
    listener: (runs: DesktopManagedProjectRun[]) => void,
  ): () => void;
  onCommand(listener: (command: DesktopShellCommand) => void): () => void;
}
