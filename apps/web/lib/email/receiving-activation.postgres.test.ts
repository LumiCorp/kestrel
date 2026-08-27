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

test("receiving activation verifies the staged webhook, fails closed, and recovers without another create", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.NEXT_PUBLIC_APP_URL = "https://one.example.test";
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });
  const buildIdentity = {
    revision: "a".repeat(40),
    source: "git" as const,
    version: "0.8.5",
  };
  process.env.KESTREL_EMAIL_RECEIVING_RELEASE_EVIDENCE_REVISION =
    buildIdentity.revision;
  process.env.KESTREL_EMAIL_RECEIVING_SECURITY_REVIEW_REVISION =
    buildIdentity.revision;

  const [{ resetDbRuntimeForTests }, receiving, activation, release] =
    await Promise.all([
      import("@/lib/db/runtime"),
      import("./receiving-config"),
      import("./receiving-activation"),
      import("./receiving-release-readiness"),
    ]);
  const sql = postgres(databaseUrl, { max: 6 });
  const suffix = randomUUID();
  const organizationId = `activation-org-${suffix}`;
  const userId = `activation-user-${suffix}`;
  const now = new Date();

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Activation User', ${`${userId}@example.test`}, true, ${now}, ${now})
  `;
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (${organizationId}, 'Activation Org', ${`activation-${suffix}`}, ${now})
  `;

  const provider = new ActivationProvider();
  await receiving.saveReceivingConnection({
    organizationId,
    actorUserId: userId,
    apiKey: "re_activation",
    receivingDomainId: "domain-one",
    provider,
  });
  assert.deepEqual(await readState(sql, organizationId), {
    inboundEnabled: false,
    webhookStatus: "staged",
    lastErrorCode: null,
  });
  assert.equal(provider.webhook.status, "disabled");
  await release.runReceivingReleaseReadiness({
    organizationId,
    actorUserId: userId,
    provider,
    buildIdentity,
  });

  provider.domainReady = false;
  await assert.rejects(
    activation.setReceivingInboundEnabled({
      organizationId,
      actorUserId: userId,
      enabled: true,
      provider,
      buildIdentity,
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_WEBHOOK_NOT_READY",
  );
  assert.equal(provider.webhook.status, "disabled");
  assert.deepEqual(await readState(sql, organizationId), {
    inboundEnabled: false,
    webhookStatus: "error",
    lastErrorCode: "RESEND_RECEIVING_WEBHOOK_ACTIVATION_FAILED",
  });
  provider.domainReady = true;

  provider.failEnableAfterAcceptance = true;
  await assert.rejects(
    activation.setReceivingInboundEnabled({
      organizationId,
      actorUserId: userId,
      enabled: true,
      provider,
      buildIdentity,
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_WEBHOOK_ACTIVATION_FAILED",
  );
  assert.equal(provider.webhook.status, "enabled");
  assert.deepEqual(await readState(sql, organizationId), {
    inboundEnabled: false,
    webhookStatus: "error",
    lastErrorCode: "RESEND_RECEIVING_WEBHOOK_ACTIVATION_FAILED",
  });

  await activation.setReceivingInboundEnabled({
    organizationId,
    actorUserId: userId,
    enabled: true,
    provider,
    buildIdentity,
  });
  assert.deepEqual(await readState(sql, organizationId), {
    inboundEnabled: true,
    webhookStatus: "active",
    lastErrorCode: null,
  });
  assert.equal(provider.createCalls, 1);

  provider.failDisable = true;
  await assert.rejects(
    activation.setReceivingInboundEnabled({
      organizationId,
      actorUserId: userId,
      enabled: false,
      provider,
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_WEBHOOK_DISABLE_FAILED",
  );
  assert.deepEqual(await readState(sql, organizationId), {
    inboundEnabled: false,
    webhookStatus: "error",
    lastErrorCode: "RESEND_RECEIVING_WEBHOOK_DISABLE_FAILED",
  });
  await assert.rejects(
    activation.setReceivingInboundEnabled({
      organizationId,
      actorUserId: userId,
      enabled: true,
      provider,
      buildIdentity,
    }),
    (error: unknown) =>
      error instanceof receiving.ReceivingConfigError &&
      error.code === "RESEND_RECEIVING_WEBHOOK_NOT_READY",
  );

  await activation.setReceivingInboundEnabled({
    organizationId,
    actorUserId: userId,
    enabled: false,
    provider,
  });
  assert.deepEqual(await readState(sql, organizationId), {
    inboundEnabled: false,
    webhookStatus: "disabled",
    lastErrorCode: null,
  });
  assert.equal(provider.webhook.status, "disabled");
  assert.equal(provider.createCalls, 1);
});

class ActivationProvider implements ResendWebhookCreateRecoveryProvider {
  createCalls = 0;
  domainReady = true;
  failDisable = false;
  failEnableAfterAcceptance = false;
  webhook: ResendWebhookProjection & { signingSecret: string } = {
    id: `activation-webhook-${randomUUID()}`,
    endpoint: "",
    status: "enabled",
    events: ["email.received"],
    signingSecret: `whsec_${randomUUID()}`,
  };

  async listDomains(): Promise<ResendReceivingDomain[]> {
    return [domain()];
  }

  async getDomain(_apiKey: string, id: string): Promise<ResendReceivingDomain> {
    return {
      ...domain(id),
      ...(this.domainReady ? {} : { mxStatus: "failed" as const }),
    };
  }

  async createWebhook(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }) {
    this.createCalls += 1;
    this.webhook.endpoint = input.intent.endpoint;
    return { id: this.webhook.id, signingSecret: this.webhook.signingSecret };
  }

  async reconcileWebhookCreate() {
    return { id: this.webhook.id, signingSecret: this.webhook.signingSecret };
  }

  async getWebhook(_apiKey: string, _webhookId: string) {
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
    if (input.endpoint) this.webhook.endpoint = input.endpoint;
    if (input.enabled !== undefined) {
      this.webhook.status = input.enabled ? "enabled" : "disabled";
      if (input.enabled && this.failEnableAfterAcceptance) {
        this.failEnableAfterAcceptance = false;
        throw new Error("provider accepted activation but response was lost");
      }
      if (!input.enabled && this.failDisable) {
        this.failDisable = false;
        throw new Error("provider disable is temporarily unavailable");
      }
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
    throw new Error("not used by activation");
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

async function readState(sql: postgres.Sql, organizationId: string) {
  const [row] = await sql<
    Array<{
      inboundEnabled: boolean;
      webhookStatus: string;
      lastErrorCode: string | null;
    }>
  >`
    SELECT "inbound_enabled" AS "inboundEnabled",
      "webhook_status" AS "webhookStatus",
      "last_error_code" AS "lastErrorCode"
    FROM "organization_receiving_connections"
    WHERE "organization_id" = ${organizationId}
  `;
  return row;
}
