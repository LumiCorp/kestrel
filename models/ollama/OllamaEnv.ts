import type { OpenAiEnvConfig } from "../contracts.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "llama3.2:3b";

export function loadOllamaEnv(env: NodeJS.ProcessEnv = process.env): OpenAiEnvConfig {
  const model =
    typeof env.OLLAMA_MODEL === "string" && env.OLLAMA_MODEL.length > 0
      ? env.OLLAMA_MODEL
      : DEFAULT_OLLAMA_MODEL;
  const baseUrl =
    typeof env.OLLAMA_BASE_URL === "string" && env.OLLAMA_BASE_URL.length > 0
      ? env.OLLAMA_BASE_URL
      : DEFAULT_OLLAMA_BASE_URL;
  const apiKey =
    typeof env.OLLAMA_API_KEY === "string" && env.OLLAMA_API_KEY.length > 0
      ? env.OLLAMA_API_KEY
      : undefined;

  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    model,
    baseUrl,
    providerName: "ollama",
    providerLabel: "Ollama",
  };
}
