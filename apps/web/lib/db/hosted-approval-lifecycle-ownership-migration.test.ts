import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(
    directory,
    "migrations/0084_hosted_approval_lifecycle_ownership.sql",
  ),
  "utf8",
);
const schema = fs.readFileSync(
  path.join(directory, "../../drizzle/schema.ts"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(path.join(directory, "migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<Record<string, unknown>> };
const historyLock = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/history-lock.json"),
    "utf8",
  ),
) as Record<string, string>;

test("hosted approval migration separates legacy decisions from V2 provider availability", () => {
  for (const column of [
    "lifecycle_version",
    "interaction_id",
    "availability_status",
  ]) {
    assert.match(migration, new RegExp(`"${column}"`, "u"));
  }

  assert.match(migration, /DEFAULT 'legacy_v1' NOT NULL/u);
  assert.match(migration, /ALTER COLUMN "status" DROP NOT NULL/u);
  assert.match(migration, /'legacy_v1', 'interaction_v2'/u);
  assert.match(migration, /'available', 'consumed', 'expired'/u);
  assert.match(
    schema,
    /lifecycleVersion: text\("lifecycle_version", \{[\s\S]*enum: \["legacy_v1", "interaction_v2"\]/u,
  );
  assert.match(
    schema,
    /interactionId: text\("interaction_id"\)\.references/u,
  );
  assert.match(
    schema,
    /availabilityStatus: text\("availability_status", \{[\s\S]*enum: \["available", "consumed", "expired"\]/u,
  );
  assert.match(
    migration,
    /"lifecycle_version" = 'interaction_v2'[\s\S]*"status" IS NULL[\s\S]*"decided_by_user_id" IS NULL[\s\S]*"decided_at" IS NULL/u,
  );
  assert.match(
    migration,
    /"availability_status" = 'available'[\s\S]*"consumed_execution_id" IS NULL[\s\S]*"consumed_at" IS NULL/u,
  );
  const availableShape = migration.match(
    /"availability_status" = 'available'([\s\S]*?)\)\s*OR\s*\(/u,
  )?.[1];
  assert.ok(availableShape);
  assert.doesNotMatch(availableShape, /"interaction_id" IS NOT NULL/u);
  assert.match(
    migration,
    /"availability_status" = 'consumed'[\s\S]*"interaction_id" IS NOT NULL[\s\S]*"consumed_execution_id" IS NOT NULL[\s\S]*"consumed_at" IS NOT NULL/u,
  );
  assert.match(
    migration,
    /"availability_status" = 'expired'[\s\S]*"interaction_id" IS NOT NULL[\s\S]*"consumed_execution_id" IS NULL[\s\S]*"consumed_at" IS NULL/u,
  );
  assert.match(
    migration,
    /"effect_status" IN \('not_started', 'started', 'committed', 'unknown'\)/u,
  );
});

test("hosted approval lifecycle ownership migration is registered and locked", () => {
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0084_hosted_approval_lifecycle_ownership",
    ),
    {
      idx: 84,
      version: "7",
      when: 1_787_767_200_000,
      tag: "0084_hosted_approval_lifecycle_ownership",
      breakpoints: true,
    },
  );
  assert.equal(
    historyLock["0084_hosted_approval_lifecycle_ownership"],
    `1787767200000:${createHash("sha256").update(migration).digest("hex")}`,
  );
});
