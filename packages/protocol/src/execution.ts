import { RunnerProtocolContractError } from "./errors.js";
import {
  parseRunnerProjectAction,
  type RunnerProjectAction,
} from "./projectActions.js";

export type {
  RunnerProjectAction,
  RunnerProjectActionType,
} from "./projectActions.js";

export const EXECUTION_PROTOCOL_VERSION = "execution-protocol-v3" as const;
export const RUNNER_COMMAND_CONTRACT_VERSION = "runner-command-v3" as const;
export const RUNNER_EVENT_CONTRACT_VERSION = "dotted-runtime-events-v3" as const;
export const RUNNER_WAITING_PROMPT_HISTORY_KIND = "runtime.waiting_prompt" as const;
export const RUNNER_ASSISTANT_TEXT_HISTORY_KIND = "runtime.assistant_text" as const;

export const RUNNER_COMMAND_TYPES = [
  "profile.list",
  "profile.get",
  "job.run",
  "run.start",
  "run.cancel",
  "session.describe",
  "session.state",
  "operator.inbox",
  "operator.thread",
  "operator.runs",
  "operator.run",
  "operator.run.reasoning",
  "operator.control",
  "task.graph.get",
  "task.graph.update",
  "workspace.checkpoint.capture",
  "workspace.checkpoint.list",
  "workspace.checkpoint.inspect",
  "workspace.checkpoint.diff",
  "workspace.checkpoint.restore",
  "workspace.checkpoint.cleanup",
  "workspace.promotion.list",
  "workspace.promotion.preview",
  "workspace.promotion.apply",
  "workspace.promotion.undo_latest",
  "workspace.managed.inspect",
  "workspace.managed.cleanup",
  "workspace.managed.restore",
  "workspace.managed.setup.retry",
  "user.terminal.start",
  "user.terminal.list",
  "user.terminal.read",
  "user.terminal.write",
  "user.terminal.resize",
  "user.terminal.stop",
  "workspace.changes.inspect",
  "workspace.changes.mutate",
  "workspace.feedback.add",
  "workspace.feedback.list",
  "workspace.feedback.remove",
  "workspace.feedback.submit",
  "workspace.review.run",
  "workspace.review.list",
  "workspace.review.update",
  "workspace.review.submit",
  "workspace.validation.inspect",
  "workspace.validation.run",
  "workspace.validation.cancel",
  "workspace.validation.submit",
  "workspace.git.inspect",
  "workspace.git.action",
  "project.snapshot.get",
  "project.snapshot.update",
  "project.action",
  "project.review.get",
  "project.review.action",
  "runner.ping",
  "mcp.status",
  "mcp.refresh",
] as const;

export type RunnerCommandType = (typeof RUNNER_COMMAND_TYPES)[number];

export const RUNNER_STREAMING_COMMAND_TYPES = [
  "job.run",
  "run.start",
] as const satisfies readonly RunnerCommandType[];

export type RunnerStreamingCommandType =
  (typeof RUNNER_STREAMING_COMMAND_TYPES)[number];

export const RUNNER_RUNTIME_ACTIVITY_EVENT_TYPES = [
  "run.tool.started",
  "run.tool.completed",
  "run.tool.failed",
  "run.log",
  "run.console",
  "run.progress",
  "run.model.reasoning.started",
  "run.model.reasoning.delta",
  "run.model.reasoning.completed",
  "run.model.reasoning.failed",
  "run.model.reasoning.unavailable",
  "run.agent_progress",
] as const;

export type RunnerRuntimeActivityEventType =
  (typeof RUNNER_RUNTIME_ACTIVITY_EVENT_TYPES)[number];

export const RUNNER_RUN_STREAM_EVENT_TYPES = [
  "run.started",
  "run.cancelled",
  ...RUNNER_RUNTIME_ACTIVITY_EVENT_TYPES,
  "run.completed",
  "run.failed",
  "runner.error",
  "task.updated",
] as const;

export type RunnerRunStreamEventType =
  (typeof RUNNER_RUN_STREAM_EVENT_TYPES)[number];

export const RUNNER_JOB_STREAM_EVENT_TYPES = [
  "job.started",
  "job.progress",
  ...RUNNER_RUNTIME_ACTIVITY_EVENT_TYPES,
  "job.completed",
  "job.failed",
  "runner.error",
] as const;

export type RunnerJobStreamEventType =
  (typeof RUNNER_JOB_STREAM_EVENT_TYPES)[number];

export const RUNNER_EVENT_TYPES = [
  "profile.listed",
  "profile.loaded",
  "job.started",
  "job.progress",
  "job.completed",
  "job.failed",
  "run.started",
  "run.cancelled",
  "run.tool.started",
  "run.tool.completed",
  "run.tool.failed",
  "run.log",
  "run.console",
  "run.progress",
  "run.model.reasoning.started",
  "run.model.reasoning.delta",
  "run.model.reasoning.completed",
  "run.model.reasoning.failed",
  "run.model.reasoning.unavailable",
  "run.agent_progress",
  "run.completed",
  "run.failed",
  "runner.error",
  "runner.pong",
  "session.described",
  "session.state",
  "operator.inbox",
  "operator.thread",
  "operator.runs",
  "operator.run",
  "operator.run.reasoning",
  "operator.controlled",
  "task.updated",
  "task.graph",
  "workspace.checkpoint",
  "user.terminal",
  "workspace.changes",
  "workspace.feedback",
  "workspace.review",
  "workspace.validation",
  "workspace.git",
  "project.snapshot",
  "project.review",
  "mcp.status",
  "mcp.refreshed",
] as const;

export type RunnerEventType = (typeof RUNNER_EVENT_TYPES)[number];

export const RUNNER_RUN_TERMINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly RunnerEventType[];

export type RunnerRunTerminalEventType =
  (typeof RUNNER_RUN_TERMINAL_EVENT_TYPES)[number];

export interface ExecutionProtocolDescriptorV3 {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  contracts: {
    command: typeof RUNNER_COMMAND_CONTRACT_VERSION;
    events: typeof RUNNER_EVENT_CONTRACT_VERSION;
  };
  commands: {
    supported: typeof RUNNER_COMMAND_TYPES;
    streaming: typeof RUNNER_STREAMING_COMMAND_TYPES;
  };
  events: {
    supported: typeof RUNNER_EVENT_TYPES;
    runStream: typeof RUNNER_RUN_STREAM_EVENT_TYPES;
    jobStream: typeof RUNNER_JOB_STREAM_EVENT_TYPES;
    runTerminal: typeof RUNNER_RUN_TERMINAL_EVENT_TYPES;
  };
}

export const EXECUTION_PROTOCOL_V3: ExecutionProtocolDescriptorV3 = {
  version: EXECUTION_PROTOCOL_VERSION,
  contracts: {
    command: RUNNER_COMMAND_CONTRACT_VERSION,
    events: RUNNER_EVENT_CONTRACT_VERSION,
  },
  commands: {
    supported: RUNNER_COMMAND_TYPES,
    streaming: RUNNER_STREAMING_COMMAND_TYPES,
  },
  events: {
    supported: RUNNER_EVENT_TYPES,
    runStream: RUNNER_RUN_STREAM_EVENT_TYPES,
    jobStream: RUNNER_JOB_STREAM_EVENT_TYPES,
    runTerminal: RUNNER_RUN_TERMINAL_EVENT_TYPES,
  },
};

/** @deprecated Use EXECUTION_PROTOCOL_V3. */
export const EXECUTION_PROTOCOL_V2 = EXECUTION_PROTOCOL_V3;
/** @deprecated Use ExecutionProtocolDescriptorV3. */
export type ExecutionProtocolDescriptorV2 = ExecutionProtocolDescriptorV3;

export interface RunnerWaitingPromptHistoryDataV2 {
  kind: typeof RUNNER_WAITING_PROMPT_HISTORY_KIND;
  runId?: string | undefined;
}

export interface RunnerAssistantTextHistoryDataV2 {
  kind: typeof RUNNER_ASSISTANT_TEXT_HISTORY_KIND;
  runId: string;
}

export type RunnerAssistantHistoryDataV2 =
  | RunnerAssistantTextHistoryDataV2
  | RunnerWaitingPromptHistoryDataV2;

export type RunnerActorType = "end_user" | "operator" | "service";
export type RunnerDurability =
  | "cancel_on_disconnect"
  | "continue_on_disconnect";
export type RunnerInteractionMode = "chat" | "plan" | "build";
export type RunnerActSubmode = "strict" | "safe" | "full_auto";
export type RunnerModelProvider =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "ollama"
  | "lmstudio";
export type RunnerToolExecutionClass =
  | "read_only"
  | "planning_write"
  | "sandboxed_only"
  | "external_side_effect";

export interface RunnerActorMetadata {
  actorId: string;
  actorType: RunnerActorType;
  displayName?: string | undefined;
  tenantId?: string | undefined;
  orgRole?: "member" | "org_admin" | undefined;
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
  modelProvider?: RunnerModelProvider | undefined;
  model?: string | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  defaultInteractionMode?: RunnerInteractionMode | undefined;
  defaultActSubmode?: RunnerActSubmode | undefined;
  toolAllowlist?: string[] | undefined;
  kestrelOneAppApprovalModes?: Record<string, "auto" | "ask"> | undefined;
  mcpServers?: RunnerMcpServerConfig[] | undefined;
  toolQueue?: RunnerToolQueueProfileConfig | undefined;
  guardrails?: RunnerGuardrailConfig | undefined;
  codeMode?: RunnerCodeModeConfig | undefined;
  reasoning?: {
    request: {
      mode: "off" | "summary" | "provider_visible";
      effort?: "low" | "medium" | "high" | undefined;
    };
    retention: {
      mode: "live_only" | "provider_visible";
      days: number;
    };
  } | undefined;
  default?: boolean | undefined;
  [key: string]: unknown;
}

