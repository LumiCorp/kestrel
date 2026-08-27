import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { createModelRegistrationV2 } from "../../../../src/kestrel/contracts/model-registration";
import { withGatewayModelEconomicsProfile } from "@/lib/ai/model-economics-profile";
import { createHostedModelRegistration } from "@/lib/ai/hosted-model-registration";
import { EmailReceiptProviderError } from "./provider";
import type { ReceivedEmailHydration, ReceivedEmailProvider } from "./provider";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("receipt hydration admits exactly one private Trigger and durably scrubs every nonmaterialized terminal outcome", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const previousDrizzleMaxConnections = process.env.DB_DRIZZLE_MAX_CONNECTIONS;
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.DB_DRIZZLE_MAX_CONNECTIONS = "1";
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test-key";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    "test-key": randomBytes(32).toString("base64"),
  });

  const [
    { resetDbRuntimeForTests },
    { encryptGatewayCredential },
    runtime,
    materializer,
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("@/lib/ai/gateway-credential-crypto"),
    import("./runtime"),
    import("./materialize"),
  ]);
  const sql = postgres(databaseUrl, { max: 6 });
  const suffix = randomUUID();
  const ids = {
    organization: `hydration-org-${suffix}`,
    user: `hydration-user-${suffix}`,
    member: `hydration-member-${suffix}`,
    fallbackOwner: `hydration-fallback-owner-${suffix}`,
    fallbackMember: `hydration-fallback-member-${suffix}`,
    environment: `hydration-environment-${suffix}`,
    project: `hydration-project-${suffix}`,
    connection: `hydration-connection-${suffix}`,
    triggerOne: `hydration-trigger-one-${suffix}`,
    triggerTwo: `hydration-trigger-two-${suffix}`,
    triggerDisabled: `hydration-trigger-disabled-${suffix}`,
    triggerRotated: `hydration-trigger-rotated-${suffix}`,
    context: `hydration-context-${suffix}`,
    gateway: `hydration-gateway-${suffix}`,
    model: `hydration-model-${suffix}`,
  };
  const now = new Date("2026-08-27T14:00:00.000Z");
  const encryptedApiKey = encryptGatewayCredential({
    gatewayId: `organization-receiving-connection:${ids.organization}:api-key`,
    plaintext: "re_test_full_access",
  });
  const modelMetadata = withGatewayModelEconomicsProfile({
    metadata: {
      context_length: 32_768,
      max_completion_tokens: 8_192,
      kestrelModelRegistrationV2: qualifiedOpenRouterRegistration(),
    },
    provider: "openrouter",
    model: "test-email-model",
    approved: true,
    modality: "language",
  });
  assert.ok(modelMetadata);

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
    await sql`DELETE FROM "user" WHERE "id" IN (${ids.user}, ${ids.fallbackOwner})`;
    await resetDbRuntimeForTests();
    if (previousDrizzleMaxConnections === undefined) {
      delete process.env.DB_DRIZZLE_MAX_CONNECTIONS;
    } else {
      process.env.DB_DRIZZLE_MAX_CONNECTIONS = previousDrizzleMaxConnections;
    }
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES
        (${ids.user}, 'Hydration User', ${`${ids.user}@example.test`}, true, ${now}, ${now}),
        (${ids.fallbackOwner}, 'Fallback Owner', ${`${ids.fallbackOwner}@example.test`}, true, ${now}, ${now})
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${ids.organization}, 'Hydration Org', ${`hydration-${suffix}`}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES
        (${ids.member}, ${ids.organization}, ${ids.user}, 'owner', ${now}),
        (${ids.fallbackMember}, ${ids.organization}, ${ids.fallbackOwner}, 'owner', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "region", "status", "is_default"
      ) VALUES (
        ${ids.environment}, ${ids.organization}, ${ids.user},
        'Hydration Environment', ${`hydration-${suffix}`}, 'iad', 'ready', true
      )
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES (
        ${ids.project}, ${ids.organization}, ${ids.environment}, ${ids.user},
        'Hydration Project'
      )
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES
        (${ids.project}, ${ids.member}, 'owner'),
        (${ids.project}, ${ids.fallbackMember}, 'owner')
    `;
    await transaction`
      INSERT INTO "project_context_revisions" (
        "id", "project_id", "revision", "project_name", "instructions",
        "created_by_user_id", "created_at"
      ) VALUES (
        ${ids.context}, ${ids.project}, 1, 'Hydration Project',
        'Use the current Project context.', ${ids.user}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "ai_gateways" (
        "id", "organization_id", "environment_id", "provider", "display_name",
        "credential_status", "credential_validated_at"
      ) VALUES (
        ${ids.gateway}, ${ids.organization}, NULL, 'openrouter', 'Hydration Gateway',
        'ready', ${now}
      )
    `;
    await transaction`
      INSERT INTO "ai_gateway_models" (
        "id", "organization_id", "gateway_id", "raw_model_id", "modality",
        "approved", "is_default", "metadata"
      ) VALUES (
        ${ids.model}, ${ids.organization}, ${ids.gateway}, 'test-email-model',
        'language', true, true,
        ${transaction.json(JSON.parse(JSON.stringify(modelMetadata)))}
      )
    `;
    await transaction`
      INSERT INTO "organization_receiving_connections" (
        "id", "organization_id", "encrypted_api_key", "credential_status",
        "credential_validated_at", "receiving_domain_id", "receiving_domain",
        "receiving_domain_status", "mx_status", "domain_checked_at",
        "route_locator", "provider_webhook_id", "encrypted_signing_secret",
        "webhook_status", "inbound_enabled", "last_health_checked_at",
        "created_at", "updated_at"
      ) VALUES (
        ${ids.connection}, ${ids.organization}, ${encryptedApiKey}, 'full_access',
        ${now}, 'domain-1', 'inbound.example.test', 'verified', 'verified', ${now},
        ${`locator-${suffix}`}, ${`webhook-${suffix}`}, 'encrypted-secret',
        'active', true, ${now}, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "project_email_triggers" (
        "id", "organization_id", "project_id", "created_by_user_id",
        "execution_owner_user_id", "name", "instruction", "model_id",
        "claimed_from_filter", "access_mode", "address_local_part",
        "address_domain", "enabled", "disabled_reason", "revision",
        "rotated_at", "created_at", "updated_at"
      ) VALUES
        (
          ${ids.triggerOne}, ${ids.organization}, ${ids.project}, ${ids.user},
          ${ids.user}, 'Invoice One', 'Process invoice', 'openrouter/test-email-model',
          'customer@example.com', 'private', 'one', 'inbound.example.test',
          true, null, 1, null, ${now}, ${now}
        ),
        (
          ${ids.triggerTwo}, ${ids.organization}, ${ids.project}, ${ids.user},
          ${ids.user}, 'Invoice Two', 'Process invoice', 'openrouter/test-email-model', null,
          'private', 'two', 'inbound.example.test', true, null, 1, null,
          ${now}, ${now}
        ),
        (
          ${ids.triggerDisabled}, ${ids.organization}, ${ids.project},
          ${ids.user}, ${ids.user}, 'Disabled', 'Process invoice', 'openrouter/test-email-model',
          null, 'private', 'disabled', 'inbound.example.test', false, 'manual',
          2, null, ${now}, ${now}
        ),
        (
          ${ids.triggerRotated}, ${ids.organization}, ${ids.project},
          ${ids.user}, ${ids.user}, 'Rotated', 'Process invoice', 'openrouter/test-email-model',
          null, 'private', 'new-address', 'inbound.example.test', true, null,
          2, ${now}, ${now}, ${now}
        )
    `;
  });

  const interruptedId = await insertReceipt(sql, ids, "hydrating");
  const interruptedProvider = fixedProvider(
    email({
      to: ["Invoice Trigger <ONE@INBOUND.EXAMPLE.TEST>"],
      attachments: [attachment("provider-a"), attachment("provider-b")],
    }),
  );
  assert.deepEqual(
    await runtime.processEmailDeliveryReceipt(interruptedId, {
      provider: interruptedProvider,
    }),
    { outcome: "admitted" },
  );
  const [admitted] = await sql<
    Array<{
      state: string;
      triggerId: string | null;
      triggerRevision: number | null;
      textBody: string | null;
      htmlBody: string | null;
    }>
  >`
    SELECT
      "state", "trigger_id" AS "triggerId",
      "trigger_revision" AS "triggerRevision", "text_body" AS "textBody",
      "html_body" AS "htmlBody"
    FROM "email_delivery_receipts"
    WHERE "id" = ${interruptedId}
  `;
  assert.deepEqual(admitted, {
    state: "admitted",
    triggerId: ids.triggerOne,
    triggerRevision: 1,
    textBody: "Please process this invoice.",
    htmlBody: null,
  });
  const descriptorRows = await sql<
    Array<{
      id: string;
      providerAttachmentId: string;
      providerOrder: number;
    }>
  >`
    SELECT
      "id", "provider_attachment_id" AS "providerAttachmentId",
      "provider_order" AS "providerOrder"
    FROM "email_delivery_attachments"
    WHERE "receipt_id" = ${interruptedId}
    ORDER BY "provider_order"
  `;
  assert.deepEqual(
    descriptorRows.map((row) => row.providerOrder),
    [0, 1],
  );
  assert.deepEqual(
    descriptorRows.map((row) => row.providerAttachmentId),
    ["provider-a", "provider-b"],
  );
  assert.ok(
    descriptorRows.every(
      (row) => row.id !== row.providerAttachmentId && isUuid(row.id),
    ),
  );
  const envelope = await runtime.readAdmittedEmailEnvelope(interruptedId);
  assert.ok(envelope);
  assert.deepEqual(
    envelope.attachments.map((value) => value.order),
    [0, 1],
  );
  assert.doesNotMatch(
    JSON.stringify(envelope),
    /provider-a|provider-b|resend|download_url|signed\.resend/u,
  );

  const [firstMaterialized, replayedMaterialization] = await Promise.all([
    materializer.materializeAdmittedEmailDeliveryReceipt(interruptedId),
    materializer.materializeAdmittedEmailDeliveryReceipt(interruptedId),
  ]);
  assert.ok(firstMaterialized?.turnId);
  assert.equal(firstMaterialized.turnId, replayedMaterialization?.turnId);
  const [materialized] = await sql<
    Array<{
      state: string;
      receiptThreadId: string | null;
      receiptMessageId: string | null;
      receiptTurnId: string | null;
      reservedThreadId: string;
      reservedMessageId: string;
      reservedTurnId: string;
      workspaceMode: string | null;
      isPublic: boolean | null;
      authorUserId: string | null;
      messageParts: unknown;
      requestedEnvironmentId: string | null;
      requestedModelId: string | null;
      requestedInteractionMode: string | null;
    }>
  >`
    SELECT
      receipt."state", receipt."materialized_thread_id" AS "receiptThreadId",
      receipt."materialized_message_id" AS "receiptMessageId",
      receipt."materialized_turn_id" AS "receiptTurnId",
      receipt."reserved_thread_id" AS "reservedThreadId",
      receipt."reserved_message_id" AS "reservedMessageId",
      receipt."reserved_turn_id" AS "reservedTurnId",
      thread."workspace_mode" AS "workspaceMode", thread."is_public" AS "isPublic",
      turn."author_user_id" AS "authorUserId", message."parts" AS "messageParts",
      turn."requested_environment_id" AS "requestedEnvironmentId",
      turn."requested_model_id" AS "requestedModelId",
      turn."requested_interaction_mode" AS "requestedInteractionMode"
    FROM "email_delivery_receipts" receipt
    LEFT JOIN "threads" thread ON thread."id" = receipt."materialized_thread_id"
    LEFT JOIN "thread_messages" message ON message."id" = receipt."materialized_message_id"
    LEFT JOIN "thread_turns" turn ON turn."id" = receipt."materialized_turn_id"
    WHERE receipt."id" = ${interruptedId}
  `;
  assert.ok(materialized);
  assert.deepEqual(
    {
      state: materialized.state,
      threadId: materialized.receiptThreadId,
      messageId: materialized.receiptMessageId,
      turnId: materialized.receiptTurnId,
      workspaceMode: materialized.workspaceMode,
      isPublic: materialized.isPublic,
      authorUserId: materialized.authorUserId,
      requestedEnvironmentId: materialized.requestedEnvironmentId,
      requestedModelId: materialized.requestedModelId,
      requestedInteractionMode: materialized.requestedInteractionMode,
    },
    {
      state: "materialized",
      threadId: materialized.reservedThreadId,
      messageId: materialized.reservedMessageId,
      turnId: materialized.reservedTurnId,
      workspaceMode: "primary",
      isPublic: false,
      authorUserId: ids.user,
      requestedEnvironmentId: ids.environment,
      requestedModelId: "openrouter/test-email-model",
      requestedInteractionMode: "build",
    },
  );
  const materializedText = JSON.stringify(materialized.messageParts);
  assert.match(materializedText, /untrusted external input/u);
  assert.match(materializedText, /Kestrel received email envelope v1/u);
  assert.match(materializedText, /Process invoice/u);
  assert.match(materializedText, /Please process this invoice/u);
  assert.match(
    materializedText,
    new RegExp(descriptorRows[0]?.id ?? "^$", "u"),
  );
  assert.doesNotMatch(
    materializedText,
    /provider-a|provider-b|resend|download_url/u,
  );

  const htmlOnlyId = await insertReceipt(sql, ids, "queued");
  await runtime.processEmailDeliveryReceipt(htmlOnlyId, {
    provider: fixedProvider(
      email({ text: null, html: "<p>HTML-only invoice</p>" }),
    ),
  });
  assert.deepEqual(await receiptOutcome(sql, htmlOnlyId), {
    state: "admitted",
    reason: null,
    textBody: "HTML-only invoice",
  });

  const retryId = await insertReceipt(sql, ids, "queued");
  const retryingProvider = temporaryThen(
    email({ attachments: [attachment("provider-retry")] }),
  );
  await assert.rejects(
    runtime.processEmailDeliveryReceipt(retryId, {
      provider: retryingProvider,
    }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      Reflect.get(error, "code") === "EMAIL_RECEIPT_PROVIDER_TEMPORARY",
  );
  assert.deepEqual(await receiptOutcome(sql, retryId), {
    state: "hydrating",
    reason: null,
    textBody: null,
  });
  await runtime.processEmailDeliveryReceipt(retryId, {
    provider: retryingProvider,
  });
  await runtime.processEmailDeliveryReceipt(retryId, {
    provider: retryingProvider,
  });
  const [{ count: retryAttachmentCount }] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS "count"
    FROM "email_delivery_attachments"
    WHERE "receipt_id" = ${retryId}
  `;
  assert.equal(retryAttachmentCount, 1);

  await expectTerminal({
    sql,
    runtime,
    ids,
    provider: fixedProvider(email({ to: ["not-an-address"] })),
    state: "rejected",
    reason: "EMAIL_RECEIPT_ADDRESS_INVALID",
  });
  await expectTerminal({
    sql,
    runtime,
    ids,
    provider: fixedProvider(
      email({
        to: ["one@inbound.example.test", "two@inbound.example.test"],
      }),
    ),
    state: "rejected",
    reason: "EMAIL_RECEIPT_TRIGGER_AMBIGUOUS",
  });
  await expectTerminal({
    sql,
    runtime,
    ids,
    provider: fixedProvider(email({ to: ["disabled@inbound.example.test"] })),
    state: "rejected",
    reason: "EMAIL_RECEIPT_TRIGGER_DISABLED",
  });
  await expectTerminal({
    sql,
    runtime,
    ids,
    provider: fixedProvider(
      email({ to: ["old-address@inbound.example.test"] }),
    ),
    state: "rejected",
    reason: "EMAIL_RECEIPT_TRIGGER_NOT_FOUND",
  });

  const scrubbedId = await insertReceipt(sql, ids, "hydrating", true);
  await sql`
    INSERT INTO "email_delivery_attachments" (
      "id", "organization_id", "receipt_id", "provider_attachment_id",
      "provider_order", "filename", "declared_media_type",
      "provider_size_bytes", "disposition", "content_id", "import_state"
    ) VALUES (
      ${randomUUID()}, ${ids.organization}, ${scrubbedId}, 'provider-private',
      0, 'private.pdf', 'application/pdf', 42, 'attachment', 'private-content',
      'available'
    )
  `;
  await runtime.processEmailDeliveryReceipt(scrubbedId, {
    provider: fixedProvider(email({ from: "other@example.com" })),
  });
  assert.deepEqual(await receiptOutcome(sql, scrubbedId), {
    state: "rejected",
    reason: "EMAIL_RECEIPT_CLAIMED_FROM_MISMATCH",
    textBody: null,
  });
  const [scrubbed] = await sql<Array<Record<string, unknown>>>`
    SELECT
      "claimed_from", "to_mailboxes", "cc_mailboxes", "bcc_mailboxes",
      "received_for_mailboxes", "reply_to_mailboxes", "subject", "text_body",
      "html_body"
    FROM "email_delivery_receipts"
    WHERE "id" = ${scrubbedId}
  `;
  assert.ok(scrubbed);
  assert.ok(Object.values(scrubbed).every((value) => value === null));
  const [{ count: scrubbedAttachmentCount }] = await sql<
    Array<{ count: number }>
  >`
    SELECT count(*)::int AS "count"
    FROM "email_delivery_attachments"
    WHERE "receipt_id" = ${scrubbedId}
  `;
  assert.equal(scrubbedAttachmentCount, 0);

  await expectTerminal({
    sql,
    runtime,
    ids,
    provider: fixedProvider(email({ text: " ", html: "<script>x</script>" })),
    state: "failed",
    reason: "EMAIL_RECEIPT_BODY_UNUSABLE",
  });
  await expectTerminal({
    sql,
    runtime,
    ids,
    provider: failingProvider("EMAIL_RECEIPT_PROVIDER_PERMANENT", false),
    state: "failed",
    reason: "EMAIL_RECEIPT_PROVIDER_PERMANENT",
  });

  const disabledReceivingId = await insertReceipt(sql, ids, "queued");
  await runtime.processEmailDeliveryReceipt(disabledReceivingId, {
    provider: fixedProvider(email()),
  });
  await sql`
    UPDATE "organization_receiving_connections"
    SET "inbound_enabled" = false
    WHERE "id" = ${ids.connection}
  `;
  assert.deepEqual(
    await materializer.materializeAdmittedEmailDeliveryReceipt(
      disabledReceivingId,
    ),
    { turnId: null, shouldDispatch: false },
  );
  assert.deepEqual(await receiptOutcome(sql, disabledReceivingId), {
    state: "rejected",
    reason: "EMAIL_RECEIPT_RECEIVING_UNAVAILABLE",
    textBody: null,
  });
  await sql`
    UPDATE "organization_receiving_connections"
    SET "inbound_enabled" = true
    WHERE "id" = ${ids.connection}
  `;

  const ownerLossId = await insertReceipt(sql, ids, "queued");
  await runtime.processEmailDeliveryReceipt(ownerLossId, {
    provider: fixedProvider(email()),
  });
  await sql`
    DELETE FROM "project_members"
    WHERE "project_id" = ${ids.project} AND "organization_member_id" = ${ids.member}
  `;
  assert.deepEqual(
    await materializer.materializeAdmittedEmailDeliveryReceipt(ownerLossId),
    { turnId: null, shouldDispatch: false },
  );
  assert.deepEqual(await receiptOutcome(sql, ownerLossId), {
    state: "rejected",
    reason: "EMAIL_RECEIPT_EXECUTION_OWNER_ACCESS_LOST",
    textBody: null,
  });
  const [disabledTrigger] = await sql<
    Array<{ enabled: boolean; disabledReason: string | null }>
  >`
    SELECT "enabled", "disabled_reason" AS "disabledReason"
    FROM "project_email_triggers"
    WHERE "id" = ${ids.triggerOne}
  `;
  assert.deepEqual(disabledTrigger, {
    enabled: false,
    disabledReason: "execution_owner_access_lost",
  });
});

