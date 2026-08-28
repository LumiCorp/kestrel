import type {
  CapabilityPackId,
  ShellKind,
  ShellPresetId,
} from "../../profile/runtimeProfile.js";
import type { RuntimeError, TransitionStatus } from "./base.js";
import type {
  NormalizedOutput,
  WaitForMatcher,
} from "./execution.js";
import type { HarnessEconomicsPolicyV1 } from "../../economics/contracts.js";
import type {
  RunnerExternalApprovalBinding,
  RunnerInteractionRequest,
} from "@kestrel-agents/protocol";
import type { RuntimeTurnActor } from "../../runtime/RuntimeTurn.js";
import {
  parseEffectiveModelContractV1,
  type EffectiveModelContractV1,
} from "../effective-model-contract.js";

export type ThreadStatus = "IDLE" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
export type DelegationStatus = "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type InteractionRequestKind = "approval" | "user_input";
export type InteractionRequestStatus = "PENDING" | "RESOLVED" | "CANCELLED";
export type ApprovalScope = "turn" | "delegation_turn";
export type ApprovalGrantStatus = "ACTIVE" | "CONSUMED" | "EXPIRED" | "REVOKED";
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
  | "profile_migration"
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
  economicsPolicy?: HarnessEconomicsPolicyV1 | undefined;
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
  interaction?: RunnerInteractionRequest | undefined;
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
  binding?: RunnerExternalApprovalBinding | undefined;
  decisionActor?: RuntimeTurnActor | undefined;
  authorityRevision?: string | undefined;
  consumedAt?: string | undefined;
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
export type ConversationTurnSubmissionKind = "initial" | "resume" | "steer" | "follow_up";
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

export interface ConversationTurnSuspensionEnvelopeV1 {
  version: "v1";
  turnRequestIdentity: string;
  submissionIdentity: string;
  runId: string;
  wait: import("../../runtime/waitState.js").CanonicalRuntimeWaitingFor;
}

export type ConversationTurnFinalizedPayloadV1 =
  | {
      storage: "inline";
      value: unknown;
      byteCount: number;
      sha256: string;
    }
  | {
      storage: "artifact";
      artifactId: string;
      byteCount: number;
      sha256: string;
    };

interface ConversationTurnTerminalEnvelopeBaseV1 {
  version: "v1";
  turnRequestIdentity: string;
  terminalSubmissionIdentity: string;
  runId: string;
  output?: NormalizedOutput | undefined;
}

export type ConversationTurnTerminalEnvelopeV1 =
  | (ConversationTurnTerminalEnvelopeBaseV1 & {
      status: "COMPLETED";
      handoff:
        | { state: "pending" }
        | {
            state: "delivered";
            assistantText: string;
            finalizedPayload?: ConversationTurnFinalizedPayloadV1 | undefined;
          }
        | {
            state: "failed";
            finalizationError: RuntimeError;
          };
    })
  | (ConversationTurnTerminalEnvelopeBaseV1 & {
      status: "FAILED";
      handoff:
        | { state: "pending" }
        | {
            state: "delivered";
            assistantText: null;
            finalizedPayload?: ConversationTurnFinalizedPayloadV1 | undefined;
          }
        | {
            state: "failed";
            finalizationError: RuntimeError;
          };
    });

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
  /**
   * Immutable, secret-free admission and terminal proof for this specific
   * call. Readers must use this captured binding rather than resolving the
   * model against the current registration catalog.
   */
  proof: ModelCallProofV1;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  completedAt?: string | undefined;
  latencyMs?: number | undefined;
  status: "REQUESTED" | "COMPLETED" | "FAILED";
}

export const MODEL_CALL_PROOF_V1 = "model_call_proof_v1" as const;

export interface ModelCallProofV1 {
  version: typeof MODEL_CALL_PROOF_V1;
  evidence: "captured" | "legacy";
  admission: "pending" | "admitted" | "pre_spend_rejected" | "unknown_legacy";
  /** The contract is only retained after a successful admission. */
  effectiveContract?: EffectiveModelContractV1 | undefined;
  /**
   * Directly derived from the admitted request requirements. These names are
   * an inspectable contract dimension, never an inferred model capability.
   */
  capabilities: ModelCallRequiredCapabilityV1[];
  terminal:
    | "pending"
    | "completed"
    | "pre_spend_rejected"
    | "provider_rejected"
    | "verifier_rejected"
    | "interrupted"
    | "unknown_legacy";
  validation: "not_requested" | "passed" | "failed" | "unknown_legacy";
  failureCode?: string | undefined;
  providerRequestId?: string | undefined;
}