export interface RunnerCommandMetadata {
  actor?: RunnerActorMetadata | undefined;
  tenantId?: string | undefined;
  profile?: RunnerProfile | undefined;
  durability?: RunnerDurability | undefined;
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

export interface RunnerHistoryEntryBase {
  text: string;
  timestamp: string;
}

export type RunnerHistoryEntry = RunnerHistoryEntryBase & (
  | {
      role: "user";
      data?: undefined;
    }
  | {
      role: "assistant";
      data?: RunnerAssistantTextHistoryDataV2 | undefined;
    }
  | {
      role: "system";
      data: RunnerWaitingPromptHistoryDataV2;
    }
);

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

export interface RunnerProjectContext {
  projectId: string;
  contextRevisionId: string;
  contextRevision: number;
  content: string;
}

export interface RunnerMcpContext {
  gatewayUrl: string;
  grantId: string;
  protocolVersion: "2025-11-25";
  organizationId: string;
  environmentId: string;
  projectId?: string | undefined;
  threadId: string;
}

export interface RunnerMcpAuthorization {
  executionTicket: string;
}

export type RunnerAutoCompactionState =
  | "idle"
  | "armed"
  | "applied"
  | "suppressed";

export interface RunnerAutoCompaction {
  enabled?: boolean | undefined;
  state?: RunnerAutoCompactionState | undefined;
  suppressOnce?: boolean | undefined;
}

export interface RunnerWorkspaceSkillCatalogEntry {
  installationId: string;
  name: string;
  description: string;
  commitSha: string;
  contentDigest: string;
  skillFile: string;
}

export interface RunnerTurnInput {
  sessionId: string;
  runId?: string | undefined;
  message: string;
  eventType: string;
  attachments?: RunnerTurnAttachment[] | undefined;
  resumeBlockedRun?: boolean | undefined;
  resumeRequestId?: string | undefined;
  stepAgent?: string | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  interactionMode?: RunnerInteractionMode | undefined;
  actSubmode?: RunnerActSubmode | undefined;
  mcpContext?: RunnerMcpContext | undefined;
  mcpAuthorization?: RunnerMcpAuthorization | undefined;
  clientCapabilities?: Record<string, unknown> | undefined;
  executionPolicy?: Record<string, unknown> | undefined;
  reasoningKeyReady?: boolean | undefined;
  reasoningKeyVersion?: number | undefined;
  systemInstructions?: string[] | undefined;
  history?: RunnerHistoryEntry[] | undefined;
  projectContext?: RunnerProjectContext | undefined;
  manualCompaction?: boolean | undefined;
  autoCompaction?: RunnerAutoCompaction | undefined;
  workspace?: Record<string, unknown> | undefined;
  workspaceSkills?: RunnerWorkspaceSkillCatalogEntry[] | undefined;
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

export interface RunnerInteractionRequestV1 extends Record<string, unknown> {
  version: "v1";
  requestId: string;
  kind: "user_input" | "approval";
  eventType: string;
  prompt: string;
  inputSchema?: Record<string, unknown> | undefined;
  approval?: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  } | undefined;
}

export interface RunnerWaitFor extends Record<string, unknown> {
  kind?: "user" | "approval" | "effect" | "tool" | "region_merge" | undefined;
  eventType: string;
  interaction?: RunnerInteractionRequestV1 | undefined;
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

export interface RunnerResultV2<TOutput = unknown> {
  output: TOutput;
  assistantText: string | null;
  finalizedPayload?: unknown | undefined;
  operatorAffordance?: unknown | undefined;
}

export type RunnerJobStoreDriver = "auto" | "postgres" | "sqlite";
export type RunnerApprovalPolicyPackId = "dev" | "ci_bot" | "production";

export type RunnerJobTurnInput = Omit<RunnerTurnInput, "eventType"> & {
  eventType?: string | undefined;
};

export interface RunnerJobInputV1 {
  version: "job_input_v1";
  turn: RunnerJobTurnInput;
  profileId?: string | undefined;
  profile?: RunnerProfile | undefined;
  storeDriver?: RunnerJobStoreDriver | undefined;
  approvalPolicyPackId?: RunnerApprovalPolicyPackId | undefined;
}

export interface RunnerJobReplayPointerV1 {
  version: "job_replay_pointer_v1";
  sessionId: string;
  threadId: string;
  runId: string;
  replayQuery: {
    runId: string;
    sessionId: string;
    threadId: string;
  };
  commands: {
    replay: string;
    doctor: string;
    bundle: string;
  };
}

export interface RunnerJobRunResultV1 {
  version: "job_run_result_v1";
  sessionId: string;
  threadId: string;
  runId: string;
  status: string;
  waitFor?: Record<string, unknown> | undefined;
  replay: RunnerJobReplayPointerV1;
  result: RunnerResultV2<RunnerRunOutput>;
  error?: RunnerRunError | undefined;
}

export type RunnerTaskGraph = Record<string, unknown>;
export type RunnerProjectSnapshot = Record<string, unknown>;
export type RunnerProjectReviewDetail = Record<string, unknown>;
export type RunnerOperatorInboxSnapshot = Record<string, unknown>;
export type RunnerOperatorThreadView = Record<string, unknown>;
export type RunnerOperatorRunIndexView = Record<string, unknown>;
export type RunnerOperatorRunView = Record<string, unknown>;
export interface RunnerMcpStatusSnapshot extends Record<string, unknown> {
  healthy: boolean;
  checkedAt: string;
  servers: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
}

export interface RunnerWorkspaceCheckpointRecord
  extends Record<string, unknown> {
  checkpointId: string;
  sessionId: string;
}

export interface RunnerWorkspaceCheckpointDetail
  extends Record<string, unknown> {
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

export interface RunnerWorkspacePromotionRecord
  extends Record<string, unknown> {
  promotionId: string;
  sessionId: string;
  runId: string;
  status: string;
  changedFiles: string[];
  candidateFingerprint?: string | undefined;
}

export interface RunnerWorkspacePromotionPreview
  extends Record<string, unknown> {
  promotion: RunnerWorkspacePromotionRecord;
  status: "ready" | "empty" | "blocked";
  changedFiles: string[];
  candidateFingerprint?: string | undefined;
  diff: RunnerWorkspaceDiffRecord;
}

export interface RunnerProjectReviewTarget {
  taskId?: string | undefined;
  branchName?: string | undefined;
  worktreePath?: string | undefined;
  pullRequestNumber?: number | undefined;
  filePath?: string | undefined;
}

export interface RunnerProjectReviewAction extends Record<string, unknown> {
  type: "review.refresh" | "review.comment.create";
  sessionId: string;
  target: RunnerProjectReviewTarget;
}

export type ProfileListCommandPayload = Record<string, never>;

export interface ProfileGetCommandPayload {
  profileId: string;
}

export type RunnerProfileReference =
  | {
      profile: RunnerProfile;
      profileId?: never;
    }
  | {
      profile?: never;
      profileId: string;
    };

type RunnerJobInputWithoutProfileReference = RunnerJobInputV1 & {
  profile?: never;
  profileId?: never;
};

type RunnerJobInputWithProfileReference = RunnerJobInputV1 & RunnerProfileReference;

export type JobRunCommandPayload =
  | (RunnerProfileReference & {
      input: RunnerJobInputWithoutProfileReference;
    })
  | {
      profile?: never;
      profileId?: never;
      input: RunnerJobInputWithProfileReference;
    };

export type RunStartCommandPayload = RunnerProfileReference & {
  turn: RunnerTurnInput;
};

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

export interface OperatorRunsCommandPayload {
  sessionId?: string | undefined;
  status?: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | undefined;
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

export type RunnerOperatorControlAction =
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

export type RunnerOperatorControlActionValue =
  | "continue"
  | "compact"
  | "summarize_forward"
  | "handoff"
  | "split_into_child_thread"
  | "operator_checkpoint"
  | "accept"
  | "defer";

export interface OperatorControlCommandPayload {
  action: RunnerOperatorControlAction;
  threadId: string;
  completionMode?: "terminal" | "accepted" | undefined;
  requestId?: string | undefined;
  proposalId?: string | undefined;
  checkpointId?: string | undefined;
  delegationId?: string | undefined;
  actionValue?: RunnerOperatorControlActionValue | undefined;
  message?: string | undefined;
  attachments?: RunnerTurnAttachment[] | undefined;
  title?: string | undefined;
  rolePrompt?: string | undefined;
  goal?: string | undefined;
  profileId?: string | undefined;
  provider?: RunnerModelProvider | undefined;
  model?: string | undefined;
  maxTurns?: number | undefined;
  maxRuntimeMs?: number | undefined;
  allowApprovalInheritance?: boolean | undefined;
  allowToolClasses?: RunnerToolExecutionClass[] | undefined;
  allowCapabilities?: string[] | undefined;
}

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

export interface RunnerWorkspaceDiffTarget {
  checkpointId?: string | undefined;
  gitRef?: string | undefined;
  workingTree?: boolean | undefined;
}

export interface WorkspaceCheckpointDiffCommandPayload {
  sessionId: string;
  source: RunnerWorkspaceDiffTarget;
  target: RunnerWorkspaceDiffTarget;
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

export interface WorkspacePromotionUndoLatestCommandPayload {
  sessionId: string;
  reason?: string | undefined;
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

export type RunnerWorkspaceChangeScope =
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "uncommitted" }
  | { kind: "branch"; baseRef: string }
  | { kind: "commit"; commitSha: string }
  | { kind: "pull_request"; number?: number | undefined }
  | { kind: "latest_run"; runId?: string | undefined }
  | { kind: "latest_turn"; turnId?: string | undefined }
  | { kind: "promotion"; promotionId: string };

export interface WorkspaceChangesInspectCommandPayload {
  sessionId: string;
  threadId: string;
  scope: RunnerWorkspaceChangeScope;
  options?: { contextLines?: number | undefined; whitespace?: "show" | "ignore_all" | "ignore_eol" | undefined } | undefined;
}

export interface WorkspaceChangesMutateCommandPayload {
  sessionId: string;
  threadId: string;
  expectedFingerprint: string;
  scope?: RunnerWorkspaceChangeScope | undefined;
  options?: { contextLines?: number | undefined; whitespace?: "show" | "ignore_all" | "ignore_eol" | undefined } | undefined;
  mutation:
    | { operation: "stage_file"; path: string }
    | { operation: "unstage_file"; path: string }
    | { operation: "revert_file"; path: string; confirmation: "revert_file" }
    | { operation: "stage_hunk"; path: string; hunkId: string }
    | { operation: "unstage_hunk"; path: string; hunkId: string }
    | { operation: "revert_hunk"; path: string; hunkId: string; confirmation: "revert_hunk" };
}

export interface WorkspaceFeedbackAddCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string }
export interface WorkspaceFeedbackListCommandPayload { sessionId: string; threadId: string }
export interface WorkspaceFeedbackRemoveCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; commentId: string }
export interface WorkspaceFeedbackSubmitCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; commentIds: string[] }
export interface WorkspaceReviewRunCommandPayload { sessionId: string; threadId: string; scope: RunnerWorkspaceChangeScope; mode?: "current_thread" | "detached_thread" | undefined; reviewerProfileId?: string | undefined; reviewerModel?: string | undefined }
export interface WorkspaceReviewListCommandPayload { sessionId: string; threadId: string }
export interface WorkspaceReviewUpdateCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; reviewId: string; findingId: string; action: "accept" | "dismiss" | "reopen" | "mark_fixed"; reason?: string | undefined }
export interface WorkspaceReviewSubmitCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; reviewId: string; findingIds: string[]; request: "address" | "more_evidence" | "verify" }
export interface WorkspaceValidationInspectCommandPayload { sessionId: string; threadId: string }
export interface WorkspaceValidationRunCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; actionId?: string | undefined; suiteId?: string | undefined }
export interface WorkspaceValidationCancelCommandPayload { sessionId: string; threadId: string; resultId: string }
export interface WorkspaceValidationSubmitCommandPayload { sessionId: string; threadId: string; resultIds: string[] }
export interface WorkspaceGitInspectCommandPayload { sessionId: string; threadId: string }
export interface WorkspaceGitActionCommandPayload { sessionId: string; threadId: string; candidateFingerprint: string; expectedHeadSha?: string | undefined; action: Record<string, unknown> }

export interface ProjectSnapshotGetCommandPayload {
  sessionId: string;
}

export interface ProjectSnapshotUpdateCommandPayload {
  sessionId: string;
  snapshot: RunnerProjectSnapshot;
}

export type ProjectActionCommandPayload = RunnerProjectAction;

export interface ProjectReviewGetCommandPayload {
  sessionId: string;
  target: RunnerProjectReviewTarget;
}

export interface ProjectReviewActionCommandPayload {
  sessionId: string;
  action: RunnerProjectReviewAction;
}

export interface RunnerPingCommandPayload {
  nonce?: string | undefined;
}

export type McpStatusCommandPayload = RunnerProfileReference;

export type McpRefreshCommandPayload = RunnerProfileReference;

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

export interface RunnerCommandEnvelope<
  TType extends RunnerCommandType = RunnerCommandType,
> {
  id: string;
  type: TType;
  payload: RunnerCommandPayloadByType[TType];
  metadata?: RunnerCommandMetadata | undefined;
}

export type RunnerCommand = {
  [K in RunnerCommandType]: RunnerCommandEnvelope<K>;
}[RunnerCommandType];

export interface ProfileListedEventPayload {
  profiles: RunnerProfile[];
}

export interface ProfileLoadedEventPayload {
  profile: RunnerProfile;
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
  update?: Record<string, unknown> | undefined;
}

export interface JobCompletedEventPayload {
  output: RunnerJobRunResultV1;
  replay: RunnerJobReplayPointerV1;
}

export interface JobFailedEventPayload {
  output: RunnerJobRunResultV1;
  replay?: RunnerJobReplayPointerV1 | undefined;
  error: RunnerRunError;
}

export interface RunStartedEventPayload {
  sessionId: string;
  runId?: string | undefined;
  eventType: string;
  stepAgent?: string | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  interactionMode?: RunnerInteractionMode | undefined;
  actSubmode?: RunnerActSubmode | undefined;
  mcpContext?: RunnerMcpContext | undefined;
  clientCapabilities?: Record<string, unknown> | undefined;
  executionPolicy?: Record<string, unknown> | undefined;
  reasoningKeyReady?: boolean | undefined;
  reasoningKeyVersion?: number | undefined;
}

export interface RunLogEventPayload {
  entry: Record<string, unknown>;
}

export interface RunConsoleEventPayload {
  update: Record<string, unknown>;
}

export type RunnerProgressKind = "stage" | "tool" | "waiting" | "heartbeat";
export type RunnerProgressPhase =
  | "engine"
  | "agent"
  | "route"
  | "chat"
  | "thinker"
  | "resolver"
  | "acter";
export type RunnerProgressCode =
  | "RUN_STARTED"
  | "RUN_RESUMED"
  | "RESUMED_FROM_WAIT"
  | "STEP_SELECTED"
  | "STEP_STARTED"
  | "STEP_COMMITTED"
  | "RUN_TERMINAL"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "MODEL_CALL_STARTED"
  | "MODEL_CALL_DONE"
  | "MODEL_CALL_FAILED"
  | "TOOL_CALL_STARTED"
  | "TOOL_CALL_DONE"
  | "TOOL_CALL_FAILED"
  | "WAITING_FOR_EVENT"
  | "RUN_STILL_ACTIVE";

export interface RunnerProgressUpdateV1 {
  version: "v1";
  runId: string;
  sessionId: string;
  ts: string;
  seq: number;
  kind: RunnerProgressKind;
  phase: RunnerProgressPhase;
  code: RunnerProgressCode;
  message: string;
  persist: boolean;
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
}

export interface RunnerAgentProgressUpdateV1 {
  version: "v1";
  runId: string;
  sessionId: string;
  ts: string;
  seq: number;
  message: string;
  stepIndex: number;
  stepAgent: string;
}

export interface RunnerModelReasoningUpdateV1 {
  version: "v1";
  runId: string;
  sessionId: string;
  ts: string;
  seq: number;
  event: "started" | "delta" | "completed" | "failed" | "unavailable";
  attempt: number;
  format: "summary" | "provider_thinking" | "provider_reasoning_text";
  delta?: string | undefined;
  contentState: "live" | "not_retained";
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
  model?: {
    provider?: string | undefined;
    model?: string | undefined;
  } | undefined;
}

export interface RunnerCitationPresentationV1 {
  id: string;
  title: string;
  url?: string | undefined;
  documentId?: string | undefined;
  excerpt?: string | undefined;
}

