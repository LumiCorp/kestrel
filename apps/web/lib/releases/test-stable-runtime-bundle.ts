import { createHash } from "node:crypto";
import type postgres from "postgres";

export async function installTestStableRuntimeBundle(
  sql: postgres.Sql,
  suffix: string,
) {
  const releaseId = `test-stable-runtime-${suffix}`;
  const manifestDigest = `sha256:${createHash("sha256").update(releaseId).digest("hex")}`;
  const revision = "a".repeat(40);
  const smoke = JSON.stringify({
    status: "passed",
    command: "test fixture",
    completedAt: new Date().toISOString(),
  });

  await sql`
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
  await sql`
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
  await sql`
    INSERT INTO "fly_image_release_settings" ("id", "stable_release_id")
    VALUES ('platform', ${releaseId})
    ON CONFLICT ("id") DO UPDATE
    SET "stable_release_id" = EXCLUDED."stable_release_id", "updated_at" = now()
  `;

  return async () => {
    await sql`
      UPDATE "fly_image_release_settings"
      SET "stable_release_id" = NULL, "updated_at" = now()
      WHERE "id" = 'platform' AND "stable_release_id" = ${releaseId}
    `;
    await sql`DELETE FROM "fly_image_releases" WHERE "id" = ${releaseId}`;
  };
}
