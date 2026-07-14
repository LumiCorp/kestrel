import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const read = (relativePath: string) =>
  fs.readFileSync(path.join(appRoot, relativePath), "utf8");

test("Vercel compilation never mutates the database", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts.build, "next build");
  assert.equal(
    packageJson.scripts["db:migrate:deploy"],
    "tsx lib/db/migrate.ts"
  );
  assert.equal(
    packageJson.scripts["db:migrate:contract"],
    "tsx lib/db/contract-migrate.ts"
  );
});

test("production migrations serialize and repair known skipped schema", () => {
  const migrate = read("lib/db/migrate.ts");
  const reconciliation = read("lib/db/schema-reconciliation.ts");
  assert.match(migrate, /pg_advisory_lock/u);
  assert.match(migrate, /hasKnownMigrationLedgerDrift/u);
  assert.match(reconciliation, /transactionBreakBefore/u);
  assert.match(
    reconciliation,
    /ALTER TABLE \"projects\" ALTER COLUMN \"environment_id\" SET NOT NULL/u
  );
  for (const tag of [
    "0014_platform_email_config",
    "0015_managed_runpod_deployments",
    "0018_environment_project_ownership",
    "0019_hosted_mcp_control_plane",
    "0020_environment_router_upgrade",
    "0021_mcp_interaction_hardening",
    "0022_mcp_sampling_processing_deadline",
  ]) {
    assert.match(reconciliation, new RegExp(tag, "u"));
  }
});
