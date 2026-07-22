import type {
  RunnerCommandType as CanonicalRunnerCommandType,
  RunnerEventType as CanonicalRunnerEventType,
} from "@kestrel-agents/protocol";
import type {
  ClientCapabilities,
  McpStatusSnapshot,
  ProductProjectAction,
  ProductProjectSnapshot,
  ProductReviewAction,
  ProductReviewDetail,
  ProductReviewTarget,
  ProductTaskGraph,
  ProgressUpdateV1,
  AgentProgressUpdateV1,
  ModelReasoningUpdateV1,
  ManagedTaskWorktreeCleanupResult,
  ManagedTaskWorktreeBinding,
  ManagedTaskWorktreeLifecycleInspection,
  RunConsoleUpdateV1,
  RunLogEntry,
  RunToolUpdateV1,
  ToolExecutionClass,
  WorkspaceCheckpointCleanupPolicy,
  WorkspaceCheckpointCleanupResult,
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointRecord,
  WorkspaceDiffRecord,
  WorkspacePromotionPreview,
  WorkspacePromotionRecord,
  WorkspaceRestoreRecord,
  UserTerminalRecord,
  WorkspaceChangeMutation,
  WorkspaceChangeScope,
  WorkspaceDiffOptions,
  WorkspaceChangeSnapshot,
  WorkspaceFeedbackSnapshot,
  WorkspaceReviewSnapshot,
  WorkspaceValidationSnapshot,
  WorkspaceGitAction,
  WorkspaceGitSnapshot,
} from "../../src/index.js";
import type { RunTurnAttachment } from "../../src/kestrel/contracts/orchestration.js";
import type {
  OperatorInboxSnapshot,
  OperatorRunIndexView,
  OperatorRunStatus,
  OperatorRunView,
  OperatorThreadView,
} from "../../src/orchestration/contracts.js";
import type { VisibleTodoState } from "../../src/runtime/visibleTodos.js";
import type {
  DelegationTaskMeta,
  OperatorAssemblySummary,
  OperatorCheckpointSummary,
  OperatorChildBlockerChainSummary,
  OperatorChildBlockerSummary,
  OperatorFanInDispositionSummary,
  OperatorInboxSummary,
  OperatorSteeringSummary,
  OperatorSupervisedChildSummary,
  OperatorSupervisionSummary,
  TuiProfile,
} from "../contracts.js";
import type {
  JobInputV1,
  JobReplayPointerV1,
  JobRunResultV1,
} from "../job/contracts.js";
import type {
  RunTurnInput,
  RunTurnResult,
} from "../runtime/KestrelChatRuntime.js";

export type RunnerCommandType = CanonicalRunnerCommandType;

export type RunnerActorType = "end_user" | "operator" | "service";

export interface RunnerActorMetadata {
  actorId: string;
  actorType: RunnerActorType;
  displayName?: string | undefined;
  tenantId?: string | undefined;
  orgRole?: "member" | "org_admin" | undefined;
}

export interface RunnerCommandMetadata {
  actor?: RunnerActorMetadata | undefined;
  tenantId?: string | undefined;
  profile?: TuiProfile | undefined;
  durability?: "cancel_on_disconnect" | "continue_on_disconnect" | undefined;
}

export interface RunnerEventSubscriptionFilter {
  sessionId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  eventTypes?: RunnerEventType[] | undefined;
  sinceEventId?: string | undefined;
}

export interface RunnerEventSubscriptionRequest {
  filter: RunnerEventSubscriptionFilter;
  metadata?: RunnerCommandMetadata | undefined;
}

export interface RunnerCommandEnvelope<
  TType extends RunnerCommandType = RunnerCommandType,
> {
  id: string;
  type: TType;
  payload: RunnerCommandPayloadByType[TType];
  metadata?: RunnerCommandMetadata | undefined;
}

type TuiProfileReference =
  | {
      profile: TuiProfile;
      profileId?: never;
    }
  | {
      profile?: never;
      profileId: string;
    };

type JobInputBase = Omit<JobInputV1, "profile" | "profileId">;

type JobInputWithoutProfileReference = JobInputBase & {
  profile?: never;
  profileId?: never;
};

type JobInputWithProfileReference = JobInputBase & TuiProfileReference;

export type RunStartCommandPayload = TuiProfileReference & {
  turn: RunTurnInput;
};

