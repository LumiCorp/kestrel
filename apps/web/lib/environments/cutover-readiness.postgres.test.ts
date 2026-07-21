import assert from "node:assert/strict";
import { inspectHostedEnvironmentSchemaReadiness } from "./cutover-readiness";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.postgres", "Postgres schema readiness executes the required-relation lookup", async () => {
  const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const readiness = await inspectHostedEnvironmentSchemaReadiness({ databaseUrl });
  const allowedRelations = new Set([
    "environments",
    "environment_workspaces",
    "organization_feature_flags",
    "user_tool_connections",
    "user_tool_connection_resources",
    "github_action_approvals",
  ]);
  assert.equal(readiness.ready, readiness.missingRelations.length === 0);
  assert.ok(readiness.missingRelations.every((relation) => allowedRelations.has(relation)));
  assert.deepEqual(readiness.missingRelations, [...new Set(readiness.missingRelations)]);
});
