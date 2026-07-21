import { existsSync, watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronSquirrelStartup from "electron-squirrel-startup";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  systemPreferences,
  webContents,
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
  parseDesktopMcpServerMutationInput,
  parseDesktopRendererSettingsUpdate,
  parseDesktopRunCancelRequest,
  parseDesktopRunTurnRequest,
  parseDesktopOperatorControlRequest,
} from "../../../src/desktopShell/contracts.js";
import {
  ensureLocalCoreDaemonReady,
  isLocalCoreDaemonElectronAppLaunch,
  type LocalCoreDaemonReady,
} from "../../../src/localCore/daemon.js";
import { resolveKestrelCoreHome } from "../../../src/localCore/home.js";
import type { LocalCoreClient } from "../../../src/localCore/client.js";
import { LocalCoreConnectionManager } from "../../../src/localCore/connectionManager.js";
import type { LocalCoreStatus } from "../../../src/localCore/contracts.js";
import type {
  LocalCoreCredentialId,
} from "../../../src/localCore/credentialStore.js";
import {
  createWebRunnerAdapter,
  type WebRunnerAdapter,
  type WebRunnerRequestContext,
} from "../../../src/web/index.js";
import { deriveDesktopReadiness } from "../../../src/desktopShell/readiness.js";
import { resolveDesktopCapabilityView } from "../../../src/desktopShell/capabilityRegistry.js";
import {
  deriveDesktopOnboardingState,
  describeDesktopProviderRequirement,
} from "../../../src/desktopShell/onboarding.js";
import {
  createDefaultModelPolicy,
  type ResolvedModelPolicy,
} from "../../../src/profile/modelPolicy.js";
import { resolveProviderModelCatalog } from "../../../src/profile/modelCatalogDiscovery.js";
import {
  assertDesktopModelConfigurationHistoryPreserved,
  getDesktopAppDefinition,
  listDesktopAppDefinitions,
  resolveDesktopModelConfiguration,
  type DesktopExecutionSelection,
} from "../../../src/desktopShell/configuration.js";
import { resolveDesktopLibexecRoot, resolveDesktopPathConfig } from "./config.js";
import type { DatabaseUrlSource } from "../../../src/runtime/databasePreflight.js";
import type {
  DesktopBootState,
  DesktopCapabilityConfigurationResult,
  DesktopCapabilityView,
  DesktopDatabaseStatus,
  DesktopDirectoryListing,
  DesktopFileContent,
  DesktopFileEntry,
  DesktopFileReadInput,
  DesktopOpenFileEditorInput,
  DesktopFileSearchResponse,
  DesktopFileWriteInput,
  DesktopManagedProjectRun,
  DesktopLegacyUiStateEntries,
  DesktopUiStateV1,
  DesktopMcpDiscoveryResult,
  DesktopMcpServerConfig,
  DesktopMcpServerMutationInput,
  DesktopMicrophoneAccess,
  DesktopProjectRegistration,
  DesktopProjectFilesChangedEvent,
  DesktopRendererSettings,
  DesktopRendererSettingsUpdate,
  DesktopProtocolTransport,
  DesktopProjectLauncherDescriptor,
  DesktopRuntimeHealth,
  DesktopReadinessView,
  DesktopRunCancelRequest,
  DesktopRunTurnRequest,
  DesktopAttachmentMetadata,
  DesktopOperatorControlRequest,
  DesktopSettings,
  DesktopModelProvider,
  DesktopShellCommand,
} from "./contracts.js";
import { createDesktopError } from "./errors.js";
import {
  assertWithinRoot,
  parseDesktopPathTargetInput,
  resolveDesktopProjectRootForWatcherCleanup,
  resolveRegisteredDesktopProjectRoot,
  resolveVerifiedDesktopPathTarget,
} from "./fileAccess.js";
import { createDesktopBeforeQuitHandler } from "./lifecycle.js";
import {
  LocalCoreRunnerTransport,
  type DesktopRunnerControlTransport,
} from "./localCoreRunnerTransport.js";
import {
  buildDesktopRunnerProfile,
  createDefaultDesktopSettings,
  normalizeDesktopSettings,
} from "./settingsStore.js";
import { createCoreOwnedDesktopDatabaseController, type DesktopDatabaseController } from "./databaseController.js";
import { archiveRuntimeStore } from "./runtimeStoreReset.js";
import { ensureDesktopRunnerResponsive } from "./runnerHandshake.js";
import { buildDesktopSupportBundle } from "./supportBundle.js";
import {
  ensureDesktopProjectGitBootstrap,
  prepareDesktopProjectRegistrations as prepareProjectRegistrationsForSettings,
} from "./projectGitBootstrap.js";
import { discoverMcpServersFromKnownConfigFiles } from "./mcpDiscovery.js";
import {
  completeDesktopMcpVerification,
  prepareDesktopMcpVerification,
} from "./mcpVerification.js";
import { DesktopProjectFileIndex } from "./projectFileIndex.js";
import { toDesktopRendererSettings } from "./rendererSettings.js";
import { probeDesktopCapabilities } from "./capabilityProbes.js";
import { verifyDesktopModelCapability } from "./modelProviderVerification.js";
import { verifyDesktopToolProvider } from "./toolProviderVerification.js";
import { buildDesktopCapabilityConfigurationPlan } from "./capabilityConfiguration.js";
import { resolveDesktopThreadWorkspace } from "./threadWorkspace.js";
import {
  getDesktopProjectSnapshot,
  getDesktopOperatorRun,
  getDesktopOperatorThread,
  listDesktopOperatorRuns,
  runDesktopProjectAction,
  runDesktopOperatorControl,
} from "./missionControl.js";