export type ModelCallRequiredCapabilityV1 =
  | "structured_output"
  | "strict_schema"
  | "tools"
  | "required_tool_choice"
  | "strict_tool_inputs"
  | "streaming_terminal";

/**
 * Rebuilds the closed, secret-free proof shape before storage. Unknown fields
 * are intentionally discarded so a caller cannot smuggle model content or
 * credentials through the provenance ledger.
 */
export function parseModelCallProofV1(value: unknown): ModelCallProofV1 {
  const record = asRecord(value, "model call proof");
  const evidence = readEnum(record.evidence, ["captured", "legacy"] as const, "evidence");
  const admission = readEnum(
    record.admission,
    ["pending", "admitted", "pre_spend_rejected", "unknown_legacy"] as const,
    "admission",
  );
  const terminal = readEnum(
    record.terminal,
    ["pending", "completed", "pre_spend_rejected", "provider_rejected", "verifier_rejected", "interrupted", "unknown_legacy"] as const,
    "terminal",
  );
  const validation = readEnum(
    record.validation,
    ["not_requested", "passed", "failed", "unknown_legacy"] as const,
    "validation",
  );
  if (record.version !== MODEL_CALL_PROOF_V1) {
    throw new Error("model call proof version is invalid");
  }
  const capabilities = readModelCallRequiredCapabilities(record.capabilities);
  const effectiveContract = record.effectiveContract === undefined
    ? undefined
    : parseEffectiveModelContractV1(record.effectiveContract);
  if (evidence === "legacy" && effectiveContract !== undefined) {
    throw new Error("legacy model call proof must not claim an effective contract");
  }
  return {
    version: MODEL_CALL_PROOF_V1,
    evidence,
    admission,
    ...(effectiveContract !== undefined ? { effectiveContract } : {}),
    capabilities,
    terminal,
    validation,
    ...(readBoundedProofString(record.failureCode, "failureCode") !== undefined
      ? { failureCode: readBoundedProofString(record.failureCode, "failureCode") }
      : {}),
    ...(readBoundedProofString(record.providerRequestId, "providerRequestId") !== undefined
      ? { providerRequestId: readBoundedProofString(record.providerRequestId, "providerRequestId") }
      : {}),
  };
}

function readModelCallRequiredCapabilities(value: unknown): ModelCallRequiredCapabilityV1[] {
  if (!Array.isArray(value)) throw new Error("model call proof capabilities are invalid");
  const allowed = new Set<ModelCallRequiredCapabilityV1>([
    "structured_output",
    "strict_schema",
    "tools",
    "required_tool_choice",
    "strict_tool_inputs",
    "streaming_terminal",
  ]);
  const parsed = value.map((entry) => {
    if (typeof entry !== "string" || !allowed.has(entry as ModelCallRequiredCapabilityV1)) {
      throw new Error("model call proof capability is invalid");
    }
    return entry as ModelCallRequiredCapabilityV1;
  });
  return [...new Set(parsed)];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || allowed.includes(value as T) === false) {
    throw new Error(`model call proof ${label} is invalid`);
  }
  return value as T;
}

function readBoundedProofString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`model call proof ${label} is invalid`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new Error(`model call proof ${label} is invalid`);
  }
  return normalized;
}

export interface RunTurnAttachment {
  fileId?: string | undefined;
  attachmentId: string;
  threadId?: string | undefined;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  kind: "image" | "text" | "file";
  representationStatus:
    | "native_image"
    | "extracted_text"
    | "staged_file"
    | "metadata_only";
  createdAt?: string | undefined;
  data?: string | undefined;
  text?: string | undefined;
  textTruncated?: boolean | undefined;
  path?: string | undefined;
  sourceUrl?: string | undefined;
  sourceUrlExpiresAt?: string | undefined;
  metadataOnlyReason?: string | undefined;
}
