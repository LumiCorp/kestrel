import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test(
  "default model assignment is atomic and serialized per organization modality",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [{ resetDbRuntimeForTests }, { saveGatewayModel }] =
      await Promise.all([import("@/lib/db/runtime"), import("./gateways")]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const organizationId = `default-model-org-${suffix}`;
    const gatewayId = `default-model-gateway-${suffix}`;
    const modelAId = `default-model-a-${suffix}`;
    const modelBId = `default-model-b-${suffix}`;
    const now = new Date();

    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (${organizationId}, 'Default Model Org', ${`default-model-${suffix}`}, ${now})
      `;
      await transaction`
        INSERT INTO "ai_gateways" (
          "id", "organization_id", "provider", "display_name"
        ) VALUES (
          ${gatewayId}, ${organizationId}, 'openai', 'Default Model Gateway'
        )
      `;
      await transaction`
        INSERT INTO "ai_gateway_models" (
          "id", "organization_id", "gateway_id", "raw_model_id", "modality",
          "approved", "is_default"
        ) VALUES
          (${modelAId}, ${organizationId}, ${gatewayId}, 'model-a', 'language', true, true),
          (${modelBId}, ${organizationId}, ${gatewayId}, 'model-b', 'language', true, false)
      `;
    });

    await assert.rejects(
      saveGatewayModel({
        organizationId,
        id: `missing-${suffix}`,
        gatewayId,
        rawModelId: "missing-model",
        modality: "language",
        approved: true,
        isDefault: true,
      }),
      /Gateway model not found/u
    );
    const [afterStaleWrite] = await sql<
      Array<{ id: string }>
    >`SELECT "id" FROM "ai_gateway_models" WHERE "organization_id" = ${organizationId} AND "is_default" = true`;
    assert.equal(afterStaleWrite?.id, modelAId);

    await Promise.all([
      saveGatewayModel({
        organizationId,
        id: modelAId,
        gatewayId,
        rawModelId: "model-a",
        modality: "language",
        approved: true,
        isDefault: true,
      }),
      saveGatewayModel({
        organizationId,
        id: modelBId,
        gatewayId,
        rawModelId: "model-b",
        modality: "language",
        approved: true,
        isDefault: true,
      }),
    ]);

    const defaults = await sql<Array<{ id: string }>>`
      SELECT "id"
      FROM "ai_gateway_models"
      WHERE "organization_id" = ${organizationId}
        AND "modality" = 'language'
        AND "is_default" = true
    `;
    assert.equal(defaults.length, 1);
    assert.ok([modelAId, modelBId].includes(defaults[0]?.id ?? ""));
  }
);

test(
  "closed model grants retain evidence while live gateway resources are deleted",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    const [
      { resetDbRuntimeForTests },
      { deleteGateway },
      { activateEnvironmentModelGrant },
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./gateways"),
      import("@/lib/environments/execution-route"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const organizationId = `grant-org-${suffix}`;
    const userId = `grant-user-${suffix}`;
    const environmentId = `grant-environment-${suffix}`;
    const workspaceId = `grant-workspace-${suffix}`;
    const threadId = `grant-thread-${suffix}`;
    const executionId = `grant-execution-${suffix}`;
    const gatewayId = `grant-gateway-${suffix}`;
    const modelId = `grant-model-${suffix}`;
    const otherModelId = `grant-other-model-${suffix}`;
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
          ${userId}, 'Grant User', ${`${userId}@example.test`}, true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (${organizationId}, 'Grant Org', ${`grant-org-${suffix}`}, ${now})
      `;
      await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "region", "status", "is_default"
        ) VALUES (
          ${environmentId}, ${organizationId}, ${userId}, 'Grant Environment',
          'grant', 'iad', 'ready', true
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "origin"
        ) VALUES (${threadId}, 'Grant Thread', ${userId}, ${organizationId}, 'web')
      `;
      await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "personal_owner_user_id",
          "created_by_user_id", "name", "kind", "status", "runtime_image"
        ) VALUES (
          ${workspaceId}, ${organizationId}, ${environmentId}, ${userId},
          ${userId}, 'Grant Workspace', 'scratch', 'ready', 'runtime:test'
        )
      `;
      await transaction`
        INSERT INTO "ai_gateways" (
          "id", "organization_id", "environment_id", "provider", "display_name"
        ) VALUES (
          ${gatewayId}, ${organizationId}, ${environmentId}, 'openai', 'Grant Gateway'
        )
      `;
      await transaction`
        INSERT INTO "ai_gateway_models" (
          "id", "organization_id", "gateway_id", "raw_model_id", "modality"
        ) VALUES
          (${modelId}, ${organizationId}, ${gatewayId}, 'grant-model', 'language'),
          (${otherModelId}, ${organizationId}, ${gatewayId}, 'grant-other-model', 'language')
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
      rawModelId: "grant-model",
    });

    await assert.rejects(
      deleteGateway(organizationId, gatewayId),
      /active Environment execution/u
    );
    await sql`
      UPDATE "environment_model_grants"
      SET "status" = 'closed', "closed_at" = now()
      WHERE "run_id" = ${executionId}
    `;
    await assert.rejects(
      activateEnvironmentModelGrant({
        organizationId,
        environmentId,
        workspaceId,
        threadId,
        runId: executionId,
        gatewayId,
        rawModelId: "grant-other-model",
      }),
      /historical model identity is immutable/u,
    );
    await activateEnvironmentModelGrant({
      organizationId,
      environmentId,
      workspaceId,
      threadId,
      runId: executionId,
      gatewayId,
      rawModelId: "grant-model",
    });
    const [reactivated] = await sql<
      Array<{ gatewayModelId: string | null; status: string }>
    >`
      SELECT "gateway_model_id" AS "gatewayModelId", "status"
      FROM "environment_model_grants"
      WHERE "run_id" = ${executionId}
    `;
    assert.deepEqual(reactivated, {
      gatewayModelId: modelId,
      status: "active",
    });
    await sql`
      UPDATE "environment_model_grants"
      SET "status" = 'closed', "closed_at" = now()
      WHERE "run_id" = ${executionId}
    `;
    assert.equal((await deleteGateway(organizationId, gatewayId))?.id, gatewayId);
    const [preserved] = await sql<
      Array<{
        gatewayId: string;
        rawModelId: string;
        gatewayModelId: string | null;
        status: string;
      }>
    >`
      SELECT "gateway_id" AS "gatewayId", "raw_model_id" AS "rawModelId",
        "gateway_model_id" AS "gatewayModelId", "status"
      FROM "environment_model_grants"
      WHERE "run_id" = ${executionId}
    `;
    assert.deepEqual(preserved, {
      gatewayId,
      rawModelId: "grant-model",
      gatewayModelId: null,
      status: "closed",
    });
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    const [remaining] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count" FROM "environment_model_grants"
      WHERE "run_id" = ${executionId}
    `;
    assert.equal(remaining?.count, 0);
  }
);

