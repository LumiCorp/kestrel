import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import type {
  ResendReceivingDomain,
  ResendReceivingProvider,
  ResendWebhookCreateIntent,
  ResendWebhookCreateRecoveryProvider,
  ResendWebhookProjection,
} from "./receiving-provider";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("maintenance stages healthy preconfigured webhooks once while isolating failures and redacting evidence", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.NEXT_PUBLIC_APP_URL = "https://one.example.test";
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });

  const [{ resetDbRuntimeForTests }, receiving, reconciliation] =
    await Promise.all([
      import("@/lib/db/runtime"),
      import("./receiving-config"),
      import("./receiving-webhook-reconciliation"),
    ]);
  const sql = postgres(databaseUrl, { max: 8 });
  const suffix = randomUUID();
  const userId = `reconciliation-user-${suffix}`;
  const organizationIds = {
    failing: `a-reconciliation-${suffix}`,
    healthy: `b-reconciliation-${suffix}`,
    ambiguous: `c-reconciliation-${suffix}`,
    active: `d-reconciliation-${suffix}`,
    staged: `e-reconciliation-${suffix}`,
    unhealthy: `f-reconciliation-${suffix}`,
    incomplete: `g-reconciliation-${suffix}`,
  } as const;
  const allOrganizationIds = Object.values(organizationIds);
  const now = new Date();

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" IN ${sql(allOrganizationIds)}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`
    INSERT INTO "user" (
      "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
    ) VALUES (
      ${userId}, 'Reconciliation User', ${`${userId}@example.test`}, true,
      ${now}, ${now}
    )
  `;
  for (const organizationId of allOrganizationIds) {
    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${organizationId}, 'Reconciliation Org',
        ${`reconciliation-${organizationId.slice(0, 1)}-${suffix}`}, ${now}
      )
    `;
    await receiving.saveReceivingConnection({
      organizationId,
      actorUserId: userId,
      apiKey: `re_${organizationId}`,
      receivingDomainId: "domain-one",
      provider: configurationOnlyProvider(),
    });
  }

  await sql`
    UPDATE "organization_receiving_connections"
    SET "webhook_status" = 'active', "inbound_enabled" = true
    WHERE "organization_id" = ${organizationIds.active}
  `;
  await sql`
    UPDATE "organization_receiving_connections"
    SET "webhook_status" = 'staged',
        "provider_webhook_id" = 'already-staged',
        "encrypted_signing_secret" = 'already-encrypted'
    WHERE "organization_id" = ${organizationIds.staged}
  `;
  await sql`
    UPDATE "organization_receiving_connections"
    SET "mx_status" = 'failed'
    WHERE "organization_id" = ${organizationIds.unhealthy}
  `;
  await sql`
    UPDATE "organization_receiving_connections"
    SET "provider_webhook_id" = 'incomplete-provider-evidence'
    WHERE "organization_id" = ${organizationIds.incomplete}
  `;

  const providers = new Map<string, RecoveryProvider>([
    [organizationIds.failing, new RecoveryProvider("permanent-failure")],
    [organizationIds.healthy, new RecoveryProvider("success")],
    [organizationIds.ambiguous, new RecoveryProvider("ambiguous-create")],
  ]);
  const providerRequests: string[] = [];
  const evidence: unknown[] = [];
  const providerFactory = (organizationId: string) => {
    providerRequests.push(organizationId);
    const provider = providers.get(organizationId);
    assert.ok(provider, `unexpected reconciliation candidate ${organizationId}`);
    return provider;
  };

  const first = await reconciliation.reconcileConfiguredReceivingWebhooks({
    limit: 2,
    providerFactory,
    report: (event) => evidence.push(event),
  });
  assert.deepEqual(first, { attempted: 2, failed: 1, staged: 1 });
  assert.deepEqual(providerRequests, [
    organizationIds.failing,
    organizationIds.healthy,
  ]);
  assert.equal((await readState(sql, organizationIds.failing)).webhookStatus, "error");
  assert.deepEqual(await readState(sql, organizationIds.healthy), {
    inboundEnabled: false,
    providerWebhookId: providers.get(organizationIds.healthy)?.webhook.id,
    webhookStatus: "staged",
  });

  const second = await reconciliation.reconcileConfiguredReceivingWebhooks({
    limit: 2,
    providerFactory,
    report: (event) => evidence.push(event),
  });
  assert.deepEqual(second, { attempted: 2, failed: 2, staged: 0 });
  assert.deepEqual(providerRequests.slice(2), [
    organizationIds.ambiguous,
    organizationIds.failing,
  ]);

  const third = await reconciliation.reconcileConfiguredReceivingWebhooks({
    limit: 2,
    providerFactory,
    report: (event) => evidence.push(event),
  });
  assert.deepEqual(third, { attempted: 2, failed: 1, staged: 1 });
  const ambiguousProvider = providers.get(organizationIds.ambiguous);
  assert.equal(ambiguousProvider?.createCalls, 1);
  assert.equal(ambiguousProvider?.reconcileCalls, 1);
  assert.deepEqual(await readState(sql, organizationIds.ambiguous), {
    inboundEnabled: false,
    providerWebhookId: ambiguousProvider?.webhook.id,
    webhookStatus: "staged",
  });
  assert.equal(ambiguousProvider?.webhook.status, "disabled");

  const serializedEvidence = JSON.stringify(evidence);
  for (const forbidden of [
    ...allOrganizationIds,
    "re_",
    "one.example.test",
    "inbound.example.test",
    "webhook-",
  ]) {
    assert.doesNotMatch(serializedEvidence, new RegExp(forbidden, "u"));
  }
  assert.ok(
    evidence.every(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "correlation" in event &&
        typeof event.correlation === "string" &&
        /^[a-f0-9]{16}$/u.test(event.correlation),
    ),
  );

  const stable = await reconciliation.reconcileConfiguredReceivingWebhooks({
    limit: 2,
    providerFactory,
    report: () => {
      throw new Error("telemetry sink unavailable");
    },
  });
  assert.deepEqual(stable, { attempted: 1, failed: 1, staged: 0 });
  assert.equal(providers.get(organizationIds.healthy)?.createCalls, 1);
  assert.equal(ambiguousProvider?.createCalls, 1);

  for (const skippedId of [
    organizationIds.active,
    organizationIds.staged,
    organizationIds.unhealthy,
    organizationIds.incomplete,
  ]) {
    assert.ok(!(providerRequests as string[]).includes(skippedId));
  }
});

