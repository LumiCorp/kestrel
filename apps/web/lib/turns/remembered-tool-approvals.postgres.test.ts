import assert from "node:assert/strict";
import test from "node:test";
import { eq, sql as drizzleSql } from "drizzle-orm";
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
  const { knowledgeDb, schema } = await import("@/lib/knowledge/db");
  const sql = postgres(databaseUrl, { max: 2 });
  const suffix = crypto.randomUUID();
  const userId = `remember-user-${suffix}`;
  const organizationId = `remember-org-${suffix}`;
  const memberId = `remember-member-${suffix}`;
  const environmentId = `remember-env-${suffix}`;
  const projectId = `remember-project-${suffix}`;
  const threadId = `remember-thread-${suffix}`;
  const otherThreadId = `remember-other-thread-${suffix}`;
  const turnId = `remember-turn-${suffix}`;
  const interactionId = `remember-interaction-${suffix}`;
  const declineInteractionId = `remember-decline-${suffix}`;
  const approveOnceInteractionId = `remember-approve-once-${suffix}`;
  const emptySourceInteractionId = `remember-empty-source-${suffix}`;
  const malformedIdentityInteractionId = `remember-malformed-identity-${suffix}`;
  const now = new Date();
  const toolIdentity = {
    version: "stable_tool_approval_identity_v1" as const,
    toolId: "hosted.tool",
    descriptorContractRevision: `sha256:${"a".repeat(64)}`,
    approvalAuthorityRevision: "approval-authority-v1",
  };
  const hostedApprovalRequest = (
    requestId: string,
    identity = toolIdentity,
    toolName = identity.toolId,
  ) => ({
    version: "runner_hosted_tool_approval_interaction_v4" as const,
    requestId,
    kind: "approval" as const,
    eventType: "user.approval" as const,
    prompt: "Remember?",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false as const,
      required: ["decision"] as const,
      properties: {
        decision: {
          type: "string" as const,
          enum: ["decline", "approve_once", "remember_approval"] as const,
        },
      },
    },
    approval: {
      preparedInvocationId: `prepared-${requestId}`,
      toolName,
      stableToolIdentity: identity,
      requestingActor: {
        actorType: "end_user" as const,
        actorId: userId,
        tenantId: organizationId,
      },
      rememberedApprovalScope: { kind: "tool_identity" as const },
      requestedAt: new Date(now.getTime() - 1_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
  });

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
      ) VALUES
        (${threadId}, ${userId}, ${organizationId}, ${projectId}),
        (${otherThreadId}, ${userId}, ${organizationId}, ${projectId})
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
        "kind", "event_type", "prompt", "status", "request_envelope"
      ) VALUES
      (
        ${interactionId}, ${`request-${suffix}`}, ${organizationId}, ${threadId},
        ${turnId}, 'runtime', 'approval', 'user.approval', 'Remember?', 'pending',
        ${transaction.json(hostedApprovalRequest(`request-${suffix}`))}
      ),
      (
        ${declineInteractionId}, ${`decline-request-${suffix}`}, ${organizationId},
        ${threadId}, ${turnId}, 'runtime', 'approval', 'user.approval', 'Decline?',
        'pending', ${transaction.json(hostedApprovalRequest(`decline-request-${suffix}`))}
      ),
      (
        ${approveOnceInteractionId}, ${`approve-once-request-${suffix}`},
        ${organizationId}, ${threadId}, ${turnId}, 'runtime', 'approval',
        'user.approval', 'Approve once?', 'pending',
        ${transaction.json(hostedApprovalRequest(`approve-once-request-${suffix}`))}
      ),
      (
        ${emptySourceInteractionId}, ${`empty-source-request-${suffix}`},
        ${organizationId}, ${threadId}, ${turnId}, 'runtime', 'approval',
        'user.approval', 'Empty source?', 'pending', '{}'::jsonb
      ),
      (
        ${malformedIdentityInteractionId}, ${`malformed-request-${suffix}`},
        ${organizationId}, ${threadId}, ${turnId}, 'runtime', 'approval',
        'user.approval', 'Malformed identity?', 'pending',
        ${transaction.json(
          hostedApprovalRequest(
            `malformed-request-${suffix}`,
            { ...toolIdentity, toolId: "hosted.arbitrary-tool" },
            "hosted.tool",
          ),
        )}
      )
    `;
  });

  const record = {
    version: "remembered_tool_approval_v1" as const,
    id: `remembered-${suffix}`,
    organizationId,
    threadId,
    actorUserId: userId,
    toolIdentity,
        scope: { kind: "tool_identity" as const },
    sourceInteractionId: interactionId,
    createdAt: now.toISOString(),
  };
  const decideAndInsert = (
    sourceInteractionId: string,
    decision: "decline" | "approve_once" | "remember_approval",
    approval = { ...record, sourceInteractionId },
  ) =>
    knowledgeDb.transaction(async (tx) => {
      await tx
        .update(schema.threadInteractions)
        .set({
          status: "processing",
          responseEnvelope: { decision },
          resolvedByUserId: userId,
          resolvedAt: now,
        })
        .where(eq(schema.threadInteractions.id, sourceInteractionId));
      return insertRememberedToolApprovalInTransaction(tx, {
        approval,
      });
    });

  const waitUntilBlockedBy = async (blockingPid: number) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [blocked] = await sql<{ blocked: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE ${blockingPid} = ANY(pg_blocking_pids(pid))
        ) AS blocked
      `;
      if (blocked?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      "Remembered approval writer did not wait on the canonical Thread lock.",
    );
  };

  await assert.rejects(
    () =>
      decideAndInsert(declineInteractionId, "decline", {
        ...record,
        id: `decline-${suffix}`,
        scope: { kind: "tool_identity" as const },
        sourceInteractionId: declineInteractionId,
      }),
    /exact remember decision/u,
  );
  await assert.rejects(
    () =>
      decideAndInsert(approveOnceInteractionId, "approve_once", {
        ...record,
        id: `approve-once-${suffix}`,
        scope: { kind: "tool_identity" as const },
        sourceInteractionId: approveOnceInteractionId,
      }),
    /exact remember decision/u,
  );
  await assert.rejects(
    () =>
      decideAndInsert(interactionId, "remember_approval", {
        ...record,
        id: `wrong-actor-${suffix}`,
        actorUserId: `other-user-${suffix}`,
      }),
    /locked source interaction authority/u,
  );
  await assert.rejects(
    () =>
      decideAndInsert(interactionId, "remember_approval", {
        ...record,
        id: `wrong-thread-${suffix}`,
        threadId: otherThreadId,
      }),
    /locked source interaction authority/u,
  );
  await assert.rejects(
    () =>
      decideAndInsert(emptySourceInteractionId, "remember_approval", {
        ...record,
        id: `empty-source-${suffix}`,
        scope: { kind: "tool_identity" as const },
        sourceInteractionId: emptySourceInteractionId,
      }),
    /does not contain exact prepared tool identity/u,
  );
  await assert.rejects(
    () =>
      decideAndInsert(malformedIdentityInteractionId, "remember_approval", {
        ...record,
        id: `arbitrary-source-${suffix}`,
        scope: { kind: "tool_identity" as const },
        sourceInteractionId: malformedIdentityInteractionId,
        toolIdentity: {
          ...record.toolIdentity,
          toolId: "hosted.arbitrary-tool",
        },
      }),
    /does not contain exact prepared tool identity/u,
  );
  await assert.rejects(
    () =>
      decideAndInsert(interactionId, "remember_approval", {
        ...record,
        id: `wrong-identity-${suffix}`,
        toolIdentity: {
          ...record.toolIdentity,
          toolId: "hosted.other-tool",
        },
      }),
    /does not match the locked source interaction authority/u,
  );
  await sql`
    UPDATE "thread_interactions"
    SET
      "status" = 'processing',
      "response_envelope" = ${sql.json({ decision: "remember_approval" })},
      "resolved_by_user_id" = ${userId},
      "resolved_at" = ${now}
    WHERE "id" = ${interactionId}
  `;
  let releaseCanonicalTransaction = () => {};
  const canonicalTransactionMayContinue = new Promise<void>((resolve) => {
    releaseCanonicalTransaction = resolve;
  });
  let canonicalThreadLocked = () => {};
  const canonicalThreadLockReady = new Promise<void>((resolve) => {
    canonicalThreadLocked = resolve;
  });
  let blockingConnectionPid: number | undefined;
  const canonicalResponseTransaction = sql.begin(async (transaction) => {
    await transaction`SET LOCAL lock_timeout = '5s'`;
    const [connection] = await transaction<{ pid: number }[]>`
      SELECT pg_backend_pid() AS pid
    `;
    assert.ok(connection);
    blockingConnectionPid = connection.pid;
    await transaction`
      SELECT "id" FROM "threads" WHERE "id" = ${threadId} FOR UPDATE
    `;
    canonicalThreadLocked();
    await canonicalTransactionMayContinue;
    await transaction`
      SELECT "id" FROM "thread_interactions"
      WHERE "id" = ${interactionId}
      FOR UPDATE
    `;
    return connection.pid;
  });
  await canonicalThreadLockReady;
  const rememberedInsert = knowledgeDb.transaction(async (tx) => {
    await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
    return insertRememberedToolApprovalInTransaction(tx, { approval: record });
  });
  assert.ok(blockingConnectionPid !== undefined);
  try {
    await waitUntilBlockedBy(blockingConnectionPid);
  } finally {
    releaseCanonicalTransaction();
  }
  const [, inserted] = await Promise.all([
    canonicalResponseTransaction,
    rememberedInsert,
  ]);
  assert.deepEqual(inserted, record);
  const rememberedRows = await sql<
    {
      id: string;
      organizationId: string;
      threadId: string;
      actorUserId: string;
      toolId: string;
      descriptorContractRevision: string;
      approvalAuthorityRevision: string;
      scope: { kind: "tool_identity" };
      sourceInteractionId: string;
    }[]
  >`
    SELECT
      "id",
      "organization_id" AS "organizationId",
      "thread_id" AS "threadId",
      "actor_user_id" AS "actorUserId",
      "tool_id" AS "toolId",
      "descriptor_contract_revision" AS "descriptorContractRevision",
      "approval_authority_revision" AS "approvalAuthorityRevision",
      "scope_payload" AS "scope",
      "source_interaction_id" AS "sourceInteractionId"
    FROM "remembered_tool_approvals"
    WHERE
      "organization_id" = ${organizationId}
      AND "thread_id" = ${threadId}
      AND "actor_user_id" = ${userId}
  `;
  assert.deepEqual(
    [...rememberedRows],
    [
      {
        id: record.id,
        organizationId,
        threadId,
        actorUserId: userId,
        toolId: toolIdentity.toolId,
        descriptorContractRevision: toolIdentity.descriptorContractRevision,
        approvalAuthorityRevision: toolIdentity.approvalAuthorityRevision,
        scope: { kind: "tool_identity" as const },
        sourceInteractionId: interactionId,
      },
    ],
  );
  const [sourceAfterInsert] = await sql<{ status: string }[]>`
    SELECT "status" FROM "thread_interactions" WHERE "id" = ${interactionId}
  `;
  assert.equal(sourceAfterInsert?.status, "processing");
  await assert.rejects(
    () =>
      knowledgeDb.transaction((tx) =>
        insertRememberedToolApprovalInTransaction(tx, {
          approval: {
            ...record,
            id: `duplicate-${suffix}`,
          },
        }),
      ),
    (error: unknown) => {
      const cause = error instanceof Error ? error.cause : undefined;
      return (
        cause instanceof Error &&
        /remembered_tool_approvals_identity_idx/u.test(cause.message)
      );
    },
  );
  assert.deepEqual(
    await listRememberedToolApprovalEvidenceForRuntime({
      organizationId,
      threadId,
      userId,
    }),
    [
      {
        version: "remembered_tool_approval_evidence_v1",
        organizationId,
        projectId,
        environmentId,
        threadId,
        actorUserId: userId,
        toolIdentity: record.toolIdentity,
        scope: { kind: "tool_identity" as const },
        sourceInteractionId: interactionId,
      },
    ],
  );
  await assert.rejects(
    () =>
      listRememberedToolApprovalEvidenceForRuntime({
        organizationId,
        threadId,
        userId: `outsider-${suffix}`,
      }),
    /Thread not found/u,
  );
  await assert.rejects(
    () =>
      listRememberedToolApprovalEvidenceForRuntime({
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
