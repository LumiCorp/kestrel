import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareHarnessEfficiencyPairsV2,
  buildModelRequestEconomicsManifest,
  createEconomicsRunEvent,
  createHarnessEfficiencyLedgerV2,
  createHarnessEfficiencyResultV2,
  hashHarnessEfficiencyValue,
  parseHarnessEfficiencyResultV2,
  parseHarnessEfficiencyLedgerV2,
  parseHarnessEfficiencyPairedComparisonV2,
  readHarnessEfficiencyEconomicsFromLedger,
  reconcileHarnessEfficiencyRuntimeTelemetry,
  type EconomicsLedgerProjectionV1,
  type HarnessEfficiencyResultV2,
} from "../../src/economics/index.js";
import { contractTest } from "../helpers/contract-test.js";
import { runHarnessEfficiencyComparison } from "../../scripts/compare-harness-efficiency.js";

const CONTROL = {
  version: 1 as const,
  policy: {
    version: 1 as const,
    policyId: "economics:test:v1",
    mode: "observe" as const,
    counting: { estimatorVersion: "utf8-byte-upper-bound:v1", allowEstimatedEnforcement: false },
    context: { outputReserveTokens: 1_000, safetyReserveTokens: 250, sections: [] },
    compaction: { requireStructuredAnchors: true as const, maxSummaryAttempts: 1 as const },
    tools: { exposure: "assembly_allowlist" as const, modelContextMaxTokens: 20_000, allowedFamiliesByPhase: {} },
    cache: { mode: "provider_default" as const },
  },
  modelProfiles: [{
    version: 1 as const,
    profileId: "provider-a:model-a:v1",
    provider: "provider-a",
    model: "model-a",
    contextWindowTokens: 100_000,
    maxOutputTokens: 8_000,
    counting: { counter: "tiktoken:o200k_base", counterVersion: "1.0.21", method: "model_tokenizer" as const, confidence: "model_compatible" as const },
    cache: { behavior: "none" as const },
  }],
};

contractTest("runtime.hermetic", "SWE and Terminal-Bench share one immutable efficiency result contract", () => {
  for (const lane of ["swe_verified", "terminal_bench"] as const) {
    const result = efficiencyResult({ lane, resultId: `${lane}-result`, inputTokens: 1_000, durationMs: 1_000 });
    assert.equal(parseHarnessEfficiencyResultV2(structuredClone(result)).lane, lane);

    const tampered = structuredClone(result) as HarnessEfficiencyResultV2;
    tampered.economics.totals.inputTokens = 1;
    assert.throws(() => parseHarnessEfficiencyResultV2(tampered), /payload hash does not match/u);
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
        cache: { mode: "provider_default", stablePrefixHash: "c".repeat(64), stablePrefixTokens: 0, prefixChanged: false },
        callId: "call-1",
        providerPayloadHash: "a".repeat(64),
        componentHash: "b".repeat(64),
        provider: "provider-a",
        model: "model-a",
        modelProfileId: "provider-a:model-a:v1",
        economicsControlHash: hashHarnessEfficiencyValue(CONTROL),
        economicsControl: CONTROL,
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
        providerReportedInputDeltaTokens: 0,
        callId: "call-1",
        provider: "provider-a",
        model: "model-a",
        latencyMs: 30,
        usage: { version: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 },
        pricing: { version: 1, status: "priced", currency: "USD", priceVersion: "test:v1", sourceUrl: "https://example.test/pricing", totalCostUsd: 0, components: [] },
      },
    }),
  ];
  const ledger = createHarnessEfficiencyLedgerV2({
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
  const parsed = parseHarnessEfficiencyLedgerV2(structuredClone(ledger));
  const economics = readHarnessEfficiencyEconomicsFromLedger(parsed);

  assert.equal(parsed.entries.at(-1)?.event.type, "economics.run_outcome.evaluated");
  assert.equal(economics.status, "complete");
  assert.equal(economics.tokensPerAcceptedSuccess, 12);
  assert.equal(economics.costPerAcceptedSuccessUsd, 0);
});

