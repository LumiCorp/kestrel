import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import type {
  ResendReceivingDomain,
  ResendWebhookCreateIntent,
  ResendWebhookCreateRecoveryProvider,
  ResendWebhookProjection,
} from "./receiving-provider";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("provider webhook staging persists checkpoints, recovers ambiguous create, and rejects stale key results", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.NEXT_PUBLIC_APP_URL = "https://one.example.test";
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });
  const [{ resetDbRuntimeForTests }, receiving] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./receiving-config"),
  ]);
  const sql = postgres(databaseUrl, { max: 8 });
  const suffix = randomUUID();
  const organizationId = `staging-org-${suffix}`;
  const userId = `staging-user-${suffix}`;
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
      ${userId}, 'Staging User', ${`${userId}@example.test`}, true, ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (${organizationId}, 'Staging Org', ${`staging-${suffix}`}, ${now})
  `;

  const provider = new StagingProvider();
  provider.failFirstCreateAfterAcceptance = true;
  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      apiKey: "re_original",
      receivingDomainId: "domain-one",
      provider,
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_WEBHOOK_STAGING_FAILED",
  );
  const [ambiguous] = await readStored(sql, organizationId);
  assert.ok(ambiguous?.webhookCreateIntent);
  assert.ok(ambiguous.webhookCreateAttemptedAt);
  assert.equal(ambiguous.providerWebhookId, null);
  assert.equal(ambiguous.encryptedSigningSecret, null);
  assert.equal(ambiguous.webhookStatus, "error");

  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    receivingDomainId: "domain-one",
    provider,
  });
  const [recovered] = await readStored(sql, organizationId);
  assert.equal(provider.createCalls, 1);
  assert.equal(provider.reconcileCalls, 1);
  assert.equal(provider.updateCalls, 1);
  assert.equal(recovered?.providerWebhookId, provider.webhook.id);
  assert.match(recovered?.encryptedSigningSecret ?? "", /^kgc:v1:/u);
  assert.equal(recovered?.webhookStatus, "staged");
  assert.equal(recovered?.inboundEnabled, false);
  assert.equal(provider.webhook.status, "disabled");
  assert.match(
    String(recovered?.webhookCreateIntent?.endpoint),
    /^https:\/\/one\.example\.test\/api\/webhooks\/resend\/inbound\//u,
  );

  provider.onGet = async () => {
    throw new Error("provider read failed");
  };
  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      receivingDomainId: "domain-one",
      provider,
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_WEBHOOK_STAGING_FAILED",
  );
  const [failedRestage] = await readStored(sql, organizationId);
  assert.equal(failedRestage?.webhookStatus, "error");
  assert.equal(failedRestage?.inboundEnabled, false);
  provider.onGet = undefined;
  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    receivingDomainId: "domain-one",
    provider,
  });

  const oldStageRead = deferred();
  const releaseOldStage = deferred();
  provider.onGet = async (apiKey) => {
    if (apiKey === "re_original") {
      oldStageRead.resolve();
      await releaseOldStage.promise;
    }
  };
  const staleSave = receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    receivingDomainId: "domain-one",
    provider,
  });
  await oldStageRead.promise;

  provider.onGet = undefined;
  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_original",
    receivingDomainId: "domain-one",
    provider,
  });
  const [afterReplacement] = await readStored(sql, organizationId);
  assert.equal(afterReplacement?.providerWebhookId, provider.webhook.id);
  assert.equal(afterReplacement?.webhookStatus, "staged");
  assert.equal(provider.createCalls, 1);

  releaseOldStage.resolve();
  await assert.rejects(staleSave, (error: unknown) => {
    assert.ok(error instanceof receiving.ReceivingConfigError);
    assert.equal(error.code, "RESEND_RECEIVING_SAVE_SUPERSEDED");
    return true;
  });
  const [afterStaleCompletion] = await readStored(sql, organizationId);
  assert.deepEqual(afterStaleCompletion, afterReplacement);
  assert.equal(provider.createCalls, 1);

  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      apiKey: "re_different_account",
      receivingDomainId: "domain-one",
      provider,
    }),
    (error: unknown) => {
      assert.ok(error instanceof receiving.ReceivingConfigError);
      assert.equal(
        error.code,
        "RESEND_RECEIVING_WEBHOOK_KEY_REPLACEMENT_UNSUPPORTED",
      );
      return true;
    },
  );
  assert.deepEqual((await readStored(sql, organizationId))[0], afterReplacement);
  assert.equal(provider.createCalls, 1);
});

class StagingProvider implements ResendWebhookCreateRecoveryProvider {
  createCalls = 0;
  reconcileCalls = 0;
  updateCalls = 0;
  failFirstCreateAfterAcceptance = false;
  onGet: ((apiKey: string) => Promise<void>) | undefined;
  webhook: ResendWebhookProjection & { signingSecret: string } = {
    id: "webhook-staged",
    endpoint: "",
    status: "enabled",
    events: ["email.received"],
    signingSecret: "whsec_staged_secret",
  };

  async listDomains() {
    return [domain()];
  }

  async getDomain(_apiKey: string, id: string) {
    return domain(id);
  }

  async createWebhook(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }) {
    this.createCalls += 1;
    this.webhook.endpoint = input.intent.endpoint;
    if (this.failFirstCreateAfterAcceptance) {
      this.failFirstCreateAfterAcceptance = false;
      throw new Error("response lost after provider acceptance");
    }
    return { id: this.webhook.id, signingSecret: this.webhook.signingSecret };
  }

  async reconcileWebhookCreate(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }) {
    this.reconcileCalls += 1;
    assert.equal(input.intent.endpoint, this.webhook.endpoint);
    return { id: this.webhook.id, signingSecret: this.webhook.signingSecret };
  }

  async getWebhook(apiKey: string) {
    await this.onGet?.(apiKey);
    return {
      id: this.webhook.id,
      endpoint: this.webhook.endpoint,
      status: this.webhook.status,
      events: [...this.webhook.events],
    };
  }

  async updateWebhook(input: {
    apiKey: string;
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
          : { status: input.enabled ? ("enabled" as const) : ("disabled" as const) }),
      },
    };
  }

  async removeWebhook() {
    throw new Error("staged webhooks are not removed during key replacement");
  }
}

function domain(id = "domain-one"): ResendReceivingDomain {
  return {
    id,
    name: "inbound.example.test",
    status: "verified",
    receiving: "enabled",
    mxStatus: "verified",
  };
}

function readStored(sql: postgres.Sql, organizationId: string) {
  return sql<
    Array<{
      webhookCreateIntent: { endpoint: string; events: string[] } | null;
      webhookCreateAttemptedAt: Date | null;
      providerWebhookId: string | null;
      encryptedSigningSecret: string | null;
      webhookStatus: string;
      inboundEnabled: boolean;
      webhookStagingSequence: string;
    }>
  >`
    SELECT
      "webhook_create_intent" AS "webhookCreateIntent",
      "webhook_create_attempted_at" AS "webhookCreateAttemptedAt",
      "provider_webhook_id" AS "providerWebhookId",
      "encrypted_signing_secret" AS "encryptedSigningSecret",
      "webhook_status" AS "webhookStatus",
      "inbound_enabled" AS "inboundEnabled",
      "webhook_staging_sequence" AS "webhookStagingSequence"
    FROM "organization_receiving_connections"
    WHERE "organization_id" = ${organizationId}
  `;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((completed) => {
    resolve = completed;
  });
  return { promise, resolve };
}
