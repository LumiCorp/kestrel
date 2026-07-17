import type { SharedToolModule } from "../contracts.js";
import {
  asRecord,
  ensureFetchOk,
  fetchImplOrDefault,
  parseJsonRecord,
  parseObjectInput,
  requireStringField,
} from "../helpers.js";

export const wikipediaLookupTool: SharedToolModule = {
  definition: {
    name: "free.wikipedia.lookup",
    description: "Lookup a topic summary from Wikipedia.",
    capability: {
      freshnessClass: "static",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["encyclopedia.lookup", "encyclopedia.summary"],
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Topic or page title to lookup." },
        title: { type: "string", description: "Alias for query." },
      },
      additionalProperties: false,
    },
    presentation: {
      displayName: "Wikipedia Lookup",
      aliases: ["wikipedia lookup", "wiki lookup", "encyclopedia lookup"],
      keywords: ["wikipedia", "lookup", "reference", "summary"],
      provider: "wikipedia",
      toolFamily: "reference",
    },
  },
  createHandler(context) {
    const fetchImpl = fetchImplOrDefault(context.fetchImpl);
    return async (input: unknown) => {
      const body = parseObjectInput("free.wikipedia.lookup", input);
      const query =
        readInputString(body, "query") ??
        readInputString(body, "title") ??
        requireStringField("free.wikipedia.lookup", body, "query");
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
      const response = await fetchImpl(url);
      ensureFetchOk("free.wikipedia.lookup", "wikipedia", response, { query });

      const payload = parseJsonRecord("free.wikipedia.lookup", "wikipedia", await response.json(), { query });
      return {
        source: "wikipedia",
        title: typeof payload.title === "string" ? payload.title : query,
        summary: typeof payload.extract === "string" ? payload.extract : "",
        url: asRecord(payload.content_urls)?.desktop,
      };
    };
  },
};

function readInputString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  if (typeof field !== "string") {
    return ;
  }
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
