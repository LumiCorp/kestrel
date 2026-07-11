import { createHash } from "node:crypto";

import { isLowValueInternetResultUrl } from "../shared/internetResultHygiene.js";
import { canonicalizeDuplicateUrl } from "./readOnlyResultDuplicates.js";
import { readWebExtractionDiagnostics } from "./webExtraction.js";
import {
  isBroadResumeBudgetExhausted,
} from "./filesystemResumeBudget.js";

type EvidenceQuality = "high" | "medium" | "low";
export type EvidenceRecoveryFamily = "web_research" | "filesystem_retrieval" | "source_retrieval";
type EvidenceRecoveryIssue =
  | "insufficient_results"
  | "low_domain_diversity"
  | "low_signal_mix"
  | "repeated_payload";

const MAX_DIAGNOSTIC_CANDIDATE_URLS = 12;

export interface RetainedEvidenceCandidate {
  url: string;
  title?: string | undefined;
  publisher?: string | undefined;
  category?: string | undefined;
  summary?: string | undefined;
  toolName: string;
  updatedAt?: string | undefined;
}

export interface FilesystemInspectionSummary {
  inventoryActions: number;
  groundedReadActions: number;
  budgetExhausted: boolean;
  inventoryPaths?: string[] | undefined;
}

export interface EvidenceRecoveryDiagnostics {
  family: EvidenceRecoveryFamily;
  toolName: string;
  quality: EvidenceQuality;
  lowSignal: boolean;
  issues: EvidenceRecoveryIssue[];
  resultsCount: number;
  domainDiversity: number;
  payloadFingerprint: string;
  repeatedFingerprintCount: number;
  candidateUrls: string[];
  duplicateKind?: "fresh_result" | "duplicate_cached_result" | "duplicate_executed_result" | undefined;
  duplicateCount?: number | undefined;
  matchedPriorStep?: number | undefined;
  canonicalSource?: string | undefined;
}

export interface EvidenceRecoveryDuplicateVerdict {
  kind: "fresh_result" | "duplicate_cached_result" | "duplicate_executed_result";
  family:
    | "web_search_results"
    | "web_page_content"
    | "source_search_results"
    | "source_page_content";
  toolName: string;
  fingerprint: string;
  duplicateCount: number;
  matchedPriorStep?: number | undefined;
  canonicalSource?: string | undefined;
  canonicalUrl?: string | undefined;
}

export interface EvidenceRecoverySummary {
  objectiveKey: string;
  family: EvidenceRecoveryFamily;
  latest?: EvidenceRecoveryDiagnostics | undefined;
  attempts: number;
  lowSignalAttempts: number;
  consecutiveLowSignal: number;
  broadenedSearchUsed: boolean;
  targetedFetchUsed: boolean;
  duplicateEvents: number;
  latestDuplicate?: EvidenceRecoveryDuplicateVerdict | undefined;
  filesystemInspection?: FilesystemInspectionSummary | undefined;
  retainedCandidates?: RetainedEvidenceCandidate[] | undefined;
  latestNewCandidateCount?: number | undefined;
}

export function normalizeEvidenceRecoverySummary(
  value: unknown,
): EvidenceRecoverySummary | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const objectiveKey = asString(record.objectiveKey);
  const family = readFamily(record.family);
  if (objectiveKey === undefined || family === undefined) {
    return undefined;
  }
  return {
    objectiveKey,
    family,
    ...(normalizeDiagnostics(record.latest) !== undefined
      ? { latest: normalizeDiagnostics(record.latest) }
      : {}),
    attempts: readNonNegativeNumber(record.attempts),
    lowSignalAttempts: readNonNegativeNumber(record.lowSignalAttempts),
    consecutiveLowSignal: readNonNegativeNumber(record.consecutiveLowSignal),
    broadenedSearchUsed: record.broadenedSearchUsed === true,
    targetedFetchUsed: record.targetedFetchUsed === true,
    duplicateEvents: readNonNegativeNumber(record.duplicateEvents),
    ...(normalizeDuplicateVerdict(record.latestDuplicate) !== undefined
      ? { latestDuplicate: normalizeDuplicateVerdict(record.latestDuplicate) }
      : {}),
    ...(normalizeFilesystemInspection(record.filesystemInspection) !== undefined
      ? { filesystemInspection: normalizeFilesystemInspection(record.filesystemInspection) }
      : {}),
    ...(normalizeRetainedCandidates(record.retainedCandidates) !== undefined
      ? { retainedCandidates: normalizeRetainedCandidates(record.retainedCandidates) }
      : {}),
    ...(readNonNegativeNumber(record.latestNewCandidateCount) !== undefined
      ? { latestNewCandidateCount: readNonNegativeNumber(record.latestNewCandidateCount) }
      : {}),
  };
}