export interface RunnerArtifactPresentationV1 {
  id: string;
  title: string;
  kind: string;
  url?: string | undefined;
  mediaType?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RunnerToolPresentationV1 {
  citations?: RunnerCitationPresentationV1[] | undefined;
  artifacts?: RunnerArtifactPresentationV1[] | undefined;
}

export interface RunnerToolUpdateV1 {
  version: "v1";
  runId: string;
  sessionId: string;
  ts: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  phase: "started" | "completed" | "failed";
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
  displayName?: string | undefined;
  toolFamily?: string | undefined;
  provider?: string | undefined;
  input?: unknown;
  output?: unknown;
  error?: { code?: string | undefined; message: string } | undefined;
  durationMs?: number | undefined;
  presentation?: RunnerToolPresentationV1 | undefined;
}

export interface RunProgressEventPayload {
  update: RunnerProgressUpdateV1;
}

export interface RunModelReasoningEventPayload {
  update: RunnerModelReasoningUpdateV1;
}

export interface RunAgentProgressEventPayload {
  update: RunnerAgentProgressUpdateV1;
}

export interface RunToolEventPayload {
  update: RunnerToolUpdateV1;
}

export interface RunCancelledEventPayload {
  sessionId: string;
  runId?: string | undefined;
  result: RunnerResultV2<RunnerRunOutput>;
}

export interface RunCompletedEventPayload {
  result: RunnerResultV2<RunnerRunOutput>;
}

export interface RunFailedEventPayload {
  result: RunnerResultV2<RunnerRunOutput>;
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

export interface SessionDescribedEventPayload extends Record<string, unknown> {
  sessionId: string;
  version: number;
  threadId?: string | undefined;
  currentStepAgent?: string | undefined;
  updatedAt?: string | undefined;
  waitFor?: Record<string, unknown> | undefined;
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
}

export interface SessionStateEventPayload {
  session: SessionDescribedEventPayload;
  version: number;
  graph: RunnerTaskGraph;
}

export interface OperatorInboxEventPayload {
  inbox: RunnerOperatorInboxSnapshot;
}

export interface OperatorThreadEventPayload {
  view: RunnerOperatorThreadView;
}

export interface OperatorRunsEventPayload {
  view: RunnerOperatorRunIndexView;
}

export interface OperatorRunEventPayload {
  view: RunnerOperatorRunView;
}

export interface OperatorRunReasoningEventPayload {
  runId: string;
  entries: Array<Record<string, unknown>>;
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
  inbox?: RunnerOperatorInboxSnapshot | undefined;
  view?: RunnerOperatorThreadView | undefined;
  result?: RunnerResultV2<RunnerRunOutput> | undefined;
}

export interface TaskUpdatedEventPayload {
  task: Record<string, unknown>;
  kind: "spawned" | "waiting" | "completed" | "failed";
  assistantText: string | null;
  finalizedPayload?: unknown | undefined;
  dialogMessage?: {
    messageId: string;
    dialogId: string;
    name: string;
    childSessionId: string;
    sender: "kestrel" | "collaborator" | "system";
    text: string;
    createdAt: string;
    dialogStatus: "open" | "closed";
    status?: "failed" | "cancelled" | undefined;
  } | undefined;
}

export interface TaskGraphEventPayload {
  sessionId: string;
  version: number;
  graph: RunnerTaskGraph;
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
  checkpoint?: RunnerWorkspaceCheckpointDetail | undefined;
  checkpoints?: RunnerWorkspaceCheckpointRecord[] | undefined;
  diff?: RunnerWorkspaceDiffRecord | undefined;
  restore?: RunnerWorkspaceRestoreRecord | undefined;
  cleanup?: RunnerWorkspaceCleanupRecord | undefined;
  deletedCheckpoints?: RunnerWorkspaceCheckpointRecord[] | undefined;
  remainingCheckpointCount?: number | undefined;
  remainingBytes?: number | undefined;
  promotions?: RunnerWorkspacePromotionRecord[] | undefined;
  preview?: RunnerWorkspacePromotionPreview | undefined;
  promotion?: RunnerWorkspacePromotionRecord | undefined;
  managedInspection?: Record<string, unknown> | undefined;
  managedCleanup?: Record<string, unknown> | undefined;
  managedBinding?: Record<string, unknown> | undefined;
  cleanupCheckpoint?: RunnerWorkspaceCheckpointDetail | undefined;
}

export interface RunnerUserTerminalRecord {
  terminalId: string;
  kind: "user_terminal";
  sessionId: string;
  threadId: string;
  workspaceRoot: string;
  cwd: string;
  shellPath: string;
  pid?: number | undefined;
  status: "running" | "exited" | "stopped" | "lost";
  cols: number;
  rows: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  exitCode?: number | undefined;
  signal?: number | undefined;
  durationMs?: number | undefined;
}

export interface UserTerminalEventPayload {
  sessionId: string;
  operation: "start" | "list" | "read" | "write" | "resize" | "stop";
  terminal?: RunnerUserTerminalRecord | undefined;
  terminals?: RunnerUserTerminalRecord[] | undefined;
  output?: string | undefined;
  cursor?: number | undefined;
  nextCursor?: number | undefined;
  truncated?: boolean | undefined;
}

export interface WorkspaceChangesEventPayload {
  sessionId: string;
  threadId: string;
  operation: "inspect" | "mutate";
  snapshot: Record<string, unknown>;
  previousFingerprint?: string | undefined;
  mutationOperation?: "stage_file" | "unstage_file" | "revert_file" | "stage_hunk" | "unstage_hunk" | "revert_hunk" | undefined;
}

export interface WorkspaceFeedbackEventPayload { sessionId: string; threadId: string; operation: "add" | "list" | "remove" | "submit"; snapshot: Record<string, unknown>; submissionRunId?: string | undefined }
export interface WorkspaceReviewEventPayload { sessionId: string; threadId: string; operation: "run" | "list" | "update" | "submit"; snapshot: Record<string, unknown>; runId?: string | undefined }
export interface WorkspaceValidationEventPayload { sessionId: string; threadId: string; operation: "inspect" | "run" | "cancel" | "submit"; snapshot: Record<string, unknown>; runId?: string | undefined }
export interface WorkspaceGitEventPayload { sessionId: string; threadId: string; operation: "inspect" | "action"; snapshot: Record<string, unknown> }

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

export type RunnerEvent = {
  [K in RunnerEventType]: RunnerEventEnvelope<K>;
}[RunnerEventType];

export type RunnerRunTerminalEvent = {
  [K in RunnerRunTerminalEventType]: RunnerEventEnvelope<K>;
}[RunnerRunTerminalEventType];

export type RunnerRunStreamEvent = Extract<
  RunnerEvent,
  { type: RunnerRunStreamEventType }
>;

export interface RunnerResponseByCommandType {
  "profile.list": RunnerEventEnvelope<"profile.listed">;
  "profile.get": RunnerEventEnvelope<"profile.loaded">;
  "job.run": RunnerEventEnvelope<"job.completed"> | RunnerEventEnvelope<"job.failed">;
  "run.start": RunnerRunTerminalEvent;
  "run.cancel": RunnerEventEnvelope<"run.cancelled">;
  "session.describe": RunnerEventEnvelope<"session.described">;
  "session.state": RunnerEventEnvelope<"session.state">;
  "operator.inbox": RunnerEventEnvelope<"operator.inbox">;
  "operator.thread": RunnerEventEnvelope<"operator.thread">;
  "operator.runs": RunnerEventEnvelope<"operator.runs">;
  "operator.run": RunnerEventEnvelope<"operator.run">;
  "operator.run.reasoning": RunnerEventEnvelope<"operator.run.reasoning">;
  "operator.control": RunnerEventEnvelope<"operator.controlled">;
  "task.graph.get": RunnerEventEnvelope<"task.graph">;
  "task.graph.update": RunnerEventEnvelope<"task.graph">;
  "workspace.checkpoint.capture": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.list": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.inspect": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.diff": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.restore": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.checkpoint.cleanup": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.promotion.list": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.promotion.preview": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.promotion.apply": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.promotion.undo_latest": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.managed.inspect": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.managed.cleanup": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.managed.restore": RunnerEventEnvelope<"workspace.checkpoint">;
  "workspace.managed.setup.retry": RunnerEventEnvelope<"workspace.checkpoint">;
  "user.terminal.start": RunnerEventEnvelope<"user.terminal">;
  "user.terminal.list": RunnerEventEnvelope<"user.terminal">;
  "user.terminal.read": RunnerEventEnvelope<"user.terminal">;
  "user.terminal.write": RunnerEventEnvelope<"user.terminal">;
  "user.terminal.resize": RunnerEventEnvelope<"user.terminal">;
  "user.terminal.stop": RunnerEventEnvelope<"user.terminal">;
  "workspace.changes.inspect": RunnerEventEnvelope<"workspace.changes">;
  "workspace.changes.mutate": RunnerEventEnvelope<"workspace.changes">;
  "workspace.feedback.add": RunnerEventEnvelope<"workspace.feedback">;
  "workspace.feedback.list": RunnerEventEnvelope<"workspace.feedback">;
  "workspace.feedback.remove": RunnerEventEnvelope<"workspace.feedback">;
  "workspace.feedback.submit": RunnerEventEnvelope<"workspace.feedback">;
  "workspace.review.run": RunnerEventEnvelope<"workspace.review">;
  "workspace.review.list": RunnerEventEnvelope<"workspace.review">;
  "workspace.review.update": RunnerEventEnvelope<"workspace.review">;
  "workspace.review.submit": RunnerEventEnvelope<"workspace.review">;
  "workspace.validation.inspect": RunnerEventEnvelope<"workspace.validation">;
  "workspace.validation.run": RunnerEventEnvelope<"workspace.validation">;
  "workspace.validation.cancel": RunnerEventEnvelope<"workspace.validation">;
  "workspace.validation.submit": RunnerEventEnvelope<"workspace.validation">;
  "workspace.git.inspect": RunnerEventEnvelope<"workspace.git">;
  "workspace.git.action": RunnerEventEnvelope<"workspace.git">;
  "project.snapshot.get": RunnerEventEnvelope<"project.snapshot">;
  "project.snapshot.update": RunnerEventEnvelope<"project.snapshot">;
  "project.action": RunnerEventEnvelope<"project.snapshot">;
  "project.review.get": RunnerEventEnvelope<"project.review">;
  "project.review.action": RunnerEventEnvelope<"project.review">;
  "runner.ping": RunnerEventEnvelope<"runner.pong">;
  "mcp.status": RunnerEventEnvelope<"mcp.status">;
  "mcp.refresh": RunnerEventEnvelope<"mcp.refreshed">;
}

export const RUNNER_RESPONSE_EVENT_TYPES_BY_COMMAND_TYPE = {
  "profile.list": ["profile.listed"],
  "profile.get": ["profile.loaded"],
  "job.run": ["job.completed", "job.failed"],
  "run.start": ["run.completed", "run.failed", "run.cancelled"],
  "run.cancel": ["run.cancelled"],
  "session.describe": ["session.described"],
  "session.state": ["session.state"],
  "operator.inbox": ["operator.inbox"],
  "operator.thread": ["operator.thread"],
  "operator.runs": ["operator.runs"],
  "operator.run": ["operator.run"],
  "operator.run.reasoning": ["operator.run.reasoning"],
  "operator.control": ["operator.controlled"],
  "task.graph.get": ["task.graph"],
  "task.graph.update": ["task.graph"],
  "workspace.checkpoint.capture": ["workspace.checkpoint"],
  "workspace.checkpoint.list": ["workspace.checkpoint"],
  "workspace.checkpoint.inspect": ["workspace.checkpoint"],
  "workspace.checkpoint.diff": ["workspace.checkpoint"],
  "workspace.checkpoint.restore": ["workspace.checkpoint"],
  "workspace.checkpoint.cleanup": ["workspace.checkpoint"],
  "workspace.promotion.list": ["workspace.checkpoint"],
  "workspace.promotion.preview": ["workspace.checkpoint"],
  "workspace.promotion.apply": ["workspace.checkpoint"],
  "workspace.promotion.undo_latest": ["workspace.checkpoint"],
  "workspace.managed.inspect": ["workspace.checkpoint"],
  "workspace.managed.cleanup": ["workspace.checkpoint"],
  "workspace.managed.restore": ["workspace.checkpoint"],
  "workspace.managed.setup.retry": ["workspace.checkpoint"],
  "user.terminal.start": ["user.terminal"],
  "user.terminal.list": ["user.terminal"],
  "user.terminal.read": ["user.terminal"],
  "user.terminal.write": ["user.terminal"],
  "user.terminal.resize": ["user.terminal"],
  "user.terminal.stop": ["user.terminal"],
  "workspace.changes.inspect": ["workspace.changes"],
  "workspace.changes.mutate": ["workspace.changes"],
  "workspace.feedback.add": ["workspace.feedback"],
  "workspace.feedback.list": ["workspace.feedback"],
  "workspace.feedback.remove": ["workspace.feedback"],
  "workspace.feedback.submit": ["workspace.feedback"],
  "workspace.review.run": ["workspace.review"],
  "workspace.review.list": ["workspace.review"],
  "workspace.review.update": ["workspace.review"],
  "workspace.review.submit": ["workspace.review"],
  "workspace.validation.inspect": ["workspace.validation"],
  "workspace.validation.run": ["workspace.validation"],
  "workspace.validation.cancel": ["workspace.validation"],
  "workspace.validation.submit": ["workspace.validation"],
  "workspace.git.inspect": ["workspace.git"],
  "workspace.git.action": ["workspace.git"],
  "project.snapshot.get": ["project.snapshot"],
  "project.snapshot.update": ["project.snapshot"],
  "project.action": ["project.snapshot"],
  "project.review.get": ["project.review"],
  "project.review.action": ["project.review"],
  "runner.ping": ["runner.pong"],
  "mcp.status": ["mcp.status"],
  "mcp.refresh": ["mcp.refreshed"],
} as const satisfies {
  [K in RunnerCommandType]: readonly RunnerEventType[];
};

const WORKSPACE_OPERATION_BY_COMMAND_TYPE = {
  "workspace.checkpoint.capture": "capture",
  "workspace.checkpoint.list": "list",
  "workspace.checkpoint.inspect": "inspect",
  "workspace.checkpoint.diff": "diff",
  "workspace.checkpoint.restore": "restore",
  "workspace.checkpoint.cleanup": "cleanup",
  "workspace.promotion.list": "promotion.list",
  "workspace.promotion.preview": "promotion.preview",
  "workspace.promotion.apply": "promotion.apply",
  "workspace.promotion.undo_latest": "promotion.undo_latest",
  "workspace.managed.inspect": "managed.inspect",
  "workspace.managed.cleanup": "managed.cleanup",
  "workspace.managed.restore": "managed.restore",
  "workspace.managed.setup.retry": "managed.setup.retry",
} as const satisfies Partial<
  Record<RunnerCommandType, WorkspaceCheckpointEventPayload["operation"]>
>;

const RUNNER_TERMINAL_RESPONSE_EVENT_TYPE_SET: ReadonlySet<string> = new Set([
  "runner.error",
  ...Object.values(RUNNER_RESPONSE_EVENT_TYPES_BY_COMMAND_TYPE).flat(),
]);
const RUNNER_RUN_STREAM_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  RUNNER_RUN_STREAM_EVENT_TYPES,
);
const RUNNER_RUN_TERMINAL_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  RUNNER_RUN_TERMINAL_EVENT_TYPES,
);
const RUNNER_JOB_STREAM_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  RUNNER_JOB_STREAM_EVENT_TYPES,
);

export function isRunnerTerminalResponseEvent(
  type: unknown,
): type is RunnerEventType {
  return typeof type === "string" && RUNNER_TERMINAL_RESPONSE_EVENT_TYPE_SET.has(type);
}

export function isRunnerRunStreamEvent(
  event: RunnerEvent,
): event is RunnerRunStreamEvent {
  return RUNNER_RUN_STREAM_EVENT_TYPE_SET.has(event.type);
}

export function isRunnerRunTerminalEvent(
  event: RunnerRunStreamEvent,
): event is RunnerRunTerminalEvent {
  return RUNNER_RUN_TERMINAL_EVENT_TYPE_SET.has(event.type);
}

