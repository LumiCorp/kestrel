import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0091_email_delivery_receipts.sql"),
  "utf8",
);
const schema = fs.readFileSync(
  path.resolve(directory, "../../drizzle/schema.ts"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(path.join(directory, "migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<Record<string, unknown>> };
const history = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/history-lock.json"),
    "utf8",
  ),
) as Record<string, string>;
const checksum = createHash("sha256").update(migration).digest("hex");

test("0091 is checksum-locked and models durable tenant-bound Delivery Receipts", () => {
  assert.equal(
    history["0091_email_delivery_receipts"],
    `1787922000000:${checksum}`,
  );
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0091_email_delivery_receipts",
    ),
    {
      idx: 91,
      version: "7",
      when: 1_787_922_000_000,
      tag: "0091_email_delivery_receipts",
      breakpoints: true,
    },
  );

  for (const source of [migration, schema]) {
    assert.match(source, /email_delivery_receipts_state_check/u);
    assert.match(
      source,
      /queued['"],?\s*['"]hydrating['"],?\s*['"]admitted['"],?\s*['"]materialized['"],?\s*['"]rejected['"],?\s*['"]failed/u,
    );
    assert.match(source, /email_delivery_receipts_reason_check/u);
    assert.match(source, /email_delivery_receipts_materialized_state_check/u);
    assert.match(source, /email_delivery_receipts_materialized_children_check/u);
    assert.match(source, /email_delivery_receipts_organization_connection_fk/u);
    assert.match(source, /email_delivery_receipts_organization_trigger_fk/u);
    assert.match(source, /email_delivery_receipts_organization_thread_fk/u);
  }

  assert.match(migration, /"reserved_thread_id" text NOT NULL/u);
  assert.match(migration, /"reserved_message_id" text NOT NULL/u);
  assert.match(migration, /"reserved_turn_id" text NOT NULL/u);
  assert.match(migration, /email_delivery_receipts_reserved_thread_idx/u);
  assert.match(migration, /email_delivery_receipts_reserved_message_idx/u);
  assert.match(migration, /email_delivery_receipts_reserved_turn_idx/u);
  assert.match(migration, /email_delivery_receipts_connection_svix_idx/u);
  assert.match(migration, /email_delivery_receipts_connection_email_idx/u);
  assert.match(
    migration,
    /email_delivery_receipts_organization_thread_fk[\s\S]*ON DELETE cascade/u,
  );
  assert.match(
    migration,
    /email_delivery_receipts_thread_message_fk[\s\S]*ON DELETE set null/u,
  );
  assert.match(
    migration,
    /email_delivery_receipts_thread_turn_fk[\s\S]*ON DELETE set null/u,
  );
  assert.match(migration, /webhook_create_intent/u);
  assert.match(migration, /webhook_create_attempted_at/u);
  assert.match(migration, /webhook_staging_sequence/u);
  assert.match(migration, /"received_for_mailboxes" jsonb/u);
  assert.doesNotMatch(migration, /raw_body|svix_signature|route_locator/u);
});
