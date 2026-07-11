import type { SharedToolModule } from "../contracts.js";
import { getInternetProvider, parseResearchInput } from "./shared.js";

export const internetResearchTool: SharedToolModule = {
  definition: {
    name: "internet.research",
    description: "Submit a Tavily Research task and optionally poll for the completed research output.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string" },
        query: { type: "string" },
        topic: { type: "string" },
        model: { type: "string", enum: ["mini", "pro", "auto"] },
        outputSchema: { type: "object" },
        citationFormat: { type: "string", enum: ["numbered", "mla", "apa", "chicago"] },
        waitForCompletion: { type: "boolean" },
        maxWaitMs: { type: "number", minimum: 1000, maximum: 120000 },
        pollIntervalMs: { type: "number", minimum: 250, maximum: 10000 },
      },
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "high",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["research.deep_report", "web.research"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: true,
        typicalFailureModes: ["rate_limit_429", "provider_unavailable", "async_pending"],
      },
    },
    presentation: {
      displayName: "Internet Research",
      aliases: ["deep research", "research report", "tavily research"],
      keywords: ["research", "report", "sources", "tavily"],
      provider: "tavily",
      toolFamily: "internet",
    },
  },
  createHandler(context) {
    const provider = getInternetProvider(context);

    return async (input: unknown) => {
      const parsed = parseResearchInput("internet.research", input);
      const result = await provider.research(parsed);
      const { status: taskStatus, ...data } = result.data;
      return {
        status: result.status,
        provider: result.provider,
        ...data,
        researchStatus: taskStatus,
        attempts: result.attempts,
        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
        ...(result.responseTime !== undefined ? { responseTime: result.responseTime } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.degraded !== undefined ? { degraded: result.degraded } : {}),
      };
    };
  },
};
