import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0092_email_delivery_attachments.sql"),
  "utf8",
);
const schema = fs.readFileSync(
  path.resolve(directory, "../../drizzle/schema.ts"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/_journal.json"),
    "utf8",
  ),
) as { entries: Array<Record<string, unknown>> };
const history = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/history-lock.json"),
    "utf8",
  ),
) as Record<string, string>;
const checksum = createHash("sha256").update(migration).digest("hex");

test("0092 is checksum-locked and models opaque ordered Delivery Attachments", () => {
  assert.equal(
    history["0092_email_delivery_attachments"],
    `1787925600000:${checksum}`,
  );
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0092_email_delivery_attachments",
    ),
    {
      idx: 92,
      version: "7",
      when: 1_787_925_600_000,
      tag: "0092_email_delivery_attachments",
      breakpoints: true,
    },
  );

  for (const source of [migration, schema]) {
    assert.match(source, /email_delivery_attachments/u);
    assert.match(source, /provider_attachment_id/u);
    assert.match(source, /provider_order/u);
    assert.match(source, /provider_size_bytes/u);
    assert.match(source, /declared_media_type/u);
    assert.match(source, /content_id/u);
    assert.match(
      source,
      /available['"],?\s*['"]importing['"],?\s*['"]ready['"],?\s*['"]failed/u,
    );
    assert.match(source, /email_delivery_attachments_failure_check/u);
    assert.match(source, /email_delivery_attachments_ready_file_check/u);
    assert.match(source, /email_delivery_attachments_organization_receipt_fk/u);
  }

  assert.match(migration, /email_delivery_attachments_receipt_provider_idx/u);
  assert.match(migration, /email_delivery_attachments_receipt_order_idx/u);
  assert.match(migration, /email_delivery_attachments_file_idx/u);
  assert.match(
    migration,
    /email_delivery_attachments_organization_receipt_fk[\s\S]*ON DELETE cascade/u,
  );
  assert.match(
    migration,
    /email_delivery_attachments_file_id_kestrel_files_id_fk[\s\S]*ON DELETE restrict/u,
  );
  assert.doesNotMatch(migration, /download_url|raw_url|credential/u);
});
