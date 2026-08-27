import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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

test("domain-only receiving saves cannot roll back a concurrently rotated credential", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
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
  const organizationId = `receiving-rotation-org-${suffix}`;
  const userId = `receiving-rotation-user-${suffix}`;
  const now = new Date();

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
      ${userId}, 'Receiving Rotation User', ${`${userId}@example.test`},
      true, ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (
      ${organizationId}, 'Receiving Rotation Org',
      ${`receiving-rotation-${suffix}`}, ${now}
    )
  `;
  await outbound.saveOrganizationEmailConfig({
    organizationId,
    actorUserId: userId,
    apiKey: "re_outbound_independent_of_receiving_rotation",
    fromName: "Kestrel One",
    fromEmail: "outbound-rotation@example.test",
    enabled: false,
  });
  const [outboundBefore] = await sql<
    Array<{ encryptedApiKey: string; fromEmail: string; enabled: boolean }>
  >`
    SELECT "encrypted_api_key" AS "encryptedApiKey", "from_email" AS "fromEmail", "enabled"
    FROM "organization_email_config" WHERE "organization_id" = ${organizationId}
  `;

  const readReceiving = () =>
    sql<Array<{ encryptedApiKey: string; receivingDomainId: string | null }>>`
      SELECT
        "encrypted_api_key" AS "encryptedApiKey",
        "receiving_domain_id" AS "receivingDomainId"
      FROM "organization_receiving_connections"
      WHERE "organization_id" = ${organizationId}
    `;
  const assertStoredKey = async (expectedApiKey: string) => {
    let observedApiKey: string | undefined;
    await receiving.inspectReceivingDomains({
      organizationId,
      provider: coordinatedProvider({
        async listDomains(apiKey) {
          observedApiKey = apiKey;
          return [];
        },
      }),
    });
    assert.equal(observedApiKey, expectedApiKey);
  };

  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_old_key_rotation_commits_first",
    receivingDomainId: "domain-before-rotation",
    provider: fakeProvider(),
  });
  const [beforeRotation] = await readReceiving();
  assert.ok(beforeRotation);

  const staleValidationStarted = deferred();
  const releaseStaleValidation = deferred();
  const staleDomainSave = receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    receivingDomainId: "domain-from-stale-key",
    provider: coordinatedProvider({
      async getDomain(apiKey, id) {
        staleValidationStarted.resolve();
        assert.equal(apiKey, "re_old_key_rotation_commits_first");
        await releaseStaleValidation.promise;
        return verifiedReceivingDomain(id);
      },
    }),
  });
  await staleValidationStarted.promise;

  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_new_key_rotation_commits_first",
    receivingDomainId: "domain-from-new-key",
    provider: fakeProvider(),
  });
  releaseStaleValidation.resolve();
  await assert.rejects(staleDomainSave, (error: unknown) => {
    assert.ok(error instanceof receiving.ReceivingConfigError);
    assert.equal(error.code, "RESEND_RECEIVING_CREDENTIAL_CHANGED");
    return true;
  });

  const [afterRotationCommitsFirst] = await readReceiving();
  assert.equal(
    afterRotationCommitsFirst?.receivingDomainId,
    "domain-from-new-key",
  );
  assert.notEqual(
    afterRotationCommitsFirst?.encryptedApiKey,
    beforeRotation.encryptedApiKey,
  );
  await assertStoredKey("re_new_key_rotation_commits_first");

  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_old_key_domain_save_commits_first",
    receivingDomainId: "domain-before-domain-save",
    provider: fakeProvider(),
  });
  const rotationValidationStarted = deferred();
  const releaseRotationValidation = deferred();
  const laterRotation = receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_new_key_domain_save_commits_first",
    receivingDomainId: "domain-from-later-rotation",
    provider: coordinatedProvider({
      async getDomain(apiKey, id) {
        rotationValidationStarted.resolve();
        assert.equal(apiKey, "re_new_key_domain_save_commits_first");
        await releaseRotationValidation.promise;
        return verifiedReceivingDomain(id);
      },
    }),
  });
  await rotationValidationStarted.promise;

  const domainOnlyResult = await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    receivingDomainId: "domain-from-current-key",
    provider: coordinatedProvider({
      async getDomain(apiKey, id) {
        assert.equal(apiKey, "re_old_key_domain_save_commits_first");
        return verifiedReceivingDomain(id);
      },
    }),
  });
  assert.equal(
    domainOnlyResult.receivingDomain,
    "domain-from-current-key.example.test",
  );
  const [afterDomainSaveCommitsFirst] = await readReceiving();
  assert.equal(
    afterDomainSaveCommitsFirst?.receivingDomainId,
    "domain-from-current-key",
  );
  await assertStoredKey("re_old_key_domain_save_commits_first");

  releaseRotationValidation.resolve();
  await laterRotation;
  const [afterLaterRotation] = await readReceiving();
  assert.equal(
    afterLaterRotation?.receivingDomainId,
    "domain-from-later-rotation",
  );
  await assertStoredKey("re_new_key_domain_save_commits_first");

  const [outboundAfter] = await sql<
    Array<{ encryptedApiKey: string; fromEmail: string; enabled: boolean }>
  >`
    SELECT "encrypted_api_key" AS "encryptedApiKey", "from_email" AS "fromEmail", "enabled"
    FROM "organization_email_config" WHERE "organization_id" = ${organizationId}
  `;
  assert.deepEqual(outboundAfter, outboundBefore);
});

test("Desktop receiving routes preserve authentication and Organization Admin failures", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  const [{ resetDbRuntimeForTests }, receivingRoute, domainsRoute] =
    await Promise.all([
      import("@/lib/db/runtime"),
      import("@/app/api/desktop/v1/organizations/[organizationId]/email/receiving/route"),
      import("@/app/api/desktop/v1/organizations/[organizationId]/email/receiving/domains/route"),
    ]);
  const sql = postgres(databaseUrl, { max: 2 });
  const suffix = crypto.randomUUID();
  const targetOrganizationId = `receiving-auth-target-${suffix}`;
  const ownedOrganizationId = `receiving-auth-owned-${suffix}`;
  const memberUserId = `receiving-auth-member-${suffix}`;
  const otherAdminUserId = `receiving-auth-admin-${suffix}`;
  const now = new Date();
  const expired = desktopAccessCredential({
    userId: otherAdminUserId,
    expiresAt: new Date(now.getTime() - 60_000),
  });
  const revoked = desktopAccessCredential({
    userId: otherAdminUserId,
    expiresAt: new Date(now.getTime() + 60_000),
    revokedAt: now,
  });
  const member = desktopAccessCredential({
    userId: memberUserId,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const crossOrganizationAdmin = desktopAccessCredential({
    userId: otherAdminUserId,
    expiresAt: new Date(now.getTime() + 60_000),
  });

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" IN (${targetOrganizationId}, ${ownedOrganizationId})`;
    await sql`DELETE FROM "user" WHERE "id" IN (${memberUserId}, ${otherAdminUserId})`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES
          (
            ${memberUserId}, 'Receiving Member',
            ${`${memberUserId}@example.test`}, true, ${now}, ${now}
          ),
          (
            ${otherAdminUserId}, 'Other Organization Admin',
            ${`${otherAdminUserId}@example.test`}, true, ${now}, ${now}
          )
      `;
    await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES
          (
            ${targetOrganizationId}, 'Receiving Auth Target',
            ${`receiving-auth-target-${suffix}`}, ${now}
          ),
          (
            ${ownedOrganizationId}, 'Receiving Auth Owned',
            ${`receiving-auth-owned-${suffix}`}, ${now}
          )
      `;
    await transaction`
        INSERT INTO "member" (
          "id", "organizationId", "userId", "role", "createdAt"
        ) VALUES
          (
            ${crypto.randomUUID()}, ${targetOrganizationId}, ${memberUserId},
            'member', ${now}
          ),
          (
            ${crypto.randomUUID()}, ${ownedOrganizationId}, ${otherAdminUserId},
            'owner', ${now}
          )
      `;
    for (const credential of [
      expired,
      revoked,
      member,
      crossOrganizationAdmin,
    ]) {
      await transaction`
          INSERT INTO "desktop_user_credentials" (
            "id", "user_id", "family_id", "kind", "secret_hash",
            "expires_at", "revoked_at", "created_at"
          ) VALUES (
            ${credential.id}, ${credential.userId}, ${crypto.randomUUID()},
            'access', ${credential.secretHash}, ${credential.expiresAt},
            ${credential.revokedAt}, ${now}
          )
        `;
    }
  });

  const contextFor = (organizationId: string) => ({
    params: Promise.resolve({ organizationId }),
  });
  const receivingUrl = `http://localhost/api/desktop/v1/organizations/${targetOrganizationId}/email/receiving`;
  const domainsUrl = `${receivingUrl}/domains`;
  const unauthorized = { code: "UNAUTHORIZED", error: "Unauthorized" };

  const missingResponse = await receivingRoute.GET(
    new Request(receivingUrl),
    contextFor(targetOrganizationId),
  );
  assert.equal(missingResponse.status, 401);
  assert.deepEqual(await missingResponse.json(), unauthorized);

  const malformedResponse = await domainsRoute.POST(
    new Request(domainsUrl, {
      method: "POST",
      headers: { authorization: "Bearer malformed" },
    }),
    contextFor(targetOrganizationId),
  );
  assert.equal(malformedResponse.status, 401);
  assert.deepEqual(await malformedResponse.json(), unauthorized);

  const expiredResponse = await receivingRoute.PUT(
    desktopRequest(receivingUrl, "PUT", expired.value),
    contextFor(targetOrganizationId),
  );
  assert.equal(expiredResponse.status, 401);
  assert.deepEqual(await expiredResponse.json(), unauthorized);

  const revokedResponse = await domainsRoute.POST(
    desktopRequest(domainsUrl, "POST", revoked.value),
    contextFor(targetOrganizationId),
  );
  assert.equal(revokedResponse.status, 401);
  assert.deepEqual(await revokedResponse.json(), unauthorized);

  for (const credential of [member, crossOrganizationAdmin]) {
    const response = await receivingRoute.GET(
      desktopRequest(receivingUrl, "GET", credential.value),
      contextFor(targetOrganizationId),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      code: "FORBIDDEN",
      error: "Forbidden",
    });
  }
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

