import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateHostedApprovalDatabaseDrain } from "./hosted-approval-drain-contract";

const zeroCounts = {
  compatibilityDecisions: 0,
  legacyInteractionTerminals: 0,
  pendingOldInteractions: 0,
  actionableLegacyProviderApprovals: 0,
  legacyProviderConsumptions: 0,
  nonterminalIncidentInteractions: 0,
};

test("database drain never authorizes cleanup without external rollout evidence", () => {
  const result = evaluateHostedApprovalDatabaseDrain({
    observedSince: "2026-08-26T12:00:00.000Z",
    generatedAt: "2026-08-26T13:00:00.000Z",
    counts: zeroCounts,
    latestLegacyExpiry: null,
  });
  assert.equal(result.databaseDrainReady, true);
  assert.equal(result.cleanupAuthorized, false);
  assert.deepEqual(result.blockers, []);
  assert.ok(
    result.remainingExternalGates.includes(
      "complete_turn_worker_rollout_cycle",
    ),
  );
});

test("any compatibility use, actionable row, incident, or future expiry blocks drain", () => {
  const result = evaluateHostedApprovalDatabaseDrain({
    observedSince: "2026-08-26T12:00:00.000Z",
    generatedAt: "2026-08-26T13:00:00.000Z",
    counts: {
      ...zeroCounts,
      compatibilityDecisions: 1,
      legacyInteractionTerminals: 1,
      actionableLegacyProviderApprovals: 2,
      nonterminalIncidentInteractions: 1,
    },
    latestLegacyExpiry: "2026-08-26T13:05:00.000Z",
  });
  assert.equal(result.databaseDrainReady, false);
  assert.deepEqual(result.blockers, [
    "compatibilityDecisions:1",
    "legacyInteractionTerminals:1",
    "actionableLegacyProviderApprovals:2",
    "nonterminalIncidentInteractions:1",
    "legacy_expiry_window_open",
  ]);
});

test("a future or malformed observation boundary cannot report ready", () => {
  const result = evaluateHostedApprovalDatabaseDrain({
    observedSince: "2026-08-26T14:00:00.000Z",
    generatedAt: "2026-08-26T13:00:00.000Z",
    counts: zeroCounts,
    latestLegacyExpiry: null,
  });
  assert.equal(result.databaseDrainReady, false);
  assert.deepEqual(result.blockers, ["observation_window_invalid"]);
});

test("drain reporting counts every late terminal path for old interactions", () => {
  const source = readFileSync(
    new URL("../../scripts/hosted-approval-drain-report.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /event\.type IN \([\s\S]*'interaction\.execution_settled'[\s\S]*'interaction\.authorization_denied'[\s\S]*'interaction\.authorization_failed'[\s\S]*\)/u,
  );
  assert.match(source, /event\.data->>'requestId' = interaction\.request_id/u);
  assert.match(source, /event\.created_at >= \$\{observedSince\}/u);
});
