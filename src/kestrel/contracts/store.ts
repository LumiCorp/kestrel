import type {
  ProductProjectSetupState,
  ProductProjectSnapshot,
} from "../../project/contracts.js";
import type {
  MissionControlOutboxRecord,
  MissionControlProjectMutationInput,
  MissionControlProjectMutationResult,
  MissionControlProjectStateRecord,
} from "../../missionControl/projectAuthority.js";
import type {
  MissionControlLegacyProjectSource,
  MissionControlMigrationSourceBinding,
} from "../../missionControl/migrationContracts.js";
import type {
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointKind,
  WorkspaceCheckpointRole,
  WorkspaceDiffRecord,
  WorkspacePromotionRecord,
  WorkspaceRestoreRecord,
} from "../../workspaceCheckpoints/contracts.js";
import type {
  ClaimStatus,
  EffectExecutionStatus,
  EffectFailurePolicy,
  OutboxStatus,
  RuntimeError,
  StateNodeRef,
  TransitionStatus,
} from "./base.js";
import type {
  BudgetSnapshot,
  MemorySnapshot,
  RunEvent,
  RunLogEntry,
  RuntimeEvent,
  RuntimeEventIntent,
} from "./events.js";
import {
  parseAgentToolResultV2,
  parseDurablePreparedToolCallV1,
  parsePreparedToolCallV1,
  type AgentToolResultV2,
  type PreparedToolCallV1,
} from "./tool-invocation.js";
import { canonicalJson } from "./tool-contract.js";

export class SandboxCapabilityExactResultCancelledError extends Error {}
export class SandboxCapabilityExactResultConflictError extends Error {}
import type {
  ArtifactIntent,
  ClaimIntent,
  EffectResult,
  RegionWorkIntent,
  RegionWorkItem,
  ResolvedEffect,
} from "./execution.js";
import type {
  ApprovalGrantRecord,
  ApprovalGrantStatus,
  AssemblyBundleRecord,
  AssemblyChangeDecisionRecord,
  AssemblyChangeProposalRecord,
  AssemblyProposalStatus,
  ContextCheckpointRecord,
  ContextCheckpointStatus,
  ContextPolicyDefinitionRecord,
  ContextSummaryArtifactRecord,
  ConversationTurnSubmissionKind,
  ConversationTurnRecord,
  ConversationTurnSegmentRecord,
  ConversationTurnTerminalEnvelopeV1,
  ConversationTurnStatus,
  DelegationRecord,
  InteractionRequestRecord,
  InteractionRequestStatus,
  ModelCallProvenanceRecord,
  OperatorAttentionKind,
  OperatorAttentionRecord,
  OperatorAttentionStatus,
  OperatorFocusRecord,
  SpecialistDefinitionRecord,
  ThreadAssemblyRecord,
  ThreadCompactionEventRecord,
  ThreadRecord,
  ThreadStatus,
} from "./orchestration.js";
import type { SandboxCapabilityChildReservationV1, SandboxCapabilityLeaseTransitionRecordV1 } from "./sandbox-capability.js";

export interface LegacySessionArchive {
  sessionId: string;
  snapshot: Record<string, unknown>;
  reason: string;
  createdAt?: string | undefined;
}

