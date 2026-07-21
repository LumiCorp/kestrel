import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const migrationUrl = new URL(
  "./migrations/0027_google_calendar_project_connections.sql",
  import.meta.url
);

contractTest("web.hermetic", "Google Calendar migration installs project user gates and capability policy", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /project_user_tool_capabilities/u);
  assert.match(migration, /REFERENCES "user_tool_connections"/u);
  assert.match(migration, /calendar\.availability\.read/u);
  assert.match(migration, /'calendar\.events\.create'[\s\S]*?'ask'/u);
  assert.match(migration, /'calendar\.events\.delete'[\s\S]*?'ask'/u);
  assert.match(
    migration,
    /ON CONFLICT \("environment_id", "provider_key", "capability_key"\)/u
  );
});

contractTest("web.hermetic", "Google Calendar migration never adds Gmail or Drive scopes", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(migration, /gmail/u);
  assert.doesNotMatch(migration, /google-drive|drive\./u);
});
