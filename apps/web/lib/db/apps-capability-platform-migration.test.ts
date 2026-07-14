import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "./migrations/0028_apps_capability_platform_expand.sql",
  import.meta.url
);
const customMcpCutoverUrl = new URL(
  "./migrations/0029_apps_custom_mcp_cutover.sql",
  import.meta.url
);
const githubResourceCutoverUrl = new URL(
  "./migrations/0030_apps_github_resource_cutover.sql",
  import.meta.url
);
const googleProjectAccessCutoverUrl = new URL(
  "./migrations/0031_apps_google_project_access_cutover.sql",
  import.meta.url
);

test("Apps migration creates the canonical control-plane tables", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  for (const table of [
    "app_definitions",
    "app_capabilities",
    "app_installations",
    "app_credentials",
    "app_connections",
    "app_connection_resources",
    "environment_app_capability_grants",
    "project_apps",
    "project_app_connections",
    "project_app_capability_policies",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`, "u")
    );
  }
});

test("Apps migration preserves existing Google and MCP authority", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /FROM "user_tool_connections" connection/u);
  assert.match(migration, /FROM "project_user_tool_capabilities" capability/u);
  assert.match(migration, /FROM "mcp_credentials" credential/u);
  assert.match(migration, /FROM "mcp_servers" server/u);
  assert.match(migration, /'kmcp:v1'/u);
  assert.match(migration, /project_app_connections_personal_default_idx/u);
  assert.match(migration, /project_app_connections_shared_default_idx/u);
});

test("Apps migration installs Tavily with restrictive long-running defaults", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(
    migration,
    /'tavily', 'search', 'internet\.search'[^\n]*'auto'/u
  );
  assert.match(
    migration,
    /'tavily', 'extract', 'internet\.extract'[^\n]*'auto'/u
  );
  assert.match(migration, /'tavily', 'crawl', 'internet\.crawl'[^\n]*'ask'/u);
  assert.match(migration, /'tavily', 'map', 'internet\.map'[^\n]*'ask'/u);
  assert.match(
    migration,
    /'tavily', 'research', 'internet\.research'[^\n]*'ask'/u
  );
  assert.match(
    migration,
    /'tavily', 'usage', 'internet\.usage'[^\n]*false, 'deny'/u
  );
});

test("Apps migration fails rather than widening Project access", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /Project capability policy beyond its Environment/u);
  assert.match(
    migration,
    /environment_grant\."approval_mode" = 'ask' AND policy\."approval_mode" = 'auto'/u
  );
});

test("Custom MCP migrates into canonical App capabilities and Project attachments", async () => {
  const migration = await readFile(customMcpCutoverUrl, "utf8");
  assert.match(
    migration,
    /capability\."kind" \|\| ':' \|\| capability\."capability_key"/u
  );
  assert.match(migration, /'mcp\.capability\.' \|\| capability\."id"/u);
  assert.match(migration, /INSERT INTO "environment_app_capability_grants"/u);
  assert.match(migration, /INSERT INTO "project_app_connections"/u);
  assert.match(migration, /INSERT INTO "project_app_capability_policies"/u);
  assert.match(migration, /Custom App cutover would widen Project access/u);
});

test("GitHub Workspace sources cut over to canonical App resources without widening", async () => {
  const migration = await readFile(githubResourceCutoverUrl, "utf8");
  assert.match(migration, /INSERT INTO "app_connection_resources"/u);
  assert.match(
    migration,
    /GitHub Workspace source is missing from canonical App resources/u
  );
  assert.match(migration, /REFERENCES "app_connection_resources"\("id"\)/u);
  assert.match(migration, /VALIDATE CONSTRAINT/u);
});

test("Google Project sharing cuts over to canonical App connections and capabilities", async () => {
  const migration = await readFile(googleProjectAccessCutoverUrl, "utf8");
  assert.match(migration, /RENAME TO "project_app_user_capabilities"/u);
  assert.match(migration, /RENAME COLUMN "provider_key" TO "app_key"/u);
  assert.match(migration, /REFERENCES "app_connections"\("id"\)/u);
  assert.match(migration, /REFERENCES "app_capabilities"\("app_key", "key"\)/u);
  assert.match(
    migration,
    /Project personal access is missing from canonical Apps authority/u
  );
});