export function isRunnerExpectedResponseEvent(
  commandType: RunnerCommandType,
  event: { type: unknown; payload?: unknown },
): boolean {
  if (typeof event.type !== "string") {
    return false;
  }
  if (event.type === "runner.error") {
    return true;
  }
  const expectedTypes = RUNNER_RESPONSE_EVENT_TYPES_BY_COMMAND_TYPE[commandType];
  if ((expectedTypes as readonly string[]).includes(event.type) === false) {
    return false;
  }
  const expectedWorkspaceOperation = WORKSPACE_OPERATION_BY_COMMAND_TYPE[
    commandType as keyof typeof WORKSPACE_OPERATION_BY_COMMAND_TYPE
  ];
  if (expectedWorkspaceOperation === undefined) {
    return true;
  }
  return event.type === "workspace.checkpoint"
    && isRecord(event.payload)
    && event.payload.operation === expectedWorkspaceOperation;
}

export function isRunnerEventAllowedForCommand(
  commandType: RunnerCommandType,
  event: { type: unknown; payload?: unknown },
): boolean {
  if (isRunnerExpectedResponseEvent(commandType, event)) {
    return true;
  }
  if (commandType === "run.start") {
    return typeof event.type === "string"
      && RUNNER_RUN_STREAM_EVENT_TYPE_SET.has(event.type);
  }
  if (commandType === "job.run") {
    return typeof event.type === "string"
      && RUNNER_JOB_STREAM_EVENT_TYPE_SET.has(event.type);
  }
  return false;
}

const RUNNER_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(RUNNER_COMMAND_TYPES);
const RUNNER_STREAMING_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(
  RUNNER_STREAMING_COMMAND_TYPES,
);
const RUNNER_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUNNER_EVENT_TYPES);

export function isRunnerCommandType(value: unknown): value is RunnerCommandType {
  return typeof value === "string" && RUNNER_COMMAND_TYPE_SET.has(value);
}

export function isRunnerStreamingCommandType(
  value: unknown,
): value is RunnerStreamingCommandType {
  return typeof value === "string" && RUNNER_STREAMING_COMMAND_TYPE_SET.has(value);
}

export function isRunnerEventType(value: unknown): value is RunnerEventType {
  return typeof value === "string" && RUNNER_EVENT_TYPE_SET.has(value);
}

export function parseRunnerCommandV2(value: unknown): RunnerCommand {
  const command = requireRecord(value, "runner command");
  const id = requireNonEmptyString(command.id, "runner command.id");
  if (!isRunnerCommandType(command.type)) {
    throw new RunnerProtocolContractError(
      `runner command.type must be a supported Execution Protocol v3 command, received '${String(command.type)}'`,
    );
  }
  const payload = parseRunnerCommandPayloadV2(
    command.type,
    requireRecord(command.payload, `runner command '${command.type}' payload`),
  );
  const metadata = command.metadata === undefined
    ? undefined
    : parseRunnerCommandMetadata(command.metadata);
  return {
    ...command,
    id,
    type: command.type,
    payload,
    ...(metadata !== undefined ? { metadata } : {}),
  } as unknown as RunnerCommand;
}

export function parseRunnerEventV2(value: unknown): RunnerEvent {
  const event = requireRecord(value, "runner event");
  const id = requireNonEmptyString(event.id, "runner event.id");
  if (!isRunnerEventType(event.type)) {
    throw new RunnerProtocolContractError(
      `runner event.type must be a supported Execution Protocol v3 event, received '${String(event.type)}'`,
    );
  }
  const ts = requireNonEmptyString(event.ts, "runner event.ts");
  const payload = parseRunnerEventPayloadV2(
    event.type,
    parseRunnerTerminalPayloadV2(
      event.type,
      requireRecord(event.payload, `runner event '${event.type}' payload`),
    ),
  );
  const runId = parseOptionalNonEmptyString(event.runId, "runner event.runId");
  const sessionId = parseOptionalNonEmptyString(event.sessionId, "runner event.sessionId");
  const threadId = parseOptionalNonEmptyString(event.threadId, "runner event.threadId");
  const commandId = parseOptionalNonEmptyString(event.commandId, "runner event.commandId");
  return {
    ...event,
    id,
    type: event.type,
    ts,
    payload,
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(commandId !== undefined ? { commandId } : {}),
  } as unknown as RunnerEvent;
}

export function parseRunnerResultV2<TOutput = unknown>(
  value: unknown,
): RunnerResultV2<TOutput> {
  const result = requireRecord(value, "runner result");
  if (Object.hasOwn(result, "assistantText") === false) {
    throw new RunnerProtocolContractError("runner result.assistantText is required");
  }
  const assistantText = parseAssistantText(result.assistantText);
  if (Object.hasOwn(result, "output") === false) {
    throw new RunnerProtocolContractError("runner result.output is required");
  }
  return {
    ...result,
    output: result.output as TOutput,
    assistantText,
    ...(Object.hasOwn(result, "finalizedPayload")
      ? { finalizedPayload: result.finalizedPayload }
      : {}),
    ...(Object.hasOwn(result, "operatorAffordance")
      ? { operatorAffordance: result.operatorAffordance }
      : {}),
  };
}

export function parseRunnerTerminalPayloadV2(
  type: string,
  value: unknown,
): Record<string, unknown> {
  const payload = requireRecord(value, `${type} payload`);
  if (type === "run.completed" || type === "run.failed" || type === "run.cancelled") {
    return {
      ...payload,
      result: parseRunnerRunResultV2(payload.result),
    };
  }
  if (type === "operator.controlled" && payload.result !== undefined) {
    return {
      ...payload,
      result: parseRunnerRunResultV2(payload.result),
    };
  }
  return payload;
}

function parseRunnerCommandPayloadV2(
  type: RunnerCommandType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const label = `runner command '${type}' payload`;
  switch (type) {
    case "profile.list":
      break;
    case "profile.get":
      requireNonEmptyString(payload.profileId, `${label}.profileId`);
      break;
    case "job.run": {
      validateOptionalProfile(payload.profile, `${label}.profile`);
      validateOptionalNonEmptyString(payload.profileId, `${label}.profileId`);
      const input = parseJobInput(payload.input, `${label}.input`);
      const profileReferenceCount = countProfileReferences(payload)
        + countProfileReferences(input);
      if (profileReferenceCount === 0) {
        throw new RunnerProtocolContractError(
          `${label} must include profile/profileId or input.profile/input.profileId`,
        );
      }
      if (profileReferenceCount > 1) {
        throw new RunnerProtocolContractError(
          `${label} must include exactly one profile reference across the payload and input`,
        );
      }
      return { ...payload, input };
    }
    case "run.start": {
      validateRequiredProfileReference(payload, label);
      validateRunTurn(payload.turn, `${label}.turn`);
      break;
    }
    case "run.cancel":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalNonEmptyString(payload.runId, `${label}.runId`);
      validateOptionalNonEmptyString(payload.commandId, `${label}.commandId`);
      break;
    case "session.describe":
    case "session.state":
    case "workspace.checkpoint.list":
    case "workspace.promotion.list":
    case "project.snapshot.get":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      break;
    case "operator.inbox":
      validateOptionalNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalNonEmptyString(payload.threadId, `${label}.threadId`);
      break;
    case "operator.thread":
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      break;
    case "operator.runs":
      rejectUnknownFields(payload, label, ["sessionId", "status", "limit"]);
      validateOptionalNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalEnum(payload.status, `${label}.status`, [
        "RUNNING",
        "WAITING",
        "COMPLETED",
        "FAILED",
      ]);
      validateOptionalIntegerRange(payload.limit, `${label}.limit`, 1, 50);
      break;
    case "operator.run":
      requireNonEmptyString(payload.runId, `${label}.runId`);
      break;
    case "operator.run.reasoning":
      rejectUnknownFields(payload, label, ["runId", "sessionId", "action"]);
      requireNonEmptyString(payload.runId, `${label}.runId`);
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalEnum(payload.action, `${label}.action`, ["read", "delete"]);
      break;
    case "operator.control":
      validateEnum(payload.action, `${label}.action`, [
        "approve",
        "reject",
        "reply",
        "steer",
        "retry",
        "focus_thread",
        "resolve_context_checkpoint",
        "approve_assembly_change",
        "reject_assembly_change",
        "spawn_child_thread",
        "supersede_child_thread",
        "resolve_fan_in_checkpoint",
      ]);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      validateOptionalEnum(payload.completionMode, `${label}.completionMode`, ["terminal", "accepted"]);
      for (const field of [
        "requestId",
        "proposalId",
        "checkpointId",
        "delegationId",
        "title",
        "rolePrompt",
        "goal",
        "profileId",
        "model",
      ] as const) {
        validateOptionalNonEmptyString(payload[field], `${label}.${field}`);
      }
      validateOptionalString(payload.message, `${label}.message`);
      validateOptionalEnum(payload.actionValue, `${label}.actionValue`, [
        "continue",
        "compact",
        "summarize_forward",
        "handoff",
        "split_into_child_thread",
        "operator_checkpoint",
        "accept",
        "defer",
      ]);
      validateOptionalEnum(payload.provider, `${label}.provider`, [
        "openrouter",
        "openai",
        "anthropic",
        "ollama",
        "lmstudio",
      ]);
      validateOptionalAttachments(payload.attachments, `${label}.attachments`);
      validateOptionalNonNegativeInteger(payload.maxTurns, `${label}.maxTurns`);
      validateOptionalNonNegativeInteger(payload.maxRuntimeMs, `${label}.maxRuntimeMs`);
      validateOptionalBoolean(
        payload.allowApprovalInheritance,
        `${label}.allowApprovalInheritance`,
      );
      validateOptionalEnumArray(payload.allowToolClasses, `${label}.allowToolClasses`, [
        "read_only",
        "planning_write",
        "sandboxed_only",
        "external_side_effect",
      ]);
      validateOptionalStringArray(payload.allowCapabilities, `${label}.allowCapabilities`);
      break;
    case "task.graph.get":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalNonEmptyString(payload.threadId, `${label}.threadId`);
      break;
    case "task.graph.update":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireRecord(payload.graph, `${label}.graph`);
      validateOptionalNonEmptyString(payload.threadId, `${label}.threadId`);
      validateOptionalNonNegativeInteger(payload.expectedVersion, `${label}.expectedVersion`);
      break;
    case "workspace.checkpoint.capture":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalString(payload.label, `${label}.label`);
      validateOptionalString(payload.reason, `${label}.reason`);
      validateOptionalNonEmptyString(payload.threadId, `${label}.threadId`);
      validateOptionalNonEmptyString(payload.runId, `${label}.runId`);
      validateOptionalNonEmptyString(payload.taskId, `${label}.taskId`);
      break;
    case "workspace.checkpoint.inspect":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.checkpointId, `${label}.checkpointId`);
      break;
    case "workspace.checkpoint.diff":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateWorkspaceDiffTarget(payload.source, `${label}.source`);
      validateWorkspaceDiffTarget(payload.target, `${label}.target`);
      validateOptionalBoolean(payload.includeHunks, `${label}.includeHunks`);
      break;
    case "workspace.checkpoint.restore":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.checkpointId, `${label}.checkpointId`);
      validateOptionalString(payload.reason, `${label}.reason`);
      validateOptionalNonEmptyString(payload.threadId, `${label}.threadId`);
      validateOptionalNonEmptyString(payload.runId, `${label}.runId`);
      validateOptionalNonEmptyString(payload.taskId, `${label}.taskId`);
      break;
    case "workspace.checkpoint.cleanup":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalString(payload.reason, `${label}.reason`);
      validateOptionalRecord(payload.policyOverride, `${label}.policyOverride`);
      break;
    case "workspace.promotion.preview":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.promotionId, `${label}.promotionId`);
      break;
    case "workspace.promotion.apply":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.promotionId, `${label}.promotionId`);
      requireNonEmptyString(
        payload.candidateFingerprint,
        `${label}.candidateFingerprint`,
      );
      break;
    case "workspace.promotion.undo_latest":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalString(payload.reason, `${label}.reason`);
      break;
    case "workspace.managed.inspect":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      break;
    case "workspace.managed.cleanup":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      requireNonEmptyString(payload.reason, `${label}.reason`);
      break;
    case "workspace.managed.restore":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      requireNonEmptyString(payload.checkpointId, `${label}.checkpointId`);
      validateOptionalString(payload.reason, `${label}.reason`);
      break;
    case "workspace.managed.setup.retry":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      break;
    case "user.terminal.start":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      validateOptionalIntegerRange(payload.cols, `${label}.cols`, 2, 1000);
      validateOptionalIntegerRange(payload.rows, `${label}.rows`, 2, 1000);
      break;
    case "user.terminal.list":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalString(payload.threadId, `${label}.threadId`);
      break;
    case "user.terminal.read":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.terminalId, `${label}.terminalId`);
      validateOptionalNonNegativeInteger(payload.cursor, `${label}.cursor`);
      break;
    case "user.terminal.write":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.terminalId, `${label}.terminalId`);
      if (typeof payload.data !== "string" || payload.data.length === 0) {
        throw new RunnerProtocolContractError(`${label}.data must be a non-empty string`);
      }
      if (Buffer.byteLength(payload.data, "utf8") > 65_536) {
        throw new RunnerProtocolContractError(`${label}.data exceeds 65536 bytes`);
      }
      break;
    case "user.terminal.resize":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.terminalId, `${label}.terminalId`);
      if (requireNonNegativeInteger(payload.cols, `${label}.cols`) < 2 || (payload.cols as number) > 1000) {
        throw new RunnerProtocolContractError(`${label}.cols must be from 2 to 1000`);
      }
      if (requireNonNegativeInteger(payload.rows, `${label}.rows`) < 2 || (payload.rows as number) > 1000) {
        throw new RunnerProtocolContractError(`${label}.rows must be from 2 to 1000`);
      }
      break;
    case "user.terminal.stop":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.terminalId, `${label}.terminalId`);
      break;
    case "workspace.changes.inspect":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      validateWorkspaceChangeScope(requireRecord(payload.scope, `${label}.scope`), `${label}.scope`);
      if (payload.options !== undefined) validateWorkspaceDiffOptions(requireRecord(payload.options, `${label}.options`), `${label}.options`);
      break;
    case "workspace.changes.mutate": {
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      requireNonEmptyString(payload.expectedFingerprint, `${label}.expectedFingerprint`);
      if (payload.scope !== undefined) validateWorkspaceChangeScope(requireRecord(payload.scope, `${label}.scope`), `${label}.scope`);
      if (payload.options !== undefined) validateWorkspaceDiffOptions(requireRecord(payload.options, `${label}.options`), `${label}.options`);
      const mutation = requireRecord(payload.mutation, `${label}.mutation`);
      validateEnum(mutation.operation, `${label}.mutation.operation`, ["stage_file", "unstage_file", "revert_file", "stage_hunk", "unstage_hunk", "revert_hunk"]);
      requireNonEmptyString(mutation.path, `${label}.mutation.path`);
      if (mutation.operation === "stage_hunk" || mutation.operation === "unstage_hunk" || mutation.operation === "revert_hunk") requireNonEmptyString(mutation.hunkId, `${label}.mutation.hunkId`);
      if (mutation.operation === "revert_file" && mutation.confirmation !== "revert_file") {
        throw new RunnerProtocolContractError(`${label}.mutation.confirmation must be 'revert_file'`);
      }
      if (mutation.operation === "revert_hunk" && mutation.confirmation !== "revert_hunk") throw new RunnerProtocolContractError(`${label}.mutation.confirmation must be 'revert_hunk'`);
      break;
    }
    case "workspace.feedback.add":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      requireNonEmptyString(payload.candidateFingerprint, `${label}.candidateFingerprint`);
      requireNonEmptyString(payload.path, `${label}.path`);
      if (requireNonNegativeInteger(payload.line, `${label}.line`) === 0) throw new RunnerProtocolContractError(`${label}.line must be positive`);
      validateEnum(payload.side, `${label}.side`, ["LEFT", "RIGHT"]);
      requireNonEmptyString(payload.body, `${label}.body`);
      break;
    case "workspace.feedback.list":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      break;
    case "workspace.feedback.remove":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      requireNonEmptyString(payload.candidateFingerprint, `${label}.candidateFingerprint`);
      requireNonEmptyString(payload.commentId, `${label}.commentId`);
      break;
    case "workspace.feedback.submit":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      requireNonEmptyString(payload.candidateFingerprint, `${label}.candidateFingerprint`);
      validateNonEmptyStringArray(payload.commentIds, `${label}.commentIds`);
      break;
    case "workspace.review.run":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); validateWorkspaceChangeScope(requireRecord(payload.scope, `${label}.scope`), `${label}.scope`);
      if (payload.mode !== undefined) validateEnum(payload.mode, `${label}.mode`, ["current_thread", "detached_thread"]);
      validateOptionalNonEmptyString(payload.reviewerProfileId, `${label}.reviewerProfileId`); validateOptionalNonEmptyString(payload.reviewerModel, `${label}.reviewerModel`); break;
    case "workspace.review.list":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); break;
    case "workspace.review.update":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); requireNonEmptyString(payload.candidateFingerprint, `${label}.candidateFingerprint`); requireNonEmptyString(payload.reviewId, `${label}.reviewId`); requireNonEmptyString(payload.findingId, `${label}.findingId`); validateEnum(payload.action, `${label}.action`, ["accept", "dismiss", "reopen", "mark_fixed"]); if (payload.action === "dismiss") requireNonEmptyString(payload.reason, `${label}.reason`); break;
    case "workspace.review.submit":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); requireNonEmptyString(payload.candidateFingerprint, `${label}.candidateFingerprint`); requireNonEmptyString(payload.reviewId, `${label}.reviewId`); validateStringArray(payload.findingIds, `${label}.findingIds`); validateEnum(payload.request, `${label}.request`, ["address", "more_evidence", "verify"]); break;
    case "workspace.validation.inspect":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); break;
    case "workspace.validation.run":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); requireNonEmptyString(payload.candidateFingerprint, `${label}.candidateFingerprint`); validateOptionalNonEmptyString(payload.actionId, `${label}.actionId`); validateOptionalNonEmptyString(payload.suiteId, `${label}.suiteId`); if ((payload.actionId === undefined) === (payload.suiteId === undefined)) throw new Error(`${label} must contain exactly one actionId or suiteId`); break;
    case "workspace.validation.cancel":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); requireNonEmptyString(payload.resultId, `${label}.resultId`); break;
    case "workspace.validation.submit":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); validateNonEmptyStringArray(payload.resultIds, `${label}.resultIds`); break;
    case "workspace.git.inspect":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); break;
    case "workspace.git.action":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); requireNonEmptyString(payload.candidateFingerprint, `${label}.candidateFingerprint`); validateOptionalNonEmptyString(payload.expectedHeadSha, `${label}.expectedHeadSha`); requireRecord(payload.action, `${label}.action`); break;
    case "project.snapshot.update":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireRecord(payload.snapshot, `${label}.snapshot`);
      break;
    case "project.action":
      return parseRunnerProjectAction(payload);
    case "project.review.get":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireRecord(payload.target, `${label}.target`);
      break;
    case "project.review.action": {
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      const action = requireRecord(payload.action, `${label}.action`);
      validateEnum(action.type, `${label}.action.type`, [
        "review.refresh",
        "review.comment.create",
      ]);
      requireNonEmptyString(action.sessionId, `${label}.action.sessionId`);
      requireRecord(action.target, `${label}.action.target`);
      break;
    }
    case "runner.ping":
      validateOptionalString(payload.nonce, `${label}.nonce`);
      break;
    case "mcp.status":
    case "mcp.refresh":
      validateRequiredProfileReference(payload, label);
      break;
  }
  return payload;
}

