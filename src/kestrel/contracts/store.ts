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
  getEffectResult(idempotencyKey: string): Promise<EffectResult | null>;
  saveEffectResult(runId: string, sessionId: string, result: EffectResult): Promise<void>;
  markEffectStatus(idempotencyKey: string, status: EffectExecutionStatus): Promise<void>;
  listReadyRegionWorkItems(sessionId: string): Promise<RegionWorkItem[]>;
  claimNextRegionWorkItem(sessionId: string, cursor?: string): Promise<RegionWorkItem | null>;
  completeRegionWorkItem(itemId: number, outcome: "DONE" | "FAILED", error?: Record<string, unknown>): Promise<void>;
  spawnRegionWorkItems(sessionId: string, items: RegionWorkIntent[]): Promise<void>;
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
