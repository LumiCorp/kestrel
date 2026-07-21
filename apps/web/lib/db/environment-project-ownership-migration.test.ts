import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0018_environment_project_ownership.sql"
  ),
  "utf8"
);

contractTest("web.hermetic", "Environment ownership migration creates one default path for every organization", () => {
  assert.match(migration, /FROM "organization" organization/u);
  assert.match(migration, /"is_default"[\s\S]*true/u);
  assert.match(migration, /environments_org_id_idx/u);
  assert.match(migration, /environment\.provision:/u);
  assert.match(migration, /requested_by_user_id/u);
});

contractTest("web.hermetic", "Environment ownership migration makes Project assignment canonical and mandatory", () => {
  assert.match(
    migration,
    /ALTER TABLE "projects" ADD COLUMN "environment_id" text/u
  );
  assert.match(migration, /SET "environment_id" = binding\."environment_id"/u);
  assert.match(migration, /SET "environment_id" = environment\."id"/u);
  assert.match(migration, /ALTER COLUMN "environment_id" SET NOT NULL/u);
  assert.match(migration, /projects_organization_environment_fk/u);
  assert.match(
    migration,
    /FOREIGN KEY \("organization_id", "environment_id"\)/u
  );
});

contractTest("web.hermetic", "Environment ownership migration preserves existing bindings and tool behavior", () => {
  assert.match(migration, /INSERT INTO "project_environment_bindings"/u);
  assert.match(migration, /INSERT INTO "environment_capability_grants"/u);
  assert.match(migration, /JOIN "organization_tool_providers" provider/u);
  assert.match(migration, /JOIN "organization_tool_capabilities" capability/u);
  assert.match(migration, /capability\."approval_mode"/u);
  assert.match(migration, /capability\."logging_mode"/u);
  assert.match(migration, /capability\."rate_limit_mode"/u);
});
