import type { ModelUsage } from "../kestrel/contracts/model-io.js";
import type {
  EconomicsPricingAttributionV1,
  EconomicsUsageV1,
  ModelEconomicsProfileV1,
} from "./contracts.js";

const TOKENS_PER_MILLION = 1_000_000;

export function normalizeEconomicsUsage(usage: ModelUsage | undefined): EconomicsUsageV1 {
  const inputTokens = nonNegativeInteger(usage?.inputTokens);
  const outputTokens = nonNegativeInteger(usage?.outputTokens);
  const cachedInputTokens = Math.min(inputTokens, nonNegativeInteger(usage?.cachedInputTokens));
  const remainingInputTokens = inputTokens - cachedInputTokens;
  const cacheWriteInputTokens = Math.min(
    remainingInputTokens,
    nonNegativeInteger(usage?.cacheWriteInputTokens),
  );
  const reasoningTokens = Math.min(outputTokens, nonNegativeInteger(usage?.reasoningTokens));
  return {
    version: 1,
    inputTokens,
    outputTokens,
    totalTokens: nonNegativeInteger(usage?.totalTokens) || inputTokens + outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
  };
}

export function attributeModelCallPrice(input: {
  usage: EconomicsUsageV1;
  profile?: ModelEconomicsProfileV1 | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}): EconomicsPricingAttributionV1 {
  if (input.profile === undefined) {
    return { version: 1, status: "unpriced", reason: "model_profile_unavailable" };
  }
  if (
    (input.provider !== undefined && input.profile.provider !== input.provider) ||
    (input.model !== undefined && input.profile.model !== input.model)
  ) {
    return { version: 1, status: "unpriced", reason: "model_profile_mismatch" };
  }
  const price = input.profile.price;
  if (price === undefined) {
    return { version: 1, status: "unpriced", reason: "price_unavailable" };
  }

  const rates = price.perMillionTokens;
  const reasoningTokens = rates.reasoning === undefined ? 0 : input.usage.reasoningTokens;
  const cachedTokens = rates.cachedInput === undefined ? 0 : input.usage.cachedInputTokens;
  const cacheWriteTokens = rates.cacheWrite === undefined ? 0 : input.usage.cacheWriteInputTokens;
  const baseInputTokens = Math.max(0, input.usage.inputTokens - cachedTokens - cacheWriteTokens);
  const baseOutputTokens = Math.max(0, input.usage.outputTokens - reasoningTokens);
  const components: Extract<EconomicsPricingAttributionV1, { status: "priced" }>["components"] = [
    component("input", baseInputTokens, rates.input),
    component("output", baseOutputTokens, rates.output),
  ];
  if (rates.cachedInput !== undefined) {
    components.push(component("cached_input", input.usage.cachedInputTokens, rates.cachedInput));
  }
  if (rates.cacheWrite !== undefined) {
    components.push(component("cache_write", input.usage.cacheWriteInputTokens, rates.cacheWrite));
  }
  if (rates.reasoning !== undefined) {
    components.push(component("reasoning", input.usage.reasoningTokens, rates.reasoning));
  }
  return {
    version: 1,
    status: "priced",
    currency: "USD",
    priceVersion: price.priceVersion,
    sourceUrl: price.sourceUrl,
    totalCostUsd: components.reduce((total, entry) => total + entry.costUsd, 0),
    components,
  };
}

function component(
  category: Extract<EconomicsPricingAttributionV1, { status: "priced" }>["components"][number]["category"],
  tokens: number,
  ratePerMillionTokens: number,
): Extract<EconomicsPricingAttributionV1, { status: "priced" }>["components"][number] {
  return {
    category,
    tokens,
    ratePerMillionTokens,
    costUsd: (tokens * ratePerMillionTokens) / TOKENS_PER_MILLION,
  };
}

function nonNegativeInteger(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
