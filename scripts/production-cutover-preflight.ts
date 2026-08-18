import postgres from "postgres";

import { loadProductionEnvironment } from "../apps/web/scripts/lib/production-command.js";

async function main() {
  const operator = await loadProductionEnvironment();
  const databaseUrl =
    process.env.POSTGRES_URL_NON_POOLING?.trim() ||
    process.env.DATABASE_URL_UNPOOLED?.trim();
  if (!databaseUrl) {
    throw new Error(
      "Production cutover preflight requires an unpooled production database URL.",
    );
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [releaseState] = await sql<Array<{ queuedReleaseJobCount: number }>>`
      SELECT count(*)::int AS "queuedReleaseJobCount"
      FROM pgboss.job
      WHERE name LIKE 'fly-image.release%'
        AND state IN ('created', 'retry', 'active')
    `;
    if (!releaseState) {
      throw new Error("Production cutover release state was unavailable.");
    }
    const [schemaState] = await sql<Array<{ runtimeChannel: boolean }>>`
      SELECT
        to_regclass('public.environment_runtime_channels') IS NOT NULL
          AS "runtimeChannel"
    `;
    if (!schemaState?.runtimeChannel) {
      throw new Error(
        "Production cutover is blocked: environment runtime channels are not installed.",
      );
    }
    const [canary] = await sql<
      Array<{ canaryEnvironmentId: string | null; canaryReady: boolean }>
    >`
      SELECT
        channel."canary_environment_id" AS "canaryEnvironmentId",
        EXISTS (
          SELECT 1
          FROM "environments" environment
          WHERE environment."id" = channel."canary_environment_id"
            AND environment."provider" = 'fly'
            AND environment."archived_at" IS NULL
            AND environment."status" IN ('ready', 'degraded')
        ) AS "canaryReady"
      FROM "environment_runtime_channels" channel
      WHERE channel."name" = 'production'
    `;
    const blockerCounts = [
      ["queuedReleaseJobCount", releaseState.queuedReleaseJobCount],
    ] as const;
    const blockers = blockerCounts.filter(([, count]) => count > 0);
    if (blockers.length) {
      throw new Error(
        `Production cutover is blocked: ${blockers
          .map(([name, count]) => `${name}=${count}`)
          .join(", ")}.`,
      );
    }
    if (!canary?.canaryEnvironmentId) {
      throw new Error(
        "Production cutover is blocked: no canary Environment is configured.",
      );
    }
    if (!canary.canaryReady) {
      throw new Error(
        `Production cutover is blocked: canary Environment ${canary.canaryEnvironmentId} is not an active Fly Environment.`,
      );
    }
    process.stdout.write(
      `Production cutover release-state preflight passed (${operator}).\n`,
    );
  } finally {
    await sql.end({ timeout: 0 });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Production cutover preflight failed."}\n`,
  );
  process.exit(1);
});
