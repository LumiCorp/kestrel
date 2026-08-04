import type { TuiProfile } from "../../cli/contracts.js";
import {
  parseDesktopExecutionSelection,
  type DesktopExecutionSelection,
} from "../desktopShell/configuration.js";
import {
  LOCAL_CORE_LOCK_VERSION,
  LOCAL_CORE_MANIFEST_VERSION,
  LOCAL_CORE_SCHEMA_VERSION,
  LOCAL_CORE_STATE_EPOCH,
} from "./constants.js";

export {
  LOCAL_CORE_LOCK_VERSION,
  LOCAL_CORE_MANIFEST_VERSION,
  LOCAL_CORE_SCHEMA_VERSION,
  LOCAL_CORE_STATE_EPOCH,
} from "./constants.js";
export const LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION = 1;
export const LOCAL_CORE_DESKTOP_PROFILE_ID = "local-core-desktop";
export const LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_VERSION = 1;
/**
 * An advertised Local Core capability required before Desktop can submit or
 * prepare an execution. This is deliberately separate from the shell/Core
 * release version: an endpoint contract can change within a release line.
 */
export const LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_CAPABILITY =
  "local-core.execution-profile-resolution.v1";

export type LocalCoreExecutionProfileResolveRequest =
  | {
      client: "desktop";
      selection: DesktopExecutionSelection;
    }
  | {
      client: "cli";
      profileId: string;
    }
  | {
      client: "web";
      profileId: string;
    };

export interface LocalCoreExecutionProfileResolution {
  version: typeof LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_VERSION;
  profileId: string;
  fingerprint: string;
  policy: {
    id: string;
    version: number;
  };
  environmentPreset: {
    id:
      | "cli_safe_local"
      | "cli_dev_local"
      | "desktop_safe_local"
      | "desktop_dev_local"
      | "workspace_hosted"
      | "web_balanced";
    version: number;
  };
  resolvedProfile: TuiProfile;
}

export function parseLocalCoreExecutionProfileResolveRequest(
  value: unknown,
): LocalCoreExecutionProfileResolveRequest {
  const record = requireLocalCoreRecord(
    value,
    "execution profile resolve request",
  );
  if (record.client === "desktop") {
    rejectUnknownLocalCoreFields(
      record,
      new Set(["client", "selection"]),
      "execution profile resolve request",
    );
    return {
      client: "desktop",
      selection: parseDesktopExecutionSelection(record.selection),
    };
  }
  if (record.client === "cli" || record.client === "web") {
    rejectUnknownLocalCoreFields(
      record,
      new Set(["client", "profileId"]),
      "execution profile resolve request",
    );
    return {
      client: record.client,
      profileId: requireLocalCoreString(
        record.profileId,
        "execution profile resolve request.profileId",
      ),
    };
  }
  throw new Error(
    "Local Core execution profile resolve request.client must be 'desktop', 'cli', or 'web'.",
  );
}

