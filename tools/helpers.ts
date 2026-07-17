import { createRuntimeFailure } from "../src/runtime/RuntimeFailure.js";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }

  return value as Record<string, unknown>;
}

export function asNonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === undefined || Object.keys(record).length === 0) {
    return ;
  }

  return record;
}

export function parseObjectInput(toolName: string, input: unknown): Record<string, unknown> {
  const value = asRecord(input);
  if (value === undefined) {
    throw createToolInputError(toolName, "Tool input must be an object.", {
      receivedType: describeValueType(input),
    });
  }
  return value;
}

export function readString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (value === undefined) {
    return ;
  }

  const maybe = value[key];
  return typeof maybe === "string" ? maybe : undefined;
}

export function readNumber(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (value === undefined) {
    return ;
  }

  const maybe = value[key];
  return typeof maybe === "number" ? maybe : undefined;
}

export function assertString(
  value: Record<string, unknown> | undefined,
  key: string,
  message: string,
): string {
  const result = readString(value, key);
  if (result === undefined || result.length === 0) {
    throw createRuntimeFailure("TOOL_INPUT_INVALID", message, {
      subsystem: "tooling",
      field: key,
      classification: "schema",
      recoverable: true,
    });
  }

  return result;
}

export function requireStringField(
  toolName: string,
  value: Record<string, unknown> | undefined,
  key: string,
): string {
  const result = readString(value, key);
  if (result === undefined || result.trim().length === 0) {
    throw createToolInputError(toolName, `Missing required string field '${key}'.`, {
      field: key,
      receivedType: describeValueType(value?.[key]),
    });
  }

  return result;
}

export function requireNumberField(
  toolName: string,
  value: Record<string, unknown> | undefined,
  key: string,
): number {
  const result = readNumber(value, key);
  if (result === undefined || Number.isFinite(result) === false) {
    throw createToolInputError(toolName, `Missing required numeric field '${key}'.`, {
      field: key,
      receivedType: describeValueType(value?.[key]),
    });
  }

  return result;
}

export function parseOptionalStringArray(
  value: Record<string, unknown> | undefined,
  key: string,
  maxItems = 100,
): string[] {
  const raw = value?.[key];
  if (Array.isArray(raw) === false) {
    return [];
  }

  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

export function parseJsonRecord(
  toolName: string,
  provider: string,
  payload: unknown,
  details?: Record<string, unknown>,
): Record<string, unknown> {
  const record = asRecord(payload);
  if (record === undefined) {
    throw createToolProviderPayloadError(
      toolName,
      provider,
      "Provider returned a non-object payload.",
      {
        ...(details ?? {}),
        receivedType: describeValueType(payload),
      },
    );
  }

  return record;
}

export function ensureFetchOk(
  toolName: string,
  provider: string,
  response: Response,
  details?: Record<string, unknown>,
): void {
  if (response.ok === true) {
    return;
  }

  throw createToolProviderError(
    toolName,
    provider,
    `Provider request failed with status ${response.status}.`,
    {
      ...(details ?? {}),
      status: response.status,
      statusText: response.statusText,
    },
  );
}

export function createToolInputError(
  toolName: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return createRuntimeFailure("TOOL_INPUT_INVALID", message, {
    subsystem: "tooling",
    toolName,
    classification: "schema",
    recoverable: true,
    ...(details ?? {}),
  });
}

export function createToolProviderError(
  toolName: string,
  provider: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return createRuntimeFailure("TOOL_PROVIDER_FAILED", message, {
    subsystem: "tooling",
    toolName,
    provider,
    classification: "runtime",
    recoverable: true,
    ...(details ?? {}),
  });
}

export function createToolProviderPayloadError(
  toolName: string,
  provider: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return createRuntimeFailure("TOOL_PROVIDER_PAYLOAD_INVALID", message, {
    subsystem: "tooling",
    toolName,
    provider,
    classification: "schema",
    recoverable: true,
    ...(details ?? {}),
  });
}

export function fetchImplOrDefault(override: typeof fetch | undefined): typeof fetch {
  return override ?? fetch;
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
