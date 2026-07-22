import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareHarnessEfficiencyPairsV1,
  buildModelRequestEconomicsManifest,
  createEconomicsRunEvent,
  createHarnessEfficiencyLedgerV1,
  createHarnessEfficiencyResultV1,
  hashHarnessEfficiencyValue,
  parseHarnessEfficiencyResultV1,
  parseHarnessEfficiencyLedgerV1,
  parseHarnessEfficiencyPairedComparisonV1,
  readHarnessEfficiencyEconomicsFromLedger,
  type EconomicsLedgerProjectionV1,
  type HarnessEfficiencyResultV1,
} from "../../src/economics/index.js";
import { contractTest } from "../helpers/contract-test.js";
import { runHarnessEfficiencyComparison } from "../../scripts/compare-harness-efficiency.js";

contractTest("runtime.hermetic", "SWE and Terminal-Bench share one immutable efficiency result contract", () => {
  for (const lane of ["swe_verified", "terminal_bench"] as const) {
    const result = efficiencyResult({ lane, resultId: `${lane}-result`, inputTokens: 1_000, durationMs: 1_000 });
    assert.equal(parseHarnessEfficiencyResultV1(structuredClone(result)).lane, lane);

    const tampered = structuredClone(result) as HarnessEfficiencyResultV1;
    tampered.economics.totals.inputTokens = 1;
    assert.throws(() => parseHarnessEfficiencyResultV1(tampered), /payload hash does not match/u);
  }
});

contractTest("runtime.hermetic", "efficiency ledger appends the independent verifier outcome to the immutable call ledger", () => {
  const runId = "run-ledger-1";
  const sessionId = "session-ledger-1";
  const timestamp = "2026-07-22T00:00:00.000Z";
  const events = [
    createEconomicsRunEvent({
      runId,
      sessionId,
      timestamp,
      event: {
        kind: "model_call.requested",
        callId: "call-1",
        providerPayloadHash: "a".repeat(64),
        componentHash: "b".repeat(64),
        modelBudgetClass: "action",
        phase: "agent.loop",
        requestManifest: buildModelRequestEconomicsManifest({ request: { input: "hello", messages: [] } }),
      },
    }),
    createEconomicsRunEvent({
      runId,
      sessionId,
      timestamp: "2026-07-22T00:00:00.010Z",
      event: { kind: "model_attempt.started", callId: "call-1", attempt: 1, maxAttempts: 1 },
    }),
    createEconomicsRunEvent({
      runId,
      sessionId,
      timestamp: "2026-07-22T00:00:00.020Z",
      event: { kind: "model_attempt.completed", callId: "call-1", attempt: 1, latencyMs: 10 },
    }),
    createEconomicsRunEvent({
      runId,
      sessionId,
      timestamp: "2026-07-22T00:00:00.030Z",
      event: {
        kind: "model_call.completed",
        callId: "call-1",
        latencyMs: 30,
        usage: { version: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 },
        pricing: { version: 1, status: "unpriced", reason: "price_unavailable" },
      },
    }),
  ];
  const ledger = createHarnessEfficiencyLedgerV1({
    replayBundle: { version: "runtime_replay_bundle_v1", replay: { events } },
    runId,
    sessionId,
    recordedAt: "2026-07-22T00:00:01.000Z",
    outcome: {
      evaluatorId: "official-verifier",
      evaluatorVersion: "1",
      independentlyEvaluated: true,
      acceptance: "accepted",
      failureClass: "none",
    },
  });
  const parsed = parseHarnessEfficiencyLedgerV1(structuredClone(ledger));
  const economics = readHarnessEfficiencyEconomicsFromLedger(parsed);

  assert.equal(parsed.events.at(-1)?.type, "economics.run_outcome.evaluated");
  assert.equal(economics.status, "complete");
  assert.equal(economics.tokensPerAcceptedSuccess, 12);
  assert.equal(economics.costPerAcceptedSuccessUsd, null);
});

contractTest("runtime.hermetic", "efficiency result rejects rehashed unknown nested fields and inconsistent derived metrics", () => {
  const result = efficiencyResult({ lane: "swe_verified", resultId: "strict-result", inputTokens: 1_000, durationMs: 1_000 });
  const unknownField = structuredClone(result) as unknown as Record<string, unknown>;
  const unknownEconomics = unknownField.economics as Record<string, unknown>;
  (unknownEconomics.totals as Record<string, unknown>).unownedMetric = 1;
  const unknownUnhashed = { ...unknownField };
  delete unknownUnhashed.payloadHash;
  unknownField.payloadHash = hashHarnessEfficiencyValue(unknownUnhashed);
  assert.throws(() => parseHarnessEfficiencyResultV1(unknownField), /unknown field 'unownedMetric'/u);

  const inconsistent = structuredClone(result) as unknown as Record<string, unknown>;
  (inconsistent.economics as Record<string, unknown>).tokensPerAcceptedSuccess = 1;
  const inconsistentUnhashed = { ...inconsistent };
  delete inconsistentUnhashed.payloadHash;
  inconsistent.payloadHash = hashHarnessEfficiencyValue(inconsistentUnhashed);
  assert.throws(() => parseHarnessEfficiencyResultV1(inconsistent), /tokensPerAcceptedSuccess does not match/u);
});

