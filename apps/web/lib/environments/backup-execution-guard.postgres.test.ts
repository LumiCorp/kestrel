import assert from "node:assert/strict";
import postgres from "postgres";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

contractTest(
  "web.postgres",
  "queued Workspace backup claim defers while an execution owns the Workspace",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");

    const [{ resetDbRuntimeForTests }, { processQueuedWorkspaceBackup }] =
      await Promise.all([
        import("@/lib/db/runtime"),
        import("./backups"),
      ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const organizationId = `org-backup-guard-${suffix}`;
    const userId = `user-backup-guard-${suffix}`;
    const threadId = `thread-backup-guard-${suffix}`;
    const environmentId = `environment-backup-guard-${suffix}`;
    const workspaceId = `workspace-backup-guard-${suffix}`;
    const operationId = `operation-backup-guard-${suffix}`;
    const backupId = `backup-guard-${suffix}`;
    const executionId = `execution-backup-guard-${suffix}`;
    const now = new Date();

    context.after(async () => {
      await sql`
        DELETE FROM "organization" WHERE "id" = ${organizationId}
      `.catch(() => {});
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, 'Backup Guard User', ${`${userId}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Backup Guard Org',
          ${`backup-guard-${suffix}`}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id"
        ) VALUES (
          ${threadId}, 'Backup Guard Thread', ${userId}, ${organizationId}
        )
      `;
      await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "region", "status", "fly_app_name", "runtime_image"
        ) VALUES (
          ${environmentId}, ${organizationId}, ${userId},
          'Backup Guard Environment', ${`backup-guard-${suffix}`},
          'iad', 'ready', ${`fly-backup-guard-${suffix}`},
          'registry.example/workspace@sha256:test'
        )
      `;
      await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "standalone_thread_id",
          "created_by_user_id", "name", "kind", "status", "fly_machine_id",
          "fly_volume_id", "runtime_image"
        ) VALUES (
          ${workspaceId}, ${organizationId}, ${environmentId}, ${threadId},
          ${userId}, 'Backup Guard Workspace', 'scratch', 'ready',
          ${`machine-${suffix}`}, ${`volume-${suffix}`},
          'registry.example/workspace@sha256:test'
        )
      `;
      await transaction`
        INSERT INTO "thread_execution_bindings" (
          "thread_id", "organization_id", "environment_id", "workspace_id",
          "source", "bound_by_user_id", "created_at", "updated_at"
        ) VALUES (
          ${threadId}, ${organizationId}, ${environmentId}, ${workspaceId},
          'thread', ${userId}, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "environment_operations" (
          "id", "organization_id", "environment_id", "workspace_id",
          "requested_by_user_id", "type", "status", "stage",
          "idempotency_key", "attempt", "input", "created_at", "updated_at"
        ) VALUES (
          ${operationId}, ${organizationId}, ${environmentId}, ${workspaceId},
          ${userId}, 'workspace.backup', 'queued', 'workspace.backup.queued',
          ${`workspace.backup.daily:${workspaceId}:2026-07-24`}, 0,
          ${transaction.json({ backupExecutionOwnership: "queue" })},
          ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "workspace_backups" (
          "id", "organization_id", "environment_id", "workspace_id",
          "operation_id", "reason", "status", "expires_at",
          "created_at", "updated_at"
        ) VALUES (
          ${backupId}, ${organizationId}, ${environmentId}, ${workspaceId},
          ${operationId}, 'daily', 'queued',
          ${new Date(now.getTime() + 86_400_000)}, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "environment_run_executions" (
          "id", "organization_id", "environment_id", "workspace_id",
          "thread_id", "actor_id", "runtime_image",
          "effective_capabilities", "status", "started_at",
          "created_at", "updated_at"
        ) VALUES (
          ${executionId}, ${organizationId}, ${environmentId}, ${workspaceId},
          ${threadId}, ${userId}, 'registry.example/runner@sha256:test',
          ${transaction.json([])}, 'running', ${now}, ${now}, ${now}
        )
      `;
    });

    assert.equal(
      await processQueuedWorkspaceBackup({
        operationId,
        workerAttempt: {
          attempt: 1,
          canRetry: true,
          retryCount: 0,
          retryLimit: 4,
        },
      }),
      "deferred",
    );

    const [record] = await sql<
      Array<{
        operationStatus: string;
        operationStage: string;
        operationAttempt: number;
        operationStartedAt: Date | null;
        backupStatus: string;
      }>
    >`
      SELECT
        operation."status" AS "operationStatus",
        operation."stage" AS "operationStage",
        operation."attempt" AS "operationAttempt",
        operation."started_at" AS "operationStartedAt",
        backup."status" AS "backupStatus"
      FROM "environment_operations" operation
      JOIN "workspace_backups" backup ON backup."operation_id" = operation."id"
      WHERE operation."id" = ${operationId}
    `;
    assert.deepEqual(record, {
      operationStatus: "queued",
      operationStage: "workspace.backup.waiting_for_execution",
      operationAttempt: 0,
      operationStartedAt: null,
      backupStatus: "queued",
    });
  },
);
