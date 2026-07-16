import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0016_hosted_environments.sql"
  ),
  "utf8"
);

test("Environment migration establishes the hosted ownership graph", () => {
  for (const table of [
    "environments",
    "environment_workspaces",
    "project_environment_bindings",
    "thread_execution_bindings",
    "environment_run_executions",
    "environment_operations",
    "environment_applications",
    "workspace_backups",
    "tool_connection_resources",
    "environment_capability_grants",
    "project_capability_restrictions",
    "environment_capability_subject_restrictions",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`, "u"));
  }
});

test("Environment ownership is canonical on Projects after the follow-up migration", () => {
  const ownershipMigration = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "migrations/0018_environment_project_ownership.sql"
    ),
    "utf8"
  );
  assert.match(ownershipMigration, /projects_organization_environment_fk/u);
  assert.match(
    ownershipMigration,
    /ALTER COLUMN "environment_id" SET NOT NULL/u
  );
});

test("Environment migration pins isolation and lazy Workspace invariants", () => {
  assert.match(migration, /environments_org_default_idx/u);
  assert.match(migration, /fly_gateway_machine_id/u);
  assert.match(migration, /router_url/u);
  assert.match(migration, /router_image/u);
  assert.match(migration, /environment_workspaces_owner_check/u);
  assert.match(migration, /environment_workspaces_source_check/u);
  assert.match(migration, /environment_workspaces_project_idx/u);
  assert.match(migration, /environment_workspaces_thread_idx/u);
  assert.match(migration, /thread_execution_bindings[\s\S]*thread_id/u);
  assert.match(migration, /environment_run_executions[\s\S]*runtime_image/u);
  assert.match(
    migration,
    /environment_run_executions[\s\S]*effective_capabilities/u
  );
  assert.doesNotMatch(
    migration,
    /(?:ALTER TABLE|UPDATE|DELETE FROM|INSERT INTO) "threads"/u
  );
  assert.doesNotMatch(migration, /INSERT INTO "thread_execution_bindings"/u);
});

test("Environment router fields converge for databases that applied the original migration", () => {
  const upgradeMigration = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "migrations/0020_environment_router_upgrade.sql"
    ),
    "utf8"
  );
  for (const field of [
    "fly_gateway_machine_id",
    "router_url",
    "router_image",
  ]) {
    assert.match(
      upgradeMigration,
      new RegExp(`ADD COLUMN IF NOT EXISTS "${field}"`, "u")
    );
  }
});

test("Environment updates extend the existing durable operation contract", () => {
  const updateMigration = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "migrations/0037_environment_update_operation.sql"
    ),
    "utf8"
  );
  assert.match(updateMigration, /'environment\.update'/u);
  assert.match(
    updateMigration,
    /ADD CONSTRAINT "environment_operations_type_check"/u
  );
  assert.doesNotMatch(updateMigration, /CREATE TABLE/u);
  assert.doesNotMatch(updateMigration, /UPDATE |DELETE FROM|INSERT INTO/u);
});

test("Environment migration makes provider operations and grants auditable", () => {
  assert.match(migration, /environment_operations_idempotency_idx/u);
  assert.match(migration, /provider_request_id/u);
  assert.match(migration, /environment_capability_grants_capability_fk/u);
  assert.match(migration, /tool_connection_resources_installation_idx/u);
  assert.match(migration, /project_capability_restrictions_capability_fk/u);
  assert.match(migration, /environment_capability_subject_capability_fk/u);
  assert.match(migration, /workspace_backups_expiry_idx/u);
  for (const capability of [
    "repository.read",
    "repository.push_agent_branch",
    "pull_request.write",
    "issue.write",
    "merge.write",
    "release.write",
    "workflow.dispatch",
  ]) {
    assert.match(migration, new RegExp(`'github', '${capability}'`, "u"));
  }
});

test("registered applications remain private and sandbox-port bounded", () => {
  assert.match(migration, /environment_applications_audience_check/u);
  assert.match(migration, /"audience" = 'workspace'/u);
  assert.match(migration, /environment_applications_port_check/u);
  assert.match(migration, /BETWEEN 1024 AND 65535/u);
});
