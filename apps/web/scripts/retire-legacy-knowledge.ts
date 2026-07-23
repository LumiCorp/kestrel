import { rm } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import postgres from "postgres";
import { resolveMigrationDatabaseConnection } from "@/lib/db/migration-connection";

config({ path: ".env.local" });

function getLegacyKnowledgeRoot() {
  return path.resolve(
    process.env.KNOWLEDGE_STORAGE_ROOT ||
      path.join(process.cwd(), ".local", "knowledge")
  );
}

function assertSnapshotPathWithinRoot(snapshotPath: string, root: string) {
  const resolved = path.resolve(snapshotPath);
  const prefix = `${root}${path.sep}`;
  if (resolved === root || !resolved.startsWith(prefix)) {
    throw new Error(`Refusing to delete legacy snapshot outside root: ${snapshotPath}`);
  }
  return resolved;
}

async function retireLegacyKnowledgeStorage() {
  const databaseConnection = resolveMigrationDatabaseConnection();
  if (!databaseConnection) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required for legacy Knowledge cleanup");
  }

  const connection = postgres(databaseConnection.url, { max: 1 });
  try {
    const [table] = await connection<Array<{ tableName: string | null }>>`
      SELECT to_regclass('public.knowledge_snapshots')::text AS "tableName"
    `;
    if (!table?.tableName) {
      console.log("Legacy Knowledge snapshots are already retired.");
      return;
    }

    const snapshots = await connection<Array<{ filesystemPath: string }>>`
      SELECT filesystem_path AS "filesystemPath" FROM knowledge_snapshots
    `;
    const root = getLegacyKnowledgeRoot();
    for (const snapshot of snapshots) {
      await rm(assertSnapshotPathWithinRoot(snapshot.filesystemPath, root), {
        recursive: true,
        force: true,
      });
    }
    console.log(`Removed ${snapshots.length} legacy Knowledge snapshot directories.`);
  } finally {
    await connection.end();
  }
}

await retireLegacyKnowledgeStorage();
