export type HostedApprovalDrainCounts = {
  compatibilityDecisions: number;
  pendingOldInteractions: number;
  actionableLegacyProviderApprovals: number;
  legacyProviderConsumptions: number;
  nonterminalIncidentInteractions: number;
};

export function evaluateHostedApprovalDatabaseDrain(input: {
  observedSince: string;
  generatedAt: string;
  counts: HostedApprovalDrainCounts;
  latestLegacyExpiry: string | null;
}) {
  const blockers = Object.entries(input.counts)
    .filter(([, count]) => count !== 0)
    .map(([name, count]) => `${name}:${count}`);
  const latestLegacyExpiry =
    input.latestLegacyExpiry === null
      ? null
      : Date.parse(input.latestLegacyExpiry);
  if (
    latestLegacyExpiry !== null &&
    (Number.isNaN(latestLegacyExpiry) ||
      latestLegacyExpiry > Date.parse(input.generatedAt))
  ) {
    blockers.push("legacy_expiry_window_open");
  }
  return {
    ...input,
    databaseDrainReady: blockers.length === 0,
    blockers,
    cleanupAuthorized: false,
    remainingExternalGates: [
      "complete_turn_worker_rollout_cycle",
      "inventory_all_started_and_stopped_turn_worker_images",
      "inventory_all_tenant_runtime_pairs",
      "retain_continuous_zero_use_evidence",
      "record_terminal_incident_reconciliation",
    ],
  };
}
