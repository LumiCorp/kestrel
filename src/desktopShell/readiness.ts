import type {
  DesktopBootState,
  DesktopDatabaseStatus,
  DesktopReadinessItem,
  DesktopReadinessItemId,
  DesktopReadinessState,
  DesktopReadinessSummary,
  DesktopReadinessView,
  DesktopRuntimeHealth,
  DesktopSettings,
} from "./contracts.js";
import { deriveDesktopOnboardingState } from "./onboarding.js";

export interface DeriveDesktopReadinessInput {
  isDesktopApp: boolean;
  bootState?: DesktopBootState | undefined;
  runtimeHealth?: DesktopRuntimeHealth | undefined;
  databaseStatus?: DesktopDatabaseStatus | undefined;
  settings?: DesktopSettings | undefined;
  providerConfigured?: boolean | undefined;
  bridgeConnected?: boolean | undefined;
  resourcesReady?: boolean | undefined;
  resourcesDetail?: string | undefined;
  settingsLoaded?: boolean | undefined;
  projectCount?: number | undefined;
}

export function deriveDesktopReadiness(input: DeriveDesktopReadinessInput): DesktopReadinessView {
  if (input.isDesktopApp === false) {
    return {
      summary: {
        state: "ready",
        title: "Web client ready",
        detail: "Desktop-only runtime checks are not required in browser mode.",
      },
      items: [
        item("resources", "Local resources", "not_applicable", "Local app resources are managed by the web server."),
        item("settings", "Settings", "not_applicable", "Local Kestrel settings are not used in browser mode."),
        item("provider", "Model provider", "unknown", "Provider readiness is handled by the web profile."),
        item("database", "Database", "not_applicable", "Kestrel Local Core database checks are not used in browser mode."),
        item("runner", "Runtime", "not_applicable", "Desktop runtime control is unavailable in browser mode.", undefined, {
          label: "Open Desktop",
          command: "reinstall_desktop",
        }),
        item("web", "Cockpit server", "ready", "Web client is loaded."),
        item("bridge", "Desktop bridge", "not_applicable", "No Desktop bridge is expected in browser mode."),
        item("projects", "Projects", "not_applicable", "Desktop project library is unavailable in browser mode."),
      ],
    };
  }

  const bootState = input.bootState;
  const runtimeHealth = input.runtimeHealth;
  const database = input.databaseStatus ?? bootState?.database ?? runtimeHealth?.database;
  const bridgeConnected = input.bridgeConnected ?? true;
  const onboarding = input.settings !== undefined
    ? deriveDesktopOnboardingState(input.settings)
    : undefined;
  const providerConfigured =
    onboarding?.providerRequirementState === "ready"
      ? true
      : onboarding?.providerRequirementState === "choice_required"
        ? false
        : input.providerConfigured;
  const resourcesReady = input.resourcesReady;
  const settingsLoaded = input.settingsLoaded;
  const projectCount = input.projectCount;

  const items: DesktopReadinessItem[] = [
    item(
      "resources",
      "Local resources",
      resourcesReady === false ? "blocked" : resourcesReady === true ? "ready" : "unknown",
      resourcesReady === false
        ? "Required Desktop resources are missing."
        : resourcesReady === true
          ? "Bundled app resources are present."
          : "Resource check has not reported yet.",
      input.resourcesDetail,
      resourcesReady === false
        ? {
            label: "Reinstall Desktop",
            command: "reinstall_desktop",
          }
        : undefined,
    ),
    item(
      "settings",
      "Settings",
      settingsLoaded === false ? "starting" : settingsLoaded === true ? "ready" : "unknown",
      settingsLoaded === false
        ? "Loading local Kestrel settings."
        : settingsLoaded === true
          ? "Local Kestrel settings are loaded."
          : "Settings load has not reported yet.",
    ),
    item(
      "provider",
      "Model provider",
      onboarding?.providerRequirementState === "choice_required"
        ? "degraded"
        : onboarding?.providerRequirementState === "credential_required"
          ? onboarding.providerIssueOwnedBySetup
            ? "degraded"
            : "blocked"
          : providerConfigured === false
            ? "blocked"
            : providerConfigured === true
              ? "ready"
              : "unknown",
      onboarding?.providerRequirementState === "choice_required"
        ? "Choose a model provider to finish Desktop setup."
        : onboarding?.providerRequirementState === "credential_required"
          ? onboarding.providerIssueOwnedBySetup
            ? "Add the selected provider API key to finish Desktop setup."
            : "The selected model provider has no configured key."
          : providerConfigured === true
            ? "The selected model provider is configured."
            : providerConfigured === false
              ? "The selected model provider has no configured key."
              : "Provider key status has not reported yet.",
      undefined,
      (onboarding?.providerRequirementState !== "ready" ||
        providerConfigured === false)
        ? {
            label: "Open Settings",
            command: "open_settings",
          }
        : undefined,
    ),
    databaseItem(database, bootState?.phase),
    item(
      "runner",
      "Runtime",
      runtimeState(runtimeHealth, bootState),
      runnerDetail(runtimeHealth, bootState),
      runtimeHealth?.running === true ? "runner process is active" : "runner process is not active",
      runnerAction(runtimeHealth, bootState),
    ),
    item(
      "web",
      "Desktop renderer",
      bootState?.phase === "ready"
        ? "ready"
        : bootState?.phase === "starting_web"
          ? "starting"
          : bootState === undefined
            ? "unknown"
            : bootState.phase === "failed"
              ? "blocked"
              : "starting",
      bootState?.phase === "ready"
        ? "Desktop renderer is loaded."
        : bootState?.message ?? "Waiting for Desktop boot state.",
      bootState?.webUrl,
    ),
    item(
      "bridge",
      "Desktop bridge",
      bridgeConnected ? "ready" : "blocked",
      bridgeConnected ? "Electron bridge is connected." : "Electron bridge is not connected.",
      undefined,
      bridgeConnected
        ? undefined
        : {
            label: "Open Logs",
            command: "open_logs",
          },
    ),
    item(
      "projects",
      "Projects",
      projectCount === undefined ? "unknown" : "ready",
      projectCount === undefined
        ? "Project library has not loaded yet."
        : projectCount === 0
          ? "No project folders are registered yet."
          : `${projectCount} project folder${projectCount === 1 ? "" : "s"} registered.`,
      projectCount === undefined ? undefined : `${projectCount} registered`,
      projectCount === 0
        ? {
            label: "Add Project",
            command: "add_project",
          }
        : undefined,
    ),
  ];

  return {
    summary: summarize(items, bootState, runtimeHealth),
    items,
  };
}

