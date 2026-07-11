import type { SharedToolModule } from "../contracts.js";
import { getInternetProvider, parseSearchInput } from "./shared.js";

export const internetSearchTool: SharedToolModule = {
  definition: {
    name: "internet.search",
    description:
      "Use this for broad web retrieval when you need multiple current or reference candidates across the open web and internet.news is too news-specific. Prefer this over internet.search_advanced for initial gathering; use advanced search only for explicit follow-up constraints such as domains or date ranges.",
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
      capabilityClasses: ["web.search", "reference.search"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: true,
        typicalFailureModes: ["rate_limit_429", "provider_unavailable"],
      },
    },
    presentation: {
      displayName: "Internet Search",
      aliases: ["internet search", "web search", "search internet"],
      keywords: ["internet", "web", "search", "lookup", "research"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async (input: unknown) => {
      const parsed = parseSearchInput("internet.search", input);
      const result = await provider.search(parsed);
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
