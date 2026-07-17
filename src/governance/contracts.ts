import type { ReplaySummary } from "../replay/RunReplayService.js";

export type GovernanceDomain =
  | "runtime"
  | "agent"
  | "tooling"
  | "web"
  | "cli"
  | "docs"
  | "ops";

export interface DocIndexEntry {
  id: string;
  domain: GovernanceDomain | string;
  status: "draft" | "active" | "deprecated" | "historical";
  owner: string;
  last_verified_at: string;
  depends_on?: string[] | undefined;
}

export interface ArchitectureRuleException {
  from: string;
  to: string;
  reason: string;
  expires_at: string;
}

export interface ArchitectureRuleSet {
  layer: string;
  can_depend_on: string[];
  forbidden_paths?: string[] | undefined;
  exceptions?: ArchitectureRuleException[] | undefined;
}

export interface LintInvariant {
  rule_id: string;
  scope: string;
  message_template: string;
  autofix_available: boolean;
  severity: "error" | "warn";
  severity_overrides?:
    | Array<{
        path_prefix: string;
        severity: "error" | "warn";
      }>
    | undefined;
}

export interface ReplayBaseline {
  scenario_id: string;
  strict_events: string[];
  expected_terminal_status?: string | undefined;
  expected_error_codes?: string[] | undefined;
  tolerant_metrics: {
    stepsObservedDelta?: number | undefined;
    progressToolCallsDelta?: number | undefined;
    durationMsDelta?: number | undefined;
  };
  exclusions?: string[] | undefined;
  approved_at: string;
}

export type UiEvidenceSnapshotType = "screenshot" | "dom" | "trace" | "video";
export type UiEvidenceCapturePhase =
  | "pre-assertion"
  | "failure"
  | "post-finalize"
  | "operator-recapture";
export type UiEvidenceCaptureSource = "runtime-capture" | "operator";

export interface UiEvidenceArtifact {
  flow_id: string;
  behavior_id?: string | undefined;
  run_id?: string | undefined;
  session_id?: string | undefined;
  snapshot_type: UiEvidenceSnapshotType;
  capture_phase: UiEvidenceCapturePhase;
  capture_source?: UiEvidenceCaptureSource | undefined;
  selector_assertions: string[];
  artifact_path: string;
  preview_path?: string | undefined;
  thumbnail_path?: string | undefined;
  result: "passed" | "failed";
  missing_reason?: string | undefined;
}

export interface StepDiagnosticsView {
  step: string;
  stepIndex: number;
  eventCount: number;
  errorCount: number;
  waitCount: number;
}

export interface FailureDiagnosticsSummary {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
  subsystem: "react" | "tooling" | "decision" | "runtime" | "unknown";
  classification:
    | "recoverable"
    | "configuration"
    | "determinism"
    | "policy"
    | "schema"
    | "runtime"
    | "unknown";
}

export interface ApiFailure {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
  subsystem?: FailureDiagnosticsSummary["subsystem"] | undefined;
  classification?: FailureDiagnosticsSummary["classification"] | undefined;
}

export interface RunDiagnosticsView {
  runId: string;
  sessionId?: string | undefined;
  terminalStatus?: string | undefined;
  totalEvents: number;
  slowestStep?: string | undefined;
  failureSummary?: FailureDiagnosticsSummary | undefined;
  decisionSummary?:
    | {
        interactionMode?: string | undefined;
        allowedToolClasses: string[];
        executionLane?: string | undefined;
        routeReason?: string | undefined;
        routeConfidence?: number | undefined;
        toolUseIntent?: string | undefined;
        toolIntentObjective?: string | undefined;
        candidateTools: Array<{ name: string; allowlisted: boolean }>;
        plannerAction?: string | undefined;
        plannerToolName?: string | undefined;
        requiredCapabilities: string[];
        requiredToolClasses: string[];
        blockedByMode: boolean;
        finalizeBlocked: boolean;
      }
    | undefined;
  stepDiagnostics: StepDiagnosticsView[];
  errorClusters: Array<{ eventType: string; count: number }>;
  toolHotspots: Array<{ toolName: string; count: number }>;
  internetSignals: InternetReliabilitySignal[];
}

export interface UiEvidenceInventoryEntry {
  snapshot_type: UiEvidenceSnapshotType;
  total: number;
  failed: number;
}

