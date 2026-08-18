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
    const [releaseState] = await sql<
      Array<{
        activeReleaseCount: number;
        nonterminalTargetCount: number;
        queuedReleaseJobCount: number;
      }>
    >`
      SELECT
        (SELECT count(*)::int FROM "fly_image_releases"
          WHERE "status" IN ('approved', 'deploying', 'paused'))
          AS "activeReleaseCount",
        (SELECT count(*)::int
          FROM "fly_image_release_targets" target
          JOIN "fly_image_releases" release
            ON release."id" = target."release_id"
          WHERE target."status" NOT IN ('completed', 'failed')
            AND release."status" NOT IN ('completed', 'superseded'))
          AS "nonterminalTargetCount",
        (SELECT count(*)::int FROM pgboss.job
          WHERE name LIKE 'fly-image.release%'
            AND state IN ('created', 'retry', 'active'))
          AS "queuedReleaseJobCount"
    `;
    if (!releaseState) {
      throw new Error("Production cutover release state was unavailable.");
    }
    const [schemaState] = await sql<Array<{ runtimeChannel: boolean }>>`
      SELECT
        to_regclass('public.environment_runtime_channels') IS NOT NULL
          AS "runtimeChannel"
    `;
    const [canary] = schemaState?.runtimeChannel
      ? await sql<Array<{ canaryEnvironmentId: string | null; canaryReady: boolean }>>`
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
        `
      : await sql<Array<{ canaryEnvironmentId: string | null; canaryReady: boolean }>>`
          SELECT
            settings."canary_environment_id" AS "canaryEnvironmentId",
            EXISTS (
              SELECT 1
              FROM "environments" environment
              WHERE environment."id" = settings."canary_environment_id"
                AND environment."provider" = 'fly'
                AND environment."archived_at" IS NULL
                AND environment."status" IN ('ready', 'degraded')
            ) AS "canaryReady"
          FROM "fly_image_release_settings" settings
          WHERE settings."id" = 'platform'
        `;
    const blockerCounts = [
      ["activeReleaseCount", releaseState.activeReleaseCount],
      ["nonterminalTargetCount", releaseState.nonterminalTargetCount],
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
