import type { OpenRouterEnvConfig } from "../contracts.js";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
} from "./constants.js";

export {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
} from "./constants.js";

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
