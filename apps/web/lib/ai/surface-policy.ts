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
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const warnedPlaceholderSurfaces = new Set<DirectRuntimeSurface>();

function getTrimmedEnvValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isOfficialOpenRouterBaseURL(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
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

  return (
    getTrimmedEnvValue(env.AI_OCR_API_KEY) ||
    getTrimmedEnvValue(env.OPENAI_API_KEY) ||
    getTrimmedEnvValue(env.AI_AGENT_API_KEY)
  );
}

function getEmbeddingDirectRuntimeConfig(
  env: NodeJS.ProcessEnv
): DirectRuntimeConfig {
  const agentConfig = getAIRuntimeConfig(env);
  const explicitApiKey = getTrimmedEnvValue(env.AI_EMBEDDING_API_KEY);
  const openAIKey = getTrimmedEnvValue(env.OPENAI_API_KEY);
  const openRouterKey = getTrimmedEnvValue(env.OPENROUTER_API_KEY);
  const explicitProvider = getTrimmedEnvValue(env.AI_EMBEDDING_PROVIDER);
  const explicitBaseURL = getTrimmedEnvValue(env.AI_EMBEDDING_BASE_URL);
  const inferredExplicitProvider = explicitBaseURL
    ? inferProvider({
        ...env,
        AI_PROVIDER: "",
        AI_AGENT_BASE_URL: explicitBaseURL,
      })
    : null;
  const configuredProvider = explicitProvider || inferredExplicitProvider;
  const agentUsesOfficialOpenRouter =
    agentConfig.provider === "openrouter" &&
    isOfficialOpenRouterBaseURL(agentConfig.baseURL);
  const provider =
    configuredProvider ||
    (explicitApiKey || openAIKey
      ? "openai"
      : agentUsesOfficialOpenRouter || openRouterKey
        ? "openrouter"
        : "openai");
  const baseURL =
    explicitBaseURL ||
    (provider === "openrouter" && agentUsesOfficialOpenRouter
      ? agentConfig.baseURL
      : getDefaultBaseURL(provider));
  const canReuseAgentApiKey =
    provider === "openrouter" &&
    agentUsesOfficialOpenRouter &&
    isOfficialOpenRouterBaseURL(baseURL) &&
    isOfficialOpenRouterBaseURL(agentConfig.baseURL);
  const apiKey =
    explicitApiKey ||
    (provider === "openai" ? openAIKey : null) ||
    (provider === "openrouter" ? openRouterKey : null) ||
    (canReuseAgentApiKey ? agentConfig.apiKey : null);
  const model =
    getTrimmedEnvValue(env.AI_EMBEDDING_MODEL) ||
    (provider === "openrouter"
      ? DEFAULT_OPENROUTER_EMBEDDING_MODEL
      : DEFAULT_OPENAI_EMBEDDING_MODEL);

  return buildDirectRuntimeConfig({
    surface: "embedding",
    provider,
    apiKey,
    baseURL,
    model,
    headers: getProviderHeaders(provider, env),
  });
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

  if (surface === "embedding") {
    return getEmbeddingDirectRuntimeConfig(env);
  }

  const provider = getDirectRuntimeProviderForSurface(surface, env);
  const prefix = "AI_OCR";
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
