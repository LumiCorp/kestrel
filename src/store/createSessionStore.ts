import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import type { SessionStore } from "../kestrel/contracts/store.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { resolveKestrelHomePath } from "../runtime/kestrelHome.js";
import { PgSqlExecutor, createPostgresPool } from "./PgSqlExecutor.js";
import { PostgresSessionStore, type SqlExecutor } from "./PostgresSessionStore.js";
import { PGliteSqlExecutor } from "./PGliteSqlExecutor.js";

export type StoreDriver = "auto" | "postgres" | "sqlite";

interface RuntimeSettingsFile {
  version?: number;
  defaults?: {
    storeDriver?: StoreDriver | undefined;
    sqlitePath?: string | undefined;
  } | undefined;
}

export interface SessionStoreHandle {
  store: SessionStore;
  driver: Exclude<StoreDriver, "auto">;
  requestedDriver: StoreDriver;
  close: () => Promise<void>;
  databaseUrl?: string | undefined;
  sqlitePath?: string | undefined;
}

export interface SqlExecutorStoreHandle {
  executor: SqlExecutor;
  driver: Exclude<StoreDriver, "auto">;
  requestedDriver: StoreDriver;
  close: () => Promise<void>;
  databaseUrl?: string | undefined;
  sqlitePath?: string | undefined;
}

export interface CreateSessionStoreOptions {
  driver?: StoreDriver | undefined;
  databaseUrl?: string | undefined;
  sqlitePath?: string | undefined;
  migrationsDir?: string | undefined;
  enforceSchemaV3?: boolean | undefined;
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

export function createSessionStoreFromEnv(options: CreateSessionStoreOptions = {}): SessionStoreHandle {
  const handle = createSqlExecutorFromEnv(options);
  return {
    store: new PostgresSessionStore(handle.executor, {
      enforceSchemaV3: options.enforceSchemaV3 ?? true,
    }),
    driver: handle.driver,
    requestedDriver: handle.requestedDriver,
    close: handle.close,
    ...(handle.databaseUrl !== undefined ? { databaseUrl: handle.databaseUrl } : {}),
    ...(handle.sqlitePath !== undefined ? { sqlitePath: handle.sqlitePath } : {}),
  };
}

export function createSqlExecutorFromEnv(options: CreateSessionStoreOptions = {}): SqlExecutorStoreHandle {
  const defaults = readRuntimeStoreDefaults();
  const requestedDriver = normalizeStoreDriver(
    options.driver ??
      readOptionalString(process.env.KESTREL_STORE_DRIVER) ??
      defaults.storeDriver ??
      "auto",
  );
  const databaseUrl =
    options.databaseUrl ??
    readOptionalString(process.env.DATABASE_URL);

  const effectiveDriver: Exclude<StoreDriver, "auto"> =
    requestedDriver === "auto"
      ? (databaseUrl !== undefined ? "postgres" : "sqlite")
      : requestedDriver;

  if (effectiveDriver === "postgres") {
    if (databaseUrl === undefined) {
      throw createRuntimeFailure(
        "STORE_DATABASE_URL_REQUIRED",
        "DATABASE_URL is required when KESTREL_STORE_DRIVER=postgres.",
      );
    }
    const pool = createPostgresPool(databaseUrl);
    return {
      executor: new PgSqlExecutor(pool),
      driver: "postgres",
      requestedDriver,
      close: () => pool.end(),
      databaseUrl,
    };
  }

  const sqlitePath = resolveSqliteStorePath(
    options.sqlitePath ??
      readOptionalString(process.env.KESTREL_SQLITE_PATH) ??
      defaults.sqlitePath ??
      path.join(resolveRuntimeHomePath(), "runtime.db"),
  );

  mkdirSync(path.dirname(sqlitePath), { recursive: true });
  // "sqlite" is a local durable mode backed by PGlite so we can preserve Postgres semantics.
  const db = new PGlite(sqlitePath);
  const ready = createSqliteReadyPromise(
    db,
    sqlitePath,
    options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR,
  );
  const executor = new LazyReadySqlExecutor(new PGliteSqlExecutor(db), ready);

  return {
    executor,
    driver: "sqlite",
    requestedDriver,
    sqlitePath,
    close: async () => {
      let initializationFailed = false;
      await ready.catch(() => {
        // Close should remain best-effort even if initialization failed.
        initializationFailed = true;
      });
      try {
        await db.close();
      } catch (error) {
        if (initializationFailed === false) {
          throw error;
        }
      }
    },
  };
}

function normalizeStoreDriver(value: string): StoreDriver {
  if (value === "auto" || value === "postgres" || value === "sqlite") {
    return value;
  }
  throw createRuntimeFailure(
    "STORE_DRIVER_INVALID",
    `Unsupported store driver '${value}'. Expected auto|postgres|sqlite (sqlite is PGlite-backed local durable mode).`,
  );
}

function readOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRuntimeStoreDefaults(): {
  storeDriver?: StoreDriver | undefined;
  sqlitePath?: string | undefined;
} {
  const settingsPath = resolveRuntimeSettingsPath();
  if (existsSync(settingsPath) === false) {
    return {};
  }

  try {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as RuntimeSettingsFile;
    const defaults = parsed.defaults;
    if (typeof defaults !== "object" || defaults === null) {
      return {};
    }

    const storeDriver =
      defaults.storeDriver === "auto" || defaults.storeDriver === "postgres" || defaults.storeDriver === "sqlite"
        ? defaults.storeDriver
        : undefined;
    const sqlitePath =
      typeof defaults.sqlitePath === "string" && defaults.sqlitePath.trim().length > 0
        ? defaults.sqlitePath.trim()
        : undefined;

    return {
      ...(storeDriver !== undefined ? { storeDriver } : {}),
      ...(sqlitePath !== undefined ? { sqlitePath } : {}),
    };
  } catch {
    return {};
  }
}

function resolveRuntimeSettingsPath(): string {
  return path.join(resolveRuntimeHomePath(), "settings.json");
}

function resolveRuntimeHomePath(): string {
  return resolveKestrelHomePath();
}

function resolveSqliteStorePath(candidate: string): string {
  return path.resolve(candidate);
}

class LazyReadySqlExecutor implements SqlExecutor {
  private readonly delegate: SqlExecutor;
  private readonly ready: Promise<void>;