export function updateEvidenceRecoverySummary(input: {
  prior: unknown;
  objective: string | undefined;
  toolName?: string | undefined;
  output: unknown;
  action?: unknown;
}): EvidenceRecoverySummary | undefined {
  const objectiveKey = normalizeObjectiveKey(input.objective);
  if (objectiveKey === undefined) {
    return undefined;
  }
  const toolName = input.toolName ?? readPrimaryToolName(input.output);
  const family = inferEvidenceRecoveryFamily(toolName) ?? normalizeEvidenceRecoverySummary(input.prior)?.family ?? "web_research";
  const priorNormalized = normalizeEvidenceRecoverySummary(input.prior);
  const prior =
    priorNormalized !== undefined && priorNormalized.family === family
      ? priorNormalized
      : seedEvidenceRecoverySummary(objectiveKey, family);
  if (family === "filesystem_retrieval" && isFilesystemMutationTool(toolName)) {
    return {
      objectiveKey,
      family,
      attempts: prior.attempts,
      lowSignalAttempts: 0,
      consecutiveLowSignal: 0,
      broadenedSearchUsed: false,
      targetedFetchUsed: false,
      duplicateEvents: 0,
      ...(prior.retainedCandidates !== undefined ? { retainedCandidates: prior.retainedCandidates } : {}),
      ...(prior.latestNewCandidateCount !== undefined ? { latestNewCandidateCount: prior.latestNewCandidateCount } : {}),
    };
  }
  if (family === "filesystem_retrieval") {
    const filesystemInspection = updateFilesystemInspectionSummary({
      prior: prior.filesystemInspection,
      toolName,
      output: input.output,
      action: input.action,
    });
    if (filesystemInspection !== undefined) {
      return {
        objectiveKey,
        family,
        attempts: prior.attempts + 1,
        lowSignalAttempts: 0,
        consecutiveLowSignal: 0,
        broadenedSearchUsed: false,
        targetedFetchUsed: false,
        duplicateEvents: 0,
        filesystemInspection,
        ...(prior.retainedCandidates !== undefined ? { retainedCandidates: prior.retainedCandidates } : {}),
        ...(prior.latestNewCandidateCount !== undefined ? { latestNewCandidateCount: prior.latestNewCandidateCount } : {}),
      };
    }
  }
  const stage = readRecoveryStage(input.output) ?? readRecoveryStage(input.action);
  const withStage = {
    ...prior,
    objectiveKey,
    broadenedSearchUsed:
      prior.broadenedSearchUsed || stage === "broaden_search",
    targetedFetchUsed:
      prior.targetedFetchUsed || stage === "target_article_fetch",
  };

  const diagnostics = readWebResearchDiagnostics({
    prior: withStage,
    objective: input.objective,
    toolName,
    output: input.output,
    action: input.action,
  });
  if (diagnostics !== undefined) {
    const reset = diagnostics.lowSignal === false;
    const latestDuplicate = diagnostics.duplicateKind !== undefined
      ? {
          kind: diagnostics.duplicateKind,
          family:
            diagnostics.family === "source_retrieval"
              ? inferEvidenceRecoveryDuplicateFamily(diagnostics.toolName) ?? "source_search_results"
              : inferWebRecoveryDuplicateFamily(diagnostics.toolName) ?? "web_search_results",
          toolName: diagnostics.toolName,
          fingerprint: diagnostics.payloadFingerprint,
          duplicateCount: diagnostics.duplicateCount ?? diagnostics.repeatedFingerprintCount,
          ...(diagnostics.matchedPriorStep !== undefined
            ? { matchedPriorStep: diagnostics.matchedPriorStep }
            : {}),
          ...(diagnostics.canonicalSource !== undefined
            ? { canonicalSource: diagnostics.canonicalSource }
            : {}),
          ...(diagnostics.candidateUrls[0] !== undefined
            ? { canonicalUrl: diagnostics.candidateUrls[0] }
            : {}),
        }
      : undefined;
    const retainedSourceProgress = mergeRetainedCandidates({
      prior: withStage.retainedCandidates,
      results: readResultItems(asRecord(input.output) ?? {}),
      toolName: diagnostics.toolName,
      updatedAt: readToolUpdateTimestamp(input.output),
    });
    return {
      objectiveKey,
      family: diagnostics.family,
      latest: diagnostics,
      attempts: withStage.attempts + 1,
      lowSignalAttempts: reset ? 0 : withStage.lowSignalAttempts + 1,
      consecutiveLowSignal: reset ? 0 : withStage.consecutiveLowSignal + 1,
      broadenedSearchUsed: reset ? false : withStage.broadenedSearchUsed,
      targetedFetchUsed: reset ? false : withStage.targetedFetchUsed,
      duplicateEvents:
        latestDuplicate !== undefined ? withStage.duplicateEvents + 1 : withStage.duplicateEvents,
      ...(latestDuplicate !== undefined ? { latestDuplicate } : {}),
      ...(retainedSourceProgress.candidates.length > 0 ? { retainedCandidates: retainedSourceProgress.candidates } : {}),
      latestNewCandidateCount: retainedSourceProgress.latestNewCandidateCount,
    };
  }

  const batchSignals = readBatchExtractionSignals(input.output);
  if (batchSignals.hasHighYield === true) {
    return {
      objectiveKey,
      family: withStage.family,
      attempts: withStage.attempts,
      lowSignalAttempts: 0,
      consecutiveLowSignal: 0,
      broadenedSearchUsed: false,
      targetedFetchUsed: false,
      duplicateEvents: 0,
      ...(withStage.retainedCandidates !== undefined ? { retainedCandidates: withStage.retainedCandidates } : {}),
      ...(withStage.latestNewCandidateCount !== undefined ? { latestNewCandidateCount: withStage.latestNewCandidateCount } : {}),
    };
  }
  if (stage !== undefined || batchSignals.hasLowYield === true) {
    return withStage;
  }

  return prior.objectiveKey === objectiveKey ? prior : withStage;
}

