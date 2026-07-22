import type { TokenCountV1 } from "./contracts.js";
import { getEncoding, type Tiktoken } from "js-tiktoken";

export interface ExactTokenCounter {
  id: string;
  version: string;
  count(value: string): number;
}

const TOKENIZER_ENCODINGS = new Map<string, "o200k_base" | "cl100k_base">([
  ["tiktoken:o200k_base", "o200k_base"],
  ["tiktoken:cl100k_base", "cl100k_base"],
]);
const TOKENIZER_CACHE = new Map<string, Tiktoken>();

export function isSupportedModelTokenizer(counterId: string): boolean {
  return TOKENIZER_ENCODINGS.has(counterId);
}

export function resolveModelTokenCounter(
  counterId: string,
  counterVersion: string,
): ExactTokenCounter | undefined {
  const encodingName = TOKENIZER_ENCODINGS.get(counterId);
  if (encodingName === undefined) return undefined;
  let encoding = TOKENIZER_CACHE.get(counterId);
  if (encoding === undefined) {
    encoding = getEncoding(encodingName);
    TOKENIZER_CACHE.set(counterId, encoding);
  }
  return {
    id: counterId,
    version: counterVersion,
    count(value: string): number {
      return encoding.encode(value).length;
    },
  };
}

export function countTextTokens(
  value: string,
  counter?: ExactTokenCounter | undefined,
): TokenCountV1 {
  const bytes = Buffer.byteLength(value, "utf8");
  if (counter !== undefined) {
    const tokens = counter.count(value);
    assertTokenCount(tokens, `Token counter '${counter.id}'`);
    return {
      version: 1,
      tokens,
      bytes,
      method: "model_tokenizer",
      confidence: "model_compatible",
      counter: counter.id,
      counterVersion: counter.version,
    };
  }

  return {
    version: 1,
    tokens: bytes,
    bytes,
    method: "conservative_estimate",
    confidence: "conservative",
    counter: "utf8-byte-upper-bound",
    counterVersion: "1",
  };
}

export function combineTokenCounts(
  counts: readonly TokenCountV1[],
  label = "composite",
): TokenCountV1 {
  const providerExact = counts.every((count) => count.method === "provider_reported");
  const tokenizerCompatible = counts.every((count) => count.method !== "conservative_estimate");
  return {
    version: 1,
    tokens: counts.reduce((total, count) => total + count.tokens, 0),
    bytes: counts.reduce((total, count) => total + count.bytes, 0),
    method: providerExact
      ? "provider_reported"
      : tokenizerCompatible
        ? "model_tokenizer"
        : "conservative_estimate",
    confidence: providerExact
      ? "provider_exact"
      : tokenizerCompatible
        ? "model_compatible"
        : "conservative",
    counter: label,
    counterVersion: "1",
  };
}

function assertTokenCount(value: number, label: string): void {
  if (Number.isSafeInteger(value) === false || value < 0) {
    throw new Error(`${label} returned an invalid token count.`);
  }
}
