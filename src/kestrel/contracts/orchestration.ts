import type {
  CapabilityPackId,
  ShellKind,
  ShellPresetId,
} from "../../profile/runtimeProfile.js";
import type { TransitionStatus } from "./base.js";
import type {
  NormalizedOutput,
  WaitForMatcher,
} from "./execution.js";

export type ThreadStatus = "IDLE" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
export type DelegationStatus = "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type InteractionRequestKind = "approval" | "user_input";
export type InteractionRequestStatus = "PENDING" | "RESOLVED" | "CANCELLED";
export type ApprovalScope = "turn" | "delegation_turn";
export type ApprovalGrantStatus = "ACTIVE" | "EXPIRED" | "REVOKED";
export type ContextCheckpointStatus = "PENDING" | "ACCEPTED" | "DEFERRED" | "REJECTED";
export type ContextCheckpointAction =
  | "continue"
  | "compact"
  | "summarize_forward"
  | "handoff"
  | "split_into_child_thread"
  | "operator_checkpoint";
export type AssemblyAuthority = "profile" | "policy" | "operator" | "model";
export type AssemblyChangeCause =
  | "thread_start"
  | "turn_start"
  | "proposal"
  | "capability_loss"
  | "policy_change"
  | "context_pressure"
  | "inheritance";
export type AssemblyProposalStatus = "PENDING" | "APPROVED" | "REJECTED";
export type AssemblyDecisionResult = "ALLOWED" | "APPROVAL_REQUIRED" | "REJECTED";

