import type { RunnerResultV2, RunnerRunStreamEventType } from "@kestrel-agents/protocol";

export type RunnerActorType = "end_user" | "operator" | "service";

export interface RunnerActorMetadata {
  actorId: string;
  actorType: RunnerActorType;
  displayName?: string | undefined;
  tenantId?: string | undefined;
}

export interface RunnerMcpServerConfig {
  name?: string | undefined;
  transport?: string | undefined;
  [key: string]: unknown;
}

export interface RunnerToolQueueProfileConfig {
  perRunConcurrency?: number | undefined;
  globalConcurrency?: number | undefined;
  maxQueuedJobsPerRun?: number | undefined;
  checkpointSize?: number | undefined;
  retryCount?: number | undefined;
}

export interface RunnerGuardrailConfig {
  maxStepVisits?: number | undefined;
  maxRunDurationMs?: number | undefined;
  toolBatchCheckpointSize?: number | undefined;
  [key: string]: unknown;
}

export interface RunnerCodeModeConfig {
  enabled?: boolean | undefined;
  approvalMode?: string | undefined;
  [key: string]: unknown;
}

export interface RunnerProfile {
  id: string;
  label: string;
  agent: string;
  sessionPrefix: string;
  modelProvider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
  model?: string | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  defaultInteractionMode?: "chat" | "plan" | "build" | undefined;
  defaultActSubmode?: "strict" | "safe" | "full_auto" | undefined;
  toolAllowlist?: string[] | undefined;
  mcpServers?: RunnerMcpServerConfig[] | undefined;
  toolQueue?: RunnerToolQueueProfileConfig | undefined;
  guardrails?: RunnerGuardrailConfig | undefined;
  codeMode?: RunnerCodeModeConfig | undefined;
  default?: boolean | undefined;
  [key: string]: unknown;
}

export interface RunnerHistoryEntry {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
}

