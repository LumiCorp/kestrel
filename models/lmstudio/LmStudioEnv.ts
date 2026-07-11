import type { OpenAiEnvConfig } from "../contracts.js";

export const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234";
export const DEFAULT_LMSTUDIO_MODEL = "local-model";

export function loadLmStudioEnv(env: NodeJS.ProcessEnv = process.env): OpenAiEnvConfig {
  const model =
    typeof env.LMSTUDIO_MODEL === "string" && env.LMSTUDIO_MODEL.length > 0
      ? env.LMSTUDIO_MODEL
      : DEFAULT_LMSTUDIO_MODEL;
  const baseUrl =
    typeof env.LMSTUDIO_BASE_URL === "string" && env.LMSTUDIO_BASE_URL.length > 0
      ? env.LMSTUDIO_BASE_URL
      : DEFAULT_LMSTUDIO_BASE_URL;
  const apiKey =
    typeof env.LMSTUDIO_API_KEY === "string" && env.LMSTUDIO_API_KEY.length > 0
      ? env.LMSTUDIO_API_KEY
      : undefined;

  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    model,
    baseUrl,
    providerName: "lmstudio",
    providerLabel: "LM Studio",
  };
}
