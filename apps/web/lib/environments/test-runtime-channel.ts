import postgres from "postgres";

const FIXTURE_LOCK_KEY = "kestrel:test-environment-runtime-channel-fixture";

export async function installTestStableRuntimeBundle(
  databaseUrl: string,
  suffix: string,
) {
  const pool = postgres(databaseUrl, { max: 1 });
  const connection = await pool.reserve();
  await connection`
    SELECT pg_advisory_lock(hashtextextended(${FIXTURE_LOCK_KEY}, 0))
  `;
  const versionId = `test-runtime-${suffix}`;
  const revision = "a".repeat(40);
  const runtimeImage = `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${"d".repeat(64)}`;
  const routerImage = `ghcr.io/lumicorp/kestrel-environment-router@sha256:${"b".repeat(64)}`;
  let previous: {
    currentVersionId: string | null;
    previousVersionId: string | null;
    generation: number;
  } | null = null;
  try {
    const [row] = await connection<
      Array<{
        currentVersionId: string | null;
        previousVersionId: string | null;
        generation: number;
      }>
    >`
      SELECT
        "current_version_id" AS "currentVersionId",
        "previous_version_id" AS "previousVersionId",
        "generation"
      FROM "environment_runtime_channels"
      WHERE "name" = 'production'
    `;
    previous = row ?? null;
    await connection`
      INSERT INTO "environment_runtime_versions" (
        "id", "workspace_runtime_image", "workspace_runtime_source_revision",
        "environment_router_image", "environment_router_source_revision"
      ) VALUES (
        ${versionId}, ${runtimeImage}, ${revision}, ${routerImage}, ${revision}
      )
      ON CONFLICT ("workspace_runtime_image", "environment_router_image")
      DO UPDATE SET "workspace_runtime_source_revision" = EXCLUDED."workspace_runtime_source_revision"
    `;
    const [version] = await connection<Array<{ id: string }>>`
      SELECT "id" FROM "environment_runtime_versions"
      WHERE "workspace_runtime_image" = ${runtimeImage}
        AND "environment_router_image" = ${routerImage}
    `;
    await connection`
      INSERT INTO "environment_runtime_channels" (
        "name", "current_version_id", "generation"
      ) VALUES ('production', ${version!.id}, 1)
      ON CONFLICT ("name") DO UPDATE SET
        "current_version_id" = EXCLUDED."current_version_id",
        "previous_version_id" = NULL,
        "generation" = "environment_runtime_channels"."generation" + 1,
        "updated_at" = now()
    `;
    return async () => {
      try {
        if (previous) {
          await connection`
            UPDATE "environment_runtime_channels" SET
              "current_version_id" = ${previous.currentVersionId},
              "previous_version_id" = ${previous.previousVersionId},
              "generation" = ${previous.generation},
              "updated_at" = now()
            WHERE "name" = 'production'
          `;
        }
        await connection`
          DELETE FROM "environment_runtime_versions"
          WHERE "id" = ${version!.id}
            AND "id" <> ${previous?.currentVersionId ?? null}
            AND "id" <> ${previous?.previousVersionId ?? null}
        `;
      } finally {
        await release(connection, pool);
      }
    };
  } catch (error) {
    await release(connection, pool);
    throw error;
  }
}

async function release(
  connection: Awaited<ReturnType<postgres.Sql["reserve"]>>,
  pool: postgres.Sql,
) {
  try {
    await connection`
      SELECT pg_advisory_unlock(hashtextextended(${FIXTURE_LOCK_KEY}, 0))
    `;
  } finally {
    connection.release();
    await pool.end({ timeout: 0 });
  }
}
