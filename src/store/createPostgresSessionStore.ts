import type { Pool } from "pg";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { PgSqlExecutor, createPostgresPool } from "./PgSqlExecutor.js";
import { PostgresSessionStore } from "./PostgresSessionStore.js";

export function createPostgresSessionStoreFromUrl(databaseUrl: string): {
  store: PostgresSessionStore;
  pool: Pool;
} {
  const pool = createPostgresPool(databaseUrl);
  const executor = new PgSqlExecutor(pool);
  const store = new PostgresSessionStore(executor, { enforceSchemaV3: true });
  return { store, pool };
}

export function createPostgresSessionStoreFromEnv(): {
  store: PostgresSessionStore;
  pool: Pool;
} {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw createRuntimeFailure("STORE_DATABASE_URL_REQUIRED", "DATABASE_URL is required.");
  }

  return createPostgresSessionStoreFromUrl(databaseUrl);
}
