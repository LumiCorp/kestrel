import type { SharedToolModule } from "../contracts.js";
import {
  parseObjectInput,
  readNumber,
  readString,
  requireStringField,
} from "../helpers.js";

export const evidenceExtractTool: SharedToolModule = {
  definition: {
    name: "evidence.extract",
    description: "Extract concise evidence snippets from source text for a claim.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        claim: { type: "string" },
        sourceId: { type: "string" },
        maxItems: { type: "number", minimum: 1, maximum: 10 },
      },
      required: ["text"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["evidence.extract"],
      suitability: {
        supportsAggregation: true,
        typicalFailureModes: ["input_text_too_short"],
      },
    },
    presentation: {
      displayName: "Evidence Extract",
      aliases: ["evidence extract", "extract evidence", "snippet extraction"],
      keywords: ["evidence", "extract", "claim", "snippet"],
      provider: "kestrel",
      toolFamily: "evidence",
    },
  },
  createHandler() {
    return async (input: unknown) => {
      const body = parseObjectInput("evidence.extract", input);
      const text = requireStringField("evidence.extract", body, "text");
      const claim = readString(body, "claim");
      const sourceId = readString(body, "sourceId");
      const maxItems = Math.max(1, Math.min(10, Math.trunc(readNumber(body, "maxItems") ?? 4)));

      const sentences = splitSentences(text).filter((sentence) => sentence.length >= 30);
      const ranked = sentences
        .map((sentence, index) => {
          const overlap = claim === undefined ? 0 : tokenOverlapScore(claim, sentence);
          const strength = claim === undefined ? baselineStrength(sentence) : overlap;
          return {
            id: sourceId === undefined ? `evidence:${index}` : `${sourceId}:evidence:${index}`,
            text: sentence,
            evidenceStrength: Number(Math.min(1, Math.max(0, strength)).toFixed(4)),
            overlapTokens: claim === undefined ? [] : overlapTokens(claim, sentence),
          };
        })
        .sort((left, right) => right.evidenceStrength - left.evidenceStrength)
        .slice(0, maxItems);

      return {
        ...(claim !== undefined ? { claim } : {}),
        ...(sourceId !== undefined ? { sourceId } : {}),
        items: ranked,
      };
    };
  },
};

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/u)
    .filter((token) => token.length >= 3);
}

function overlapTokens(claim: string, sentence: string): string[] {
  const left = new Set(tokenize(claim));
  const tokens = tokenize(sentence);
  return [...new Set(tokens.filter((token) => left.has(token)))];
}

function tokenOverlapScore(claim: string, sentence: string): number {
  const claimTokens = tokenize(claim);
  if (claimTokens.length === 0) {
    return baselineStrength(sentence);
  }
  const overlap = overlapTokens(claim, sentence);
  return overlap.length / claimTokens.length;
}

function baselineStrength(sentence: string): number {
  if (sentence.length >= 220) {
    return 0.75;
  }
  if (sentence.length >= 120) {
    return 0.6;
  }
  return 0.45;
}
