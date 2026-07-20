import type {
  NormalizedOutput,
} from "../kestrel/contracts/execution.js";
import type {
  AssemblyBundleRecord,
  AssemblyChangeDecisionRecord,
  AssemblyChangeProposalRecord,
  ApprovalGrantRecord,
  ContextCheckpointAction,
  ContextCheckpointRecord,
  ContextSummaryArtifactRecord,
  ContextPolicyDefinitionRecord,
  DelegationRecord,
  InteractionRequestRecord,
  RunTurnAttachment,
  SpecialistDefinitionRecord,
  ThreadCompactionEventRecord,
  ThreadAssemblyRecord,
  ThreadRecord,
} from "../kestrel/contracts/orchestration.js";
import type {
  SessionRecord,
  AssemblyStore,
  ThreadStore,
} from "../kestrel/contracts/store.js";
import type {
  ActSubmode,
  ExecutionPolicyOverride,
  InteractionMode,
  ToolExecutionClass,
} from "../mode/contracts.js";
import type { RuntimeTurnActor } from "../runtime/RuntimeTurn.js";
import type { RuntimeTurnInput } from "../runtime/RuntimeTurn.js";
import type { EvidenceRecoverySummary } from "../runtime/evidenceQuality.js";

export type ContextPolicyAction =
  | "continue"
  | "compact"
  | "summarize_forward"
  | "handoff"
  | "split_into_child_thread"
  | "operator_checkpoint";
export type ThreadEventType =
  | "thread.started"
  | "thread.turn_submitted"
  | "thread.turn_completed"
  | "thread.waiting"
  | "thread.failed"
  | "thread.follow_up_queued"
  | "thread.follow_up_cancelled"
  | "thread.follow_up_edited"
  | "thread.follow_up_queue_paused"
  | "thread.follow_up_queue_resumed"
  | "thread.follow_up_failed"
  | "delegation.requested"
  | "delegation.spawned"
  | "delegation.waiting"
  | "delegation.completed"
  | "delegation.failed"
  | "delegation.superseded"
  | "delegation.reconciled"
  | "interaction.requested"
  | "interaction.resolved"
  | "approval.granted"
  | "context.compaction_applied"
  | "context.checkpoint_auto_resolved"
  | "context.adaptation_applied";

export interface ChildThreadPolicy {
  allowApprovalInheritance?: boolean | undefined;
  allowedToolClasses?: ToolExecutionClass[] | undefined;
  allowedCapabilities?: string[] | undefined;
  maxTurns?: number | undefined;
  maxRuntimeMs?: number | undefined;
  depth?: number | undefined;
  maxDepth?: number | undefined;
  rootDelegationId?: string | undefined;
  parentTaskId?: string | undefined;
  sourceCheckpointId?: string | undefined;
  sourceMutationFanIn?: "manual" | undefined;
  supervision?: ChildThreadSupervisionPolicy | undefined;
}

export interface ChildThreadBudget {
  maxTurns?: number | undefined;
  maxRuntimeMs?: number | undefined;
  allowApprovalInheritance?: boolean | undefined;
}

export type SupervisionChildOutcomeState =
  | "running"
  | "blocked"
  | "partial"
  | "failed"
  | "completed"
  | "superseded";

export interface ChildThreadSupervisionPolicy {
  groupId: string;
  rolePrompt?: string | undefined;
  goal?: string | undefined;
  budget?: ChildThreadBudget | undefined;
  reconciliationIntent?: "auto_when_safe" | "manual_review" | undefined;
  resultState?: SupervisionChildOutcomeState | undefined;
  outcomeReason?: string | undefined;
  supersededAt?: string | undefined;
  supersededBy?: string | undefined;
  latestFanInDisposition?: "pending_checkpoint" | "auto_applied" | "accepted" | "deferred" | undefined;
  latestFanInCheckpointId?: string | undefined;
}

