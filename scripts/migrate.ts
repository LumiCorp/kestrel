import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Pool } from "pg";
import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";
import { applyKestrelLocalEnvDefaults, buildDefaultKestrelDatabaseUrl } from "../src/config/localDev.js";

async function main(): Promise<void> {
  await loadShellAndDotEnv(process.cwd(), {
    preferDotEnvKeys: ["DATABASE_URL"],
  });
  applyKestrelLocalEnvDefaults(process.env);
  const databaseUrl = process.env.DATABASE_URL ?? buildDefaultKestrelDatabaseUrl(process.env);
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
      .sort((a, b) => a.localeCompare(b));

    const appliedRows = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    const applied = new Set(appliedRows.rows.map((row) => row.name));

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      const migrationSql = await readFile(path.join(migrationsDir, file), "utf8");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migrationSql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        process.stdout.write(`Applied migration: ${file}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    process.stdout.write("Migrations complete.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message =
    error instanceof Error
      ? error.stack ?? error.message
      : typeof error === "object"
        ? JSON.stringify(error)
        : String(error);
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
});
