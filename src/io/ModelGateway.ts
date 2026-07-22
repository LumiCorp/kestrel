import type {
  ModelGateway,
  ModelGatewayCallOptions,
  ModelGatewayEventSink,
  ModelRequest,
} from "../kestrel/contracts/model-io.js";
import {
  DEFAULT_MODEL_TIMING_POLICY,
  deriveModelTimeoutMs,
  type ModelTimingPolicyConfig,
} from "./ModelTimingPolicy.js";
import { RunCancelledError, createRuntimeFailure } from "../runtime/RuntimeFailure.js";

export type ModelInvoker = <T>(request: ModelRequest, options?: ModelGatewayCallOptions) => Promise<T>;

interface ModelGatewayConfig {
  timeoutMs: number;
  retryCount: number;
  timingPolicy: ModelTimingPolicyConfig;
}

const DEFAULT_CONFIG: ModelGatewayConfig = {
  timeoutMs: DEFAULT_MODEL_TIMING_POLICY.phaseCapMs,
  retryCount: 2,
  timingPolicy: DEFAULT_MODEL_TIMING_POLICY,
};

export class RetryingModelGateway implements ModelGateway {
  private readonly invoke: ModelInvoker;
  private readonly config: ModelGatewayConfig;

  constructor(invoke: ModelInvoker, config?: Partial<ModelGatewayConfig>) {
    this.invoke = invoke;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  async call<T>(
    request: ModelRequest,
    options: ModelGatewayCallOptions = {},
  ): Promise<T> {
    let lastError: unknown;
    let attemptsMade = 0;
    const retryDelaysMs: number[] = [];
    const startedAtMs = Date.now();

    const maxAttempts = this.config.retryCount + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      throwIfAborted(options.signal);
      let visibleOutputStarted = false;
      const startedReasoningFormats = new Set<"summary" | "provider_thinking" | "provider_reasoning_text">();
      const attemptNumber = attempt + 1;
      const attemptStartedAtMs = Date.now();
      await options.onEvent?.({ type: "attempt.started", attempt: attemptNumber, maxAttempts });
      const onEvent: ModelGatewayEventSink | undefined = options.onEvent === undefined
        ? undefined
        : async (event) => {
            if (event.type === "reasoning.started" || event.type === "reasoning.delta" || event.type === "output.delta") {
              visibleOutputStarted = true;
            }
            if (event.type === "reasoning.started" || event.type === "reasoning.delta") {
              startedReasoningFormats.add(event.format);
            }
            if (event.type === "reasoning.completed" || event.type === "reasoning.failed") {
              startedReasoningFormats.delete(event.format);
            }
            await options.onEvent?.({ ...event, attempt: attemptNumber });
          };
      try {
        const elapsedMs = Date.now() - startedAtMs;
        const timeoutMetadata = withAttemptBudgetMetadata(
          request.metadata,
          this.config.timeoutMs,
          elapsedMs,
        );
        if (typeof request.model === "string" && typeof timeoutMetadata.model !== "string") {
          timeoutMetadata.model = request.model;
        }
        const timeoutMs = deriveModelTimeoutMs(
          {
            ...request,
            metadata: timeoutMetadata,
          },
          this.config.timingPolicy,
        );
        return await withTimeout(
          this.invoke<T>({
            ...request,
            metadata: timeoutMetadata,
          }, {
            signal: options.signal,
            ...(onEvent !== undefined ? { onEvent } : {}),
          }),
          timeoutMs,
          attempt + 1,
          maxAttempts,
          options.signal,
          timeoutMetadata,
        ).then(async (result) => {
          await options.onEvent?.({
            type: "attempt.completed",
            attempt: attemptNumber,
            latencyMs: Date.now() - attemptStartedAtMs,
          });
          return result;
        });
      } catch (error) {
        lastError = error;
        attemptsMade = attempt + 1;
        for (const format of startedReasoningFormats) {
          await options.onEvent?.({
            type: "reasoning.failed",
            attempt: attemptNumber,
            format,
          });
        }
        const retryable = isRetryableModelError(error);
        const willRetry =
          attempt < maxAttempts - 1 &&
          visibleOutputStarted === false &&
          retryable &&
          hasBudgetForAnotherAttempt(
            request.metadata,
            this.config.timingPolicy,
            Date.now() - startedAtMs,
          );
        const retryDelayMs = willRetry ? resolveRetryDelayMs(error, attempt) : undefined;
        await options.onEvent?.({
          type: "attempt.failed",
          attempt: attemptNumber,
          latencyMs: Date.now() - attemptStartedAtMs,
          ...(readFailureCode(error) !== undefined ? { failureCode: readFailureCode(error) } : {}),
          ...(readFailureClass(error) !== undefined ? { failureClass: readFailureClass(error) } : {}),
          retryable,
          willRetry,
          visibleOutputStarted,
          ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
        });
        if (willRetry && retryDelayMs !== undefined) {
          retryDelaysMs.push(retryDelayMs);
          await sleep(retryDelayMs, options.signal);
          continue;
        }
        break;
      }
    }

    throw annotateGatewayFailure(
      parseGatewayFailure(lastError),
      attemptsMade,
      maxAttempts,
      retryDelaysMs,
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  attempt?: number,
  maxAttempts?: number,
  signal?: AbortSignal,
  metadata?: Record<string, unknown>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(createModelTimeoutError(timeoutMs, attempt, maxAttempts, metadata));
    }, timeoutMs);
  });

  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<T>((_, reject) => {
          if (signal.aborted) {
            reject(new RunCancelledError());
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(new RunCancelledError());
            },
            { once: true },
          );
        });

  try {
    return await Promise.race(
      abortPromise === undefined ? [promise, timeoutPromise] : [promise, timeoutPromise, abortPromise],
    );
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function createModelTimeoutError(
  timeoutMs: number,
  attempt?: number,
  maxAttempts?: number,
  metadata?: Record<string, unknown>,
){
  const suffix =
    typeof attempt === "number" && typeof maxAttempts === "number"
      ? ` (attempt ${attempt}/${maxAttempts})`
      : "";
  return createRuntimeFailure("IO_MODEL_TIMEOUT", `Model call timed out after ${timeoutMs}ms${suffix}`, {
    subsystem: "runtime",
    classification: "runtime",
    recoverable: true,
    timeoutMs,
    ...(typeof attempt === "number" ? { attempt } : {}),
    ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
    ...readTimeoutDiagnosticDetails(metadata),
  });
}

function withAttemptBudgetMetadata(
  metadata: Record<string, unknown> | undefined,
  phaseTimeoutMs: number,
  elapsedMs: number,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...(metadata ?? {}),
    phaseTimeoutMs,
  };

  const remaining = merged.runtimeBudgetRemainingMs;
  if (typeof remaining === "number") {
    merged.runtimeBudgetRemainingMs = Math.max(0, remaining - elapsedMs);
  }

  return merged;
}

