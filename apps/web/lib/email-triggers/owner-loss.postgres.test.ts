import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("Organization owner loss disables Email Triggers before membership and user cascades", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const sql = postgres(databaseUrl, { max: 6 });
  const suffix = crypto.randomUUID();
  const now = new Date("2026-08-27T14:00:00.000Z");
  const ids = {
    organization: `trigger-owner-loss-org-${suffix}`,
    environment: `trigger-owner-loss-environment-${suffix}`,
    project: `trigger-owner-loss-project-${suffix}`,
    admin: `trigger-owner-loss-admin-${suffix}`,
    adminMember: `trigger-owner-loss-admin-member-${suffix}`,
    genericUser: `trigger-owner-loss-generic-user-${suffix}`,
    genericMember: `trigger-owner-loss-generic-member-${suffix}`,
    directUser: `trigger-owner-loss-direct-user-${suffix}`,
    directMember: `trigger-owner-loss-direct-member-${suffix}`,
    raceUser: `trigger-owner-loss-race-user-${suffix}`,
    raceMember: `trigger-owner-loss-race-member-${suffix}`,
    enabledTrigger: `trigger-owner-loss-enabled-${suffix}`,
    disabledTrigger: `trigger-owner-loss-disabled-${suffix}`,
    deletedTrigger: `trigger-owner-loss-deleted-${suffix}`,
    directTrigger: `trigger-owner-loss-direct-${suffix}`,
    raceTrigger: `trigger-owner-loss-race-${suffix}`,
  };

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
    await sql`
      DELETE FROM "user"
      WHERE "id" IN (${ids.admin}, ${ids.genericUser}, ${ids.directUser}, ${ids.raceUser})
    `;
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES
        (${ids.admin}, 'Owner-loss Admin', ${`${ids.admin}@example.test`}, true, ${now}, ${now}),
        (${ids.genericUser}, 'Owner-loss Generic', ${`${ids.genericUser}@example.test`}, true, ${now}, ${now}),
        (${ids.directUser}, 'Owner-loss Direct', ${`${ids.directUser}@example.test`}, true, ${now}, ${now}),
        (${ids.raceUser}, 'Owner-loss Race', ${`${ids.raceUser}@example.test`}, true, ${now}, ${now})
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${ids.organization}, 'Trigger owner-loss organization', ${ids.organization}, ${now})
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES
        (${ids.adminMember}, ${ids.organization}, ${ids.admin}, 'owner', ${now}),
        (${ids.genericMember}, ${ids.organization}, ${ids.genericUser}, 'member', ${now}),
        (${ids.directMember}, ${ids.organization}, ${ids.directUser}, 'member', ${now}),
        (${ids.raceMember}, ${ids.organization}, ${ids.raceUser}, 'member', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "region", "status", "is_default", "fly_app_name", "router_url"
      ) VALUES (
        ${ids.environment}, ${ids.organization}, ${ids.admin},
        'Owner-loss Environment', 'owner-loss', 'iad', 'ready', true,
        ${`owner-loss-${suffix}`}, 'https://environment.example'
      )
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES (
        ${ids.project}, ${ids.organization}, ${ids.environment}, ${ids.admin},
        'Trigger owner-loss Project'
      )
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES
        (${ids.project}, ${ids.adminMember}, 'owner'),
        (${ids.project}, ${ids.genericMember}, 'editor'),
        (${ids.project}, ${ids.directMember}, 'editor'),
        (${ids.project}, ${ids.raceMember}, 'editor')
    `;
    await transaction`
      INSERT INTO "project_email_triggers" (
        "id", "organization_id", "project_id", "created_by_user_id",
        "execution_owner_user_id", "name", "instruction", "model_id",
        "address_local_part", "address_domain", "enabled", "disabled_reason",
        "revision", "deleted_at", "created_at", "updated_at"
      ) VALUES
        (
          ${ids.enabledTrigger}, ${ids.organization}, ${ids.project},
          ${ids.genericUser}, ${ids.genericUser}, 'Enabled target', 'Process email.',
          'openrouter/model', 'private-enabled-address', 'inbound.example.test',
          true, NULL, 3, NULL, ${now}, ${now}
        ),
        (
          ${ids.disabledTrigger}, ${ids.organization}, ${ids.project},
          ${ids.genericUser}, ${ids.genericUser}, 'Disabled target', 'Process email.',
          'openrouter/model', 'private-disabled-address', 'inbound.example.test',
          false, 'manual', 7, NULL, ${now}, ${now}
        ),
        (
          ${ids.deletedTrigger}, ${ids.organization}, ${ids.project},
          ${ids.genericUser}, ${ids.genericUser}, 'Deleted target', 'Process email.',
          'openrouter/model', 'private-deleted-address', 'inbound.example.test',
          false, 'deleted', 9, ${now}, ${now}, ${now}
        ),
        (
          ${ids.directTrigger}, ${ids.organization}, ${ids.project},
          ${ids.directUser}, ${ids.directUser}, 'Direct user target', 'Process email.',
          'openrouter/model', 'private-direct-address', 'inbound.example.test',
          true, NULL, 1, NULL, ${now}, ${now}
        ),
        (
          ${ids.raceTrigger}, ${ids.organization}, ${ids.project},
          ${ids.raceUser}, ${ids.raceUser}, 'Concurrent target', 'Process email.',
          'openrouter/model', 'private-race-address', 'inbound.example.test',
          true, NULL, 1, NULL, ${now}, ${now}
        )
    `;
  });

  const genericDeleted = await sql<Array<{ id: string }>>`
    DELETE FROM "member" WHERE "id" = ${ids.genericMember} RETURNING "id"
  `;
  assert.deepEqual([...genericDeleted], [{ id: ids.genericMember }]);

  const genericRows = await sql<
    Array<{
      id: string;
      enabled: boolean;
      reason: string | null;
      revision: number;
    }>
  >`
    SELECT "id", "enabled", "disabled_reason" AS "reason", "revision"
    FROM "project_email_triggers"
    WHERE "id" IN (${ids.enabledTrigger}, ${ids.disabledTrigger}, ${ids.deletedTrigger})
    ORDER BY "id"
  `;
  assert.deepEqual(
    genericRows.find((row) => row.id === ids.enabledTrigger),
    {
      id: ids.enabledTrigger,
      enabled: false,
      reason: "execution_owner_access_lost",
      revision: 4,
    },
  );
  assert.deepEqual(
    genericRows.find((row) => row.id === ids.disabledTrigger),
    {
      id: ids.disabledTrigger,
      enabled: false,
      reason: "manual",
      revision: 7,
    },
  );
  assert.deepEqual(
    genericRows.find((row) => row.id === ids.deletedTrigger),
    {
      id: ids.deletedTrigger,
      enabled: false,
      reason: "deleted",
      revision: 9,
    },
  );
  const genericAudit = await sql<
    Array<{
      targetId: string;
      metadata: { reason: string; revision: number };
    }>
  >`
    SELECT "target_id" AS "targetId", "metadata"
    FROM "project_audit_events"
    WHERE "target_type" = 'project_email_trigger'
      AND "target_id" IN (${ids.enabledTrigger}, ${ids.disabledTrigger}, ${ids.deletedTrigger})
  `;
  assert.deepEqual(
    [...genericAudit],
    [
      {
        targetId: ids.enabledTrigger,
        metadata: { reason: "execution_owner_access_lost", revision: 4 },
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(genericAudit),
    /private-(?:enabled|disabled|deleted)-address|inbound\.example\.test/u,
  );

  const directDeleted = await sql<Array<{ id: string }>>`
    DELETE FROM "user" WHERE "id" = ${ids.directUser} RETURNING "id"
  `;
  assert.deepEqual([...directDeleted], [{ id: ids.directUser }]);
  const [directRow] = await sql<
    Array<{
      enabled: boolean;
      reason: string | null;
      revision: number;
      creator: string | null;
      executionOwner: string | null;
    }>
  >`
    SELECT "enabled", "disabled_reason" AS "reason", "revision",
           "created_by_user_id" AS "creator",
           "execution_owner_user_id" AS "executionOwner"
    FROM "project_email_triggers" WHERE "id" = ${ids.directTrigger}
  `;
  assert.deepEqual(directRow, {
    enabled: false,
    reason: "execution_owner_access_lost",
    revision: 2,
    creator: null,
    executionOwner: null,
  });

  const concurrentDeletes = await Promise.all([
    sql<Array<{ id: string }>>`
      DELETE FROM "member" WHERE "id" = ${ids.raceMember} RETURNING "id"
    `,
    sql<Array<{ id: string }>>`
      DELETE FROM "member" WHERE "id" = ${ids.raceMember} RETURNING "id"
    `,
  ]);
  assert.equal(concurrentDeletes.flat().length, 1);
  const [raceRow] = await sql<
    Array<{
      enabled: boolean;
      reason: string | null;
      revision: number;
      audits: number;
    }>
  >`
    SELECT triggers."enabled", triggers."disabled_reason" AS "reason",
           triggers."revision", count(audit."id")::int AS "audits"
    FROM "project_email_triggers" triggers
    LEFT JOIN "project_audit_events" audit
      ON audit."target_type" = 'project_email_trigger'
      AND audit."target_id" = triggers."id"
    WHERE triggers."id" = ${ids.raceTrigger}
    GROUP BY triggers."id"
  `;
  assert.deepEqual(raceRow, {
    enabled: false,
    reason: "execution_owner_access_lost",
    revision: 2,
    audits: 1,
  });
});
