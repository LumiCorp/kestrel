import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const root = path.dirname(fileURLToPath(import.meta.url));
const expandMigration = fs.readFileSync(
  path.join(root, "migrations/0026_environment_private_inference_expand.sql"),
  "utf8"
);
const contractMigration = fs.readFileSync(
  path.join(
    root,
    "contract-migrations/0000_environment_private_inference_contract.sql"
  ),
  "utf8"
);
const reconciliationMigration = fs.readFileSync(
  path.join(root, "migrations/0025_schema_reconciliation_audit.sql"),
  "utf8"
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8"
);
const contractJournal = fs.readFileSync(
  path.join(root, "contract-migrations/meta/_journal.json"),
  "utf8"
);

contractTest("web.hermetic", "private inference is backfilled into the default Environment", () => {
  assert.match(expandMigration, /UPDATE "ai_deployments" deployment/u);
  assert.match(expandMigration, /environment\."is_default" = true/u);
  assert.match(expandMigration, /gateway\."provider" = 'runpod'/u);
  assert.doesNotMatch(
    expandMigration,
    /ALTER COLUMN "environment_id" SET NOT NULL/u
  );
  assert.match(
    contractMigration,
    /Every managed inference deployment must resolve/u
  );
  assert.match(
    contractMigration,
    /ALTER COLUMN "environment_id" SET NOT NULL/u
  );
});

contractTest("web.hermetic", "Environment ownership is enforced for inference and durable turns", () => {
  assert.match(expandMigration, /ai_gateways_organization_environment_fk/u);
  assert.match(expandMigration, /ai_deployments_organization_environment_fk/u);
  assert.match(expandMigration, /thread_turns_organization_environment_fk/u);
  assert.match(expandMigration, /ON DELETE RESTRICT/u);
  assert.match(expandMigration, /NOT VALID/u);
  assert.match(contractMigration, /VALIDATE CONSTRAINT/u);
  assert.match(
    expandMigration,
    /ai_deployments_active_environment_profile_idx/u
  );
  assert.match(
    expandMigration,
    /ai_gateways_environment_provider_display_name_idx/u
  );
});

contractTest("web.hermetic", "Environment defaults seed only for an unambiguous eligible model", () => {
  assert.match(
    expandMigration,
    /CREATE TABLE "environment_ai_model_defaults"/u
  );
  assert.match(expandMigration, /HAVING count\(\*\) = 1/u);
  assert.match(expandMigration, /deployment\."status" = 'ready'/u);
});

contractTest("web.hermetic", "every organization receives the approved two-deployment policy", () => {
  assert.match(expandMigration, /SELECT "id", true, 2, now\(\), now\(\)/u);
  assert.match(expandMigration, /seed_default_ai_deployment_policy/u);
  assert.match(expandMigration, /AFTER INSERT ON "organization"/u);
});

contractTest("web.hermetic", "schema repair, expansion, and contraction are registered separately", () => {
  assert.match(journal, /"tag": "0025_schema_reconciliation_audit"/u);
  assert.match(journal, /"tag": "0026_environment_private_inference_expand"/u);
  assert.doesNotMatch(journal, /environment_private_inference_contract/u);
  assert.match(contractJournal, /0000_environment_private_inference_contract/u);
  assert.match(reconciliationMigration, /mcp_credentials/u);
});
