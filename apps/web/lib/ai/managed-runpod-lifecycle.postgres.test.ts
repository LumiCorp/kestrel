import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test(
  "managed deletion preserves readiness while an active model grant exists",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    const [
      { resetDbRuntimeForTests },
      { activateEnvironmentModelGrant },
      { queueManagedRunPodDeletion },
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("@/lib/environments/execution-route"),
      import("./managed-runpod-store"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const organizationId = `runpod-delete-org-${suffix}`;
    const userId = `runpod-delete-user-${suffix}`;
    const environmentId = `runpod-delete-environment-${suffix}`;
    const workspaceId = `runpod-delete-workspace-${suffix}`;
    const threadId = `runpod-delete-thread-${suffix}`;
    const executionId = `runpod-delete-execution-${suffix}`;
    const profileId = `runpod-delete-profile-${suffix}`;
    const deploymentId = `runpod-delete-deployment-${suffix}`;
    const gatewayId = `runpod-delete-gateway-${suffix}`;
    const modelId = `runpod-delete-model-${suffix}`;
    const now = new Date();

    context.after(async () => {
      await sql`DELETE FROM "environment_model_grants" WHERE "run_id" = ${executionId}`;
      await sql`DELETE FROM "environment_run_executions" WHERE "id" = ${executionId}`;
      await sql`UPDATE "ai_deployments" SET "gateway_id" = NULL WHERE "id" = ${deploymentId}`;
      await sql`DELETE FROM "ai_gateways" WHERE "id" = ${gatewayId}`;
      await sql`DELETE FROM "ai_deployments" WHERE "id" = ${deploymentId}`;
      await sql`DELETE FROM "ai_deployment_profiles" WHERE "id" = ${profileId}`;
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
          ${userId}, 'RunPod Delete User', ${`${userId}@example.test`}, true,
          ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'RunPod Delete Org',
          ${`runpod-delete-${suffix}`}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "region", "status", "is_default"
        ) VALUES (
          ${environmentId}, ${organizationId}, ${userId}, 'RunPod Delete',
          'runpod-delete', 'iad', 'ready', true
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "origin"
        ) VALUES (
          ${threadId}, 'RunPod Delete Thread', ${userId}, ${organizationId}, 'web'
        )
      `;
      await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "personal_owner_user_id",
          "created_by_user_id", "name", "kind", "status", "runtime_image"
        ) VALUES (
          ${workspaceId}, ${organizationId}, ${environmentId}, ${userId},
          ${userId}, 'RunPod Delete Workspace', 'scratch', 'ready', 'runtime:test'
        )
      `;
      await transaction`
        INSERT INTO "ai_deployment_profiles" (
          "id", "organization_id", "profile_key", "version", "display_name",
          "provider", "status", "image_ref", "expected_model_id", "spec_hash",
          "template_spec", "endpoint_spec", "cost_limit_usd_per_hour"
        ) VALUES (
          ${profileId}, ${organizationId}, 'delete-test', 1, 'Delete Test',
          'runpod', 'active', 'example.invalid/runpod:test', 'test-model',
          ${`spec-${suffix}`}, '{}'::jsonb, '{}'::jsonb, 1
        )
      `;
      await transaction`
        INSERT INTO "ai_deployments" (
          "id", "organization_id", "environment_id", "created_by_user_id",
          "profile_id", "display_name", "status", "spec_snapshot"
        ) VALUES (
          ${deploymentId}, ${organizationId}, ${environmentId}, ${userId},
          ${profileId}, 'Delete Test', 'ready', '{}'::jsonb
        )
      `;
      await transaction`
        INSERT INTO "ai_gateways" (
          "id", "organization_id", "environment_id", "deployment_id",
          "provider", "display_name", "enabled"
        ) VALUES (
          ${gatewayId}, ${organizationId}, ${environmentId}, ${deploymentId},
          'runpod', 'Delete Test Gateway', true
        )
      `;
      await transaction`
        UPDATE "ai_deployments" SET "gateway_id" = ${gatewayId}
        WHERE "id" = ${deploymentId}
      `;
      await transaction`
        INSERT INTO "ai_gateway_models" (
          "id", "organization_id", "gateway_id", "raw_model_id", "modality"
        ) VALUES (
          ${modelId}, ${organizationId}, ${gatewayId}, 'test-model', 'language'
        )
      `;
      await transaction`
        INSERT INTO "environment_run_executions" (
          "id", "organization_id", "environment_id", "workspace_id", "thread_id",
          "actor_id", "runtime_image", "effective_capabilities", "status"
        ) VALUES (
          ${executionId}, ${organizationId}, ${environmentId}, ${workspaceId},
          ${threadId}, ${userId}, 'runtime:test', '[]'::jsonb, 'running'
        )
      `;
    });
    await activateEnvironmentModelGrant({
      organizationId,
      environmentId,
      workspaceId,
      threadId,
      runId: executionId,
      gatewayId,
      rawModelId: "test-model",
    });

    await assert.rejects(
      queueManagedRunPodDeletion({ organizationId, deploymentId }),
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "MANAGED_RUNPOD_ACTIVE_MODEL_GRANTS",
    );
    const [preserved] = await sql<
      Array<{ status: string; enabled: boolean; deleteRuns: number }>
    >`
      SELECT deployment."status", gateway."enabled",
        count(run."id")::int AS "deleteRuns"
      FROM "ai_deployments" AS deployment
      JOIN "ai_gateways" AS gateway ON gateway."id" = deployment."gateway_id"
      LEFT JOIN "ai_deployment_runs" AS run
        ON run."deployment_id" = deployment."id" AND run."kind" = 'delete'
      WHERE deployment."id" = ${deploymentId}
      GROUP BY deployment."status", gateway."enabled"
    `;
    assert.deepEqual(preserved, {
      status: "ready",
      enabled: true,
      deleteRuns: 0,
    });
  },
);

