import "../../scripts/register-server-only.mjs";

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import {
  type CreatedResendWebhook,
  type ResendReceivingDomain,
  ResendReceivingProviderError,
  type ResendWebhookCreateIntent,
  type ResendWebhookDecommissionProvider,
  type ResendWebhookProjection,
  type ResendWebhookUpdateEvidence,
} from "@/lib/email/receiving-provider";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("Organization deletion disables ingress and decommissions known, absent, failed, and ambiguous Resend webhooks", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });
  const [
    { resetDbRuntimeForTests },
    { encryptGatewayCredential },
    receiving,
    deletion,
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("@/lib/ai/gateway-credential-crypto"),
    import("@/lib/email/receiving-config"),
    import("./deletion"),
  ]);
  const sql = postgres(databaseUrl, { max: 8 });
  const suiteSuffix = randomUUID();
  const createdOperationIds: string[] = [];
  const createdOrganizationIds: string[] = [];

  context.after(async () => {
    for (const operationId of createdOperationIds) {
      await sql`DELETE FROM "organization_deletion_operations" WHERE "id" = ${operationId}`;
    }
    for (const organizationId of createdOrganizationIds) {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    }
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  async function insertFixture(input: {
    label: string;
    webhookStatus: "staged" | "active";
    providerWebhookId: string | null;
    createAttempted: boolean;
    createIntent?: ResendWebhookCreateIntent;
  }) {
    const organizationId = `receiving-delete-org-${input.label}-${suiteSuffix}`;
    const operationId = `receiving-delete-op-${input.label}-${suiteSuffix}`;
    const connectionId = `receiving-delete-connection-${input.label}-${suiteSuffix}`;
    const locator = `locator-${input.label}-${suiteSuffix}`;
    const apiKey = `re_${input.label}_private_authority`;
    const now = new Date();
    const encryptedApiKey = encryptGatewayCredential({
      gatewayId: `organization-receiving-connection:${organizationId}:api-key`,
      plaintext: apiKey,
    });
    const encryptedSigningSecret = receiving.encryptReceivingSigningSecret({
      organizationId,
      signingSecret: `whsec_${input.label}_private_secret`,
    });
    createdOrganizationIds.push(organizationId);
    createdOperationIds.push(operationId);
    await sql`
      INSERT INTO "organization" (
        "id", "name", "slug", "createdAt", "lifecycle_state"
      ) VALUES (
        ${organizationId}, 'Receiving Delete Org',
        ${`receiving-delete-${input.label}-${suiteSuffix}`}, ${now}, 'deleting'
      )
    `;
    await sql`
      INSERT INTO "organization_deletion_operations" (
        "id", "organization_id", "organization_name", "status", "stage",
        "idempotency_key", "inventory", "created_at", "updated_at"
      ) VALUES (
        ${operationId}, ${organizationId}, 'Receiving Delete Org', 'queued',
        'organization.deletion.requested', ${`delete:${operationId}`},
        '{"environments":[]}'::jsonb, ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO "organization_receiving_connections" (
        "id", "organization_id", "encrypted_api_key", "credential_status",
        "receiving_domain_id", "receiving_domain", "receiving_domain_status",
        "mx_status", "route_locator", "provider_webhook_id",
        "encrypted_signing_secret", "webhook_create_intent",
        "webhook_create_attempted_at", "webhook_status", "inbound_enabled",
        "created_at", "updated_at"
      ) VALUES (
        ${connectionId}, ${organizationId}, ${encryptedApiKey}, 'full_access',
        'domain-private', 'mail.private.example', 'verified', 'verified',
        ${locator}, ${input.providerWebhookId}, ${encryptedSigningSecret},
        ${input.createIntent ? sql.json(input.createIntent) : null},
        ${input.createAttempted ? now : null}, ${input.webhookStatus},
        ${input.webhookStatus === "active"},
        ${now}, ${now}
      )
    `;
    return {
      apiKey,
      connectionId,
      encryptedApiKey,
      locator,
      operationId,
      organizationId,
    };
  }

  async function assertIngressDisabled(organizationId: string) {
    const [connection] = await sql<
      Array<{ inboundEnabled: boolean; webhookStatus: string }>
    >`
      SELECT "inbound_enabled" AS "inboundEnabled",
             "webhook_status" AS "webhookStatus"
      FROM "organization_receiving_connections"
      WHERE "organization_id" = ${organizationId}
    `;
    assert.deepEqual(connection, {
      inboundEnabled: false,
      webhookStatus: "disabled",
    });
  }

  const active = await insertFixture({
    label: "active",
    webhookStatus: "active",
    providerWebhookId: "webhook-active-private",
    createAttempted: true,
  });
  const activeProvider = new DeletionProvider(active.apiKey);
  activeProvider.webhooks.set(
    "webhook-active-private",
    webhook("webhook-active-private"),
  );
  activeProvider.beforeProviderCall = () =>
    assertIngressDisabled(active.organizationId);
  await deletion.processOrganizationDeletion(active.operationId, {
    receivingProvider: activeProvider,
  });
  assert.equal(activeProvider.removeCalls, 1);
  assert.equal(activeProvider.reconcileCalls, 0);
  await assertCompletedAndCascaded(sql, active);

  const absent = await insertFixture({
    label: "absent",
    webhookStatus: "staged",
    providerWebhookId: "webhook-already-absent",
    createAttempted: true,
  });
  const absentProvider = new DeletionProvider(absent.apiKey);
  absentProvider.beforeProviderCall = () =>
    assertIngressDisabled(absent.organizationId);
  await deletion.processOrganizationDeletion(absent.operationId, {
    receivingProvider: absentProvider,
  });
  assert.equal(absentProvider.removeCalls, 1);
  await assertCompletedAndCascaded(sql, absent);

  const failed = await insertFixture({
    label: "retry",
    webhookStatus: "active",
    providerWebhookId: "webhook-retry-private",
    createAttempted: true,
  });
  const failedProvider = new DeletionProvider(failed.apiKey);
  failedProvider.webhooks.set(
    "webhook-retry-private",
    webhook("webhook-retry-private"),
  );
  failedProvider.removeFailure = new ResendReceivingProviderError(
    "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
    `provider rejected ${failed.apiKey} ${failed.encryptedApiKey} ${failed.locator} webhook-retry-private person@example.test`,
  );
  await deletion.processOrganizationDeletion(failed.operationId, {
    receivingProvider: failedProvider,
  });
  const [failedOperation] = await sql<
    Array<{ status: string; errorCode: string | null; errorMessage: string | null }>
  >`
    SELECT "status", "error_code" AS "errorCode", "error_message" AS "errorMessage"
    FROM "organization_deletion_operations" WHERE "id" = ${failed.operationId}
  `;
  assert.deepEqual(failedOperation, {
    status: "failed",
    errorCode: "RESEND_RECEIVING_DECOMMISSION_FAILED",
    errorMessage:
      "Resend receiving could not be removed. Retry organization deletion.",
  });
  for (const privateValue of [
    failed.apiKey,
    failed.encryptedApiKey,
    failed.locator,
    "webhook-retry-private",
    "person@example.test",
  ]) {
    assert.equal(JSON.stringify(failedOperation).includes(privateValue), false);
  }
  await assertIngressDisabled(failed.organizationId);
  const [preserved] = await sql<
    Array<{ encryptedApiKey: string; providerWebhookId: string | null }>
  >`
    SELECT "encrypted_api_key" AS "encryptedApiKey",
           "provider_webhook_id" AS "providerWebhookId"
    FROM "organization_receiving_connections"
    WHERE "organization_id" = ${failed.organizationId}
  `;
  assert.deepEqual(preserved, {
    encryptedApiKey: failed.encryptedApiKey,
    providerWebhookId: "webhook-retry-private",
  });
  failedProvider.removeFailure = null;
  await deletion.retryOrganizationDeletion({
    organizationId: failed.organizationId,
  });
  await deletion.processOrganizationDeletion(failed.operationId, {
    receivingProvider: failedProvider,
  });
  assert.equal(failedProvider.removeCalls, 2);
  await assertCompletedAndCascaded(sql, failed);

  const ambiguousIntent: ResendWebhookCreateIntent = {
    endpoint: "https://one.example.test/api/webhooks/resend/inbound/ambiguous-private",
    events: ["email.received"],
  };
  const ambiguous = await insertFixture({
    label: "ambiguous",
    webhookStatus: "staged",
    providerWebhookId: null,
    createAttempted: true,
    createIntent: ambiguousIntent,
  });
  const ambiguousProvider = new DeletionProvider(ambiguous.apiKey);
  ambiguousProvider.recovered = {
    id: "webhook-recovered-private",
    signingSecret: "whsec_recovered_private",
  };
  ambiguousProvider.webhooks.set(
    "webhook-recovered-private",
    webhook("webhook-recovered-private", ambiguousIntent.endpoint),
  );
  ambiguousProvider.beforeProviderCall = async (action) => {
    await assertIngressDisabled(ambiguous.organizationId);
    if (action === "remove") {
      const [evidence] = await sql<Array<{ providerWebhookId: string | null }>>`
        SELECT "provider_webhook_id" AS "providerWebhookId"
        FROM "organization_receiving_connections"
        WHERE "organization_id" = ${ambiguous.organizationId}
      `;
      assert.equal(evidence?.providerWebhookId, "webhook-recovered-private");
    }
  };
  await deletion.processOrganizationDeletion(ambiguous.operationId, {
    receivingProvider: ambiguousProvider,
  });
  assert.equal(ambiguousProvider.createCalls, 0);
  assert.equal(ambiguousProvider.reconcileCalls, 1);
  assert.equal(ambiguousProvider.removeCalls, 1);
  assert.deepEqual(ambiguousProvider.reconciledIntents, [ambiguousIntent]);
  await assertCompletedAndCascaded(sql, ambiguous);

  const absentAttempt = await insertFixture({
    label: "attempted-without-provider-resource",
    webhookStatus: "staged",
    providerWebhookId: null,
    createAttempted: true,
    createIntent: {
      endpoint:
        "https://one.example.test/api/webhooks/resend/inbound/absent-attempt",
      events: ["email.received"],
    },
  });
  const absentAttemptProvider = new DeletionProvider(absentAttempt.apiKey);
  await deletion.processOrganizationDeletion(absentAttempt.operationId, {
    receivingProvider: absentAttemptProvider,
  });
  assert.equal(absentAttemptProvider.reconcileCalls, 1);
  assert.equal(absentAttemptProvider.createCalls, 0);
  assert.equal(absentAttemptProvider.removeCalls, 0);
  await assertCompletedAndCascaded(sql, absentAttempt);
});