declare global {
  var __kestrelDesktopRunnerTransportFactory: (() => DesktopProtocolTransport) | undefined;
  var __kestrelDesktopProfileOverride:
    | {
        presetId?: "desktop_dev_local" | undefined;
        capabilityPacks?: Array<"balanced" | "filesystem" | "dev_shell" | "desktop_host" | "sandbox_code"> | undefined;
        version: number;
      }
    | undefined;
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
let runnerTransport: DesktopRunnerControlTransport | undefined;
let desktopConfig: ReturnType<typeof resolveDesktopPathConfig> | undefined;
let localCoreStatus: LocalCoreStatus | undefined;
let runtimeHealth: DesktopRuntimeHealth = {
  state: "degraded",
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
let desktopModelPolicy: ResolvedModelPolicy = createDefaultModelPolicy();
let localCoreConnectionManager: LocalCoreConnectionManager | undefined;
let desktopRunnerAdapter: WebRunnerAdapter | undefined;
let unsubscribeProjectRunEvents: (() => void) | undefined;
let desktopProfileOverrideVersion = 0;
let currentDatabaseUrl: string | undefined;
let currentDatabaseUrlSource: DatabaseUrlSource = "desktop_default";
let mediaPermissionHandlerInstalled = false;
const projectRunPreviewWindows = new Map<string, BrowserWindow>();
const fileEditorWindows = new Map<string, BrowserWindow>();
const projectFileWatchers = new Map<string, DesktopProjectFileWatcher>();
const projectFileIndex = new DesktopProjectFileIndex();
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
const ownsSingleInstanceLock = rejectedDaemonAppLaunch === false
  && electronSquirrelStartup === false
  && app.requestSingleInstanceLock();
const shouldStartDesktopMain = rejectedDaemonAppLaunch === false
  && electronSquirrelStartup === false
  && ownsSingleInstanceLock;

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

async function main(): Promise<void> {
  await app.whenReady();
  const localCoreHome = resolveKestrelCoreHome(process.env, process.platform);
  if (localCoreHome.source !== "isolated_dev_home") {
    process.env.KESTREL_CORE_HOME = localCoreHome.homePath;
  }
  if (process.env.KESTREL_HOME === undefined || process.env.KESTREL_HOME.trim().length === 0) {
    process.env.KESTREL_HOME = localCoreHome.homePath;
  }
  if (process.platform === "darwin") {
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
  const localCoreConfig = desktopConfig;
  const ready = await ensureDesktopLocalCoreReady(localCoreConfig);
  localCoreStatus = ready.status;
  localCoreConnectionManager = new LocalCoreConnectionManager({
    initialConnection: ready,
    connect: async () => await ensureDesktopLocalCoreReady(localCoreConfig),
    onConnected(connection) {
      localCoreStatus = connection.status;
      currentDatabaseUrl = connection.status.databaseUrl;
      subscribeToCoreProjectRuns(connection.client);
    },
  });
  await refreshDesktopCoreState();
  await migrateDesktopCredentialsToLocalCore();
  if (desktopSettings.selectedProvider !== desktopModelPolicy.provider) {
    await saveDesktopCoreSettings({
      ...desktopSettings,
      selectedProvider: desktopModelPolicy.provider,
      providerSelectionCompletedAt:
        desktopSettings.providerSelectionCompletedAt ??
        new Date().toISOString(),
    });
  }
  syncDesktopWebEnvironment(desktopSettings);
  applyDesktopProfileOverride(desktopSettings);
  await reconfigureDatabaseController(desktopSettings);
  runnerTransport = new LocalCoreRunnerTransport({
    connectionManager: localCoreConnectionManager,
    logPath: desktopConfig.runtimeLogPath,
  });
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

  registerIpcHandlers(runnerTransport);
  installApplicationMenu();
  await ensureMainWindow();

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
  app.on("before-quit", createDesktopBeforeQuitHandler({
    stopProjectRuns: stopCoreProjectRuns,
    closeWebServer: async () => {},
    stopRunner: async () => {
      unsubscribeProjectRunEvents?.();
      await desktopRunnerAdapter?.close();
      desktopRunnerAdapter = undefined;
      await runnerTransport?.stop();
      await databaseController?.close();
    },
    quitApp: () => app.quit(),
  }));
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
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("Kestrel Desktop failed to start", { error });
    dialog.showErrorBox("Kestrel could not start", message);
    app.quit();
  });
}

async function ensureMainWindow(): Promise<void> {
  if (desktopConfig === undefined || runnerTransport === undefined) {
    throw createDesktopError({
      code: "desktop.config_unavailable",
      message: "Desktop app configuration is unavailable.",
    });
  }
  if (mainWindow !== undefined && mainWindow.isDestroyed() === false) {
    if (bootState.phase === "ready") {
      await mainWindow.loadFile(desktopConfig.rendererHtmlPath);
    }
    return;
  }
  const window = new BrowserWindow({
    icon: desktopConfig.iconPath,
    width: 1440,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#101315",
    show: false,
    title: "Kestrel",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  window.on("ready-to-show", () => {
    window.show();
  });
  ensureMediaPermissionHandler(window);
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  mainWindow = window;
  await window.loadFile(desktopConfig.bootHtmlPath);

  if (bootState.phase === "ready") {
    updateBootState({
      phase: "ready",
      message: "Desktop ready.",
    }, window.webContents);
    await window.loadFile(desktopConfig.rendererHtmlPath);
    return;
  }

  void bootDesktop({
    config: desktopConfig,
    window,
    runnerTransport,
  });
}

async function bootDesktop(input: {
  config: ReturnType<typeof resolveDesktopPathConfig>;
  window: BrowserWindow;
  runnerTransport: DesktopRunnerControlTransport;
}): Promise<void> {
  try {
    if (databaseController === undefined) {
      throw createDesktopError({
        code: "desktop.database_controller_unavailable",
        message: "Kestrel Local Core database controller is unavailable.",
      });
    }
    updateBootState({
      phase: "starting_database",
      message: "Checking Kestrel Local Core database…",
      database: databaseStatus,
    }, input.window.webContents);
    const database = await databaseController.prepare();
    currentDatabaseUrl = database.databaseUrl;
    databaseStatus = database.status;
    updateBootState({
      phase: "starting_runtime",
      message: "Starting Kestrel runtime…",
      database: databaseStatus,
    }, input.window.webContents);
    await ensureDesktopRunnerResponsive(input.runnerTransport);

    updateBootState({
      phase: "starting_web",
      message: "Opening desktop renderer…",
      database: databaseStatus,
    }, input.window.webContents);
    updateBootState({
      phase: "ready",
      message: "Desktop ready.",
      database: databaseStatus,
    }, input.window.webContents);
    await input.window.loadFile(input.config.rendererHtmlPath);
  } catch (error) {
    if (databaseController !== undefined) {
      databaseStatus = await databaseController.getStatus().catch(() => databaseStatus);
    }
    updateBootState({
      phase: "failed",
      message: "Desktop startup failed.",
      ...(readDesktopErrorCode(error) !== undefined ? { code: readDesktopErrorCode(error) } : {}),
      details: error instanceof Error ? error.message : String(error),
      database: databaseStatus,
    }, input.window.webContents);
  }
}

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: "about" },
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
      submenu: [
        {
          label: "Toggle Left Sidebar",
          accelerator: "CmdOrCtrl+\\",
          click: () => {
            void sendDesktopCommand("toggle-left-sidebar");
          },
        },
        {
          label: "Toggle File Inspector",
          accelerator: "Alt+CmdOrCtrl+\\",
          click: () => {
            void sendDesktopCommand("toggle-right-sidebar");
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

function registerIpcHandlers(
  runnerTransport: DesktopRunnerControlTransport,
): void {
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
  ipcMain.handle("desktop:get-support-bundle", async () => {
    const manager = requireLocalCoreConnectionManager();
    const coreBundle = await manager.executeIdempotent(
      async (client) => await client.supportBundle(),
    ).catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    return buildDesktopSupportBundle({
      generatedAt: new Date().toISOString(),
      appInfo: {
        name: app.getName(),
        version: app.getVersion(),
        isPackaged: app.isPackaged,
      },
      bootState,
      runtimeHealth,
      databaseStatus,
      settings: desktopSettings,
      projectRuns: await manager.executeIdempotent(
        async (client) => await client.listDesktopProjectRuns(),
      ),
      runtimeStatus: runnerTransport.getStatus(),
      paths: {
        runtimeLogPath: runnerTransport.getStatus().logPath,
      },
      localCoreStatus,
      coreSupportBundle: coreBundle,
    });
  });
  ipcMain.handle("desktop:get-settings", async () => await readDesktopRendererSettings());
  ipcMain.handle("desktop:get-capabilities", async () => await readDesktopCapabilityView());
  ipcMain.handle("desktop:configure-capability", async (_event, input: unknown): Promise<DesktopCapabilityConfigurationResult> => {
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
    const previousSettings = structuredClone(desktopSettings);
    const previousModelPolicy = structuredClone(desktopModelPolicy);
    let plan: ReturnType<typeof buildDesktopCapabilityConfigurationPlan>;
    try {
      plan = buildDesktopCapabilityConfigurationPlan({
        currentSettings: desktopSettings,
        currentModelPolicy: desktopModelPolicy,
        configuration,
      });
      if (plan.requiresVerification && plan.registration.modelProvider !== undefined) {
        await verifyDesktopModelCapability({
          provider: plan.registration.modelProvider,
          settings: plan.settings,
          ...(typeof plan.credential?.value === "string" ? { apiKey: plan.credential.value } : {}),
        });
      } else if (
        plan.requiresVerification
        && (configuration.capabilityId === "tools.internet.tavily" || configuration.capabilityId === "tools.weather")
      ) {
        if (typeof plan.credential?.value !== "string") {
          throw new Error("A credential is required to verify this provider configuration.");
        }
        await verifyDesktopToolProvider({
          capabilityId: configuration.capabilityId,
          credential: plan.credential.value,
          settings: plan.settings,
        });
      } else if (
        plan.requiresVerification
        && configuration.capabilityId === "data.database"
        && plan.settings.databaseMode === "external"
      ) {
        if (typeof plan.credential?.value !== "string") {
          throw new Error("Enter the PostgreSQL connection URL to verify external storage.");
        }
        await requireLocalCoreConnectionManager().executeOnce(
          async (client) => await client.verifyExternalDatabase(plan.credential!.value as string),
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

    const capabilityVerifications = { ...plan.settings.capabilityVerifications };
    if (plan.credential?.value === null) {
      delete capabilityVerifications[configuration.capabilityId];
    } else if (plan.requiresVerification) {
      capabilityVerifications[configuration.capabilityId] = new Date().toISOString();
    }
    const appliedSettings = {
      ...plan.settings,
      capabilityVerifications,
      ...(plan.registration.modelProvider !== undefined && configuration.enabled === true
        ? {
            providerSelectionCompletedAt:
              plan.settings.providerSelectionCompletedAt ?? new Date().toISOString(),
          }
        : {}),
      modelPolicy: plan.modelPolicy,
    };
    await saveDesktopCoreSettings(appliedSettings);
    try {
      if (plan.credential?.value === null) {
        await requireLocalCoreConnectionManager().executeOnce(
          async (client) => await client.deleteCredential(plan.credential!.id),
        );
      } else if (typeof plan.credential?.value === "string" && credentialAppliedDuringVerification === false) {
        await requireLocalCoreConnectionManager().executeOnce(
          async (client) => await client.setCredential(plan.credential!.id, plan.credential!.value as string),
        );
      }
    } catch (error) {
      await saveDesktopCoreSettings({ ...previousSettings, modelPolicy: previousModelPolicy });
      throw createDesktopError({
        code: "desktop.capability_credential_apply_failed",
        message: "Desktop could not apply the verified credential. The previous configuration was preserved.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    syncDesktopWebEnvironment(desktopSettings);
    applyDesktopProfileOverride(desktopSettings);
    await resetDesktopRunnerAdapter();
    let runtimeRestarted = false;
    if (plan.restartRuntime) {
      updateBootState({
        phase: "starting_runtime",
        message: `Applying ${configuration.capabilityId} configuration…`,
        database: databaseStatus,
      }, mainWindow?.webContents);
      await runnerTransport.restart();
      runtimeRestarted = true;
      if (configuration.capabilityId === "data.database") {
        await reconfigureDatabaseController(desktopSettings);
      }
      updateBootState({ phase: "ready", message: "Desktop ready.", database: databaseStatus }, mainWindow?.webContents);
    }
    runtimeHealth = deriveRuntimeHealth(bootState);
    mainWindow?.webContents.send("desktop:runtime-health", runtimeHealth);
    return {
      capabilityId: configuration.capabilityId,
      applied: true,
      runtimeRestarted,
      view: await readDesktopCapabilityView(),
    };
  });
  ipcMain.handle("desktop:get-ui-state", async () => await requireLocalCoreConnectionManager().executeIdempotent(
      async (client) => await client.getDesktopUiState(),
    ));
  ipcMain.handle("desktop:sync-legacy-ui-state", async (_event, input: unknown) => {
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
  });
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
    return await requireLocalCoreConnectionManager().executeIdempotent(
      async (client) => await client.syncDesktopUiState(state),
    );
  });
  ipcMain.handle("desktop:run-turn", async (event, input: unknown) => {
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
    const { projectPath, threadId, attachmentIds, executionSelection, ...turnRequest } = request;
    const runProfile = resolveDesktopExecutionProfile(executionSelection);
    const canonicalThreadId = `thread-main:${request.sessionId}`;
    if (threadId !== undefined && threadId !== canonicalThreadId) {
      throw createDesktopError({ code: "desktop.invalid_run_thread", message: "Desktop run thread does not match its Local Core session." });
    }
    if (attachmentIds !== undefined) {
      const listed = await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.listDesktopAttachments(canonicalThreadId),
      );
      const selected = attachmentIds.map((attachmentId) => listed.find((entry) => entry.attachmentId === attachmentId));
      if (selected.some((entry) => entry === undefined)) {
        throw createDesktopError({ code: "desktop.attachment_unavailable", message: "One or more attachments are unavailable for this thread." });
      }
      if (selected.some((entry) => entry?.kind === "image") && runProfile.modelCapabilities?.visionInputEnabled !== true) {
        throw createDesktopError({ code: "desktop.model_vision_unavailable", message: "The selected model does not accept image attachments." });
      }
    }
    const attachments = attachmentIds === undefined
      ? undefined
      : await requireLocalCoreConnectionManager().executeIdempotent(
          async (client) => await client.resolveDesktopAttachments(canonicalThreadId, attachmentIds),
        );
    const workspace = resolveDesktopThreadWorkspace({
      ...(projectPath !== undefined ? { projectPath } : {}),
      projects: desktopSettings.projects,
      defaultKestrelRoot: requireLocalCoreStatus().home.productRootPath,
    });
    return await requireDesktopRunnerAdapter(runnerTransport).runTurnStream(
      {
        ...turnRequest,
        ...(attachments !== undefined ? { attachments } : {}),
        workspace,
        metadata: { desktopExecutionSelection: executionSelection },
      },
      {
        onEvent(runnerEvent) {
          if (event.sender.isDestroyed() === false) {
            event.sender.send("desktop:runner-event", runnerEvent);
          }
        },
      },
      { ...DESKTOP_RUNNER_REQUEST_CONTEXT, profile: runProfile },
    );
  });
  ipcMain.handle("desktop:select-attachments", async (_event, threadId: unknown): Promise<DesktopAttachmentMetadata[]> => {
    const normalizedThreadId = parseDesktopThreadId(threadId);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images and text/code", extensions: ["png", "jpg", "jpeg", "webp", "gif", "txt", "md", "markdown", "json", "yaml", "yml", "csv", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "zsh", "sql", "html", "css", "scss", "toml", "xml", "vue", "svelte"] },
      ],
    };
    const selection = mainWindow === undefined
      ? await dialog.showOpenDialog(dialogOptions)
      : await dialog.showOpenDialog(mainWindow, dialogOptions);
    if (selection.canceled) return [];
    if (selection.filePaths.length > 8) throw createDesktopError({ code: "desktop.too_many_attachments", message: "Select no more than 8 attachments at once." });
    const imported: DesktopAttachmentMetadata[] = [];
    for (const filePath of selection.filePaths) {
      const bytes = await readFile(filePath);
      imported.push(await requireLocalCoreConnectionManager().executeOnce(async (client) => await client.importDesktopAttachment({
        threadId: normalizedThreadId,
        filename: path.basename(filePath),
        mimeType: desktopAttachmentMimeType(filePath),
        data: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })));
    }
    return imported;
  });
  ipcMain.handle("desktop:list-attachments", async (_event, threadId: unknown) => await requireLocalCoreConnectionManager().executeIdempotent(
    async (client) => await client.listDesktopAttachments(parseDesktopThreadId(threadId)),
  ));
  ipcMain.handle("desktop:remove-attachment", async (_event, threadId: unknown, attachmentId: unknown) => await requireLocalCoreConnectionManager().executeOnce(
    async (client) => await client.removeDesktopAttachment(parseDesktopThreadId(threadId), parseDesktopAttachmentId(attachmentId)),
  ));
  ipcMain.handle("desktop:operator-control", async (_event, input: unknown) => {
    let request: DesktopOperatorControlRequest;
    try { request = parseDesktopOperatorControlRequest(input); }
    catch (error) { throw createDesktopError({ code: "desktop.invalid_operator_control", message: "Desktop operator control request is invalid.", details: error instanceof Error ? error.message : String(error) }); }
    const { attachmentIds, ...control } = request;
    if (attachmentIds !== undefined) {
      const listed = await requireLocalCoreConnectionManager().executeIdempotent(async (client) => await client.listDesktopAttachments(request.threadId));
      const selected = attachmentIds.map((attachmentId) => listed.find((entry) => entry.attachmentId === attachmentId));
      if (selected.some((entry) => entry === undefined)) throw createDesktopError({ code: "desktop.attachment_unavailable", message: "One or more attachments are unavailable for this thread." });
      if (selected.some((entry) => entry?.kind === "image") && desktopModelPolicy.modelCapabilities.visionInputEnabled !== true) {
        throw createDesktopError({ code: "desktop.model_vision_unavailable", message: "The selected model does not accept image attachments." });
      }
    }
    const attachments = attachmentIds !== undefined && request.action !== "enqueue_follow_up"
      ? await requireLocalCoreConnectionManager().executeIdempotent(async (client) => await client.resolveDesktopAttachments(request.threadId, attachmentIds))
      : undefined;
    return runDesktopOperatorControl({
      adapter: requireDesktopRunnerAdapter(runnerTransport),
      request: {
        ...control,
        ...(request.action === "enqueue_follow_up" && attachmentIds !== undefined ? { attachmentIds } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      },
      context: DESKTOP_RUNNER_REQUEST_CONTEXT,
    });
  });
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
    return await requireDesktopRunnerAdapter(runnerTransport).sendControl(
      {
        type: "run.cancel",
        ...request,
      },
      DESKTOP_RUNNER_REQUEST_CONTEXT,
    );
  });
  ipcMain.handle("desktop:get-model-policy", async () => desktopModelPolicy);
  ipcMain.handle("desktop:get-model-catalog", async (_event, provider: unknown) => {
    if (provider !== "openrouter" && provider !== "openai" && provider !== "anthropic"
      && provider !== "ollama" && provider !== "lmstudio") {
      throw createDesktopError({
        code: "desktop.invalid_model_provider",
        message: "Desktop model provider is invalid.",
      });
    }
    return await resolveProviderModelCatalog(provider, process.env);
  });
  ipcMain.handle("desktop:save-settings", async (_event, nextSettings: unknown) => {
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
    const nextProjects = update.projects ?? desktopSettings.projects;
    const preparedProjects = await prepareDesktopSettingsProjectRegistrations(nextProjects);
    const normalized = normalizeDesktopSettings({
      ...desktopSettings,
      projects: preparedProjects,
      modelConfigurations: update.modelConfigurations ?? desktopSettings.modelConfigurations,
      defaultModelConfigurationId:
        update.defaultModelConfigurationId ?? desktopSettings.defaultModelConfigurationId,
      defaultEnabledAppIds: update.defaultEnabledAppIds ?? desktopSettings.defaultEnabledAppIds,
      appearanceTheme: update.appearanceTheme ?? desktopSettings.appearanceTheme,
    }, { fallbackModelPolicy: desktopModelPolicy });
    return persistDesktopRendererConfiguration(runnerTransport, {
      settings: normalized,
      restartRuntime: false,
      resetRunnerProfile: false,
      restartMessage: "Applying project settings…",
    });
  });
  ipcMain.handle("desktop:get-boot-state", () => bootState);
  ipcMain.handle("desktop:pick-workspace", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Select workspace",
    });
    return result.canceled === true ? undefined : result.filePaths[0];
  });
  ipcMain.handle("desktop:pick-project-folder", async (): Promise<DesktopProjectRegistration | undefined> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Add project folder",
    });
    const selectedPath = result.canceled === true ? undefined : result.filePaths[0];
    if (selectedPath === undefined) {
      return ;
    }
    await ensureDesktopProjectGitBootstrap(selectedPath);
    return {
      path: selectedPath,
      label: path.basename(selectedPath),
    };
  });
  ipcMain.handle("desktop:open-external", async (_event, url: unknown) => {
    if (typeof url !== "string" || /^https?:\/\//u.test(url) === false) {
      throw createDesktopError({
        code: "desktop.invalid_external_url",
        message: "desktop.openExternal requires an http(s) URL.",
      });
    }
    await shell.openExternal(url);
  });
  ipcMain.handle("desktop:open-project-run-preview", async (_event, input: unknown) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw createDesktopError({
        code: "desktop.invalid_project_run_preview_input",
        message: "desktop.openProjectRunPreview requires a project run payload.",
      });
    }
    const payload = input as Record<string, unknown>;
    if (typeof payload.runId !== "string" || payload.runId.trim().length === 0) {
      throw createDesktopError({
        code: "desktop.invalid_project_run_id",
        message: "desktop.openProjectRunPreview requires a run id.",
      });
    }
    if (payload.url !== undefined && typeof payload.url !== "string") {
      throw createDesktopError({
        code: "desktop.invalid_project_run_preview_url",
        message: "desktop.openProjectRunPreview requires an http(s) URL when a URL is provided.",
      });
    }
    const preview = await resolveCoreProjectRunPreviewUrl({
      runId: payload.runId,
      ...(typeof payload.url === "string" ? { url: payload.url } : {}),
    });
    await openProjectRunPreviewWindow(preview.run, preview.url);
  });
  ipcMain.handle("desktop:open-file-editor", async (_event, input: unknown) => {
    const editorInput = parseDesktopOpenFileEditorInput(input);
    await openFileEditorWindow(editorInput);
  });
  ipcMain.handle("desktop:open-path", async (_event, input: unknown) => {
    const parsed = parseDesktopPathTargetInput(input, {
      methodName: "desktop.openPath",
      invalidInputCode: "desktop.invalid_open_input",
      invalidTargetCode: "desktop.invalid_open_path",
    });
    const resolved = await resolveVerifiedDesktopPathTarget(
      parsed,
      registeredDesktopProjectRootPaths(),
    );
    await shell.openPath(resolved.targetPath);
  });
  ipcMain.handle("desktop:reveal-path", async (_event, input: unknown) => {
    const parsed = parseDesktopPathTargetInput(input, {
      methodName: "desktop.revealPath",
      invalidInputCode: "desktop.invalid_reveal_input",
      invalidTargetCode: "desktop.invalid_reveal_path",
    });
    const resolved = await resolveVerifiedDesktopPathTarget(
      parsed,
      registeredDesktopProjectRootPaths(),
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
    updateBootState({
      phase: "starting_runtime",
      message: "Restarting Kestrel runtime…",
      database: databaseStatus,
    }, mainWindow?.webContents);
    await stopCoreProjectRuns();
    await runnerTransport.stop();
    await ensureDesktopRunnerResponsive(runnerTransport);
    const status = runnerTransport.getStatus();
    updateBootState({
      phase: "ready",
      message: "Desktop ready.",
      database: databaseStatus,
    }, mainWindow?.webContents);
    return status;
  });
  ipcMain.handle("desktop:request-microphone-access", async (): Promise<DesktopMicrophoneAccess> => requestDesktopMicrophoneAccess());
  ipcMain.handle("desktop:reset-runtime-store", async () => {
    if (desktopConfig === undefined) {
      throw createDesktopError({
        code: "desktop.config_unavailable",
        message: "Kestrel Local Core shell configuration is unavailable.",
      });
    }
    try {
      updateBootState({
        phase: "starting_runtime",
        message: "Resetting local runtime store…",
        database: databaseStatus,
      }, mainWindow?.webContents);
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
      updateBootState({
        phase: "ready",
        message: "Desktop ready.",
        database: databaseStatus,
      }, mainWindow?.webContents);
      return {
        ...reset,
        runtimeStatus,
      };
    } catch (error) {
      updateBootState({
        phase: "failed",
        message: "Runtime store reset failed.",
        ...(readDesktopErrorCode(error) !== undefined ? { code: readDesktopErrorCode(error) } : {}),
        details: error instanceof Error ? error.message : String(error),
        database: databaseStatus,
      }, mainWindow?.webContents);
      throw error;
    }
  });
  ipcMain.handle("desktop:restart-app", async () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle("desktop:open-diagnostics", async () => {
    const status = runnerTransport.getStatus();
    shell.showItemInFolder(status.logPath);
  });
  ipcMain.handle("desktop:get-runtime-status", async () => runnerTransport.getStatus());
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
  ipcMain.handle("desktop:reveal-database-files", async (_event, target: unknown) => {
    if (target !== "log" && target !== "data") {
      throw createDesktopError({
        code: "desktop.invalid_database_reveal_target",
        message: "desktop.revealDatabaseFiles requires 'log' or 'data'.",
      });
    }
    const filePath = target === "log" ? databaseController?.getLogPath() : databaseController?.getDataPath();
    if (filePath === undefined) {
      throw createDesktopError({
        code: "desktop.database_path_unavailable",
        message: `Database ${target} path is unavailable.`,
      });
    }
    shell.showItemInFolder(filePath);
  });
  ipcMain.handle("desktop:list-directory", async (_event, rootPath: unknown, directoryPath: unknown): Promise<DesktopDirectoryListing> => {
    if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
      throw createDesktopError({
        code: "desktop.invalid_root_path",
        message: "desktop.listDirectory requires a project root path.",
      });
    }
    const resolvedRoot = resolveRegisteredDesktopProjectRoot(
      rootPath,
      registeredDesktopProjectRootPaths(),
    );
    const resolvedDirectory = typeof directoryPath === "string" && directoryPath.trim().length > 0
      ? path.resolve(directoryPath)
      : resolvedRoot;
    assertWithinRoot(resolvedRoot, resolvedDirectory, "directoryPath");
    await resolveVerifiedDesktopPathTarget(
      { rootPath: resolvedRoot, targetPath: resolvedDirectory },
      registeredDesktopProjectRootPaths(),
      "directoryPath",
    );
    const directoryEntries = await readdir(resolvedDirectory, { withFileTypes: true });
    const entries: DesktopFileEntry[] = (await Promise.all(
      directoryEntries.map(async (entry): Promise<DesktopFileEntry | undefined> => {
        const entryPath = path.join(resolvedDirectory, entry.name);
        try {
          const entryStats = await lstat(entryPath);
          return {
            path: entryPath,
            name: entry.name,
            kind: entry.isDirectory() ? "directory" as const : "file" as const,
            modifiedAt: entryStats.mtime.toISOString(),
            ...(entry.isDirectory() ? {} : { sizeBytes: entryStats.size }),
          };
        } catch {
          return {
            path: entryPath,
            name: entry.name,
            kind: entry.isDirectory() ? "directory" as const : "file" as const,
          };
        }
      }),
    ))
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
  });
  ipcMain.handle("desktop:search-project-files", async (_event, rootPath: unknown, query: unknown): Promise<DesktopFileSearchResponse> => {
    if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
      throw createDesktopError({
        code: "desktop.invalid_root_path",
        message: "desktop.searchProjectFiles requires a project root path.",
      });
    }
    const resolvedRoot = resolveRegisteredDesktopProjectRoot(
      rootPath,
      registeredDesktopProjectRootPaths(),
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
      registeredDesktopProjectRootPaths(),
    );
    return projectFileIndex.search(resolvedRoot, query.trim());
  });
  ipcMain.handle("desktop:watch-project-files", async (event, rootPath: unknown) => {
    const resolvedRoot = await parseDesktopProjectWatchRoot(rootPath, "desktop.watchProjectFiles");
    startProjectFileWatcher(resolvedRoot, event.sender.id);
    event.sender.once("destroyed", () => {
      stopProjectFileWatcher(resolvedRoot, event.sender.id);
    });
  });
  ipcMain.handle("desktop:unwatch-project-files", async (event, rootPath: unknown) => {
    const resolvedRoot = parseDesktopProjectUnwatchRoot(rootPath, "desktop.unwatchProjectFiles");
    stopProjectFileWatcher(resolvedRoot, event.sender.id);
  });
  ipcMain.handle("desktop:read-file", async (_event, input: unknown): Promise<DesktopFileContent> => {
    const parsed = parseDesktopFileReadInput(input);
    const resolved = await resolveVerifiedDesktopPathTarget(
      parsed,
      registeredDesktopProjectRootPaths(),
    );
    const resolvedPath = resolved.targetPath;
    const fileStats = await stat(resolvedPath);
    if (fileStats.isFile() === false) {
      throw createDesktopError({
        code: "desktop.invalid_read_path",
        message: "desktop.readFile requires a file path.",
      });
    }
    const contentBuffer = await readEditableTextFileBuffer(resolvedPath, fileStats.size);
    const diskContent = decodeUtf8TextFile(contentBuffer, resolvedPath);
    const lineEnding = detectLineEnding(diskContent);
    const content = normalizeEditorLineEndings(diskContent);
    const editable =
      fileStats.size <= EDITABLE_TEXT_FILE_MAX_BYTES && lineEnding !== "mixed";
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
  });
  ipcMain.handle("desktop:write-file", async (_event, input: unknown): Promise<DesktopFileContent> => {
    const parsed = parseDesktopFileWriteInput(input);
    const resolved = await resolveVerifiedDesktopPathTarget(
      parsed,
      registeredDesktopProjectRootPaths(),
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
        message: "This file is open read-only because it has mixed line endings.",
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
  });
  ipcMain.handle("desktop:discover-mcp-servers", async (): Promise<DesktopMcpDiscoveryResult> => readDesktopMcpInventory());
  ipcMain.handle("desktop:save-mcp-server", async (_event, input: unknown): Promise<DesktopMcpDiscoveryResult> => {
    let configuration: DesktopMcpServerMutationInput;
    try {
      configuration = parseDesktopMcpServerMutationInput(input);
    } catch (error) {
      throw createDesktopError({ code: "desktop.invalid_mcp_server", message: "MCP server configuration is invalid.", details: error instanceof Error ? error.message : String(error) });
    }
    let server: DesktopMcpServerConfig;
    try {
      if (configuration.enabled) {
        const prepared = prepareDesktopMcpVerification(configuration);
        const verification = await requireLocalCoreConnectionManager().executeOnce(
          async (client) => await client.verifyMcpServer(prepared.request),
        );
        server = completeDesktopMcpVerification(
          configuration,
          prepared.bindings,
          verification,
        );
      } else {
        const current = desktopSettings.mcpServers.find((entry) => entry.id === configuration.id);
        if (current === undefined) throw new Error("Only an existing Desktop-managed MCP server can be disabled.");
        server = { ...current, enabled: false };
      }
    } catch (error) {
      throw createDesktopError({ code: "desktop.mcp_verification_failed", message: `${configuration.name} could not be activated.`, details: error instanceof Error ? error.message : String(error) });
    }
    const previousServer = desktopSettings.mcpServers.find((entry) => entry.id === server.id);
    await saveDesktopCoreSettings({
      ...desktopSettings,
      mcpServers: [...desktopSettings.mcpServers.filter((entry) => entry.id !== server.id), server],
      capabilityVerifications: {
        ...desktopSettings.capabilityVerifications,
        ...(configuration.enabled ? { "connections.mcp": server.verifiedAt! } : {}),
      },
    });
    const activeCredentialIds = new Set(server.credentials?.map((credential) => credential.credentialId) ?? []);
    const removedCredentialIds = previousServer?.credentials
      ?.map((credential) => credential.credentialId)
      .filter((credentialId) => activeCredentialIds.has(credentialId) === false) ?? [];
    if (removedCredentialIds.length > 0) {
      await requireLocalCoreConnectionManager().executeOnce(async (client) => {
        for (const credentialId of removedCredentialIds) await client.deleteCredential(credentialId);
      });
    }
    applyDesktopProfileOverride(desktopSettings);
    await resetDesktopRunnerAdapter();
    await runnerTransport.restart();
    return await readDesktopMcpInventory();
  });
  ipcMain.handle("desktop:delete-mcp-server", async (_event, input: unknown): Promise<DesktopMcpDiscoveryResult> => {
    if (typeof input !== "string" || /^[a-zA-Z0-9._-]+$/u.test(input) === false) {
      throw createDesktopError({ code: "desktop.invalid_mcp_server", message: "MCP server id is invalid." });
    }
    const removed = desktopSettings.mcpServers.find((server) => server.id === input);
    await saveDesktopCoreSettings({ ...desktopSettings, mcpServers: desktopSettings.mcpServers.filter((server) => server.id !== input) });
    if (removed?.credentials !== undefined) {
      await requireLocalCoreConnectionManager().executeOnce(async (client) => {
        for (const credential of removed.credentials ?? []) {
          await client.deleteCredential(credential.credentialId);
        }
      });
    }
    applyDesktopProfileOverride(desktopSettings);
    await resetDesktopRunnerAdapter();
    await runnerTransport.restart();
    return await readDesktopMcpInventory();
  });
  ipcMain.handle("desktop:read-project-launcher", async (_event, projectPath: unknown, packageManagerOverride: unknown): Promise<DesktopProjectLauncherDescriptor | undefined> => {
    if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
      throw createDesktopError({
        code: "desktop.invalid_project_path",
        message: "desktop.readProjectLauncher requires a project path.",
      });
    }
    return requireLocalCoreConnectionManager().executeIdempotent(
      async (client) => await client.readDesktopProjectLauncher({
        projectPath,
        ...(packageManagerOverride === "npm" || packageManagerOverride === "pnpm"
          ? { packageManagerOverride }
          : {}),
      }),
    );
  });
  ipcMain.handle("desktop:list-project-runs", async (): Promise<DesktopManagedProjectRun[]> => requireLocalCoreConnectionManager().executeIdempotent(
      async (client) => await client.listDesktopProjectRuns(),
    ));
  ipcMain.handle("desktop:start-project-run", async (_event, input: unknown): Promise<DesktopManagedProjectRun> => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw createDesktopError({
        code: "desktop.invalid_project_run_input",
        message: "desktop.startProjectRun requires a project run payload.",
      });
    }
    const payload = input as Record<string, unknown>;
    if (typeof payload.projectPath !== "string" || payload.projectPath.trim().length === 0) {
      throw createDesktopError({
        code: "desktop.invalid_project_path",
        message: "desktop.startProjectRun requires a project path.",
      });
    }
    if (typeof payload.scriptName !== "string" || payload.scriptName.trim().length === 0) {
      throw createDesktopError({
        code: "desktop.invalid_script_name",
        message: "desktop.startProjectRun requires a script name.",
      });
    }
    const projectPath = payload.projectPath;
    const scriptName = payload.scriptName;
    const packageManagerOverride = payload.packageManagerOverride === "npm" || payload.packageManagerOverride === "pnpm"
      ? payload.packageManagerOverride
      : undefined;
    return requireLocalCoreConnectionManager().executeOnce(
      async (client) => await client.startDesktopProjectRun({
        projectPath,
        scriptName,
        ...(packageManagerOverride !== undefined ? { packageManagerOverride } : {}),
      }),
    );
  });
  ipcMain.handle("desktop:stop-project-run", async (_event, runId: unknown): Promise<DesktopManagedProjectRun | undefined> => {
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw createDesktopError({
        code: "desktop.invalid_project_run_id",
        message: "desktop.stopProjectRun requires a run id.",
      });
    }
    return requireLocalCoreConnectionManager().executeOnce(
      async (client) => await client.stopDesktopProjectRun(runId),
    );
  });
  ipcMain.handle("desktop:restart-project-run", async (_event, runId: unknown): Promise<DesktopManagedProjectRun> => {
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw createDesktopError({
        code: "desktop.invalid_project_run_id",
        message: "desktop.restartProjectRun requires a run id.",
      });
    }
    return requireLocalCoreConnectionManager().executeOnce(
      async (client) => await client.restartDesktopProjectRun(runId),
    );
  });
  ipcMain.handle("desktop:get-project-snapshot", async (_event, sessionId: unknown) => getDesktopProjectSnapshot({
      adapter: requireDesktopRunnerAdapter(runnerTransport),
      sessionId,
      context: DESKTOP_RUNNER_REQUEST_CONTEXT,
    }));
  ipcMain.handle("desktop:run-project-action", async (_event, action: unknown) => runDesktopProjectAction({
      adapter: requireDesktopRunnerAdapter(runnerTransport),
      action,
      context: DESKTOP_RUNNER_REQUEST_CONTEXT,
    }));
  ipcMain.handle("desktop:get-operator-thread", async (_event, threadId: unknown) => getDesktopOperatorThread({
      adapter: requireDesktopRunnerAdapter(runnerTransport),
      threadId,
      context: DESKTOP_RUNNER_REQUEST_CONTEXT,
    }));
  ipcMain.handle("desktop:list-operator-runs", async (_event, query: unknown) => await listDesktopOperatorRuns({
      adapter: requireDesktopRunnerAdapter(runnerTransport),
      query,
      context: DESKTOP_RUNNER_REQUEST_CONTEXT,
    }));
  ipcMain.handle("desktop:get-operator-run", async (_event, runId: unknown) => getDesktopOperatorRun({
      adapter: requireDesktopRunnerAdapter(runnerTransport),
      runId,
      context: DESKTOP_RUNNER_REQUEST_CONTEXT,
    }));
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

