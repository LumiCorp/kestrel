import type { RunnerEvent } from "../../cli/protocol/contracts.js";
import type {
  RunnerAssistantTextHistoryDataV2,
  RunnerWaitingPromptHistoryDataV2,
} from "@kestrel-agents/protocol";
import type { TaskAction } from "../missionControl/contracts.js";
import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";
import type {
  ProductProjectBoardAction,
  ProductProjectSnapshot,
} from "../project/contracts.js";
import type {
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointRecord,
  WorkspaceCheckpointCleanupResult,
  WorkspaceDiffRecord,
  WorkspacePromotionPreview,
  WorkspacePromotionRecord,
  WorkspaceRestoreRecord,
} from "../workspaceCheckpoints/contracts.js";
import type {
  ManagedTaskWorktreeBinding,
  ManagedTaskWorktreeCleanupResult,
  ManagedTaskWorktreeLifecycleInspection,
  ManagedTaskWorktreeSetupSpec,
} from "../workspace/ManagedTaskWorktreeService.js";
import { parseManagedTaskWorktreeSetupSpec } from "../workspace/ManagedTaskWorktreeService.js";
import type { UserTerminalReadResult, UserTerminalRecord } from "../terminal/UserTerminalService.js";
import type { WorkspaceChangeMutation, WorkspaceChangeMutationResult, WorkspaceChangeScope, WorkspaceChangeSnapshot, WorkspaceDiffOptions } from "../changes/contracts.js";
import type { WorkspaceFeedbackSnapshot } from "../review/contracts.js";
import type { WorkspaceReviewSnapshot } from "../review/contracts.js";
import type { WorkspaceValidationSnapshot } from "../validation/contracts.js";
import type { WorkspaceGitAction, WorkspaceGitSnapshot } from "../git/contracts.js";
import {
  parseDesktopExecutionSelection,
  parseDesktopModelConfigurations,
  type DesktopAppDefinition,
  type DesktopExecutionSelection,
  type DesktopModelConfiguration,
} from "./configuration.js";
import type { ResolvedProviderModelCatalog } from "../profile/modelCatalogDiscovery.js";

export type DesktopRuntimeHealthState = "healthy" | "degraded" | "blocked";
export type DesktopDatabaseState = "starting" | "healthy" | "degraded" | "blocked";

export type { SupportBundle as DesktopSupportBundle } from "../diagnostics/supportBundle.js";
export type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";

export type DesktopBridgeCapabilityId =
  | "app_info"
  | "settings"
  | "capability_registry"
  | "provider_credentials"
  | "ui_state"
  | "runner_commands"
  | "support_bundle"
  | "project_picker"
  | "workspace_picker"
  | "runtime_control"
  | "database_control"
  | "file_browser"
  | "file_editor"
  | "file_write"
  | "file_watch"
  | "mcp_discovery"
  | "project_launcher"
  | "project_runs"
  | "project_run_preview"
  | "mission_control"
  | "runtime_inspection"
  | "workspace_lifecycle"
  | "user_terminal"
  | "workspace_changes"
  | "workspace_review"
  | "workspace_validation"
  | "workspace_git"
  | "attachments"
  | "operator_control"
  | "external_open"
  | "path_open"
  | "microphone"
  | "model_configurations"
  | "app_selection"
  | "commands";

export interface DesktopBridgeInfo {
  connected: boolean;
  version: string;
  capabilities: DesktopBridgeCapabilityId[];
}

export const DESKTOP_BRIDGE_VERSION = "6";

export const DESKTOP_BRIDGE_CAPABILITIES: DesktopBridgeCapabilityId[] = [
  "app_info",
  "settings",
  "capability_registry",
  "provider_credentials",
  "ui_state",
  "runner_commands",
  "support_bundle",
  "project_picker",
  "workspace_picker",
  "runtime_control",
  "database_control",
  "file_browser",
  "file_editor",
  "file_write",
  "file_watch",
  "mcp_discovery",
  "project_launcher",
  "project_runs",
  "project_run_preview",
  "mission_control",
  "runtime_inspection",
  "workspace_lifecycle",
  "user_terminal",
  "workspace_changes",
  "workspace_review",
  "workspace_validation",
  "workspace_git",
  "attachments",
  "operator_control",
  "external_open",
  "path_open",
  "microphone",
  "model_configurations",
  "app_selection",
  "commands",
];

export const DESKTOP_UI_STATE_VERSION = "desktop-ui-state-v1" as const;
export const DESKTOP_UI_STATE_SOURCE = "legacy-local-storage" as const;
export const DESKTOP_UI_STATE_RENDERER_SOURCE = "vite-renderer" as const;
export const DESKTOP_UI_STATE_MAX_BYTES = 12 * 1024 * 1024;

export const DESKTOP_LEGACY_UI_STORAGE_KEYS = [
  "kchat:web:composer-drafts:v1",
  "kchat:web:prompt-history:v1",
  "kestrel:desktop-interaction-state:v1",
  "kchat:web:theme-mode",
  "kchat:web:task-graph:v1",
  "kchat:web:threads:v2",
  "kchat:web:active-thread:v1",
  "kestrel:desktop:surface:v1",
  "kestrel:desktop:inspector-open:v1",
  "kestrel:desktop:inspector-width:v1",
  "kestrel:desktop-workspace:v5",
  "kestrel:desktop-workspace:v4",
  "kestrel:desktop-workspace:v3",
  "kestrel:desktop-workspace:v2",
  "kestrel.desktop.rail.v2",
  "kestrel.missionControl.taskQueue",
] as const;

export type DesktopLegacyUiStorageKey = typeof DESKTOP_LEGACY_UI_STORAGE_KEYS[number];
export type DesktopLegacyUiStateEntries = Partial<Record<DesktopLegacyUiStorageKey, string>>;

export interface DesktopUiStateV1 {
  version: typeof DESKTOP_UI_STATE_VERSION;
  source: typeof DESKTOP_UI_STATE_SOURCE | typeof DESKTOP_UI_STATE_RENDERER_SOURCE;
  sourceAppVersion: string;
  capturedAt: string;
  entries: DesktopLegacyUiStateEntries;
}

export interface DesktopUiStateSyncResult {
  state: DesktopUiStateV1;
  updated: boolean;
}

interface DesktopRunHistoryLineBase {
  text: string;
  timestamp: string;
  attachments?: RunTurnAttachment[] | undefined;
}