contractTest("runtime.hermetic", "efficiency ledger rejects reordered canonical sequence even when the outer hash is recomputed", () => {
  const ledger = completeLedgerFixture();
  const mutated = structuredClone(ledger) as unknown as Record<string, unknown>;
  const entries = mutated.entries as Array<Record<string, unknown>>;
  entries[0]!.sequence = 2;
  const unhashed = { ...mutated };
  delete unhashed.payloadHash;
  mutated.payloadHash = hashHarnessEfficiencyValue(unhashed);

  assert.throws(() => parseHarnessEfficiencyLedgerV2(mutated), /sequence must be contiguous/u);
});

contractTest("runtime.hermetic", "efficiency ledger keeps missing delegated child evidence inspectable but incomplete", () => {
  const fixture = completeLedgerFixtureInput();
  fixture.events.splice(fixture.events.length - 1, 0, {
    runId: fixture.runId,
    sessionId: fixture.sessionId,
    type: "delegation.completed",
    level: "INFO",
    timestamp: "2026-07-22T00:00:00.025Z",
    metadata: {
      delegationId: "delegation-1",
      childRunId: "run-missing-child",
      status: "COMPLETED",
    },
  });
  const ledger = createHarnessEfficiencyLedgerV2({
    replayBundle: { version: "runtime_replay_bundle_v1", replay: { events: fixture.events } },
    runId: fixture.runId,
    sessionId: fixture.sessionId,
    recordedAt: "2026-07-22T00:00:01.000Z",
    outcome: {
      evaluatorId: "official-verifier",
      evaluatorVersion: "1",
      independentlyEvaluated: true,
      acceptance: "accepted",
      failureClass: "none",
    },
  });
  const economics = readHarnessEfficiencyEconomicsFromLedger(ledger);

  assert.equal(parseHarnessEfficiencyLedgerV2(ledger).runIds.includes("run-missing-child"), true);
  assert.equal(economics.status, "incomplete");
  assert.ok(economics.missingFields.includes("childRun:run-missing-child"));
  assert.equal(economics.tokensPerAcceptedSuccess, null);
});

contractTest("runtime.hermetic", "efficiency result rejects rehashed unknown nested fields and inconsistent derived metrics", () => {
  const result = efficiencyResult({ lane: "swe_verified", resultId: "strict-result", inputTokens: 1_000, durationMs: 1_000 });
  const unknownField = structuredClone(result) as unknown as Record<string, unknown>;
  const unknownEconomics = unknownField.economics as Record<string, unknown>;
  (unknownEconomics.totals as Record<string, unknown>).unownedMetric = 1;
  const unknownUnhashed = { ...unknownField };
  delete unknownUnhashed.payloadHash;
  unknownField.payloadHash = hashHarnessEfficiencyValue(unknownUnhashed);
  assert.throws(() => parseHarnessEfficiencyResultV2(unknownField), /unknown field 'unownedMetric'/u);

  const inconsistent = structuredClone(result) as unknown as Record<string, unknown>;
  (inconsistent.economics as Record<string, unknown>).tokensPerAcceptedSuccess = 1;
  const inconsistentUnhashed = { ...inconsistent };
  delete inconsistentUnhashed.payloadHash;
  inconsistent.payloadHash = hashHarnessEfficiencyValue(inconsistentUnhashed);
  assert.throws(() => parseHarnessEfficiencyResultV2(inconsistent), /tokensPerAcceptedSuccess does not match/u);
});

