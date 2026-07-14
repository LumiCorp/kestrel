export const LOCAL_CORE_MANIFEST_VERSION = 2;
export const LOCAL_CORE_LOCK_VERSION = 1;
export const LOCAL_CORE_SCHEMA_VERSION = 1;
export const LOCAL_CORE_STATE_EPOCH = "0.6";
export const LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION = 1;
export const LOCAL_CORE_DESKTOP_PROFILE_ID = "local-core-desktop";

export interface LocalCoreDesktopProfileSnapshot {
  id: typeof LOCAL_CORE_DESKTOP_PROFILE_ID;
  label: string;
  agent: "reference-react";
  shellKind: "desktop";
  presetId: "desktop_dev_local";
  modelProvider: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";
  model: string;
  modeSystemV2Enabled: true;
  defaultInteractionMode: "chat" | "plan" | "build";
  defaultActSubmode: "strict" | "safe" | "full_auto";
}

export interface LocalCoreDesktopExecutionConfig {
  version: typeof LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION;
  profileId: typeof LOCAL_CORE_DESKTOP_PROFILE_ID;
  resolvedProfile: LocalCoreDesktopProfileSnapshot;
}

/**
 * Parse the Core-owned Desktop execution snapshot at the client boundary.
 * Desktop uses `profileId` for execution and treats `resolvedProfile` as
 * display/request-shaping data, never as inline execution authority.
 */
export function parseLocalCoreDesktopExecutionConfig(
  value: unknown,
): LocalCoreDesktopExecutionConfig {
  const record = requireLocalCoreRecord(value, "Desktop execution config");
  rejectUnknownLocalCoreFields(
    record,
    new Set(["version", "profileId", "resolvedProfile"]),
    "Desktop execution config",
  );
  if (record.version !== LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION) {
    throw new Error(
      `Local Core Desktop execution config.version must be ${LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION}.`,
    );
  }
  if (record.profileId !== LOCAL_CORE_DESKTOP_PROFILE_ID) {
    throw new Error(
      `Local Core Desktop execution config.profileId must be '${LOCAL_CORE_DESKTOP_PROFILE_ID}'.`,
    );
  }

  const profile = requireLocalCoreRecord(
    record.resolvedProfile,
    "Desktop execution config.resolvedProfile",
  );
  rejectUnknownLocalCoreFields(
    profile,
    new Set([
      "id",
      "label",
      "agent",
      "shellKind",
      "presetId",
      "modelProvider",
      "model",
      "modeSystemV2Enabled",
      "defaultInteractionMode",
      "defaultActSubmode",
    ]),
    "Desktop execution config.resolvedProfile",
  );
  if (profile.id !== record.profileId) {
    throw new Error("Local Core Desktop execution config profile id does not match profileId.");
  }
  const label = requireLocalCoreString(
    profile.label,
    "Desktop execution config.resolvedProfile.label",
  );
  if (profile.agent !== "reference-react") {
    throw new Error("Local Core Desktop execution config resolvedProfile.agent must be 'reference-react'.");
  }
  if (profile.shellKind !== "desktop") {
    throw new Error("Local Core Desktop execution config resolvedProfile must target the Desktop shell.");
  }
  if (profile.presetId !== "desktop_dev_local") {
    throw new Error("Local Core Desktop execution config resolvedProfile must use the Desktop preset.");
  }
  if (
    profile.modelProvider !== "openrouter"
    && profile.modelProvider !== "openai"
    && profile.modelProvider !== "anthropic"
    && profile.modelProvider !== "ollama"
    && profile.modelProvider !== "lmstudio"
  ) {
    throw new Error("Local Core Desktop execution config resolvedProfile.modelProvider is invalid.");
  }
  const model = requireLocalCoreString(
    profile.model,
    "Desktop execution config.resolvedProfile.model",
  );
  if (profile.modeSystemV2Enabled !== true) {
    throw new Error("Local Core Desktop execution config resolvedProfile must enable mode-system v2.");
  }
  if (
    profile.defaultInteractionMode !== "chat"
    && profile.defaultInteractionMode !== "plan"
    && profile.defaultInteractionMode !== "build"
  ) {
    throw new Error("Local Core Desktop execution config resolvedProfile.defaultInteractionMode is invalid.");
  }
  if (
    profile.defaultActSubmode !== "strict"
    && profile.defaultActSubmode !== "safe"
    && profile.defaultActSubmode !== "full_auto"
  ) {
    throw new Error("Local Core Desktop execution config resolvedProfile.defaultActSubmode is invalid.");
  }

  return {
    version: LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION,
    profileId: LOCAL_CORE_DESKTOP_PROFILE_ID,
    resolvedProfile: {
      id: LOCAL_CORE_DESKTOP_PROFILE_ID,
      label,
      agent: "reference-react",
      shellKind: "desktop",
      presetId: "desktop_dev_local",
      modelProvider: profile.modelProvider,
      model,
      modeSystemV2Enabled: true,
      defaultInteractionMode: profile.defaultInteractionMode,
      defaultActSubmode: profile.defaultActSubmode,
    },
  };
}

function requireLocalCoreRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Local Core ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireLocalCoreString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Local Core ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function rejectUnknownLocalCoreFields(
  value: Record<string, unknown>,
  supported: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => supported.has(key) === false);
  if (unknown !== undefined) {
    throw new Error(`Local Core ${label} includes unsupported field '${unknown}'.`);
  }
}

export type KestrelCoreHomeSource =
  | "default"
  | "explicit_core_home"
  | "isolated_dev_home";

