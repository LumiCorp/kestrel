import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_TURN_DB_TEST_URL?.trim();

test("Project context continuation reuses only the exact persisted execution grant", async (context) => {
  assert.ok(databaseUrl, "KESTREL_TURN_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;

  const [{ resetDbRuntimeForTests }, grants] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./context-grants"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const ids = {
    user: `context-user-${suffix}`,
    organization: `context-org-${suffix}`,
    member: `context-member-${suffix}`,
    environment: `context-environment-${suffix}`,
    project: `context-project-${suffix}`,
    revision: `context-revision-${suffix}`,
    thread: `context-thread-${suffix}`,
    workspace: `context-workspace-${suffix}`,
    sourceTurn: `context-source-turn-${suffix}`,
    execution: `context-execution-${suffix}`,
    interaction: `context-interaction-${suffix}`,
    request: `context-request-${suffix}`,
    runtimeRun: `context-runtime-run-${suffix}`,
    grant: `context-grant-${suffix}`,
  };
  const now = new Date();

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
    await sql`DELETE FROM "user" WHERE "id" = ${ids.user}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${ids.user}, 'Context User', ${`${ids.user}@example.test`}, true,
        ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${ids.organization}, 'Context Org', ${ids.organization}, ${now})
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (${ids.member}, ${ids.organization}, ${ids.user}, 'owner', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "region", "status", "is_default"
      ) VALUES (
        ${ids.environment}, ${ids.organization}, ${ids.user}, 'Context',
        'context', 'iad', 'ready', true
      )
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES (
        ${ids.project}, ${ids.organization}, ${ids.environment}, ${ids.user},
        'Context Project'
      )
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES (${ids.project}, ${ids.member}, 'owner')
    `;
    await transaction`
      INSERT INTO "project_context_revisions" (
        "id", "project_id", "revision", "project_name", "instructions",
        "created_by_user_id"
      ) VALUES (
        ${ids.revision}, ${ids.project}, 7, 'Context Project', 'Exact context',
        ${ids.user}
      )
    `;
    await transaction`
      INSERT INTO "threads" (
        "id", "title", "created_by_user_id", "organization_id", "project_id"
      ) VALUES (
        ${ids.thread}, 'Context Thread', ${ids.user}, ${ids.organization},
        ${ids.project}
      )
    `;
    await transaction`
      INSERT INTO "environment_workspaces" (
        "id", "organization_id", "environment_id", "project_id",
        "created_by_user_id", "name", "kind", "status", "runtime_image"
      ) VALUES (
        ${ids.workspace}, ${ids.organization}, ${ids.environment}, ${ids.project},
        ${ids.user}, 'Context Workspace', 'project', 'ready', 'runtime:test'
      )
    `;
    await transaction`
      INSERT INTO "thread_turns" (
        "id", "organization_id", "thread_id", "author_user_id", "approval_id",
        "approval_approved", "project_context_revision_id",
        "requested_environment_id", "idempotency_key", "sequence",
        "queue_ordinal", "status"
      ) VALUES (
        ${ids.sourceTurn}, ${ids.organization}, ${ids.thread}, ${ids.user},
        'approval-source', true, ${ids.revision}, ${ids.environment},
        'context-source', 1, 1, 'waiting_for_input'
      )
    `;
    await transaction`
      INSERT INTO "environment_run_executions" (
        "id", "organization_id", "environment_id", "workspace_id", "thread_id",
        "project_id", "project_context_revision_id", "project_context_grant_id",
        "actor_id", "runtime_image", "effective_capabilities", "runtime_run_id",
        "status"
      ) VALUES (
        ${ids.execution}, ${ids.organization}, ${ids.environment}, ${ids.workspace},
        ${ids.thread}, ${ids.project}, ${ids.revision}, ${ids.grant}, ${ids.user},
        'runtime:test', '[]'::jsonb, ${ids.runtimeRun}, 'completed'
      )
    `;
    await transaction`
      UPDATE "thread_turns"
      SET "environment_execution_id" = ${ids.execution}
      WHERE "id" = ${ids.sourceTurn}
    `;
    await transaction`
      INSERT INTO "thread_interactions" (
        "id", "request_id", "organization_id", "thread_id", "turn_id", "source",
        "kind", "event_type", "prompt", "status", "request_envelope",
        "source_runtime_run_id", "resumed_at"
      ) VALUES (
        ${ids.interaction}, ${ids.request}, ${ids.organization}, ${ids.thread},
        ${ids.sourceTurn}, 'runtime', 'approval', 'tool.approval', 'Approve?',
        'processing', '{}'::jsonb, ${ids.runtimeRun}, ${now}
      )
    `;
  });

  const identity = {
    organizationId: ids.organization,
    projectId: ids.project,
    threadId: ids.thread,
    actorUserId: ids.user,
    contextRevisionId: ids.revision,
    contextRevision: 7,
  };
  assert.equal(
    await grants.resolveProjectContextGrantContinuationId({
      ...identity,
      executionId: ids.execution,
    }),
    ids.grant,
  );
  assert.equal(
    await grants.resolveProjectContextGrantContinuationId({
      ...identity,
      resumeInteractionId: ids.interaction,
    }),
    ids.grant,
  );

  await sql`
    UPDATE "environment_run_executions"
    SET "runtime_run_id" = 'wrong-runtime-run'
    WHERE "id" = ${ids.execution}
  `;
  await assert.rejects(
    grants.resolveProjectContextGrantContinuationId({
      ...identity,
      resumeInteractionId: ids.interaction,
    }),
    (error) =>
      error instanceof grants.ProjectContextGrantContinuityError &&
      error.code === "PROJECT_CONTEXT_GRANT_CONTINUITY_INVALID",
  );

  await sql`
    UPDATE "environment_run_executions"
    SET "runtime_run_id" = ${ids.runtimeRun}, "project_context_grant_id" = NULL
    WHERE "id" = ${ids.execution}
  `;
  await assert.rejects(
    grants.resolveProjectContextGrantContinuationId({
      ...identity,
      executionId: ids.execution,
    }),
    (error) => error instanceof grants.ProjectContextGrantContinuityError,
  );
});