export type JobRunCommandPayload =
  | (TuiProfileReference & {
      input: JobInputWithoutProfileReference;
    })
  | {
      profile?: never;
      profileId?: never;
      input: JobInputWithProfileReference;
    };

export type ProfileListCommandPayload = Record<string, never>;

export interface ProfileGetCommandPayload {
  profileId: string;
}

export interface RunCancelCommandPayload {
  sessionId: string;
  runId?: string | undefined;
  commandId?: string | undefined;
}

export interface SessionDescribeCommandPayload {
  sessionId: string;
}

export interface SessionStateCommandPayload {
  sessionId: string;
}

export interface RunnerPingCommandPayload {
  nonce?: string | undefined;
}

export interface OperatorInboxCommandPayload {
  sessionId?: string | undefined;
  threadId?: string | undefined;
}

export interface OperatorThreadCommandPayload {
  threadId: string;
}

export interface OperatorRunsCommandPayload {
  sessionId?: string | undefined;
  status?: OperatorRunStatus | undefined;
  limit?: number | undefined;
}

export interface OperatorRunCommandPayload {
  runId: string;
}

export interface OperatorRunReasoningCommandPayload {
  runId: string;
  sessionId: string;
  action?: "read" | "delete" | undefined;
}

export interface OperatorControlCommandPayload {
  action:
    | "approve"
    | "reject"
    | "reply"
    | "steer"
    | "retry"
    | "continue_waiting"
    | "focus_thread"
    | "resolve_context_checkpoint"
    | "approve_assembly_change"
    | "reject_assembly_change"
    | "spawn_child_thread"
    | "supersede_child_thread"
    | "resolve_fan_in_checkpoint"
    | "enqueue_follow_up"
    | "edit_follow_up"
    | "cancel_follow_up"
    | "resume_follow_up_queue";
  threadId: string;
  completionMode?: "terminal" | "accepted" | undefined;
  followUpId?: string | undefined;
  requestId?: string | undefined;
  proposalId?: string | undefined;
  checkpointId?: string | undefined;
  delegationId?: string | undefined;
  actionValue?:
    | "continue"
    | "compact"
    | "summarize_forward"
    | "handoff"
    | "split_into_child_thread"
    | "operator_checkpoint"
    | "accept"
    | "defer"
    | undefined;
  message?: string | undefined;
  attachments?: RunTurnAttachment[] | undefined;
  attachmentIds?: string[] | undefined;
  interactionMode?: "chat" | "plan" | "build" | undefined;
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
  title?: string | undefined;
  rolePrompt?: string | undefined;
  goal?: string | undefined;
  profileId?: string | undefined;
  provider?:
    | "openrouter"
    | "openai"
    | "anthropic"
    | "ollama"
    | "lmstudio"
    | undefined;
  model?: string | undefined;
  maxTurns?: number | undefined;
  maxRuntimeMs?: number | undefined;
  allowApprovalInheritance?: boolean | undefined;
  allowToolClasses?: ToolExecutionClass[] | undefined;
  allowCapabilities?: string[] | undefined;
}

export interface TaskGraphGetCommandPayload {
  sessionId: string;
  threadId?: string | undefined;
}

export interface TaskGraphUpdateCommandPayload {
  sessionId: string;
  graph: ProductTaskGraph;
  threadId?: string | undefined;
  expectedVersion?: number | undefined;
}

export interface ProjectSnapshotGetCommandPayload {
  sessionId: string;
}

export interface WorkspaceCheckpointCaptureCommandPayload {
  sessionId: string;
  label?: string | undefined;
  reason?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
}

export interface WorkspaceCheckpointListCommandPayload {
  sessionId: string;
}

export interface WorkspaceCheckpointInspectCommandPayload {
  sessionId: string;
  checkpointId: string;
}

export interface WorkspaceCheckpointDiffCommandPayload {
  sessionId: string;
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
}

export interface WorkspaceCheckpointRestoreCommandPayload {
  sessionId: string;
  checkpointId: string;
  reason?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
}

export interface WorkspaceCheckpointCleanupCommandPayload {
  sessionId: string;
  reason?: string | undefined;
  policyOverride?: Partial<WorkspaceCheckpointCleanupPolicy> | undefined;
}

