import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();
const ownerLossMigration = fs.readFileSync(
  new URL(
    "../db/migrations/0090_project_email_trigger_owner_loss.sql",
    import.meta.url,
  ),
  "utf8",
);
const ownerLossMigrationStatements = ownerLossMigration
  .split("--> statement-breakpoint")
  .map((candidate) => candidate.trim())
  .filter(Boolean);

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
    staleUser: `trigger-owner-loss-stale-user-${suffix}`,
    staleMember: `trigger-owner-loss-stale-member-${suffix}`,
    cutoverUser: `trigger-owner-loss-cutover-user-${suffix}`,
    cutoverMember: `trigger-owner-loss-cutover-member-${suffix}`,
    enabledTrigger: `trigger-owner-loss-enabled-${suffix}`,
    disabledTrigger: `trigger-owner-loss-disabled-${suffix}`,
    deletedTrigger: `trigger-owner-loss-deleted-${suffix}`,
    directTrigger: `trigger-owner-loss-direct-${suffix}`,
    raceTrigger: `trigger-owner-loss-race-${suffix}`,
    staleEnabledTrigger: `trigger-owner-loss-stale-enabled-${suffix}`,
    staleDisabledTrigger: `trigger-owner-loss-stale-disabled-${suffix}`,
    staleDeletedTrigger: `trigger-owner-loss-stale-deleted-${suffix}`,
    cutoverTrigger: `trigger-owner-loss-cutover-${suffix}`,
  };

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
    await sql`
      DELETE FROM "user"
      WHERE "id" IN (${ids.admin}, ${ids.genericUser}, ${ids.directUser}, ${ids.raceUser}, ${ids.staleUser}, ${ids.cutoverUser})
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

  await sql.begin(async (transaction) => {
    await transaction`
      DROP TRIGGER "member_delete_disable_project_email_triggers" ON "member"
    `;
    await transaction`
      DROP FUNCTION "disable_project_email_triggers_on_member_delete"()
    `;
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${ids.staleUser}, 'Owner-loss Stale', ${`${ids.staleUser}@example.test`},
        true, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (
        ${ids.staleMember}, ${ids.organization}, ${ids.staleUser}, 'member', ${now}
      )
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES (${ids.project}, ${ids.staleMember}, 'editor')
    `;
    await transaction`
      INSERT INTO "project_email_triggers" (
        "id", "organization_id", "project_id", "created_by_user_id",
        "execution_owner_user_id", "name", "instruction", "model_id",
        "address_local_part", "address_domain", "enabled", "disabled_reason",
        "revision", "deleted_at", "created_at", "updated_at"
      ) VALUES
        (
          ${ids.staleEnabledTrigger}, ${ids.organization}, ${ids.project},
          ${ids.staleUser}, ${ids.staleUser}, 'Stale enabled target', 'Process email.',
          'openrouter/model', 'private-stale-enabled-address', 'inbound.example.test',
          true, NULL, 4, NULL, ${now}, ${now}
        ),
        (
          ${ids.staleDisabledTrigger}, ${ids.organization}, ${ids.project},
          ${ids.staleUser}, ${ids.staleUser}, 'Stale disabled target', 'Process email.',
          'openrouter/model', 'private-stale-disabled-address', 'inbound.example.test',
          false, 'manual', 6, NULL, ${now}, ${now}
        ),
        (
          ${ids.staleDeletedTrigger}, ${ids.organization}, ${ids.project},
          ${ids.staleUser}, ${ids.staleUser}, 'Stale deleted target', 'Process email.',
          'openrouter/model', 'private-stale-deleted-address', 'inbound.example.test',
          false, 'deleted', 8, ${now}, ${now}, ${now}
        )
    `;

    await transaction`DELETE FROM "member" WHERE "id" = ${ids.staleMember}`;
    const [beforeMigration] = await transaction<
      Array<{ enabled: boolean; revision: number }>
    >`
      SELECT "enabled", "revision"
      FROM "project_email_triggers"
      WHERE "id" = ${ids.staleEnabledTrigger}
    `;
    assert.deepEqual(beforeMigration, { enabled: true, revision: 4 });

    for (const statement of ownerLossMigrationStatements) {
      await transaction.unsafe(statement);
    }

    const migratedRows = await transaction<
      Array<{
        id: string;
        enabled: boolean;
        reason: string | null;
        revision: number;
      }>
    >`
      SELECT "id", "enabled", "disabled_reason" AS "reason", "revision"
      FROM "project_email_triggers"
      WHERE "id" IN (
        ${ids.staleEnabledTrigger}, ${ids.staleDisabledTrigger},
        ${ids.staleDeletedTrigger}
      )
      ORDER BY "id"
    `;
    assert.deepEqual(
      migratedRows.find((row) => row.id === ids.staleEnabledTrigger),
      {
        id: ids.staleEnabledTrigger,
        enabled: false,
        reason: "execution_owner_access_lost",
        revision: 5,
      },
    );
    assert.deepEqual(
      migratedRows.find((row) => row.id === ids.staleDisabledTrigger),
      {
        id: ids.staleDisabledTrigger,
        enabled: false,
        reason: "manual",
        revision: 6,
      },
    );
    assert.deepEqual(
      migratedRows.find((row) => row.id === ids.staleDeletedTrigger),
      {
        id: ids.staleDeletedTrigger,
        enabled: false,
        reason: "deleted",
        revision: 8,
      },
    );

    const staleAudit = await transaction<
      Array<{
        targetId: string;
        metadata: { reason: string; revision: number };
      }>
    >`
      SELECT "target_id" AS "targetId", "metadata"
      FROM "project_audit_events"
      WHERE "target_type" = 'project_email_trigger'
        AND "target_id" IN (
          ${ids.staleEnabledTrigger}, ${ids.staleDisabledTrigger},
          ${ids.staleDeletedTrigger}
        )
    `;
    assert.deepEqual(
      [...staleAudit],
      [
        {
          targetId: ids.staleEnabledTrigger,
          metadata: { reason: "execution_owner_access_lost", revision: 5 },
        },
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(staleAudit),
      /private-stale-(?:enabled|disabled|deleted)-address|inbound\.example\.test/u,
    );

    const formerUserDeleted = await transaction<Array<{ id: string }>>`
      DELETE FROM "user" WHERE "id" = ${ids.staleUser} RETURNING "id"
    `;
    assert.deepEqual([...formerUserDeleted], [{ id: ids.staleUser }]);
    const [preservedHistory] = await transaction<
      Array<{
        creator: string | null;
        executionOwner: string | null;
        enabled: boolean;
        reason: string | null;
        revision: number;
      }>
    >`
      SELECT "created_by_user_id" AS "creator",
             "execution_owner_user_id" AS "executionOwner",
             "enabled", "disabled_reason" AS "reason", "revision"
      FROM "project_email_triggers"
      WHERE "id" = ${ids.staleEnabledTrigger}
    `;
    assert.deepEqual(preservedHistory, {
      creator: null,
      executionOwner: null,
      enabled: false,
      reason: "execution_owner_access_lost",
      revision: 5,
    });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${ids.cutoverUser}, 'Owner-loss Cutover', ${`${ids.cutoverUser}@example.test`},
        true, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (
        ${ids.cutoverMember}, ${ids.organization}, ${ids.cutoverUser}, 'member', ${now}
      )
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES (${ids.project}, ${ids.cutoverMember}, 'editor')
    `;
    await transaction`
      INSERT INTO "project_email_triggers" (
        "id", "organization_id", "project_id", "created_by_user_id",
        "execution_owner_user_id", "name", "instruction", "model_id",
        "address_local_part", "address_domain", "enabled", "disabled_reason",
        "revision", "deleted_at", "created_at", "updated_at"
      ) VALUES (
        ${ids.cutoverTrigger}, ${ids.organization}, ${ids.project},
        ${ids.cutoverUser}, ${ids.cutoverUser}, 'Cutover target', 'Process email.',
        'openrouter/model', 'private-cutover-address', 'inbound.example.test',
        true, NULL, 10, NULL, ${now}, ${now}
      )
    `;
  });

  await sql`DROP TRIGGER "member_delete_disable_project_email_triggers" ON "member"`;
  await sql`DROP FUNCTION "disable_project_email_triggers_on_member_delete"()`;

  const migrationSql = postgres(databaseUrl, { max: 1 });
  const deleteSql = postgres(databaseUrl, { max: 1 });
  const observerSql = postgres(databaseUrl, { max: 1 });
  let boundaryInstalled = false;
  let deleteResult:
    | Promise<postgres.RowList<Array<{ id: string }>>>
    | undefined;
  try {
    assert.equal(ownerLossMigrationStatements.length, 4);
    await migrationSql.begin(async (migration) => {
      const [migrationBackend] = await migration<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS "pid"
      `;
      assert.ok(migrationBackend);

      await migration.unsafe(ownerLossMigrationStatements[0] as string);
      await migration.unsafe(ownerLossMigrationStatements[1] as string);

      let announceDeletePid!: (pid: number) => void;
      const deletePidReady = new Promise<number>((resolve) => {
        announceDeletePid = resolve;
      });
      deleteResult = deleteSql.begin(async (deletion) => {
        const [deleteBackend] = await deletion<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS "pid"
        `;
        assert.ok(deleteBackend);
        announceDeletePid(deleteBackend.pid);
        return deletion<Array<{ id: string }>>`
          DELETE FROM "member"
          WHERE "id" = ${ids.cutoverMember}
          RETURNING "id"
        `;
      });
      const deletePid = await deletePidReady;
      const blockedDelete = await waitForDatabaseBlock({
        sql: observerSql,
        blockedPid: deletePid,
        blockerPid: migrationBackend.pid,
      });
      assert.equal(blockedDelete.state, "active");
      assert.equal(blockedDelete.waitEventType, "Lock");
      assert.match(blockedDelete.query, /DELETE FROM "member"/u);

      await migration.unsafe(ownerLossMigrationStatements[2] as string);
      await migration.unsafe(ownerLossMigrationStatements[3] as string);
    });
    boundaryInstalled = true;

    assert.ok(deleteResult);
    assert.deepEqual([...(await deleteResult)], [{ id: ids.cutoverMember }]);
  } finally {
    if (deleteResult) {
      await deleteResult.catch(() => {});
    }
    if (!boundaryInstalled) {
      await applyOwnerLossMigration(sql);
    }
    await Promise.all([
      migrationSql.end({ timeout: 0 }),
      deleteSql.end({ timeout: 0 }),
      observerSql.end({ timeout: 0 }),
    ]);
  }

  const [cutoverRow] = await sql<
    Array<{
      enabled: boolean;
      reason: string | null;
      revision: number;
    }>
  >`
    SELECT "enabled", "disabled_reason" AS "reason", "revision"
    FROM "project_email_triggers"
    WHERE "id" = ${ids.cutoverTrigger}
  `;
  assert.deepEqual(cutoverRow, {
    enabled: false,
    reason: "execution_owner_access_lost",
    revision: 11,
  });
  const cutoverAudit = await sql<
    Array<{
      targetId: string;
      metadata: { reason: string; revision: number };
    }>
  >`
    SELECT "target_id" AS "targetId", "metadata"
    FROM "project_audit_events"
    WHERE "target_type" = 'project_email_trigger'
      AND "target_id" = ${ids.cutoverTrigger}
  `;
  assert.deepEqual(
    [...cutoverAudit],
    [
      {
        targetId: ids.cutoverTrigger,
        metadata: { reason: "execution_owner_access_lost", revision: 11 },
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(cutoverAudit),
    /private-cutover-address|inbound\.example\.test/u,
  );
});

async function waitForDatabaseBlock(input: {
  sql: postgres.Sql;
  blockedPid: number;
  blockerPid: number;
}) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [activity] = await input.sql<
      Array<{
        state: string;
        waitEventType: string | null;
        blockingPids: number[];
        query: string;
      }>
    >`
      SELECT "state", "wait_event_type" AS "waitEventType",
             pg_blocking_pids(${input.blockedPid}) AS "blockingPids", "query"
      FROM pg_stat_activity
      WHERE "pid" = ${input.blockedPid}
    `;
    if (activity?.blockingPids.includes(input.blockerPid)) {
      return activity;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for backend ${input.blockedPid} to be blocked by migration backend ${input.blockerPid}.`,
  );
}

async function applyOwnerLossMigration(sql: postgres.Sql) {
  await sql.begin(async (transaction) => {
    for (const statement of ownerLossMigrationStatements) {
      await transaction.unsafe(statement);
    }
  });
}
