import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.resolve(
    directory,
    "../../drizzle/migrations/0002_platform_oauth_registration_legacy_settings.sql",
  ),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(
    path.resolve(directory, "../../drizzle/migrations/meta/_journal.json"),
    "utf8",
  ),
) as { entries: Array<Record<string, unknown>> };

test("legacy Platform OAuth settings are disabled without reinterpreting their value", () => {
  assert.match(migration, /"provider" = 'google_workspace'[\s\S]*"tenant_or_issuer" IS NOT NULL/u);
  assert.match(
    migration,
    /"provider" = 'microsoft_365'[\s\S]*lower\("tenant_or_issuer"\) <> 'organizations'[\s\S]*!~\*/u,
  );
  assert.match(migration, /"enabled" = false[\s\S]*"revision" = "revision" \+ 1/u);
  assert.doesNotMatch(migration, /"tenant_or_issuer"\s*=\s*NULL/u);
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0002_platform_oauth_registration_legacy_settings",
    ),
    {
      idx: 2,
      version: "7",
      when: 1_787_923_600_000,
      tag: "0002_platform_oauth_registration_legacy_settings",
      breakpoints: true,
    },
  );
});
