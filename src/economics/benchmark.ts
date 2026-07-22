import { createHash, randomUUID } from "node:crypto";

import type { EconomicsLedgerProjectionV1 } from "./contracts.js";
import type { RunEvent } from "../kestrel/contracts/events.js";
import {
  createEconomicsRunEvent,
  parseEconomicsLedgerEvent,
  projectEconomicsLedger,
} from "./ledger.js";

export type HarnessEfficiencyLane = "swe_verified" | "terminal_bench";
export type HarnessEfficiencyAcceptance = "accepted" | "rejected" | "not_evaluated";

export interface HarnessEfficiencyResultV1 {
  version: 1;
  schema: "kestrel.harness-efficiency-result/v1";
  resultId: string;
  payloadHash: string;
  pairId: string;
  lane: HarnessEfficiencyLane;
  dataset: string;
  taskId: string;
  attemptId: string;
  trial: number;
  recordedAt: string;
  durationMs: number;
  frozen: {
    protocolHash: string;
    taskInputHash: string;
    benchmarkConfigHash: string;
    controlVariantHash: string;
    harnessRevision: string;
    modelProvider: string;
    model: string;
  };
  runtime: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    threadId?: string | undefined;
  };
  outcome: {
    evaluatorId: string;
    evaluatorVersion: string;
    independentlyEvaluated: boolean;
    acceptance: HarnessEfficiencyAcceptance;
    failureClass: string;
  };
  economics: {
    status: "complete" | "incomplete";
    missingFields: string[];
    totals: EconomicsLedgerProjectionV1["totals"];
    invalidLedgerEvents: number;
    tokensPerAcceptedSuccess: number | null;
    costPerAcceptedSuccessUsd: number | null;
  };
  artifacts: Array<{
    kind: string;
    path: string;
    sha256?: string | undefined;
  }>;
}

export interface HarnessEfficiencyLedgerV1 {
  version: 1;
  schema: "kestrel.harness-efficiency-ledger/v1";
  payloadHash: string;
  sourceReplayHash: string;
  runId: string;
  sessionId: string;
  recordedAt: string;
  events: RunEvent[];
}

export type HarnessEfficiencyResultDraftV1 = Omit<HarnessEfficiencyResultV1, "version" | "schema" | "resultId" | "payloadHash">;

export interface HarnessEfficiencyPairedComparisonV1 {
  version: 1;
  schema: "kestrel.harness-efficiency-paired-comparison/v1";
  comparisonId: string;
  payloadHash: string;
  recordedAt: string;
  pairIds: string[];
  baselineResultIds: string[];
  candidateResultIds: string[];
  metrics: {
    baseline: HarnessEfficiencyAggregateV1;
    candidate: HarnessEfficiencyAggregateV1;
  };
  newFailureClasses: string[];
  regressedPairIds: string[];
  promotable: boolean;
  reasons: string[];
}

