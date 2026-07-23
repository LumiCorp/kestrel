import assert from "node:assert/strict";
import postgres from "postgres";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

contractTest(
  "web.postgres",
  "Workspace reconciliation commit skips lifecycle operations inserted after provider inspection",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");

    const [
      { resetDbRuntimeForTests },
      { knowledgeDb },
      { findActiveWorkspaceLifecycleOperation },
      { recordWorkspaceReconciliationStatus },
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("@/lib/knowledge/db"),
      import("./lifecycle-operations"),
      import("./reconciliation-status"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    context.after(async () => {
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    const suffix = crypto.randomUUID();
    const organizationId = `org-reconcile-${suffix}`;
    const userId = `user-reconcile-${suffix}`;
    const threadId = `thread-reconcile-${suffix}`;
    const environmentId = `environment-reconcile-${suffix}`;
    const workspaceId = `workspace-reconcile-${suffix}`;
    const now = new Date();

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, 'Reconciliation User', ${`${userId}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Reconciliation Org',
          ${`reconciliation-${suffix}`}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id"
        ) VALUES (
          ${threadId}, 'Reconciliation Thread', ${userId}, ${organizationId}
        )
      `;
      await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "region", "status", "fly_app_name", "runtime_image"
        ) VALUES (
          ${environmentId}, ${organizationId}, ${userId},
          'Reconciliation Environment', ${`reconciliation-${suffix}`},
          'iad', 'ready', ${`fly-reconciliation-${suffix}`},
          'registry.example/workspace@sha256:test'
        )
      `;
      await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "standalone_thread_id",
          "created_by_user_id", "name", "kind", "status", "fly_machine_id",
          "fly_volume_id", "runtime_image", "failure_code", "failure_message"
        ) VALUES (
          ${workspaceId}, ${organizationId}, ${environmentId}, ${threadId},
          ${userId}, 'Reconciliation Workspace', 'scratch', 'starting',
          ${`machine-${suffix}`}, ${`volume-${suffix}`},
          'registry.example/workspace@sha256:test',
          'LIFECYCLE_OPERATION_ACTIVE', 'Lifecycle operation owns status.'
        )
      `;
    });

    const workspaceOperationTypes = [
      "workspace.provision",
      "workspace.start",
      "workspace.stop",
      "workspace.rebuild",
      "workspace.delete",
      "workspace.backup",
      "workspace.restore",
      "workspace.reconcile",
    ] as const;
    for (const [index, type] of workspaceOperationTypes.entries()) {
      const operationId = `operation-${index}-${suffix}`;
      await sql`
        INSERT INTO "environment_operations" (
          "id", "organization_id", "environment_id", "workspace_id",
          "requested_by_user_id", "type", "status", "stage",
          "idempotency_key", "created_at", "updated_at"
        ) VALUES (
          ${operationId}, ${organizationId}, ${environmentId}, ${workspaceId},
          ${userId}, ${type}, ${index % 2 === 0 ? "queued" : "running"},
          'environment.health.checking', ${operationId}, ${now}, ${now}
        )
      `;
      assert.equal(
        await recordWorkspaceReconciliationStatus({
          organizationId,
          environmentId,
          workspaceId,
          status: "ready",
          reconciledAt: new Date(now.getTime() + index + 1),
        }),
        false,
        `${type} must retain lifecycle ownership`,
      );
      const [workspace] = await sql<
        Array<{
          status: string;
          failureCode: string | null;
          lastHealthAt: Date | null;
        }>
      >`
        SELECT
          "status",
          "failure_code" AS "failureCode",
          "last_health_at" AS "lastHealthAt"
        FROM "environment_workspaces"
        WHERE "id" = ${workspaceId}
      `;
      assert.deepEqual(workspace, {
        status: "starting",
        failureCode: "LIFECYCLE_OPERATION_ACTIVE",
        lastHealthAt: null,
      });
      await sql`
        DELETE FROM "environment_operations" WHERE "id" = ${operationId}
      `;
    }

    for (const [index, type] of [
      "environment.update",
      "environment.delete",
    ].entries()) {
      const operationId = `environment-operation-${index}-${suffix}`;
      await sql`
        INSERT INTO "environment_operations" (
          "id", "organization_id", "environment_id", "workspace_id",
          "requested_by_user_id", "type", "status", "stage",
          "idempotency_key", "created_at", "updated_at"
        ) VALUES (
          ${operationId}, ${organizationId}, ${environmentId}, NULL,
          ${userId}, ${type}, 'running', 'environment.health.checking',
          ${operationId}, ${now}, ${now}
        )
      `;
      assert.equal(
        await recordWorkspaceReconciliationStatus({
          organizationId,
          environmentId,
          workspaceId,
          status: "ready",
          reconciledAt: new Date(now.getTime() + 100 + index),
        }),
        false,
        `${type} must retain lifecycle ownership`,
      );
      await sql`
        DELETE FROM "environment_operations" WHERE "id" = ${operationId}
      `;
    }

    const parentOperationId = `parent-operation-${suffix}`;
    const backupOperationId = `backup-operation-${suffix}`;
    const unrelatedOperationId = `unrelated-operation-${suffix}`;
    await sql`
      INSERT INTO "environment_operations" (
        "id", "organization_id", "environment_id", "workspace_id",
        "requested_by_user_id", "type", "status", "stage",
        "idempotency_key", "created_at", "updated_at"
      ) VALUES
        (
          ${parentOperationId}, ${organizationId}, ${environmentId}, NULL,
          ${userId}, 'environment.update', 'running',
          'environment.update.backing_up', ${parentOperationId}, ${now}, ${now}
        ),
        (
          ${backupOperationId}, ${organizationId}, ${environmentId},
          ${workspaceId}, ${userId}, 'workspace.backup', 'running',
          'workspace.backup.exporting', ${backupOperationId}, ${now}, ${now}
        )
    `;
    assert.equal(
      await findActiveWorkspaceLifecycleOperation(knowledgeDb, {
        organizationId,
        environmentId,
        workspaceId,
        excludedOperationIds: [parentOperationId, backupOperationId],
      }),
      undefined,
    );
    await sql`
      INSERT INTO "environment_operations" (
        "id", "organization_id", "environment_id", "workspace_id",
        "requested_by_user_id", "type", "status", "stage",
        "idempotency_key", "created_at", "updated_at"
      ) VALUES (
        ${unrelatedOperationId}, ${organizationId}, ${environmentId},
        ${workspaceId}, ${userId}, 'workspace.stop', 'queued',
        'environment.machine.stopping', ${unrelatedOperationId}, ${now}, ${now}
      )
    `;
    const unrelated =
      await findActiveWorkspaceLifecycleOperation(knowledgeDb, {
        organizationId,
        environmentId,
        workspaceId,
        excludedOperationIds: [parentOperationId, backupOperationId],
      });
    assert.equal(unrelated?.id, unrelatedOperationId);
    await sql`
      DELETE FROM "environment_operations"
      WHERE "id" IN (
        ${parentOperationId}, ${backupOperationId}, ${unrelatedOperationId}
      )
    `;

    const reconciledAt = new Date(now.getTime() + 1000);
    assert.equal(
      await recordWorkspaceReconciliationStatus({
        organizationId,
        environmentId,
        workspaceId,
        status: "ready",
        reconciledAt,
      }),
      true,
    );
    const [readyWorkspace] = await sql<
      Array<{
        status: string;
        failureCode: string | null;
        failureMessage: string | null;
        lastHealthAt: Date | null;
      }>
    >`
      SELECT
        "status",
        "failure_code" AS "failureCode",
        "failure_message" AS "failureMessage",
        "last_health_at" AS "lastHealthAt"
      FROM "environment_workspaces"
      WHERE "id" = ${workspaceId}
    `;
    assert.deepEqual(readyWorkspace, {
      status: "ready",
      failureCode: null,
      failureMessage: null,
      lastHealthAt: reconciledAt,
    });
  },
);