export function parseLocalCoreExecutionProfileResolution(
  value: unknown,
): LocalCoreExecutionProfileResolution {
  const record = requireLocalCoreRecord(value, "execution profile resolution");
  rejectUnknownLocalCoreFields(
    record,
    new Set([
      "version",
      "profileId",
      "fingerprint",
      "policy",
      "environmentPreset",
      "resolvedProfile",
    ]),
    "execution profile resolution",
  );
  if (record.version !== LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_VERSION) {
    throw new Error(
      `Local Core execution profile resolution.version must be ${LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_VERSION}.`,
    );
  }
  const profileId = requireLocalCoreString(
    record.profileId,
    "execution profile resolution.profileId",
  );
  const fingerprint = requireLocalCoreString(
    record.fingerprint,
    "execution profile resolution.fingerprint",
  );
  if (/^[a-f0-9]{64}$/u.test(fingerprint) === false) {
    throw new Error(
      "Local Core execution profile resolution.fingerprint must be a SHA-256 digest.",
    );
  }
  const policy = requireLocalCoreRecord(
    record.policy,
    "execution profile resolution.policy",
  );
  rejectUnknownLocalCoreFields(
    policy,
    new Set(["id", "version"]),
    "execution profile resolution.policy",
  );
  const policyId = requireLocalCoreString(
    policy.id,
    "execution profile resolution.policy.id",
  );
  if (
    typeof policy.version !== "number" ||
    Number.isSafeInteger(policy.version) === false ||
    policy.version < 1
  ) {
    throw new Error(
      "Local Core execution profile resolution.policy.version must be a positive integer.",
    );
  }
  const environmentPreset = requireLocalCoreRecord(
    record.environmentPreset,
    "execution profile resolution.environmentPreset",
  );
  rejectUnknownLocalCoreFields(
    environmentPreset,
    new Set(["id", "version"]),
    "execution profile resolution.environmentPreset",
  );
  if (
    environmentPreset.id !== "cli_safe_local" &&
    environmentPreset.id !== "cli_dev_local" &&
    environmentPreset.id !== "desktop_safe_local" &&
    environmentPreset.id !== "desktop_dev_local" &&
    environmentPreset.id !== "workspace_hosted" &&
    environmentPreset.id !== "web_balanced"
  ) {
    throw new Error(
      "Local Core execution profile resolution.environmentPreset.id is invalid.",
    );
  }
  if (
    typeof environmentPreset.version !== "number" ||
    Number.isSafeInteger(environmentPreset.version) === false ||
    environmentPreset.version < 1
  ) {
    throw new Error(
      "Local Core execution profile resolution.environmentPreset.version must be a positive integer.",
    );
  }
  const profile = requireLocalCoreRecord(
    record.resolvedProfile,
    "execution profile resolution.resolvedProfile",
  ) as Partial<TuiProfile>;
  if (
    profile.id !== profileId ||
    typeof profile.label !== "string" ||
    profile.label.trim().length === 0 ||
    profile.agent !== "kestrel"
  ) {
    throw new Error(
      "Local Core execution profile resolution.resolvedProfile is invalid.",
    );
  }
  if (
    profile.presetId !== "cli_safe_local" &&
    profile.presetId !== "cli_dev_local" &&
    profile.presetId !== "desktop_safe_local" &&
    profile.presetId !== "desktop_dev_local" &&
    profile.presetId !== "workspace_hosted" &&
    profile.presetId !== "web_balanced"
  ) {
    throw new Error(
      "Local Core execution profile resolution.resolvedProfile.presetId is invalid.",
    );
  }
  return {
    version: LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_VERSION,
    profileId,
    fingerprint,
    policy: {
      id: policyId,
      version: policy.version,
    },
    environmentPreset: {
      id: environmentPreset.id,
      version: environmentPreset.version,
    },
    resolvedProfile: structuredClone(profile as TuiProfile),
  };
}

export interface LocalCoreRuntimeStoreResetRequest {
  confirm: true;
}

export interface LocalCoreRuntimeStoreReset {
  storePath: string;
  archivedStorePath: string | null;
  resetAt: string;
}

export interface LocalCoreRuntimeStoreResetResult {
  reset: LocalCoreRuntimeStoreReset;
  status: LocalCoreStatus;
}

export interface LocalCoreSystemLifecycleBlocker {
  code: string;
  message: string;
  count: number;
}

export interface LocalCoreSystemLifecycle {
  state: "idle" | "busy";
  owner: {
    pid: number;
    executable: string;
  };
  blockers: LocalCoreSystemLifecycleBlocker[];
}

export type LocalCoreSystemShutdownRequest =
  | {
      reason: "uninstall";
      confirm: "shutdown-local-core-for-uninstall";
    }
  | {
      reason: "desktop_update";
      confirm: "shutdown-local-core-for-desktop-update";
    }
  | {
      reason: "desktop_restart";
      confirm: "shutdown-local-core-for-desktop-restart";
    };

export type LocalCoreSystemShutdownResult =
  | {
      status: "accepted";
      reason: LocalCoreSystemShutdownRequest["reason"];
      lifecycle: LocalCoreSystemLifecycle;
    }
  | {
      status: "blocked";
      reason: LocalCoreSystemShutdownRequest["reason"];
      lifecycle: LocalCoreSystemLifecycle;
    };