  constructor(delegate: SqlExecutor, ready: Promise<void>) {
    this.delegate = delegate;
    this.ready = ready;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    await this.ready;
    return this.delegate.query<Row>(text, values);
  }

  async transaction<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    await this.ready;
    if (typeof this.delegate.transaction === "function") {
      return this.delegate.transaction(operation);
    }
    return operation(this.delegate);
  }
}

async function applySqliteMigrations(db: PGlite, migrationsDir: string): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const appliedResult = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(appliedResult.rows.map((row) => row.name));

  for (const file of migrationFiles) {
    if (applied.has(file)) {
      continue;
    }

    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
  }
}

function createSqliteReadyPromise(
  db: PGlite,
  sqlitePath: string,
  migrationsDir: string,
): Promise<void> {
  return applySqliteMigrations(db, migrationsDir).catch((error) => {
    throw createRuntimeFailure(
      "STORE_SQLITE_INIT_FAILED",
      `Failed to initialize local runtime store at '${sqlitePath}': ${describeSqliteInitError(error)}`,
      {
        sqlitePath,
        ...(readErrorCode(error) !== undefined ? { causeCode: readErrorCode(error) } : {}),
      },
    );
  });
}

function describeSqliteInitError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const message = readUnknownObjectString(error, "message");
    if (message !== undefined) {
      return message;
    }
    const code = readUnknownObjectString(error, "code");
    if (code !== undefined) {
      return code;
    }
  }
  return "unknown sqlite initialization failure";
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return ;
  }
  return readUnknownObjectString(error, "code");
}

function readUnknownObjectString(value: object, key: string): string | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}
