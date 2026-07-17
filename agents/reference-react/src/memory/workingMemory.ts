import { createHash } from "node:crypto";

import type { MemorySnapshot } from "../../../../src/kestrel/contracts/events.js";
import { readActiveTaskGoalFromTranscript } from "../../../../src/runtime/modelTranscript.js";

import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
import type {
  DecisionVerification,
  EvidencePack,
  MemoryRecallEntry,
  ReadOnlyResultDuplicateLedgerEntry,
  ToolOutcomeCacheEntry,
} from "../types.js";

const MAX_RECALL_ITEMS = 8;
const MAX_EPISODIC_ITEMS = 12;
const MAX_SEMANTIC_ITEMS = 16;
const MAX_TOOL_CACHE_ITEMS = 16;
const MAX_DUPLICATE_LEDGER_ITEMS = 24;
const MAX_SUMMARY_CHARS = 240;

export function buildMemoryRecall(input: {
  memory: MemorySnapshot | undefined;
  reactState: Record<string, unknown>;
}): MemoryRecallEntry[] {
  const memoryWorking = asRecord(input.memory?.working) ?? {};
  const recalls: MemoryRecallEntry[] = [];

  const workingGoal = readActiveTaskGoalFromTranscript(input.reactState.modelTranscript);
  if (workingGoal !== undefined && workingGoal.trim().length > 0) {
    recalls.push({
      kind: "working",
      key: "goal",
      summary: clampSummary(workingGoal),
      freshness: "current",
    });
  }

  for (const entry of readMemoryEntries(memoryWorking.episodicMemories, "episodic")) {
    recalls.push(entry);
  }
  for (const entry of readMemoryEntries(memoryWorking.semanticMemories, "semantic")) {
    recalls.push(entry);
  }

  return recalls.slice(0, MAX_RECALL_ITEMS);
}

export function buildEvidencePack(input: {
  reactState: Record<string, unknown>;
  memory: MemorySnapshot | undefined;
  verification?: DecisionVerification | undefined;
}): EvidencePack {
  const facts = new Set<string>();
  const toolOutcomes: EvidencePack["toolOutcomes"] = [];
  const nextBestEvidence = new Set<string>();

  const planIntent = asString(asRecord(input.reactState.plan)?.intent);
  if (planIntent !== undefined) {
    facts.add(`Plan intent: ${clampSummary(planIntent)}`);
  }

  const observationSummary = asString(asRecord(lastObservation(input.reactState))?.summary);
  if (observationSummary !== undefined) {
    facts.add(`Observation: ${clampSummary(observationSummary)}`);
  }

  const capabilityEvidence = capabilityEvidenceFromAgentFeedback(input.reactState);
  const capabilityKeys = Object.keys(capabilityEvidence).filter((key) => key.trim().length > 0);
  if (capabilityKeys.length > 0) {
    facts.add(`Capabilities observed: ${capabilityKeys.join(", ")}`);
  }

  for (const entry of readToolOutcomeCache(input.memory)) {
    toolOutcomes.push({
      toolName: entry.toolName,
      status: entry.status,
      summary: entry.summary,
    });
  }

  const missingCapabilities = input.verification?.missingCapabilities ?? [];
  for (const capability of missingCapabilities) {
    nextBestEvidence.add(`Acquire evidence for capability '${capability}'`);
  }
  if (toolOutcomes.length === 0) {
    nextBestEvidence.add("Collect at least one concrete tool result before finalizing");
  }

  return {
    facts: [...facts].slice(0, 6),
    toolOutcomes: toolOutcomes.slice(0, 5),
    missingCapabilities,
    nextBestEvidence: [...nextBestEvidence].slice(0, 4),
  };
}

export function readToolOutcomeCache(memory: MemorySnapshot | undefined): ToolOutcomeCacheEntry[] {
  const working = asRecord(memory?.working) ?? {};
  return asArray(working.toolOutcomeCache)
    .map((item) => normalizeToolOutcomeCacheEntry(item))
    .filter((item): item is ToolOutcomeCacheEntry => item !== undefined)
    .slice(0, MAX_TOOL_CACHE_ITEMS);
}