async function openFileEditorWindow(input: DesktopOpenFileEditorInput): Promise<void> {
  if (desktopConfig === undefined || existsSync(desktopConfig.rendererHtmlPath) === false) {
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
  };
  const existing = fileEditorWindows.get(resolvedFilePath);
  if (existing !== undefined && existing.isDestroyed() === false) {
    existing.setTitle(buildFileEditorTitle(resolvedFilePath));
    await existing.loadFile(desktopConfig.rendererHtmlPath, { query: editorQuery });
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
  await editorWindow.loadFile(desktopConfig.rendererHtmlPath, { query: editorQuery });
}

function buildFileEditorTitle(filePath: string): string {
  return `${path.basename(filePath) || "File"} - Kestrel Editor`;
}

function ensureMediaPermissionHandler(window: BrowserWindow): void {
  if (mediaPermissionHandlerInstalled) {
    return;
  }
  mediaPermissionHandlerInstalled = true;
  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(false);
      return;
    }
    const requestingOrigin = webContents.getURL();
    if (isTrustedDesktopOrigin(requestingOrigin) === false) {
      callback(false);
      return;
    }
    const requestedMediaTypes = Array.isArray((details as { mediaTypes?: unknown }).mediaTypes)
      ? (details as { mediaTypes: unknown[] }).mediaTypes
      : [];
    if (requestedMediaTypes.length > 0 && requestedMediaTypes.includes("audio") === false) {
      callback(false);
      return;
    }
    callback(true);
  });
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
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
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
  methodName: string,
): Promise<string> {
  if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_root_path",
      message: `${methodName} requires a project root path.`,
    });
  }
  const resolvedRoot = resolveRegisteredDesktopProjectRoot(
    rootPath,
    registeredDesktopProjectRootPaths(),
  );
  await resolveVerifiedDesktopPathTarget(
    { rootPath: resolvedRoot, targetPath: resolvedRoot },
    registeredDesktopProjectRootPaths(),
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
  watcherRecord.watcher = watch(rootPath, { recursive: true }, (eventType, filename) => {
    queueProjectFilesChangedEvent(watcherRecord, eventType, filename);
  });
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
    return ;
  }
  const candidatePath = path.resolve(rootPath, filename.toString());
  try {
    assertWithinRoot(rootPath, candidatePath, "changedPath");
    return candidatePath;
  } catch {
    return ;
  }
}

