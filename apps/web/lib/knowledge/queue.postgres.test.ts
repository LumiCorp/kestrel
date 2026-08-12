import assert from "node:assert/strict";
import test from "node:test";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

async function waitForJobState(
  sql: postgres.Sql,
  jobId: string,
  expected: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [job] = await sql<Array<{ state: string }>>`
      SELECT state FROM pgboss.job WHERE id = ${jobId}::uuid
    `;
    if (job?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`pg-boss job ${jobId} did not become ${expected}.`);
}

test(
  "Environment reconciliation preserves terminal history and parks dependencies without attempts",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    const [queue, queueState, dependency, { resetDbRuntimeForTests }] =
      await Promise.all([
        import("./queue"),
        import("./queue-state"),
        import("@/lib/environments/dependency"),
        import("@/lib/db/runtime"),
      ]);
    const sql = postgres(databaseUrl, { max: 2 });
    const boss = new PgBoss({ connectionString: databaseUrl, migrate: true });
    await boss.start();
    await boss.createQueue(queue.ENVIRONMENT_OPERATION_QUEUE);
    queueState.knowledgeQueueState.databaseUrl = databaseUrl;
    queueState.knowledgeQueueState.bossPromise = Promise.resolve(boss);

    const suffix = crypto.randomUUID();
    const userId = `queue-user-${suffix}`;
    const degradedOwnerUserId = `queue-degraded-owner-${suffix}`;
    const organizationId = `queue-org-${suffix}`;
    const waitingEnvironmentId = `queue-waiting-env-${suffix}`;
    const degradedEnvironmentId = `queue-degraded-env-${suffix}`;
    const waitingWorkspaceId = crypto.randomUUID();
    const degradedWorkspaceId = crypto.randomUUID();
    const parentOperationId = crypto.randomUUID();
    const degradedParentOperationId = crypto.randomUUID();
    const waitingOperationId = crypto.randomUUID();
    const incidentOperationId = crypto.randomUUID();

    context.after(async () => {
      await boss.stop({ graceful: true, timeout: 5000 });
      queueState.knowledgeQueueState.bossPromise = null;
      queueState.knowledgeQueueState.environmentWorkersRegistered = false;
      await sql`
        DELETE FROM pgboss.job
        WHERE data->>'operationId' IN (
          ${waitingOperationId}, ${incidentOperationId},
          ${degradedParentOperationId}
        )
      `;
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`
        DELETE FROM "user"
        WHERE "id" IN (${userId}, ${degradedOwnerUserId})
      `;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES
          (
            ${userId}, 'Queue User', ${`${userId}@example.test`}, true, now(), now()
          ),
          (
            ${degradedOwnerUserId}, 'Degraded Owner',
            ${`${degradedOwnerUserId}@example.test`}, true, now(), now()
          )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (${organizationId}, 'Queue Org', ${`queue-org-${suffix}`}, now())
      `;
      await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "region", "status", "is_default"
        ) VALUES
          (
            ${waitingEnvironmentId}, ${organizationId}, ${userId}, 'Waiting',
            ${`waiting-${suffix}`}, 'iad', 'provisioning', false
          ),
          (
            ${degradedEnvironmentId}, ${organizationId}, ${userId}, 'Degraded',
            ${`degraded-${suffix}`}, 'iad', 'degraded', false
          )
      `;
      await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "personal_owner_user_id",
          "created_by_user_id", "name", "kind", "status"
        ) VALUES
          (
            ${waitingWorkspaceId}, ${organizationId}, ${waitingEnvironmentId},
            ${userId}, ${userId}, 'Waiting Workspace', 'scratch', 'requested'
          ),
          (
            ${degradedWorkspaceId}, ${organizationId}, ${degradedEnvironmentId},
            ${degradedOwnerUserId}, ${userId}, 'Degraded Workspace', 'scratch', 'requested'
          )
      `;
      await transaction`
        INSERT INTO "environment_operations" (
          "id", "organization_id", "environment_id", "workspace_id", "type",
          "status", "stage", "idempotency_key", "attempt", "created_at", "updated_at"
        ) VALUES
          (
            ${parentOperationId}, ${organizationId}, ${waitingEnvironmentId}, null,
            'environment.provision', 'queued', 'environment.activation.requested',
            ${`environment.provision:${waitingEnvironmentId}`}, 0, now(), now()
          ),
          (
            ${waitingOperationId}, ${organizationId}, ${waitingEnvironmentId},
            ${waitingWorkspaceId}, 'workspace.provision', 'queued',
            'environment.runtime.connecting', ${`workspace.provision:${waitingWorkspaceId}`},
            2000, now(), now()
          ),
          (
            ${incidentOperationId}, ${organizationId}, ${degradedEnvironmentId},
            ${degradedWorkspaceId}, 'workspace.provision', 'queued',
            'environment.runtime.connecting', ${`workspace.provision:${degradedWorkspaceId}`},
            2000, now(), now()
          ),
          (
            ${degradedParentOperationId}, ${organizationId},
            ${degradedEnvironmentId}, null, 'environment.update', 'queued',
            'environment.activation.requested',
            ${`environment.update:${degradedEnvironmentId}`}, 0, now(), now()
          )
      `;
    });

    await queue.enqueueEnvironmentOperation(waitingOperationId);
    const [parked] = await sql<
      Array<{
        attempt: number;
        stage: string;
        errorCode: string | null;
        updatedAt: Date;
      }>
    >`
      SELECT attempt, stage, error_code AS "errorCode", updated_at AS "updatedAt"
      FROM environment_operations WHERE id = ${waitingOperationId}
    `;
    assert.equal(parked?.attempt, 2000);
    assert.equal(parked?.stage, "environment.dependency.waiting");
    assert.equal(parked?.errorCode, "ENVIRONMENT_DEPENDENCY_WAITING");
    await queue.enqueueEnvironmentOperation(waitingOperationId);
    const [stillParked] = await sql<Array<{ updatedAt: Date }>>`
      SELECT updated_at AS "updatedAt"
      FROM environment_operations WHERE id = ${waitingOperationId}
    `;
    assert.equal(stillParked?.updatedAt.getTime(), parked?.updatedAt.getTime());
    const [parkedJobs] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pgboss.job
      WHERE name = ${queue.ENVIRONMENT_OPERATION_QUEUE}
        AND data->>'operationId' = ${waitingOperationId}
    `;
    assert.equal(parkedJobs?.count, 0);

    await sql`
      UPDATE environments
      SET status = 'ready', fly_app_name = ${`queue-ready-${suffix}`}
      WHERE id = ${waitingEnvironmentId}
    `;
    await sql`
      UPDATE environment_operations SET status = 'completed', completed_at = now()
      WHERE id = ${parentOperationId}
    `;
    await queue.enqueueEnvironmentOperation(waitingOperationId);
    await queue.enqueueEnvironmentOperation(waitingOperationId);
    const [awakened] = await sql<Array<{ attempt: number; stage: string }>>`
      SELECT attempt, stage FROM environment_operations WHERE id = ${waitingOperationId}
    `;
    assert.deepEqual(awakened, {
      attempt: 2000,
      stage: "environment.activation.requested",
    });
    const [activeJobs] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pgboss.job
      WHERE name = ${queue.ENVIRONMENT_OPERATION_QUEUE}
        AND data->>'operationId' = ${waitingOperationId}
        AND state IN ('active', 'created', 'retry')
    `;
    assert.equal(activeJobs?.count, 1);

    const historicalJobId = await boss.send(
      queue.ENVIRONMENT_OPERATION_QUEUE,
      { operationId: incidentOperationId },
      { id: incidentOperationId },
    );
    assert.equal(historicalJobId, incidentOperationId);
    await boss.work(queue.ENVIRONMENT_OPERATION_QUEUE, async () => {});
    await waitForJobState(sql, incidentOperationId, "completed");
    await boss.offWork(queue.ENVIRONMENT_OPERATION_QUEUE);

    await queue.reconcileEnvironmentOperationQueue(boss);
    const incidentJobs = await sql<
      Array<{ id: string; state: string }>
    >`
      SELECT id::text, state FROM pgboss.job
      WHERE name = ${queue.ENVIRONMENT_OPERATION_QUEUE}
        AND data->>'operationId' = ${incidentOperationId}
      ORDER BY created_on, id
    `;
    assert.equal(incidentJobs.length, 2);
    assert.deepEqual(
      incidentJobs.map((job) => job.state).sort(),
      ["completed", "created"],
    );
    assert.equal(
      incidentJobs.some((job) => job.id === incidentOperationId),
      true,
    );

    assert.equal(
      await dependency.settleWorkspaceProvisionDependency(incidentOperationId),
      "terminal",
    );
    const [terminal] = await sql<
      Array<{
        attempt: number;
        operationStatus: string;
        operationCode: string | null;
        workspaceStatus: string;
        workspaceCode: string | null;
      }>
    >`
      SELECT
        operation.attempt,
        operation.status AS "operationStatus",
        operation.error_code AS "operationCode",
        workspace.status AS "workspaceStatus",
        workspace.failure_code AS "workspaceCode"
      FROM environment_operations operation
      JOIN environment_workspaces workspace ON workspace.id = operation.workspace_id
      WHERE operation.id = ${incidentOperationId}
    `;
    assert.deepEqual(terminal, {
      attempt: 2000,
      operationStatus: "failed",
      operationCode: "ENVIRONMENT_DEPENDENCY_UNAVAILABLE",
      workspaceStatus: "failed",
      workspaceCode: "ENVIRONMENT_DEPENDENCY_UNAVAILABLE",
    });
  },
);
