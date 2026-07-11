import type { StepContext, UserWaitForMatcher, WaitForMatcher } from "../../../src/kestrel/contracts/execution.js";
import type { ModelToolSpec } from "../../../src/kestrel/contracts/model-io.js";

import type { DevShellSourceWriteGuardResult } from "../../../src/devshell/contracts.js";
import type {
  ManagedTaskWorktreeProposal,
  ManagedTaskWorktreeRequest,
} from "../../../src/workspace/ManagedTaskWorktreeService.js";
import type { ToolExecutionClass as RuntimeToolExecutionClass } from "../../../src/mode/contracts.js";
import type { ContinuationOfferV1 } from "../../../src/runtime/continuationOffer.js";

export interface AgentRegistrationOptions {
  decisionModel?: string;
  agentModel?: string;
  agentToolNames?: string[];
  agentTools?: ModelToolSpec[] | undefined;
  agentToolsProvider?: ((ctx: StepContext) => ModelToolSpec[]) | undefined;
  capabilityManifest?: ToolCapabilityManifestItem[] | undefined;
  capabilityManifestProvider?: ((ctx: StepContext) => ToolCapabilityManifestItem[]) | undefined;
  managedWorktreeProposalProvider?: ((request: ManagedTaskWorktreeRequest) => Promise<ManagedTaskWorktreeProposal>) | undefined;
  effectResultLookupTool?: string;
  finalizeToolName?: string;
  defaultGoal?: string;
  deliberatorModel?: string;
  deliberatorToolNames?: string[];
  deliberatorTools?: ModelToolSpec[] | undefined;
  deliberatorToolsProvider?: ((ctx: StepContext) => ModelToolSpec[]) | undefined;
  thinkerToolNames?: string[];
  thinkerTools?: ModelToolSpec[] | undefined;
  thinkerToolsProvider?: ((ctx: StepContext) => ModelToolSpec[]) | undefined;
}

export interface ResolvedAgentOptions {
  agentModel: string;
  agentToolsProvider: (ctx: StepContext) => ModelToolSpec[];
  capabilityManifestProvider: (ctx: StepContext) => ToolCapabilityManifestItem[];
  managedWorktreeProposalProvider?: ((request: ManagedTaskWorktreeRequest) => Promise<ManagedTaskWorktreeProposal>) | undefined;
  effectResultLookupTool: string;
  finalizeToolName: string;
  defaultGoal: string;
}

export type ExecutionLane = "chat" | "tooling";

export interface ExtractedToolInputHints {
  query?: string | undefined;
  url?: string | undefined;
  urlSource?: "user" | "prior_result_grounding" | undefined;
  topic?: string | undefined;
  text?: string | undefined;
  claim?: string | undefined;
  sourceId?: string | undefined;
  maxItems?: number | undefined;
  path?: string | undefined;
  content?: string | undefined;
  mode?: "overwrite" | "append" | undefined;
  language?: "javascript" | "python" | "bash" | undefined;
  code?: string | undefined;
  scope?: "us" | "global" | undefined;
  freshness?: string | undefined;
  region?: string | undefined;
  locationQuery?: string | undefined;
  timezoneQuery?: string | undefined;
  baseCurrency?: string | undefined;
  quoteCurrency?: string | undefined;
}

export type ExtractedExecutionPreference =
  | "host_shell"
  | "sandbox_snippet"
  | "none";

export type ExtractedCommandMode =
  | "oneshot"
  | "persistent";

export type ExtractedTaskKind =
  | "inspect"
  | "implement"
  | "review"
  | "debug"
  | "validate"
  | "run";

export type ExtractedMutationIntent =
  | "read_only"
  | "edit_files"
  | "run_commands";

export type ExtractedVerificationKind =
  | "test"
  | "lint"
  | "build"
  | "smoke"
  | "browser";

export type ExtractedOperationKind =
  | "write_file"
  | "scaffold_app"
  | "run_host_command"
  | "run_sandbox_code"
  | "read_file"
  | "inspect_repo";

export type ExtractedWorkflowKind =
  | "direct_operation"
  | "coding_change"
  | "validation"
  | "research";

export interface ExtractedVerificationIntent {
  requested: boolean;
  kinds?: ExtractedVerificationKind[] | undefined;
}

export interface ExtractedOperationIntent {
  kind: ExtractedOperationKind;
}

export interface ExtractedWorkflowIntent {
  kind: ExtractedWorkflowKind;
}

export interface ExtractedRepoScope {
  kind: "workspace" | "paths" | "unknown";
  targets?: string[] | undefined;
}

export type ExtractedHostWorkflowKind =
  | "none"
  | "oneshot_command"
  | "persistent_command";

