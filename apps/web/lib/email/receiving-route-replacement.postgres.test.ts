import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { ResendReceivingProviderError } from "./receiving-provider";
import type {
  ResendReceivingDomain,
  ResendWebhookCreateIntent,
  ResendWebhookCreateRecoveryProvider,
  ResendWebhookProjection,
} from "./receiving-provider";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("One and Desktop replace write-only Resend credentials through their real management routes", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.NEXT_PUBLIC_APP_URL = "https://one.example.test";
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });

  const [
    { resetDbRuntimeForTests },
    receiving,
    routeHandlers,
    { requireOrganizationAdmin },
    { requireDesktopReceivingAdmin },
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./receiving-config"),
    import("./receiving-admin-route-handlers"),
    import("@/lib/knowledge/auth"),
    import("./desktop-receiving-auth"),
  ]);
  const sql = postgres(databaseUrl, { max: 8 });
  const fixtures: RouteFixture[] = [];

  context.after(async () => {
    for (const fixture of fixtures) {
      await sql`DELETE FROM "organization" WHERE "id" = ${fixture.organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${fixture.userId}`;
    }
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  const configured = await createRouteFixture(sql, "configured");
  fixtures.push(configured);
  const provider = new RouteReplacementProvider("webhook-route-configured");
  await receiving.saveReceivingConnection({
    organizationId: configured.organizationId,
    actorUserId: configured.userId,
    apiKey: "re_original_route_key",
    receivingDomainId: "domain-one",
    provider,
  });
  const [initial] = await readStored(sql, configured.organizationId);
  assert.ok(initial);
  assert.equal(initial.webhookStatus, "staged");
  assert.equal(initial.inboundEnabled, false);
  assert.equal(provider.createCalls, 1);

  const onePut = routeHandlers.createOneReceivingPutHandler({
    requireAdmin: requireOrganizationAdmin,
    provider,
  });
  const desktopPut = routeHandlers.createDesktopReceivingPutHandler({
    requireAdmin: requireDesktopReceivingAdmin,
    provider,
  });
  const oneSuccess = await onePut(
    jsonRequest(
      "http://localhost/api/organization/email/receiving",
      configured.sessionToken,
      {
        apiKey: "re_one_replacement_key",
        receivingDomainId: "domain-one",
      },
    ),
  );
  assert.equal(oneSuccess.status, 200);
  const oneSuccessBody = await oneSuccess.json();
  assertPublicConnectionBody(oneSuccessBody, [
    "re_original_route_key",
    "re_one_replacement_key",
    provider.webhook.signingSecret,
    provider.webhook.id,
  ]);
  assert.equal(oneSuccessBody.connection.webhookStatus, "staged");
  assert.equal(oneSuccessBody.connection.inboundEnabled, false);
  const [afterOne] = await readStored(sql, configured.organizationId);
  assert.ok(afterOne);
  assert.equal(afterOne.providerWebhookId, initial.providerWebhookId);
  assert.equal(afterOne.webhookStatus, "staged");
  assert.equal(afterOne.inboundEnabled, false);
  assert.equal(provider.createCalls, 1);
  assert.equal(
    receiving.decryptReceivingApiKey({
      organizationId: configured.organizationId,
      encryptedApiKey: afterOne.encryptedApiKey,
    }),
    "re_one_replacement_key",
  );

  const oneAudits = await readReceivingAudits(sql, configured.organizationId);
  assert.equal(oneAudits.length, 1);
  assert.ok(oneAudits[0]?.createdAt.getTime() >= afterOne.updatedAt.getTime());

  const desktopSuccess = await desktopPut(
    jsonRequest(
      `http://localhost/api/desktop/v1/organizations/${configured.organizationId}/email/receiving`,
      configured.desktopCredential,
      {
        apiKey: "re_desktop_replacement_key",
        receivingDomainId: "domain-one",
      },
    ),
    desktopContext(configured.organizationId),
  );
  assert.equal(desktopSuccess.status, 200);
  const desktopSuccessBody = await desktopSuccess.json();
  assertPublicConnectionBody(desktopSuccessBody, [
    "re_one_replacement_key",
    "re_desktop_replacement_key",
    provider.webhook.signingSecret,
    provider.webhook.id,
  ]);
  assert.deepEqual(
    Object.keys(desktopSuccessBody.connection).sort(),
    Object.keys(oneSuccessBody.connection).sort(),
  );
  assert.equal(desktopSuccessBody.connection.webhookStatus, "staged");
  assert.equal(desktopSuccessBody.connection.inboundEnabled, false);
  const [afterDesktop] = await readStored(sql, configured.organizationId);
  assert.ok(afterDesktop);
  assert.equal(afterDesktop.providerWebhookId, initial.providerWebhookId);
  assert.equal(
    afterDesktop.encryptedSigningSecret,
    initial.encryptedSigningSecret,
  );
  assert.equal(provider.createCalls, 1);
  assert.equal(
    receiving.decryptReceivingApiKey({
      organizationId: configured.organizationId,
      encryptedApiKey: afterDesktop.encryptedApiKey,
    }),
    "re_desktop_replacement_key",
  );
  assert.equal(
    (await readReceivingAudits(sql, configured.organizationId)).length,
    1,
    "Desktop replacement must not create a One admin audit",
  );

  const rejectedCases = [
    {
      name: "One different-account key",
      apiKey: "re_other_account_route_key",
      invoke: (request: Request) => onePut(request),
      url: "http://localhost/api/organization/email/receiving",
      credential: configured.sessionToken,
    },
    {
      name: "Desktop insufficient-authority key",
      apiKey: "re_insufficient_route_key",
      invoke: (request: Request) =>
        desktopPut(request, desktopContext(configured.organizationId)),
      url: `http://localhost/api/desktop/v1/organizations/${configured.organizationId}/email/receiving`,
      credential: configured.desktopCredential,
    },
  ];
  for (const rejected of rejectedCases) {
    const before = (await readStored(sql, configured.organizationId))[0];
    assert.ok(before);
    const response = await rejected.invoke(
      jsonRequest(rejected.url, rejected.credential, {
        apiKey: rejected.apiKey,
        receivingDomainId: "domain-one",
      }),
    );
    assert.equal(response.status, 409, rejected.name);
    const body = await response.json();
    assert.deepEqual(
      body,
      {
        code: "RESEND_RECEIVING_WEBHOOK_KEY_AUTHORITY_CONFLICT",
        error:
          "The replacement Resend credential cannot manage the existing receiving webhook.",
      },
      rejected.name,
    );
    assertSafeErrorBody(body, [
      rejected.apiKey,
      before.encryptedApiKey,
      before.encryptedSigningSecret ?? "",
      before.routeLocator,
      before.providerWebhookId ?? "",
      provider.webhook.endpoint,
      provider.privateDiagnostic,
    ]);
    assert.deepEqual(
      (await readStored(sql, configured.organizationId))[0],
      before,
      `${rejected.name} must not mutate durable state`,
    );
  }
  assert.equal(provider.createCalls, 1);
  assert.equal(
    (await readReceivingAudits(sql, configured.organizationId)).length,
    1,
    "rejected One replacement must not record success",
  );

  const ambiguous = await createRouteFixture(sql, "ambiguous");
  fixtures.push(ambiguous);
  const ambiguousProvider = new RouteReplacementProvider(
    "webhook-route-ambiguous",
  );
  ambiguousProvider.failCreateAfterAcceptance = true;
  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId: ambiguous.organizationId,
      actorUserId: ambiguous.userId,
      apiKey: "re_ambiguous_original_key",
      receivingDomainId: "domain-one",
      provider: ambiguousProvider,
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_WEBHOOK_STAGING_FAILED",
  );
  const [ambiguousBefore] = await readStored(sql, ambiguous.organizationId);
  assert.ok(ambiguousBefore?.webhookCreateAttemptedAt);
  assert.equal(ambiguousBefore.providerWebhookId, null);
  assert.equal(ambiguousBefore.encryptedSigningSecret, null);
  const ambiguousOnePut = routeHandlers.createOneReceivingPutHandler({
    requireAdmin: requireOrganizationAdmin,
    provider: ambiguousProvider,
  });
  const ambiguousDesktopPut = routeHandlers.createDesktopReceivingPutHandler({
    requireAdmin: requireDesktopReceivingAdmin,
    provider: ambiguousProvider,
  });
  const ambiguousCases = [
    {
      name: "One ambiguous-create replacement",
      apiKey: "re_ambiguous_one_candidate",
      invoke: (request: Request) => ambiguousOnePut(request),
      url: "http://localhost/api/organization/email/receiving",
      credential: ambiguous.sessionToken,
    },
    {
      name: "Desktop ambiguous-create replacement",
      apiKey: "re_ambiguous_desktop_candidate",
      invoke: (request: Request) =>
        ambiguousDesktopPut(request, desktopContext(ambiguous.organizationId)),
      url: `http://localhost/api/desktop/v1/organizations/${ambiguous.organizationId}/email/receiving`,
      credential: ambiguous.desktopCredential,
    },
  ];
  const providerCallsBeforeAmbiguousReplacement =
    ambiguousProvider.providerCalls();
  for (const rejected of ambiguousCases) {
    const response = await rejected.invoke(
      jsonRequest(rejected.url, rejected.credential, {
        apiKey: rejected.apiKey,
        receivingDomainId: "domain-one",
      }),
    );
    assert.equal(response.status, 409, rejected.name);
    const body = await response.json();
    assert.deepEqual(
      body,
      {
        code: "RESEND_RECEIVING_WEBHOOK_KEY_AUTHORITY_CONFLICT",
        error:
          "The replacement Resend credential cannot manage the existing receiving webhook.",
      },
      rejected.name,
    );
    assertSafeErrorBody(body, [
      rejected.apiKey,
      ambiguousBefore.encryptedApiKey,
      ambiguousBefore.routeLocator,
      ambiguousProvider.webhook.endpoint,
      ambiguousProvider.privateDiagnostic,
    ]);
    assert.deepEqual(
      (await readStored(sql, ambiguous.organizationId))[0],
      ambiguousBefore,
      `${rejected.name} must preserve ambiguous-create evidence`,
    );
  }
  assert.deepEqual(
    ambiguousProvider.providerCalls(),
    providerCallsBeforeAmbiguousReplacement,
    "candidate keys must not create, reconcile, inspect, or update ambiguous provider state",
  );
  assert.equal(
    (await readReceivingAudits(sql, ambiguous.organizationId)).length,
    0,
  );
});