contractTest("runtime.hermetic", "paired efficiency comparison passes only accepted lower-cost candidates without regressions", () => {
  const baseline = efficiencyResult({ lane: "swe_verified", resultId: "baseline", inputTokens: 1_000, durationMs: 1_000 });
  const candidate = efficiencyResult({ lane: "swe_verified", resultId: "candidate", inputTokens: 700, durationMs: 900, candidate: true });

  const comparison = compareHarnessEfficiencyPairsV2({ baseline: [baseline], candidate: [candidate] });
  assert.equal(parseHarnessEfficiencyPairedComparisonV2(structuredClone(comparison)).comparisonId, comparison.comparisonId);

  assert.equal(comparison.passed, true);
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

  const comparison = compareHarnessEfficiencyPairsV2({ baseline: [baseline], candidate: [candidate] });

  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.regressedPairIds, ["pair-1"]);
  assert.ok(comparison.reasons.some((reason) => /complete economics telemetry/u.test(reason)));
  assert.ok(comparison.reasons.some((reason) => /baseline-accepted pair regressed/u.test(reason)));
});

contractTest("runtime.hermetic", "paired efficiency comparison does not interpret efficiency without an accepted outcome on each side", () => {
  const rejectedBaseline = efficiencyResult({
    lane: "swe_verified",
    resultId: "baseline-rejected",
    inputTokens: 1_000,
    durationMs: 1_000,
    acceptance: "rejected",
  });
  const acceptedBaseline = efficiencyResult({
    lane: "swe_verified",
    resultId: "baseline-accepted",
    inputTokens: 1_000,
    durationMs: 1_000,
  });
  const rejectedCandidate = efficiencyResult({
    lane: "swe_verified",
    resultId: "candidate-rejected",
    inputTokens: 700,
    durationMs: 900,
    candidate: true,
    acceptance: "rejected",
  });
  const acceptedCandidate = efficiencyResult({
    lane: "swe_verified",
    resultId: "candidate-accepted",
    inputTokens: 700,
    durationMs: 900,
    candidate: true,
  });

  for (const comparison of [
    compareHarnessEfficiencyPairsV2({ baseline: [rejectedBaseline], candidate: [rejectedCandidate] }),
    compareHarnessEfficiencyPairsV2({ baseline: [rejectedBaseline], candidate: [acceptedCandidate] }),
    compareHarnessEfficiencyPairsV2({ baseline: [acceptedBaseline], candidate: [rejectedCandidate] }),
  ]) {
    assert.equal(comparison.passed, false);
    assert.ok(comparison.reasons.some((reason) => /each have at least one accepted outcome/u.test(reason)));
    assert.equal(comparison.reasons.some((reason) => /does not improve tokens or priced cost/u.test(reason)), false);
  }
});

contractTest("runtime.hermetic", "measurement A/A qualifies identical accepted evidence without demanding an efficiency delta", () => {
  const baseline = efficiencyResult({ lane: "swe_verified", resultId: "aa-baseline", inputTokens: 1_000, durationMs: 1_000 });
  const candidate = efficiencyResult({ lane: "swe_verified", resultId: "aa-candidate", inputTokens: 1_100, durationMs: 1_100, candidate: true });

  const comparison = compareHarnessEfficiencyPairsV2({
    baseline: [baseline],
    candidate: [candidate],
    mode: "measurement_aa",
  });

  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.reasons, []);
});

contractTest("runtime.hermetic", "measurement A/A rejects runtime-ledger disagreement", () => {
  const baseline = efficiencyResult({ lane: "swe_verified", resultId: "aa-baseline", inputTokens: 1_000, durationMs: 1_000 });
  const candidate = efficiencyResult({
    lane: "swe_verified",
    resultId: "aa-candidate",
    inputTokens: 1_000,
    durationMs: 1_000,
    candidate: true,
  });
  const comparison = compareHarnessEfficiencyPairsV2({ baseline: [baseline], candidate: [candidate], mode: "measurement_aa" });
  assert.equal(comparison.passed, true);

  const reconciled = reconcileHarnessEfficiencyRuntimeTelemetry(baseline.economics, {
    modelCalls: baseline.economics.totals.calls + 1,
    inputTokens: baseline.economics.totals.inputTokens,
    outputTokens: baseline.economics.totals.outputTokens,
    totalTokens: baseline.economics.totals.inputTokens + baseline.economics.totals.outputTokens,
  });
  assert.equal(reconciled.status, "incomplete");
  assert.ok(reconciled.missingFields.some((field) => field.startsWith("runtimeTelemetry.modelCalls:")));
});

