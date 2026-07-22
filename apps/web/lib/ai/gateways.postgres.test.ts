import assert from "node:assert/strict";
import postgres from "postgres";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

contractTest(
  "web.postgres",
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
