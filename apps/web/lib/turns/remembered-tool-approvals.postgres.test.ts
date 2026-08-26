import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_TURN_DB_TEST_URL?.trim();

test("remembered approval storage enforces identity, authority, and thread cascade", async (context) => {
  assert.ok(databaseUrl, "KESTREL_TURN_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");
  const { resetDbRuntimeForTests } = await import("@/lib/db/runtime");
  const {
    insertRememberedToolApprovalInTransaction,
    listRememberedToolApprovalEvidenceForRuntime,
  } = await import("./store");
  const { knowledgeDb } = await import("@/lib/knowledge/db");
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const userId = `remember-user-${suffix}`;
  const organizationId = `remember-org-${suffix}`;
  const memberId = `remember-member-${suffix}`;
  const environmentId = `remember-env-${suffix}`;
  const projectId = `remember-project-${suffix}`;
  const threadId = `remember-thread-${suffix}`;
  const turnId = `remember-turn-${suffix}`;
  const interactionId = `remember-interaction-${suffix}`;
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
        ${userId}, 'Remember User', ${`${userId}@example.test`}, true, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'Remember Org', ${organizationId}, ${now})
    `;
    await transaction`
      INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
      VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug", "region"
      ) VALUES (
        ${environmentId}, ${organizationId}, ${userId}, 'Remember Env',
        ${`remember-${suffix}`}, 'iad'
      )
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES (
        ${projectId}, ${organizationId}, ${environmentId}, ${userId}, 'Remember Project'
      )
    `;
    await transaction`
      INSERT INTO "project_members" ("project_id", "organization_member_id", "role")
      VALUES (${projectId}, ${memberId}, 'owner')
    `;
    await transaction`
      INSERT INTO "threads" (
        "id", "created_by_user_id", "organization_id", "project_id"
      ) VALUES (${threadId}, ${userId}, ${organizationId}, ${projectId})
    `;
    await transaction`
      INSERT INTO "thread_turns" (
        "id", "organization_id", "thread_id", "author_user_id", "approval_id",
        "approval_approved", "requested_environment_id", "idempotency_key",
        "sequence", "queue_ordinal", "status", "finished_at"
      ) VALUES (
        ${turnId}, ${organizationId}, ${threadId}, ${userId}, 'runtime-approval-1',
        true, ${environmentId}, ${`remember-${suffix}`}, 1, 1, 'completed', ${now}
      )
    `;
    await transaction`
      INSERT INTO "thread_interactions" (
        "id", "request_id", "organization_id", "thread_id", "turn_id", "source",
        "kind", "event_type", "prompt", "status", "request_envelope",
        "response_envelope", "resolved_by_user_id", "resolved_at"
      ) VALUES (
        ${interactionId}, ${`request-${suffix}`}, ${organizationId}, ${threadId},
        ${turnId}, 'runtime', 'approval', 'user.approval', 'Approve?', 'resolved',
        '{}'::jsonb, '{"decision":"remember_approval"}'::jsonb, ${userId}, ${now}
      )
    `;
  });

  const record = {
    version: "remembered_tool_approval_v1" as const,
    id: `remembered-${suffix}`,
    organizationId,
    threadId,
    actorUserId: userId,
    toolIdentity: {
      version: "stable_tool_approval_identity_v1" as const,
      toolId: "hosted.tool",
      descriptorContractRevision: `sha256:${"a".repeat(64)}`,
      approvalAuthorityRevision: "approval-authority-v1",
    },
    sourceInteractionId: interactionId,
    createdAt: now.toISOString(),
  };
  await assert.rejects(
    () => knowledgeDb.transaction((tx) =>
      insertRememberedToolApprovalInTransaction(tx, {
        ...record,
        id: `wrong-actor-${suffix}`,
        actorUserId: `other-user-${suffix}`,
      })),
    /exact resolved decision by this actor/u,
  );
  await assert.rejects(
    () => knowledgeDb.transaction((tx) =>
      insertRememberedToolApprovalInTransaction(tx, {
        ...record,
        id: `wrong-source-${suffix}`,
        sourceInteractionId: `other-interaction-${suffix}`,
      })),
    /exact resolved decision by this actor/u,
  );
  await knowledgeDb.transaction((tx) =>
    insertRememberedToolApprovalInTransaction(tx, record),
  );
  await assert.rejects(
    () => knowledgeDb.transaction((tx) =>
      insertRememberedToolApprovalInTransaction(tx, {
        ...record,
        id: `duplicate-${suffix}`,
      })),
    (error: unknown) => {
      const cause = error instanceof Error ? error.cause : undefined;
      return cause instanceof Error
        && /remembered_tool_approvals_identity_idx/u.test(cause.message);
    },
  );
  assert.deepEqual(
    await listRememberedToolApprovalEvidenceForRuntime({
      organizationId,
      threadId,
      userId,
    }),
    [{
      version: "remembered_tool_approval_evidence_v1",
      organizationId,
      projectId,
      environmentId,
      threadId,
      actorUserId: userId,
      toolIdentity: record.toolIdentity,
      sourceInteractionId: interactionId,
    }],
  );
  await assert.rejects(
    () => listRememberedToolApprovalEvidenceForRuntime({
      organizationId,
      threadId,
      userId: `outsider-${suffix}`,
    }),
    /Thread not found/u,
  );
  await assert.rejects(
    () => listRememberedToolApprovalEvidenceForRuntime({
      organizationId: `other-org-${suffix}`,
      threadId,
      userId,
    }),
    /Thread not found/u,
  );
  await sql`DELETE FROM "threads" WHERE "id" = ${threadId}`;
  const [remaining] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "remembered_tool_approvals"
    WHERE "id" = ${record.id}
  `;
  assert.equal(remaining?.count, 0);
});
