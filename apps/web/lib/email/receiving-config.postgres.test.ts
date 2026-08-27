import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import type {
  ResendReceivingDomain,
  ResendReceivingProvider,
} from "./receiving-provider";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("Organization receiving persists one encrypted inactive connection without changing outbound email", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });
  const [{ resetDbRuntimeForTests }, receiving, outbound] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./receiving-config"),
    import("./organization-config"),
  ]);
  const sql = postgres(databaseUrl, { max: 6 });
  const suffix = crypto.randomUUID();
  const organizationId = `receiving-org-${suffix}`;
  const userId = `receiving-user-${suffix}`;
  const now = new Date();
  const provider = fakeProvider();

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`
    INSERT INTO "user" (
      "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
    ) VALUES (
      ${userId}, 'Receiving User', ${`${userId}@example.test`}, true, ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (${organizationId}, 'Receiving Org', ${`receiving-${suffix}`}, ${now})
  `;
  await outbound.saveOrganizationEmailConfig({
    organizationId,
    actorUserId: userId,
    apiKey: "re_outbound_still_working",
    fromName: "Kestrel One",
    fromEmail: "outbound@example.test",
    enabled: false,
  });
  const [outboundBefore] = await sql<
    Array<{ encryptedApiKey: string; fromEmail: string; enabled: boolean }>
  >`
    SELECT "encrypted_api_key" AS "encryptedApiKey", "from_email" AS "fromEmail", "enabled"
    FROM "organization_email_config" WHERE "organization_id" = ${organizationId}
  `;

  await Promise.all([
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      apiKey: "re_full_access_one",
      receivingDomainId: "domain-one",
      provider,
    }),
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      apiKey: "re_full_access_two",
      receivingDomainId: "domain-two",
      provider,
    }),
  ]);

  const rows = await sql<
    Array<{
      organizationId: string;
      encryptedApiKey: string;
      routeLocator: string;
      providerWebhookId: string | null;
      encryptedSigningSecret: string | null;
      inboundEnabled: boolean;
    }>
  >`
    SELECT
      "organization_id" AS "organizationId",
      "encrypted_api_key" AS "encryptedApiKey",
      "route_locator" AS "routeLocator",
      "provider_webhook_id" AS "providerWebhookId",
      "encrypted_signing_secret" AS "encryptedSigningSecret",
      "inbound_enabled" AS "inboundEnabled"
    FROM "organization_receiving_connections"
    WHERE "organization_id" = ${organizationId}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.inboundEnabled, false);
  assert.equal(rows[0]?.providerWebhookId, null);
  assert.equal(rows[0]?.encryptedSigningSecret, null);
  assert.match(rows[0]?.encryptedApiKey ?? "", /^kgc:v1:/u);
  assert.doesNotMatch(rows[0]?.encryptedApiKey ?? "", /re_full_access/u);
  assert.notEqual(rows[0]?.routeLocator, organizationId);
  assert.ok((rows[0]?.routeLocator.length ?? 0) >= 40);

  const publicProjection = await receiving.getPublicReceivingConnection(
    organizationId,
  );
  assert.equal(publicProjection.readiness, "ready_inactive");
  assert.doesNotMatch(
    JSON.stringify(publicProjection),
    /apiKey|signingSecret|routeLocator|providerWebhookId/u,
  );

  const [outboundAfter] = await sql<
    Array<{ encryptedApiKey: string; fromEmail: string; enabled: boolean }>
  >`
    SELECT "encrypted_api_key" AS "encryptedApiKey", "from_email" AS "fromEmail", "enabled"
    FROM "organization_email_config" WHERE "organization_id" = ${organizationId}
  `;
  assert.deepEqual(outboundAfter, outboundBefore);

  const encryptedSecret = receiving.encryptReceivingSigningSecret({
    organizationId,
    signingSecret: "whsec_never_public",
  });
  assert.match(encryptedSecret, /^kgc:v1:/u);
  assert.equal(
    receiving.decryptReceivingSigningSecret({
      organizationId,
      encryptedSigningSecret: encryptedSecret,
    }),
    "whsec_never_public",
  );
});

function fakeProvider(): ResendReceivingProvider {
  const domain = (id: string): ResendReceivingDomain => ({
    id,
    name: `${id}.example.test`,
    status: "verified",
    receiving: "enabled",
    mxStatus: "verified",
  });
  return {
    async listDomains() {
      return [domain("domain-one"), domain("domain-two")];
    },
    async getDomain(_apiKey, id) {
      return domain(id);
    },
    async createWebhook() {
      throw new Error("Webhook creation is outside Issue 01.");
    },
    async getWebhook() {
      throw new Error("Webhook retrieval is unused by this test.");
    },
    async updateWebhook() {
      throw new Error("Webhook update is unused by this test.");
    },
    async removeWebhook() {
      throw new Error("Webhook removal is unused by this test.");
    },
  };
}