export function readReadOnlyResultDuplicateLedger(
  memory: MemorySnapshot | undefined,
): ReadOnlyResultDuplicateLedgerEntry[] {
  const working = asRecord(memory?.working) ?? {};
  return asArray(working.readOnlyResultDuplicateLedger)
    .map((item) => normalizeDuplicateLedgerEntry(item))
    .filter((item): item is ReadOnlyResultDuplicateLedgerEntry => item !== undefined)
    .slice(0, MAX_DUPLICATE_LEDGER_ITEMS);
}

export function findReusableToolOutcome(input: {
  memory: MemorySnapshot | undefined;
  reactState: Record<string, unknown>;
  toolName: string;
  toolInput: Record<string, unknown>;
}): ToolOutcomeCacheEntry | undefined {
  if (isReusableToolOutcomeDisabled(input.toolName)) {
    return ;
  }
  const inputHash = hashToolInput(input.toolName, input.toolInput);
  const lastAction = asRecord(input.reactState.lastActionResult);
  const lastActionName = asString(lastAction?.name);
  const lastActionOutput = lastAction?.output;
  const lastActionInputHash = asString(lastAction?.inputHash);
  if (lastActionName === input.toolName && lastActionInputHash === inputHash) {
      return {
        toolName: input.toolName,
        inputHash,
        status: normalizeToolStatus(lastActionOutput),
        summary: clampSummary(summarizeToolOutput(lastActionOutput)),
        stepIndex: readStepIndex(lastAction) ?? -1,
        reusable: normalizeToolStatus(lastActionOutput) === "success",
        capabilityClasses: Object.keys(capabilityEvidenceFromAgentFeedback(input.reactState)),
        output: lastActionOutput,
        updatedAt: new Date().toISOString(),
      };
    }

  return readToolOutcomeCache(input.memory).find(
    (entry) => entry.toolName === input.toolName && entry.inputHash === inputHash && entry.reusable,
  );
}

export function hashToolInput(toolName: string, toolInput: unknown): string {
  return createHash("sha256")
    .update(`${toolName}:${stableStringify(toolInput)}`)
    .digest("hex")
    .slice(0, 16);
}

function buildToolOutcomeEntry(input: {
  action: unknown;
  lastActionResult: unknown;
  stepIndex: number;
  timestamp: string;
  capabilityEvidence: unknown;
}): ToolOutcomeCacheEntry | undefined {
  const action = asRecord(input.action);
  const result = asRecord(input.lastActionResult);
  if (asString(action?.kind) !== "tool" || asString(result?.kind) !== "tool") {
    return ;
  }
  const toolName = asString(action?.name);
  const toolInput = asRecord(action?.input);
  if (toolName === undefined || toolInput === undefined) {
    return ;
  }
  if (isReusableToolOutcomeDisabled(toolName)) {
    return ;
  }
  const output = result?.output;
  const status = normalizeToolStatus(output);
  return {
    toolName,
    inputHash: hashToolInput(toolName, toolInput),
    status,
    summary: clampSummary(summarizeToolOutput(output)),
    stepIndex: input.stepIndex,
    reusable: status === "success",
    capabilityClasses: Object.keys(asRecord(input.capabilityEvidence) ?? {}),
    output,
    updatedAt: input.timestamp,
  };
}

function isReusableToolOutcomeDisabled(toolName: string): boolean {
  return toolName.startsWith("fs.") || toolName.startsWith("dev.shell.");
}

