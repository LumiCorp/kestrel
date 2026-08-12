type GatewayOverviewInput = {
  gateway: {
    enabled: boolean;
    hasApiKey: boolean;
    provider: string;
  };
  models: ReadonlyArray<{
    approved: boolean;
    isDefault: boolean;
  }>;
};

export type GatewayCollectionState =
  | "loading"
  | "error"
  | "empty"
  | "ready";

export function getGatewayCollectionState(input: {
  isLoading: boolean;
  error: string | null;
  count: number;
}): GatewayCollectionState {
  if (input.isLoading) return "loading";
  if (input.error) return "error";
  return input.count === 0 ? "empty" : "ready";
}

export function getGatewayOverview(input: GatewayOverviewInput) {
  const approvedCount = input.models.filter((model) => model.approved).length;
  const defaultCount = input.models.filter((model) => model.isDefault).length;
  const attentionReason = getGatewayAttentionReason(input);

  return {
    approvedCount,
    defaultCount,
    attentionReason,
    status: attentionReason ? ("Needs attention" as const) : ("Ready" as const),
    tone: attentionReason ? ("warning" as const) : ("positive" as const),
  };
}

function getGatewayAttentionReason(input: GatewayOverviewInput) {
  if (!input.gateway.enabled) return "Provider disabled";
  if (!(input.gateway.hasApiKey || input.gateway.provider === "ollama")) {
    return "API key missing";
  }
  if (input.models.length === 0) return "No models synced";
  return null;
}