export interface WorkspacePromotionUndoLatestCommandPayload {
  sessionId: string;
  reason?: string | undefined;
}

export interface WorkspacePromotionListCommandPayload {
  sessionId: string;
}

export interface WorkspacePromotionPreviewCommandPayload {
  sessionId: string;
  promotionId: string;
}

export interface WorkspacePromotionApplyCommandPayload {
  sessionId: string;
  promotionId: string;
  candidateFingerprint: string;
}

export interface WorkspaceManagedInspectCommandPayload {
  sessionId: string;
  threadId: string;
}

export interface WorkspaceManagedCleanupCommandPayload {
  sessionId: string;
  threadId: string;
  reason: string;
}

export interface WorkspaceManagedRestoreCommandPayload {
  sessionId: string;
  threadId: string;
  checkpointId: string;
  reason?: string | undefined;
}

export interface WorkspaceManagedSetupRetryCommandPayload {
  sessionId: string;
  threadId: string;
}

export interface UserTerminalStartCommandPayload {
  sessionId: string;
  threadId: string;
  cols?: number | undefined;
  rows?: number | undefined;
}

export interface UserTerminalListCommandPayload {
  sessionId: string;
  threadId?: string | undefined;
}

export interface UserTerminalReadCommandPayload {
  sessionId: string;
  terminalId: string;
  cursor?: number | undefined;
}

export interface UserTerminalWriteCommandPayload {
  sessionId: string;
  terminalId: string;
  data: string;
}

export interface UserTerminalResizeCommandPayload {
  sessionId: string;
  terminalId: string;
  cols: number;
  rows: number;
}

export interface UserTerminalStopCommandPayload {
  sessionId: string;
  terminalId: string;
}

export interface WorkspaceChangesInspectCommandPayload {
  sessionId: string;
  threadId: string;
  scope: WorkspaceChangeScope;
  options?: Partial<WorkspaceDiffOptions> | undefined;
}

export interface WorkspaceChangesMutateCommandPayload {
  sessionId: string;
  threadId: string;
  expectedFingerprint: string;
  scope?: WorkspaceChangeScope | undefined;
  options?: Partial<WorkspaceDiffOptions> | undefined;
  mutation: WorkspaceChangeMutation;
}
export interface WorkspaceFeedbackAddCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string }
export interface WorkspaceFeedbackListCommandPayload { sessionId: string; threadId: string }
export interface WorkspaceFeedbackRemoveCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; commentId: string }
export interface WorkspaceFeedbackSubmitCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; commentIds: string[] }
export interface WorkspaceReviewRunCommandPayload { sessionId: string; threadId: string; scope: WorkspaceChangeScope; mode?: "current_thread" | "detached_thread" | undefined; reviewerProfileId?: string | undefined; reviewerModel?: string | undefined }
export interface WorkspaceReviewListCommandPayload { sessionId: string; threadId: string }
export interface WorkspaceReviewUpdateCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; reviewId: string; findingId: string; action: "accept" | "dismiss" | "reopen" | "mark_fixed"; reason?: string | undefined }
export interface WorkspaceReviewSubmitCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; reviewId: string; findingIds: string[]; request: "address" | "more_evidence" | "verify" }
export interface WorkspaceValidationInspectCommandPayload { sessionId: string; threadId: string }
export interface WorkspaceValidationRunCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; actionId?: string | undefined; suiteId?: string | undefined }
export interface WorkspaceValidationCancelCommandPayload { sessionId: string; threadId: string; resultId: string }
export interface WorkspaceValidationSubmitCommandPayload { sessionId: string; threadId: string; resultIds: string[] }
export interface WorkspaceGitInspectCommandPayload { sessionId: string; threadId: string }
export interface WorkspaceGitActionCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; expectedHeadSha?: string | undefined; action: WorkspaceGitAction }

export interface ProjectSnapshotUpdateCommandPayload {
  sessionId: string;
  snapshot: ProductProjectSnapshot;
}

export type ProjectActionCommandPayload = ProductProjectAction;

export interface ProjectReviewGetCommandPayload {
  sessionId: string;
  target: ProductReviewTarget;
}

export interface ProjectReviewActionCommandPayload {
  sessionId: string;
  action: ProductReviewAction;
}

export type McpStatusCommandPayload = TuiProfileReference;

