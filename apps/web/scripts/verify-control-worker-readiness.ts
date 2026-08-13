import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { RELEASE_CONTROLLER_CONTRACT_REVISION } from "@/lib/releases/controller-contract";

async function main() {
  const expectedRevision = process.argv[2]?.trim();
  const contractOnly = expectedRevision === "--contract-only";
  if (!contractOnly && !expectedRevision) {
    throw new Error("Expected controller revision is required.");
  }
  if (
    !contractOnly &&
    process.env.KESTREL_BUILD_REVISION?.trim() !== expectedRevision
  ) {
    throw new Error("The running controller revision does not match the release revision.");
  }
  const readyFile = process.env.KESTREL_CONTROL_WORKER_READY_FILE?.trim();
  if (!readyFile) throw new Error("The controller readiness file is not configured.");
  const ready = await readFile(readyFile, "utf8");
  if (!ready.includes(`release-controller-v${RELEASE_CONTROLLER_CONTRACT_REVISION}`)) {
    throw new Error("The controller readiness contract is unavailable.");
  }
  const databaseUrl =
    process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("The controller database is not configured.");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [heartbeat] = await sql<
      Array<{ contractRevision: number; ageSeconds: number }>
    >`
      SELECT
        contract_revision AS "contractRevision",
        EXTRACT(EPOCH FROM (now() - heartbeat_at))::float8 AS "ageSeconds"
      FROM release_controller_heartbeats
      WHERE id = 'platform'
    `;
    if (
      heartbeat?.contractRevision !== RELEASE_CONTROLLER_CONTRACT_REVISION ||
      heartbeat.ageSeconds >= 90
    ) {
      throw new Error("The controller heartbeat is unavailable or stale.");
    }
  } finally {
    await sql.end({ timeout: 0 });
  }
  process.stdout.write("Release controller readiness is healthy.\n");
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Release controller readiness failed."}\n`,
  );
  process.exitCode = 1;
});
