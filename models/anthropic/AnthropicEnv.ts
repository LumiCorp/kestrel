import type { AnthropicEnvConfig } from "../contracts.js";

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export function loadAnthropicEnv(env: NodeJS.ProcessEnv = process.env): AnthropicEnvConfig {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }

  return {
    apiKey,
    model:
      typeof env.ANTHROPIC_MODEL === "string" && env.ANTHROPIC_MODEL.length > 0
        ? env.ANTHROPIC_MODEL
        : DEFAULT_ANTHROPIC_MODEL,
    baseUrl:
      typeof env.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL.length > 0
        ? env.ANTHROPIC_BASE_URL
        : DEFAULT_ANTHROPIC_BASE_URL,
    version:
      typeof env.ANTHROPIC_VERSION === "string" && env.ANTHROPIC_VERSION.length > 0
        ? env.ANTHROPIC_VERSION
        : DEFAULT_ANTHROPIC_VERSION,
  };
}