class RouteReplacementProvider implements ResendWebhookCreateRecoveryProvider {
  createCalls = 0;
  reconcileCalls = 0;
  getCalls = 0;
  updateCalls = 0;
  domainCalls = 0;
  failCreateAfterAcceptance = false;
  readonly privateDiagnostic = "provider_private_diagnostic_re_secret";
  readonly webhook: ResendWebhookProjection & { signingSecret: string };

  constructor(webhookId: string) {
    this.webhook = {
      id: webhookId,
      endpoint: "",
      status: "enabled",
      events: ["email.received"],
      signingSecret: `whsec_${webhookId}`,
    };
  }

  async listDomains() {
    return [verifiedDomain()];
  }

  async getDomain(_apiKey: string, id: string) {
    this.domainCalls += 1;
    return verifiedDomain(id);
  }

  async createWebhook(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }) {
    this.createCalls += 1;
    this.webhook.endpoint = input.intent.endpoint;
    if (this.failCreateAfterAcceptance) {
      this.failCreateAfterAcceptance = false;
      throw new Error(this.privateDiagnostic);
    }
    return {
      id: this.webhook.id,
      signingSecret: this.webhook.signingSecret,
    };
  }

  async reconcileWebhookCreate() {
    this.reconcileCalls += 1;
    return {
      id: this.webhook.id,
      signingSecret: this.webhook.signingSecret,
    };
  }

  async getWebhook(apiKey: string) {
    this.getCalls += 1;
    if (apiKey === "re_other_account_route_key") {
      throw new ResendReceivingProviderError(
        "RESEND_RECEIVING_DOMAIN_INVALID",
        this.privateDiagnostic,
      );
    }
    if (apiKey === "re_insufficient_route_key") {
      throw new ResendReceivingProviderError(
        "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
        this.privateDiagnostic,
      );
    }
    return {
      id: this.webhook.id,
      endpoint: this.webhook.endpoint,
      status: this.webhook.status,
      events: [...this.webhook.events],
    };
  }

  async updateWebhook(input: {
    webhookId: string;
    endpoint?: string;
    enabled?: boolean;
  }) {
    this.updateCalls += 1;
    if (input.endpoint) this.webhook.endpoint = input.endpoint;
    if (input.enabled !== undefined) {
      this.webhook.status = input.enabled ? "enabled" : "disabled";
    }
    return {
      id: input.webhookId,
      applied: {
        ...(input.endpoint ? { endpoint: input.endpoint } : {}),
        ...(input.enabled === undefined
          ? {}
          : {
              status: input.enabled
                ? ("enabled" as const)
                : ("disabled" as const),
            }),
      },
    };
  }

  async removeWebhook() {
    throw new Error("route replacement must not remove the existing webhook");
  }

  providerCalls() {
    return {
      create: this.createCalls,
      reconcile: this.reconcileCalls,
      get: this.getCalls,
      update: this.updateCalls,
      domain: this.domainCalls,
    };
  }
}

