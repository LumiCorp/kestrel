import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronSquirrelStartup from "electron-squirrel-startup";
import electronUpdater from "electron-updater";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  systemPreferences,
  webContents,
  session,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import {
  DESKTOP_BRIDGE_CAPABILITIES,
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_UI_STATE_SOURCE,
  DESKTOP_UI_STATE_RENDERER_SOURCE,
  DESKTOP_UI_STATE_VERSION,
  parseDesktopLegacyUiStateEntries,
  parseDesktopCapabilityConfigurationInput,
  parseDesktopBrowserPersonalDomainListRequest,
  parseDesktopBrowserPersonalDomainRevokeRequest,
  parseDesktopProviderModelCatalogRequest,
  parseDesktopMcpServerMutationInput,
  parseDesktopRendererSettingsUpdate,
  parseDesktopRunCancelRequest,
  parseDesktopRunTurnRequest,
  parseDesktopConversationMessageRequest,
  parseDesktopOperatorControlRequest,
} from "../../../src/desktopShell/contracts.js";
import {
  ensureLocalCoreDaemonReady,
  isLocalCoreDaemonElectronAppLaunch,
  type LocalCoreDaemonReady,
} from "../../../src/localCore/daemon.js";
import {
  resolveKestrelCoreHome,
  resolveLocalCorePaths,
} from "../../../src/localCore/home.js";
import {
  LocalCoreApiError,
  type LocalCoreClient,
} from "../../../src/localCore/client.js";
import {
  LocalCoreConnectionManager,
  type LocalCoreConnectionState,
} from "../../../src/localCore/connectionManager.js";
import type { LocalCoreStatus } from "../../../src/localCore/contracts.js";
import { parseLocalCoreBuildIdentity } from "../../../src/localCore/contracts.js";
import { LOCAL_CORE_BUILD_MANIFEST_NAME } from "../../../src/localCore/buildIdentity.js";
import type { LocalCoreCredentialId } from "../../../src/localCore/credentialStore.js";
import { listMcpOAuthCredentialIds } from "../../../src/localCore/mcpOAuthProvider.js";
import {
  createWebRunnerAdapter,
  type WebRunnerAdapter,
  type WebRunnerRegisteredProfileSnapshot,
  type WebRunnerRequestContext,
} from "../../../src/web/index.js";
import {
  KESTREL_APP_IDS,
  KESTREL_STANDARD_APP_MANIFESTS,
  parseRunnerEventV2,
} from "@kestrel-agents/protocol";
import { deriveDesktopReadiness } from "../../../src/desktopShell/readiness.js";
import {
  deriveDesktopOnboardingRouteV1,
  desktopUiStateContainsOnboardingHandoff,
} from "../../../src/desktopShell/onboarding.js";
import { redactDiagnosticValue } from "../../../src/diagnostics/redaction.js";
import { resolveDesktopCapabilityView } from "../../../src/desktopShell/capabilityRegistry.js";
import {
  createDefaultModelPolicy,
  type ResolvedModelPolicy,
} from "../../../src/profile/modelPolicy.js";
import { resolveProviderModelCatalog } from "../../../src/profile/modelCatalogDiscovery.js";
import {
  assertDesktopModelConfigurationHistoryPreserved,
  currentDesktopModelConfigurationRef,
  getDesktopAppDefinition,
  type DesktopExecutionSelection,
} from "../../../src/desktopShell/configuration.js";
import {
  desktopStandardAppToolRequiresApproval,
  getDesktopStandardAppConnection,
} from "../../../src/desktopShell/standardAppConnections.js";
import {
  resolveDesktopLibexecRoot,
  resolveDesktopPathConfig,
} from "./config.js";
import {
  LinkPreviewService,
  parseDesktopLinkPreviewInput,
} from "./linkPreview.js";
import type { DatabaseUrlSource } from "../../../src/runtime/databasePreflight.js";
import type {
  DesktopBootState,
  DesktopLaunchState,
  DesktopOnboardingDraftInput,
  DesktopOnboardingProviderInput,
  DesktopOnboardingProviderVerificationResult,
  DesktopOnboardingProjectCandidate,
  DesktopOnboardingStateV1,
  DesktopCapabilityConfigurationResult,
  DesktopCapabilityView,
  DesktopDatabaseStatus,
  DesktopDirectoryListing,
  DesktopFileContent,
  DesktopFileContentSearchResponse,
  DesktopFileEntry,
  DesktopFileReadInput,
  DesktopOpenFileEditorInput,
  DesktopFileSearchResponse,
  DesktopFileWriteInput,
  DesktopManagedProjectRun,
  DesktopLegacyUiStateEntries,
  DesktopUiStateV1,
  DesktopMcpDiscoveryResult,
  DesktopAppConnectionSession,
  DesktopStandardAppConnectionInput,
  DesktopMcpServerConfig,
  DesktopMcpServerMutationInput,
  DesktopMicrophoneAccess,
  DesktopProjectRegistration,
  DesktopProjectFilesChangedEvent,
  DesktopRendererSettings,
  DesktopRendererSettingsUpdate,
  DesktopRendererBootstrapReport,
  DesktopProtocolTransport,
  DesktopProjectLauncherDescriptor,
  DesktopRuntimeHealth,
  DesktopReadinessView,
  DesktopRunCancelRequest,
  DesktopRunTurnRequest,
  DesktopConversationMessageRequest,
  DesktopConversationMessageResult,
  DesktopAttachmentMetadata,
  DesktopOperatorControlRequest,
  DesktopSettings,
  DesktopModelProvider,
  DesktopShellCommand,
  DesktopUpdateBlocker,
  DesktopUninstallApplyInput,
} from "./contracts.js";
import { createDesktopError } from "./errors.js";
import {
  DESKTOP_LOCAL_CORE_EXECUTION_PROFILE_INCOMPATIBLE,
  assertDesktopLocalCoreExecutionProfileCompatibility,
} from "./localCoreCompatibility.js";
import { resolveDesktopPublicAppClientId } from "./appConnectionConfig.js";
import {
  assertWithinRoot,
  parseDesktopPathTargetInput,
  resolveRegisteredDesktopProjectRoot,
  resolveDesktopProjectRootForWatcherCleanup,
  resolveVerifiedDesktopPathTarget,
} from "./fileAccess.js";
import {
  createDesktopBeforeQuitHandler,
  createDesktopShutdownPreparation,
  type DesktopShutdownPreparation,
} from "./lifecycle.js";
import { createElectronUpdaterAdapter } from "./electronUpdaterAdapter.js";
import { DesktopUpdateCoordinator } from "./updater.js";
import {
  canReuseDesktopOnboardingProviderVerification,
  createDesktopOnboardingProviderFailure,
} from "./onboardingProviderVerificationResult.js";
import { findExactRegisteredOnboardingProject } from "./onboardingProjectSelection.js";
import {
  buildDesktopUpdateDialog,
  resolveDesktopUpdateDialogAction,
} from "./updateDialog.js";
import {
  LocalCoreRunnerTransport,
  type DesktopRunnerControlTransport,
} from "./localCoreRunnerTransport.js";
import {
  createDesktopLocalCoreRecoveryOperations,
  createDesktopStartupRecoveryCoordinator,
  parseDesktopRestartKestrelInput,
  type DesktopStartupRecoveryCoordinator,
} from "./localCoreRecovery.js";
import {
  createDefaultDesktopSettings,
  normalizeDesktopSettings,
  preserveDesktopProjectRegistrationIds,
} from "./settingsStore.js";
import {
  DesktopBrowserPersonalDomainService,
  type DesktopBrowserPersonalDomainRememberRequest,
  type DesktopBrowserPersonalRevisionAdoptionCoordinator,
} from "./browserPersonalDomainService.js";
import {
  createCoreOwnedDesktopDatabaseController,
  type DesktopDatabaseController,
} from "./databaseController.js";
import { archiveRuntimeStore } from "./runtimeStoreReset.js";
import { ensureDesktopRunnerResponsive } from "./runnerHandshake.js";
import { startDesktopStartup } from "./startupSequence.js";
import { buildDesktopSupportBundle } from "./supportBundle.js";
import {
  ensureDesktopProjectGitBootstrap,
  inspectDesktopProjectGitBootstrap,
  prepareDesktopProjectRegistrations as prepareProjectRegistrationsForSettings,
} from "./projectGitBootstrap.js";
import { discoverMcpServersFromKnownConfigFiles } from "./mcpDiscovery.js";
import {
  completeDesktopMcpVerification,
  prepareDesktopMcpVerification,
} from "./mcpVerification.js";
import { DesktopProjectFileIndex } from "./projectFileIndex.js";
import { resolveProjectScopedDesktopAppIds } from "./projectPersonalApps.js";
import {
  getEffectiveDesktopEnabledAppIds,
  toDesktopRendererSettings,
} from "./rendererSettings.js";
import { probeDesktopCapabilities } from "./capabilityProbes.js";
import {
  DesktopModelProviderVerificationError,
  verifyDesktopModelCapability,
} from "./modelProviderVerification.js";
import { verifyDesktopToolProvider } from "./toolProviderVerification.js";
import {
  buildDesktopCapabilityConfigurationPlan,
  promoteDesktopDefaultModelConfiguration,
} from "./capabilityConfiguration.js";
import {
  deriveDesktopWorkspaceId,
  resolveDesktopThreadWorkspace,
} from "./threadWorkspace.js";
import { WorkspaceSkillManager } from "../../../src/skills/WorkspaceSkillStore.js";
import { requireMissionControlProjectId } from "../../../src/missionControl/projectAuthority.js";
import { discoverWorkspaceValidationCatalog } from "../../../src/validation/WorkspaceValidationService.js";
import type { WorkspaceSkillSource } from "../../../src/skills/contracts.js";
import { resolveDesktopWorkspaceAccessRoot } from "./workspaceAccess.js";
import {
  executeDesktopMissionControlAction,
  getDesktopMissionControlProject,
  getDesktopOperatorRun,
  getDesktopOperatorThread,
  listDesktopOperatorRuns,
  listDesktopConversationMessages,
  parseDesktopRuntimeThreadInspection,
  runDesktopOperatorControl,
} from "./missionControl.js";
import {
  applyDesktopWorkspacePromotion,
  captureDesktopWorkspaceCheckpoint,
  compareDesktopWorkspaceCheckpoint,
  cleanupDesktopWorkspaceCheckpoints,
  getDesktopWorkspaceLifecycle,
  inspectDesktopWorkspaceCheckpoint,
  inspectDesktopManagedWorktree,
  previewDesktopWorkspacePromotion,
  restoreDesktopWorkspaceCheckpoint,
  undoLatestDesktopWorkspacePromotion,
  cleanupDesktopManagedWorktree,
  restoreDesktopManagedWorktree,
  retryDesktopManagedWorktreeSetup,
} from "./workspaceLifecycle.js";
import { runDesktopUserTerminalCommand } from "./userTerminal.js";
import {
  inspectDesktopWorkspaceChanges,
  mutateDesktopWorkspaceChanges,
} from "./workspaceChanges.js";
import { runDesktopWorkspaceFeedback } from "./workspaceFeedback.js";
import { runDesktopWorkspaceReview } from "./workspaceReview.js";
import { runDesktopWorkspaceValidation } from "./workspaceValidation.js";
import { runDesktopWorkspaceGit } from "./workspaceGit.js";
import { isAllowedEmbeddedPreviewUrl } from "./previewSecurity.js";
import {
  parseDesktopAttachmentImportInput,
  parseDesktopAttachmentThreadId,
} from "./attachmentInput.js";
import { cancelDesktopRun } from "./runCancellation.js";
import { inspectDesktopThreadAuthority } from "./threadAuthority.js";
import {
  applyKestrelUninstallPlan,
  createKestrelUninstallPlan,
} from "../../../src/uninstall/coordinator.js";
import {
  KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
  parseKestrelUninstallCompletionReportV1,
  parseKestrelUninstallPlanV1,
  parseKestrelUninstallScope,
  type KestrelUninstallApplyResultV1,
  type KestrelUninstallBlocker,
  type KestrelUninstallPlanOptions,
  type KestrelUninstallTarget,
} from "../../../src/uninstall/contracts.js";

declare global {
  var __kestrelDesktopRunnerTransportFactory:
    | (() => DesktopProtocolTransport)
    | undefined;
  var __kestrelDesktopProfileOverride:
    | {
        presetId?: "desktop_safe_local" | "desktop_dev_local" | undefined;
        capabilityPacks?:
          | Array<
              | "balanced"
              | "filesystem"
              | "dev_shell"
              | "desktop_host"
              | "sandbox_code"
            >
          | undefined;
        version: number;
      }
    | undefined;
  var __kestrelDesktopUninstallHelperRunner:
    | ((
        input: DesktopUninstallHelperRunnerInput,
      ) => Promise<DesktopUninstallHelperReport>)
    | undefined;
}

interface DesktopUninstallHelperRunnerInput {
  helperPath: string;
  planPath: string;
  reportPath: string;
  parentPid: number;
  waitsForParentExit: boolean;
}

interface DesktopUninstallHelperReport {
  status: "applied" | "blocked" | "partial" | "scheduled";
  removedTargets: string[];
  failures: Array<{
    targetId?: string | undefined;
    code: string;
    message: string;
  }>;
  reportPath: string;
}

let mainWindow: BrowserWindow | undefined;
const bootStartedAt = new Date().toISOString();
let bootTimeline: NonNullable<DesktopBootState["timeline"]> = [];
let bootState: DesktopBootState = {
  phase: "idle",
  message: "Preparing desktop app…",
  startedAt: bootStartedAt,
  updatedAt: bootStartedAt,
};
let launchState: DesktopLaunchState = {
  phase: "foundation_starting",
  message: "Preparing Kestrel…",
};
let executionStartup: Promise<void> | undefined;
let executionIpcRegistered = false;
const onboardingProjectSelections = new Map<
  string,
  Omit<DesktopOnboardingProjectCandidate, "selectionId"> &
    (
      | { source: "picker"; selectedPath: string }
      | { source: "registered"; registeredPath: string }
    )
>();
const DESKTOP_RENDERER_BOOTSTRAP_TIMEOUT_MS = 10_000;
let rendererBootstrapGeneration = 0;
let rendererBootstrapTimeout: NodeJS.Timeout | undefined;
let rendererFallbackActive = false;
let desktopAppQuitting = false;
let runnerTransport: DesktopRunnerControlTransport | undefined;
const microsoft365AuthorizationSessionIds = new Set<string>();
const googleWorkspaceAuthorizationSessionIds = new Set<string>();
const mcpAuthorizationSessionIds = new Set<string>();
let desktopAdmissionClosed = false;
let desktopConfig: ReturnType<typeof resolveDesktopPathConfig> | undefined;
let localCoreStatus: LocalCoreStatus | undefined;
let runtimeHealth: DesktopRuntimeHealth = {
  state: "degraded",
  connection: "disconnected",
  summary: "Preparing desktop app…",
  running: false,
};
let databaseController: DesktopDatabaseController | undefined;
let databaseStatus: DesktopDatabaseStatus = {
  state: "starting",
  summary: "Preparing Kestrel Local Core database…",
  managed: false,
  initialized: false,
  running: false,
};
let desktopSettings: DesktopSettings = createDefaultDesktopSettings();
let browserPersonalDomainService: DesktopBrowserPersonalDomainService | undefined;
/**
 * Main owns the truthful pre-host state: Desktop cannot have an active Browser
 * Session until Issue 03 supplies and wires the real session coordinator.
 */
const noActiveDesktopBrowserSessionsPersonalRevisionAdoptionCoordinator:
  DesktopBrowserPersonalRevisionAdoptionCoordinator = {
  async adoptPersonalRevision(input) {
    return {
      personalRevision: input.personalRevision,
      closedUnauthorizedConnections: 0,
    };
  },
};
const linkPreviewService = new LinkPreviewService();

function resolveAuthoritativeDesktopExecutionSelection(
  requested: DesktopExecutionSelection,
  projectPath?: string | undefined,
): DesktopExecutionSelection {
  const authoritativeIds = resolveProjectScopedDesktopAppIds({
    ...(projectPath !== undefined ? { projectPath } : {}),
    projects: desktopSettings.projects,
    requested,
    enabledAppIds: getEffectiveDesktopEnabledAppIds(desktopSettings),
  });
  return {
    modelConfiguration: requested.modelConfiguration,
    apps: authoritativeIds.flatMap((id) => {
      const definition = getDesktopAppDefinition(
        id,
        undefined,
        desktopSettings.mcpServers,
      );
      return definition === undefined
        ? []
        : [{ id: definition.id, contractVersion: definition.contractVersion }];
    }),
  };
}
let desktopModelPolicy: ResolvedModelPolicy = createDefaultModelPolicy();
let localCoreConnectionManager: LocalCoreConnectionManager | undefined;
let localCoreConnectionState: LocalCoreConnectionState = "disconnected";
const desktopRunnerAdapters = new Map<string, WebRunnerAdapter>();
let defaultDesktopRunnerProfileId: string | undefined;
let unsubscribeProjectRunEvents: (() => void) | undefined;
let desktopProfileOverrideVersion = 0;
let currentDatabaseUrl: string | undefined;
let currentDatabaseUrlSource: DatabaseUrlSource = "desktop_default";
let mediaPermissionHandlerInstalled = false;
const projectRunPreviewWindows = new Map<string, BrowserWindow>();
const embeddedPreviewWebContentsIds = new Set<number>();
let embeddedPreviewSecurityConfigured = false;
const fileEditorWindows = new Map<string, BrowserWindow>();
const projectFileWatchers = new Map<string, DesktopProjectFileWatcher>();
const projectFileIndex = new DesktopProjectFileIndex();
const activeDesktopWorkspaceRunCounts = new Map<string, number>();
const activeDesktopAttachmentImports = new Map<
  string,
  {
    filePath: string;
    handle: FileHandle;
    threadId: string;
    filename: string;
    mimeType?: string | undefined;
    expectedBytes: number;
    receivedBytes: number;
  }
>();
const activatedDesktopWorkspaceSkills = new Set<string>();
const desktopWorkspaceSkillManagers = new Map<string, WorkspaceSkillManager>();
const EDITABLE_TEXT_FILE_MAX_BYTES = 1024 * 1024;
const READABLE_TEXT_FILE_MAX_BYTES = 5 * 1024 * 1024;
const DESKTOP_RUNNER_REQUEST_CONTEXT = {
  actor: {
    actorId: "kestrel-desktop",
    actorType: "operator",
    displayName: "Kestrel Desktop",
  },
} satisfies WebRunnerRequestContext;

interface DesktopProjectFileWatcher {
  rootPath: string;
  watcher: FSWatcher;
  subscriberIds: Set<number>;
  latestEvent?: DesktopProjectFilesChangedEvent | undefined;
  pendingTimer?: NodeJS.Timeout | undefined;
}

const rejectedDaemonAppLaunch = isLocalCoreDaemonElectronAppLaunch();
const ownsSingleInstanceLock =
  rejectedDaemonAppLaunch === false &&
  electronSquirrelStartup === false &&
  app.requestSingleInstanceLock();
const shouldStartDesktopMain =
  rejectedDaemonAppLaunch === false &&
  electronSquirrelStartup === false &&
  ownsSingleInstanceLock;

if (rejectedDaemonAppLaunch) {
  process.stderr.write(
    "[desktop] Refusing to start a Local Core daemon as an Electron application.\n",
  );
  app.exit(1);
} else if (electronSquirrelStartup || ownsSingleInstanceLock === false) {
  app.quit();
}

const currentModulePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentModulePath);
const preloadPath = path.join(currentDir, "preload.js");
const { autoUpdater } = electronUpdater;
let desktopUpdateCoordinator: DesktopUpdateCoordinator | undefined;
let desktopShutdownPreparation: DesktopShutdownPreparation | undefined;
let desktopStartupRecoveryCoordinator:
  | DesktopStartupRecoveryCoordinator
  | undefined;

async function main(): Promise<void> {
  await app.whenReady();
  const localCoreHome = resolveKestrelCoreHome(process.env, process.platform);
  if (localCoreHome.source !== "isolated_dev_home") {
    process.env.KESTREL_CORE_HOME = localCoreHome.homePath;
  }
  if (
    process.env.KESTREL_HOME === undefined ||
    process.env.KESTREL_HOME.trim().length === 0
  ) {
    process.env.KESTREL_HOME = localCoreHome.homePath;
  }
  const isolatedPackageSmokeCredentials =
    isApprovedPackageSmokeEnvironmentCredentialStore();
  if (
    process.platform === "darwin" &&
    isolatedPackageSmokeCredentials === false
  ) {
    process.env.KESTREL_CORE_CREDENTIAL_STORE = "macos_keychain";
  }
  desktopConfig = resolveDesktopPathConfig({
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    localCoreHomePath: localCoreHome.homePath,
    isPackaged: app.isPackaged,
  });
  if (app.isPackaged === false && process.platform === "darwin") {
    app.dock?.setIcon(desktopConfig.iconPath);
  }
  const desktopLibexecRoot = resolveDesktopLibexecRoot({
    currentValue: process.env.KESTREL_CLI_LIBEXEC,
    isPackaged: desktopConfig.isPackaged,
    repoRoot: desktopConfig.repoRoot,
  });
  if (desktopLibexecRoot !== undefined) {
    process.env.KESTREL_CLI_LIBEXEC = desktopLibexecRoot;
  }
  if (desktopConfig.isPackaged) {
    process.env.KESTREL_CORE_BUILD_MANIFEST_REQUIRED = "1";
  }

  configureEmbeddedPreviewSecurity();
  desktopShutdownPreparation = createMainDesktopShutdownPreparation();
  desktopStartupRecoveryCoordinator = createDesktopStartupRecoveryCoordinator({
    operations: createDesktopLocalCoreRecoveryOperations(
      localCoreHome.homePath,
    ),
    prepareDesktop: async () => {
      await requireDesktopShutdownPreparation().prepare({
        cancelActiveWork: false,
      });
    },
    relaunchDesktop() {
      setImmediate(() => {
        app.relaunch();
        app.exit(0);
      });
    },
  });
  desktopUpdateCoordinator = createMainDesktopUpdateCoordinator(
    desktopShutdownPreparation,
  );
  registerBootIpcHandlers();
  installApplicationMenu();
  installDesktopLifecycleHandlers(desktopShutdownPreparation);
  await startDesktopStartup({
    showBootWindow: async () => {
      await ensureMainWindow();
    },
    startServices: startDesktopServices,
    reportFailure: reportDesktopStartupFailure,
  });
}

async function startDesktopServices(): Promise<void> {
  const localCoreConfig = requireDesktopConfig();
  updateLaunchState({
    phase: "foundation_starting",
    message: "Connecting to Kestrel Local Core…",
  });
  updateBootState(
    {
      phase: "starting_runtime",
      message: "Connecting to Kestrel Local Core…",
    },
    mainWindow?.webContents,
  );
  const ready = await ensureDesktopLocalCoreReady(localCoreConfig);
  localCoreStatus = ready.status;
  localCoreConnectionState = "connected";
  localCoreConnectionManager = new LocalCoreConnectionManager({
    initialConnection: ready,
    connect: async () => await ensureDesktopLocalCoreReady(localCoreConfig),
    onConnected(connection) {
      localCoreStatus = connection.status;
      currentDatabaseUrl = connection.status.databaseUrl;
      subscribeToCoreProjectRuns(connection.client);
    },
    onStateChanged(state) {
      localCoreConnectionState = state;
      publishDesktopRuntimeHealth();
    },
  });
  updateBootState(
    {
      phase: "starting_runtime",
      message: "Loading Desktop settings…",
    },
    mainWindow?.webContents,
  );
  await refreshDesktopCoreState();
  updateBootState(
    {
      phase: "starting_runtime",
      message: "Migrating Desktop credentials…",
    },
    mainWindow?.webContents,
  );
  await migrateDesktopCredentialsToLocalCore();
  if (desktopSettings.selectedProvider !== desktopModelPolicy.provider) {
    updateBootState(
      {
        phase: "starting_runtime",
        message: "Applying Desktop model policy…",
      },
      mainWindow?.webContents,
    );
    await saveDesktopCoreSettings({
      ...desktopSettings,
      selectedProvider: desktopModelPolicy.provider,
    });
  }
  syncDesktopWebEnvironment(desktopSettings);
  applyDesktopProfileOverride(desktopSettings);
  updateBootState(
    {
      phase: "starting_database",
      message: "Configuring Kestrel Local Core database…",
    },
    mainWindow?.webContents,
  );
  await reconfigureDatabaseController(desktopSettings);
  if (databaseController === undefined) {
    throw createDesktopError({
      code: "desktop.database_controller_unavailable",
      message: "Kestrel Local Core database controller is unavailable.",
    });
  }
  const database = await databaseController.prepare();
  currentDatabaseUrl = database.databaseUrl;
  databaseStatus = database.status;

  if (desktopSettings.desktopOnboarding === undefined) {
    const resumeExistingSetup =
      desktopSettings.providerSelectionCompletedAt !== undefined ||
      desktopSettings.setupCompletedAt !== undefined ||
      desktopSettings.projects.length > 0 ||
      Object.keys(desktopSettings.capabilityVerifications).length > 0;
    await saveDesktopCoreSettings({
      ...desktopSettings,
      desktopOnboarding: {
        version: 1,
        status: "in_progress",
        startedAt: new Date().toISOString(),
        ...(resumeExistingSetup
          ? { provider: desktopSettings.selectedProvider }
          : {}),
        ...(resumeExistingSetup &&
        currentProviderModel(desktopSettings) !== undefined
          ? { model: currentProviderModel(desktopSettings) }
          : {}),
        ...(resumeExistingSetup && desktopSettings.projects[0] !== undefined
          ? { projectPath: desktopSettings.projects[0].path }
          : {}),
      },
    });
  }

  const onboarding = await readDesktopOnboardingState();
  if (
    desktopSettings.desktopOnboarding?.status !== "complete" ||
    onboarding.canComplete === false
  ) {
    updateBootState(
      {
        phase: "ready",
        message: "Desktop setup is ready.",
        database: databaseStatus,
      },
      mainWindow?.webContents,
    );
    updateLaunchState({
      phase: "setup_required",
      message:
        onboarding.mode === "repair"
          ? "Kestrel needs one setup item repaired."
          : "Finish setting up Kestrel.",
    });
    return;
  }

  await ensureDesktopOnboardingModelIsDefault(onboarding);
  await startDesktopExecutionServices();
  await ensureCompletedDesktopOnboardingHandoff();
  updateLaunchState(buildDesktopReadyLaunchState());
}

async function startDesktopExecutionServices(): Promise<void> {
  if (executionStartup !== undefined) {
    return await executionStartup;
  }
  executionStartup = startDesktopExecutionServicesOnce().catch((error) => {
    executionStartup = undefined;
    throw error;
  });
  return await executionStartup;
}

