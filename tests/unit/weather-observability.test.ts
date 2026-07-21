import assert from "node:assert/strict";

import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { executeObservedWeatherProviderAttempt } from "../../tools/free/weatherObservability.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "Weather attempt evidence records success without provider payload leakage", async () => {
  const ticks = [100, 112];
  const outcome = await executeObservedWeatherProviderAttempt({
    provider: "open-meteo",
    now: () => ticks.shift() ?? 112,
    execute: async () => ({ temperatureC: 22 }),
  });
  assert.deepEqual(outcome, {
    status: "succeeded",
    value: { temperatureC: 22 },
    attempt: {
      provider: "open-meteo",
      outcome: "succeeded",
      durationMs: 12,
    },
  });
});

contractTest("runtime.hermetic", "Weather attempt evidence exposes only normalized failure metadata", async () => {
  const failure = createRuntimeFailure(
    "TOOL_PROVIDER_FAILED",
    "secret-bearing upstream message",
    { classification: "provider", credential: "must-not-leak" },
  );
  const outcome = await executeObservedWeatherProviderAttempt({
    provider: "visual-crossing",
    now: () => 100,
    execute: async () => {
      throw failure;
    },
  });
  assert.equal(outcome.status, "failed");
  assert.deepEqual(outcome.attempt, {
    provider: "visual-crossing",
    outcome: "failed",
    durationMs: 0,
    failureCode: "TOOL_PROVIDER_FAILED",
    failureClassification: "provider",
  });
  assert.equal(JSON.stringify(outcome.attempt).includes("must-not-leak"), false);
});