export interface AssemblyBundleRecord {
  bundleId: string;
  label: string;
  source: "profile_default" | "thread_inherited" | "proposal" | "runtime_derived";
  toolAllowlist: string[];
  specialistIds: string[];
  contextPolicyId?: string | undefined;
  approvalPolicyId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadAssemblyRecord {
  recordId: string;
  threadId: string;
  bundleId: string;
  cause: AssemblyChangeCause;
  authority: AssemblyAuthority;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
}

export interface AssemblyChangeProposalRecord {
  proposalId: string;
  threadId: string;
  requestedBundleId?: string | undefined;
  requestedToolAllowlist?: string[] | undefined;
  requestedProvider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
  requestedModel?: string | undefined;
  requestedPromptVariant?: string | undefined;
  requestedSpecialistIds?: string[] | undefined;
  requestedContextPolicyId?: string | undefined;
  requestedApprovalPolicyId?: string | undefined;
  proposedBy: "operator" | "model" | "policy";
  status: AssemblyProposalStatus;
  reason?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  resolvedAt?: string | undefined;
}

export interface AssemblyChangeDecisionRecord {
  decisionId: string;
  threadId: string;
  proposalId?: string | undefined;
  result: AssemblyDecisionResult;
  decidedBy: "policy" | "operator";
  reason: string;
  resultingBundleId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
}

export interface SpecialistDefinitionRecord {
  specialistId: string;
  label: string;
  description?: string | undefined;
  allowedToolAllowlist: string[];
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ContextPolicyDefinitionRecord {
  contextPolicyId: string;
  label: string;
  defaultAction: ContextCheckpointAction;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadRecord {
  threadId: string;
  sessionId: string;
  title: string;
  status: ThreadStatus;
  agentProfileId?: string | undefined;
  agentProfileLabel?: string | undefined;
  environmentShellKind?: ShellKind | undefined;
  environmentPresetId?: ShellPresetId | undefined;
  environmentCapabilityPackIds?: CapabilityPackId[] | undefined;
  effectiveAssemblyId?: string | undefined;
  effectiveAssemblyLabel?: string | undefined;
  parentThreadId?: string | undefined;
  activeRunId?: string | undefined;
  currentRequestId?: string | undefined;
  lastRunStatus?: NormalizedOutput["status"] | undefined;
  waitFor?: NormalizedOutput["waitFor"] | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface SubAgentResultEnvelope {
  status: "completed" | "blocked" | "failed";
  result: string;
  references?: string[] | undefined;
  error?: {
    code: string;
    message: string;
  } | undefined;
}

export interface DelegationRecord {
  delegationId: string;
  parentThreadId: string;
  childThreadId: string;
  parentRunId?: string | undefined;
  childRunId?: string | undefined;
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
  title: string;
  prompt: string;
  status: DelegationStatus;
  profileId?: string | undefined;
  provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
  model?: string | undefined;
  skillPackId?: string | undefined;
  launchedBy?: "operator" | "agent" | undefined;
  waitEventType?: string | undefined;
  result?: SubAgentResultEnvelope | undefined;
  resultSummary?: string | undefined;
  errorMessage?: string | undefined;
  resultContract?: string | undefined;
  policy?: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface InteractionRequestRecord {
  requestId: string;
  threadId: string;
  runId?: string | undefined;
  kind: InteractionRequestKind;
  status: InteractionRequestStatus;
  eventType: string;
  delegationId?: string | undefined;
  waitKind?: WaitForMatcher["kind"] | undefined;
  prompt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  response?: Record<string, unknown> | undefined;
  createdAt: string;
  resolvedAt?: string | undefined;
}

export interface ApprovalGrantRecord {
  grantId: string;
  threadId: string;
  requestId: string;
  delegationId?: string | undefined;
  scope: ApprovalScope;
  status: ApprovalGrantStatus;
  allowedToolClasses: string[];
  allowedCapabilities: string[];
  expiresAt?: string | undefined;
  issuedBy: string;
  issuedAt: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface ContextCheckpointRecord {
  checkpointId: string;
  threadId: string;
  runId?: string | undefined;
  status: ContextCheckpointStatus;
  recommendedAction: ContextCheckpointAction;
  reason: string;
  signals?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
  resolutionAction?: ContextCheckpointAction | undefined;
  resolvedBy?: string | undefined;
  createdAt: string;
  resolvedAt?: string | undefined;
}

export interface OperatorFocusRecord {
  sessionId: string;
  threadId: string;
  updatedAt: string;
  updatedBy?: string | undefined;
}

export type OperatorAttentionKind =
  | "context_checkpoint"
  | "child_thread_blocker"
  | "stalled_thread_attention";

export type OperatorAttentionStatus = "ACTIVE" | "RESOLVED" | "SUPERSEDED";

export interface OperatorAttentionRecord {
  attentionId: string;
  sessionId: string;
  threadId: string;
  kind: OperatorAttentionKind;
  status: OperatorAttentionStatus;
  title: string;
  detail?: string | undefined;
  checkpointId?: string | undefined;
  delegationId?: string | undefined;
  childThreadId?: string | undefined;
  recommendedAction?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | undefined;
}

export interface ContextSummaryArtifactRecord {
  artifactId: string;
  threadId: string;
  runId?: string | undefined;
  summary: string;
  source:
    | "manual_compaction"
    | "auto_compaction"
    | "policy_checkpoint"
    | "summarize_forward";
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
}

export type StructuredContextSummaryGenerator =
  | "deterministic"
  | "model"
  | "deterministic_fallback";

export interface StructuredContextSummaryV1 {
  version: "v1";
  objective: string;
  decisions: string[];
  completedWork: string[];
  openQuestions: string[];
  artifactsFiles: string[];
  blockers: string[];
  nextAction: string;
  sourceRunIds: string[];
  sourceThreadId?: string | undefined;
  sourceTurnId?: string | undefined;
  generatedAt: string;
  generatedBy: StructuredContextSummaryGenerator;
}

export interface ThreadCompactionEventRecord {
  eventId: string;
  threadId: string;
  runId?: string | undefined;
  action:
    | "compact"
    | "summarize_forward"
    | "operator_checkpoint"
    | "handoff"
    | "split_into_child_thread";
  reason: string;
  summaryArtifactId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
}

export type ConversationTurnStatus = "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
export type ConversationTurnSegmentKind =
  | "submission"
  | "resume"
  | "approval_reply"
  | "user_reply"
  | "system_resume";

export interface ConversationTurnRecord {
  turnId: string;
  threadId: string;
  sessionId: string;
  rootRunId?: string | undefined;
  status: ConversationTurnStatus;
  initialEventType: string;
  activeRunId?: string | undefined;
  terminalRunId?: string | undefined;
  terminalStatus?: TransitionStatus | undefined;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ConversationTurnSegmentRecord {
  segmentId: string;
  turnId: string;
  threadId: string;
  sessionId: string;
  runId: string;
  kind: ConversationTurnSegmentKind;
  eventType: string;
  requestId?: string | undefined;
  grantId?: string | undefined;
  messageHash: string;
  createdAt: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface ModelCallProvenanceRecord {
  callId: string;
  runId: string;
  sessionId: string;
  threadId?: string | undefined;
  turnId?: string | undefined;
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
  phase?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  responseFormat?: string | undefined;
  schemaName?: string | undefined;
  providerPayloadHash: string;
  componentHash: string;
  templateIds?: string[] | undefined;
  toolManifestHash?: string | undefined;
  assemblyId?: string | undefined;
  sourceBucketHashes?: Record<string, string> | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  completedAt?: string | undefined;
  latencyMs?: number | undefined;
  status: "REQUESTED" | "COMPLETED" | "FAILED";
}

export interface RunTurnAttachment {
  attachmentId: string;
  threadId?: string | undefined;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  kind: "image" | "text";
  createdAt?: string | undefined;
  data?: string | undefined;
  text?: string | undefined;
}