async function startDesktopExecutionServicesOnce(): Promise<void> {
  const localCoreConfig = requireDesktopConfig();
  updateLaunchState({
    phase: "starting_execution",
    message: "Starting Kestrel for this project…",
  });
  runnerTransport = new LocalCoreRunnerTransport({
    connectionManager: requireLocalCoreConnectionManager(),
    logPath: localCoreConfig.runtimeLogPath,
  });
  runnerTransport.observe({
    onLine(line) {
      try {
        const event = parseRunnerEventV2(JSON.parse(line));
        if (
          (event.type.startsWith("run.") ||
            event.type === "task.updated" ||
            event.type === "mission_control.project") &&
          mainWindow?.isDestroyed() === false
        ) {
          if (event.type === "mission_control.project") {
            mainWindow.webContents.send("desktop:mission-control-project", {
              projectId: event.payload.projectId,
              project: event.payload.project,
            });
          } else {
            mainWindow.webContents.send("desktop:runner-event", event);
          }
        }
      } catch {
        // Protocol parsing and command-specific error handling remain owned by the adapter.
      }
    },
  });
  updateBootState(
    {
      phase: "starting_runtime",
      message: "Resolving Desktop execution profile…",
    },
    mainWindow?.webContents,
  );
  await prepareDefaultDesktopRunnerAdapter(runnerTransport);
  subscribeToCoreProjectRuns();
  globalThis.__kestrelDesktopRunnerTransportFactory = () => {
    if (runnerTransport === undefined) {
      throw createDesktopError({
        code: "desktop.runner_not_started",
        message: "Desktop runner transport is unavailable.",
      });
    }
    return runnerTransport;
  };

  if (executionIpcRegistered === false) {
    registerIpcHandlers(runnerTransport);
    executionIpcRegistered = true;
  }
  await bootDesktop({ runnerTransport });
}

function installDesktopLifecycleHandlers(
  preparation: DesktopShutdownPreparation,
): void {
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void ensureMainWindow();
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("before-quit", () => {
    desktopAppQuitting = true;
    clearDesktopRendererBootstrapTimeout();
  });
  app.on(
    "before-quit",
    createDesktopBeforeQuitHandler({
      preparation,
      quitApp: () => app.quit(),
    }),
  );
}

function createMainDesktopShutdownPreparation(): DesktopShutdownPreparation {
  return createDesktopShutdownPreparation({
    stopProjectRuns: stopCoreProjectRuns,
    closeAdapters: async () => {
      unsubscribeProjectRunEvents?.();
      await Promise.all(
        [...desktopRunnerAdapters.values()].map(
          async (adapter) => await adapter.close(),
        ),
      );
      desktopRunnerAdapters.clear();
    },
    stopRunner: async () => {
      await runnerTransport?.stop();
    },
    closeDatabase: async () => {
      await databaseController?.close();
    },
  });
}

function createMainDesktopUpdateCoordinator(
  preparation: DesktopShutdownPreparation,
): DesktopUpdateCoordinator {
  return new DesktopUpdateCoordinator({
    updater: createElectronUpdaterAdapter(autoUpdater),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    currentVersion: app.getVersion(),
    getBlockers: getDesktopUpdateBlockers,
    prepareForInstall: async () =>
      await prepareDesktopUpdateInstallation(preparation),
    publish(state) {
      if (mainWindow?.isDestroyed() === false) {
        mainWindow.webContents.send("desktop:update-state", state);
      }
    },
  });
}

async function reportDesktopStartupFailure(error: unknown): Promise<void> {
  const recovery = await requireDesktopStartupRecoveryCoordinator()
    .recoverStartupFailure()
    .catch(() => {});
  if (recovery?.status === "restarting") return;
  const recoveryDetails =
    recovery?.status === "blocked"
      ? recovery.blockers.map((blocker) => blocker.message).join("\n")
      : undefined;
  if (databaseController !== undefined) {
    databaseStatus = await databaseController
      .getStatus()
      .catch(() => databaseStatus);
  }
  updateBootState(
    {
      phase: "failed",
      message: "Desktop startup failed.",
      ...(readDesktopErrorCode(error) !== undefined
        ? { code: readDesktopErrorCode(error) }
        : {}),
      details:
        recoveryDetails ??
        (error instanceof Error ? error.message : String(error)),
      database: databaseStatus,
    },
    mainWindow?.webContents,
  );
  updateLaunchState({
    phase: "failed",
    message: "Kestrel could not finish starting.",
    ...(readDesktopErrorCode(error) !== undefined
      ? { code: readDesktopErrorCode(error) }
      : {}),
    details:
      recoveryDetails ??
      (error instanceof Error ? error.message : String(error)),
  });
}

function requireDesktopConfig(): ReturnType<typeof resolveDesktopPathConfig> {
  if (desktopConfig === undefined) {
    throw createDesktopError({
      code: "desktop.config_unavailable",
      message: "Desktop app configuration is unavailable.",
    });
  }
  return desktopConfig;
}

function requireDesktopUpdateCoordinator(): DesktopUpdateCoordinator {
  if (desktopUpdateCoordinator === undefined) {
    throw createDesktopError({
      code: "desktop.update_coordinator_unavailable",
      message: "Desktop updates are not initialized.",
    });
  }
  return desktopUpdateCoordinator;
}

function requireDesktopShutdownPreparation(): DesktopShutdownPreparation {
  if (desktopShutdownPreparation === undefined) {
    throw createDesktopError({
      code: "desktop.shutdown_preparation_unavailable",
      message: "Desktop shutdown preparation is not initialized.",
    });
  }
  return desktopShutdownPreparation;
}

function requireDesktopStartupRecoveryCoordinator(): DesktopStartupRecoveryCoordinator {
  if (desktopStartupRecoveryCoordinator === undefined) {
    throw createDesktopError({
      code: "desktop.startup_recovery_unavailable",
      message: "Desktop startup recovery is not initialized.",
    });
  }
  return desktopStartupRecoveryCoordinator;
}

if (shouldStartDesktopMain) {
  app.on("second-instance", () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });
  void main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error("Kestrel Desktop failed to start", { error });
    dialog.showErrorBox("Kestrel could not start", message);
    app.quit();
  });
}

async function ensureMainWindow(): Promise<BrowserWindow> {
  const config = requireDesktopConfig();
  if (mainWindow !== undefined && mainWindow.isDestroyed() === false) {
    return mainWindow;
  }
  const window = new BrowserWindow({
    icon: config.iconPath,
    width: 1440,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#101315",
    show: true,
    title: "Kestrel",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    if (event.url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  window.webContents.on(
    "will-attach-webview",
    (event, webPreferences, params) => {
      if (
        params.partition !== "persist:kestrel-preview" ||
        (params.src !== undefined &&
          params.src !== "about:blank" &&
          !isAllowedEmbeddedPreviewUrl(params.src))
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      delete webPreferences.preload;
    },
  );
  ensureMediaPermissionHandler(window);
  window.on("closed", () => {
    clearDesktopRendererBootstrapTimeout();
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (errorCode === -3 || isMainFrame === false || rendererFallbackActive) {
        return;
      }
      void showDesktopRendererFallback(window, rendererBootstrapGeneration);
    },
  );
  window.webContents.on("render-process-gone", () => {
    if (desktopAppQuitting || rendererFallbackActive) {
      return;
    }
    void showDesktopRendererFallback(window, rendererBootstrapGeneration);
  });
  mainWindow = window;
  await loadDesktopRenderer(window, config);
  return window;
}

async function loadDesktopRenderer(
  window: BrowserWindow,
  config: ReturnType<typeof resolveDesktopPathConfig>,
): Promise<void> {
  rendererBootstrapGeneration += 1;
  const generation = rendererBootstrapGeneration;
  rendererFallbackActive = false;
  clearDesktopRendererBootstrapTimeout();
  rendererBootstrapTimeout = setTimeout(() => {
    void showDesktopRendererFallback(window, generation);
  }, DESKTOP_RENDERER_BOOTSTRAP_TIMEOUT_MS);
  try {
    await window.loadFile(config.rendererHtmlPath, {
      query: { bootstrapGeneration: String(generation) },
    });
  } catch {
    await showDesktopRendererFallback(window, generation);
  }
}

async function showDesktopRendererFallback(
  window: BrowserWindow,
  generation: number,
): Promise<void> {
  if (
    desktopAppQuitting ||
    window.isDestroyed() ||
    window !== mainWindow ||
    generation !== rendererBootstrapGeneration ||
    rendererFallbackActive
  ) {
    return;
  }
  rendererFallbackActive = true;
  clearDesktopRendererBootstrapTimeout();
  await window.loadFile(requireDesktopConfig().bootHtmlPath);
}

function clearDesktopRendererBootstrapTimeout(): void {
  if (rendererBootstrapTimeout !== undefined) {
    clearTimeout(rendererBootstrapTimeout);
    rendererBootstrapTimeout = undefined;
  }
}

function configureEmbeddedPreviewSecurity(): void {
  if (embeddedPreviewSecurityConfigured) return;
  embeddedPreviewSecurityConfigured = true;
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    embeddedPreviewWebContentsIds.add(contents.id);
    contents.once("destroyed", () =>
      embeddedPreviewWebContentsIds.delete(contents.id),
    );
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedEmbeddedPreviewUrl(url)) event.preventDefault();
    });
    contents.on(
      "console-message",
      (_event, level, message, _line, sourceId) => {
        sendPreviewDiagnostic({
          webContentsId: contents.id,
          kind: "console",
          level,
          message,
          ...(sourceId ? { url: sourceId } : {}),
        });
      },
    );
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedUrl) => {
        if (errorCode === -3) return;
        sendPreviewDiagnostic({
          webContentsId: contents.id,
          kind: "load_error",
          message: `${errorDescription} (${errorCode})`,
          ...(validatedUrl ? { url: validatedUrl } : {}),
        });
      },
    );
  });
  const previewSession = session.fromPartition("persist:kestrel-preview");
  previewSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.webRequest.onErrorOccurred((details) => {
    if (
      details.webContentsId === undefined ||
      !embeddedPreviewWebContentsIds.has(details.webContentsId) ||
      details.error === "net::ERR_ABORTED"
    )
      return;
    sendPreviewDiagnostic({
      webContentsId: details.webContentsId,
      kind: "network_error",
      message: details.error,
      url: details.url,
    });
  });
}

function sendPreviewDiagnostic(input: {
  webContentsId: number;
  kind: "console" | "network_error" | "load_error";
  message: string;
  url?: string | undefined;
  level?: number | undefined;
}): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("desktop:preview-diagnostic", {
    ...input,
    message: redactDiagnosticValue(input.message),
    ...(input.url ? { url: redactDiagnosticValue(input.url) } : {}),
    at: new Date().toISOString(),
  });
}

async function bootDesktop(input: {
  runnerTransport: DesktopRunnerControlTransport;
}): Promise<void> {
  if (databaseController === undefined) {
    throw createDesktopError({
      code: "desktop.database_controller_unavailable",
      message: "Kestrel Local Core database controller is unavailable.",
    });
  }
  updateBootState(
    {
      phase: "starting_database",
      message: "Checking Kestrel Local Core database…",
      database: databaseStatus,
    },
    mainWindow?.webContents,
  );
  updateBootState(
    {
      phase: "starting_runtime",
      message: "Starting Kestrel runtime…",
      database: databaseStatus,
    },
    mainWindow?.webContents,
  );
  await ensureDesktopRunnerResponsive(input.runnerTransport);

  const window = await ensureMainWindow();
  updateBootState(
    {
      phase: "starting_web",
      message: "Opening desktop renderer…",
      database: databaseStatus,
    },
    window.webContents,
  );
  updateBootState(
    {
      phase: "ready",
      message: "Desktop ready.",
      database: databaseStatus,
    },
    window.webContents,
  );
}

