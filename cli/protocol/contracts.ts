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
  ReasoningUpdateV1,
  RunConsoleUpdateV1,
  RunToolUpdateV1,
  RunLogEntry,
  ToolExecutionClass,
  WorkspaceCheckpointCleanupPolicy,
  WorkspaceCheckpointCleanupResult,
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointRecord,
  WorkspaceDiffRecord,
  WorkspaceRestoreRecord,
} from "../../src/index.js";
import type { RunnerRunStreamEventType } from "@kestrel-agents/protocol";
import type { DelegationTaskMeta, TuiProfile } from "../contracts.js";
import type { JobInputV1, JobReplayPointerV1, JobRunResultV1 } from "../job/contracts.js";
import type { OperatorAssemblySummary } from "../contracts.js";
import type { RunTurnAttachment } from "../../src/kestrel/contracts/orchestration.js";

import type {
  OperatorChildBlockerChainSummary,
  OperatorCheckpointSummary,
  OperatorChildBlockerSummary,
  OperatorFanInDispositionSummary,
  OperatorSupervisionSummary,
  OperatorSupervisedChildSummary,
  OperatorInboxSummary,
  OperatorSteeringSummary,
} from "../contracts.js";
import type { RunTurnInput, RunTurnResult } from "../runtime/KestrelChatRuntime.js";
import type {
  OperatorInboxSnapshot,
  OperatorRunIndexView,
  OperatorRunStatus,
  OperatorRunView,
  OperatorThreadView,
} from "../../src/orchestration/contracts.js";
import type { VisibleTodoState } from "../../src/runtime/visibleTodos.js";

export type RunnerCommandType =
  | "profile.list"
  | "profile.get"
  | "job.run"
  | "run.start"
  | "run.cancel"
  | "session.describe"
  | "session.state"
  | "operator.inbox"
  | "operator.thread"
  | "operator.runs"
  | "operator.run"
  | "operator.control"
  | "task.graph.get"
  | "task.graph.update"
  | "workspace.checkpoint.capture"
  | "workspace.checkpoint.list"
  | "workspace.checkpoint.inspect"
  | "workspace.checkpoint.diff"
  | "workspace.checkpoint.restore"
  | "workspace.checkpoint.cleanup"
  | "workspace.promotion.undo_latest"
  | "project.snapshot.get"
  | "project.snapshot.update"
  | "project.action"
  | "project.review.get"
  | "project.review.action"
  | "runner.ping"
  | "mcp.status"
  | "mcp.refresh";

export type RunnerActorType = "end_user" | "operator" | "service";

