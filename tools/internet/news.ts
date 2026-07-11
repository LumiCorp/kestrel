import type { SharedToolModule } from "../contracts.js";
import { getInternetProvider, parseNewsInput } from "./shared.js";

export const internetNewsTool: SharedToolModule = {
  definition: {
    name: "internet.news",
    description:
      "Use this first for broad current-news gathering when you need multiple distinct live stories or headline candidates. Prefer this over internet.search_advanced for initial story collection, then switch to targeted follow-up only for missing facts or source gaps.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 20 },
        freshness: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["news.search", "news.headlines", "web.search"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: true,
        typicalFailureModes: ["rate_limit_429", "provider_unavailable"],
      },
    },
    presentation: {
      displayName: "Internet News",
      aliases: ["news search", "internet news", "search news"],
      keywords: ["news", "headlines", "latest", "current events"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async (input: unknown) => {
      const parsed = parseNewsInput("internet.news", input);
      const result = await provider.news(parsed);
      return {
        status: result.status,
        provider: result.provider,
        query: result.data.query,
        results: result.data.results,
        attempts: result.attempts,
        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
        ...(result.responseTime !== undefined ? { responseTime: result.responseTime } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.degraded !== undefined ? { degraded: result.degraded } : {}),
      };
    };
  },
};
