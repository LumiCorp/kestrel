import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createPlan,
  findNewEfficiencyResultCandidates,
  parseExperimentSpec,
} from "../../scripts/harness-efficiency.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "efficiency plan validates strict profiles and balances pair order", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "kestrel-efficiency-plan-"));
  try {
    const baselineFile = path.join(temporary, "baseline.json");
    const candidateFile = path.join(temporary, "candidate.json");
    writeFileSync(baselineFile, JSON.stringify({ profiles: [profile("observe")] }), "utf8");
    writeFileSync(candidateFile, JSON.stringify({ profiles: [profile("enforce")] }), "utf8");
    const spec = parseExperimentSpec({
      version: 1,
      baseline: { sourceRoot: process.cwd(), profileFile: baselineFile, profileId: "economics-test" },
      candidate: { sourceRoot: process.cwd(), profileFile: candidateFile, profileId: "economics-test" },
      lanes: [{ lane: "swe_verified", dataset: "SWE-bench_Verified", taskIds: ["task-a", "task-b"] }],
      trialCount: 1,
      outputDirectory: path.join(temporary, "results"),
    });
    const plan = createPlan(spec);

    assert.equal(plan.pairCount, 2);
    assert.equal(plan.attemptCount, 4);
    assert.deepEqual(plan.attempts.map((attempt) => attempt.order), [
      ["baseline", "candidate"],
      ["candidate", "baseline"],
    ]);
    assert.equal(plan.attempts[0]?.commands.baseline.profileId, "economics-test");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "efficiency spec rejects unknown fields", () => {
  assert.throws(() => parseExperimentSpec({
    version: 1,
    baseline: {},
    candidate: {},
    lanes: [],
    trialCount: 1,
    outputDirectory: "results",
    promotionPolicy: {},
  }), /unknown field 'promotionPolicy'/u);
});

contractTest("runtime.hermetic", "efficiency result discovery includes the external variant output root", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "kestrel-efficiency-results-"));
  try {
    const sourceRoot = path.join(temporary, "source");
    const outputRoot = path.join(temporary, "results", "baseline");
    const resultPath = path.join(outputRoot, "attempt", "harness-efficiency-result.json");
    const unrelatedPath = path.join(sourceRoot, "unrelated.json");
    mkdirSync(path.dirname(resultPath), { recursive: true });
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ schema: "kestrel.harness-efficiency-result/v2" }), "utf8");
    writeFileSync(unrelatedPath, JSON.stringify({ schema: "other" }), "utf8");

    assert.deepEqual(
      findNewEfficiencyResultCandidates([sourceRoot, outputRoot], 0),
      [resultPath],
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function profile(mode: "observe" | "enforce") {
  return {
    id: "economics-test",
    label: "Economics test",
    agent: "reference-react",
    modelProvider: "provider-a",
    model: "model-a",
    agentStageConfig: { modelByStage: { "agent.loop": "model-a", "agent.maintenance": "model-a", "delegation.child": "model-a" } },
    harnessEconomics: {
      version: 1,
      policy: {
        version: 1,
        policyId: `economics:${mode}`,
        mode,
        counting: { estimatorVersion: "utf8-byte-upper-bound:v1", allowEstimatedEnforcement: false },
        context: { outputReserveTokens: 1_000, safetyReserveTokens: 250, sections: [] },
        compaction: { requireStructuredAnchors: true, maxSummaryAttempts: 1 },
        tools: { exposure: "assembly_allowlist", modelContextMaxTokens: 20_000, allowedFamiliesByPhase: {} },
        cache: { mode: "provider_default" },
      },
      modelProfiles: [{
        version: 1,
        profileId: "provider-a:model-a:v1",
        provider: "provider-a",
        model: "model-a",
        contextWindowTokens: 100_000,
        maxOutputTokens: 8_000,
        counting: { counter: "tiktoken:o200k_base", counterVersion: "1.0.21", method: "model_tokenizer", confidence: "model_compatible" },
        cache: { behavior: "none" },
        price: {
          version: 1,
          priceVersion: "test:v1",
          currency: "USD",
          effectiveAt: "2026-07-22T00:00:00.000Z",
          retrievedAt: "2026-07-22T00:00:00.000Z",
          sourceUrl: "https://example.test/pricing",
          perMillionTokens: { input: 1, output: 2 },
        },
      }],
    },
  };
}