function hasBudgetForAnotherAttempt(
  metadata: Record<string, unknown> | undefined,
  config: ModelTimingPolicyConfig,
  elapsedMs: number,
): boolean {
  const remaining = metadata?.runtimeBudgetRemainingMs;
  if (typeof remaining !== "number" || Number.isFinite(remaining) === false) {
    return true;
  }
  const remainingAfterElapsed = Math.max(0, remaining - elapsedMs);
  return remainingAfterElapsed > config.minTimeoutMs + config.reserveMs;
}

function resolveRetryDelayMs(error: unknown, attempt: number): number {
  const hintedRetryAfterMs = readRetryAfterMs(error);
  if (hintedRetryAfterMs !== undefined) {
    return applyRetryJitter(hintedRetryAfterMs);
  }

  const rateLimited = isRateLimitedModelError(error);
  const baseMs = rateLimited ? 2000 : 250;
  const maxMs = rateLimited ? 30_000 : 4000;
  const raw = Math.min(maxMs, baseMs * 2 ** attempt);
  return applyRetryJitter(raw);
}

function applyRetryJitter(delayMs: number): number {
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.max(0, Math.floor(delayMs * jitter));
}

function isRetryableModelError(error: unknown): boolean {
  if (error instanceof RunCancelledError) {
    return false;
  }

  const record = asRecord(error);
  const code = typeof record?.code === "string" ? record.code : undefined;
  const status = typeof record?.status === "number" ? record.status : undefined;

  if (
    code === "MODEL_AUTH_ERROR" ||
    code === "MODEL_PROVIDER_SCHEMA"
  ) {
    return false;
  }

  if (code === "MODEL_BAD_RESPONSE") {
    return isRetryableProviderWrapperBadResponse(error);
  }

  if (
    code === "IO_MODEL_TIMEOUT" ||
    code === "MODEL_TIMEOUT" ||
    code === "MODEL_RATE_LIMITED" ||
    code === "MODEL_PROVIDER_ERROR" ||
    code === "MODEL_NETWORK_DNS" ||
    code === "MODEL_NETWORK_ERROR"
  ) {
    return true;
  }

  if (status === undefined) {
    return false;
  }

  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function isRetryableProviderWrapperBadResponse(error: unknown): boolean {
  const record = asRecord(error);
  const topLevelStatus = typeof record?.status === "number" ? record.status : undefined;
  const details = asRecord(record?.details);
  const detailStatus = typeof details?.status === "number" ? details.status : undefined;
  if ((topLevelStatus ?? detailStatus) !== 400) {
    return false;
  }

  if (
    typeof details?.nestedProviderMessage === "string" ||
    typeof details?.providerRaw === "string" ||
    details?.parsedProviderError !== undefined
  ) {
    return false;
  }

  if (details?.providerMessage === "Provider returned error") {
    return true;
  }

  const parsedBody = asRecord(details?.parsedBody);
  const parsedError = asRecord(parsedBody?.error);
  return parsedError?.message === "Provider returned error";
}

function isRateLimitedModelError(error: unknown): boolean {
  const record = asRecord(error);
  const code = typeof record?.code === "string" ? record.code : undefined;
  const status = typeof record?.status === "number" ? record.status : undefined;
  return code === "MODEL_RATE_LIMITED" || status === 429;
}

function readRetryAfterMs(error: unknown): number | undefined {
  const record = asRecord(error);
  const topLevelMs = readPositiveNumber(record?.retryAfterMs);
  if (topLevelMs !== undefined) {
    return topLevelMs;
  }
  const topLevelSeconds = readPositiveNumber(record?.retryAfterSeconds);
  if (topLevelSeconds !== undefined) {
    return Math.ceil(topLevelSeconds * 1000);
  }
  const details = asRecord(record?.details);
  const detailMs = readPositiveNumber(details?.retryAfterMs);
  if (detailMs !== undefined) {
    return detailMs;
  }
  const detailSeconds = readPositiveNumber(details?.retryAfterSeconds);
  if (detailSeconds !== undefined) {
    return Math.ceil(detailSeconds * 1000);
  }
  return ;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new RunCancelledError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new RunCancelledError());
      },
      { once: true },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new RunCancelledError();
  }
}

