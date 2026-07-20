import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_CORE_SCHEMA_VERSION,
  LOCAL_CORE_STATE_EPOCH,
  type EnsureLocalCoreReadyOptions,
  type LocalCoreConfiguredDatabaseMode,
  type LocalCoreDatabaseStatus,
  type LocalCoreFailure,
  type LocalCoreStatus,
} from "./contracts.js";
import { resolveKestrelCoreHome, resolveLocalCorePaths } from "./home.js";
import { acquireCoreLock } from "./lock.js";
import { runLocalCoreMigrations } from "./migrations.js";
import { createCoreManifest, readCoreManifest, writeCoreManifest } from "./manifest.js";
import { ensureLocalCoreStore } from "./store.js";

export async function ensureLocalCoreReady(options: EnsureLocalCoreReadyOptions): Promise<LocalCoreStatus> {
  const home = resolveKestrelCoreHome(options.env, options.platform);
  const paths = resolveLocalCorePaths(home.homePath);
  await mkdir(paths.stateRootPath, { recursive: true, mode: 0o700 });
  await chmod(paths.stateRootPath, 0o700);
  const schemaVersion = options.schemaVersion ?? LOCAL_CORE_SCHEMA_VERSION;
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const lock = await acquireCoreLock({
    homePath: home.homePath,
    coreVersion: options.coreVersion,
    ownerExecutable: options.ownerExecutable ?? process.execPath,
    ownerPid: options.lockOwnerPid,
    authorityId: options.lockAuthorityId,
    schemaVersion,
    socketPath: paths.apiSocketPath,
    now: options.now,
    isPidAlive,
  });

  if (lock.state === "incompatible" || lock.state === "repair_required") {
    return {
      state: "blocked",
      summary: lock.reason ?? "Kestrel Local Core is blocked.",
      home,
      lock,
      dbMode: "unavailable",
      database: unavailableDatabase(lock.reason ?? "Kestrel Local Core is blocked."),
      settingsReady: false,
      workspaceRegistryReady: false,
      diagnosticsPath: paths.diagnosticsPath,
      logsPath: paths.logsPath,
      lastError: {
        code: lock.state === "incompatible" ? "LOCAL_CORE_VERSION_INCOMPATIBLE" : "LOCAL_CORE_LOCK_REPAIR_REQUIRED",
        message: lock.reason ?? "Kestrel Local Core lock requires attention.",
      },
    };
  }

  if (
    options.lockOwnerPid !== undefined
    && lock.state === "live"
    && (
      lock.lock.ownerPid !== options.lockOwnerPid
      || (
        options.lockAuthorityId !== undefined
        && lock.lock.authorityId !== options.lockAuthorityId
      )
    )
  ) {
    return {
      state: "blocked",
      summary: "Another Kestrel Local Core authority already owns this state epoch.",
      home,
      lock,
      dbMode: "unavailable",
      database: unavailableDatabase("Another Kestrel Local Core authority already owns this state epoch."),
      settingsReady: false,
      workspaceRegistryReady: false,
      diagnosticsPath: paths.diagnosticsPath,
      logsPath: paths.logsPath,
      lastError: {
        code: "LOCAL_CORE_AUTHORITY_ALREADY_ACTIVE",
        message: `Local Core authority belongs to another instance at pid ${lock.lock.ownerPid}.`,
      },
    };
  }

  await mkdir(paths.runtimePath, { recursive: true });
  await mkdir(paths.settingsPath, { recursive: true });
  await mkdir(paths.workspaceRegistryPath, { recursive: true });
  await mkdir(paths.logsPath, { recursive: true });
  await mkdir(paths.diagnosticsPath, { recursive: true });

  let existingManifest;
  try {
    existingManifest = await readCoreManifest(home.homePath);
  } catch (error) {
    return blockedStatus({
      summary: "Kestrel Local Core manifest requires repair.",
      home,
      lock,
      database: unavailableDatabase("Kestrel Local Core manifest requires repair."),
      diagnosticsPath: paths.diagnosticsPath,
      logsPath: paths.logsPath,
      failure: {
        code: "LOCAL_CORE_MANIFEST_REPAIR_REQUIRED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
  if (existingManifest !== undefined) {
    const manifestFailure = classifyManifestCompatibility(
      existingManifest.stateEpoch,
      existingManifest.schemaVersion,
      schemaVersion,
    );
    if (manifestFailure !== undefined) {
      return blockedStatus({
        summary: manifestFailure.message,
        home,
        lock,
        manifest: existingManifest,
        database: unavailableDatabase(manifestFailure.message),
        diagnosticsPath: paths.diagnosticsPath,
        logsPath: paths.logsPath,
        failure: manifestFailure,
      });
    }
  }
  const databaseMode = normalizeDatabaseMode(options.databaseMode);
  const manifestCapabilities = [
    "local-core.contract.v2",
    "local-core.state-epoch.0.6",
    ...(databaseMode === "pglite" ? ["local-core.store.pglite"] : ["local-core.store.external-postgres"]),
  ].sort();
  let manifest = existingManifest;
  if (manifest === undefined) {
    manifest = createCoreManifest({
      homePath: home.homePath,
      coreVersion: options.coreVersion,
      schemaVersion,
      dbMode: databaseMode,
      capabilities: manifestCapabilities,
      now: options.now,
    });
    await writeCoreManifest(home.homePath, manifest);
  } else if (
    manifest.coreVersion !== options.coreVersion
    || manifest.dbMode !== databaseMode
    || arraysEqual(manifest.capabilities, manifestCapabilities) === false
  ) {
    manifest = {
      ...manifest,
      coreVersion: options.coreVersion,
      dbMode: databaseMode,
      capabilities: manifestCapabilities,
      updatedAt: (options.now ?? new Date()).toISOString(),
    };
    await writeCoreManifest(home.homePath, manifest);
  }

  const database = await resolveDatabaseStatus(options, paths, databaseMode);
  if (database.state === "blocked") {
    return blockedStatus({
      summary: database.summary,
      home,
      lock,
      manifest,
      database,
      diagnosticsPath: paths.diagnosticsPath,
      logsPath: paths.logsPath,
      failure: database.lastError ?? {
        code: "LOCAL_CORE_DATABASE_BLOCKED",
        message: database.summary,
      },
    });
  }

  if (
    databaseMode === "external"
    && options.runMigrations === true
    && normalizeString(options.repoRoot) === undefined
  ) {
    return blockedStatus({
      summary: "Kestrel Local Core migrations require an explicit repo root.",
      home,
      lock,
      manifest,
      database,
      diagnosticsPath: paths.diagnosticsPath,
      logsPath: paths.logsPath,
      failure: {
        code: "LOCAL_CORE_MIGRATION_REPO_ROOT_REQUIRED",
        message: "Core-owned migrations require a repo root containing scripts/migrate.ts.",
      },
    });
  }

  const migrations = options.runMigrations !== true
    ? undefined
    : databaseMode === "pglite"
      ? {
        state: "healthy" as const,
        summary: "Core-owned PGlite schema ready.",
        schemaVersion,
        lock: { state: "missing" as const, lockPath: paths.migrationLockPath },
        migrated: true,
      }
      : await runLocalCoreMigrations({
        homePath: home.homePath,
        coreVersion: options.coreVersion,
        schemaVersion,
        ownerExecutable: options.ownerExecutable ?? process.execPath,
        databaseUrl: database.databaseUrl ?? "",
        repoRoot: options.repoRoot ?? "",
        env: options.env,
        now: options.now,
        isPidAlive,
      });
  if (migrations?.state === "blocked") {
    return blockedStatus({
      summary: migrations.summary,
      home,
      lock,
      manifest,
      database,
      migrations,
      diagnosticsPath: paths.diagnosticsPath,
      logsPath: paths.logsPath,
      failure: migrations.lastError ?? {
        code: "LOCAL_CORE_MIGRATIONS_BLOCKED",
        message: migrations.summary,
      },
    });
  }

  return {
    state: database.state === "healthy" ? "healthy" : "degraded",
    summary: "Kestrel Local Core ready.",
    home,
    manifest,
    lock,
    dbMode: database.mode,
    database,
    ...(migrations !== undefined ? { migrations } : {}),
    databaseSocketPath: database.socketPath,
    settingsReady: true,
    workspaceRegistryReady: true,
    diagnosticsPath: paths.diagnosticsPath,
    logsPath: paths.logsPath,
  };
}

async function resolveDatabaseStatus(
  options: EnsureLocalCoreReadyOptions,
  paths: ReturnType<typeof resolveLocalCorePaths>,
  mode: LocalCoreConfiguredDatabaseMode,
): Promise<LocalCoreDatabaseStatus> {
  const repoRoot = normalizeString(options.repoRoot);
  if (mode === "external") {
    const databaseUrl = options.externalDatabaseUrl
      ?? (options.allowInheritedDatabaseUrl === true ? normalizeString(options.env?.DATABASE_URL) : undefined);
    if (databaseUrl === undefined) {
      return {
        mode: "external",
        state: "blocked",
        summary: "External database mode requires an explicit DATABASE_URL.",
        managed: false,
        initialized: false,
        running: false,
        identityVerified: false,
        lastError: {
          code: "LOCAL_CORE_EXTERNAL_DATABASE_URL_REQUIRED",
          message: "External database mode is Advanced and requires an explicit DATABASE_URL.",
        },
      };
    }
    try {
      await ensureLocalCoreStore({
        homePath: paths.stateRootPath,
        mode: "external",
        externalDatabaseUrl: databaseUrl,
      });
      return {
        mode: "external",
        state: "healthy",
        summary: "Kestrel Local Core external database ready.",
        managed: false,
        initialized: true,
        running: true,
        identityVerified: true,
      };
    } catch (error) {
      return {
        mode: "external",
        state: "blocked",
        summary: error instanceof Error ? error.message : String(error),
        managed: false,
        initialized: false,
        running: false,
        identityVerified: false,
        lastError: {
          code: "LOCAL_CORE_EXTERNAL_DATABASE_INIT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  try {
    const handle = await ensureLocalCoreStore({
      homePath: paths.stateRootPath,
      mode: "pglite",
      ...(repoRoot !== undefined
        ? { migrationsDir: path.join(repoRoot, "db", "migrations") }
        : {}),
    });
    return {
      mode: "pglite",
      state: "healthy",
      summary: "Kestrel Local Core PGlite database ready.",
      managed: true,
      initialized: true,
      running: true,
      identityVerified: true,
      pglitePath: handle.pglitePath,
      dataPath: handle.pglitePath,
    };
  } catch (error) {
    return {
      mode: "pglite",
      state: "blocked",
      summary: error instanceof Error ? error.message : String(error),
      managed: true,
      initialized: false,
      running: false,
      identityVerified: false,
      pglitePath: paths.pgliteDataPath,
      dataPath: paths.pgliteDataPath,
      lastError: {
        code: "LOCAL_CORE_PGLITE_INIT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function classifyManifestCompatibility(
  actualStateEpoch: string,
  actualSchemaVersion: number,
  expectedSchemaVersion: number,
): LocalCoreFailure | undefined {
  if (actualStateEpoch !== LOCAL_CORE_STATE_EPOCH) {
    return {
      code: "LOCAL_CORE_STATE_EPOCH_INCOMPATIBLE",
      message: `Kestrel Local Core state epoch ${actualStateEpoch} does not match requested epoch ${LOCAL_CORE_STATE_EPOCH}.`,
    };
  }
  if (actualSchemaVersion !== expectedSchemaVersion) {
    return {
      code: "LOCAL_CORE_SCHEMA_VERSION_INCOMPATIBLE",
      message: `Kestrel Local Core schema version ${actualSchemaVersion} does not match requested schema version ${expectedSchemaVersion}.`,
    };
  }
  return ;
}

function normalizeDatabaseMode(
  mode: EnsureLocalCoreReadyOptions["databaseMode"],
): LocalCoreConfiguredDatabaseMode {
  return mode === "external" ? "external" : "pglite";
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function blockedStatus(input: {
  summary: string;
  home: LocalCoreStatus["home"];
  lock: LocalCoreStatus["lock"];
  manifest?: LocalCoreStatus["manifest"] | undefined;
  database: LocalCoreDatabaseStatus;
  migrations?: LocalCoreStatus["migrations"] | undefined;
  diagnosticsPath: string;
  logsPath: string;
  failure: LocalCoreFailure;
}): LocalCoreStatus {
  return {
    state: "blocked",
    summary: input.summary,
    home: input.home,
    ...(input.manifest !== undefined ? { manifest: input.manifest } : {}),
    lock: input.lock,
    dbMode: input.database.mode,
    database: input.database,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
    databaseUrl: input.database.databaseUrl,
    databaseSocketPath: input.database.socketPath,
    settingsReady: false,
    workspaceRegistryReady: false,
    diagnosticsPath: input.diagnosticsPath,
    logsPath: input.logsPath,
    lastError: input.failure,
  };
}

function unavailableDatabase(summary: string): LocalCoreDatabaseStatus {
  return {
    mode: "unavailable",
    state: "blocked",
    summary,
    managed: false,
    initialized: false,
    running: false,
    identityVerified: false,
  };
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || Number.isInteger(pid) === false) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
