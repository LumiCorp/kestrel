import { DEFAULT_MODEL_BY_PROVIDER, type ModelProviderId } from "./runtimeProfile.js";

const RAW_MODEL_ALLOWLIST_BY_PROVIDER: Record<ModelProviderId, readonly string[]> = {
  openrouter: [
    "z-ai/glm-5.2",
    "openai/gpt-5.4-mini",
    "openai/gpt-5.2-chat",
    "anthropic/claude-sonnet-4.5",
  ],
  openai: [
    "gpt-5.4-2026-03-05",
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
  ],
  anthropic: [
    "claude-3-5-haiku-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-7-sonnet",
  ],
  ollama: [
    "llama3.2:3b",
    "qwen2.5-coder",
  ],
  lmstudio: [
    "local-model",
    "qwen2.5-coder",
  ],
};

const MODEL_PROVIDER_IDS = Object.keys(DEFAULT_MODEL_BY_PROVIDER) as ModelProviderId[];

function buildModelAllowlistByProvider(): Record<ModelProviderId, readonly string[]> {
  const allowlist = {} as Record<ModelProviderId, readonly string[]>;
  for (const provider of MODEL_PROVIDER_IDS) {
    const ordered = [
      DEFAULT_MODEL_BY_PROVIDER[provider],
      ...RAW_MODEL_ALLOWLIST_BY_PROVIDER[provider],
    ];
    allowlist[provider] = [...new Set(ordered)];
  }
  return allowlist;
}

export const MODEL_ALLOWLIST_BY_PROVIDER: Record<ModelProviderId, readonly string[]> = buildModelAllowlistByProvider();

export function listAllowedModelsForProvider(provider: ModelProviderId): readonly string[] {
  return MODEL_ALLOWLIST_BY_PROVIDER[provider];
}

export function isAllowedModelForProvider(provider: ModelProviderId, model: string): boolean {
  return MODEL_ALLOWLIST_BY_PROVIDER[provider].includes(model);
}