function qualifiedOpenRouterRegistration() {
  const pending = createHostedModelRegistration({
    registrationId: "email-receipt-test-openrouter-model",
    revision: "email-receipt-test-registration-1",
    observedAt: "2026-08-27T14:00:00.000Z",
    modelId: "test-email-model",
    credentialRevision: "1",
    providerConfiguration: {
      version: "provider_runtime_configuration_v1",
      providerId: "openrouter",
      protocol: "openrouter",
      authentication: {
        mode: "required",
        credentialReference: {
          source: "hosted",
          id: "provider.openrouter.hosted",
        },
      },
      endpoint: "https://openrouter.example/api/v1",
      timeoutMs: 15_000,
      allowedHeaders: [],
      dataHandling: "provider_managed",
    },
    providerEvidence: {
      provider: "openrouter",
      details: {
        id: "test-email-model",
        supported_parameters: [
          "response_format",
          "tools",
          "tool_choice",
          "strict_tool_inputs",
        ],
        endpoints: [
          {
            id: "email-receipt-test-endpoint",
            supported_parameters: [
              "response_format",
              "tools",
              "tool_choice",
              "strict_tool_inputs",
            ],
          },
        ],
      },
    },
  }).registration;
  const { fingerprint: _fingerprint, ...authoring } = pending;
  const evidence = {
    source: "qualification" as const,
    observedRevision: authoring.revision,
    observedAt: "2026-08-27T14:00:01.000Z",
    adapterRevision: authoring.adapterRevision,
    credentialRevision: "1",
    qualificationRevision: "hosted-agent-loop-v1",
    retainedPayloadHash: `sha256:${"a".repeat(64)}`,
  };
  const qualified = <T extends { evidence: readonly unknown[] }>(claim: T) => ({
    ...claim,
    state: "qualified" as const,
    evidence: [...claim.evidence, evidence],
  });
  return createModelRegistrationV2({
    ...authoring,
    qualification: {
      state: "qualified",
      revision: "hosted-agent-loop-v1",
      checkedAt: "2026-08-27T14:00:01.000Z",
      probeHash: `sha256:${"b".repeat(64)}`,
    },
    capabilities: {
      ...authoring.capabilities,
      providerStrictSchema: qualified(
        authoring.capabilities.providerStrictSchema,
      ),
      nativeTools: qualified(authoring.capabilities.nativeTools),
      requiredToolChoice: qualified(authoring.capabilities.requiredToolChoice),
      strictToolInputs: qualified(authoring.capabilities.strictToolInputs),
    },
  });
}

