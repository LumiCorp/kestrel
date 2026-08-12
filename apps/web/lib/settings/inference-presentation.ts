type InferenceProfile = {
  displayName: string;
  status: string;
};

type InferenceFleetRow = {
  deployment: { status: string };
  attributedSpendUsd: number;
};

export function getInferenceOverview(input: {
  loaded: boolean;
  connection: { status: string; hasApiKey: boolean } | null;
  profiles: InferenceProfile[];
  fleet: InferenceFleetRow[];
  quota: number;
}) {
  const activeProfile = input.profiles.find(
    (profile) => profile.status === "active",
  );
  const attentionCount = input.fleet.filter((row) =>
    ["failed", "delete_failed"].includes(row.deployment.status),
  ).length;
  const readyCount = input.fleet.filter(
    (row) => row.deployment.status === "ready",
  ).length;

  return {
    connectionStatus: input.loaded
      ? (input.connection?.status ?? "Not configured")
      : "Loading",
    connectionDetail: input.connection?.hasApiKey
      ? "Encrypted credential stored"
      : "No credential",
    activeProfile: activeProfile?.displayName ?? "None",
    fleetHealth:
      attentionCount > 0
        ? `${attentionCount} need attention`
        : input.fleet.length > 0
          ? `${readyCount} of ${input.fleet.length} ready`
          : "No deployments",
    fleetTone: attentionCount > 0 ? ("warning" as const) : ("neutral" as const),
    quota: input.quota,
    attributedSpendUsd: input.fleet.reduce(
      (total, row) => total + row.attributedSpendUsd,
      0,
    ),
  };
}