export type McpRefreshCommandPayload = TuiProfileReference;

export interface RunnerCommandPayloadByType {
  "profile.list": ProfileListCommandPayload;
  "profile.get": ProfileGetCommandPayload;
  "job.run": JobRunCommandPayload;
  "run.start": RunStartCommandPayload;
  "run.cancel": RunCancelCommandPayload;
  "session.describe": SessionDescribeCommandPayload;
  "session.state": SessionStateCommandPayload;
  "operator.inbox": OperatorInboxCommandPayload;
  "operator.thread": OperatorThreadCommandPayload;
  "operator.runs": OperatorRunsCommandPayload;
  "operator.run": OperatorRunCommandPayload;
  "operator.run.reasoning": OperatorRunReasoningCommandPayload;
  "operator.control": OperatorControlCommandPayload;
  "task.graph.get": TaskGraphGetCommandPayload;
  "task.graph.update": TaskGraphUpdateCommandPayload;
  "workspace.checkpoint.capture": WorkspaceCheckpointCaptureCommandPayload;
  "workspace.checkpoint.list": WorkspaceCheckpointListCommandPayload;
  "workspace.checkpoint.inspect": WorkspaceCheckpointInspectCommandPayload;
  "workspace.checkpoint.diff": WorkspaceCheckpointDiffCommandPayload;
  "workspace.checkpoint.restore": WorkspaceCheckpointRestoreCommandPayload;
  "workspace.checkpoint.cleanup": WorkspaceCheckpointCleanupCommandPayload;
  "workspace.promotion.list": WorkspacePromotionListCommandPayload;
  "workspace.promotion.preview": WorkspacePromotionPreviewCommandPayload;
  "workspace.promotion.apply": WorkspacePromotionApplyCommandPayload;
  "workspace.promotion.undo_latest": WorkspacePromotionUndoLatestCommandPayload;
  "workspace.managed.inspect": WorkspaceManagedInspectCommandPayload;
  "workspace.managed.cleanup": WorkspaceManagedCleanupCommandPayload;
  "workspace.managed.restore": WorkspaceManagedRestoreCommandPayload;
  "workspace.managed.setup.retry": WorkspaceManagedSetupRetryCommandPayload;
  "user.terminal.start": UserTerminalStartCommandPayload;
  "user.terminal.list": UserTerminalListCommandPayload;
  "user.terminal.read": UserTerminalReadCommandPayload;
  "user.terminal.write": UserTerminalWriteCommandPayload;
  "user.terminal.resize": UserTerminalResizeCommandPayload;
  "user.terminal.stop": UserTerminalStopCommandPayload;
  "workspace.changes.inspect": WorkspaceChangesInspectCommandPayload;
  "workspace.changes.mutate": WorkspaceChangesMutateCommandPayload;
  "workspace.feedback.add": WorkspaceFeedbackAddCommandPayload;
  "workspace.feedback.list": WorkspaceFeedbackListCommandPayload;
  "workspace.feedback.remove": WorkspaceFeedbackRemoveCommandPayload;
  "workspace.feedback.submit": WorkspaceFeedbackSubmitCommandPayload;
  "workspace.review.run": WorkspaceReviewRunCommandPayload;
  "workspace.review.list": WorkspaceReviewListCommandPayload;
  "workspace.review.update": WorkspaceReviewUpdateCommandPayload;
  "workspace.review.submit": WorkspaceReviewSubmitCommandPayload;
  "workspace.validation.inspect": WorkspaceValidationInspectCommandPayload;
  "workspace.validation.run": WorkspaceValidationRunCommandPayload;
  "workspace.validation.cancel": WorkspaceValidationCancelCommandPayload;
  "workspace.validation.submit": WorkspaceValidationSubmitCommandPayload;
  "workspace.git.inspect": WorkspaceGitInspectCommandPayload;
  "workspace.git.action": WorkspaceGitActionCommandPayload;
  "project.snapshot.get": ProjectSnapshotGetCommandPayload;
  "project.snapshot.update": ProjectSnapshotUpdateCommandPayload;
  "project.action": ProjectActionCommandPayload;
  "project.review.get": ProjectReviewGetCommandPayload;
  "project.review.action": ProjectReviewActionCommandPayload;
  "runner.ping": RunnerPingCommandPayload;
  "mcp.status": McpStatusCommandPayload;
  "mcp.refresh": McpRefreshCommandPayload;
}

