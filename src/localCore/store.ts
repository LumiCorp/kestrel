import { chmod, lstat, mkdir, realpath, rename } from "node:fs/promises";
import path from "node:path";

import type { SessionStore } from "../kestrel/contracts/store.js";
import {
  createSqlExecutorFromEnv,
  type SqlExecutorStoreHandle,
} from "../store/createSessionStore.js";
import {
  PostgresSessionStore,
  type SqlExecutor,
} from "../store/PostgresSessionStore.js";
import type {
  LocalCoreConfiguredDatabaseMode,
  LocalCoreRuntimeStoreReset,
} from "./contracts.js";
import { resolveLocalCorePaths } from "./home.js";

export interface LocalCoreStoreHandle {
  store: SessionStore;
  executor: SqlExecutor;
  mode: LocalCoreConfiguredDatabaseMode;
  stateRootPath: string;
  close: () => Promise<void>;
  pglitePath?: string | undefined;
  databaseUrl?: string | undefined;
}

export interface EnsureLocalCoreStoreOptions {
  homePath: string;
  mode?: "pglite" | "managed" | "external" | undefined;
  externalDatabaseUrl?: string | undefined;
  migrationsDir?: string | undefined;
}

export interface ArchiveLocalCorePgliteStoreOptions {
  homePath: string;
  now?: Date | undefined;
}

interface StoreEntry {
  configurationKey: string;
  handle: Promise<LocalCoreStoreHandle>;
}

const storesByStateRoot = new Map<string, StoreEntry>();

export async function ensureLocalCoreStore(
  options: EnsureLocalCoreStoreOptions,
): Promise<LocalCoreStoreHandle> {
  const paths = await resolveCanonicalStorePaths(options.homePath, true);
  const mode = normalizeMode(options.mode);
  const externalDatabaseUrl = normalizeString(options.externalDatabaseUrl);
  const migrationsDir = normalizeString(options.migrationsDir);
  if (mode === "external" && externalDatabaseUrl === undefined) {
    throw new Error("External Local Core store mode requires an explicit database URL.");
  }

  const configurationKey = mode === "pglite"
    ? `pglite:${paths.pgliteDataPath}:${migrationsDir ?? "default"}`
    : `external:${externalDatabaseUrl}`;
  const existing = storesByStateRoot.get(paths.stateRootPath);
  if (existing?.configurationKey === configurationKey) {
    return await existing.handle;
  }

  const handle = createStoreAfterClosing(existing?.handle, {
    stateRootPath: paths.stateRootPath,
    pglitePath: paths.pgliteDataPath,
    mode,
    externalDatabaseUrl,
    migrationsDir,
  });
  const entry = { configurationKey, handle };
  storesByStateRoot.set(paths.stateRootPath, entry);

  try {
    return await handle;
  } catch (error) {
    if (storesByStateRoot.get(paths.stateRootPath) === entry) {
      storesByStateRoot.delete(paths.stateRootPath);
    }
    throw error;
  }
}

export async function closeLocalCoreStore(homePath: string): Promise<void> {
  const stateRootPath = (await resolveCanonicalStorePaths(homePath, false)).stateRootPath;
  await closeLocalCoreStoreByStateRoot(stateRootPath);
}

/**
 * Close and archive the one Core-owned PGlite store without touching settings,
 * workspaces, project-run state, credentials, or legacy runtime files.
 */