function parseRunnerEventPayloadV2(
  type: RunnerEventType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const label = `runner event '${type}' payload`;
  switch (type) {
    case "profile.listed":
      validateRecordArray(payload.profiles, `${label}.profiles`, validateRunnerProfile);
      break;
    case "profile.loaded":
      validateRunnerProfile(requireRecord(payload.profile, `${label}.profile`), `${label}.profile`);
      break;
    case "job.started":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      requireNonEmptyString(payload.profileId, `${label}.profileId`);
      break;
    case "job.progress":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      validateOptionalNonEmptyString(payload.runId, `${label}.runId`);
      validateEnum(payload.stage, `${label}.stage`, [
        "accepted",
        "runtime_progress",
        "finalizing",
      ]);
      requireString(payload.message, `${label}.message`);
      validateOptionalRecord(payload.update, `${label}.update`);
      break;
    case "job.completed": {
      const output = parseJobRunResult(payload.output, `${label}.output`);
      validateJobReplayPointer(payload.replay, `${label}.replay`);
      return { ...payload, output };
    }
    case "job.failed": {
      const output = parseJobRunResult(payload.output, `${label}.output`);
      if (payload.replay !== undefined) {
        validateJobReplayPointer(payload.replay, `${label}.replay`);
      }
      validateRunError(payload.error, `${label}.error`);
      return { ...payload, output };
    }
    case "run.started":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalNonEmptyString(payload.runId, `${label}.runId`);
      requireNonEmptyString(payload.eventType, `${label}.eventType`);
      validateOptionalNonEmptyString(payload.stepAgent, `${label}.stepAgent`);
      validateOptionalBoolean(payload.modeSystemV2Enabled, `${label}.modeSystemV2Enabled`);
      validateOptionalEnum(payload.interactionMode, `${label}.interactionMode`, [
        "chat",
        "plan",
        "build",
      ]);
      validateOptionalEnum(payload.actSubmode, `${label}.actSubmode`, [
        "strict",
        "safe",
        "full_auto",
      ]);
      validateOptionalRecord(payload.mcpContext, `${label}.mcpContext`);
      validateOptionalRecord(payload.clientCapabilities, `${label}.clientCapabilities`);
      validateOptionalRecord(payload.executionPolicy, `${label}.executionPolicy`);
      validateOptionalBoolean(payload.reasoningKeyReady, `${label}.reasoningKeyReady`);
      validateOptionalIntegerRange(payload.reasoningKeyVersion, `${label}.reasoningKeyVersion`, 0, 1000);
      break;
    case "run.cancelled":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalNonEmptyString(payload.runId, `${label}.runId`);
      requireRecord(payload.result, `${label}.result`);
      break;
    case "run.console":
      requireRecord(payload.update, `${label}.update`);
      break;
    case "run.progress":
      validateRunnerProgressUpdate(payload.update, `${label}.update`);
      break;
    case "run.agent_progress":
      validateRunnerAgentProgressUpdate(payload.update, `${label}.update`);
      break;
    case "run.model.reasoning.started":
    case "run.model.reasoning.delta":
    case "run.model.reasoning.completed":
    case "run.model.reasoning.failed":
    case "run.model.reasoning.unavailable":
      validateRunnerModelReasoningUpdate(
        payload.update,
        `${label}.update`,
        type.slice("run.model.reasoning.".length),
      );
      break;
    case "run.tool.started":
    case "run.tool.completed":
    case "run.tool.failed":
      validateRunnerToolUpdate(
        payload.update,
        `${label}.update`,
        type.slice("run.tool.".length),
      );
      break;
    case "run.log":
      requireRecord(payload.entry, `${label}.entry`);
      break;
    case "run.completed":
      requireRecord(payload.result, `${label}.result`);
      break;
    case "run.failed":
      requireRecord(payload.result, `${label}.result`);
      validateRunError(payload.error, `${label}.error`);
      break;
    case "runner.error":
      requireNonEmptyString(payload.code, `${label}.code`);
      requireString(payload.message, `${label}.message`);
      validateOptionalRecord(payload.details, `${label}.details`);
      break;
    case "runner.pong":
      validateOptionalString(payload.nonce, `${label}.nonce`);
      validateOptionalNonEmptyString(payload.sessionId, `${label}.sessionId`);
      break;
    case "session.described": {
      const session = normalizeSessionDescription(payload);
      validateSessionDescription(session, label);
      return session;
    }
    case "session.state": {
      const session = normalizeSessionDescription(
        requireRecord(payload.session, `${label}.session`),
      );
      validateSessionDescription(session, `${label}.session`);
      requireNonNegativeInteger(payload.version, `${label}.version`);
      requireRecord(payload.graph, `${label}.graph`);
      return { ...payload, session };
    }
    case "operator.inbox":
      requireRecord(payload.inbox, `${label}.inbox`);
      break;
    case "operator.thread":
    case "operator.runs":
    case "operator.run":
      requireRecord(payload.view, `${label}.view`);
      break;
    case "operator.run.reasoning":
      requireNonEmptyString(payload.runId, `${label}.runId`);
      if (!Array.isArray(payload.entries)) {
        throw new RunnerProtocolContractError(`${label}.entries must be an array`);
      }
      validateEnum(payload.retention, `${label}.retention`, ["provider_visible"]);
      validateEnum(payload.access, `${label}.access`, ["org_admin"]);
      validateEnum(payload.action, `${label}.action`, ["read", "delete"]);
      validateOptionalIntegerRange(payload.deletedCount, `${label}.deletedCount`, 0, Number.MAX_SAFE_INTEGER);
      break;
    case "operator.controlled":
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      validateOptionalNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalEnum(payload.disposition, `${label}.disposition`, ["accepted", "completed"]);
      validateOptionalNonEmptyString(payload.runId, `${label}.runId`);
      validateOptionalRecord(payload.inbox, `${label}.inbox`);
      validateOptionalRecord(payload.view, `${label}.view`);
      validateOptionalRecord(payload.result, `${label}.result`);
      break;
    case "task.updated":
      requireRecord(payload.task, `${label}.task`);
      validateEnum(payload.kind, `${label}.kind`, [
        "spawned",
        "waiting",
        "completed",
        "failed",
      ]);
      return {
        ...payload,
        assistantText: parseAssistantText(payload.assistantText),
      };
    case "task.graph":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonNegativeInteger(payload.version, `${label}.version`);
      requireRecord(payload.graph, `${label}.graph`);
      break;
    case "workspace.checkpoint":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateEnum(payload.operation, `${label}.operation`, [
        "capture",
        "list",
        "inspect",
        "diff",
        "restore",
        "cleanup",
        "promotion.list",
        "promotion.preview",
        "promotion.apply",
        "promotion.undo_latest",
        "managed.inspect",
        "managed.cleanup",
        "managed.restore",
        "managed.setup.retry",
      ]);
      validateOptionalWorkspaceRecord(
        payload.checkpoint,
        `${label}.checkpoint`,
        validateWorkspaceCheckpointDetail,
      );
      validateOptionalWorkspaceRecord(
        payload.diff,
        `${label}.diff`,
        validateWorkspaceDiffRecord,
      );
      validateOptionalWorkspaceRecord(
        payload.restore,
        `${label}.restore`,
        validateWorkspaceRestoreRecord,
      );
      validateOptionalWorkspaceRecord(
        payload.cleanup,
        `${label}.cleanup`,
        validateWorkspaceCleanupRecord,
      );
      validateOptionalWorkspaceRecord(
        payload.preview,
        `${label}.preview`,
        validateWorkspacePromotionPreview,
      );
      validateOptionalWorkspaceRecord(
        payload.promotion,
        `${label}.promotion`,
        validateWorkspacePromotionRecord,
      );
      validateOptionalWorkspaceRecordArray(
        payload.checkpoints,
        `${label}.checkpoints`,
        validateWorkspaceCheckpointRecord,
      );
      validateOptionalWorkspaceRecordArray(
        payload.deletedCheckpoints,
        `${label}.deletedCheckpoints`,
        validateWorkspaceCheckpointRecord,
      );
      validateOptionalWorkspaceRecordArray(
        payload.promotions,
        `${label}.promotions`,
        validateWorkspacePromotionRecord,
      );
      validateOptionalNonNegativeInteger(
        payload.remainingCheckpointCount,
        `${label}.remainingCheckpointCount`,
      );
      validateOptionalNonNegativeNumber(payload.remainingBytes, `${label}.remainingBytes`);
      break;
    case "user.terminal":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateEnum(payload.operation, `${label}.operation`, ["start", "list", "read", "write", "resize", "stop"]);
      if (payload.terminal !== undefined) {
        validateUserTerminalRecord(requireRecord(payload.terminal, `${label}.terminal`), `${label}.terminal`);
      }
      if (payload.terminals !== undefined) {
        if (Array.isArray(payload.terminals) === false) {
          throw new RunnerProtocolContractError(`${label}.terminals must be an array`);
        }
        payload.terminals.forEach((terminal, index) =>
          validateUserTerminalRecord(
            requireRecord(terminal, `${label}.terminals[${index}]`),
            `${label}.terminals[${index}]`,
          )
        );
      }
      validateOptionalString(payload.output, `${label}.output`);
      validateOptionalNonNegativeInteger(payload.cursor, `${label}.cursor`);
      validateOptionalNonNegativeInteger(payload.nextCursor, `${label}.nextCursor`);
      if (payload.truncated !== undefined && typeof payload.truncated !== "boolean") {
        throw new RunnerProtocolContractError(`${label}.truncated must be a boolean`);
      }
      break;
    case "workspace.changes":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      validateEnum(payload.operation, `${label}.operation`, ["inspect", "mutate"]);
      requireRecord(payload.snapshot, `${label}.snapshot`);
      validateOptionalNonEmptyString(payload.previousFingerprint, `${label}.previousFingerprint`);
      if (payload.mutationOperation !== undefined) validateEnum(payload.mutationOperation, `${label}.mutationOperation`, ["stage_file", "unstage_file", "revert_file", "stage_hunk", "unstage_hunk", "revert_hunk"]);
      break;
    case "workspace.feedback":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      validateEnum(payload.operation, `${label}.operation`, ["add", "list", "remove", "submit"]);
      requireRecord(payload.snapshot, `${label}.snapshot`);
      validateOptionalNonEmptyString(payload.submissionRunId, `${label}.submissionRunId`);
      break;
    case "workspace.review":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); validateEnum(payload.operation, `${label}.operation`, ["run", "list", "update", "submit"]); requireRecord(payload.snapshot, `${label}.snapshot`); validateOptionalNonEmptyString(payload.runId, `${label}.runId`); break;
    case "workspace.validation":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); validateEnum(payload.operation, `${label}.operation`, ["inspect", "run", "cancel", "submit"]); requireRecord(payload.snapshot, `${label}.snapshot`); validateOptionalNonEmptyString(payload.runId, `${label}.runId`); break;
    case "workspace.git":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`); requireNonEmptyString(payload.threadId, `${label}.threadId`); validateEnum(payload.operation, `${label}.operation`, ["inspect", "action"]); requireRecord(payload.snapshot, `${label}.snapshot`); break;
    case "project.snapshot":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireRecord(payload.snapshot, `${label}.snapshot`);
      break;
    case "project.review":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireRecord(payload.detail, `${label}.detail`);
      break;
    case "mcp.status":
    case "mcp.refreshed":
      requireRecord(payload.status, `${label}.status`);
      break;
  }
  return payload;
}

function validateRunTurn(value: unknown, label: string): void {
  const turn = requireRecord(value, label);
  requireNonEmptyString(turn.sessionId, `${label}.sessionId`);
  validateOptionalNonEmptyString(turn.runId, `${label}.runId`);
  requireString(turn.message, `${label}.message`);
  requireNonEmptyString(turn.eventType, `${label}.eventType`);
  validateOptionalAttachments(turn.attachments, `${label}.attachments`);
  validateOptionalBoolean(turn.resumeBlockedRun, `${label}.resumeBlockedRun`);
  validateOptionalNonEmptyString(turn.resumeRequestId, `${label}.resumeRequestId`);
  if (turn.resumeBlockedRun === true && turn.resumeRequestId === undefined) {
    throw new RunnerProtocolContractError(
      `${label}.resumeRequestId is required when resumeBlockedRun is true`,
    );
  }
  validateOptionalNonEmptyString(turn.stepAgent, `${label}.stepAgent`);
  validateOptionalBoolean(turn.modeSystemV2Enabled, `${label}.modeSystemV2Enabled`);
  validateOptionalEnum(turn.interactionMode, `${label}.interactionMode`, [
    "chat",
    "plan",
    "build",
  ]);
  validateOptionalEnum(turn.actSubmode, `${label}.actSubmode`, [
    "strict",
    "safe",
    "full_auto",
  ]);
  validateOptionalRecord(turn.mcpContext, `${label}.mcpContext`);
  validateOptionalRecord(turn.mcpAuthorization, `${label}.mcpAuthorization`);
  validateOptionalRecord(turn.clientCapabilities, `${label}.clientCapabilities`);
  validateOptionalRecord(turn.executionPolicy, `${label}.executionPolicy`);
  validateOptionalNonEmptyStringArray(
    turn.systemInstructions,
    `${label}.systemInstructions`,
  );
  validateOptionalHistory(turn.history, `${label}.history`);
  validateOptionalRecord(turn.projectContext, `${label}.projectContext`);
  validateOptionalBoolean(turn.manualCompaction, `${label}.manualCompaction`);
  validateOptionalAutoCompaction(turn.autoCompaction, `${label}.autoCompaction`);
  validateOptionalRecord(turn.workspace, `${label}.workspace`);
  validateOptionalWorkspaceSkills(turn.workspaceSkills, `${label}.workspaceSkills`);
}

function parseJobInput(value: unknown, label: string): RunnerJobInputV1 {
  const input = requireRecord(value, label);
  if (input.version !== "job_input_v1") {
    throw new RunnerProtocolContractError(`${label}.version must be 'job_input_v1'`);
  }
  const turn = parseJobTurn(input.turn, `${label}.turn`);
  validateOptionalNonEmptyString(input.profileId, `${label}.profileId`);
  validateOptionalProfile(input.profile, `${label}.profile`);
  validateOptionalEnum(input.storeDriver, `${label}.storeDriver`, [
    "auto",
    "postgres",
    "sqlite",
  ]);
  validateOptionalEnum(input.approvalPolicyPackId, `${label}.approvalPolicyPackId`, [
    "dev",
    "ci_bot",
    "production",
  ]);
  return {
    ...input,
    version: "job_input_v1",
    turn,
  } as RunnerJobInputV1;
}

function parseJobTurn(value: unknown, label: string): RunnerTurnInput {
  const turn = requireRecord(value, label);
  const normalized = {
    ...turn,
    eventType: turn.eventType === undefined ? "job.run" : turn.eventType,
  };
  validateRunTurn(normalized, label);
  return normalized as unknown as RunnerTurnInput;
}

function parseJobRunResult(value: unknown, label: string): RunnerJobRunResultV1 {
  const output = requireRecord(value, label);
  if (output.version !== "job_run_result_v1") {
    throw new RunnerProtocolContractError(`${label}.version must be 'job_run_result_v1'`);
  }
  const sessionId = requireNonEmptyString(output.sessionId, `${label}.sessionId`);
  const threadId = requireNonEmptyString(output.threadId, `${label}.threadId`);
  const runId = requireNonEmptyString(output.runId, `${label}.runId`);
  const status = requireNonEmptyString(output.status, `${label}.status`);
  validateJobReplayPointer(output.replay, `${label}.replay`);
  const result = parseRunnerRunResultV2(output.result);
  if (output.error !== undefined) {
    validateRunError(output.error, `${label}.error`);
  }
  return {
    ...output,
    version: "job_run_result_v1",
    sessionId,
    threadId,
    runId,
    status,
    replay: output.replay as RunnerJobReplayPointerV1,
    result,
    ...(output.error !== undefined ? { error: output.error as RunnerRunError } : {}),
  };
}

function validateJobReplayPointer(value: unknown, label: string): void {
  const replay = requireRecord(value, label);
  if (replay.version !== "job_replay_pointer_v1") {
    throw new RunnerProtocolContractError(
      `${label}.version must be 'job_replay_pointer_v1'`,
    );
  }
  requireNonEmptyString(replay.sessionId, `${label}.sessionId`);
  requireNonEmptyString(replay.threadId, `${label}.threadId`);
  requireNonEmptyString(replay.runId, `${label}.runId`);
  const replayQuery = requireRecord(replay.replayQuery, `${label}.replayQuery`);
  requireNonEmptyString(replayQuery.sessionId, `${label}.replayQuery.sessionId`);
  requireNonEmptyString(replayQuery.threadId, `${label}.replayQuery.threadId`);
  requireNonEmptyString(replayQuery.runId, `${label}.replayQuery.runId`);
  const commands = requireRecord(replay.commands, `${label}.commands`);
  requireNonEmptyString(commands.replay, `${label}.commands.replay`);
  requireNonEmptyString(commands.doctor, `${label}.commands.doctor`);
  requireNonEmptyString(commands.bundle, `${label}.commands.bundle`);
}

function validateSessionDescription(
  session: Record<string, unknown>,
  label: string,
): void {
  requireNonEmptyString(session.sessionId, `${label}.sessionId`);
  requireNonNegativeInteger(session.version, `${label}.version`);
  validateOptionalNonEmptyString(session.threadId, `${label}.threadId`);
  validateOptionalNonEmptyString(session.currentStepAgent, `${label}.currentStepAgent`);
  validateOptionalNonEmptyString(session.updatedAt, `${label}.updatedAt`);
  validateOptionalRecord(session.waitFor, `${label}.waitFor`);
  validateOptionalRecord(session.activeAssembly, `${label}.activeAssembly`);
  validateOptionalRecord(session.operatorInbox, `${label}.operatorInbox`);
  validateOptionalRecord(session.childBlocker, `${label}.childBlocker`);
  validateOptionalRecordArray(session.childThreads, `${label}.childThreads`);
  validateOptionalStringArray(session.blockerChain, `${label}.blockerChain`);
  validateOptionalNonEmptyString(session.dominantBlocker, `${label}.dominantBlocker`);
  validateOptionalRecord(session.latestCheckpoint, `${label}.latestCheckpoint`);
  validateOptionalRecord(session.latestSteering, `${label}.latestSteering`);
  validateOptionalNonEmptyString(session.nextAction, `${label}.nextAction`);
  validateOptionalNonEmptyString(session.contextPosture, `${label}.contextPosture`);
  validateOptionalNonEmptyString(session.focusedThreadId, `${label}.focusedThreadId`);
  validateOptionalRecord(session.operatorThreadView, `${label}.operatorThreadView`);
}

function normalizeSessionDescription(
  session: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof session.updatedAt !== "string" || session.updatedAt.trim()) {
    return session;
  }
  const { updatedAt: _discarded, ...normalized } = session;
  return normalized;
}

function validateRunError(value: unknown, label: string): void {
  const error = requireRecord(value, label);
  requireNonEmptyString(error.code, `${label}.code`);
  requireString(error.message, `${label}.message`);
  validateOptionalRecord(error.details, `${label}.details`);
}

function parseRunnerRunResultV2(value: unknown): RunnerResultV2<RunnerRunOutput> {
  const result = parseRunnerResultV2<RunnerRunOutput>(value);
  validateRunnerRunOutput(result.output, "runner result.output");
  validateRunnerAssistantTextContract(result);
  return result;
}

function validateRunnerRunOutput(value: unknown, label: string): void {
  const output = requireRecord(value, label);
  requireNonEmptyString(output.status, `${label}.status`);
  requireNonEmptyString(output.sessionId, `${label}.sessionId`);
  requireNonEmptyString(output.runId, `${label}.runId`);
  validateRecordArray(output.errors, `${label}.errors`, validateRunError);
  if (output.telemetry !== undefined) {
    validateRunnerTelemetry(output.telemetry, `${label}.telemetry`);
  }
  if (output.readBudgets !== undefined) {
    validateRunnerReadBudgets(output.readBudgets, `${label}.readBudgets`);
  }
  if (output.waitFor !== undefined) {
    validateRunnerWaitFor(output.waitFor, `${label}.waitFor`);
  }
}

function validateRunnerTelemetry(value: unknown, label: string): void {
  const telemetry = requireRecord(value, label);
  for (const field of [
    "stepsExecuted",
    "toolCalls",
    "modelCalls",
    "durationMs",
    "inputTokens",
    "outputTokens",
    "totalTokens",
  ] as const) {
    validateOptionalNonNegativeNumber(telemetry[field], `${label}.${field}`);
  }
}

function validateRunnerReadBudgets(value: unknown, label: string): void {
  const readBudgets = requireRecord(value, label);
  if (readBudgets.filesystemResume === undefined) {
    return;
  }
  const budget = requireRecord(
    readBudgets.filesystemResume,
    `${label}.filesystemResume`,
  );
  if (budget.kind !== "filesystem_resume") {
    throw new RunnerProtocolContractError(
      `${label}.filesystemResume.kind must be 'filesystem_resume'`,
    );
  }
  validateFilesystemResumeBudgetCounts(
    budget.configuredLimits,
    `${label}.filesystemResume.configuredLimits`,
    true,
  );
  validateFilesystemResumeBudgetCounts(
    budget.usage,
    `${label}.filesystemResume.usage`,
    false,
  );
  validateFilesystemResumeBudgetCounts(
    budget.remaining,
    `${label}.filesystemResume.remaining`,
    true,
  );
  requireBoolean(budget.exhausted, `${label}.filesystemResume.exhausted`);
  requireBoolean(budget.stoppedByBudget, `${label}.filesystemResume.stoppedByBudget`);
  validateOptionalString(budget.stopReason, `${label}.filesystemResume.stopReason`);
}

function validateFilesystemResumeBudgetCounts(
  value: unknown,
  label: string,
  includeExplicitTarget: boolean,
): void {
  const counts = requireRecord(value, label);
  requireNonNegativeInteger(counts.inventoryReadActions, `${label}.inventoryReadActions`);
  requireNonNegativeInteger(counts.groundedReadActions, `${label}.groundedReadActions`);
  if (includeExplicitTarget) {
    requireNonNegativeInteger(
      counts.groundedReadActionsWithExplicitTarget,
      `${label}.groundedReadActionsWithExplicitTarget`,
    );
  }
}

function validateRunnerWaitFor(value: unknown, label: string): void {
  const waitFor = requireRecord(value, label);
  const eventType = requireNonEmptyString(waitFor.eventType, `${label}.eventType`);
  validateOptionalEnum(waitFor.kind, `${label}.kind`, [
    "user",
    "approval",
    "effect",
    "tool",
    "region_merge",
  ]);
  if (waitFor.interaction !== undefined) {
    validateRunnerInteractionRequest(waitFor.interaction, `${label}.interaction`, eventType);
  }
  if (
    (waitFor.kind === "user" || waitFor.kind === "approval") &&
    waitFor.interaction === undefined
  ) {
    throw new RunnerProtocolContractError(
      `${label}.interaction is required for user-facing waits`,
    );
  }
}

function validateRunnerInteractionRequest(
  value: unknown,
  label: string,
  waitEventType: string,
): void {
  const interaction = requireRecord(value, label);
  if (interaction.version !== "v1") {
    throw new RunnerProtocolContractError(`${label}.version must be 'v1'`);
  }
  requireNonEmptyString(interaction.requestId, `${label}.requestId`);
  validateEnum(interaction.kind, `${label}.kind`, ["user_input", "approval"]);
  const eventType = requireNonEmptyString(interaction.eventType, `${label}.eventType`);
  if (eventType !== waitEventType) {
    throw new RunnerProtocolContractError(
      `${label}.eventType must match ${label.replace(/\.interaction$/u, "")}.eventType`,
    );
  }
  requireNonEmptyString(interaction.prompt, `${label}.prompt`);
  validateOptionalRecord(interaction.inputSchema, `${label}.inputSchema`);
  if (interaction.approval !== undefined) {
    const approval = requireRecord(interaction.approval, `${label}.approval`);
    requireNonEmptyString(approval.toolCallId, `${label}.approval.toolCallId`);
    requireNonEmptyString(approval.toolName, `${label}.approval.toolName`);
    if (Object.hasOwn(approval, "input") === false) {
      throw new RunnerProtocolContractError(`${label}.approval.input is required`);
    }
  }
}

function validateRunnerAssistantTextContract(
  result: RunnerResultV2<RunnerRunOutput>,
): void {
  const status = result.output.status.toUpperCase();
  if (status === "COMPLETED" && result.assistantText === null) {
    throw new RunnerProtocolContractError(
      "runner result.assistantText is required when output.status is COMPLETED",
    );
  }
  if (status !== "WAITING") {
    return;
  }
  const waitFor = result.output.waitFor;
  if (waitFor === undefined) {
    throw new RunnerProtocolContractError(
      "runner result.output.waitFor is required when output.status is WAITING",
    );
  }
  const interaction = waitFor.interaction;
  if (interaction === undefined) {
    if (waitFor.kind === "user" || waitFor.kind === "approval") {
      throw new RunnerProtocolContractError(
        "runner result.output.waitFor.interaction is required for user-facing waits",
      );
    }
    return;
  }
  if (result.assistantText !== interaction.prompt.trim()) {
    throw new RunnerProtocolContractError(
      "runner result.assistantText must equal output.waitFor.interaction.prompt for user-facing waits",
    );
  }
}

function validateWorkspaceDiffTarget(value: unknown, label: string): void {
  const target = requireRecord(value, label);
  validateOptionalNonEmptyString(target.checkpointId, `${label}.checkpointId`);
  validateOptionalNonEmptyString(target.gitRef, `${label}.gitRef`);
  validateOptionalBoolean(target.workingTree, `${label}.workingTree`);
  if (
    target.checkpointId === undefined
    && target.gitRef === undefined
    && target.workingTree !== true
  ) {
    throw new RunnerProtocolContractError(
      `${label} must select checkpointId, gitRef, or workingTree`,
    );
  }
}

function validateOptionalProfile(value: unknown, label: string): void {
  if (value !== undefined) {
    validateRunnerProfile(requireRecord(value, label), label);
  }
}

function countProfileReferences(value: {
  profile?: unknown;
  profileId?: unknown;
}): number {
  return Number(value.profile !== undefined) + Number(value.profileId !== undefined);
}

function validateRequiredProfileReference(
  value: Record<string, unknown>,
  label: string,
): void {
  validateOptionalProfile(value.profile, `${label}.profile`);
  validateOptionalNonEmptyString(value.profileId, `${label}.profileId`);
  const referenceCount = countProfileReferences(value);
  if (referenceCount === 0) {
    throw new RunnerProtocolContractError(
      `${label} must include profile or profileId`,
    );
  }
  if (referenceCount > 1) {
    throw new RunnerProtocolContractError(
      `${label} must include only one of profile or profileId`,
    );
  }
}

function validateRunnerProfile(
  profile: Record<string, unknown>,
  label: string,
): void {
  requireNonEmptyString(profile.id, `${label}.id`);
  requireNonEmptyString(profile.label, `${label}.label`);
  requireNonEmptyString(profile.agent, `${label}.agent`);
  requireNonEmptyString(profile.sessionPrefix, `${label}.sessionPrefix`);
  validateOptionalEnum(profile.modelProvider, `${label}.modelProvider`, [
    "openrouter",
    "openai",
    "anthropic",
    "ollama",
    "lmstudio",
  ]);
  validateOptionalNonEmptyString(profile.model, `${label}.model`);
  validateOptionalBoolean(profile.modeSystemV2Enabled, `${label}.modeSystemV2Enabled`);
  validateOptionalEnum(profile.defaultInteractionMode, `${label}.defaultInteractionMode`, [
    "chat",
    "plan",
    "build",
  ]);
  validateOptionalEnum(profile.defaultActSubmode, `${label}.defaultActSubmode`, [
    "strict",
    "safe",
    "full_auto",
  ]);
  validateOptionalStringArray(profile.toolAllowlist, `${label}.toolAllowlist`);
  validateOptionalEnumRecord(
    profile.kestrelOneAppApprovalModes,
    `${label}.kestrelOneAppApprovalModes`,
    ["auto", "ask"],
  );
  validateOptionalRecordArray(profile.mcpServers, `${label}.mcpServers`);
  validateOptionalRecord(profile.toolQueue, `${label}.toolQueue`);
  validateOptionalRecord(profile.guardrails, `${label}.guardrails`);
  validateOptionalRecord(profile.codeMode, `${label}.codeMode`);
  if (profile.reasoning !== undefined) {
    const reasoning = requireRecord(profile.reasoning, `${label}.reasoning`);
    const request = requireRecord(reasoning.request, `${label}.reasoning.request`);
    const retention = requireRecord(reasoning.retention, `${label}.reasoning.retention`);
    validateEnum(request.mode, `${label}.reasoning.request.mode`, ["off", "summary", "provider_visible"]);
    validateOptionalEnum(request.effort, `${label}.reasoning.request.effort`, ["low", "medium", "high"]);
    validateEnum(retention.mode, `${label}.reasoning.retention.mode`, ["live_only", "provider_visible"]);
    const retentionDays = requireNonNegativeInteger(retention.days, `${label}.reasoning.retention.days`);
    if (retentionDays < 1 || retentionDays > 30) {
      throw new RunnerProtocolContractError(`${label}.reasoning.retention.days must be from 1 to 30`);
    }
  }
  validateOptionalBoolean(profile.default, `${label}.default`);
}

function validateWorkspaceCheckpointRecord(
  record: Record<string, unknown>,
  label: string,
): void {
  requireNonEmptyString(record.checkpointId, `${label}.checkpointId`);
  requireNonEmptyString(record.sessionId, `${label}.sessionId`);
}

function validateWorkspaceCheckpointDetail(
  detail: Record<string, unknown>,
  label: string,
): void {
  validateWorkspaceCheckpointRecord(
    requireRecord(detail.checkpoint, `${label}.checkpoint`),
    `${label}.checkpoint`,
  );
  validateRecordArray(detail.files, `${label}.files`);
}

function validateWorkspaceDiffRecord(
  diff: Record<string, unknown>,
  label: string,
): void {
  requireNonEmptyString(diff.diffId, `${label}.diffId`);
  requireNonEmptyString(diff.sessionId, `${label}.sessionId`);
  validateRecordArray(diff.files, `${label}.files`);
}

function validateWorkspaceRestoreRecord(
  restore: Record<string, unknown>,
  label: string,
): void {
  requireNonEmptyString(restore.restoreId, `${label}.restoreId`);
  requireNonEmptyString(restore.sessionId, `${label}.sessionId`);
  requireNonEmptyString(restore.checkpointId, `${label}.checkpointId`);
  requireNonEmptyString(restore.status, `${label}.status`);
}

function validateWorkspaceCleanupRecord(
  cleanup: Record<string, unknown>,
  label: string,
): void {
  requireNonEmptyString(cleanup.cleanupId, `${label}.cleanupId`);
  requireNonEmptyString(cleanup.sessionId, `${label}.sessionId`);
  requireNonEmptyString(cleanup.trigger, `${label}.trigger`);
}

function validateWorkspacePromotionRecord(
  promotion: Record<string, unknown>,
  label: string,
): void {
  requireNonEmptyString(promotion.promotionId, `${label}.promotionId`);
  requireNonEmptyString(promotion.sessionId, `${label}.sessionId`);
  requireNonEmptyString(promotion.runId, `${label}.runId`);
  requireNonEmptyString(promotion.status, `${label}.status`);
  validateStringArray(promotion.changedFiles, `${label}.changedFiles`);
  validateOptionalNonEmptyString(
    promotion.candidateFingerprint,
    `${label}.candidateFingerprint`,
  );
}

function validateWorkspacePromotionPreview(
  preview: Record<string, unknown>,
  label: string,
): void {
  validateWorkspacePromotionRecord(
    requireRecord(preview.promotion, `${label}.promotion`),
    `${label}.promotion`,
  );
  validateEnum(preview.status, `${label}.status`, ["ready", "empty", "blocked"]);
  validateStringArray(preview.changedFiles, `${label}.changedFiles`);
  validateOptionalNonEmptyString(
    preview.candidateFingerprint,
    `${label}.candidateFingerprint`,
  );
  validateWorkspaceDiffRecord(
    requireRecord(preview.diff, `${label}.diff`),
    `${label}.diff`,
  );
}

function validateOptionalWorkspaceRecord(
  value: unknown,
  label: string,
  validate: (record: Record<string, unknown>, label: string) => void,
): void {
  if (value !== undefined) {
    validate(requireRecord(value, label), label);
  }
}

function validateOptionalWorkspaceRecordArray(
  value: unknown,
  label: string,
  validate: (record: Record<string, unknown>, label: string) => void,
): void {
  if (value !== undefined) {
    validateRecordArray(value, label, validate);
  }
}

function validateOptionalAttachments(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  validateRecordArray(value, label, (attachment, attachmentLabel) => {
    requireNonEmptyString(attachment.attachmentId, `${attachmentLabel}.attachmentId`);
    validateOptionalNonEmptyString(attachment.threadId, `${attachmentLabel}.threadId`);
    requireNonEmptyString(attachment.filename, `${attachmentLabel}.filename`);
    requireNonEmptyString(attachment.mimeType, `${attachmentLabel}.mimeType`);
    requireNonNegativeInteger(attachment.sizeBytes, `${attachmentLabel}.sizeBytes`);
    requireNonEmptyString(attachment.sha256, `${attachmentLabel}.sha256`);
    validateEnum(attachment.kind, `${attachmentLabel}.kind`, ["image", "text"]);
    validateOptionalNonEmptyString(attachment.createdAt, `${attachmentLabel}.createdAt`);
    validateOptionalString(attachment.data, `${attachmentLabel}.data`);
    validateOptionalString(attachment.text, `${attachmentLabel}.text`);
  });
}

function validateOptionalWorkspaceSkills(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  validateRecordArray(value, label, (entry, entryLabel) => {
    requireNonEmptyString(entry.installationId, `${entryLabel}.installationId`);
    requireNonEmptyString(entry.name, `${entryLabel}.name`);
    requireNonEmptyString(entry.description, `${entryLabel}.description`);
    requireNonEmptyString(entry.commitSha, `${entryLabel}.commitSha`);
    requireNonEmptyString(entry.contentDigest, `${entryLabel}.contentDigest`);
    requireNonEmptyString(entry.skillFile, `${entryLabel}.skillFile`);
  });
}

function validateOptionalHistory(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  validateRecordArray(value, label, (entry, entryLabel) => {
    validateEnum(entry.role, `${entryLabel}.role`, ["user", "assistant", "system"]);
    requireString(entry.text, `${entryLabel}.text`);
    requireNonEmptyString(entry.timestamp, `${entryLabel}.timestamp`);
    if (entry.role === "system") {
      const data = requireRecord(entry.data, `${entryLabel}.data`);
      if (data.kind !== RUNNER_WAITING_PROMPT_HISTORY_KIND) {
        throw new RunnerProtocolContractError(
          `${entryLabel}.data.kind must be '${RUNNER_WAITING_PROMPT_HISTORY_KIND}'`,
        );
      }
      validateOptionalNonEmptyString(data.runId, `${entryLabel}.data.runId`);
    } else if (entry.role === "assistant" && entry.data !== undefined) {
      const data = requireRecord(entry.data, `${entryLabel}.data`);
      if (data.kind !== RUNNER_ASSISTANT_TEXT_HISTORY_KIND) {
        throw new RunnerProtocolContractError(
          `${entryLabel}.data.kind must be '${RUNNER_ASSISTANT_TEXT_HISTORY_KIND}'`,
        );
      }
      requireNonEmptyString(data.runId, `${entryLabel}.data.runId`);
    } else if (entry.data !== undefined) {
      throw new RunnerProtocolContractError(
        `${entryLabel}.data is only valid for runtime-authored assistant text or legacy system waiting prompts`,
      );
    }
  });
}

function parseRunnerCommandMetadata(value: unknown): RunnerCommandMetadata {
  const metadata = requireRecord(value, "runner command.metadata");
  const actor = metadata.actor === undefined
    ? undefined
    : parseRunnerActorMetadata(metadata.actor);
  const tenantId = parseOptionalNonEmptyString(
    metadata.tenantId,
    "runner command.metadata.tenantId",
  );
  let profile: RunnerProfile | undefined;
  if (metadata.profile !== undefined) {
    const profileRecord = requireRecord(
      metadata.profile,
      "runner command.metadata.profile",
    );
    validateRunnerProfile(profileRecord, "runner command.metadata.profile");
    profile = profileRecord as RunnerProfile;
  }
  if (
    metadata.durability !== undefined
    && metadata.durability !== "cancel_on_disconnect"
    && metadata.durability !== "continue_on_disconnect"
  ) {
    throw new RunnerProtocolContractError(
      "runner command.metadata.durability must be 'cancel_on_disconnect' or 'continue_on_disconnect'",
    );
  }
  return {
    ...metadata,
    ...(actor !== undefined ? { actor } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(metadata.durability !== undefined
      ? { durability: metadata.durability }
      : {}),
  };
}

function parseRunnerActorMetadata(value: unknown): RunnerActorMetadata {
  const actor = requireRecord(value, "runner command.metadata.actor");
  const actorId = requireNonEmptyString(
    actor.actorId,
    "runner command.metadata.actor.actorId",
  );
  if (
    actor.actorType !== "end_user"
    && actor.actorType !== "operator"
    && actor.actorType !== "service"
  ) {
    throw new RunnerProtocolContractError(
      "runner command.metadata.actor.actorType must be 'end_user', 'operator', or 'service'",
    );
  }
  const displayName = parseOptionalNonEmptyString(
    actor.displayName,
    "runner command.metadata.actor.displayName",
  );
  const tenantId = parseOptionalNonEmptyString(
    actor.tenantId,
    "runner command.metadata.actor.tenantId",
  );
  if (actor.orgRole !== undefined && actor.orgRole !== "member" && actor.orgRole !== "org_admin") {
    throw new RunnerProtocolContractError(
      "runner command.metadata.actor.orgRole must be 'member' or 'org_admin'",
    );
  }
  return {
    actorId,
    actorType: actor.actorType,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(actor.orgRole !== undefined ? { orgRole: actor.orgRole } : {}),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerProtocolContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function validateOptionalRecord(value: unknown, label: string): void {
  if (value !== undefined) {
    requireRecord(value, label);
  }
}

function validateOptionalEnumRecord<const T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): void {
  if (value === undefined) return;
  const record = requireRecord(value, label);
  for (const [key, entry] of Object.entries(record)) {
    requireNonEmptyString(key, `${label} key`);
    if (typeof entry !== "string" || !allowed.includes(entry as T)) {
      throw new Error(`${label}.${key} must be one of: ${allowed.join(", ")}`);
    }
  }
}

function validateOptionalAutoCompaction(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  const autoCompaction = requireRecord(value, label);
  validateOptionalBoolean(autoCompaction.enabled, `${label}.enabled`);
  validateOptionalEnum(autoCompaction.state, `${label}.state`, [
    "idle",
    "armed",
    "applied",
    "suppressed",
  ]);
  validateOptionalBoolean(autoCompaction.suppressOnce, `${label}.suppressOnce`);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).find((field) => allowedFields.has(field) === false);
  if (unknown !== undefined) {
    throw new RunnerProtocolContractError(`${label}.${unknown} is not supported`);
  }
}

function validateRecordArray(
  value: unknown,
  label: string,
  validate: (record: Record<string, unknown>, label: string) => void = () => {},
): void {
  if (!Array.isArray(value)) {
    throw new RunnerProtocolContractError(`${label} must be an array`);
  }
  value.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    validate(requireRecord(entry, entryLabel), entryLabel);
  });
}

function validateOptionalRecordArray(value: unknown, label: string): void {
  if (value !== undefined) {
    validateRecordArray(value, label);
  }
}

function validatePresentationUpdateIdentity(value: unknown, label: string) {
  const update = requireRecord(value, label);
  if (update.version !== "v1") {
    throw new RunnerProtocolContractError(`${label}.version must be 'v1'`);
  }
  requireNonEmptyString(update.runId, `${label}.runId`);
  requireNonEmptyString(update.sessionId, `${label}.sessionId`);
  requireNonEmptyString(update.ts, `${label}.ts`);
  requireNonNegativeInteger(update.seq, `${label}.seq`);
  return update;
}

function validateRunnerProgressUpdate(value: unknown, label: string): void {
  const update = validatePresentationUpdateIdentity(value, label);
  validateEnum(update.kind, `${label}.kind`, ["stage", "tool", "waiting", "heartbeat"]);
  validateEnum(update.phase, `${label}.phase`, [
    "engine", "agent", "route", "chat", "thinker", "resolver", "acter",
  ]);
  validateEnum(update.code, `${label}.code`, [
    "RUN_STARTED", "RUN_RESUMED", "RESUMED_FROM_WAIT", "STEP_SELECTED",
    "STEP_STARTED", "STEP_COMMITTED", "RUN_TERMINAL", "RUN_COMPLETED",
    "RUN_FAILED", "MODEL_CALL_STARTED", "MODEL_CALL_DONE", "MODEL_CALL_FAILED",
    "TOOL_CALL_STARTED", "TOOL_CALL_DONE", "TOOL_CALL_FAILED",
    "WAITING_FOR_EVENT", "RUN_STILL_ACTIVE",
  ]);
  requireNonEmptyString(update.message, `${label}.message`);
  requireBoolean(update.persist, `${label}.persist`);
  validateOptionalNonNegativeInteger(update.stepIndex, `${label}.stepIndex`);
  validateOptionalNonEmptyString(update.stepAgent, `${label}.stepAgent`);
}

function validateRunnerAgentProgressUpdate(value: unknown, label: string): void {
  const update = validatePresentationUpdateIdentity(value, label);
  rejectUnknownFields(update, label, [
    "version", "runId", "sessionId", "ts", "seq", "message", "stepIndex", "stepAgent",
  ]);
  requireNonEmptyString(update.message, `${label}.message`);
  requireNonNegativeInteger(update.stepIndex, `${label}.stepIndex`);
  requireNonEmptyString(update.stepAgent, `${label}.stepAgent`);
}

function validateRunnerModelReasoningUpdate(
  value: unknown,
  label: string,
  expectedEvent: string,
): void {
  const update = validatePresentationUpdateIdentity(value, label);
  rejectUnknownFields(update, label, [
    "version", "runId", "sessionId", "ts", "seq", "event", "attempt", "format", "delta",
    "contentState", "stepIndex", "stepAgent", "model",
  ]);
  validateEnum(update.event, `${label}.event`, [
    "started", "delta", "completed", "failed", "unavailable",
  ]);
  if (update.event !== expectedEvent) {
    throw new RunnerProtocolContractError(
      `${label}.event must match the runner event type '${expectedEvent}'`,
    );
  }
  requireNonNegativeInteger(update.attempt, `${label}.attempt`);
  validateEnum(update.format, `${label}.format`, [
    "summary", "provider_thinking", "provider_reasoning_text",
  ]);
  validateEnum(update.contentState, `${label}.contentState`, ["live", "not_retained"]);
  validateOptionalString(update.delta, `${label}.delta`);
  if (update.contentState === "not_retained" && update.delta !== undefined) {
    throw new RunnerProtocolContractError(
      `${label}.delta must be omitted when contentState is 'not_retained'`,
    );
  }
  validateOptionalNonNegativeInteger(update.stepIndex, `${label}.stepIndex`);
  validateOptionalNonEmptyString(update.stepAgent, `${label}.stepAgent`);
  if (update.model !== undefined) {
    const model = requireRecord(update.model, `${label}.model`);
    rejectUnknownFields(model, `${label}.model`, ["provider", "model"]);
    validateOptionalNonEmptyString(model.provider, `${label}.model.provider`);
    validateOptionalNonEmptyString(model.model, `${label}.model.model`);
  }
}

function validateRunnerToolUpdate(
  value: unknown,
  label: string,
  expectedPhase: string,
): void {
  const update = validatePresentationUpdateIdentity(value, label);
  requireNonEmptyString(update.toolCallId, `${label}.toolCallId`);
  requireNonEmptyString(update.toolName, `${label}.toolName`);
  validateEnum(update.phase, `${label}.phase`, ["started", "completed", "failed"]);
  if (update.phase !== expectedPhase) {
    throw new RunnerProtocolContractError(
      `${label}.phase must match the runner event type '${expectedPhase}'`,
    );
  }
  validateOptionalNonNegativeInteger(update.stepIndex, `${label}.stepIndex`);
  validateOptionalNonEmptyString(update.stepAgent, `${label}.stepAgent`);
  validateOptionalNonEmptyString(update.displayName, `${label}.displayName`);
  validateOptionalNonEmptyString(update.toolFamily, `${label}.toolFamily`);
  validateOptionalNonEmptyString(update.provider, `${label}.provider`);
  validateOptionalNonNegativeNumber(update.durationMs, `${label}.durationMs`);
  if (update.error !== undefined) {
    const error = requireRecord(update.error, `${label}.error`);
    validateOptionalNonEmptyString(error.code, `${label}.error.code`);
    requireNonEmptyString(error.message, `${label}.error.message`);
  }
  if (update.presentation !== undefined) {
    const presentation = requireRecord(update.presentation, `${label}.presentation`);
    validateOptionalPresentationItems(
      presentation.citations,
      `${label}.presentation.citations`,
      ["id", "title"],
    );
    validateOptionalPresentationItems(
      presentation.artifacts,
      `${label}.presentation.artifacts`,
      ["id", "title", "kind"],
    );
  }
}

function validateOptionalPresentationItems(
  value: unknown,
  label: string,
  required: readonly string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new RunnerProtocolContractError(`${label} must be an array`);
  }
  for (const [index, item] of value.entries()) {
    const record = requireRecord(item, `${label}[${index}]`);
    for (const field of required) {
      requireNonEmptyString(record[field], `${label}[${index}].${field}`);
    }
    for (const field of ["url", "documentId", "excerpt", "mediaType"]) {
      validateOptionalNonEmptyString(record[field], `${label}[${index}].${field}`);
    }
    validateOptionalRecord(record.metadata, `${label}[${index}].metadata`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new RunnerProtocolContractError(`${label} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunnerProtocolContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateOptionalString(value: unknown, label: string): void {
  if (value !== undefined) {
    requireString(value, label);
  }
}

function validateOptionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined) {
    requireNonEmptyString(value, label);
  }
}

function parseOptionalNonEmptyString(
  value: unknown,
  label: string,
): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, label);
}

function validateUserTerminalRecord(record: Record<string, unknown>, label: string): void {
  requireNonEmptyString(record.terminalId, `${label}.terminalId`);
  validateEnum(record.kind, `${label}.kind`, ["user_terminal"]);
  requireNonEmptyString(record.sessionId, `${label}.sessionId`);
  requireNonEmptyString(record.threadId, `${label}.threadId`);
  requireNonEmptyString(record.workspaceRoot, `${label}.workspaceRoot`);
  requireNonEmptyString(record.cwd, `${label}.cwd`);
  requireNonEmptyString(record.shellPath, `${label}.shellPath`);
  validateEnum(record.status, `${label}.status`, ["running", "exited", "stopped", "lost"]);
  requireNonNegativeInteger(record.cols, `${label}.cols`);
  requireNonNegativeInteger(record.rows, `${label}.rows`);
  requireNonEmptyString(record.startedAt, `${label}.startedAt`);
  requireNonEmptyString(record.updatedAt, `${label}.updatedAt`);
  validateOptionalNonNegativeInteger(record.pid, `${label}.pid`);
  validateOptionalString(record.completedAt, `${label}.completedAt`);
  validateOptionalNonNegativeInteger(record.exitCode, `${label}.exitCode`);
  validateOptionalNonNegativeInteger(record.signal, `${label}.signal`);
  validateOptionalNonNegativeNumber(record.durationMs, `${label}.durationMs`);
}