function seedEvidenceRecoverySummary(
  objectiveKey: string,
  family: EvidenceRecoveryFamily,
): EvidenceRecoverySummary {
  return {
    objectiveKey,
    family,
    attempts: 0,
    lowSignalAttempts: 0,
    consecutiveLowSignal: 0,
    broadenedSearchUsed: false,
    targetedFetchUsed: false,
    duplicateEvents: 0,
  };
}

function readWebResearchDiagnostics(input: {
  prior: EvidenceRecoverySummary;
  objective: string | undefined;
  toolName?: string | undefined;
  output: unknown;
  action?: unknown;
}): EvidenceRecoveryDiagnostics | undefined {
  const toolName = input.toolName ?? readPrimaryToolName(input.output);
  const family = inferEvidenceRecoveryFamily(toolName);
  const duplicateVerdict = readDuplicateVerdict(input.output);
  if (toolName === undefined || family === undefined || family === "filesystem_retrieval") {
    return undefined;
  }
  if (toolName === "internet.extract" || toolName === "source.fetch") {
    return readPageDuplicateDiagnostics({
      toolName,
      output: input.output,
      family,
    });
  }
  if (
    toolName !== "internet.news" &&
    toolName !== "internet.search" &&
    toolName !== "internet.search_advanced" &&
    toolName !== "internet.research" &&
    toolName !== "source.search" &&
    toolName !== "source.triage"
  ) {
    return undefined;
  }
  if (
    toolName === "internet.search" &&
    duplicateVerdict === undefined &&
    isNewsResearchSearchAttempt({
      prior: input.prior,
      objective: input.objective,
      output: input.output,
    }) === false
  ) {
    return undefined;
  }

  const record = asRecord(input.output);
  if (record === undefined) {
    return undefined;
  }
  const results = readResultItems(record);
  const explicitlySourceConstrained = hasExplicitStructuredSourceConstraint({
    toolName,
    output: input.output,
    action: input.action,
  });
  const distinctDomains = new Set<string>();
  const candidateUrls: string[] = [];
  let lowSignalCount = 0;
  const fingerprintSeed: Array<Record<string, string>> = [];

  for (const item of results) {
    const source = normalizeDomain(item);
    if (source !== undefined) {
      distinctDomains.add(source);
    }
    if (isLowSignalItem(item)) {
      lowSignalCount += 1;
    } else if (
      typeof item.url === "string" &&
      item.url.trim().length > 0 &&
      candidateUrls.includes(item.url.trim()) === false &&
      candidateUrls.length < MAX_DIAGNOSTIC_CANDIDATE_URLS
    ) {
      candidateUrls.push(item.url.trim());
    }
    fingerprintSeed.push({
      title: item.title ?? "",
      url: item.url ?? "",
      source: item.source ?? source ?? "",
    });
  }

  if (candidateUrls.length === 0) {
    for (const item of results) {
      if (typeof item.url !== "string" || item.url.trim().length === 0) {
        continue;
      }
      const url = item.url.trim();
      if (candidateUrls.includes(url)) {
        continue;
      }
      candidateUrls.push(url);
      if (candidateUrls.length >= MAX_DIAGNOSTIC_CANDIDATE_URLS) {
        break;
      }
    }
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify(fingerprintSeed.slice(0, 8)))
    .digest("hex")
    .slice(0, 16);
  const repeatedFingerprintCount =
    readDuplicateVerdict(input.output)?.duplicateCount ??
    (input.prior.latest?.payloadFingerprint === fingerprint
      ? input.prior.latest.repeatedFingerprintCount + 1
      : 1);
  const issues: EvidenceRecoveryIssue[] = [];
  if (results.length < 5) {
    issues.push("insufficient_results");
  }
  if (distinctDomains.size < 3 && explicitlySourceConstrained === false) {
    issues.push("low_domain_diversity");
  }
  if (lowSignalCount >= Math.max(2, Math.ceil(results.length / 2))) {
    issues.push("low_signal_mix");
  }
  if (repeatedFingerprintCount >= 2) {
    issues.push("repeated_payload");
  }

  const quality = classifyQuality({
    issues,
    resultsCount: results.length,
    domainDiversity: distinctDomains.size,
    explicitlySourceConstrained,
  });

  return {
    family,
    toolName,
    quality,
    lowSignal: quality === "low",
    issues,
    resultsCount: results.length,
    domainDiversity: distinctDomains.size,
    payloadFingerprint: fingerprint,
    repeatedFingerprintCount,
    candidateUrls,
    ...(duplicateVerdict?.kind !== undefined ? { duplicateKind: duplicateVerdict.kind } : {}),
    ...(duplicateVerdict?.duplicateCount !== undefined
      ? { duplicateCount: duplicateVerdict.duplicateCount }
      : {}),
    ...(duplicateVerdict?.matchedPriorStep !== undefined
      ? { matchedPriorStep: duplicateVerdict.matchedPriorStep }
      : {}),
    ...(duplicateVerdict?.canonicalSource !== undefined
      ? { canonicalSource: duplicateVerdict.canonicalSource }
      : {}),
  };
}

