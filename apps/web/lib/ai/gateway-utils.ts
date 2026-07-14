export type GatewayProtocolProvider =
  | "anthropic"
  | "lumi"
  | "openai"
  | "openrouter"
  | "ollama"
  | "runpod"
  | "replicate";

export type GatewayProtocolModality =
  | "language"
  | "image"
  | "speech"
  | "video"
  | "embedding";

export type GatewayLanguageProtocol = "openai" | "anthropic";

export const GATEWAY_PROVIDERS = [
  "anthropic",
  "lumi",
  "openai",
  "openrouter",
  "ollama",
  "runpod",
  "replicate",
] as const;

export const GATEWAY_MODALITIES = [
  "language",
  "image",
  "speech",
  "video",
  "embedding",
] as const;

const KESTREL_RUNTIME_LANGUAGE_PROVIDERS = new Set<GatewayProtocolProvider>([
  "anthropic",
  "lumi",
  "ollama",
  "openai",
  "openrouter",
  "runpod",
]);

const GATEWAY_SELECTION_PRIORITY: Record<GatewayProtocolProvider, number> = {
  openai: 0,
  lumi: 1,
  anthropic: 2,
  ollama: 3,
  openrouter: 4,
  runpod: 5,
  replicate: 6,
};

const PROVIDER_SUPPORTED_MODALITIES: Record<
  GatewayProtocolProvider,
  GatewayProtocolModality[]
> = {
  anthropic: ["language"],
  lumi: ["language", "image", "speech", "embedding"],
  openai: ["language", "image", "speech", "embedding"],
  openrouter: ["language", "image", "speech", "embedding"],
  ollama: ["language", "embedding"],
  runpod: ["language"],
  replicate: ["image", "video"],
};

const RUNPOD_ENDPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export function normalizeRunPodEndpointId(value: unknown): string {
  const endpointId = typeof value === "string" ? value.trim() : "";
  if (!RUNPOD_ENDPOINT_ID_PATTERN.test(endpointId)) {
    throw new Error("RunPod endpoint ID is invalid.");
  }
  return endpointId;
}

export function buildRunPodServerlessBaseUrl(endpointId: unknown): string {
  return `https://api.runpod.ai/v2/${normalizeRunPodEndpointId(endpointId)}/openai/v1`;
}

export function isRunPodServerlessBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    const match = /^\/v2\/([^/]+)\/openai\/v1\/?$/u.exec(url.pathname);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.runpod.ai" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      match !== null &&
      normalizeRunPodEndpointId(match[1]) === match[1]
    );
  } catch {
    return false;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function normalizeOpenAICompatibleBaseUrl(
  baseUrl: string | null | undefined
) {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "") || "";
  if (!trimmed) {
    return null;
  }

  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function getProviderSupportedModalities(
  provider: GatewayProtocolProvider
) {
  return PROVIDER_SUPPORTED_MODALITIES[provider];
}

export function isKestrelRuntimeLanguageProvider(
  provider: GatewayProtocolProvider
): provider is
  | "anthropic"
  | "lumi"
  | "ollama"
  | "openai"
  | "openrouter"
  | "runpod" {
  return KESTREL_RUNTIME_LANGUAGE_PROVIDERS.has(provider);
}

export function selectPreferredGatewayModelId(
  models: Array<{ id: string; isDefault: boolean }>,
  selectedModelId?: string | null,
  fallbackModelId?: string | null
) {
  for (const candidate of [selectedModelId, fallbackModelId]) {
    if (candidate && models.some((model) => model.id === candidate)) {
      return candidate;
    }
  }

  return models.find((model) => model.isDefault)?.id || models[0]?.id || null;
}

export function isGatewayModelDefault(input: {
  environmentDefaultModelId?: string | null;
  modelId: string;
  modelIsDefault: boolean;
}) {
  return input.environmentDefaultModelId
    ? input.environmentDefaultModelId === input.modelId
    : input.modelIsDefault;
}

export function selectGatewayModelSelection<
  T extends {
    id: string;
    alias: string | null;
    rawModelId: string;
    gatewayProvider: GatewayProtocolProvider;
    isDefault: boolean;
  },
>(models: T[], selection?: string | null): T | null {
  if (models.length === 0) {
    return null;
  }
  if (!selection) {
    return models.find((model) => model.isDefault) || models[0] || null;
  }

  const explicitMatches = models.filter(
    (model) =>
      model.id === selection ||
      model.alias === selection ||
      `${model.gatewayProvider}/${model.rawModelId}` === selection
  );
  if (explicitMatches.length === 0) {
    return null;
  }
  const exactIdMatches = explicitMatches.filter(
    (model) => model.id === selection
  );
  const exactSourceMatches = explicitMatches.filter(
    (model) => `${model.gatewayProvider}/${model.rawModelId}` === selection
  );
  const candidatePool =
    exactIdMatches.length > 0
      ? exactIdMatches
      : exactSourceMatches.length > 0
        ? exactSourceMatches
        : explicitMatches;

  return (
    [...candidatePool].sort((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      return (
        GATEWAY_SELECTION_PRIORITY[left.gatewayProvider] -
        GATEWAY_SELECTION_PRIORITY[right.gatewayProvider]
      );
    })[0] || null
  );
}

export function getGatewayLanguageProtocol(input: {
  gatewayProvider: GatewayProtocolProvider;
  modality: GatewayProtocolModality;
  metadata: unknown;
}): GatewayLanguageProtocol {
  if (input.gatewayProvider !== "lumi" || input.modality !== "language") {
    return "openai";
  }

  return toRecord(input.metadata).protocol === "anthropic"
    ? "anthropic"
    : "openai";
}

export function normalizeGatewayModelMetadata(input: {
  gatewayProvider: GatewayProtocolProvider;
  modality: GatewayProtocolModality;
  metadata: unknown;
}) {
  const metadata = toRecord(input.metadata);

  if (input.gatewayProvider === "lumi" && input.modality === "language") {
    return {
      ...metadata,
      protocol: getGatewayLanguageProtocol(input),
    } satisfies Record<string, unknown>;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}
