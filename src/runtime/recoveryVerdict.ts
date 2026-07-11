import {
  normalizeEvidenceRecoverySummary,
  type EvidenceRecoverySummary,
} from "./evidenceQuality.js";
import {
  normalizeWebExtractionRetrySummary,
  type WebExtractionRetrySummary,
} from "./webExtraction.js";

export const RECOVERY_LOW_SIGNAL_ELEVATED_THRESHOLD = 2;
export const RECOVERY_LOW_SIGNAL_EXHAUSTED_THRESHOLD = 3;
export const RECOVERY_LOW_YIELD_CLUSTER_THRESHOLD = 2;
export const RESEARCH_STALL_LOW_PROGRESS_THRESHOLD = 3;
export const CONTEXT_THRASH_CHECKPOINT_THRESHOLD = 0.5;

export type LowSignalState = "none" | "elevated" | "exhausted";
export type ContextPressureLevel = "none" | "high" | "critical";

export interface RecoveryLowYieldClusterVerdict {
  sourceCluster: string;
  consecutiveLowYield: number;
  lastToolName?: string | undefined;
  lastQuality: "high" | "medium" | "low";
}

export interface RecoveryAdaptationVerdict {
  objectiveKey?: string | undefined;
  evidenceRecovery?: EvidenceRecoverySummary | undefined;
  webExtraction?: WebExtractionRetrySummary | undefined;
  lowSignalState: LowSignalState;
  hasLowSignalResearchStall: boolean;
  lowYieldClusters: RecoveryLowYieldClusterVerdict[];
  hasLowYieldClusterStall: boolean;
  recoveryExhausted: boolean;
  contextPressure: {
    level: ContextPressureLevel;
    high: boolean;
    critical: boolean;
  };
  thrash: {
    index: number;
    threshold: number;
    requiresCheckpoint: boolean;
  };
  autoCompactEligible: boolean;
  researchStall: {
    eligible: boolean;
    active: boolean;
    lowProgressCycles: number;
    threshold: number;
  };
}

export function isResearchRecoveryToolName(toolName: string): boolean {
  return (
    toolName === "internet.search" ||
    toolName === "internet.search_advanced" ||
    toolName === "internet.news" ||
    toolName === "internet.extract" ||
    toolName === "internet.crawl" ||
    toolName === "internet.map" ||
    toolName === "internet.research" ||
    toolName === "source.search" ||
    toolName === "source.fetch" ||
    toolName === "source.triage"
  );
}

export function buildRecoveryAdaptationVerdict(input: {
  evidenceRecovery: unknown;
  webExtraction: unknown;
  contextPressure?: unknown;
  thrashIndex?: number | undefined;
  outputStatus?: unknown;
  waitFor?: unknown;
  lowProgressCycles?: number | undefined;
  researchToolActive?: boolean | undefined;
}): RecoveryAdaptationVerdict {
  const evidenceRecovery = normalizeEvidenceRecoverySummary(input.evidenceRecovery);
  const webExtraction = normalizeWebExtractionRetrySummary(input.webExtraction);
  const lowSignalState = classifyLowSignalState(evidenceRecovery);
  const lowYieldClusters = getLowYieldClusters(webExtraction);
  const contextPressureLevel = normalizeContextPressureLevel(input.contextPressure);
  const lowProgressCycles =
    typeof input.lowProgressCycles === "number" && Number.isFinite(input.lowProgressCycles) && input.lowProgressCycles > 0
      ? Math.trunc(input.lowProgressCycles)
      : 0;
  const thrashIndex =
    typeof input.thrashIndex === "number" && Number.isFinite(input.thrashIndex) && input.thrashIndex > 0
      ? input.thrashIndex
      : 0;
  const researchToolActive = input.researchToolActive === true;
  const objectiveKey = evidenceRecovery?.objectiveKey ?? webExtraction?.objectiveKey;
  const completedWithoutWait = input.outputStatus === "COMPLETED" && input.waitFor === undefined;
  const hasLowSignalResearchStall =
    (evidenceRecovery?.consecutiveLowSignal ?? 0) >= RESEARCH_STALL_LOW_PROGRESS_THRESHOLD;

  return {
    ...(objectiveKey !== undefined ? { objectiveKey } : {}),
    ...(evidenceRecovery !== undefined ? { evidenceRecovery } : {}),
    ...(webExtraction !== undefined ? { webExtraction } : {}),
    lowSignalState,
    hasLowSignalResearchStall,
    lowYieldClusters,
    hasLowYieldClusterStall: lowYieldClusters.length > 0,
    recoveryExhausted: lowSignalState === "exhausted",
    contextPressure: {
      level: contextPressureLevel,
      high: contextPressureLevel === "high" || contextPressureLevel === "critical",
      critical: contextPressureLevel === "critical",
    },
    thrash: {
      index: thrashIndex,
      threshold: CONTEXT_THRASH_CHECKPOINT_THRESHOLD,
      requiresCheckpoint: thrashIndex >= CONTEXT_THRASH_CHECKPOINT_THRESHOLD,
    },
    autoCompactEligible:
      completedWithoutWait &&
      (contextPressureLevel === "high" || contextPressureLevel === "critical") &&
      contextPressureLevel !== "critical" &&
      thrashIndex < CONTEXT_THRASH_CHECKPOINT_THRESHOLD,
    researchStall: {
      eligible: researchToolActive && objectiveKey !== undefined,
      active:
        researchToolActive &&
        objectiveKey !== undefined &&
        lowProgressCycles >= RESEARCH_STALL_LOW_PROGRESS_THRESHOLD &&
        (hasLowSignalResearchStall || lowYieldClusters.length > 0),
      lowProgressCycles,
      threshold: RESEARCH_STALL_LOW_PROGRESS_THRESHOLD,
    },
  };
}

export function getLowYieldClusters(
  summary: unknown,
): RecoveryLowYieldClusterVerdict[] {
  const webExtraction = normalizeWebExtractionRetrySummary(summary);
  if (webExtraction === undefined) {
    return [];
  }
  return webExtraction.clusters
    .filter((entry) => entry.consecutiveLowYield >= RECOVERY_LOW_YIELD_CLUSTER_THRESHOLD)
    .map((entry) => ({
      sourceCluster: entry.sourceCluster,
      consecutiveLowYield: entry.consecutiveLowYield,
      ...(entry.lastToolName !== undefined ? { lastToolName: entry.lastToolName } : {}),
      lastQuality: entry.lastQuality,
    }));
}

export function isLowYieldSourceClusterStalled(summary: unknown, sourceCluster: string): boolean {
  return getLowYieldClusters(summary).some((entry) => entry.sourceCluster === sourceCluster);
}

function classifyLowSignalState(
  summary: EvidenceRecoverySummary | undefined,
): LowSignalState {
  if (
    (summary?.consecutiveLowSignal ?? 0) >= RECOVERY_LOW_SIGNAL_EXHAUSTED_THRESHOLD &&
    summary?.broadenedSearchUsed === true &&
    summary?.targetedFetchUsed === true
  ) {
    return "exhausted";
  }
  if ((summary?.consecutiveLowSignal ?? 0) >= RECOVERY_LOW_SIGNAL_ELEVATED_THRESHOLD) {
    return "elevated";
  }
  return "none";
}

function normalizeContextPressureLevel(value: unknown): ContextPressureLevel {
  return value === "high" || value === "critical" ? value : "none";
}
