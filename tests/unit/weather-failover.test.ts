import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import {
  executeWeatherFailover,
  type WeatherFailoverPolicy,
} from "../../tools/free/weatherFailover.js";

const testPolicy: WeatherFailoverPolicy = {
  totalBudgetMs: 100,
  primaryAttemptTimeoutMs: 40,
  fallbackAttemptTimeoutMs: 40,
  failoverOnTimeout: true,
  classifyFailure(error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "WEATHER_PROVIDER_FAILED";
    return {
      eligibleForFallback: code === "TOOL_PROVIDER_FAILED",
      code,
      classification: "provider",
    };
  },
};

test("Weather failover records an eligible primary failure and fallback success", async () => {
  const result = await executeWeatherFailover({
    policy: testPolicy,
    primary: async () => {
      throw createRuntimeFailure("TOOL_PROVIDER_FAILED", "primary failed");
    },
    fallback: async () => ({ source: "visual-crossing" }),
  });
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.value.source, "visual-crossing");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.provider, "open-meteo");
  assert.equal(result.attempts[0]?.failureCode, "TOOL_PROVIDER_FAILED");
  assert.equal(result.attempts[1]?.outcome, "succeeded");
});

test("Weather failover reports an explicit unavailable configured fallback", async () => {
  await assert.rejects(
    () =>
      executeWeatherFailover({
        policy: testPolicy,
        primary: async () => {
          throw createRuntimeFailure("TOOL_PROVIDER_FAILED", "primary failed");
        },
      }),
    (error: unknown) => {
      const failure = error as {
        code?: string;
        details?: { attempts?: Array<Record<string, unknown>> };
      };
      assert.equal(failure.code, "WEATHER_FALLBACK_NOT_CONFIGURED");
      assert.equal(failure.details?.attempts?.[1]?.outcome, "unavailable");
      return true;
    },
  );
});

test("Weather failover honors an explicit primary timeout and total deadline", async () => {
  const result = await executeWeatherFailover({
    policy: {
      ...testPolicy,
      totalBudgetMs: 60,
      primaryAttemptTimeoutMs: 10,
      fallbackAttemptTimeoutMs: 40,
    },
    primary: async () => new Promise(() => {}),
    fallback: async () => ({ source: "visual-crossing" }),
  });
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.attempts[0]?.outcome, "timed_out");
  assert.equal(result.attempts[0]?.failureCode, "WEATHER_PROVIDER_TIMEOUT");
});

test("Weather failover bounds two unresponsive providers by the total deadline", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      executeWeatherFailover({
        policy: {
          ...testPolicy,
          totalBudgetMs: 25,
          primaryAttemptTimeoutMs: 10,
          fallbackAttemptTimeoutMs: 40,
        },
        primary: async () => new Promise(() => {}),
        fallback: async () => new Promise(() => {}),
      }),
    (error: unknown) => {
      const failure = error as {
        code?: string;
        details?: { attempts?: Array<Record<string, unknown>> };
      };
      assert.equal(failure.code, "WEATHER_ALL_PROVIDERS_FAILED");
      assert.equal(failure.details?.attempts?.[0]?.outcome, "timed_out");
      assert.equal(failure.details?.attempts?.[1]?.outcome, "timed_out");
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 150);
});

test("Weather failover has no implicit policy defaults", async () => {
  await assert.rejects(
    () =>
      executeWeatherFailover({
        policy: {
          ...testPolicy,
          totalBudgetMs: 0,
        },
        primary: async () => ({ source: "open-meteo" }),
      }),
    (error: unknown) =>
      (error as { code?: string }).code === "WEATHER_FAILOVER_POLICY_INVALID",
  );
});