test(
  "recorded RunPod cleanup connections remain usable after disablement",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    const previousKeyId = process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID;
    const previousKeys = process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS;
    process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test";
    process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
      test: Buffer.alloc(32, 19).toString("base64"),
    });
    const [
      { resetDbRuntimeForTests },
      { encryptGatewayCredential },
      { createRunPodControlPlaneClientByConnectionId },
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./gateway-credential-crypto"),
      import("./managed-runpod-connection"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const organizationId = `runpod-cleanup-org-${suffix}`;
    const connectionId = `runpod-cleanup-connection-${suffix}`;
    const now = new Date();

    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      if (previousKeyId === undefined) {
        Reflect.deleteProperty(process.env, "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID");
      } else {
        process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = previousKeyId;
      }
      if (previousKeys === undefined) {
        Reflect.deleteProperty(process.env, "KESTREL_GATEWAY_CREDENTIAL_KEYS");
      } else {
        process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = previousKeys;
      }
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });
    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'RunPod Cleanup Org', ${`runpod-cleanup-${suffix}`}, ${now})
    `;
    await sql`
      INSERT INTO "ai_provider_connections" (
        "id", "organization_id", "provider", "scope", "display_name",
        "api_key", "enabled", "status"
      ) VALUES (
        ${connectionId}, ${organizationId}, 'runpod', 'organization', 'RunPod',
        ${encryptGatewayCredential({
          gatewayId: connectionId,
          plaintext: "runpod-cleanup-secret",
        })}, false, 'ready'
      )
    `;
    await assert.rejects(
      createRunPodControlPlaneClientByConnectionId({ connectionId }),
      /disabled/u
    );
    let authorization: string | null = null;
    const { client } = await createRunPodControlPlaneClientByConnectionId({
      connectionId,
      allowDisabledForCleanup: true,
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json([]);
      },
    });
    await client.listEndpoints();
    assert.equal(authorization, "Bearer runpod-cleanup-secret");
  }
);
