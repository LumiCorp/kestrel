import { sql } from "drizzle-orm";
import migrationHistory from "@/lib/db/migrations/meta/history-lock.json";
import { FlyMachinesClient } from "@/lib/environments/providers/fly-machines";
import { knowledgeDb } from "@/lib/knowledge/db";

const MIGRATION_TAG = /^[0-9]{4}_[a-z0-9_]+$/u;
const CONTROL_WORKER_IMAGE =
  /^registry\.fly\.io\/kestrel-one-control-worker:production-[1-9][0-9]*-[1-9][0-9]*$/u;

type ControlWorkerFlyClient = Pick<FlyMachinesClient, "listAppMachines">;

export async function isProductionMigrationApplied(
  requiredMigration: string,
) {
  if (!MIGRATION_TAG.test(requiredMigration)) return false;
  const ledgerEntry = (
    migrationHistory as Readonly<Record<string, string>>
  )[requiredMigration];
  if (!ledgerEntry) return false;
  const [timestampText, hash] = ledgerEntry.split(":");
  const timestamp = Number(timestampText);
  if (!(Number.isSafeInteger(timestamp) && hash)) return false;
  const ledger = await knowledgeDb.execute<{ present: boolean }>(sql`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present
  `);
  if (!ledger[0]?.present) return false;
  const rows = await knowledgeDb.execute<{ ready: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM drizzle.__drizzle_migrations
      WHERE hash = ${hash}
        AND created_at >= ${timestamp}
    ) AS ready
  `);
  return rows[0]?.ready ?? false;
}

export async function isTagCapableEnvironmentLifecycleWorker(
  fly: ControlWorkerFlyClient = createPlatformFlyClient(),
) {
  const machines = await fly.listAppMachines({
    appName: "kestrel-one-control-worker",
  });
  return (
    machines.some((machine) => machine.state === "started") &&
    machines.length > 0 &&
    machines.every(
      (machine) =>
        (machine.state === "started" || machine.state === "stopped") &&
        Boolean(machine.image && CONTROL_WORKER_IMAGE.test(machine.image)),
    )
  );
}

function createPlatformFlyClient() {
  return new FlyMachinesClient({
    token: process.env.FLY_API_TOKEN ?? "",
    organizationSlug: process.env.KESTREL_FLY_ORGANIZATION_SLUG ?? "",
  });
}