function classifyQuality(input: {
  issues: EvidenceRecoveryIssue[];
  resultsCount: number;
  domainDiversity: number;
  explicitlySourceConstrained: boolean;
}): EvidenceQuality {
  if (
    input.issues.includes("insufficient_results") ||
    input.issues.includes("low_domain_diversity") ||
    input.issues.includes("repeated_payload") ||
    input.issues.includes("low_signal_mix") ||
    input.resultsCount < 3 ||
    (input.explicitlySourceConstrained === false && input.domainDiversity < 2)
  ) {
    return "low";
  }
  if (input.issues.length > 0) {
    return "medium";
  }
  return "high";
}

function readBatchExtractionSignals(value: unknown): {
  hasHighYield: boolean;
  hasLowYield: boolean;
} {
  const record = asRecord(value);
  const items = asArray(record?.items);
  let hasHighYield = false;
  let hasLowYield = false;
  for (const entry of items) {
    const item = asRecord(entry);
    const toolName = asString(item?.name);
    const diagnostics = readWebExtractionDiagnostics(toolName, item?.output);
    const duplicateVerdict = readDuplicateVerdict(item?.output);
    if (duplicateVerdict?.kind === "duplicate_cached_result" || duplicateVerdict?.kind === "duplicate_executed_result") {
      hasLowYield = true;
      continue;
    }
    if (diagnostics === undefined) {
      continue;
    }
    if (diagnostics.lowYield) {
      hasLowYield = true;
      continue;
    }
    hasHighYield = true;
  }
  return { hasHighYield, hasLowYield };
}

function normalizeDiagnostics(value: unknown): EvidenceRecoveryDiagnostics | undefined {
  const record = asRecord(value);
  const family = readFamily(record?.family);
  const toolName = asString(record?.toolName);
  const quality = readQuality(record?.quality);
  if (family === undefined || toolName === undefined) {
    return undefined;
  }
  return {
    family,
    toolName,
    quality,
    lowSignal: record?.lowSignal === true,
    issues: readIssues(record?.issues),
    resultsCount: readNonNegativeNumber(record?.resultsCount),
    domainDiversity: readNonNegativeNumber(record?.domainDiversity),
    payloadFingerprint: asString(record?.payloadFingerprint) ?? "",
    repeatedFingerprintCount: Math.max(1, readNonNegativeNumber(record?.repeatedFingerprintCount)),
    candidateUrls: readStrings(record?.candidateUrls).slice(0, MAX_DIAGNOSTIC_CANDIDATE_URLS),
    ...(readDuplicateKind(record?.duplicateKind) !== undefined
      ? { duplicateKind: readDuplicateKind(record?.duplicateKind) }
      : {}),
    ...(readNonNegativeNumber(record?.duplicateCount) > 0
      ? { duplicateCount: readNonNegativeNumber(record?.duplicateCount) }
      : {}),
    ...(readMatchedPriorStep(record?.matchedPriorStep) !== undefined
      ? { matchedPriorStep: readMatchedPriorStep(record?.matchedPriorStep) }
      : {}),
    ...(asString(record?.canonicalSource) !== undefined
      ? { canonicalSource: asString(record?.canonicalSource) }
      : {}),
  };
}

