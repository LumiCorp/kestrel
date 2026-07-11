import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput } from "../helpers.js";

export const sourceTriageTool: SharedToolModule = {
  definition: {
    name: "source.triage",
    description: "Normalize candidate sources without applying deterministic scores or thresholds.",
    inputSchema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      required: ["sources"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["web.triage"],
      suitability: {
        supportsAggregation: true,
        typicalFailureModes: ["malformed_source_records"],
      },
    },
    presentation: {
      displayName: "Source Triage",
      aliases: ["source triage", "triage sources", "normalize sources"],
      keywords: ["triage", "sources", "ranking", "normalize"],
      provider: "kestrel",
      toolFamily: "web",
    },
  },
  createHandler() {
    return async (input: unknown) => {
      const body = parseObjectInput("source.triage", input);
      if (Array.isArray(body.sources) === false) {
        throw createToolInputError("source.triage", "source.triage requires input.sources array.", {
          field: "sources",
          receivedType: typeof body.sources,
        });
      }
      const sources = body.sources;

      const normalized = sources
        .map((item) =>
          typeof item === "object" && item !== null && Array.isArray(item) === false
            ? (item as Record<string, unknown>)
            : undefined,
        )
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .map((item, index) => normalizeSource(item, index));

      return {
        sources: normalized,
      };
    };
  },
};

function normalizeSource(
  source: Record<string, unknown>,
  index: number,
): {
  rank: number;
  title?: string;
  url?: string;
  publishedAt?: string;
  sourceType?: string;
  metadata: Record<string, unknown>;
} {
  const title = typeof source.title === "string" ? source.title : undefined;
  const url = typeof source.url === "string" ? source.url : undefined;
  const publishedAt =
    typeof source.publishedAt === "string"
      ? source.publishedAt
      : typeof source.published_at === "string"
        ? source.published_at
        : undefined;
  const sourceType = typeof source.sourceType === "string" ? source.sourceType : undefined;

  return {
    rank: index + 1,
    ...(title !== undefined ? { title } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(sourceType !== undefined ? { sourceType } : {}),
    metadata: source,
  };
}
