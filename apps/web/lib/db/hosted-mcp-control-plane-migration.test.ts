import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const migration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0019_hosted_mcp_control_plane.sql"
  ),
  "utf8"
);
const interactionHardeningMigration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0021_mcp_interaction_hardening.sql"
  ),
  "utf8"
);
const interactionDeadlineMigration = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations/0022_mcp_sampling_processing_deadline.sql"
  ),
  "utf8"
);

contractTest("web.hermetic", "hosted MCP credentials are Environment-owned and encrypted-only", () => {
  assert.match(migration, /CREATE TABLE "mcp_credentials"/u);
  assert.match(migration, /mcp_credentials_organization_environment_fk/u);
  assert.match(migration, /mcp_servers_environment_credential_fk/u);
  assert.match(migration, /encrypted_payload" LIKE 'kmcp:v1:%'/u);
  assert.doesNotMatch(migration, /access_token|refresh_token|header_value/u);
});

contractTest("web.hermetic", "OAuth authorization state and PKCE verifier are durable and encrypted", () => {
  assert.match(migration, /CREATE TABLE "mcp_oauth_authorizations"/u);
  assert.match(migration, /mcp_oauth_authorizations_state_digest_idx/u);
  assert.match(migration, /encrypted_session" LIKE 'kmcp:v1:%'/u);
  assert.match(migration, /expires_at" timestamp with time zone NOT NULL/u);
  assert.doesNotMatch(migration, /code_verifier|client_secret" text/u);
});

contractTest("web.hermetic", "hosted MCP servers support remote HTTP and digest-pinned OCI with isolation defaults", () => {
  assert.match(migration, /'remote', 'oci'/u);
  assert.match(migration, /'streamable_http', 'stdio'/u);
  assert.match(migration, /oci_digest" ~ '\^sha256:\[0-9a-f\]\{64\}\$'/u);
  assert.match(migration, /oci_image_reference" LIKE '%@sha256:%'/u);
  assert.match(migration, /egress_allowlist" jsonb DEFAULT '\[\]'::jsonb/u);
  assert.match(migration, /mcp_servers_resource_limits_check/u);
});

contractTest("web.hermetic", "capability discovery is reviewable and defaults every new capability to disabled", () => {
  assert.match(migration, /CREATE TABLE "mcp_discovery_jobs"/u);
  assert.match(migration, /mcp_discovery_jobs_active_server_idx/u);
  assert.match(migration, /CREATE TABLE "mcp_capability_snapshots"/u);
  assert.match(migration, /DEFAULT 'pending_review'/u);
  assert.match(
    migration,
    /environment_enabled" boolean DEFAULT false NOT NULL/u
  );
  assert.match(migration, /approval_mode" text DEFAULT 'deny' NOT NULL/u);
  assert.match(migration, /mcp_capabilities_tool_capability_fk/u);
  assert.match(
    migration,
    /CREATE TABLE "mcp_project_capability_restrictions"/u
  );
});

contractTest("web.hermetic", "run grants and interactions carry expiry, audit, and replay evidence", () => {
  assert.match(migration, /CREATE TABLE "mcp_run_grants"/u);
  assert.match(migration, /expires_at" timestamp with time zone NOT NULL/u);
  assert.match(migration, /mcp_run_grants_expiry_check/u);
  assert.match(migration, /effective_policy" jsonb NOT NULL/u);
  assert.match(migration, /CREATE TABLE "mcp_invocations"/u);
  assert.match(migration, /request_digest/u);
  assert.match(migration, /response_digest/u);
  assert.match(migration, /replay_evidence/u);
  assert.match(migration, /CREATE TABLE "mcp_interaction_checkpoints"/u);
  assert.match(migration, /'sampling', 'elicitation'/u);
  assert.match(migration, /replay_cursor/u);
});

contractTest("web.hermetic", "Project MCP resources are explicit live references", () => {
  assert.match(migration, /CREATE TABLE "mcp_project_resource_references"/u);
  assert.match(migration, /resource_uri" text NOT NULL/u);
  assert.match(migration, /mcp_project_resource_references_uri_idx/u);
});

contractTest("web.hermetic", "interaction hardening adds durable claim and failure state", () => {
  assert.match(interactionHardeningMigration, /'processing'/u);
  assert.match(interactionHardeningMigration, /'failed'/u);
  assert.match(interactionHardeningMigration, /"failure_code" text/u);
  assert.match(interactionHardeningMigration, /"failure_message" text/u);
});

contractTest("web.hermetic", "sampling claims receive an independently durable processing deadline", () => {
  assert.match(interactionDeadlineMigration, /"processing_started_at"/u);
  assert.match(interactionDeadlineMigration, /"processing_expires_at"/u);
  assert.match(
    interactionDeadlineMigration,
    /mcp_interaction_checkpoints_processing_expiry_idx/u
  );
});
