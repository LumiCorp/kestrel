export const GATEWAY_MODEL_ECONOMICS_PROFILE_KEY =
  "kestrelEconomicsProfile";

export type GatewayModelEconomicsProfile = {
  version: 1;
  profileId: string;
  provider: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  counting: {
    counter: string;
    counterVersion: string;
    method: "conservative_estimate" | "model_tokenizer";
    confidence: "conservative" | "model_compatible";
  };
  cache: {
    behavior: "none" | "provider_automatic" | "anthropic_ephemeral";
  };
};

type RecordValue = Record<string, unknown>;

/**
 * Provider catalogs use different names for the same capacity fields. Keep
 * the translation here so approval persists one stable runtime contract.
 */
export function createGatewayModelEconomicsProfile(input: {
  provider: string;
  model: string;
  metadata: unknown;
}): GatewayModelEconomicsProfile | undefined {
  const metadata = asRecord(input.metadata);
  const topProvider = asRecord(metadata.top_provider);
  const contextWindowTokens = positiveInteger(
    metadata.context_length ??
      metadata.contextWindowTokens ??
      metadata.context_window ??
      metadata.max_input_tokens ??
      topProvider.context_length,
  );
  const maxOutputTokens = positiveInteger(
    topProvider.max_completion_tokens ??
      metadata.max_completion_tokens ??
      metadata.max_output_tokens ??
      metadata.maxOutputTokens ??
      metadata.max_tokens,
  );

  if (
    contextWindowTokens === undefined ||
    maxOutputTokens === undefined ||
    maxOutputTokens >= contextWindowTokens
  ) {
    return;
  }

  return {
    version: 1,
    profileId: `${input.provider}:${input.model}:v1`,
    provider: input.provider,
    model: input.model,
    contextWindowTokens,
    maxOutputTokens,
    counting: {
      counter: "utf8-byte-upper-bound",
      counterVersion: "1",
      method: "conservative_estimate",
      confidence: "conservative",
    },
    cache: {
      behavior: "none",
    },
  };
}

export function readGatewayModelEconomicsProfile(
  metadata: unknown,
  input: { provider: string; model: string },
): GatewayModelEconomicsProfile | undefined {
  const candidate = asRecord(metadata)[GATEWAY_MODEL_ECONOMICS_PROFILE_KEY];
  const profile = asRecord(candidate);
  if (
    profile.provider !== input.provider ||
    profile.model !== input.model ||
    profile.version !== 1 ||
    typeof profile.profileId !== "string"
  ) {
    return;
  }
  return candidate as GatewayModelEconomicsProfile;
}

export function withGatewayModelEconomicsProfile(input: {
  metadata: unknown;
  provider: string;
  model: string;
  approved: boolean;
  modality: string;
}): Record<string, unknown> | null {
  const metadata = asRecord(input.metadata);
  const next = { ...metadata };
  if (!input.approved || input.modality !== "language") {
    delete next[GATEWAY_MODEL_ECONOMICS_PROFILE_KEY];
    return Object.keys(next).length > 0 ? next : null;
  }

  const existing = readGatewayModelEconomicsProfile(next, {
    provider: input.provider,
    model: input.model,
  });
  const profile =
    existing ??
    createGatewayModelEconomicsProfile({
      provider: input.provider,
      model: input.model,
      metadata: next,
    });
  if (profile !== undefined) {
    next[GATEWAY_MODEL_ECONOMICS_PROFILE_KEY] = profile;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return;
  }
  return value;
}
