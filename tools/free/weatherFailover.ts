import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import {
  executeObservedWeatherProviderAttempt,
  type WeatherProviderAttemptEvidence,
} from "./weatherObservability.js";

export interface WeatherFailureDecision {
  eligibleForFallback: boolean;
  code: string;
  classification: string;
}

export interface WeatherFailoverPolicy {
  totalBudgetMs: number;
  primaryAttemptTimeoutMs: number;
  fallbackAttemptTimeoutMs: number;
  failoverOnTimeout: boolean;
  classifyFailure(error: unknown): WeatherFailureDecision;
}

export interface WeatherFailoverResult<T> {
  value: T;
  attempts: WeatherProviderAttemptEvidence[];
  fallbackUsed: boolean;
}

/**
 * Execute the fixed Open-Meteo -> Visual Crossing sequence. The coordinator
 * owns no timeout or failure policy; callers must supply the complete policy.
 */
export async function executeWeatherFailover<T>(input: {
  policy: WeatherFailoverPolicy;
  primary: (signal: AbortSignal) => Promise<T>;
  fallback?: ((signal: AbortSignal) => Promise<T>) | undefined;
  now?: (() => number) | undefined;
}): Promise<WeatherFailoverResult<T>> {
  validatePolicy(input.policy);
  const now = input.now ?? Date.now;
  const sequenceStartedAt = now();
  const attempts: WeatherProviderAttemptEvidence[] = [];
  const primary = await executeBoundedAttempt({
    provider: "open-meteo",
    timeoutMs: boundedAttemptTimeout(
      input.policy.primaryAttemptTimeoutMs,
      remainingBudget(input.policy.totalBudgetMs, sequenceStartedAt, now()),
    ),
    execute: input.primary,
    now,
  });
  attempts.push(primary.attempt);
  if (primary.status === "succeeded") {
    return { value: primary.value, attempts, fallbackUsed: false };
  }

  const decision =
    primary.attempt.outcome === "timed_out"
      ? {
          eligibleForFallback: input.policy.failoverOnTimeout,
          code: "WEATHER_PROVIDER_TIMEOUT",
          classification: "timeout",
        }
      : input.policy.classifyFailure(primary.error);
  primary.attempt.failureCode = decision.code;
  primary.attempt.failureClassification = decision.classification;
  if (!decision.eligibleForFallback) {
    throw sequenceFailure(
      "WEATHER_PRIMARY_FAILED_NO_FALLBACK",
      "The primary Weather provider failed and policy did not permit fallback.",
      attempts,
    );
  }
  if (input.fallback === undefined) {
    attempts.push({
      provider: "visual-crossing",
      outcome: "unavailable",
      durationMs: 0,
      failureCode: "WEATHER_FALLBACK_NOT_CONFIGURED",
      failureClassification: "configuration",
    });
    throw sequenceFailure(
      "WEATHER_FALLBACK_NOT_CONFIGURED",
      "The Weather fallback provider is not configured.",
      attempts,
    );
  }
  const remaining = remainingBudget(
    input.policy.totalBudgetMs,
    sequenceStartedAt,
    now(),
  );
  if (remaining <= 0) {
    throw sequenceFailure(
      "WEATHER_TOTAL_BUDGET_EXHAUSTED",
      "The Weather provider budget was exhausted before fallback could run.",
      attempts,
    );
  }
  const fallback = await executeBoundedAttempt({
    provider: "visual-crossing",
    timeoutMs: boundedAttemptTimeout(
      input.policy.fallbackAttemptTimeoutMs,
      remaining,
    ),
    execute: input.fallback,
    now,
  });
  attempts.push(fallback.attempt);
  if (fallback.status === "succeeded") {
    return { value: fallback.value, attempts, fallbackUsed: true };
  }
  const fallbackDecision =
    fallback.attempt.outcome === "timed_out"
      ? {
          code: "WEATHER_PROVIDER_TIMEOUT",
          classification: "timeout",
        }
      : input.policy.classifyFailure(fallback.error);
  fallback.attempt.failureCode = fallbackDecision.code;
  fallback.attempt.failureClassification = fallbackDecision.classification;
  throw sequenceFailure(
    "WEATHER_ALL_PROVIDERS_FAILED",
    "All configured Weather providers failed.",
    attempts,
  );
}

async function executeBoundedAttempt<T>(input: {
  provider: WeatherProviderAttemptEvidence["provider"];
  timeoutMs: number;
  execute: (signal: AbortSignal) => Promise<T>;
  now: () => number;
}) {
  const controller = new AbortController();
  const timeoutFailure = Symbol("weather-provider-timeout");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await executeObservedWeatherProviderAttempt({
    provider: input.provider,
    now: input.now,
    execute: async () => {
      const result = await Promise.race([
        input.execute(controller.signal),
        new Promise<typeof timeoutFailure>((resolve) => {
          timeout = setTimeout(() => {
            controller.abort();
            resolve(timeoutFailure);
          }, input.timeoutMs);
        }),
      ]);
      if (result === timeoutFailure) {
        throw timeoutFailure;
      }
      return result;
    },
  });
  if (timeout !== undefined) clearTimeout(timeout);
  if (outcome.status === "failed" && outcome.error === timeoutFailure) {
    return {
      ...outcome,
      attempt: {
        ...outcome.attempt,
        outcome: "timed_out" as const,
        failureCode: "WEATHER_PROVIDER_TIMEOUT",
        failureClassification: "timeout",
      },
    };
  }
  return outcome;
}

function boundedAttemptTimeout(configured: number, remaining: number) {
  if (remaining <= 0) {
    throw createRuntimeFailure(
      "WEATHER_TOTAL_BUDGET_EXHAUSTED",
      "The Weather provider budget was exhausted.",
      {
        subsystem: "tooling",
        classification: "timeout",
        recoverable: true,
      },
    );
  }
  return Math.min(configured, remaining);
}

function remainingBudget(total: number, startedAt: number, now: number) {
  return Math.max(0, total - Math.max(0, now - startedAt));
}

function validatePolicy(policy: WeatherFailoverPolicy) {
  for (const [field, value] of [
    ["totalBudgetMs", policy.totalBudgetMs],
    ["primaryAttemptTimeoutMs", policy.primaryAttemptTimeoutMs],
    ["fallbackAttemptTimeoutMs", policy.fallbackAttemptTimeoutMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw createRuntimeFailure(
        "WEATHER_FAILOVER_POLICY_INVALID",
        `Weather failover policy ${field} must be a positive finite number.`,
        {
          subsystem: "tooling",
          field,
          classification: "configuration",
          recoverable: false,
        },
      );
    }
  }
}

function sequenceFailure(
  code: string,
  message: string,
  attempts: WeatherProviderAttemptEvidence[],
) {
  return createRuntimeFailure(code, message, {
    subsystem: "tooling",
    classification: "provider",
    recoverable: true,
    attempts: attempts.map((attempt) => ({ ...attempt })),
  });
}