export interface ExtractedPersistenceIntent {
  kind: "write_file";
}

export interface ExtractedFollowUpSourceSelection {
  kind: "use_prior_source" | "search_pivot" | "none";
  candidateId?: string | undefined;
  toolName?: string | undefined;
  query?: string | undefined;
  reason?: string | undefined;
}

export interface ExecutionIntent {
  objective: string;
  candidateTools: string[];
  operationIntent?: ExtractedOperationIntent | undefined;
  inputHints?: ExtractedToolInputHints | undefined;
  command?: string | undefined;
  commandMode?: ExtractedCommandMode | undefined;
  clarification?: {
    needed: boolean;
    prompt?: string;
  };
}

export interface ExecutionIntentMetadata {
  workflowIntent?: ExtractedWorkflowIntent | undefined;
  taskKind?: ExtractedTaskKind | undefined;
  repoScope?: ExtractedRepoScope | undefined;
  mutationIntent?: ExtractedMutationIntent | undefined;
  verificationIntent?: ExtractedVerificationIntent | undefined;
  workspaceTargets?: string[] | undefined;
  hostWorkflowKind?: ExtractedHostWorkflowKind | undefined;
  executionPreference?: ExtractedExecutionPreference | undefined;
  persistenceIntent?: ExtractedPersistenceIntent | undefined;
  followUpSourceSelection?: ExtractedFollowUpSourceSelection | undefined;
  toolUseIntent?: "none" | "single" | "multi" | undefined;
}

export interface DraftIntent {
  version: "v3";
  execution: ExecutionIntent;
  metadata?: ExecutionIntentMetadata | undefined;
  confidence: number;
}

export interface ExtractorDecision extends DraftIntent {}

export type CompiledIntentNextStep =
  | "deliberator"
  | "wait_user";

export type CompiledIntentIssueCode =
  | "clarification_required"
  | "no_allowlisted_candidates"
  | "operation_candidate_mismatch";