function validateWorkspaceChangeScope(scope: Record<string, unknown>, label: string): void {
  validateEnum(scope.kind, `${label}.kind`, ["unstaged", "staged", "uncommitted", "branch", "commit", "pull_request", "latest_run", "latest_turn", "promotion"]);
  if (scope.kind === "branch") requireNonEmptyString(scope.baseRef, `${label}.baseRef`);
  if (scope.kind === "commit") requireNonEmptyString(scope.commitSha, `${label}.commitSha`);
  if (scope.kind === "pull_request") validateOptionalIntegerRange(scope.number, `${label}.number`, 1, Number.MAX_SAFE_INTEGER);
  if (scope.kind === "latest_run") validateOptionalNonEmptyString(scope.runId, `${label}.runId`);
  if (scope.kind === "latest_turn") validateOptionalNonEmptyString(scope.turnId, `${label}.turnId`);
  if (scope.kind === "promotion") requireNonEmptyString(scope.promotionId, `${label}.promotionId`);
}

function validateWorkspaceDiffOptions(options: Record<string, unknown>, label: string): void {
  validateOptionalIntegerRange(options.contextLines, `${label}.contextLines`, 0, 100);
  if (options.whitespace !== undefined) validateEnum(options.whitespace, `${label}.whitespace`, ["show", "ignore_all", "ignore_eol"]);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RunnerProtocolContractError(`${label} must be a non-negative integer`);
  }
  return value;
}