type TestIds = {
  organization: string;
  connection: string;
};

async function insertReceipt(
  sql: postgres.Sql,
  ids: TestIds,
  state: "queued" | "hydrating",
  withPrivateContent = false,
) {
  const id = `hydration-receipt-${randomUUID()}`;
  await sql`
    INSERT INTO "email_delivery_receipts" (
      "id", "organization_id", "receiving_connection_id", "svix_id",
      "resend_email_id", "event_at", "state", "claimed_from", "to_mailboxes",
      "cc_mailboxes", "bcc_mailboxes", "received_for_mailboxes",
      "reply_to_mailboxes", "subject", "text_body", "html_body",
      "reserved_thread_id", "reserved_message_id", "reserved_turn_id"
    ) VALUES (
      ${id}, ${ids.organization}, ${ids.connection}, ${randomUUID()},
      ${`email-${randomUUID()}`}, now(), ${state},
      ${withPrivateContent ? "private-sender@example.com" : "sender@example.com"},
      ${sql.json(["private-recipient@example.com"])}, ${sql.json([])},
      ${sql.json([])}, ${sql.json(["private-received@example.com"])},
      ${sql.json(["private-reply@example.com"])},
      ${withPrivateContent ? "Private subject" : "Ingress subject"},
      ${withPrivateContent ? "Private body" : null},
      ${withPrivateContent ? "<p>Private HTML</p>" : null},
      ${randomUUID()}, ${randomUUID()}, ${randomUUID()}
    )
  `;
  return id;
}

