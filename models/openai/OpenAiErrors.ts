export class OpenAiModelError extends Error {
  readonly code: string;
  readonly status?: number | undefined;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    status?: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OpenAiModelError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createOpenAiHttpError(
  status: number,
  bodyText: string,
  providerLabel = "OpenAI",
): OpenAiModelError {
  const parsedBody = safeParseJson(bodyText);
  const message =
    asString(asRecord(asRecord(parsedBody)?.error)?.message) ??
    truncate(bodyText, 1200) ??
    `${providerLabel} request failed (${status}).`;

  if (status === 401 || status === 403) {
    return new OpenAiModelError("MODEL_AUTH_ERROR", `${providerLabel} auth failed (${status}): ${message}`, status, {
      bodyText,
      ...(parsedBody !== undefined ? { parsedBody } : {}),
    });
  }

  if (status === 429) {
    return new OpenAiModelError("MODEL_RATE_LIMITED", `${providerLabel} rate limited (429): ${message}`, status, {
      bodyText,
      ...(parsedBody !== undefined ? { parsedBody } : {}),
    });
  }

  if (status >= 500) {
    return new OpenAiModelError("MODEL_PROVIDER_ERROR", `${providerLabel} server error (${status}): ${message}`, status, {
      bodyText,
      ...(parsedBody !== undefined ? { parsedBody } : {}),
    });
  }

  return new OpenAiModelError("MODEL_BAD_RESPONSE", `${providerLabel} request failed (${status}): ${message}`, status, {
    bodyText,
    ...(parsedBody !== undefined ? { parsedBody } : {}),
  });
}

export function createOpenAiBadResponseError(message: string): OpenAiModelError {
  return new OpenAiModelError("MODEL_BAD_RESPONSE", message);
}

export function mapOpenAiTransportError(error: unknown, providerLabel = "OpenAI"): OpenAiModelError {
  if (error instanceof OpenAiModelError) {
    return error;
  }

  if (error instanceof Error) {
    return new OpenAiModelError("MODEL_PROVIDER_ERROR", error.message);
  }

  return new OpenAiModelError("MODEL_PROVIDER_ERROR", `Unknown ${providerLabel} transport error`);
}

function safeParseJson(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}