export interface RunnerTurnAttachment {
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

export interface RunnerTurnInput {
  sessionId: string;
  runId?: string | undefined;
  message: string;
  eventType: string;
  attachments?: RunnerTurnAttachment[] | undefined;
  resumeBlockedRun?: boolean | undefined;
  stepAgent?: string | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  interactionMode?: "chat" | "plan" | "build" | undefined;
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
  clientCapabilities?: Record<string, unknown> | undefined;
  executionPolicy?: Record<string, unknown> | undefined;
  history?: RunnerHistoryEntry[] | undefined;
  manualCompaction?: boolean | undefined;
  autoCompaction?: {
    enabled?: boolean | undefined;
    state?: string | undefined;
    suppressOnce?: boolean | undefined;
  } | undefined;
  workspace?: Record<string, unknown> | undefined;
  skillPack?: Record<string, unknown> | undefined;
}

export interface RunnerRunError {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface RunnerTelemetry {
  stepsExecuted?: number | undefined;
  toolCalls?: number | undefined;
  modelCalls?: number | undefined;
  durationMs?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  [key: string]: unknown;
}

export interface RunnerFilesystemResumeReadBudget {
  kind: "filesystem_resume";
  configuredLimits: {
    inventoryReadActions: number;
    groundedReadActions: number;
    groundedReadActionsWithExplicitTarget: number;
  };
  usage: {
    inventoryReadActions: number;
    groundedReadActions: number;
  };
  remaining: {
    inventoryReadActions: number;
    groundedReadActions: number;
    groundedReadActionsWithExplicitTarget: number;
  };
  exhausted: boolean;
  stoppedByBudget: boolean;
  stopReason?: string | undefined;
}

export interface RunnerReadBudgets {
  filesystemResume?: RunnerFilesystemResumeReadBudget | undefined;
  [key: string]: unknown;
}

export interface RunnerWaitFor extends Record<string, unknown> {
  eventType?: string | undefined;
}

export interface RunnerRunOutput {
  status: string;
  sessionId: string;
  runId: string;
  errors: RunnerRunError[];
  telemetry?: RunnerTelemetry | undefined;
  readBudgets?: RunnerReadBudgets | undefined;
  waitFor?: RunnerWaitFor | undefined;
  [key: string]: unknown;
}

export interface RunnerRunResult extends RunnerResultV2<RunnerRunOutput> {}

export interface RunnerCommandMetadata {
  actor?: RunnerActorMetadata | undefined;
  tenantId?: string | undefined;
  profile?: RunnerProfile | undefined;
}

export interface RunnerEventSubscriptionFilter {
  sessionId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  eventTypes?: RunnerEventType[] | undefined;
}

export interface KestrelRequestContext {
  actor: RunnerActorMetadata;
  tenantId?: string | undefined;
}

export interface KestrelClientOptions {
  baseUrl?: string | undefined;
  authToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface KestrelRunRequest {
  profileId: string;
  turn: RunnerTurnInput;
}

export interface RunnerPingCommandPayload {
  nonce?: string | undefined;
}

export interface ProfileListCommandPayload {}

export interface ProfileGetCommandPayload {
  profileId: string;
}

export interface RunStartCommandPayload {
  profile?: RunnerProfile | undefined;
  profileId?: string | undefined;
  turn: RunnerTurnInput;
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

export interface OperatorInboxCommandPayload {
  sessionId?: string | undefined;
  threadId?: string | undefined;
}

export interface OperatorThreadCommandPayload {
  threadId: string;
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
}

export type RunnerTaskGraph = Record<string, unknown>;
export type RunnerProjectSnapshot = Record<string, unknown>;
export type RunnerProjectAction = Record<string, unknown>;
export type RunnerProjectReviewDetail = Record<string, unknown>;
export type RunnerProjectReviewTarget = Record<string, unknown>;
export type RunnerProjectReviewAction = Record<string, unknown>;
export type RunnerOperatorInboxSnapshot = Record<string, unknown>;
export type RunnerOperatorThreadView = Record<string, unknown>;
export type RunnerDelegationTask = Record<string, unknown>;

export interface TaskGraphGetCommandPayload {
  sessionId: string;
  threadId?: string | undefined;
}

export interface TaskGraphUpdateCommandPayload {
  sessionId: string;
  graph: RunnerTaskGraph;
  threadId?: string | undefined;
  expectedVersion?: number | undefined;
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
  policyOverride?: Record<string, unknown> | undefined;
}

export interface ProjectSnapshotGetCommandPayload {
  sessionId: string;
}

export interface ProjectSnapshotUpdateCommandPayload {
  sessionId: string;
  snapshot: RunnerProjectSnapshot;
}

export interface ProjectActionCommandPayload extends RunnerProjectAction {}

export interface ProjectReviewGetCommandPayload {
  sessionId: string;
  target: RunnerProjectReviewTarget;
}

export interface ProjectReviewActionCommandPayload {
  sessionId: string;
  action: RunnerProjectReviewAction;
}

export interface McpStatusCommandPayload {
  profile?: RunnerProfile | undefined;
  profileId?: string | undefined;
}

export interface McpRefreshCommandPayload {
  profile?: RunnerProfile | undefined;
  profileId?: string | undefined;
}

export type RunnerCommandType =
  | "profile.list"
  | "profile.get"
  | "run.start"
  | "run.cancel"
  | "session.describe"
  | "session.state"
  | "operator.inbox"
  | "operator.thread"
  | "operator.control"
  | "task.graph.get"
  | "task.graph.update"
  | "workspace.checkpoint.capture"
  | "workspace.checkpoint.list"
  | "workspace.checkpoint.inspect"
  | "workspace.checkpoint.diff"
  | "workspace.checkpoint.restore"
  | "workspace.checkpoint.cleanup"
  | "project.snapshot.get"
  | "project.snapshot.update"
  | "project.action"
  | "project.review.get"
  | "project.review.action"
  | "runner.ping"
  | "mcp.status"
  | "mcp.refresh";

export interface RunnerCommandPayloadByType {
  "profile.list": ProfileListCommandPayload;
  "profile.get": ProfileGetCommandPayload;
  "run.start": RunStartCommandPayload;
  "run.cancel": RunCancelCommandPayload;
  "session.describe": SessionDescribeCommandPayload;
  "session.state": SessionStateCommandPayload;
  "operator.inbox": OperatorInboxCommandPayload;
  "operator.thread": OperatorThreadCommandPayload;
  "operator.control": OperatorControlCommandPayload;
  "task.graph.get": TaskGraphGetCommandPayload;
  "task.graph.update": TaskGraphUpdateCommandPayload;
  "workspace.checkpoint.capture": WorkspaceCheckpointCaptureCommandPayload;
  "workspace.checkpoint.list": WorkspaceCheckpointListCommandPayload;
  "workspace.checkpoint.inspect": WorkspaceCheckpointInspectCommandPayload;
  "workspace.checkpoint.diff": WorkspaceCheckpointDiffCommandPayload;
  "workspace.checkpoint.restore": WorkspaceCheckpointRestoreCommandPayload;
  "workspace.checkpoint.cleanup": WorkspaceCheckpointCleanupCommandPayload;
  "project.snapshot.get": ProjectSnapshotGetCommandPayload;
  "project.snapshot.update": ProjectSnapshotUpdateCommandPayload;
  "project.action": ProjectActionCommandPayload;
  "project.review.get": ProjectReviewGetCommandPayload;
  "project.review.action": ProjectReviewActionCommandPayload;
  "runner.ping": RunnerPingCommandPayload;
  "mcp.status": McpStatusCommandPayload;
  "mcp.refresh": McpRefreshCommandPayload;
}

export interface RunnerCommandEnvelope<TType extends RunnerCommandType = RunnerCommandType> {
  id: string;
  type: TType;
  payload: RunnerCommandPayloadByType[TType];
  metadata?: RunnerCommandMetadata | undefined;
}

export interface RunnerMcpStatusSnapshot {
  healthy: boolean;
  checkedAt: string;
  servers: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
}

export type RunnerEventType =
  | "profile.listed"
  | "profile.loaded"
  | RunnerRunStreamEventType
  | "runner.error"
  | "runner.pong"
  | "session.described"
  | "session.state"
  | "operator.inbox"
  | "operator.thread"
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

export interface ProfileListedEventPayload {
  profiles: RunnerProfile[];
}

export interface ProfileLoadedEventPayload {
  profile: RunnerProfile;
}

export interface RunStartedEventPayload {
  sessionId: string;
  eventType: string;
  stepAgent?: string | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  interactionMode?: RunnerTurnInput["interactionMode"];
  actSubmode?: RunnerTurnInput["actSubmode"];
  clientCapabilities?: Record<string, unknown> | undefined;
  executionPolicy?: Record<string, unknown> | undefined;
}

export interface RunLogEventPayload {
  entry: Record<string, unknown>;
}

export interface RunConsoleEventPayload {
  update: Record<string, unknown>;
}

export interface RunProgressEventPayload {
  update: Record<string, unknown>;
}

export interface RunReasoningEventPayload {
  update: Record<string, unknown>;
}

export interface RunToolEventPayload {
  update: Record<string, unknown>;
}

export interface RunCancelledEventPayload {
  sessionId: string;
  runId?: string | undefined;
  result: RunnerRunResult;
}

export interface RunCompletedEventPayload {
  result: RunnerRunResult;
}

export interface RunFailedEventPayload {
  result: RunnerRunResult;
  error: RunnerRunError;
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

export interface RunnerSessionDescription {
  sessionId: string;
  version: number;
  threadId?: string | undefined;
  currentStepAgent?: string | undefined;
  updatedAt?: string | undefined;
  waitFor?: unknown;
  activeAssembly?: Record<string, unknown> | undefined;
  operatorInbox?: Record<string, unknown> | undefined;
  childBlocker?: Record<string, unknown> | undefined;
  childThreads?: RunnerOperatorThreadView[] | undefined;
  blockerChain?: string[] | undefined;
  dominantBlocker?: string | undefined;
  latestCheckpoint?: Record<string, unknown> | undefined;
  latestSteering?: Record<string, unknown> | undefined;
  nextAction?: string | undefined;
  contextPosture?: string | undefined;
  focusedThreadId?: string | undefined;
  operatorThreadView?: RunnerOperatorThreadView | undefined;
  [key: string]: unknown;
}

export interface RunnerSessionState {
  session: RunnerSessionDescription;
  version: number;
  graph: RunnerTaskGraph;
}

export interface OperatorInboxEventPayload {
  inbox: RunnerOperatorInboxSnapshot;
}

export interface OperatorThreadEventPayload {
  view: RunnerOperatorThreadView;
}

export interface OperatorControlledEventPayload {
  sessionId?: string | undefined;
  threadId: string;
  inbox?: RunnerOperatorInboxSnapshot | undefined;
  view?: RunnerOperatorThreadView | undefined;
  result?: RunnerRunResult | undefined;
}

export interface TaskUpdatedEventPayload {
  task: RunnerDelegationTask;
  kind: "spawned" | "waiting" | "completed" | "failed";
  assistantText: string | null;
  finalizedPayload?: unknown | undefined;
}

export interface TaskGraphEventPayload {
  sessionId: string;
  version: number;
  graph: RunnerTaskGraph;
}

export interface RunnerWorkspaceCheckpointRecord extends Record<string, unknown> {
  checkpointId: string;
  sessionId: string;
}

export interface RunnerWorkspaceCheckpointDetail extends Record<string, unknown> {
  checkpoint: RunnerWorkspaceCheckpointRecord;
  files: Array<Record<string, unknown>>;
}

export interface RunnerWorkspaceDiffRecord extends Record<string, unknown> {
  diffId: string;
  sessionId: string;
  files: Array<Record<string, unknown>>;
}

export interface RunnerWorkspaceRestoreRecord extends Record<string, unknown> {
  restoreId: string;
  sessionId: string;
  checkpointId: string;
  status: string;
}

export interface RunnerWorkspaceCleanupRecord extends Record<string, unknown> {
  cleanupId: string;
  sessionId: string;
  trigger: string;
}

export interface WorkspaceCheckpointEventPayload {
  sessionId: string;
  operation: "capture" | "list" | "inspect" | "diff" | "restore" | "cleanup";
  checkpoint?: RunnerWorkspaceCheckpointDetail | undefined;
  checkpoints?: RunnerWorkspaceCheckpointRecord[] | undefined;
  diff?: RunnerWorkspaceDiffRecord | undefined;
  restore?: RunnerWorkspaceRestoreRecord | undefined;
  cleanup?: RunnerWorkspaceCleanupRecord | undefined;
  deletedCheckpoints?: RunnerWorkspaceCheckpointRecord[] | undefined;
  remainingCheckpointCount?: number | undefined;
  remainingBytes?: number | undefined;
}

export interface ProjectSnapshotEventPayload {
  sessionId: string;
  snapshot: RunnerProjectSnapshot;
}

export interface ProjectReviewEventPayload {
  sessionId: string;
  detail: RunnerProjectReviewDetail;
}

export interface McpStatusEventPayload {
  status: RunnerMcpStatusSnapshot;
}

export interface McpRefreshedEventPayload {
  status: RunnerMcpStatusSnapshot;
}

export interface RunnerEventPayloadByType {
  "profile.listed": ProfileListedEventPayload;
  "profile.loaded": ProfileLoadedEventPayload;
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
  "session.described": RunnerSessionDescription;
  "session.state": RunnerSessionState;
  "operator.inbox": OperatorInboxEventPayload;
  "operator.thread": OperatorThreadEventPayload;
  "operator.controlled": OperatorControlledEventPayload;
  "task.updated": TaskUpdatedEventPayload;
  "task.graph": TaskGraphEventPayload;
  "workspace.checkpoint": WorkspaceCheckpointEventPayload;
  "project.snapshot": ProjectSnapshotEventPayload;
  "project.review": ProjectReviewEventPayload;
  "mcp.status": McpStatusEventPayload;
  "mcp.refreshed": McpRefreshedEventPayload;
}

export type RunnerCommand = {
  [K in RunnerCommandType]: RunnerCommandEnvelope<K>;
}[RunnerCommandType];

export type RunnerEvent = {
  [K in RunnerEventType]: RunnerEventEnvelope<K>;
}[RunnerEventType];

export type RunnerRunTerminalEvent =
  | RunnerEventEnvelope<"run.completed">
  | RunnerEventEnvelope<"run.failed">
  | RunnerEventEnvelope<"run.cancelled">;

export type RunnerStreamEvent = RunnerEvent;

export type RunnerRunStreamEvent = Extract<
  RunnerEvent,
  { type: RunnerRunStreamEventType }
>;

export interface RunnerResponseByCommandType {
  "profile.list": RunnerEventEnvelope<"profile.listed">;
  "profile.get": RunnerEventEnvelope<"profile.loaded">;
  "run.start": RunnerRunTerminalEvent;
  "run.cancel": RunnerEventEnvelope<"run.cancelled">;
  "session.describe": RunnerEventEnvelope<"session.described">;
  "session.state": RunnerEventEnvelope<"session.state">;
  "operator.inbox": RunnerEventEnvelope<"operator.inbox">;
  "operator.thread": RunnerEventEnvelope<"operator.thread">;
  "operator.control": RunnerEventEnvelope<"operator.controlled">;
  "task.graph.get": RunnerEventEnvelope<"task.graph">;
  "task.graph.update": RunnerEventEnvelope<"task.graph">;
  "workspace.checkpoint.capture": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.list": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.inspect": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.diff": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.restore": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.cleanup": RunnerEventEnvelope<"workspace.checkpoint">;
  "project.snapshot.get": RunnerEventEnvelope<"project.snapshot">;
  "project.snapshot.update": RunnerEventEnvelope<"project.snapshot">;
  "project.action": RunnerEventEnvelope<"project.snapshot">;
  "project.review.get": RunnerEventEnvelope<"project.review">;
  "project.review.action": RunnerEventEnvelope<"project.review">;
  "runner.ping": RunnerEventEnvelope<"runner.pong">;
  "mcp.status": RunnerEventEnvelope<"mcp.status">;
  "mcp.refresh": RunnerEventEnvelope<"mcp.refreshed">;
}

export interface RunnerStream<TEvent, TTerminal> extends AsyncIterable<TEvent> {
  result: Promise<TTerminal>;
  cancel(): Promise<void>;
}