function resolveFileViewKind(filePath: string): Pick<DesktopFileContent, "viewKind" | "language"> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".mdx") {
    return { viewKind: "markdown" };
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".html", ".sh", ".bash", ".py", ".go", ".rs", ".sql", ".yaml", ".yml"].includes(extension)) {
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

function parseDesktopOpenFileEditorInput(input: unknown): DesktopOpenFileEditorInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw createDesktopError({
      code: "desktop.invalid_editor_input",
      message: "desktop.openFileEditor requires an editor request.",
    });
  }
  const record = input as Record<string, unknown>;
  if (typeof record.projectPath !== "string" || record.projectPath.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_project_path",
      message: "desktop.openFileEditor requires a project path.",
    });
  }
  if (typeof record.filePath !== "string" || record.filePath.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_editor_file",
      message: "desktop.openFileEditor requires a file path.",
    });
  }
  return {
    projectPath: record.projectPath,
    filePath: record.filePath,
    projectLabel:
      typeof record.projectLabel === "string" && record.projectLabel.trim().length > 0
        ? record.projectLabel
        : path.basename(record.projectPath),
  };
}

async function readEditableTextFileBuffer(filePath: string, sizeBytes: number): Promise<Buffer> {
  assertReadableDesktopTextFile(filePath, sizeBytes);
  return readFile(filePath);
}

