import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0014_platform_email_config.sql"
  ),
  "utf8"
);

test("platform email migration is singleton, platform scoped, and credential safe", () => {
  assert.match(migration, /CREATE TABLE "platform_email_config"/);
  assert.match(migration, /platform_email_config_singleton_idx/);
  assert.match(migration, /"encrypted_api_key" text/);
  assert.match(migration, /credential_source_check/);
  assert.doesNotMatch(migration, /organization_id/);
  assert.doesNotMatch(migration, /RESEND_API_KEY|re_[A-Za-z0-9]/);
});
