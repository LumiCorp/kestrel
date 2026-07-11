import type { SharedToolModule } from "../contracts.js";
import { getInternetProvider, parseResearchStatusInput } from "./shared.js";

export const internetResearchStatusTool: SharedToolModule = {
  definition: {
    name: "internet.research_status",
    description: "Fetch the current status or completed result for a Tavily Research request ID.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", minLength: 1 },
      },
      required: ["requestId"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["research.status", "web.research"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: false,
        typicalFailureModes: ["provider_unavailable", "async_pending"],
      },
    },
    presentation: {
      displayName: "Research Status",
      aliases: ["research status", "tavily research status"],
      keywords: ["research", "status", "request"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async (input: unknown) => {
      const parsed = parseResearchStatusInput("internet.research_status", input);
      const result = await provider.researchStatus(parsed);
      const { status: taskStatus, ...data } = result.data;
      return {
        status: result.status,
        provider: result.provider,
        ...data,
        researchStatus: taskStatus,
        attempts: result.attempts,
        ...(result.responseTime !== undefined ? { responseTime: result.responseTime } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.degraded !== undefined ? { degraded: result.degraded } : {}),
      };
    };
  },
};
