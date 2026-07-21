import assert from "node:assert/strict";

import { buildQualityScorecard } from "../../src/governance/qualityScorecard.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "buildQualityScorecard computes bounded score and trend", () => {
  const scorecard = buildQualityScorecard([
    {
      domain: "runtime",
      architectureCompliance: 90,
      testDepth: 90,
      incidentRate: 10,
      drift: 10,
      replayStability: 95,
      latency: 80,
      previousScore: 70,
    },
  ]);

  assert.equal(scorecard.domains.length, 1);
  assert.equal(scorecard.domains[0]?.domain, "runtime");
  assert.equal((scorecard.domains[0]?.score ?? 0) > 0, true);
  assert.equal(scorecard.domains[0]?.trend, "up");
});
