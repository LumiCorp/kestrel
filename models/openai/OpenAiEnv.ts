import type { OpenAiEnvConfig } from "../contracts.js";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-2026-03-05";

export function loadOpenAiEnv(env: NodeJS.ProcessEnv = process.env): OpenAiEnvConfig {
  const apiKey = env.OPENAI_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const model =
    typeof env.OPENAI_MODEL === "string" && env.OPENAI_MODEL.length > 0
      ? env.OPENAI_MODEL
      : DEFAULT_OPENAI_MODEL;

  const baseUrl =
    typeof env.OPENAI_BASE_URL === "string" && env.OPENAI_BASE_URL.length > 0
      ? env.OPENAI_BASE_URL
      : DEFAULT_OPENAI_BASE_URL;

  const organization =
    typeof env.OPENAI_ORG_ID === "string" && env.OPENAI_ORG_ID.length > 0
      ? env.OPENAI_ORG_ID
      : undefined;
  const project =
    typeof env.OPENAI_PROJECT_ID === "string" && env.OPENAI_PROJECT_ID.length > 0
      ? env.OPENAI_PROJECT_ID
      : undefined;

  return {
    apiKey,
    model,
    baseUrl,
    providerName: "openai",
    providerLabel: "OpenAI",
    ...(organization !== undefined ? { organization } : {}),
    ...(project !== undefined ? { project } : {}),
  };
}