export type DesktopRunHistoryLine = DesktopRunHistoryLineBase & (
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

export interface DesktopRunTurnRequest {
  sessionId: string;
  threadId?: string | undefined;
  message: string;
  eventType: string;
  projectPath?: string | undefined;
  workspaceMode?: "local" | "managed" | undefined;
  workspaceBaseRef?: string | undefined;
  workspaceSetup?: ManagedTaskWorktreeSetupSpec | undefined;
  attachments?: RunTurnAttachment[] | undefined;
  history?: DesktopRunHistoryLine[] | undefined;
  interactionMode?: "chat" | "plan" | "build" | undefined;
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
  resumeFromWait?: boolean | undefined;
  resumeBlockedRun?: boolean | undefined;
  attachmentIds?: string[] | undefined;
  executionSelection: DesktopExecutionSelection;
}

export interface DesktopAttachmentMetadata {
  attachmentId: string;
  threadId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  kind: "image" | "text";
  createdAt: string;
  submittedAt?: string | undefined;
}

export interface DesktopOperatorInboxItem {
  itemId: string;
  kind: "approval_request" | "user_input_request" | "context_checkpoint" | "child_thread_blocker" | "stalled_thread_attention" | "assembly_change_proposal" | "compatibility_downgrade_attention" | "fan_in_checkpoint" | "child_outcome_review";
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

export interface DesktopFollowUpQueueEntry {
  followUpId: string;
  message: string;
  attachmentIds: string[];
  interactionMode?: "chat" | "plan" | "build" | undefined;
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
  createdAt: string;
  state: "queued" | "starting";
}

export interface DesktopOperatorControlRequest {
  action: "approve" | "reject" | "reply" | "steer" | "retry" | "continue_waiting" | "focus_thread" | "resolve_context_checkpoint" | "approve_assembly_change" | "reject_assembly_change" | "supersede_child_thread" | "resolve_fan_in_checkpoint" | "enqueue_follow_up" | "edit_follow_up" | "cancel_follow_up" | "resume_follow_up_queue";
  threadId: string;
  completionMode?: "terminal" | "accepted" | undefined;
  followUpId?: string | undefined;
  requestId?: string | undefined;
  proposalId?: string | undefined;
  checkpointId?: string | undefined;
  delegationId?: string | undefined;
  actionValue?: "continue" | "compact" | "summarize_forward" | "handoff" | "split_into_child_thread" | "operator_checkpoint" | "accept" | "defer" | undefined;
  message?: string | undefined;
  attachmentIds?: string[] | undefined;
  interactionMode?: "chat" | "plan" | "build" | undefined;
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
}

export function parseDesktopOperatorControlRequest(value: unknown): DesktopOperatorControlRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Desktop operator control request must be an object.");
  const input = value as Record<string, unknown>;
  const actions = new Set<DesktopOperatorControlRequest["action"]>([
    "approve", "reject", "reply", "steer", "retry", "continue_waiting", "focus_thread", "resolve_context_checkpoint",
    "approve_assembly_change", "reject_assembly_change", "supersede_child_thread", "resolve_fan_in_checkpoint",
    "enqueue_follow_up", "edit_follow_up", "cancel_follow_up", "resume_follow_up_queue",
  ]);
  if (typeof input.action !== "string" || actions.has(input.action as DesktopOperatorControlRequest["action"]) === false) {
    throw new Error("Desktop operator control action is invalid.");
  }
  const action = input.action as DesktopOperatorControlRequest["action"];
  const result: DesktopOperatorControlRequest = {
    action,
    threadId: parseRequiredDesktopString(input.threadId, "threadId"),
  };
  if (input.completionMode !== undefined) {
    if (input.completionMode !== "terminal" && input.completionMode !== "accepted") throw new Error("Desktop operator control completionMode is invalid.");
    result.completionMode = input.completionMode;
  }
  for (const field of ["followUpId", "requestId", "proposalId", "checkpointId", "delegationId", "message"] as const) {
    if (input[field] !== undefined) result[field] = parseRequiredDesktopString(input[field], field);
  }
  const actionValue = input.actionValue;
  if (actionValue !== undefined) {
    if (actionValue !== "continue" && actionValue !== "compact" && actionValue !== "summarize_forward" && actionValue !== "handoff" && actionValue !== "split_into_child_thread" && actionValue !== "operator_checkpoint" && actionValue !== "accept" && actionValue !== "defer") {
      throw new Error("Desktop operator control actionValue is invalid.");
    }
    result.actionValue = actionValue;
  }
  const attachmentIds = parseDesktopStringArray(input.attachmentIds, "attachmentIds", 8);
  if (attachmentIds !== undefined) result.attachmentIds = attachmentIds;
  if (input.interactionMode !== undefined) {
    if (input.interactionMode !== "chat" && input.interactionMode !== "plan" && input.interactionMode !== "build") throw new Error("Desktop operator control interactionMode is invalid.");
    result.interactionMode = input.interactionMode;
  }
  if (input.actSubmode !== undefined) {
    if (input.actSubmode !== "strict" && input.actSubmode !== "safe" && input.actSubmode !== "full_auto") throw new Error("Desktop operator control actSubmode is invalid.");
    result.actSubmode = input.actSubmode;
  }
  return result;
}

export interface DesktopRunCancelRequest {
  sessionId: string;
  runId?: string | undefined;
  commandId?: string | undefined;
}

export type DesktopUserTerminal = UserTerminalRecord;
export type DesktopUserTerminalReadResult = UserTerminalReadResult;
export type DesktopWorkspaceChangeScope = WorkspaceChangeScope;
export type DesktopWorkspaceDiffOptions = WorkspaceDiffOptions;
export type DesktopWorkspaceChangeMutation = WorkspaceChangeMutation;
export type DesktopWorkspaceChangeSnapshot = WorkspaceChangeSnapshot;
export type DesktopWorkspaceChangeMutationResult = WorkspaceChangeMutationResult;
export type DesktopWorkspaceFeedbackSnapshot = WorkspaceFeedbackSnapshot;
export type DesktopWorkspaceReviewSnapshot = WorkspaceReviewSnapshot;
export type DesktopWorkspaceValidationSnapshot = WorkspaceValidationSnapshot;
export type DesktopWorkspaceCheckpointCleanupResult = WorkspaceCheckpointCleanupResult;
export type DesktopWorkspaceGitAction = WorkspaceGitAction;
export type DesktopWorkspaceGitSnapshot = WorkspaceGitSnapshot;
export interface DesktopWorkspaceFeedbackSubmitResult { snapshot: WorkspaceFeedbackSnapshot; submissionRunId?: string | undefined }

export type DesktopProjectAction = TaskAction | ProductProjectBoardAction;

export interface DesktopProjectSnapshotResponse {
  sessionId: string;
  snapshot: ProductProjectSnapshot;
}

export type DesktopRuntimeThreadStatus =
  | "IDLE"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED";

export interface DesktopRuntimeThreadSummary {
  threadId: string;
  sessionId: string;
  title: string;
  status: DesktopRuntimeThreadStatus;
  agentProfileId?: string | undefined;
  agentProfileLabel?: string | undefined;
  parentThreadId?: string | undefined;
  activeRunId?: string | undefined;
  currentRequestId?: string | undefined;
  lastRunStatus?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopRuntimeThreadBlocker {
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

export interface DesktopRuntimeThreadNextAction {
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

export interface DesktopRuntimeThreadPlan {
  phase?: string | undefined;
  currentChunk?: string | undefined;
  status?: string | undefined;
  expectedNextCommand?: string | undefined;
  waitReason?: string | undefined;
  blocker?: string | undefined;
  commandNames?: string[] | undefined;
}

export interface DesktopRuntimeThreadInspection {
  thread: DesktopRuntimeThreadSummary;
  workspace?: DesktopThreadWorkspaceContext | undefined;
  focusedThreadId?: string | undefined;
  parentThread?: DesktopRuntimeThreadSummary | undefined;
  childThreads: DesktopRuntimeThreadSummary[];
  operatorPhase?: "assemble" | "decide" | "act" | "observe" | "wait" | "finalize" | undefined;
  blocker?: DesktopRuntimeThreadBlocker | undefined;
  nextAction?: DesktopRuntimeThreadNextAction | undefined;
  runtimePlan?: DesktopRuntimeThreadPlan | undefined;
  activeRun?: { runId: string; status: "RUNNING" | "WAITING" } | undefined;
  followUpQueue: {
    state: "ready" | "paused";
    pauseReason?: "waiting" | "failed" | "cancelled" | "operator" | undefined;
    items: DesktopFollowUpQueueEntry[];
  };
  inboxItems: DesktopOperatorInboxItem[];
  latestSteering?: {
    message: string;
    issuedBy?: string | undefined;
    at: string;
    runId?: string | undefined;
  } | undefined;
}

export interface DesktopThreadWorkspaceContext {
  kind: "local" | "managed";
  workspaceId?: string | undefined;
  label: string;
  workspaceRoot: string;
  sourceWorkspaceRoot: string;
  sourceRepoRoot?: string | undefined;
  managedWorktreeRoot?: string | undefined;
  baseRefName?: string | undefined;
  baseHead?: string | undefined;
  lastObservedSourceHead?: string | undefined;
  leaseId?: string | undefined;
  leaseKind?: "run" | "process" | undefined;
  dirty?: boolean | undefined;
}

export interface DesktopWorkspaceLifecycleState {
  sessionId: string;
  checkpoints: WorkspaceCheckpointRecord[];
  promotions: WorkspacePromotionRecord[];
}

export interface DesktopWorkspaceCheckpointCaptureResult {
  sessionId: string;
  checkpoint: WorkspaceCheckpointDetail;
}

export interface DesktopWorkspaceCheckpointRestoreResult {
  sessionId: string;
  restore: WorkspaceRestoreRecord;
}

export interface DesktopWorkspaceCheckpointInspectResult {
  sessionId: string;
  checkpoint: WorkspaceCheckpointDetail;
}

export interface DesktopWorkspaceCheckpointDiffResult {
  sessionId: string;
  diff: WorkspaceDiffRecord;
}

export interface DesktopWorkspacePromotionPreviewResult {
  sessionId: string;
  preview: WorkspacePromotionPreview;
}

export interface DesktopWorkspacePromotionApplyResult {
  sessionId: string;
  promotion: WorkspacePromotionRecord;
}

export interface DesktopWorkspacePromotionUndoResult {
  sessionId: string;
  restore: WorkspaceRestoreRecord;
}

export interface DesktopManagedWorktreeInspectionResult {
  sessionId: string;
  inspection: ManagedTaskWorktreeLifecycleInspection;
}

export interface DesktopManagedWorktreeCleanupResult {
  sessionId: string;
  checkpoint: WorkspaceCheckpointDetail;
  cleanup: ManagedTaskWorktreeCleanupResult;
}

export interface DesktopManagedWorktreeRestoreResult {
  sessionId: string;
  binding: ManagedTaskWorktreeBinding;
  restore: WorkspaceRestoreRecord;
}

export type DesktopRuntimeRunStatus = "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";

export interface DesktopRuntimeRunTimelineEntry {
  seq: number;
  at: string;
  label: string;
  detail?: string | undefined;
  source: "engine" | "agent" | "wait" | "scheduler" | "terminal" | "tooling";
  step?: string | undefined;
  stepIndex?: number | undefined;
}

export interface DesktopRuntimeRunInspection {
  version: "operator-run-v1";
  run: {
    runId: string;
    sessionId: string;
    eventType: string;
    status: DesktopRuntimeRunStatus;
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
    terminalStatus?: DesktopRuntimeRunStatus | undefined;
    stepsObserved: number;
    progressToolCalls: number;
    waitingMilestones: number;
    truncated: boolean;
    requestedLimit?: number | undefined;
  };
  diagnosis: {
    status: DesktopRuntimeRunStatus | "UNKNOWN" | "STALLED";
    finalStep?: string | undefined;
    terminalReasonCode?: string | undefined;
    actionable: boolean;
    dominantFailure?: {
      classification: string;
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
  runtimePlan?: DesktopRuntimeThreadPlan | undefined;
  timeline: DesktopRuntimeRunTimelineEntry[];
}

export interface DesktopRuntimeRunIndexQuery {
  sessionId?: string | undefined;
  status?: DesktopRuntimeRunStatus | undefined;
  limit?: number | undefined;
}

export interface DesktopRuntimeRunIndexEntry {
  run: DesktopRuntimeRunInspection["run"];
  threadId?: string | undefined;
  summary: {
    eventCount: number;
    truncated: boolean;
  };
  diagnosis: {
    status: DesktopRuntimeRunInspection["diagnosis"]["status"];
    finalStep?: string | undefined;
    terminalReasonCode?: string | undefined;
    actionable: boolean;
    dominantFailure?: DesktopRuntimeRunInspection["diagnosis"]["dominantFailure"] | undefined;
    wait?: DesktopRuntimeRunInspection["diagnosis"]["wait"] | undefined;
  };
}

export interface DesktopRuntimeSessionIndexEntry {
  sessionId: string;
  runCount: number;
  statusCounts: Record<DesktopRuntimeRunStatus, number>;
  latestRunId: string;
  latestStatus: DesktopRuntimeRunStatus;
  latestStartedAt: string;
}

export interface DesktopRuntimeRunIndex {
  version: "operator-run-index-v1";
  generatedAt: string;
  filters: {
    sessionId?: string | undefined;
    status?: DesktopRuntimeRunStatus | undefined;
    limit: number;
  };
  hasMore: boolean;
  runs: DesktopRuntimeRunIndexEntry[];
  sessions: DesktopRuntimeSessionIndexEntry[];
}

export type DesktopRunnerEvent = RunnerEvent;

export function parseDesktopRunTurnRequest(value: unknown): DesktopRunTurnRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop run request must be an object.");
  }
  const input = value as Record<string, unknown>;
  const sessionId = parseRequiredDesktopString(input.sessionId, "sessionId");
  const threadId = input.threadId === undefined ? undefined : parseRequiredDesktopString(input.threadId, "threadId");
  const message = parseRequiredDesktopText(input.message, "message");
  const eventType = parseRequiredDesktopString(input.eventType, "eventType");
  const projectPath = input.projectPath === undefined
    ? undefined
    : parseRequiredDesktopString(input.projectPath, "projectPath");
  const workspaceMode = input.workspaceMode;
  if (workspaceMode !== undefined && workspaceMode !== "local" && workspaceMode !== "managed") {
    throw new Error("Desktop run request workspaceMode is invalid.");
  }
  const workspaceBaseRef = input.workspaceBaseRef === undefined
    ? undefined
    : parseRequiredDesktopString(input.workspaceBaseRef, "workspaceBaseRef");
  const workspaceSetup = parseManagedTaskWorktreeSetupSpec(input.workspaceSetup);
  const attachments = parseDesktopRunTurnAttachments(input.attachments, "attachments");
  if (attachments?.some((attachment) => attachment.threadId !== undefined && attachment.threadId !== sessionId)) {
    throw new Error("Desktop run request attachments must belong to the active session.");
  }
  const interactionMode = input.interactionMode;
  if (
    interactionMode !== undefined
    && interactionMode !== "chat"
    && interactionMode !== "plan"
    && interactionMode !== "build"
  ) {
    throw new Error("Desktop run request interactionMode is invalid.");
  }
  const actSubmode = input.actSubmode;
  if (
    actSubmode !== undefined
    && actSubmode !== "strict"
    && actSubmode !== "safe"
    && actSubmode !== "full_auto"
  ) {
    throw new Error("Desktop run request actSubmode is invalid.");
  }
  if (input.history !== undefined && Array.isArray(input.history) === false) {
    throw new Error("Desktop run request history must be an array.");
  }
  const history = input.history === undefined
    ? undefined
    : input.history.map((line, index) => parseDesktopRunHistoryLine(line, index));
  const attachmentIds = parseDesktopStringArray(input.attachmentIds, "attachmentIds", 8);
  return {
    sessionId,
    ...(threadId !== undefined ? { threadId } : {}),
    message,
    eventType,
    ...(projectPath !== undefined ? { projectPath } : {}),
    ...(workspaceMode !== undefined ? { workspaceMode } : {}),
    ...(workspaceBaseRef !== undefined ? { workspaceBaseRef } : {}),
    ...(workspaceSetup !== undefined ? { workspaceSetup } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(history !== undefined ? { history } : {}),
    ...(interactionMode !== undefined ? { interactionMode } : {}),
    ...(actSubmode !== undefined ? { actSubmode } : {}),
    ...(input.resumeFromWait === true ? { resumeFromWait: true } : {}),
    ...(input.resumeBlockedRun === true ? { resumeBlockedRun: true } : {}),
    ...(attachmentIds !== undefined ? { attachmentIds } : {}),
    executionSelection: parseDesktopExecutionSelection(input.executionSelection),
  };
}

function parseDesktopStringArray(value: unknown, field: string, max: number): string[] | undefined {
  if (value === undefined) return;
  if (Array.isArray(value) === false || value.length > max) throw new Error(`Desktop request field '${field}' must be an array with at most ${max} entries.`);
  const parsed = value.map((entry, index) => parseRequiredDesktopString(entry, `${field}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`Desktop request field '${field}' cannot contain duplicates.`);
  return parsed;
}

export function parseDesktopRunCancelRequest(value: unknown): DesktopRunCancelRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop cancel request must be an object.");
  }
  const input = value as Record<string, unknown>;
  return {
    sessionId: parseRequiredDesktopString(input.sessionId, "sessionId"),
    ...parseOptionalDesktopString(input.runId, "runId"),
    ...parseOptionalDesktopString(input.commandId, "commandId"),
  };
}

function parseDesktopRunHistoryLine(value: unknown, index: number): DesktopRunHistoryLine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Desktop run history[${index}] must be an object.`);
  }
  const input = value as Record<string, unknown>;
  if (input.role !== "user" && input.role !== "assistant" && input.role !== "system") {
    throw new Error(`Desktop run history[${index}].role is invalid.`);
  }
  const timestamp = parseRequiredDesktopString(input.timestamp, `history[${index}].timestamp`);
  const parsedTimestamp = new Date(timestamp);
  if (
    Number.isFinite(parsedTimestamp.getTime()) === false
    || parsedTimestamp.toISOString() !== timestamp
  ) {
    throw new Error(`Desktop run history[${index}].timestamp must be an ISO timestamp.`);
  }
  const parsed = {
    text: parseRequiredDesktopText(input.text, `history[${index}].text`),
    timestamp,
    ...parseOptionalDesktopRunTurnAttachments(input.attachments, `history[${index}].attachments`),
  };
  if (input.role === "system") {
    const data = typeof input.data === "object" && input.data !== null && Array.isArray(input.data) === false
      ? input.data as Record<string, unknown>
      : undefined;
    if (data?.kind !== "runtime.waiting_prompt") {
      throw new Error(
        `Desktop run history[${index}] system entries must be tagged as runtime.waiting_prompt.`,
      );
    }
    const runId = typeof data.runId === "string" && data.runId.trim().length > 0
      ? data.runId.trim()
      : undefined;
    return {
      ...parsed,
      role: "system",
      data: {
        kind: "runtime.waiting_prompt",
        ...(runId !== undefined ? { runId } : {}),
      },
    };
  }
  return {
    ...parsed,
    role: input.role,
  };
}

function parseOptionalDesktopRunTurnAttachments(
  value: unknown,
  field: string,
): { attachments?: RunTurnAttachment[] | undefined } {
  const attachments = parseDesktopRunTurnAttachments(value, field);
  return attachments === undefined ? {} : { attachments };
}

function parseDesktopRunTurnAttachments(
  value: unknown,
  field: string,
): RunTurnAttachment[] | undefined {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value) === false || value.length > 8) {
    throw new Error(`Desktop request field '${field}' must contain at most 8 attachments.`);
  }
  let totalBytes = 0;
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Desktop request field '${field}[${index}]' must be an object.`);
    }
    const attachment = entry as Record<string, unknown>;
    const attachmentId = parseRequiredDesktopString(attachment.attachmentId, `${field}[${index}].attachmentId`);
    const filename = parseRequiredDesktopString(attachment.filename, `${field}[${index}].filename`);
    const mimeType = parseRequiredDesktopString(attachment.mimeType, `${field}[${index}].mimeType`);
    const sha256 = parseRequiredDesktopString(attachment.sha256, `${field}[${index}].sha256`);
    if (/^[a-f0-9]{64}$/u.test(sha256) === false) {
      throw new Error(`Desktop request field '${field}[${index}].sha256' must be a SHA-256 digest.`);
    }
    if (
      typeof attachment.sizeBytes !== "number" ||
      Number.isInteger(attachment.sizeBytes) === false ||
      attachment.sizeBytes < 0 ||
      attachment.sizeBytes > 5 * 1024 * 1024
    ) {
      throw new Error(`Desktop request field '${field}[${index}].sizeBytes' is invalid.`);
    }
    totalBytes += attachment.sizeBytes;
    if (totalBytes > 10 * 1024 * 1024) {
      throw new Error(`Desktop request field '${field}' exceeds the 10 MB attachment limit.`);
    }
    if (attachment.kind !== "text" && attachment.kind !== "image") {
      throw new Error(`Desktop request field '${field}[${index}].kind' is invalid.`);
    }
    if (attachment.kind === "text" && typeof attachment.text !== "string") {
      throw new Error(`Desktop text attachment '${field}[${index}]' requires text.`);
    }
    if (attachment.kind === "image" && typeof attachment.data !== "string") {
      throw new Error(`Desktop image attachment '${field}[${index}]' requires data.`);
    }
    if (
      (typeof attachment.text === "string" && new TextEncoder().encode(attachment.text).byteLength > 5 * 1024 * 1024) ||
      (typeof attachment.data === "string" && attachment.data.length > 7 * 1024 * 1024)
    ) {
      throw new Error(`Desktop attachment '${field}[${index}]' payload is too large.`);
    }
    const threadId = attachment.threadId === undefined
      ? undefined
      : parseRequiredDesktopString(attachment.threadId, `${field}[${index}].threadId`);
    const createdAt = attachment.createdAt === undefined
      ? undefined
      : parseRequiredDesktopString(attachment.createdAt, `${field}[${index}].createdAt`);
    return {
      attachmentId,
      filename,
      mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256,
      kind: attachment.kind,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(typeof attachment.data === "string" ? { data: attachment.data } : {}),
      ...(typeof attachment.text === "string" ? { text: attachment.text } : {}),
    };
  });
}

function parseRequiredDesktopString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Desktop request field '${field}' must be a non-empty string.`);
  }
  return value.trim();
}

function parseRequiredDesktopText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Desktop request field '${field}' must be a non-empty string.`);
  }
  return value;
}

function parseOptionalDesktopString(
  value: unknown,
  field: "runId" | "commandId",
): Partial<Record<"runId" | "commandId", string>> {
  if (value === undefined) {
    return {};
  }
  return { [field]: parseRequiredDesktopString(value, field) };
}

export function parseDesktopLegacyUiStateEntries(value: unknown): DesktopLegacyUiStateEntries {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop legacy UI state entries must be an object.");
  }
  const input = value as Record<string, unknown>;
  const knownKeys = new Set<string>(DESKTOP_LEGACY_UI_STORAGE_KEYS);
  const unknownKey = Object.keys(input).find((key) => knownKeys.has(key) === false);
  if (unknownKey !== undefined) {
    throw new Error(`Desktop legacy UI state includes unsupported key '${unknownKey}'.`);
  }

  const entries: DesktopLegacyUiStateEntries = {};
  for (const key of DESKTOP_LEGACY_UI_STORAGE_KEYS) {
    const candidate = input[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "string") {
      throw new Error(`Desktop legacy UI state entry '${key}' must be a string.`);
    }
    entries[key] = candidate;
  }
  if (new TextEncoder().encode(JSON.stringify(entries)).byteLength > DESKTOP_UI_STATE_MAX_BYTES) {
    throw new Error("Desktop legacy UI state exceeds the supported size.");
  }
  return entries;
}

export function parseDesktopUiStateV1(value: unknown): DesktopUiStateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop UI state must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== DESKTOP_UI_STATE_VERSION) {
    throw new Error(`Desktop UI state version must be '${DESKTOP_UI_STATE_VERSION}'.`);
  }
  if (
    input.source !== DESKTOP_UI_STATE_SOURCE
    && input.source !== DESKTOP_UI_STATE_RENDERER_SOURCE
  ) {
    throw new Error("Desktop UI state source is invalid.");
  }
  if (typeof input.sourceAppVersion !== "string" || input.sourceAppVersion.trim().length === 0) {
    throw new Error("Desktop UI state sourceAppVersion must be a non-empty string.");
  }
  const capturedAt = typeof input.capturedAt === "string"
    ? new Date(input.capturedAt)
    : undefined;
  if (
    capturedAt === undefined
    || Number.isFinite(capturedAt.getTime()) === false
    || capturedAt.toISOString() !== input.capturedAt
  ) {
    throw new Error("Desktop UI state capturedAt must be an ISO timestamp.");
  }
  return {
    version: DESKTOP_UI_STATE_VERSION,
    source: input.source,
    sourceAppVersion: input.sourceAppVersion.trim(),
    capturedAt: capturedAt.toISOString(),
    entries: parseDesktopLegacyUiStateEntries(input.entries),
  };
}

export interface DesktopDatabaseStatus {
  state: DesktopDatabaseState;
  summary: string;
  managed: boolean;
  initialized: boolean;
  running: boolean;
  host?: string | undefined;
  port?: number | undefined;
  database?: string | undefined;
  logPath?: string | undefined;
  lastError?:
    | {
        code: string;
        message: string;
        details?: Record<string, unknown> | undefined;
      }
    | undefined;
}

export interface DesktopRuntimeHealth {
  state: DesktopRuntimeHealthState;
  summary: string;
  code?: string | undefined;
  details?: string | undefined;
  running: boolean;
  logPath?: string | undefined;
  database?: DesktopDatabaseStatus | undefined;
}

export type DesktopBootPhase =
  | "idle"
  | "starting_database"
  | "starting_runtime"
  | "starting_web"
  | "ready"
  | "failed";

export type DesktopReadinessItemId =
  | "resources"
  | "settings"
  | "provider"
  | "database"
  | "runner"
  | "web"
  | "bridge"
  | "projects";

export type DesktopReadinessState =
  | "ready"
  | "starting"
  | "degraded"
  | "blocked"
  | "unknown"
  | "not_applicable";

export interface DesktopReadinessAction {
  label: string;
  command:
    | "open_settings"
    | "open_logs"
    | "restart_runtime"
    | "restart_database"
    | "repair_database"
    | "add_project"
    | "copy_help_packet"
    | "reinstall_desktop";
}

export interface DesktopReadinessItem {
  id: DesktopReadinessItemId;
  label: string;
  state: DesktopReadinessState;
  detail: string;
  evidence?: string | undefined;
  action?: DesktopReadinessAction | undefined;
}

export interface DesktopReadinessSummary {
  state: Exclude<DesktopReadinessState, "not_applicable">;
  title: string;
  detail: string;
}

export interface DesktopReadinessView {
  summary: DesktopReadinessSummary;
  items: DesktopReadinessItem[];
}

export interface DesktopBootEvent {
  at: string;
  phase: DesktopBootPhase;
  message: string;
}

export interface DesktopBootState {
  phase: DesktopBootPhase;
  message: string;
  code?: string | undefined;
  webUrl?: string | undefined;
  details?: string | undefined;
  database?: DesktopDatabaseStatus | undefined;
  readiness?: DesktopReadinessView | undefined;
  timeline?: DesktopBootEvent[] | undefined;
  startedAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface DesktopRuntimeStoreReset {
  storePath: string;
  archivedStorePath?: string | undefined;
  resetAt: string;
}

export interface DesktopProjectRegistration {
  path: string;
  label: string;
}

export type DesktopPackageManager = "npm" | "pnpm";

export interface DesktopProjectLauncherScript {
  name: string;
  command: string;
}

export interface DesktopProjectLauncherDescriptor {
  projectPath: string;
  manifestPath: string;
  scripts: DesktopProjectLauncherScript[];
  packageManager?: DesktopPackageManager | undefined;
  packageManagerSelectionRequired: boolean;
  unsupportedPackageManager?: string | undefined;
}

export type DesktopManagedProjectRunStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped";

export interface DesktopManagedProjectRunPreviewUrl {
  url: string;
  source: "stdout" | "stderr";
  firstSeenAt: string;
  lastSeenAt: string;
  line: string;
  count: number;
}

export interface DesktopManagedProjectRun {
  runId: string;
  projectPath: string;
  manifestPath: string;
  scriptName: string;
  packageManager: DesktopPackageManager;
  command: string;
  status: DesktopManagedProjectRunStatus;
  startedAt: string;
  updatedAt: string;
  pendingAction?: "stop" | "restart" | undefined;
  completedAt?: string | undefined;
  exitCode?: number | undefined;
  stopSignal?: string | undefined;
  previewUrls?: DesktopManagedProjectRunPreviewUrl[] | undefined;
  primaryPreviewUrl?: string | undefined;
  stdoutTail: string[];
  stderrTail: string[];
}

export interface DesktopPreviewDiagnostic {
  webContentsId: number;
  kind: "console" | "network_error" | "load_error";
  message: string;
  url?: string | undefined;
  level?: number | undefined;
  at: string;
}

export type DesktopModelProvider = "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";
export type DesktopAppearanceTheme = "system" | "light" | "dark";
export type DesktopDatabaseMode = "default" | "external";
export type DesktopShellPresetId = "desktop_dev_local";
export type DesktopCapabilityPackId =
  | "balanced"
  | "filesystem"
  | "dev_shell"
  | "desktop_host"
  | "sandbox_code";

export type DesktopCapabilityCategory =
  | "models"
  | "tools_services"
  | "local_capabilities"
  | "connections"
  | "workspace_data"
  | "permissions";

export type DesktopCapabilityId =
  | "model.openrouter"
  | "model.openai"
  | "model.anthropic"
  | "model.ollama"
  | "model.lmstudio"
  | "tools.internet.tavily"
  | "tools.weather"
  | "tools.network.free"
  | "local.filesystem"
  | "local.developer_shell"
  | "local.sandbox_code"
  | "connections.mcp"
  | "data.workspace"
  | "data.database"
  | "permission.microphone";

export type DesktopCapabilityReadiness =
  | "ready"
  | "optional"
  | "setup_required"
  | "unavailable"
  | "verification_failed"
  | "disabled";

export type DesktopCapabilityRequirementKind =
  | "credential"
  | "configuration"
  | "connectivity"
  | "local_prerequisite"
  | "permission";

export interface DesktopCapabilityRequirement {
  kind: DesktopCapabilityRequirementKind;
  label: string;
  satisfied: boolean;
  detail?: string | undefined;
}

export interface DesktopCapabilitySettingField {
  key: string;
  label: string;
  kind: "text" | "url" | "secret" | "boolean" | "select";
  required: boolean;
  secret: boolean;
  value?: string | boolean | undefined;
  placeholder?: string | undefined;
  options?: Array<{ value: string; label: string }> | undefined;
}

/** Renderer-safe capability status. Secret values are never represented here. */
export interface DesktopCapability {
  id: DesktopCapabilityId;
  category: DesktopCapabilityCategory;
  name: string;
  description: string;
  toolNames: string[];
  enabled: boolean;
  readiness: DesktopCapabilityReadiness;
  detail: string;
  requirements: DesktopCapabilityRequirement[];
  settings: DesktopCapabilitySettingField[];
  verificationStrategy: string;
  runtimeApplication: string;
  settingsSection: string;
  lastVerifiedAt?: string | undefined;
}

export interface DesktopCapabilityView {
  capabilities: DesktopCapability[];
  credentialStore: {
    available: boolean;
    backend: DesktopCredentialBackend;
  };
  refreshedAt: string;
}

export type DesktopCredentialBackend = "macos_keychain" | "unavailable";

export type DesktopCapabilitySettingValue = string | boolean | null;

export interface DesktopCapabilityConfigurationInput {
  capabilityId: DesktopCapabilityId;
  enabled?: boolean | undefined;
  settings?: Record<string, DesktopCapabilitySettingValue> | undefined;
  /** Write-only. A string replaces the credential; null removes it. */
  credential?: string | null | undefined;
}

export interface DesktopCapabilityConfigurationResult {
  capabilityId: DesktopCapabilityId;
  applied: boolean;
  runtimeRestarted: boolean;
  view: DesktopCapabilityView;
}

export function parseDesktopCapabilityConfigurationInput(
  value: unknown,
): DesktopCapabilityConfigurationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop capability configuration must be an object.");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["capabilityId", "enabled", "settings", "credential"]);
  const unsupported = Object.keys(input).find((key) => allowed.has(key) === false);
  if (unsupported !== undefined) {
    throw new Error(`Desktop capability configuration includes unsupported field '${unsupported}'.`);
  }
  const capabilityId = parseDesktopCapabilityId(input.capabilityId);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new Error("Desktop capability configuration enabled must be a boolean.");
  }
  if (
    input.credential !== undefined
    && input.credential !== null
    && (typeof input.credential !== "string" || input.credential.trim().length === 0)
  ) {
    throw new Error("Desktop capability credential must be a non-empty string or null.");
  }
  let settings: Record<string, DesktopCapabilitySettingValue> | undefined;
  if (input.settings !== undefined) {
    if (typeof input.settings !== "object" || input.settings === null || Array.isArray(input.settings)) {
      throw new Error("Desktop capability settings must be an object.");
    }
    settings = {};
    for (const [key, setting] of Object.entries(input.settings as Record<string, unknown>)) {
      if (key.trim().length === 0 || key.length > 80) {
        throw new Error("Desktop capability setting keys must be non-empty and bounded.");
      }
      if (
        setting !== null
        && typeof setting !== "boolean"
        && (typeof setting !== "string" || setting.length > 4096)
      ) {
        throw new Error(`Desktop capability setting '${key}' is invalid.`);
      }
      settings[key] = setting as DesktopCapabilitySettingValue;
    }
  }
  return {
    capabilityId,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(settings !== undefined ? { settings } : {}),
    ...(input.credential !== undefined
      ? { credential: input.credential as string | null }
      : {}),
  };
}

function parseDesktopCapabilityId(value: unknown): DesktopCapabilityId {
  const ids: DesktopCapabilityId[] = [
    "model.openrouter", "model.openai", "model.anthropic", "model.ollama", "model.lmstudio",
    "tools.internet.tavily", "tools.weather", "tools.network.free",
    "local.filesystem", "local.developer_shell", "local.sandbox_code",
    "connections.mcp", "data.workspace", "data.database", "permission.microphone",
  ];
  if (typeof value !== "string" || ids.includes(value as DesktopCapabilityId) === false) {
    throw new Error("Desktop capability ID is not supported.");
  }
  return value as DesktopCapabilityId;
}

export interface DesktopAgentStageConfig {
  modelByStage?: Record<string, string> | undefined;
}

export interface DesktopSettings {
  selectedProvider: DesktopModelProvider;
  databaseMode: DesktopDatabaseMode;
  presetId: DesktopShellPresetId;
  capabilityPacks: DesktopCapabilityPackId[];
  projects: DesktopProjectRegistration[];
  mcpServers: DesktopMcpServerConfig[];
  capabilityVerifications: Partial<Record<DesktopCapabilityId, string>>;
  developerShellPath?: string | undefined;
  developerPath?: string | undefined;
  developerShellEnvMode: "inherit" | "allowlist";
  developerShellAllowedEnvNames: string[];
  approvalPolicyPackId: "dev" | "ci_bot" | "production";
  agentStageConfig?: DesktopAgentStageConfig | undefined;
  modelTimeoutMs?: number | undefined;
  databaseUrl?: string | undefined;
  openrouterApiKey?: string | undefined;
  openrouterModel?: string | undefined;
  openrouterBaseUrl?: string | undefined;
  openrouterSiteUrl?: string | undefined;
  openrouterAppName?: string | undefined;
  openaiApiKey?: string | undefined;
  openaiModel?: string | undefined;
  openaiBaseUrl?: string | undefined;
  openaiOrgId?: string | undefined;
  openaiProjectId?: string | undefined;
  anthropicApiKey?: string | undefined;
  anthropicModel?: string | undefined;
  anthropicBaseUrl?: string | undefined;
  anthropicVersion?: string | undefined;
  ollamaModel?: string | undefined;
  ollamaBaseUrl?: string | undefined;
  lmstudioModel?: string | undefined;
  lmstudioBaseUrl?: string | undefined;
  tavilyApiKey?: string | undefined;
  tavilyBaseUrl?: string | undefined;
  tavilyProject?: string | undefined;
  tavilyHttpProxy?: string | undefined;
  tavilyHttpsProxy?: string | undefined;
  providerSelectionCompletedAt?: string | undefined;
  setupCompletedAt?: string | undefined;
  advancedWorkspaceEnabled: boolean;
  modelConfigurations: DesktopModelConfiguration[];
  defaultModelConfigurationId: string;
  defaultEnabledAppIds: string[];
  appearanceTheme: DesktopAppearanceTheme;
}

export interface DesktopProviderReadiness {
  provider: DesktopModelProvider;
  configured: boolean;
  requiresCredential: boolean;
}

export interface DesktopRendererSettings {
  selectedProvider: DesktopModelProvider;
  databaseMode: DesktopDatabaseMode;
  presetId: DesktopShellPresetId;
  capabilityPacks: DesktopCapabilityPackId[];
  projects: DesktopProjectRegistration[];
  providerSelectionCompletedAt?: string | undefined;
  setupCompletedAt?: string | undefined;
  advancedWorkspaceEnabled: boolean;
  modelConfigurations: DesktopModelConfiguration[];
  defaultModelConfigurationId: string;
  defaultEnabledAppIds: string[];
  appearanceTheme: DesktopAppearanceTheme;
  apps: DesktopAppDefinition[];
  providerReadiness: DesktopProviderReadiness[];
}

export interface DesktopRendererSettingsUpdate {
  projects?: DesktopProjectRegistration[] | undefined;
  modelConfigurations?: DesktopModelConfiguration[] | undefined;
  defaultModelConfigurationId?: string | undefined;
  defaultEnabledAppIds?: string[] | undefined;
  appearanceTheme?: DesktopAppearanceTheme | undefined;
}

export type DesktopCredentialedModelProvider = "openrouter" | "openai" | "anthropic";

export function parseDesktopRendererSettingsUpdate(
  value: unknown,
): DesktopRendererSettingsUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop settings update must be an object.");
  }
  const input = value as Record<string, unknown>;
  const supportedKeys = new Set([
    "projects",
    "modelConfigurations",
    "defaultModelConfigurationId",
    "defaultEnabledAppIds",
    "appearanceTheme",
  ]);
  const unsupportedKey = Object.keys(input).find((key) => supportedKeys.has(key) === false);
  if (unsupportedKey !== undefined) {
    throw new Error(`Desktop settings update includes unsupported field '${unsupportedKey}'.`);
  }

  const update: DesktopRendererSettingsUpdate = {};
  if (input.projects !== undefined) {
    if (Array.isArray(input.projects) === false) {
      throw new Error("Desktop settings update projects must be an array.");
    }
    update.projects = input.projects.map((project, index) => {
      if (typeof project !== "object" || project === null || Array.isArray(project)) {
        throw new Error(`Desktop settings update projects[${index}] must be an object.`);
      }
      const entry = project as Record<string, unknown>;
      return {
        path: parseRequiredDesktopString(entry.path, `projects[${index}].path`),
        label: parseRequiredDesktopString(entry.label, `projects[${index}].label`),
      };
    });
  }
  if (input.modelConfigurations !== undefined) {
    update.modelConfigurations = parseDesktopModelConfigurations(input.modelConfigurations);
  }
  if (input.defaultModelConfigurationId !== undefined) {
    update.defaultModelConfigurationId = parseRequiredDesktopString(
      input.defaultModelConfigurationId,
      "defaultModelConfigurationId",
    );
  }
  if (input.defaultEnabledAppIds !== undefined) {
    if (
      Array.isArray(input.defaultEnabledAppIds) === false
      || input.defaultEnabledAppIds.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
    ) {
      throw new Error("Desktop settings update defaultEnabledAppIds must be an array of strings.");
    }
    update.defaultEnabledAppIds = [...new Set(input.defaultEnabledAppIds.map((entry) => entry.trim()))].sort();
  }
  if (input.appearanceTheme !== undefined) {
    if (
      input.appearanceTheme !== "system"
      && input.appearanceTheme !== "light"
      && input.appearanceTheme !== "dark"
    ) {
      throw new Error("Desktop settings update appearanceTheme is invalid.");
    }
    update.appearanceTheme = input.appearanceTheme;
  }
  return update;
}

export type DesktopProviderModelCatalog = ResolvedProviderModelCatalog;
export type DesktopShellCommand =
  | "add-project"
  | "new-thread"
  | "stop-agent"
  | "toggle-left-sidebar"
  | "toggle-right-sidebar"
  | "restart-runtime";

export type DesktopFileEntryKind = "file" | "directory";
export type DesktopFileViewKind = "markdown" | "code" | "text" | "binary";

export interface DesktopFileEntry {
  path: string;
  name: string;
  kind: DesktopFileEntryKind;
  modifiedAt?: string | undefined;
  sizeBytes?: number | undefined;
}

export interface DesktopDirectoryListing {
  rootPath: string;
  directoryPath: string;
  entries: DesktopFileEntry[];
}

export interface DesktopFileSearchResult {
  path: string;
  name: string;
  directoryPath: string;
}

export interface DesktopFileSearchResponse {
  rootPath: string;
  query: string;
  results: DesktopFileSearchResult[];
  truncated: boolean;
  fullSearchAvailable: boolean;
}

export interface DesktopFileContentSearchResult extends DesktopFileSearchResult {
  lineNumber: number;
  columnNumber: number;
  preview: string;
}

export interface DesktopFileContentSearchResponse {
  rootPath: string;
  query: string;
  results: DesktopFileContentSearchResult[];
  truncated: boolean;
  fullSearchAvailable: boolean;
  scannedFileCount: number;
  skippedFileCount: number;
}

export interface DesktopFileContent {
  path: string;
  content: string;
  viewKind: DesktopFileViewKind;
  language?: string | undefined;
  contentHash?: string | undefined;
  modifiedAt?: string | undefined;
  sizeBytes?: number | undefined;
  lineEnding?: "lf" | "crlf" | "cr" | "mixed" | "none" | undefined;
  editable?: boolean | undefined;
  readOnlyReason?: "large_file" | "mixed_line_endings" | undefined;
}

export interface DesktopPathTargetInput {
  rootPath: string;
  targetPath: string;
  threadId?: string | undefined;
}

export interface DesktopFileReadInput extends DesktopPathTargetInput {}

export interface DesktopFileWriteInput extends DesktopPathTargetInput {
  content: string;
  expectedContentHash?: string | undefined;
  lineEnding?: "lf" | "crlf" | "cr" | "none" | undefined;
}

export interface DesktopOpenFileEditorInput {
  filePath: string;
  projectPath: string;
  projectLabel: string;
  threadId?: string | undefined;
  lineNumber?: number | undefined;
  columnNumber?: number | undefined;
}

export interface DesktopProjectFilesChangedEvent {
  rootPath: string;
  eventType: "change" | "rename" | "unknown";
  observedAt: string;
  changedPath?: string | undefined;
}

export type DesktopMcpTransport = "stdio" | "http" | "sse";
export type DesktopMcpDiscoverySourceKind = "desktop-managed" | "config-file" | "docker-toolkit";

export interface DesktopMcpToolSummary {
  name: string;
  description?: string | undefined;
  approvalMode?: "auto" | "ask" | undefined;
  allowedInteractionModes?: ("chat" | "plan" | "build")[] | undefined;
}

export type DesktopMcpCredentialKind = "bearer" | "header" | "environment";

export interface DesktopMcpCredentialBinding {
  kind: DesktopMcpCredentialKind;
  name?: string | undefined;
  credentialId: `mcp.${string}`;
  envKey: string;
  configured: boolean;
}

export interface DesktopMcpCredentialMutationInput {
  kind: DesktopMcpCredentialKind;
  name?: string | undefined;
  credentialId?: `mcp.${string}` | undefined;
  envKey?: string | undefined;
  secret?: string | undefined;
}

export interface DesktopMcpServerConfig {
  id: string;
  name: string;
  transport: DesktopMcpTransport;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  workingDirectory?: string | undefined;
  enabled: boolean;
  source: string;
  sourceKind?: DesktopMcpDiscoverySourceKind | undefined;
  sourcePath?: string | undefined;
  toolCount?: number | undefined;
  tools?: DesktopMcpToolSummary[] | undefined;
  credentials?: DesktopMcpCredentialBinding[] | undefined;
  setupWarning?: string | undefined;
  verifiedAt?: string | undefined;
}

export interface DesktopMcpDiscoveryDiagnostic {
  source: string;
  path: string;
  status: "missing" | "read" | "invalid" | "error";
  message?: string | undefined;
}

export interface DesktopMcpDiscoveryResult {
  servers: DesktopMcpServerConfig[];
  diagnostics: DesktopMcpDiscoveryDiagnostic[];
  discoveredAt: string;
}

export interface DesktopMcpServerMutationInput {
  id: string;
  name: string;
  transport: DesktopMcpTransport;
  command?: string | undefined;
  args?: string[] | undefined;
  url?: string | undefined;
  credentials?: DesktopMcpCredentialMutationInput[] | undefined;
  toolPolicies?: Record<string, {
    approvalMode: "auto" | "ask";
    allowedInteractionModes: ("chat" | "plan" | "build")[];
  }> | undefined;
  enabled: boolean;
}

export function parseDesktopMcpServerMutationInput(value: unknown): DesktopMcpServerMutationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop MCP server configuration must be an object.");
  }
  const input = value as Record<string, unknown>;
  const supported = new Set(["id", "name", "transport", "command", "args", "url", "credentials", "toolPolicies", "enabled"]);
  const unsupported = Object.keys(input).find((key) => supported.has(key) === false);
  if (unsupported !== undefined) throw new Error(`Desktop MCP server includes unsupported field '${unsupported}'.`);
  const id = parseRequiredDesktopString(input.id, "id");
  if (/^[a-zA-Z0-9._-]+$/u.test(id) === false) throw new Error("Desktop MCP server id must match [a-zA-Z0-9._-]+.");
  const name = parseRequiredDesktopString(input.name, "name");
  if (input.transport !== "stdio" && input.transport !== "http" && input.transport !== "sse") {
    throw new Error("Desktop MCP server transport is unsupported.");
  }
  if (typeof input.enabled !== "boolean") throw new Error("Desktop MCP server enabled must be a boolean.");
  const credentials = parseDesktopMcpCredentialInputs(input.credentials, id);
  const toolPolicies = parseDesktopMcpToolPolicies(input.toolPolicies);
  if (input.transport === "stdio") {
    const command = parseRequiredDesktopString(input.command, "command");
    if (input.args !== undefined && (Array.isArray(input.args) === false || input.args.some((arg) => typeof arg !== "string"))) {
      throw new Error("Desktop MCP server args must be an array of strings.");
    }
    if (credentials.some((binding) => binding.kind !== "environment")) throw new Error("Desktop MCP stdio servers only support environment credential bindings.");
    return { id, name, transport: "stdio", command, ...(input.args !== undefined ? { args: input.args as string[] } : {}), ...(credentials.length > 0 ? { credentials } : {}), ...(toolPolicies !== undefined ? { toolPolicies } : {}), enabled: input.enabled };
  }
  const url = parseRequiredDesktopString(input.url, "url");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("Desktop MCP server URL must use HTTP or HTTPS.");
  if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
    throw new Error("Desktop MCP credentials cannot be embedded in the server URL.");
  }
  if (credentials.some((binding) => binding.kind === "environment")) throw new Error("Remote MCP servers support bearer and header credentials, not process environment bindings.");
  if (credentials.filter((binding) => binding.kind === "bearer").length > 1) throw new Error("Desktop MCP server can have at most one bearer credential.");
  return { id, name, transport: input.transport, url: parsedUrl.toString(), ...(credentials.length > 0 ? { credentials } : {}), ...(toolPolicies !== undefined ? { toolPolicies } : {}), enabled: input.enabled };
}

function parseDesktopMcpCredentialInputs(value: unknown, serverId: string): DesktopMcpCredentialMutationInput[] {
  if (value === undefined) return [];
  if (Array.isArray(value) === false) throw new Error("Desktop MCP credentials must be an array.");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Desktop MCP credential binding must be an object.");
    const binding = raw as Record<string, unknown>;
    const unsupported = Object.keys(binding).find((key) => new Set(["kind", "name", "credentialId", "envKey", "secret"]).has(key) === false);
    if (unsupported !== undefined) throw new Error(`Desktop MCP credential includes unsupported field '${unsupported}'.`);
    if (binding.kind !== "bearer" && binding.kind !== "header" && binding.kind !== "environment") throw new Error("Desktop MCP credential kind is invalid.");
    const name = binding.kind === "bearer" ? undefined : parseRequiredDesktopString(binding.name, "credential name");
    if (binding.kind === "header" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name!) === false) throw new Error("Desktop MCP header credential name is invalid.");
    if (binding.kind === "environment" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name!) === false) throw new Error("Desktop MCP environment credential name is invalid.");
    const identity = `${binding.kind}:${name ?? ""}`.toLowerCase();
    if (seen.has(identity)) throw new Error("Desktop MCP credential bindings must be unique.");
    seen.add(identity);
    const credentialId = binding.credentialId === undefined ? undefined : String(binding.credentialId);
    if (credentialId !== undefined && (credentialId.startsWith(`mcp.${serverId}.`) === false || /^mcp\.[a-zA-Z0-9._-]+$/u.test(credentialId) === false)) throw new Error("Desktop MCP credential id is invalid for this server.");
    const envKey = binding.envKey === undefined ? undefined : String(binding.envKey);
    if (envKey !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(envKey) === false) throw new Error("Desktop MCP credential environment key is invalid.");
    const secret = binding.secret === undefined ? undefined : String(binding.secret);
    if (secret !== undefined && (secret.length === 0 || secret.trim() !== secret || /[\u0000-\u001f\u007f]/u.test(secret))) throw new Error("Desktop MCP credential value is invalid.");
    return { kind: binding.kind, ...(name !== undefined ? { name } : {}), ...(credentialId !== undefined ? { credentialId: credentialId as `mcp.${string}` } : {}), ...(envKey !== undefined ? { envKey } : {}), ...(secret !== undefined ? { secret } : {}) };
  });
}

function parseDesktopMcpToolPolicies(value: unknown): DesktopMcpServerMutationInput["toolPolicies"] {
  if (value === undefined) return ;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Desktop MCP tool policies must be an object.");
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([toolName, raw]) => {
    if (toolName.trim().length === 0 || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Desktop MCP tool policy is invalid.");
    const policy = raw as Record<string, unknown>;
    if (policy.approvalMode !== "auto" && policy.approvalMode !== "ask") throw new Error(`Desktop MCP tool '${toolName}' approval mode is invalid.`);
    if (Array.isArray(policy.allowedInteractionModes) === false || policy.allowedInteractionModes.length === 0 || policy.allowedInteractionModes.some((mode) => mode !== "chat" && mode !== "plan" && mode !== "build")) throw new Error(`Desktop MCP tool '${toolName}' interaction modes are invalid.`);
    return [toolName, { approvalMode: policy.approvalMode, allowedInteractionModes: [...new Set(policy.allowedInteractionModes)] as ("chat" | "plan" | "build")[] }] as const;
  }));
}

export type DesktopMicrophoneAccessState =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unknown";

export interface DesktopMicrophoneAccess {
  state: DesktopMicrophoneAccessState;
  granted: boolean;
}