type RouteFixture = {
  organizationId: string;
  userId: string;
  sessionToken: string;
  desktopCredential: string;
};

async function createRouteFixture(
  sql: postgres.Sql,
  label: string,
): Promise<RouteFixture> {
  const suffix = randomUUID();
  const organizationId = `receiving-route-${label}-${suffix}`;
  const userId = `receiving-route-${label}-user-${suffix}`;
  const environmentId = `receiving-route-${label}-environment-${suffix}`;
  const sessionToken = `receiving-route-${label}-session-${suffix}`;
  const desktop = desktopAccessCredential(userId);
  const now = new Date();

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${userId}, 'Receiving Route Replacement Admin',
        ${`${userId}@example.test`}, true, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${organizationId}, 'Receiving Route Replacement',
        ${`receiving-route-${label}-${suffix}`}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (
        ${randomUUID()}, ${organizationId}, ${userId}, 'owner', ${now}
      )
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "provider", "region", "status", "is_default", "created_at",
        "updated_at"
      ) VALUES (
        ${environmentId}, ${organizationId}, ${userId},
        'Receiving Route Environment', 'default', 'fly', 'iad', 'ready', true,
        ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "session" (
        "id", "expiresAt", "token", "createdAt", "updatedAt", "userId",
        "activeOrganizationId"
      ) VALUES (
        ${randomUUID()}, ${new Date(now.getTime() + 10 * 60_000)},
        ${sessionToken}, ${now}, ${now}, ${userId}, ${organizationId}
      )
    `;
    await transaction`
      INSERT INTO "desktop_user_credentials" (
        "id", "user_id", "family_id", "kind", "secret_hash",
        "expires_at", "revoked_at", "created_at"
      ) VALUES (
        ${desktop.id}, ${userId}, ${randomUUID()}, 'access',
        ${desktop.secretHash}, ${new Date(now.getTime() + 10 * 60_000)},
        NULL, ${now}
      )
    `;
  });

  return {
    organizationId,
    userId,
    sessionToken,
    desktopCredential: desktop.value,
  };
}

function verifiedDomain(id = "domain-one"): ResendReceivingDomain {
  return {
    id,
    name: "inbound.example.test",
    status: "verified",
    receiving: "enabled",
    mxStatus: "verified",
  };
}

function desktopAccessCredential(userId: string) {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return {
    id,
    userId,
    secretHash: createHash("sha256").update(secret).digest("hex"),
    value: `${id}.${secret}`,
  };
}

function jsonRequest(
  url: string,
  credential: string,
  body: { apiKey: string; receivingDomainId: string },
) {
  return new Request(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function desktopContext(organizationId: string) {
  return { params: Promise.resolve({ organizationId }) };
}

function assertPublicConnectionBody(body: unknown, privateValues: string[]) {
  assert.ok(body && typeof body === "object");
  const serialized = JSON.stringify(body);
  for (const field of [
    "apiKey",
    "encryptedApiKey",
    "signingSecret",
    "encryptedSigningSecret",
    "routeLocator",
    "providerWebhookId",
    "webhookCreateIntent",
    "endpoint",
  ]) {
    assert.equal(serialized.includes(field), false, field);
  }
  for (const value of privateValues) {
    assert.equal(serialized.includes(value), false, value);
  }
}

function assertSafeErrorBody(body: unknown, privateValues: string[]) {
  const serialized = JSON.stringify(body);
  for (const value of privateValues.filter(Boolean)) {
    assert.equal(serialized.includes(value), false, value);
  }
  for (const field of [
    "apiKey",
    "encryptedApiKey",
    "signingSecret",
    "routeLocator",
    "providerWebhookId",
    "endpoint",
    "diagnostic",
  ]) {
    assert.equal(serialized.includes(field), false, field);
  }
}

function readStored(sql: postgres.Sql, organizationId: string) {
  return sql<
    Array<{
      encryptedApiKey: string;
      encryptedSigningSecret: string | null;
      routeLocator: string;
      providerWebhookId: string | null;
      webhookCreateIntent: { endpoint: string; events: string[] } | null;
      webhookCreateAttemptedAt: Date | null;
      webhookStatus: string;
      inboundEnabled: boolean;
      lastErrorCode: string | null;
      updatedAt: Date;
    }>
  >`
    SELECT
      "encrypted_api_key" AS "encryptedApiKey",
      "encrypted_signing_secret" AS "encryptedSigningSecret",
      "route_locator" AS "routeLocator",
      "provider_webhook_id" AS "providerWebhookId",
      "webhook_create_intent" AS "webhookCreateIntent",
      "webhook_create_attempted_at" AS "webhookCreateAttemptedAt",
      "webhook_status" AS "webhookStatus",
      "inbound_enabled" AS "inboundEnabled",
      "last_error_code" AS "lastErrorCode",
      "updated_at" AS "updatedAt"
    FROM "organization_receiving_connections"
    WHERE "organization_id" = ${organizationId}
  `;
}

function readReceivingAudits(sql: postgres.Sql, organizationId: string) {
  return sql<Array<{ createdAt: Date }>>`
    SELECT "created_at" AS "createdAt"
    FROM "admin_event_logs"
    WHERE "organization_id" = ${organizationId}
      AND "action" = 'update-inbound-receiving'
    ORDER BY "created_at" ASC
  `;
}