export async function archiveLocalCorePgliteStore(
  options: ArchiveLocalCorePgliteStoreOptions,
): Promise<LocalCoreRuntimeStoreReset> {
  const paths = await resolveCanonicalStorePaths(options.homePath, false);
  await closeLocalCoreStoreByStateRoot(paths.stateRootPath);

  const resetAt = (options.now ?? new Date()).toISOString();
  const storePath = paths.pgliteDataPath;
  const databasePath = path.dirname(storePath);
  let canonicalDatabasePath: string;
  try {
    canonicalDatabasePath = await realpath(databasePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { storePath, archivedStorePath: null, resetAt };
    }
    throw error;
  }
  if (canonicalDatabasePath !== databasePath) {
    throw new Error(
      "Local Core refused to archive a PGlite store through a linked database directory.",
    );
  }

  try {
    const entry = await lstat(storePath);
    if (entry.isDirectory() === false && entry.isSymbolicLink() === false) {
      throw new Error("Local Core PGlite store path is not a directory or symbolic link.");
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return { storePath, archivedStorePath: null, resetAt };
    }
    throw error;
  }

  const archiveStem = `${storePath}.archived-${archiveTimestamp(resetAt)}`;
  for (let collision = 0; collision < 1_000; collision += 1) {
    const archivedStorePath = collision === 0
      ? archiveStem
      : `${archiveStem}-${collision}`;
    if (await pathEntryExists(archivedStorePath)) {
      continue;
    }
    try {
      await rename(storePath, archivedStorePath);
      return { storePath, archivedStorePath, resetAt };
    } catch (error) {
      if (isAlreadyExistsError(error) || isDirectoryNotEmptyError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Local Core could not allocate a unique PGlite archive path.");
}

async function closeLocalCoreStoreByStateRoot(stateRootPath: string): Promise<void> {
  const existing = storesByStateRoot.get(stateRootPath);
  if (existing === undefined) {
    return;
  }
  storesByStateRoot.delete(stateRootPath);
  const handle = await existing.handle.catch(() => undefined);
  await handle?.close();
}

export async function closeAllLocalCoreStores(): Promise<void> {
  const entries = [...storesByStateRoot.values()];
  storesByStateRoot.clear();
  await Promise.all(entries.map(async (entry) => {
    const handle = await entry.handle.catch(() => undefined);
    await handle?.close();
  }));
}

async function createStoreAfterClosing(
  previousHandle: Promise<LocalCoreStoreHandle> | undefined,
  input: {
    stateRootPath: string;
    pglitePath: string;
    mode: LocalCoreConfiguredDatabaseMode;
    externalDatabaseUrl?: string | undefined;
    migrationsDir?: string | undefined;
  },
): Promise<LocalCoreStoreHandle> {
  if (previousHandle !== undefined) {
    const previous = await previousHandle.catch(() => undefined);
    await previous?.close();
  }

  if (input.mode === "pglite") {
    await mkdir(input.pglitePath, { recursive: true, mode: 0o700 });
    await chmod(input.pglitePath, 0o700);
  }

  const sqlHandle = createSqlExecutorFromEnv(input.mode === "pglite"
    ? {
      driver: "sqlite",
      sqlitePath: input.pglitePath,
      ...(input.migrationsDir !== undefined ? { migrationsDir: input.migrationsDir } : {}),
      enforceSchemaV3: true,
    }
    : {
      driver: "postgres",
      databaseUrl: input.externalDatabaseUrl,
      enforceSchemaV3: true,
    });

  try {
    // Both drivers initialize connections lazily. Readiness must prove that
    // the configured database is reachable before publishing the handle.
    await sqlHandle.executor.query("SELECT 1 AS local_core_ready");
    return buildHandle(input, sqlHandle);
  } catch (error) {
    await sqlHandle.close().catch(() => undefined);
    throw error;
  }
}

function buildHandle(
  input: {
    stateRootPath: string;
    pglitePath: string;
    mode: LocalCoreConfiguredDatabaseMode;
    externalDatabaseUrl?: string | undefined;
  },
  sqlHandle: SqlExecutorStoreHandle,
): LocalCoreStoreHandle {
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await sqlHandle.close();
  };
  return {
    store: new PostgresSessionStore(sqlHandle.executor, { enforceSchemaV3: true }),
    executor: sqlHandle.executor,
    mode: input.mode,
    stateRootPath: input.stateRootPath,
    close,
    ...(input.mode === "pglite" ? { pglitePath: input.pglitePath } : {}),
    ...(input.externalDatabaseUrl !== undefined ? { databaseUrl: input.externalDatabaseUrl } : {}),
  };
}

function normalizeMode(
  mode: EnsureLocalCoreStoreOptions["mode"],
): LocalCoreConfiguredDatabaseMode {
  return mode === "external" ? "external" : "pglite";
}

function normalizeString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

async function resolveCanonicalStorePaths(homePath: string, create: boolean) {
  const paths = resolveLocalCorePaths(homePath);
  if (create) {
    await mkdir(paths.stateRootPath, { recursive: true, mode: 0o700 });
    await chmod(paths.stateRootPath, 0o700);
  }
  try {
    return resolveLocalCorePaths(await realpath(paths.stateRootPath));
  } catch (error) {
    if (isNotFoundError(error)) {
      return paths;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTEMPTY";
}

async function pathEntryExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function archiveTimestamp(timestamp: string): string {
  return timestamp.replaceAll(":", "-").replaceAll(".", "-");
}