function email(
  overrides: Partial<ReceivedEmailHydration> = {},
): ReceivedEmailHydration {
  return {
    id: "provider-email-id-is-not-model-visible",
    from: "Customer <customer@example.com>",
    to: ["one@inbound.example.test"],
    cc: [],
    bcc: [],
    replyTo: ["reply@example.com"],
    subject: "Invoice request",
    text: "Please process this invoice.",
    html: null,
    attachments: [],
    ...overrides,
  };
}

function attachment(providerAttachmentId: string) {
  return {
    providerAttachmentId,
    filename: "invoice.pdf",
    declaredMediaType: "application/pdf",
    providerSizeBytes: 42,
    disposition: "attachment",
    contentId: "invoice-content-id",
  };
}

function fixedProvider(value: ReceivedEmailHydration): ReceivedEmailProvider {
  return {
    retrieve: async () => value,
    downloadAttachment: unexpectedAttachmentDownload,
  };
}

function temporaryThen(value: ReceivedEmailHydration): ReceivedEmailProvider {
  let temporary = true;
  return {
    async retrieve() {
      if (temporary) {
        temporary = false;
        throw new EmailReceiptProviderError(
          "EMAIL_RECEIPT_PROVIDER_TEMPORARY",
          true,
        );
      }
      return value;
    },
    downloadAttachment: unexpectedAttachmentDownload,
  };
}