function assertReadableDesktopTextFile(filePath: string, sizeBytes: number): void {
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

function assertWritableDesktopTextFile(filePath: string, sizeBytes: number): void {
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

function detectLineEnding(content: string): NonNullable<DesktopFileContent["lineEnding"]> {
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
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function deriveRuntimeHealth(nextBootState: DesktopBootState): DesktopRuntimeHealth {
  const status = runnerTransport?.getStatus();
  const onboarding = deriveDesktopOnboardingState(desktopSettings);
  const providerRequirement = describeDesktopProviderRequirement(desktopSettings);
  if (
    providerRequirement !== undefined &&
    onboarding.providerIssueOwnedBySetup
  ) {
    return {
      state: "degraded",
      summary: providerRequirement.summary,
      details: providerRequirement.detail,
      running: status?.running ?? false,
      ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
      database: databaseStatus,
    };
  }
  if (providerRequirement !== undefined) {
    return {
      state: "blocked",
      summary: providerRequirement.summary,
      details: providerRequirement.detail,
      running: status?.running ?? false,
      ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
      database: databaseStatus,
    };
  }
  if (databaseStatus.state === "blocked") {
    return {
      state: "blocked",
      summary: databaseStatus.summary,
      details: databaseStatus.lastError?.details?.recommendedAction as string | undefined,
      running: status?.running ?? false,
      ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
      database: databaseStatus,
    };
  }
  if (nextBootState.phase === "failed") {
    return {
      state: "blocked",
      summary: nextBootState.message,
      ...(nextBootState.code !== undefined ? { code: nextBootState.code } : {}),
      ...(nextBootState.details !== undefined ? { details: nextBootState.details } : {}),
      running: status?.running ?? false,
      ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
      database: databaseStatus,
    };
  }
  if (nextBootState.phase === "ready") {
    return {
      state: "healthy",
      summary: "Runtime ready.",
      running: status?.running ?? false,
      ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
      database: databaseStatus,
    };
  }
  return {
    state: "degraded",
    summary: nextBootState.message,
    ...(nextBootState.code !== undefined ? { code: nextBootState.code } : {}),
    ...(nextBootState.details !== undefined ? { details: nextBootState.details } : {}),
    running: status?.running ?? false,
    ...(status?.logPath !== undefined ? { logPath: status.logPath } : {}),
    database: databaseStatus,
  };
}

function updateBootState(nextState: DesktopBootState, webContents: WebContents | undefined): void {
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
    ...(nextState.database !== undefined ? { database: nextState.database } : { database: databaseStatus }),
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
    detail: desktopConfig.isPackaged ? "Packaged resources resolved." : "Development resources resolved from the repo.",
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
  const microphone = process.platform === "darwin"
    ? systemPreferences.getMediaAccessStatus("microphone")
    : "unknown";
  const probes = await probeDesktopCapabilities({
    projects: desktopSettings.projects,
    databaseReady: databaseStatus?.state === "healthy",
    microphone,
    mcpServers: discovery.servers,
    settings: desktopSettings,
  });
  return resolveDesktopCapabilityView({ settings: desktopSettings, credentials, probes });
}

function parseDesktopThreadId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({ code: "desktop.invalid_attachment_thread", message: "Attachment thread ID must be a non-empty string." });
  }
  return value.trim();
}

function parseDesktopAttachmentId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({ code: "desktop.invalid_attachment_id", message: "Attachment ID must be a non-empty string." });
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
  const managedIds = new Set(desktopSettings.mcpServers.map((server) => server.id));
  return {
    ...discovered,
    servers: [
      ...desktopSettings.mcpServers.map((server) => ({
        ...server,
        args: server.args !== undefined ? [...server.args] : undefined,
        tools: server.tools?.map((tool) => ({ ...tool })),
      })),
      ...discovered.servers.filter((server) => managedIds.has(server.id) === false),
    ],
  };
}

