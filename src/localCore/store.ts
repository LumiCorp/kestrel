import { chmod, mkdir, realpath } from "node:fs/promises";

import type { SessionStore } from "../kestrel/contracts/store.js";
import {
  createSqlExecutorFromEnv,
  type SqlExecutorStoreHandle,
} from "../store/createSessionStore.js";
import {
  PostgresSessionStore,
  type SqlExecutor,
} from "../store/PostgresSessionStore.js";
import type { LocalCoreConfiguredDatabaseMode } from "./contracts.js";
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
  if (mode === "external" && externalDatabaseUrl === undefined) {
    throw new Error("External Local Core store mode requires an explicit database URL.");
  }

  const configurationKey = mode === "pglite"
    ? `pglite:${paths.pgliteDataPath}`
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
