export class AnthropicModelError extends Error {
  readonly code: string;
  readonly status?: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AnthropicModelError";
    this.code = code;
    this.status = status;
  }
}

export function createAnthropicHttpError(
  status: number,
  bodyText: string
): AnthropicModelError {
  return new AnthropicModelError(
    status === 401 || status === 403
      ? "MODEL_AUTH_ERROR"
      : "ANTHROPIC_HTTP_ERROR",
    `Anthropic request failed with status ${status}: ${bodyText}`,
    status
  );
}

export function createAnthropicBadResponseError(
  message: string
): AnthropicModelError {
  return new AnthropicModelError("ANTHROPIC_BAD_RESPONSE", message);
}

export function mapAnthropicTransportError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new AnthropicModelError("ANTHROPIC_TRANSPORT_ERROR", String(error));
}
