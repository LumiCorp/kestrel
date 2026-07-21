export type WorkspaceValidationKind =
  | "setup"
  | "test"
  | "lint"
  | "typecheck"
  | "build"
  | "smoke"
  | "custom";

export type WorkspaceValidationOutcome =
  | "not_run"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "stale";

export interface WorkspaceValidationAction {
  actionId: string;
  label: string;
  kind: WorkspaceValidationKind;
  command: string;
  args: string[];
  cwd: string;
  required: boolean;
  artifactPaths: string[];
  locationsFile?: string | undefined;
  source: "package_script" | "kestrel_config";
}

export interface WorkspaceValidationSuite {
  suiteId: string;
  label: string;
  actionIds: string[];
  stopOnFailure: boolean;
}

export interface WorkspaceValidationOutputEntry {
  seq: number;
  at: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface WorkspaceValidationEvidence {
  path: string;
  exists: boolean;
}

export interface WorkspaceValidationSourceLocation {
  path: string;
  line: number;
  column?: number | undefined;
  message?: string | undefined;
}

export interface WorkspaceValidationResult {
  resultId: string;
  sessionId: string;
  threadId: string;
  actionId: string;
  actionLabel: string;
  kind: WorkspaceValidationKind;
  candidateFingerprint: string;
  outcome: WorkspaceValidationOutcome;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  completedAt?: string | undefined;
  durationMs?: number | undefined;
  exitCode?: number | undefined;
  signal?: string | undefined;
  output: WorkspaceValidationOutputEntry[];
  outputTruncated: boolean;
  evidence: WorkspaceValidationEvidence[];
  locations: WorkspaceValidationSourceLocation[];
  locationsFile?: string | undefined;
  submissionRunId?: string | undefined;
}

export interface WorkspaceValidationReadiness {
  state: "not_run" | "running" | "ready" | "blocked" | "stale";
  required: number;
  passed: number;
  failed: number;
  stale: number;
  message: string;
}

export interface WorkspaceValidationSnapshot {
  sessionId: string;
  threadId: string;
  workspaceRoot: string;
  candidateFingerprint: string;
  actions: WorkspaceValidationAction[];
  suites: WorkspaceValidationSuite[];
  results: WorkspaceValidationResult[];
  readiness: WorkspaceValidationReadiness;
  generatedAt: string;
}