export interface HarnessEfficiencyAggregateV1 {
  attempts: number;
  accepted: number;
  acceptanceRate: number;
  totalTokens: number;
  tokensPerAcceptedSuccess: number | null;
  pricedCostUsd: number;
  costPerAcceptedSuccessUsd: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

export function createHarnessEfficiencyResultV1(
  draft: HarnessEfficiencyResultDraftV1,
  resultId: string = randomUUID(),
): HarnessEfficiencyResultV1 {
  const unhashed = {
    version: 1 as const,
    schema: "kestrel.harness-efficiency-result/v1" as const,
    resultId,
    ...draft,
  };
  validateResult(unhashed);
  return { ...unhashed, payloadHash: hashCanonical(unhashed) };
}

export function parseHarnessEfficiencyResultV1(value: unknown): HarnessEfficiencyResultV1 {
  const result = requireRecord(value, "result");
  rejectUnknown(result, new Set(["version", "schema", "resultId", "payloadHash", "pairId", "lane", "dataset", "taskId", "attemptId", "trial", "recordedAt", "durationMs", "frozen", "runtime", "outcome", "economics", "artifacts"]), "result");
  const payloadHash = requireHash(result.payloadHash, "payloadHash");
  const unhashed = { ...result };
  delete unhashed.payloadHash;
  if (hashCanonical(unhashed) !== payloadHash) throw new Error("Harness efficiency result payload hash does not match.");
  validateResult(unhashed);
  return { ...unhashed, payloadHash } as HarnessEfficiencyResultV1;
}

export function createHarnessEfficiencyLedgerV1(input: {
  replayBundle: unknown;
  recordedAt: string;
  runId?: string | undefined;
  sessionId?: string | undefined;
  outcome: HarnessEfficiencyResultV1["outcome"];
}): HarnessEfficiencyLedgerV1 {
  const replayEvents = readReplayEvents(input.replayBundle).filter((event) => event.type.startsWith("economics."));
  const runId = input.runId ?? replayEvents[0]?.runId;
  const sessionId = input.sessionId ?? replayEvents[0]?.sessionId;
  if (runId === undefined || sessionId === undefined) {
    throw new Error("Harness efficiency ledger requires runtime run and session identifiers.");
  }
  if (replayEvents.some((event) => event.runId !== runId || event.sessionId !== sessionId)) {
    throw new Error("Harness efficiency ledger replay events span multiple runs or sessions.");
  }
  const outcomeEvent = createEconomicsRunEvent({
    runId,
    sessionId,
    timestamp: input.recordedAt,
    event: {
      kind: "run_outcome.evaluated",
      runId,
      evaluatorId: input.outcome.evaluatorId,
      evaluatorVersion: input.outcome.evaluatorVersion,
      acceptance: input.outcome.acceptance,
      independentlyEvaluated: input.outcome.independentlyEvaluated,
      failureClass: input.outcome.failureClass,
    },
  });
  const unhashed = {
    version: 1 as const,
    schema: "kestrel.harness-efficiency-ledger/v1" as const,
    sourceReplayHash: hashCanonical(input.replayBundle),
    runId,
    sessionId,
    recordedAt: input.recordedAt,
    events: [...replayEvents, outcomeEvent],
  };
  validateEfficiencyLedger(unhashed);
  return { ...unhashed, payloadHash: hashCanonical(unhashed) };
}

export function parseHarnessEfficiencyLedgerV1(value: unknown): HarnessEfficiencyLedgerV1 {
  const ledger = requireRecord(value, "ledger");
  rejectUnknown(ledger, new Set(["version", "schema", "payloadHash", "sourceReplayHash", "runId", "sessionId", "recordedAt", "events"]), "ledger");
  const payloadHash = requireHash(ledger.payloadHash, "ledger.payloadHash");
  const unhashed = { ...ledger };
  delete unhashed.payloadHash;
  if (hashCanonical(unhashed) !== payloadHash) throw new Error("Harness efficiency ledger payload hash does not match.");
  validateEfficiencyLedger(unhashed);
  return { ...unhashed, payloadHash } as HarnessEfficiencyLedgerV1;
}

export function compareHarnessEfficiencyPairsV1(input: {
  baseline: HarnessEfficiencyResultV1[];
  candidate: HarnessEfficiencyResultV1[];
}): HarnessEfficiencyPairedComparisonV1 {
  const baselineByPair = uniqueByPair(input.baseline, "baseline");
  const candidateByPair = uniqueByPair(input.candidate, "candidate");
  const pairIds = [...new Set([...baselineByPair.keys(), ...candidateByPair.keys()])].sort();
  const reasons: string[] = [];
  const regressedPairIds: string[] = [];
  const pairedBaseline: HarnessEfficiencyResultV1[] = [];
  const pairedCandidate: HarnessEfficiencyResultV1[] = [];
  for (const pairId of pairIds) {
    const baseline = baselineByPair.get(pairId);
    const candidate = candidateByPair.get(pairId);
    if (baseline === undefined || candidate === undefined) {
      reasons.push(`Pair '${pairId}' is missing a ${baseline === undefined ? "baseline" : "candidate"} result.`);
      continue;
    }
    assertFrozenPair(baseline, candidate);
    pairedBaseline.push(baseline);
    pairedCandidate.push(candidate);
    if (baseline.outcome.acceptance === "accepted" && candidate.outcome.acceptance !== "accepted") {
      regressedPairIds.push(pairId);
    }
  }
  if ([...pairedBaseline, ...pairedCandidate].some((result) => result.economics.status !== "complete" || result.economics.invalidLedgerEvents > 0)) {
    reasons.push("Every paired result must have complete economics telemetry and zero invalid ledger events.");
  }
  if ([...pairedBaseline, ...pairedCandidate].some((result) => result.outcome.independentlyEvaluated !== true || result.outcome.acceptance === "not_evaluated")) {
    reasons.push("Every paired result must have an independent terminal evaluation.");
  }
  if (regressedPairIds.length > 0) reasons.push("At least one baseline-accepted pair regressed.");
  const baselineMetrics = aggregate(pairedBaseline);
  const candidateMetrics = aggregate(pairedCandidate);
  if (candidateMetrics.acceptanceRate < baselineMetrics.acceptanceRate) reasons.push("Candidate acceptance rate is lower than baseline.");
  if ((candidateMetrics.latencyP95Ms ?? Infinity) > (baselineMetrics.latencyP95Ms ?? -Infinity)) reasons.push("Candidate p95 latency is higher than baseline.");
  const baselineFailures = new Set(pairedBaseline.filter((result) => result.outcome.acceptance !== "accepted").map((result) => result.outcome.failureClass));
  const newFailureClasses = [...new Set(pairedCandidate
    .filter((result) => result.outcome.acceptance !== "accepted" && baselineFailures.has(result.outcome.failureClass) === false)
    .map((result) => result.outcome.failureClass))].sort();
  if (newFailureClasses.length > 0) reasons.push("Candidate introduces a new failure class.");
  const tokenImproved = baselineMetrics.tokensPerAcceptedSuccess !== null && candidateMetrics.tokensPerAcceptedSuccess !== null && candidateMetrics.tokensPerAcceptedSuccess < baselineMetrics.tokensPerAcceptedSuccess;
  const costImproved = baselineMetrics.costPerAcceptedSuccessUsd !== null && candidateMetrics.costPerAcceptedSuccessUsd !== null && candidateMetrics.costPerAcceptedSuccessUsd < baselineMetrics.costPerAcceptedSuccessUsd;
  if (tokenImproved === false && costImproved === false) reasons.push("Candidate does not improve tokens or priced cost per accepted success.");
  const unhashed = {
    version: 1 as const,
    schema: "kestrel.harness-efficiency-paired-comparison/v1" as const,
    comparisonId: randomUUID(),
    recordedAt: new Date().toISOString(),
    pairIds,
    baselineResultIds: pairedBaseline.map((result) => result.resultId),
    candidateResultIds: pairedCandidate.map((result) => result.resultId),
    metrics: { baseline: baselineMetrics, candidate: candidateMetrics },
    newFailureClasses,
    regressedPairIds,
    promotable: reasons.length === 0 && pairIds.length > 0,
    reasons,
  };
  validateComparison(unhashed);
  return { ...unhashed, payloadHash: hashCanonical(unhashed) };
}

export function parseHarnessEfficiencyPairedComparisonV1(value: unknown): HarnessEfficiencyPairedComparisonV1 {
  const comparison = requireRecord(value, "comparison");
  rejectUnknown(comparison, new Set([
    "version", "schema", "comparisonId", "payloadHash", "recordedAt", "pairIds", "baselineResultIds",
    "candidateResultIds", "metrics", "newFailureClasses", "regressedPairIds", "promotable", "reasons",
  ]), "comparison");
  const payloadHash = requireHash(comparison.payloadHash, "comparison.payloadHash");
  const unhashed = { ...comparison };
  delete unhashed.payloadHash;
  if (hashCanonical(unhashed) !== payloadHash) throw new Error("Harness efficiency comparison payload hash does not match.");
  validateComparison(unhashed);
  return { ...unhashed, payloadHash } as HarnessEfficiencyPairedComparisonV1;
}

function aggregate(results: HarnessEfficiencyResultV1[]): HarnessEfficiencyAggregateV1 {
  const accepted = results.filter((result) => result.outcome.acceptance === "accepted").length;
  const totalTokens = results.reduce((total, result) => total + result.economics.totals.inputTokens + result.economics.totals.outputTokens, 0);
  const pricedCostUsd = results.reduce((total, result) => total + result.economics.totals.pricedCostUsd, 0);
  const fullyPriced = results.every((result) => result.economics.totals.unpricedCalls === 0);
  const latencies = results.map((result) => result.durationMs).sort((left, right) => left - right);
  return {
    attempts: results.length,
    accepted,
    acceptanceRate: results.length === 0 ? 0 : accepted / results.length,
    totalTokens,
    tokensPerAcceptedSuccess: accepted === 0 ? null : totalTokens / accepted,
    pricedCostUsd,
    costPerAcceptedSuccessUsd: accepted === 0 || fullyPriced === false ? null : pricedCostUsd / accepted,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
  };
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  return values[Math.max(0, Math.ceil(percentileValue / 100 * values.length) - 1)] ?? null;
}

function uniqueByPair(results: HarnessEfficiencyResultV1[], label: string): Map<string, HarnessEfficiencyResultV1> {
  const map = new Map<string, HarnessEfficiencyResultV1>();
  for (const result of results) {
    if (map.has(result.pairId)) throw new Error(`Duplicate ${label} pairId '${result.pairId}'.`);
    map.set(result.pairId, result);
  }
  return map;
}

function assertFrozenPair(baseline: HarnessEfficiencyResultV1, candidate: HarnessEfficiencyResultV1): void {
  for (const field of ["lane", "dataset", "taskId", "trial"] as const) {
    if (baseline[field] !== candidate[field]) throw new Error(`Pair '${baseline.pairId}' changed frozen field '${field}'.`);
  }
  for (const field of ["protocolHash", "taskInputHash", "benchmarkConfigHash", "modelProvider", "model"] as const) {
    if (baseline.frozen[field] !== candidate.frozen[field]) throw new Error(`Pair '${baseline.pairId}' changed frozen field 'frozen.${field}'.`);
  }
}

function validateResult(value: Record<string, unknown>): void {
  if (value.version !== 1 || value.schema !== "kestrel.harness-efficiency-result/v1") throw new Error("Harness efficiency result version is invalid.");
  for (const field of ["resultId", "pairId", "dataset", "taskId", "attemptId", "recordedAt"] as const) requireString(value[field], field);
  if (value.lane !== "swe_verified" && value.lane !== "terminal_bench") throw new Error("Harness efficiency result lane is invalid.");
  requirePositiveInteger(value.trial, "trial");
  requireNonNegativeInteger(value.durationMs, "durationMs");
  requireIsoTimestamp(value.recordedAt, "recordedAt");
  const frozen = requireRecord(value.frozen, "frozen");
  rejectUnknown(frozen, new Set(["protocolHash", "taskInputHash", "benchmarkConfigHash", "controlVariantHash", "harnessRevision", "modelProvider", "model"]), "frozen");
  for (const field of ["protocolHash", "taskInputHash", "benchmarkConfigHash", "controlVariantHash"] as const) requireHash(frozen[field], `frozen.${field}`);
  for (const field of ["harnessRevision", "modelProvider", "model"] as const) requireString(frozen[field], `frozen.${field}`);
  const runtime = requireRecord(value.runtime, "runtime");
  rejectUnknown(runtime, new Set(["runId", "sessionId", "threadId"]), "runtime");
  for (const field of ["runId", "sessionId", "threadId"] as const) if (runtime[field] !== undefined) requireString(runtime[field], `runtime.${field}`);
  const outcome = requireRecord(value.outcome, "outcome");
  rejectUnknown(outcome, new Set(["evaluatorId", "evaluatorVersion", "independentlyEvaluated", "acceptance", "failureClass"]), "outcome");
  requireString(outcome.evaluatorId, "outcome.evaluatorId");
  requireString(outcome.evaluatorVersion, "outcome.evaluatorVersion");
  requireString(outcome.failureClass, "outcome.failureClass");
  if (typeof outcome.independentlyEvaluated !== "boolean") throw new Error("Harness efficiency outcome independentlyEvaluated must be boolean.");
  if (outcome.acceptance !== "accepted" && outcome.acceptance !== "rejected" && outcome.acceptance !== "not_evaluated") throw new Error("Harness efficiency outcome acceptance is invalid.");
  if ((outcome.acceptance === "not_evaluated") === outcome.independentlyEvaluated) {
    throw new Error("Harness efficiency outcome evaluation state is inconsistent.");
  }
  const economics = requireRecord(value.economics, "economics");
  rejectUnknown(economics, new Set(["status", "missingFields", "totals", "invalidLedgerEvents", "tokensPerAcceptedSuccess", "costPerAcceptedSuccessUsd"]), "economics");
  if (economics.status !== "complete" && economics.status !== "incomplete") throw new Error("Harness efficiency economics status is invalid.");
  const missingFields = requireUniqueStringArray(economics.missingFields, "economics.missingFields");
  const totals = requireEconomicsTotals(economics.totals);
  const invalidLedgerEvents = requireNonNegativeInteger(economics.invalidLedgerEvents, "economics.invalidLedgerEvents");
  if (economics.status === "complete" && (missingFields.length > 0 || invalidLedgerEvents > 0 || totals.calls === 0)) {
    throw new Error("Harness efficiency complete economics must contain model calls with no missing or invalid telemetry.");
  }
  if (economics.status === "incomplete" && missingFields.length === 0 && invalidLedgerEvents === 0) {
    throw new Error("Harness efficiency incomplete economics must identify missing or invalid telemetry.");
  }
  for (const field of ["tokensPerAcceptedSuccess", "costPerAcceptedSuccessUsd"] as const) if (economics[field] !== null) requireNonNegativeNumber(economics[field], `economics.${field}`);
  const accepted = outcome.acceptance === "accepted";
  const complete = economics.status === "complete";
  const expectedTokens = accepted && complete ? totals.inputTokens + totals.outputTokens : null;
  if (economics.tokensPerAcceptedSuccess !== expectedTokens) {
    throw new Error("Harness efficiency tokensPerAcceptedSuccess does not match the independently evaluated outcome and ledger totals.");
  }
  const expectedCost = accepted && complete && totals.unpricedCalls === 0 ? totals.pricedCostUsd : null;
  if (economics.costPerAcceptedSuccessUsd !== expectedCost) {
    throw new Error("Harness efficiency costPerAcceptedSuccessUsd does not match pricing completeness and the independently evaluated outcome.");
  }
  requireArtifacts(value.artifacts);
}

function validateComparison(value: Record<string, unknown>): void {
  if (value.version !== 1 || value.schema !== "kestrel.harness-efficiency-paired-comparison/v1") {
    throw new Error("Harness efficiency comparison version is invalid.");
  }
  requireString(value.comparisonId, "comparison.comparisonId");
  requireIsoTimestamp(value.recordedAt, "comparison.recordedAt");
  const pairIds = requireUniqueStringArray(value.pairIds, "comparison.pairIds");
  const baselineResultIds = requireUniqueStringArray(value.baselineResultIds, "comparison.baselineResultIds");
  const candidateResultIds = requireUniqueStringArray(value.candidateResultIds, "comparison.candidateResultIds");
  requireUniqueStringArray(value.newFailureClasses, "comparison.newFailureClasses");
  const regressedPairIds = requireUniqueStringArray(value.regressedPairIds, "comparison.regressedPairIds");
  requireUniqueStringArray(value.reasons, "comparison.reasons");
  if (baselineResultIds.length !== candidateResultIds.length || baselineResultIds.length > pairIds.length) {
    throw new Error("Harness efficiency comparison result pairing is inconsistent.");
  }
  if (regressedPairIds.some((pairId) => pairIds.includes(pairId) === false)) {
    throw new Error("Harness efficiency comparison regressedPairIds contains an unknown pair.");
  }
  const metrics = requireRecord(value.metrics, "comparison.metrics");
  rejectUnknown(metrics, new Set(["baseline", "candidate"]), "comparison.metrics");
  requireAggregate(metrics.baseline, "comparison.metrics.baseline");
  requireAggregate(metrics.candidate, "comparison.metrics.candidate");
  if (typeof value.promotable !== "boolean") throw new Error("Harness efficiency comparison promotable must be boolean.");
  const reasons = value.reasons as string[];
  if (value.promotable !== (reasons.length === 0 && pairIds.length > 0)) {
    throw new Error("Harness efficiency comparison promotion decision is inconsistent with its reasons.");
  }
}

function requireAggregate(value: unknown, label: string): void {
  const aggregate = requireRecord(value, label);
  rejectUnknown(aggregate, new Set([
    "attempts", "accepted", "acceptanceRate", "totalTokens", "tokensPerAcceptedSuccess", "pricedCostUsd",
    "costPerAcceptedSuccessUsd", "latencyP50Ms", "latencyP95Ms",
  ]), label);
  const attempts = requireNonNegativeInteger(aggregate.attempts, `${label}.attempts`);
  const accepted = requireNonNegativeInteger(aggregate.accepted, `${label}.accepted`);
  if (accepted > attempts) throw new Error(`Harness efficiency ${label}.accepted exceeds attempts.`);
  const acceptanceRate = requireNonNegativeNumber(aggregate.acceptanceRate, `${label}.acceptanceRate`);
  if (acceptanceRate > 1 || acceptanceRate !== (attempts === 0 ? 0 : accepted / attempts)) {
    throw new Error(`Harness efficiency ${label}.acceptanceRate is inconsistent.`);
  }
  requireNonNegativeInteger(aggregate.totalTokens, `${label}.totalTokens`);
  requireNonNegativeNumber(aggregate.pricedCostUsd, `${label}.pricedCostUsd`);
  for (const field of ["tokensPerAcceptedSuccess", "costPerAcceptedSuccessUsd", "latencyP50Ms", "latencyP95Ms"] as const) {
    if (aggregate[field] !== null) requireNonNegativeNumber(aggregate[field], `${label}.${field}`);
  }
}

const ECONOMICS_TOTAL_FIELDS = new Set([
  "calls", "completedCalls", "failedCalls", "attempts", "retries", "inputTokens", "outputTokens",
  "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens", "pricedCostUsd", "unpricedCalls",
  "independentlyAcceptedCalls", "toolResults", "storedToolResultTokens", "modelVisibleToolResultTokens",
  "reducedToolResultTokens",
]);

function requireEconomicsTotals(value: unknown): EconomicsLedgerProjectionV1["totals"] {
  const totals = requireRecord(value, "economics.totals");
  rejectUnknown(totals, ECONOMICS_TOTAL_FIELDS, "economics.totals");
  for (const field of ECONOMICS_TOTAL_FIELDS) {
    if (field === "pricedCostUsd") requireNonNegativeNumber(totals[field], `economics.totals.${field}`);
    else requireNonNegativeInteger(totals[field], `economics.totals.${field}`);
  }
  if ((totals.completedCalls as number) + (totals.failedCalls as number) > (totals.calls as number)) {
    throw new Error("Harness efficiency economics terminal call totals exceed calls.");
  }
  if ((totals.retries as number) > (totals.attempts as number)) {
    throw new Error("Harness efficiency economics retries exceed attempts.");
  }
  if ((totals.unpricedCalls as number) > (totals.completedCalls as number)) {
    throw new Error("Harness efficiency economics unpricedCalls exceed completedCalls.");
  }
  if ((totals.independentlyAcceptedCalls as number) > (totals.calls as number)) {
    throw new Error("Harness efficiency economics independentlyAcceptedCalls exceed calls.");
  }
  if ((totals.reducedToolResultTokens as number) > (totals.storedToolResultTokens as number)) {
    throw new Error("Harness efficiency economics reduced tool-result tokens exceed stored tokens.");
  }
  return totals as unknown as EconomicsLedgerProjectionV1["totals"];
}

function requireArtifacts(value: unknown): void {
  if (Array.isArray(value) === false) throw new Error("Harness efficiency artifacts must be an array.");
  const identities = new Set<string>();
  value.forEach((entry, index) => {
    const artifact = requireRecord(entry, `artifacts[${index}]`);
    rejectUnknown(artifact, new Set(["kind", "path", "sha256"]), `artifacts[${index}]`);
    const kind = requireString(artifact.kind, `artifacts[${index}].kind`);
    const artifactPath = requireString(artifact.path, `artifacts[${index}].path`);
    if (artifact.sha256 !== undefined) requireHash(artifact.sha256, `artifacts[${index}].sha256`);
    const identity = `${kind}\u0000${artifactPath}`;
    if (identities.has(identity)) throw new Error(`Harness efficiency duplicate artifact '${kind}' at '${artifactPath}'.`);
    identities.add(identity);
  });
}

export function hashHarnessEfficiencyValue(value: unknown): string {
  return hashCanonical(value);
}

export function readHarnessEfficiencyEconomicsFromReplayBundle(
  value: unknown,
  acceptance: HarnessEfficiencyAcceptance,
): HarnessEfficiencyResultV1["economics"] {
  const bundle = typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
  const replay = bundle === undefined ? undefined : optionalRecord(bundle.replay);
  const events = Array.isArray(replay?.events) ? replay.events.filter(isRunEvent) : [];
  const projection = projectEconomicsLedger(events);
  const missingFields: string[] = [];
  if (bundle?.version !== "runtime_replay_bundle_v1") missingFields.push("runtimeReplayBundle");
  if (events.length === 0) missingFields.push("runEvents");
  if (projection.totals.calls === 0) missingFields.push("modelCalls");
  if (projection.calls.some((call) => call.request === undefined)) missingFields.push("modelCallRequest");
  if (projection.calls.some((call) => call.completion === undefined && call.failure === undefined)) missingFields.push("modelCallTerminal");
  if (projection.invalidEvents.length > 0) missingFields.push("validEconomicsLedger");
  return economicsFromProjection(projection, acceptance, missingFields);
}

export function readHarnessEfficiencyEconomicsFromLedger(
  value: unknown,
): HarnessEfficiencyResultV1["economics"] {
  const ledger = parseHarnessEfficiencyLedgerV1(value);
  const projection = projectEconomicsLedger(ledger.events);
  const outcome = projection.runOutcomes[0]?.event;
  const missingFields: string[] = [];
  if (projection.totals.calls === 0) missingFields.push("modelCalls");
  if (projection.calls.some((call) => call.request === undefined)) missingFields.push("modelCallRequest");
  if (projection.calls.some((call) => call.completion === undefined && call.failure === undefined)) missingFields.push("modelCallTerminal");
  if (projection.invalidEvents.length > 0) missingFields.push("validEconomicsLedger");
  if (outcome === undefined) missingFields.push("independentRunOutcome");
  return economicsFromProjection(projection, outcome?.acceptance ?? "not_evaluated", missingFields);
}

export function emptyHarnessEfficiencyEconomics(
  missingFields: string[],
): HarnessEfficiencyResultV1["economics"] {
  return {
    status: "incomplete",
    missingFields: [...new Set(missingFields)],
    totals: {
      calls: 0,
      completedCalls: 0,
      failedCalls: 0,
      attempts: 0,
      retries: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
      pricedCostUsd: 0,
      unpricedCalls: 0,
      independentlyAcceptedCalls: 0,
      toolResults: 0,
      storedToolResultTokens: 0,
      modelVisibleToolResultTokens: 0,
      reducedToolResultTokens: 0,
    },
    invalidLedgerEvents: 0,
    tokensPerAcceptedSuccess: null,
    costPerAcceptedSuccessUsd: null,
  };
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function validateEfficiencyLedger(value: Record<string, unknown>): void {
  if (value.version !== 1 || value.schema !== "kestrel.harness-efficiency-ledger/v1") {
    throw new Error("Harness efficiency ledger version is invalid.");
  }
  requireHash(value.sourceReplayHash, "ledger.sourceReplayHash");
  const runId = requireString(value.runId, "ledger.runId");
  const sessionId = requireString(value.sessionId, "ledger.sessionId");
  const recordedAt = requireIsoTimestamp(value.recordedAt, "ledger.recordedAt");
  if (Array.isArray(value.events) === false || value.events.length === 0) {
    throw new Error("Harness efficiency ledger events must be a non-empty array.");
  }
  const events = value.events.map((event, index) => {
    if (isRunEvent(event) === false) throw new Error(`Harness efficiency ledger events[${index}] is invalid.`);
    if (event.runId !== runId || event.sessionId !== sessionId) {
      throw new Error(`Harness efficiency ledger events[${index}] does not match the ledger run and session.`);
    }
    if (parseEconomicsLedgerEvent(event) === undefined) {
      throw new Error(`Harness efficiency ledger events[${index}] is not an economics event.`);
    }
    return event;
  });
  const projection = projectEconomicsLedger(events);
  if (projection.invalidEvents.length > 0) {
    throw new Error(`Harness efficiency ledger contains invalid events: ${projection.invalidEvents[0]?.reason ?? "unknown"}`);
  }
  if (projection.runOutcomes.length !== 1) {
    throw new Error("Harness efficiency ledger must contain exactly one independent run outcome.");
  }
  if (projection.runOutcomes[0]?.recordedAt !== recordedAt) {
    throw new Error("Harness efficiency ledger recordedAt must match its independent run outcome.");
  }
}

function readReplayEvents(value: unknown): RunEvent[] {
  const bundle = optionalRecord(value);
  const replay = optionalRecord(bundle?.replay);
  return Array.isArray(replay?.events) ? replay.events.filter(isRunEvent) : [];
}

function economicsFromProjection(
  projection: EconomicsLedgerProjectionV1,
  acceptance: HarnessEfficiencyAcceptance,
  missingFields: string[],
): HarnessEfficiencyResultV1["economics"] {
  const complete = missingFields.length === 0;
  const accepted = acceptance === "accepted";
  const totalTokens = projection.totals.inputTokens + projection.totals.outputTokens;
  return {
    status: complete ? "complete" : "incomplete",
    missingFields: [...new Set(missingFields)],
    totals: projection.totals,
    invalidLedgerEvents: projection.invalidEvents.length,
    tokensPerAcceptedSuccess: complete && accepted ? totalTokens : null,
    costPerAcceptedSuccessUsd:
      complete && accepted && projection.totals.unpricedCalls === 0
        ? projection.totals.pricedCostUsd
        : null,
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortValue(record[key])]));
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function isRunEvent(value: unknown): value is RunEvent {
  const record = optionalRecord(value);
  return record !== undefined &&
    typeof record.runId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.type === "string" &&
    typeof record.level === "string" &&
    typeof record.timestamp === "string";
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Harness efficiency ${field} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((field) => fields.has(field) === false);
  if (unknown !== undefined) throw new Error(`Harness efficiency ${label} contains unknown field '${unknown}'.`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Harness efficiency ${field} must be a non-empty string.`);
  return value;
}

function requireHash(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (/^[a-f0-9]{64}$/u.test(parsed) === false) throw new Error(`Harness efficiency ${field} must be a SHA-256 digest.`);
  return parsed;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isSafeInteger(value) === false || value <= 0) throw new Error(`Harness efficiency ${field} must be a positive integer.`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isSafeInteger(value) === false || value < 0) throw new Error(`Harness efficiency ${field} must be a non-negative safe integer.`);
  return value;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isFinite(value) === false || value < 0) throw new Error(`Harness efficiency ${field} must be non-negative.`);
  return value;
}

function requireUniqueStringArray(value: unknown, field: string): string[] {
  if (Array.isArray(value) === false || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`Harness efficiency ${field} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`Harness efficiency ${field} must not contain duplicates.`);
  return value as string[];
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`Harness efficiency ${field} must be an ISO timestamp.`);
  return parsed;
}
