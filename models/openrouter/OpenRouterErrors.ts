export class OpenRouterModelError extends Error {
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
    this.name = "OpenRouterModelError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createOpenRouterHttpError(
  status: number,
  bodyText: string,
  options: {
    retryAfter?: string | undefined;
  } = {},
): OpenRouterModelError {
  const details = buildHttpErrorDetails(status, bodyText, options);
  const providerMessage = selectProviderMessage(details) ?? truncate(bodyText, 1200);

  if (status === 400 && isProviderSchemaMessage(providerMessage)) {
    return new OpenRouterModelError(
      "MODEL_PROVIDER_SCHEMA",
      `OpenRouter schema rejected (400): ${providerMessage}`,
      status,
      {
        ...details,
        category: "provider_schema",
      },
    );
  }

  if (status === 401 || status === 403) {
    return new OpenRouterModelError(
      "MODEL_AUTH_ERROR",
      `OpenRouter auth failed (${status}): ${providerMessage}`,
      status,
      details,
    );
  }

  if (status === 429) {
    return new OpenRouterModelError(
      "MODEL_RATE_LIMITED",
      `OpenRouter rate limited (429): ${providerMessage}`,
      status,
      details,
    );
  }

  if (status >= 500) {
    return new OpenRouterModelError(
      "MODEL_PROVIDER_ERROR",
      `OpenRouter server error (${status}): ${providerMessage}`,
      status,
      details,
    );
  }

  return new OpenRouterModelError(
    "MODEL_BAD_RESPONSE",
    `OpenRouter request failed (${status}): ${providerMessage}`,
    status,
    details,
  );
}

export function createOpenRouterBadResponseError(message: string): OpenRouterModelError {
  return new OpenRouterModelError("MODEL_BAD_RESPONSE", message);
}

export function createOpenRouterProviderSchemaError(
  message: string,
  details?: Record<string, unknown>,
): OpenRouterModelError {
  return new OpenRouterModelError(
    "MODEL_PROVIDER_SCHEMA",
    message,
    undefined,
    {
      ...(details ?? {}),
      category: "provider_schema",
    },
  );
}

export function isOpenRouterProviderSchemaError(error: unknown): boolean {
  if ((error instanceof OpenRouterModelError) === false) {
    return false;
  }
  if (error.code === "MODEL_PROVIDER_SCHEMA") {
    return true;
  }
  if (error.code !== "MODEL_BAD_RESPONSE") {
    return false;
  }

  const details = asRecord(error.details);
  const nestedProviderMessage = asString(details?.nestedProviderMessage);
  const providerMessage = asString(details?.providerMessage);
  const bodyText = asString(details?.bodyText);
  const combined = [
    error.message,
    nestedProviderMessage,
    providerMessage,
    bodyText,
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join(" ")
    .toLowerCase();

  return isProviderSchemaMessage(combined);
}

export function mapOpenRouterTransportError(error: unknown): OpenRouterModelError {
  if (error instanceof OpenRouterModelError) {
    return error;
  }

  if (error instanceof Error) {
    const details = buildTransportErrorDetails(error);
    const primaryMessage = asString(details.primaryMessage) ?? error.message;

    if (isTimeoutTransportError(details)) {
      return new OpenRouterModelError("MODEL_TIMEOUT", primaryMessage, undefined, details);
    }

    if (isDnsTransportError(details)) {
      return new OpenRouterModelError(
        "MODEL_NETWORK_DNS",
        `OpenRouter DNS lookup failed: ${primaryMessage}`,
        undefined,
        details,
      );
    }

    if (isConnectivityTransportError(details)) {
      return new OpenRouterModelError(
        "MODEL_NETWORK_ERROR",
        `OpenRouter network request failed: ${primaryMessage}`,
        undefined,
        details,
      );
    }

    return new OpenRouterModelError("MODEL_PROVIDER_ERROR", error.message, undefined, details);
  }

  return new OpenRouterModelError("MODEL_PROVIDER_ERROR", "Unknown OpenRouter transport error");
}

function buildHttpErrorDetails(
  status: number,
  bodyText: string,
  options: {
    retryAfter?: string | undefined;
  },
): Record<string, unknown> {
  const parsedBody = safeParseJson(bodyText);
  const topLevelError = asRecord(asRecord(parsedBody)?.error);
  const metadata = asRecord(topLevelError?.metadata);
  const rawProviderError = asString(metadata?.raw);
  const parsedProviderError = rawProviderError !== undefined ? safeParseJson(rawProviderError) : undefined;
  const nestedProviderError = asRecord(asRecord(parsedProviderError)?.error);
  const nestedProviderMessage = asString(nestedProviderError?.message);
  const retryAfterSeconds = parseRetryAfterSeconds(options.retryAfter);

  return {
    status,
    providerMessage: asString(topLevelError?.message),
    nestedProviderMessage,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(rawProviderError !== undefined ? { providerRaw: rawProviderError } : {}),
    bodyText,
    ...(parsedBody !== undefined ? { parsedBody } : {}),
    ...(parsedProviderError !== undefined ? { parsedProviderError } : {}),
  };
}

function parseRetryAfterSeconds(value: string | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const absoluteTimeMs = Date.parse(trimmed);
  if (Number.isNaN(absoluteTimeMs)) {
    return undefined;
  }
  const deltaMs = absoluteTimeMs - Date.now();
  return deltaMs > 0 ? deltaMs / 1_000 : undefined;
}

function selectProviderMessage(details: Record<string, unknown>): string | undefined {
  const nested = asString(details.nestedProviderMessage);
  if (nested !== undefined && nested.trim().length > 0) {
    return nested.trim();
  }

  const provider = asString(details.providerMessage);
  if (provider !== undefined && provider.trim().length > 0) {
    return provider.trim();
  }

  return undefined;
}

function safeParseJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
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

function truncate(value: string, limit = 400): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function buildTransportErrorDetails(error: Error): Record<string, unknown> {
  const chain = flattenErrorChain(error);
  const codes = chain
    .map((entry) => asString(entry.code))
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toUpperCase());
  const messages = chain
    .map((entry) => asString(entry.message))
    .filter((value): value is string => value !== undefined);
  const primaryMessage = messages.find((message) => message.trim().length > 0) ?? error.message;

  return {
    primaryMessage,
    codes,
    chain,
  };
}

