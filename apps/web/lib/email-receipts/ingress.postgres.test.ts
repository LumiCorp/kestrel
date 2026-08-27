import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PgBoss } from "pg-boss";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("signed Resend ingress converges durably and queue reconciliation preserves one intent", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
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
    route,
    queue,
    receiptStore,
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("@/lib/ai/gateway-credential-crypto"),
    import("@/lib/email/receiving-config"),
    import("@/app/api/webhooks/resend/inbound/[locator]/route"),
    import("@/lib/turns/queue"),
    import("./store"),
  ]);
  const sql = postgres(databaseUrl, { max: 10 });
  const boss = new PgBoss({ connectionString: databaseUrl, migrate: true });
  await boss.start();
  const suffix = randomUUID();
  const organizationId = `receipt-org-${suffix}`;
  const userId = `receipt-user-${suffix}`;
  const environmentId = `receipt-environment-${suffix}`;
  const connectionId = `receipt-connection-${suffix}`;
  const locator = randomBytes(32).toString("base64url");
  const signingSecret = `whsec_${randomBytes(32).toString("base64")}`;
  const encryptedSigningSecret = receiving.encryptReceivingSigningSecret({
    organizationId,
    signingSecret,
  });
  const encryptedApiKey = encryptGatewayCredential({
    gatewayId: `organization-receiving-connection:${organizationId}:api-key`,
    plaintext: "re_test_full_access",
  });
  const now = new Date();
  const telemetry: unknown[] = [];
  const originalInfo = console.info;
  const bossPrototype = PgBoss.prototype as unknown as {
    send: (...args: unknown[]) => Promise<string | null>;
  };
  const originalQueueSend = bossPrototype.send;
  console.info = (...values: unknown[]) => telemetry.push(values);

  context.after(async () => {
    console.info = originalInfo;
    bossPrototype.send = originalQueueSend;
    await queue.stopDurableThreadTurnWorker();
    await boss.stop({ graceful: true, timeout: 5000 });
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`
    INSERT INTO "user" (
      "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
    ) VALUES (
      ${userId}, 'Receipt User', ${`${userId}@example.test`}, true, ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (${organizationId}, 'Receipt Org', ${`receipt-${suffix}`}, ${now})
  `;
  await sql`
    INSERT INTO "environments" (
      "id", "organization_id", "created_by_user_id", "name", "slug",
      "region", "status", "is_default"
    ) VALUES (
      ${environmentId}, ${organizationId}, ${userId}, 'Receipt Environment',
      ${`receipt-${suffix}`}, 'iad', 'ready', true
    )
  `;
  await sql`
    INSERT INTO "organization_receiving_connections" (
      "id", "organization_id", "encrypted_api_key", "credential_status",
      "credential_validated_at", "receiving_domain_id", "receiving_domain",
      "receiving_domain_status", "mx_status", "domain_checked_at",
      "route_locator", "provider_webhook_id", "encrypted_signing_secret",
      "webhook_status", "inbound_enabled", "last_health_checked_at",
      "updated_by_user_id", "created_at", "updated_at"
    ) VALUES (
      ${connectionId}, ${organizationId}, ${encryptedApiKey}, 'full_access',
      ${now}, 'domain-1', 'inbound.example.test', 'verified', 'verified', ${now},
      ${locator}, ${`webhook-${suffix}`}, ${encryptedSigningSecret}, 'active',
      true, ${now}, ${userId}, ${now}, ${now}
    )
  `;
  for (const invalidTerminal of [
    { state: "queued", reason: "UNEXPECTED", finishedAt: null },
    { state: "queued", reason: null, finishedAt: now },
    { state: "failed", reason: null, finishedAt: null },
  ]) {
    await assert.rejects(sql`
      INSERT INTO "email_delivery_receipts" (
        "id", "organization_id", "receiving_connection_id", "svix_id",
        "resend_email_id", "event_at", "state", "reason", "finished_at",
        "reserved_thread_id", "reserved_message_id", "reserved_turn_id"
      ) VALUES (
        ${randomUUID()}, ${organizationId}, ${connectionId}, ${randomUUID()},
        ${randomUUID()}, ${now}, ${invalidTerminal.state},
        ${invalidTerminal.reason}, ${invalidTerminal.finishedAt}, ${randomUUID()},
        ${randomUUID()}, ${randomUUID()}
      )
    `);
  }

  const url = `http://localhost/api/webhooks/resend/inbound/${locator}`;
  const unknown = trackedBodyRequest(url, "unverified-body");
  const unknownResponse = await route.POST(unknown.request, {
    params: Promise.resolve({ locator: randomBytes(32).toString("base64url") }),
  });
  assert.equal(unknownResponse.status, 404);
  assert.equal(unknown.readCount(), 0);

  await sql`
    UPDATE "organization_receiving_connections"
    SET "inbound_enabled" = false, "webhook_status" = 'staged'
    WHERE "id" = ${connectionId}
  `;
  const disabled = trackedBodyRequest(url, "unverified-body");
  const disabledResponse = await route.POST(disabled.request, {
    params: Promise.resolve({ locator }),
  });
  assert.equal(disabledResponse.status, 404);
  assert.equal(disabled.readCount(), 0);
  await sql`
    UPDATE "organization_receiving_connections"
    SET "inbound_enabled" = true, "webhook_status" = 'active'
    WHERE "id" = ${connectionId}
  `;

  const emailId = `email-${suffix}`;
  const providerMessageId = `provider-message-${suffix}`;
  const event = receivedEvent({ emailId, providerMessageId });
  const invalid = await invokeSigned(route, url, locator, signingSecret, event, {
    signature: "v1,invalid",
  });
  assert.equal(invalid.status, 400);
  assert.equal(await receiptCount(sql, connectionId), 0);

  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
  const stale = await invokeSigned(route, url, locator, signingSecret, event, {
    timestamp: staleTimestamp,
  });
  assert.equal(stale.status, 400);
  assert.equal(await receiptCount(sql, connectionId), 0);

  const firstSvixId = `svix-${suffix}`;
  let throwAfterCommittedSend = true;
  bossPrototype.send = async function (...args: unknown[]) {
    const jobId = await Reflect.apply(originalQueueSend, this, args);
    if (
      throwAfterCommittedSend &&
      args[0] === queue.EMAIL_DELIVERY_RECEIPT_QUEUE
    ) {
      throwAfterCommittedSend = false;
      throw new Error("queue response lost after committed send");
    }
    return jobId;
  };
  const accepted = await invokeSigned(route, url, locator, signingSecret, event, {
    svixId: firstSvixId,
  });
  bossPrototype.send = originalQueueSend;
  assert.equal(accepted.status, 202);
  assert.equal(throwAfterCommittedSend, false);
  const firstBody = (await accepted.json()) as {
    receiptId: string;
    state: string;
  };
  assert.equal(firstBody.state, "queued");
  assert.doesNotMatch(JSON.stringify(firstBody), /email-|provider-message|svix-/u);

  const repeated = await invokeSigned(route, url, locator, signingSecret, event, {
    svixId: firstSvixId,
  });
  assert.equal(repeated.status, 202);
  assert.equal((await repeated.json()).receiptId, firstBody.receiptId);

  const replay = await invokeSigned(route, url, locator, signingSecret, event, {
    svixId: `svix-replay-${suffix}`,
  });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).receiptId, firstBody.receiptId);

  const concurrent = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      invokeSigned(route, url, locator, signingSecret, event, {
        svixId: `svix-concurrent-${index}-${suffix}`,
      }),
    ),
  );
  assert.equal(concurrent.every(({ status }) => status === 202), true);
  assert.deepEqual(
    new Set(await Promise.all(concurrent.map(async (response) => (await response.json()).receiptId))),
    new Set([firstBody.receiptId]),
  );

  const contradictory = await invokeSigned(
    route,
    url,
    locator,
    signingSecret,
    receivedEvent({
      emailId: `different-email-${suffix}`,
      providerMessageId: `different-message-${suffix}`,
    }),
    { svixId: firstSvixId },
  );
  assert.equal(contradictory.status, 503);
  assert.equal(await receiptCount(sql, connectionId), 1);

  const [receipt] = await sql<
    Array<{
      id: string;
      reservedThreadId: string;
      reservedMessageId: string;
      reservedTurnId: string;
      receivedForMailboxes: string[];
      state: string;
    }>
  >`
    SELECT "id", "reserved_thread_id" AS "reservedThreadId",
      "reserved_message_id" AS "reservedMessageId",
      "reserved_turn_id" AS "reservedTurnId",
      "received_for_mailboxes" AS "receivedForMailboxes", "state"
    FROM "email_delivery_receipts"
    WHERE "receiving_connection_id" = ${connectionId}
  `;
  assert.equal(receipt?.id, firstBody.receiptId);
  assert.equal(receipt?.state, "queued");
  assert.deepEqual(receipt?.receivedForMailboxes, ["trigger@example.test"]);
  assert.equal(
    new Set([
      receipt?.reservedThreadId,
      receipt?.reservedMessageId,
      receipt?.reservedTurnId,
    ]).size,
    3,
  );

  const omittedReceivedForEmailId = `sdk-shape-email-${suffix}`;
  const omittedReceivedFor = await invokeSigned(
    route,
    url,
    locator,
    signingSecret,
    receivedEvent({
      emailId: omittedReceivedForEmailId,
      providerMessageId: `sdk-shape-message-${suffix}`,
      includeReceivedFor: false,
    }),
  );
  assert.equal(omittedReceivedFor.status, 202);
  const [omittedReceivedForReceipt] = await sql<
    Array<{ receivedForMailboxes: string[] }>
  >`
    SELECT "received_for_mailboxes" AS "receivedForMailboxes"
    FROM "email_delivery_receipts"
    WHERE "receiving_connection_id" = ${connectionId}
      AND "resend_email_id" = ${omittedReceivedForEmailId}
  `;
  assert.deepEqual(omittedReceivedForReceipt?.receivedForMailboxes, []);

  const terminalEmailId = `terminal-email-${suffix}`;
  const terminalSvixId = `terminal-svix-${suffix}`;
  const terminalReceipt =
    await receiptStore.createOrFindQueuedEmailDeliveryReceipt({
      organizationId,
      receivingConnectionId: connectionId,
      svixId: terminalSvixId,
      resendEmailId: terminalEmailId,
      eventAt: now,
      claimedFrom: "terminal@example.test",
      toMailboxes: ["trigger@example.test"],
      ccMailboxes: [],
      bccMailboxes: [],
      receivedForMailboxes: [],
      subject: "Terminal replay",
    });
  await sql`
    UPDATE "email_delivery_receipts"
    SET "state" = 'failed', "reason" = 'HYDRATION_FAILED',
      "finished_at" = ${now}, "updated_at" = ${now}
    WHERE "id" = ${terminalReceipt.receipt.id}
  `;
  const terminalReplay = await invokeSigned(
    route,
    url,
    locator,
    signingSecret,
    receivedEvent({
      emailId: terminalEmailId,
      providerMessageId: `terminal-message-${suffix}`,
    }),
    { svixId: terminalSvixId },
  );
  assert.equal(terminalReplay.status, 202);
  assert.deepEqual(await terminalReplay.json(), {
    receiptId: terminalReceipt.receipt.id,
    state: "failed",
  });
  assert.equal(
    (
      await boss.findJobs(queue.EMAIL_DELIVERY_RECEIPT_QUEUE, {
        data: { receiptId: terminalReceipt.receipt.id },
      })
    ).length,
    0,
  );

  await boss.createQueue(queue.EMAIL_DELIVERY_RECEIPT_QUEUE);
  const receiptJobs = await boss.findJobs<{ receiptId?: string }>(
    queue.EMAIL_DELIVERY_RECEIPT_QUEUE,
    { data: { receiptId: firstBody.receiptId } },
  );
  assert.equal(receiptJobs.filter(({ state }) => state === "created").length, 1);

  const recoveryEmailId = `recovery-email-${suffix}`;
  const recoveryReceipt = await receiptStore.createOrFindQueuedEmailDeliveryReceipt({
    organizationId,
    receivingConnectionId: connectionId,
    svixId: `recovery-svix-${suffix}`,
    resendEmailId: recoveryEmailId,
    eventAt: now,
    claimedFrom: "recovery@example.test",
    toMailboxes: ["trigger@example.test"],
    ccMailboxes: [],
    bccMailboxes: [],
    receivedForMailboxes: ["trigger@example.test"],
    subject: "Recovery",
  });
  assert.equal(
    (
      await boss.findJobs(queue.EMAIL_DELIVERY_RECEIPT_QUEUE, {
        data: { receiptId: recoveryReceipt.receipt.id },
      })
    ).length,
    0,
  );
  await queue.reconcileEmailDeliveryReceiptQueue();
  assert.equal(
    (
      await boss.findJobs(queue.EMAIL_DELIVERY_RECEIPT_QUEUE, {
        data: { receiptId: recoveryReceipt.receipt.id },
      })
    ).some(({ state }) => state === "created"),
    true,
  );

  const materializedReceiptId = `materialized-receipt-${suffix}`;
  const materializedThreadId = `materialized-thread-${suffix}`;
  const materializedMessageId = `materialized-message-${suffix}`;
  const materializedTurnId = `materialized-turn-${suffix}`;
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "threads" (
        "id", "created_by_user_id", "organization_id", "origin", "mode",
        "interaction_mode", "workspace_mode", "is_public", "created_at", "updated_at"
      ) VALUES (
        ${materializedThreadId}, ${userId}, ${organizationId}, 'web', 'chat',
        'build', 'primary', false, ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "thread_messages" (
        "id", "thread_id", "role", "author_user_id", "search_text", "source", "created_at"
      ) VALUES (
        ${materializedMessageId}, ${materializedThreadId}, 'user', ${userId},
        '', 'web', ${now}
      )
    `;
    await transaction`
      INSERT INTO "thread_turns" (
        "id", "organization_id", "thread_id", "author_user_id",
        "input_message_id", "idempotency_key", "sequence", "queue_ordinal",
        "source", "requested_interaction_mode", "requested_environment_id",
        "status", "created_at", "updated_at"
      ) VALUES (
        ${materializedTurnId}, ${organizationId}, ${materializedThreadId}, ${userId},
        ${materializedMessageId}, ${`materialized:${suffix}`}, 1, 1, 'web',
        'build', ${environmentId}, 'queued', ${now}, ${now}
      )
    `;
    await transaction`
      INSERT INTO "email_delivery_receipts" (
        "id", "organization_id", "receiving_connection_id", "svix_id",
        "resend_email_id", "event_at", "state", "reserved_thread_id",
        "reserved_message_id", "reserved_turn_id",
        "materialized_thread_organization_id", "materialized_thread_id",
        "materialized_message_thread_id", "materialized_message_id",
        "materialized_turn_thread_id", "materialized_turn_id",
        "materialized_at", "created_at", "updated_at"
      ) VALUES (
        ${materializedReceiptId}, ${organizationId}, ${connectionId},
        ${`materialized-svix-${suffix}`}, ${`materialized-email-${suffix}`},
        ${now}, 'materialized', ${materializedThreadId}, ${materializedMessageId},
        ${materializedTurnId}, ${organizationId}, ${materializedThreadId},
        ${materializedThreadId}, ${materializedMessageId}, ${materializedThreadId},
        ${materializedTurnId}, ${now}, ${now}, ${now}
      )
    `;
  });
  await sql`DELETE FROM "thread_turns" WHERE "id" = ${materializedTurnId}`;
  const [afterTurnDelete] = await sql<
    Array<{
      materializedThreadId: string | null;
      materializedTurnThreadId: string | null;
      materializedTurnId: string | null;
    }>
  >`
    SELECT "materialized_thread_id" AS "materializedThreadId",
      "materialized_turn_thread_id" AS "materializedTurnThreadId",
      "materialized_turn_id" AS "materializedTurnId"
    FROM "email_delivery_receipts" WHERE "id" = ${materializedReceiptId}
  `;
  assert.equal(afterTurnDelete?.materializedThreadId, materializedThreadId);
  assert.equal(afterTurnDelete?.materializedTurnThreadId, null);
  assert.equal(afterTurnDelete?.materializedTurnId, null);
  await sql`DELETE FROM "thread_messages" WHERE "id" = ${materializedMessageId}`;
  const [afterMessageDelete] = await sql<
    Array<{
      materializedThreadId: string | null;
      materializedMessageThreadId: string | null;
      materializedMessageId: string | null;
    }>
  >`
    SELECT "materialized_thread_id" AS "materializedThreadId",
      "materialized_message_thread_id" AS "materializedMessageThreadId",
      "materialized_message_id" AS "materializedMessageId"
    FROM "email_delivery_receipts" WHERE "id" = ${materializedReceiptId}
  `;
  assert.equal(afterMessageDelete?.materializedThreadId, materializedThreadId);
  assert.equal(afterMessageDelete?.materializedMessageThreadId, null);
  assert.equal(afterMessageDelete?.materializedMessageId, null);
  await sql`DELETE FROM "threads" WHERE "id" = ${materializedThreadId}`;
  const [deletedMaterializedReceipt] = await sql<Array<{ count: string }>>`
    SELECT count(*)::text AS "count" FROM "email_delivery_receipts"
    WHERE "id" = ${materializedReceiptId}
  `;
  assert.equal(deletedMaterializedReceipt?.count, "0");

  const serializedTelemetry = JSON.stringify(telemetry);
  assert.doesNotMatch(serializedTelemetry, new RegExp(locator, "u"));
  assert.doesNotMatch(serializedTelemetry, /provider-message|sender@example/u);
  assert.doesNotMatch(serializedTelemetry, new RegExp(emailId, "u"));
});

function receivedEvent(input: {
  emailId: string;
  providerMessageId: string;
  includeReceivedFor?: boolean;
}) {
  const createdAt = new Date().toISOString();
  return {
    type: "email.received",
    created_at: createdAt,
    data: {
      email_id: input.emailId,
      created_at: createdAt,
      from: "Sender <sender@example.test>",
      to: ["trigger@example.test"],
      bcc: [],
      cc: [],
      message_id: input.providerMessageId,
      ...(input.includeReceivedFor === false
        ? {}
        : { received_for: ["trigger@example.test"] }),
      subject: "Private invoice subject",
      attachments: [],
    },
  };
}

async function invokeSigned(
  route: {
    POST(
      request: Request,
      context: { params: Promise<{ locator: string }> },
    ): Promise<Response>;
  },
  url: string,
  locator: string,
  signingSecret: string,
  event: ReturnType<typeof receivedEvent>,
  overrides: {
    svixId?: string;
    timestamp?: string;
    signature?: string;
  } = {},
) {
  const payload = JSON.stringify(event);
  const svixId = overrides.svixId ?? `svix-${randomUUID()}`;
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    overrides.signature ?? signSvix(signingSecret, svixId, timestamp, payload);
  return route.POST(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": timestamp,
        "svix-signature": signature,
      },
      body: payload,
    }),
    { params: Promise.resolve({ locator }) },
  );
}

function signSvix(
  secret: string,
  svixId: string,
  timestamp: string,
  payload: string,
) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const digest = createHmac("sha256", key)
    .update(`${svixId}.${timestamp}.${payload}`)
    .digest("base64");
  return `v1,${digest}`;
}

function trackedBodyRequest(url: string, body: string) {
  const request = new Request(url, { method: "POST", body });
  let reads = 0;
  Object.defineProperty(request, "text", {
    value: async () => {
      reads += 1;
      return body;
    },
  });
  return { request, readCount: () => reads };
}

async function receiptCount(
  sql: postgres.Sql,
  receivingConnectionId: string,
) {
  const [row] = await sql<Array<{ count: string }>>`
    SELECT count(*)::text AS "count" FROM "email_delivery_receipts"
    WHERE "receiving_connection_id" = ${receivingConnectionId}
  `;
  return Number(row?.count ?? 0);
}
