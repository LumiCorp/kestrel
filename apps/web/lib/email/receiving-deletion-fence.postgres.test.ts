import "../../scripts/register-server-only.mjs";

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import type {
  CreatedResendWebhook,
  ResendReceivingDomain,
  ResendWebhookCreateIntent,
  ResendWebhookDecommissionProvider,
  ResendWebhookProjection,
  ResendWebhookUpdateEvidence,
} from "./receiving-provider";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("Organization deletion fences receipt, configuration, reconciliation, and in-flight webhook creation", async (context) => {
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
    { encryptGatewayCredential },
    receiving,
    staging,
    reconciliation,
    receiptStore,
    deletion,
    decommission,
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("@/lib/ai/gateway-credential-crypto"),
    import("./receiving-config"),
    import("./receiving-webhook-staging"),
    import("./receiving-webhook-reconciliation"),
    import("@/lib/email-receipts/store"),
    import("@/lib/organizations/deletion"),
    import("./receiving-decommission"),
  ]);
  const sql = postgres(databaseUrl, { max: 12 });
  const suffix = randomUUID();
  const userId = `receiving-fence-user-${suffix}`;
  const organizationIds: string[] = [];
  const operationIds: string[] = [];
  const now = new Date();

  context.after(async () => {
    for (const operationId of operationIds) {
      await sql`DELETE FROM "organization_deletion_operations" WHERE "id" = ${operationId}`;
    }
    for (const organizationId of organizationIds) {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    }
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`
    INSERT INTO "user" (
      "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
    ) VALUES (
      ${userId}, 'Receiving Fence User', ${`${userId}@example.test`}, true,
      ${now}, ${now}
    )
  `;

  async function insertFixture(input: {
    label: string;
    active?: boolean;
    providerWebhookId?: string | null;
  }) {
    const organizationId = `receiving-fence-${input.label}-${suffix}`;
    const connectionId = `receiving-fence-connection-${input.label}-${suffix}`;
    const routeLocator = `receiving-fence-locator-${input.label}-${suffix}`;
    const apiKey = `re_receiving_fence_${input.label}`;
    const providerWebhookId = input.providerWebhookId ?? null;
    const encryptedApiKey = encryptGatewayCredential({
      gatewayId: `organization-receiving-connection:${organizationId}:api-key`,
      plaintext: apiKey,
    });
    const encryptedSigningSecret = providerWebhookId
      ? receiving.encryptReceivingSigningSecret({
          organizationId,
          signingSecret: `whsec_receiving_fence_${input.label}`,
        })
      : null;
    organizationIds.push(organizationId);
    await sql`
      INSERT INTO "organization" (
        "id", "name", "slug", "createdAt", "lifecycle_state"
      ) VALUES (
        ${organizationId}, ${`Receiving Fence ${input.label}`},
        ${`receiving-fence-${input.label}-${suffix}`}, ${now}, 'active'
      )
    `;
    await sql`
      INSERT INTO "organization_receiving_connections" (
        "id", "organization_id", "encrypted_api_key", "credential_status",
        "credential_validated_at", "receiving_domain_id", "receiving_domain",
        "receiving_domain_status", "mx_status", "domain_checked_at",
        "route_locator", "provider_webhook_id", "encrypted_signing_secret",
        "webhook_staging_sequence", "webhook_status", "inbound_enabled",
        "last_health_checked_at", "updated_by_user_id", "created_at", "updated_at"
      ) VALUES (
        ${connectionId}, ${organizationId}, ${encryptedApiKey}, 'full_access',
        ${now}, 'domain-one', 'mail.example.test', 'verified', 'verified', ${now},
        ${routeLocator}, ${providerWebhookId}, ${encryptedSigningSecret}, 5,
        ${input.active ? "active" : "not_staged"}, ${input.active ?? false},
        ${now}, ${userId}, ${now}, ${now}
      )
    `;
    return {
      apiKey,
      connectionId,
      encryptedApiKey,
      encryptedSigningSecret,
      name: `Receiving Fence ${input.label}`,
      organizationId,
      providerWebhookId,
      routeLocator,
    };
  }

  async function requestDeletion(fixture: Awaited<ReturnType<typeof insertFixture>>) {
    const operation = await deletion.requestOrganizationDeletion({
      organizationId: fixture.organizationId,
      actorUserId: userId,
      confirmationName: fixture.name,
    });
    operationIds.push(operation.id);
    return operation;
  }

  const fenced = await insertFixture({
    label: "atomic",
    active: true,
    providerWebhookId: `webhook-atomic-${suffix}`,
  });
  await requestDeletion(fenced);
  const [fencedState] = await sql<
    Array<{
      lifecycleState: string;
      inboundEnabled: boolean;
      webhookStatus: string;
      stagingSequence: string;
      encryptedApiKey: string | null;
      encryptedSigningSecret: string | null;
      providerWebhookId: string | null;
    }>
  >`
    SELECT organization."lifecycle_state" AS "lifecycleState",
           receiving."inbound_enabled" AS "inboundEnabled",
           receiving."webhook_status" AS "webhookStatus",
           receiving."webhook_staging_sequence"::text AS "stagingSequence",
           receiving."encrypted_api_key" AS "encryptedApiKey",
           receiving."encrypted_signing_secret" AS "encryptedSigningSecret",
           receiving."provider_webhook_id" AS "providerWebhookId"
    FROM "organization" organization
    JOIN "organization_receiving_connections" receiving
      ON receiving."organization_id" = organization."id"
    WHERE organization."id" = ${fenced.organizationId}
  `;
  assert.deepEqual(fencedState, {
    lifecycleState: "deleting",
    inboundEnabled: false,
    webhookStatus: "disabled",
    stagingSequence: "6",
    encryptedApiKey: fenced.encryptedApiKey,
    encryptedSigningSecret: fenced.encryptedSigningSecret,
    providerWebhookId: fenced.providerWebhookId,
  });
  assert.equal(
    await receiving.resolveReceivingIngressAuthority(fenced.routeLocator),
    null,
  );

  const existingOperation = await insertFixture({
    label: "existing-operation",
    active: true,
    providerWebhookId: `webhook-existing-operation-${suffix}`,
  });
  const existingOperationId = `receiving-fence-existing-operation-${suffix}`;
  operationIds.push(existingOperationId);
  await sql`
    INSERT INTO "organization_deletion_operations" (
      "id", "organization_id", "organization_name", "status", "stage",
      "idempotency_key", "inventory", "created_at", "updated_at"
    ) VALUES (
      ${existingOperationId}, ${existingOperation.organizationId},
      ${existingOperation.name}, 'queued', 'organization.deletion.requested',
      ${`receiving-fence-existing:${suffix}`}, '{"environments":[]}'::jsonb,
      ${now}, ${now}
    )
  `;
  const returnedExisting = await requestDeletion(existingOperation);
  assert.equal(returnedExisting.id, existingOperationId);
  const [existingOperationState] = await sql<
    Array<{
      lifecycleState: string;
      inboundEnabled: boolean;
      stagingSequence: string;
    }>
  >`
    SELECT organization."lifecycle_state" AS "lifecycleState",
           receiving."inbound_enabled" AS "inboundEnabled",
           receiving."webhook_staging_sequence"::text AS "stagingSequence"
    FROM "organization" organization
    JOIN "organization_receiving_connections" receiving
      ON receiving."organization_id" = organization."id"
    WHERE organization."id" = ${existingOperation.organizationId}
  `;
  assert.deepEqual(existingOperationState, {
    lifecycleState: "deleting",
    inboundEnabled: false,
    stagingSequence: "6",
  });
  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId: existingOperation.organizationId,
      actorUserId: userId,
      receivingDomainId: "domain-one",
      provider: new BlockingProvider(),
    }),
    hasCode("RESEND_RECEIVING_ORGANIZATION_UNAVAILABLE"),
  );

  const rejectedProvider = new BlockingProvider();
  await assert.rejects(
    receiving.saveReceivingConnection({
      organizationId: fenced.organizationId,
      actorUserId: userId,
      receivingDomainId: "domain-one",
      provider: rejectedProvider,
    }),
    hasCode("RESEND_RECEIVING_ORGANIZATION_UNAVAILABLE"),
  );
  await assert.rejects(
    staging.stageReceivingWebhook({
      organizationId: fenced.organizationId,
      provider: rejectedProvider,
    }),
    hasCode("RESEND_RECEIVING_ORGANIZATION_UNAVAILABLE"),
  );
  assert.equal(rejectedProvider.providerCalls, 0);
  let reconciliationFactories = 0;
  assert.deepEqual(
    await reconciliation.reconcileConfiguredReceivingWebhooks({
      providerFactory: () => {
        reconciliationFactories += 1;
        return rejectedProvider;
      },
    }),
    { attempted: 0, failed: 0, staged: 0 },
  );
  assert.equal(reconciliationFactories, 0);
  await assert.rejects(
    receiptStore.createOrFindQueuedEmailDeliveryReceipt(
      receiptInput(fenced, "atomic"),
    ),
    (error: unknown) =>
      error instanceof receiptStore.EmailDeliveryReceiptUnavailableError,
  );

  const saveRace = await insertFixture({ label: "save-race" });
  const saveProvider = new BlockingProvider({ blockDomain: true });
  const saving = receiving.saveReceivingConnection({
    organizationId: saveRace.organizationId,
    actorUserId: userId,
    apiKey: saveRace.apiKey,
    receivingDomainId: "domain-one",
    provider: saveProvider,
  });
  await saveProvider.domainEntered;
  await requestDeletion(saveRace);
  saveProvider.releaseDomain();
  await assert.rejects(
    saving,
    hasCode("RESEND_RECEIVING_ORGANIZATION_UNAVAILABLE"),
  );
  assert.equal(saveProvider.createCalls, 0);

  const createRace = await insertFixture({ label: "create-race" });
  const createProvider = new BlockingProvider({ blockCreate: true });
  const stagingRun = staging.stageReceivingWebhook({
    organizationId: createRace.organizationId,
    provider: createProvider,
  });
  await createProvider.createEntered;
  let deletionSettled = false;
  const queuedDeletion = requestDeletion(createRace).finally(() => {
    deletionSettled = true;
  });
  await delay(25);
  assert.equal(deletionSettled, false);
  createProvider.releaseCreate();
  await queuedDeletion;
  await assert.rejects(stagingRun);
  const [createdBeforeFence] = await sql<
    Array<{
      providerWebhookId: string | null;
      lifecycleState: string;
      webhookStatus: string;
    }>
  >`
    SELECT receiving."provider_webhook_id" AS "providerWebhookId",
           organization."lifecycle_state" AS "lifecycleState",
           receiving."webhook_status" AS "webhookStatus"
    FROM "organization_receiving_connections" receiving
    JOIN "organization" organization ON organization."id" = receiving."organization_id"
    WHERE receiving."organization_id" = ${createRace.organizationId}
  `;
  assert.deepEqual(createdBeforeFence, {
    providerWebhookId: createProvider.webhook.id,
    lifecycleState: "deleting",
    webhookStatus: "disabled",
  });
  await decommission.decommissionOrganizationReceivingWebhook({
    organizationId: createRace.organizationId,
    provider: createProvider,
  });
  assert.equal(createProvider.webhooks.size, 0);

  const receiptRace = await insertFixture({
    label: "receipt-race",
    active: true,
    providerWebhookId: `webhook-receipt-${suffix}`,
  });
  const verifiedAuthority =
    await receiving.resolveReceivingIngressAuthority(receiptRace.routeLocator);
  assert.equal(verifiedAuthority?.available, true);
  let inFlightReceipt:
    | ReturnType<typeof receiptStore.createOrFindQueuedEmailDeliveryReceipt>
    | undefined;
  await sql.begin(async (fence) => {
    await fence`
      UPDATE "organization" SET "lifecycle_state" = 'deleting'
      WHERE "id" = ${receiptRace.organizationId}
    `;
    await fence`
      UPDATE "organization_receiving_connections"
      SET "inbound_enabled" = false, "webhook_status" = 'disabled',
          "webhook_staging_sequence" = "webhook_staging_sequence" + 1
      WHERE "organization_id" = ${receiptRace.organizationId}
    `;
    inFlightReceipt = receiptStore.createOrFindQueuedEmailDeliveryReceipt(
      receiptInput(receiptRace, "receipt-race"),
    );
    const outcome = await Promise.race([
      inFlightReceipt.then(() => "settled", () => "settled"),
      delay(25).then(() => "waiting"),
    ]);
    assert.equal(outcome, "waiting");
  });
  assert.ok(inFlightReceipt);
  await assert.rejects(
    inFlightReceipt,
    (error: unknown) =>
      error instanceof receiptStore.EmailDeliveryReceiptUnavailableError,
  );
  const [receiptCount] = await sql<Array<{ count: string }>>`
    SELECT count(*)::text AS "count" FROM "email_delivery_receipts"
    WHERE "organization_id" = ${receiptRace.organizationId}
  `;
  assert.equal(receiptCount?.count, "0");
});