function readPageDuplicateDiagnostics(input: {
  toolName: string;
  output: unknown;
  family: EvidenceRecoveryFamily;
}): EvidenceRecoveryDiagnostics | undefined {
  const duplicateVerdict = readDuplicateVerdict(input.output);
  if (
    duplicateVerdict?.kind !== "duplicate_cached_result" &&
    duplicateVerdict?.kind !== "duplicate_executed_result"
  ) {
    return undefined;
  }
  const output = asRecord(input.output);
  const url = canonicalizeDuplicateUrl(asString(output?.url)) ?? asString(output?.url);
  return {
    family: input.family,
    toolName: input.toolName,
    quality: "low",
    lowSignal: true,
    issues: ["repeated_payload"],
    resultsCount: 1,
    domainDiversity: duplicateVerdict.canonicalSource !== undefined ? 1 : 0,
    payloadFingerprint: duplicateVerdict.fingerprint,
    repeatedFingerprintCount: duplicateVerdict.duplicateCount,
    candidateUrls: url !== undefined ? [url] : [],
    duplicateKind: duplicateVerdict.kind,
    duplicateCount: duplicateVerdict.duplicateCount,
    ...(duplicateVerdict.matchedPriorStep !== undefined
      ? { matchedPriorStep: duplicateVerdict.matchedPriorStep }
      : {}),
    ...(duplicateVerdict.canonicalSource !== undefined
      ? { canonicalSource: duplicateVerdict.canonicalSource }
      : {}),
  };
}

function readResultItems(record: Record<string, unknown>): Array<{
  title?: string | undefined;
  url?: string | undefined;
  source?: string | undefined;
  publisher?: string | undefined;
  category?: string | undefined;
  summary?: string | undefined;
}> {
  const raw =
    asArray(record.results).length > 0
      ? asArray(record.results)
      : asArray(record.sources).length > 0
        ? asArray(record.sources)
        : asArray(record.highlights);
  return raw
    .map((entry) => {
      const item = asRecord(entry);
      if (item === undefined) {
        return undefined;
      }
      return {
        ...(asString(item.title) !== undefined ? { title: asString(item.title) } : {}),
        ...(asString(item.url) !== undefined ? { url: asString(item.url) } : {}),
        ...(asString(item.source) !== undefined ? { source: asString(item.source) } : {}),
        ...(asString(item.publisher) !== undefined ? { publisher: asString(item.publisher) } : {}),
        ...(asString(item.category) !== undefined ? { category: asString(item.category) } : {}),
        ...(asString(item.summary) !== undefined ? { summary: asString(item.summary) } : {}),
      };
    })
    .filter(
      (
        item,
      ): item is {
        title?: string | undefined;
        url?: string | undefined;
        source?: string | undefined;
        publisher?: string | undefined;
        category?: string | undefined;
        summary?: string | undefined;
      } => item !== undefined,
    );
}

function isLowSignalItem(item: {
  title?: string | undefined;
  url?: string | undefined;
  source?: string | undefined;
}): boolean {
  if (isLowValueInternetResultUrl(item.url)) {
    return true;
  }
  const haystack = `${item.title ?? ""} ${item.url ?? ""} ${item.source ?? ""}`.toLowerCase();
  return (
    haystack.includes("editorial roundup") ||
    haystack.includes("press release") ||
    haystack.includes("newsletter") ||
    haystack.includes("full broadcast") ||
    haystack.includes("face the nation") ||
    haystack.includes("60 minutes") ||
    haystack.includes("saturday sessions") ||
    haystack.includes("laser focus") ||
    haystack.includes("clip") ||
    haystack.includes("video") ||
    haystack.includes("open: this is")
  );
}

function hasExplicitStructuredSourceConstraint(input: {
  toolName: string;
  output: unknown;
  action?: unknown;
}): boolean {
  if (input.toolName !== "internet.search_advanced") {
    return false;
  }

  return (
    hasNonEmptyStringArray(asRecord(input.output)?.domainAllow) ||
    hasNonEmptyStringArray(asRecord(asRecord(input.action)?.input)?.domainAllow)
  );
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return (
    asArray(value)
      .map((entry) => asString(entry)?.trim())
      .filter((entry): entry is string => entry !== undefined && entry.length > 0).length > 0
  );
}

function normalizeDomain(item: {
  title?: string | undefined;
  url?: string | undefined;
  source?: string | undefined;
}): string | undefined {
  if (typeof item.url === "string" && item.url.trim().length > 0) {
    try {
      return new URL(item.url).hostname.toLowerCase().replace(/^www\./u, "");
    } catch {
      // Fall through to source parsing.
    }
  }
  const source = item.source?.trim().toLowerCase();
  return source === undefined || source.length === 0 ? undefined : source.replace(/^www\./u, "");
}

function readPrimaryToolName(value: unknown): string | undefined {
  const record = asRecord(value);
  const items = asArray(record?.items);
  const first = asRecord(items[0]);
  return asString(first?.name);
}

