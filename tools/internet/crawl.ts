import type { SharedToolModule } from "../contracts.js";
import { getInternetProvider, parseCrawlInput } from "./shared.js";

export const internetCrawlTool: SharedToolModule = {
  definition: {
    name: "internet.crawl",
    description: "Crawl a public website from a base URL and extract content from discovered pages. Do not use for localhost, private network, or local app URLs.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, description: "Public absolute http or https URL." },
        instructions: { type: "string" },
        maxDepth: { type: "number", minimum: 1, maximum: 5 },
        maxBreadth: { type: "number", minimum: 1, maximum: 500 },
        limit: { type: "number", minimum: 1, maximum: 100 },
        selectPaths: { type: "array", maxItems: 100, items: { type: "string" } },
        selectDomains: { type: "array", maxItems: 100, items: { type: "string" } },
        excludePaths: { type: "array", maxItems: 100, items: { type: "string" } },
        excludeDomains: { type: "array", maxItems: 100, items: { type: "string" } },
        allowExternal: { type: "boolean" },
        extractDepth: { type: "string", enum: ["basic", "advanced"] },
        format: { type: "string", enum: ["markdown", "text"] },
        includeImages: { type: "boolean" },
        includeFavicon: { type: "boolean" },
        includeUsage: { type: "boolean" },
        chunksPerSource: {
          type: "number",
          minimum: 1,
          maximum: 5,
          description: "Only sent to Tavily when instructions are provided.",
        },
        maxChars: { type: "number", minimum: 500, maximum: 200_000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "high",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["web.crawl", "web.extract"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: true,
        typicalFailureModes: ["rate_limit_429", "provider_unavailable"],
      },
    },
    presentation: {
      displayName: "Crawl Site",
      aliases: ["crawl site", "website crawl", "crawl url"],
      keywords: ["crawl", "site", "website", "extract"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async (input: unknown) => {
      const parsed = parseCrawlInput("internet.crawl", input);
      const result = await provider.crawl(parsed);
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
