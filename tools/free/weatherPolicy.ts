import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type {
  WeatherFailureDecision,
  WeatherFailoverPolicy,
} from "./weatherFailover.js";

export const WEATHER_TOTAL_PROVIDER_BUDGET_MS = 18_000;
export const OPEN_METEO_ATTEMPT_TIMEOUT_MS = 8000;
export const VISUAL_CROSSING_ATTEMPT_TIMEOUT_MS = 10_000;

/** Approved production policy for the fixed Open-Meteo -> Visual Crossing sequence. */
export const WEATHER_FAILOVER_POLICY: WeatherFailoverPolicy = Object.freeze({
  totalBudgetMs: WEATHER_TOTAL_PROVIDER_BUDGET_MS,
  primaryAttemptTimeoutMs: OPEN_METEO_ATTEMPT_TIMEOUT_MS,
  fallbackAttemptTimeoutMs: VISUAL_CROSSING_ATTEMPT_TIMEOUT_MS,
  failoverOnTimeout: true,
  classifyFailure: classifyWeatherProviderFailure,
});

export function classifyWeatherProviderFailure(
  error: unknown,
): WeatherFailureDecision {
  const failure = parseWeatherProviderFailure(error);
  if (failure.kind === "runtime") {
    if (failure.error.code === "TOOL_PROVIDER_PAYLOAD_INVALID") {
      return decision(true, failure.error.code, "invalid_payload");
    }
    if (failure.error.code === "TOOL_PROVIDER_FAILED") {
      const status = readHttpStatus(failure.error.details?.status);
      if (status === undefined) {
        return decision(true, failure.error.code, "transport");
      }
      const eligible = isFallbackEligibleStatus(status);
      return decision(
        eligible,
        failure.error.code,
        eligible ? "retryable_http_status" : "non_retryable_http_status",
      );
    }
    return decision(
      false,
      failure.error.code,
      readClassification(failure.error.details?.classification),
    );
  }

  if (failure.kind === "transport") {
    return decision(true, "WEATHER_PROVIDER_TRANSPORT_FAILED", "transport");
  }
  return decision(false, "WEATHER_PROVIDER_FAILED", "unknown");
}

function parseWeatherProviderFailure(error: unknown):
  | { kind: "runtime"; error: RuntimeFailure }
  | { kind: "transport" }
  | { kind: "unknown" } {
  if (error instanceof RuntimeFailure) return { kind: "runtime", error };
  if (isFetchTransportError(error)) return { kind: "transport" };
  return { kind: "unknown" };
}

function isFallbackEligibleStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function isFetchTransportError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof DOMException &&
    (error.name === "NetworkError" || error.name === "AbortError")
  );
}

function readHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readClassification(value: unknown): string {
  return typeof value === "string" ? value : "runtime";
}

function decision(
  eligibleForFallback: boolean,
  code: string,
  classification: string,
): WeatherFailureDecision {
  return { eligibleForFallback, code, classification };
}
