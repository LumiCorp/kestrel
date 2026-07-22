import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const expandMigration = fs.readFileSync(path.join(root, "migrations/0039_organization_settings_prepare.sql"), "utf8");
const contractMigration = fs.readFileSync(path.join(root, "contract-migrations/0001_organization_settings_contract.sql"), "utf8");
const backfill = fs.readFileSync(path.join(root, "../../scripts/backfill-organization-settings.ts"), "utf8");
const expandJournal = fs.readFileSync(path.join(root, "migrations/meta/_journal.json"), "utf8");
const contractJournal = fs.readFileSync(path.join(root, "contract-migrations/meta/_journal.json"), "utf8");

contractTest("web.hermetic", "organization settings use an expand-backfill-contract migration", () => {
  assert.match(expandMigration, /ADD COLUMN IF NOT EXISTS "organization_id"/u);
  assert.doesNotMatch(expandMigration, /ALTER COLUMN "organization_id" SET NOT NULL/u);
  assert.match(contractMigration, /ALTER COLUMN "organization_id" SET NOT NULL/u);
  assert.match(expandJournal, /0039_organization_settings_prepare/u);
  assert.match(contractJournal, /0001_organization_settings_contract/u);
});

contractTest("web.hermetic", "tenant relationships are enforced across providers, profiles, gateways, and models", () => {
  assert.match(expandMigration, /ai_gateways_organization_provider_connection_fk/u);
  assert.match(expandMigration, /ai_gateway_models_organization_gateway_fk/u);
  assert.match(expandMigration, /ai_deployments_organization_profile_fk/u);
  assert.match(expandMigration, /NOT VALID/u);
  assert.match(contractMigration, /VALIDATE CONSTRAINT/u);
});

contractTest("web.hermetic", "legacy settings backfill is explicit, dry-runnable, and rejects conflicting ownership", () => {
  assert.match(backfill, /--organization-id/u);
  assert.match(backfill, /--dry-run/u);
  assert.match(backfill, /--apply/u);
  assert.match(backfill, /status: "rejected"/u);
  assert.match(backfill, /another organization/u);
  assert.doesNotMatch(backfill, /process\.stdout\.write[\s\S]*apiKey/u);
});

contractTest("web.hermetic", "contract cutover rejects global and environment-backed provider credentials", () => {
  assert.match(contractMigration, /AI gateway environment credential fallbacks must be removed/u);
  assert.match(contractMigration, /infrastructure provider connection must use a stored credential/u);
});
