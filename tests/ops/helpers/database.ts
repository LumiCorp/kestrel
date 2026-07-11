import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

import { buildDefaultKestrelDatabaseUrl } from "../../../src/config/localDev.js";
import { createPostgresSessionStoreFromUrl } from "../../../src/store/createPostgresSessionStore.js";
import type { SessionStore } from "../../../src/kestrel/contracts/store.js";

import { seedOpsInspectionFixtures, type OpsInspectionFixtureRefs } from "./fixtures.js";

const DEFAULT_OPS_TEST_DATABASE_URL = buildDefaultKestrelDatabaseUrl(process.env, "kestrel_ops_test");

export interface PreparedOpsFixtures {
  databaseUrl: string;
  fixtures: OpsInspectionFixtureRefs;
}

export function resolveOpsTestDatabaseUrl(): string {
  return process.env.KESTREL_OPS_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? DEFAULT_OPS_TEST_DATABASE_URL;
}

export async function prepareOpsFixtures(
  databaseUrl = resolveOpsTestDatabaseUrl(),
): Promise<PreparedOpsFixtures> {
  await ensureDatabaseExists(databaseUrl);
  await resetDatabase(databaseUrl);
  await applyMigrations(databaseUrl);

  const { store, pool } = createPostgresSessionStoreFromUrl(databaseUrl);
  try {
    const fixtures = await seedOpsInspectionFixtures(store);
    return {
      databaseUrl,
      fixtures,
    };
  } finally {
    await pool.end();
  }
}

export async function withPreparedOpsStore<T>(
  operation: (input: {
    databaseUrl: string;
    store: SessionStore;
    pool: Pool;
    fixtures: OpsInspectionFixtureRefs;
  }) => Promise<T>,
  databaseUrl = resolveOpsTestDatabaseUrl(),
): Promise<T> {
  await ensureDatabaseExists(databaseUrl);
  await resetDatabase(databaseUrl);
  await applyMigrations(databaseUrl);

  const { store, pool } = createPostgresSessionStoreFromUrl(databaseUrl);
  try {
    const fixtures = await seedOpsInspectionFixtures(store);
    return await operation({
      databaseUrl,
      store,
      pool,
      fixtures,
    });
  } finally {
    await pool.end();
  }
}

async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const adminUrl = toAdminDatabaseUrl(databaseUrl);
  const targetDatabase = new URL(databaseUrl).pathname.slice(1);
  const pool = new Pool({ connectionString: adminUrl });
  try {
    const existing = await pool.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = $1",
      [targetDatabase],
    );
    if ((existing.rowCount ?? 0) > 0) {
      return;
    }
    await pool.query(`CREATE DATABASE ${quoteIdentifier(targetDatabase)}`);
  } finally {
    await pool.end();
  }
}

async function resetDatabase(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("GRANT ALL ON SCHEMA public TO PUBLIC");
  } finally {
    await pool.end();
  }
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.resolve(process.cwd(), "db/migrations");
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));

    for (const file of files) {
      const migrationSql = await readFile(path.join(migrationsDir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migrationSql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
          [file],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

function toAdminDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
