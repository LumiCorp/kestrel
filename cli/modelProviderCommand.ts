import type {
  ModelProviderId,
  ModelCatalogSearchResult,
  PresentedProviderModelCatalog,
  ResolvedProviderModelCatalog,
} from "../src/index.js";

export const MODEL_SET_PROVIDER_IDS = [
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
] as const satisfies readonly ModelProviderId[];

export const MODEL_SET_PROVIDER_USAGE = `<${MODEL_SET_PROVIDER_IDS.join("|")}> [model]`;

export function isSupportedModelSetProvider(value: unknown): value is (typeof MODEL_SET_PROVIDER_IDS)[number] {
  return typeof value === "string" && MODEL_SET_PROVIDER_IDS.includes(value as (typeof MODEL_SET_PROVIDER_IDS)[number]);
}

export function formatModelOptions(models: readonly string[], selectedModel?: string | undefined): string {
  return models
    .map((model) => `${model === selectedModel ? "*" : "-"} ${model}`)
    .join("\n");
}

export function buildModelOptionsBlock(input: {
  provider: ModelProviderId;
  models: readonly string[];
  selectedModel?: string | undefined;
  heading?: string | undefined;
}): string {
  const heading = input.heading ?? `Available models for '${input.provider}':`;
  return `${heading}\n${formatModelOptions(input.models, input.selectedModel)}`;
}

export function buildModelCatalogStatusLine(catalog: ResolvedProviderModelCatalog): string {
  return catalog.source === "live" ? "modelCatalog=live" : "modelCatalog=fallback";
}

export function buildModelSummaryBlock(input: {
  provider: ModelProviderId;
  summary: PresentedProviderModelCatalog;
  selectedModel?: string | undefined;
  searchCommand?: string | undefined;
  setCommand?: string | undefined;
}): string[] {
  const sections: string[] = [];
  if (input.summary.recommendedModels.length > 0) {
    sections.push(
      buildModelOptionsBlock({
        provider: input.provider,
        models: input.summary.recommendedModels,
        selectedModel: input.selectedModel,
        heading: `Recommended models for '${input.provider}':`,
      }),
    );
  }
  if (input.summary.recentModels.length > 0) {
    sections.push(
      buildModelOptionsBlock({
        provider: input.provider,
        models: input.summary.recentModels,
        selectedModel: input.selectedModel,
        heading: `Recent models for '${input.provider}':`,
      }),
    );
  }
  sections.push(`additionalAvailableModels=${input.summary.additionalAvailableCount}`);
  sections.push(`Use ${input.searchCommand ?? "/model search <query>"} to browse ${input.summary.totalAvailableCount} available models.`);
  sections.push(`Use ${input.setCommand ?? "/model set <exact-model-id>"} to pick a model directly.`);
  return sections;
}

export function buildModelSearchResultBlock(
  result: ModelCatalogSearchResult,
  options?: {
    searchCommand?: string | undefined;
    setCommand?: string | undefined;
  },
): string[] {
  if (result.matches.length === 0) {
    return [
      `No models matched '${result.query}' for provider '${result.provider}'.`,
      `Use ${options?.searchCommand ?? "/model search <query>"} with a shorter or different query.`,
    ];
  }
  return [
    `Model search results for '${result.query}' (${result.provider}):`,
    formatModelOptions(result.matches),
    ...(result.additionalMatchCount > 0 ? [`additionalMatches=${result.additionalMatchCount}`] : []),
    `Use ${options?.setCommand ?? "/model set <exact-model-id>"} to pick one of these models.`,
  ];
}
