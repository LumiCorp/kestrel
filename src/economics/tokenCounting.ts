import type { TokenCountV1 } from "./contracts.js";

export interface ExactTokenCounter {
  id: string;
  version: string;
  count(value: string): number;
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
      method: "exact",
      confidence: "exact",
      counter: counter.id,
      counterVersion: counter.version,
    };
  }

  return {
    version: 1,
    tokens: bytes,
    bytes,
    method: "estimated",
    confidence: "conservative",
    counter: "utf8-byte-upper-bound",
    counterVersion: "1",
  };
}

export function combineTokenCounts(
  counts: readonly TokenCountV1[],
  label = "composite",
): TokenCountV1 {
  const exact = counts.every((count) => count.method === "exact");
  return {
    version: 1,
    tokens: counts.reduce((total, count) => total + count.tokens, 0),
    bytes: counts.reduce((total, count) => total + count.bytes, 0),
    method: exact ? "exact" : "estimated",
    confidence: exact ? "exact" : "conservative",
    counter: label,
    counterVersion: "1",
  };
}

function assertTokenCount(value: number, label: string): void {
  if (Number.isSafeInteger(value) === false || value < 0) {
    throw new Error(`${label} returned an invalid token count.`);
  }
}
