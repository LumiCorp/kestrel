import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("daily retention purges only terminal nonmaterialized receipt diagnostics after 30 days", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  const [{ resetDbRuntimeForTests }, retention] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./retention"),
  ]);
  const sql = postgres(databaseUrl, { max: 4 });
  const suffix = randomUUID();
  const ids = {
    organization: `retention-org-${suffix}`,
    connection: `retention-connection-${suffix}`,
    expired: `retention-expired-${suffix}`,
    boundary: `retention-boundary-${suffix}`,
    recent: `retention-recent-${suffix}`,
  };
  const now = new Date("2026-08-27T12:00:00.000Z");

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (${ids.organization}, 'Receipt Retention Org', ${`retention-${suffix}`}, ${now})
  `;
  await sql`
    INSERT INTO "organization_receiving_connections" (
      "id", "organization_id", "route_locator", "created_at", "updated_at"
    ) VALUES (
      ${ids.connection}, ${ids.organization}, ${randomBytes(32).toString("base64url")}, ${now}, ${now}
    )
  `;
  await insertTerminalReceipt(sql, {
    id: ids.expired,
    organizationId: ids.organization,
    connectionId: ids.connection,
    finishedAt: new Date("2026-07-27T11:59:59.999Z"),
  });
  await insertTerminalReceipt(sql, {
    id: ids.boundary,
    organizationId: ids.organization,
    connectionId: ids.connection,
    finishedAt: new Date("2026-07-28T12:00:00.000Z"),
  });
  await insertTerminalReceipt(sql, {
    id: ids.recent,
    organizationId: ids.organization,
    connectionId: ids.connection,
    finishedAt: new Date("2026-08-26T12:00:00.000Z"),
  });

  assert.equal(
    await retention.purgeExpiredTerminalEmailDeliveryReceipts({ now }),
    1,
  );
  const rows = await sql<Array<{ id: string; state: string; reason: string }>>`
    SELECT "id", "state", "reason"
    FROM "email_delivery_receipts"
    WHERE "organization_id" = ${ids.organization}
    ORDER BY "id"
  `;
  assert.deepEqual(
    Array.from(rows),
    [
      { id: ids.boundary, state: "failed", reason: "EMAIL_RECEIPT_ADDRESS_INVALID" },
      { id: ids.recent, state: "failed", reason: "EMAIL_RECEIPT_ADDRESS_INVALID" },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
});

async function insertTerminalReceipt(
  sql: postgres.Sql,
  input: {
    id: string;
    organizationId: string;
    connectionId: string;
    finishedAt: Date;
  },
) {
  await sql`
    INSERT INTO "email_delivery_receipts" (
      "id", "organization_id", "receiving_connection_id", "svix_id",
      "resend_email_id", "event_at", "state", "reason", "finished_at",
      "reserved_thread_id", "reserved_message_id", "reserved_turn_id",
      "created_at", "updated_at"
    ) VALUES (
      ${input.id}, ${input.organizationId}, ${input.connectionId}, ${randomUUID()},
      ${randomUUID()}, ${input.finishedAt}, 'failed', 'EMAIL_RECEIPT_ADDRESS_INVALID', ${input.finishedAt},
      ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${input.finishedAt}, ${input.finishedAt}
    )
  `;
}
