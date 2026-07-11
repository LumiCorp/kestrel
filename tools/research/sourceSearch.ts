import type { SharedToolModule } from "../contracts.js";
import {
  fetchImplOrDefault,
  parseJsonRecord,
  parseObjectInput,
  readNumber,
  requireStringField,
} from "../helpers.js";

export const sourceSearchTool: SharedToolModule = {
  definition: {
    name: "source.search",
    description: "Search Wikipedia for a query and return candidate source URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        topic: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["reference.search", "web.search"],
      suitability: {
        supportsAttribution: true,
        typicalFailureModes: ["rate_limit_429", "provider_unavailable"],
      },
    },
    presentation: {
      displayName: "Wikipedia Search",
      aliases: ["wiki search", "wikipedia search", "wikipedia reference search"],
      keywords: ["wikipedia", "reference", "encyclopedia", "search"],
      provider: "wikipedia",
      toolFamily: "reference",
    },
  },
  createHandler(context) {
    const fetchImpl = fetchImplOrDefault(context.fetchImpl);

    return async (input: unknown) => {
      const body = parseObjectInput("source.search", input);
      const query = sanitizeQuery(
        readInputString(body, "query") ??
          readInputString(body, "topic") ??
          requireStringField("source.search", body, "query"),
      );
      const limit = Math.max(1, Math.min(10, Math.trunc(readNumber(body, "limit") ?? 5)));

      const titleUrl =
        `https://en.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(query)}&limit=${limit}`;

      const response = await fetchImpl(titleUrl);
      if (response.ok === false) {
        if (response.status === 429) {
          const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
          return {
            source: "wikipedia.title_search",
            query,
            results: [],
            error: {
              code: "rate_limited",
              status: response.status,
              message: "Wikipedia search is temporarily rate limited. Try again shortly.",
              ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
            },
          };
        }

        return {
          source: "wikipedia.title_search",
          query,
          results: [],
          error: {
            code: "upstream_error",
            status: response.status,
            message: `source.search failed with status ${response.status}`,
          },
        };
      }

      const payload = parseJsonRecord("source.search", "wikipedia", await response.json(), { query, limit });
      const pages = Array.isArray(payload.pages) ? payload.pages : [];
      const results = pages
        .map((item) => parseJsonRecord("source.search", "wikipedia", item, { query, field: "pages[]" }))
        .map((item) => {
          const key = item.key;
          const title = typeof item.title === "string" ? item.title : "";
          const id = typeof key === "string" ? key : title.replace(/\s+/g, "_");
          const excerpt = typeof item.excerpt === "string" ? stripHtml(item.excerpt) : undefined;
          return {
            id,
            title,
            ...(excerpt !== undefined ? { snippet: excerpt } : {}),
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(id)}`,
            sourceType: "reference",
            source: "wikipedia.title_search",
          };
        })
        .slice(0, limit);

      return {
        source: "wikipedia.title_search",
        query,
        results,
      };
    };
  },
};

function readInputString(
  body: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = body?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeQuery(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim();
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }

  const asNumber = Number.parseInt(value, 10);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return asNumber;
  }

  const retryDateMs = Date.parse(value);
  if (Number.isNaN(retryDateMs)) {
    return undefined;
  }
  const deltaSeconds = Math.ceil((retryDateMs - Date.now()) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : 0;
}