export function isDesktopControlPlaneReady(input: {
  isDesktopApp: boolean;
  bootState?: DesktopBootState | undefined;
  runtimeHealth?: DesktopRuntimeHealth | undefined;
}): boolean {
  const databaseStatus = input.runtimeHealth?.database
    ?? input.bootState?.database
    ?? (input.bootState?.phase === "ready"
      ? {
          state: "healthy" as const,
          summary: "Kestrel Local Core database is ready.",
          managed: false,
          initialized: true,
          running: true,
        }
      : undefined);
  return deriveDesktopReadiness({
    ...input,
    databaseStatus,
    settings: undefined,
    providerConfigured: true,
    resourcesReady: true,
    settingsLoaded: true,
    bridgeConnected: true,
    projectCount: 1,
  }).summary.state === "ready";
}

function item(
  id: DesktopReadinessItemId,
  label: string,
  state: DesktopReadinessState,
  detail: string,
  evidence?: string,
  action?: DesktopReadinessItem["action"],
): DesktopReadinessItem {
  return {
    id,
    label,
    state,
    detail,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(action !== undefined ? { action } : {}),
  };
}

function databaseItem(
  database: DesktopDatabaseStatus | undefined,
  bootPhase: DesktopBootState["phase"] | undefined,
): DesktopReadinessItem {
  if (database === undefined) {
    return item(
      "database",
      "Database",
      bootPhase === "starting_database" ? "starting" : "unknown",
      bootPhase === "starting_database" ? "Starting Kestrel Local Core database." : "Database status has not reported yet.",
      undefined,
      bootPhase === "starting_database"
        ? undefined
        : {
            label: "Open Logs",
            command: "open_logs",
          },
    );
  }
  const state: DesktopReadinessState =
    database.state === "healthy"
      ? "ready"
      : database.state === "starting"
        ? "starting"
        : database.state;
  return item(
    "database",
    "Database",
    state,
    database.summary,
    database.running ? "database process is reachable" : "database process is not reachable",
    state === "blocked"
      ? {
          label: "Retry Database",
          command: "restart_database",
        }
      : state === "degraded"
        ? {
            label: "Restart Database",
            command: "restart_database",
          }
        : undefined,
  );
}

