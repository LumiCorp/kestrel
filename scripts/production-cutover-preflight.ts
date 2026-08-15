import postgres from "postgres";

async function main() {
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
    const [snapshot] = await sql<
      Array<{
        activeReleaseCount: number;
        nonterminalTargetCount: number;
        queuedReleaseJobCount: number;
        canaryEnvironmentId: string | null;
        canaryReady: boolean;
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
          AS "queuedReleaseJobCount",
        (SELECT "canary_environment_id"
          FROM "fly_image_release_settings"
          WHERE "id" = 'platform')
          AS "canaryEnvironmentId",
        EXISTS (
          SELECT 1
          FROM "fly_image_release_settings" settings
          JOIN "environments" environment
            ON environment."id" = settings."canary_environment_id"
          WHERE settings."id" = 'platform'
            AND environment."provider" = 'fly'
            AND environment."archived_at" IS NULL
            AND environment."status" IN ('ready', 'degraded')
        ) AS "canaryReady"
    `;
    if (!snapshot) throw new Error("Production cutover snapshot was unavailable.");
    const blockerCounts = [
      ["activeReleaseCount", snapshot.activeReleaseCount],
      ["nonterminalTargetCount", snapshot.nonterminalTargetCount],
      ["queuedReleaseJobCount", snapshot.queuedReleaseJobCount],
    ] as const;
    const blockers = blockerCounts.filter(([, count]) => count > 0);
    if (blockers.length) {
      throw new Error(
        `Production cutover is blocked: ${blockers
          .map(([name, count]) => `${name}=${count}`)
          .join(", ")}.`,
      );
    }
    if (!snapshot.canaryEnvironmentId) {
      throw new Error(
        "Production cutover is blocked: no canary Environment is configured.",
      );
    }
    if (!snapshot.canaryReady) {
      throw new Error(
        `Production cutover is blocked: canary Environment ${snapshot.canaryEnvironmentId} is not an active Fly Environment.`,
      );
    }
    process.stdout.write("Production cutover release-state preflight passed.\n");
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