export function parseLocalCoreSystemLifecycle(
  value: unknown,
): LocalCoreSystemLifecycle {
  const record = requireLocalCoreRecord(value, "system lifecycle");
  rejectUnknownLocalCoreFields(
    record,
    new Set(["state", "owner", "blockers"]),
    "system lifecycle",
  );
  if (record.state !== "idle" && record.state !== "busy") {
    throw new Error("Local Core system lifecycle.state must be idle or busy.");
  }
  const owner = requireLocalCoreRecord(record.owner, "system lifecycle.owner");
  rejectUnknownLocalCoreFields(
    owner,
    new Set(["pid", "executable"]),
    "system lifecycle.owner",
  );
  const blockers = requireLocalCoreArray(
    record.blockers,
    "system lifecycle.blockers",
  ).map((entry, index) => {
    const blocker = requireLocalCoreRecord(
      entry,
      `system lifecycle.blockers[${index}]`,
    );
    rejectUnknownLocalCoreFields(
      blocker,
      new Set(["code", "message", "count"]),
      `system lifecycle.blockers[${index}]`,
    );
    return {
      code: requireLocalCoreString(
        blocker.code,
        `system lifecycle.blockers[${index}].code`,
      ),
      message: requireLocalCoreString(
        blocker.message,
        `system lifecycle.blockers[${index}].message`,
      ),
      count: requireLocalCoreInteger(
        blocker.count,
        `system lifecycle.blockers[${index}].count`,
        1,
      ),
    };
  });
  return {
    state: record.state,
    owner: {
      pid: requireLocalCoreInteger(
        owner.pid,
        "system lifecycle.owner.pid",
        1,
      ),
      executable: requireLocalCoreString(
        owner.executable,
        "system lifecycle.owner.executable",
      ),
    },
    blockers,
  };
}

export function parseLocalCoreSystemShutdownRequest(
  value: unknown,
): LocalCoreSystemShutdownRequest {
  const record = requireLocalCoreRecord(value, "system shutdown request");
  rejectUnknownLocalCoreFields(
    record,
    new Set(["reason", "confirm"]),
    "system shutdown request",
  );
  if (
    record.reason === "uninstall" &&
    record.confirm === "shutdown-local-core-for-uninstall"
  ) {
    return {
      reason: "uninstall",
      confirm: "shutdown-local-core-for-uninstall",
    };
  }
  if (
    record.reason === "desktop_update" &&
    record.confirm === "shutdown-local-core-for-desktop-update"
  ) {
    return {
      reason: "desktop_update",
      confirm: "shutdown-local-core-for-desktop-update",
    };
  }
  if (
    record.reason === "desktop_restart" &&
    record.confirm === "shutdown-local-core-for-desktop-restart"
  ) {
    return {
      reason: "desktop_restart",
      confirm: "shutdown-local-core-for-desktop-restart",
    };
  }
  throw new Error(
    "Local Core shutdown requires an exact uninstall, Desktop update, or Desktop restart confirmation payload.",
  );
}

export function parseLocalCoreSystemShutdownResult(
  value: unknown,
): LocalCoreSystemShutdownResult {
  const record = requireLocalCoreRecord(value, "system shutdown result");
  rejectUnknownLocalCoreFields(
    record,
    new Set(["status", "reason", "lifecycle"]),
    "system shutdown result",
  );
  if (record.status !== "accepted" && record.status !== "blocked") {
    throw new Error("Local Core system shutdown result.status is invalid.");
  }
  if (
    record.reason !== "uninstall" &&
    record.reason !== "desktop_update" &&
    record.reason !== "desktop_restart"
  ) {
    throw new Error("Local Core system shutdown result.reason is invalid.");
  }
  return {
    status: record.status,
    reason: record.reason,
    lifecycle: parseLocalCoreSystemLifecycle(record.lifecycle),
  };
}

export function parseLocalCoreRuntimeStoreResetRequest(
  value: unknown,
): LocalCoreRuntimeStoreResetRequest {
  const record = requireLocalCoreRecord(value, "runtime store reset request");
  rejectUnknownLocalCoreFields(
    record,
    new Set(["confirm"]),
    "runtime store reset request",
  );
  if (record.confirm !== true) {
    throw new Error("Local Core runtime store reset requires confirm: true.");
  }
  return { confirm: true };
}

export function parseLocalCoreRuntimeStoreReset(
  value: unknown,
): LocalCoreRuntimeStoreReset {
  const record = requireLocalCoreRecord(value, "runtime store reset");
  rejectUnknownLocalCoreFields(
    record,
    new Set(["storePath", "archivedStorePath", "resetAt"]),
    "runtime store reset",
  );
  const storePath = requireLocalCoreString(
    record.storePath,
    "runtime store reset.storePath",
  );
  const archivedStorePath = record.archivedStorePath === null
    ? null
    : requireLocalCoreString(
        record.archivedStorePath,
        "runtime store reset.archivedStorePath",
      );
  if (archivedStorePath === storePath) {
    throw new Error("Local Core runtime store reset archive must differ from storePath.");
  }
  const resetAt = requireCanonicalIsoTimestamp(
    record.resetAt,
    "runtime store reset.resetAt",
  );
  return { storePath, archivedStorePath, resetAt };
}