export type RunnerEventType = CanonicalRunnerEventType;

export interface RunnerEventEnvelope<
  TType extends RunnerEventType = RunnerEventType,
> {
  id: string;
  type: TType;
  ts: string;
  runId?: string | undefined;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  commandId?: string | undefined;
  payload: RunnerEventPayloadByType[TType];
}

export type RunnerCommand = {
  [K in RunnerCommandType]: RunnerCommandEnvelope<K>;
}[RunnerCommandType];

export type RunnerEvent = {
  [K in RunnerEventType]: RunnerEventEnvelope<K>;
}[RunnerEventType];

export const RUN_STARTED_INTERACTION_MODES = ["chat", "plan", "build"] as const;

export const RUN_STARTED_ACT_SUBMODES = [
  "strict",
  "safe",
  "full_auto",
] as const;

export interface RunStartedEventPayload {
  sessionId: string;
  runId?: string | undefined;
  eventType: string;
  stepAgent?: string | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  interactionMode?: "chat" | "plan" | "build" | undefined;
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
  mcpContext?:
    | import("../../src/mcp/hosted-contracts.js").HostedMcpContext
    | undefined;
  clientCapabilities?: ClientCapabilities | undefined;
  executionPolicy?:
    | {
        toolClassPolicy?:
          | Partial<
              Record<
                "read_only" | "sandboxed_only" | "external_side_effect",
                boolean
              >
            >
          | undefined;
        capabilityPolicy?: Record<string, boolean> | undefined;
        approvalPolicy?:
          | {
              strictApprovalPerCall?: boolean | undefined;
            }
          | undefined;
      }
    | undefined;
  reasoningKeyReady?: boolean | undefined;
  reasoningKeyVersion?: number | undefined;
}

export interface JobStartedEventPayload {
  sessionId: string;
  threadId: string;
  profileId: string;
}

export interface JobProgressEventPayload {
  sessionId: string;
  threadId: string;
  runId?: string | undefined;
  stage: "accepted" | "runtime_progress" | "finalizing";
  message: string;
  update?: ProgressUpdateV1 | undefined;
}

export interface JobCompletedEventPayload {
  output: JobRunResultV1;
  replay: JobReplayPointerV1;
}

export interface JobFailedEventPayload {
  output: JobRunResultV1;
  replay?: JobReplayPointerV1 | undefined;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown> | undefined;
  };
}

export interface RunLogEventPayload {
  entry: RunLogEntry;
}

export interface RunConsoleEventPayload {
  update: RunConsoleUpdateV1;
}

export interface RunProgressEventPayload {
  update: ProgressUpdateV1;
}

export interface RunModelReasoningEventPayload {
  update: ModelReasoningUpdateV1;
}

export interface RunAgentProgressEventPayload {
  update: AgentProgressUpdateV1;
}

export interface RunToolEventPayload {
  update: RunToolUpdateV1;
}

export interface RunCancelledEventPayload {
  sessionId: string;
  runId?: string | undefined;
  result: RunTurnResult;
}

export interface RunCompletedEventPayload {
  result: RunTurnResult;
}

export interface RunFailedEventPayload {
  result: RunTurnResult;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown> | undefined;
  };
}