export interface KestrelCoreHomeResolution {
  productRootPath: string;
  homePath: string;
  stateEpoch: typeof LOCAL_CORE_STATE_EPOCH;
  source: KestrelCoreHomeSource;
  isolated: boolean;
  platform: NodeJS.Platform;
}

export type LocalCoreConfiguredDatabaseMode = "pglite" | "external";

// `managed` remains accepted at legacy call sites while the CLI and Desktop
// migrate to the explicit `pglite` spelling. It is never persisted in a v2
// manifest and always normalizes to `pglite` at the Core boundary.
export type LocalCoreDatabaseMode = LocalCoreConfiguredDatabaseMode | "managed" | "unavailable";

export interface LocalCorePaths {
  productRootPath: string;
  stateRootPath: string;
  corePath: string;
  manifestPath: string;
  lockPath: string;
  migrationLockPath: string;
  apiSocketPath: string;
  apiTokenPath: string;
  runtimePath: string;
  settingsPath: string;
  workspaceRegistryPath: string;
  logsPath: string;
  diagnosticsPath: string;
  pgliteDataPath: string;
  postgresDataPath: string;
  postgresSocketPath: string;
  postgresMetadataPath: string;
  postgresLogPath: string;
}

export interface LocalCoreManifest {
  version: typeof LOCAL_CORE_MANIFEST_VERSION;
  stateEpoch: string;
  coreVersion: string;
  schemaVersion: number;
  homePath: string;
  dbMode: LocalCoreConfiguredDatabaseMode;
  capabilities: string[];
  paths: LocalCorePaths;
  createdAt: string;
  updatedAt: string;
}

export interface LocalCoreLock {
  version: typeof LOCAL_CORE_LOCK_VERSION;
  ownerPid: number;
  /** Identifies the specific Core authority instance, not merely its process. */
  authorityId?: string | undefined;
  ownerExecutable: string;
  coreVersion: string;
  schemaVersion?: number | undefined;
  startedAt: string;
  heartbeatAt: string;
  socketPath?: string | undefined;
  databaseSocketPath?: string | undefined;
}

export interface LocalCoreMigrationLock {
  version: typeof LOCAL_CORE_LOCK_VERSION;
  ownerPid: number;
  ownerExecutable: string;
  coreVersion: string;
  schemaVersion: number;
  startedAt: string;
  heartbeatAt: string;
}

export type LocalCoreLockState =
  | "missing"
  | "live"
  | "stale"
  | "incompatible"
  | "repair_required";

export type LocalCoreLockReadResult =
  | { state: "missing"; lockPath: string }
  | { state: "live" | "stale" | "incompatible"; lockPath: string; lock: LocalCoreLock; reason?: string | undefined }
  | { state: "repair_required"; lockPath: string; reason: string; raw?: unknown | undefined };

export type LocalCoreMigrationLockReadResult =
  | { state: "missing"; lockPath: string }
  | { state: "live" | "stale" | "incompatible"; lockPath: string; lock: LocalCoreMigrationLock; reason?: string | undefined }
  | { state: "repair_required"; lockPath: string; reason: string; raw?: unknown | undefined };

export type LocalCoreStatusState =
  | "missing"
  | "starting"
  | "healthy"
  | "degraded"
  | "blocked";

export interface LocalCoreFailure {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface LocalCoreDatabaseStatus {
  mode: LocalCoreDatabaseMode;
  state: LocalCoreStatusState;
  summary: string;
  managed: boolean;
  initialized: boolean;
  running: boolean;
  identityVerified: boolean;
  pglitePath?: string | undefined;
  dataPath?: string | undefined;
  socketPath?: string | undefined;
  metadataPath?: string | undefined;
  databaseUrl?: string | undefined;
  database?: string | undefined;
  user?: string | undefined;
  port?: number | undefined;
  logPath?: string | undefined;
  lastError?: LocalCoreFailure | undefined;
}

export interface LocalCoreMigrationStatus {
  state: LocalCoreStatusState;
  summary: string;
  schemaVersion: number;
  lock: LocalCoreMigrationLockReadResult;
  migrated: boolean;
  lastError?: LocalCoreFailure | undefined;
}

export interface LocalCoreStatus {
  state: LocalCoreStatusState;
  summary: string;
  home: KestrelCoreHomeResolution;
  manifest?: LocalCoreManifest | undefined;
  lock: LocalCoreLockReadResult;
  dbMode: LocalCoreDatabaseMode;
  database: LocalCoreDatabaseStatus;
  migrations?: LocalCoreMigrationStatus | undefined;
  databaseUrl?: string | undefined;
  databaseSocketPath?: string | undefined;
  settingsReady: boolean;
  workspaceRegistryReady: boolean;
  diagnosticsPath: string;
  logsPath: string;
  lastError?: LocalCoreFailure | undefined;
}

export interface EnsureLocalCoreReadyOptions {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  coreVersion: string;
  schemaVersion?: number | undefined;
  ownerExecutable?: string | undefined;
  lockOwnerPid?: number | undefined;
  lockAuthorityId?: string | undefined;
  now?: Date | undefined;
  isPidAlive?: ((pid: number) => boolean) | undefined;
  databaseMode?: "pglite" | "managed" | "external" | undefined;
  externalDatabaseUrl?: string | undefined;
  allowInheritedDatabaseUrl?: boolean | undefined;
  postgresBundleRootPath?: string | undefined;
  runMigrations?: boolean | undefined;
  repoRoot?: string | undefined;
}