function requireDesktopRunnerAdapter(
  transport: DesktopRunnerControlTransport,
): WebRunnerAdapter {
  if (desktopRunnerAdapter === undefined) {
    desktopRunnerAdapter = createWebRunnerAdapter({
      profile: buildDesktopRunnerProfile(desktopModelPolicy, desktopSettings),
      transportFactory: () => transport,
    });
  }
  return desktopRunnerAdapter;
}

function resolveDesktopExecutionProfile(selection: DesktopExecutionSelection) {
  const resolved = resolveDesktopModelConfiguration(
    desktopSettings.modelConfigurations,
    selection.modelConfiguration,
  );
  if (resolved === undefined) {
    throw createDesktopError({
      code: "desktop.model_configuration_not_found",
      message: "The selected model configuration revision is unavailable.",
      details: JSON.stringify(selection.modelConfiguration),
    });
  }
  const selectedAppTools = new Set<string>();
  for (const app of selection.apps) {
    const definition = getDesktopAppDefinition(app.id, app.contractVersion);
    if (definition === undefined) {
      throw createDesktopError({
        code: "desktop.app_contract_not_found",
        message: `The selected app contract '${app.id}@${app.contractVersion}' is unavailable.`,
      });
    }
    for (const toolName of definition.toolNames) {
      selectedAppTools.add(toolName);
    }
  }
  const allAppTools = new Set(
    listDesktopAppDefinitions().flatMap((definition) => definition.toolNames),
  );
  const baseProfile = buildDesktopRunnerProfile(resolved.revision.policy);
  const toolAllowlist = [
    ...(baseProfile.toolAllowlist ?? []).filter((toolName) => allAppTools.has(toolName) === false),
    ...selectedAppTools,
  ];
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(selection))
    .digest("hex")
    .slice(0, 12);
  return {
    ...baseProfile,
    id: `${baseProfile.id}-${fingerprint}`,
    label: `${resolved.configuration.name} · ${baseProfile.label}`,
    toolAllowlist: [...new Set(toolAllowlist)],
  };
}

