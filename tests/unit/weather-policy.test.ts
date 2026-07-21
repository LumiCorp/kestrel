import assert from "node:assert/strict";

import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import {
  classifyWeatherProviderFailure,
  OPEN_METEO_ATTEMPT_TIMEOUT_MS,
  VISUAL_CROSSING_ATTEMPT_TIMEOUT_MS,
  WEATHER_FAILOVER_POLICY,
  WEATHER_TOTAL_PROVIDER_BUDGET_MS,
} from "../../tools/free/weatherPolicy.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "Weather production policy uses the approved budgets", () => {
  assert.equal(WEATHER_TOTAL_PROVIDER_BUDGET_MS, 18_000);
  assert.equal(OPEN_METEO_ATTEMPT_TIMEOUT_MS, 8000);
  assert.equal(VISUAL_CROSSING_ATTEMPT_TIMEOUT_MS, 10_000);
  assert.equal(WEATHER_FAILOVER_POLICY.failoverOnTimeout, true);
});

contractTest("runtime.hermetic", "Weather production policy falls back for approved HTTP statuses only", () => {
  for (const status of [408, 425, 429, 500, 503]) {
    assert.equal(classifyStatus(status).eligibleForFallback, true, String(status));
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(classifyStatus(status).eligibleForFallback, false, String(status));
  }
});

contractTest("runtime.hermetic", "Weather production policy falls back for transport and invalid payload failures", () => {
  assert.deepEqual(classifyWeatherProviderFailure(new TypeError("fetch failed")), {
    eligibleForFallback: true,
    code: "WEATHER_PROVIDER_TRANSPORT_FAILED",
    classification: "transport",
  });
  assert.equal(
    classifyWeatherProviderFailure(
      createRuntimeFailure("TOOL_PROVIDER_PAYLOAD_INVALID", "bad payload"),
    ).eligibleForFallback,
    true,
  );
});

contractTest("runtime.hermetic", "Weather production policy does not fall back for input failures", () => {
  assert.equal(
    classifyWeatherProviderFailure(
      createRuntimeFailure("TOOL_INPUT_INVALID", "bad input", {
        classification: "schema",
      }),
    ).eligibleForFallback,
    false,
  );
});

function classifyStatus(status: number) {
  return classifyWeatherProviderFailure(
    createRuntimeFailure("TOOL_PROVIDER_FAILED", "provider failed", { status }),
  );
}