contractTest("runtime.hermetic", "paired efficiency comparison promotes only accepted lower-cost candidates without regressions", () => {
  const baseline = efficiencyResult({ lane: "swe_verified", resultId: "baseline", inputTokens: 1_000, durationMs: 1_000 });
  const candidate = efficiencyResult({ lane: "swe_verified", resultId: "candidate", inputTokens: 700, durationMs: 900, candidate: true });

  const comparison = compareHarnessEfficiencyPairsV1({ baseline: [baseline], candidate: [candidate] });
  assert.equal(parseHarnessEfficiencyPairedComparisonV1(structuredClone(comparison)).comparisonId, comparison.comparisonId);

  assert.equal(comparison.promotable, true);
  assert.deepEqual(comparison.reasons, []);
  assert.equal(comparison.metrics.baseline.tokensPerAcceptedSuccess, 1_100);
  assert.equal(comparison.metrics.candidate.tokensPerAcceptedSuccess, 800);
});

contractTest("runtime.hermetic", "paired efficiency comparison rejects incomplete telemetry and acceptance regressions", () => {
  const baseline = efficiencyResult({ lane: "terminal_bench", resultId: "baseline", inputTokens: 1_000, durationMs: 1_000 });
  const candidate = efficiencyResult({
    lane: "terminal_bench",
    resultId: "candidate",
    inputTokens: 700,
    durationMs: 900,
    candidate: true,
    acceptance: "rejected",
    economicsStatus: "incomplete",
  });

  const comparison = compareHarnessEfficiencyPairsV1({ baseline: [baseline], candidate: [candidate] });

  assert.equal(comparison.promotable, false);
  assert.deepEqual(comparison.regressedPairIds, ["pair-1"]);
  assert.ok(comparison.reasons.some((reason) => /complete economics telemetry/u.test(reason)));
  assert.ok(comparison.reasons.some((reason) => /baseline-accepted pair regressed/u.test(reason)));
});

contractTest("runtime.hermetic", "paired comparison command reads lane artifacts and writes a promotion decision", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kestrel-efficiency-compare-"));
  try {
    const baselineDir = path.join(tmp, "baseline");
    const candidateDir = path.join(tmp, "candidate");
    const outputPath = path.join(tmp, "comparison.json");
    mkdirSync(baselineDir);
    mkdirSync(candidateDir);
    writeFileSync(path.join(baselineDir, "result.json"), JSON.stringify(efficiencyResult({ lane: "swe_verified", resultId: "baseline", inputTokens: 1_000, durationMs: 1_000 })), "utf8");
    writeFileSync(path.join(candidateDir, "result.json"), JSON.stringify(efficiencyResult({ lane: "swe_verified", resultId: "candidate", inputTokens: 700, durationMs: 900, candidate: true })), "utf8");

    const status = runHarnessEfficiencyComparison([
      "--baseline", baselineDir,
      "--candidate", candidateDir,
      "--out", outputPath,
    ], { write: () => true });

    assert.equal(status, 0);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).promotable, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function efficiencyResult(input: {
  lane: "swe_verified" | "terminal_bench";
  resultId: string;
  inputTokens: number;
  durationMs: number;
  candidate?: boolean | undefined;
  acceptance?: "accepted" | "rejected" | undefined;
  economicsStatus?: "complete" | "incomplete" | undefined;
}): HarnessEfficiencyResultV1 {
  const acceptance = input.acceptance ?? "accepted";
  const totals = totalsFixture(input.inputTokens);
  return createHarnessEfficiencyResultV1({
    pairId: "pair-1",
    lane: input.lane,
    dataset: input.lane === "swe_verified" ? "SWE-bench_Verified" : "terminal-bench@2.0",
    taskId: "task-1",
    attemptId: input.resultId,
    trial: 1,
    recordedAt: "2026-07-22T00:00:00.000Z",
    durationMs: input.durationMs,
    frozen: {
      protocolHash: "a".repeat(64),
      taskInputHash: "b".repeat(64),
      benchmarkConfigHash: "c".repeat(64),
      controlVariantHash: (input.candidate ? "d" : "e").repeat(64),
      harnessRevision: input.candidate ? "candidate-revision" : "baseline-revision",
      modelProvider: "provider-a",
      model: "model-a",
    },
    runtime: { runId: `run-${input.resultId}` },
    outcome: {
      evaluatorId: input.lane === "swe_verified" ? "swebench" : "terminal-bench",
      evaluatorVersion: "1",
      independentlyEvaluated: true,
      acceptance,
      failureClass: acceptance === "accepted" ? "none" : "verifier_failed",
    },
    economics: {
      status: input.economicsStatus ?? "complete",
      missingFields: input.economicsStatus === "incomplete" ? ["ledger"] : [],
      totals,
      invalidLedgerEvents: 0,
      tokensPerAcceptedSuccess: acceptance === "accepted" ? totals.inputTokens + totals.outputTokens : null,
      costPerAcceptedSuccessUsd: acceptance === "accepted" ? totals.pricedCostUsd : null,
    },
    artifacts: [],
  }, input.resultId);
}

function totalsFixture(inputTokens: number): EconomicsLedgerProjectionV1["totals"] {
  return {
    calls: 1,
    completedCalls: 1,
    failedCalls: 0,
    attempts: 1,
    retries: 0,
    inputTokens,
    outputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    pricedCostUsd: inputTokens / 1_000,
    unpricedCalls: 0,
    independentlyAcceptedCalls: 1,
    toolResults: 1,
    storedToolResultTokens: 100,
    modelVisibleToolResultTokens: 50,
    reducedToolResultTokens: 50,
  };
}
