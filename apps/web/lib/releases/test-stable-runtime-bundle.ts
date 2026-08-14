import { createHash } from "node:crypto";
import postgres from "postgres";

const FIXTURE_LOCK_KEY = "kestrel:test-stable-runtime-bundle-fixture";

export async function installTestStableRuntimeBundle(
  databaseUrl: string,
  suffix: string,
) {
  // The fixture lock must not consume the caller's pool. Several PostgreSQL
  // contracts intentionally use max: 1, so reserving that connection for the
  // fixture lifetime would deadlock the test's first ordinary query.
  const lockPool = postgres(databaseUrl, { max: 1 });
  const sql = lockPool;
  const connection = await sql.reserve();
  await connection`
    SELECT pg_advisory_lock(hashtextextended(${FIXTURE_LOCK_KEY}, 0))
  `;
  const releaseId = `test-stable-runtime-${suffix}`;
  const manifestDigest = `sha256:${createHash("sha256").update(releaseId).digest("hex")}`;
  const revision = "a".repeat(40);
  const smoke = JSON.stringify({
    status: "passed",
    command: "test fixture",
    completedAt: new Date().toISOString(),
  });
  let previousStableReleaseId: string | null = null;

  try {
    const [previousSettings] = await connection<
      Array<{ stableReleaseId: string | null }>
    >`
      SELECT "stable_release_id" AS "stableReleaseId"
      FROM "fly_image_release_settings"
      WHERE "id" = 'platform'
    `;
    previousStableReleaseId = previousSettings?.stableReleaseId ?? null;
    await connection`
      INSERT INTO "fly_image_releases" (
        "id", "bundle_revision", "manifest_digest", "trigger", "status",
        "validation", "completed_at"
      ) VALUES (
        ${releaseId}, ${revision}, ${manifestDigest}, 'bootstrap', 'completed',
        ${sql.json({
          status: "passed",
          commands: ["test fixture"],
          completedAt: new Date().toISOString(),
        })}, now()
      )
    `;
    await connection`
      INSERT INTO "fly_image_release_components" (
        "release_id", "role", "image", "source_revision", "input_fingerprint",
        "changed", "smoke"
      ) VALUES
        (
          ${releaseId}, 'environment-router',
          ${`ghcr.io/lumicorp/kestrel-environment-router@sha256:${"b".repeat(64)}`},
          ${revision}, ${`sha256:${"c".repeat(64)}`}, false, ${smoke}::jsonb
        ),
        (
          ${releaseId}, 'workspace-runtime',
          ${`ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${"d".repeat(64)}`},
          ${revision}, ${`sha256:${"e".repeat(64)}`}, false, ${smoke}::jsonb
        )
    `;
    await connection`
      INSERT INTO "fly_image_release_settings" ("id", "stable_release_id")
      VALUES ('platform', ${releaseId})
      ON CONFLICT ("id") DO UPDATE
      SET "stable_release_id" = EXCLUDED."stable_release_id", "updated_at" = now()
    `;
  } catch (error) {
    await releaseFixtureLock(connection, lockPool);
    throw error;
  }

  return async () => {
    try {
      await connection`
        UPDATE "fly_image_release_settings"
        SET
          "stable_release_id" = ${previousStableReleaseId},
          "updated_at" = now()
        WHERE "id" = 'platform' AND "stable_release_id" = ${releaseId}
      `;
      await connection`
        DELETE FROM "fly_image_releases" WHERE "id" = ${releaseId}
      `;
    } finally {
      await releaseFixtureLock(connection, lockPool);
    }
  };
}

async function releaseFixtureLock(
  connection: Awaited<ReturnType<postgres.Sql["reserve"]>>,
  lockPool?: postgres.Sql,
) {
  try {
    await connection`
      SELECT pg_advisory_unlock(hashtextextended(${FIXTURE_LOCK_KEY}, 0))
    `;
  } finally {
    connection.release();
    await lockPool?.end({ timeout: 0 });
  }
}
