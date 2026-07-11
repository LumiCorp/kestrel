import type { SharedToolModule } from "../contracts.js";
import {
  ensureFetchOk,
  fetchImplOrDefault,
  parseObjectInput,
  readNumber,
  requireStringField,
} from "../helpers.js";

export const sourceFetchTool: SharedToolModule = {
  definition: {
    name: "source.fetch",
    description: "Fetch source content from a URL and return normalized text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxChars: { type: "number" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "read_only",
      capabilityClasses: ["web.fetch"],
      suitability: {
        supportsAttribution: true,
        typicalFailureModes: ["upstream_error", "content_too_large"],
      },
    },
    presentation: {
      displayName: "Source Fetch",
      aliases: ["source fetch", "web fetch", "fetch source"],
      keywords: ["fetch", "source", "content", "url"],
      provider: "generic-fetch",
      toolFamily: "web",
    },
  },
  createHandler(context) {
    const fetchImpl = fetchImplOrDefault(context.fetchImpl);

    return async (input: unknown) => {
      const body = parseObjectInput("source.fetch", input);
      const url = requireStringField("source.fetch", body, "url");
      const maxChars = Math.max(500, Math.min(100_000, Math.trunc(readNumber(body, "maxChars") ?? 8_000)));

      const response = await fetchImpl(url);
      ensureFetchOk("source.fetch", "generic-fetch", response, { url, maxChars });

      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const raw = await response.text();
      const normalized = normalizeContent(raw, contentType, maxChars);

      return {
        url,
        contentType,
        title: extractTitle(raw),
        content: normalized,
        charCount: normalized.length,
        fetchedAt: new Date().toISOString(),
      };
    };
  },
};

function normalizeContent(raw: string, contentType: string, maxChars: number): string {
  const isHtml = contentType.toLowerCase().includes("html");
  const text = isHtml ? stripHtml(raw) : raw;
  return text.slice(0, maxChars).trim();
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(htmlOrText: string): string | undefined {
  const match = htmlOrText.match(/<title>([\s\S]*?)<\/title>/iu);
  if (match?.[1] === undefined) {
    return undefined;
  }

  const value = match[1].replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : undefined;
}
