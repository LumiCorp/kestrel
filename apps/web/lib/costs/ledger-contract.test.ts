import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function read(relativePath: string) {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

contractTest("web.hermetic", "organization cost ledger uses additive numeric money tables", () => {
  const migration = read("lib/db/migrations/0044_organization_cost_ledger.sql");
  for (const table of [
    "organization_usage_events",
    "cost_rate_cards",
    "organization_cost_entries",
    "organization_dashboard_settings",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`, "u"));
  }
  assert.match(migration, /"quantity" numeric\(24, 8\)/u);
  assert.match(migration, /"amount_usd" numeric\(20, 8\)/u);
  assert.match(migration, /UNIQUE NULLS NOT DISTINCT/u);
  assert.match(migration, /'all_members'/u);
  assert.match(migration, /'admins_only'/u);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN/u);
});

contractTest("web.hermetic", "billable app effects are metered before upstream fetch", () => {
  const runtime = read("lib/apps/runtime-route.ts");
  assert.ok(runtime.indexOf("await recordUsageEvent") < runtime.indexOf("await fetch"));
  assert.match(runtime, /sourceKind: "app_runtime_invocation"/u);
  assert.match(runtime, /App usage outcome enrichment failed/u);
});

contractTest("web.hermetic", "cost workers stay in the durable environment worker", () => {
  const queue = read("lib/knowledge/queue.ts");
  const worker = queue.slice(queue.indexOf("startEnvironmentLifecycleWorker"));
  assert.match(worker, /boss\.work\(\s*COST_PRICING_QUEUE/u);
  assert.match(worker, /boss\.work\(\s*COST_ACCRUAL_QUEUE/u);
  assert.match(worker, /boss\.work\(\s*COST_FLY_METERING_QUEUE/u);
  assert.match(worker, /backfill: "incremental"/u);
  assert.match(worker, /backfill: "startup"/u);
});

contractTest(
  "web.hermetic",
  "Fly cost metering uses organization-scoped provider authority",
  () => {
    const metering = read("lib/costs/metering.ts");
    assert.match(metering, /createFlyProviderClient\(organizationId\)/u);
    assert.match(
      metering,
      /providerForOrganization\(environment\.organizationId\)/u
    );
    assert.match(
      metering,
      /providerForOrganization\(workspace\.organizationId\)/u
    );
    assert.doesNotMatch(metering, /createFlyProviderClient\(\)/u);
  }
);
