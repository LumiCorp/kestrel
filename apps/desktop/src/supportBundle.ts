import type {
  DesktopBootState,
  DesktopRuntimeStatus,
} from "./contracts.js";
import type {
  DesktopDatabaseStatus,
  DesktopManagedProjectRun,
  DesktopRuntimeHealth,
  DesktopSettings,
} from "../../../src/desktopShell/contracts.js";
import {
  buildSupportBundle,
  type SupportBundle,
} from "../../../src/diagnostics/supportBundle.js";
import type { LocalCoreStatus } from "../../../src/localCore/contracts.js";

export interface DesktopSupportBundleInput {
  generatedAt: string;
  appInfo: {
    name: string;
    version: string;
    isPackaged: boolean;
  };
  bootState: DesktopBootState;
  runtimeHealth: DesktopRuntimeHealth;
  databaseStatus: DesktopDatabaseStatus;
  settings: DesktopSettings;
  projectRuns: DesktopManagedProjectRun[];
  runtimeStatus?: DesktopRuntimeStatus | undefined;
  paths: {
    runtimeLogPath?: string | undefined;
    settingsPath?: string | undefined;
  };
  localCoreStatus?: LocalCoreStatus | undefined;
  coreSupportBundle?: unknown | undefined;
}

export function buildDesktopSupportBundle(input: DesktopSupportBundleInput): SupportBundle {
  return buildSupportBundle({
    source: "desktop",
    generatedAt: input.generatedAt,
    app: {
      name: input.appInfo.name,
      version: input.appInfo.version,
      isPackaged: input.appInfo.isPackaged,
      surface: "desktop",
    },
    readiness: {
      state: input.runtimeHealth.state,
      title: input.bootState.phase,
      detail: input.runtimeHealth.summary,
    },
    settings: input.settings,
    runtime: {
      ...input.runtimeHealth,
      ...(input.runtimeStatus !== undefined ? { status: input.runtimeStatus } : {}),
    },
    database: { ...input.databaseStatus },
    projectRuns: input.projectRuns,
    logs: [
      ...(input.paths.runtimeLogPath !== undefined ? [{ label: "runtime", path: input.paths.runtimeLogPath }] : []),
      ...(input.databaseStatus.logPath !== undefined ? [{ label: "database", path: input.databaseStatus.logPath }] : []),
      ...(input.paths.settingsPath !== undefined ? [{ label: "settings", path: input.paths.settingsPath }] : []),
    ],
    extra: {
      boot: input.bootState,
      ...(input.localCoreStatus !== undefined ? { localCore: input.localCoreStatus } : {}),
      ...(input.coreSupportBundle !== undefined ? { coreSupportBundle: input.coreSupportBundle } : {}),
    },
  });
}
