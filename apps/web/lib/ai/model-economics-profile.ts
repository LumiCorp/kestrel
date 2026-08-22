import { GatewayModelProviderResolutionError } from "./gateway-lifecycle-error";

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

export function validateOpenRouterModelDetails(input: {
  requestedModelId: string;
  response: unknown;
}): Record<string, unknown> {
  const data =
    input.response &&
    typeof input.response === "object" &&
    !Array.isArray(input.response)
      ? (input.response as Record<string, unknown>).data
      : undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new GatewayModelProviderResolutionError({
      message: `OpenRouter returned invalid model details for ${input.requestedModelId}.`,
    });
  }
  const model = data as Record<string, unknown>;
  if (model.id !== input.requestedModelId) {
    throw new GatewayModelProviderResolutionError({
      message:
        typeof model.id === "string"
          ? `OpenRouter resolved '${input.requestedModelId}' to '${model.id}'. Approve the exact returned model ID.`
          : `OpenRouter did not return the exact model ID '${input.requestedModelId}'.`,
      resolvedModelId: typeof model.id === "string" ? model.id : undefined,
    });
  }
  return model;
}

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

export function getProviderEconomicsFallbackCapability(provider: string) {
  return {
    supportsConservativeFallback: ["anthropic", "openai", "lumi", "ollama", "runpod"].includes(provider),
    requiresValidation: provider === "runpod",
  };
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
    topProvider.context_length ??
      metadata.context_length ??
      metadata.contextWindowTokens ??
      metadata.context_window ??
      metadata.max_input_tokens,
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
    maxOutputTokens > contextWindowTokens
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

export function createKestrelDefaultEconomicsProfile(input: {
  provider: string;
  model: string;
}): GatewayModelEconomicsProfile {
  return {
    version: 1,
    profileId: `${input.provider}:${input.model}:v1`,
    provider: input.provider,
    model: input.model,
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
    counting: {
      counter: "utf8-byte-upper-bound",
      counterVersion: "1",
      method: "conservative_estimate",
      confidence: "conservative",
    },
    cache: { behavior: "none" },
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
    maxOutputTokens > contextWindowTokens ||
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
