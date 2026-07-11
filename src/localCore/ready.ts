import { mkdir } from "node:fs/promises";
import {
  LOCAL_CORE_SCHEMA_VERSION,
  type EnsureLocalCoreReadyOptions,
  type LocalCoreDatabaseStatus,
  type LocalCoreFailure,
  type LocalCoreStatus,
} from "./contracts.js";
import { resolveKestrelCoreHome, resolveLocalCorePaths } from "./home.js";
import { acquireCoreLock } from "./lock.js";
import { runLocalCoreMigrations } from "./migrations.js";
import { createCoreManifest, readCoreManifest, writeCoreManifest } from "./manifest.js";
import { ensureLocalCoreManagedPostgres } from "./postgres.js";

export async function ensureLocalCoreReady(options: EnsureLocalCoreReadyOptions): Promise<LocalCoreStatus> {
  const home = resolveKestrelCoreHome(options.env, options.platform);
  const paths = resolveLocalCorePaths(home.homePath);
  const schemaVersion = options.schemaVersion ?? LOCAL_CORE_SCHEMA_VERSION;
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const lock = await acquireCoreLock({
    homePath: home.homePath,
    coreVersion: options.coreVersion,
    ownerExecutable: options.ownerExecutable ?? process.execPath,
    schemaVersion,
    socketPath: paths.apiSocketPath,
    databaseSocketPath: paths.postgresSocketPath,
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
    const manifestFailure = classifyManifestCompatibility(existingManifest.coreVersion, existingManifest.schemaVersion, options.coreVersion, schemaVersion);
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
  const manifest = existingManifest ?? createCoreManifest({
    homePath: home.homePath,
    coreVersion: options.coreVersion,
    schemaVersion,
    dbMode: options.databaseMode ?? "managed",
    capabilities: ["local-core.contract.v1"],
    now: options.now,
  });
  if (existingManifest === undefined) {
    await writeCoreManifest(home.homePath, manifest);
  }

  const database = await resolveDatabaseStatus(options, paths);
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

  if (options.runMigrations === true && normalizeString(options.repoRoot) === undefined) {
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

  const migrations = options.runMigrations === true
    ? await runLocalCoreMigrations({
      homePath: home.homePath,
      coreVersion: options.coreVersion,
      schemaVersion,
      ownerExecutable: options.ownerExecutable ?? process.execPath,
      databaseUrl: database.databaseUrl ?? "",
      repoRoot: options.repoRoot ?? "",
      env: options.env,
      now: options.now,
      isPidAlive,
    })
    : undefined;
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
    databaseUrl: database.databaseUrl,
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
): Promise<LocalCoreDatabaseStatus> {
  const mode = options.databaseMode ?? "managed";
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
    return {
      mode: "external",
      state: "healthy",
      summary: "Kestrel Local Core external database configured.",
      managed: false,
      initialized: true,
      running: true,
      identityVerified: true,
      databaseUrl,
    };
  }

  if (options.postgresBundleRootPath === undefined) {
    return {
      mode: "managed",
      state: "blocked",
      summary: "Kestrel Local Core managed database bundle root is not configured.",
      managed: true,
      initialized: false,
      running: false,
      identityVerified: false,
      dataPath: paths.postgresDataPath,
      socketPath: paths.postgresSocketPath,
      metadataPath: paths.postgresMetadataPath,
      logPath: paths.postgresLogPath,
      lastError: {
        code: "LOCAL_CORE_POSTGRES_BUNDLE_ROOT_REQUIRED",
        message: "Managed database mode requires bundled Postgres resources.",
      },
    };
  }

  try {
    return (await ensureLocalCoreManagedPostgres({
      paths,
      bundleRootPath: options.postgresBundleRootPath,
      platform: options.platform,
      isPidAlive: options.isPidAlive,
    })).status;
  } catch (error) {
    return {
      mode: "managed",
      state: "blocked",
      summary: error instanceof Error ? error.message : String(error),
      managed: true,
      initialized: false,
      running: false,
      identityVerified: false,
      dataPath: paths.postgresDataPath,
      socketPath: paths.postgresSocketPath,
      metadataPath: paths.postgresMetadataPath,
      logPath: paths.postgresLogPath,
      lastError: {
        code: "LOCAL_CORE_POSTGRES_UNEXPECTED_FAILURE",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function classifyManifestCompatibility(
  actualCoreVersion: string,
  actualSchemaVersion: number,
  expectedCoreVersion: string,
  expectedSchemaVersion: number,
): LocalCoreFailure | undefined {
  if (isManifestCoreVersionCompatible(actualCoreVersion, expectedCoreVersion) === false) {
    return {
      code: "LOCAL_CORE_MANIFEST_VERSION_INCOMPATIBLE",
      message: `Kestrel Local Core version ${actualCoreVersion} does not match shell version ${expectedCoreVersion}.`,
    };
  }
  if (actualSchemaVersion !== expectedSchemaVersion) {
    return {
      code: "LOCAL_CORE_SCHEMA_VERSION_INCOMPATIBLE",
      message: `Kestrel Local Core schema version ${actualSchemaVersion} does not match requested schema version ${expectedSchemaVersion}.`,
    };
  }
  return undefined;
}

function isManifestCoreVersionCompatible(
  actualCoreVersion: string,
  expectedCoreVersion: string,
): boolean {
  return actualCoreVersion === expectedCoreVersion
    || (actualCoreVersion === "0.5.0-beta.0" && expectedCoreVersion === "0.5.1");
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