contractTest("runtime.hermetic", "paired comparison command reads lane artifacts and writes a pass decision", () => {
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
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).passed, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function completeLedgerFixtureInput() {
  const runId = "run-ledger-fixture";
  const sessionId = "session-ledger-fixture";
  const events = [
    createEconomicsRunEvent({
      runId,
      sessionId,
      timestamp: "2026-07-22T00:00:00.000Z",
      event: {
        kind: "model_call.requested",
        cache: { mode: "provider_default", stablePrefixHash: "c".repeat(64), stablePrefixTokens: 0, prefixChanged: false },
        callId: "call-fixture",
        providerPayloadHash: "a".repeat(64),
        componentHash: "b".repeat(64),
        provider: "provider-a",
        model: "model-a",
        modelProfileId: "provider-a:model-a:v1",
        economicsControlHash: hashHarnessEfficiencyValue(CONTROL),
        economicsControl: CONTROL,
        modelBudgetClass: "action",
        phase: "agent.loop",
        requestManifest: buildModelRequestEconomicsManifest({ request: { input: "hello", messages: [] } }),
      },
    }),
    createEconomicsRunEvent({
      runId,
      sessionId,
      timestamp: "2026-07-22T00:00:00.010Z",
      event: { kind: "model_attempt.started", callId: "call-fixture", attempt: 1, maxAttempts: 1 },
    }),
    createEconomicsRunEvent({
      runId,
      sessionId,
      timestamp: "2026-07-22T00:00:00.020Z",
      event: { kind: "model_attempt.completed", callId: "call-fixture", attempt: 1, latencyMs: 10 },
    }),
    createEconomicsRunEvent({
      runId,
      sessionId,
      timestamp: "2026-07-22T00:00:00.030Z",
      event: {
        kind: "model_call.completed",
        providerReportedInputDeltaTokens: 0,
        callId: "call-fixture",
        provider: "provider-a",
        model: "model-a",
        latencyMs: 30,
        usage: { version: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 },
        pricing: { version: 1, status: "priced", currency: "USD", priceVersion: "test:v1", sourceUrl: "https://example.test/pricing", totalCostUsd: 0, components: [] },
      },
    }),
  ];
  return { runId, sessionId, events };
}

function completeLedgerFixture() {
  const fixture = completeLedgerFixtureInput();
  return createHarnessEfficiencyLedgerV2({
    replayBundle: { version: "runtime_replay_bundle_v1", replay: { events: fixture.events } },
    runId: fixture.runId,
    sessionId: fixture.sessionId,
    recordedAt: "2026-07-22T00:00:01.000Z",
    outcome: {
      evaluatorId: "official-verifier",
      evaluatorVersion: "1",
      independentlyEvaluated: true,
      acceptance: "accepted",
      failureClass: "none",
    },
  });
}

function efficiencyResult(input: {
  lane: "swe_verified" | "terminal_bench";
  resultId: string;
  inputTokens: number;
  durationMs: number;
  candidate?: boolean | undefined;
  acceptance?: "accepted" | "rejected" | undefined;
  economicsStatus?: "complete" | "incomplete" | undefined;
}): HarnessEfficiencyResultV2 {
  const acceptance = input.acceptance ?? "accepted";
  const totals = totalsFixture(input.inputTokens);
  return createHarnessEfficiencyResultV2({
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
    cacheHitRatio: 0,
    cacheWriteAmplification: 0,
    reasoningTokens: 0,
    pricedCostUsd: inputTokens / 1_000,
    unpricedCalls: 0,
    toolResults: 1,
    rawToolResultTokens: 100,
    persistedToolResultTokens: 75,
    verificationVisibleToolResultTokens: 75,
    modelVisibleToolResultTokens: 50,
    rawToPersistedReductionTokens: 25,
    persistedToModelVisibleReductionTokens: 25,
    rawToModelVisibleReductionTokens: 50,
  };
}
