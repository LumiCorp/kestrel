import type { RunnerErrorEventPayload } from "./contracts.js";

export class KestrelSdkError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown> | undefined;
  readonly status?: number | undefined;
  readonly body?: string | undefined;

  constructor(input: {
    name?: string | undefined;
    code: string;
    message: string;
    details?: Record<string, unknown> | undefined;
    status?: number | undefined;
    body?: string | undefined;
  }) {
    super(input.message);
    this.name = input.name ?? "KestrelSdkError";
    this.code = input.code;
    this.details = input.details;
    this.status = input.status;
    this.body = input.body;
  }
}

export class KestrelConfigurationError extends KestrelSdkError {
  constructor(message: string, details?: Record<string, unknown> | undefined) {
    super({
      name: "KestrelConfigurationError",
      code: "SDK_CONFIGURATION_ERROR",
      message,
      details,
    });
  }
}

export class KestrelHttpError extends KestrelSdkError {
  constructor(message: string, input: { status: number; body?: string | undefined; details?: Record<string, unknown> | undefined }) {
    super({
      name: "KestrelHttpError",
      code: "RUNNER_HTTP_ERROR",
      message,
      status: input.status,
      body: input.body,
      details: input.details,
    });
  }
}

export class KestrelProtocolError extends KestrelSdkError {
  constructor(message: string, input?: { code?: string | undefined; details?: Record<string, unknown> | undefined }) {
    super({
      name: "KestrelProtocolError",
      code: input?.code ?? "RUNNER_PROTOCOL_ERROR",
      message,
      details: input?.details,
    });
  }
}

export class KestrelServiceError extends KestrelSdkError {
  constructor(payload: RunnerErrorEventPayload, input?: { status?: number | undefined; body?: string | undefined }) {
    super({
      name: "KestrelServiceError",
      code: payload.code,
      message: payload.message,
      details: payload.details,
      status: input?.status,
      body: input?.body,
    });
  }
}

export function toKestrelError(payload: RunnerErrorEventPayload): KestrelSdkError {
  if (payload.code === "RUNNER_HTTP_ERROR") {
    return new KestrelHttpError(payload.message, {
      status: typeof payload.details?.status === "number" ? payload.details.status : 500,
      body: typeof payload.details?.body === "string" ? payload.details.body : undefined,
      details: payload.details,
    });
  }
  if (
    payload.code === "RUNNER_PROTOCOL_ERROR" ||
    payload.code === "RUNNER_PROTOCOL_INVALID" ||
    payload.code === "RUNNER_TRANSPORT_ERROR"
  ) {
    return new KestrelProtocolError(payload.message, {
      code: payload.code,
      details: payload.details,
    });
  }
  return new KestrelServiceError(payload);
}
