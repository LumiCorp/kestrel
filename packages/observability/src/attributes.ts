type TraceAttributeValue = string | number | boolean | undefined;

const SENSITIVE_ATTRIBUTE_KEY =
  /(?:^|[._-])(actor[_-]?name|authorization|cookie|credential|display[_-]?name|password|prompt|response|secret|raw[_-]?payload|tool[_-]?payload|pii|user[_-]?name)(?:$|[._-])/iu;

const NON_NEGATIVE_INTEGER_ATTRIBUTES = new Set([
  "kestrel.retry_attempt",
  "kestrel.input_tokens",
  "kestrel.output_tokens",
]);

const NON_NEGATIVE_NUMBER_ATTRIBUTES = new Set([
  "kestrel.latency_ms",
]);

export function compactTraceAttributes(
  attributes: Record<string, TraceAttributeValue>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (SENSITIVE_ATTRIBUTE_KEY.test(key)) return [];
      if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        return [[key, value]];
      }
      return [];
    }),
  );
}

export function assertKnownNumericTraceAttributes(
  attributes: Record<string, TraceAttributeValue>,
  label: string,
): void {
  for (const key of NON_NEGATIVE_INTEGER_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw new Error(`${label} attribute '${key}' must be a non-negative safe integer.`);
    }
  }
  for (const key of NON_NEGATIVE_NUMBER_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${label} attribute '${key}' must be a non-negative finite number.`);
    }
  }
}
