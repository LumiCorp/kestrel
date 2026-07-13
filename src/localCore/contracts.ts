export const LOCAL_CORE_MANIFEST_VERSION = 2;
export const LOCAL_CORE_LOCK_VERSION = 1;
export const LOCAL_CORE_SCHEMA_VERSION = 1;
export const LOCAL_CORE_STATE_EPOCH = "0.6";

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