async function resetDesktopRunnerAdapter(): Promise<void> {
  const adapter = desktopRunnerAdapter;
  desktopRunnerAdapter = undefined;
  await adapter?.close();
}

async function refreshDesktopCoreState(): Promise<void> {
  const response = await requireLocalCoreConnectionManager().executeIdempotent(
    async (client) => await client.desktopSettings<Partial<DesktopSettings>>(),
  );
  desktopSettings = normalizeDesktopSettings(response.settings, {
    fallbackModelPolicy: response.modelPolicy,
  });
  desktopModelPolicy = response.modelPolicy;
  projectFileIndex.retainRoots(desktopSettings.projects.map((project) => project.path));
}

async function migrateDesktopCredentialsToLocalCore(): Promise<void> {
  const legacyCredentials: Array<{
    id: LocalCoreCredentialId;
    value: string | undefined;
  }> = [
    { id: "provider.openrouter.default", value: desktopSettings.openrouterApiKey },
    { id: "provider.openai.default", value: desktopSettings.openaiApiKey },
    { id: "provider.anthropic.default", value: desktopSettings.anthropicApiKey },
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
      legacyValue !== undefined
      && currentStatus.credentials.some(
        (status) => status.id === credential.id && status.configured,
      ) === false
    ) {
      await manager.executeOnce(
        async (client) => await client.setCredential(credential.id, legacyValue),
      );
    }
  }
  await manager.executeOnce(async (client) => await client.patchSettings({
    openrouterApiKey: null,
    openaiApiKey: null,
    anthropicApiKey: null,
    tavilyApiKey: null,
    databaseUrl: null,
  }));
  await refreshDesktopCoreState();
}