function readRecoveryStage(
  value: unknown,
): "broaden_search" | "target_article_fetch" | undefined {
  const record = asRecord(value);
  const runtimeStage = asString(record?.recoveryStage);
  if (runtimeStage === "broaden_search" || runtimeStage === "target_article_fetch") {
    return runtimeStage;
  }
  const policyContext = asRecord(record?.policyContext);
  const stage = asString(policyContext?.evidenceRecoveryStage);
  if (stage === "broaden_search" || stage === "target_article_fetch") {
    return stage;
  }
  return undefined;
}

function readDuplicateVerdict(value: unknown): EvidenceRecoveryDuplicateVerdict | undefined {
  return normalizeDuplicateVerdict(asRecord(value)?.duplicateResult);
}

function isNewsResearchSearchAttempt(input: {
  prior: EvidenceRecoverySummary;
  objective: string | undefined;
  output: unknown;
}): boolean {
  if (
    input.prior.attempts > 0 ||
    input.prior.broadenedSearchUsed ||
    input.prior.targetedFetchUsed
  ) {
    return true;
  }

  const record = asRecord(input.output);
  const query = asString(record?.query);
  const haystack = `${input.objective ?? ""} ${query ?? ""}`.toLowerCase();
  return (
    haystack.includes("news") ||
    haystack.includes("headline") ||
    haystack.includes("top stories") ||
    haystack.includes("current events") ||
    haystack.includes("nightly") ||
    haystack.includes("monologue")
  );
}

function normalizeObjectiveKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/gu, " ");
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  return normalized.slice(0, 160);
}

function readFamily(value: unknown): EvidenceRecoveryFamily | undefined {
  if (
    value === "web_research" ||
    value === "filesystem_retrieval" ||
    value === "source_retrieval"
  ) {
    return value;
  }
  return value === "news_research" ? "web_research" : undefined;
}

function inferEvidenceRecoveryFamily(toolName: string | undefined): EvidenceRecoveryFamily | undefined {
  if (
    toolName === "internet.news" ||
    toolName === "internet.search" ||
    toolName === "internet.search_advanced" ||
    toolName === "internet.extract" ||
    toolName === "internet.crawl" ||
    toolName === "internet.map" ||
    toolName === "internet.research"
  ) {
    return "web_research";
  }
  if (toolName === "fs.list" || toolName === "fs.read_text" || toolName === "fs.search_text") {
    return "filesystem_retrieval";
  }
  if (
    toolName === "source.search" ||
    toolName === "source.fetch" ||
    toolName === "source.triage"
  ) {
    return "source_retrieval";
  }
  return undefined;
}

function isFilesystemMutationTool(toolName: string | undefined): boolean {
  return (
    toolName === "fs.write_text" ||
    toolName === "fs.replace_text" ||
    toolName === "fs.mkdir" ||
    toolName === "fs.copy" ||
    toolName === "fs.move" ||
    toolName === "fs.delete"
  );
}

function normalizeFilesystemInspection(value: unknown): FilesystemInspectionSummary | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const inventoryActions = readNonNegativeNumber(record.inventoryActions);
  const groundedReadActions = readNonNegativeNumber(record.groundedReadActions);
  const inventoryPaths = readStrings(record.inventoryPaths)
    .map((entry) => normalizeFilesystemPath(entry))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 32);
  if (inventoryActions === 0 && groundedReadActions === 0 && inventoryPaths.length === 0) {
    return undefined;
  }
  return {
    inventoryActions,
    groundedReadActions,
    budgetExhausted: isBroadResumeBudgetExhausted({
      inventoryActions,
      groundedReadActions,
    }),
    ...(inventoryPaths.length > 0 ? { inventoryPaths } : {}),
  };
}

function updateFilesystemInspectionSummary(input: {
  prior: FilesystemInspectionSummary | undefined;
  toolName?: string | undefined;
  output: unknown;
  action?: unknown;
}): FilesystemInspectionSummary | undefined {
  const toolName = input.toolName;
  const prior = input.prior;
  if (toolName !== "fs.list" && toolName !== "fs.read_text" && toolName !== "fs.search_text") {
    return undefined;
  }
  const inventoryActions = prior?.inventoryActions ?? 0;
  const groundedReadActions = prior?.groundedReadActions ?? 0;
  const inventoryPaths = prior?.inventoryPaths ?? [];
  if (toolName === "fs.list") {
    const nextInventoryPaths = readFilesystemInventoryPaths(input.output, input.action);
    const nextInventoryActions = inventoryActions + 1;
    return {
      inventoryActions: nextInventoryActions,
      groundedReadActions,
      budgetExhausted: isBroadResumeBudgetExhausted({
        inventoryActions: nextInventoryActions,
        groundedReadActions,
      }),
      ...((nextInventoryPaths.length > 0 ? nextInventoryPaths : inventoryPaths).length > 0
        ? { inventoryPaths: (nextInventoryPaths.length > 0 ? nextInventoryPaths : inventoryPaths).slice(0, 32) }
        : {}),
    };
  }
  const targetPath = readFilesystemTargetPath(input.output, input.action);
  const explicitReadTextPath =
    toolName === "fs.read_text" &&
    targetPath !== undefined &&
    targetPath !== ".";
  const grounded =
    explicitReadTextPath ||
    (targetPath !== undefined &&
      inventoryPaths.some((inventoryPath) => filesystemTargetMatchesInventory(targetPath, inventoryPath)));
  const nextGroundedReadActions = grounded ? groundedReadActions + 1 : groundedReadActions;
  return {
    inventoryActions,
    groundedReadActions: nextGroundedReadActions,
    budgetExhausted: isBroadResumeBudgetExhausted({
      inventoryActions,
      groundedReadActions: nextGroundedReadActions,
    }),
    ...(inventoryPaths.length > 0 ? { inventoryPaths: inventoryPaths.slice(0, 32) } : {}),
  };
}

