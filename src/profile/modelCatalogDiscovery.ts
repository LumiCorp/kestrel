import { DEFAULT_OLLAMA_BASE_URL } from "../../models/ollama/OllamaEnv.js";
import { DEFAULT_OPENROUTER_BASE_URL } from "../../models/openrouter/OpenRouterEnv.js";
import type { ModelProviderId } from "./runtimeProfile.js";
import { MODEL_ALLOWLIST_BY_PROVIDER } from "./modelCatalog.js";

const MODEL_CATALOG_TIMEOUT_MS = 2500;

export interface ResolvedProviderModelCatalog {
  provider: ModelProviderId;
  models: string[];
  source: "live" | "fallback";
  note?: string | undefined;
}

export async function resolveProviderModelCatalog(
  provider: ModelProviderId,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedProviderModelCatalog> {
  switch (provider) {
    case "openrouter":
      return resolveOpenRouterModelCatalog(env, fetchImpl);
    case "ollama":
      return resolveOllamaModelCatalog(env, fetchImpl);
    default:
      return buildFallbackCatalog(provider);
  }
}

function buildFallbackCatalog(
  provider: ModelProviderId,
  note?: string | undefined,
): ResolvedProviderModelCatalog {
  return {
    provider,
    models: [...MODEL_ALLOWLIST_BY_PROVIDER[provider]],
    source: "fallback",
    ...(note !== undefined ? { note } : {}),
  };
}

async function resolveOpenRouterModelCatalog(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ResolvedProviderModelCatalog> {
  const apiKey = readOptionalString(env.OPENROUTER_API_KEY);
  const baseUrl = readOptionalString(env.OPENROUTER_BASE_URL) ?? DEFAULT_OPENROUTER_BASE_URL;
  try {
    const payload = await fetchJson(
      `${trimTrailingSlash(baseUrl)}/api/v1/models`,
      {
        headers: {
          Accept: "application/json",
          ...(apiKey !== undefined ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      fetchImpl,
    );
    const discovered = readOpenRouterModelIds(payload);
    if (discovered.length === 0) {
      return buildFallbackCatalog("openrouter", "Live discovery returned no models; using the curated fallback list.");
    }
    return {
      provider: "openrouter",
      models: rankDiscoveredModels("openrouter", discovered),
      source: "live",
    };
  } catch (error) {
    return buildFallbackCatalog(
      "openrouter",
      `Live discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function resolveOllamaModelCatalog(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ResolvedProviderModelCatalog> {
  const apiKey = readOptionalString(env.OLLAMA_API_KEY);
  const baseUrl = readOptionalString(env.OLLAMA_BASE_URL) ?? DEFAULT_OLLAMA_BASE_URL;
  try {
    const payload = await fetchJson(
      `${trimTrailingSlash(baseUrl)}/api/tags`,
      {
        headers: {
          Accept: "application/json",
          ...(apiKey !== undefined ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      fetchImpl,
    );
    const discovered = readOllamaModelIds(payload);
    if (discovered.length === 0) {
      return buildFallbackCatalog("ollama", "Live discovery returned no models; using the curated fallback list.");
    }
    return {
      provider: "ollama",
      models: rankDiscoveredModels("ollama", discovered),
      source: "live",
    };
  } catch (error) {
    return buildFallbackCatalog(
      "ollama",
      `Live discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_CATALOG_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    if (response.ok === false) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function rankDiscoveredModels(provider: ModelProviderId, discovered: string[]): string[] {
  const preferred = MODEL_ALLOWLIST_BY_PROVIDER[provider];
  const unique = [...new Set(discovered.map((model) => model.trim()).filter((model) => model.length > 0))];
  const preferredRank = new Map(preferred.map((model, index) => [model, index]));
  return unique.sort((left, right) => {
    const leftRank = preferredRank.get(left);
    const rightRank = preferredRank.get(right);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) {
        return 1;
      }
      if (rightRank === undefined) {
        return -1;
      }
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });
}

function readOpenRouterModelIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const data = (value as { data?: unknown }).data;
  if (Array.isArray(data) === false) {
    return [];
  }
  return data
    .map((entry) => (typeof (entry as { id?: unknown })?.id === "string" ? (entry as { id: string }).id.trim() : undefined))
    .filter((entry): entry is string => entry !== undefined && entry.length > 0);
}

function readOllamaModelIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const models = (value as { models?: unknown }).models;
  if (Array.isArray(models) === false) {
    return [];
  }
  return models
    .map((entry) => {
      const record = entry as { model?: unknown; name?: unknown };
      if (typeof record.model === "string" && record.model.trim().length > 0) {
        return record.model.trim();
      }
      return typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : undefined;
    })
    .filter((entry): entry is string => entry !== undefined && entry.length > 0);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
