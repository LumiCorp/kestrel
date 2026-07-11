import type { SharedToolModule } from "../contracts.js";
import { TAVILY_SEARCH_COUNTRIES } from "./countries.js";
import { getInternetProvider, parseAdvancedSearchInput } from "./shared.js";

export const internetSearchAdvancedTool: SharedToolModule = {
  definition: {
    name: "internet.search_advanced",
    description:
      "Use this only after broad internet.news or internet.search gathering has already happened and you still need targeted follow-up retrieval with explicit Tavily controls such as domains, search depth, or date ranges. Do not use this as the default broad story-gathering tool, and stop using it once the retained evidence set is large enough to synthesize. exactMatch is only for queries that already include at least one double-quoted phrase.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 20 },
        freshness: { type: "string", enum: ["day", "week", "month", "year", "d", "w", "m", "y"] },
        topic: { type: "string", enum: ["general", "news", "finance"] },
        searchDepth: { type: "string", enum: ["basic", "advanced", "fast", "ultra-fast"] },
        chunksPerSource: {
          type: "number",
          minimum: 1,
          maximum: 3,
          description: "Only sent to Tavily when searchDepth is advanced.",
        },
        days: {
          type: "number",
          minimum: 1,
          maximum: 365,
          description: "Only sent to Tavily for topic news and never with startDate or endDate.",
        },
        startDate: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description:
            "Explicit YYYY-MM-DD start date for a targeted date range. If endDate is also provided, it must differ from startDate.",
        },
        endDate: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description:
            "Explicit YYYY-MM-DD end date for a targeted date range. Must differ from startDate when both are provided.",
        },
        country: {
          type: "string",
          enum: [...TAVILY_SEARCH_COUNTRIES],
          description: "Lowercase Tavily-supported country name. Only available when topic is general.",
        },
        includeAnswer: {
          anyOf: [
            { type: "boolean" },
            { type: "string", enum: ["basic", "advanced"] },
          ],
        },
        includeRawContent: {
          anyOf: [
            { type: "boolean" },
            { type: "string", enum: ["markdown", "text"] },
          ],
        },
        includeFavicon: { type: "boolean" },
        includeUsage: { type: "boolean" },
        exactMatch: {
          type: "boolean",
          description:
            "Use only when the query already includes at least one double-quoted phrase that must be matched exactly (e.g. \"\\\"John Smith\\\" CEO\"). Do not set this for general topic searches.",
        },
        domainAllow: {
          type: "array",
          maxItems: 300,
          items: {
            type: "string",
            minLength: 1,
            description:
              "Hostname only, such as example.com. Use this to narrow targeted follow-up searches to specific publishers. Do not include schemes, paths, or content categories.",
          },
        },
        domainDeny: {
          type: "array",
          maxItems: 150,
          items: {
            type: "string",
            minLength: 1,
            description:
              "Hostname only, such as example.com. Use this to exclude publishers from targeted follow-up searches. Do not include schemes, paths, or content categories.",
          },
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["web.search", "reference.search", "provider.tavily.advanced"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: true,
        typicalFailureModes: ["rate_limit_429", "provider_unavailable", "provider_contract_rejected"],
      },
    },
    presentation: {
      displayName: "Advanced Internet Search",
      aliases: ["advanced internet search", "tavily search", "domain search"],
      keywords: ["internet", "web", "search", "domains", "tavily", "advanced"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async (input: unknown) => {
      const parsed = parseAdvancedSearchInput("internet.search_advanced", input);
      const result = await provider.searchAdvanced(parsed);
      return {
        status: result.status,
        provider: result.provider,
        query: result.data.query,
        ...(result.data.answer !== undefined ? { answer: result.data.answer } : {}),
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