function receiptInput(
  fixture: { organizationId: string; connectionId: string },
  label: string,
) {
  return {
    organizationId: fixture.organizationId,
    receivingConnectionId: fixture.connectionId,
    svixId: `svix-${label}-${randomUUID()}`,
    resendEmailId: `email-${label}-${randomUUID()}`,
    eventAt: new Date(),
    claimedFrom: "sender@example.test",
    toMailboxes: ["trigger@example.test"],
    ccMailboxes: [],
    bccMailboxes: [],
    receivedForMailboxes: ["trigger@example.test"],
    subject: "Deletion fence",
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class BlockingProvider implements ResendWebhookDecommissionProvider {
  readonly webhooks = new Map<string, ResendWebhookProjection>();
  readonly webhook = {
    id: `webhook-${randomUUID()}`,
    endpoint: "",
    status: "enabled" as const,
    events: ["email.received"] as ["email.received"],
    signingSecret: `whsec_${randomUUID()}`,
  };
  createCalls = 0;
  providerCalls = 0;
  readonly domainEntered: Promise<void>;
  readonly createEntered: Promise<void>;
  private enterDomain!: () => void;
  private continueDomain!: () => void;
  private enterCreate!: () => void;
  private continueCreate!: () => void;

  constructor(
    private readonly options: { blockDomain?: boolean; blockCreate?: boolean } = {},
  ) {
    this.domainEntered = new Promise((resolve) => {
      this.enterDomain = resolve;
    });
    this.createEntered = new Promise((resolve) => {
      this.enterCreate = resolve;
    });
  }

  releaseDomain() {
    this.continueDomain?.();
  }

  releaseCreate() {
    this.continueCreate?.();
  }

  async listDomains(): Promise<ResendReceivingDomain[]> {
    this.providerCalls += 1;
    return [verifiedDomain()];
  }

  async getDomain(): Promise<ResendReceivingDomain> {
    this.providerCalls += 1;
    this.enterDomain();
    if (this.options.blockDomain) {
      await new Promise<void>((resolve) => {
        this.continueDomain = resolve;
      });
    }
    return verifiedDomain();
  }

  async createWebhook(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }): Promise<CreatedResendWebhook> {
    this.providerCalls += 1;
    this.createCalls += 1;
    this.enterCreate();
    if (this.options.blockCreate) {
      await new Promise<void>((resolve) => {
        this.continueCreate = resolve;
      });
    }
    this.webhook.endpoint = input.intent.endpoint;
    this.webhooks.set(this.webhook.id, this.webhook);
    return { id: this.webhook.id, signingSecret: this.webhook.signingSecret };
  }

  async reconcileWebhookCreate(): Promise<CreatedResendWebhook> {
    this.providerCalls += 1;
    if (!this.webhooks.has(this.webhook.id)) throw new Error("not found");
    return { id: this.webhook.id, signingSecret: this.webhook.signingSecret };
  }

  async reconcileWebhookCreateIfPresent(): Promise<CreatedResendWebhook | null> {
    this.providerCalls += 1;
    return this.webhooks.has(this.webhook.id)
      ? { id: this.webhook.id, signingSecret: this.webhook.signingSecret }
      : null;
  }

  async getWebhook(
    _apiKey: string,
    webhookId: string,
  ): Promise<ResendWebhookProjection> {
    this.providerCalls += 1;
    const webhook = this.webhooks.get(webhookId);
    if (!webhook) throw new Error("not found");
    return { ...webhook, events: [...webhook.events] };
  }

  async getWebhookIfPresent(
    _apiKey: string,
    webhookId: string,
  ): Promise<ResendWebhookProjection | null> {
    this.providerCalls += 1;
    return this.webhooks.get(webhookId) ?? null;
  }

  async updateWebhook(input: {
    apiKey: string;
    webhookId: string;
    endpoint?: string;
    enabled?: boolean;
  }): Promise<ResendWebhookUpdateEvidence> {
    this.providerCalls += 1;
    const webhook = this.webhooks.get(input.webhookId);
    if (!webhook) throw new Error("not found");
    const status: "enabled" | "disabled" = input.enabled
      ? "enabled"
      : "disabled";
    this.webhooks.set(input.webhookId, { ...webhook, status });
    return { id: input.webhookId, applied: { status } };
  }

  async removeWebhook(_apiKey: string, webhookId: string) {
    this.providerCalls += 1;
    this.webhooks.delete(webhookId);
  }
}

function verifiedDomain(): ResendReceivingDomain {
  return {
    id: "domain-one",
    name: "mail.example.test",
    status: "verified",
    receiving: "enabled",
    mxStatus: "verified",
  };
}
