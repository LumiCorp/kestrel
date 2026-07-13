import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0017_github_user_oauth.sql"
  ),
  "utf8"
);

test("GitHub OAuth migration assigns connections to users and auth accounts", () => {
  assert.match(migration, /CREATE TABLE "user_tool_connections"/u);
  assert.match(migration, /"user_id" text NOT NULL/u);
  assert.match(migration, /"auth_account_id" text NOT NULL/u);
  assert.match(migration, /user_tool_connections_org_provider_user_idx/u);
  assert.match(migration, /REFERENCES "account"\("id"\)/u);
});

test("GitHub OAuth migration records actor-specific repository access", () => {
  assert.match(migration, /CREATE TABLE "user_tool_connection_resources"/u);
  assert.match(migration, /"can_pull" boolean DEFAULT true NOT NULL/u);
  assert.match(migration, /"can_push" boolean DEFAULT false NOT NULL/u);
  assert.match(migration, /user_tool_connection_resources_resource_idx/u);
});

test("Workspace sources reference repository resources, not installations", () => {
  assert.match(
    migration,
    /RENAME COLUMN "source_connection_id" TO "source_resource_id"/u
  );
  assert.match(migration, /environment_workspaces_source_resource_fk/u);
  assert.match(
    migration,
    /DROP INDEX "tool_connection_resources_installation_idx"/u
  );
  assert.match(migration, /"resource_type" = 'installation'/u);
  assert.match(migration, /"connectionModel":"user_oauth"/u);
  assert.match(migration, /"source_resource_id" IS NOT NULL/u);
});