function normalizeToolOutcomeCacheEntry(value: unknown): ToolOutcomeCacheEntry | undefined {
  const record = asRecord(value);
  const toolName = asString(record?.toolName);
  const inputHash = asString(record?.inputHash);
  const summary = asString(record?.summary);
  const status = asString(record?.status);
  const updatedAt = asString(record?.updatedAt);
  const stepIndex = typeof record?.stepIndex === "number" ? record.stepIndex : undefined;
  if (
    toolName === undefined ||
    inputHash === undefined ||
    summary === undefined ||
    updatedAt === undefined ||
    stepIndex === undefined ||
    (status !== "success" && status !== "error" && status !== "blocked")
  ) {
    return ;
  }
  return {
    toolName,
    inputHash,
    summary,
    status,
    stepIndex,
    reusable: record?.reusable === true,
    capabilityClasses: asArray(record?.capabilityClasses)
      .map((item) => asString(item))
      .filter((item): item is string => item !== undefined),
    ...(record?.output !== undefined ? { output: record.output } : {}),
    updatedAt,
  };
}

function buildDuplicateLedgerEntry(input: {
  reactState: Record<string, unknown>;
  stepIndex: number;
  timestamp: string;
}): ReadOnlyResultDuplicateLedgerEntry | undefined {
  const duplicate = asRecord(asRecord(input.reactState.postToolVerification)?.duplicateResult);
  const fingerprint = asString(duplicate?.fingerprint);
  const toolName = asString(duplicate?.toolName);
  const family = duplicate?.family;
  const duplicateCount = readPositiveInt(duplicate?.duplicateCount);
  if (
    fingerprint === undefined ||
    toolName === undefined ||
    duplicateCount === undefined ||
    (family !== "web_search_results" &&
      family !== "web_page_content" &&
      family !== "source_search_results" &&
      family !== "source_page_content")
  ) {
    return ;
  }
  const matchedPriorStep = readPositiveInt(duplicate?.matchedPriorStep);
  return {
    fingerprint,
    family,
    toolName,
    ...(asString(duplicate?.canonicalSource) !== undefined
      ? { canonicalSource: asString(duplicate?.canonicalSource) }
      : {}),
    ...(asString(duplicate?.canonicalUrl) !== undefined
      ? { canonicalUrl: asString(duplicate?.canonicalUrl) }
      : {}),
    count: duplicateCount,
    firstSeenStep: matchedPriorStep ?? input.stepIndex,
    lastSeenStep: input.stepIndex,
    ...(matchedPriorStep !== undefined ? { matchedPriorStep } : {}),
    updatedAt: input.timestamp,
  };
}

function normalizeDuplicateLedgerEntry(value: unknown): ReadOnlyResultDuplicateLedgerEntry | undefined {
  const record = asRecord(value);
  const fingerprint = asString(record?.fingerprint);
  const toolName = asString(record?.toolName);
  const family = record?.family;
  const updatedAt = asString(record?.updatedAt);
  const count = readPositiveInt(record?.count);
  const firstSeenStep = readPositiveInt(record?.firstSeenStep);
  const lastSeenStep = readPositiveInt(record?.lastSeenStep);
  if (
    fingerprint === undefined ||
    toolName === undefined ||
    updatedAt === undefined ||
    count === undefined ||
    firstSeenStep === undefined ||
    lastSeenStep === undefined ||
    (family !== "web_search_results" &&
      family !== "web_page_content" &&
      family !== "source_search_results" &&
      family !== "source_page_content")
  ) {
    return ;
  }
  const matchedPriorStep = readPositiveInt(record?.matchedPriorStep);
  return {
    fingerprint,
    family,
    toolName,
    ...(asString(record?.canonicalSource) !== undefined
      ? { canonicalSource: asString(record?.canonicalSource) }
      : {}),
    ...(asString(record?.canonicalUrl) !== undefined ? { canonicalUrl: asString(record?.canonicalUrl) } : {}),
    count,
    firstSeenStep,
    lastSeenStep,
    ...(matchedPriorStep !== undefined ? { matchedPriorStep } : {}),
    updatedAt,
  };
}

function normalizeMemoryRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  const key = asString(record.key);
  const summary = asString(record.summary);
  if (key === undefined || summary === undefined) {
    return ;
  }
  return record;
}

