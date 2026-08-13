import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test(
  "organization Fly credentials persist through the expanded provider contract",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");
    process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "fly-test-key";
    process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
      "fly-test-key": randomBytes(32).toString("base64"),
    });

    const [{ resetDbRuntimeForTests }, flyConnection] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./fly-connection"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    context.after(async () => {
      Reflect.deleteProperty(process.env, "FLY_API_TOKEN");
      Reflect.deleteProperty(process.env, "KESTREL_FLY_ORGANIZATION_SLUG");
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    const suffix = crypto.randomUUID();
    const organizationId = `org-fly-${suffix}`;
    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'Fly Test Org', ${`fly-test-${suffix}`}, now())
    `;

    process.env.FLY_API_TOKEN = "FlyV1 platform-secret";
    process.env.KESTREL_FLY_ORGANIZATION_SLUG = "platform-org";
    await assert.rejects(
      flyConnection.resolveFlyProviderAuthority(organizationId),
      /connection is not configured/u,
    );

    const configured = await flyConnection.configureFlyProviderConnection({
      organizationId,
      apiToken: "FlyV1 organization-secret",
      organizationSlug: "testorg-588",
      enabled: true,
    });
    assert.deepEqual(configured, {
      id: `organization-fly:${organizationId}`,
      provider: "fly",
      displayName: "Fly.io",
      enabled: true,
      status: "not_configured",
      hasApiToken: true,
      organizationSlug: "testorg-588",
      lastTestedAt: null,
    });

    const [stored] = await sql<
      Array<{ provider: string; apiKey: string | null }>
    >`
      SELECT "provider", "api_key" AS "apiKey"
      FROM "ai_provider_connections"
      WHERE "organization_id" = ${organizationId}
    `;
    assert.equal(stored?.provider, "fly");
    assert.ok(stored?.apiKey);
    assert.notEqual(stored.apiKey, "FlyV1 organization-secret");
    assert.deepEqual(
      await flyConnection.resolveFlyProviderAuthority(organizationId),
      {
        token: "FlyV1 organization-secret",
        organizationSlug: "testorg-588",
      }
    );

    let releaseTest: (() => void) | undefined;
    let markTestStarted: (() => void) | undefined;
    const testStarted = new Promise<void>((resolve) => {
      markTestStarted = resolve;
    });
    const testReleased = new Promise<void>((resolve) => {
      releaseTest = resolve;
    });
    const staleTest = flyConnection.testFlyProviderConnection(organizationId, {
      fetchImpl: (async () => {
        markTestStarted?.();
        await testReleased;
        return Response.json({ apps: [] });
      }) as unknown as typeof fetch,
    });
    await testStarted;
    await flyConnection.configureFlyProviderConnection({
      organizationId,
      apiToken: "FlyV1 replacement-secret",
      organizationSlug: "replacement-fly-org",
      enabled: true,
    });
    releaseTest?.();
    await assert.rejects(staleTest, /changed during testing/u);
    const current = await flyConnection.getFlyProviderConnection(organizationId);
    assert.equal(current?.status, "not_configured");
    assert.deepEqual(current?.metadata, {
      organizationSlug: "replacement-fly-org",
    });
    assert.deepEqual(
      await flyConnection.resolveFlyProviderAuthority(organizationId),
      {
        token: "FlyV1 replacement-secret",
        organizationSlug: "replacement-fly-org",
      }
    );
  }
);