function failingProvider(
  code: ConstructorParameters<typeof EmailReceiptProviderError>[0],
  retryable: boolean,
): ReceivedEmailProvider {
  return {
    async retrieve() {
      throw new EmailReceiptProviderError(code, retryable);
    },
    downloadAttachment: unexpectedAttachmentDownload,
  };
}

async function unexpectedAttachmentDownload(): Promise<never> {
  throw new Error(
    "Attachment download is not expected during receipt hydration.",
  );
}

async function expectTerminal(input: {
  sql: postgres.Sql;
  runtime: typeof import("./runtime");
  ids: TestIds;
  provider: ReceivedEmailProvider;
  state: "rejected" | "failed";
  reason: string;
}) {
  const receiptId = await insertReceipt(input.sql, input.ids, "queued");
  await input.runtime.processEmailDeliveryReceipt(receiptId, {
    provider: input.provider,
  });
  assert.deepEqual(await receiptOutcome(input.sql, receiptId), {
    state: input.state,
    reason: input.reason,
    textBody: null,
  });
}

async function receiptOutcome(sql: postgres.Sql, receiptId: string) {
  const [row] = await sql<
    Array<{ state: string; reason: string | null; textBody: string | null }>
  >`
    SELECT "state", "reason", "text_body" AS "textBody"
    FROM "email_delivery_receipts"
    WHERE "id" = ${receiptId}
  `;
  return row;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
}
