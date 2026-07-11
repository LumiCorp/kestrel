import type { SharedToolModule } from "../contracts.js";
import { getInternetProvider, parseImagesInput } from "./shared.js";

export const internetImagesTool: SharedToolModule = {
  definition: {
    name: "internet.images",
    description: "Search internet images and return normalized image metadata.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["web.image_search"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: true,
        typicalFailureModes: ["rate_limit_429", "provider_unavailable"],
      },
    },
    presentation: {
      displayName: "Internet Images",
      aliases: ["image search", "search images", "internet images"],
      keywords: ["images", "photos", "pictures", "visual search"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async (input: unknown) => {
      const parsed = parseImagesInput("internet.images", input);
      const result = await provider.images(parsed);
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