export interface InternetReliabilitySignal {
  toolName: string;
  status: "ok" | "degraded";
  attempts: number;
  provider?: string | undefined;
  degradedCode?: string | undefined;
  degradedMessage?: string | undefined;
  retryAfterSeconds?: number | undefined;
}

export interface OperatorTriageSummary {
  interactionMode: string;
  executionLane: string;
  extractorCandidateTools: string[];
  plannerAction: string;
  topFailure: FailureDiagnosticsSummary;
  toolHotspots: Array<{ toolName: string; count: number }>;
  internetSignals: InternetReliabilitySignal[];
  replayVerdict: "passed" | "failed" | "missing" | "untracked";
  uiEvidenceInventory: UiEvidenceInventoryEntry[];
  terminalStatus?: string | undefined;
  slowestStep?: string | undefined;
  errorClusters?: Array<{ eventType: string; count: number }> | undefined;
  failureCauses?: string[] | undefined;
}

export interface ReplayBaselineViolation {
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface ReplayArtifactExpectation {
  required_snapshot_types?: UiEvidenceSnapshotType[] | undefined;
  min_count?: number | undefined;
}

export interface ReplayFlowManifest {
  flow_id: string;
  source_behavior_id?: string | undefined;
  source_mode?: "mock" | "replay" | "live" | undefined;
  baseline_class: "deterministic" | "live" | "browser" | "failure-recovery";
  primary_for_behavior?: boolean | undefined;
  captured_run_id?: string | undefined;
  strict_events: string[];
  expected_terminal_status?: string | undefined;
  expected_error_codes?: string[] | undefined;
  tolerant_metrics: ReplayBaseline["tolerant_metrics"];
  expected_artifacts?: ReplayArtifactExpectation | undefined;
  exclusions?: string[] | undefined;
  approved_at: string;
}

export interface CapturedReplayBundle {
  manifest: ReplayFlowManifest;
  current: {
    events: string[];
    summary: ReplaySummary;
    errorCodes?: string[] | undefined;
    uiEvidenceArtifacts?: UiEvidenceArtifact[] | undefined;
  };
  previous: {
    summary: ReplaySummary;
  };
}

export interface ReplayBaselineVerdict {
  flow_id: string;
  baseline_class: ReplayFlowManifest["baseline_class"];
  status: "passed" | "failed" | "missing";
  approved_at?: string | undefined;
  source_behavior_id?: string | undefined;
  source_mode?: ReplayFlowManifest["source_mode"];
  expected_snapshot_types?: UiEvidenceSnapshotType[] | undefined;
  actual_snapshot_types?: UiEvidenceSnapshotType[] | undefined;
  violations: ReplayBaselineViolation[];
}

export interface DocDriftFinding {
  type: "stale" | "missing_link" | "orphan" | "code_doc_mismatch";
  severity: "low" | "medium" | "high";
  target_doc: string;
  suggested_fix: string;
  confidence: number;
}

export interface AutonomyPolicy {
  level: "L0" | "L1" | "L2" | "L3" | "L4";
  allowed_actions: string[];
  required_evidence: string[];
  mandatory_escalations: string[];
}

export type RiskTier = "low" | "medium" | "high" | "critical";

export interface GateProfile {
  tier: RiskTier;
  required_checks: string[];
}

export type CiGateId =
  | "static-policy"
  | "runtime-unit"
  | "package-contracts"
  | "web-unit"
  | "web-build"
  | "service-contracts"
  | "docs-contracts"
  | "desktop-contracts"
  | "package-macos";

export type CiChangeStatus = "A" | "C" | "D" | "M" | "R" | "T" | "U";

export interface CiChangedPath {
  path: string;
  previousPath?: string | undefined;
  status: CiChangeStatus;
}

export interface CiGateSelection {
  selected: boolean;
  reasons: string[];
}

export interface CiGatePlan {
  version: 1;
  base: string;
  head: string;
  full: boolean;
  risk: RiskTier;
  changes: CiChangedPath[];
  unownedPaths: string[];
  gates: Record<CiGateId, CiGateSelection>;
}

export interface QualityScoreDomain {
  domain: string;
  score: number;
  trend: "up" | "flat" | "down";
  confidence: number;
  recommended_actions: string[];
}

export interface QualityScorecard {
  generated_at: string;
  domains: QualityScoreDomain[];
}
