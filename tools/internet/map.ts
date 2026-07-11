import type { SharedToolModule } from "../contracts.js";
import { getInternetProvider, parseMapInput } from "./shared.js";

export const internetMapTool: SharedToolModule = {
  definition: {
    name: "internet.map",
    description: "Map and discover URLs from a public website starting from a root URL. Do not use for localhost, private network, or local app URLs.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, description: "Public absolute http or https URL." },
        instructions: { type: "string" },
        maxDepth: { type: "number", minimum: 1, maximum: 5 },
        maxBreadth: { type: "number", minimum: 1, maximum: 500 },
        limit: { type: "number", minimum: 1, maximum: 500 },
        selectPaths: { type: "array", maxItems: 100, items: { type: "string" } },
        selectDomains: { type: "array", maxItems: 100, items: { type: "string" } },
        excludePaths: { type: "array", maxItems: 100, items: { type: "string" } },
        excludeDomains: { type: "array", maxItems: 100, items: { type: "string" } },
        allowExternal: { type: "boolean" },
        includeUsage: { type: "boolean" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["web.map", "web.discovery"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: true,
        typicalFailureModes: ["rate_limit_429", "provider_unavailable"],
      },
    },
    presentation: {
      displayName: "Map Site",
      aliases: ["map site", "discover urls", "site map"],
      keywords: ["map", "urls", "site", "discover"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async (input: unknown) => {
      const parsed = parseMapInput("internet.map", input);
      const result = await provider.map(parsed);
      return {
        status: result.status,
        provider: result.provider,
        baseUrl: result.data.baseUrl,
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
