const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const OPENAI_PROVIDER = "openai";
const OPENROUTER_PROVIDER = "openrouter";
const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5-mini";

type AIProviderName = string;

export type AIRuntimeConfig = {
  provider: AIProviderName;
  apiKey: string | null;
  baseURL: string;
  model: string;
  headers: Record<string, string>;
};

function getTrimmedEnvValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function inferProvider(env: NodeJS.ProcessEnv = process.env) {
  const explicitProvider = getTrimmedEnvValue(env.AI_PROVIDER);

  if (explicitProvider) {
    return explicitProvider;
  }

  const baseURL = getTrimmedEnvValue(env.AI_AGENT_BASE_URL);

  if (baseURL?.includes("openrouter.ai")) {
    return OPENROUTER_PROVIDER;
  }

  return OPENAI_PROVIDER;
}

export function getDefaultBaseURL(provider: AIProviderName) {
  return provider === OPENROUTER_PROVIDER
    ? OPENROUTER_API_BASE_URL
    : OPENAI_API_BASE_URL;
}

export function getDefaultModel(provider: AIProviderName) {
  return provider === OPENROUTER_PROVIDER
    ? DEFAULT_OPENROUTER_MODEL
    : DEFAULT_OPENAI_MODEL;
}

export function getProviderHeaders(
  provider: AIProviderName,
  env: NodeJS.ProcessEnv = process.env
) {
  const headers: Record<string, string> = {};

  if (provider === OPENROUTER_PROVIDER) {
    const siteUrl = getTrimmedEnvValue(env.AI_AGENT_SITE_URL);
    const siteName = getTrimmedEnvValue(env.AI_AGENT_SITE_NAME);

    if (siteUrl) {
      headers["HTTP-Referer"] = siteUrl;
    }

    if (siteName) {
      headers["X-Title"] = siteName;
    }
  }

  return headers;
}

export function getAIRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): AIRuntimeConfig {
  const provider = inferProvider(env);

  return {
    provider,
    apiKey: getTrimmedEnvValue(env.AI_AGENT_API_KEY),
    baseURL:
      getTrimmedEnvValue(env.AI_AGENT_BASE_URL) || getDefaultBaseURL(provider),
    model: getTrimmedEnvValue(env.AI_AGENT_MODEL) || getDefaultModel(provider),
    headers: getProviderHeaders(provider, env),
  };
}

export function getDefaultAIModel(env: NodeJS.ProcessEnv = process.env) {
  return getAIRuntimeConfig(env).model;
}