export interface RunnerActorMetadata {
  actorId: string;
  actorType: RunnerActorType;
  displayName?: string | undefined;
  tenantId?: string | undefined;
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

export interface RunnerCommandEnvelope<TType extends RunnerCommandType = RunnerCommandType> {
  id: string;
  type: TType;
  payload: RunnerCommandPayloadByType[TType];
  metadata?: RunnerCommandMetadata | undefined;
}

export interface RunStartCommandPayload {
  profile?: TuiProfile | undefined;
  profileId?: string | undefined;
  turn: RunTurnInput;
}

export interface JobRunCommandPayload {
  profile?: TuiProfile | undefined;
  profileId?: string | undefined;
  input: JobInputV1;
}

export interface ProfileListCommandPayload {}

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

export interface OperatorControlCommandPayload {
  action:
    | "approve"
    | "reject"
    | "reply"
    | "steer"
    | "retry"
    | "focus_thread"
    | "resolve_context_checkpoint"
    | "approve_assembly_change"
    | "reject_assembly_change"
    | "spawn_child_thread"
    | "supersede_child_thread"
    | "resolve_fan_in_checkpoint";
  threadId: string;
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
  title?: string | undefined;
  rolePrompt?: string | undefined;
  goal?: string | undefined;
  profileId?: string | undefined;
  provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
  model?: string | undefined;
  skillPackId?: string | undefined;
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

export interface McpStatusCommandPayload {
  profile?: TuiProfile | undefined;
  profileId?: string | undefined;
}

export interface McpRefreshCommandPayload {
  profile?: TuiProfile | undefined;
  profileId?: string | undefined;
}

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
  "operator.control": OperatorControlCommandPayload;
  "task.graph.get": TaskGraphGetCommandPayload;
  "task.graph.update": TaskGraphUpdateCommandPayload;
  "workspace.checkpoint.capture": WorkspaceCheckpointCaptureCommandPayload;
  "workspace.checkpoint.list": WorkspaceCheckpointListCommandPayload;
  "workspace.checkpoint.inspect": WorkspaceCheckpointInspectCommandPayload;
  "workspace.checkpoint.diff": WorkspaceCheckpointDiffCommandPayload;
  "workspace.checkpoint.restore": WorkspaceCheckpointRestoreCommandPayload;
  "workspace.checkpoint.cleanup": WorkspaceCheckpointCleanupCommandPayload;
  "workspace.promotion.undo_latest": WorkspacePromotionUndoLatestCommandPayload;
  "project.snapshot.get": ProjectSnapshotGetCommandPayload;
  "project.snapshot.update": ProjectSnapshotUpdateCommandPayload;
  "project.action": ProjectActionCommandPayload;
  "project.review.get": ProjectReviewGetCommandPayload;
  "project.review.action": ProjectReviewActionCommandPayload;
  "runner.ping": RunnerPingCommandPayload;
  "mcp.status": McpStatusCommandPayload;
  "mcp.refresh": McpRefreshCommandPayload;
}

export type RunnerEventType =
  | "profile.listed"
  | "profile.loaded"
  | "job.started"
  | "job.progress"
  | "job.completed"
  | "job.failed"
  | RunnerRunStreamEventType
  | "runner.error"
  | "runner.pong"
  | "session.described"
  | "session.state"
  | "operator.inbox"
  | "operator.thread"
  | "operator.runs"
  | "operator.run"
  | "operator.controlled"
  | "task.updated"
  | "task.graph"
  | "workspace.checkpoint"
  | "project.snapshot"
  | "project.review"
  | "mcp.status"
  | "mcp.refreshed";

export interface RunnerEventEnvelope<TType extends RunnerEventType = RunnerEventType> {
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

export const RUN_STARTED_INTERACTION_MODES = [
  "chat",
  "plan",
  "build",
] as const;

export const RUN_STARTED_ACT_SUBMODES = ["strict", "safe", "full_auto"] as const;

export interface RunStartedEventPayload {
  sessionId: string;
  runId?: string | undefined;
  eventType: string;
  stepAgent?: string | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  interactionMode?: "chat" | "plan" | "build" | undefined;
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
  clientCapabilities?: ClientCapabilities | undefined;
  executionPolicy?:
    | {
        toolClassPolicy?: Partial<Record<"read_only" | "sandboxed_only" | "external_side_effect", boolean>> | undefined;
        capabilityPolicy?: Record<string, boolean> | undefined;
        approvalPolicy?: {
          strictApprovalPerCall?: boolean | undefined;
        } | undefined;
      }
    | undefined;
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

export interface RunReasoningEventPayload {
  update: ReasoningUpdateV1;
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
  latestReasoning?: import("../contracts.js").OperatorReasoningSummary | undefined;
  latestAdaptation?: import("../contracts.js").OperatorAdaptationSummary | undefined;
  latestEvidenceRecovery?: import("../contracts.js").OperatorEvidenceRecoverySummary | undefined;
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

export interface OperatorControlledEventPayload {
  sessionId?: string | undefined;
  threadId: string;
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
  operation: "capture" | "list" | "inspect" | "diff" | "restore" | "cleanup" | "promotion.undo_latest";
  checkpoint?: WorkspaceCheckpointDetail | undefined;
  checkpoints?: WorkspaceCheckpointRecord[] | undefined;
  diff?: WorkspaceDiffRecord | undefined;
  restore?: WorkspaceRestoreRecord | undefined;
  cleanup?: WorkspaceCheckpointCleanupResult["cleanup"] | undefined;
  deletedCheckpoints?: WorkspaceCheckpointRecord[] | undefined;
  remainingCheckpointCount?: number | undefined;
  remainingBytes?: number | undefined;
}

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
  "run.reasoning": RunReasoningEventPayload;
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
  "operator.controlled": OperatorControlledEventPayload;
  "task.updated": TaskUpdatedEventPayload;
  "task.graph": TaskGraphEventPayload;
  "workspace.checkpoint": WorkspaceCheckpointEventPayload;
  "project.snapshot": ProjectSnapshotEventPayload;
  "project.review": ProjectReviewEventPayload;
  "mcp.status": McpStatusEventPayload;
  "mcp.refreshed": McpRefreshedEventPayload;
}

export function isRunnerCommandEnvelope(value: unknown): value is RunnerCommand {
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
