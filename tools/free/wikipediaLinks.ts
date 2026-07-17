import type { SharedToolModule } from "../contracts.js";
import {
  ensureFetchOk,
  fetchImplOrDefault,
  parseJsonRecord,
  parseObjectInput,
  readNumber,
  requireStringField,
} from "../helpers.js";

interface WikipediaLinkItem {
  title: string;
  url: string;
}

export const wikipediaLinksTool: SharedToolModule = {
  definition: {
    name: "free.wikipedia.links",
    description: "Lookup outbound links for a Wikipedia page title.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Wikipedia page title." },
        limit: { type: "number", description: "Maximum links to return (1-500, default 100)." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "static",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["encyclopedia.links"],
    },
    presentation: {
      displayName: "Wikipedia Links",
      aliases: ["wikipedia links", "wiki links", "page links"],
      keywords: ["wikipedia", "links", "reference", "encyclopedia"],
      provider: "wikipedia",
      toolFamily: "reference",
    },
  },
  createHandler(context) {
    const fetchImpl = fetchImplOrDefault(context.fetchImpl);

    return async (input: unknown) => {
      const body = parseObjectInput("free.wikipedia.links", input);
      const title = requireStringField("free.wikipedia.links", body, "title");
      const limit = Math.max(1, Math.min(500, Math.trunc(readNumber(body, "limit") ?? 100)));

      const links: WikipediaLinkItem[] = [];
      let plcontinue: string | undefined;
      let truncated = false;

      while (links.length < limit) {
        const pageUrl = buildUrl(title, Math.min(500, limit - links.length), plcontinue);
        const response = await fetchImpl(pageUrl);
        ensureFetchOk("free.wikipedia.links", "wikipedia", response, { title, limit });

        const payload = parseJsonRecord("free.wikipedia.links", "wikipedia", await response.json(), {
          title,
          limit,
        });
        const page = extractPage(payload);
        const pageLinks = Array.isArray(page?.links) ? page.links : [];

        for (const raw of pageLinks) {
          const entry = parseJsonRecord("free.wikipedia.links", "wikipedia", raw, {
            title,
            field: "links[]",
          });
          const linkTitle = typeof entry?.title === "string" ? entry.title.trim() : "";
          if (linkTitle.length === 0) {
            continue;
          }
          links.push({
            title: linkTitle,
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(linkTitle.replace(/\s+/g, "_"))}`,
          });
          if (links.length >= limit) {
            break;
          }
        }

        const next =
          typeof payload.continue === "object" && payload.continue !== null && Array.isArray(payload.continue) === false
            ? (payload.continue as Record<string, unknown>)
            : undefined;
        plcontinue = typeof next?.plcontinue === "string" ? next.plcontinue : undefined;
        if (plcontinue === undefined) {
          break;
        }
      }

      if (plcontinue !== undefined && links.length >= limit) {
        truncated = true;
      }

      return {
        source: "wikipedia.links",
        title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`,
        links,
        truncated,
      };
    };
  },
};

function buildUrl(title: string, pllimit: number, plcontinue?: string): string {
  const query = new URLSearchParams({
    format: "json",
    action: "query",
    prop: "links",
    titles: title,
    plnamespace: "0",
    pllimit: String(pllimit),
    redirects: "1",
  });
  if (plcontinue !== undefined) {
    query.set("plcontinue", plcontinue);
  }
  return `https://en.wikipedia.org/w/api.php?${query.toString()}`;
}

function extractPage(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const query =
    typeof payload.query === "object" && payload.query !== null && Array.isArray(payload.query) === false
      ? (payload.query as Record<string, unknown>)
      : undefined;
  const pages =
    typeof query?.pages === "object" && query.pages !== null && Array.isArray(query.pages) === false
      ? (query.pages as Record<string, unknown>)
      : undefined;
  if (pages === undefined) {
    return ;
  }

  for (const value of Object.values(pages)) {
    const page =
      typeof value === "object" && value !== null && Array.isArray(value) === false
        ? (value as Record<string, unknown>)
        : undefined;
    if (page !== undefined) {
      return page;
    }
  }
  return ;
}