type Sql = ReturnType<typeof postgres>;

async function assertCompletedAndCascaded(
  sql: Sql,
  fixture: { operationId: string; organizationId: string },
) {
  const [state] = await sql<
    Array<{ status: string; stage: string; organizations: number; connections: number }>
  >`
    SELECT deletion."status", deletion."stage",
      (SELECT count(*)::int FROM "organization" WHERE "id" = ${fixture.organizationId}) AS "organizations",
      (SELECT count(*)::int FROM "organization_receiving_connections" WHERE "organization_id" = ${fixture.organizationId}) AS "connections"
    FROM "organization_deletion_operations" deletion
    WHERE deletion."id" = ${fixture.operationId}
  `;
  assert.deepEqual(state, {
    status: "completed",
    stage: "organization.deleted",
    organizations: 0,
    connections: 0,
  });
}

function webhook(
  id: string,
  endpoint = "https://one.example.test/api/webhooks/resend/inbound/private",
): ResendWebhookProjection {
  return {
    id,
    endpoint,
    status: "disabled",
    events: ["email.received"],
  };
}

class DeletionProvider implements ResendWebhookDecommissionProvider {
  readonly webhooks = new Map<string, ResendWebhookProjection>();
  readonly reconciledIntents: ResendWebhookCreateIntent[] = [];
  createCalls = 0;
  reconcileCalls = 0;
  removeCalls = 0;
  removeFailure: Error | null = null;
  recovered: CreatedResendWebhook | null = null;
  beforeProviderCall:
    | ((action: "reconcile" | "remove" | "verify") => Promise<void> | void)
    | null = null;