export interface DelegationRequest {
  parentThreadId: string;
  parentRunId?: string | undefined;
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
  title: string;
  prompt: string;
  profileId?: string | undefined;
  provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
  model?: string | undefined;
  skillPackId?: string | undefined;
  launchedBy?: "operator" | "agent" | undefined;
  resultContract?: string | undefined;
  policy?: ChildThreadPolicy | undefined;
}

export interface DelegationHandle {
  delegationId: string;
  childThreadId: string;
}

export interface DelegationSummaryArtifact {
  artifactId: string;
  delegationId: string;
  childThreadId: string;
  summary: string;
  payload?: Record<string, unknown> | undefined;
  createdAt: string;
}

export interface DelegationResult {
  delegation: DelegationRecord;
  summaryArtifact?: DelegationSummaryArtifact | undefined;
  finalizedPayload?: unknown | undefined;
}

export interface ThreadStartInput {
  threadId?: string | undefined;
  sessionId?: string | undefined;
  title: string;
  parentThreadId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface SubmitTurnInput {
  threadId: string;
  message: string;
  eventType: string;
  attachments?: RunTurnAttachment[] | undefined;
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  stepAgent?: string | undefined;
  resumeBlockedRun?: boolean | undefined;
  signal?: AbortSignal | undefined;
  manualCompaction?: boolean | undefined;
  autoCompaction?:
    | {
        enabled?: boolean | undefined;
        state?: string | undefined;
        suppressOnce?: boolean | undefined;
      }
    | undefined;
  metadata?: Record<string, unknown> | undefined;
  runtimeTurn?: RuntimeTurnInput | undefined;
}

export interface ThreadWaitDescriptor {
  waitFor: Exclude<NormalizedOutput["waitFor"], undefined>;
  request?: InteractionRequestRecord | undefined;
}

export interface SubmitTurnResult {
  thread: ThreadRecord;
  output: NormalizedOutput;
  assistantText: string | null;
  session?: SessionRecord | undefined;
  wait?: ThreadWaitDescriptor | undefined;
  finalizedPayload?: unknown | undefined;
  compactionAction?: ContextPolicyAction | undefined;
}

export interface ReplyToRequestInput {
  threadId: string;
  requestId: string;
  message: string;
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  signal?: AbortSignal | undefined;
  issuedBy?: string | undefined;
  allowedToolClasses?: ToolExecutionClass[] | undefined;
  allowedCapabilities?: string[] | undefined;
  approve?: boolean | undefined;
  attachments?: RunTurnAttachment[] | undefined;
  runtimeTurn?: RuntimeTurnInput | undefined;
}

export interface ResumeBlockedTurnInput {
  threadId: string;
  requestId: string;
  message: string;
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  signal?: AbortSignal | undefined;
  actor?: RuntimeTurnActor | undefined;
  attachments?: RunTurnAttachment[] | undefined;
  runtimeTurn?: RuntimeTurnInput | undefined;
}

export interface ThreadStatusSnapshot {
  thread: ThreadRecord;
  openRequests: InteractionRequestRecord[];
  activeGrants: ApprovalGrantRecord[];
  contextCheckpoints: ContextCheckpointRecord[];
  delegations: DelegationRecord[];
  activeAssembly?: ThreadAssemblyRecord | undefined;
  assemblyBundle?: AssemblyBundleRecord | undefined;
  latestSummary?: ContextSummaryArtifactRecord | undefined;
}

export type OperatorInboxItemKind =
  | "approval_request"
  | "user_input_request"
  | "context_checkpoint"
  | "child_thread_blocker"
  | "stalled_thread_attention"
  | "assembly_change_proposal"
  | "compatibility_downgrade_attention"
  | "fan_in_checkpoint"
  | "child_outcome_review";

export interface OperatorInboxItem {
  itemId: string;
  kind: OperatorInboxItemKind;
  threadId: string;
  sessionId: string;
  title: string;
  actionable: boolean;
  createdAt: string;
  requestId?: string | undefined;
  checkpointId?: string | undefined;
  delegationId?: string | undefined;
  childThreadId?: string | undefined;
  recommendedAction?: string | undefined;
  detail?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface OperatorBlockerSummary {
  kind: "wait" | "child_thread" | "checkpoint" | "stalled";
  summary: string;
  actionable: boolean;
  threadId?: string | undefined;
  childThreadId?: string | undefined;
  requestId?: string | undefined;
  checkpointId?: string | undefined;
  delegationId?: string | undefined;
  eventType?: string | undefined;
}

export interface OperatorChildBlockerChainEntry {
  threadId: string;
  title: string;
  status: ThreadRecord["status"];
  delegationId?: string | undefined;
  waitEventType?: string | undefined;
  reason?: string | undefined;
}

export interface OperatorNextActionSummary {
  kind:
    | "approve"
    | "reply"
    | "retry"
    | "focus_thread"
    | "resolve_context_checkpoint"
    | "resolve_fan_in_checkpoint"
    | "approve_assembly_change"
    | "switch_thread"
    | "wait";
  summary: string;
  threadId?: string | undefined;
  requestId?: string | undefined;
  checkpointId?: string | undefined;
  proposalId?: string | undefined;
  childThreadId?: string | undefined;
}

export interface OperatorContextPostureSummary {
  status: "healthy" | "checkpoint_pending" | "compacted" | "degraded" | "not_recorded";
  summary: string;
  checkpointId?: string | undefined;
  compactionState?: string | undefined;
}

export interface SupervisionChildSummary {
  delegationId: string;
  threadId: string;
  title: string;
  status: DelegationRecord["status"];
  outcomeState: SupervisionChildOutcomeState;
  actionable: boolean;
  updatedAt: string;
  rolePrompt?: string | undefined;
  goal?: string | undefined;
  result?: DelegationRecord["result"] | undefined;
  resultSummary?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  references?: string[] | undefined;
  waitEventType?: string | undefined;
  supersededAt?: string | undefined;
  latestFanInDisposition?: ChildThreadSupervisionPolicy["latestFanInDisposition"] | undefined;
  latestFanInCheckpointId?: string | undefined;
}

export interface OperatorChildResultSummary {
  threadId: string;
  title: string;
  status: SupervisionChildSummary["status"];
  updatedAt: string;
  delegationId?: string | undefined;
  taskId?: string | undefined;
  resultStatus?: NonNullable<DelegationRecord["result"]>["status"] | undefined;
  result?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  references?: string[] | undefined;
  waitEventType?: string | undefined;
}

export interface SupervisionSummary {
  groupId: string;
  status: "active" | "waiting_fan_in" | "auto_reconciled" | "accepted" | "deferred";
  childCount: number;
  activeCount: number;
  terminalCount: number;
  dominantBlockerDelegationId?: string | undefined;
  checkpointId?: string | undefined;
  nextAction?: string | undefined;
}

export interface FanInDispositionSummary {
  status: "not_recorded" | "pending_checkpoint" | "auto_applied" | "accepted" | "deferred";
  checkpointId?: string | undefined;
  summary?: string | undefined;
  selectedDelegationIds?: string[] | undefined;
  at?: string | undefined;
}

export interface AdaptationSummary {
  status: "auto_applied" | "pending_checkpoint" | "accepted" | "deferred" | "not_recorded";
  recommendedAction:
    | Exclude<ContextCheckpointAction, "continue">
    | "continue"
    | undefined;
  reason: string;
  sourceSignals?: Record<string, unknown> | undefined;
  checkpointId?: string | undefined;
  eventId?: string | undefined;
  summaryArtifactId?: string | undefined;
  childThreadId?: string | undefined;
  delegationId?: string | undefined;
  at: string;
}

export interface OperatorEvidenceRecoverySummary {
  family?: EvidenceRecoverySummary["family"] | undefined;
  attempts: number;
  consecutiveLowSignal: number;
  lowSignalAttempts: number;
  broadenedSearchUsed: boolean;
  targetedFetchUsed: boolean;
  latestQuality?: string | undefined;
  latestIssues?: string[] | undefined;
  terminalOutcome?: string | undefined;
}

export interface OperatorCheckpointDispositionSummary {
  status: ContextCheckpointRecord["status"];
  action?: ContextCheckpointAction | undefined;
  resolvedAt?: string | undefined;
  resolvedBy?: string | undefined;
}

export interface OperatorInboxSnapshot {
  focusThreadId?: string | undefined;
  items: OperatorInboxItem[];
  summary: {
    total: number;
    actionable: number;
    approvals: number;
    userInputs: number;
    checkpoints: number;
    childBlockers: number;
    stalled: number;
    assemblyProposals: number;
    compatibilityAlerts: number;
  };
}

export interface OperatorRuntimePlanSummary {
  phase?: string | undefined;
  currentChunk?: string | undefined;
  status?: string | undefined;
  expectedNextCommand?: string | undefined;
  waitReason?: string | undefined;
  blocker?: string | undefined;
  commandBatchId?: string | undefined;
  executionMode?: string | undefined;
  commandNames?: string[] | undefined;
  lastCheckpoint?: {
    substate?: string | undefined;
    currentStepAgent?: string | undefined;
    nextStepAgent?: string | undefined;
    updatedAtStepIndex?: number | undefined;
  } | undefined;
}

export const OPERATOR_RUN_VIEW_VERSION = "operator-run-v1" as const;

export type OperatorRunStatus = "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";

export type OperatorRunFailureClassification =
  | "approval_wait"
  | "user_input_wait"
  | "delegation_blocked"
  | "delegation_failed"
  | "scheduler_stall"
  | "compaction_checkpoint"
  | "loop_guard"
  | "capability_loss_pruned_tool"
  | "terminal_failure"
  | "unknown";

export interface OperatorRunTimelineEntry {
  seq: number;
  at: string;
  label: string;
  detail?: string | undefined;
  source: "engine" | "agent" | "wait" | "scheduler" | "terminal" | "tooling";
  step?: string | undefined;
  stepIndex?: number | undefined;
}

export interface OperatorRunView {
  version: typeof OPERATOR_RUN_VIEW_VERSION;
  run: {
    runId: string;
    sessionId: string;
    eventType: string;
    status: OperatorRunStatus;
    startedAt: string;
    completedAt?: string | undefined;
    error?: {
      code: string;
      message: string;
    } | undefined;
  };
  threadId?: string | undefined;
  summary: {
    eventCount: number;
    firstEventAt?: string | undefined;
    lastEventAt?: string | undefined;
    terminalStatus?: OperatorRunStatus | undefined;
    stepsObserved: number;
    progressToolCalls: number;
    waitingMilestones: number;
    truncated: boolean;
    requestedLimit?: number | undefined;
  };
  diagnosis: {
    status: OperatorRunStatus | "UNKNOWN" | "STALLED";
    finalStep?: string | undefined;
    terminalReasonCode?: string | undefined;
    actionable: boolean;
    dominantFailure?: {
      classification: OperatorRunFailureClassification;
      message: string;
    } | undefined;
    wait?: {
      kind: "approval" | "user_input" | "delegation" | "scheduler_wait" | "compaction_checkpoint" | "unknown";
      actionable: boolean;
      eventType?: string | undefined;
      threadId?: string | undefined;
      delegationId?: string | undefined;
      requestId?: string | undefined;
      enteredAt?: string | undefined;
    } | undefined;
    latestReasoning?: {
      message: string;
      at: string;
    } | undefined;
  };
  modelProvenance: {
    retention: "hash_only";
    callCount: number;
    actionCallCount: number;
    maintenanceCallCount: number;
    providers: string[];
    models: string[];
  };
  runtimePlan?: OperatorRuntimePlanSummary | undefined;
  timeline: OperatorRunTimelineEntry[];
}

export const OPERATOR_RUN_INDEX_VIEW_VERSION = "operator-run-index-v1" as const;

export interface OperatorRunIndexEntry {
  run: {
    runId: string;
    sessionId: string;
    eventType: string;
    status: OperatorRunStatus;
    startedAt: string;
    completedAt?: string | undefined;
    error?: {
      code: string;
      message: string;
    } | undefined;
  };
  threadId?: string | undefined;
  summary: {
    eventCount: number;
    truncated: boolean;
  };
  diagnosis: {
    status: OperatorRunStatus | "UNKNOWN" | "STALLED";
    finalStep?: string | undefined;
    terminalReasonCode?: string | undefined;
    actionable: boolean;
    dominantFailure?: {
      classification: OperatorRunFailureClassification;
      message: string;
    } | undefined;
    wait?: {
      kind: "approval" | "user_input" | "delegation" | "scheduler_wait" | "compaction_checkpoint" | "unknown";
      actionable: boolean;
      eventType?: string | undefined;
      threadId?: string | undefined;
      delegationId?: string | undefined;
      requestId?: string | undefined;
      enteredAt?: string | undefined;
    } | undefined;
  };
}

export interface OperatorSessionIndexEntry {
  sessionId: string;
  runCount: number;
  statusCounts: Record<OperatorRunStatus, number>;
  latestRunId: string;
  latestStatus: OperatorRunStatus;
  latestStartedAt: string;
}

export interface OperatorRunIndexView {
  version: typeof OPERATOR_RUN_INDEX_VIEW_VERSION;
  generatedAt: string;
  filters: {
    sessionId?: string | undefined;
    status?: OperatorRunStatus | undefined;
    limit: number;
  };
  hasMore: boolean;
  runs: OperatorRunIndexEntry[];
  sessions: OperatorSessionIndexEntry[];
}

export interface OperatorThreadView {
  thread: ThreadRecord;
  focusedThreadId?: string | undefined;
  parentThread?: ThreadRecord | undefined;
  childThreads: ThreadRecord[];
  supervision?: SupervisionSummary | undefined;
  childOutcomes?: SupervisionChildSummary[] | undefined;
  childResults?: OperatorChildResultSummary[] | undefined;
  latestFanInDisposition?: FanInDispositionSummary | undefined;
  activeWait?: import("../replay/RunReplayService.js").ActiveWaitReport | undefined;
  blocker?: OperatorBlockerSummary | undefined;
  childBlocker?: import("../replay/RunReplayService.js").ReplayDoctorReport["childBlocker"] | undefined;
  childBlockerChain: OperatorChildBlockerChainEntry[];
  latestSteering?: {
    message: string;
    issuedBy?: string | undefined;
    at: string;
    runId?: string | undefined;
  } | undefined;
  latestReasoning?: import("../replay/RunReplayService.js").ReplayDoctorReport["latestReasoning"] | undefined;
  activeTurn?: import("../replay/RunReplayService.js").ReplayTurnReport | undefined;
  modelProvenance?: import("../replay/RunReplayService.js").ReplayModelProvenanceSummary | undefined;
  operatorPhase?: "assemble" | "decide" | "act" | "observe" | "wait" | "finalize" | undefined;
  latestCheckpoint?: ContextCheckpointRecord | undefined;
  latestCheckpointDisposition?: OperatorCheckpointDispositionSummary | undefined;
  activeAssembly?: ThreadAssemblyRecord | undefined;
  assemblyBundle?: AssemblyBundleRecord | undefined;
  contextPosture?: OperatorContextPostureSummary | undefined;
  latestAdaptation?: AdaptationSummary | undefined;
  latestEvidenceRecovery?: OperatorEvidenceRecoverySummary | undefined;
  nextAction?: OperatorNextActionSummary | undefined;
  runtimePlan?: OperatorRuntimePlanSummary | undefined;
  activeRun?: {
    runId: string;
    status: "RUNNING" | "WAITING";
  } | undefined;
  followUpQueue?: FollowUpQueueView | undefined;
  inboxItems?: OperatorInboxItem[] | undefined;
}

export type FollowUpQueuePauseReason = "waiting" | "failed" | "cancelled" | "operator";

export interface FollowUpQueueEntry {
  followUpId: string;
  message: string;
  attachmentIds: string[];
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  createdAt: string;
  state: "queued" | "starting";
}

export interface FollowUpQueueView {
  state: "ready" | "paused";
  pauseReason?: FollowUpQueuePauseReason | undefined;
  items: FollowUpQueueEntry[];
}

export interface EnqueueFollowUpInput {
  threadId: string;
  followUpId: string;
  message: string;
  attachmentIds?: string[] | undefined;
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  issuedBy?: string | undefined;
}

export interface PendingSteerRecord {
  steerId: string;
  message: string;
  attachments?: RunTurnAttachment[] | undefined;
  issuedBy?: string | undefined;
  createdAt: string;
}

export interface SteerThreadInput {
  threadId: string;
  message: string;
  attachments?: RunTurnAttachment[] | undefined;
  issuedBy?: string | undefined;
}

export interface SteerThreadResult {
  thread: ThreadRecord;
  status: "queued" | "applied";
  result?: SubmitTurnResult | undefined;
  pendingSteer?: PendingSteerRecord | undefined;
}

export interface RetryThreadInput {
  threadId: string;
  reason?: string | undefined;
}

export interface FocusThreadInput {
  threadId: string;
}

export interface ResolveAssemblyProposalInput {
  threadId: string;
  proposalId: string;
  issuedBy?: string | undefined;
  reason?: string | undefined;
}

export interface SpawnChildThreadInput {
  threadId: string;
  prompt: string;
  title?: string | undefined;
  rolePrompt?: string | undefined;
  goal?: string | undefined;
  budget?: ChildThreadBudget | undefined;
  resultContract?: string | undefined;
  supervisionGroupId?: string | undefined;
  reconciliationIntent?: "auto_when_safe" | "manual_review" | undefined;
  profileId?: string | undefined;
  provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
  model?: string | undefined;
  skillPackId?: string | undefined;
  policy?: ChildThreadPolicy | undefined;
  issuedBy?: string | undefined;
}

export interface SupersedeChildThreadInput {
  threadId: string;
  delegationId: string;
  reason?: string | undefined;
  issuedBy?: string | undefined;
}

export interface ResolveFanInCheckpointInput {
  threadId: string;
  checkpointId: string;
  disposition: "accept" | "defer";
  selectedDelegationIds?: string[] | undefined;
  summary?: string | undefined;
  issuedBy?: string | undefined;
}

export interface ThreadRuntimeSubscription {
  unsubscribe(): void;
}

export interface ThreadRuntimeEvent {
  type: ThreadEventType;
  threadId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ThreadRuntimePort {
  startThread(input: ThreadStartInput): Promise<ThreadRecord>;
  ensureMainThreadForSession(input: {
    sessionId: string;
    title?: string | undefined;
  }): Promise<ThreadRecord>;
  submitTurn(input: SubmitTurnInput): Promise<SubmitTurnResult>;
  resumeBlockedTurn(input: ResumeBlockedTurnInput): Promise<SubmitTurnResult>;
  replyToRequest(input: ReplyToRequestInput): Promise<SubmitTurnResult>;
  spawnDelegation(input: DelegationRequest): Promise<DelegationHandle>;
  listDelegations(threadId: string): Promise<DelegationRecord[]>;
  getActiveAssembly(threadId: string): Promise<{
    record: ThreadAssemblyRecord;
    bundle?: AssemblyBundleRecord | undefined;
  } | null>;
  listAssemblyHistory(threadId: string): Promise<ThreadAssemblyRecord[]>;
  proposeAssemblyChange(input: {
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
    reason?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<{
    proposal: AssemblyChangeProposalRecord;
    decision: AssemblyChangeDecisionRecord;
    request?: InteractionRequestRecord | undefined;
    activeAssembly?: ThreadAssemblyRecord | undefined;
    bundle?: AssemblyBundleRecord | undefined;
  }>;
  listOperatorInbox(input: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
  }): Promise<OperatorInboxSnapshot>;
  listOperatorRuns?(input?: {
    sessionId?: string | undefined;
    status?: OperatorRunStatus | undefined;
    limit?: number | undefined;
  }): Promise<OperatorRunIndexView>;
  getOperatorThreadView(threadId: string): Promise<OperatorThreadView | null>;
  getOperatorRunView?(runId: string): Promise<OperatorRunView | null>;
  steerThread(input: SteerThreadInput): Promise<SteerThreadResult>;
  enqueueFollowUp(input: EnqueueFollowUpInput): Promise<OperatorThreadView>;
  editFollowUp(input: { threadId: string; followUpId: string; message: string }): Promise<OperatorThreadView>;
  cancelFollowUp(input: { threadId: string; followUpId: string }): Promise<OperatorThreadView>;
  pauseFollowUpQueue(input: { threadId: string; reason: FollowUpQueuePauseReason }): Promise<OperatorThreadView>;
  resumeFollowUpQueue(input: { threadId: string }): Promise<OperatorThreadView>;
  retryThread(input: RetryThreadInput): Promise<SubmitTurnResult>;
  continueWaiting(input: { threadId: string }): Promise<ThreadStatusSnapshot>;
  focusThread(input: FocusThreadInput): Promise<ThreadStatusSnapshot>;
  approveAssemblyChange(input: ResolveAssemblyProposalInput): Promise<SubmitTurnResult>;
  rejectAssemblyChange(input: ResolveAssemblyProposalInput): Promise<ThreadStatusSnapshot>;
  spawnChildThread(input: SpawnChildThreadInput): Promise<DelegationHandle>;
  supersedeChildThread(input: SupersedeChildThreadInput): Promise<ThreadStatusSnapshot>;
  resolveFanInCheckpoint(input: ResolveFanInCheckpointInput): Promise<ThreadStatusSnapshot>;
  listChildOutcomes(parentThreadId: string): Promise<SupervisionChildSummary[]>;
  getSupervisionView(threadId: string): Promise<SupervisionSummary | null>;
  resolveContextCheckpoint(input: {
    threadId: string;
    checkpointId: string;
    action: ContextCheckpointAction;
    issuedBy?: string | undefined;
  }): Promise<ThreadStatusSnapshot>;
  getThreadStatus(threadId: string): Promise<ThreadStatusSnapshot | null>;
  subscribe(
    target: { threadId?: string | undefined; groupId?: string | undefined },
    listener: (event: ThreadRuntimeEvent) => void,
  ): ThreadRuntimeSubscription;
}

export interface ContextPolicyDecision {
  action: ContextPolicyAction;
  reason: string;
  metadata?: Record<string, unknown> | undefined;
}

export type OrchestrationStore = ThreadStore & AssemblyStore;

export type {
  AssemblyBundleRecord,
  AssemblyChangeDecisionRecord,
  AssemblyChangeProposalRecord,
  ApprovalGrantRecord,
  ContextCheckpointAction,
  ContextCheckpointRecord,
  ContextSummaryArtifactRecord,
  ContextPolicyDefinitionRecord,
  DelegationRecord,
  InteractionRequestRecord,
  SpecialistDefinitionRecord,
  ThreadCompactionEventRecord,
  ThreadAssemblyRecord,
  ThreadRecord,
};

export interface TurnExecutionInput extends SubmitTurnInput {
  sessionId: string;
}

export interface TurnExecutionResult {
  output: NormalizedOutput;
  assistantText?: string | null | undefined;
  session?: SessionRecord | undefined;
  finalizedPayload?: unknown | undefined;
}

export interface TurnExecutor {
  executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
}