type CoordinatedProviderOverrides = {
  listDomains?: (apiKey: string) => Promise<ResendReceivingDomain[]>;
  getDomain?: (apiKey: string, id: string) => Promise<ResendReceivingDomain>;
};

function coordinatedProvider(
  overrides: CoordinatedProviderOverrides,
): ResendReceivingProvider {
  return {
    async listDomains(apiKey) {
      return overrides.listDomains
        ? overrides.listDomains(apiKey)
        : [verifiedReceivingDomain("domain-one")];
    },
    async getDomain(apiKey, id) {
      return overrides.getDomain
        ? overrides.getDomain(apiKey, id)
        : verifiedReceivingDomain(id);
    },
    async createWebhook() {
      throw new Error("Webhook creation is outside the receiving save test.");
    },
    async getWebhook() {
      throw new Error("Webhook retrieval is outside the receiving save test.");
    },
    async updateWebhook() {
      throw new Error("Webhook update is outside the receiving save test.");
    },
    async removeWebhook() {
      throw new Error("Webhook removal is outside the receiving save test.");
    },
  };
}

function verifiedReceivingDomain(id: string): ResendReceivingDomain {
  return {
    id,
    name: `${id}.example.test`,
    status: "verified",
    receiving: "enabled",
    mxStatus: "verified",
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function desktopAccessCredential(input: {
  userId: string;
  expiresAt: Date;
  revokedAt?: Date;
}) {
  const id = crypto.randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return {
    id,
    userId: input.userId,
    secretHash: createHash("sha256").update(secret).digest("hex"),
    expiresAt: input.expiresAt,
    revokedAt: input.revokedAt ?? null,
    value: `${id}.${secret}`,
  };
}

function desktopRequest(url: string, method: string, credential: string) {
  return new Request(url, {
    method,
    headers: { authorization: `Bearer ${credential}` },
  });
}
