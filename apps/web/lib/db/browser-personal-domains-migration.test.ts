import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0097_browser_personal_domains.sql"),
  "utf8",
);
const schemaSource = fs.readFileSync(
  path.join(directory, "../../drizzle/schema.ts"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/_journal.json"),
    "utf8",
  ),
) as { entries: Array<Record<string, unknown>> };
const historyLock = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/history-lock.json"),
    "utf8",
  ),
) as Record<string, string>;

test("personal Browser domains have an isolated monotonic revision set", () => {
  assert.match(
    migration,
    /CREATE TABLE "browser_personal_domain_revision_sets"/u,
  );
  assert.match(
    migration,
    /PRIMARY KEY \("organization_id", "environment_id", "user_id"\)/u,
  );
  assert.match(migration, /CHECK \("revision" >= 0\)/u);
  assert.match(
    migration,
    /FOREIGN KEY \("organization_id", "environment_id"\)\s+REFERENCES "environments"\("organization_id", "id"\)/u,
    "the authenticated organization and Environment must be the same authority",
  );
  assert.match(
    migration,
    /FOREIGN KEY \("organization_id", "environment_id", "user_id"\)\s+REFERENCES "browser_personal_domain_revision_sets"/u,
    "every domain state must belong to exactly one personal revision set",
  );
});

test("personal Browser domain identity and lifecycle exclude Project scope", () => {
  assert.match(migration, /CREATE TABLE "browser_personal_domains"/u);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "browser_personal_domains_identity_idx"[\s\S]*"organization_id", "environment_id", "user_id", "canonical_domain"/u,
  );
  assert.doesNotMatch(migration, /"project_id"/u);
  assert.doesNotMatch(migration, /remembered_tool_approvals/u);
  assert.match(
    migration,
    /"scheme" = 'https'[\s\S]*"include_subdomains" = true[\s\S]*"port" = 443/u,
  );
  assert.match(migration, /CHECK \("personal_revision" > 0\)/u);
  assert.match(
    migration,
    /"status" = 'active' AND "revoked_at" IS NULL AND "revoked_by_user_id" IS NULL/u,
  );
  assert.match(migration, /"status" = 'revoked' AND "revoked_at" IS NOT NULL/u);
  for (const column of [
    "approval_id",
    "source_interaction_id",
    "source_prepared_invocation_id",
    "approval_authority_revision",
    "approved_at",
    "revoked_at",
    "revoked_by_user_id",
  ]) {
    assert.match(migration, new RegExp(`"${column}"`, "u"));
  }
});

test("Drizzle exports the same personal Browser storage contract", () => {
  assert.match(
    schemaSource,
    /export const browserPersonalDomainRevisionSets = pgTable\(/u,
  );
  assert.match(
    schemaSource,
    /export const browserPersonalDomains = pgTable\(/u,
  );
  const browserSchema = schemaSource.slice(
    schemaSource.indexOf("export const browserPersonalDomainRevisionSets"),
    schemaSource.indexOf(
      "export const environmentCapabilitySubjectRestrictions",
    ),
  );
  assert.doesNotMatch(browserSchema, /projectId|project_id/u);
  assert.match(browserSchema, /browser_personal_domains_identity_idx/u);
  assert.match(browserSchema, /browser_personal_domains_revision_set_fk/u);
  assert.match(
    browserSchema,
    /browser_personal_domains_public_authority_check/u,
  );
  assert.match(browserSchema, /browser_personal_domains_lifecycle_check/u);
});

test("personal Browser domains migration is registered and history locked", () => {
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0097_browser_personal_domains",
    ),
    {
      idx: 97,
      version: "7",
      when: 1_787_954_400_000,
      tag: "0097_browser_personal_domains",
      breakpoints: true,
    },
  );
  assert.equal(
    historyLock["0097_browser_personal_domains"],
    `1787954400000:${createHash("sha256").update(migration).digest("hex")}`,
  );
});