function runtimeState(
  runtimeHealth: DesktopRuntimeHealth | undefined,
  bootState: DesktopBootState | undefined,
): DesktopReadinessState {
  if (runtimeHealth !== undefined) {
    return runtimeHealth.state === "healthy" ? "ready" : runtimeHealth.state;
  }
  if (bootState?.phase === "starting_runtime") {
    return "starting";
  }
  if (bootState?.phase === "failed") {
    return "blocked";
  }
  return "unknown";
}

function runnerDetail(
  runtimeHealth: DesktopRuntimeHealth | undefined,
  bootState: DesktopBootState | undefined,
): string {
  if (runtimeHealth !== undefined) {
    return runtimeHealth.summary;
  }
  return bootState?.phase === "starting_runtime"
    ? "Starting Kestrel runtime."
    : bootState?.message ?? "Runtime health has not reported yet.";
}

function runnerAction(
  runtimeHealth: DesktopRuntimeHealth | undefined,
  bootState: DesktopBootState | undefined,
): DesktopReadinessItem["action"] | undefined {
  const state = runtimeState(runtimeHealth, bootState);
  if (state === "blocked" || state === "degraded") {
    return {
      label: runtimeHealth?.code === "STORE_SQLITE_INIT_FAILED" ? "Copy Help Packet" : "Restart Runtime",
      command: runtimeHealth?.code === "STORE_SQLITE_INIT_FAILED" ? "copy_help_packet" : "restart_runtime",
    };
  }
  return undefined;
}

function summarize(
  items: DesktopReadinessItem[],
  bootState: DesktopBootState | undefined,
  runtimeHealth: DesktopRuntimeHealth | undefined,
): DesktopReadinessSummary {
  if (items.some((entry) => entry.state === "blocked")) {
    return {
      state: "blocked",
      title: "Desktop startup blocked",
      detail: firstItemInState(items, "blocked")?.detail
        ?? runtimeHealth?.summary
        ?? bootState?.message
        ?? "One or more Desktop checks are blocked.",
    };
  }
  if (items.some((entry) => entry.state === "degraded")) {
    return {
      state: "degraded",
      title: "Desktop degraded",
      detail: firstItemInState(items, "degraded")?.detail
        ?? runtimeHealth?.summary
        ?? "Desktop is available with degraded checks.",
    };
  }
  if (items.some((entry) => entry.state === "starting")) {
    return {
      state: "starting",
      title: "Desktop starting",
      detail: bootState?.message ?? "Desktop checks are still starting.",
    };
  }
  if (items.some((entry) => entry.state === "unknown")) {
    return {
      state: "unknown",
      title: "Desktop status unknown",
      detail: "Some Desktop checks have not reported yet.",
    };
  }
  return {
    state: "ready",
    title: "Desktop ready",
    detail: runtimeHealth?.summary ?? "Desktop runtime is ready.",
  };
}

function firstItemInState(
  items: DesktopReadinessItem[],
  state: DesktopReadinessState,
): DesktopReadinessItem | undefined {
  return items.find((entry) => entry.state === state && entry.action !== undefined)
    ?? items.find((entry) => entry.state === state);
}
