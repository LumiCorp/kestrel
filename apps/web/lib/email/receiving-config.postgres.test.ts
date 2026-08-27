import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import {
  ResendHttpReceivingProvider,
  ResendReceivingProviderError,
} from "./receiving-provider";
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

  const saveOutcomes = await Promise.allSettled([
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
  assert.ok(
    saveOutcomes.some((outcome) => outcome.status === "fulfilled"),
  );
  for (const outcome of saveOutcomes) {
    if (outcome.status !== "rejected") continue;
    assert.ok(outcome.reason instanceof receiving.ReceivingConfigError);
    assert.equal(outcome.reason.code, "RESEND_RECEIVING_SAVE_SUPERSEDED");
  }

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

test("stored receiving checks persist failure and recovery without poisoning the authoritative key", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });
  const [{ resetDbRuntimeForTests }, receiving] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./receiving-config"),
  ]);
  const sql = postgres(databaseUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const organizationId = `receiving-health-org-${suffix}`;
  const userId = `receiving-health-user-${suffix}`;
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
      ${userId}, 'Receiving Health User', ${`${userId}@example.test`},
      true, ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (
      ${organizationId}, 'Receiving Health Org',
      ${`receiving-health-${suffix}`}, ${now}
    )
  `;

  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_authoritative_stored_key",
    receivingDomainId: "domain-health",
    provider: fakeProvider(),
  });
  const readStored = () =>
    sql<
      Array<{
        encryptedApiKey: string;
        credentialStatus: string;
        credentialValidatedAt: Date | null;
        lastHealthCheckedAt: Date | null;
        lastErrorCode: string | null;
      }>
    >`
      SELECT
        "encrypted_api_key" AS "encryptedApiKey",
        "credential_status" AS "credentialStatus",
        "credential_validated_at" AS "credentialValidatedAt",
        "last_health_checked_at" AS "lastHealthCheckedAt",
        "last_error_code" AS "lastErrorCode"
      FROM "organization_receiving_connections"
      WHERE "organization_id" = ${organizationId}
    `;
  const [saved] = await readStored();
  assert.ok(saved);

  const initiallyHealthy =
    await receiving.getPublicReceivingConnection(organizationId);
  await assert.rejects(
    receiving.inspectReceivingDomains({
      organizationId,
      provider: new ResendHttpReceivingProvider({
        baseUrl: "https://resend.test",
        fetchImpl: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/domains") {
            return Response.json({
              object: "list",
              has_more: false,
              data: [
                {
                  id: "domain-health",
                  name: "domain-health.example.test",
                  status: "verified",
                  capabilities: {
                    sending: "enabled",
                    receiving: "enabled",
                  },
                },
              ],
            });
          }
          return Response.json({
            id: "domain-other",
            name: "domain-other.example.test",
            status: "failed",
            capabilities: { sending: "enabled", receiving: "enabled" },
            records: [{ record: "Receiving MX", type: "MX", status: "failed" }],
          });
        },
      }),
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_RESPONSE_INVALID",
  );
  const afterContradictoryHydration =
    await receiving.getPublicReceivingConnection(organizationId);
  assert.equal(afterContradictoryHydration.credentialStatus, "error");
  assert.equal(
    afterContradictoryHydration.lastErrorCode,
    "RESEND_RECEIVING_RESPONSE_INVALID",
  );
  assert.equal(afterContradictoryHydration.receivingDomainStatus, "verified");
  assert.equal(afterContradictoryHydration.mxStatus, "verified");
  assert.equal(
    afterContradictoryHydration.domainCheckedAt,
    initiallyHealthy.domainCheckedAt,
  );

  await assert.rejects(
    receiving.inspectReceivingDomains({
      organizationId,
      provider: new ResendHttpReceivingProvider({
        baseUrl: "https://resend.test",
        fetchImpl: async () =>
          Response.json({ object: "list", has_more: true, data: [] }),
      }),
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_RESPONSE_INVALID",
  );
  const afterIncompleteList =
    await receiving.getPublicReceivingConnection(organizationId);
  assert.equal(afterIncompleteList.credentialStatus, "error");
  assert.equal(
    afterIncompleteList.lastErrorCode,
    "RESEND_RECEIVING_RESPONSE_INVALID",
  );
  assert.equal(afterIncompleteList.receivingDomainStatus, "verified");
  assert.equal(afterIncompleteList.mxStatus, "verified");
  assert.equal(
    afterIncompleteList.domainCheckedAt,
    initiallyHealthy.domainCheckedAt,
  );

  assert.deepEqual(
    await receiving.inspectReceivingDomains({
      organizationId,
      provider: new ResendHttpReceivingProvider({
        baseUrl: "https://resend.test",
        fetchImpl: async () =>
          Response.json({ object: "list", has_more: false, data: [] }),
      }),
    }),
    [],
  );
  const afterCompleteEmptyList =
    await receiving.getPublicReceivingConnection(organizationId);
  assert.equal(afterCompleteEmptyList.credentialStatus, "full_access");
  assert.equal(afterCompleteEmptyList.lastErrorCode, null);
  assert.equal(afterCompleteEmptyList.receivingDomainStatus, "failed");
  assert.equal(afterCompleteEmptyList.mxStatus, "unknown");
  assert.equal(afterCompleteEmptyList.readiness, "domain_unready");

  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-health"),
  });

  await assert.rejects(
    receiving.inspectReceivingDomains({
      organizationId,
      provider: failingListProvider(
        "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
        "Resend receiving requires a Full access API key.",
      ),
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
  );
  const insufficient = await receiving.getPublicReceivingConnection(
    organizationId,
  );
  assert.equal(insufficient.credentialStatus, "insufficient");
  assert.equal(insufficient.readiness, "credential_insufficient");
  assert.equal(
    insufficient.lastErrorCode,
    "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
  );
  assert.ok(insufficient.lastHealthCheckedAt);

  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-health"),
  });
  const recoveredFromRevocation =
    await receiving.getPublicReceivingConnection(organizationId);
  assert.equal(recoveredFromRevocation.credentialStatus, "full_access");
  assert.equal(recoveredFromRevocation.readiness, "ready_inactive");
  assert.equal(recoveredFromRevocation.lastErrorCode, null);
  assert.ok(recoveredFromRevocation.credentialValidatedAt);

  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      receivingDomainId: "domain-health",
      provider: new ResendHttpReceivingProvider({
        baseUrl: "https://resend.test",
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_DOMAIN_INVALID",
  );
  const removedConfiguredDomain =
    await receiving.getPublicReceivingConnection(organizationId);
  assert.equal(removedConfiguredDomain.credentialStatus, "full_access");
  assert.equal(
    removedConfiguredDomain.receivingDomain,
    "domain-health.example.test",
  );
  assert.equal(removedConfiguredDomain.receivingDomainStatus, "failed");
  assert.equal(removedConfiguredDomain.mxStatus, "unknown");
  assert.equal(removedConfiguredDomain.readiness, "domain_unready");
  assert.equal(
    removedConfiguredDomain.lastErrorCode,
    "RESEND_RECEIVING_DOMAIN_INVALID",
  );
  assert.ok(removedConfiguredDomain.credentialValidatedAt);
  assert.ok(removedConfiguredDomain.domainCheckedAt);
  assert.ok(removedConfiguredDomain.lastHealthCheckedAt);
  assert.equal(
    removedConfiguredDomain.domainCheckedAt,
    removedConfiguredDomain.lastHealthCheckedAt,
  );
  assert.equal(
    removedConfiguredDomain.credentialValidatedAt,
    removedConfiguredDomain.lastHealthCheckedAt,
  );

  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-health"),
  });
  const recoveredFromRemovedDomain =
    await receiving.getPublicReceivingConnection(organizationId);
  assert.equal(recoveredFromRemovedDomain.credentialStatus, "full_access");
  assert.equal(recoveredFromRemovedDomain.receivingDomainStatus, "verified");
  assert.equal(recoveredFromRemovedDomain.mxStatus, "verified");
  assert.equal(recoveredFromRemovedDomain.readiness, "ready_inactive");
  assert.equal(recoveredFromRemovedDomain.lastErrorCode, null);

  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      receivingDomainId: "domain-candidate-missing",
      provider: new ResendHttpReceivingProvider({
        baseUrl: "https://resend.test",
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_DOMAIN_INVALID",
  );
  assert.deepEqual(
    await receiving.getPublicReceivingConnection(organizationId),
    recoveredFromRemovedDomain,
  );

  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      apiKey: "re_failed_candidate_replacement",
      receivingDomainId: "domain-health",
      provider: new ResendHttpReceivingProvider({
        baseUrl: "https://resend.test",
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_DOMAIN_INVALID",
  );
  assert.deepEqual(
    await receiving.getPublicReceivingConnection(organizationId),
    recoveredFromRemovedDomain,
  );

  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      receivingDomainId: "domain-health",
      provider: coordinatedProvider({
        async getDomain(_apiKey, id) {
          return {
            ...verifiedReceivingDomain(id),
            status: "failed",
            mxStatus: "failed",
          };
        },
      }),
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_DOMAIN_NOT_READY",
  );
  const domainFailure = await receiving.getPublicReceivingConnection(
    organizationId,
  );
  assert.equal(domainFailure.credentialStatus, "full_access");
  assert.equal(domainFailure.receivingDomainStatus, "failed");
  assert.equal(domainFailure.mxStatus, "failed");
  assert.equal(domainFailure.readiness, "domain_unready");

  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-health"),
  });

  await assert.rejects(
    receiving.inspectReceivingDomains({
      organizationId,
      provider: failingListProvider(
        "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
        "Resend receiving is temporarily unavailable.",
      ),
    }),
  );
  const unavailable = await receiving.getPublicReceivingConnection(
    organizationId,
  );
  assert.equal(unavailable.credentialStatus, "error");
  assert.equal(unavailable.readiness, "error");
  assert.equal(
    unavailable.lastErrorCode,
    "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
  );

  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-health"),
  });
  const recovered = await receiving.getPublicReceivingConnection(
    organizationId,
  );
  assert.equal(recovered.credentialStatus, "full_access");
  assert.equal(recovered.readiness, "ready_inactive");
  assert.equal(recovered.lastErrorCode, null);

  await assert.rejects(
    receiving.inspectReceivingDomains({
      organizationId,
      apiKey: "re_failed_candidate_replacement",
      provider: failingListProvider(
        "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
        "Resend receiving requires a Full access API key.",
      ),
    }),
  );
  const [afterCandidateFailure] = await readStored();
  assert.equal(afterCandidateFailure?.encryptedApiKey, saved.encryptedApiKey);
  assert.equal(afterCandidateFailure?.credentialStatus, "full_access");
  assert.equal(afterCandidateFailure?.lastErrorCode, null);
  assert.equal(
    afterCandidateFailure?.credentialValidatedAt?.toISOString(),
    recovered.credentialValidatedAt,
  );
  assert.equal(
    afterCandidateFailure?.lastHealthCheckedAt?.toISOString(),
    recovered.lastHealthCheckedAt,
  );

  const staleCheckStarted = deferred();
  const releaseStaleCheck = deferred();
  const staleStoredCheck = receiving.inspectReceivingDomains({
    organizationId,
    provider: coordinatedProvider({
      async listDomains(apiKey) {
        assert.equal(apiKey, "re_authoritative_stored_key");
        staleCheckStarted.resolve();
        await releaseStaleCheck.promise;
        throw new ResendReceivingProviderError(
          "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
          "Resend receiving requires a Full access API key.",
        );
      },
    }),
  });
  await staleCheckStarted.promise;
  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_rotated_authoritative_key",
    receivingDomainId: "domain-after-health-rotation",
    provider: fakeProvider(),
  });
  releaseStaleCheck.resolve();
  await assert.rejects(staleStoredCheck, (error: unknown) => {
    assert.ok(error instanceof receiving.ReceivingConfigError);
    assert.equal(error.code, "RESEND_RECEIVING_CREDENTIAL_CHANGED");
    return true;
  });
  const [afterStaleCheck] = await readStored();
  assert.notEqual(afterStaleCheck?.encryptedApiKey, saved.encryptedApiKey);
  assert.equal(afterStaleCheck?.credentialStatus, "full_access");
  assert.equal(afterStaleCheck?.lastErrorCode, null);
});

test("same-key stored receiving checks persist in invocation order across inverted provider completion", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });
  const [{ resetDbRuntimeForTests }, receiving] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./receiving-config"),
  ]);
  const sql = postgres(databaseUrl, { max: 6 });
  const suffix = crypto.randomUUID();
  const organizationId = `receiving-order-org-${suffix}`;
  const userId = `receiving-order-user-${suffix}`;
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
      ${userId}, 'Receiving Order User', ${`${userId}@example.test`},
      true, ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (
      ${organizationId}, 'Receiving Order Org',
      ${`receiving-order-${suffix}`}, ${now}
    )
  `;
  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_ordered_stored_key",
    receivingDomainId: "domain-order",
    provider: fakeProvider(),
  });

  const readAuthority = () =>
    sql<
      Array<{
        encryptedApiKey: string;
        healthCheckSequence: number;
        credentialStatus: string;
        receivingDomainStatus: string;
        mxStatus: string;
        lastHealthCheckedAt: Date | null;
        lastErrorCode: string | null;
      }>
    >`
      SELECT
        "encrypted_api_key" AS "encryptedApiKey",
        "health_check_sequence" AS "healthCheckSequence",
        "credential_status" AS "credentialStatus",
        "receiving_domain_status" AS "receivingDomainStatus",
        "mx_status" AS "mxStatus",
        "last_health_checked_at" AS "lastHealthCheckedAt",
        "last_error_code" AS "lastErrorCode"
      FROM "organization_receiving_connections"
      WHERE "organization_id" = ${organizationId}
    `;
  const [initial] = await readAuthority();
  assert.ok(initial);

  const lateFailureStarted = deferred();
  const releaseLateFailure = deferred();
  const lateFailure = receiving.inspectReceivingDomains({
    organizationId,
    provider: coordinatedProvider({
      async listDomains(apiKey) {
        assert.equal(apiKey, "re_ordered_stored_key");
        lateFailureStarted.resolve();
        await releaseLateFailure.promise;
        throw new ResendReceivingProviderError(
          "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
          "Resend receiving requires a Full access API key.",
        );
      },
    }),
  });
  await lateFailureStarted.promise;
  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-order"),
  });
  const [afterNewerRecovery] = await readAuthority();
  assert.ok(afterNewerRecovery);
  assert.equal(afterNewerRecovery.credentialStatus, "full_access");
  assert.equal(afterNewerRecovery.receivingDomainStatus, "verified");
  assert.equal(afterNewerRecovery.lastErrorCode, null);

  releaseLateFailure.resolve();
  await assert.rejects(lateFailure, (error: unknown) => {
    assert.ok(error instanceof receiving.ReceivingConfigError);
    assert.equal(error.code, "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT");
    return true;
  });
  const [afterLateFailure] = await readAuthority();
  assert.deepEqual(afterLateFailure, afterNewerRecovery);

  const lateEmptyStarted = deferred();
  const releaseLateEmpty = deferred();
  const lateEmpty = receiving.inspectReceivingDomains({
    organizationId,
    provider: coordinatedProvider({
      async listDomains(apiKey) {
        assert.equal(apiKey, "re_ordered_stored_key");
        lateEmptyStarted.resolve();
        await releaseLateEmpty.promise;
        return [];
      },
    }),
  });
  await lateEmptyStarted.promise;
  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-order"),
  });
  const [afterRecoveryNewerThanEmpty] = await readAuthority();
  assert.ok(afterRecoveryNewerThanEmpty);
  assert.equal(afterRecoveryNewerThanEmpty.receivingDomainStatus, "verified");
  assert.equal(afterRecoveryNewerThanEmpty.mxStatus, "verified");

  releaseLateEmpty.resolve();
  assert.deepEqual(await lateEmpty, []);
  const [afterLateEmpty] = await readAuthority();
  assert.deepEqual(afterLateEmpty, afterRecoveryNewerThanEmpty);

  const lateSuccessStarted = deferred();
  const releaseLateSuccess = deferred();
  const lateSuccess = receiving.inspectReceivingDomains({
    organizationId,
    provider: coordinatedProvider({
      async listDomains(apiKey) {
        assert.equal(apiKey, "re_ordered_stored_key");
        lateSuccessStarted.resolve();
        await releaseLateSuccess.promise;
        return [verifiedReceivingDomain("domain-order")];
      },
    }),
  });
  await lateSuccessStarted.promise;
  await assert.rejects(
    receiving.inspectReceivingDomains({
      organizationId,
      provider: failingListProvider(
        "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
        "Resend receiving requires a Full access API key.",
      ),
    }),
  );
  const [afterNewerFailure] = await readAuthority();
  assert.ok(afterNewerFailure);
  assert.equal(afterNewerFailure.credentialStatus, "insufficient");
  assert.equal(
    afterNewerFailure.lastErrorCode,
    "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
  );

  releaseLateSuccess.resolve();
  assert.equal((await lateSuccess)[0]?.id, "domain-order");
  const [afterLateSuccess] = await readAuthority();
  assert.deepEqual(afterLateSuccess, afterNewerFailure);
  assert.equal(afterNewerFailure.encryptedApiKey, initial.encryptedApiKey);
  assert.ok(
    afterNewerFailure.healthCheckSequence > initial.healthCheckSequence,
  );
});

