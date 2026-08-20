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

export function getGatewayModelEconomicsProvider(input: {
  gatewayProvider: string;
  modality: string;
  metadata: unknown;
}): string | undefined {
  if (input.modality !== "language") return;
  if (input.gatewayProvider === "lumi") {
    return asRecord(input.metadata).protocol === "anthropic"
      ? "anthropic"
      : "openai";
  }
  if (input.gatewayProvider === "runpod") return "openai";
  return input.gatewayProvider;
}

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
  const contextWindowTokens = positiveInteger(profile.contextWindowTokens);
  const maxOutputTokens = positiveInteger(profile.maxOutputTokens);
  if (
    profile.provider !== input.provider ||
    profile.model !== input.model ||
    profile.version !== 1 ||
    profile.profileId !== `${input.provider}:${input.model}:v1` ||
    contextWindowTokens === undefined ||
    maxOutputTokens === undefined ||
    maxOutputTokens >= contextWindowTokens ||
    !isRecordWithStrings(profile.counting, ["counter", "counterVersion"]) ||
    !isRecordWithStrings(profile.cache, ["behavior"]) ||
    !isAllowedProfileValues(profile)
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
  if (Object.hasOwn(next, GATEWAY_MODEL_ECONOMICS_PROFILE_KEY) && !existing) {
    delete next[GATEWAY_MODEL_ECONOMICS_PROFILE_KEY];
  }
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

function isRecordWithStrings(
  value: unknown,
  keys: readonly string[],
): value is Record<string, string> {
  const record = asRecord(value);
  return keys.every((key) => typeof record[key] === "string");
}

function isAllowedProfileValues(profile: Record<string, unknown>): boolean {
  const counting = asRecord(profile.counting);
  const cache = asRecord(profile.cache);
  return (
    counting.method === "conservative_estimate" ||
    counting.method === "model_tokenizer"
  ) &&
    (counting.confidence === "conservative" ||
      counting.confidence === "model_compatible") &&
    (cache.behavior === "none" ||
      cache.behavior === "provider_automatic" ||
      cache.behavior === "anthropic_ephemeral");
}