function validateOptionalNonNegativeInteger(value: unknown, label: string): void {
  if (value !== undefined) {
    requireNonNegativeInteger(value, label);
  }
}

function validateOptionalIntegerRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (
    value !== undefined
    && (
      typeof value !== "number"
      || !Number.isInteger(value)
      || value < minimum
      || value > maximum
    )
  ) {
    throw new RunnerProtocolContractError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

function validateOptionalNonNegativeNumber(value: unknown, label: string): void {
  if (
    value !== undefined
    && (typeof value !== "number" || !Number.isFinite(value) || value < 0)
  ) {
    throw new RunnerProtocolContractError(`${label} must be a non-negative number`);
  }
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new RunnerProtocolContractError(`${label} must be a boolean`);
  }
  return value;
}

function validateOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new RunnerProtocolContractError(`${label} must be a boolean`);
  }
}

function validateEnum<const T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== "string" || allowed.includes(value as T) === false) {
    throw new RunnerProtocolContractError(
      `${label} must be one of ${allowed.map((entry) => `'${entry}'`).join(", ")}`,
    );
  }
}

function validateOptionalEnum<const T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): void {
  if (value !== undefined) {
    validateEnum(value, label, allowed);
  }
}

function validateOptionalStringArray(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RunnerProtocolContractError(`${label} must be an array of strings`);
  }
}

function validateStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RunnerProtocolContractError(`${label} must be an array of strings`);
  }
}

function validateOptionalNonEmptyStringArray(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (
    !Array.isArray(value)
    || value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    throw new RunnerProtocolContractError(
      `${label} must be an array of non-empty strings`,
    );
  }
}

function validateNonEmptyStringArray(value: unknown, label: string): void {
  validateOptionalNonEmptyStringArray(value, label);
  if (!Array.isArray(value) || value.length === 0) {
    throw new RunnerProtocolContractError(`${label} must contain at least one entry`);
  }
}

function validateOptionalEnumArray<const T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new RunnerProtocolContractError(`${label} must be an array`);
  }
  value.forEach((entry, index) => validateEnum(entry, `${label}[${index}]`, allowed));
}

function parseAssistantText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunnerProtocolContractError(
      "runner result.assistantText must be null or a non-empty string",
    );
  }
  return value.trim();
}