export interface PersistedArtifact {
  artifactId: string;
  sessionId: string;
  runId: string;
  stepIndex: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface GetArtifactInput {
  artifactId: string;
  sessionId: string;
}

export interface ListArtifactsInput {
  sessionId: string;
  runId?: string | undefined;
  stepIndex?: number | undefined;
  type?: string | undefined;
  limit?: number | undefined;
}

export interface PersistedClaim {
  claimId: string;
  sessionId: string;
  runId: string;
  stepIndex: number;
  text: string;
  status: ClaimStatus;
  evidenceIds: string[];
  createdAt: string;
}

export interface SessionRecord {
  sessionId: string;
  version: number;
  state: Record<string, unknown>;
  currentStepAgent?: string | undefined;
  updatedAt: string;
}

export interface SessionProductStateRecord {
  sessionId: string;
  version: number;
  projectSnapshot: ProductProjectSnapshot;
  taskGraph: Record<string, unknown>;
  workspaceCheckpointState: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedRunRecord {
  runId: string;
  sessionId: string;
  eventType: string;
  status: TransitionStatus | "RUNNING";
  startedAt: string;
  completedAt?: string | undefined;
  error?: RuntimeError | undefined;
}

export interface PersistedMissionControlRunCorrelation {
  projectId: string;
  itemId: string;
  attemptId: string;
  commandId: string;
  runId: string;
}

export interface PersistedRunSummaryRecord {
  run: PersistedRunRecord;
  eventCount: number;
  threadId?: string | undefined;
  missionControl?: PersistedMissionControlRunCorrelation | undefined;
}

export interface PersistedRunStateRecord {
  runId: string;
  sessionId: string;
  version: number;
  baseVersion: number;
  state: Record<string, unknown>;
  deltaCount: number;
}

export interface ClaimConversationTurnExecutionInput {
  turnId: string;
  threadId: string;
  sessionId: string;
  turnRequestIdentity: string;
  submissionIdentity: string;
  submissionKind: ConversationTurnSubmissionKind;
  proposedRunId: string;
  eventType: string;
  segment: ConversationTurnSegmentRecord;
  startedAt: string;
}

export type ClaimConversationTurnExecutionResult =
  | { kind: "claimed"; runId: string }
  | { kind: "already_running"; runId: string }
  | { kind: "terminal"; terminalEnvelope: ConversationTurnTerminalEnvelopeV1 };

export interface UpdateConversationTurnTerminalEnvelopeInput {
  turnId: string;
  runId: string;
  terminalSubmissionIdentity: string;
  envelope: ConversationTurnTerminalEnvelopeV1;
}

export interface RunLifecycleSettlement {
  wait?: import("../../runtime/waitState.js").CanonicalRuntimeWaitingFor | undefined;
}

export type ProviderReasoningRecordKind = "continuation" | "retained_visible";

export interface ProviderReasoningEncryptedRecord {
  recordId: string;
  kind: ProviderReasoningRecordKind;
  runId: string;
  sessionId: string;
  turnId: string;
  retentionScope: string;
  provider: string;
  model: string;
  format?: string | undefined;
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
  createdAt: string;
  expiresAt: string;
}

export interface ProviderReasoningStore {
  appendProviderReasoningAccessAudit?(record: {
    runId: string;
    sessionId: string;
    actorId: string;
    actorRole: string;
    action: "read" | "delete" | "policy_change";
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void>;
  saveProviderReasoningRecord?(record: ProviderReasoningEncryptedRecord): Promise<void>;
  listProviderReasoningRecords?(input: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    turnId?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    kind?: ProviderReasoningRecordKind | undefined;
    includeExpired?: boolean | undefined;
  }): Promise<ProviderReasoningEncryptedRecord[]>;
  deleteProviderReasoningRecords?(input: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    turnId?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    kind?: ProviderReasoningRecordKind | undefined;
  }): Promise<number>;
  purgeExpiredProviderReasoning?(now?: string): Promise<number>;
  applyProviderReasoningRetentionPolicy?(input: {
    retentionScope: string;
    mode: "live_only" | "provider_visible";
    expiresAt: string;
  }): Promise<number>;
}

export interface PersistedEffect {
  runId: string;
  sessionId: string;
  stepIndex: number;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  failurePolicy: EffectFailurePolicy;
  status: EffectExecutionStatus;
  createdAt: string;
}

export interface OutboxEventRecord {
  id: number;
  runId: string;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attemptCount: number;
  lastError?: string | undefined;
  deliveredAt?: string | undefined;
  createdAt: string;
}

export interface CommitStepInput {
  runId: string;
  event: RuntimeEvent;
  sessionId: string;
  expectedVersion: number;
  stepAgent?: string | undefined;
  nextStepAgent?: string | undefined;
  statePatch?: Record<string, unknown> | undefined;
  effects: ResolvedEffect[];
  emitEvents: RuntimeEventIntent[];
  runLogs?: RunLogEntry[] | undefined;
  runEvents?: RunEvent[] | undefined;
  stateNode?: StateNodeRef | undefined;
  artifacts?: ArtifactIntent[] | undefined;
  claims?: ClaimIntent[] | undefined;
  memory?: MemorySnapshot | undefined;
  budget?: BudgetSnapshot | undefined;
  stepIndex: number;
}

export interface CommitStepResult {
  session: SessionRecord;
  persistedEffects: PersistedEffect[];
  persistedOutboxEventIds: number[];
  persistedArtifacts: PersistedArtifact[];
  persistedClaims: PersistedClaim[];
}

export interface RuntimeWorkspaceCheckpointService {
  capture(input: {
    sessionId: string;
    setup: ProductProjectSetupState;
    label?: string | undefined;
    reason?: string | undefined;
    kind?: WorkspaceCheckpointKind | undefined;
    threadId?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
    createdBy?: string | undefined;
    baseCheckpointId?: string | undefined;
    workspaceRole?: WorkspaceCheckpointRole | undefined;
    promotionId?: string | undefined;
    promotionPhase?: "pre" | "post" | undefined;
  }): Promise<WorkspaceCheckpointDetail>;
  diff(input: {
    sessionId: string;
    setup: ProductProjectSetupState;
    source: {
      checkpointId?: string | undefined;
      gitRef?: string | undefined;
      workingTree?: boolean | undefined;
    };
    target: {
      checkpointId?: string | undefined;
      gitRef?: string | undefined;
      workingTree?: boolean | undefined;
    };
    includeHunks?: boolean | undefined;
  }): Promise<WorkspaceDiffRecord>;
  restore(input: {
    sessionId: string;
    setup: ProductProjectSetupState;
    checkpointId: string;
    reason?: string | undefined;
    threadId?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
    restoredBy?: string | undefined;
    expectedWorkspaceRole?: WorkspaceCheckpointRole | undefined;
    promotionId?: string | undefined;
  }): Promise<WorkspaceRestoreRecord>;
  recordPromotion?(input: {
    promotion: WorkspacePromotionRecord;
  }): Promise<WorkspacePromotionRecord>;
  restoreLatestPromotion?(input: {
    sessionId: string;
    restoredBy?: string | undefined;
    reason?: string | undefined;
  }): Promise<WorkspaceRestoreRecord>;
}

export interface SessionRepository {
  getSession(sessionId: string): Promise<SessionRecord | null>;
  ensureSession(sessionId: string, initialStepAgent?: string): Promise<SessionRecord>;
  getSessionProductState?(sessionId: string): Promise<SessionProductStateRecord | null>;
  updateSessionProjectSnapshot?(input: {
    sessionId: string;
    graphVersion?: ProductProjectSnapshot["graphVersion"] | undefined;
    reason?: string | undefined;
    apply: (snapshot: ProductProjectSnapshot) => ProductProjectSnapshot | Promise<ProductProjectSnapshot>;
  }): Promise<SessionProductStateRecord>;
  saveSessionProjectSnapshot?(input: {
    sessionId: string;
    snapshot: ProductProjectSnapshot;
  }): Promise<SessionProductStateRecord>;
  patchSessionState(input: {
    sessionId: string;
    statePatch: Record<string, unknown>;
    expectedVersion?: number | undefined;
    nextStepAgent?: string | undefined;
    reason?: string | undefined;
  }): Promise<SessionRecord>;
  appendLegacyArchive(archive: LegacySessionArchive): Promise<void>;
}

export interface MissionControlProjectRepository {
  getMissionControlProjectState(
    projectId: string,
  ): Promise<MissionControlProjectStateRecord | null>;
  updateMissionControlProjectState(
    input: MissionControlProjectMutationInput,
  ): Promise<MissionControlProjectMutationResult>;
  listMissionControlLegacySources?(): Promise<MissionControlLegacyProjectSource[]>;
  listMissionControlMigrationSourceBindings?(): Promise<
    MissionControlMigrationSourceBinding[]
  >;
  listMissionControlOutbox(
    projectId: string,
  ): Promise<MissionControlOutboxRecord[]>;
  markMissionControlOutboxDelivered?(
    projectId: string,
    effectId: string,
  ): Promise<void>;
  recordMissionControlOutboxFailure?(
    projectId: string,
    effectId: string,
    error: string,
  ): Promise<void>;
}

export interface RunRepository {
  getRun(runId: string): Promise<PersistedRunRecord | null>;
  getRunState(runId: string): Promise<PersistedRunStateRecord | null>;
  listRuns(input?: {
    sessionId?: string | undefined;
    status?: TransitionStatus | "RUNNING" | undefined;
    limit?: number | undefined;
  }): Promise<PersistedRunRecord[]>;
  listRunSummaries(input?: {
    sessionId?: string | undefined;
    status?: TransitionStatus | "RUNNING" | undefined;
    limit?: number | undefined;
  }): Promise<PersistedRunSummaryRecord[]>;
  acquireRunLease(runId: string, sessionId: string): Promise<void>;
  releaseRunLease(runId: string, sessionId: string): Promise<void>;
  cancelActiveRun(sessionId: string, error?: RuntimeError): Promise<{ runId?: string | undefined }>;
  startRun(runId: string, event: RuntimeEvent): Promise<void>;
  validatePrestartedRun(runId: string, event: RuntimeEvent): Promise<void>;
  completeRun(
    runId: string,
    status: TransitionStatus,
    error?: RuntimeError,
    settlement?: RunLifecycleSettlement | undefined,
  ): Promise<void>;
}

export interface StepCommitStore {
  commitStep(input: CommitStepInput): Promise<CommitStepResult>;
}

export interface EffectStore {
  listPendingEffects(sessionId: string): Promise<PersistedEffect[]>;
  getPersistedEffect?(idempotencyKey: string): Promise<PersistedEffect | null>;
  getEffectResult(idempotencyKey: string): Promise<EffectResult | null>;
  claimEffectExecution(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
  ): Promise<"claimed" | "already_claimed" | "terminal">;
  resetPreparedApprovalCleanupEffectExecution(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
  ): Promise<"reset" | "done" | "conflict">;
  quarantineInvalidPreparedApprovalCleanupDoneEvidence(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
  ): Promise<"done" | "quarantined" | "conflict">;
  executePreparedApprovalCleanupInCriticalSection(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
    execute: () => Promise<EffectResult & { status: "DONE" }>,
  ): Promise<
    | { status: "executed"; result: EffectResult & { status: "DONE" } }
    | { status: "done"; result: EffectResult & { status: "DONE" } }
    | { status: "conflict" }
  >;
  commitPreparedApprovalCleanupEffectDone(
    idempotencyKey: string,
    owner: { runId: string; sessionId: string },
    result: EffectResult & { status: "DONE" },
  ): Promise<void>;
  saveEffectResult(runId: string, sessionId: string, result: EffectResult): Promise<void>;
  markEffectStatus(
    idempotencyKey: string,
    status: EffectExecutionStatus,
    owner: { runId: string; sessionId: string },
  ): Promise<void>;
  listReadyRegionWorkItems(sessionId: string): Promise<RegionWorkItem[]>;
  claimNextRegionWorkItem(sessionId: string, cursor?: string): Promise<RegionWorkItem | null>;
  completeRegionWorkItem(itemId: number, outcome: "DONE" | "FAILED", error?: Record<string, unknown>): Promise<void>;
  spawnRegionWorkItems(sessionId: string, items: RegionWorkIntent[]): Promise<void>;
}

export function validatePreparedApprovalCleanupDoneEvidence(input: {
  effect: PersistedEffect;
  result: EffectResult;
}): {
  preparedToolCall: PreparedToolCallV1;
  canonicalOutput: string;
} {
  const preparedToolCall = validatePreparedApprovalCleanupEffectIdentity(
    input.effect,
  );
  if (
    input.result.idempotencyKey !== input.effect.idempotencyKey ||
    input.result.status !== "DONE" ||
    input.result.error !== undefined ||
    typeof input.result.output !== "object" ||
    input.result.output === null ||
    Array.isArray(input.result.output)
  ) {
    throw new SandboxCapabilityExactResultConflictError(
      "Cleanup DONE evidence does not match the exact prepared invocation",
    );
  }
  const output = input.result.output as Record<string, unknown>;
  if (
    Object.keys(output).length !== 1 ||
    output.releasedPreparedInvocationId !== preparedToolCall.callId
  ) {
    throw new SandboxCapabilityExactResultConflictError(
      "Cleanup DONE output does not prove the exact prepared invocation release",
    );
  }
  return {
    preparedToolCall,
    canonicalOutput: canonicalJson(output),
  };
}

export function validatePreparedApprovalCleanupEffectIdentity(
  effect: PersistedEffect,
): PreparedToolCallV1 {
  if (effect.type !== "release_prepared_tool_call") {
    throw new SandboxCapabilityExactResultConflictError(
      "Cleanup DONE evidence requires a release effect",
    );
  }
  let preparedToolCall: PreparedToolCallV1;
  try {
    preparedToolCall = parseDurablePreparedToolCallV1(
      effect.payload.preparedToolCall,
    );
  } catch {
    throw new SandboxCapabilityExactResultConflictError(
      "Cleanup DONE evidence requires an exact durable prepared tool call",
    );
  }
  if (
    preparedToolCall.sessionId !== effect.sessionId ||
    `${preparedToolCall.callId}:release` !== effect.idempotencyKey
  ) {
    throw new SandboxCapabilityExactResultConflictError(
      "Cleanup DONE evidence does not match the exact prepared invocation",
    );
  }
  return preparedToolCall;
}

export function quarantinePreparedApprovalCleanupDoneResult(
  result: EffectResult,
): EffectResult {
  return {
    idempotencyKey: result.idempotencyKey,
    status: "FAILED",
    error: {
      code: "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
      message:
        "Prepared approval cleanup DONE evidence was invalid and quarantined for retry.",
      details: { retryable: true, quarantined: true },
    },
    timestamp: result.timestamp,
  };
}

export type ExactEffectResultRead =
  | { status: "found"; result: AgentToolResultV2 }
  | { status: "not_found" }
  | { status: "incomplete" }
  | { status: "conflict" };

export type ExactEffectCancellationClaim =
  | { status: "cancelled" }
  | { status: "started" }
  | { status: "completed" }
  | { status: "not_found" }
  | { status: "conflict" };

export interface ExactEffectResultStore {
  readExactEffectResult(input: {
    sessionId: string;
    runId: string;
    idempotencyKey: string;
    tenantId: string;
  }): Promise<ExactEffectResultRead>;
  claimExactEffectCancellation(input: {
    sessionId: string;
    runId: string;
    idempotencyKey: string;
    tenantId: string;
  }): Promise<ExactEffectCancellationClaim>;
}

export function validateExactEffectCancellationCandidate(input: {
  requested: { sessionId: string; runId: string; idempotencyKey: string };
  effect: PersistedEffect | null;
}): "ready" | "not_found" | "conflict" {
  const { requested, effect } = input;
  if (effect === null) return "not_found";
  if (
    effect.sessionId !== requested.sessionId ||
    effect.runId !== requested.runId ||
    effect.idempotencyKey !== requested.idempotencyKey
  ) return "not_found";
  if (effect.type !== "execute_tool_call") return "conflict";
  let prepared;
  try { prepared = parsePreparedToolCallV1(effect.payload.preparedToolCall); } catch { return "conflict"; }
  if (
    prepared.sessionId !== requested.sessionId ||
    prepared.callId !== requested.idempotencyKey
  ) return "conflict";
  return "ready";
}

export function validateExactEffectCancellationTenantBinding(input: {
  requested: { sessionId: string; runId: string; idempotencyKey: string; tenantId: string };
  lease: SandboxCapabilityLeaseTransitionRecordV1 | null;
}): "ready" | "not_found" | "conflict" {
  if (input.lease === null) return "conflict";
  const binding = input.lease.binding;
  if (
    binding.tenantId !== input.requested.tenantId ||
    binding.sessionId !== input.requested.sessionId ||
    binding.runId !== input.requested.runId ||
    binding.toolCallId !== input.requested.idempotencyKey
  ) return "not_found";
  return "ready";
}

export function exactEffectRequiresCapabilityTenantBinding(
  effect: PersistedEffect,
): boolean {
  const prepared = parsePreparedToolCallV1(effect.payload.preparedToolCall);
  return Object.prototype.hasOwnProperty.call(prepared.effectiveInput, "capability");
}

export function validateExactEffectResultRead(input: {
  requested: { sessionId: string; runId: string; idempotencyKey: string };
  effect: PersistedEffect | null;
  effectResult: EffectResult | null;
}): ExactEffectResultRead {
  const { requested, effect, effectResult } = input;
  if (effect === null) return { status: "not_found" };
  if (
    effect.sessionId !== requested.sessionId ||
    effect.runId !== requested.runId ||
    effect.idempotencyKey !== requested.idempotencyKey
  ) return { status: "not_found" };
  if (effect.type !== "execute_tool_call") return { status: "conflict" };
  let prepared;
  try { prepared = parsePreparedToolCallV1(effect.payload.preparedToolCall); } catch { return { status: "conflict" }; }
  if (
    prepared.sessionId !== requested.sessionId ||
    prepared.callId !== requested.idempotencyKey
  ) return { status: "conflict" };
  if (effect.status !== "DONE" || effectResult === null) return { status: "incomplete" };
  if (effectResult.idempotencyKey !== requested.idempotencyKey) return { status: "conflict" };
  if (effectResult.status !== "DONE" || effectResult.output === undefined) return { status: "incomplete" };
  let result: AgentToolResultV2;
  try { result = parseAgentToolResultV2(effectResult.output); } catch { return { status: "conflict" }; }
  if (
    result.toolCallId !== requested.idempotencyKey ||
    result.toolName !== prepared.activation.descriptor.toolId ||
    result.outcome.callId !== requested.idempotencyKey ||
    canonicalJson(result.activation) !== canonicalJson(prepared.activation) ||
    canonicalJson(result.outcome.activation) !== canonicalJson(prepared.activation) ||
    canonicalJson(result.auditRecord.input) !== canonicalJson(prepared.effectiveInput)
  ) return { status: "conflict" };
  return { status: "found", result };
}

export function validateExactEffectResultTenantBinding(input: {
  read: ExactEffectResultRead;
  requested: { sessionId: string; runId: string; idempotencyKey: string; tenantId: string };
  lease: SandboxCapabilityLeaseTransitionRecordV1 | null;
}): ExactEffectResultRead {
  if (input.read.status !== "found") return input.read;
  const rawOutput = input.read.result.outcome.kind === "success" || input.read.result.outcome.kind === "partial"
    ? input.read.result.outcome.rawOutput
    : undefined;
  if (typeof rawOutput !== "object" || rawOutput === null || Array.isArray(rawOutput)) return { status: "conflict" };
  const replayEvidence = (rawOutput as Record<string, unknown>).capabilityReplayEvidence;
  if (typeof replayEvidence !== "object" || replayEvidence === null || Array.isArray(replayEvidence)) return { status: "conflict" };
  const leaseId = (replayEvidence as Record<string, unknown>).leaseId;
  if (typeof leaseId !== "string" || leaseId.length === 0 || input.lease === null || input.lease.leaseId !== leaseId) {
    return { status: "conflict" };
  }
  const binding = input.lease.binding;
  if (
    binding.tenantId !== input.requested.tenantId ||
    binding.sessionId !== input.requested.sessionId ||
    binding.runId !== input.requested.runId ||
    binding.toolCallId !== input.requested.idempotencyKey
  ) return { status: "not_found" };
  return input.read;
}

export interface OutboxStore {
  listUndeliveredOutbox(limit: number, runId?: string): Promise<OutboxEventRecord[]>;
  markOutboxDeliveredBatch(ids: number[]): Promise<void>;
  markOutboxAttemptFailedBatch(entries: Array<{ id: number; error: string }>): Promise<void>;
  markOutboxDelivered(id: number): Promise<void>;
  markOutboxAttemptFailed(id: number, error: string): Promise<void>;
}

export interface EventStore {
  appendRunLogsBatch(entries: RunLogEntry[]): Promise<void>;
  appendRunEventsBatch(events: RunEvent[]): Promise<void>;
  appendRunLog(entry: RunLogEntry): Promise<void>;
  appendRunEvent(event: RunEvent): Promise<void>;
  getReplayStream(input: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    threadId?: string | undefined;
    delegationId?: string | undefined;
    eventTypes?: RunEvent["type"][] | undefined;
    fromTimestamp?: string | undefined;
    toTimestamp?: string | undefined;
    limit?: number | undefined;
  }): Promise<RunEvent[]>;
  appendModelCallProvenance?(record: ModelCallProvenanceRecord): Promise<void>;
  updateModelCallProvenance?(input: {
    callId: string;
    status: ModelCallProvenanceRecord["status"];
    completedAt: string;
    latencyMs?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void>;
  listModelCallProvenance?(input?: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    turnId?: string | undefined;
    limit?: number | undefined;
  }): Promise<ModelCallProvenanceRecord[]>;
}

export interface SandboxCapabilityLeaseStore {
  appendSandboxCapabilityLeaseTransition(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1>;
  issueSandboxCapabilityLease(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
    childReservation?: SandboxCapabilityChildReservationV1 | undefined;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1>;
  reserveSandboxCapabilityInvocation(input: {
    expectedSequence: number;
    record: SandboxCapabilityLeaseTransitionRecordV1;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1 & { invocationResponseByteLimit: number }>;
  /** Atomically persists the exact DONE result and transitions its owning effect to DONE. */
  saveSandboxCapabilityEffectResult(input: {
    leaseId: string;
    bindingDigest: string;
    toolCallId: string;
    runId: string;
    sessionId: string;
    result: EffectResult;
    signal?: AbortSignal | undefined;
  }): Promise<void>;
  getSandboxCapabilityLease(leaseId: string): Promise<SandboxCapabilityLeaseTransitionRecordV1 | null>;
  listSandboxCapabilityLeaseTransitions(leaseId: string): Promise<SandboxCapabilityLeaseTransitionRecordV1[]>;
  listRecoverableSandboxCapabilityLeases(input: {
    before: string;
    limit?: number | undefined;
  }): Promise<SandboxCapabilityLeaseTransitionRecordV1[]>;
  reserveSandboxCapabilityChild(input: {
    expectedParentSequence: number;
    reservation: SandboxCapabilityChildReservationV1;
  }): Promise<SandboxCapabilityChildReservationV1>;
  settleSandboxCapabilityChild(input: {
    reservationId: string;
    expectedSequence: number;
    status: "committed" | "released";
    requestsCommitted: number;
    responseBytesCommitted: number;
    reason?: string | undefined;
    occurredAt: string;
  }): Promise<SandboxCapabilityChildReservationV1>;
  getSandboxCapabilityChildReservation(reservationId: string): Promise<SandboxCapabilityChildReservationV1 | null>;
  listSandboxCapabilityChildReservations(parentLeaseId: string): Promise<SandboxCapabilityChildReservationV1[]>;
}

export interface ArtifactStore {
  appendArtifacts(
    runId: string,
    sessionId: string,
    stepIndex: number,
    artifacts: ArtifactIntent[],
  ): Promise<PersistedArtifact[]>;
  getArtifact(input: GetArtifactInput): Promise<PersistedArtifact | null>;
  listArtifacts(input: ListArtifactsInput): Promise<PersistedArtifact[]>;
  appendClaims(
    runId: string,
    sessionId: string,
    stepIndex: number,
    claims: ClaimIntent[],
  ): Promise<PersistedClaim[]>;
}

export interface ThreadStore {
  upsertConversationTurn?(record: ConversationTurnRecord): Promise<void>;
  appendConversationTurnSegment?(record: ConversationTurnSegmentRecord): Promise<void>;
  getConversationTurn?(turnId: string): Promise<ConversationTurnRecord | null>;
  listConversationTurns?(input?: {
    threadId?: string | undefined;
    sessionId?: string | undefined;
    status?: ConversationTurnStatus | undefined;
    completedAfter?: { completedAt: string; turnId: string } | undefined;
    terminalMessagesOnly?: boolean | undefined;
    terminalOutcomesOnly?: boolean | undefined;
    limit?: number | undefined;
  }): Promise<ConversationTurnRecord[]>;
  listConversationTurnSegments?(turnId: string): Promise<ConversationTurnSegmentRecord[]>;
  upsertThread(thread: ThreadRecord): Promise<void>;
  updateThreadAfterRun(input: {
    thread: ThreadRecord;
    turnId: string;
    runId: string;
  }): Promise<boolean>;
  getThread(threadId: string): Promise<ThreadRecord | null>;
  listThreads(input?: {
    parentThreadId?: string | undefined;
    sessionId?: string | undefined;
    status?: ThreadStatus | undefined;
  }): Promise<ThreadRecord[]>;
  upsertDelegation(record: DelegationRecord): Promise<void>;
  getDelegation(delegationId: string): Promise<DelegationRecord | null>;
  getDelegationByChildThreadId(childThreadId: string): Promise<DelegationRecord | null>;
  listDelegations(input?: {
    parentThreadId?: string | undefined;
    childThreadId?: string | undefined;
    status?: DelegationRecord["status"] | undefined;
  }): Promise<DelegationRecord[]>;
  upsertInteractionRequest(record: InteractionRequestRecord): Promise<void>;
  getInteractionRequest(requestId: string): Promise<InteractionRequestRecord | null>;
  listInteractionRequests(input?: {
    threadId?: string | undefined;
    delegationId?: string | undefined;
    status?: InteractionRequestStatus | undefined;
  }): Promise<InteractionRequestRecord[]>;
  upsertApprovalGrant(record: ApprovalGrantRecord): Promise<void>;
  listApprovalGrants(input?: {
    threadId?: string | undefined;
    requestId?: string | undefined;
    status?: ApprovalGrantStatus | undefined;
  }): Promise<ApprovalGrantRecord[]>;
  upsertContextCheckpoint(record: ContextCheckpointRecord): Promise<void>;
  getContextCheckpoint(checkpointId: string): Promise<ContextCheckpointRecord | null>;
  listContextCheckpoints(input?: {
    threadId?: string | undefined;
    status?: ContextCheckpointStatus | undefined;
  }): Promise<ContextCheckpointRecord[]>;
  saveContextSummaryArtifact(record: ContextSummaryArtifactRecord): Promise<void>;
  listContextSummaryArtifacts(threadId: string): Promise<ContextSummaryArtifactRecord[]>;
  appendThreadCompactionEvent(record: ThreadCompactionEventRecord): Promise<void>;
  listThreadCompactionEvents(threadId: string): Promise<ThreadCompactionEventRecord[]>;
  upsertAssemblyBundle(record: AssemblyBundleRecord): Promise<void>;
  getAssemblyBundle(bundleId: string): Promise<AssemblyBundleRecord | null>;
  listAssemblyBundles(input?: { source?: AssemblyBundleRecord["source"] | undefined }): Promise<AssemblyBundleRecord[]>;
  appendThreadAssemblyRecord(record: ThreadAssemblyRecord): Promise<void>;
  listThreadAssemblyRecords(threadId: string): Promise<ThreadAssemblyRecord[]>;
  upsertAssemblyChangeProposal(record: AssemblyChangeProposalRecord): Promise<void>;
  getAssemblyChangeProposal(proposalId: string): Promise<AssemblyChangeProposalRecord | null>;
  listAssemblyChangeProposals(input?: {
    threadId?: string | undefined;
    status?: AssemblyProposalStatus | undefined;
  }): Promise<AssemblyChangeProposalRecord[]>;
  appendAssemblyChangeDecision(record: AssemblyChangeDecisionRecord): Promise<void>;
  listAssemblyChangeDecisions(input?: {
    threadId?: string | undefined;
    proposalId?: string | undefined;
  }): Promise<AssemblyChangeDecisionRecord[]>;
  upsertSpecialistDefinition(record: SpecialistDefinitionRecord): Promise<void>;
  listSpecialistDefinitions(): Promise<SpecialistDefinitionRecord[]>;
  upsertContextPolicyDefinition(record: ContextPolicyDefinitionRecord): Promise<void>;
  getContextPolicyDefinition?(contextPolicyId: string): Promise<ContextPolicyDefinitionRecord | null>;
  listContextPolicyDefinitions(): Promise<ContextPolicyDefinitionRecord[]>;
  upsertOperatorFocus(record: OperatorFocusRecord): Promise<void>;
  getOperatorFocus(sessionId: string): Promise<OperatorFocusRecord | null>;
  upsertOperatorAttention(record: OperatorAttentionRecord): Promise<void>;
  getOperatorAttention(attentionId: string): Promise<OperatorAttentionRecord | null>;
  listOperatorAttention(input?: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
    kind?: OperatorAttentionKind | undefined;
    status?: OperatorAttentionStatus | undefined;
  }): Promise<OperatorAttentionRecord[]>;
}

export interface AssemblyStore {
  upsertAssemblyBundle(record: AssemblyBundleRecord): Promise<void>;
  getAssemblyBundle(bundleId: string): Promise<AssemblyBundleRecord | null>;
  listAssemblyBundles(input?: { source?: AssemblyBundleRecord["source"] | undefined }): Promise<AssemblyBundleRecord[]>;
  appendThreadAssemblyRecord(record: ThreadAssemblyRecord): Promise<void>;
  listThreadAssemblyRecords(threadId: string): Promise<ThreadAssemblyRecord[]>;
  upsertAssemblyChangeProposal(record: AssemblyChangeProposalRecord): Promise<void>;
  getAssemblyChangeProposal(proposalId: string): Promise<AssemblyChangeProposalRecord | null>;
  listAssemblyChangeProposals(input?: {
    threadId?: string | undefined;
    status?: AssemblyProposalStatus | undefined;
  }): Promise<AssemblyChangeProposalRecord[]>;
  appendAssemblyChangeDecision(record: AssemblyChangeDecisionRecord): Promise<void>;
  listAssemblyChangeDecisions(input?: {
    threadId?: string | undefined;
    proposalId?: string | undefined;
  }): Promise<AssemblyChangeDecisionRecord[]>;
  upsertSpecialistDefinition(record: SpecialistDefinitionRecord): Promise<void>;
  listSpecialistDefinitions(): Promise<SpecialistDefinitionRecord[]>;
  upsertContextPolicyDefinition(record: ContextPolicyDefinitionRecord): Promise<void>;
  getContextPolicyDefinition?(contextPolicyId: string): Promise<ContextPolicyDefinitionRecord | null>;
  listContextPolicyDefinitions(): Promise<ContextPolicyDefinitionRecord[]>;
}

export interface RuntimeStore
  extends SessionRepository,
    RunRepository,
    StepCommitStore,
    EffectStore,
    OutboxStore,
    EventStore,
    ArtifactStore,
    ProviderReasoningStore {}

export interface ReplayStore
  extends SessionRepository,
    RunRepository,
    EventStore,
    ArtifactStore,
    ThreadStore,
    AssemblyStore {
  claimConversationTurnExecution(
    input: ClaimConversationTurnExecutionInput,
  ): Promise<ClaimConversationTurnExecutionResult>;
  updateConversationTurnTerminalEnvelope(
    input: UpdateConversationTurnTerminalEnvelopeInput,
  ): Promise<boolean>;
}

export interface SessionStore
  extends RuntimeStore,
    MissionControlProjectRepository,
    ThreadStore,
    AssemblyStore {
  readExactEffectResult?: ExactEffectResultStore["readExactEffectResult"];
  claimExactEffectCancellation?: ExactEffectResultStore["claimExactEffectCancellation"];
  recoverOrphanedActiveRun?(
    sessionId: string,
  ): Promise<{ runId?: string | undefined }>;
  claimConversationTurnExecution(
    input: ClaimConversationTurnExecutionInput,
  ): Promise<ClaimConversationTurnExecutionResult>;
  updateConversationTurnTerminalEnvelope(
    input: UpdateConversationTurnTerminalEnvelopeInput,
  ): Promise<boolean>;
}
