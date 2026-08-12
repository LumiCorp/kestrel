export type ModelTransportFailureCode =
  | "MODEL_TIMEOUT"
  | "MODEL_NETWORK_DNS"
  | "MODEL_NETWORK_ERROR";

const DNS_CODES = new Set(["EAI_AGAIN", "ENOTFOUND"]);
const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/** Classifies native transport failures without treating cancellation as retryable. */
export function classifyModelTransportFailure(
  error: unknown,
): ModelTransportFailureCode | undefined {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const record = asRecord(current);
    if (record === undefined) break;
    const name = readString(record.name);
    if (name === "AbortError") return;
    const code = readString(record.code)?.toUpperCase();
    if (code === "ETIMEDOUT") return "MODEL_TIMEOUT";
    if (code !== undefined && DNS_CODES.has(code)) return "MODEL_NETWORK_DNS";
    if (code !== undefined && NETWORK_CODES.has(code)) return "MODEL_NETWORK_ERROR";
    current = record.cause;
  }
  return;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
