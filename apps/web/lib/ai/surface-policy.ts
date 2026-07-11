import {
  type AIRuntimeConfig,
  getAIRuntimeConfig,
  getDefaultAIModel,
  getDefaultBaseURL,
  getDefaultModel,
  getProviderHeaders,
  inferProvider,
} from "./config";

export const AI_SURFACE_POLICY = {
  chat: "gateway-required",
  admin: "gateway-required",
  title: "gateway-required",
  artifact: "gateway-required",
  suggestions: "gateway-required",
  image: "gateway-required",
  speech: "gateway-required",
  embedding: "runtime-direct",
  ocr: "runtime-direct",
  "runtime-direct": "runtime-direct",
} as const;

export type AISurface = keyof typeof AI_SURFACE_POLICY;
export type AISurfacePolicy = (typeof AI_SURFACE_POLICY)[AISurface];
export type DirectRuntimeSurface = Extract<
  AISurface,
  "embedding" | "ocr" | "runtime-direct"
>;

export type DirectRuntimeConfig = AIRuntimeConfig & {
  mode: "live" | "fallback";
  surface: DirectRuntimeSurface;
  usesPlaceholderKey: boolean;
};

const PLACEHOLDER_RUNTIME_API_KEYS = new Set(["sk_your_provider_key"]);
const warnedPlaceholderSurfaces = new Set<DirectRuntimeSurface>();

function getTrimmedEnvValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getAISurfacePolicy(surface: AISurface): AISurfacePolicy {
  return AI_SURFACE_POLICY[surface];
}

export function isPlaceholderRuntimeApiKey(value: string | null | undefined) {
  return value ? PLACEHOLDER_RUNTIME_API_KEYS.has(value.trim()) : false;
}

function buildDirectRuntimeConfig(input: {
  surface: DirectRuntimeSurface;
  provider: string;
  apiKey: string | null;
  baseURL: string;
  model: string;
  headers: Record<string, string>;
}): DirectRuntimeConfig {
  const usesPlaceholderKey = isPlaceholderRuntimeApiKey(input.apiKey);

  return {
    provider: input.provider,
    apiKey: usesPlaceholderKey ? null : input.apiKey,
    baseURL: input.baseURL,
    model: input.model,
    headers: input.headers,
    mode: usesPlaceholderKey || !input.apiKey ? "fallback" : "live",
    surface: input.surface,
    usesPlaceholderKey,
  };
}

function getDirectRuntimeApiKeyForSurface(
  surface: DirectRuntimeSurface,
  env: NodeJS.ProcessEnv
) {
  if (surface === "runtime-direct") {
    return getAIRuntimeConfig(env).apiKey;
  }

  const prefix = surface === "embedding" ? "AI_EMBEDDING" : "AI_OCR";
  return (
    getTrimmedEnvValue(env[`${prefix}_API_KEY`]) ||
    getTrimmedEnvValue(env.OPENAI_API_KEY) ||
    getTrimmedEnvValue(env.AI_AGENT_API_KEY)
  );
}

function getDirectRuntimeProviderForSurface(
  surface: DirectRuntimeSurface,
  env: NodeJS.ProcessEnv
) {
  if (surface === "runtime-direct") {
    return getAIRuntimeConfig(env).provider;
  }

  const prefix = surface === "embedding" ? "AI_EMBEDDING" : "AI_OCR";
  const explicitProvider = getTrimmedEnvValue(env[`${prefix}_PROVIDER`]);
  const explicitBaseURL = getTrimmedEnvValue(env[`${prefix}_BASE_URL`]);

  if (explicitProvider) {
    return explicitProvider;
  }

  if (explicitBaseURL) {
    return inferProvider({
      ...env,
      AI_PROVIDER: "",
      AI_AGENT_BASE_URL: explicitBaseURL,
    });
  }

  return "openai";
}

function getDirectRuntimeModelForSurface(
  surface: DirectRuntimeSurface,
  provider: string,
  env: NodeJS.ProcessEnv
) {
  if (surface === "runtime-direct") {
    return getAIRuntimeConfig(env).model;
  }

  if (surface === "embedding") {
    return (
      getTrimmedEnvValue(env.AI_EMBEDDING_MODEL) || "text-embedding-3-small"
    );
  }

  return (
    getTrimmedEnvValue(env.AI_OCR_MODEL) ||
    getTrimmedEnvValue(env.AI_AGENT_MODEL) ||
    getDefaultModel(provider)
  );
}

export function getDirectRuntimeConfig(
  surface: DirectRuntimeSurface,
  env: NodeJS.ProcessEnv = process.env
): DirectRuntimeConfig {
  if (surface === "runtime-direct") {
    const config = getAIRuntimeConfig(env);

    return buildDirectRuntimeConfig({
      surface,
      provider: config.provider,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      headers: config.headers,
    });
  }

  const provider = getDirectRuntimeProviderForSurface(surface, env);
  const prefix = surface === "embedding" ? "AI_EMBEDDING" : "AI_OCR";
  const baseURL =
    getTrimmedEnvValue(env[`${prefix}_BASE_URL`]) ||
    getDefaultBaseURL(provider);

  return buildDirectRuntimeConfig({
    surface,
    provider,
    apiKey: getDirectRuntimeApiKeyForSurface(surface, env),
    baseURL,
    model: getDirectRuntimeModelForSurface(surface, provider, env),
    headers: getProviderHeaders(provider, env),
  });
}

export function warnIfPlaceholderRuntimeConfig(config: DirectRuntimeConfig) {
  if (
    !config.usesPlaceholderKey ||
    warnedPlaceholderSurfaces.has(config.surface)
  ) {
    return;
  }

  warnedPlaceholderSurfaces.add(config.surface);
  console.warn(
    `Ignoring placeholder API key for ${config.surface} direct runtime surface.`,
    {
      surface: config.surface,
      model: config.model,
      provider: config.provider,
    }
  );
}

export function getGatewayResolutionFailureMessage(input: {
  surface: AISurface;
  modelId?: string | null;
}) {
  if (input.modelId) {
    return `Model "${input.modelId}" is not an approved gateway model for the ${input.surface} surface.`;
  }

  return `No approved gateway model is configured for the ${input.surface} surface.`;
}

export function getDefaultGatewayResolutionSelection(
  env: NodeJS.ProcessEnv = process.env
) {
  return getDefaultAIModel(env);
}
