import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import postgres, { type Sql } from "postgres";
import * as schema from "@/drizzle/schema";

type KnowledgeDb = PostgresJsDatabase<typeof schema>;

export type DbErrorCategory =
  | "misconfigured_database"
  | "too_many_clients"
  | "connection_exhausted"
  | "transient_network"
  | "authentication_failed"
  | "query_failed"
  | "unknown";

export type DbErrorInfo = {
  category: DbErrorCategory;
  retryable: boolean;
  details?: string;
};

export type DbRuntimeConfig = {
  databaseUrl: string | null;
  cacheScope: "global" | "module";
  drizzle: {
    maxConnections: number;
    idleTimeoutSeconds: number;
    maxLifetimeSeconds: number;
    connectTimeoutSeconds: number;
    prepare: boolean;
  };
  kysely: {
    maxConnections: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    maxLifetimeSeconds: number;
  };
};

export type DbErrorSnapshot = DbErrorInfo & {
  at: string;
};

export type DbConnectionPressureSnapshot = {
  pool: {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };
  database?: {
    maxConnections: number;
    currentDatabaseConnections: number;
    activeConnections: number;
    idleConnections: number;
  };
};

export type DbRuntimeDiagnostics = {
  databaseUrlConfigured: boolean;
  config: Omit<DbRuntimeConfig, "databaseUrl">;
  lastError: DbErrorSnapshot | null;
  lastHealthyAt: string | null;
  pressure: DbConnectionPressureSnapshot | null;
};

export type DbHealthResult = {
  ok: boolean;
  category?: DbErrorCategory;
  details?: string;
  diagnostics: DbRuntimeDiagnostics;
};

type DbRuntimeState = {
  drizzleClient?: Sql;
  drizzleDb?: KnowledgeDb;
  pgPool?: Pool;
  kyselyDb?: Kysely<any>;
  lastError: DbErrorSnapshot | null;
  lastHealthyAt: string | null;
};

const GLOBAL_RUNTIME_KEY = "__unifiedAppDbRuntime";
const moduleRuntimeState: DbRuntimeState = {
  lastError: null,
  lastHealthyAt: null,
};

function shouldUseGlobalCache(env: NodeJS.ProcessEnv = process.env) {
  return (env.NODE_ENV ?? "development") !== "production";
}

function getGlobalRuntimeState() {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [GLOBAL_RUNTIME_KEY]?: DbRuntimeState;
  };

  if (!runtimeGlobal[GLOBAL_RUNTIME_KEY]) {
    runtimeGlobal[GLOBAL_RUNTIME_KEY] = {
      lastError: null,
      lastHealthyAt: null,
    };
  }

  return runtimeGlobal[GLOBAL_RUNTIME_KEY];
}

function getRuntimeState() {
  return shouldUseGlobalCache() ? getGlobalRuntimeState() : moduleRuntimeState;
}

function getTrimmedEnvValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getDbRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): DbRuntimeConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";

  return {
    databaseUrl:
      getTrimmedEnvValue(env.POSTGRES_URL) ??
      getTrimmedEnvValue(env.DATABASE_URL),
    cacheScope: shouldUseGlobalCache(env) ? "global" : "module",
    drizzle: {
      maxConnections: parsePositiveInteger(
        env.DB_DRIZZLE_MAX_CONNECTIONS,
        isProduction ? 10 : 4
      ),
      idleTimeoutSeconds: parsePositiveInteger(
        env.DB_DRIZZLE_IDLE_TIMEOUT_SECONDS,
        isProduction ? 30 : 10
      ),
      maxLifetimeSeconds: parsePositiveInteger(
        env.DB_DRIZZLE_MAX_LIFETIME_SECONDS,
        isProduction ? 60 * 30 : 60 * 5
      ),
      connectTimeoutSeconds: parsePositiveInteger(
        env.DB_DRIZZLE_CONNECT_TIMEOUT_SECONDS,
        10
      ),
      prepare:
        getTrimmedEnvValue(env.DB_DRIZZLE_PREPARE) === "true"
          ? true
          : isProduction,
    },
    kysely: {
      maxConnections: parsePositiveInteger(
        env.DB_PG_MAX_CONNECTIONS,
        isProduction ? 10 : 4
      ),
      idleTimeoutMillis: parsePositiveInteger(
        env.DB_PG_IDLE_TIMEOUT_MILLIS,
        isProduction ? 30_000 : 10_000
      ),
      connectionTimeoutMillis: parsePositiveInteger(
        env.DB_PG_CONNECTION_TIMEOUT_MILLIS,
        10_000
      ),
      maxLifetimeSeconds: parsePositiveInteger(
        env.DB_PG_MAX_LIFETIME_SECONDS,
        isProduction ? 60 * 30 : 60 * 5
      ),
    },
  };
}

