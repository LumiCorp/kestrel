/**
 * Generic safe value helpers used by multiple agents.
 * These helpers are intentionally framework-agnostic.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }

  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }

  return value;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