function parseGatewayFailure(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return createRuntimeFailure("IO_MODEL_FAILED", "Model call failed.", {
    subsystem: "runtime",
    classification: "runtime",
    recoverable: true,
  });
}

function annotateGatewayFailure(
  error: Error,
  attemptsMade: number,
  maxAttempts: number,
  retryDelaysMs: number[],
): Error {
  if (attemptsMade <= 0) {
    return error;
  }

  const record = error as Error & {
    details?: Record<string, unknown> | undefined;
  };
  record.details = {
    ...(asRecord(record.details) ?? {}),
    gatewayAttempts: attemptsMade,
    gatewayMaxAttempts: maxAttempts,
    gatewayRetryDelaysMs: retryDelaysMs,
  };
  return error;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function readFailureCode(value: unknown): string | undefined {
  const record = asRecord(value);
  return typeof record?.code === "string" && record.code.trim().length > 0
    ? record.code
    : undefined;
}

function readFailureClass(value: unknown): string | undefined {
  const record = asRecord(value);
  const details = asRecord(record?.details);
  return typeof details?.classification === "string" && details.classification.trim().length > 0
    ? details.classification
    : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readTimeoutDiagnosticDetails(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (metadata === undefined) {
    return {};
  }

  const details: Record<string, unknown> = {};
  for (const key of [
    "runId",
    "phase",
    "stepAgent",
    "model",
    "runtimeBudgetRemainingMs",
    "objective",
    "lastToolName",
    "lastToolInputHash",
  ] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      details[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      details[key] = value;
    }
  }
  return details;
}