function collectErrorMessages(error: unknown) {
  const messages = new Set<string>();
  const codes = new Set<string>();
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (typeof current === "string") {
      messages.add(current);
      continue;
    }

    if (current instanceof Error) {
      messages.add(current.message);
      queue.push(current.cause);
    }

    if (typeof current === "object") {
      const candidate = current as {
        message?: unknown;
        detail?: unknown;
        code?: unknown;
        cause?: unknown;
      };

      if (typeof candidate.message === "string") {
        messages.add(candidate.message);
      }

      if (typeof candidate.detail === "string") {
        messages.add(candidate.detail);
      }

      if (typeof candidate.code === "string") {
        codes.add(candidate.code);
      }

      if ("cause" in candidate) {
        queue.push(candidate.cause);
      }
    }
  }

  return {
    messages: [...messages],
    codes: [...codes],
  };
}

function getPrimaryErrorDetail(error: unknown) {
  const { messages } = collectErrorMessages(error);
  return messages.find(Boolean);
}

function isMatchingMessage(
  messages: string[],
  matcher: (value: string) => boolean
) {
  return messages.some((message) => matcher(message.toLowerCase()));
}

export function classifyDbError(error: unknown): DbErrorInfo {
  const detail =
    getPrimaryErrorDetail(error) ?? "Unexpected database runtime error";
  const { messages, codes } = collectErrorMessages(error);

  if (messages.length === 0 && codes.length === 0) {
    return {
      category: "unknown",
      retryable: false,
      details: detail,
    };
  }

  if (
    isMatchingMessage(
      messages,
      (message) =>
        message.includes("database_url") ||
        message.includes("postgres_url") ||
        message.includes("database not configured") ||
        message.includes("database configuration is missing") ||
        message.includes("must be set")
    ) ||
    codes.includes("3D000")
  ) {
    return {
      category: "misconfigured_database",
      retryable: false,
      details: detail,
    };
  }

  if (
    codes.includes("53300") ||
    isMatchingMessage(messages, (message) =>
      message.includes("too many clients already")
    )
  ) {
    return {
      category: "too_many_clients",
      retryable: true,
      details: detail,
    };
  }

  if (
    isMatchingMessage(
      messages,
      (message) =>
        message.includes("timeout exceeded when trying to connect") ||
        message.includes("connection terminated due to connection timeout") ||
        message.includes("connection acquisition timeout") ||
        message.includes("remaining connection slots are reserved")
    )
  ) {
    return {
      category: "connection_exhausted",
      retryable: true,
      details: detail,
    };
  }

  if (
    codes.includes("28P01") ||
    isMatchingMessage(
      messages,
      (message) =>
        message.includes("password authentication failed") ||
        message.includes("no pg_hba.conf entry")
    )
  ) {
    return {
      category: "authentication_failed",
      retryable: false,
      details: detail,
    };
  }

  if (
    isMatchingMessage(
      messages,
      (message) =>
        message.includes("econnrefused") ||
        message.includes("econnreset") ||
        message.includes("enotfound") ||
        message.includes("connection terminated unexpectedly") ||
        message.includes("server closed the connection unexpectedly") ||
        message.includes("terminating connection due to administrator command")
    ) ||
    codes.some((code) => code.startsWith("08"))
  ) {
    return {
      category: "transient_network",
      retryable: true,
      details: detail,
    };
  }

  if (
    isMatchingMessage(messages, (message) => message.includes("failed query:"))
  ) {
    return {
      category: "query_failed",
      retryable: false,
      details: detail,
    };
  }

  return {
    category: "unknown",
    retryable: false,
    details: detail,
  };
}

function sanitizeConfigForDiagnostics(config: DbRuntimeConfig) {
  return {
    cacheScope: config.cacheScope,
    drizzle: config.drizzle,
    kysely: config.kysely,
  };
}

function recordDbSuccess() {
  getRuntimeState().lastHealthyAt = new Date().toISOString();
}

export function recordDbError(error: unknown) {
  const classified = classifyDbError(error);
  const snapshot: DbErrorSnapshot = {
    ...classified,
    at: new Date().toISOString(),
  };

  getRuntimeState().lastError = snapshot;
  return snapshot;
}

function getDatabaseUrlOrThrow(config: DbRuntimeConfig) {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL not configured");
  }

  return config.databaseUrl;
}

function createPostgresJsClient(config: DbRuntimeConfig) {
  return postgres(getDatabaseUrlOrThrow(config), {
    connect_timeout: config.drizzle.connectTimeoutSeconds,
    idle_timeout: config.drizzle.idleTimeoutSeconds,
    max: config.drizzle.maxConnections,
    max_lifetime: config.drizzle.maxLifetimeSeconds,
    prepare: config.drizzle.prepare,
  });
}

