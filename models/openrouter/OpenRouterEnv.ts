import type { OpenRouterEnvConfig } from "../contracts.js";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai";
export const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.2";

export function loadOpenRouterEnv(env: NodeJS.ProcessEnv = process.env): OpenRouterEnvConfig {
  const apiKey = env.OPENROUTER_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("OPENROUTER_API_KEY is required");
  }

  const model =
    typeof env.OPENROUTER_MODEL === "string" && env.OPENROUTER_MODEL.length > 0
      ? env.OPENROUTER_MODEL
      : DEFAULT_OPENROUTER_MODEL;

  const baseUrl =
    typeof env.OPENROUTER_BASE_URL === "string" && env.OPENROUTER_BASE_URL.length > 0
      ? env.OPENROUTER_BASE_URL
      : DEFAULT_OPENROUTER_BASE_URL;

  const siteUrl =
    typeof env.OPENROUTER_SITE_URL === "string" && env.OPENROUTER_SITE_URL.length > 0
      ? env.OPENROUTER_SITE_URL
      : undefined;

  const appName =
    typeof env.OPENROUTER_APP_NAME === "string" && env.OPENROUTER_APP_NAME.length > 0
      ? env.OPENROUTER_APP_NAME
      : undefined;

  return {
    apiKey,
    model,
    baseUrl,
    siteUrl,
    appName,
  };
}
