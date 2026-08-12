import assert from "node:assert/strict";
import postgres from "postgres";
import { test } from "node:test";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("concurrent backup revision claims converge on one active artifact", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const sql = postgres(databaseUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const organizationId = `org-backup-revision-${suffix}`;
  const userId = `user-backup-revision-${suffix}`;
  const threadId = `thread-backup-revision-${suffix}`;
  const environmentId = `environment-backup-revision-${suffix}`;
  const workspaceId = `workspace-backup-revision-${suffix}`;
  const backupIds = [
    `backup-revision-a-${suffix}`,
    `backup-revision-b-${suffix}`,
  ];
  const sourceRevision = "d".repeat(64);
  const now = new Date();

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`.catch(
      () => {},
    );
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`.catch(() => {});
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${userId}, 'Backup Revision User', ${`${userId}@example.test`},
        true, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${organizationId}, 'Backup Revision Org',
        ${`backup-revision-${suffix}`}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "threads" (
        "id", "title", "created_by_user_id", "organization_id"
      ) VALUES (
        ${threadId}, 'Backup Revision Thread', ${userId}, ${organizationId}
      )
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "region", "status", "fly_app_name", "runtime_image"
      ) VALUES (
        ${environmentId}, ${organizationId}, ${userId},
        'Backup Revision Environment', ${`backup-revision-${suffix}`},
        'iad', 'ready', ${`fly-backup-revision-${suffix}`},
        'registry.example/workspace@sha256:test'
      )
    `;
    await transaction`
      INSERT INTO "environment_workspaces" (
        "id", "organization_id", "environment_id", "personal_owner_user_id",
        "created_by_user_id", "name", "kind", "status", "fly_machine_id",
        "fly_volume_id", "runtime_image"
      ) VALUES (
        ${workspaceId}, ${organizationId}, ${environmentId}, ${userId},
        ${userId}, 'Backup Revision Workspace', 'scratch', 'ready',
        ${`machine-${suffix}`}, ${`volume-${suffix}`},
        'registry.example/workspace@sha256:test'
      )
    `;
    await transaction`
      INSERT INTO "workspace_backups" (
        "id", "organization_id", "environment_id", "workspace_id",
        "reason", "status", "expires_at", "created_at", "updated_at"
      ) VALUES
        (
          ${backupIds[0]}, ${organizationId}, ${environmentId}, ${workspaceId},
          'daily', 'queued', ${new Date(now.getTime() + 86_400_000)}, ${now}, ${now}
        ),
        (
          ${backupIds[1]}, ${organizationId}, ${environmentId}, ${workspaceId},
          'checkpoint', 'queued', ${new Date(now.getTime() + 86_400_000)}, ${now}, ${now}
        )
    `;
  });

  const claims = await Promise.allSettled(
    backupIds.map(
      (backupId) => sql`
        UPDATE "workspace_backups"
        SET "source_revision" = ${sourceRevision}, "updated_at" = now()
        WHERE "id" = ${backupId}
      `,
    ),
  );
  assert.equal(
    claims.filter((claim) => claim.status === "fulfilled").length,
    1,
  );
  const rejected = claims.find((claim) => claim.status === "rejected");
  assert.equal(
    rejected?.status === "rejected"
      ? (rejected.reason as { code?: string }).code
      : undefined,
    "23505",
  );
  const [{ count }] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS count
    FROM "workspace_backups"
    WHERE "workspace_id" = ${workspaceId}
      AND "source_revision" = ${sourceRevision}
      AND "status" IN ('queued', 'creating', 'available', 'deleting', 'delete_failed')
  `;
  assert.equal(count, 1);
});