function createPgPool(config: DbRuntimeConfig) {
  return new Pool({
    connectionString: getDatabaseUrlOrThrow(config),
    connectionTimeoutMillis: config.kysely.connectionTimeoutMillis,
    idleTimeoutMillis: config.kysely.idleTimeoutMillis,
    max: config.kysely.maxConnections,
    maxLifetimeSeconds: config.kysely.maxLifetimeSeconds,
  });
}

function getPostgresJsClient() {
  const state = getRuntimeState();
  if (state.drizzleClient) {
    return state.drizzleClient;
  }

  try {
    state.drizzleClient = createPostgresJsClient(getDbRuntimeConfig());
    return state.drizzleClient;
  } catch (error) {
    recordDbError(error);
    throw error;
  }
}

export function getDrizzleDb(): KnowledgeDb {
  const state = getRuntimeState();
  if (state.drizzleDb) {
    return state.drizzleDb;
  }

  state.drizzleDb = drizzle(getPostgresJsClient(), { schema });
  return state.drizzleDb;
}

export function getPgPool(): Pool {
  const state = getRuntimeState();
  if (state.pgPool) {
    return state.pgPool;
  }

  try {
    state.pgPool = createPgPool(getDbRuntimeConfig());
    return state.pgPool;
  } catch (error) {
    recordDbError(error);
    throw error;
  }
}

export function getKyselyDb() {
  const state = getRuntimeState();
  if (state.kyselyDb) {
    return state.kyselyDb;
  }

  state.kyselyDb = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: getPgPool(),
    }),
  });

  return state.kyselyDb;
}

async function getConnectionPressureSnapshot(): Promise<DbConnectionPressureSnapshot | null> {
  const pool = getPgPool();
  const snapshot: DbConnectionPressureSnapshot = {
    pool: {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    },
  };

  try {
    const result = await pool.query<{
      max_connections: string;
      current_database_connections: string;
      active_connections: string;
      idle_connections: string;
    }>(`
      select
        current_setting('max_connections') as max_connections,
        count(*) filter (where datname = current_database())::text as current_database_connections,
        count(*) filter (where datname = current_database() and state = 'active')::text as active_connections,
        count(*) filter (where datname = current_database() and state = 'idle')::text as idle_connections
      from pg_stat_activity
    `);

    const row = result.rows[0];

    if (!row) {
      return snapshot;
    }

    snapshot.database = {
      maxConnections: Number.parseInt(row.max_connections, 10) || 0,
      currentDatabaseConnections:
        Number.parseInt(row.current_database_connections, 10) || 0,
      activeConnections: Number.parseInt(row.active_connections, 10) || 0,
      idleConnections: Number.parseInt(row.idle_connections, 10) || 0,
    };

    return snapshot;
  } catch {
    return snapshot;
  }
}

function buildDiagnostics(
  config: DbRuntimeConfig,
  pressure: DbConnectionPressureSnapshot | null
): DbRuntimeDiagnostics {
  const state = getRuntimeState();

  return {
    databaseUrlConfigured: Boolean(config.databaseUrl),
    config: sanitizeConfigForDiagnostics(config),
    lastError: state.lastError,
    lastHealthyAt: state.lastHealthyAt,
    pressure,
  };
}

export async function getDbHealth(): Promise<DbHealthResult> {
  const config = getDbRuntimeConfig();

  if (!config.databaseUrl) {
    const error = new Error("DATABASE_URL or POSTGRES_URL not configured");
    const classified = recordDbError(error);

    return {
      ok: false,
      category: classified.category,
      details: classified.details,
      diagnostics: buildDiagnostics(config, null),
    };
  }

  try {
    const pool = getPgPool();
    await pool.query("SELECT 1");
    recordDbSuccess();

    const pressure = await getConnectionPressureSnapshot();

    return {
      ok: true,
      diagnostics: buildDiagnostics(config, pressure),
    };
  } catch (error) {
    const classified = recordDbError(error);

    return {
      ok: false,
      category: classified.category,
      details: classified.details,
      diagnostics: buildDiagnostics(config, null),
    };
  }
}

export async function resetDbRuntimeForTests() {
  const state = getRuntimeState();

  await Promise.allSettled([
    state.kyselyDb?.destroy(),
    state.pgPool?.end(),
    state.drizzleClient?.end({ timeout: 0 }),
  ]);

  state.kyselyDb = undefined;
  state.pgPool = undefined;
  state.drizzleClient = undefined;
  state.drizzleDb = undefined;
  state.lastError = null;
  state.lastHealthyAt = null;
}