function installApplicationMenu(): void {
  const desktopReady = launchState.phase === "ready";
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          visible: desktopReady,
          click: () => {
            if (launchState.phase === "ready") {
              void sendDesktopCommand("settings");
            }
          },
        },
        { type: "separator" },
        {
          label: "Stop Agent",
          accelerator: "CmdOrCtrl+.",
          click: () => {
            void sendDesktopCommand("stop-agent");
          },
        },
        {
          label: "Restart Kestrel",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => {
            void sendDesktopCommand("restart-runtime");
          },
        },
        {
          label: "Check for Updates…",
          click: () => {
            void showDesktopUpdateDialog();
          },
        },
        {
          label: "Uninstall Kestrel...",
          click: () => {
            void sendDesktopCommand("uninstall");
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      visible: desktopReady,
      submenu: [
        {
          label: "Add Project",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            void sendDesktopCommand("add-project");
          },
        },
        {
          label: "New Thread",
          accelerator: "CmdOrCtrl+T",
          click: () => {
            void sendDesktopCommand("new-thread");
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      visible: desktopReady,
      submenu: [
        {
          label: "Toggle Left Sidebar",
          accelerator: "CmdOrCtrl+\\",
          click: () => {
            void sendDesktopCommand("toggle-left-sidebar");
          },
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function sendDesktopCommand(command: DesktopShellCommand): Promise<void> {
  mainWindow?.webContents.send("desktop:command", command);
}

async function showDesktopUpdateDialog(): Promise<void> {
  const coordinator = requireDesktopUpdateCoordinator();
  let state = await coordinator.checkForUpdates();
  while (true) {
    const updateDialog = buildDesktopUpdateDialog(state);
    const options = {
      type: state.phase === "error" ? ("error" as const) : ("info" as const),
      ...updateDialog,
    };
    const result =
      mainWindow !== undefined && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
    const action = resolveDesktopUpdateDialogAction(state, result.response);
    if (action === "download") {
      state = await coordinator.downloadUpdate();
      continue;
    }
    if (action === "install") {
      state = await coordinator.installUpdate();
      if (state.phase === "installing") {
        return;
      }
      continue;
    }
    return;
  }
}

function requireCurrentMainWindowIpcSender(
  event: IpcMainInvokeEvent,
): BrowserWindow {
  const window = mainWindow;
  if (
    window === undefined ||
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw createDesktopError({
      code: "desktop.invalid_renderer_sender",
      message: "This operation is accepted only from Kestrel's main window.",
    });
  }
  return window;
}

function registerBootIpcHandlers(): void {
  ipcMain.handle("desktop:get-bridge-info", () => ({
    connected: true,
    version: DESKTOP_BRIDGE_VERSION,
    capabilities: DESKTOP_BRIDGE_CAPABILITIES,
  }));
  ipcMain.handle("desktop:get-app-info", () => ({
    name: app.getName(),
    version: app.getVersion(),
    isPackaged: app.isPackaged,
  }));
  ipcMain.handle(
    "desktop:report-renderer-bootstrap",
    async (event, input: unknown) => {
      const report = parseDesktopRendererBootstrapReport(input);
      const window = requireCurrentMainWindowIpcSender(event);
      if (
        report.generation !== rendererBootstrapGeneration ||
        rendererFallbackActive
      ) {
        return false;
      }
      if (report.status === "failed") {
        await showDesktopRendererFallback(window, report.generation);
        return false;
      }
      clearDesktopRendererBootstrapTimeout();
      return true;
    },
  );
  ipcMain.handle("desktop:get-launch-state", (event) => {
    requireCurrentMainWindowIpcSender(event);
    return launchState;
  });
  ipcMain.handle("desktop:get-onboarding-state", async (event) => {
    requireCurrentMainWindowIpcSender(event);
    return await readDesktopOnboardingState();
  });
  ipcMain.handle(
    "desktop:save-onboarding-draft",
    async (event, input: unknown) => {
      requireCurrentMainWindowIpcSender(event);
      return await saveDesktopOnboardingDraft(
        parseDesktopOnboardingDraftInput(input),
      );
    },
  );
  ipcMain.handle(
    "desktop:verify-onboarding-provider",
    async (event, input: unknown) => {
      requireCurrentMainWindowIpcSender(event);
      return await applyDesktopOnboardingProvider(
        parseDesktopOnboardingProviderInput(input),
      );
    },
  );
  ipcMain.handle("desktop:pick-onboarding-project", async (event) => {
    requireCurrentMainWindowIpcSender(event);
    const approvedSmokePath = readApprovedPackageSmokeProjectPath();
    const selectedPath =
      approvedSmokePath ??
      (await dialog
        .showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
          title: "Choose a Kestrel project",
          buttonLabel: "Choose Project",
        })
        .then((result) => (result.canceled ? undefined : result.filePaths[0])));
    return selectedPath === undefined
      ? undefined
      : await createDesktopOnboardingProjectCandidate(selectedPath, {
          source: "picker",
        });
  });
  ipcMain.handle(
    "desktop:inspect-onboarding-project",
    async (event, projectPath: unknown) => {
      requireCurrentMainWindowIpcSender(event);
      if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
        throw createDesktopError({
          code: "desktop.invalid_onboarding_project",
          message: "Choose a valid project folder.",
        });
      }
      const registered = findExactRegisteredOnboardingProject(
        desktopSettings.projects,
        projectPath,
      );
      if (registered === undefined) {
        throw createDesktopError({
          code: "desktop.onboarding_project_not_registered",
          message: "Choose this folder with the native picker first.",
        });
      }
      return await createDesktopOnboardingProjectCandidate(registered.path, {
        source: "registered",
        registeredPath: registered.path,
      });
    },
  );
  ipcMain.handle(
    "desktop:confirm-onboarding-project",
    async (event, input: unknown) => {
      requireCurrentMainWindowIpcSender(event);
      return await confirmDesktopOnboardingProject(
        parseDesktopOnboardingProjectConfirmation(input),
      );
    },
  );
  ipcMain.handle("desktop:complete-onboarding", async (event) => {
    requireCurrentMainWindowIpcSender(event);
    return await completeDesktopOnboarding();
  });
  ipcMain.handle("desktop:get-model-catalog", async (event, input: unknown) => {
    requireCurrentMainWindowIpcSender(event);
    const request = parseDesktopProviderModelCatalogRequest(input);
    return await resolveProviderModelCatalog(
      request.provider,
      {
        ...process.env,
        ...(desktopSettings.openrouterBaseUrl !== undefined
          ? { OPENROUTER_BASE_URL: desktopSettings.openrouterBaseUrl }
          : {}),
        ...(desktopSettings.openaiBaseUrl !== undefined
          ? { OPENAI_BASE_URL: desktopSettings.openaiBaseUrl }
          : {}),
        ...(desktopSettings.anthropicBaseUrl !== undefined
          ? { ANTHROPIC_BASE_URL: desktopSettings.anthropicBaseUrl }
          : {}),
        ...(request.provider === "ollama" && request.baseUrl !== undefined
          ? { OLLAMA_BASE_URL: request.baseUrl }
          : desktopSettings.ollamaBaseUrl !== undefined
            ? { OLLAMA_BASE_URL: desktopSettings.ollamaBaseUrl }
            : {}),
        ...(request.provider === "lmstudio" && request.baseUrl !== undefined
          ? { LMSTUDIO_BASE_URL: request.baseUrl }
          : desktopSettings.lmstudioBaseUrl !== undefined
            ? { LMSTUDIO_BASE_URL: desktopSettings.lmstudioBaseUrl }
            : {}),
      },
      fetch,
      {
        requireLiveLocalCatalog: true,
        preserveProviderOrder: true,
      },
    );
  });
  ipcMain.handle("desktop:open-external", async (_event, url: unknown) => {
    requireCurrentMainWindowIpcSender(_event);
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = typeof url === "string" ? new URL(url) : undefined;
    } catch {
      parsedUrl = undefined;
    }
    if (
      parsedUrl === undefined ||
      (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      parsedUrl.username.length > 0 ||
      parsedUrl.password.length > 0
    ) {
      throw createDesktopError({
        code: "desktop.invalid_external_url",
        message: "desktop.openExternal requires a credential-free http(s) URL.",
      });
    }
    await shell.openExternal(url as string);
  });
  ipcMain.handle("desktop:get-link-previews", async (event, input: unknown) => {
    requireCurrentMainWindowIpcSender(event);
    let request;
    try {
      request = parseDesktopLinkPreviewInput(input);
    } catch (cause) {
      throw createDesktopError({
        code: "desktop.invalid_link_preview_input",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return await linkPreviewService.getPreviews(request);
  });
  ipcMain.handle("desktop:get-boot-state", () => bootState);
  ipcMain.handle(
    "desktop:get-support-bundle",
    async () => await buildCurrentDesktopSupportBundle(),
  );
  ipcMain.handle(
    "desktop:create-uninstall-plan",
    async (_event, input: unknown) => {
      assertDesktopAdmissionOpen("uninstall planning");
      const record = isRecord(input) ? input : {};
      return await createKestrelUninstallPlan({
        initiator: "desktop",
        scope: parseKestrelUninstallScope(record.scope),
        options: parseDesktopUninstallPlanOptions(record.options),
      });
    },
  );
  ipcMain.handle(
    "desktop:apply-uninstall-plan",
    async (_event, input: unknown) => {
      assertDesktopAdmissionOpen("uninstall");
      return await applyDesktopUninstallPlan(
        parseDesktopUninstallApplyInput(input),
      );
    },
  );
  ipcMain.handle(
    "desktop:get-pending-uninstall-result",
    async () => await readPendingDesktopUninstallResult(),
  );
  ipcMain.handle("desktop:restart-app", async () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle("desktop:restart-kestrel", async (_event, value: unknown) => {
    const request = parseDesktopRestartKestrelInput(value);
    updateBootState(
      {
        phase: "starting_runtime",
        message: request.force
          ? "Force restarting Kestrel…"
          : "Restarting Kestrel…",
      },
      mainWindow?.webContents,
    );
    const result =
      await requireDesktopStartupRecoveryCoordinator().restart(request);
    if (result.status === "blocked") {
      updateBootState(
        {
          phase: "failed",
          message: "Kestrel restart needs confirmation.",
          details: result.blockers.map((blocker) => blocker.message).join("\n"),
        },
        mainWindow?.webContents,
      );
    }
    return result;
  });
  ipcMain.handle("desktop:get-update-state", () =>
    requireDesktopUpdateCoordinator().state(),
  );
  ipcMain.handle(
    "desktop:check-for-updates",
    async () => await requireDesktopUpdateCoordinator().checkForUpdates(),
  );
  ipcMain.handle(
    "desktop:download-update",
    async () => await requireDesktopUpdateCoordinator().downloadUpdate(),
  );
  ipcMain.handle(
    "desktop:install-update",
    async () => await requireDesktopUpdateCoordinator().installUpdate(),
  );
  ipcMain.handle("desktop:open-diagnostics", async () => {
    const runtimeLogPath =
      runnerTransport?.getStatus().logPath ?? desktopConfig?.runtimeLogPath;
    if (runtimeLogPath !== undefined) {
      shell.showItemInFolder(runtimeLogPath);
    }
  });
}

async function buildCurrentDesktopSupportBundle() {
  const manager = localCoreConnectionManager;
  const coreSupportBundle =
    manager === undefined
      ? undefined
      : await manager
          .executeIdempotent(async (client) => await client.supportBundle())
          .catch((error) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }));
  const projectRuns =
    manager === undefined
      ? []
      : await manager
          .executeIdempotent(
            async (client) => await client.listDesktopProjectRuns(),
          )
          .catch(() => []);
  const runtimeStatus = runnerTransport?.getStatus();
  return buildDesktopSupportBundle({
    generatedAt: new Date().toISOString(),
    appInfo: {
      name: app.getName(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    },
    bootState,
    launchState,
    runtimeHealth,
    databaseStatus,
    settings: desktopSettings,
    projectRuns,
    ...(runtimeStatus !== undefined ? { runtimeStatus } : {}),
    paths: {
      runtimeLogPath: runtimeStatus?.logPath ?? desktopConfig?.runtimeLogPath,
    },
    ...(localCoreStatus !== undefined ? { localCoreStatus } : {}),
    ...(coreSupportBundle !== undefined ? { coreSupportBundle } : {}),
  });
}

function registerIpcHandlers(
  runnerTransport: DesktopRunnerControlTransport,
): void {
  browserPersonalDomainService ??= new DesktopBrowserPersonalDomainService({
    resolveAccount: async () =>
      await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.kestrelOneAccount(),
      ),
    readSettings: () => desktopSettings,
    persistSettings: async (settings) => {
      await saveDesktopCoreSettings({
        ...desktopSettings,
        browserPersonalDomains: settings.browserPersonalDomains,
      });
    },
    adoptionCoordinator:
      noActiveDesktopBrowserSessionsPersonalRevisionAdoptionCoordinator,
  });
  ipcMain.handle(
    "desktop:get-settings",
    async () => await readDesktopRendererSettings(),
  );
  ipcMain.handle(
    "desktop:get-kestrel-one-account",
    async () =>
      await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.kestrelOneAccount(),
      ),
  );
  ipcMain.handle(
    "desktop:list-browser-personal-domains",
    async (_event, input: unknown) => {
      const request = parseDesktopBrowserPersonalDomainListRequest(input);
      return await requireBrowserPersonalDomainService().list(
        request.environmentId,
      );
    },
  );
  ipcMain.handle(
    "desktop:revoke-browser-personal-domain",
    async (_event, input: unknown) => {
      const request = parseDesktopBrowserPersonalDomainRevokeRequest(input);
      return await requireBrowserPersonalDomainService().revoke(request);
    },
  );
  ipcMain.handle(
    "desktop:start-kestrel-one-authorization",
    async (_event, input: unknown) => {
      const baseUrl = parseDesktopKestrelOneAuthorization(input);
      const session = await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.startKestrelOneAuthorization({ baseUrl }),
      );
      if (session.authorizationUrl) {
        await shell.openExternal(session.authorizationUrl);
      }
      return session;
    },
  );
  ipcMain.handle(
    "desktop:get-kestrel-one-authorization-status",
    async (_event, sessionId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("Kestrel One authorization session ID is required.");
      }
      return await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.kestrelOneAuthorizationStatus(sessionId),
      );
    },
  );
  ipcMain.handle(
    "desktop:sign-out-kestrel-one-account",
    async () =>
      await requireBrowserPersonalDomainService().signOut(
        async () =>
          await requireLocalCoreConnectionManager().executeOnce(
            async (client) => await client.signOutKestrelOneAccount(),
          ),
      ),
  );
  ipcMain.handle(
    "desktop:get-kestrel-one-receiving-connection",
    async (_event, organizationId: unknown) => {
      if (typeof organizationId !== "string" || !organizationId.trim()) {
        throw new Error("Kestrel One Organization ID is required.");
      }
      try {
        return {
          status: "ok",
          connection:
            await requireLocalCoreConnectionManager().executeIdempotent(
              async (client) =>
                await client.kestrelOneReceivingConnection(
                  organizationId.trim(),
                ),
            ),
        };
      } catch (error) {
        if (
          error instanceof LocalCoreApiError &&
          (error.statusCode === 401 || error.statusCode === 403) &&
          error.code === "KESTREL_ONE_RECEIVING_AUTHORIZATION_REJECTED"
        ) {
          return {
            status: "authorization_rejected",
            httpStatus: error.statusCode,
          };
        }
        throw error;
      }
    },
  );
  ipcMain.handle(
    "desktop:inspect-kestrel-one-receiving-domains",
    async (_event, input: unknown) => {
      const parsed = parseDesktopReceivingInput(input, false);
      return await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) =>
          await client.inspectKestrelOneReceivingDomains(parsed),
      );
    },
  );
  ipcMain.handle(
    "desktop:save-kestrel-one-receiving-connection",
    async (_event, input: unknown) => {
      const parsed = parseDesktopReceivingInput(input, true);
      return await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.saveKestrelOneReceivingConnection(parsed),
      );
    },
  );
  ipcMain.handle(
    "desktop:get-kestrel-one-thread",
    async (_event, threadId: unknown) => {
      if (typeof threadId !== "string" || !threadId.trim()) {
        throw new Error("Kestrel One Thread ID is required.");
      }
      return await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.kestrelOneThread(threadId.trim()),
      );
    },
  );
  ipcMain.handle(
    "desktop:submit-kestrel-one-turn",
    async (_event, input: unknown) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Kestrel One turn submission must be an object.");
      }
      const record = input as Record<string, unknown>;
      const interactionMode = record.interactionMode;
      if (
        typeof record.threadId !== "string" ||
        !record.threadId.trim() ||
        typeof record.text !== "string" ||
        !record.text.trim() ||
        (interactionMode !== "chat" &&
          interactionMode !== "plan" &&
          interactionMode !== "build")
      ) {
        throw new Error("Kestrel One turn submission is invalid.");
      }
      const threadId = record.threadId.trim();
      const text = record.text.trim();
      return await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.submitKestrelOneTurn({
            threadId,
            text,
            interactionMode,
            ...(typeof record.model === "string" && record.model.trim()
              ? { model: record.model.trim() }
              : {}),
          }),
      );
    },
  );
  ipcMain.handle(
    "desktop:publish-kestrel-one-preview",
    async (_event, input: unknown) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Kestrel One preview publication must be an object.");
      }
      const record = input as Record<string, unknown>;
      for (const field of [
        "projectId",
        "connectionId",
        "localRunRef",
        "localUrl",
      ] as const) {
        if (typeof record[field] !== "string" || !record[field].trim()) {
          throw new Error(`Kestrel One preview ${field} is required.`);
        }
      }
      const projectId = (record.projectId as string).trim();
      const connectionId = (record.connectionId as string).trim();
      const localRunRef = (record.localRunRef as string).trim();
      const localUrl = (record.localUrl as string).trim();
      return await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.publishKestrelOnePreview({
            projectId,
            connectionId,
            localRunRef,
            localUrl,
            ...(typeof record.name === "string" && record.name.trim()
              ? { name: record.name.trim() }
              : {}),
          }),
      );
    },
  );
  ipcMain.handle(
    "desktop:renew-kestrel-one-preview",
    async (_event, previewId: unknown) => {
      if (typeof previewId !== "string" || !previewId.trim()) {
        throw new Error("Kestrel One preview ID is required.");
      }
      return await requireLocalCoreConnectionManager().executeOnce(
        async (client) => await client.renewKestrelOnePreview(previewId.trim()),
      );
    },
  );
  ipcMain.handle(
    "desktop:unpublish-kestrel-one-preview",
    async (_event, previewId: unknown) => {
      if (typeof previewId !== "string" || !previewId.trim()) {
        throw new Error("Kestrel One preview ID is required.");
      }
      await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.unpublishKestrelOnePreview(previewId.trim()),
      );
    },
  );
  ipcMain.handle(
    "desktop:get-kestrel-one-environments",
    async () =>
      await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.kestrelOneEnvironments(),
      ),
  );
  ipcMain.handle(
    "desktop:start-kestrel-one-enrollment",
    async (_event, input: unknown) => {
      const enrollment = parseDesktopKestrelOneEnrollment(input);
      return await requireLocalCoreConnectionManager().executeOnce(
        async (client) => await client.startKestrelOneEnrollment(enrollment),
      );
    },
  );
  ipcMain.handle(
    "desktop:refresh-kestrel-one-enrollments",
    async () =>
      await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.refreshKestrelOneEnrollments(),
      ),
  );
  ipcMain.handle(
    "desktop:refresh-model-readiness",
    async () =>
      await requireLocalCoreConnectionManager().executeOnce(
        async (client) => await client.refreshDesktopModelReadiness(),
      ),
  );
  ipcMain.handle(
    "desktop:set-kestrel-one-capacity",
    async (_event, capacity: unknown) => {
      if (
        typeof capacity !== "number" ||
        !Number.isInteger(capacity) ||
        capacity < 1 ||
        capacity > 16
      ) {
        throw new Error("Desktop remote-task capacity must be from 1 to 16.");
      }
      return await requireLocalCoreConnectionManager().executeOnce(
        async (client) => await client.setKestrelOneCapacity(capacity),
      );
    },
  );
  ipcMain.handle(
    "desktop:disconnect-kestrel-one-environment",
    async (_event, connectionId: unknown) => {
      if (typeof connectionId !== "string" || !connectionId.trim()) {
        throw new Error("Desktop Environment connection ID is required.");
      }
      return await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.disconnectKestrelOneEnvironment(connectionId),
      );
    },
  );
  ipcMain.handle(
    "desktop:get-capabilities",
    async () => await readDesktopCapabilityView(),
  );
  ipcMain.handle(
    "desktop:configure-capability",
    async (
      _event,
      input: unknown,
    ): Promise<DesktopCapabilityConfigurationResult> => {
      let configuration;
      let credentialAppliedDuringVerification = false;
      try {
        configuration = parseDesktopCapabilityConfigurationInput(input);
      } catch (error) {
        throw createDesktopError({
          code: "desktop.invalid_capability_configuration",
          message: "Desktop capability configuration is invalid.",
          details: error instanceof Error ? error.message : String(error),
        });
      }
      if (configuration.capabilityId.startsWith("model.")) {
        const { runtimeRestarted } =
          await applyDesktopModelCapabilityConfiguration(configuration, {
            runnerTransport,
            deferExecution: false,
            mapVerificationError(error): never {
              throw createDesktopError({
                code: "desktop.capability_verification_failed",
                message:
                  "Desktop could not verify this capability configuration.",
                details: error instanceof Error ? error.message : String(error),
              });
            },
          });
        return {
          capabilityId: configuration.capabilityId,
          applied: true,
          runtimeRestarted,
          view: await readDesktopCapabilityView(),
        };
      }
      const previousSettings = structuredClone(desktopSettings);
      const previousModelPolicy = structuredClone(desktopModelPolicy);
      let plan: ReturnType<typeof buildDesktopCapabilityConfigurationPlan>;
      try {
        plan = buildDesktopCapabilityConfigurationPlan({
          currentSettings: desktopSettings,
          currentModelPolicy: desktopModelPolicy,
          configuration,
        });
        if (
          plan.requiresVerification &&
          (configuration.capabilityId === "tools.internet.tavily" ||
            configuration.capabilityId === "tools.weather")
        ) {
          if (typeof plan.credential?.value !== "string") {
            throw new Error(
              "A credential is required to verify this provider configuration.",
            );
          }
          await verifyDesktopToolProvider({
            capabilityId: configuration.capabilityId,
            credential: plan.credential.value,
            settings: plan.settings,
          });
        } else if (
          plan.requiresVerification &&
          configuration.capabilityId === "data.database" &&
          plan.settings.databaseMode === "external"
        ) {
          if (typeof plan.credential?.value !== "string") {
            throw new Error(
              "Enter the PostgreSQL connection URL to verify external storage.",
            );
          }
          await requireLocalCoreConnectionManager().executeOnce(
            async (client) =>
              await client.verifyExternalDatabase(
                plan.credential!.value as string,
              ),
          );
          credentialAppliedDuringVerification = true;
        }
      } catch (error) {
        throw createDesktopError({
          code: "desktop.capability_verification_failed",
          message: "Desktop could not verify this capability configuration.",
          details: error instanceof Error ? error.message : String(error),
        });
      }

      const capabilityVerifications = {
        ...plan.settings.capabilityVerifications,
      };
      if (plan.credential?.value === null) {
        delete capabilityVerifications[configuration.capabilityId];
      } else if (plan.requiresVerification) {
        capabilityVerifications[configuration.capabilityId] =
          new Date().toISOString();
      }
      const appliedSettings = {
        ...plan.settings,
        capabilityVerifications,
        ...(plan.registration.modelProvider !== undefined &&
        configuration.enabled === true
          ? {
              providerSelectionCompletedAt:
                plan.settings.providerSelectionCompletedAt ??
                new Date().toISOString(),
            }
          : {}),
        modelPolicy: plan.modelPolicy,
      };
      await saveDesktopCoreSettings(appliedSettings);
      try {
        if (plan.credential?.value === null) {
          await requireLocalCoreConnectionManager().executeOnce(
            async (client) =>
              await client.deleteCredential(plan.credential!.id),
          );
        } else if (
          typeof plan.credential?.value === "string" &&
          credentialAppliedDuringVerification === false
        ) {
          await requireLocalCoreConnectionManager().executeOnce(
            async (client) =>
              await client.setCredential(
                plan.credential!.id,
                plan.credential!.value as string,
              ),
          );
        }
      } catch (error) {
        await saveDesktopCoreSettings({
          ...previousSettings,
          modelPolicy: previousModelPolicy,
        });
        throw createDesktopError({
          code: "desktop.capability_credential_apply_failed",
          message:
            "Desktop could not apply the verified credential. The previous configuration was preserved.",
          details: error instanceof Error ? error.message : String(error),
        });
      }
      syncDesktopWebEnvironment(desktopSettings);
      applyDesktopProfileOverride(desktopSettings);
      await resetDesktopRunnerAdapter();
      let runtimeRestarted = false;
      if (plan.restartRuntime) {
        updateBootState(
          {
            phase: "starting_runtime",
            message: `Applying ${configuration.capabilityId} configuration…`,
            database: databaseStatus,
          },
          mainWindow?.webContents,
        );
        await runnerTransport.restart();
        runtimeRestarted = true;
        if (configuration.capabilityId === "data.database") {
          await reconfigureDatabaseController(desktopSettings);
        }
        updateBootState(
          {
            phase: "ready",
            message: "Desktop ready.",
            database: databaseStatus,
          },
          mainWindow?.webContents,
        );
      }
      runtimeHealth = deriveRuntimeHealth(bootState);
      mainWindow?.webContents.send("desktop:runtime-health", runtimeHealth);
      return {
        capabilityId: configuration.capabilityId,
        applied: true,
        runtimeRestarted,
        view: await readDesktopCapabilityView(),
      };
    },
  );
  ipcMain.handle(
    "desktop:get-ui-state",
    async () =>
      await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.getDesktopUiState(),
      ),
  );
  ipcMain.handle(
    "desktop:sync-legacy-ui-state",
    async (_event, input: unknown) => {
      let entries: DesktopLegacyUiStateEntries;
      try {
        entries = parseDesktopLegacyUiStateEntries(input);
      } catch (error) {
        throw createDesktopError({
          code: "desktop.invalid_ui_state",
          message: "Desktop UI state migration payload is invalid.",
          details: error instanceof Error ? error.message : String(error),
        });
      }
      const state: DesktopUiStateV1 = {
        version: DESKTOP_UI_STATE_VERSION,
        source: DESKTOP_UI_STATE_SOURCE,
        sourceAppVersion: app.getVersion(),
        capturedAt: new Date().toISOString(),
        entries,
      };
      return await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.syncDesktopUiState(state),
      );
    },
  );
  ipcMain.handle("desktop:save-ui-state", async (_event, input: unknown) => {
    let entries: DesktopLegacyUiStateEntries;
    try {
      entries = parseDesktopLegacyUiStateEntries(input);
    } catch (error) {
      throw createDesktopError({
        code: "desktop.invalid_ui_state",
        message: "Desktop UI state payload is invalid.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    const state: DesktopUiStateV1 = {
      version: DESKTOP_UI_STATE_VERSION,
      source: DESKTOP_UI_STATE_RENDERER_SOURCE,
      sourceAppVersion: app.getVersion(),
      capturedAt: new Date().toISOString(),
      entries,
    };
    const result = await requireLocalCoreConnectionManager().executeIdempotent(
      async (client) => await client.syncDesktopUiState(state),
    );
    await acknowledgePersistedDesktopOnboardingHandoff(result.state.entries);
    return result;
  });
  ipcMain.handle(
    "desktop:conversation-message-submit",
    async (
      _event,
      input: unknown,
    ): Promise<DesktopConversationMessageResult> => {
      let request: DesktopConversationMessageRequest;
      try {
        request = parseDesktopConversationMessageRequest(input);
      } catch (error) {
        throw createDesktopError({
          code: "desktop.invalid_conversation_message",
          message: "Desktop conversation message request is invalid.",
          details: error instanceof Error ? error.message : String(error),
        });
      }
      const {
        projectPath,
        workspaceMode,
        workspaceBaseRef,
        workspaceSetup,
        threadId,
        messageId,
        attachmentIds,
        executionSelection,
        ...turnRequest
      } = request;
      const canonicalThreadId = `thread-main:${request.sessionId}`;
      if (threadId !== canonicalThreadId) {
        throw createDesktopError({
          code: "desktop.invalid_run_thread",
          message:
            "Desktop conversation thread does not match its Local Core session.",
        });
      }
      const globalExecutionSelection =
        resolveAuthoritativeDesktopExecutionSelection(
          executionSelection,
          projectPath,
        );
      const executionProfile =
        await requireLocalCoreConnectionManager().executeIdempotent(
          async (client) =>
            await client.resolveExecutionProfile({
              client: "desktop",
              selection: globalExecutionSelection,
            }),
        );
      const runProfile = executionProfile.resolvedProfile;
      if (attachmentIds !== undefined) {
        const listed =
          await requireLocalCoreConnectionManager().executeIdempotent(
            async (client) =>
              await client.listDesktopAttachments(canonicalThreadId),
          );
        const selected = attachmentIds.map((attachmentId) =>
          listed.find((entry) => entry.attachmentId === attachmentId),
        );
        if (selected.some((entry) => entry === undefined)) {
          throw createDesktopError({
            code: "desktop.attachment_unavailable",
            message: "One or more attachments are unavailable for this thread.",
          });
        }
        if (
          selected.some((entry) => entry?.kind === "image") &&
          runProfile.modelCapabilities?.visionInputEnabled !== true
        ) {
          throw createDesktopError({
            code: "desktop.model_vision_unavailable",
            message: "The selected model does not accept image attachments.",
          });
        }
      }
      const attachments =
        attachmentIds === undefined
          ? undefined
          : await requireLocalCoreConnectionManager().executeIdempotent(
              async (client) =>
                await client.resolveDesktopAttachments(
                  canonicalThreadId,
                  attachmentIds,
                ),
            );
      const workspace = resolveDesktopThreadWorkspace({
        ...(projectPath !== undefined ? { projectPath } : {}),
        projects: desktopSettings.projects,
        defaultKestrelRoot: requireLocalCoreStatus().home.productRootPath,
        ...(workspaceMode !== undefined ? { workspaceMode } : {}),
        ...(workspaceBaseRef !== undefined ? { workspaceBaseRef } : {}),
        ...(workspaceSetup !== undefined ? { workspaceSetup } : {}),
      });
      assertDesktopAdmissionOpen("a conversation message");
      const event = await requireDesktopRunnerAdapter(
        runnerTransport,
        executionProfile.profileId,
        runProfile,
      ).submitConversationMessage(
        {
          threadId,
          messageId,
          turn: {
            ...turnRequest,
            ...(attachments !== undefined ? { attachments } : {}),
            workspace,
            metadata: { desktopExecutionSelection: globalExecutionSelection },
          },
        },
        DESKTOP_RUNNER_REQUEST_CONTEXT,
      );
      if (attachmentIds !== undefined && attachmentIds.length > 0) {
        await requireLocalCoreConnectionManager().executeIdempotent(
          async (client) =>
            await client.markDesktopAttachmentsSubmitted(
              canonicalThreadId,
              attachmentIds,
              messageId,
            ),
        );
      }
      return {
        ...event.payload,
        view: parseDesktopRuntimeThreadInspection(event.payload.view),
      };
    },
  );

  ipcMain.handle("desktop:run-turn", async (_event, input: unknown) => {
    let request: DesktopRunTurnRequest;
    try {
      request = parseDesktopRunTurnRequest(input);
    } catch (error) {
      throw createDesktopError({
        code: "desktop.invalid_run_request",
        message: "Desktop run request is invalid.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    const {
      projectPath,
      workspaceMode,
      workspaceBaseRef,
      workspaceSetup,
      threadId,
      attachmentIds,
      executionSelection,
      ...turnRequest
    } = request;
    const globalExecutionSelection =
      resolveAuthoritativeDesktopExecutionSelection(
        executionSelection,
        projectPath,
      );
    const executionProfile =
      await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) =>
          await client.resolveExecutionProfile({
            client: "desktop",
            selection: globalExecutionSelection,
          }),
      );
    const runProfile = executionProfile.resolvedProfile;
    const canonicalThreadId = `thread-main:${request.sessionId}`;
    if (threadId !== undefined && threadId !== canonicalThreadId) {
      throw createDesktopError({
        code: "desktop.invalid_run_thread",
        message: "Desktop run thread does not match its Local Core session.",
      });
    }
    if (attachmentIds !== undefined) {
      const listed =
        await requireLocalCoreConnectionManager().executeIdempotent(
          async (client) =>
            await client.listDesktopAttachments(canonicalThreadId),
        );
      const selected = attachmentIds.map((attachmentId) =>
        listed.find((entry) => entry.attachmentId === attachmentId),
      );
      if (selected.some((entry) => entry === undefined)) {
        throw createDesktopError({
          code: "desktop.attachment_unavailable",
          message: "One or more attachments are unavailable for this thread.",
        });
      }
      if (
        selected.some((entry) => entry?.kind === "image") &&
        runProfile.modelCapabilities?.visionInputEnabled !== true
      ) {
        throw createDesktopError({
          code: "desktop.model_vision_unavailable",
          message: "The selected model does not accept image attachments.",
        });
      }
    }
    const attachments =
      attachmentIds === undefined
        ? undefined
        : await requireLocalCoreConnectionManager().executeIdempotent(
            async (client) =>
              await client.resolveDesktopAttachments(
                canonicalThreadId,
                attachmentIds,
              ),
          );
    const workspace = resolveDesktopThreadWorkspace({
      ...(projectPath !== undefined ? { projectPath } : {}),
      projects: desktopSettings.projects,
      defaultKestrelRoot: requireLocalCoreStatus().home.productRootPath,
      ...(workspaceMode !== undefined ? { workspaceMode } : {}),
      ...(workspaceBaseRef !== undefined ? { workspaceBaseRef } : {}),
      ...(workspaceSetup !== undefined ? { workspaceSetup } : {}),
    });
    const skillWorkspaceRoot =
      projectPath === undefined
        ? undefined
        : path.resolve(
            workspace.sourceWorkspaceRoot ?? workspace.workspaceRoot,
          );
    assertDesktopAdmissionOpen("a workspace execution");
    if (skillWorkspaceRoot !== undefined) {
      await activateDesktopWorkspaceSkills(skillWorkspaceRoot);
      activeDesktopWorkspaceRunCounts.set(
        skillWorkspaceRoot,
        (activeDesktopWorkspaceRunCounts.get(skillWorkspaceRoot) ?? 0) + 1,
      );
    }
    try {
      return await requireDesktopRunnerAdapter(
        runnerTransport,
        executionProfile.profileId,
        runProfile,
      ).runTurnStream(
        {
          ...turnRequest,
          ...(attachments !== undefined ? { attachments } : {}),
          workspace,
          metadata: { desktopExecutionSelection: globalExecutionSelection },
        },
        {
          onEvent() {},
        },
        DESKTOP_RUNNER_REQUEST_CONTEXT,
      );
    } finally {
      if (skillWorkspaceRoot !== undefined) {
        const remaining =
          (activeDesktopWorkspaceRunCounts.get(skillWorkspaceRoot) ?? 1) - 1;
        if (remaining > 0)
          activeDesktopWorkspaceRunCounts.set(skillWorkspaceRoot, remaining);
        else activeDesktopWorkspaceRunCounts.delete(skillWorkspaceRoot);
      }
    }
  });
  ipcMain.handle(
    "desktop:select-attachments",
    async (_event, threadId: unknown): Promise<DesktopAttachmentMetadata[]> => {
      const normalizedThreadId = parseDesktopAttachmentThreadId(threadId);
      const dialogOptions: Electron.OpenDialogOptions = {
        title: "Attach files",
        properties: ["openFile", "multiSelections"],
      };
      const selection =
        mainWindow === undefined
          ? await dialog.showOpenDialog(dialogOptions)
          : await dialog.showOpenDialog(mainWindow, dialogOptions);
      if (selection.canceled) return [];
      const existingDrafts = (
        await requireLocalCoreConnectionManager().executeIdempotent(
          async (client) =>
            await client.listDesktopAttachments(normalizedThreadId),
        )
      ).filter((attachment) => attachment.submittedAt === undefined);
      if (existingDrafts.length + selection.filePaths.length > 20)
        throw createDesktopError({
          code: "desktop.too_many_attachments",
          message: "Select no more than 20 attachments at once.",
        });
      const selectedStats = await Promise.all(
        selection.filePaths.map(async (filePath) => await stat(filePath)),
      );
      if (
        selectedStats.some(
          (entry) => !entry.isFile() || entry.size > 100 * 1024 * 1024,
        )
      ) {
        throw createDesktopError({
          code: "desktop.attachment_too_large",
          message:
            "Each attachment must be a regular file no larger than 100 MiB.",
        });
      }
      if (
        existingDrafts.reduce((sum, entry) => sum + entry.sizeBytes, 0) +
          selectedStats.reduce((sum, entry) => sum + entry.size, 0) >
        500 * 1024 * 1024
      ) {
        throw createDesktopError({
          code: "desktop.attachments_too_large",
          message: "Attachments must total at most 500 MiB per message.",
        });
      }
      const imported: DesktopAttachmentMetadata[] = [];
      for (const filePath of selection.filePaths) {
        imported.push(
          await requireLocalCoreConnectionManager().executeOnce(
            async (client) =>
              await client.importDesktopAttachmentPath({
                threadId: normalizedThreadId,
                filename: path.basename(filePath),
                mimeType: desktopAttachmentMimeType(filePath),
                sourcePath: filePath,
              }),
          ),
        );
      }
      return imported;
    },
  );
  ipcMain.handle(
    "desktop:import-attachment",
    async (_event, input: unknown): Promise<DesktopAttachmentMetadata> => {
      const attachment = parseDesktopAttachmentImportInput(input);
      return await requireLocalCoreConnectionManager().executeOnce(
        async (client) => await client.importDesktopAttachment(attachment),
      );
    },
  );
  ipcMain.handle(
    "desktop:attachment-stream-begin",
    async (_event, value: unknown): Promise<string> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw createDesktopError({
          code: "desktop.invalid_attachment_input",
          message: "Attachment stream metadata is invalid.",
        });
      }
      const input = value as Record<string, unknown>;
      const threadId = parseDesktopAttachmentThreadId(input.threadId);
      const filename =
        typeof input.filename === "string" ? input.filename.trim() : "";
      const mimeType =
        typeof input.mimeType === "string" && input.mimeType.trim()
          ? input.mimeType.trim()
          : undefined;
      const expectedBytes = input.sizeBytes;
      if (
        !filename ||
        typeof expectedBytes !== "number" ||
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes < 0 ||
        expectedBytes > 100 * 1024 * 1024
      ) {
        throw createDesktopError({
          code: "desktop.invalid_attachment_input",
          message: "Attachment stream filename or size is invalid.",
        });
      }
      const drafts = (
        await requireLocalCoreConnectionManager().executeIdempotent(
          async (client) => await client.listDesktopAttachments(threadId),
        )
      ).filter((attachment) => attachment.submittedAt === undefined);
      if (
        drafts.length >= 20 ||
        drafts.reduce((sum, entry) => sum + entry.sizeBytes, 0) +
          expectedBytes >
          500 * 1024 * 1024
      ) {
        throw createDesktopError({
          code: "desktop.attachments_too_large",
          message:
            "Attachment count or message total exceeds the configured limit.",
        });
      }
      const importRoot = await mkdtemp(
        path.join(os.tmpdir(), "kestrel-desktop-attachment-import-"),
      );
      const filePath = path.join(importRoot, "upload.bin");
      const handle = await open(filePath, "wx", 0o600);
      const uploadId = `attachment-upload-${randomUUID()}`;
      activeDesktopAttachmentImports.set(uploadId, {
        filePath,
        handle,
        threadId,
        filename,
        ...(mimeType !== undefined ? { mimeType } : {}),
        expectedBytes,
        receivedBytes: 0,
      });
      return uploadId;
    },
  );
  ipcMain.handle(
    "desktop:attachment-stream-append",
    async (_event, uploadId: unknown, value: unknown): Promise<void> => {
      const upload =
        typeof uploadId === "string"
          ? activeDesktopAttachmentImports.get(uploadId)
          : undefined;
      const chunk =
        value instanceof Uint8Array ? Buffer.from(value) : undefined;
      if (
        upload === undefined ||
        chunk === undefined ||
        chunk.byteLength > 1024 * 1024
      ) {
        throw createDesktopError({
          code: "desktop.invalid_attachment_input",
          message: "Attachment stream chunk is invalid.",
        });
      }
      if (upload.receivedBytes + chunk.byteLength > upload.expectedBytes) {
        throw createDesktopError({
          code: "desktop.attachment_too_large",
          message: "Attachment stream exceeded its declared size.",
        });
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await upload.handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
        );
        offset += bytesWritten;
      }
      upload.receivedBytes += chunk.byteLength;
    },
  );
  ipcMain.handle(
    "desktop:attachment-stream-finish",
    async (_event, uploadId: unknown): Promise<DesktopAttachmentMetadata> => {
      const normalizedId = typeof uploadId === "string" ? uploadId : "";
      const upload = activeDesktopAttachmentImports.get(normalizedId);
      if (upload === undefined) {
        throw createDesktopError({
          code: "desktop.invalid_attachment_input",
          message: "Attachment stream is unavailable.",
        });
      }
      activeDesktopAttachmentImports.delete(normalizedId);
      try {
        await upload.handle.close();
        if (upload.receivedBytes !== upload.expectedBytes) {
          throw createDesktopError({
            code: "desktop.invalid_attachment_input",
            message: "Attachment stream ended before its declared size.",
          });
        }
        return await requireLocalCoreConnectionManager().executeOnce(
          async (client) =>
            await client.importDesktopAttachmentPath({
              threadId: upload.threadId,
              filename: upload.filename,
              sourcePath: upload.filePath,
              ...(upload.mimeType !== undefined
                ? { mimeType: upload.mimeType }
                : {}),
            }),
        );
      } finally {
        await upload.handle.close().catch(() => {});
        await rm(path.dirname(upload.filePath), {
          recursive: true,
          force: true,
        });
      }
    },
  );
  ipcMain.handle(
    "desktop:attachment-stream-abort",
    async (_event, uploadId: unknown): Promise<void> => {
      const normalizedId = typeof uploadId === "string" ? uploadId : "";
      const upload = activeDesktopAttachmentImports.get(normalizedId);
      if (upload === undefined) return;
      activeDesktopAttachmentImports.delete(normalizedId);
      await upload.handle.close().catch(() => {});
      await rm(path.dirname(upload.filePath), { recursive: true, force: true });
    },
  );
  ipcMain.handle(
    "desktop:list-attachments",
    async (_event, threadId: unknown) =>
      await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) =>
          await client.listDesktopAttachments(
            parseDesktopAttachmentThreadId(threadId),
          ),
      ),
  );
  ipcMain.handle(
    "desktop:remove-attachment",
    async (_event, threadId: unknown, attachmentId: unknown) =>
      await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.removeDesktopAttachment(
            parseDesktopAttachmentThreadId(threadId),
            parseDesktopAttachmentId(attachmentId),
          ),
      ),
  );
  ipcMain.handle(
    "desktop:save-attachment",
    async (
      _event,
      threadId: unknown,
      attachmentId: unknown,
    ): Promise<string | null> => {
      const normalizedThreadId = parseDesktopAttachmentThreadId(threadId);
      const normalizedAttachmentId = parseDesktopAttachmentId(attachmentId);
      const listed =
        await requireLocalCoreConnectionManager().executeIdempotent(
          async (client) =>
            await client.listDesktopAttachments(normalizedThreadId),
        );
      const attachment = listed.find(
        (entry) => entry.attachmentId === normalizedAttachmentId,
      );
      if (!attachment) {
        throw createDesktopError({
          code: "desktop.attachment_unavailable",
          message: "The attachment is unavailable for this thread.",
        });
      }
      const selection =
        mainWindow === undefined
          ? await dialog.showSaveDialog({ defaultPath: attachment.filename })
          : await dialog.showSaveDialog(mainWindow, {
              defaultPath: attachment.filename,
            });
      if (selection.canceled || !selection.filePath) return null;
      const source = path.join(
        resolveLocalCorePaths(requireLocalCoreStatus().home.homePath)
          .stateRootPath,
        "attachments",
        "blobs",
        attachment.sha256,
      );
      await copyFile(source, selection.filePath);
      return selection.filePath;
    },
  );
  ipcMain.handle("desktop:operator-control", async (_event, input: unknown) => {
    let request: DesktopOperatorControlRequest;
    try {
      request = parseDesktopOperatorControlRequest(input);
    } catch (error) {
      throw createDesktopError({
        code: "desktop.invalid_operator_control",
        message: "Desktop operator control request is invalid.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    const { attachmentIds, ...control } = request;
    if (attachmentIds !== undefined) {
      const listed =
        await requireLocalCoreConnectionManager().executeIdempotent(
          async (client) =>
            await client.listDesktopAttachments(request.threadId),
        );
      const selected = attachmentIds.map((attachmentId) =>
        listed.find((entry) => entry.attachmentId === attachmentId),
      );
      if (selected.some((entry) => entry === undefined))
        throw createDesktopError({
          code: "desktop.attachment_unavailable",
          message: "One or more attachments are unavailable for this thread.",
        });
      if (
        selected.some((entry) => entry?.kind === "image") &&
        desktopModelPolicy.modelCapabilities.visionInputEnabled !== true
      ) {
        throw createDesktopError({
          code: "desktop.model_vision_unavailable",
          message: "The selected model does not accept image attachments.",
        });
      }
    }
    const attachments =
      attachmentIds !== undefined && request.action !== "enqueue_follow_up"
        ? await requireLocalCoreConnectionManager().executeIdempotent(
            async (client) =>
              await client.resolveDesktopAttachments(
                request.threadId,
                attachmentIds,
              ),
          )
        : undefined;
    return runDesktopOperatorControl({
      adapter: requireDesktopRunnerAdapter(runnerTransport),
      request: {
        ...control,
        ...(request.action === "enqueue_follow_up" &&
        attachmentIds !== undefined
          ? { attachmentIds }
          : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      },
      context: DESKTOP_RUNNER_REQUEST_CONTEXT,
    });
  });
  ipcMain.handle(
    "desktop:conversation-messages",
    async (_event, threadId: unknown, afterCursor: unknown, limit: unknown) => {
      if (typeof threadId !== "string" || threadId.trim().length === 0) {
        throw createDesktopError({
          code: "desktop.invalid_thread_id",
          message: "Conversation message threadId is required.",
        });
      }
      if (afterCursor !== undefined && typeof afterCursor !== "string") {
        throw createDesktopError({
          code: "desktop.invalid_message_cursor",
          message: "Conversation message cursor is invalid.",
        });
      }
      if (
        limit !== undefined &&
        (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 500)
      ) {
        throw createDesktopError({
          code: "desktop.invalid_message_limit",
          message: "Conversation message limit must be from 1 to 500.",
        });
      }
      return listDesktopConversationMessages({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        threadId: threadId.trim(),
        ...(typeof afterCursor === "string" ? { afterCursor } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      });
    },
  );
  ipcMain.handle(
    "desktop:conversation-activity",
    async (
      _event,
      sessionId: unknown,
      afterCursor: unknown,
      limit: unknown,
    ) => {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
        throw createDesktopError({
          code: "desktop.invalid_session_id",
          message: "Conversation activity sessionId is required.",
        });
      }
      if (afterCursor !== undefined && typeof afterCursor !== "string") {
        throw createDesktopError({
          code: "desktop.invalid_activity_cursor",
          message: "Conversation activity cursor is invalid.",
        });
      }
      if (
        limit !== undefined &&
        (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 500)
      ) {
        throw createDesktopError({
          code: "desktop.invalid_activity_limit",
          message: "Conversation activity limit must be from 1 to 500.",
        });
      }
      return requireLocalCoreConnectionManager().executeIdempotent(
        async (client) =>
          await client.listDesktopConversationActivity({
            sessionId: sessionId.trim(),
            ...(typeof afterCursor === "string" ? { afterCursor } : {}),
            ...(typeof limit === "number" ? { limit } : {}),
          }),
      );
    },
  );
  ipcMain.handle("desktop:cancel-run", async (_event, input: unknown) => {
    let request: DesktopRunCancelRequest;
    try {
      request = parseDesktopRunCancelRequest(input);
    } catch (error) {
      throw createDesktopError({
        code: "desktop.invalid_cancel_request",
        message: "Desktop run cancellation request is invalid.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    return await cancelDesktopRun({
      adapter: requireDesktopRunnerAdapter(runnerTransport),
      request,
      context: DESKTOP_RUNNER_REQUEST_CONTEXT,
    });
  });
  ipcMain.handle("desktop:get-model-policy", async () => desktopModelPolicy);
  ipcMain.handle(
    "desktop:save-settings",
    async (_event, nextSettings: unknown) => {
      assertDesktopAdmissionOpen("a settings mutation");
      let update: DesktopRendererSettingsUpdate;
      try {
        update = parseDesktopRendererSettingsUpdate(nextSettings);
        if (update.modelConfigurations !== undefined) {
          assertDesktopModelConfigurationHistoryPreserved(
            desktopSettings.modelConfigurations,
            update.modelConfigurations,
          );
        }
      } catch (error) {
        throw createDesktopError({
          code: "desktop.invalid_settings",
          message: "Desktop settings update is invalid.",
          details: error instanceof Error ? error.message : String(error),
        });
      }
      const nextProjects = preserveDesktopProjectRegistrationIds(
        desktopSettings.projects,
        update.projects ?? desktopSettings.projects,
      );
      const preparedProjects =
        await prepareDesktopSettingsProjectRegistrations(nextProjects);
      const nextProjectPaths = new Set(
        preparedProjects.map((project) => path.resolve(project.path)),
      );
      const removedAt = new Date().toISOString();
      const normalized = normalizeDesktopSettings(
        {
          ...desktopSettings,
          projects: preparedProjects,
          projectTombstones: [
            ...desktopSettings.projectTombstones,
            ...desktopSettings.projects
              .filter(
                (project) => !nextProjectPaths.has(path.resolve(project.path)),
              )
              .map((project) => ({
                id: project.id!,
                path: path.resolve(project.path),
                label: project.label,
                removedAt,
              })),
          ],
          modelConfigurations:
            update.modelConfigurations ?? desktopSettings.modelConfigurations,
          defaultModelConfigurationId:
            update.defaultModelConfigurationId ??
            desktopSettings.defaultModelConfigurationId,
          defaultEnabledBuiltInAppIds:
            update.defaultEnabledBuiltInAppIds ??
            desktopSettings.defaultEnabledBuiltInAppIds,
          appearanceTheme:
            update.appearanceTheme ?? desktopSettings.appearanceTheme,
        },
        { fallbackModelPolicy: desktopModelPolicy },
      );
      const persisted = await persistDesktopRendererConfiguration(
        runnerTransport,
        {
          settings: normalized,
          restartRuntime: false,
          resetRunnerProfile: false,
          restartMessage: "Applying project settings…",
        },
      );
      await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.syncKestrelOneProjects(normalized.projects),
      );
      return persisted;
    },
  );
  ipcMain.handle("desktop:pick-workspace", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Select workspace",
    });
    return result.canceled === true ? undefined : result.filePaths[0];
  });
  ipcMain.handle(
    "desktop:pick-project-folder",
    async (): Promise<DesktopProjectRegistration | undefined> => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Add project folder",
      });
      const selectedPath =
        result.canceled === true ? undefined : result.filePaths[0];
      if (selectedPath === undefined) {
        return;
      }
      await ensureDesktopProjectGitBootstrap(selectedPath);
      return {
        path: selectedPath,
        label: path.basename(selectedPath),
      };
    },
  );
  ipcMain.handle(
    "desktop:open-project-run-preview",
    async (_event, input: unknown) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw createDesktopError({
          code: "desktop.invalid_project_run_preview_input",
          message:
            "desktop.openProjectRunPreview requires a project run payload.",
        });
      }
      const payload = input as Record<string, unknown>;
      if (
        typeof payload.runId !== "string" ||
        payload.runId.trim().length === 0
      ) {
        throw createDesktopError({
          code: "desktop.invalid_project_run_id",
          message: "desktop.openProjectRunPreview requires a run id.",
        });
      }
      if (payload.url !== undefined && typeof payload.url !== "string") {
        throw createDesktopError({
          code: "desktop.invalid_project_run_preview_url",
          message:
            "desktop.openProjectRunPreview requires an http(s) URL when a URL is provided.",
        });
      }
      const preview = await resolveCoreProjectRunPreviewUrl({
        runId: payload.runId,
        ...(typeof payload.url === "string" ? { url: payload.url } : {}),
      });
      await openProjectRunPreviewWindow(preview.run, preview.url);
    },
  );
  ipcMain.handle("desktop:open-file-editor", async (_event, input: unknown) => {
    const editorInput = parseDesktopOpenFileEditorInput(input);
    const projectPath = await resolveDesktopAuthorizedWorkspaceRoot(
      editorInput.projectPath,
      editorInput.threadId,
    );
    await openFileEditorWindow({ ...editorInput, projectPath });
  });
  ipcMain.handle("desktop:open-path", async (_event, input: unknown) => {
    const parsed = parseDesktopPathTargetInput(input, {
      methodName: "desktop.openPath",
      invalidInputCode: "desktop.invalid_open_input",
      invalidTargetCode: "desktop.invalid_open_path",
    });
    const rootPath = await resolveDesktopAuthorizedWorkspaceRoot(
      parsed.rootPath,
      parsed.threadId,
    );
    const resolved = await resolveVerifiedDesktopPathTarget(
      { ...parsed, rootPath },
      [rootPath],
    );
    await shell.openPath(resolved.targetPath);
  });
  ipcMain.handle("desktop:reveal-path", async (_event, input: unknown) => {
    const parsed = parseDesktopPathTargetInput(input, {
      methodName: "desktop.revealPath",
      invalidInputCode: "desktop.invalid_reveal_input",
      invalidTargetCode: "desktop.invalid_reveal_path",
    });
    const rootPath = await resolveDesktopAuthorizedWorkspaceRoot(
      parsed.rootPath,
      parsed.threadId,
    );
    const resolved = await resolveVerifiedDesktopPathTarget(
      { ...parsed, rootPath },
      [rootPath],
    );
    shell.showItemInFolder(resolved.targetPath);
  });
  ipcMain.handle("desktop:restart-runtime", async () => {
    if (desktopConfig === undefined) {
      throw createDesktopError({
        code: "desktop.config_unavailable",
        message: "Kestrel Local Core shell configuration is unavailable.",
      });
    }
    if (databaseController !== undefined) {
      const database = await databaseController.prepare();
      currentDatabaseUrl = database.databaseUrl;
      databaseStatus = database.status;
    }
    updateBootState(
      {
        phase: "starting_runtime",
        message: "Restarting Kestrel runtime…",
        database: databaseStatus,
      },
      mainWindow?.webContents,
    );
    await stopCoreProjectRuns();
    await runnerTransport.stop();
    await ensureDesktopRunnerResponsive(runnerTransport);
    const status = runnerTransport.getStatus();
    updateBootState(
      {
        phase: "ready",
        message: "Desktop ready.",
        database: databaseStatus,
      },
      mainWindow?.webContents,
    );
    return status;
  });
  ipcMain.handle(
    "desktop:request-microphone-access",
    async (): Promise<DesktopMicrophoneAccess> =>
      requestDesktopMicrophoneAccess(),
  );
  ipcMain.handle("desktop:reset-runtime-store", async () => {
    if (desktopConfig === undefined) {
      throw createDesktopError({
        code: "desktop.config_unavailable",
        message: "Kestrel Local Core shell configuration is unavailable.",
      });
    }
    try {
      updateBootState(
        {
          phase: "starting_runtime",
          message: "Resetting local runtime store…",
          database: databaseStatus,
        },
        mainWindow?.webContents,
      );
      await stopCoreProjectRuns();
      await runnerTransport.stop();
      const reset = await archiveRuntimeStore(desktopConfig.runtimeHomePath);
      if (databaseController !== undefined) {
        const database = await databaseController.prepare();
        currentDatabaseUrl = database.databaseUrl;
        databaseStatus = database.status;
      }
      await ensureDesktopRunnerResponsive(runnerTransport);
      const runtimeStatus = runnerTransport.getStatus();
      updateBootState(
        {
          phase: "ready",
          message: "Desktop ready.",
          database: databaseStatus,
        },
        mainWindow?.webContents,
      );
      return {
        ...reset,
        runtimeStatus,
      };
    } catch (error) {
      updateBootState(
        {
          phase: "failed",
          message: "Runtime store reset failed.",
          ...(readDesktopErrorCode(error) !== undefined
            ? { code: readDesktopErrorCode(error) }
            : {}),
          details: error instanceof Error ? error.message : String(error),
          database: databaseStatus,
        },
        mainWindow?.webContents,
      );
      throw error;
    }
  });
  ipcMain.handle("desktop:get-runtime-status", async () =>
    runnerTransport.getStatus(),
  );
  ipcMain.handle("desktop:get-runtime-health", async () => runtimeHealth);
  ipcMain.handle("desktop:get-database-status", async () => {
    if (databaseController === undefined) {
      return databaseStatus;
    }
    databaseStatus = await databaseController.getStatus();
    return databaseStatus;
  });
  ipcMain.handle("desktop:restart-database", async () => {
    if (databaseController === undefined) {
      throw createDesktopError({
        code: "desktop.database_controller_unavailable",
        message: "Kestrel Local Core database controller is unavailable.",
      });
    }
    databaseStatus = await databaseController.restart();
    currentDatabaseUrl = databaseController.getDatabaseUrl();
    runtimeHealth = deriveRuntimeHealth(bootState);
    mainWindow?.webContents.send("desktop:runtime-health", runtimeHealth);
    return databaseStatus;
  });
  ipcMain.handle("desktop:repair-database", async () => {
    if (databaseController === undefined) {
      throw createDesktopError({
        code: "desktop.database_controller_unavailable",
        message: "Kestrel Local Core database controller is unavailable.",
      });
    }
    databaseStatus = await databaseController.repair();
    currentDatabaseUrl = databaseController.getDatabaseUrl();
    runtimeHealth = deriveRuntimeHealth(bootState);
    mainWindow?.webContents.send("desktop:runtime-health", runtimeHealth);
    return databaseStatus;
  });
  ipcMain.handle(
    "desktop:reveal-database-files",
    async (_event, target: unknown) => {
      if (target !== "log" && target !== "data") {
        throw createDesktopError({
          code: "desktop.invalid_database_reveal_target",
          message: "desktop.revealDatabaseFiles requires 'log' or 'data'.",
        });
      }
      const filePath =
        target === "log"
          ? databaseController?.getLogPath()
          : databaseController?.getDataPath();
      if (filePath === undefined) {
        throw createDesktopError({
          code: "desktop.database_path_unavailable",
          message: `Database ${target} path is unavailable.`,
        });
      }
      shell.showItemInFolder(filePath);
    },
  );
  ipcMain.handle(
    "desktop:list-directory",
    async (
      _event,
      rootPath: unknown,
      directoryPath: unknown,
      threadId: unknown,
    ): Promise<DesktopDirectoryListing> => {
      if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
        throw createDesktopError({
          code: "desktop.invalid_root_path",
          message: "desktop.listDirectory requires a project root path.",
        });
      }
      const resolvedRoot = await resolveDesktopAuthorizedWorkspaceRoot(
        rootPath,
        parseOptionalThreadId(threadId),
      );
      const resolvedDirectory =
        typeof directoryPath === "string" && directoryPath.trim().length > 0
          ? path.resolve(directoryPath)
          : resolvedRoot;
      assertWithinRoot(resolvedRoot, resolvedDirectory, "directoryPath");
      await resolveVerifiedDesktopPathTarget(
        { rootPath: resolvedRoot, targetPath: resolvedDirectory },
        [resolvedRoot],
        "directoryPath",
      );
      const directoryEntries = await readdir(resolvedDirectory, {
        withFileTypes: true,
      });
      const entries: DesktopFileEntry[] = (
        await Promise.all(
          directoryEntries.map(
            async (entry): Promise<DesktopFileEntry | undefined> => {
              const entryPath = path.join(resolvedDirectory, entry.name);
              try {
                const entryStats = await lstat(entryPath);
                return {
                  path: entryPath,
                  name: entry.name,
                  kind: entry.isDirectory()
                    ? ("directory" as const)
                    : ("file" as const),
                  modifiedAt: entryStats.mtime.toISOString(),
                  ...(entry.isDirectory()
                    ? {}
                    : { sizeBytes: entryStats.size }),
                };
              } catch {
                return {
                  path: entryPath,
                  name: entry.name,
                  kind: entry.isDirectory()
                    ? ("directory" as const)
                    : ("file" as const),
                };
              }
            },
          ),
        )
      )
        .filter((entry): entry is DesktopFileEntry => entry !== undefined)
        .sort((left, right) => {
          if (left.kind !== right.kind) {
            return left.kind === "directory" ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });
      const listing: DesktopDirectoryListing = {
        rootPath: resolvedRoot,
        directoryPath: resolvedDirectory,
        entries,
      };
      projectFileIndex.rememberDirectoryListing(listing);
      return listing;
    },
  );
  ipcMain.handle(
    "desktop:search-project-files",
    async (
      _event,
      rootPath: unknown,
      query: unknown,
      threadId: unknown,
    ): Promise<DesktopFileSearchResponse> => {
      if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
        throw createDesktopError({
          code: "desktop.invalid_root_path",
          message: "desktop.searchProjectFiles requires a project root path.",
        });
      }
      const resolvedRoot = await resolveDesktopAuthorizedWorkspaceRoot(
        rootPath,
        parseOptionalThreadId(threadId),
      );
      if (typeof query !== "string" || query.trim().length === 0) {
        return {
          rootPath: resolvedRoot,
          query: "",
          results: [],
          truncated: false,
          fullSearchAvailable: true,
        };
      }
      await resolveVerifiedDesktopPathTarget(
        { rootPath: resolvedRoot, targetPath: resolvedRoot },
        [resolvedRoot],
      );
      return projectFileIndex.search(resolvedRoot, query.trim());
    },
  );
  ipcMain.handle(
    "desktop:search-project-content",
    async (
      _event,
      rootPath: unknown,
      query: unknown,
      threadId: unknown,
    ): Promise<DesktopFileContentSearchResponse> => {
      if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
        throw createDesktopError({
          code: "desktop.invalid_root_path",
          message: "desktop.searchProjectContent requires a project root path.",
        });
      }
      const resolvedRoot = await resolveDesktopAuthorizedWorkspaceRoot(
        rootPath,
        parseOptionalThreadId(threadId),
      );
      if (typeof query !== "string" || query.trim().length === 0) {
        return {
          rootPath: resolvedRoot,
          query: "",
          results: [],
          truncated: false,
          fullSearchAvailable: true,
          scannedFileCount: 0,
          skippedFileCount: 0,
        };
      }
      if (query.trim().length > 256) {
        throw createDesktopError({
          code: "desktop.invalid_content_search_query",
          message:
            "desktop.searchProjectContent supports queries up to 256 characters.",
        });
      }
      await resolveVerifiedDesktopPathTarget(
        { rootPath: resolvedRoot, targetPath: resolvedRoot },
        [resolvedRoot],
      );
      return projectFileIndex.searchContent(resolvedRoot, query.trim());
    },
  );
  ipcMain.handle(
    "desktop:watch-project-files",
    async (event, rootPath: unknown, threadId: unknown) => {
      const resolvedRoot = await parseDesktopProjectWatchRoot(
        rootPath,
        parseOptionalThreadId(threadId),
        "desktop.watchProjectFiles",
      );
      startProjectFileWatcher(resolvedRoot, event.sender.id);
      event.sender.once("destroyed", () => {
        stopProjectFileWatcher(resolvedRoot, event.sender.id);
      });
    },
  );
  ipcMain.handle(
    "desktop:unwatch-project-files",
    async (event, rootPath: unknown) => {
      const resolvedRoot = parseDesktopProjectUnwatchRoot(
        rootPath,
        "desktop.unwatchProjectFiles",
      );
      stopProjectFileWatcher(resolvedRoot, event.sender.id);
    },
  );
  ipcMain.handle(
    "desktop:read-file",
    async (_event, input: unknown): Promise<DesktopFileContent> => {
      const parsed = parseDesktopFileReadInput(input);
      const rootPath = await resolveDesktopAuthorizedWorkspaceRoot(
        parsed.rootPath,
        parsed.threadId,
      );
      const resolved = await resolveVerifiedDesktopPathTarget(
        { ...parsed, rootPath },
        [rootPath],
      );
      const resolvedPath = resolved.targetPath;
      const fileStats = await stat(resolvedPath);
      if (fileStats.isFile() === false) {
        throw createDesktopError({
          code: "desktop.invalid_read_path",
          message: "desktop.readFile requires a file path.",
        });
      }
      const contentBuffer = await readEditableTextFileBuffer(
        resolvedPath,
        fileStats.size,
      );
      const diskContent = decodeUtf8TextFile(contentBuffer, resolvedPath);
      const lineEnding = detectLineEnding(diskContent);
      const content = normalizeEditorLineEndings(diskContent);
      const editable =
        fileStats.size <= EDITABLE_TEXT_FILE_MAX_BYTES &&
        lineEnding !== "mixed";
      const readOnlyReason =
        fileStats.size > EDITABLE_TEXT_FILE_MAX_BYTES
          ? "large_file"
          : lineEnding === "mixed"
            ? "mixed_line_endings"
            : undefined;
      return {
        path: resolvedPath,
        content,
        contentHash: hashTextContent(diskContent),
        modifiedAt: fileStats.mtime.toISOString(),
        sizeBytes: fileStats.size,
        lineEnding,
        editable,
        ...(readOnlyReason !== undefined ? { readOnlyReason } : {}),
        ...resolveFileViewKind(resolvedPath),
      };
    },
  );
  ipcMain.handle(
    "desktop:write-file",
    async (_event, input: unknown): Promise<DesktopFileContent> => {
      const parsed = parseDesktopFileWriteInput(input);
      const rootPath = await resolveDesktopAuthorizedWorkspaceRoot(
        parsed.rootPath,
        parsed.threadId,
      );
      const resolved = await resolveVerifiedDesktopPathTarget(
        { ...parsed, rootPath },
        [rootPath],
      );
      const resolvedPath = resolved.targetPath;
      const currentStats = await stat(resolvedPath);
      if (currentStats.isFile() === false) {
        throw createDesktopError({
          code: "desktop.invalid_write_path",
          message: "desktop.writeFile requires a file path.",
        });
      }
      assertWritableDesktopTextFile(resolvedPath, currentStats.size);
      const currentBuffer = await readFile(resolvedPath);
      const currentContent = decodeUtf8TextFile(currentBuffer, resolvedPath);
      assertWritableDesktopTextContent(currentContent);
      const currentHash = hashTextContent(currentContent);
      if (
        parsed.expectedContentHash !== undefined &&
        parsed.expectedContentHash !== currentHash
      ) {
        throw createDesktopError({
          code: "desktop.stale_file_write",
          message: "The file changed on disk before Kestrel saved it.",
          details: `expectedContentHash=${parsed.expectedContentHash} currentHash=${currentHash}`,
        });
      }
      const detectedLineEnding = detectLineEnding(currentContent);
      if (detectedLineEnding === "mixed") {
        throw createDesktopError({
          code: "desktop.file_read_only_mixed_line_endings",
          message:
            "This file is open read-only because it has mixed line endings.",
        });
      }
      const lineEnding = parsed.lineEnding ?? detectedLineEnding;
      const nextDiskContent = applyLineEnding(parsed.content, lineEnding);
      await writeFile(resolvedPath, nextDiskContent, "utf8");
      const nextStats = await stat(resolvedPath);
      return {
        path: resolvedPath,
        content: normalizeEditorLineEndings(nextDiskContent),
        contentHash: hashTextContent(nextDiskContent),
        modifiedAt: nextStats.mtime.toISOString(),
        sizeBytes: nextStats.size,
        lineEnding: detectLineEnding(nextDiskContent),
        editable: true,
        ...resolveFileViewKind(resolvedPath),
      };
    },
  );
  ipcMain.handle(
    "desktop:discover-mcp-servers",
    async (): Promise<DesktopMcpDiscoveryResult> => readDesktopMcpInventory(),
  );
  ipcMain.handle(
    "desktop:start-standard-app-connection",
    async (_event, rawInput: unknown): Promise<DesktopAppConnectionSession> => {
      assertDesktopAdmissionOpen("an authorization session");
      if (
        typeof rawInput !== "object" ||
        rawInput === null ||
        Array.isArray(rawInput)
      ) {
        throw createDesktopError({
          code: "desktop.invalid_app_connection",
          message: "The App connection request is invalid.",
        });
      }
      const raw = rawInput as Record<string, unknown>;
      if (
        Object.keys(raw).some(
          (key) => key !== "appId" && key !== "capabilityPacks",
        ) ||
        typeof raw.appId !== "string" ||
        (raw.capabilityPacks !== undefined &&
          (!Array.isArray(raw.capabilityPacks) ||
            raw.capabilityPacks.some((pack) => typeof pack !== "string")))
      ) {
        throw createDesktopError({
          code: "desktop.invalid_app_connection",
          message: "The App connection request is invalid.",
        });
      }
      const input: DesktopStandardAppConnectionInput = {
        appId: raw.appId,
        ...(raw.capabilityPacks !== undefined
          ? { capabilityPacks: raw.capabilityPacks as string[] }
          : {}),
      };
      const connection = getDesktopStandardAppConnection(input.appId);
      if (connection?.kind !== "authorization") {
        throw createDesktopError({
          code: "desktop.app_connection_unavailable",
          message: "This App does not support this Desktop connection flow.",
        });
      }
      const manifest = KESTREL_STANDARD_APP_MANIFESTS.find(
        (candidate) => candidate.id === connection.appId,
      );
      if (manifest === undefined) {
        throw new Error("The published App manifest is unavailable.");
      }
      const capabilityPacks = [...new Set(input.capabilityPacks ?? [])];
      const configuredScopes = connection.capabilityPackScopes;
      if (
        (configuredScopes === undefined && capabilityPacks.length > 0) ||
        (configuredScopes !== undefined &&
          (capabilityPacks.length === 0 ||
            capabilityPacks.some(
              (pack) => configuredScopes[pack] === undefined,
            )))
      ) {
        throw createDesktopError({
          code: "desktop.invalid_app_connection",
          message: `Choose valid ${manifest.name} capabilities before connecting.`,
        });
      }
      const clientId = resolveDesktopPublicAppClientId({
        appId: connection.appId,
        environmentVariable: connection.clientIdEnvironmentVariable,
        env: process.env,
        configPath: path.join(app.getAppPath(), "app-connections.json"),
      });
      if (connection.clientIdEnvironmentVariable && !clientId) {
        throw createDesktopError({
          code: "desktop.app_connection_unavailable",
          message: `${manifest.name} is not configured for this Kestrel Desktop build.`,
        });
      }
      const session = await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          connection.runtime === "native" &&
          connection.appId === KESTREL_APP_IDS.MICROSOFT_365
            ? await client.startMicrosoft365OAuth({
                clientId: clientId!,
                packs:
                  capabilityPacks as import("../../../src/apps/microsoft365.js").Microsoft365Pack[],
              })
            : connection.runtime === "native" &&
                connection.appId === KESTREL_APP_IDS.GOOGLE_WORKSPACE
              ? await client.startGoogleWorkspaceOAuth({
                  clientId: clientId!,
                  packs:
                    capabilityPacks as import("../../../src/apps/googleWorkspace.js").GoogleWorkspacePack[],
                })
              : await client.startMcpOAuth({
                  credentialPrefix: connection.credentialPrefix,
                  serverUrl: connection.url,
                  appName: manifest.name,
                  ...(clientId ? { clientId } : {}),
                  ...(connection.loopbackCallback
                    ? { loopbackCallback: connection.loopbackCallback }
                    : {}),
                  ...(configuredScopes
                    ? {
                        scopes: [
                          ...new Set(
                            capabilityPacks.flatMap(
                              (pack) => configuredScopes[pack] ?? [],
                            ),
                          ),
                        ],
                      }
                    : {}),
                }),
      );
      if (connection.appId === KESTREL_APP_IDS.MICROSOFT_365) {
        microsoft365AuthorizationSessionIds.add(session.sessionId);
      }
      if (connection.appId === KESTREL_APP_IDS.GOOGLE_WORKSPACE) {
        googleWorkspaceAuthorizationSessionIds.add(session.sessionId);
      }
      if (connection.runtime !== "native") {
        mcpAuthorizationSessionIds.add(session.sessionId);
      }
      if (session.authorizationUrl !== undefined) {
        await shell.openExternal(session.authorizationUrl);
      }
      return {
        sessionId: session.sessionId,
        state: session.state,
        ...(session.error !== undefined ? { error: session.error } : {}),
        expiresAt: session.expiresAt,
      };
    },
  );
  ipcMain.handle(
    "desktop:get-standard-app-connection-status",
    async (
      _event,
      sessionId: unknown,
    ): Promise<DesktopAppConnectionSession> => {
      if (typeof sessionId !== "string") {
        throw createDesktopError({
          code: "desktop.invalid_app_connection",
          message: "The App connection session is invalid.",
        });
      }
      const session = await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          microsoft365AuthorizationSessionIds.has(sessionId)
            ? await client.microsoft365OAuthStatus(sessionId)
            : googleWorkspaceAuthorizationSessionIds.has(sessionId)
              ? await client.googleWorkspaceOAuthStatus(sessionId)
              : await client.mcpOAuthStatus(sessionId),
      );
      if (session.state !== "awaiting_user") {
        microsoft365AuthorizationSessionIds.delete(sessionId);
        googleWorkspaceAuthorizationSessionIds.delete(sessionId);
        mcpAuthorizationSessionIds.delete(sessionId);
      }
      return {
        sessionId: session.sessionId,
        state: session.state,
        ...(session.error !== undefined ? { error: session.error } : {}),
        expiresAt: session.expiresAt,
      };
    },
  );
  ipcMain.handle(
    "desktop:save-mcp-server",
    async (_event, input: unknown): Promise<DesktopMcpDiscoveryResult> => {
      let configuration: DesktopMcpServerMutationInput;
      try {
        configuration = parseDesktopMcpServerMutationInput(input);
      } catch (error) {
        throw createDesktopError({
          code: "desktop.invalid_mcp_server",
          message: "MCP server configuration is invalid.",
          details: error instanceof Error ? error.message : String(error),
        });
      }
      let server: DesktopMcpServerConfig;
      try {
        if (
          configuration.appId !== undefined &&
          desktopSettings.mcpServers.some(
            (entry) =>
              entry.appId === configuration.appId &&
              entry.id !== configuration.id,
          )
        ) {
          throw new Error(
            "This standard App already has a Desktop connection.",
          );
        }
        const standardConnection = configuration.appId
          ? getDesktopStandardAppConnection(configuration.appId)
          : undefined;
        if (
          configuration.enabled &&
          standardConnection?.kind === "authorization" &&
          standardConnection.runtime === "native"
        ) {
          const toolNames = [
            ...new Set(
              (configuration.capabilityPacks ?? []).flatMap(
                (pack) => standardConnection.capabilityPackTools?.[pack] ?? [],
              ),
            ),
          ];
          if ((configuration.capabilityPacks ?? []).length === 0)
            throw new Error("Choose at least one App capability.");
          const verification =
            await requireLocalCoreConnectionManager().executeOnce(
              async (client) =>
                configuration.appId === KESTREL_APP_IDS.GOOGLE_WORKSPACE
                  ? await client.verifyGoogleWorkspace(
                      (configuration.capabilityPacks ??
                        []) as import("../../../src/apps/googleWorkspace.js").GoogleWorkspacePack[],
                    )
                  : await client.verifyMicrosoft365(
                      (configuration.capabilityPacks ??
                        []) as import("../../../src/apps/microsoft365.js").Microsoft365Pack[],
                    ),
            );
          server = {
            id: configuration.id,
            appId: configuration.appId!,
            name: configuration.name,
            transport: "http",
            url: configuration.url!,
            enabled: true,
            source: "Kestrel Desktop",
            sourceKind: "desktop-managed",
            oauthCredentialPrefix: configuration.oauthCredentialPrefix!,
            capabilityPacks: [...(configuration.capabilityPacks ?? [])],
            tools: toolNames.map((name) => {
              const requiresApproval = desktopStandardAppToolRequiresApproval(
                configuration.appId!,
                name,
              );
              return {
                name,
                description: `${configuration.name} capability`,
                approvalMode: requiresApproval ? "ask" : "auto",
                allowedInteractionModes: requiresApproval
                  ? ["chat", "build"]
                  : ["chat", "plan", "build"],
              };
            }),
            toolCount: toolNames.length,
            verifiedAt: verification.verifiedAt,
          };
        } else if (configuration.enabled) {
          const prepared = prepareDesktopMcpVerification(configuration);
          const verification =
            await requireLocalCoreConnectionManager().executeOnce(
              async (client) => await client.verifyMcpServer(prepared.request),
            );
          server = completeDesktopMcpVerification(
            configuration,
            prepared.bindings,
            verification,
          );
        } else {
          const current = desktopSettings.mcpServers.find(
            (entry) => entry.id === configuration.id,
          );
          if (current === undefined)
            throw new Error(
              "Only an existing Desktop-managed MCP server can be disabled.",
            );
          server = { ...current, enabled: false };
        }
      } catch (error) {
        throw createDesktopError({
          code: "desktop.mcp_verification_failed",
          message: `${configuration.name} could not be activated.`,
          details: error instanceof Error ? error.message : String(error),
        });
      }
      const previousServer = desktopSettings.mcpServers.find(
        (entry) => entry.id === server.id,
      );
      await saveDesktopCoreSettings({
        ...desktopSettings,
        mcpServers: [
          ...desktopSettings.mcpServers.filter(
            (entry) => entry.id !== server.id,
          ),
          server,
        ],
        capabilityVerifications: {
          ...desktopSettings.capabilityVerifications,
          ...(configuration.enabled
            ? { "connections.mcp": server.verifiedAt! }
            : {}),
        },
      });
      const activeCredentialIds = new Set(
        server.credentials?.map((credential) => credential.credentialId) ?? [],
      );
      const removedCredentialIds =
        previousServer?.credentials
          ?.map((credential) => credential.credentialId)
          .filter(
            (credentialId) => activeCredentialIds.has(credentialId) === false,
          ) ?? [];
      if (
        previousServer?.oauthCredentialPrefix !== undefined &&
        previousServer.oauthCredentialPrefix !== server.oauthCredentialPrefix
      ) {
        removedCredentialIds.push(
          ...listMcpOAuthCredentialIds(previousServer.oauthCredentialPrefix),
        );
      }
      if (removedCredentialIds.length > 0) {
        await requireLocalCoreConnectionManager().executeOnce(
          async (client) => {
            for (const credentialId of removedCredentialIds)
              await client.deleteCredential(credentialId);
          },
        );
      }
      applyDesktopProfileOverride(desktopSettings);
      await resetDesktopRunnerAdapter();
      await runnerTransport.restart();
      return await readDesktopMcpInventory();
    },
  );
  ipcMain.handle(
    "desktop:delete-mcp-server",
    async (_event, input: unknown): Promise<DesktopMcpDiscoveryResult> => {
      if (
        typeof input !== "string" ||
        /^[a-zA-Z0-9._-]+$/u.test(input) === false
      ) {
        throw createDesktopError({
          code: "desktop.invalid_mcp_server",
          message: "MCP server id is invalid.",
        });
      }
      const removed = desktopSettings.mcpServers.find(
        (server) => server.id === input,
      );
      await saveDesktopCoreSettings({
        ...desktopSettings,
        mcpServers: desktopSettings.mcpServers.filter(
          (server) => server.id !== input,
        ),
      });
      if (
        removed?.credentials !== undefined ||
        removed?.oauthCredentialPrefix !== undefined
      ) {
        await requireLocalCoreConnectionManager().executeOnce(
          async (client) => {
            for (const credential of removed.credentials ?? []) {
              await client.deleteCredential(credential.credentialId);
            }
            if (removed.oauthCredentialPrefix !== undefined) {
              for (const credentialId of listMcpOAuthCredentialIds(
                removed.oauthCredentialPrefix,
              )) {
                await client.deleteCredential(credentialId);
              }
            }
          },
        );
      }
      applyDesktopProfileOverride(desktopSettings);
      await resetDesktopRunnerAdapter();
      await runnerTransport.restart();
      return await readDesktopMcpInventory();
    },
  );
  ipcMain.handle(
    "desktop:read-project-launcher",
    async (
      _event,
      projectPath: unknown,
      packageManagerOverride: unknown,
      threadId: unknown,
    ): Promise<DesktopProjectLauncherDescriptor | undefined> => {
      if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
        throw createDesktopError({
          code: "desktop.invalid_project_path",
          message: "desktop.readProjectLauncher requires a project path.",
        });
      }
      const authorizedProjectPath = await resolveDesktopAuthorizedWorkspaceRoot(
        projectPath,
        parseOptionalThreadId(threadId),
      );
      return requireLocalCoreConnectionManager().executeIdempotent(
        async (client) =>
          await client.readDesktopProjectLauncher({
            projectPath: authorizedProjectPath,
            ...(packageManagerOverride === "npm" ||
            packageManagerOverride === "pnpm"
              ? { packageManagerOverride }
              : {}),
          }),
      );
    },
  );
  ipcMain.handle(
    "desktop:list-workspace-skills",
    async (_event, projectPath: unknown) =>
      await desktopWorkspaceSkillManager(projectPath).list(),
  );
  ipcMain.handle(
    "desktop:install-workspace-skill",
    async (_event, projectPath: unknown, source: unknown) =>
      await desktopWorkspaceSkillManager(projectPath).install(
        parseDesktopWorkspaceSkillSource(source),
      ),
  );
  ipcMain.handle(
    "desktop:update-workspace-skill",
    async (
      _event,
      projectPath: unknown,
      installationId: unknown,
      source: unknown,
    ) =>
      await desktopWorkspaceSkillManager(projectPath).updateSource(
        requireDesktopString(
          installationId,
          "desktop.updateWorkspaceSkill requires an installation id.",
        ),
        parseDesktopWorkspaceSkillSource(source),
      ),
  );
  ipcMain.handle(
    "desktop:sync-workspace-skills",
    async (_event, projectPath: unknown) =>
      await desktopWorkspaceSkillManager(projectPath).syncAll(),
  );
  ipcMain.handle(
    "desktop:remove-workspace-skill",
    async (_event, projectPath: unknown, installationId: unknown) => {
      const manager = desktopWorkspaceSkillManager(projectPath);
      await manager.remove(
        requireDesktopString(
          installationId,
          "desktop.removeWorkspaceSkill requires an installation id.",
        ),
      );
      return await manager.list();
    },
  );
  ipcMain.handle(
    "desktop:list-project-runs",
    async (): Promise<DesktopManagedProjectRun[]> =>
      requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.listDesktopProjectRuns(),
      ),
  );
  ipcMain.handle(
    "desktop:start-project-run",
    async (_event, input: unknown): Promise<DesktopManagedProjectRun> => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw createDesktopError({
          code: "desktop.invalid_project_run_input",
          message: "desktop.startProjectRun requires a project run payload.",
        });
      }
      const payload = input as Record<string, unknown>;
      if (
        typeof payload.projectPath !== "string" ||
        payload.projectPath.trim().length === 0
      ) {
        throw createDesktopError({
          code: "desktop.invalid_project_path",
          message: "desktop.startProjectRun requires a project path.",
        });
      }
      if (
        typeof payload.scriptName !== "string" ||
        payload.scriptName.trim().length === 0
      ) {
        throw createDesktopError({
          code: "desktop.invalid_script_name",
          message: "desktop.startProjectRun requires a script name.",
        });
      }
      const projectPath = await resolveDesktopAuthorizedWorkspaceRoot(
        payload.projectPath,
        parseOptionalThreadId(payload.threadId),
      );
      const scriptName = payload.scriptName;
      const packageManagerOverride =
        payload.packageManagerOverride === "npm" ||
        payload.packageManagerOverride === "pnpm"
          ? payload.packageManagerOverride
          : undefined;
      return requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.startDesktopProjectRun({
            projectPath,
            scriptName,
            ...(packageManagerOverride !== undefined
              ? { packageManagerOverride }
              : {}),
          }),
      );
    },
  );
  ipcMain.handle(
    "desktop:stop-project-run",
    async (
      _event,
      runId: unknown,
    ): Promise<DesktopManagedProjectRun | undefined> => {
      if (typeof runId !== "string" || runId.trim().length === 0) {
        throw createDesktopError({
          code: "desktop.invalid_project_run_id",
          message: "desktop.stopProjectRun requires a run id.",
        });
      }
      return requireLocalCoreConnectionManager().executeOnce(
        async (client) => await client.stopDesktopProjectRun(runId),
      );
    },
  );
  ipcMain.handle(
    "desktop:restart-project-run",
    async (_event, runId: unknown): Promise<DesktopManagedProjectRun> => {
      if (typeof runId !== "string" || runId.trim().length === 0) {
        throw createDesktopError({
          code: "desktop.invalid_project_run_id",
          message: "desktop.restartProjectRun requires a run id.",
        });
      }
      return requireLocalCoreConnectionManager().executeOnce(
        async (client) => await client.restartDesktopProjectRun(runId),
      );
    },
  );
  ipcMain.handle(
    "desktop:get-mission-control-project",
    async (_event, projectId: unknown) =>
      getDesktopMissionControlProject({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        projectId,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:inspect-mission-control-project-setup",
    async (_event, projectIdValue: unknown) => {
      const projectId = requireMissionControlProjectId(projectIdValue);
      const project = desktopSettings.projects.find(
        (candidate) => candidate.id === projectId,
      );
      if (project === undefined) {
        throw createDesktopError({
          code: "desktop.unregistered_mission_control_project",
          message:
            "Mission Control project setup requires a registered project.",
        });
      }
      const catalog = await discoverWorkspaceValidationCatalog(project.path);
      return {
        projectId,
        projectPath: project.path,
        ...catalog,
      };
    },
  );
  ipcMain.handle(
    "desktop:execute-mission-control-action",
    async (_event, intent: unknown) =>
      executeDesktopMissionControlAction({
        intent,
        registeredProjectIds: desktopSettings.projects.flatMap((project) =>
          project.id === undefined ? [] : [project.id],
        ),
        profileForProject: async (projectId) => {
          const project = desktopSettings.projects.find(
            (candidate) => candidate.id === projectId,
          );
          if (project === undefined) {
            throw createDesktopError({
              code: "desktop.unregistered_mission_control_project",
              message:
                "Desktop Mission Control commands require a registered project.",
            });
          }
          const configuration =
            desktopSettings.modelConfigurations.find(
              (candidate) =>
                candidate.id === desktopSettings.defaultModelConfigurationId,
            ) ?? desktopSettings.modelConfigurations[0];
          if (configuration === undefined) {
            throw createDesktopError({
              code: "desktop.model_configuration_not_found",
              message: "Desktop has no default model configuration.",
            });
          }
          const requested: DesktopExecutionSelection = {
            modelConfiguration:
              currentDesktopModelConfigurationRef(configuration),
            apps: getEffectiveDesktopEnabledAppIds(desktopSettings).flatMap(
              (appId) => {
                const definition = getDesktopAppDefinition(
                  appId,
                  undefined,
                  desktopSettings.mcpServers,
                );
                return definition === undefined
                  ? []
                  : [
                      {
                        id: definition.id,
                        contractVersion: definition.contractVersion,
                      },
                    ];
              },
            ),
          };
          const resolution =
            await requireLocalCoreConnectionManager().executeIdempotent(
              async (client) =>
                await client.resolveExecutionProfile({
                  client: "desktop",
                  selection: resolveAuthoritativeDesktopExecutionSelection(
                    requested,
                    project.path,
                  ),
                }),
            );
          return {
            profileId: resolution.profileId,
            adapter: requireDesktopRunnerAdapter(
              runnerTransport,
              resolution.profileId,
              resolution.resolvedProfile,
            ),
          };
        },
        actionId: randomUUID(),
        actionTs: new Date().toISOString(),
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:get-operator-thread",
    async (_event, threadId: unknown) =>
      getDesktopOperatorThread({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        threadId,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:inspect-thread-authority",
    async (_event, threadId: unknown) =>
      inspectDesktopThreadAuthority({
        inspect: async () =>
          await getDesktopOperatorThread({
            adapter: requireDesktopRunnerAdapter(runnerTransport),
            threadId,
            context: DESKTOP_RUNNER_REQUEST_CONTEXT,
          }),
      }),
  );
  ipcMain.handle(
    "desktop:list-operator-runs",
    async (_event, query: unknown) =>
      await listDesktopOperatorRuns({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        query,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle("desktop:get-operator-run", async (_event, runId: unknown) =>
    getDesktopOperatorRun({
      adapter: requireDesktopRunnerAdapter(runnerTransport),
      runId,
      context: DESKTOP_RUNNER_REQUEST_CONTEXT,
    }),
  );
  ipcMain.handle(
    "desktop:get-workspace-lifecycle",
    async (_event, sessionId: unknown) =>
      getDesktopWorkspaceLifecycle({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        sessionId,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:capture-workspace-checkpoint",
    async (_event, request: unknown) =>
      captureDesktopWorkspaceCheckpoint({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:restore-workspace-checkpoint",
    async (_event, request: unknown) =>
      restoreDesktopWorkspaceCheckpoint({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:inspect-workspace-checkpoint",
    async (_event, request: unknown) =>
      inspectDesktopWorkspaceCheckpoint({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:compare-workspace-checkpoint",
    async (_event, request: unknown) =>
      compareDesktopWorkspaceCheckpoint({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:cleanup-workspace-checkpoints",
    async (_event, request: unknown) =>
      cleanupDesktopWorkspaceCheckpoints({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:preview-workspace-promotion",
    async (_event, request: unknown) =>
      previewDesktopWorkspacePromotion({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:apply-workspace-promotion",
    async (_event, request: unknown) =>
      applyDesktopWorkspacePromotion({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:undo-latest-workspace-promotion",
    async (_event, request: unknown) =>
      undoLatestDesktopWorkspacePromotion({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:inspect-managed-worktree",
    async (_event, request: unknown) =>
      inspectDesktopManagedWorktree({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:cleanup-managed-worktree",
    async (_event, request: unknown) =>
      cleanupDesktopManagedWorktree({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:restore-managed-worktree",
    async (_event, request: unknown) =>
      restoreDesktopManagedWorktree({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  ipcMain.handle(
    "desktop:retry-managed-worktree-setup",
    async (_event, request: unknown) =>
      retryDesktopManagedWorktreeSetup({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  for (const operation of [
    "start",
    "list",
    "read",
    "write",
    "resize",
    "stop",
  ] as const) {
    ipcMain.handle(
      `desktop:${operation}-user-terminal`,
      async (_event, request: unknown) =>
        runDesktopUserTerminalCommand({
          adapter: requireDesktopRunnerAdapter(runnerTransport),
          request,
          operation,
          context: DESKTOP_RUNNER_REQUEST_CONTEXT,
        }),
    );
  }
  ipcMain.handle(
    "desktop:inspect-workspace-changes",
    async (_event, request: unknown) => {
      const record =
        typeof request === "object" &&
        request !== null &&
        !Array.isArray(request)
          ? (request as Record<string, unknown>)
          : {};
      const sessionId =
        typeof record.sessionId === "string" ? record.sessionId.trim() : "";
      const threadId =
        typeof record.threadId === "string" ? record.threadId.trim() : "";
      const projectPath =
        typeof record.projectPath === "string"
          ? record.projectPath.trim()
          : undefined;
      if (sessionId.length > 0 && threadId.length > 0) {
        const workspace = resolveDesktopThreadWorkspace({
          ...(projectPath ? { projectPath } : {}),
          projects: desktopSettings.projects,
          defaultKestrelRoot: requireLocalCoreStatus().home.productRootPath,
        });
        await requireLocalCoreConnectionManager().executeOnce(
          async (client) =>
            await client.syncDesktopThreadWorkspace({
              sessionId,
              threadId,
              workspace,
            }),
        );
      }
      return inspectDesktopWorkspaceChanges({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      });
    },
  );
  ipcMain.handle(
    "desktop:mutate-workspace-changes",
    async (_event, request: unknown) =>
      mutateDesktopWorkspaceChanges({
        adapter: requireDesktopRunnerAdapter(runnerTransport),
        request,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  );
  for (const operation of ["add", "list", "remove", "submit"] as const) {
    ipcMain.handle(
      `desktop:${operation}-workspace-feedback`,
      async (_event, request: unknown) =>
        runDesktopWorkspaceFeedback({
          adapter: requireDesktopRunnerAdapter(runnerTransport),
          request,
          operation,
          context: DESKTOP_RUNNER_REQUEST_CONTEXT,
        }),
    );
  }
  for (const operation of ["run", "list", "update", "submit"] as const)
    ipcMain.handle(
      `desktop:${operation}-workspace-review`,
      async (_event, request: unknown) =>
        runDesktopWorkspaceReview({
          adapter: requireDesktopRunnerAdapter(runnerTransport),
          request,
          operation,
          context: DESKTOP_RUNNER_REQUEST_CONTEXT,
        }),
    );
  for (const operation of ["inspect", "run", "cancel", "submit"] as const)
    ipcMain.handle(
      `desktop:${operation}-workspace-validation`,
      async (_event, request: unknown) =>
        runDesktopWorkspaceValidation({
          adapter: requireDesktopRunnerAdapter(runnerTransport),
          request,
          operation,
          context: DESKTOP_RUNNER_REQUEST_CONTEXT,
        }),
    );
  for (const operation of ["inspect", "action"] as const)
    ipcMain.handle(
      `desktop:${operation}-workspace-git`,
      async (_event, request: unknown) =>
        runDesktopWorkspaceGit({
          adapter: requireDesktopRunnerAdapter(runnerTransport),
          request,
          operation,
          context: DESKTOP_RUNNER_REQUEST_CONTEXT,
        }),
    );
}

function requireBrowserPersonalDomainService(): DesktopBrowserPersonalDomainService {
  if (browserPersonalDomainService === undefined) {
    throw new Error("Desktop Browser personal-domain service is unavailable.");
  }
  return browserPersonalDomainService;
}

/** Trusted main-process entrypoint for the eventual Browser approval effect. */
export async function rememberBrowserPersonalDomainForCurrentAccount(
  input: DesktopBrowserPersonalDomainRememberRequest,
) {
  return await requireBrowserPersonalDomainService().remember(input);
}

async function openProjectRunPreviewWindow(
  run: DesktopManagedProjectRun,
  url: string,
): Promise<void> {
  const existing = projectRunPreviewWindows.get(run.runId);
  if (existing !== undefined && existing.isDestroyed() === false) {
    existing.setTitle(buildProjectRunPreviewTitle(run));
    await existing.loadURL(url);
    existing.show();
    existing.focus();
    return;
  }
  projectRunPreviewWindows.delete(run.runId);
  const previewWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#101315",
    show: false,
    title: buildProjectRunPreviewTitle(run),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  projectRunPreviewWindows.set(run.runId, previewWindow);
  previewWindow.on("ready-to-show", () => {
    previewWindow.show();
  });
  previewWindow.on("closed", () => {
    if (projectRunPreviewWindows.get(run.runId) === previewWindow) {
      projectRunPreviewWindows.delete(run.runId);
    }
  });
  previewWindow.webContents.setWindowOpenHandler(({ url: openedUrl }) => {
    if (/^https?:\/\//u.test(openedUrl)) {
      void shell.openExternal(openedUrl);
    }
    return { action: "deny" };
  });
  previewWindow.webContents.on("will-navigate", (event, nextUrl) => {
    if (/^https?:\/\//u.test(nextUrl) === false) {
      event.preventDefault();
    }
  });
  previewWindow.webContents.on("will-redirect", (event, nextUrl) => {
    if (/^https?:\/\//u.test(nextUrl) === false) {
      event.preventDefault();
    }
  });
  await previewWindow.loadURL(url);
}

function buildProjectRunPreviewTitle(run: DesktopManagedProjectRun): string {
  const projectName = path.basename(run.projectPath) || "Project";
  return `${projectName} ${run.scriptName} Preview - Kestrel`;
}

async function openFileEditorWindow(
  input: DesktopOpenFileEditorInput,
): Promise<void> {
  if (
    desktopConfig === undefined ||
    existsSync(desktopConfig.rendererHtmlPath) === false
  ) {
    throw createDesktopError({
      code: "desktop.renderer_unavailable",
      message: "Desktop renderer is not ready.",
    });
  }
  const resolvedProjectPath = path.resolve(input.projectPath);
  const resolvedFilePath = path.resolve(input.filePath);
  assertWithinRoot(resolvedProjectPath, resolvedFilePath, "filePath");
  const fileStats = await stat(resolvedFilePath);
  if (fileStats.isFile() === false) {
    throw createDesktopError({
      code: "desktop.invalid_editor_file",
      message: "desktop.openFileEditor requires a file path.",
    });
  }

  const editorQuery = {
    view: "editor",
    filePath: resolvedFilePath,
    projectPath: resolvedProjectPath,
    projectLabel: input.projectLabel,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.lineNumber !== undefined
      ? { lineNumber: String(input.lineNumber) }
      : {}),
    ...(input.columnNumber !== undefined
      ? { columnNumber: String(input.columnNumber) }
      : {}),
  };
  const existing = fileEditorWindows.get(resolvedFilePath);
  if (existing !== undefined && existing.isDestroyed() === false) {
    existing.setTitle(buildFileEditorTitle(resolvedFilePath));
    await existing.loadFile(desktopConfig.rendererHtmlPath, {
      query: editorQuery,
    });
    existing.show();
    existing.focus();
    return;
  }
  fileEditorWindows.delete(resolvedFilePath);

  const editorWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#101315",
    show: false,
    title: buildFileEditorTitle(resolvedFilePath),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  fileEditorWindows.set(resolvedFilePath, editorWindow);
  editorWindow.on("ready-to-show", () => {
    editorWindow.show();
  });
  editorWindow.on("closed", () => {
    if (fileEditorWindows.get(resolvedFilePath) === editorWindow) {
      fileEditorWindows.delete(resolvedFilePath);
    }
  });
  editorWindow.webContents.setWindowOpenHandler(({ url: openedUrl }) => {
    if (/^https?:\/\//u.test(openedUrl)) {
      void shell.openExternal(openedUrl);
    }
    return { action: "deny" };
  });
  await editorWindow.loadFile(desktopConfig.rendererHtmlPath, {
    query: editorQuery,
  });
}

function buildFileEditorTitle(filePath: string): string {
  return `${path.basename(filePath) || "File"} - Kestrel Editor`;
}

function ensureMediaPermissionHandler(window: BrowserWindow): void {
  if (mediaPermissionHandlerInstalled) {
    return;
  }
  mediaPermissionHandlerInstalled = true;
  window.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (permission !== "media") {
        callback(false);
        return;
      }
      const requestingOrigin = webContents.getURL();
      if (isTrustedDesktopOrigin(requestingOrigin) === false) {
        callback(false);
        return;
      }
      const requestedMediaTypes = Array.isArray(
        (details as { mediaTypes?: unknown }).mediaTypes,
      )
        ? (details as { mediaTypes: unknown[] }).mediaTypes
        : [];
      if (
        requestedMediaTypes.length > 0 &&
        requestedMediaTypes.includes("audio") === false
      ) {
        callback(false);
        return;
      }
      callback(true);
    },
  );
}

function isTrustedDesktopOrigin(value: string): boolean {
  if (value.trim().length === 0) {
    return true;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") {
      return true;
    }
    if (parsed.protocol !== "http:") {
      return false;
    }
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function readDesktopMicrophoneAccessState(): DesktopMicrophoneAccess["state"] {
  try {
    const state = systemPreferences.getMediaAccessStatus("microphone");
    if (
      state === "granted" ||
      state === "denied" ||
      state === "restricted" ||
      state === "not-determined"
    ) {
      return state;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function requestDesktopMicrophoneAccess(): Promise<DesktopMicrophoneAccess> {
  const currentState = readDesktopMicrophoneAccessState();
  if (currentState === "granted") {
    return {
      state: currentState,
      granted: true,
    };
  }
  if (process.platform === "darwin") {
    if (currentState === "denied" || currentState === "restricted") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      );
      return { state: currentState, granted: false };
    }
    const granted = await systemPreferences.askForMediaAccess("microphone");
    const state = readDesktopMicrophoneAccessState();
    return {
      state,
      granted: granted || state === "granted",
    };
  }
  return {
    state: currentState,
    granted: currentState !== "denied" && currentState !== "restricted",
  };
}

function syncDesktopWebEnvironment(settings: DesktopSettings): void {
  setOptionalEnv("OPENAI_API_KEY", settings.openaiApiKey);
}

function setOptionalEnv(name: string, value: string | undefined): void {
  if (typeof value === "string" && value.trim().length > 0) {
    process.env[name] = value.trim();
    return;
  }
  delete process.env[name];
}

function parseDesktopKestrelOneEnrollment(value: unknown): {
  baseUrl: string;
  desktopName: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Kestrel One enrollment must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.baseUrl !== "string" ||
    !record.baseUrl.trim() ||
    typeof record.desktopName !== "string" ||
    !record.desktopName.trim()
  ) {
    throw new Error("Kestrel One URL and Desktop name are required.");
  }
  return {
    baseUrl: record.baseUrl.trim(),
    desktopName: record.desktopName.trim(),
  };
}

function parseDesktopKestrelOneAuthorization(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Kestrel One authorization must be an object.");
  }
  const baseUrl = (value as Record<string, unknown>).baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error("Kestrel One URL is required.");
  }
  return baseUrl.trim();
}

function parseDesktopReceivingInput(
  value: unknown,
  requireDomain: true,
): {
  organizationId: string;
  receivingDomainId?: string | undefined;
  receivingDomain?: string | undefined;
  apiKey?: string | undefined;
};
function parseDesktopReceivingInput(
  value: unknown,
  requireDomain: false,
): { organizationId: string; apiKey?: string | undefined };
function parseDesktopReceivingInput(
  value: unknown,
  requireDomain: boolean,
):
  | {
      organizationId: string;
      receivingDomainId?: string | undefined;
      receivingDomain?: string | undefined;
      apiKey?: string | undefined;
    }
  | {
      organizationId: string;
      apiKey?: string | undefined;
    } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Kestrel One receiving request must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.organizationId !== "string" ||
    !record.organizationId.trim()
  ) {
    throw new Error("Kestrel One Organization ID is required.");
  }
  const receivingDomainId =
    typeof record.receivingDomainId === "string"
      ? record.receivingDomainId.trim()
      : "";
  const receivingDomain =
    typeof record.receivingDomain === "string"
      ? record.receivingDomain.trim().toLowerCase()
      : "";
  if (
    requireDomain &&
    (Boolean(receivingDomainId) === Boolean(receivingDomain) ||
      (receivingDomain &&
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.resend\.app$/u.test(
          receivingDomain,
        )))
  ) {
    throw new Error("A Resend receiving domain is required.");
  }
  return {
    organizationId: record.organizationId.trim(),
    ...(requireDomain
      ? receivingDomain
        ? { receivingDomain }
        : { receivingDomainId }
      : {}),
    ...(typeof record.apiKey === "string" && record.apiKey.trim()
      ? { apiKey: record.apiKey.trim() }
      : {}),
  };
}

function applyDesktopProfileOverride(settings: DesktopSettings): void {
  desktopProfileOverrideVersion += 1;
  globalThis.__kestrelDesktopProfileOverride = {
    presetId: settings.presetId,
    capabilityPacks: [...settings.capabilityPacks],
    version: desktopProfileOverrideVersion,
  };
}

async function parseDesktopProjectWatchRoot(
  rootPath: unknown,
  threadId: string | undefined,
  methodName: string,
): Promise<string> {
  if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_root_path",
      message: `${methodName} requires a project root path.`,
    });
  }
  const resolvedRoot = await resolveDesktopAuthorizedWorkspaceRoot(
    rootPath,
    threadId,
  );
  await resolveVerifiedDesktopPathTarget(
    { rootPath: resolvedRoot, targetPath: resolvedRoot },
    [resolvedRoot],
    "rootPath",
  );
  const rootStats = await stat(resolvedRoot);
  if (rootStats.isDirectory() === false) {
    throw createDesktopError({
      code: "desktop.invalid_root_path",
      message: `${methodName} requires a project directory path.`,
    });
  }
  return resolvedRoot;
}

function parseDesktopProjectUnwatchRoot(
  rootPath: unknown,
  methodName: string,
): string {
  if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_root_path",
      message: `${methodName} requires a project root path.`,
    });
  }
  return resolveDesktopProjectRootForWatcherCleanup(
    rootPath,
    registeredDesktopProjectRootPaths(),
    [...projectFileWatchers.keys()],
  );
}

function registeredDesktopProjectRootPaths(): string[] {
  return desktopSettings.projects.map((project) => project.path);
}

async function resolveDesktopAuthorizedWorkspaceRoot(
  rootPath: string,
  threadId: string | undefined,
): Promise<string> {
  return resolveDesktopWorkspaceAccessRoot({
    rootPath,
    registeredRootPaths: registeredDesktopProjectRootPaths(),
    ...(threadId !== undefined ? { threadId } : {}),
    getOperatorThread: async (authoritativeThreadId) =>
      getDesktopOperatorThread({
        adapter: requireDesktopRunnerAdapter(requireDesktopRunnerTransport()),
        threadId: authoritativeThreadId,
        context: DESKTOP_RUNNER_REQUEST_CONTEXT,
      }),
  });
}

function parseOptionalThreadId(value: unknown): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_operator_thread_id",
      message:
        "Desktop workspace access requires a non-empty runtime thread ID.",
    });
  }
  return value.trim();
}

function startProjectFileWatcher(rootPath: string, subscriberId: number): void {
  const existing = projectFileWatchers.get(rootPath);
  if (existing !== undefined) {
    existing.subscriberIds.add(subscriberId);
    return;
  }
  const subscriberIds = new Set<number>([subscriberId]);
  const watcherRecord: DesktopProjectFileWatcher = {
    rootPath,
    subscriberIds,
    watcher: undefined as unknown as FSWatcher,
  };
  watcherRecord.watcher = watch(
    rootPath,
    { recursive: true },
    (eventType, filename) => {
      queueProjectFilesChangedEvent(watcherRecord, eventType, filename);
    },
  );
  watcherRecord.watcher.on("error", (error) => {
    for (const id of watcherRecord.subscriberIds) {
      const target = webContents.fromId(id);
      if (target === undefined || target.isDestroyed()) {
        continue;
      }
      target.send("desktop:project-files-changed", {
        rootPath,
        eventType: "unknown",
        observedAt: new Date().toISOString(),
      } satisfies DesktopProjectFilesChangedEvent);
    }
    watcherRecord.watcher.close();
    projectFileWatchers.delete(rootPath);
    console.warn("Desktop project file watcher failed", { rootPath, error });
  });
  projectFileWatchers.set(rootPath, watcherRecord);
}

function stopProjectFileWatcher(rootPath: string, subscriberId: number): void {
  const existing = projectFileWatchers.get(rootPath);
  if (existing === undefined) {
    return;
  }
  existing.subscriberIds.delete(subscriberId);
  if (existing.subscriberIds.size > 0) {
    return;
  }
  if (existing.pendingTimer !== undefined) {
    clearTimeout(existing.pendingTimer);
  }
  existing.watcher.close();
  projectFileWatchers.delete(rootPath);
}

function queueProjectFilesChangedEvent(
  watcherRecord: DesktopProjectFileWatcher,
  rawEventType: string,
  filename: string | Buffer | null,
): void {
  const eventType =
    rawEventType === "change" || rawEventType === "rename"
      ? rawEventType
      : "unknown";
  const changedPath = resolveWatchedProjectFilePath(
    watcherRecord.rootPath,
    filename,
  );
  watcherRecord.latestEvent = {
    rootPath: watcherRecord.rootPath,
    eventType,
    observedAt: new Date().toISOString(),
    ...(changedPath !== undefined ? { changedPath } : {}),
  };
  projectFileIndex.invalidate(watcherRecord.rootPath);
  if (watcherRecord.pendingTimer !== undefined) {
    return;
  }
  watcherRecord.pendingTimer = setTimeout(() => {
    watcherRecord.pendingTimer = undefined;
    const event = watcherRecord.latestEvent;
    if (event === undefined) {
      return;
    }
    for (const id of [...watcherRecord.subscriberIds]) {
      const target = webContents.fromId(id);
      if (target === undefined || target.isDestroyed()) {
        watcherRecord.subscriberIds.delete(id);
        continue;
      }
      target.send("desktop:project-files-changed", event);
    }
    if (watcherRecord.subscriberIds.size === 0) {
      stopProjectFileWatcher(watcherRecord.rootPath, -1);
    }
  }, 100);
}

function resolveWatchedProjectFilePath(
  rootPath: string,
  filename: string | Buffer | null,
): string | undefined {
  if (filename === null) {
    return;
  }
  const candidatePath = path.resolve(rootPath, filename.toString());
  try {
    assertWithinRoot(rootPath, candidatePath, "changedPath");
    return candidatePath;
  } catch {
    return;
  }
}

function resolveFileViewKind(
  filePath: string,
): Pick<DesktopFileContent, "viewKind" | "language"> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".mdx") {
    return { viewKind: "markdown" };
  }
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".json",
      ".css",
      ".html",
      ".sh",
      ".bash",
      ".py",
      ".go",
      ".rs",
      ".sql",
      ".yaml",
      ".yml",
    ].includes(extension)
  ) {
    return {
      viewKind: "code",
      language: extension.slice(1),
    };
  }
  if ([".txt", ".log"].includes(extension) || extension.length === 0) {
    return { viewKind: "text" };
  }
  return { viewKind: "text" };
}

function parseDesktopFileReadInput(input: unknown): DesktopFileReadInput {
  return parseDesktopPathTargetInput(input, {
    methodName: "desktop.readFile",
    invalidInputCode: "desktop.invalid_read_input",
    invalidTargetCode: "desktop.invalid_read_path",
  });
}

function parseDesktopFileWriteInput(input: unknown): DesktopFileWriteInput {
  const pathInput = parseDesktopPathTargetInput(input, {
    methodName: "desktop.writeFile",
    invalidInputCode: "desktop.invalid_write_input",
    invalidTargetCode: "desktop.invalid_write_path",
  });
  const record = input as Record<string, unknown>;
  if (typeof record.content !== "string") {
    throw createDesktopError({
      code: "desktop.invalid_write_content",
      message: "desktop.writeFile requires string content.",
    });
  }
  if (
    record.expectedContentHash !== undefined &&
    typeof record.expectedContentHash !== "string"
  ) {
    throw createDesktopError({
      code: "desktop.invalid_write_hash",
      message: "desktop.writeFile expectedContentHash must be a string.",
    });
  }
  if (
    record.lineEnding !== undefined &&
    record.lineEnding !== "lf" &&
    record.lineEnding !== "crlf" &&
    record.lineEnding !== "cr" &&
    record.lineEnding !== "none"
  ) {
    throw createDesktopError({
      code: "desktop.invalid_write_line_ending",
      message: "desktop.writeFile lineEnding must be a writable line ending.",
    });
  }
  return {
    ...pathInput,
    content: record.content,
    ...(typeof record.expectedContentHash === "string"
      ? { expectedContentHash: record.expectedContentHash }
      : {}),
    ...(typeof record.lineEnding === "string"
      ? { lineEnding: record.lineEnding }
      : {}),
  };
}

function parseDesktopOpenFileEditorInput(
  input: unknown,
): DesktopOpenFileEditorInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw createDesktopError({
      code: "desktop.invalid_editor_input",
      message: "desktop.openFileEditor requires an editor request.",
    });
  }
  const record = input as Record<string, unknown>;
  if (
    typeof record.projectPath !== "string" ||
    record.projectPath.trim().length === 0
  ) {
    throw createDesktopError({
      code: "desktop.invalid_project_path",
      message: "desktop.openFileEditor requires a project path.",
    });
  }
  if (
    typeof record.filePath !== "string" ||
    record.filePath.trim().length === 0
  ) {
    throw createDesktopError({
      code: "desktop.invalid_editor_file",
      message: "desktop.openFileEditor requires a file path.",
    });
  }
  const threadId = parseOptionalThreadId(record.threadId);
  const lineNumber = parseOptionalSourcePosition(
    record.lineNumber,
    "lineNumber",
  );
  const columnNumber = parseOptionalSourcePosition(
    record.columnNumber,
    "columnNumber",
  );
  return {
    projectPath: record.projectPath,
    filePath: record.filePath,
    projectLabel:
      typeof record.projectLabel === "string" &&
      record.projectLabel.trim().length > 0
        ? record.projectLabel
        : path.basename(record.projectPath),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(lineNumber !== undefined ? { lineNumber } : {}),
    ...(columnNumber !== undefined ? { columnNumber } : {}),
  };
}

function parseOptionalSourcePosition(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== "number" ||
    Number.isInteger(value) === false ||
    value < 1 ||
    value > 10_000_000
  ) {
    throw createDesktopError({
      code: "desktop.invalid_editor_position",
      message: `desktop.openFileEditor ${field} must be a positive integer.`,
    });
  }
  return value;
}

async function readEditableTextFileBuffer(
  filePath: string,
  sizeBytes: number,
): Promise<Buffer> {
  assertReadableDesktopTextFile(filePath, sizeBytes);
  return readFile(filePath);
}

function assertReadableDesktopTextFile(
  filePath: string,
  sizeBytes: number,
): void {
  if (isBlockedBinaryFilePath(filePath)) {
    throw createDesktopError({
      code: "desktop.binary_file",
      message: "Kestrel Desktop edits UTF-8 source and text files only.",
    });
  }
  if (sizeBytes > READABLE_TEXT_FILE_MAX_BYTES) {
    throw createDesktopError({
      code: "desktop.file_too_large",
      message: "This file is too large to open in Kestrel Desktop.",
      details: `sizeBytes=${sizeBytes} maxBytes=${READABLE_TEXT_FILE_MAX_BYTES}`,
    });
  }
}

function assertWritableDesktopTextFile(
  filePath: string,
  sizeBytes: number,
): void {
  assertReadableDesktopTextFile(filePath, sizeBytes);
  if (sizeBytes > EDITABLE_TEXT_FILE_MAX_BYTES) {
    throw createDesktopError({
      code: "desktop.file_read_only_large",
      message: "This file is open read-only because it is larger than 1 MB.",
      details: `sizeBytes=${sizeBytes} maxBytes=${EDITABLE_TEXT_FILE_MAX_BYTES}`,
    });
  }
}

function assertWritableDesktopTextContent(content: string): void {
  if (detectLineEnding(content) === "mixed") {
    throw createDesktopError({
      code: "desktop.file_read_only_mixed_line_endings",
      message: "This file is open read-only because it has mixed line endings.",
    });
  }
}

function decodeUtf8TextFile(buffer: Buffer, filePath: string): string {
  if (buffer.includes(0)) {
    throw createDesktopError({
      code: "desktop.binary_file",
      message: "Kestrel Desktop edits UTF-8 source and text files only.",
    });
  }
  const content = buffer.toString("utf8");
  if (Buffer.from(content, "utf8").equals(buffer) === false) {
    throw createDesktopError({
      code: "desktop.unsupported_encoding",
      message: `${path.basename(filePath)} is not valid UTF-8 text.`,
    });
  }
  return content;
}

function isBlockedBinaryFilePath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (basename === ".ds_store") {
    return true;
  }
  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".tgz",
    ".mp3",
    ".mp4",
    ".mov",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".sqlite",
    ".db",
  ].includes(extension);
}

function detectLineEnding(
  content: string,
): NonNullable<DesktopFileContent["lineEnding"]> {
  const crlf = (content.match(/\r\n/gu) ?? []).length;
  const withoutCrlf = content.replace(/\r\n/gu, "");
  const lf = (withoutCrlf.match(/\n/gu) ?? []).length;
  const cr = (withoutCrlf.match(/\r/gu) ?? []).length;
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (kinds === 0) {
    return "none";
  }
  if (kinds > 1) {
    return "mixed";
  }
  if (crlf > 0) {
    return "crlf";
  }
  if (cr > 0) {
    return "cr";
  }
  return "lf";
}

function normalizeEditorLineEndings(content: string): string {
  return content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function applyLineEnding(
  content: string,
  lineEnding: NonNullable<DesktopFileWriteInput["lineEnding"]>,
): string {
  const normalized = normalizeEditorLineEndings(content);
  if (lineEnding === "crlf") {
    return normalized.replace(/\n/gu, "\r\n");
  }
  if (lineEnding === "cr") {
    return normalized.replace(/\n/gu, "\r");
  }
  return normalized;
}

function hashTextContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
  );
}

function parseDesktopUninstallPlanOptions(
  value: unknown,
): KestrelUninstallPlanOptions {
  if (value === undefined) return {};
  if (isRecord(value) === false) {
    throw createDesktopError({
      code: "desktop.invalid_input",
      message: "Desktop uninstall options must be an object.",
    });
  }
  rejectDesktopUnknownFields(
    value,
    new Set([
      "disconnectKestrelOne",
      "exportWorktreesDirectory",
      "discardWorktrees",
    ]),
    "Desktop uninstall options",
  );
  const options: KestrelUninstallPlanOptions = {};
  if (value.disconnectKestrelOne !== undefined) {
    if (typeof value.disconnectKestrelOne !== "boolean") {
      throw createDesktopError({
        code: "desktop.invalid_input",
        message: "Desktop uninstall disconnectKestrelOne must be a boolean.",
      });
    }
    options.disconnectKestrelOne = value.disconnectKestrelOne;
  }
  if (value.exportWorktreesDirectory !== undefined) {
    if (typeof value.exportWorktreesDirectory !== "string") {
      throw createDesktopError({
        code: "desktop.invalid_input",
        message: "Desktop uninstall exportWorktreesDirectory must be a string.",
      });
    }
    options.exportWorktreesDirectory = value.exportWorktreesDirectory;
  }
  if (value.discardWorktrees !== undefined) {
    if (typeof value.discardWorktrees !== "boolean") {
      throw createDesktopError({
        code: "desktop.invalid_input",
        message: "Desktop uninstall discardWorktrees must be a boolean.",
      });
    }
    options.discardWorktrees = value.discardWorktrees;
  }
  return options;
}

function parseDesktopUninstallApplyInput(
  value: unknown,
): DesktopUninstallApplyInput {
  const record = isRecord(value) ? value : undefined;
  if (record === undefined) {
    throw createDesktopError({
      code: "desktop.invalid_input",
      message: "Desktop uninstall apply input must be an object.",
    });
  }
  rejectDesktopUnknownFields(
    record,
    new Set([
      "plan",
      "confirmPlanId",
      "deleteDataPhrase",
      "discardWorktreesPhrase",
    ]),
    "Desktop uninstall apply input",
  );
  const plan = parseKestrelUninstallPlanV1(record.plan);
  if (plan.initiator !== "desktop") {
    throw createDesktopError({
      code: "desktop.invalid_input",
      message: "Desktop uninstall apply requires a Desktop-initiated plan.",
    });
  }
  if (typeof record.confirmPlanId !== "string") {
    throw createDesktopError({
      code: "desktop.invalid_input",
      message: "Desktop uninstall apply requires confirmPlanId.",
    });
  }
  return {
    plan,
    confirmPlanId: record.confirmPlanId,
    ...(record.deleteDataPhrase !== undefined
      ? {
          deleteDataPhrase: requireOptionalDesktopString(
            record.deleteDataPhrase,
            "deleteDataPhrase",
          ),
        }
      : {}),
    ...(record.discardWorktreesPhrase !== undefined
      ? {
          discardWorktreesPhrase: requireOptionalDesktopString(
            record.discardWorktreesPhrase,
            "discardWorktreesPhrase",
          ),
        }
      : {}),
  };
}

function rejectDesktopUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const field of Object.keys(value)) {
    if (allowed.has(field) === false) {
      throw createDesktopError({
        code: "desktop.invalid_input",
        message: `${label} has unsupported field '${field}'.`,
      });
    }
  }
}

function requireOptionalDesktopString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw createDesktopError({
      code: "desktop.invalid_input",
      message: `Desktop uninstall apply ${field} must be a string.`,
    });
  }
  return value;
}

async function applyDesktopUninstallPlan(
  input: DesktopUninstallApplyInput,
): Promise<KestrelUninstallApplyResultV1> {
  const helperTargets = selectedDesktopHelperTargets(input.plan.targets);
  const helperTargetIds = helperTargets.map((target) => target.id);
  const removesDesktopBundle = helperTargets.some(
    (target) => target.kind === "desktop_bundle",
  );
  if (removesDesktopBundle && app.isPackaged === false) {
    return blockedDesktopUninstallResult(input.plan, [
      {
        code: "DESKTOP_UNINSTALL_RELEASE_BUILD_REQUIRED",
        message:
          "Desktop app self-removal requires a packaged release-signed build.",
      },
    ]);
  }

  const coordinatorResult = await applyKestrelUninstallPlan({
    plan: input.plan,
    confirmPlanId: input.confirmPlanId,
    ...(input.deleteDataPhrase !== undefined
      ? { deleteDataPhrase: input.deleteDataPhrase }
      : {}),
    ...(input.discardWorktreesPhrase !== undefined
      ? { discardWorktreesPhrase: input.discardWorktreesPhrase }
      : {}),
    deferredTargetIds: helperTargetIds,
  });
  if (coordinatorResult.status === "blocked" || helperTargets.length === 0) {
    return coordinatorResult;
  }

  const helperReport = await runDesktopUninstallHelper(
    input.plan,
    helperTargets,
    {
      waitsForParentExit: true,
    },
  );
  const merged = mergeDesktopHelperReport(coordinatorResult, helperReport);
  if (
    globalThis.__kestrelDesktopUninstallHelperRunner === undefined &&
    helperReport.status !== "blocked"
  ) {
    setImmediate(() => {
      app.quit();
    });
  }
  return merged;
}

function selectedDesktopHelperTargets(
  targets: readonly KestrelUninstallTarget[],
): KestrelUninstallTarget[] {
  return targets.filter(
    (target) =>
      target.selected &&
      (target.kind === "desktop_bundle" ||
        target.kind === "state_root" ||
        target.kind === "electron_profile" ||
        target.kind === "preferences" ||
        target.kind === "cache" ||
        target.kind === "saved_state"),
  );
}

function blockedDesktopUninstallResult(
  plan: DesktopUninstallApplyInput["plan"],
  blockers: KestrelUninstallBlocker[],
): KestrelUninstallApplyResultV1 {
  return {
    version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
    planId: plan.planId,
    appliedAt: new Date().toISOString(),
    status: "blocked",
    removedTargets: [],
    skippedTargets: [],
    blockers,
    finalTargets: plan.targets,
    kestrelOneDisconnects: [],
    deferredCompletions: [],
  };
}

async function runDesktopUninstallHelper(
  plan: DesktopUninstallApplyInput["plan"],
  helperTargets: readonly KestrelUninstallTarget[],
  input: { waitsForParentExit: boolean },
): Promise<DesktopUninstallHelperReport> {
  if (/^[a-f0-9]{24}$/u.test(plan.planId) === false) {
    return {
      status: "blocked",
      removedTargets: [],
      failures: [
        {
          code: "DESKTOP_UNINSTALL_PLAN_ID_INVALID",
          message:
            "Desktop uninstall helper requires a coordinator-generated plan id.",
        },
      ],
      reportPath: "",
    };
  }
  const helperPath = path.join(
    process.resourcesPath,
    "kestrel-uninstall-helper",
  );
  const handoffRoot = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-desktop-uninstall-"),
  );
  await chmod(handoffRoot, 0o700);
  const planPath = path.join(handoffRoot, "plan.json");
  const reportBase = "/private/var/tmp/com.kestrel.uninstall";
  await mkdir(reportBase, { recursive: true, mode: 0o700 });
  const reportBaseStat = await lstat(reportBase);
  const currentUid = process.getuid?.();
  if (
    reportBaseStat.isDirectory() === false ||
    reportBaseStat.isSymbolicLink() ||
    (currentUid !== undefined && reportBaseStat.uid !== currentUid)
  ) {
    await rm(handoffRoot, { recursive: true, force: true });
    return {
      status: "blocked",
      removedTargets: [],
      failures: [
        {
          code: "DESKTOP_UNINSTALL_REPORT_ROOT_INVALID",
          message:
            "Desktop uninstall report root is not a verified current-user directory.",
        },
      ],
      reportPath: "",
    };
  }
  await chmod(reportBase, 0o700);
  const reportRoot = path.join(reportBase, plan.planId);
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  await chmod(reportRoot, 0o700);
  const reportPath = path.join(reportRoot, "desktop-helper.json");
  const helperPlan = {
    ...plan,
    targets: helperTargets,
  };
  await writeFile(planPath, `${JSON.stringify(helperPlan, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(planPath, 0o600);
  const runnerInput: DesktopUninstallHelperRunnerInput = {
    helperPath,
    planPath,
    reportPath,
    parentPid: process.pid,
    waitsForParentExit: input.waitsForParentExit,
  };
  if (globalThis.__kestrelDesktopUninstallHelperRunner !== undefined) {
    return await globalThis.__kestrelDesktopUninstallHelperRunner(runnerInput);
  }
  if (existsSync(helperPath) === false) {
    await rm(handoffRoot, { recursive: true, force: true });
    return {
      status: "blocked",
      removedTargets: [],
      failures: [
        {
          code: "DESKTOP_UNINSTALL_HELPER_MISSING",
          message: "Packaged Desktop uninstall helper is missing.",
        },
      ],
      reportPath,
    };
  }
  const child = spawn(
    helperPath,
    [
      "--plan",
      planPath,
      "--report",
      reportPath,
      "--parent-pid",
      String(process.pid),
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  return {
    status: "scheduled",
    removedTargets: [],
    failures: [
      {
        code: "DESKTOP_UNINSTALL_HELPER_SCHEDULED",
        message: `Desktop uninstall helper scheduled. Report: ${reportPath}`,
      },
    ],
    reportPath,
  };
}

function mergeDesktopHelperReport(
  coordinatorResult: KestrelUninstallApplyResultV1,
  helperReport: DesktopUninstallHelperReport,
): KestrelUninstallApplyResultV1 {
  const scheduled = helperReport.status === "scheduled";
  const helperBlockers = helperReport.failures
    .filter((failure) => failure.code !== "DESKTOP_UNINSTALL_HELPER_SCHEDULED")
    .map((failure) => ({
      code: failure.code,
      message: failure.message,
      ...(failure.targetId !== undefined ? { targetId: failure.targetId } : {}),
    }));
  const blockers = [...coordinatorResult.blockers, ...helperBlockers];
  const removedTargets = [
    ...coordinatorResult.removedTargets,
    ...helperReport.removedTargets,
  ];
  return {
    ...coordinatorResult,
    status: scheduled
      ? "partial"
      : blockers.length === 0
        ? coordinatorResult.status
        : removedTargets.length > 0 || helperReport.status === "partial"
          ? "partial"
          : "blocked",
    removedTargets,
    blockers,
    deferredCompletions: [
      ...coordinatorResult.deferredCompletions,
      {
        executor: "desktop_helper",
        state: scheduled ? "scheduled" : "complete",
        reportPath: helperReport.reportPath,
      },
    ],
  };
}

async function readPendingDesktopUninstallResult(): Promise<
  KestrelUninstallApplyResultV1 | undefined
> {
  const reportRoot = "/private/var/tmp/com.kestrel.uninstall";
  const planDirectories = await readdir(reportRoot, {
    withFileTypes: true,
  }).catch(() => []);
  const candidates: Array<{ path: string; modifiedAt: number }> = [];
  for (const directory of planDirectories) {
    if (
      directory.isDirectory() === false ||
      /^[a-f0-9]{24}$/u.test(directory.name) === false
    ) {
      continue;
    }
    const reportPath = path.join(
      reportRoot,
      directory.name,
      "desktop-helper.json",
    );
    const reportStat = await lstat(reportPath).catch(() => {});
    const currentUid = process.getuid?.();
    if (
      reportStat !== undefined &&
      reportStat.isFile() &&
      reportStat.isSymbolicLink() === false &&
      (reportStat.mode & 0o777) === 0o600 &&
      (currentUid === undefined || reportStat.uid === currentUid)
    ) {
      candidates.push({ path: reportPath, modifiedAt: reportStat.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const candidate of candidates) {
    try {
      const report = parseKestrelUninstallCompletionReportV1(
        JSON.parse(await readFile(candidate.path, "utf8")),
      );
      if (
        report.executor !== "desktop_helper" ||
        report.status === "complete" ||
        report.planId !== path.basename(path.dirname(candidate.path)) ||
        report.reportPath !== candidate.path
      ) {
        continue;
      }
      return {
        version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
        planId: report.planId,
        appliedAt: report.completedAt,
        status: report.status === "blocked" ? "blocked" : "partial",
        removedTargets: report.removedTargets,
        skippedTargets: [],
        blockers: report.failures.map((failure) => ({
          code: failure.code,
          message: failure.message,
          ...(failure.targetId !== undefined
            ? { targetId: failure.targetId }
            : {}),
        })),
        finalTargets: [],
        kestrelOneDisconnects: [],
        deferredCompletions: [
          {
            executor: "desktop_helper",
            state: "complete",
            reportPath: report.reportPath,
          },
        ],
      };
    } catch {
      // Ignore malformed or foreign report files.
    }
  }
  return;
}

function deriveRuntimeHealth(
  nextBootState: DesktopBootState,
): DesktopRuntimeHealth {
  const status = runnerTransport?.getStatus();
  const connection = localCoreConnectionState;
  if (databaseStatus.state === "blocked") {
    return {
      state: "blocked",
      connection,
      summary: databaseStatus.summary,
      details: databaseStatus.lastError?.details?.recommendedAction as
        | string
        | undefined,
      running: status?.running ?? false,
      ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
      database: databaseStatus,
    };
  }
  if (nextBootState.phase === "failed") {
    if (
      nextBootState.code === DESKTOP_LOCAL_CORE_EXECUTION_PROFILE_INCOMPATIBLE
    ) {
      return {
        state: "blocked",
        connection,
        summary: "Kestrel Local Core needs an update.",
        code: nextBootState.code,
        details: nextBootState.details,
        running: status?.running ?? false,
        ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
        database: databaseStatus,
      };
    }
    return {
      state: "blocked",
      connection,
      summary: nextBootState.message,
      ...(nextBootState.code !== undefined ? { code: nextBootState.code } : {}),
      ...(nextBootState.details !== undefined
        ? { details: nextBootState.details }
        : {}),
      running: status?.running ?? false,
      ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
      database: databaseStatus,
    };
  }
  if (nextBootState.phase === "ready" && connection !== "connected") {
    return {
      state: "degraded",
      connection,
      summary:
        connection === "connecting"
          ? "Reconnecting to Kestrel Local Core…"
          : "Kestrel Local Core is disconnected.",
      running: status?.running ?? false,
      ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
      database: databaseStatus,
    };
  }
  if (nextBootState.phase === "ready") {
    return {
      state: "healthy",
      connection,
      summary: "Runtime ready.",
      running: status?.running ?? false,
      ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
      database: databaseStatus,
    };
  }
  return {
    state: "degraded",
    connection,
    summary: nextBootState.message,
    ...(nextBootState.code !== undefined ? { code: nextBootState.code } : {}),
    ...(nextBootState.details !== undefined
      ? { details: nextBootState.details }
      : {}),
    running: status?.running ?? false,
    ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
    database: databaseStatus,
  };
}

function publishDesktopRuntimeHealth(): void {
  runtimeHealth = deriveRuntimeHealth(bootState);
  mainWindow?.webContents.send("desktop:runtime-health", runtimeHealth);
}

function updateBootState(
  nextState: DesktopBootState,
  webContents: WebContents | undefined,
): void {
  const updatedAt = new Date().toISOString();
  const previous = bootTimeline[bootTimeline.length - 1];
  if (
    previous === undefined ||
    previous.phase !== nextState.phase ||
    previous.message !== nextState.message
  ) {
    bootTimeline = [
      ...bootTimeline,
      {
        at: updatedAt,
        phase: nextState.phase,
        message: nextState.message,
      },
    ].slice(-12);
  }
  bootState = {
    ...nextState,
    ...(nextState.database !== undefined
      ? { database: nextState.database }
      : { database: databaseStatus }),
    startedAt: nextState.startedAt ?? bootStartedAt,
    updatedAt,
    timeline: bootTimeline,
  };
  runtimeHealth = deriveRuntimeHealth(nextState);
  bootState = {
    ...bootState,
    readiness: deriveDesktopBootReadiness(bootState, runtimeHealth),
  };
  webContents?.send("desktop:boot-state", bootState);
  webContents?.send("desktop:runtime-health", runtimeHealth);
}

function deriveDesktopBootReadiness(
  nextBootState: DesktopBootState,
  nextRuntimeHealth: DesktopRuntimeHealth,
): DesktopReadinessView {
  const resources = inspectDesktopResources();
  return deriveDesktopReadiness({
    isDesktopApp: true,
    bootState: nextBootState,
    runtimeHealth: nextRuntimeHealth,
    databaseStatus,
    settings: desktopSettings,
    providerConfigured:
      typeof desktopSettings.capabilityVerifications[
        `model.${desktopSettings.selectedProvider}`
      ] === "string",
    bridgeConnected: true,
    resourcesReady: resources.ready,
    resourcesDetail: resources.detail,
    settingsLoaded: true,
    projectCount: desktopSettings.projects.length,
  });
}

function inspectDesktopResources(): { ready: boolean; detail: string } {
  if (desktopConfig === undefined) {
    return {
      ready: false,
      detail: "Desktop path configuration is unavailable.",
    };
  }
  const checks = [
    ["repo", desktopConfig.repoRoot],
    ["boot", desktopConfig.bootHtmlPath],
    ["renderer", desktopConfig.rendererHtmlPath],
  ] as const;
  const missing = checks
    .filter(([, targetPath]) => existsSync(targetPath) === false)
    .map(([label]) => label);
  if (missing.length > 0) {
    return {
      ready: false,
      detail: `Missing ${missing.join(", ")} resource${missing.length === 1 ? "" : "s"}.`,
    };
  }
  return {
    ready: true,
    detail: desktopConfig.isPackaged
      ? "Packaged resources resolved."
      : "Development resources resolved from the repo.",
  };
}

async function prepareDesktopSettingsProjectRegistrations(
  projects: readonly DesktopProjectRegistration[],
): Promise<DesktopProjectRegistration[]> {
  const prepared = await prepareProjectRegistrationsForSettings(projects);
  projectFileIndex.retainRoots(prepared.map((project) => project.path));
  return prepared;
}

function requireLocalCoreConnectionManager(): LocalCoreConnectionManager {
  if (localCoreConnectionManager === undefined) {
    throw createDesktopError({
      code: "desktop.local_core_api_unavailable",
      message: "Kestrel Local Core API is unavailable.",
    });
  }
  return localCoreConnectionManager;
}

function requireLocalCoreStatus(): LocalCoreStatus {
  if (localCoreStatus === undefined) {
    throw createDesktopError({
      code: "desktop.local_core_unavailable",
      message: "Kestrel Local Core status is unavailable.",
    });
  }
  return localCoreStatus;
}

async function readDesktopCapabilityView(): Promise<DesktopCapabilityView> {
  const [credentials, discovery] = await Promise.all([
    requireLocalCoreConnectionManager().executeIdempotent(
      async (client) => await client.credentialStatus(),
    ),
    readDesktopMcpInventory(),
  ]);
  const microphone =
    process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus("microphone")
      : "unknown";
  const probes = await probeDesktopCapabilities({
    projects: desktopSettings.projects,
    databaseReady: databaseStatus?.state === "healthy",
    microphone,
    mcpServers: discovery.servers,
    settings: desktopSettings,
  });
  return resolveDesktopCapabilityView({
    settings: desktopSettings,
    credentials,
    probes,
  });
}

function parseDesktopThreadId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_attachment_thread",
      message: "Attachment thread ID must be a non-empty string.",
    });
  }
  return value.trim();
}

function parseDesktopAttachmentId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_attachment_id",
      message: "Attachment ID must be a non-empty string.",
    });
  }
  return value.trim();
}

function desktopAttachmentMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".json") return "application/json";
  if (extension === ".yaml" || extension === ".yml") return "application/yaml";
  if (extension === ".csv") return "text/csv";
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  return "text/plain";
}

async function readDesktopMcpInventory(): Promise<DesktopMcpDiscoveryResult> {
  const discovered = await discoverMcpServersFromKnownConfigFiles();
  const managedIds = new Set(
    desktopSettings.mcpServers.map((server) => server.id),
  );
  return {
    ...discovered,
    servers: [
      ...desktopSettings.mcpServers.map((server) => ({
        ...server,
        args: server.args !== undefined ? [...server.args] : undefined,
        tools: server.tools?.map((tool) => ({ ...tool })),
      })),
      ...discovered.servers.filter(
        (server) => managedIds.has(server.id) === false,
      ),
    ],
  };
}

function requireDesktopRunnerAdapter(
  transport: DesktopRunnerControlTransport,
  profileId?: string | undefined,
  resolvedProfile?: WebRunnerRegisteredProfileSnapshot | undefined,
): WebRunnerAdapter {
  const effectiveProfileId =
    profileId ?? requireDefaultDesktopRunnerProfileId();
  let adapter = desktopRunnerAdapters.get(effectiveProfileId);
  if (adapter === undefined) {
    if (resolvedProfile === undefined) {
      throw createDesktopError({
        code: "desktop.execution_profile_unavailable",
        message: "Desktop execution profile metadata is unavailable.",
      });
    }
    adapter = createWebRunnerAdapter({
      profileId: effectiveProfileId,
      resolvedProfile,
      transportFactory: () => transport,
    });
    desktopRunnerAdapters.set(effectiveProfileId, adapter);
  }
  return adapter;
}

function requireDefaultDesktopRunnerProfileId(): string {
  if (defaultDesktopRunnerProfileId === undefined) {
    throw createDesktopError({
      code: "desktop.execution_profile_unavailable",
      message: "Desktop has not resolved its Core-owned execution profile.",
    });
  }
  return defaultDesktopRunnerProfileId;
}

function requireDesktopRunnerTransport(): DesktopRunnerControlTransport {
  if (runnerTransport === undefined) {
    throw createDesktopError({
      code: "desktop.runtime_unavailable",
      message: "Kestrel Local Core runtime is unavailable.",
    });
  }
  return runnerTransport;
}

async function resetDesktopRunnerAdapter(): Promise<void> {
  const adapters = [...desktopRunnerAdapters.values()];
  desktopRunnerAdapters.clear();
  defaultDesktopRunnerProfileId = undefined;
  await Promise.all(adapters.map(async (adapter) => await adapter.close()));
  if (runnerTransport !== undefined) {
    await prepareDefaultDesktopRunnerAdapter(runnerTransport);
  }
}

async function prepareDefaultDesktopRunnerAdapter(
  transport: DesktopRunnerControlTransport,
): Promise<void> {
  const configuration =
    desktopSettings.modelConfigurations.find(
      (candidate) =>
        candidate.id === desktopSettings.defaultModelConfigurationId,
    ) ?? desktopSettings.modelConfigurations[0];
  if (configuration === undefined) {
    throw createDesktopError({
      code: "desktop.model_configuration_not_found",
      message: "Desktop has no default model configuration.",
    });
  }
  const apps = getEffectiveDesktopEnabledAppIds(desktopSettings).flatMap(
    (id) => {
      const definition = getDesktopAppDefinition(
        id,
        undefined,
        desktopSettings.mcpServers,
      );
      return definition === undefined
        ? []
        : [{ id: definition.id, contractVersion: definition.contractVersion }];
    },
  );
  const resolution =
    await requireLocalCoreConnectionManager().executeIdempotent(
      async (client) =>
        await client.resolveExecutionProfile({
          client: "desktop",
          selection: {
            modelConfiguration:
              currentDesktopModelConfigurationRef(configuration),
            apps,
          },
        }),
    );
  defaultDesktopRunnerProfileId = resolution.profileId;
  requireDesktopRunnerAdapter(
    transport,
    resolution.profileId,
    resolution.resolvedProfile,
  );
}

async function refreshDesktopCoreState(): Promise<void> {
  const response = await requireLocalCoreConnectionManager().executeIdempotent(
    async (client) => await client.desktopSettings<Partial<DesktopSettings>>(),
  );
  desktopSettings = normalizeDesktopSettings(response.settings, {
    fallbackModelPolicy: response.modelPolicy,
  });
  desktopModelPolicy = response.modelPolicy;
  projectFileIndex.retainRoots(
    desktopSettings.projects.map((project) => project.path),
  );
  await requireLocalCoreConnectionManager()
    .executeOnce(
      async (client) =>
        await client.syncKestrelOneProjects(desktopSettings.projects),
    )
    .catch(() => {
      // Kestrel One enrollment is optional and must not block Desktop startup.
    });
}

async function migrateDesktopCredentialsToLocalCore(): Promise<void> {
  const legacyCredentials: Array<{
    id: LocalCoreCredentialId;
    value: string | undefined;
  }> = [
    {
      id: "provider.openrouter.default",
      value: desktopSettings.openrouterApiKey,
    },
    { id: "provider.openai.default", value: desktopSettings.openaiApiKey },
    {
      id: "provider.anthropic.default",
      value: desktopSettings.anthropicApiKey,
    },
    { id: "tool.tavily.default", value: desktopSettings.tavilyApiKey },
    { id: "data.database.external", value: desktopSettings.databaseUrl },
  ];
  if (legacyCredentials.every((credential) => credential.value === undefined)) {
    return;
  }
  const manager = requireLocalCoreConnectionManager();
  const currentStatus = await manager.executeIdempotent(
    async (client) => await client.credentialStatus(),
  );
  if (currentStatus.available === false) {
    return;
  }
  for (const credential of legacyCredentials) {
    const legacyValue = credential.value;
    if (
      legacyValue !== undefined &&
      currentStatus.credentials.some(
        (status) => status.id === credential.id && status.configured,
      ) === false
    ) {
      await manager.executeOnce(
        async (client) =>
          await client.setCredential(credential.id, legacyValue),
      );
    }
  }
  await manager.executeOnce(
    async (client) =>
      await client.patchSettings({
        openrouterApiKey: null,
        openaiApiKey: null,
        anthropicApiKey: null,
        tavilyApiKey: null,
        databaseUrl: null,
      }),
  );
  await refreshDesktopCoreState();
}

async function saveDesktopCoreSettings(
  settings: Partial<DesktopSettings> & { modelPolicy?: unknown | undefined },
): Promise<void> {
  const normalized = normalizeDesktopSettings(settings, {
    fallbackModelPolicy: desktopModelPolicy,
  });
  const response = await requireLocalCoreConnectionManager().executeIdempotent(
    async (client) =>
      await client.patchDesktopSettings<Partial<DesktopSettings>>({
        ...normalized,
        ...(settings.modelPolicy !== undefined
          ? { modelPolicy: settings.modelPolicy }
          : {}),
      }),
  );
  desktopSettings = normalizeDesktopSettings(response.settings, {
    fallbackModelPolicy: response.modelPolicy,
  });
  desktopModelPolicy = response.modelPolicy;
  projectFileIndex.retainRoots(
    desktopSettings.projects.map((project) => project.path),
  );
}

async function applyDesktopModelCapabilityConfiguration(
  configuration: ReturnType<typeof parseDesktopCapabilityConfigurationInput>,
  options: {
    runnerTransport?: DesktopRunnerControlTransport | undefined;
    deferExecution: boolean;
    skipCredentialWrite?: boolean | undefined;
    onboardingRecord?: DesktopSettings["desktopOnboarding"] | undefined;
    mapVerificationError(error: unknown): never;
  },
): Promise<{ runtimeRestarted: boolean }> {
  const previousSettings = structuredClone(desktopSettings);
  const previousModelPolicy = structuredClone(desktopModelPolicy);
  let plan: ReturnType<typeof buildDesktopCapabilityConfigurationPlan>;
  try {
    plan = buildDesktopCapabilityConfigurationPlan({
      currentSettings: desktopSettings,
      currentModelPolicy: desktopModelPolicy,
      configuration,
    });
    const provider = plan.registration.modelProvider;
    if (provider === undefined) {
      throw new Error(
        `Capability '${configuration.capabilityId}' is not a model provider.`,
      );
    }
    if (plan.requiresVerification) {
      await verifyDesktopModelCapability({
        provider,
        settings: plan.settings,
        ...(typeof plan.credential?.value === "string"
          ? { apiKey: plan.credential.value }
          : {}),
      });
    }
  } catch (error) {
    return options.mapVerificationError(error);
  }

  const verifiedAt = new Date().toISOString();
  const capabilityVerifications = {
    ...plan.settings.capabilityVerifications,
  };
  if (plan.credential?.value === null) {
    delete capabilityVerifications[configuration.capabilityId];
  } else if (plan.requiresVerification) {
    capabilityVerifications[configuration.capabilityId] = verifiedAt;
  }
  await saveDesktopCoreSettings({
    ...plan.settings,
    capabilityVerifications,
    ...(configuration.enabled === true
      ? {
          providerSelectionCompletedAt:
            plan.settings.providerSelectionCompletedAt ?? verifiedAt,
        }
      : {}),
    ...(options.onboardingRecord !== undefined
      ? { desktopOnboarding: options.onboardingRecord }
      : {}),
    modelPolicy: plan.modelPolicy,
  });
  try {
    if (plan.credential?.value === null) {
      await requireLocalCoreConnectionManager().executeOnce(
        async (client) => await client.deleteCredential(plan.credential!.id),
      );
    } else if (
      typeof plan.credential?.value === "string" &&
      options.skipCredentialWrite !== true
    ) {
      await requireLocalCoreConnectionManager().executeOnce(
        async (client) =>
          await client.setCredential(
            plan.credential!.id,
            plan.credential!.value as string,
          ),
      );
    }
  } catch (error) {
    await saveDesktopCoreSettings({
      ...previousSettings,
      modelPolicy: previousModelPolicy,
    });
    throw createDesktopError({
      code: "desktop.capability_credential_apply_failed",
      message:
        "Desktop could not apply the verified credential. The previous configuration was preserved.",
      details: error instanceof Error ? error.message : String(error),
    });
  }

  syncDesktopWebEnvironment(desktopSettings);
  applyDesktopProfileOverride(desktopSettings);
  if (options.deferExecution) {
    return { runtimeRestarted: false };
  }

  await resetDesktopRunnerAdapter();
  let runtimeRestarted = false;
  if (plan.restartRuntime) {
    const transport = options.runnerTransport;
    if (transport === undefined) {
      throw createDesktopError({
        code: "desktop.runtime_unavailable",
        message: "Desktop runtime is unavailable for provider reconfiguration.",
      });
    }
    updateBootState(
      {
        phase: "starting_runtime",
        message: `Applying ${configuration.capabilityId} configuration…`,
        database: databaseStatus,
      },
      mainWindow?.webContents,
    );
    await transport.restart();
    runtimeRestarted = true;
    updateBootState(
      {
        phase: "ready",
        message: "Desktop ready.",
        database: databaseStatus,
      },
      mainWindow?.webContents,
    );
  }
  runtimeHealth = deriveRuntimeHealth(bootState);
  mainWindow?.webContents.send("desktop:runtime-health", runtimeHealth);
  return { runtimeRestarted };
}

function updateLaunchState(state: DesktopLaunchState): void {
  const readinessChanged =
    (launchState.phase === "ready") !== (state.phase === "ready");
  launchState = state;
  if (readinessChanged && app.isReady()) {
    installApplicationMenu();
  }
  if (mainWindow !== undefined && mainWindow.isDestroyed() === false) {
    mainWindow.webContents.send("desktop:launch-state", state);
  }
}

async function readDesktopOnboardingState(): Promise<DesktopOnboardingStateV1> {
  const record = desktopSettings.desktopOnboarding;
  const credentials =
    await requireLocalCoreConnectionManager().executeIdempotent(
      async (client) => await client.credentialStatus(),
    );
  const projects = await Promise.all(
    desktopSettings.projects.map(async (project) => ({
      path: project.path,
      label: project.label,
      available: await stat(project.path)
        .then((entry) => entry.isDirectory())
        .catch(() => false),
    })),
  );
  const provider = record?.provider ?? desktopSettings.selectedProvider;
  const model = record?.model ?? providerModel(desktopSettings, provider);
  const baseUrl = providerBaseUrl(desktopSettings, provider);
  const credentialConfigured =
    provider === "ollama" || provider === "lmstudio"
      ? true
      : credentials.credentials.some(
          (entry) =>
            entry.id === providerCredentialId(provider) && entry.configured,
        ) ||
        readApprovedPackageSmokeEnvironmentCredential(provider) !== undefined;
  const configuredModel = providerModel(desktopSettings, provider);
  const providerVerified =
    credentialConfigured &&
    typeof model === "string" &&
    model.length > 0 &&
    desktopSettings.selectedProvider === provider &&
    configuredModel === model &&
    typeof desktopSettings.capabilityVerifications[`model.${provider}`] ===
      "string";
  const projectPath = record?.projectPath;
  const projectReady =
    projectPath !== undefined &&
    projects.some(
      (project) => project.path === projectPath && project.available,
    );
  const hasExistingState =
    desktopSettings.providerSelectionCompletedAt !== undefined ||
    desktopSettings.setupCompletedAt !== undefined ||
    desktopSettings.projects.length > 0 ||
    Object.keys(desktopSettings.capabilityVerifications).length > 0;
  const { mode, step } = deriveDesktopOnboardingRouteV1({
    ...(record !== undefined ? { record } : {}),
    providerVerified,
    projectReady,
    hasExistingState,
  });
  return {
    version: 1,
    mode,
    step,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    providerVerified,
    credentialConfigured,
    secureStorageAvailable:
      credentials.available ||
      isApprovedPackageSmokeEnvironmentCredentialStore(),
    ...(projectPath !== undefined ? { projectPath } : {}),
    projects,
    canComplete: providerVerified && projectReady,
  };
}

async function saveDesktopOnboardingDraft(
  input: DesktopOnboardingDraftInput,
): Promise<DesktopOnboardingStateV1> {
  const current = desktopSettings.desktopOnboarding ?? {
    version: 1 as const,
    status: "in_progress" as const,
    startedAt: new Date().toISOString(),
  };
  await saveDesktopCoreSettings({
    ...desktopSettings,
    desktopOnboarding: {
      ...current,
      status: "in_progress",
      completedAt: undefined,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    },
  });
  return await readDesktopOnboardingState();
}

async function applyDesktopOnboardingProvider(
  input: DesktopOnboardingProviderInput,
): Promise<DesktopOnboardingProviderVerificationResult> {
  const capabilityId = `model.${input.provider}` as const;
  const approvedSmokeCredential =
    input.provider === "ollama" || input.provider === "lmstudio"
      ? undefined
      : readApprovedPackageSmokeEnvironmentCredential(input.provider);
  const usesApprovedSmokeCredential =
    approvedSmokeCredential !== undefined &&
    approvedSmokeCredential === input.credential;
  const credentialStatus =
    await requireLocalCoreConnectionManager().executeIdempotent(
      async (client) => await client.credentialStatus(),
    );
  if (
    input.provider !== "ollama" &&
    input.provider !== "lmstudio" &&
    credentialStatus.available === false &&
    usesApprovedSmokeCredential === false
  ) {
    return createDesktopOnboardingProviderFailure("secure_storage_unavailable");
  }
  const credentialId =
    input.provider === "ollama" || input.provider === "lmstudio"
      ? undefined
      : providerCredentialId(input.provider);
  const credentialConfigured =
    credentialId === undefined ||
    credentialStatus.credentials.some(
      (entry) => entry.id === credentialId && entry.configured,
    ) ||
    approvedSmokeCredential !== undefined;
  const alreadyVerified = canReuseDesktopOnboardingProviderVerification({
    requestedProvider: input.provider,
    requestedModel: input.model,
    activeProvider: desktopSettings.selectedProvider,
    activeModel: providerModel(desktopSettings, input.provider),
    credentialConfigured,
    verificationPresent:
      typeof desktopSettings.capabilityVerifications[capabilityId] === "string",
  });
  if (
    input.provider !== "ollama" &&
    input.provider !== "lmstudio" &&
    input.credential === undefined &&
    alreadyVerified
  ) {
    return {
      ok: true,
      state: await saveDesktopOnboardingDraft({
        provider: input.provider,
        model: input.model,
      }),
    };
  }
  if (
    input.provider !== "ollama" &&
    input.provider !== "lmstudio" &&
    input.credential === undefined
  ) {
    return createDesktopOnboardingProviderFailure("invalid_credential");
  }
  const configuration = parseDesktopCapabilityConfigurationInput({
    capabilityId,
    enabled: true,
    settings: {
      model: input.model,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    },
    ...(input.credential !== undefined ? { credential: input.credential } : {}),
  });
  const verifiedAt = new Date().toISOString();
  const currentRecord = desktopSettings.desktopOnboarding ?? {
    version: 1 as const,
    status: "in_progress" as const,
    startedAt: verifiedAt,
  };
  try {
    await applyDesktopModelCapabilityConfiguration(configuration, {
      deferExecution: true,
      skipCredentialWrite: usesApprovedSmokeCredential,
      onboardingRecord: {
        ...currentRecord,
        status: "in_progress",
        completedAt: undefined,
        provider: input.provider,
        model: input.model,
      },
      mapVerificationError(error): never {
        throw error;
      },
    });
  } catch (error) {
    if (error instanceof DesktopModelProviderVerificationError) {
      return createDesktopOnboardingProviderFailure(error.kind);
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "desktop.capability_credential_apply_failed"
    ) {
      return createDesktopOnboardingProviderFailure(
        "secure_storage_unavailable",
      );
    }
    throw error;
  }
  return { ok: true, state: await readDesktopOnboardingState() };
}

async function createDesktopOnboardingProjectCandidate(
  selectedPath: string,
  selectionSource:
    | { source: "picker" }
    | { source: "registered"; registeredPath: string },
): Promise<DesktopOnboardingProjectCandidate> {
  const canonicalPath = await realpath(path.resolve(selectedPath));
  const inspection = await inspectDesktopProjectGitBootstrap(canonicalPath);
  const selectionId = randomUUID();
  const publicCandidate = {
    path: canonicalPath,
    label: path.basename(canonicalPath),
    kind: inspection.kind,
    requiresGitBootstrap: inspection.requiresGitBootstrap,
  } satisfies Omit<DesktopOnboardingProjectCandidate, "selectionId">;
  const candidate =
    selectionSource.source === "picker"
      ? {
          ...publicCandidate,
          source: "picker" as const,
          selectedPath: path.resolve(selectedPath),
        }
      : { ...publicCandidate, ...selectionSource };
  onboardingProjectSelections.set(selectionId, candidate);
  return { selectionId, ...publicCandidate };
}

async function confirmDesktopOnboardingProject(input: {
  selectionId: string;
  allowGitBootstrap: boolean;
}): Promise<DesktopOnboardingStateV1> {
  const candidate = onboardingProjectSelections.get(input.selectionId);
  if (candidate === undefined) {
    throw createDesktopError({
      code: "desktop.onboarding_project_selection_expired",
      message: "Select the project folder again.",
    });
  }
  if (candidate.source === "registered") {
    const stillRegistered = desktopSettings.projects.some(
      (project) => project.path === candidate.registeredPath,
    );
    const registeredCanonicalPath = stillRegistered
      ? await realpath(candidate.registeredPath).catch(() => {})
      : undefined;
    if (
      stillRegistered === false ||
      registeredCanonicalPath !== candidate.path
    ) {
      throw createDesktopError({
        code: "desktop.onboarding_project_changed",
        message: "The registered project changed. Select it again.",
      });
    }
  } else {
    const selectedCanonicalPath = await realpath(candidate.selectedPath).catch(
      () => {},
    );
    if (selectedCanonicalPath !== candidate.path) {
      throw createDesktopError({
        code: "desktop.onboarding_project_changed",
        message: "The selected project path changed. Select it again.",
      });
    }
  }
  const canonicalPath = await realpath(candidate.path);
  if (canonicalPath !== candidate.path) {
    throw createDesktopError({
      code: "desktop.onboarding_project_changed",
      message: "The selected project path changed. Select it again.",
    });
  }
  const inspection = await inspectDesktopProjectGitBootstrap(canonicalPath);
  if (
    inspection.kind !== candidate.kind ||
    inspection.requiresGitBootstrap !== candidate.requiresGitBootstrap
  ) {
    throw createDesktopError({
      code: "desktop.onboarding_project_changed",
      message: "The selected project changed. Review it and try again.",
    });
  }
  if (inspection.requiresGitBootstrap && input.allowGitBootstrap === false) {
    throw createDesktopError({
      code: "desktop.onboarding_git_confirmation_required",
      message: "Confirm the initial Git commit before continuing.",
    });
  }
  if (inspection.requiresGitBootstrap) {
    await ensureDesktopProjectGitBootstrap(canonicalPath, {
      allowNonEmptyGitWithoutHeadBootstrap: true,
    });
  }
  const now = new Date().toISOString();
  const projectPath =
    candidate.source === "registered"
      ? candidate.registeredPath
      : canonicalPath;
  const projects = desktopSettings.projects.some(
    (project) => project.path === projectPath,
  )
    ? desktopSettings.projects
    : [
        ...desktopSettings.projects,
        { path: projectPath, label: candidate.label, addedAt: now },
      ];
  const record = desktopSettings.desktopOnboarding ?? {
    version: 1 as const,
    status: "in_progress" as const,
    startedAt: now,
  };
  await saveDesktopCoreSettings({
    ...desktopSettings,
    projects,
    desktopOnboarding: {
      ...record,
      status: "in_progress",
      completedAt: undefined,
      projectPath,
    },
  });
  await requireLocalCoreConnectionManager()
    .executeOnce(
      async (client) => await client.syncKestrelOneProjects(projects),
    )
    .catch(() => {
      // Kestrel One is optional and must not block local project onboarding.
    });
  onboardingProjectSelections.delete(input.selectionId);
  return await readDesktopOnboardingState();
}

async function completeDesktopOnboarding(): Promise<DesktopLaunchState> {
  const onboarding = await readDesktopOnboardingState();
  if (onboarding.canComplete === false) {
    throw createDesktopError({
      code: "desktop.onboarding_incomplete",
      message: "Verify a model and choose an available project first.",
    });
  }
  try {
    await ensureDesktopOnboardingModelIsDefault(onboarding);
    await startDesktopExecutionServices();
    const confirmedOnboarding = await readDesktopOnboardingState();
    if (confirmedOnboarding.canComplete === false) {
      throw createDesktopError({
        code: "desktop.onboarding_changed_during_startup",
        message:
          "Model or project setup changed while Kestrel was starting. Review the setup and retry.",
      });
    }
    const completedAt = new Date().toISOString();
    const record = desktopSettings.desktopOnboarding!;
    const handoffId = record.handoffId ?? randomUUID();
    await saveDesktopCoreSettings({
      ...desktopSettings,
      providerSelectionCompletedAt:
        desktopSettings.providerSelectionCompletedAt ?? completedAt,
      setupCompletedAt: completedAt,
      desktopOnboarding: {
        ...record,
        status: "complete",
        completedAt,
        handoffId,
      },
    });
    updateLaunchState(buildDesktopReadyLaunchState());
    return launchState;
  } catch (error) {
    updateLaunchState({
      phase: "setup_required",
      message: "Kestrel could not start for this setup.",
      details: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function ensureDesktopOnboardingModelIsDefault(
  onboarding: DesktopOnboardingStateV1,
): Promise<void> {
  if (onboarding.provider === undefined || onboarding.model === undefined) {
    throw createDesktopError({
      code: "desktop.onboarding_model_missing",
      message: "The verified onboarding model is unavailable.",
    });
  }
  const authoritativeModelPolicy: ResolvedModelPolicy = {
    ...desktopModelPolicy,
    provider: onboarding.provider,
    model: onboarding.model,
  };
  const promotedSettings = promoteDesktopDefaultModelConfiguration(
    desktopSettings,
    authoritativeModelPolicy,
  );
  if (promotedSettings === desktopSettings) {
    return;
  }
  await saveDesktopCoreSettings({
    ...promotedSettings,
    modelPolicy: authoritativeModelPolicy,
  });
}

async function ensureCompletedDesktopOnboardingHandoff(): Promise<void> {
  const record = desktopSettings.desktopOnboarding;
  if (record?.status !== "complete" || record.handoffId !== undefined) {
    return;
  }
  await saveDesktopCoreSettings({
    ...desktopSettings,
    desktopOnboarding: {
      ...record,
      handoffId: randomUUID(),
    },
  });
}

async function acknowledgePersistedDesktopOnboardingHandoff(
  entries: DesktopLegacyUiStateEntries,
): Promise<void> {
  const record = desktopSettings.desktopOnboarding;
  if (
    record?.status !== "complete" ||
    record.handoffId === undefined ||
    record.handoffAcknowledgedAt !== undefined ||
    desktopUiStateContainsOnboardingHandoff(entries, record.handoffId) === false
  ) {
    return;
  }
  await saveDesktopCoreSettings({
    ...desktopSettings,
    desktopOnboarding: {
      ...record,
      handoffAcknowledgedAt: new Date().toISOString(),
    },
  });
  updateLaunchState(buildDesktopReadyLaunchState());
}

function buildDesktopReadyLaunchState(): DesktopLaunchState {
  const record = desktopSettings.desktopOnboarding;
  const projectAvailable =
    record?.projectPath !== undefined &&
    desktopSettings.projects.some(
      (project) => project.path === record.projectPath,
    );
  return {
    phase: "ready",
    message: "Kestrel is ready.",
    ...(record?.status === "complete" &&
    record.handoffId !== undefined &&
    record.handoffAcknowledgedAt === undefined &&
    projectAvailable
      ? {
          onboardingHandoff: {
            id: record.handoffId,
            projectPath: record.projectPath!,
          },
        }
      : {}),
  };
}

function parseDesktopOnboardingProvider(value: unknown): DesktopModelProvider {
  if (
    value !== "openrouter" &&
    value !== "openai" &&
    value !== "anthropic" &&
    value !== "ollama" &&
    value !== "lmstudio"
  ) {
    throw createDesktopError({
      code: "desktop.invalid_model_provider",
      message: "Desktop model provider is invalid.",
    });
  }
  return value;
}

function parseDesktopRendererBootstrapReport(
  value: unknown,
): DesktopRendererBootstrapReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Renderer bootstrap report must be an object.");
  }
  const record = value as Record<string, unknown>;
  const supported = new Set(["generation", "status", "reason"]);
  if (
    Object.keys(record).some((key) => supported.has(key) === false) ||
    typeof record.generation !== "number" ||
    Number.isSafeInteger(record.generation) === false ||
    record.generation < 1
  ) {
    throw new Error("Renderer bootstrap report is invalid.");
  }
  if (record.status === "ready" && record.reason === undefined) {
    return { generation: record.generation, status: "ready" };
  }
  if (
    record.status === "failed" &&
    (record.reason === "react_error" || record.reason === "stylesheet_missing")
  ) {
    return {
      generation: record.generation,
      status: "failed",
      reason: record.reason,
    };
  }
  throw new Error("Renderer bootstrap report status is invalid.");
}

function parseDesktopOnboardingDraftInput(
  value: unknown,
): DesktopOnboardingDraftInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Onboarding draft must be an object.");
  }
  const record = value as Record<string, unknown>;
  const supported = new Set(["provider", "model"]);
  if (Object.keys(record).some((key) => supported.has(key) === false)) {
    throw new Error("Onboarding draft contains unsupported fields.");
  }
  return {
    ...(record.provider !== undefined
      ? { provider: parseDesktopOnboardingProvider(record.provider) }
      : {}),
    ...(record.model !== undefined
      ? { model: parseNonEmptyOnboardingText(record.model, "model") }
      : {}),
  };
}

function parseDesktopOnboardingProviderInput(
  value: unknown,
): DesktopOnboardingProviderInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider setup must be an object.");
  }
  const record = value as Record<string, unknown>;
  const supported = new Set(["provider", "model", "baseUrl", "credential"]);
  if (Object.keys(record).some((key) => supported.has(key) === false)) {
    throw new Error("Provider setup contains unsupported fields.");
  }
  const provider = parseDesktopOnboardingProvider(record.provider);
  if (
    record.baseUrl !== undefined &&
    provider !== "ollama" &&
    provider !== "lmstudio"
  ) {
    throw new Error("Hosted onboarding providers do not accept a base URL.");
  }
  const baseUrl =
    record.baseUrl === undefined
      ? undefined
      : parseDesktopProviderModelCatalogRequest({
          provider,
          baseUrl: record.baseUrl,
        }).baseUrl;
  const credential =
    record.credential === undefined
      ? undefined
      : parseNonEmptyOnboardingText(record.credential, "API key", false);
  return {
    provider,
    model: parseNonEmptyOnboardingText(record.model, "model"),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(credential !== undefined ? { credential } : {}),
  };
}

function parseDesktopOnboardingProjectConfirmation(value: unknown): {
  selectionId: string;
  allowGitBootstrap: boolean;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Project confirmation must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "selectionId" && key !== "allowGitBootstrap",
    ) ||
    typeof record.allowGitBootstrap !== "boolean"
  ) {
    throw new Error("Project confirmation is invalid.");
  }
  return {
    selectionId: parseNonEmptyOnboardingText(
      record.selectionId,
      "selection ID",
    ),
    allowGitBootstrap: record.allowGitBootstrap,
  };
}

function parseNonEmptyOnboardingText(
  value: unknown,
  label: string,
  trim = true,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Onboarding ${label} is required.`);
  }
  const normalized = trim ? value.trim() : value;
  if (
    normalized.length === 0 ||
    (trim === false && normalized.trim() !== normalized) ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`Onboarding ${label} is invalid.`);
  }
  return normalized;
}

function providerCredentialId(
  provider: Exclude<DesktopModelProvider, "ollama" | "lmstudio">,
): LocalCoreCredentialId {
  if (provider === "openrouter") return "provider.openrouter.default";
  if (provider === "openai") return "provider.openai.default";
  return "provider.anthropic.default";
}

function isApprovedPackageSmokeEnvironmentCredentialStore(): boolean {
  return (
    app.isPackaged &&
    process.env.KESTREL_DESKTOP_PACKAGE_SMOKE_APPROVED === "1" &&
    process.env.KESTREL_CORE_CREDENTIAL_STORE === "environment"
  );
}

function readApprovedPackageSmokeEnvironmentCredential(
  provider: Exclude<DesktopModelProvider, "ollama" | "lmstudio">,
): string | undefined {
  if (isApprovedPackageSmokeEnvironmentCredentialStore() === false) {
    return;
  }
  const value =
    provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY
      : provider === "openai"
        ? process.env.OPENAI_API_KEY
        : process.env.ANTHROPIC_API_KEY;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readApprovedPackageSmokeProjectPath(): string | undefined {
  if (isApprovedPackageSmokeEnvironmentCredentialStore() === false) {
    return;
  }
  const value = process.env.KESTREL_DESKTOP_PACKAGE_SMOKE_PROJECT_PATH;
  return typeof value === "string" && value.trim().length > 0
    ? path.resolve(value.trim())
    : undefined;
}

function providerModel(
  settings: DesktopSettings,
  provider: DesktopModelProvider,
): string | undefined {
  if (provider === "openrouter") return settings.openrouterModel;
  if (provider === "openai") return settings.openaiModel;
  if (provider === "anthropic") return settings.anthropicModel;
  if (provider === "ollama") return settings.ollamaModel;
  return settings.lmstudioModel;
}

function providerBaseUrl(
  settings: DesktopSettings,
  provider: DesktopModelProvider,
): string | undefined {
  if (provider === "openrouter") return settings.openrouterBaseUrl;
  if (provider === "openai") return settings.openaiBaseUrl;
  if (provider === "anthropic") return settings.anthropicBaseUrl;
  if (provider === "ollama") return settings.ollamaBaseUrl;
  return settings.lmstudioBaseUrl;
}

function currentProviderModel(settings: DesktopSettings): string | undefined {
  return providerModel(settings, settings.selectedProvider);
}

async function persistDesktopRendererConfiguration(
  runner: DesktopRunnerControlTransport,
  input: {
    settings: Partial<DesktopSettings> & { modelPolicy?: unknown | undefined };
    restartRuntime: boolean;
    resetRunnerProfile: boolean;
    restartMessage: string;
  },
): Promise<DesktopRendererSettings> {
  if (desktopConfig === undefined) {
    throw createDesktopError({
      code: "desktop.config_unavailable",
      message: "Local Kestrel settings are unavailable.",
    });
  }
  await saveDesktopCoreSettings(input.settings);
  syncDesktopWebEnvironment(desktopSettings);
  applyDesktopProfileOverride(desktopSettings);
  if (input.resetRunnerProfile) {
    await resetDesktopRunnerAdapter();
  }
  if (input.restartRuntime) {
    updateBootState(
      {
        phase: "starting_runtime",
        message: input.restartMessage,
        database: databaseStatus,
      },
      mainWindow?.webContents,
    );
    await runner.restart();
    updateBootState(
      {
        phase: "ready",
        message: "Desktop ready.",
        database: databaseStatus,
      },
      mainWindow?.webContents,
    );
  }
  runtimeHealth = deriveRuntimeHealth(bootState);
  mainWindow?.webContents.send("desktop:runtime-health", runtimeHealth);
  return await readDesktopRendererSettings();
}

async function readDesktopRendererSettings(): Promise<DesktopRendererSettings> {
  const selectedProvider = desktopSettings.selectedProvider;
  if (selectedProvider === "ollama" || selectedProvider === "lmstudio") {
    return toDesktopRendererSettings(
      desktopSettings,
      new Set([selectedProvider]),
    );
  }
  const status = await requireLocalCoreConnectionManager().executeIdempotent(
    async (client) => await client.credentialStatus(),
  );
  const configuredProviders = new Set<DesktopModelProvider>();
  for (const provider of ["openrouter", "openai", "anthropic"] as const) {
    if (
      status.credentials.some(
        (credential) =>
          credential.id === `provider.${provider}.default` &&
          credential.configured,
      )
    ) {
      configuredProviders.add(provider);
    }
  }
  return toDesktopRendererSettings(desktopSettings, configuredProviders);
}

function subscribeToCoreProjectRuns(client?: LocalCoreClient): void {
  const activeClient =
    client ?? requireLocalCoreConnectionManager().current()?.client;
  if (activeClient === undefined) {
    throw createDesktopError({
      code: "desktop.local_core_api_unavailable",
      message: "Kestrel Local Core API is unavailable.",
    });
  }
  unsubscribeProjectRunEvents?.();
  unsubscribeProjectRunEvents = activeClient.subscribeDesktopProjectRuns({
    onRuns(runs) {
      mainWindow?.webContents.send("desktop:project-runs", runs);
    },
    onError(error) {
      const manager = requireLocalCoreConnectionManager();
      manager.invalidate(activeClient);
      console.warn("Desktop project run event stream failed", {
        phase: "disconnected",
        code: (error as NodeJS.ErrnoException).code,
        error,
      });
      void manager.ensureConnected().catch((recoveryError: unknown) => {
        console.warn("Desktop project run event stream recovery failed", {
          phase: "reconnect_failed",
          disconnectCode: (error as NodeJS.ErrnoException).code,
          recoveryCode: (recoveryError as NodeJS.ErrnoException | undefined)
            ?.code,
          error: recoveryError,
        });
      });
    },
  });
}

async function stopCoreProjectRuns(): Promise<void> {
  const client = localCoreConnectionManager?.current()?.client;
  if (client === undefined) {
    return;
  }
  const runs = await client.listDesktopProjectRuns();
  await Promise.all(
    runs
      .filter((run) => run.status === "running" || run.status === "stopping")
      .map((run) => client.stopDesktopProjectRun(run.runId)),
  );
}

async function getDesktopUpdateBlockers(): Promise<DesktopUpdateBlocker[]> {
  const blockers = getDesktopActivityBlockers();
  const client = localCoreConnectionManager?.current()?.client;
  if (client !== undefined) {
    const lifecycle = await client.systemLifecycle();
    blockers.push(
      ...lifecycle.blockers.map((blocker) => ({
        source: "local_core" as const,
        ...blocker,
      })),
    );
  }
  return blockers;
}

function getDesktopActivityBlockers(): DesktopUpdateBlocker[] {
  const blockers: DesktopUpdateBlocker[] = [];
  if (
    [...activeDesktopWorkspaceRunCounts.values()].some((count) => count > 0)
  ) {
    blockers.push({
      source: "desktop",
      code: "DESKTOP_EXECUTIONS_ACTIVE",
      message: "Desktop workspace executions are active.",
      count: [...activeDesktopWorkspaceRunCounts.values()].reduce(
        (total, count) => total + count,
        0,
      ),
    });
  }
  const authorizationCount =
    microsoft365AuthorizationSessionIds.size +
    googleWorkspaceAuthorizationSessionIds.size +
    mcpAuthorizationSessionIds.size;
  if (authorizationCount > 0) {
    blockers.push({
      source: "desktop",
      code: "DESKTOP_AUTHORIZATION_ACTIVE",
      message: "Desktop authorization sessions are active.",
      count: authorizationCount,
    });
  }
  return blockers;
}

function assertDesktopAdmissionOpen(operation: string): void {
  if (!desktopAdmissionClosed) return;
  throw createDesktopError({
    code: "desktop.admission_closed",
    message: `Kestrel cannot begin ${operation} while preparing to restart.`,
  });
}

async function prepareDesktopUpdateInstallation(
  preparation: DesktopShutdownPreparation,
): Promise<DesktopUpdateBlocker[]> {
  desktopAdmissionClosed = true;
  const desktopBlockers = getDesktopActivityBlockers();
  if (desktopBlockers.length > 0) {
    desktopAdmissionClosed = false;
    return desktopBlockers;
  }
  const client = localCoreConnectionManager?.current()?.client;
  if (client !== undefined) {
    const shutdown = await client.shutdownForDesktopUpdate();
    if (shutdown.status === "blocked") {
      desktopAdmissionClosed = false;
      return shutdown.lifecycle.blockers.map((blocker) => ({
        source: "local_core",
        ...blocker,
      }));
    }
  }
  await preparation.prepare({ cancelActiveWork: false });
  return [];
}

async function restartLocalCoreForDatabaseSettingsChange(): Promise<void> {
  localCoreStatus = await requireLocalCoreConnectionManager().executeOnce(
    async (client) => await client.restartExecutionBundle(),
  );
  currentDatabaseUrl = localCoreStatus.databaseUrl;
}

async function resolveCoreProjectRunPreviewUrl(input: {
  runId: string;
  url?: string | undefined;
}): Promise<{
  run: DesktopManagedProjectRun;
  url: string;
}> {
  const run = (
    await requireLocalCoreConnectionManager().executeIdempotent(
      async (client) => await client.listDesktopProjectRuns(),
    )
  ).find((entry) => entry.runId === input.runId);
  if (run === undefined) {
    throw createDesktopError({
      code: "desktop.project_run_not_found",
      message: "The selected project run no longer exists.",
    });
  }
  const requestedUrl = input.url ?? run.primaryPreviewUrl;
  if (typeof requestedUrl !== "string" || requestedUrl.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.project_run_preview_url_missing",
      message: "The selected project run has not emitted a preview URL.",
    });
  }
  if (isPreviewableHttpUrl(requestedUrl) === false) {
    throw createDesktopError({
      code: "desktop.invalid_project_run_preview_url",
      message:
        "Project run previews require an http(s) URL without embedded credentials.",
    });
  }
  const matchedUrl = run.previewUrls?.find(
    (entry) => entry.url === requestedUrl,
  )?.url;
  if (matchedUrl === undefined) {
    throw createDesktopError({
      code: "desktop.project_run_preview_url_not_recorded",
      message:
        "Project run previews can only open URLs emitted by that managed run.",
    });
  }
  return { run, url: matchedUrl };
}

function isPreviewableHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function desktopWorkspaceSkillManager(
  projectPath: unknown,
): WorkspaceSkillManager {
  const requested = requireDesktopString(
    projectPath,
    "Desktop workspace skills require a project path.",
  );
  const workspaceRoot = resolveRegisteredDesktopProjectRoot(
    requested,
    desktopSettings.projects.map((project) => project.path),
  );
  const existing = desktopWorkspaceSkillManagers.get(workspaceRoot);
  if (existing !== undefined) return existing;
  const manager = new WorkspaceSkillManager(
    {
      workspaceId: deriveDesktopWorkspaceId(workspaceRoot),
      workspaceRoot,
    },
    {
      isWorkspaceIdle: async () =>
        (activeDesktopWorkspaceRunCounts.get(path.resolve(workspaceRoot)) ??
          0) === 0,
    },
  );
  desktopWorkspaceSkillManagers.set(workspaceRoot, manager);
  return manager;
}

async function activateDesktopWorkspaceSkills(
  workspaceRoot: string,
): Promise<void> {
  const normalizedRoot = path.resolve(workspaceRoot);
  if (activatedDesktopWorkspaceSkills.has(normalizedRoot)) return;
  await desktopWorkspaceSkillManager(normalizedRoot).syncAll();
  activatedDesktopWorkspaceSkills.add(normalizedRoot);
}

function parseDesktopWorkspaceSkillSource(
  value: unknown,
): WorkspaceSkillSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw createDesktopError({
      code: "desktop.invalid_workspace_skill_source",
      message: "Workspace skill source must be an object.",
    });
  }
  const record = value as Record<string, unknown>;
  const gitUrl = requireDesktopString(
    record.gitUrl,
    "Workspace skill Git URL is required.",
  );
  const branch = requireDesktopString(
    record.branch,
    "Workspace skill branch is required.",
  );
  return {
    gitUrl,
    branch,
    ...(typeof record.path === "string" && record.path.trim().length > 0
      ? { path: record.path.trim() }
      : {}),
  };
}

function requireDesktopString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({ code: "desktop.invalid_input", message });
  }
  return value.trim();
}

function readDesktopErrorCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown })?.code === "string"
    ? String((error as { code: string }).code)
    : undefined;
}

async function reconfigureDatabaseController(
  settings: DesktopSettings,
): Promise<void> {
  if (databaseController !== undefined) {
    await databaseController.close().catch(() => {});
  }
  databaseController = createAppDatabaseController(settings);
  currentDatabaseUrl = databaseController.getDatabaseUrl();
  databaseStatus = await databaseController.getStatus();
}

async function ensureDesktopLocalCoreReady(
  config: ReturnType<typeof resolveDesktopPathConfig>,
): Promise<LocalCoreDaemonReady & { client: LocalCoreClient }> {
  const ready = await ensureLocalCoreDaemonReady({
    env: process.env,
    platform: process.platform,
    coreVersion: resolveDesktopLocalCoreSuiteVersion(config.repoRoot),
    ownerExecutable: process.execPath,
    databaseMode: "pglite",
    repoRoot: config.repoRoot,
    runMigrations: true,
  });
  if (ready.client === undefined) {
    throw createDesktopError({
      code: "desktop.local_core_api_unavailable",
      message: "Kestrel Desktop requires the Kestrel Local Core API.",
    });
  }
  assertDesktopLocalCoreExecutionProfileCompatibility(ready.status);
  return {
    ...ready,
    client: ready.client,
  };
}