function flattenErrorChain(error: Error): Array<Record<string, unknown>> {
  const visited = new Set<unknown>();
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  let depth = 0;

  while (current instanceof Error && depth < 8 && visited.has(current) === false) {
    visited.add(current);
    const entry: Record<string, unknown> = {
      name: current.name,
      message: current.message,
    };
    const code = asString((current as unknown as { code?: unknown }).code);
    if (code !== undefined) {
      entry.code = code;
    }
    const errno = (current as unknown as { errno?: unknown }).errno;
    if (typeof errno === "number") {
      entry.errno = errno;
    }
    const syscall = asString((current as unknown as { syscall?: unknown }).syscall);
    if (syscall !== undefined) {
      entry.syscall = syscall;
    }
    const hostname = asString((current as unknown as { hostname?: unknown }).hostname);
    if (hostname !== undefined) {
      entry.hostname = hostname;
    }
    chain.push(entry);

    current = (current as unknown as { cause?: unknown }).cause;
    depth += 1;
  }

  return chain;
}

function isTimeoutTransportError(details: Record<string, unknown>): boolean {
  const codes = toUppercaseStrings(details.codes);
  if (codes.includes("ETIMEDOUT")) {
    return true;
  }

  const combined = collectLowercaseText(details);
  return (
    combined.includes("timed out") ||
    combined.includes("timeout") ||
    combined.includes("abort")
  );
}

function isDnsTransportError(details: Record<string, unknown>): boolean {
  const codes = toUppercaseStrings(details.codes);
  if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN")) {
    return true;
  }

  const combined = collectLowercaseText(details);
  return (
    combined.includes("getaddrinfo") ||
    combined.includes("could not resolve host") ||
    combined.includes("name resolution") ||
    combined.includes("nodename nor servname provided")
  );
}

function isConnectivityTransportError(details: Record<string, unknown>): boolean {
  const codes = toUppercaseStrings(details.codes);
  const connectivityCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
  ]);
  if (codes.some((code) => connectivityCodes.has(code))) {
    return true;
  }

  const combined = collectLowercaseText(details);
  return (
    combined.includes("network error") ||
    combined.includes("socket hang up") ||
    combined.includes("connection refused") ||
    combined.includes("connection reset")
  );
}

function toUppercaseStrings(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined)
    .map((item) => item.toUpperCase());
}

function collectLowercaseText(details: Record<string, unknown>): string {
  const parts: string[] = [];
  const primaryMessage = asString(details.primaryMessage);
  if (primaryMessage !== undefined) {
    parts.push(primaryMessage);
  }
  const chain = Array.isArray(details.chain) ? details.chain : [];
  for (const item of chain) {
    const entry = asRecord(item);
    const message = asString(entry?.message);
    if (message !== undefined) {
      parts.push(message);
    }
    const syscall = asString(entry?.syscall);
    if (syscall !== undefined) {
      parts.push(syscall);
    }
  }

  return parts.join(" ").toLowerCase();
}

function isProviderSchemaMessage(message: string): boolean {
  const combined = message.toLowerCase();
  return (
    combined.includes("invalid schema for response_format") ||
    combined.includes("json_schema") ||
    combined.includes("required' is required to be supplied")
  );
}