function readMemoryEntries(
  value: unknown,
  kind: MemoryRecallEntry["kind"],
): MemoryRecallEntry[] {
  return asArray(value)
    .map((item) => normalizeMemoryRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((entry) => ({
      kind,
      key: asString(entry.key) ?? "unknown",
      summary: clampSummary(asString(entry.summary) ?? "No summary"),
      ...(asString(entry.freshness) !== undefined
        ? { freshness: asString(entry.freshness) as MemoryRecallEntry["freshness"] }
        : {}),
      metadata: entry,
    }));
}

function lastObservation(reactState: Record<string, unknown>): unknown {
  const observations = asArray(reactState.observations);
  return observations.length > 0 ? observations[observations.length - 1] : undefined;
}

function dedupeByKey(values: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const entry of values) {
    const key = asString(entry.key);
    if (key === undefined || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function dedupeToolCache(values: ToolOutcomeCacheEntry[]): ToolOutcomeCacheEntry[] {
  const seen = new Set<string>();
  const result: ToolOutcomeCacheEntry[] = [];
  for (const entry of values) {
    const key = `${entry.toolName}:${entry.inputHash}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function dedupeDuplicateLedger(
  values: ReadOnlyResultDuplicateLedgerEntry[],
): ReadOnlyResultDuplicateLedgerEntry[] {
  const seen = new Map<string, ReadOnlyResultDuplicateLedgerEntry>();
  for (const entry of values) {
    const existing = seen.get(entry.fingerprint);
    if (existing === undefined) {
      seen.set(entry.fingerprint, entry);
      continue;
    }
    seen.set(entry.fingerprint, {
      ...existing,
      ...entry,
      count: Math.max(existing.count, entry.count),
      firstSeenStep: Math.min(existing.firstSeenStep, entry.firstSeenStep),
      lastSeenStep: Math.max(existing.lastSeenStep, entry.lastSeenStep),
      matchedPriorStep:
        entry.matchedPriorStep !== undefined ? entry.matchedPriorStep : existing.matchedPriorStep,
      updatedAt: entry.updatedAt.localeCompare(existing.updatedAt) >= 0 ? entry.updatedAt : existing.updatedAt,
    });
  }
  return [...seen.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function summarizeToolOutput(value: unknown): string {
  const record = asRecord(value);
  const summary = asString(record?.summary);
  if (summary !== undefined && summary.trim().length > 0) {
    return summary;
  }
  const message = asString(asRecord(record?.error)?.message);
  if (message !== undefined) {
    return message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeToolStatus(output: unknown): "success" | "error" | "blocked" {
  const record = asRecord(output);
  const status = asString(record?.status);
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "error" || asRecord(record?.error) !== undefined) {
    return "error";
  }
  return "success";
}

function readStepIndex(value: Record<string, unknown> | undefined): number | undefined {
  return typeof value?.stepIndex === "number" ? value.stepIndex : undefined;
}

function capabilityEvidenceFromAgentFeedback(
  reactState: Record<string, unknown>,
): Record<string, { tool: string; stepIndex: number; ts: string }> {
  const snapshot: Record<string, { tool: string; stepIndex: number; ts: string }> = {};
  const ingest = (record: Record<string, unknown> | undefined): void => {
    if (record === undefined) {
      return;
    }
    const tool = asString(record.toolName) ?? asString(record.name);
    if (tool === undefined) {
      return;
    }
    const stepIndex = typeof record.stepIndex === "number" ? record.stepIndex : 0;
    const ts = asString(record.ts) ?? new Date(0).toISOString();
    for (const item of asArray(record.capabilityClasses)) {
      const capability = asString(item)?.trim();
      if (capability === undefined || capability.length === 0 || snapshot[capability] !== undefined) {
        continue;
      }
      snapshot[capability] = { tool, stepIndex, ts };
    }
  };
  for (const observation of asArray(reactState.observations)) {
    ingest(asRecord(observation));
  }
  const lastActionResult = asRecord(reactState.lastActionResult);
  ingest(lastActionResult);
  for (const item of asArray(lastActionResult?.items)) {
    ingest(asRecord(item));
  }
  return snapshot;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function clampSummary(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_SUMMARY_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SUMMARY_CHARS - 3)}...`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}
