import assert from "node:assert/strict";
import test from "node:test";

import {
  promptSuiteResultFailures,
  promptSuiteThresholdsFor,
} from "../../scripts/prompt-suite.js";
import type { PromptSuiteSummary } from "./promptSuiteHarness.js";

test("prompt suite result contract enforces totals and release thresholds", () => {
  const profile = "stable";
  const thresholds = promptSuiteThresholdsFor(profile);
  const summary = {
    total: 10,
    passed: 9,
    failed: 1,
    passRate: 0.9,
    threshold_profile: profile,
    quality: {
      correctness: 90,
      latency: 90,
      tool_efficiency: 90,
      recovery: 90,
      cost: 90,
      composite: 90,
    },
    byTag: {},
    byFailureClass: {},
    results: [],
  } satisfies PromptSuiteSummary;

  assert.deepEqual(promptSuiteResultFailures(summary, thresholds), []);
  assert.deepEqual(
    promptSuiteResultFailures(
      { ...summary, failed: 0, passRate: 0.5 },
      thresholds
    ),
    ["passed plus failed must equal total", "passRate=0.5 < min=0.9"]
  );
});