  constructor(private readonly expectedApiKey: string) {}

  async listDomains(): Promise<ResendReceivingDomain[]> {
    throw new Error("unused");
  }

  async getDomain(): Promise<ResendReceivingDomain> {
    throw new Error("unused");
  }

  async createWebhook(): Promise<CreatedResendWebhook> {
    this.createCalls += 1;
    throw new Error("decommission must never create a webhook");
  }

  async reconcileWebhookCreate(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }): Promise<CreatedResendWebhook> {
    this.assertApiKey(input.apiKey);
    await this.beforeProviderCall?.("reconcile");
    this.reconcileCalls += 1;
    this.reconciledIntents.push(input.intent);
    if (!this.recovered) throw new Error("ambiguous provider evidence");
    return this.recovered;
  }

  async reconcileWebhookCreateIfPresent(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }): Promise<CreatedResendWebhook | null> {
    this.assertApiKey(input.apiKey);
    await this.beforeProviderCall?.("reconcile");
    this.reconcileCalls += 1;
    this.reconciledIntents.push(input.intent);
    return this.recovered;
  }

  async getWebhook(
    apiKey: string,
    webhookId: string,
  ): Promise<ResendWebhookProjection> {
    this.assertApiKey(apiKey);
    const value = this.webhooks.get(webhookId);
    if (!value) throw new Error("not found");
    return value;
  }

  async getWebhookIfPresent(
    apiKey: string,
    webhookId: string,
  ): Promise<ResendWebhookProjection | null> {
    this.assertApiKey(apiKey);
    await this.beforeProviderCall?.("verify");
    return this.webhooks.get(webhookId) ?? null;
  }

  async updateWebhook(): Promise<ResendWebhookUpdateEvidence> {
    throw new Error("unused");
  }

  async removeWebhook(apiKey: string, webhookId: string): Promise<void> {
    this.assertApiKey(apiKey);
    await this.beforeProviderCall?.("remove");
    this.removeCalls += 1;
    if (this.removeFailure) throw this.removeFailure;
    this.webhooks.delete(webhookId);
  }

  private assertApiKey(apiKey: string) {
    assert.equal(apiKey, this.expectedApiKey);
  }
}