function resolveDesktopLocalCoreSuiteVersion(runtimeRoot: string): string {
  const buildManifestPath = path.join(
    runtimeRoot,
    LOCAL_CORE_BUILD_MANIFEST_NAME,
  );
  if (existsSync(buildManifestPath)) {
    return parseLocalCoreBuildIdentity(
      JSON.parse(readFileSync(buildManifestPath, "utf8")),
    ).suiteVersion;
  }
  const packageManifest = JSON.parse(
    readFileSync(path.join(runtimeRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (
    typeof packageManifest.version !== "string" ||
    packageManifest.version.trim().length === 0
  ) {
    throw new Error(
      "Kestrel Desktop could not resolve its Local Core runtime suite version.",
    );
  }
  return packageManifest.version.trim();
}

function createAppDatabaseController(
  settings: DesktopSettings,
): DesktopDatabaseController {
  currentDatabaseUrlSource =
    settings.databaseMode === "external"
      ? "desktop_external"
      : "desktop_managed";
  return createCoreOwnedDesktopDatabaseController({
    readCurrentStatus: () => localCoreStatus,
    ensureReady: async () => {
      localCoreStatus =
        await requireLocalCoreConnectionManager().executeIdempotent(
          async (client) => await client.status(),
        );
      currentDatabaseUrl = localCoreStatus.databaseUrl;
      return localCoreStatus;
    },
  });
}