async function saveDesktopCoreSettings(
  settings: Partial<DesktopSettings> & { modelPolicy?: unknown | undefined },
): Promise<void> {
  const normalized = normalizeDesktopSettings(settings, {
    fallbackModelPolicy: desktopModelPolicy,
  });
  const response = await requireLocalCoreConnectionManager().executeIdempotent(
    async (client) => await client.patchDesktopSettings<Partial<DesktopSettings>>({
      ...normalized,
      ...(settings.modelPolicy !== undefined ? { modelPolicy: settings.modelPolicy } : {}),
    }),
  );
  desktopSettings = normalizeDesktopSettings(response.settings, {
    fallbackModelPolicy: response.modelPolicy,
  });
  desktopModelPolicy = response.modelPolicy;
  projectFileIndex.retainRoots(desktopSettings.projects.map((project) => project.path));
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
    updateBootState({
      phase: "starting_runtime",
      message: input.restartMessage,
      database: databaseStatus,
    }, mainWindow?.webContents);
    await runner.restart();
    updateBootState({
      phase: "ready",
      message: "Desktop ready.",
      database: databaseStatus,
    }, mainWindow?.webContents);
  }
  runtimeHealth = deriveRuntimeHealth(bootState);
  mainWindow?.webContents.send("desktop:runtime-health", runtimeHealth);
  return await readDesktopRendererSettings();
}

async function readDesktopRendererSettings(): Promise<DesktopRendererSettings> {
  const selectedProvider = desktopSettings.selectedProvider;
  if (
    selectedProvider === "ollama"
    || selectedProvider === "lmstudio"
  ) {
    return toDesktopRendererSettings(desktopSettings, new Set([selectedProvider]));
  }
  const status = await requireLocalCoreConnectionManager().executeIdempotent(
    async (client) => await client.credentialStatus(),
  );
  const configuredProviders = new Set<DesktopModelProvider>();
  for (const provider of ["openrouter", "openai", "anthropic"] as const) {
    if (status.credentials.some(
      (credential) => credential.id === `provider.${provider}.default` && credential.configured,
    )) {
      configuredProviders.add(provider);
    }
  }
  return toDesktopRendererSettings(desktopSettings, configuredProviders);
}

function subscribeToCoreProjectRuns(client?: LocalCoreClient): void {
  const activeClient = client ?? requireLocalCoreConnectionManager().current()?.client;
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
      requireLocalCoreConnectionManager().invalidate(activeClient);
      console.warn("Desktop project run event stream failed", { error });
    },
  });
}

async function stopCoreProjectRuns(): Promise<void> {
  const client = localCoreConnectionManager?.current()?.client;
  if (client === undefined) {
    return;
  }
  const runs = await client.listDesktopProjectRuns().catch(() => []);
  await Promise.all(runs
    .filter((run) => run.status === "running" || run.status === "stopping")
    .map((run) => client.stopDesktopProjectRun(run.runId).catch(() => {})));
}

async function restartLocalCoreForDatabaseSettingsChange(): Promise<void> {
  localCoreStatus = await requireLocalCoreConnectionManager().executeOnce(
    async (client) => await client.restart(),
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
  const run = (await requireLocalCoreConnectionManager().executeIdempotent(
    async (client) => await client.listDesktopProjectRuns(),
  ))
    .find((entry) => entry.runId === input.runId);
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
      message: "Project run previews require an http(s) URL without embedded credentials.",
    });
  }
  const matchedUrl = run.previewUrls?.find((entry) => entry.url === requestedUrl)?.url;
  if (matchedUrl === undefined) {
    throw createDesktopError({
      code: "desktop.project_run_preview_url_not_recorded",
      message: "Project run previews can only open URLs emitted by that managed run.",
    });
  }
  return { run, url: matchedUrl };
}

function isPreviewableHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0;
  } catch {
    return false;
  }
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
    coreVersion: app.getVersion(),
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
  return {
    ...ready,
    client: ready.client,
  };
}

function createAppDatabaseController(
  settings: DesktopSettings,
): DesktopDatabaseController {
  currentDatabaseUrlSource = settings.databaseMode === "external" ? "desktop_external" : "desktop_managed";
  return createCoreOwnedDesktopDatabaseController({
    readCurrentStatus: () => localCoreStatus,
    ensureReady: async () => {
      localCoreStatus = await requireLocalCoreConnectionManager().executeIdempotent(
        async (client) => await client.status(),
      );
      currentDatabaseUrl = localCoreStatus.databaseUrl;
      return localCoreStatus;
    },
  });
}