export interface RunnerErrorEventPayload {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface RunnerPongEventPayload {
  nonce?: string | undefined;
  sessionId?: string | undefined;
}

export interface SessionDescribedEventPayload {
  sessionId: string;
  version: number;
  threadId?: string | undefined;
  currentStepAgent?: string | undefined;
  updatedAt?: string | undefined;
  waitFor?: RunCompletedEventPayload["result"]["output"]["waitFor"] | undefined;
  activeAssembly?: OperatorAssemblySummary | undefined;
  operatorInbox?: OperatorInboxSummary | undefined;
  childBlocker?: OperatorChildBlockerSummary | undefined;
  childThreads?: OperatorSupervisedChildSummary[] | undefined;
  childBlockerChainDetails?: OperatorChildBlockerChainSummary[] | undefined;
  blockerChain?: string[] | undefined;
  dominantBlocker?: string | undefined;
  latestCheckpoint?: OperatorCheckpointSummary | undefined;
  latestCheckpointDisposition?: OperatorCheckpointSummary["status"] | undefined;
  latestFanInDisposition?: OperatorFanInDispositionSummary | undefined;
  latestSteering?: OperatorSteeringSummary | undefined;
  latestReasoning?:
    | import("../contracts.js").OperatorReasoningSummary
    | undefined;
  latestAdaptation?:
    | import("../contracts.js").OperatorAdaptationSummary
    | undefined;
  latestEvidenceRecovery?:
    | import("../contracts.js").OperatorEvidenceRecoverySummary
    | undefined;
  supervision?: OperatorSupervisionSummary | undefined;
  nextAction?: string | undefined;
  visibleTodos?: VisibleTodoState | undefined;
  contextPosture?: string | undefined;
  focusedThreadId?: string | undefined;
  operatorThreadView?: OperatorThreadView | undefined;
}

export interface SessionStateEventPayload {
  session: SessionDescribedEventPayload;
  version: number;
  graph: ProductTaskGraph;
}

export interface OperatorInboxEventPayload {
  inbox: OperatorInboxSnapshot;
}

export interface OperatorThreadEventPayload {
  view: OperatorThreadView;
}

export interface OperatorRunsEventPayload {
  view: OperatorRunIndexView;
}

export interface OperatorRunEventPayload {
  view: OperatorRunView;
}

export interface OperatorRunReasoningEventPayload {
  runId: string;
  entries: Array<{
    provider: string;
    model: string;
    format: string;
    text: string;
    createdAt: string;
    expiresAt: string;
  }>;
  action: "read" | "delete";
  deletedCount?: number | undefined;
  retention: "provider_visible";
  access: "org_admin";
}

export interface OperatorControlledEventPayload {
  sessionId?: string | undefined;
  threadId: string;
  disposition?: "accepted" | "completed" | undefined;
  runId?: string | undefined;
  inbox?: OperatorInboxSnapshot | undefined;
  view?: OperatorThreadView | undefined;
  result?: RunTurnResult | undefined;
}

export interface ProfileListedEventPayload {
  profiles: TuiProfile[];
}

export interface ProfileLoadedEventPayload {
  profile: TuiProfile;
}

export interface TaskUpdatedEventPayload {
  task: DelegationTaskMeta;
  kind: "spawned" | "waiting" | "completed" | "failed";
  assistantText: string | null;
  finalizedPayload?: unknown | undefined;
}

export interface TaskGraphEventPayload {
  sessionId: string;
  version: number;
  graph: ProductTaskGraph;
}

export interface WorkspaceCheckpointEventPayload {
  sessionId: string;
  operation:
    | "capture"
    | "list"
    | "inspect"
    | "diff"
    | "restore"
    | "cleanup"
    | "promotion.list"
    | "promotion.preview"
    | "promotion.apply"
    | "promotion.undo_latest"
    | "managed.inspect"
    | "managed.cleanup"
    | "managed.restore"
    | "managed.setup.retry";
  checkpoint?: WorkspaceCheckpointDetail | undefined;
  checkpoints?: WorkspaceCheckpointRecord[] | undefined;
  diff?: WorkspaceDiffRecord | undefined;
  restore?: WorkspaceRestoreRecord | undefined;
  cleanup?: WorkspaceCheckpointCleanupResult["cleanup"] | undefined;
  deletedCheckpoints?: WorkspaceCheckpointRecord[] | undefined;
  remainingCheckpointCount?: number | undefined;
  remainingBytes?: number | undefined;
  promotions?: WorkspacePromotionRecord[] | undefined;
  preview?: WorkspacePromotionPreview | undefined;
  promotion?: WorkspacePromotionRecord | undefined;
  managedInspection?: ManagedTaskWorktreeLifecycleInspection | undefined;
  managedCleanup?: ManagedTaskWorktreeCleanupResult | undefined;
  managedBinding?: ManagedTaskWorktreeBinding | undefined;
  cleanupCheckpoint?: WorkspaceCheckpointDetail | undefined;
}

export interface UserTerminalEventPayload {
  sessionId: string;
  operation: "start" | "list" | "read" | "write" | "resize" | "stop";
  terminal?: UserTerminalRecord | undefined;
  terminals?: UserTerminalRecord[] | undefined;
  output?: string | undefined;
  cursor?: number | undefined;
  nextCursor?: number | undefined;
  truncated?: boolean | undefined;
}

export interface WorkspaceChangesEventPayload {
  sessionId: string;
  threadId: string;
  operation: "inspect" | "mutate";
  snapshot: WorkspaceChangeSnapshot;
  previousFingerprint?: string | undefined;
  mutationOperation?: WorkspaceChangeMutation["operation"] | undefined;
}
export interface WorkspaceFeedbackEventPayload { sessionId: string; threadId: string; operation: "add" | "list" | "remove" | "submit"; snapshot: WorkspaceFeedbackSnapshot; submissionRunId?: string | undefined }
export interface WorkspaceReviewEventPayload { sessionId: string; threadId: string; operation: "run" | "list" | "update" | "submit"; snapshot: WorkspaceReviewSnapshot; runId?: string | undefined }
export interface WorkspaceValidationEventPayload { sessionId: string; threadId: string; operation: "inspect" | "run" | "cancel" | "submit"; snapshot: WorkspaceValidationSnapshot; runId?: string | undefined }
export interface WorkspaceGitEventPayload { sessionId: string; threadId: string; operation: "inspect" | "action"; snapshot: WorkspaceGitSnapshot }

export interface ProjectSnapshotEventPayload {
  sessionId: string;
  snapshot: ProductProjectSnapshot;
}

export interface ProjectReviewEventPayload {
  sessionId: string;
  detail: ProductReviewDetail;
}

export interface McpStatusEventPayload {
  status: McpStatusSnapshot;
}

export interface McpRefreshedEventPayload {
  status: McpStatusSnapshot;
}

export interface RunnerEventPayloadByType {
  "profile.listed": ProfileListedEventPayload;
  "profile.loaded": ProfileLoadedEventPayload;
  "job.started": JobStartedEventPayload;
  "job.progress": JobProgressEventPayload;
  "job.completed": JobCompletedEventPayload;
  "job.failed": JobFailedEventPayload;
  "run.started": RunStartedEventPayload;
  "run.cancelled": RunCancelledEventPayload;
  "run.tool.started": RunToolEventPayload;
  "run.tool.completed": RunToolEventPayload;
  "run.tool.failed": RunToolEventPayload;
  "run.log": RunLogEventPayload;
  "run.console": RunConsoleEventPayload;
  "run.progress": RunProgressEventPayload;
  "run.model.reasoning.started": RunModelReasoningEventPayload;
  "run.model.reasoning.delta": RunModelReasoningEventPayload;
  "run.model.reasoning.completed": RunModelReasoningEventPayload;
  "run.model.reasoning.failed": RunModelReasoningEventPayload;
  "run.model.reasoning.unavailable": RunModelReasoningEventPayload;
  "run.agent_progress": RunAgentProgressEventPayload;
  "run.completed": RunCompletedEventPayload;
  "run.failed": RunFailedEventPayload;
  "runner.error": RunnerErrorEventPayload;
  "runner.pong": RunnerPongEventPayload;
  "session.described": SessionDescribedEventPayload;
  "session.state": SessionStateEventPayload;
  "operator.inbox": OperatorInboxEventPayload;
  "operator.thread": OperatorThreadEventPayload;
  "operator.runs": OperatorRunsEventPayload;
  "operator.run": OperatorRunEventPayload;
  "operator.run.reasoning": OperatorRunReasoningEventPayload;
  "operator.controlled": OperatorControlledEventPayload;
  "task.updated": TaskUpdatedEventPayload;
  "task.graph": TaskGraphEventPayload;
  "workspace.checkpoint": WorkspaceCheckpointEventPayload;
  "user.terminal": UserTerminalEventPayload;
  "workspace.changes": WorkspaceChangesEventPayload;
  "workspace.feedback": WorkspaceFeedbackEventPayload;
  "workspace.review": WorkspaceReviewEventPayload;
  "workspace.validation": WorkspaceValidationEventPayload;
  "workspace.git": WorkspaceGitEventPayload;
  "project.snapshot": ProjectSnapshotEventPayload;
  "project.review": ProjectReviewEventPayload;
  "mcp.status": McpStatusEventPayload;
  "mcp.refreshed": McpRefreshedEventPayload;
}

export function isRunnerCommandEnvelope(
  value: unknown
): value is RunnerCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    record.payload !== undefined
  );
}