test(
  "malformed qualification provenance reaches a terminal failed state",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    const [{ resetDbRuntimeForTests }, { processManagedRunPodRun }] =
      await Promise.all([
        import("@/lib/db/runtime"),
        import("./managed-runpod-runtime"),
      ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const organizationId = `runpod-metadata-org-${suffix}`;
    const profileId = `runpod-metadata-profile-${suffix}`;
    const runId = `runpod-metadata-run-${suffix}`;
    const now = new Date();

    context.after(async () => {
      await sql`DELETE FROM "ai_deployment_runs" WHERE "id" = ${runId}`;
      await sql`DELETE FROM "ai_deployment_profiles" WHERE "id" = ${profileId}`;
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });
    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${organizationId}, 'RunPod Metadata Org',
        ${`runpod-metadata-${suffix}`}, ${now}
      )
    `;
    await sql`
      INSERT INTO "ai_deployment_profiles" (
        "id", "organization_id", "profile_key", "version", "display_name",
        "provider", "status", "image_ref", "expected_model_id", "spec_hash",
        "template_spec", "endpoint_spec", "cost_limit_usd_per_hour"
      ) VALUES (
        ${profileId}, ${organizationId}, 'metadata-test', 1, 'Metadata Test',
        'runpod', 'qualifying', 'example.invalid/runpod:test', 'test-model',
        ${`spec-${suffix}`}, '{}'::jsonb, '{}'::jsonb, 1
      )
    `;
    await sql`
      INSERT INTO "ai_deployment_runs" (
        "id", "kind", "profile_id", "status", "metadata"
      ) VALUES (
        ${runId}, 'qualification', ${profileId}, 'queued',
        '{"providerConnectionId":""}'::jsonb
      )
    `;

    await assert.doesNotReject(processManagedRunPodRun(runId));
    const [settled] = await sql<
      Array<{ runStatus: string; errorCode: string | null; profileStatus: string }>
    >`
      SELECT run."status" AS "runStatus", run."error_code" AS "errorCode",
        profile."status" AS "profileStatus"
      FROM "ai_deployment_runs" AS run
      JOIN "ai_deployment_profiles" AS profile ON profile."id" = run."profile_id"
      WHERE run."id" = ${runId}
    `;
    assert.deepEqual(settled, {
      runStatus: "failed",
      errorCode: "MANAGED_RUNPOD_RUN_METADATA_INVALID",
      profileStatus: "draft",
    });
  },
);
