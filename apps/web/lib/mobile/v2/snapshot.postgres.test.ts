import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import "../../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_TURN_DB_TEST_URL?.trim();

test("mobile Thread snapshots derive Project context from the hosted Thread", async (context) => {
  assert.ok(databaseUrl, "KESTREL_TURN_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;

  const [{ resetDbRuntimeForTests }, { getMobileV2ThreadSnapshot }] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./snapshot"),
  ]);
  const sql = postgres(databaseUrl, { max: 2 });
  const suffix = crypto.randomUUID();
  const organizationId = `mobile-snapshot-org-${suffix}`;
  const userId = `mobile-snapshot-user-${suffix}`;
  const memberId = `mobile-snapshot-member-${suffix}`;
  const environmentId = `mobile-snapshot-environment-${suffix}`;
  const projectId = `mobile-snapshot-project-${suffix}`;
  const projectThreadId = `mobile-snapshot-project-thread-${suffix}`;
  const standaloneThreadId = `mobile-snapshot-standalone-thread-${suffix}`;
  const now = new Date();

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${userId}, 'Mobile Snapshot User', ${`${userId}@example.test`},
        true, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${organizationId}, 'Mobile Snapshot Org',
        ${`mobile-snapshot-org-${suffix}`}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "region", "status", "is_default"
      ) VALUES (
        ${environmentId}, ${organizationId}, ${userId}, 'Default', 'default',
        'iad', 'ready', true
      )
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES (
        ${projectId}, ${organizationId}, ${environmentId},
        ${userId}, 'Authoritative Project'
      )
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES (${projectId}, ${memberId}, 'owner')
    `;
    await transaction`
      INSERT INTO "threads" (
        "id", "title", "created_by_user_id", "organization_id", "project_id", "origin"
      ) VALUES
        (
          ${projectThreadId}, 'Project Thread', ${userId},
          ${organizationId}, ${projectId}, 'mobile'
        ),
        (
          ${standaloneThreadId}, 'Standalone Thread', ${userId},
          ${organizationId}, NULL, 'mobile'
        )
    `;
  });

  const projectSnapshot = await getMobileV2ThreadSnapshot({
    threadId: projectThreadId,
    organizationId,
    userId,
  });
  const standaloneSnapshot = await getMobileV2ThreadSnapshot({
    threadId: standaloneThreadId,
    organizationId,
    userId,
  });

  assert.deepEqual(projectSnapshot?.thread.project, {
    id: projectId,
    name: "Authoritative Project",
  });
  assert.equal(standaloneSnapshot?.thread.project, null);
});
