import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0087_organization_resend_receiving.sql"),
  "utf8",
);
const healthCheckSequenceMigration = fs.readFileSync(
  path.join(directory, "migrations/0088_receiving_health_check_sequence.sql"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(path.join(directory, "migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

test("Organization Resend receiving is additive, tenant-owned, and inactive", () => {
  assert.match(migration, /CREATE TABLE "organization_receiving_connections"/u);
  assert.match(migration, /UNIQUE INDEX "organization_receiving_connections_org_idx"/u);
  assert.match(migration, /UNIQUE INDEX "organization_receiving_connections_webhook_idx"/u);
  assert.match(migration, /"inbound_enabled" boolean DEFAULT false NOT NULL/u);
  assert.match(migration, /NOT "inbound_enabled" OR "webhook_status" = 'active'/u);
  assert.doesNotMatch(migration, /INSERT INTO|UPDATE "organization_email_config"/u);
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0087_organization_resend_receiving",
    ),
    {
      idx: 87,
      version: "7",
      when: 1_787_907_600_000,
      tag: "0087_organization_resend_receiving",
      breakpoints: true,
    },
  );
});

test("stored receiving health checks have a durable monotonic sequence", () => {
  assert.match(
    healthCheckSequenceMigration,
    /ADD COLUMN "health_check_sequence" bigint DEFAULT 0 NOT NULL/u,
  );
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0088_receiving_health_check_sequence",
    ),
    {
      idx: 88,
      version: "7",
      when: 1_787_911_200_000,
      tag: "0088_receiving_health_check_sequence",
      breakpoints: true,
    },
  );
});
