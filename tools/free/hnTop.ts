import type { SharedToolModule } from "../contracts.js";
import {
  createToolProviderError,
  fetchImplOrDefault,
  parseJsonRecord,
  parseObjectInput,
  readString,
} from "../helpers.js";

export const hnTopTool: SharedToolModule = {
  definition: {
    name: "free.hn.top",
    description: "Fetch top Hacker News stories.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 20, description: "Number of stories to fetch (default 10, max 20)." },
      },
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["news.tech.top"],
      suitability: {
        supportsAttribution: true,
        typicalFailureModes: ["provider_unavailable", "partial_story_fetch_failure"],
      },
    },
    presentation: {
      displayName: "Hacker News Top",
      aliases: ["hacker news top", "hn top", "top hacker news"],
      keywords: ["hacker news", "hn", "top stories", "tech news"],
      provider: "hacker-news",
      toolFamily: "news",
    },
  },
  createHandler(context) {
    const fetchImpl = fetchImplOrDefault(context.fetchImpl);

    return async (input: unknown) => {
      const body = parseObjectInput("free.hn.top", input);
      const rawLimit = typeof body?.limit === "number" ? body.limit : 10;
      const limit = Math.max(1, Math.min(20, Math.floor(rawLimit)));

      const idsResponse = await fetchImpl(
        "https://hacker-news.firebaseio.com/v0/topstories.json",
      );
      if (idsResponse.ok === false) {
        throw createToolProviderError("free.hn.top", "hacker-news", "Failed to fetch top story ids.", {
          status: idsResponse.status,
        });
      }

      const idsPayload = await idsResponse.json();
      const ids = Array.isArray(idsPayload) ? idsPayload.slice(0, limit) : [];

      const stories: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        const itemResponse = await fetchImpl(
          `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
        );
        if (itemResponse.ok === false) {
          continue;
        }

        const item = parseJsonRecord("free.hn.top", "hacker-news", await itemResponse.json(), {
          storyId: id,
        });
        if (item === undefined) {
          continue;
        }

        stories.push({
          id: item.id,
          title: readString(item, "title"),
          by: readString(item, "by"),
          score: item.score,
          url: readString(item, "url"),
          time: item.time,
        });
      }

      return {
        source: "hacker-news",
        limit,
        stories,
      };
    };
  },
};
