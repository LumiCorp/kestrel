import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createPlan,
  findNewEfficiencyResultCandidates,
  isCollectedEfficiencyResultPath,
  parseHarnessEfficiencyCommand,
  parseExperimentSpec,
  validatePlanLaneProfiles,
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
      experiment: "efficiency_ab",
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

contractTest("runtime.hermetic", "efficiency comparison reads only collector-owned result artifacts", () => {
  assert.equal(isCollectedEfficiencyResultPath("/results/baseline/pair/result-1.json"), true);
  assert.equal(isCollectedEfficiencyResultPath("/results/baseline/raw/harness-efficiency-result.json"), false);
  assert.equal(isCollectedEfficiencyResultPath("/results/baseline/jobs/result.v2.json"), false);
});

contractTest("runtime.hermetic", "efficiency spec rejects unknown fields", () => {
  assert.throws(() => parseExperimentSpec({
    version: 1,
    experiment: "efficiency_ab",
    baseline: {},
    candidate: {},
    lanes: [],
    trialCount: 1,
    outputDirectory: "results",
    promotionPolicy: {},
  }), /unknown field 'promotionPolicy'/u);
});

contractTest("runtime.hermetic", "efficiency command accepts the documented pnpm separator", () => {
  const direct = parseHarnessEfficiencyCommand(["plan", "--spec", "experiment.json"]);
  const separated = parseHarnessEfficiencyCommand(["--", "plan", "--spec", "experiment.json"]);
  assert.deepEqual(separated, direct);
});

contractTest("runtime.hermetic", "efficiency plan validates every variant with each lane-owned profile contract", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "kestrel-efficiency-validation-"));
  try {
    const baselineFile = path.join(temporary, "baseline.json");
    const candidateFile = path.join(temporary, "candidate.json");
    writeFileSync(baselineFile, JSON.stringify({ profiles: [profile("observe")] }), "utf8");
    writeFileSync(candidateFile, JSON.stringify({ profiles: [profile("enforce")] }), "utf8");
    const plan = createPlan(parseExperimentSpec({
      version: 1,
      experiment: "efficiency_ab",
      baseline: { sourceRoot: process.cwd(), profileFile: baselineFile, profileId: "economics-test" },
      candidate: { sourceRoot: process.cwd(), profileFile: candidateFile, profileId: "economics-test" },
      lanes: [
        { lane: "swe_verified", dataset: "SWE-bench_Verified", taskIds: ["task-a"] },
        { lane: "terminal_bench", dataset: "terminal-bench@2.0", taskIds: ["task-b"] },
      ],
      trialCount: 1,
      outputDirectory: path.join(temporary, "results"),
    }));
    const commands: string[] = [];
    const successfulSpawn = ((command: string, args: readonly string[]) => {
      commands.push([command, ...args].join(" "));
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    }) as unknown as typeof spawnSync;

    validatePlanLaneProfiles(plan, successfulSpawn);

    assert.deepEqual(commands, [
      "pnpm run bench:swe -- validate-profile",
      "python3 -m benchmarks.terminal_bench.job_input --validate-profile",
      "pnpm run bench:swe -- validate-profile",
      "python3 -m benchmarks.terminal_bench.job_input --validate-profile",
    ]);

    const failingSpawn = (() => ({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "Terminal-Bench profile must enable inherited dev shell.",
      status: 1,
      signal: null,
    })) as unknown as typeof spawnSync;
    assert.throws(
      () => validatePlanLaneProfiles(plan, failingSpawn),
      /failed swe_verified contract validation/u,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "measurement A/A requires identical source and normalized profiles", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "kestrel-measurement-aa-"));
  try {
    const baselineFile = path.join(temporary, "baseline.json");
    const candidateFile = path.join(temporary, "candidate.json");
    writeFileSync(baselineFile, JSON.stringify({ profiles: [profile("observe")] }), "utf8");
    writeFileSync(candidateFile, JSON.stringify({ profiles: [profile("enforce")] }), "utf8");
    const create = () => createPlan(parseExperimentSpec({
      version: 1,
      experiment: "measurement_aa",
      baseline: { sourceRoot: process.cwd(), profileFile: baselineFile, profileId: "economics-test" },
      candidate: { sourceRoot: process.cwd(), profileFile: candidateFile, profileId: "economics-test" },
      lanes: [{ lane: "swe_verified", dataset: "SWE-bench_Verified", taskIds: ["task-a"] }],
      trialCount: 1,
      outputDirectory: path.join(temporary, "results"),
    }));

    assert.throws(create, /identical normalized baseline and candidate profiles/u);
    writeFileSync(candidateFile, JSON.stringify({ profiles: [profile("observe")] }), "utf8");
    assert.equal(create().experiment, "measurement_aa");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
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
