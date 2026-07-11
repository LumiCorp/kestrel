import test from "node:test";
import assert from "node:assert/strict";

import { promptSuiteThresholdsFor } from "../../scripts/prompt-suite.js";
import { runPromptSuite } from "./promptSuiteHarness.js";

test("prompt suite pass-rate meets threshold", async () => {
  const profile = "stable";
  const thresholds = promptSuiteThresholdsFor(profile);
  const summary = await runPromptSuite(2, profile);

  assert.equal(summary.total > 0, true);
  assert.equal(Number.isFinite(summary.passRate), true);
  assert.equal(summary.threshold_profile, profile);
  assert.equal(Number.isFinite(summary.quality.composite), true);
  assert.equal(typeof summary.byFailureClass, "object");
  assert.equal(
    summary.passRate >= thresholds.passRate,
    true,
    `passRate=${summary.passRate} below ${thresholds.passRate}`,
  );
  assert.equal(
    summary.quality.composite >= thresholds.composite,
    true,
    `composite=${summary.quality.composite} below ${thresholds.composite}`,
  );
});