class RecoveryProvider implements ResendWebhookCreateRecoveryProvider {
  createCalls = 0;
  reconcileCalls = 0;
  webhook: ResendWebhookProjection & { signingSecret: string } = {
    id: `webhook-${randomUUID()}`,
    endpoint: "",
    status: "enabled",
    events: ["email.received"],
    signingSecret: `whsec_${randomUUID()}`,
  };

  constructor(
    private readonly behavior:
      | "ambiguous-create"
      | "permanent-failure"
      | "success",
  ) {}

  async listDomains() {
    return [verifiedDomain()];
  }

  async getDomain() {
    return verifiedDomain();
  }

  async createWebhook(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }) {
    this.createCalls += 1;
    if (this.behavior === "permanent-failure") {
      throw new Error("provider unavailable");
    }
    this.webhook.endpoint = input.intent.endpoint;
    if (this.behavior === "ambiguous-create" && this.createCalls === 1) {
      throw new Error("provider accepted create but response was lost");
    }
    return { id: this.webhook.id, signingSecret: this.webhook.signingSecret };
  }

  async reconcileWebhookCreate() {
    this.reconcileCalls += 1;
    if (!this.webhook.endpoint) throw new Error("webhook was not created");
    return { id: this.webhook.id, signingSecret: this.webhook.signingSecret };
  }

  async getWebhook() {
    return { ...this.webhook, events: [...this.webhook.events] };
  }

  async updateWebhook(input: { enabled?: boolean }) {
    if (input.enabled !== undefined) {
      this.webhook.status = input.enabled ? "enabled" : "disabled";
    }
    return {
      id: this.webhook.id,
      applied: { status: this.webhook.status },
    };
  }

  async removeWebhook() {
    throw new Error("reconciliation never removes staged webhooks");
  }
}

function configurationOnlyProvider(): ResendReceivingProvider {
  return {
    async listDomains() {
      return [verifiedDomain()];
    },
    async getDomain() {
      return verifiedDomain();
    },
    async createWebhook() {
      throw new Error("configuration does not stage provider webhooks");
    },
    async getWebhook() {
      throw new Error("configuration does not read provider webhooks");
    },
    async updateWebhook() {
      throw new Error("configuration does not update provider webhooks");
    },
    async removeWebhook() {
      throw new Error("configuration does not remove provider webhooks");
    },
  };
}

function verifiedDomain(): ResendReceivingDomain {
  return {
    id: "domain-one",
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
      providerWebhookId: string | null;
      webhookStatus: string;
    }>
  >`
    SELECT
      "inbound_enabled" AS "inboundEnabled",
      "provider_webhook_id" AS "providerWebhookId",
      "webhook_status" AS "webhookStatus"
    FROM "organization_receiving_connections"
    WHERE "organization_id" = ${organizationId}
  `;
  assert.ok(row);
  return row;
}
