import type {
  FailureDiagnosticsSummary,
  OperatorTriageSummary,
  ReplayBaselineVerdict,
  RunDiagnosticsView,
  UiEvidenceArtifact,
  UiEvidenceInventoryEntry,
  UiEvidenceSnapshotType,
} from "./contracts.js";

const SNAPSHOT_ORDER: UiEvidenceSnapshotType[] = ["screenshot", "dom", "trace", "video"];

export function buildOperatorTriageSummary(input: {
  runDiagnostics?: RunDiagnosticsView | undefined;
  baselineVerdict?: ReplayBaselineVerdict | undefined;
  uiEvidenceArtifacts?: UiEvidenceArtifact[] | undefined;
  terminalStatus?: string | undefined;
  failureCauses?: string[] | undefined;
}): OperatorTriageSummary {
  const decision = input.runDiagnostics?.decisionSummary;
  const failure =
    input.runDiagnostics?.failureSummary ??
    fallbackFailureSummary(input.failureCauses);

  return {
    interactionMode: decision?.interactionMode ?? "unknown",
    executionLane: decision?.executionLane ?? "unknown",
    extractorCandidateTools: (decision?.candidateTools ?? []).map((tool) => tool.name),
    plannerAction: decision?.plannerAction ?? "unknown",
    topFailure: failure,
    toolHotspots: input.runDiagnostics?.toolHotspots ?? [],
    internetSignals: input.runDiagnostics?.internetSignals ?? [],
    replayVerdict: input.baselineVerdict?.status ?? "untracked",
    uiEvidenceInventory: buildEvidenceInventory(input.uiEvidenceArtifacts ?? []),
    ...(input.terminalStatus !== undefined ? { terminalStatus: input.terminalStatus } : {}),
    ...(input.runDiagnostics?.slowestStep !== undefined
      ? { slowestStep: input.runDiagnostics.slowestStep }
      : {}),
    ...(input.runDiagnostics?.errorClusters !== undefined
      ? { errorClusters: input.runDiagnostics.errorClusters }
      : {}),
    ...(input.failureCauses !== undefined ? { failureCauses: input.failureCauses } : {}),
  };
}

function fallbackFailureSummary(
  failureCauses: string[] | undefined,
): FailureDiagnosticsSummary {
  const firstCause = failureCauses?.find((item) => item.trim().length > 0);
  if (firstCause !== undefined) {
    return {
      code: firstCause,
      message: "Failure cause derived from run doctor/replay signals.",
      subsystem: "unknown",
      classification: "unknown",
    };
  }

  return {
    code: "NONE",
    message: "No failure summary available.",
    subsystem: "unknown",
    classification: "unknown",
  };
}

function buildEvidenceInventory(artifacts: UiEvidenceArtifact[]): UiEvidenceInventoryEntry[] {
  if (artifacts.length === 0) {
    return [];
  }

  const counters = new Map<UiEvidenceSnapshotType, { total: number; failed: number }>();
  for (const snapshot of SNAPSHOT_ORDER) {
    counters.set(snapshot, { total: 0, failed: 0 });
  }

  for (const artifact of artifacts) {
    const counter = counters.get(artifact.snapshot_type) ?? { total: 0, failed: 0 };
    counter.total += 1;
    if (artifact.result === "failed") {
      counter.failed += 1;
    }
    counters.set(artifact.snapshot_type, counter);
  }

  return SNAPSHOT_ORDER
    .map((snapshot_type) => {
      const value = counters.get(snapshot_type);
      if (value === undefined || value.total === 0) {
        return ;
      }
      return {
        snapshot_type,
        total: value.total,
        failed: value.failed,
      };
    })
    .filter((entry): entry is UiEvidenceInventoryEntry => entry !== undefined);
}
