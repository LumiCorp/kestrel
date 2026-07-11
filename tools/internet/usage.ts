import type { SharedToolModule } from "../contracts.js";
import { getInternetProvider } from "./shared.js";

export const internetUsageTool: SharedToolModule = {
  definition: {
    name: "internet.usage",
    description: "Read Tavily usage diagnostics for the configured API key or project.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["provider.tavily.usage"],
      suitability: {
        supportsAttribution: false,
        supportsAggregation: false,
        typicalFailureModes: ["provider_unavailable", "configuration_missing"],
      },
    },
    presentation: {
      displayName: "Tavily Usage",
      aliases: ["tavily usage", "internet usage"],
      keywords: ["usage", "credits", "tavily"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async () => {
      const result = await provider.usage();
      return {
        status: result.status,
        provider: result.provider,
        ...result.data,
        attempts: result.attempts,
        ...(result.responseTime !== undefined ? { responseTime: result.responseTime } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.degraded !== undefined ? { degraded: result.degraded } : {}),
      };
    };
  },
};
