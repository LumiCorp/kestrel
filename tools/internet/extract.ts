import type { SharedToolModule } from "../contracts.js";
import { getInternetProvider, parseExtractInput } from "./shared.js";

export const internetExtractTool: SharedToolModule = {
  definition: {
    name: "internet.extract",
    description: "Extract text content from one or more public absolute http/https URLs. Do not use for localhost, private network, or local app URLs.",
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, description: "Public absolute http or https URL." },
        },
        url: { type: "string", minLength: 1, description: "Public absolute http or https URL. Alias for a single-item urls array." },
        maxChars: { type: "number", minimum: 500, maximum: 200000 },
        query: { type: "string" },
        chunksPerSource: {
          type: "number",
          minimum: 1,
          maximum: 5,
          description: "Only sent to Tavily when query is provided.",
        },
        extractDepth: { type: "string", enum: ["basic", "advanced"] },
        format: { type: "string", enum: ["markdown", "text"] },
        includeImages: { type: "boolean" },
        includeFavicon: { type: "boolean" },
        includeUsage: { type: "boolean" },
      },
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["web.fetch", "web.extract", "web.scrape"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: true,
        typicalFailureModes: ["provider_unavailable", "malformed_source_records"],
      },
    },
    presentation: {
      displayName: "Extract URLs",
      aliases: ["extract url", "fetch url", "retrieve page", "page extract"],
      keywords: ["url", "fetch", "page", "extract", "content"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async (input: unknown) => {
      const parsed = parseExtractInput("internet.extract", input);
      const result = await provider.extract(parsed);
      const first = result.data.results[0];
      return {
        status: result.status,
        provider: result.provider,
        results: result.data.results,
        failedResults: result.data.failedResults,
        ...(first !== undefined ? first : {}),
        attempts: result.attempts,
        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
        ...(result.responseTime !== undefined ? { responseTime: result.responseTime } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.degraded !== undefined ? { degraded: result.degraded } : {}),
      };
    };
  },
};