export function parseLocalCoreRuntimeStoreResetResult(
  value: unknown,
): LocalCoreRuntimeStoreResetResult {
  const record = requireLocalCoreRecord(value, "runtime store reset result");
  rejectUnknownLocalCoreFields(
    record,
    new Set(["ok", "reset", "status"]),
    "runtime store reset result",
  );
  if (record.ok !== true) {
    throw new Error("Local Core runtime store reset result.ok must be true.");
  }
  return {
    reset: parseLocalCoreRuntimeStoreReset(record.reset),
    status: parseLocalCoreStatus(record.status),
  };
}

export interface LocalCoreDesktopProfileSnapshot {
  id: string;
  label: string;
  agent: "kestrel";
  shellKind: "desktop";
  presetId: "desktop_safe_local" | "desktop_dev_local";
  modelProvider: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";
  model: string;
  modeSystemV2Enabled: true;
  defaultInteractionMode: "chat" | "plan" | "build";
  defaultActSubmode: "strict" | "safe" | "full_auto";
}

export interface LocalCoreDesktopExecutionConfig {
  version: typeof LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION;
  profileId: string;
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
  if (
    typeof record.profileId !== "string" ||
    /^kestrel:desktop_(?:safe|dev)_local:[a-f0-9]{64}$/u.test(record.profileId) ===
      false
  ) {
    throw new Error(
      "Local Core Desktop execution config.profileId must be an immutable Kestrel Desktop profile reference.",
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
  if (profile.agent !== "kestrel") {
    throw new Error("Local Core Desktop execution config resolvedProfile.agent must be 'kestrel'.");
  }
  if (profile.shellKind !== "desktop") {
    throw new Error("Local Core Desktop execution config resolvedProfile must target the Desktop shell.");
  }
  if (
    profile.presetId !== "desktop_safe_local" &&
    profile.presetId !== "desktop_dev_local"
  ) {
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
    profileId: record.profileId,
    resolvedProfile: {
      id: record.profileId,
      label,
      agent: "kestrel",
      shellKind: "desktop",
      presetId: profile.presetId,
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

function requireCanonicalIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireLocalCoreString(value, label);
  let canonical: string;
  try {
    canonical = new Date(timestamp).toISOString();
  } catch {
    throw new Error(`Local Core ${label} must be a canonical ISO timestamp.`);
  }
  if (canonical !== timestamp) {
    throw new Error(`Local Core ${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
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

/**
 * Parse a status document received across the Local Core API boundary.
 *
 * Status is intentionally validated recursively: callers must never treat a
 * partially shaped object as an authoritative view of Core readiness.
 */
export function parseLocalCoreStatus(value: unknown): LocalCoreStatus {
  const record = requireLocalCoreRecord(value, "status");
  rejectUnknownLocalCoreFields(
    record,
    new Set([
      "state",
      "summary",
      "home",
      "manifest",
      "lock",
      "dbMode",
      "database",
      "migrations",
      "databaseUrl",
      "databaseSocketPath",
      "settingsReady",
      "workspaceRegistryReady",
      "diagnosticsPath",
      "logsPath",
      "lastError",
    ]),
    "status",
  );

  const manifest = hasOwnLocalCoreField(record, "manifest")
    ? parseLocalCoreManifest(record.manifest, "status.manifest")
    : undefined;
  const migrations = hasOwnLocalCoreField(record, "migrations")
    ? parseLocalCoreMigrationStatus(record.migrations, "status.migrations")
    : undefined;
  const databaseUrl = parseOptionalLocalCoreString(record, "databaseUrl", "status");
  const databaseSocketPath = parseOptionalLocalCoreString(
    record,
    "databaseSocketPath",
    "status",
  );
  const lastError = hasOwnLocalCoreField(record, "lastError")
    ? parseLocalCoreFailure(record.lastError, "status.lastError")
    : undefined;

  return {
    state: requireLocalCoreStatusState(record.state, "status.state"),
    summary: requireLocalCoreString(record.summary, "status.summary"),
    home: parseKestrelCoreHomeResolution(record.home, "status.home"),
    ...(manifest !== undefined ? { manifest } : {}),
    lock: parseLocalCoreLockReadResult(record.lock, "status.lock"),
    dbMode: requireLocalCoreDatabaseMode(record.dbMode, "status.dbMode"),
    database: parseLocalCoreDatabaseStatus(record.database, "status.database"),
    ...(migrations !== undefined ? { migrations } : {}),
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    ...(databaseSocketPath !== undefined ? { databaseSocketPath } : {}),
    settingsReady: requireLocalCoreBoolean(record.settingsReady, "status.settingsReady"),
    workspaceRegistryReady: requireLocalCoreBoolean(
      record.workspaceRegistryReady,
      "status.workspaceRegistryReady",
    ),
    diagnosticsPath: requireLocalCoreString(record.diagnosticsPath, "status.diagnosticsPath"),
    logsPath: requireLocalCoreString(record.logsPath, "status.logsPath"),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

function parseKestrelCoreHomeResolution(
  value: unknown,
  label: string,
): KestrelCoreHomeResolution {
  const record = requireLocalCoreRecord(value, label);
  rejectUnknownLocalCoreFields(
    record,
    new Set([
      "productRootPath",
      "homePath",
      "stateEpoch",
      "source",
      "isolated",
      "platform",
    ]),
    label,
  );
  if (record.stateEpoch !== LOCAL_CORE_STATE_EPOCH) {
    throw new Error(`Local Core ${label}.stateEpoch must be '${LOCAL_CORE_STATE_EPOCH}'.`);
  }
  if (
    record.source !== "default"
    && record.source !== "explicit_core_home"
    && record.source !== "isolated_dev_home"
  ) {
    throw new Error(`Local Core ${label}.source is invalid.`);
  }
  const supportedPlatforms: ReadonlySet<NodeJS.Platform> = new Set([
    "aix",
    "android",
    "darwin",
    "freebsd",
    "haiku",
    "linux",
    "openbsd",
    "sunos",
    "win32",
    "cygwin",
    "netbsd",
  ]);
  if (typeof record.platform !== "string" || supportedPlatforms.has(record.platform as NodeJS.Platform) === false) {
    throw new Error(`Local Core ${label}.platform is invalid.`);
  }
  return {
    productRootPath: requireLocalCoreString(record.productRootPath, `${label}.productRootPath`),
    homePath: requireLocalCoreString(record.homePath, `${label}.homePath`),
    stateEpoch: LOCAL_CORE_STATE_EPOCH,
    source: record.source,
    isolated: requireLocalCoreBoolean(record.isolated, `${label}.isolated`),
    platform: record.platform as NodeJS.Platform,
  };
}

function parseLocalCoreManifest(value: unknown, label: string): LocalCoreManifest {
  const record = requireLocalCoreRecord(value, label);
  rejectUnknownLocalCoreFields(
    record,
    new Set([
      "version",
      "stateEpoch",
      "coreVersion",
      "schemaVersion",
      "homePath",
      "dbMode",
      "capabilities",
      "paths",
      "createdAt",
      "updatedAt",
    ]),
    label,
  );
  if (record.version !== LOCAL_CORE_MANIFEST_VERSION) {
    throw new Error(`Local Core ${label}.version must be ${LOCAL_CORE_MANIFEST_VERSION}.`);
  }
  return {
    version: LOCAL_CORE_MANIFEST_VERSION,
    stateEpoch: requireLocalCoreString(record.stateEpoch, `${label}.stateEpoch`),
    coreVersion: requireLocalCoreString(record.coreVersion, `${label}.coreVersion`),
    schemaVersion: requireLocalCoreInteger(record.schemaVersion, `${label}.schemaVersion`, 0),
    homePath: requireLocalCoreString(record.homePath, `${label}.homePath`),
    dbMode: requireLocalCoreConfiguredDatabaseMode(record.dbMode, `${label}.dbMode`),
    capabilities: requireLocalCoreStringArray(record.capabilities, `${label}.capabilities`),
    paths: parseLocalCorePaths(record.paths, `${label}.paths`),
    createdAt: requireCanonicalIsoTimestamp(record.createdAt, `${label}.createdAt`),
    updatedAt: requireCanonicalIsoTimestamp(record.updatedAt, `${label}.updatedAt`),
  };
}

function parseLocalCorePaths(value: unknown, label: string): LocalCorePaths {
  const record = requireLocalCoreRecord(value, label);
  const fields = [
    "productRootPath",
    "stateRootPath",
    "corePath",
    "manifestPath",
    "lockPath",
    "migrationLockPath",
    "apiSocketPath",
    "apiTokenPath",
    "runtimePath",
    "settingsPath",
    "workspaceRegistryPath",
    "logsPath",
    "diagnosticsPath",
    "pgliteDataPath",
    "postgresDataPath",
    "postgresSocketPath",
    "postgresMetadataPath",
    "postgresLogPath",
  ] as const;
  rejectUnknownLocalCoreFields(record, new Set(fields), label);
  return Object.fromEntries(
    fields.map((field) => [
      field,
      requireLocalCoreString(record[field], `${label}.${field}`),
    ]),
  ) as unknown as LocalCorePaths;
}

function parseLocalCoreLockReadResult(
  value: unknown,
  label: string,
): LocalCoreLockReadResult {
  const record = requireLocalCoreRecord(value, label);
  if (record.state === "missing") {
    rejectUnknownLocalCoreFields(record, new Set(["state", "lockPath"]), label);
    return {
      state: "missing",
      lockPath: requireLocalCoreString(record.lockPath, `${label}.lockPath`),
    };
  }
  if (
    record.state === "live"
    || record.state === "stale"
    || record.state === "incompatible"
  ) {
    rejectUnknownLocalCoreFields(
      record,
      new Set(["state", "lockPath", "lock", "reason"]),
      label,
    );
    const reason = parseOptionalLocalCoreString(record, "reason", label);
    return {
      state: record.state,
      lockPath: requireLocalCoreString(record.lockPath, `${label}.lockPath`),
      lock: parseLocalCoreLock(record.lock, `${label}.lock`),
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  if (record.state === "repair_required") {
    rejectUnknownLocalCoreFields(
      record,
      new Set(["state", "lockPath", "reason", "raw"]),
      label,
    );
    return {
      state: "repair_required",
      lockPath: requireLocalCoreString(record.lockPath, `${label}.lockPath`),
      reason: requireLocalCoreString(record.reason, `${label}.reason`),
      ...(hasOwnLocalCoreField(record, "raw") ? { raw: record.raw } : {}),
    };
  }
  throw new Error(`Local Core ${label}.state is invalid.`);
}

function parseLocalCoreLock(value: unknown, label: string): LocalCoreLock {
  const record = requireLocalCoreRecord(value, label);
  rejectUnknownLocalCoreFields(
    record,
    new Set([
      "version",
      "ownerPid",
      "authorityId",
      "ownerExecutable",
      "coreVersion",
      "schemaVersion",
      "startedAt",
      "heartbeatAt",
      "socketPath",
      "databaseSocketPath",
    ]),
    label,
  );
  if (record.version !== LOCAL_CORE_LOCK_VERSION) {
    throw new Error(`Local Core ${label}.version must be ${LOCAL_CORE_LOCK_VERSION}.`);
  }
  const authorityId = parseOptionalLocalCoreString(record, "authorityId", label);
  const schemaVersion = parseOptionalLocalCoreInteger(record, "schemaVersion", label, 0);
  const socketPath = parseOptionalLocalCoreString(record, "socketPath", label);
  const databaseSocketPath = parseOptionalLocalCoreString(
    record,
    "databaseSocketPath",
    label,
  );
  return {
    version: LOCAL_CORE_LOCK_VERSION,
    ownerPid: requireLocalCoreInteger(record.ownerPid, `${label}.ownerPid`, 1),
    ...(authorityId !== undefined ? { authorityId } : {}),
    ownerExecutable: requireLocalCoreString(record.ownerExecutable, `${label}.ownerExecutable`),
    coreVersion: requireLocalCoreString(record.coreVersion, `${label}.coreVersion`),
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    startedAt: requireCanonicalIsoTimestamp(record.startedAt, `${label}.startedAt`),
    heartbeatAt: requireCanonicalIsoTimestamp(record.heartbeatAt, `${label}.heartbeatAt`),
    ...(socketPath !== undefined ? { socketPath } : {}),
    ...(databaseSocketPath !== undefined ? { databaseSocketPath } : {}),
  };
}

function parseLocalCoreDatabaseStatus(
  value: unknown,
  label: string,
): LocalCoreDatabaseStatus {
  const record = requireLocalCoreRecord(value, label);
  rejectUnknownLocalCoreFields(
    record,
    new Set([
      "mode",
      "state",
      "summary",
      "managed",
      "initialized",
      "running",
      "identityVerified",
      "pglitePath",
      "dataPath",
      "socketPath",
      "metadataPath",
      "databaseUrl",
      "database",
      "user",
      "port",
      "logPath",
      "lastError",
    ]),
    label,
  );
  const pglitePath = parseOptionalLocalCoreString(record, "pglitePath", label);
  const dataPath = parseOptionalLocalCoreString(record, "dataPath", label);
  const socketPath = parseOptionalLocalCoreString(record, "socketPath", label);
  const metadataPath = parseOptionalLocalCoreString(record, "metadataPath", label);
  const databaseUrl = parseOptionalLocalCoreString(record, "databaseUrl", label);
  const database = parseOptionalLocalCoreString(record, "database", label);
  const user = parseOptionalLocalCoreString(record, "user", label);
  const port = parseOptionalLocalCoreInteger(record, "port", label, 1, 65_535);
  const logPath = parseOptionalLocalCoreString(record, "logPath", label);
  const lastError = hasOwnLocalCoreField(record, "lastError")
    ? parseLocalCoreFailure(record.lastError, `${label}.lastError`)
    : undefined;
  return {
    mode: requireLocalCoreDatabaseMode(record.mode, `${label}.mode`),
    state: requireLocalCoreStatusState(record.state, `${label}.state`),
    summary: requireLocalCoreString(record.summary, `${label}.summary`),
    managed: requireLocalCoreBoolean(record.managed, `${label}.managed`),
    initialized: requireLocalCoreBoolean(record.initialized, `${label}.initialized`),
    running: requireLocalCoreBoolean(record.running, `${label}.running`),
    identityVerified: requireLocalCoreBoolean(
      record.identityVerified,
      `${label}.identityVerified`,
    ),
    ...(pglitePath !== undefined ? { pglitePath } : {}),
    ...(dataPath !== undefined ? { dataPath } : {}),
    ...(socketPath !== undefined ? { socketPath } : {}),
    ...(metadataPath !== undefined ? { metadataPath } : {}),
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    ...(database !== undefined ? { database } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(logPath !== undefined ? { logPath } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

function parseLocalCoreMigrationStatus(
  value: unknown,
  label: string,
): LocalCoreMigrationStatus {
  const record = requireLocalCoreRecord(value, label);
  rejectUnknownLocalCoreFields(
    record,
    new Set(["state", "summary", "schemaVersion", "lock", "migrated", "lastError"]),
    label,
  );
  const lastError = hasOwnLocalCoreField(record, "lastError")
    ? parseLocalCoreFailure(record.lastError, `${label}.lastError`)
    : undefined;
  return {
    state: requireLocalCoreStatusState(record.state, `${label}.state`),
    summary: requireLocalCoreString(record.summary, `${label}.summary`),
    schemaVersion: requireLocalCoreInteger(record.schemaVersion, `${label}.schemaVersion`, 0),
    lock: parseLocalCoreMigrationLockReadResult(record.lock, `${label}.lock`),
    migrated: requireLocalCoreBoolean(record.migrated, `${label}.migrated`),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

function parseLocalCoreMigrationLockReadResult(
  value: unknown,
  label: string,
): LocalCoreMigrationLockReadResult {
  const record = requireLocalCoreRecord(value, label);
  if (record.state === "missing") {
    rejectUnknownLocalCoreFields(record, new Set(["state", "lockPath"]), label);
    return {
      state: "missing",
      lockPath: requireLocalCoreString(record.lockPath, `${label}.lockPath`),
    };
  }
  if (
    record.state === "live"
    || record.state === "stale"
    || record.state === "incompatible"
  ) {
    rejectUnknownLocalCoreFields(
      record,
      new Set(["state", "lockPath", "lock", "reason"]),
      label,
    );
    const reason = parseOptionalLocalCoreString(record, "reason", label);
    return {
      state: record.state,
      lockPath: requireLocalCoreString(record.lockPath, `${label}.lockPath`),
      lock: parseLocalCoreMigrationLock(record.lock, `${label}.lock`),
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  if (record.state === "repair_required") {
    rejectUnknownLocalCoreFields(
      record,
      new Set(["state", "lockPath", "reason", "raw"]),
      label,
    );
    return {
      state: "repair_required",
      lockPath: requireLocalCoreString(record.lockPath, `${label}.lockPath`),
      reason: requireLocalCoreString(record.reason, `${label}.reason`),
      ...(hasOwnLocalCoreField(record, "raw") ? { raw: record.raw } : {}),
    };
  }
  throw new Error(`Local Core ${label}.state is invalid.`);
}

function parseLocalCoreMigrationLock(
  value: unknown,
  label: string,
): LocalCoreMigrationLock {
  const record = requireLocalCoreRecord(value, label);
  rejectUnknownLocalCoreFields(
    record,
    new Set([
      "version",
      "ownerPid",
      "ownerExecutable",
      "coreVersion",
      "schemaVersion",
      "startedAt",
      "heartbeatAt",
    ]),
    label,
  );
  if (record.version !== LOCAL_CORE_LOCK_VERSION) {
    throw new Error(`Local Core ${label}.version must be ${LOCAL_CORE_LOCK_VERSION}.`);
  }
  return {
    version: LOCAL_CORE_LOCK_VERSION,
    ownerPid: requireLocalCoreInteger(record.ownerPid, `${label}.ownerPid`, 1),
    ownerExecutable: requireLocalCoreString(record.ownerExecutable, `${label}.ownerExecutable`),
    coreVersion: requireLocalCoreString(record.coreVersion, `${label}.coreVersion`),
    schemaVersion: requireLocalCoreInteger(record.schemaVersion, `${label}.schemaVersion`, 0),
    startedAt: requireCanonicalIsoTimestamp(record.startedAt, `${label}.startedAt`),
    heartbeatAt: requireCanonicalIsoTimestamp(record.heartbeatAt, `${label}.heartbeatAt`),
  };
}

function parseLocalCoreFailure(value: unknown, label: string): LocalCoreFailure {
  const record = requireLocalCoreRecord(value, label);
  rejectUnknownLocalCoreFields(record, new Set(["code", "message", "details"]), label);
  const details = hasOwnLocalCoreField(record, "details")
    ? requireLocalCoreRecord(record.details, `${label}.details`)
    : undefined;
  return {
    code: requireLocalCoreString(record.code, `${label}.code`),
    message: requireLocalCoreString(record.message, `${label}.message`),
    ...(details !== undefined ? { details } : {}),
  };
}

function requireLocalCoreStatusState(value: unknown, label: string): LocalCoreStatusState {
  if (
    value !== "missing"
    && value !== "starting"
    && value !== "healthy"
    && value !== "degraded"
    && value !== "blocked"
  ) {
    throw new Error(`Local Core ${label} is invalid.`);
  }
  return value;
}

function requireLocalCoreDatabaseMode(value: unknown, label: string): LocalCoreDatabaseMode {
  if (
    value !== "pglite"
    && value !== "external"
    && value !== "managed"
    && value !== "unavailable"
  ) {
    throw new Error(`Local Core ${label} is invalid.`);
  }
  return value;
}

function requireLocalCoreConfiguredDatabaseMode(
  value: unknown,
  label: string,
): LocalCoreConfiguredDatabaseMode {
  if (value !== "pglite" && value !== "external") {
    throw new Error(`Local Core ${label} is invalid.`);
  }
  return value;
}

function requireLocalCoreBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Local Core ${label} must be a boolean.`);
  }
  return value;
}

function requireLocalCoreInteger(
  value: unknown,
  label: string,
  minimum?: number,
  maximum?: number,
): number {
  if (
    typeof value !== "number"
    || Number.isInteger(value) === false
    || (minimum !== undefined && value < minimum)
    || (maximum !== undefined && value > maximum)
  ) {
    throw new Error(`Local Core ${label} must be an integer in the supported range.`);
  }
  return value;
}

function requireLocalCoreStringArray(value: unknown, label: string): string[] {
  if (Array.isArray(value) === false) {
    throw new Error(`Local Core ${label} must be a string array.`);
  }
  return value.map((item, index) => requireLocalCoreString(item, `${label}[${index}]`));
}

function requireLocalCoreArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value) === false) {
    throw new Error(`Local Core ${label} must be an array.`);
  }
  return value;
}

function parseOptionalLocalCoreString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string | undefined {
  return hasOwnLocalCoreField(record, field)
    ? requireLocalCoreString(record[field], `${label}.${field}`)
    : undefined;
}

function parseOptionalLocalCoreInteger(
  record: Record<string, unknown>,
  field: string,
  label: string,
  minimum?: number,
  maximum?: number,
): number | undefined {
  return hasOwnLocalCoreField(record, field)
    ? requireLocalCoreInteger(record[field], `${label}.${field}`, minimum, maximum)
    : undefined;
}

function hasOwnLocalCoreField(record: Record<string, unknown>, field: string): boolean {
  return  Object.hasOwn(record, field);
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
