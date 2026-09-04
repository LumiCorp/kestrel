import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { seedBrowser } from "./seed.js";
import { hashEnvironmentServiceToken } from "../../lib/environments/service-tokens.js";

const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/browser_fly_local");
const sql = postgres(url.toString(), { max: 2 });
try {
  const ids = await seedBrowser(sql);
  // Phase 1 identities are deliberately not real Fly resources. Provisioning
  // must replace them before any hosted Browser operation is attempted.
  await sql`UPDATE environments SET gateway_service_token_hash = ${hashEnvironmentServiceToken(process.env.BROWSER_TEST_GATEWAY_TOKEN!)}, router_url = 'http://127.0.0.1:3001' WHERE id = ${ids.environmentId}`;
  await sql`UPDATE environment_workspaces SET fly_machine_id = 'local-preflight-only', service_token_hash = ${hashEnvironmentServiceToken(process.env.BROWSER_TEST_WORKSPACE_TOKEN!)} WHERE id = ${ids.workspaceId}`;
  await writeFile(process.env.BROWSER_TEST_IDS_FILE!, JSON.stringify(ids), { mode: 0o600 });
} finally {
  await sql.end({ timeout: 0 });
  const { resetDbRuntimeForTests } = await import("../../lib/db/runtime.js");
  await resetDbRuntimeForTests();
}
