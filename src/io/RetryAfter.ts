/** Parses an HTTP Retry-After header into a delay without retaining the raw value. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return;
  }

  if (/^(?:\d+\.?\d*|\.\d+)$/u.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isFinite(seconds) && seconds > 0
      ? Math.ceil(seconds * 1000)
      : undefined;
  }

  const retryAtMs = Date.parse(normalized);
  if (Number.isFinite(retryAtMs) === false || retryAtMs <= nowMs) {
    return;
  }
  return Math.ceil(retryAtMs - nowMs);
}
