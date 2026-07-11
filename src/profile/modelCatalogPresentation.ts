import type { ModelProviderId } from "./runtimeProfile.js";
import type { ResolvedProviderModelCatalog } from "./modelCatalogDiscovery.js";
import { MODEL_ALLOWLIST_BY_PROVIDER } from "./modelCatalog.js";

export const MODEL_RECOMMENDATION_LIMIT = 8;
export const MODEL_RECENT_LIMIT = 3;
export const MODEL_SEARCH_RESULT_LIMIT = 20;

export type RecentModelsByProvider = Partial<Record<ModelProviderId, string[]>>;

export interface PresentedProviderModelCatalog {
  provider: ModelProviderId;
  recommendedModels: string[];
  recentModels: string[];
  additionalAvailableCount: number;
  totalAvailableCount: number;
}

export interface ModelCatalogSearchResult {
  provider: ModelProviderId;
  query: string;
  matches: string[];
  additionalMatchCount: number;
}

export function buildPresentedProviderModelCatalog(input: {
  provider: ModelProviderId;
  catalog: ResolvedProviderModelCatalog;
  recentModelsByProvider?: RecentModelsByProvider | undefined;
}): PresentedProviderModelCatalog {
  const available = new Set(input.catalog.models);
  const curatedRecommendations = MODEL_ALLOWLIST_BY_PROVIDER[input.provider]
    .filter((model) => available.has(model))
    .slice(0, MODEL_RECOMMENDATION_LIMIT);
  const recommendedModels = curatedRecommendations.length > 0
    ? curatedRecommendations
    : input.catalog.models.slice(0, MODEL_RECOMMENDATION_LIMIT);
  const recentModels = (input.recentModelsByProvider?.[input.provider] ?? [])
    .filter((model, index, list) => list.indexOf(model) === index)
    .filter((model) => available.has(model))
    .slice(0, MODEL_RECENT_LIMIT);
  const displayed = new Set([...recommendedModels, ...recentModels]);
  return {
    provider: input.provider,
    recommendedModels,
    recentModels,
    additionalAvailableCount: Math.max(0, input.catalog.models.length - displayed.size),
    totalAvailableCount: input.catalog.models.length,
  };
}

export function searchProviderModelCatalog(input: {
  provider: ModelProviderId;
  catalog: ResolvedProviderModelCatalog;
  query: string;
}): ModelCatalogSearchResult {
  const normalizedQuery = input.query.trim().toLowerCase();
  const matching = normalizedQuery.length === 0
    ? []
    : input.catalog.models.filter((model) => model.toLowerCase().includes(normalizedQuery));
  return {
    provider: input.provider,
    query: input.query.trim(),
    matches: matching.slice(0, MODEL_SEARCH_RESULT_LIMIT),
    additionalMatchCount: Math.max(0, matching.length - MODEL_SEARCH_RESULT_LIMIT),
  };
}

export function updateRecentModelsByProvider(
  recentModelsByProvider: RecentModelsByProvider | undefined,
  provider: ModelProviderId,
  model: string,
): RecentModelsByProvider {
  const next = { ...(recentModelsByProvider ?? {}) };
  const existing = next[provider] ?? [];
  next[provider] = [model, ...existing.filter((entry) => entry !== model)].slice(0, 5);
  return next;
}