test("every stored-key receiving save outcome rejects when a newer same-key check supersedes it", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });
  const [{ resetDbRuntimeForTests }, receiving] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./receiving-config"),
  ]);
  const sql = postgres(databaseUrl, { max: 6 });
  const suffix = crypto.randomUUID();
  const organizationId = `receiving-save-order-org-${suffix}`;
  const userId = `receiving-save-order-user-${suffix}`;
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
      ${userId}, 'Receiving Save Order User',
      ${`${userId}@example.test`}, true, ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (
      ${organizationId}, 'Receiving Save Order Org',
      ${`receiving-save-order-${suffix}`}, ${now}
    )
  `;
  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_save_order_stored_key",
    receivingDomainId: "domain-original",
    provider: fakeProvider(),
  });

  const readPersisted = () =>
    sql<
      Array<{
        receivingDomainId: string | null;
        receivingDomain: string | null;
        receivingDomainStatus: string;
        mxStatus: string;
        domainCheckedAt: Date | null;
        credentialStatus: string;
        healthCheckSequence: string;
        lastHealthCheckedAt: Date | null;
        lastErrorCode: string | null;
      }>
    >`
      SELECT
        "receiving_domain_id" AS "receivingDomainId",
        "receiving_domain" AS "receivingDomain",
        "receiving_domain_status" AS "receivingDomainStatus",
        "mx_status" AS "mxStatus",
        "domain_checked_at" AS "domainCheckedAt",
        "credential_status" AS "credentialStatus",
        "health_check_sequence" AS "healthCheckSequence",
        "last_health_checked_at" AS "lastHealthCheckedAt",
        "last_error_code" AS "lastErrorCode"
      FROM "organization_receiving_connections"
      WHERE "organization_id" = ${organizationId}
    `;

  const staleSaveStarted = deferred();
  const releaseStaleSave = deferred();
  const staleSave = receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    receivingDomainId: "domain-superseded",
    provider: coordinatedProvider({
      async getDomain(apiKey, id) {
        assert.equal(apiKey, "re_save_order_stored_key");
        assert.equal(id, "domain-superseded");
        staleSaveStarted.resolve();
        await releaseStaleSave.promise;
        return verifiedReceivingDomain(id);
      },
    }),
  });

  await staleSaveStarted.promise;
  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-original"),
  });
  releaseStaleSave.resolve();

  await assert.rejects(staleSave, (error: unknown) => {
    assert.ok(error instanceof receiving.ReceivingConfigError);
    assert.equal(error.code, "RESEND_RECEIVING_SAVE_SUPERSEDED");
    return true;
  });

  const [persisted] = await readPersisted();
  assert.ok(persisted);
  assert.equal(persisted.receivingDomainId, "domain-original");
  assert.equal(persisted.receivingDomain, "domain-original.example.test");
  assert.equal(persisted.credentialStatus, "full_access");
  assert.equal(persisted.lastErrorCode, null);
  assert.equal(persisted.healthCheckSequence, "2");

  const staleFailureStarted = deferred();
  const releaseStaleFailure = deferred();
  const staleFailure = receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    receivingDomainId: "domain-failed-provider",
    provider: coordinatedProvider({
      async getDomain(apiKey, id) {
        assert.equal(apiKey, "re_save_order_stored_key");
        assert.equal(id, "domain-failed-provider");
        staleFailureStarted.resolve();
        await releaseStaleFailure.promise;
        throw new ResendReceivingProviderError(
          "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
          "Resend receiving is temporarily unavailable.",
        );
      },
    }),
  });
  await staleFailureStarted.promise;
  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-original"),
  });
  const [afterNewerCheck] = await readPersisted();
  assert.ok(afterNewerCheck);

  releaseStaleFailure.resolve();
  await assert.rejects(staleFailure, (error: unknown) => {
    assert.ok(error instanceof receiving.ReceivingConfigError);
    assert.equal(error.code, "RESEND_RECEIVING_SAVE_SUPERSEDED");
    return true;
  });
  assert.deepEqual((await readPersisted())[0], afterNewerCheck);

  const staleUnreadyStarted = deferred();
  const releaseStaleUnready = deferred();
  const staleUnready = receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    receivingDomainId: "domain-original",
    provider: coordinatedProvider({
      async getDomain(apiKey, id) {
        assert.equal(apiKey, "re_save_order_stored_key");
        assert.equal(id, "domain-original");
        staleUnreadyStarted.resolve();
        await releaseStaleUnready.promise;
        return {
          ...verifiedReceivingDomain(id),
          status: "failed",
          mxStatus: "failed",
        };
      },
    }),
  });
  await staleUnreadyStarted.promise;
  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-original"),
  });
  const [afterNewerUnreadyCheck] = await readPersisted();
  assert.ok(afterNewerUnreadyCheck);

  releaseStaleUnready.resolve();
  await assert.rejects(staleUnready, (error: unknown) => {
    assert.ok(error instanceof receiving.ReceivingConfigError);
    assert.equal(error.code, "RESEND_RECEIVING_SAVE_SUPERSEDED");
    return true;
  });
  assert.deepEqual((await readPersisted())[0], afterNewerUnreadyCheck);

  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      receivingDomainId: "domain-ordinary-provider-failure",
      provider: coordinatedProvider({
        async getDomain() {
          throw new ResendReceivingProviderError(
            "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
            "Resend receiving is temporarily unavailable.",
          );
        },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof receiving.ReceivingConfigError);
      assert.equal(error.code, "RESEND_RECEIVING_PROVIDER_UNAVAILABLE");
      return true;
    },
  );

  await receiving.inspectReceivingDomains({
    organizationId,
    provider: healthyListProvider("domain-original"),
  });
  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      receivingDomainId: "domain-original",
      provider: coordinatedProvider({
        async getDomain(_apiKey, id) {
          return {
            ...verifiedReceivingDomain(id),
            status: "failed",
            mxStatus: "failed",
          };
        },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof receiving.ReceivingConfigError);
      assert.equal(error.code, "RESEND_RECEIVING_DOMAIN_NOT_READY");
      return true;
    },
  );

  const staleRotatedFailureStarted = deferred();
  const releaseStaleRotatedFailure = deferred();
  const staleRotatedFailure = receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    receivingDomainId: "domain-before-rotation",
    provider: coordinatedProvider({
      async getDomain(apiKey) {
        assert.equal(apiKey, "re_save_order_stored_key");
        staleRotatedFailureStarted.resolve();
        await releaseStaleRotatedFailure.promise;
        throw new ResendReceivingProviderError(
          "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
          "Resend receiving is temporarily unavailable.",
        );
      },
    }),
  });
  await staleRotatedFailureStarted.promise;
  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_save_order_rotated_key",
    receivingDomainId: "domain-after-rotation",
    provider: fakeProvider(),
  });

  releaseStaleRotatedFailure.resolve();
  await assert.rejects(staleRotatedFailure, (error: unknown) => {
    assert.ok(error instanceof receiving.ReceivingConfigError);
    assert.equal(error.code, "RESEND_RECEIVING_CREDENTIAL_CHANGED");
    return true;
  });
  const [afterRotation] = await readPersisted();
  assert.ok(afterRotation);
  assert.equal(afterRotation.receivingDomainId, "domain-after-rotation");
  assert.equal(afterRotation.credentialStatus, "full_access");
  assert.equal(afterRotation.lastErrorCode, null);
});

test("Desktop receiving GET permits only members while inspection and mutation remain Admin-only", async (context) => {
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

  const memberReadResponse = await receivingRoute.GET(
    desktopRequest(receivingUrl, "GET", member.value),
    contextFor(targetOrganizationId),
  );
  assert.equal(memberReadResponse.status, 200);
  assert.equal(memberReadResponse.headers.get("cache-control"), "no-store");
  const memberRead = await memberReadResponse.json();
  assert.deepEqual(Object.keys(memberRead.connection).sort(), [
    "configured",
    "credentialStatus",
    "credentialValidatedAt",
    "domainCheckedAt",
    "inboundEnabled",
    "lastErrorCode",
    "lastHealthCheckedAt",
    "lastTestedAt",
    "mxStatus",
    "provider",
    "readiness",
    "receivingDomain",
    "receivingDomainStatus",
    "webhookStatus",
  ]);

  const crossOrganizationReadResponse = await receivingRoute.GET(
    desktopRequest(receivingUrl, "GET", crossOrganizationAdmin.value),
    contextFor(targetOrganizationId),
  );
  assert.equal(crossOrganizationReadResponse.status, 403);
  assert.deepEqual(await crossOrganizationReadResponse.json(), {
    code: "FORBIDDEN",
    error: "Forbidden",
  });

  const memberMutationResponse = await receivingRoute.PUT(
    desktopRequest(receivingUrl, "PUT", member.value),
    contextFor(targetOrganizationId),
  );
  assert.equal(memberMutationResponse.status, 403);
  assert.deepEqual(await memberMutationResponse.json(), {
    code: "FORBIDDEN",
    error: "Forbidden",
  });

  const memberInspectionResponse = await domainsRoute.POST(
    desktopRequest(domainsUrl, "POST", member.value),
    contextFor(targetOrganizationId),
  );
  assert.equal(memberInspectionResponse.status, 403);
  assert.deepEqual(await memberInspectionResponse.json(), {
    code: "FORBIDDEN",
    error: "Forbidden",
  });
});

test("configured receiving mutation exports authorize before parsing malformed JSON", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  const [
    { resetDbRuntimeForTests },
    oneReceivingRoute,
    oneDomainsRoute,
    desktopReceivingRoute,
    desktopDomainsRoute,
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("@/app/api/organization/email/receiving/route"),
    import("@/app/api/organization/email/receiving/domains/route"),
    import("@/app/api/desktop/v1/organizations/[organizationId]/email/receiving/route"),
    import("@/app/api/desktop/v1/organizations/[organizationId]/email/receiving/domains/route"),
  ]);
  const sql = postgres(databaseUrl, { max: 2 });
  const suffix = crypto.randomUUID();
  const organizationId = `receiving-route-auth-${suffix}`;
  const environmentId = `receiving-route-environment-${suffix}`;
  const adminUserId = `receiving-route-admin-${suffix}`;
  const memberUserId = `receiving-route-member-${suffix}`;
  const adminSessionToken = `receiving-route-admin-session-${suffix}`;
  const memberSessionToken = `receiving-route-member-session-${suffix}`;
  const now = new Date();
  const adminCredential = desktopAccessCredential({
    userId: adminUserId,
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  });
  const memberCredential = desktopAccessCredential({
    userId: memberUserId,
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  });

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" IN (${adminUserId}, ${memberUserId})`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES
        (
          ${adminUserId}, 'Receiving Route Admin',
          ${`${adminUserId}@example.test`}, true, ${now}, ${now}
        ),
        (
          ${memberUserId}, 'Receiving Route Member',
          ${`${memberUserId}@example.test`}, true, ${now}, ${now}
        )
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${organizationId}, 'Receiving Route Auth',
        ${`receiving-route-auth-${suffix}`}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES
        (
          ${crypto.randomUUID()}, ${organizationId}, ${adminUserId},
          'owner', ${now}
        ),
        (
          ${crypto.randomUUID()}, ${organizationId}, ${memberUserId},
          'member', ${now}
        )
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "provider", "region", "status", "is_default", "created_at",
        "updated_at"
      ) VALUES (
        ${environmentId}, ${organizationId}, ${adminUserId},
        'Receiving Route Environment', 'default', 'fly', 'iad', 'ready', true,
        ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "session" (
        "id", "expiresAt", "token", "createdAt", "updatedAt", "userId",
        "activeOrganizationId"
      ) VALUES
        (
          ${crypto.randomUUID()}, ${new Date(now.getTime() + 10 * 60_000)},
          ${adminSessionToken}, ${now}, ${now}, ${adminUserId},
          ${organizationId}
        ),
        (
          ${crypto.randomUUID()}, ${new Date(now.getTime() + 10 * 60_000)},
          ${memberSessionToken}, ${now}, ${now}, ${memberUserId},
          ${organizationId}
        )
    `;
    for (const credential of [adminCredential, memberCredential]) {
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

  const oneReceivingUrl = "http://localhost/api/organization/email/receiving";
  const desktopReceivingUrl = `http://localhost/api/desktop/v1/organizations/${organizationId}/email/receiving`;
  const desktopContext = {
    params: Promise.resolve({ organizationId }),
  };
  const mutations = [
    {
      name: "One receiving PUT",
      url: oneReceivingUrl,
      method: "PUT",
      adminAuthorization: `Bearer ${adminSessionToken}`,
      memberAuthorization: `Bearer ${memberSessionToken}`,
      invoke: (request: Request) => oneReceivingRoute.PUT(request),
    },
    {
      name: "One domains POST",
      url: `${oneReceivingUrl}/domains`,
      method: "POST",
      adminAuthorization: `Bearer ${adminSessionToken}`,
      memberAuthorization: `Bearer ${memberSessionToken}`,
      invoke: (request: Request) => oneDomainsRoute.POST(request),
    },
    {
      name: "Desktop receiving PUT",
      url: desktopReceivingUrl,
      method: "PUT",
      adminAuthorization: `Bearer ${adminCredential.value}`,
      memberAuthorization: `Bearer ${memberCredential.value}`,
      invoke: (request: Request) =>
        desktopReceivingRoute.PUT(request, desktopContext),
    },
    {
      name: "Desktop domains POST",
      url: `${desktopReceivingUrl}/domains`,
      method: "POST",
      adminAuthorization: `Bearer ${adminCredential.value}`,
      memberAuthorization: `Bearer ${memberCredential.value}`,
      invoke: (request: Request) =>
        desktopDomainsRoute.POST(request, desktopContext),
    },
  ];

  for (const mutation of mutations) {
    const authorized = trackedMalformedMutationRequest({
      url: mutation.url,
      method: mutation.method,
      authorization: mutation.adminAuthorization,
    });
    const authorizedResponse = await mutation.invoke(authorized.request);
    assert.equal(authorizedResponse.status, 422, mutation.name);
    assert.deepEqual(
      await authorizedResponse.json(),
      {
        code: "RESEND_RECEIVING_REQUEST_INVALID",
        error: "Invalid inbound receiving request.",
      },
      mutation.name,
    );
    assert.equal(authorized.readCount(), 1, mutation.name);

    const unauthenticated = trackedMalformedMutationRequest({
      url: mutation.url,
      method: mutation.method,
    });
    const unauthenticatedResponse = await mutation.invoke(
      unauthenticated.request,
    );
    assert.equal(unauthenticatedResponse.status, 401, mutation.name);
    assert.deepEqual(
      await unauthenticatedResponse.json(),
      { code: "UNAUTHORIZED", error: "Unauthorized" },
      mutation.name,
    );
    assert.equal(unauthenticated.readCount(), 0, mutation.name);

    const member = trackedMalformedMutationRequest({
      url: mutation.url,
      method: mutation.method,
      authorization: mutation.memberAuthorization,
    });
    const memberResponse = await mutation.invoke(member.request);
    assert.equal(memberResponse.status, 403, mutation.name);
    assert.deepEqual(
      await memberResponse.json(),
      { code: "FORBIDDEN", error: "Forbidden" },
      mutation.name,
    );
    assert.equal(member.readCount(), 0, mutation.name);
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

function failingListProvider(
  code:
    | "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT"
    | "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
  message: string,
): ResendReceivingProvider {
  return coordinatedProvider({
    async listDomains() {
      throw new ResendReceivingProviderError(code, message);
    },
  });
}

function healthyListProvider(domainId: string): ResendReceivingProvider {
  return coordinatedProvider({
    async listDomains() {
      return [verifiedReceivingDomain(domainId)];
    },
  });
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

function trackedMalformedMutationRequest(input: {
  url: string;
  method: string;
  authorization?: string;
}) {
  const request = new Request(input.url, {
    method: input.method,
    body: "{",
    headers: {
      "content-type": "application/json",
      ...(input.authorization ? { authorization: input.authorization } : {}),
    },
  });
  let reads = 0;
  request.text = async () => {
    reads += 1;
    return "{";
  };
  return { request, readCount: () => reads };
}