function readFilesystemInventoryPaths(output: unknown, action: unknown): string[] {
  const outputRecord = asRecord(output);
  const actionInput = asRecord(asRecord(action)?.input);
  const root = normalizeFilesystemPath(asString(outputRecord?.path) ?? asString(actionInput?.path));
  const entries = asArray(outputRecord?.entries)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => normalizeFilesystemPath(asString(entry.path)))
    .filter((entry): entry is string => entry !== undefined);
  return [...new Set([...(root !== undefined ? [root] : []), ...entries])].slice(0, 32);
}

function readFilesystemTargetPath(output: unknown, action: unknown): string | undefined {
  return normalizeFilesystemPath(
    asString(asRecord(output)?.path) ?? asString(asRecord(asRecord(action)?.input)?.path),
  );
}

function filesystemTargetMatchesInventory(targetPath: string, inventoryPath: string): boolean {
  if (inventoryPath === ".") {
    return targetPath === ".";
  }
  return targetPath === inventoryPath || targetPath.startsWith(`${inventoryPath}/`);
}

function normalizeFilesystemPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim().replace(/\\/gu, "/");
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^(?:\.\/)+/u, "");
  const collapsed = withoutPrefix.replace(/\/+/gu, "/").replace(/\/$/u, "");
  return collapsed.length === 0 ? "." : collapsed;
}

function normalizeDuplicateVerdict(value: unknown): EvidenceRecoveryDuplicateVerdict | undefined {
  const record = asRecord(value);
  const kind = readDuplicateKind(record?.kind);
  const family = readDuplicateFamily(record?.family);
  const toolName = asString(record?.toolName);
  const fingerprint = asString(record?.fingerprint);
  const duplicateCount = readNonNegativeNumber(record?.duplicateCount);
  if (
    kind === undefined ||
    family === undefined ||
    toolName === undefined ||
    fingerprint === undefined ||
    duplicateCount < 1
  ) {
    return undefined;
  }
  return {
    kind,
    family,
    toolName,
    fingerprint,
    duplicateCount,
    ...(readMatchedPriorStep(record?.matchedPriorStep) !== undefined
      ? { matchedPriorStep: readMatchedPriorStep(record?.matchedPriorStep) }
      : {}),
    ...(asString(record?.canonicalSource) !== undefined
      ? { canonicalSource: asString(record?.canonicalSource) }
      : {}),
    ...(asString(record?.canonicalUrl) !== undefined ? { canonicalUrl: asString(record?.canonicalUrl) } : {}),
  };
}

function normalizeRetainedCandidates(value: unknown): RetainedEvidenceCandidate[] | undefined {
  const items = asArray(value)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => {
      const url = asString(entry.url);
      const toolName = asString(entry.toolName);
      if (url === undefined || toolName === undefined) {
        return undefined;
      }
      return {
        url,
        toolName,
        ...(asString(entry.title) !== undefined ? { title: asString(entry.title) } : {}),
        ...(asString(entry.publisher) !== undefined ? { publisher: asString(entry.publisher) } : {}),
        ...(asString(entry.category) !== undefined ? { category: asString(entry.category) } : {}),
        ...(asString(entry.summary) !== undefined ? { summary: asString(entry.summary) } : {}),
        ...(asString(entry.updatedAt) !== undefined ? { updatedAt: asString(entry.updatedAt) } : {}),
      };
    })
    .filter((entry): entry is RetainedEvidenceCandidate => entry !== undefined);
  return items.length > 0 ? items : undefined;
}

