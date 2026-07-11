export type GatewayProtocolProvider =
  | "anthropic"
  | "lumi"
  | "openai"
  | "openrouter"
  | "ollama"
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
  "replicate",
] as const;

export const GATEWAY_MODALITIES = [
  "language",
  "image",
  "speech",
  "video",
  "embedding",
] as const;

const PROVIDER_SUPPORTED_MODALITIES: Record<
  GatewayProtocolProvider,
  GatewayProtocolModality[]
> = {
  anthropic: ["language"],
  lumi: ["language", "image", "speech", "embedding"],
  openai: ["language", "image", "speech", "embedding"],
  openrouter: ["language", "image", "speech", "embedding"],
  ollama: ["language", "embedding"],
  replicate: ["image", "video"],
};

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
