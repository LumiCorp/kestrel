import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHostedApprovalDatabaseDrain } from "./hosted-approval-drain-contract";

const zeroCounts = {
  compatibilityDecisions: 0,
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
      actionableLegacyProviderApprovals: 2,
      nonterminalIncidentInteractions: 1,
    },
    latestLegacyExpiry: "2026-08-26T13:05:00.000Z",
  });
  assert.equal(result.databaseDrainReady, false);
  assert.deepEqual(result.blockers, [
    "compatibilityDecisions:1",
    "actionableLegacyProviderApprovals:2",
    "nonterminalIncidentInteractions:1",
    "legacy_expiry_window_open",
  ]);
});
