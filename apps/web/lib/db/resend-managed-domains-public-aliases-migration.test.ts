import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(
    directory,
    "migrations/0096_resend_managed_domains_public_aliases.sql",
  ),
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

test("Resend-managed domains and public aliases are additive contracts", () => {
  assert.match(migration, /ADD COLUMN "receiving_domain_kind"/u);
  assert.match(migration, /'custom', 'resend_managed'/u);
  assert.match(migration, /'private', 'public'/u);
  assert.match(
    migration,
    /WHERE "deleted_at" IS NULL/u,
    "deleted aliases can be reused without weakening live-address uniqueness",
  );
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0096_resend_managed_domains_public_aliases",
    ),
    {
      idx: 96,
      version: "7",
      when: 1_787_950_800_000,
      tag: "0096_resend_managed_domains_public_aliases",
      breakpoints: true,
    },
  );
  assert.equal(
    historyLock["0096_resend_managed_domains_public_aliases"],
    `1787950800000:${createHash("sha256").update(migration).digest("hex")}`,
  );
});