export interface CompiledIntentIssue {
  code: CompiledIntentIssueCode;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface LegacyExtractedToolIntent {
  version: "v1" | "v2";
  toolUseIntent: "none" | "single" | "multi";
  objective: string;
  candidateTools: string[];
  confidence: number;
  workflowIntent?: ExtractedWorkflowIntent | undefined;
  taskKind?: ExtractedTaskKind | undefined;
  repoScope?: ExtractedRepoScope | undefined;
  mutationIntent?: ExtractedMutationIntent | undefined;
  verificationIntent?:
    | ExtractedVerificationIntent
    | {
        requested: boolean;
        kinds?: string[] | undefined;
      }
    | undefined;
  operationIntent?: ExtractedOperationIntent | undefined;
  workspaceTargets?: string[] | undefined;
  hostWorkflowKind?: ExtractedHostWorkflowKind | undefined;
  inputHints?: ExtractedToolInputHints | undefined;
  executionPreference?: ExtractedExecutionPreference | undefined;
  command?: string | undefined;
  commandMode?: ExtractedCommandMode | undefined;
  persistenceIntent?: ExtractedPersistenceIntent | undefined;
  followUpSourceSelection?: ExtractedFollowUpSourceSelection | undefined;
  clarification?: {
    needed: boolean;
    prompt?: string;
  };
}

export type CannotSatisfyReasonCode =
  | "unsatisfied_by_available_tools"
  | "insufficient_horizon"
  | "missing_required_capability"
  | "need_user_choice"
  | "requested_tool_unavailable";

export type FinalizeReasonCode =
  | "goal_satisfied"
  | "tool_unavailable"
  | "policy_blocked"
  | "out_of_scope";

export type ModelFinalizeStatus = Exclude<FinalizeReasonCode, "tool_unavailable" | "policy_blocked">;

export interface ModelFinalizeAction {
  kind: "finalize";
  status: ModelFinalizeStatus;
  message: string;
  data?: Record<string, unknown> | undefined;
}

export interface RuntimeFinalizeAction {
  kind: "finalize";
  finalizeReason: FinalizeReasonCode;
  input: Record<string, unknown>;
  supportEvidence?: Record<string, unknown> | undefined;
}

export interface HandoffToBuildAction {
  kind: "handoff_to_build";
  message: string;
  continuation: ContinuationOfferV1;
  data?: Record<string, unknown> | undefined;
}

export type CommandExecutionRole =
  | "source_inspection"
  | "source_authoring"
  | "helper_execution"
  | "helper_repair_check"
  | "environment_probe"
  | "general_evidence";

export interface CommandExecutionRoleHint {
  role: CommandExecutionRole;
  target?: string | undefined;
  sourcePath?: string | undefined;
  artifactTarget?: string | undefined;
  evidenceIds?: string[] | undefined;
  rationale?: string | undefined;
}

type ReactActionCommon = {
  name?: string | undefined;
  input?: Record<string, unknown> | undefined;
  finalizeReason?: FinalizeReasonCode | undefined;
};

export type ReactAction = ReactActionCommon & (
  {
      kind: "resolve_tool";
      intent: string;
      constraints?: string[];
      candidateTools?: string[];
    }
    | {
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      executionRole?: CommandExecutionRoleHint | undefined;
      policyContext?: Record<string, unknown> | undefined;
    }
  | {
      kind: "tool_batch";
      items: Array<{
        name: string;
        input: Record<string, unknown>;
        executionRole?: CommandExecutionRoleHint | undefined;
      }>;
      policyContext?: Record<string, unknown> | undefined;
    }
  | {
      kind: "effect";
      type: string;
      payload: Record<string, unknown>;
      idempotencyKey?: string;
    }
  | {
      kind: "ask_user";
      prompt: string;
      waitFor: UserWaitForMatcher;
    }
  | {
      kind: "cannot_satisfy";
      reasonCode: CannotSatisfyReasonCode;
      message: string;
      details?: Record<string, unknown>;
    }
  | HandoffToBuildAction
  | RuntimeFinalizeAction
);

export type AgentAction = Extract<
  ReactAction,
  { kind: "tool" | "tool_batch" | "ask_user" | "finalize" | "cannot_satisfy" | "handoff_to_build" }
>;

export interface ArtifactExpectation {
  target: string;
  requirements: readonly ArtifactRequirement[];
  checks?: string[] | undefined;
  sourceTruth?: ArtifactSourceTruthExpectation | undefined;
  derivation?: ArtifactDerivationExpectation | undefined;
  verification?: ArtifactVerification | undefined;
}

export interface ArtifactSourceTruthExpectation {
  requiredEvidence: string[];
  sufficiency: string;
  evidenceIds?: string[] | undefined;
  status?: "missing" | "sufficient" | "inconclusive" | "blocked" | undefined;
}

export interface ArtifactDerivationExpectation {
  method: string;
  sourceEvidenceIds?: string[] | undefined;
  evidenceIds?: string[] | undefined;
  status?: "missing" | "supported" | "unsupported" | "inconclusive" | undefined;
}

export interface HelperFailure {
  command: string;
  errorPreview: string;
  exitCode?: number | undefined;
  processId?: string | undefined;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
}

export type HelperOutcomeStatus =
  | "running"
  | "completed_done"
  | "completed_incomplete"
  | "failed_runtime"
  | "stalled";

export type HelperOutcomeNextSuggestedAction =
  | "continue_helper"
  | "collect_output"
  | "stop_process"
  | "verify_artifact"
  | "replan";

export interface HelperOutcome {
  status: HelperOutcomeStatus;
  summary: string;
  processId?: string | undefined;
  command?: string | undefined;
  artifactTarget?: string | undefined;
  progressEvidence?: string | undefined;
  remainingWork?: string | undefined;
  nextSuggestedAction?: HelperOutcomeNextSuggestedAction | undefined;
}

export interface ArtifactProducerReference {
  sourcePath?: string | undefined;
  command?: string | undefined;
  processId?: string | undefined;
}

export type ArtifactProducerRepairAction =
  | "inspect_producer"
  | "rewrite_producer"
  | "rerun_producer"
  | "reverify_artifact";

export type ArtifactProducerFailedRequirement = ArtifactVerificationRequirement & {
  status: "failed" | "inconclusive";
};

export interface ArtifactRequirement {
  id: string;
  expectation: string;
  source: "task_text" | "user_request" | "plan";
}

export interface ArtifactVerificationRequirement {
  id: string;
  expectation: string;
  observed: string;
  status: "passed" | "failed" | "inconclusive";
}

export interface ArtifactVerification {
  target: string;
  status: "passed" | "failed" | "inconclusive";
  evidence: {
    kind: "tool_result";
    toolName: string;
    stepIndex?: number | undefined;
    command?: string | undefined;
    truncated?: boolean | undefined;
    summary: string;
  };
  requirements: readonly ArtifactVerificationRequirement[];
  sourceTruth?: {
    status: "passed" | "failed" | "inconclusive";
    observed: string;
    evidenceIds?: string[] | undefined;
  } | undefined;
  derivation?: {
    status: "passed" | "failed" | "inconclusive";
    observed: string;
    evidenceIds?: string[] | undefined;
  } | undefined;
  failures?: string[] | undefined;
}

export type EvidenceLedgerSource = "tool" | "agent.loop" | "policy" | "runtime";

export type EvidenceLedgerKind =
  | "tool_result"
  | "file_listing"
  | "file_content"
  | "process_result"
  | "process_state"
  | "helper_outcome"
  | "helper_failure"
  | "helper_stall"
  | "file_write"
  | "artifact_verification"
  | "policy_correction";

export type EvidenceLedgerStatus =
  | "passed"
  | "failed"
  | "inconclusive"
  | "running"
  | "blocked";

export type EvidenceClaimImpactSuccess = "blocks" | "supports" | "neutral";

export type EvidenceClaimImpactScope =
  | "artifact"
  | "helper"
  | "environment"
  | "policy"
  | "goal"
  | "general";

export interface EvidenceClaimImpact {
  success: EvidenceClaimImpactSuccess;
  reason: string;
  scope: EvidenceClaimImpactScope;
  target?: string | undefined;
  requirementIds?: readonly string[] | undefined;
}

export interface EvidenceLedgerEntry {
  id: string;
  version: "v1" | string;
  createdAt: string;
  stepIndex?: number | undefined;
  source: EvidenceLedgerSource | string;
  kind: EvidenceLedgerKind | string;
  status: EvidenceLedgerStatus | string;
  summary: string;
  target?: {
    type: "path" | "process" | "artifact" | "url" | "tool" | "workspace" | string;
    value: string;
    normalizedValue?: string | undefined;
  } | undefined;
  facts: Record<string, unknown>;
  raw?: {
    ref?: string | undefined;
    bytes?: number | undefined;
    hash?: string | undefined;
    toolOutputTruncated?: boolean | undefined;
    contextPreviewTruncated?: boolean | undefined;
    contextPreviewBytes?: number | undefined;
  } | undefined;
  links?: {
    processId?: string | undefined;
    sourcePath?: string | undefined;
    artifactTarget?: string | undefined;
    priorEvidenceIds?: string[] | undefined;
  } | undefined;
  nextUse?: {
    supports?: string | undefined;
    blocks?: string | undefined;
    requiresAction?: string | undefined;
    invalidatesRepeat?: boolean | undefined;
  } | undefined;
  claimImpact?: EvidenceClaimImpact | undefined;
}

export interface EvidenceLedgerContext {
  latest: EvidenceLedgerEntry | undefined;
  unresolved: EvidenceLedgerEntry[];
  successBlockers: EvidenceLedgerEntry[];
  successSupport: EvidenceLedgerEntry[];
  linkedToLatestTarget: EvidenceLedgerEntry[];
  repeatedInspection: EvidenceLedgerEntry | undefined;
  entries: EvidenceLedgerEntry[];
  contextPreviewTruncated: boolean;
}

export interface ActiveControllerFailure {
  evidenceId: string;
  stepIndex?: number | undefined;
  status: EvidenceLedgerStatus;
  summary: string;
  command?: string | undefined;
  sourcePath?: string | undefined;
  artifactTarget?: string | undefined;
  processId?: string | undefined;
  errorPreview?: string | undefined;
}

export interface LatestToolEvidence {
  toolName: string;
  inputHash?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  processId?: string | undefined;
  sentInputPreview?: string | undefined;
  sentInputBytes?: number | undefined;
  target?: {
    type: "path" | "process" | "artifact" | "url" | "tool" | "workspace";
    value: string;
    normalizedValue?: string | undefined;
  } | undefined;
  status?: string | undefined;
  exitCode?: number | undefined;
  failureReason?: string | undefined;
  securityMode?: string | undefined;
  sourceWriteGuard?: DevShellSourceWriteGuardResult | undefined;
  toolOutputTruncated?: boolean | undefined;
  promptPreviewClipped: boolean;
  delivery: "full_content" | "excerpt" | "metadata";
  bytes?: number | undefined;
  hash?: string | undefined;
  artifactIds?: string[] | undefined;
  digestArtifactId?: string | undefined;
  digestArtifactIds?: string[] | undefined;
  content?: string | undefined;
  excerpt?: string | undefined;
  message?: string | undefined;
  empty?: boolean | undefined;
  omittedHiddenEntryCount?: number | undefined;
  directoryFacts?: Record<string, unknown> | undefined;
  entryCount?: number | undefined;
  entries?: Array<Record<string, unknown>> | undefined;
  rawEvidenceAvailable: boolean;
}

export interface FilesystemInventoryDirectoryFact {
  path: string;
  normalizedPath: string;
  entryCount: number;
  empty: boolean;
  entries: Array<Record<string, unknown>>;
  message?: string | undefined;
  omittedHiddenEntryCount?: number | undefined;
  directoryFacts?: Record<string, unknown> | undefined;
  observedOptions?: {
    includeHidden?: boolean | undefined;
    recursive?: boolean | undefined;
    maxDepth?: number | undefined;
  } | undefined;
  source: "lastActionResult" | "evidenceLedger";
  stepIndex?: number | undefined;
}

export interface FilesystemInventoryFact {
  directories: FilesystemInventoryDirectoryFact[];
}

export type ToolFreshnessClass = "live" | "volatile" | "static" | "runtime" | "snapshot";
export type ToolLatencyClass = "low" | "medium" | "high";
export type ToolCostClass = "free" | "metered" | "premium";
export type ToolExecutionClass = RuntimeToolExecutionClass;
export type ToolGranularity = "hourly" | "daily" | "mixed";

export interface ToolCapabilitySuitability {
  forecastHorizonDays?: number | undefined;
  granularity?: ToolGranularity | undefined;
  supportsAttribution?: boolean | undefined;
  supportsAggregation?: boolean | undefined;
  typicalFailureModes?: string[] | undefined;
}

export interface ToolCapabilityManifestItem {
  name: string;
  description: string;
  freshnessClass?: ToolFreshnessClass | undefined;
  latencyClass?: ToolLatencyClass | undefined;
  costClass?: ToolCostClass | undefined;
  executionClass?: ToolExecutionClass | undefined;
  capabilityClasses: string[];
  approvalCapabilities?: string[] | undefined;
  requires?: string[] | undefined;
  suitability?: ToolCapabilitySuitability | undefined;
  displayName?: string | undefined;
  aliases?: string[] | undefined;
  keywords?: string[] | undefined;
  provider?: string | undefined;
  toolFamily?: string | undefined;
}

export interface ToolIntentCandidateView {
  name: string;
  allowlisted: boolean;
  capabilityClasses: string[];
  executionClass?: ToolExecutionClass | undefined;
}

export interface DecisionContextExecutionIntent extends ExecutionIntent {}

export interface DecisionContextIntentMetadata extends ExecutionIntentMetadata {}

/**
 * Deprecated compatibility shape for tests and migration callers. New runtime
 * code should use executionIntent + intentMetadata separately.
 */
export interface DecisionContextToolIntent {
  objective: string;
  confidence: number;
  candidateTools: ToolIntentCandidateView[] | string[];
  allowlistedCandidates: string[];
  derivedRequiredCapabilities: string[];
  operationIntent?: ExtractedOperationIntent | undefined;
  workflowIntent?: ExtractedWorkflowIntent | undefined;
  inputHints?: ExtractedToolInputHints | undefined;
  command?: string | undefined;
  commandMode?: ExtractedCommandMode | undefined;
  clarification?: {
    needed: boolean;
    prompt?: string;
  };
  taskKind?: ExtractedTaskKind | undefined;
  repoScope?: ExtractedRepoScope | undefined;
  mutationIntent?: ExtractedMutationIntent | undefined;
  verificationIntent?: ExtractedVerificationIntent | undefined;
  workspaceTargets?: string[] | undefined;
  hostWorkflowKind?: ExtractedHostWorkflowKind | undefined;
  executionPreference?: ExtractedExecutionPreference | undefined;
  persistenceIntent?: ExtractedPersistenceIntent | undefined;
  followUpSourceSelection?: ExtractedFollowUpSourceSelection | undefined;
  toolUseIntent?: "none" | "single" | "multi" | undefined;
  concreteToolName?: string | undefined;
  isAmbiguous?: boolean | undefined;
}

export interface CompiledIntent {
  version: "compiled_v1";
  source: "draft_intent" | "legacy_tool_intent" | "compiled_intent" | "decision_context";
  execution: DecisionContextExecutionIntent;
  metadata?: DecisionContextIntentMetadata | undefined;
  confidence: number;
  candidateTools: ToolIntentCandidateView[];
  allowlistedCandidates: string[];
  operationCompatibleCandidates: string[];
  usableCandidates: string[];
  requiredCapabilities: string[];
  concreteToolName?: string | undefined;
  isAmbiguous: boolean;
  nextStep: CompiledIntentNextStep;
  issues: CompiledIntentIssue[];
}

export interface PriorSourceCandidate {
  id: string;
  title?: string | undefined;
  url: string;
  source?: string | undefined;
  category?: string | undefined;
  publishedAt?: string | undefined;
  summary?: string | undefined;
  snippet?: string | undefined;
  toolName: string;
  stepIndex?: number | undefined;
  updatedAt?: string | undefined;
  contextHint?: string | undefined;
}

export interface FollowUpGroundingSummary {
  status: "provided_url" | "selected_prior_source" | "search_pivot" | "insufficient";
  reason: string;
  candidateId?: string | undefined;
  matchedUrl?: string | undefined;
  matchedTitle?: string | undefined;
  toolName?: string | undefined;
  query?: string | undefined;
  candidateCount: number;
}

export type WebGoalClass =
  | "site_summary"
  | "page_summary"
  | "general_web_research"
  | "comparison"
  | "other";

export type WebEvidenceSufficiency =
  | "insufficient"
  | "sufficient_direct"
  | "sufficient_search_corroborated";

export type WebPivotAssessmentClassification =
  | "acceptable"
  | "low_value_reference_pivot"
  | "low_value_metadata_pivot"
  | "low_value_framework_internal_pivot";

export interface WebSearchCorroboration {
  agreeingSourceCount: number;
  domainDiversity: number;
}

export interface WebPlannedPivotAssessment {
  classification: WebPivotAssessmentClassification;
  reason: string;
}

export interface WebInference {
  goalClass: WebGoalClass;
  evidenceSufficiency: WebEvidenceSufficiency;
  sufficiencyRationale: string;
  supportingUrls: string[];
  keyClaims: string[];
  searchCorroboration?: WebSearchCorroboration | undefined;
  plannedPivotAssessment?: WebPlannedPivotAssessment | undefined;
}

export type DecisionFailureCode =
  | "DECISION_SCHEMA_FAILED"
  | "DECISION_PARSE_FAILED"
  | "DECISION_POLICY_FAILED"
  | "DECISION_MODEL_EMPTY_RESPONSE"
  | "DECISION_CAPABILITY_UNAVAILABLE"
  | "DECISION_CAPABILITY_EVIDENCE_REQUIRED"
  | "TERMINAL_CONTROL_TOOL_REQUIRED";

export type DecisionRunEventType =
  | "decision.generated"
  | "decision.compiled"
  | "decision.policy_passed"
  | "decision.optional_metadata_dropped"
  | "decision.rejected"
  | "decision.redirected"
  | "decision.executed"
  | "decision.deduped"
  | "route.decision"
  | "route.override"
  | "resolver.generated"
  | "resolver.rejected"
  | "resolver.bypassed"
  | "clarification.triggered"
  | "progress.blocked"
  | "context.telemetry"
  | "tool.result_summarized"
  | "tool.chunk.started"
  | "tool.chunk.completed"
  | "agent.action_selected";

export interface DecisionTrace {
  eventType: DecisionRunEventType;
  phase: "agent.loop" | "route" | "chat" | "deliberator" | "resolver" | "acter";
  decisionCode: string;
  decisionErrorCode?: DecisionFailureCode | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type EvidenceDelta = "low" | "medium" | "high";

export interface DecisionVerification {
  missingCapabilities: string[];
  actionNovelty: boolean;
  expectedEvidenceDelta: EvidenceDelta;
  retryRationale?: string | undefined;
  expectedNewEvidence?: string[] | undefined;
  verificationSteps?: string[] | undefined;
  expectedRepoDelta?: string[] | undefined;
  browserEvidence?: BrowserVerificationEvidence[] | undefined;
  blockedBy?: string[] | undefined;
}

export interface BrowserVerificationEvidence {
  url: string;
  assertion: string;
  evidenceType: "dom" | "screenshot" | "trace" | "tool_output";
  artifactRef?: string | undefined;
}

export type CodingWorkPlanPhase =
  | "grounding"
  | "implementation"
  | "verification"
  | "reporting";

export type CodingWorkPlanStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "skipped";

export interface CodingWorkPlanItem {
  id: string;
  title: string;
  phase: CodingWorkPlanPhase;
  status: CodingWorkPlanStatus;
  required: boolean;
  evidence?: string[] | undefined;
}

export interface CodingWorkPlan {
  kind: "coding";
  taskKey: string;
  items: CodingWorkPlanItem[];
}

export type CodingCompletionState =
  | "implemented_and_verified"
  | "implemented_not_verified"
  | "blocked"
  | "deferred";

export interface DecisionLastActionResultStructured {
  kind?: string | undefined;
  name?: string | undefined;
  toolNames?: string[] | undefined;
  inputHash?: string | undefined;
  reused?: boolean | undefined;
  truncated?: boolean | undefined;
  outputTruncated?: boolean | undefined;
  outputPath?: string | undefined;
  outputContentBytes?: number | undefined;
  outputContentHash?: string | undefined;
  outputEntryCount?: number | undefined;
  contextPreviewTruncated?: boolean | undefined;
  contextPreviewChars?: number | undefined;
  contextPreviewBudgetChars?: number | undefined;
  artifactIds?: string[] | undefined;
  digestArtifactId?: string | undefined;
  digestArtifactIds?: string[] | undefined;
}

export interface DecisionRepetitionSignals {
  lastToolName?: string | undefined;
  lastToolInputHash?: string | undefined;
  lastToolFamily?: string | undefined;
  nextToolName?: string | undefined;
  nextToolInputHash?: string | undefined;
  nextToolFamily?: string | undefined;
  lastFilesystemInspectionKey?: string | undefined;
  nextFilesystemInspectionKey?: string | undefined;
  sameToolAsLastAction?: boolean | undefined;
  sameInputAsLastAction?: boolean | undefined;
  sameToolFamilyAsLastAction?: boolean | undefined;
  sameFilesystemInspectionAsLastAction?: boolean | undefined;
  lastResultReused?: boolean | undefined;
  dispatchReuseCount?: number | undefined;
  trailingSameEvidenceLoopCycles?: number | undefined;
  requiredCapabilitiesAlreadyObserved?: boolean | undefined;
  latestEvidenceQuality?: string | undefined;
  lowSignalAttempts?: number | undefined;
  consecutiveLowSignal?: number | undefined;
  broadenedSearchUsed?: boolean | undefined;
  targetedFetchUsed?: boolean | undefined;
  retainedCandidateCount?: number | undefined;
  latestNewCandidateCount?: number | undefined;
  settledDevShellCommand?: boolean | undefined;
  latestDuplicateResult?: {
    kind?: string | undefined;
    family?: string | undefined;
    toolName?: string | undefined;
    fingerprint?: string | undefined;
    duplicateCount?: number | undefined;
    matchedPriorStep?: number | undefined;
    canonicalSource?: string | undefined;
    canonicalUrl?: string | undefined;
    nonRepeatConstraint: "do_not_repeat_same_tool_input_or_payload";
  } | undefined;
}

export interface DecisionRetrievalStallSummary {
  lastToolFamily?: string | undefined;
  nextToolFamily?: string | undefined;
  sameToolFamilyAsLastAction?: boolean | undefined;
  sameInputAsLastAction?: boolean | undefined;
  requiredCapabilitiesAlreadyObserved?: boolean | undefined;
  researchStallActive?: boolean | undefined;
  trailingSameEvidenceLoopCycles?: number | undefined;
  consecutiveLowSignal?: number | undefined;
  broadenedSearchUsed?: boolean | undefined;
  targetedFetchUsed?: boolean | undefined;
  retainedCandidateCount?: number | undefined;
  latestNewCandidateCount?: number | undefined;
  suggestedResolution?:
    | "finalize_or_new_family"
    | "new_target_within_family"
    | "synthesize_with_current_evidence"
    | undefined;
}

export interface DecisionRecoveryVerdict {
  objectiveKey?: string | undefined;
  lowSignalState?: "none" | "elevated" | "exhausted" | undefined;
  recoveryExhausted?: boolean | undefined;
  hasLowSignalResearchStall?: boolean | undefined;
  lowYieldClusters?: Array<{
    sourceCluster: string;
    consecutiveLowYield: number;
    lastToolName?: string | undefined;
    lastQuality: "high" | "medium" | "low";
  }> | undefined;
  researchStall?: {
    eligible: boolean;
    active: boolean;
    lowProgressCycles: number;
    threshold: number;
  } | undefined;
}

export interface MemoryRecallEntry {
  kind: "working" | "episodic" | "semantic";
  key: string;
  summary: string;
  freshness?: "current" | "recent" | "stale" | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ToolOutcomeCacheEntry {
  toolName: string;
  inputHash: string;
  status: "success" | "error" | "blocked";
  summary: string;
  stepIndex: number;
  reusable: boolean;
  capabilityClasses: string[];
  output?: unknown;
  updatedAt: string;
}

export interface ReadOnlyResultDuplicateLedgerEntry {
  fingerprint: string;
  family: "web_search_results" | "web_page_content" | "source_search_results" | "source_page_content";
  toolName: string;
  canonicalSource?: string | undefined;
  canonicalUrl?: string | undefined;
  count: number;
  firstSeenStep: number;
  lastSeenStep: number;
  matchedPriorStep?: number | undefined;
  updatedAt: string;
}

export interface EvidencePack {
  facts: string[];
  toolOutcomes: Array<{
    toolName: string;
    status: "success" | "error" | "blocked";
    summary: string;
  }>;
  missingCapabilities: string[];
  nextBestEvidence: string[];
}

export interface ContextTelemetry {
  promptBudgetChars: number;
  estimatedChars: number;
  degradationMode: "full" | "compact" | "minimal";
  droppedSections: string[];
  previewTruncation?: Record<string, unknown> | undefined;
  previewClipping?: Record<string, unknown> | undefined;
  compactionState?: "idle" | "armed" | "applied" | "suppressed" | undefined;
  compactionReason?: string | undefined;
  manualCompactionApplied?: boolean | undefined;
}

export type ReactExecSubstate =
  | "dispatch"
  | "wait_effect"
  | "wait_approval"
  | "wait_user"
  | "collect"
  | "finalize";

export interface ReactExecState {
  substate?: ReactExecSubstate | undefined;
  pendingToolCall?: Record<string, unknown> | undefined;
  pendingBatch?: Record<string, unknown> | undefined;
  pendingApproval?: Record<string, unknown> | undefined;
  pendingAction?: Record<string, unknown> | undefined;
  pendingEffectKey?: string | undefined;
  pendingEffectType?: string | undefined;
  waitingForUser?: Record<string, unknown> | undefined;
  devShell?: {
    processId?: string | undefined;
    activeProcessId?: string | undefined;
    liveProcessIds?: string[] | undefined;
    status?: string | undefined;
    workspaceRoot?: string | undefined;
    lastReadNoProgress?: boolean | undefined;
    lastCompletedProcessId?: string | undefined;
    lastCompletedExitCode?: number | undefined;
    lastNonEmptyReadChunkBytes?: number | undefined;
    recentCommands?: string[] | undefined;
    processes?: Record<
      string,
      {
        processId?: string | undefined;
        command?: string | undefined;
        cwd?: string | undefined;
        workspaceRoot?: string | undefined;
        status?: string | undefined;
        submittedAt?: string | undefined;
        startedAt?: string | undefined;
        updatedAt?: string | undefined;
        completedAt?: string | undefined;
        exitCode?: number | undefined;
        chunkBytes?: number | undefined;
        truncated?: boolean | undefined;
        lastStdinPreview?: string | undefined;
        lastStdinAt?: string | undefined;
      }
    > | undefined;
    lastProcessInput?: {
      processId?: string | undefined;
      chars?: string | undefined;
    } | undefined;
    helperStall?: {
      processId?: string | undefined;
      command?: string | undefined;
      cwd?: string | undefined;
      workspaceRoot?: string | undefined;
      sourcePath?: string | undefined;
      requiredArtifact?: string | undefined;
      startedAt?: string | undefined;
      lastReadAt?: string | undefined;
      lastChunkBytes: 0;
      reason: "no_output_after_read";
      correction: "stop_or_replan_helper";
    } | undefined;
    helperOutcome?: HelperOutcome | undefined;
    lastCommand?: {
      command?: string | undefined;
      cwd?: string | undefined;
      workspaceRoot?: string | undefined;
      envMode?: string | undefined;
      requiredTools?: string[] | undefined;
    } | undefined;
  } | undefined;
}

export type ReactWaitKind = "effect" | "approval" | "user" | "region_merge";

export interface ReactWaitState {
  kind: ReactWaitKind;
  eventType: string;
  resumeStepAgent: string;
  resumeToken: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface ReactTerminalState {
  status: "WAITING" | "COMPLETED" | "FAILED";
  reasonCode: string;
  finalStepAgent: string;
  finalizedAt: string;
  outputRef?: string | undefined;
}

/** @deprecated work-item proof gates are no longer runtime authorities. */
export type SourceTruthRequirementStatus = "unknown" | "satisfied" | "missing" | "failed";

/** @deprecated work-item proof gates are no longer runtime authorities. */
export interface SourceTruthGoalRequirement {
  id: string;
  description: string;
  status?: SourceTruthRequirementStatus | undefined;
  sufficiencyChecks?: Array<Record<string, unknown>> | undefined;
}

/** @deprecated work-item proof gates are no longer runtime authorities. */
export interface SourceTruthGoal {
  summary?: string | undefined;
  requirements: SourceTruthGoalRequirement[];
}

/** @deprecated work-item proof gates are no longer runtime authorities. */
export type ReactWorkItem =
  | { phase: "gather_evidence"; [key: string]: unknown }
  | { phase: "derive_artifact"; sourcePath?: string | undefined; artifact?: { target: string }; [key: string]: unknown }
  | { phase: "verify_artifact"; sourcePath?: string | undefined; artifact: { target: string }; [key: string]: unknown }
  | { phase: "finalize"; [key: string]: unknown };

/** @deprecated work-item proof gates are no longer runtime authorities. */
export interface WorkItemEvidenceHistoryAttempt {
  kind: string;
  status?: string | undefined;
  target?: string | undefined;
  [key: string]: unknown;
}

/** @deprecated work-item proof gates are no longer runtime authorities. */
export interface WorkItemEvidenceHistoryBlocker {
  reason: string;
  [key: string]: unknown;
}

/** @deprecated work-item proof gates are no longer runtime authorities. */
export interface WorkItemEvidenceHistory {
  attempts: WorkItemEvidenceHistoryAttempt[];
  blockers: WorkItemEvidenceHistoryBlocker[];
}
