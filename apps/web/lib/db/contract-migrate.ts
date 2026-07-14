import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

config({ path: ".env.local" });

async function run() {
  const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("POSTGRES_URL or DATABASE_URL is required");
  }

  const connection = postgres(databaseUrl, { max: 1 });
  try {
    await connection`
      SELECT pg_advisory_lock(hashtext('kestrel-one-schema-migrate'))
    `;
    await migrate(drizzle(connection), {
      migrationsFolder: "./lib/db/contract-migrations",
      migrationsTable: "__kestrel_contract_migrations",
    });
    process.stdout.write("✅ Contract migrations completed.\n");
  } finally {
    await connection`
      SELECT pg_advisory_unlock(hashtext('kestrel-one-schema-migrate'))
    `.catch(() => {});
    await connection.end();
  }
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exit(1);
});
