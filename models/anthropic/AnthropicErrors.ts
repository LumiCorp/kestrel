export class AnthropicModelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AnthropicModelError";
    this.code = code;
  }
}

export function createAnthropicHttpError(status: number, bodyText: string): AnthropicModelError {
  return new AnthropicModelError(
    "ANTHROPIC_HTTP_ERROR",
    `Anthropic request failed with status ${status}: ${bodyText}`,
  );
}

export function createAnthropicBadResponseError(message: string): AnthropicModelError {
  return new AnthropicModelError("ANTHROPIC_BAD_RESPONSE", message);
}

export function mapAnthropicTransportError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new AnthropicModelError("ANTHROPIC_TRANSPORT_ERROR", String(error));
}
