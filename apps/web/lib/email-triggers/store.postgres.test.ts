import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { withGatewayModelEconomicsProfile } from "@/lib/ai/model-economics-profile";
import { createEmailTriggerInputSchema } from "./contracts";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("Project Email Triggers preserve private authority, rotation, and lifecycle contracts", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const previousDrizzleMaxConnections = process.env.DB_DRIZZLE_MAX_CONNECTIONS;
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.DB_DRIZZLE_MAX_CONNECTIONS = "1";

  const [{ resetDbRuntimeForTests }, triggers, projects] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./store"),
    import("@/lib/projects/store"),
  ]);
  const sql = postgres(databaseUrl, { max: 6 });
  const suffix = crypto.randomUUID();
  const ids = {
    organization: `trigger-org-${suffix}`,
    environment: `trigger-environment-${suffix}`,
    project: `trigger-project-${suffix}`,
    gateway: `trigger-gateway-${suffix}`,
    model: `trigger-model-${suffix}`,
    owner: `trigger-owner-${suffix}`,
    creator: `trigger-creator-${suffix}`,
    member: `trigger-member-${suffix}`,
    ownerMember: `trigger-owner-member-${suffix}`,
    creatorMember: `trigger-creator-member-${suffix}`,
    memberMember: `trigger-member-member-${suffix}`,
    connection: `trigger-connection-${suffix}`,
  };
  const now = new Date("2026-08-27T14:00:00.000Z");
  const modelMetadata = withGatewayModelEconomicsProfile({
    metadata: { context_length: 32_768, max_completion_tokens: 8192 },
    provider: "openrouter",
    model: "email-trigger-model",
    approved: true,
    modality: "language",
  });
  assert.ok(modelMetadata);

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
    await sql`DELETE FROM "user" WHERE "id" IN (${ids.owner}, ${ids.creator}, ${ids.member})`;
    await resetDbRuntimeForTests();
    if (previousDrizzleMaxConnections === undefined) {
      delete process.env.DB_DRIZZLE_MAX_CONNECTIONS;
    } else {
      process.env.DB_DRIZZLE_MAX_CONNECTIONS = previousDrizzleMaxConnections;
    }
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES
        (${ids.owner}, 'Trigger Owner', ${`${ids.owner}@example.test`}, true, ${now}, ${now}),
        (${ids.creator}, 'Trigger Creator', ${`${ids.creator}@example.test`}, true, ${now}, ${now}),
        (${ids.member}, 'Trigger Member', ${`${ids.member}@example.test`}, true, ${now}, ${now})
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${ids.organization}, 'Trigger Org', ${ids.organization}, ${now})
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES
        (${ids.ownerMember}, ${ids.organization}, ${ids.owner}, 'owner', ${now}),
        (${ids.creatorMember}, ${ids.organization}, ${ids.creator}, 'member', ${now}),
        (${ids.memberMember}, ${ids.organization}, ${ids.member}, 'member', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "region", "status", "is_default", "fly_app_name", "router_url"
      ) VALUES (
        ${ids.environment}, ${ids.organization}, ${ids.owner},
        'Trigger Environment', 'trigger', 'iad', 'ready', true,
        ${`trigger-app-${suffix}`}, 'https://environment.example'
      )
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES (
        ${ids.project}, ${ids.organization}, ${ids.environment},
        ${ids.owner}, 'Trigger Project'
      )
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES
        (${ids.project}, ${ids.ownerMember}, 'owner'),
        (${ids.project}, ${ids.creatorMember}, 'editor'),
        (${ids.project}, ${ids.memberMember}, 'member')
    `;
    await transaction`
      INSERT INTO "ai_gateways" (
        "id", "organization_id", "provider", "display_name"
      ) VALUES (
        ${ids.gateway}, ${ids.organization}, 'openrouter', 'Trigger Gateway'
      )
    `;
    await transaction`
      INSERT INTO "ai_gateway_models" (
        "id", "organization_id", "gateway_id", "raw_model_id", "modality",
        "approved", "is_default", "metadata"
      ) VALUES (
        ${ids.model}, ${ids.organization}, ${ids.gateway},
        'email-trigger-model', 'language', true, true,
        ${transaction.json(JSON.parse(JSON.stringify(modelMetadata)))}
      )
    `;
    await transaction`
      INSERT INTO "organization_receiving_connections" (
        "id", "organization_id", "encrypted_api_key", "credential_status",
        "credential_validated_at", "receiving_domain_id", "receiving_domain",
        "receiving_domain_status", "mx_status", "domain_checked_at",
        "route_locator", "provider_webhook_id", "encrypted_signing_secret",
        "webhook_status", "inbound_enabled", "last_health_checked_at",
        "created_at", "updated_at"
      ) VALUES (
        ${ids.connection}, ${ids.organization}, 'encrypted-key', 'full_access',
        ${now}, 'domain-1', 'inbound.example.test', 'verified', 'verified', ${now},
        ${`locator-${suffix}`}, ${`webhook-${suffix}`}, 'encrypted-secret',
        'active', true, ${now}, ${now}, ${now}
      )
    `;
  });

  await assert.rejects(
    triggers.createProjectEmailTrigger({
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.member,
      name: "Forbidden Trigger",
      modelId: "openrouter/email-trigger-model",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "PROJECT_FORBIDDEN",
  );
  await assert.rejects(
    triggers.createProjectEmailTrigger({
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.creator,
      name: "Unavailable model",
      modelId: "openrouter/not-approved",
    }),
    (error: unknown) =>
      error instanceof triggers.EmailTriggerReadinessError &&
      error.reason === "environment_model_unavailable",
  );

  const created = await triggers.createProjectEmailTrigger({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.creator,
    name: "Invoice intake",
    modelId: "openrouter/email-trigger-model",
    claimedFromFilter: "billing@example.test",
  });
  assert.equal(created.accessMode, "private");
  assert.equal(created.executionOwnerUserId, ids.creator);
  assert.equal(created.createdByUserId, ids.creator);
  assert.equal(created.revision, 1);
  assert.equal(created.enabled, true);
  assert.equal(created.disabledReason, null);
  assert.match(created.addressLocalPart, /^[a-f0-9]{32}$/u);
  assert.equal(created.addressDomain, "inbound.example.test");
  assert.equal(
    created.instruction,
    triggers.DEFAULT_EMAIL_TRIGGER_INSTRUCTION,
  );

  const memberProjection = await triggers.listProjectEmailTriggersForUser({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.member,
  });
  assert.equal(memberProjection[0]?.address, `${created.addressLocalPart}@inbound.example.test`);
  assert.deepEqual(memberProjection[0]?.permissions, {
    canEdit: false,
    canRotate: false,
    canEnable: false,
    canDisable: false,
    canDelete: false,
  });
  assert.deepEqual(
    await triggers.listProjectEmailTriggersForUser({
      organizationId: `another-${ids.organization}`,
      userId: ids.creator,
    }),
    [],
  );

  await sql`
    UPDATE "organization_receiving_connections"
    SET "receiving_domain_id" = 'domain-2',
        "receiving_domain" = 'new-inbound.example.test',
        "updated_at" = ${now}
    WHERE "organization_id" = ${ids.organization}
  `;
  const rotated = await triggers.rotateProjectEmailTriggerAddress({
    triggerId: created.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    expectedRevision: 1,
  });
  assert.equal(rotated.revision, 2);
  assert.notEqual(rotated.addressLocalPart, created.addressLocalPart);
  assert.equal(rotated.addressDomain, "new-inbound.example.test");
  assert.match(rotated.addressLocalPart, /^[a-f0-9]{32}$/u);
  const [oldAddress] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS "count"
    FROM "project_email_triggers"
    WHERE "address_local_part" = ${created.addressLocalPart}
      AND "address_domain" = ${created.addressDomain}
      AND "enabled" = true
      AND "deleted_at" IS NULL
  `;
  assert.equal(oldAddress?.count, 0);

  await assert.rejects(
    triggers.updateProjectEmailTrigger({
      triggerId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.owner,
      expectedRevision: 1,
      instruction: "This stale write must lose.",
    }),
    triggers.EmailTriggerConflictError,
  );
  const edited = await triggers.updateProjectEmailTrigger({
    triggerId: created.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    expectedRevision: 2,
    instruction: "Process the invoice using current Project instructions.",
  });
  assert.equal(edited.revision, 3);
  assert.equal(edited.executionOwnerUserId, ids.creator);
  assert.equal(edited.createdByUserId, ids.creator);

  const manuallyDisabled = await triggers.createProjectEmailTrigger({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.creator,
    name: "Manual pause",
    modelId: "openrouter/email-trigger-model",
  });
  const manual = await triggers.updateProjectEmailTrigger({
    triggerId: manuallyDisabled.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    expectedRevision: 1,
    enabled: false,
  });
  assert.equal(manual.disabledReason, "manual");
  assert.equal(manual.revision, 2);
  const repeatedManual = await triggers.updateProjectEmailTrigger({
    triggerId: manuallyDisabled.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    expectedRevision: 2,
    enabled: false,
  });
  assert.equal(repeatedManual.disabledReason, "manual");
  assert.equal(repeatedManual.revision, 2);
  const [manualAuditHistory] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS "count"
    FROM "project_audit_events"
    WHERE "target_id" = ${manuallyDisabled.id}
  `;
  assert.equal(manualAuditHistory?.count, 2);

  await projects.removeProjectMember({
    projectId: ids.project,
    organizationId: ids.organization,
    actorUserId: ids.owner,
    organizationMemberId: ids.creatorMember,
  });
  const [ownerLossRows] = await Promise.all([
    sql<Array<{ id: string; enabled: boolean; reason: string | null; revision: number }>>`
      SELECT "id", "enabled", "disabled_reason" AS "reason", "revision"
      FROM "project_email_triggers"
      WHERE "id" IN (${created.id}, ${manuallyDisabled.id})
      ORDER BY "id"
    `,
  ]);
  const ownerLost = ownerLossRows.find((row) => row.id === created.id);
  const manualPreserved = ownerLossRows.find((row) => row.id === manuallyDisabled.id);
  assert.deepEqual(ownerLost, {
    id: created.id,
    enabled: false,
    reason: "execution_owner_access_lost",
    revision: 4,
  });
  assert.deepEqual(manualPreserved, {
    id: manuallyDisabled.id,
    enabled: false,
    reason: "manual",
    revision: 2,
  });
  const repeatedOwnerLoss = await triggers.updateProjectEmailTrigger({
    triggerId: created.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    expectedRevision: 4,
    enabled: false,
  });
  assert.equal(repeatedOwnerLoss.disabledReason, "execution_owner_access_lost");
  assert.equal(repeatedOwnerLoss.revision, 4);
  const [ownerLossAuditHistory] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS "count"
    FROM "project_audit_events"
    WHERE "target_id" = ${created.id}
  `;
  assert.equal(ownerLossAuditHistory?.count, 4);

  const archiveTarget = await triggers.createProjectEmailTrigger({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.owner,
    name: "Archive target",
    modelId: "openrouter/email-trigger-model",
  });
  const archiveManualTarget = await triggers.createProjectEmailTrigger({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.owner,
    name: "Archive manual target",
    modelId: "openrouter/email-trigger-model",
  });
  await triggers.updateProjectEmailTrigger({
    triggerId: archiveManualTarget.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    expectedRevision: 1,
    enabled: false,
  });
  await projects.setProjectArchived({
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    archived: true,
  });
  const archiveRows = await sql<Array<{
    id: string;
    enabled: boolean;
    reason: string | null;
    revision: number;
  }>>`
    SELECT "id", "enabled", "disabled_reason" AS "reason", "revision"
    FROM "project_email_triggers"
    WHERE "id" IN (${archiveTarget.id}, ${archiveManualTarget.id})
    ORDER BY "id"
  `;
  assert.deepEqual(
    archiveRows.find((row) => row.id === archiveTarget.id),
    {
      id: archiveTarget.id,
      enabled: false,
      reason: "project_archived",
      revision: 2,
    },
  );
  const repeatedArchive = await triggers.updateProjectEmailTrigger({
    triggerId: archiveTarget.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    expectedRevision: 2,
    enabled: false,
  });
  assert.equal(repeatedArchive.disabledReason, "project_archived");
  assert.equal(repeatedArchive.revision, 2);
  const [archiveAuditHistory] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS "count"
    FROM "project_audit_events"
    WHERE "target_id" = ${archiveTarget.id}
  `;
  assert.equal(archiveAuditHistory?.count, 2);
  assert.deepEqual(
    archiveRows.find((row) => row.id === archiveManualTarget.id),
    {
      id: archiveManualTarget.id,
      enabled: false,
      reason: "manual",
      revision: 2,
    },
  );
  await assert.rejects(
    triggers.updateProjectEmailTrigger({
      triggerId: archiveTarget.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.owner,
      expectedRevision: 2,
      enabled: true,
    }),
    (error: unknown) =>
      error instanceof triggers.EmailTriggerReadinessError &&
      error.reason === "project_archived",
  );
  await projects.setProjectArchived({
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    archived: false,
  });

  const raceTarget = await triggers.createProjectEmailTrigger({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.owner,
    name: "Concurrent revision target",
    instruction: "Original concurrent instruction.",
    modelId: "openrouter/email-trigger-model",
  });
  const raceResults = await Promise.allSettled([
    triggers.updateProjectEmailTrigger({
      triggerId: raceTarget.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.owner,
      expectedRevision: 1,
      instruction: "The concurrent definition won.",
    }),
    triggers.rotateProjectEmailTriggerAddress({
      triggerId: raceTarget.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.owner,
      expectedRevision: 1,
    }),
  ]);
  assert.equal(
    raceResults.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    raceResults.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof triggers.EmailTriggerConflictError,
    ).length,
    1,
  );
  const [raceCommitted] = await sql<Array<{
    revision: number;
    instruction: string;
    addressLocalPart: string;
  }>>`
    SELECT "revision", "instruction",
           "address_local_part" AS "addressLocalPart"
    FROM "project_email_triggers"
    WHERE "id" = ${raceTarget.id}
  `;
  assert.equal(raceCommitted?.revision, 2);
  assert.notEqual(
    raceCommitted?.instruction === "The concurrent definition won.",
    raceCommitted?.addressLocalPart !== raceTarget.addressLocalPart,
    "exactly one same-revision definition or address outcome commits",
  );

  await sql`
    UPDATE "organization_receiving_connections"
    SET "inbound_enabled" = false, "webhook_status" = 'staged',
        "updated_at" = ${now}
    WHERE "organization_id" = ${ids.organization}
  `;
  const inactive = await triggers.createProjectEmailTrigger({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.owner,
    ...createEmailTriggerInputSchema.parse({
      name: "Prepared before activation",
      instruction: triggers.DEFAULT_EMAIL_TRIGGER_INSTRUCTION,
      modelId: "openrouter/email-trigger-model",
      claimedFromFilter: null,
    }),
  });
  assert.equal(inactive.enabled, false);
  assert.equal(inactive.disabledReason, "manual");
  await assert.rejects(
    triggers.createProjectEmailTrigger({
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.owner,
      name: "Explicit activation before receiving",
      modelId: "openrouter/email-trigger-model",
      enabled: true,
    }),
    (error: unknown) =>
      error instanceof triggers.EmailTriggerReadinessError &&
      error.reason === "inbound_receiving_unavailable",
  );
  const explicitlyInactive = await triggers.createProjectEmailTrigger({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.owner,
    name: "Explicitly prepared before activation",
    modelId: "openrouter/email-trigger-model",
    enabled: false,
  });
  assert.equal(explicitlyInactive.enabled, false);
  await assert.rejects(
    triggers.updateProjectEmailTrigger({
      triggerId: inactive.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.owner,
      expectedRevision: 1,
      enabled: true,
    }),
    (error: unknown) =>
      error instanceof triggers.EmailTriggerReadinessError &&
      error.reason === "inbound_receiving_unavailable",
  );

  const deleted = await triggers.deleteProjectEmailTrigger({
    triggerId: inactive.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    expectedRevision: 1,
  });
  assert.equal(deleted.enabled, false);
  assert.equal(deleted.disabledReason, "deleted");
  assert.equal(deleted.revision, 2);
  assert.ok(deleted.deletedAt);
  const visibleAfterDelete = await triggers.listProjectEmailTriggersForUser({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.owner,
  });
  assert.equal(visibleAfterDelete.some((trigger) => trigger.id === inactive.id), false);
});
