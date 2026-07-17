import { createRuntimeFailure } from "./RuntimeFailure.js";

const ISO_GMT_OFFSET_SUFFIX = /^(.+\S)\s+GMT([+-]\d{2})(\d{2})$/i;
const BARE_GMT_OFFSET = /^GMT[+-]\d{4}$/i;

export function normalizeTimestampString(value: unknown): string {
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isFinite(time)) {
      return value.toISOString();
    }
    throw createRuntimeFailure(
      "TIMESTAMP_INVALID",
      "Invalid timestamp value; Date is not finite",
    );
  }
  if (typeof value !== "string") {
    throw createRuntimeFailure(
      "TIMESTAMP_TYPE_INVALID",
      `Invalid timestamp value; expected string or Date, received ${describeType(value)}`,
      { receivedType: describeType(value) },
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  const normalizedIso = toIsoTimestamp(trimmed);
  return normalizedIso ?? trimmed;
}

export function normalizeOptionalTimestampString(
  value: unknown,
): string | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  return normalizeTimestampString(value);
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  return value === null ? "null" : typeof value;
}

function toIsoTimestamp(value: string): string | undefined {
  if (BARE_GMT_OFFSET.test(value)) {
    return ;
  }

  const direct = Date.parse(value);
  if (Number.isFinite(direct)) {
    return new Date(direct).toISOString();
  }

  const gmtOffset = value.match(ISO_GMT_OFFSET_SUFFIX);
  if (gmtOffset === null) {
    return ;
  }

  const [, prefix, hours, minutes] = gmtOffset;
  const parsed = Date.parse(`${prefix}${hours}:${minutes}`);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }

  return ;
}
