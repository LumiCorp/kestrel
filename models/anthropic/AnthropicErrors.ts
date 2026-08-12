import { classifyModelTransportFailure } from "../../src/io/ModelTransportError.js";

export class AnthropicModelError extends Error {
  readonly code: string;
  readonly status?: number | undefined;
  readonly retryAfterMs?: number | undefined;

  constructor(code: string, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "AnthropicModelError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function createAnthropicHttpError(
  status: number,
  bodyText: string,
  retryAfterMs?: number,
): AnthropicModelError {
  const code = status === 401 || status === 403
    ? "MODEL_AUTH_ERROR"
    : status === 408
      ? "MODEL_TIMEOUT"
      : status === 429
        ? "MODEL_RATE_LIMITED"
        : status === 500 || status === 502 || status === 503 || status === 504
          ? "MODEL_PROVIDER_ERROR"
          : "ANTHROPIC_HTTP_ERROR";
  return new AnthropicModelError(
    code,
    `Anthropic request failed with status ${status}: ${bodyText}`,
    status,
    retryAfterMs,
  );
}

export function createAnthropicBadResponseError(
  message: string
): AnthropicModelError {
  return new AnthropicModelError("ANTHROPIC_BAD_RESPONSE", message);
}

export function mapAnthropicTransportError(error: unknown): Error {
  if (error instanceof Error) {
    const code = classifyModelTransportFailure(error);
    return code === undefined
      ? error
      : new AnthropicModelError(code, error.message);
  }
  return new AnthropicModelError("ANTHROPIC_TRANSPORT_ERROR", String(error));
}
