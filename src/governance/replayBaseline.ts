import type { ReplaySummary } from "../replay/RunReplayService.js";
import type {
  CapturedReplayBundle,
  ReplayBaseline,
  ReplayBaselineVerdict,
  ReplayBaselineViolation,
  ReplayFlowManifest,
  UiEvidenceArtifact,
} from "./contracts.js";

export type ReplayDiffViolation = ReplayBaselineViolation;

export function diffReplayAgainstBaseline(input: {
  baseline: ReplayBaseline;
  events: string[];
  summary: ReplaySummary;
  previousSummary: ReplaySummary;
  errorCodes?: string[] | undefined;
}): ReplayDiffViolation[] {
  const violations: ReplayDiffViolation[] = [];
  const exclusions = new Set(input.baseline.exclusions ?? []);

  const strict = input.baseline.strict_events.filter((event) => exclusions.has(event) === false);
  let previousIndex = -1;
  for (const event of strict) {
    const nextIndex = input.events.indexOf(event, previousIndex + 1);
    if (nextIndex === -1) {
      violations.push({
        field: "strict_events",
        expected: event,
        actual: "missing",
      });
      continue;
    }
    previousIndex = nextIndex;
  }

  if (
    input.baseline.expected_terminal_status !== undefined &&
    input.summary.terminalStatus !== input.baseline.expected_terminal_status
  ) {
    violations.push({
      field: "terminalStatus",
      expected: input.baseline.expected_terminal_status,
      actual: input.summary.terminalStatus ?? "missing",
    });
  }

  for (const errorCode of input.baseline.expected_error_codes ?? []) {
    if ((input.errorCodes ?? []).includes(errorCode) === false) {
      violations.push({
        field: "errorCodes",
        expected: errorCode,
        actual: input.errorCodes ?? [],
      });
    }
  }

  checkMetricDelta(
    "stepsObserved",
    input.summary.stepsObserved,
    input.previousSummary.stepsObserved,
    input.baseline.tolerant_metrics.stepsObservedDelta,
    violations,
  );
  checkMetricDelta(
    "progressToolCalls",
    input.summary.progressToolCalls,
    input.previousSummary.progressToolCalls,
    input.baseline.tolerant_metrics.progressToolCallsDelta,
    violations,
  );

  return violations;
}

export function diffCapturedReplayBundle(input: {
  bundle: CapturedReplayBundle;
  summary: ReplaySummary;
  events: string[];
  errorCodes?: string[] | undefined;
  uiEvidenceArtifacts?: UiEvidenceArtifact[] | undefined;
}): ReplayDiffViolation[] {
  const violations = diffReplayAgainstBaseline({
    baseline: {
      scenario_id: input.bundle.manifest.flow_id,
      strict_events: input.bundle.manifest.strict_events,
      expected_terminal_status: input.bundle.manifest.expected_terminal_status,
      expected_error_codes: input.bundle.manifest.expected_error_codes,
      tolerant_metrics: input.bundle.manifest.tolerant_metrics,
      exclusions: input.bundle.manifest.exclusions,
      approved_at: input.bundle.manifest.approved_at,
    },
    events: input.events,
    summary: input.summary,
    previousSummary: input.bundle.previous.summary,
    errorCodes: input.errorCodes,
  });

  const requiredTypes = input.bundle.manifest.expected_artifacts?.required_snapshot_types ?? [];
  const actualTypes = new Set(
    (input.uiEvidenceArtifacts ?? [])
      .filter((artifact) => artifact.result === "passed")
      .map((artifact) => artifact.snapshot_type),
  );

  for (const snapshotType of requiredTypes) {
    if (actualTypes.has(snapshotType) === false) {
      violations.push({
        field: "artifacts.required_snapshot_types",
        expected: snapshotType,
        actual: [...actualTypes],
      });
    }
  }

  const minCount = input.bundle.manifest.expected_artifacts?.min_count;
  if (
    typeof minCount === "number" &&
    (input.uiEvidenceArtifacts?.filter((artifact) => artifact.result === "passed").length ?? 0) < minCount
  ) {
    violations.push({
      field: "artifacts.min_count",
      expected: minCount,
      actual: input.uiEvidenceArtifacts?.filter((artifact) => artifact.result === "passed").length ?? 0,
    });
  }

  return violations;
}

export function evaluateReplayBundle(input: {
  bundle: CapturedReplayBundle;
  summary: ReplaySummary;
  events: string[];
  errorCodes?: string[] | undefined;
  uiEvidenceArtifacts?: UiEvidenceArtifact[] | undefined;
}): ReplayBaselineVerdict {
  const violations = diffCapturedReplayBundle(input);
  return createReplayBaselineVerdict(input.bundle.manifest, violations, input.uiEvidenceArtifacts);
}

export function createReplayBaselineVerdict(
  manifest: ReplayFlowManifest,
  violations: ReplayDiffViolation[],
  uiEvidenceArtifacts?: UiEvidenceArtifact[] | undefined,
): ReplayBaselineVerdict {
  return {
    flow_id: manifest.flow_id,
    baseline_class: manifest.baseline_class,
    status: violations.length === 0 ? "passed" : "failed",
    approved_at: manifest.approved_at,
    ...(manifest.source_behavior_id !== undefined ? { source_behavior_id: manifest.source_behavior_id } : {}),
    ...(manifest.source_mode !== undefined ? { source_mode: manifest.source_mode } : {}),
    ...(manifest.expected_artifacts?.required_snapshot_types !== undefined
      ? { expected_snapshot_types: manifest.expected_artifacts.required_snapshot_types }
      : {}),
    actual_snapshot_types: [
      ...new Set((uiEvidenceArtifacts ?? []).map((artifact) => artifact.snapshot_type)),
    ],
    violations,
  };
}

export function missingReplayBaselineVerdict(input: {
  flowId: string;
  baselineClass?: ReplayFlowManifest["baseline_class"] | undefined;
  behaviorId?: string | undefined;
  mode?: ReplayFlowManifest["source_mode"] | undefined;
}): ReplayBaselineVerdict {
  return {
    flow_id: input.flowId,
    baseline_class: input.baselineClass ?? "deterministic",
    status: "missing",
    ...(input.behaviorId !== undefined ? { source_behavior_id: input.behaviorId } : {}),
    ...(input.mode !== undefined ? { source_mode: input.mode } : {}),
    violations: [],
  };
}

function checkMetricDelta(
  field: string,
  actual: number,
  previous: number,
  tolerance: number | undefined,
  violations: ReplayDiffViolation[],
): void {
  if (typeof tolerance !== "number") {
    return;
  }
  if (Math.abs(actual - previous) > tolerance) {
    violations.push({
      field,
      expected: `within ±${tolerance} of ${previous}`,
      actual,
    });
  }
}