function mergeRetainedCandidates(input: {
  prior: RetainedEvidenceCandidate[] | undefined;
  results: Array<{
    title?: string | undefined;
    url?: string | undefined;
    source?: string | undefined;
    publisher?: string | undefined;
    category?: string | undefined;
    summary?: string | undefined;
  }>;
  toolName: string;
  updatedAt?: string | undefined;
}): { candidates: RetainedEvidenceCandidate[]; latestNewCandidateCount: number } {
  const priorByUrl = new Map<string, RetainedEvidenceCandidate>();
  for (const candidate of input.prior ?? []) {
    const key = canonicalizeDuplicateUrl(candidate.url) ?? candidate.url;
    if (key.trim().length === 0 || priorByUrl.has(key)) {
      continue;
    }
    priorByUrl.set(key, candidate);
  }
  const latestCandidates: RetainedEvidenceCandidate[] = [];
  const seenLatest = new Set<string>();
  let latestNewCandidateCount = 0;
  for (const result of input.results) {
    const url = asString(result.url);
    if (url === undefined) {
      continue;
    }
    const key = canonicalizeDuplicateUrl(url) ?? url;
    if (key.trim().length === 0 || seenLatest.has(key)) {
      continue;
    }
    seenLatest.add(key);
    const publisher = asString(result.publisher) ?? asString(result.source);
    const next: RetainedEvidenceCandidate = {
      url,
      toolName: input.toolName,
      ...(asString(result.title) !== undefined ? { title: asString(result.title) } : {}),
      ...(publisher !== undefined ? { publisher } : {}),
      ...(asString(result.category) !== undefined ? { category: asString(result.category) } : {}),
      ...(asString(result.summary) !== undefined ? { summary: asString(result.summary) } : {}),
      ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
    };
    const prior = priorByUrl.get(key);
    if (prior === undefined) {
      latestNewCandidateCount += 1;
      latestCandidates.push(next);
      continue;
    }
    latestCandidates.push(mergeCandidateFacts(prior, next));
    priorByUrl.delete(key);
  }
  return {
    candidates: [...latestCandidates, ...priorByUrl.values()],
    latestNewCandidateCount,
  };
}

function mergeCandidateFacts(
  prior: RetainedEvidenceCandidate,
  next: RetainedEvidenceCandidate,
): RetainedEvidenceCandidate {
  return {
    url: next.url,
    toolName: next.toolName,
    ...(next.title !== undefined ? { title: next.title } : prior.title !== undefined ? { title: prior.title } : {}),
    ...(next.publisher !== undefined
      ? { publisher: next.publisher }
      : prior.publisher !== undefined
        ? { publisher: prior.publisher }
        : {}),
    ...(next.category !== undefined
      ? { category: next.category }
      : prior.category !== undefined
        ? { category: prior.category }
        : {}),
    ...(next.summary !== undefined
      ? { summary: next.summary }
      : prior.summary !== undefined
        ? { summary: prior.summary }
        : {}),
    ...(next.updatedAt !== undefined
      ? { updatedAt: next.updatedAt }
      : prior.updatedAt !== undefined
        ? { updatedAt: prior.updatedAt }
        : {}),
  };
}

function readToolUpdateTimestamp(value: unknown): string | undefined {
  const record = asRecord(value);
  return asString(record?.updatedAt) ?? asString(record?.timestamp) ?? asString(record?.ts);
}

function isAbsoluteHttpUrl(value: string | undefined): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function readQuality(value: unknown): EvidenceQuality {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function readIssues(value: unknown): EvidenceRecoveryIssue[] {
  return readStrings(value).filter(
    (item): item is EvidenceRecoveryIssue =>
      item === "insufficient_results" ||
      item === "low_domain_diversity" ||
      item === "low_signal_mix" ||
      item === "repeated_payload",
  );
}

function readDuplicateKind(
  value: unknown,
): EvidenceRecoveryDuplicateVerdict["kind"] | undefined {
  return value === "fresh_result" ||
    value === "duplicate_cached_result" ||
    value === "duplicate_executed_result"
    ? value
    : undefined;
}

function readDuplicateFamily(
  value: unknown,
): EvidenceRecoveryDuplicateVerdict["family"] | undefined {
  return value === "web_search_results" ||
    value === "web_page_content" ||
    value === "source_search_results" ||
    value === "source_page_content"
    ? value
    : undefined;
}

function inferEvidenceRecoveryDuplicateFamily(
  toolName: string | undefined,
): EvidenceRecoveryDuplicateVerdict["family"] | undefined {
  if (toolName === "source.search" || toolName === "source.triage") {
    return "source_search_results";
  }
  if (toolName === "source.fetch") {
    return "source_page_content";
  }
  return undefined;
}

function inferWebRecoveryDuplicateFamily(
  toolName: string | undefined,
): EvidenceRecoveryDuplicateVerdict["family"] | undefined {
  if (toolName === "internet.extract" || toolName === "internet.crawl") {
    return "web_page_content";
  }
  return "web_search_results";
}

function readMatchedPriorStep(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function readStrings(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
