import { RunnerProtocolContractError } from "./errors.js";
import {
  parseHostedToolApprovalDecision,
  parseRememberedToolApprovalEvidenceSetV1,
  parseRememberedApprovalScope,
  parseStableToolApprovalIdentityV1,
  type HostedToolApprovalDecision,
  type RememberedToolApprovalEvidenceV1,
  type RememberedApprovalScope,
  type RunnerApprovalActorAuthorityV1,
  type StableToolApprovalIdentityV1,
} from "./approvals.js";
import {
  parseRunnerProjectAction,
  type RunnerProjectAction,
} from "./projectActions.js";

export type {
  RunnerProjectAction,
  RunnerProjectActionType,
} from "./projectActions.js";

export const EXECUTION_PROTOCOL_VERSION = "execution-protocol-v4" as const;
export const RUNNER_COMMAND_CONTRACT_VERSION = "runner-command-v3" as const;
export const RUNNER_EVENT_CONTRACT_VERSION = "dotted-runtime-events-v3" as const;
export const WORKSPACE_HOSTED_APPROVAL_PRESET_VERSION = 4 as const;
export const HOSTED_APPROVAL_PRODUCER_PROTOCOL = "v4" as const;
export const RUNNER_WAITING_PROMPT_HISTORY_KIND = "runtime.waiting_prompt" as const;
export const RUNNER_ASSISTANT_TEXT_HISTORY_KIND = "runtime.assistant_text" as const;

export interface ConversationMessageCursor {
  completedAt: string;
  turnId: string;
}

export function encodeConversationMessageCursor(cursor: ConversationMessageCursor): string {
  requireIsoTimestamp(cursor.completedAt, "conversation message cursor.completedAt");
  requireNonEmptyString(cursor.turnId, "conversation message cursor.turnId");
  return `v1:${encodeURIComponent(cursor.completedAt)}:${encodeURIComponent(cursor.turnId)}`;
}

export function parseConversationMessageCursor(
  value: unknown,
  label = "conversation message cursor",
): ConversationMessageCursor {
  const encoded = requireNonEmptyString(value, label);
  const parts = encoded.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new RunnerProtocolContractError(`${label} is invalid`);
  }
  try {
    const completedAt = decodeURIComponent(parts[1] ?? "");
    const turnId = decodeURIComponent(parts[2] ?? "");
    requireIsoTimestamp(completedAt, `${label}.completedAt`);
    requireNonEmptyString(turnId, `${label}.turnId`);
    return { completedAt, turnId };
  } catch (error) {
    if (error instanceof RunnerProtocolContractError) throw error;
    throw new RunnerProtocolContractError(`${label} is invalid`);
  }
}

export const RUNNER_COMMAND_TYPES = [
  "profile.list",
  "profile.get",
  "execution-profile.resolve",
  "job.run",
  "run.start",
  "run.cancel",
  "effect.result.get",
  "session.describe",
  "session.state",
  "operator.inbox",
  "operator.thread",
  "conversation.message.submit",
  "conversation.messages.list",
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
  "mission_control.project.get",
  "mission_control.action.execute",
  "project.snapshot.get",
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
  "conversation.message.submit",
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
  "execution-profile.resolved",
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
  "effect.result.loaded",
  "runner.error",
  "runner.pong",
  "session.described",
  "session.state",
  "operator.inbox",
  "operator.thread",
  "conversation.message.routed",
  "conversation.messages",
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
  "mission_control.project",
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

export interface ExecutionProtocolDescriptorV4 {
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

export const EXECUTION_PROTOCOL_V4: ExecutionProtocolDescriptorV4 = {
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
  kestrelOneAppApprovalPolicies?: Record<string, {
    environment: "auto" | "ask" | "deny";
    project?: "auto" | "ask" | "deny" | undefined;
    subject?: "auto" | "ask" | "deny" | undefined;
    minimum: "auto" | "ask";
  }> | undefined;
  rememberedToolApprovalEvidence?: RememberedToolApprovalEvidenceV1[] | undefined;
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

export interface RunnerTurnFile {
  /** Canonical durable identity. */
  fileId?: string | undefined;
  /** @deprecated Protocol v4 compatibility alias for fileId. */
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
  /** Transient transport input; runners must materialize and remove it before persistence. */
  sourceUrl?: string | undefined;
  sourceUrlExpiresAt?: string | undefined;
  metadataOnlyReason?: string | undefined;
}

/** @deprecated Use RunnerTurnFile. */
export type RunnerTurnAttachment = RunnerTurnFile;

export interface RunnerProjectContext {
  projectId: string;
  contextRevisionId: string;
  contextRevision: number;
  content: string;
}

export interface RunnerMissionControlExecution {
  projectId: string;
  itemId: string;
  attemptId: string;
  commandId: string;
  runId: string;
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
  renewal?: RunnerExecutionAuthorizationRenewalV1 | undefined;
}

export interface RunnerExecutionAuthorizationRenewalV1 {
  version: "execution-authorization-renewal-v1";
  endpoint: string;
  token: string;
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

export interface RunnerHostedApprovalAuthorityV1 {
  version: "runner_hosted_approval_authority_v1";
  organizationId: string;
  environmentId: string;
  projectId: string;
  threadId: string;
}

export const RUNNER_PREPARED_APPROVAL_CLEANUP_VERSION =
  "runner_prepared_approval_cleanup_v1" as const;

export interface RunnerPreparedApprovalCleanupV1 {
  version: typeof RUNNER_PREPARED_APPROVAL_CLEANUP_VERSION;
  organizationId: string;
  threadId: string;
  turnId: string;
  interactionId: string;
  requestId: string;
  failureCode:
    | "EXTERNAL_APPROVAL_EXPIRED"
    | "EXTERNAL_APPROVAL_IDENTITY_MISMATCH"
    | "EXTERNAL_APPROVAL_POLICY_CHANGED";
  failureMessage: string;
}

export function parseRunnerPreparedApprovalCleanupV1(
  value: unknown,
  label = "preparedApprovalCleanup",
): RunnerPreparedApprovalCleanupV1 {
  const cleanup = requireRecord(value, label);
  rejectUnknownFields(cleanup, label, [
    "version",
    "organizationId",
    "threadId",
    "turnId",
    "interactionId",
    "requestId",
    "failureCode",
    "failureMessage",
  ]);
  if (cleanup.version !== RUNNER_PREPARED_APPROVAL_CLEANUP_VERSION) {
    throw new RunnerProtocolContractError(`${label}.version is invalid`);
  }
  if (
    cleanup.failureCode !== "EXTERNAL_APPROVAL_EXPIRED" &&
    cleanup.failureCode !== "EXTERNAL_APPROVAL_IDENTITY_MISMATCH" &&
    cleanup.failureCode !== "EXTERNAL_APPROVAL_POLICY_CHANGED"
  ) {
    throw new RunnerProtocolContractError(`${label}.failureCode is invalid`);
  }
  return {
    version: RUNNER_PREPARED_APPROVAL_CLEANUP_VERSION,
    organizationId: requireNonEmptyString(cleanup.organizationId, `${label}.organizationId`),
    threadId: requireNonEmptyString(cleanup.threadId, `${label}.threadId`),
    turnId: requireNonEmptyString(cleanup.turnId, `${label}.turnId`),
    interactionId: requireNonEmptyString(cleanup.interactionId, `${label}.interactionId`),
    requestId: requireNonEmptyString(cleanup.requestId, `${label}.requestId`),
    failureCode: cleanup.failureCode,
    failureMessage: requireNonEmptyString(cleanup.failureMessage, `${label}.failureMessage`),
  };
}

export interface RunnerTurnInput {
  sessionId: string;
  runId?: string | undefined;
  message: string;
  eventType: string;
  /** Execute without conversational waits; blockers must terminate the turn. */
  noninteractive?: boolean | undefined;
  attachments?: RunnerTurnAttachment[] | undefined;
  resumeBlockedRun?: boolean | undefined;
  resumeRequestId?: string | undefined;
  recoveryOptionId?: string | undefined;
  decision?: HostedToolApprovalDecision | undefined;
  decidingActor?: RunnerActorMetadata | undefined;
  preparedApprovalCleanup?: RunnerPreparedApprovalCleanupV1 | undefined;
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
  missionControl?: RunnerMissionControlExecution | undefined;
  manualCompaction?: boolean | undefined;
  autoCompaction?: RunnerAutoCompaction | undefined;
  workspace?: Record<string, unknown> | undefined;
  workspaceSkills?: RunnerWorkspaceSkillCatalogEntry[] | undefined;
  hostedApprovalAuthority?: RunnerHostedApprovalAuthorityV1 | undefined;
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
  cachedInputTokens?: number | undefined;
  cacheWriteInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  totalTokens?: number | undefined;
  pricedCostUsd?: number | undefined;
  validationRejections?: number | undefined;
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
  kind: "user_input";
  eventType: string;
  prompt: string;
  inputSchema?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export const RUNNER_LOCAL_TOOL_APPROVAL_INTERACTION_V1 =
  "runner_local_tool_approval_interaction_v1" as const;

export interface RunnerLocalToolApprovalInteractionV1
  extends Record<string, unknown> {
  version: typeof RUNNER_LOCAL_TOOL_APPROVAL_INTERACTION_V1;
  requestId: string;
  kind: "approval";
  eventType: "user.approval";
  prompt: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    required: ["decision"];
    properties: {
      decision: { type: "string"; enum: Array<"decline" | "approve_once"> };
    };
  };
  metadata?: Record<string, unknown> | undefined;
  approval: {
    approvalId: string;
    toolName: string;
    presentation?: unknown;
    requestedAt: string;
    expiresAt: string;
  };
}

export const RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V4 =
  "runner_hosted_tool_approval_interaction_v4" as const;

export interface RunnerHostedToolApprovalInteractionV4
  extends Record<string, unknown> {
  version: typeof RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V4;
  requestId: string;
  kind: "approval";
  eventType: "user.approval";
  prompt: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    required: ["decision"];
    properties: {
      decision: { type: "string"; enum: HostedToolApprovalDecision[] };
    };
  };
  metadata?: Record<string, unknown> | undefined;
  approval: {
    preparedInvocationId: string;
    toolName: string;
    stableToolIdentity: StableToolApprovalIdentityV1;
    requestingActor: RunnerApprovalActorAuthorityV1;
    presentation?: unknown;
    rememberedApprovalScope: RememberedApprovalScope;
    requestedAt: string;
    expiresAt: string;
  };
}

export type RunnerInteractionRequest =
  | RunnerInteractionRequestV1
  | RunnerLocalToolApprovalInteractionV1
  | RunnerHostedToolApprovalInteractionV4;

export type RunnerStructuredReviewReason =
  | "recovery_review"
  | "evaluation_review";

export type RunnerStructuredReviewOptionId =
  | "retry.primary"
  | "evaluation.accept_once"
  | "evaluation.revise"
  | "terminal.fail";

export type RunnerStructuredReviewClassificationV1 =
  | { kind: "ordinary" }
  | {
      kind: "structured_review";
      reason: RunnerStructuredReviewReason;
      requestId: string;
      eventType: "user.reply";
      prompt: string;
      allowedOptionIds: RunnerStructuredReviewOptionId[];
      triggeringFailureCode?: string | undefined;
      triggeringFailureSummary?: string | undefined;
      evaluationTechnicalDisclosure?: Record<string, unknown> | undefined;
    }
  | {
      kind: "invalid_review";
      reason?: RunnerStructuredReviewReason | undefined;
      error: string;
    };

export interface CreateRunnerStructuredReviewInteractionV1Input {
  reason: RunnerStructuredReviewReason;
  requestId: string;
  prompt: string;
  allowedOptionIds: readonly string[];
  triggeringFailureCode?: string | undefined;
  triggeringFailureSummary?: string | undefined;
  evaluationTechnicalDisclosure?: Record<string, unknown> | undefined;
}

export function parseRunnerInteractionRequestV1(
  value: unknown,
  expectedEventType?: string | undefined,
): RunnerInteractionRequestV1 {
  const interaction = requireRecord(value, "runner interaction");
  if (interaction.version !== "v1") {
    throw new RunnerProtocolContractError(
      "runner interaction.version must be 'v1'",
    );
  }
  if (interaction.kind === "approval") {
    throw new RunnerProtocolContractError(
      "runner interaction V1 cannot represent tool approval",
    );
  }
  const eventType = expectedEventType ?? requireNonEmptyString(
    interaction.eventType,
    "runner interaction.eventType",
  );
  validateRunnerInteractionRequest(interaction, "runner interaction", eventType);
  return structuredClone(interaction) as RunnerInteractionRequestV1;
}

export function parseRunnerHostedToolApprovalInteractionV4(
  value: unknown,
  expectedEventType = "user.approval",
): RunnerHostedToolApprovalInteractionV4 {
  const interaction = requireRecord(value, "hosted tool approval interaction");
  validateRunnerHostedToolApprovalInteractionV4(
    interaction,
    "hosted tool approval interaction",
    expectedEventType,
  );
  const parsed = structuredClone(interaction) as RunnerHostedToolApprovalInteractionV4;
  parsed.approval.rememberedApprovalScope = parseRememberedApprovalScope(
    interaction.approval &&
      typeof interaction.approval === "object" &&
      !Array.isArray(interaction.approval)
      ? (interaction.approval as Record<string, unknown>).rememberedApprovalScope
      : undefined,
  );
  return parsed;
}

export function parseRunnerLocalToolApprovalInteractionV1(
  value: unknown,
  expectedEventType = "user.approval",
): RunnerLocalToolApprovalInteractionV1 {
  const interaction = requireRecord(value, "local tool approval interaction");
  validateRunnerLocalToolApprovalInteractionV1(
    interaction,
    "local tool approval interaction",
    expectedEventType,
  );
  return structuredClone(interaction) as RunnerLocalToolApprovalInteractionV1;
}

export function parseRunnerInteractionRequest(
  value: unknown,
  expectedEventType?: string | undefined,
): RunnerInteractionRequest {
  const interaction = requireRecord(value, "runner interaction");
  if (interaction.version === RUNNER_LOCAL_TOOL_APPROVAL_INTERACTION_V1) {
    return parseRunnerLocalToolApprovalInteractionV1(
      interaction,
      expectedEventType,
    );
  }
  if (interaction.version === RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V4) {
    return parseRunnerHostedToolApprovalInteractionV4(
      interaction,
      expectedEventType,
    );
  }
  if (
    interaction.version === "runner_hosted_tool_approval_interaction_v2" ||
    interaction.version === "runner_hosted_tool_approval_interaction_v3"
  ) {
    throw new RunnerProtocolContractError(
      "legacy hosted tool approval interactions are not supported",
    );
  }
  return parseRunnerInteractionRequestV1(interaction, expectedEventType);
}

const RECOVERY_REVIEW_OPTION_IDS = new Set<RunnerStructuredReviewOptionId>([
  "retry.primary",
  "terminal.fail",
]);
const EVALUATION_REVIEW_OPTION_IDS = new Set<RunnerStructuredReviewOptionId>([
  "evaluation.accept_once",
  "evaluation.revise",
  "terminal.fail",
]);

export function runnerStructuredReviewOptionLabel(
  reason: RunnerStructuredReviewReason,
  optionId: RunnerStructuredReviewOptionId,
): string {
  if (reason === "recovery_review") {
    if (optionId === "retry.primary") return "Try again";
    if (optionId === "terminal.fail") return "End this run";
  } else {
    if (optionId === "evaluation.accept_once") return "Accept once";
    if (optionId === "evaluation.revise") return "Revise result";
    if (optionId === "terminal.fail") return "Fail run";
  }
  throw new RunnerProtocolContractError(
    `Structured review option '${optionId}' is invalid for '${reason}'.`,
  );
}

export function createRunnerStructuredReviewInteractionV1(
  input: CreateRunnerStructuredReviewInteractionV1Input,
): RunnerInteractionRequestV1 {
  if (input.reason === "recovery_review") {
    throw new RunnerProtocolContractError(
      "Generic recovery reviews are retired and cannot be created.",
    );
  }
  const requestId = requireNonEmptyString(input.requestId, "structured review.requestId");
  const prompt = requireNonEmptyString(input.prompt, "structured review.prompt");
  const allowedOptionIds = validateStructuredReviewOptionIds(
    input.reason,
    input.allowedOptionIds,
    "structured review.allowedOptionIds",
  );
  const interaction: RunnerInteractionRequestV1 = {
    version: "v1",
    requestId,
    kind: "user_input",
    eventType: "user.reply",
    prompt,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["recoveryOptionId"],
      properties: {
        recoveryOptionId: {
          type: "string",
          enum: [...allowedOptionIds],
        },
      },
    },
    metadata: {
      reason: input.reason,
      allowedOptionIds: [...allowedOptionIds],
      evaluationTechnicalDisclosure: validateEvaluationTechnicalDisclosure(
        input.evaluationTechnicalDisclosure,
        "structured review.evaluationTechnicalDisclosure",
      ),
    },
  };
  const classification = parseRunnerStructuredReviewInteractionV1(interaction);
  if (classification.kind !== "structured_review") {
    throw new RunnerProtocolContractError(
      classification.kind === "invalid_review"
        ? classification.error
        : "Structured review interaction was not recognized.",
    );
  }
  return interaction;
}

export function parseRunnerStructuredReviewInteractionV1(
  value: unknown,
): RunnerStructuredReviewClassificationV1 {
  if (!isRecord(value)) return { kind: "ordinary" };
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  const reason = metadata?.reason;
  if (reason !== "recovery_review" && reason !== "evaluation_review") {
    return metadata !== undefined && Object.hasOwn(metadata, "allowedOptionIds")
      ? {
          kind: "invalid_review",
          error: "Structured reviews require a supported metadata.reason.",
        }
      : { kind: "ordinary" };
  }
  const reviewMetadata = metadata as Record<string, unknown>;
  const invalid = (error: string): RunnerStructuredReviewClassificationV1 => ({
    kind: "invalid_review",
    reason,
    error,
  });
  if (reason === "recovery_review") {
    return invalid(
      "This recovery request can no longer be resumed safely. End the waiting turn and retry explicitly.",
    );
  }
  if (value.version !== "v1" || value.kind !== "user_input") {
    return invalid("Structured reviews must be v1 user_input interactions.");
  }
  if (value.eventType !== "user.reply") {
    return invalid("Structured reviews must use the user.reply event type.");
  }
  if (typeof value.requestId !== "string" || value.requestId.trim().length === 0) {
    return invalid("Structured reviews require a non-empty requestId.");
  }
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) {
    return invalid("Structured reviews require a non-empty prompt.");
  }
  const metadataKeys = Object.keys(reviewMetadata).sort();
  const allowedMetadataKeys = ["allowedOptionIds", "evaluationTechnicalDisclosure", "reason"];
  if (metadataKeys.some((key) => allowedMetadataKeys.includes(key) === false)) {
    return invalid("Structured review metadata contains unsupported fields.");
  }
  let allowedOptionIds: RunnerStructuredReviewOptionId[];
  try {
    allowedOptionIds = validateStructuredReviewOptionIds(
      reason,
      reviewMetadata.allowedOptionIds,
      "structured review metadata.allowedOptionIds",
    );
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Structured review options are invalid.");
  }
  const inputSchema = isRecord(value.inputSchema) ? value.inputSchema : undefined;
  const properties = isRecord(inputSchema?.properties) ? inputSchema.properties : undefined;
  const optionSchema = isRecord(properties?.recoveryOptionId)
    ? properties.recoveryOptionId
    : undefined;
  const required = inputSchema?.required;
  const schemaOptions = optionSchema?.enum;
  if (
    inputSchema?.type !== "object" ||
    inputSchema.additionalProperties !== false ||
    !Array.isArray(required) ||
    required.length !== 1 ||
    required[0] !== "recoveryOptionId" ||
    properties === undefined ||
    Object.keys(properties).length !== 1 ||
    optionSchema?.type !== "string" ||
    !Array.isArray(schemaOptions) ||
    schemaOptions.some((optionId) => typeof optionId !== "string")
  ) {
    return invalid("Structured reviews require the canonical recoveryOptionId input schema.");
  }
  if (
    schemaOptions.length !== allowedOptionIds.length ||
    schemaOptions.some((optionId, index) => optionId !== allowedOptionIds[index])
  ) {
    return invalid("Structured review schema options must exactly match metadata.allowedOptionIds.");
  }
  let evaluationTechnicalDisclosure: Record<string, unknown> | undefined;
  try {
    evaluationTechnicalDisclosure = validateEvaluationTechnicalDisclosure(
      reviewMetadata.evaluationTechnicalDisclosure,
      "structured review metadata.evaluationTechnicalDisclosure",
    );
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Evaluation review disclosure is invalid.");
  }
  return {
    kind: "structured_review",
    reason,
    requestId: value.requestId.trim(),
    eventType: "user.reply",
    prompt: value.prompt.trim(),
    allowedOptionIds,
    ...(typeof reviewMetadata.triggeringFailureCode === "string"
      ? { triggeringFailureCode: reviewMetadata.triggeringFailureCode.trim() }
      : {}),
    ...(typeof reviewMetadata.triggeringFailureSummary === "string"
      ? { triggeringFailureSummary: reviewMetadata.triggeringFailureSummary.trim() }
      : {}),
    ...(evaluationTechnicalDisclosure !== undefined
      ? { evaluationTechnicalDisclosure }
      : {}),
  };
}

function validateStructuredReviewOptionIds(
  reason: RunnerStructuredReviewReason,
  value: unknown,
  label: string,
): RunnerStructuredReviewOptionId[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RunnerProtocolContractError(`${label} must be a non-empty array.`);
  }
  const supported = reason === "recovery_review"
    ? RECOVERY_REVIEW_OPTION_IDS
    : EVALUATION_REVIEW_OPTION_IDS;
  const result: RunnerStructuredReviewOptionId[] = [];
  for (const optionId of value) {
    if (typeof optionId !== "string" || optionId.trim().length === 0) {
      throw new RunnerProtocolContractError(`${label} must contain non-empty strings.`);
    }
    if (!supported.has(optionId as RunnerStructuredReviewOptionId)) {
      throw new RunnerProtocolContractError(
        `${label} contains unsupported option '${optionId}'.`,
      );
    }
    if (result.includes(optionId as RunnerStructuredReviewOptionId)) {
      throw new RunnerProtocolContractError(`${label} must not contain duplicates.`);
    }
    result.push(optionId as RunnerStructuredReviewOptionId);
  }
  return result;
}

function validateEvaluationTechnicalDisclosure(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const disclosure = requireRecord(value, label);
  const allowedKeys = new Set([
    "candidate",
    "score",
    "confidence",
    "assertions",
    "rationale",
    "evidenceReferences",
    "reasonCode",
  ]);
  if (Object.keys(disclosure).some((key) => allowedKeys.has(key) === false)) {
    throw new RunnerProtocolContractError(`${label} contains unsupported fields.`);
  }
  requireNonEmptyString(disclosure.candidate, `${label}.candidate`);
  if (disclosure.score !== undefined && typeof disclosure.score !== "number") {
    throw new RunnerProtocolContractError(`${label}.score must be a number.`);
  }
  if (disclosure.confidence !== undefined && typeof disclosure.confidence !== "number") {
    throw new RunnerProtocolContractError(`${label}.confidence must be a number.`);
  }
  if (disclosure.rationale !== undefined) {
    requireNonEmptyString(disclosure.rationale, `${label}.rationale`);
  }
  if (disclosure.reasonCode !== undefined) {
    requireNonEmptyString(disclosure.reasonCode, `${label}.reasonCode`);
  }
  if (!Array.isArray(disclosure.assertions)) {
    throw new RunnerProtocolContractError(`${label}.assertions must be an array.`);
  }
  for (const [index, assertionValue] of disclosure.assertions.entries()) {
    const assertion = requireRecord(
      assertionValue,
      `${label}.assertions[${index}]`,
    );
    const allowedAssertionKeys = new Set([
      "assertionId",
      "required",
      "passed",
      "rationale",
      "evidenceRefs",
    ]);
    if (Object.keys(assertion).some((key) => !allowedAssertionKeys.has(key))) {
      throw new RunnerProtocolContractError(
        `${label}.assertions[${index}] contains unsupported fields.`,
      );
    }
    requireNonEmptyString(
      assertion.assertionId,
      `${label}.assertions[${index}].assertionId`,
    );
    if (typeof assertion.passed !== "boolean") {
      throw new RunnerProtocolContractError(
        `${label}.assertions[${index}].passed must be a boolean.`,
      );
    }
    if (assertion.required !== undefined && typeof assertion.required !== "boolean") {
      throw new RunnerProtocolContractError(
        `${label}.assertions[${index}].required must be a boolean.`,
      );
    }
    if (assertion.rationale !== undefined) {
      requireNonEmptyString(
        assertion.rationale,
        `${label}.assertions[${index}].rationale`,
      );
    }
    if (
      assertion.evidenceRefs !== undefined &&
      (!Array.isArray(assertion.evidenceRefs) ||
        assertion.evidenceRefs.some((reference) => typeof reference !== "string"))
    ) {
      throw new RunnerProtocolContractError(
        `${label}.assertions[${index}].evidenceRefs must be a string array.`,
      );
    }
  }
  if (
    !Array.isArray(disclosure.evidenceReferences) ||
    disclosure.evidenceReferences.some(
      (reference) => typeof reference !== "string" || reference.trim().length === 0,
    )
  ) {
    throw new RunnerProtocolContractError(`${label}.evidenceReferences must be a string array.`);
  }
  return structuredClone(disclosure);
}

export interface RunnerWaitFor extends Record<string, unknown> {
  kind?: "user" | "approval" | "effect" | "tool" | "region_merge" | undefined;
  eventType: string;
  timeoutMs?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  interaction?: RunnerInteractionRequest | undefined;
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
export type RunnerApprovalPolicyPackId =
  | "dev"
  | "isolated_code"
  | "ci_bot"
  | "hosted_workspace"
  | "production";

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

export interface RunnerJobInputV2 extends Omit<RunnerJobInputV1, "version"> {
  version: "job_input_v2";
  environmentPresetId:
    | "cli_safe_local"
    | "cli_dev_local"
    | "desktop_safe_local"
    | "desktop_dev_local"
    | "workspace_hosted";
}

export type RunnerJobInput = RunnerJobInputV1 | RunnerJobInputV2;

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

export interface RunnerJobManagedResultHandleV1 {
  version: "job_managed_result_handle_v1";
  kind: "managed_worktree";
  worktreePath: string;
  sourceWorkspaceRoot: string;
  baseRevision: string;
  candidateRevision: string;
  changedFiles: string[];
  promotionId?: string | undefined;
}

export interface RunnerJobRunResultV1 {
  version: "job_run_result_v1";
  sessionId: string;
  threadId: string;
  runId: string;
  status: string;
  waitFor?: Record<string, unknown> | undefined;
  resultHandle?: RunnerJobManagedResultHandleV1 | undefined;
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

export interface ExecutionProfileResolveCommandPayload {
  environmentPresetId:
    | "cli_safe_local"
    | "cli_dev_local"
    | "desktop_safe_local"
    | "desktop_dev_local"
    | "workspace_hosted";
  managedConfiguration?: Record<string, unknown> | undefined;
  authoringProfileId?: string | undefined;
  /** Exact tools to evaluate in Build mode before any provider or model spend. */
  exactToolNames?: string[] | undefined;
}

export interface EffectiveToolDecisionV1 {
  version: "effective_tool_decision_v1";
  available: boolean;
  availabilityReason:
    | "available"
    | "approval_policy"
    | "interaction_mode"
    | "tool_class_policy"
    | "capability_policy"
    | "approval_policy"
    | "actor_access";
  approvalDisposition: {
    mode: "auto" | "ask" | "deny";
    reasonCode:
      | "tool_minimum"
      | "environment_policy"
      | "project_restriction"
      | "subject_restriction"
      | "runtime_strict"
      | "remembered_thread";
    authority: {
      kind: "runtime_policy" | "hosted_mcp_grant" | "hosted_app_policy";
      revision: string;
    };
  };
  rememberApprovalEligible: boolean;
  authorityRevision: string;
  evidence: {
    interactionMode: "chat" | "plan" | "build";
    toolClass: "read_only" | "planning_write" | "sandboxed_only" | "external_side_effect";
    requiredCapabilities: string[];
    blockedCapability?:
      | "workspace.read"
      | "workspace.write"
      | "shell.exec"
      | "mission_control.work_item.write"
      | "network.call"
      | "code.execute"
      | "mcp.invoke"
      | "delegation.control"
      | "external.confirm"
      | undefined;
    actorAccess: boolean;
  };
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

type RunnerJobInputWithoutProfileReference = RunnerJobInput & {
  profile?: never;
  profileId?: never;
};

type RunnerJobInputWithProfileReference = RunnerJobInput & RunnerProfileReference;

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

export type OrdinaryConversationTurn = Omit<
  RunnerTurnInput,
  | "runId"
  | "eventId"
  | "eventType"
  | "resumeBlockedRun"
  | "resumeRequestId"
  | "recoveryOptionId"
  | "decision"
  | "decidingActor"
  | "preparedApprovalCleanup"
  | "stepAgent"
>;

export type ConversationMessageSubmitCommandPayload = RunnerProfileReference & {
  threadId: string;
  messageId: string;
  turn: OrdinaryConversationTurn;
};

export interface RunCancelCommandPayload {
  sessionId: string;
  runId?: string | undefined;
  commandId?: string | undefined;
}

export interface EffectResultGetCommandPayload {
  sessionId: string;
  runId: string;
  idempotencyKey: string;
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

export interface ConversationMessagesListCommandPayload {
  threadId: string;
  afterCursor?: string | undefined;
  limit?: number | undefined;
  includeFinalizedPayload?: boolean | undefined;
  includeTerminalOutcomes?: boolean | undefined;
}

export interface RunnerConversationMessage {
  messageId: string;
  turnId: string;
  threadId: string;
  sessionId: string;
  runId: string;
  completedAt: string;
  result: {
    assistantText: string;
    output: unknown;
    finalizedPayload?: unknown | undefined;
  };
}

export interface RunnerConversationTerminalOutcome {
  messageId: string;
  turnId: string;
  threadId: string;
  sessionId: string;
  runId: string;
  completedAt: string;
  terminalStatus: "COMPLETED" | "FAILED";
  outcomeStatus: "completed" | "failed" | "cancelled" | "contract_failure";
  handoffState: "delivered" | "failed";
  result?: {
    assistantText: string | null;
    output: unknown;
    finalizedPayload?: unknown | undefined;
  } | undefined;
  finalizationError?: { code: string; message: string; details?: unknown | undefined } | undefined;
}

export interface ConversationMessagesEventPayload {
  threadId: string;
  messages: RunnerConversationMessage[];
  terminalOutcomes?: RunnerConversationTerminalOutcome[] | undefined;
  nextCursor?: string | undefined;
  hasMore: boolean;
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
  followUpId?: string | undefined;
  requestId?: string | undefined;
  recoveryOptionId?: string | undefined;
  proposalId?: string | undefined;
  checkpointId?: string | undefined;
  delegationId?: string | undefined;
  actionValue?: RunnerOperatorControlActionValue | undefined;
  message?: string | undefined;
  attachments?: RunnerTurnAttachment[] | undefined;
  attachmentIds?: string[] | undefined;
  interactionMode?: RunnerInteractionMode | undefined;
  actSubmode?: RunnerActSubmode | undefined;
  title?: string | undefined;
  rolePrompt?: string | undefined;
  goal?: string | undefined;
  profileId?: string | undefined;
  provider?: RunnerModelProvider | undefined;
  model?: string | undefined;
  maxTurns?: number | undefined;
  maxRuntimeMs?: number | undefined;
  allowApprovalInheritance?: boolean | undefined;
  missionControl?: RunnerMissionControlExecution | undefined;
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

export interface MissionControlProjectGetCommandPayload {
  projectId: string;
}

export interface MissionControlActionExecuteCommandPayload {
  action: Record<string, unknown>;
}

export interface ProjectSnapshotGetCommandPayload {
  sessionId: string;
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
  "execution-profile.resolve": ExecutionProfileResolveCommandPayload;
  "job.run": JobRunCommandPayload;
  "run.start": RunStartCommandPayload;
  "run.cancel": RunCancelCommandPayload;
  "effect.result.get": EffectResultGetCommandPayload;
  "session.describe": SessionDescribeCommandPayload;
  "session.state": SessionStateCommandPayload;
  "operator.inbox": OperatorInboxCommandPayload;
  "operator.thread": OperatorThreadCommandPayload;
  "conversation.message.submit": ConversationMessageSubmitCommandPayload;
  "conversation.messages.list": ConversationMessagesListCommandPayload;
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
  "mission_control.project.get": MissionControlProjectGetCommandPayload;
  "mission_control.action.execute": MissionControlActionExecuteCommandPayload;
  "project.snapshot.get": ProjectSnapshotGetCommandPayload;
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

export interface ExecutionProfileResolvedEventPayload {
  version: 1;
  profileId: string;
  fingerprint: string;
  policy: {
    id: string;
    version: number;
  };
  environmentPreset: {
    id:
      | "cli_safe_local"
      | "cli_dev_local"
      | "desktop_safe_local"
      | "desktop_dev_local"
      | "workspace_hosted";
    version: number;
  };
  hostedApprovalProducerProtocol?: typeof HOSTED_APPROVAL_PRODUCER_PROTOCOL | undefined;
  resolvedProfile: RunnerProfile;
  exactToolDecisions?: Record<string, EffectiveToolDecisionV1> | undefined;
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
  followUpId?: string | undefined;
  sourceMessageId?: string | undefined;
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
  | "MODEL_ATTEMPT_STARTED"
  | "MODEL_ATTEMPT_RETRYING"
  | "MODEL_CALL_DONE"
  | "MODEL_CALL_FAILED"
  | "TOOL_CALL_STARTED"
  | "TOOL_CALL_DONE"
  | "TOOL_CALL_FAILED"
  | "EVALUATION_CHECKING"
  | "EVALUATION_REVISING"
  | "EVALUATION_REVIEW_REQUIRED"
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

export interface RunnerToolUpdateV2
  extends Omit<RunnerToolUpdateV1, "version"> {
  version: "v2";
  activation: Record<string, unknown>;
  outcome?: Record<string, unknown> | undefined;
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
  update: RunnerToolUpdateV1 | RunnerToolUpdateV2;
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

export interface EffectResultLoadedEventPayload {
  version: 1;
  sessionId: string;
  runId: string;
  idempotencyKey: string;
  result: AgentToolResultV2Wire;
}

export interface AgentToolResultV2Wire extends Record<string, unknown> {
  version: "v2";
  toolName: string;
  status: "OK" | "FAILED";
  toolCallId: string;
  activation: Record<string, unknown>;
  outcome: Record<string, unknown>;
  modelContext: { text: string; rawOutputRef: string; truncated: boolean };
  auditRecord: Record<string, unknown>;
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

export interface ConversationMessageRoutedEventPayload {
  threadId: string;
  sessionId: string;
  messageId: string;
  disposition: "started" | "replied" | "queued";
  runId?: string | undefined;
  requestId?: string | undefined;
  followUpId?: string | undefined;
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
    parentRunId?: string | undefined;
    name: string;
    childSessionId: string;
    sender: "kestrel" | "collaborator" | "system";
    text: string;
    createdAt: string;
    dialogStatus: "open" | "closed";
    dialogActivity?: "idle" | "working" | "waiting" | "interrupted" | undefined;
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

export interface MissionControlProjectEventPayload {
  projectId: string;
  project: Record<string, unknown>;
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
  "execution-profile.resolved": ExecutionProfileResolvedEventPayload;
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
  "effect.result.loaded": EffectResultLoadedEventPayload;
  "runner.error": RunnerErrorEventPayload;
  "runner.pong": RunnerPongEventPayload;
  "session.described": SessionDescribedEventPayload;
  "session.state": SessionStateEventPayload;
  "operator.inbox": OperatorInboxEventPayload;
  "operator.thread": OperatorThreadEventPayload;
  "conversation.message.routed": ConversationMessageRoutedEventPayload;
  "conversation.messages": ConversationMessagesEventPayload;
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
  "mission_control.project": MissionControlProjectEventPayload;
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
  "execution-profile.resolve": RunnerEventEnvelope<"execution-profile.resolved">;
  "job.run": RunnerEventEnvelope<"job.completed"> | RunnerEventEnvelope<"job.failed">;
  "run.start": RunnerRunTerminalEvent;
  "run.cancel": RunnerEventEnvelope<"run.cancelled"> | RunnerEventEnvelope<"runner.error">;
  "effect.result.get": RunnerEventEnvelope<"effect.result.loaded"> | RunnerEventEnvelope<"runner.error">;
  "session.describe": RunnerEventEnvelope<"session.described">;
  "session.state": RunnerEventEnvelope<"session.state">;
  "operator.inbox": RunnerEventEnvelope<"operator.inbox">;
  "operator.thread": RunnerEventEnvelope<"operator.thread">;
  "conversation.message.submit": RunnerEventEnvelope<"conversation.message.routed">;
  "conversation.messages.list": RunnerEventEnvelope<"conversation.messages">;
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
  "mission_control.project.get": RunnerEventEnvelope<"mission_control.project">;
  "mission_control.action.execute": RunnerEventEnvelope<"mission_control.project">;
  "project.snapshot.get": RunnerEventEnvelope<"project.snapshot">;
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
  "execution-profile.resolve": ["execution-profile.resolved"],
  "job.run": ["job.completed", "job.failed"],
  "run.start": ["run.completed", "run.failed", "run.cancelled"],
  "run.cancel": ["run.cancelled", "runner.error"],
  "effect.result.get": ["effect.result.loaded", "runner.error"],
  "session.describe": ["session.described"],
  "session.state": ["session.state"],
  "operator.inbox": ["operator.inbox"],
  "operator.thread": ["operator.thread"],
  "conversation.message.submit": ["conversation.message.routed"],
  "conversation.messages.list": ["conversation.messages"],
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
  "mission_control.project.get": ["mission_control.project"],
  "mission_control.action.execute": ["mission_control.project"],
  "project.snapshot.get": ["project.snapshot"],
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
  if (commandType === "conversation.message.submit") {
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
      `runner command.type must be a supported Execution Protocol v4 command, received '${String(command.type)}'`,
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
      `runner event.type must be a supported Execution Protocol v4 event, received '${String(event.type)}'`,
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
    case "execution-profile.resolve":
      validateEnum(payload.environmentPresetId, `${label}.environmentPresetId`, [
        "cli_safe_local",
        "cli_dev_local",
        "desktop_safe_local",
        "desktop_dev_local",
        "workspace_hosted",
      ]);
      if (payload.managedConfiguration !== undefined) {
        requireRecord(payload.managedConfiguration, `${label}.managedConfiguration`);
      }
      validateOptionalNonEmptyString(payload.authoringProfileId, `${label}.authoringProfileId`);
      if (payload.exactToolNames !== undefined) {
        validateUniqueNonEmptyStringArray(payload.exactToolNames, `${label}.exactToolNames`);
      }
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
    case "conversation.message.submit": {
      validateRequiredProfileReference(payload, label);
      rejectUnknownFields(payload, label, ["profile", "profileId", "threadId", "messageId", "turn"]);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      requireNonEmptyString(payload.messageId, `${label}.messageId`);
      const turn = requireRecord(payload.turn, `${label}.turn`);
      for (const forbidden of [
        "runId",
        "eventId",
        "eventType",
        "resumeBlockedRun",
        "resumeRequestId",
        "recoveryOptionId",
        "decision",
        "decidingActor",
        "preparedApprovalCleanup",
        "stepAgent",
      ]) {
        if (Object.hasOwn(turn, forbidden)) {
          throw new RunnerProtocolContractError(`${label}.turn.${forbidden} is runtime-owned`);
        }
      }
      validateRunTurn({ ...turn, eventType: "user.message" }, `${label}.turn`);
      break;
    }
    case "run.cancel":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalNonEmptyString(payload.runId, `${label}.runId`);
      validateOptionalNonEmptyString(payload.commandId, `${label}.commandId`);
      break;
    case "effect.result.get":
      rejectUnknownFields(payload, label, ["sessionId", "runId", "idempotencyKey"]);
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.runId, `${label}.runId`);
      requireNonEmptyString(payload.idempotencyKey, `${label}.idempotencyKey`);
      break;
    case "session.describe":
    case "session.state":
    case "workspace.checkpoint.list":
    case "workspace.promotion.list":
    case "project.snapshot.get":
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      break;
    case "mission_control.project.get":
      requireNonEmptyString(payload.projectId, `${label}.projectId`);
      break;
    case "mission_control.action.execute":
      rejectUnknownFields(payload, label, ["action"]);
      if (
        typeof payload.action !== "object" ||
        payload.action === null ||
        Array.isArray(payload.action)
      ) {
        throw new RunnerProtocolContractError(
          `${label}.action must be an object`,
        );
      }
      break;
    case "operator.inbox":
      validateOptionalNonEmptyString(payload.sessionId, `${label}.sessionId`);
      validateOptionalNonEmptyString(payload.threadId, `${label}.threadId`);
      break;
    case "operator.thread":
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      break;
    case "conversation.messages.list":
      rejectUnknownFields(payload, label, [
        "threadId",
        "afterCursor",
        "limit",
        "includeFinalizedPayload",
        "includeTerminalOutcomes",
      ]);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      if (payload.afterCursor !== undefined) {
        parseConversationMessageCursor(payload.afterCursor, `${label}.afterCursor`);
      }
      validateOptionalIntegerRange(payload.limit, `${label}.limit`, 1, 500);
      validateOptionalBoolean(
        payload.includeFinalizedPayload,
        `${label}.includeFinalizedPayload`,
      );
      validateOptionalBoolean(
        payload.includeTerminalOutcomes,
        `${label}.includeTerminalOutcomes`,
      );
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
      rejectUnknownFields(payload, label, [
        "action",
        "threadId",
        "completionMode",
        "followUpId",
        "requestId",
        "recoveryOptionId",
        "proposalId",
        "checkpointId",
        "delegationId",
        "actionValue",
        "message",
        "attachments",
        "attachmentIds",
        "interactionMode",
        "actSubmode",
        "title",
        "rolePrompt",
        "goal",
        "profileId",
        "provider",
        "model",
        "maxTurns",
        "maxRuntimeMs",
        "allowApprovalInheritance",
        "missionControl",
      ]);
      validateEnum(payload.action, `${label}.action`, [
        "approve",
        "reject",
        "reply",
        "steer",
        "retry",
        "continue_waiting",
        "focus_thread",
        "resolve_context_checkpoint",
        "approve_assembly_change",
        "reject_assembly_change",
        "spawn_child_thread",
        "supersede_child_thread",
        "resolve_fan_in_checkpoint",
        "enqueue_follow_up",
        "edit_follow_up",
        "cancel_follow_up",
        "resume_follow_up_queue",
      ]);
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      validateOptionalEnum(payload.completionMode, `${label}.completionMode`, ["terminal", "accepted"]);
      for (const field of [
        "followUpId",
        "requestId",
        "recoveryOptionId",
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
      if (payload.recoveryOptionId !== undefined && payload.action !== "reply") {
        throw new RunnerProtocolContractError(
          `${label}.recoveryOptionId is supported only for reply actions`,
        );
      }
      validateOperatorFollowUpIdentity(payload, label);
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
      validateOptionalNonEmptyStringArray(payload.attachmentIds, `${label}.attachmentIds`);
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
      validateOptionalNonNegativeInteger(payload.maxTurns, `${label}.maxTurns`);
      validateOptionalNonNegativeInteger(payload.maxRuntimeMs, `${label}.maxRuntimeMs`);
      validateOptionalBoolean(
        payload.allowApprovalInheritance,
        `${label}.allowApprovalInheritance`,
      );
      validateOptionalMissionControlExecution(
        payload.missionControl,
        `${label}.missionControl`,
      );
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

function validateOperatorFollowUpIdentity(
  payload: Record<string, unknown>,
  label: string,
): void {
  const action = payload.action;
  const ownsFollowUpIdentity =
    action === "enqueue_follow_up"
    || action === "edit_follow_up"
    || action === "cancel_follow_up";
  if (ownsFollowUpIdentity) {
    requireNonEmptyString(payload.followUpId, `${label}.followUpId`);
  } else if (payload.followUpId !== undefined) {
    throw new RunnerProtocolContractError(
      `${label}.followUpId is supported only for enqueue_follow_up, edit_follow_up, and cancel_follow_up actions`,
    );
  }
  if (action === "enqueue_follow_up" || action === "edit_follow_up") {
    requireNonEmptyString(payload.message, `${label}.message`);
  }
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
    case "execution-profile.resolved":
      if (payload.version !== 1) {
        throw new RunnerProtocolContractError(`${label}.version must be 1`);
      }
      requireNonEmptyString(payload.profileId, `${label}.profileId`);
      validateSha256(payload.fingerprint, `${label}.fingerprint`);
      validateProfileResolutionProvenance(payload.policy, `${label}.policy`);
      validateEnvironmentPresetProvenance(payload.environmentPreset, `${label}.environmentPreset`);
      validateOptionalEnum(
        payload.hostedApprovalProducerProtocol,
        `${label}.hostedApprovalProducerProtocol`,
        [HOSTED_APPROVAL_PRODUCER_PROTOCOL],
      );
      validateRunnerProfile(
        requireRecord(payload.resolvedProfile, `${label}.resolvedProfile`),
        `${label}.resolvedProfile`,
      );
      if (payload.exactToolDecisions !== undefined) {
        const decisions = requireRecord(payload.exactToolDecisions, `${label}.exactToolDecisions`);
        for (const [toolName, decision] of Object.entries(decisions)) {
          requireNonEmptyString(toolName, `${label}.exactToolDecisions tool name`);
          validateEffectiveToolDecisionV1(
            requireRecord(decision, `${label}.exactToolDecisions.${toolName}`),
            `${label}.exactToolDecisions.${toolName}`,
          );
        }
      }
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
      validateOptionalNonEmptyString(payload.followUpId, `${label}.followUpId`);
      validateOptionalNonEmptyString(payload.sourceMessageId, `${label}.sourceMessageId`);
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
    case "effect.result.loaded":
      rejectUnknownFields(payload, label, ["version", "sessionId", "runId", "idempotencyKey", "result"]);
      if (payload.version !== 1) throw new RunnerProtocolContractError(`${label}.version must be 1`);
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.runId, `${label}.runId`);
      requireNonEmptyString(payload.idempotencyKey, `${label}.idempotencyKey`);
      validateAgentToolResultV2Wire(payload.result, `${label}.result`);
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
    case "conversation.message.routed":
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      requireNonEmptyString(payload.sessionId, `${label}.sessionId`);
      requireNonEmptyString(payload.messageId, `${label}.messageId`);
      validateEnum(payload.disposition, `${label}.disposition`, ["started", "replied", "queued"]);
      validateOptionalNonEmptyString(payload.runId, `${label}.runId`);
      validateOptionalNonEmptyString(payload.requestId, `${label}.requestId`);
      validateOptionalNonEmptyString(payload.followUpId, `${label}.followUpId`);
      requireRecord(payload.view, `${label}.view`);
      break;
    case "conversation.messages": {
      requireNonEmptyString(payload.threadId, `${label}.threadId`);
      if (!Array.isArray(payload.messages)) {
        throw new RunnerProtocolContractError(`${label}.messages must be an array`);
      }
      payload.messages.forEach((entry, index) => {
        const message = requireRecord(entry, `${label}.messages[${index}]`);
        requireNonEmptyString(message.messageId, `${label}.messages[${index}].messageId`);
        requireNonEmptyString(message.turnId, `${label}.messages[${index}].turnId`);
        requireNonEmptyString(message.threadId, `${label}.messages[${index}].threadId`);
        requireNonEmptyString(message.sessionId, `${label}.messages[${index}].sessionId`);
        requireNonEmptyString(message.runId, `${label}.messages[${index}].runId`);
        if (message.messageId !== `terminal:${message.runId as string}`) {
          throw new RunnerProtocolContractError(`${label}.messages[${index}].messageId must match its runId`);
        }
        if (message.threadId !== payload.threadId) {
          throw new RunnerProtocolContractError(`${label}.messages[${index}].threadId must match payload.threadId`);
        }
        requireIsoTimestamp(message.completedAt, `${label}.messages[${index}].completedAt`);
        const result = requireRecord(message.result, `${label}.messages[${index}].result`);
        requireNonEmptyString(result.assistantText, `${label}.messages[${index}].result.assistantText`);
        if (!Object.hasOwn(result, "output")) {
          throw new RunnerProtocolContractError(`${label}.messages[${index}].result.output is required`);
        }
        validateRunnerRunOutput(result.output, `${label}.messages[${index}].result.output`);
        const output = requireRecord(result.output, `${label}.messages[${index}].result.output`);
        if (output.status !== "COMPLETED") {
          throw new RunnerProtocolContractError(`${label}.messages[${index}].result.output.status must be 'COMPLETED'`);
        }
        if (output.runId !== message.runId) {
          throw new RunnerProtocolContractError(`${label}.messages[${index}].result.output.runId must match message.runId`);
        }
        if (output.sessionId !== message.sessionId) {
          throw new RunnerProtocolContractError(`${label}.messages[${index}].result.output.sessionId must match message.sessionId`);
        }
      });
      for (let index = 1; index < payload.messages.length; index += 1) {
        const previous = requireRecord(payload.messages[index - 1], `${label}.messages[${index - 1}]`);
        const current = requireRecord(payload.messages[index], `${label}.messages[${index}]`);
        const ordered = String(previous.completedAt).localeCompare(String(current.completedAt))
          || String(previous.turnId).localeCompare(String(current.turnId));
        if (ordered >= 0) {
          throw new RunnerProtocolContractError(`${label}.messages must be strictly chronological`);
        }
      }
      if (payload.terminalOutcomes !== undefined) {
        if (!Array.isArray(payload.terminalOutcomes)) {
          throw new RunnerProtocolContractError(`${label}.terminalOutcomes must be an array`);
        }
        payload.terminalOutcomes.forEach((entry, index) => {
          const outcome = requireRecord(entry, `${label}.terminalOutcomes[${index}]`);
          requireNonEmptyString(outcome.messageId, `${label}.terminalOutcomes[${index}].messageId`);
          requireNonEmptyString(outcome.turnId, `${label}.terminalOutcomes[${index}].turnId`);
          requireNonEmptyString(outcome.threadId, `${label}.terminalOutcomes[${index}].threadId`);
          requireNonEmptyString(outcome.sessionId, `${label}.terminalOutcomes[${index}].sessionId`);
          requireNonEmptyString(outcome.runId, `${label}.terminalOutcomes[${index}].runId`);
          if (outcome.messageId !== `terminal:${outcome.runId as string}`) {
            throw new RunnerProtocolContractError(`${label}.terminalOutcomes[${index}].messageId must match its runId`);
          }
          if (outcome.threadId !== payload.threadId) {
            throw new RunnerProtocolContractError(`${label}.terminalOutcomes[${index}].threadId must match payload.threadId`);
          }
          requireIsoTimestamp(outcome.completedAt, `${label}.terminalOutcomes[${index}].completedAt`);
          validateEnum(outcome.terminalStatus, `${label}.terminalOutcomes[${index}].terminalStatus`, ["COMPLETED", "FAILED"]);
          validateEnum(outcome.outcomeStatus, `${label}.terminalOutcomes[${index}].outcomeStatus`, ["completed", "failed", "cancelled", "contract_failure"]);
          validateEnum(outcome.handoffState, `${label}.terminalOutcomes[${index}].handoffState`, ["delivered", "failed"]);
          if (outcome.handoffState === "failed" && outcome.outcomeStatus !== "contract_failure") {
            throw new RunnerProtocolContractError(`${label}.terminalOutcomes[${index}].outcomeStatus must be 'contract_failure' when handoff failed`);
          }
          if (outcome.handoffState === "delivered") {
            const result = requireRecord(outcome.result, `${label}.terminalOutcomes[${index}].result`);
            if (outcome.terminalStatus === "COMPLETED") {
              requireNonEmptyString(result.assistantText, `${label}.terminalOutcomes[${index}].result.assistantText`);
            } else if (result.assistantText !== null) {
              throw new RunnerProtocolContractError(`${label}.terminalOutcomes[${index}].result.assistantText must be null for failed outcomes`);
            }
            validateRunnerRunOutput(result.output, `${label}.terminalOutcomes[${index}].result.output`);
            const output = requireRecord(result.output, `${label}.terminalOutcomes[${index}].result.output`);
            if (output.runId !== outcome.runId || output.sessionId !== outcome.sessionId) {
              throw new RunnerProtocolContractError(`${label}.terminalOutcomes[${index}].result.output identity must match the outcome`);
            }
          } else {
            const error = requireRecord(outcome.finalizationError, `${label}.terminalOutcomes[${index}].finalizationError`);
            requireNonEmptyString(error.code, `${label}.terminalOutcomes[${index}].finalizationError.code`);
            requireNonEmptyString(error.message, `${label}.terminalOutcomes[${index}].finalizationError.message`);
          }
        });
        for (let index = 1; index < payload.terminalOutcomes.length; index += 1) {
          const previous = requireRecord(payload.terminalOutcomes[index - 1], `${label}.terminalOutcomes[${index - 1}]`);
          const current = requireRecord(payload.terminalOutcomes[index], `${label}.terminalOutcomes[${index}]`);
          const ordered = String(previous.completedAt).localeCompare(String(current.completedAt))
            || String(previous.turnId).localeCompare(String(current.turnId));
          if (ordered >= 0) {
            throw new RunnerProtocolContractError(`${label}.terminalOutcomes must be strictly chronological`);
          }
        }
      }
      if (payload.nextCursor !== undefined) {
        parseConversationMessageCursor(payload.nextCursor, `${label}.nextCursor`);
      }
      if (typeof payload.hasMore !== "boolean") {
        throw new RunnerProtocolContractError(`${label}.hasMore must be a boolean`);
      }
      break;
    }
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
    case "mission_control.project":
      requireNonEmptyString(payload.projectId, `${label}.projectId`);
      requireRecord(payload.project, `${label}.project`);
      break;
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
  validateOptionalBoolean(turn.noninteractive, `${label}.noninteractive`);
  validateOptionalAttachments(turn.attachments, `${label}.attachments`);
  validateOptionalBoolean(turn.resumeBlockedRun, `${label}.resumeBlockedRun`);
  validateOptionalNonEmptyString(turn.resumeRequestId, `${label}.resumeRequestId`);
  validateOptionalNonEmptyString(turn.recoveryOptionId, `${label}.recoveryOptionId`);
  validateOptionalEnum(turn.decision, `${label}.decision`, [
    "decline",
    "approve_once",
    "remember_approval",
  ]);
  const decidingActor = turn.decidingActor === undefined
    ? undefined
    : parseRunnerActorMetadata(turn.decidingActor, `${label}.decidingActor`);
  const preparedApprovalCleanup = turn.preparedApprovalCleanup === undefined
    ? undefined
    : parseRunnerPreparedApprovalCleanupV1(
        turn.preparedApprovalCleanup,
        `${label}.preparedApprovalCleanup`,
      );
  if (turn.resumeBlockedRun === true && turn.resumeRequestId === undefined) {
    throw new RunnerProtocolContractError(
      `${label}.resumeRequestId is required when resumeBlockedRun is true`,
    );
  }
  if (
    turn.recoveryOptionId !== undefined &&
    turn.resumeBlockedRun !== true
  ) {
    throw new RunnerProtocolContractError(
      `${label}.recoveryOptionId requires resumeBlockedRun to be true`,
    );
  }
  if (
    turn.decision !== undefined &&
    (turn.resumeRequestId === undefined || turn.eventType !== "user.approval")
  ) {
    throw new RunnerProtocolContractError(
      `${label}.decision requires a user.approval resumeRequestId`,
    );
  }
  if (turn.decision !== undefined && decidingActor === undefined) {
    throw new RunnerProtocolContractError(
      `${label}.decidingActor is required for an approval decision`,
    );
  }
  if (decidingActor !== undefined && turn.decision === undefined) {
    throw new RunnerProtocolContractError(
      `${label}.decidingActor requires an approval decision`,
    );
  }
  if (
    preparedApprovalCleanup !== undefined &&
    (turn.decision !== "decline" ||
      turn.eventType !== "user.approval" ||
      turn.resumeRequestId !== preparedApprovalCleanup.requestId)
  ) {
    throw new RunnerProtocolContractError(
      `${label}.preparedApprovalCleanup requires the exact declined approval request`,
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
  validateOptionalMissionControlExecution(
    turn.missionControl,
    `${label}.missionControl`,
  );
  validateOptionalBoolean(turn.manualCompaction, `${label}.manualCompaction`);
  validateOptionalAutoCompaction(turn.autoCompaction, `${label}.autoCompaction`);
  validateOptionalRecord(turn.workspace, `${label}.workspace`);
  validateOptionalWorkspaceSkills(turn.workspaceSkills, `${label}.workspaceSkills`);
  if (turn.hostedApprovalAuthority !== undefined) {
    const authority = requireRecord(
      turn.hostedApprovalAuthority,
      `${label}.hostedApprovalAuthority`,
    );
    const allowedKeys = new Set([
      "version",
      "organizationId",
      "environmentId",
      "projectId",
      "threadId",
    ]);
    const unknownKey = Object.keys(authority).find(
      (key) => !allowedKeys.has(key),
    );
    if (unknownKey !== undefined) {
      throw new RunnerProtocolContractError(
        `${label}.hostedApprovalAuthority contains unknown field '${unknownKey}'`,
      );
    }
    if (authority.version !== "runner_hosted_approval_authority_v1") {
      throw new RunnerProtocolContractError(
        `${label}.hostedApprovalAuthority.version must be 'runner_hosted_approval_authority_v1'`,
      );
    }
    requireNonEmptyString(
      authority.organizationId,
      `${label}.hostedApprovalAuthority.organizationId`,
    );
    requireNonEmptyString(
      authority.environmentId,
      `${label}.hostedApprovalAuthority.environmentId`,
    );
    requireNonEmptyString(
      authority.projectId,
      `${label}.hostedApprovalAuthority.projectId`,
    );
    requireNonEmptyString(
      authority.threadId,
      `${label}.hostedApprovalAuthority.threadId`,
    );
  }
}

function parseJobInput(value: unknown, label: string): RunnerJobInput {
  const input = requireRecord(value, label);
  if (input.version !== "job_input_v1" && input.version !== "job_input_v2") {
    throw new RunnerProtocolContractError(`${label}.version must be 'job_input_v1' or 'job_input_v2'`);
  }
  const allowedKeys = new Set([
    "version", "environmentPresetId", "turn", "profileId", "profile", "storeDriver", "approvalPolicyPackId",
  ]);
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    throw new RunnerProtocolContractError(`${label} contains unknown field '${unknownKey}'`);
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
    "isolated_code",
    "ci_bot",
    "hosted_workspace",
    "production",
  ]);
  const environmentPresetId = input.version === "job_input_v2"
    ? (() => {
        validateEnum(input.environmentPresetId, `${label}.environmentPresetId`, [
          "cli_safe_local", "cli_dev_local", "desktop_safe_local", "desktop_dev_local", "workspace_hosted",
        ]);
        return input.environmentPresetId;
      })()
    : undefined;
  return {
    ...input,
    version: input.version,
    ...(environmentPresetId === undefined ? {} : { environmentPresetId }),
    turn,
  } as RunnerJobInput;
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
  const resultHandle = output.resultHandle === undefined
    ? undefined
    : parseJobManagedResultHandle(output.resultHandle, `${label}.resultHandle`);
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
    ...(resultHandle !== undefined ? { resultHandle } : {}),
    replay: output.replay as RunnerJobReplayPointerV1,
    result,
    ...(output.error !== undefined ? { error: output.error as RunnerRunError } : {}),
  };
}

function parseJobManagedResultHandle(
  value: unknown,
  label: string,
): RunnerJobManagedResultHandleV1 {
  const handle = requireRecord(value, label);
  rejectUnknownFields(handle, label, [
    "version",
    "kind",
    "worktreePath",
    "sourceWorkspaceRoot",
    "baseRevision",
    "candidateRevision",
    "changedFiles",
    "promotionId",
  ]);
  if (handle.version !== "job_managed_result_handle_v1") {
    throw new RunnerProtocolContractError(
      `${label}.version must be 'job_managed_result_handle_v1'`,
    );
  }
  if (handle.kind !== "managed_worktree") {
    throw new RunnerProtocolContractError(
      `${label}.kind must be 'managed_worktree'`,
    );
  }
  const worktreePath = requireNonEmptyString(handle.worktreePath, `${label}.worktreePath`);
  const sourceWorkspaceRoot = requireNonEmptyString(
    handle.sourceWorkspaceRoot,
    `${label}.sourceWorkspaceRoot`,
  );
  const baseRevision = requireNonEmptyString(handle.baseRevision, `${label}.baseRevision`);
  const candidateRevision = requireNonEmptyString(
    handle.candidateRevision,
    `${label}.candidateRevision`,
  );
  validateNonEmptyStringArray(handle.changedFiles, `${label}.changedFiles`);
  validateOptionalNonEmptyString(handle.promotionId, `${label}.promotionId`);
  return {
    version: "job_managed_result_handle_v1",
    kind: "managed_worktree",
    worktreePath,
    sourceWorkspaceRoot,
    baseRevision,
    candidateRevision,
    changedFiles: [...(handle.changedFiles as string[])],
    ...(handle.promotionId !== undefined
      ? { promotionId: handle.promotionId as string }
      : {}),
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
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "pricedCostUsd",
    "validationRejections",
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
  validateOptionalRecord(waitFor.metadata, `${label}.metadata`);
  const waitMetadata = isRecord(waitFor.metadata) ? waitFor.metadata : undefined;
  const reviewReason = waitMetadata?.reason;
  if (reviewReason === "evaluation_review") {
    const review = parseRunnerStructuredReviewInteractionV1(waitFor.interaction);
    if (review.kind !== "structured_review" || review.reason !== "evaluation_review") {
      throw new RunnerProtocolContractError(
        `${label}.interaction must contain the canonical evaluation_review contract`,
      );
    }
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
  if (interaction.version === RUNNER_LOCAL_TOOL_APPROVAL_INTERACTION_V1) {
    validateRunnerLocalToolApprovalInteractionV1(
      interaction,
      label,
      waitEventType,
    );
    return;
  }
  if (interaction.version === RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V4) {
    validateRunnerHostedToolApprovalInteractionV4(
      interaction,
      label,
      waitEventType,
    );
    return;
  }
  if (interaction.version !== "v1") {
    throw new RunnerProtocolContractError(`${label}.version must be 'v1'`);
  }
  requireNonEmptyString(interaction.requestId, `${label}.requestId`);
  validateEnum(interaction.kind, `${label}.kind`, ["user_input"]);
  const eventType = requireNonEmptyString(interaction.eventType, `${label}.eventType`);
  if (eventType !== waitEventType) {
    throw new RunnerProtocolContractError(
      `${label}.eventType must match ${label.replace(/\.interaction$/u, "")}.eventType`,
    );
  }
  requireNonEmptyString(interaction.prompt, `${label}.prompt`);
  validateOptionalRecord(interaction.inputSchema, `${label}.inputSchema`);
  validateOptionalRecord(interaction.metadata, `${label}.metadata`);
  const structuredReview = parseRunnerStructuredReviewInteractionV1(interaction);
  if (
    structuredReview.kind === "invalid_review" &&
    structuredReview.reason !== "recovery_review"
  ) {
    throw new RunnerProtocolContractError(
      `${label} is an invalid structured review: ${structuredReview.error}`,
    );
  }
}

function validateRunnerLocalToolApprovalInteractionV1(
  interaction: Record<string, unknown>,
  label: string,
  waitEventType: string,
): void {
  rejectUnknownFields(interaction, label, [
    "version",
    "requestId",
    "kind",
    "eventType",
    "prompt",
    "inputSchema",
    "metadata",
    "approval",
  ]);
  if (interaction.version !== RUNNER_LOCAL_TOOL_APPROVAL_INTERACTION_V1) {
    throw new RunnerProtocolContractError(
      `${label}.version must be '${RUNNER_LOCAL_TOOL_APPROVAL_INTERACTION_V1}'`,
    );
  }
  requireNonEmptyString(interaction.requestId, `${label}.requestId`);
  if (interaction.kind !== "approval") {
    throw new RunnerProtocolContractError(`${label}.kind must be 'approval'`);
  }
  if (interaction.eventType !== "user.approval" || waitEventType !== "user.approval") {
    throw new RunnerProtocolContractError(`${label}.eventType must be 'user.approval'`);
  }
  requireNonEmptyString(interaction.prompt, `${label}.prompt`);
  validateOptionalRecord(interaction.metadata, `${label}.metadata`);
  const schema = requireRecord(interaction.inputSchema, `${label}.inputSchema`);
  rejectUnknownFields(schema, `${label}.inputSchema`, [
    "type",
    "additionalProperties",
    "required",
    "properties",
  ]);
  const properties = requireRecord(schema.properties, `${label}.inputSchema.properties`);
  rejectUnknownFields(properties, `${label}.inputSchema.properties`, ["decision"]);
  const decision = requireRecord(properties.decision, `${label}.inputSchema.properties.decision`);
  rejectUnknownFields(decision, `${label}.inputSchema.properties.decision`, [
    "type",
    "enum",
  ]);
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    Array.isArray(schema.required) === false ||
    schema.required.length !== 1 ||
    schema.required[0] !== "decision" ||
    decision.type !== "string" ||
    Array.isArray(decision.enum) === false ||
    decision.enum.length !== 2 ||
    decision.enum[0] !== "decline" ||
    decision.enum[1] !== "approve_once"
  ) {
    throw new RunnerProtocolContractError(`${label}.inputSchema is invalid`);
  }
  const approval = requireRecord(interaction.approval, `${label}.approval`);
  rejectUnknownFields(approval, `${label}.approval`, [
    "approvalId",
    "toolName",
    "presentation",
    "requestedAt",
    "expiresAt",
  ]);
  requireNonEmptyString(approval.approvalId, `${label}.approval.approvalId`);
  requireNonEmptyString(approval.toolName, `${label}.approval.toolName`);
  const requestedAt = requireIsoTimestamp(
    approval.requestedAt,
    `${label}.approval.requestedAt`,
  );
  const expiresAt = requireIsoTimestamp(
    approval.expiresAt,
    `${label}.approval.expiresAt`,
  );
  if (Date.parse(expiresAt) <= Date.parse(requestedAt)) {
    throw new RunnerProtocolContractError(
      `${label}.approval.expiresAt must be after requestedAt`,
    );
  }
}

function validateRunnerHostedToolApprovalInteractionV4(
  interaction: Record<string, unknown>,
  label: string,
  waitEventType: string,
): void {
  validateRunnerHostedToolApprovalInteraction(
    interaction,
    label,
    waitEventType,
    RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V4,
    ["decline", "approve_once", "remember_approval"],
  );
}

function validateRunnerHostedToolApprovalInteraction(
  interaction: Record<string, unknown>,
  label: string,
  waitEventType: string,
  expectedVersion: typeof RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V4,
  expectedDecisions: readonly HostedToolApprovalDecision[],
): void {
  rejectUnknownFields(interaction, label, [
    "version",
    "requestId",
    "kind",
    "eventType",
    "prompt",
    "inputSchema",
    "metadata",
    "approval",
  ]);
  if (interaction.version !== expectedVersion) {
    throw new RunnerProtocolContractError(
      `${label}.version must be '${expectedVersion}'`,
    );
  }
  requireNonEmptyString(interaction.requestId, `${label}.requestId`);
  if (interaction.kind !== "approval") {
    throw new RunnerProtocolContractError(`${label}.kind must be 'approval'`);
  }
  if (interaction.eventType !== "user.approval" || waitEventType !== "user.approval") {
    throw new RunnerProtocolContractError(`${label}.eventType must be 'user.approval'`);
  }
  requireNonEmptyString(interaction.prompt, `${label}.prompt`);
  validateOptionalRecord(interaction.metadata, `${label}.metadata`);
  const schema = requireRecord(interaction.inputSchema, `${label}.inputSchema`);
  rejectUnknownFields(schema, `${label}.inputSchema`, [
    "type",
    "additionalProperties",
    "required",
    "properties",
  ]);
  const properties = requireRecord(schema.properties, `${label}.inputSchema.properties`);
  rejectUnknownFields(properties, `${label}.inputSchema.properties`, ["decision"]);
  const decision = requireRecord(properties.decision, `${label}.inputSchema.properties.decision`);
  rejectUnknownFields(decision, `${label}.inputSchema.properties.decision`, [
    "type",
    "enum",
  ]);
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    Array.isArray(schema.required) === false ||
    schema.required.length !== 1 ||
    schema.required[0] !== "decision" ||
    decision.type !== "string" ||
    Array.isArray(decision.enum) === false ||
    decision.enum.length !== expectedDecisions.length ||
    decision.enum.some((entry, index) => entry !== expectedDecisions[index]) ||
    decision.enum.some((entry) => {
      try {
        parseHostedToolApprovalDecision(entry);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new RunnerProtocolContractError(`${label}.inputSchema is invalid`);
  }
  const approval = requireRecord(interaction.approval, `${label}.approval`);
  rejectUnknownFields(
    approval,
    `${label}.approval`,
    [
      "preparedInvocationId",
      "toolName",
      "stableToolIdentity",
      "requestingActor",
      "presentation",
      ...(expectedVersion === RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V4
        ? ["rememberedApprovalScope", "requestedAt", "expiresAt"]
        : []),
    ],
  );
  requireNonEmptyString(
    approval.preparedInvocationId,
    `${label}.approval.preparedInvocationId`,
  );
  requireNonEmptyString(approval.toolName, `${label}.approval.toolName`);
  if (expectedVersion === RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V4) {
    parseRememberedApprovalScope(approval.rememberedApprovalScope);
    const requestedAt = requireIsoTimestamp(
      approval.requestedAt,
      `${label}.approval.requestedAt`,
    );
    const expiresAt = requireIsoTimestamp(
      approval.expiresAt,
      `${label}.approval.expiresAt`,
    );
    if (Date.parse(expiresAt) <= Date.parse(requestedAt)) {
      throw new RunnerProtocolContractError(
        `${label}.approval.expiresAt must be after requestedAt`,
      );
    }
  }
  const stableToolIdentity = parseStableToolApprovalIdentityV1(
    approval.stableToolIdentity,
  );
  if (stableToolIdentity.toolId !== approval.toolName) {
    throw new RunnerProtocolContractError(
      `${label}.approval.stableToolIdentity.toolId must match ${label}.approval.toolName`,
    );
  }
  try {
    const requestingActor = requireRecord(
      approval.requestingActor,
      `${label}.approval.requestingActor`,
    );
    rejectUnknownFields(
      requestingActor,
      `${label}.approval.requestingActor`,
      ["actorType", "actorId", "tenantId"],
    );
    parseRunnerActorMetadata(
      requestingActor,
      `${label}.approval.requestingActor`,
    );
  } catch (error) {
    throw new RunnerProtocolContractError(
      `${label}.approval.requestingActor is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (approval.presentation !== undefined) {
    requireRecord(approval.presentation, `${label}.approval.presentation`);
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
  validateOptionalAppApprovalPolicyRecord(
    profile.kestrelOneAppApprovalPolicies,
    `${label}.kestrelOneAppApprovalPolicies`,
  );
  parseRememberedToolApprovalEvidenceSetV1(
    profile.rememberedToolApprovalEvidence,
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

function validateOptionalAppApprovalPolicyRecord(
  value: unknown,
  label: string,
): void {
  if (value === undefined) return;
  const policies = requireRecord(value, label);
  for (const [toolName, rawPolicy] of Object.entries(policies)) {
    requireNonEmptyString(toolName, `${label} tool name`);
    const policy = requireRecord(rawPolicy, `${label}.${toolName}`);
    validateEnum(policy.environment, `${label}.${toolName}.environment`, [
      "auto",
      "ask",
      "deny",
    ]);
    validateOptionalEnum(policy.project, `${label}.${toolName}.project`, [
      "auto",
      "ask",
      "deny",
    ]);
    validateOptionalEnum(policy.subject, `${label}.${toolName}.subject`, [
      "auto",
      "ask",
      "deny",
    ]);
    validateEnum(policy.minimum, `${label}.${toolName}.minimum`, ["auto", "ask"]);
  }
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
  const attachments: Array<{ sizeBytes: number; fileId: string }> = [];
  validateRecordArray(value, label, (attachment, attachmentLabel) => {
    const fileId = attachment.fileId ?? attachment.attachmentId;
    requireNonEmptyString(fileId, `${attachmentLabel}.fileId`);
    validateOptionalNonEmptyString(attachment.fileId, `${attachmentLabel}.fileId`);
    validateOptionalNonEmptyString(attachment.attachmentId, `${attachmentLabel}.attachmentId`);
    validateOptionalNonEmptyString(attachment.threadId, `${attachmentLabel}.threadId`);
    requireNonEmptyString(attachment.filename, `${attachmentLabel}.filename`);
    requireNonEmptyString(attachment.mimeType, `${attachmentLabel}.mimeType`);
    requireNonNegativeInteger(attachment.sizeBytes, `${attachmentLabel}.sizeBytes`);
    const sha256 = requireNonEmptyString(attachment.sha256, `${attachmentLabel}.sha256`);
    if (/^[a-f0-9]{64}$/u.test(sha256) === false) {
      throw new RunnerProtocolContractError(`${attachmentLabel}.sha256 must be a SHA-256 digest.`);
    }
    validateEnum(attachment.kind, `${attachmentLabel}.kind`, ["image", "text", "file"]);
    validateEnum(attachment.representationStatus, `${attachmentLabel}.representationStatus`, [
      "native_image",
      "extracted_text",
      "staged_file",
      "metadata_only",
    ]);
    validateOptionalNonEmptyString(attachment.createdAt, `${attachmentLabel}.createdAt`);
    validateOptionalString(attachment.data, `${attachmentLabel}.data`);
    validateOptionalString(attachment.text, `${attachmentLabel}.text`);
    if (attachment.textTruncated !== undefined && typeof attachment.textTruncated !== "boolean") {
      throw new RunnerProtocolContractError(`${attachmentLabel}.textTruncated must be a boolean.`);
    }
    validateOptionalNonEmptyString(attachment.path, `${attachmentLabel}.path`);
    validateOptionalNonEmptyString(attachment.sourceUrl, `${attachmentLabel}.sourceUrl`);
    validateOptionalNonEmptyString(attachment.sourceUrlExpiresAt, `${attachmentLabel}.sourceUrlExpiresAt`);
    validateOptionalNonEmptyString(attachment.metadataOnlyReason, `${attachmentLabel}.metadataOnlyReason`);
    attachments.push({
      fileId: String(fileId),
      sizeBytes: Number(attachment.sizeBytes),
    });
  });
  if (attachments.length > 20) {
    throw new RunnerProtocolContractError(`${label} must contain at most 20 attachments.`);
  }
  if (new Set(attachments.map((entry) => entry.fileId)).size !== attachments.length) {
    throw new RunnerProtocolContractError(`${label} file IDs must be unique.`);
  }
  if (attachments.some((entry) => entry.sizeBytes > 100 * 1024 * 1024)) {
    throw new RunnerProtocolContractError(`${label} attachments must each be at most 100 MiB.`);
  }
  if (attachments.reduce((sum, entry) => sum + entry.sizeBytes, 0) > 500 * 1024 * 1024) {
    throw new RunnerProtocolContractError(`${label} must total at most 500 MiB.`);
  }
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

function parseRunnerActorMetadata(
  value: unknown,
  label = "runner command.metadata.actor",
): RunnerActorMetadata {
  const actor = requireRecord(value, label);
  const actorId = requireNonEmptyString(
    actor.actorId,
    `${label}.actorId`,
  );
  if (
    actor.actorType !== "end_user"
    && actor.actorType !== "operator"
    && actor.actorType !== "service"
  ) {
    throw new RunnerProtocolContractError(
      `${label}.actorType must be 'end_user', 'operator', or 'service'`,
    );
  }
  const displayName = parseOptionalNonEmptyString(
    actor.displayName,
    `${label}.displayName`,
  );
  const tenantId = parseOptionalNonEmptyString(
    actor.tenantId,
    `${label}.tenantId`,
  );
  if (actor.orgRole !== undefined && actor.orgRole !== "member" && actor.orgRole !== "org_admin") {
    throw new RunnerProtocolContractError(
      `${label}.orgRole must be 'member' or 'org_admin'`,
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

function validateOptionalMissionControlExecution(
  value: unknown,
  label: string,
): void {
  if (value === undefined) {
    return;
  }
  const record = requireRecord(value, label);
  rejectUnknownFields(record, label, [
    "projectId",
    "itemId",
    "attemptId",
    "commandId",
    "runId",
  ]);
  requireNonEmptyString(record.projectId, `${label}.projectId`);
  requireNonEmptyString(record.itemId, `${label}.itemId`);
  requireNonEmptyString(record.attemptId, `${label}.attemptId`);
  requireNonEmptyString(record.commandId, `${label}.commandId`);
  requireNonEmptyString(record.runId, `${label}.runId`);
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
    "RUN_FAILED", "MODEL_CALL_STARTED", "MODEL_ATTEMPT_STARTED",
    "MODEL_ATTEMPT_RETRYING", "MODEL_CALL_DONE", "MODEL_CALL_FAILED",
    "TOOL_CALL_STARTED", "TOOL_CALL_DONE", "TOOL_CALL_FAILED",
    "EVALUATION_CHECKING", "EVALUATION_REVISING",
    "EVALUATION_REVIEW_REQUIRED",
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
  const update = requireRecord(value, label);
  if (update.version !== "v1" && update.version !== "v2") {
    throw new RunnerProtocolContractError(
      `${label}.version must be 'v1' or 'v2'`,
    );
  }
  requireNonEmptyString(update.runId, `${label}.runId`);
  requireNonEmptyString(update.sessionId, `${label}.sessionId`);
  requireNonEmptyString(update.ts, `${label}.ts`);
  requireNonNegativeInteger(update.seq, `${label}.seq`);
  const toolCallId = requireNonEmptyString(
    update.toolCallId,
    `${label}.toolCallId`,
  );
  const toolName = requireNonEmptyString(update.toolName, `${label}.toolName`);
  validateEnum(update.phase, `${label}.phase`, ["started", "completed", "failed"]);
  if (update.phase !== expectedPhase) {
    throw new RunnerProtocolContractError(
      `${label}.phase must match the runner event type '${expectedPhase}'`,
    );
  }
  if (update.version === "v2") {
    const activation = validateAgentToolActivationV1(
      update.activation,
      `${label}.activation`,
    );
    if (activation.descriptorToolId !== toolName) {
      throw new RunnerProtocolContractError(
        `${label}.activation must match toolName`,
      );
    }
    if (update.phase !== "started" && update.outcome === undefined) {
      throw new RunnerProtocolContractError(
        `${label}.outcome is required for a terminal v2 tool update`,
      );
    }
    if (update.outcome !== undefined) {
      const outcome = requireRecord(update.outcome, `${label}.outcome`);
      if (outcome.version !== "v1") {
        throw new RunnerProtocolContractError(
          `${label}.outcome.version must be 'v1'`,
        );
      }
      if (
        requireNonEmptyString(outcome.callId, `${label}.outcome.callId`) !==
        toolCallId
      ) {
        throw new RunnerProtocolContractError(
          `${label}.outcome.callId must match toolCallId`,
        );
      }
      const outcomeActivation = validateAgentToolActivationV1(
        outcome.activation,
        `${label}.outcome.activation`,
      );
      if (outcomeActivation.canonicalIdentity !== activation.canonicalIdentity) {
        throw new RunnerProtocolContractError(
          `${label}.outcome.activation must match activation`,
        );
      }
      validateEnum(outcome.kind, `${label}.outcome.kind`, [
        "success",
        "partial",
        "failure",
        "cancellation",
      ]);
      validateEnum(outcome.effectState, `${label}.outcome.effectState`, [
        "not_applicable",
        "not_started",
        "committed",
        "unknown",
      ]);
      requireNonEmptyString(outcome.startedAt, `${label}.outcome.startedAt`);
      requireNonEmptyString(outcome.completedAt, `${label}.outcome.completedAt`);
      if (outcome.kind !== "success") {
        requireNonEmptyString(
          outcome.normalizedFailureCode,
          `${label}.outcome.normalizedFailureCode`,
        );
        requireBoolean(outcome.retryable, `${label}.outcome.retryable`);
      }
    }
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

function validateAgentToolResultV2Wire(value: unknown, label: string): void {
  const result = requireRecord(value, label);
  rejectUnknownFields(result, label, ["version", "toolName", "status", "toolCallId", "activation", "outcome", "modelContext", "auditRecord", "projections", "presentation"]);
  if (result.version !== "v2") throw new RunnerProtocolContractError(`${label}.version must be 'v2'`);
  const toolName = requireNonEmptyString(result.toolName, `${label}.toolName`);
  const toolCallId = requireNonEmptyString(result.toolCallId, `${label}.toolCallId`);
  if (result.status !== "OK" && result.status !== "FAILED") throw new RunnerProtocolContractError(`${label}.status is invalid`);

  const activation = validateAgentToolActivationV1(result.activation, `${label}.activation`);
  const outcome = requireRecord(result.outcome, `${label}.outcome`);
  rejectUnknownFields(outcome, `${label}.outcome`, ["version", "callId", "activation", "kind", "startedAt", "completedAt", "effectState", "rawOutput", "normalizedFailureCode", "retryable", "error"]);
  if (outcome.version !== "v1") throw new RunnerProtocolContractError(`${label}.outcome.version must be 'v1'`);
  const outcomeCallId = requireNonEmptyString(outcome.callId, `${label}.outcome.callId`);
  const outcomeActivation = validateAgentToolActivationV1(outcome.activation, `${label}.outcome.activation`);
  if (!["success", "partial", "failure", "cancellation"].includes(String(outcome.kind))) throw new RunnerProtocolContractError(`${label}.outcome.kind is invalid`);
  if (!["not_applicable", "not_started", "committed", "unknown"].includes(String(outcome.effectState))) throw new RunnerProtocolContractError(`${label}.outcome.effectState is invalid`);
  requireNonEmptyString(outcome.startedAt, `${label}.outcome.startedAt`);
  requireNonEmptyString(outcome.completedAt, `${label}.outcome.completedAt`);
  if (outcome.kind === "success" && !Object.hasOwn(outcome, "rawOutput")) throw new RunnerProtocolContractError(`${label}.outcome.rawOutput is required`);
  if (outcome.kind === "partial") {
    if (!Object.hasOwn(outcome, "rawOutput")) throw new RunnerProtocolContractError(`${label}.outcome.rawOutput is required`);
    requireNonEmptyString(outcome.normalizedFailureCode, `${label}.outcome.normalizedFailureCode`);
    requireBoolean(outcome.retryable, `${label}.outcome.retryable`);
  }
  if (outcome.kind === "failure") {
    requireNonEmptyString(outcome.normalizedFailureCode, `${label}.outcome.normalizedFailureCode`);
    requireBoolean(outcome.retryable, `${label}.outcome.retryable`);
    const error = requireRecord(outcome.error, `${label}.outcome.error`);
    rejectUnknownFields(error, `${label}.outcome.error`, ["message", "details"]);
    requireString(error.message, `${label}.outcome.error.message`);
    if (error.details !== undefined) requireRecord(error.details, `${label}.outcome.error.details`);
  }
  if (outcome.kind === "cancellation" && (outcome.normalizedFailureCode !== "TOOL_CANCELLED" || outcome.retryable !== false)) throw new RunnerProtocolContractError(`${label}.outcome cancellation is invalid`);

  const modelContext = requireRecord(result.modelContext, `${label}.modelContext`);
  rejectUnknownFields(modelContext, `${label}.modelContext`, ["text", "rawOutputRef", "truncated"]);
  requireString(modelContext.text, `${label}.modelContext.text`);
  requireNonEmptyString(modelContext.rawOutputRef, `${label}.modelContext.rawOutputRef`);
  requireBoolean(modelContext.truncated, `${label}.modelContext.truncated`);
  const audit = requireRecord(result.auditRecord, `${label}.auditRecord`);
  rejectUnknownFields(audit, `${label}.auditRecord`, ["toolName", "input", "output", "error", "startedAt", "completedAt", "durationMs", "status"]);
  if (audit.toolName !== toolName || audit.status !== result.status) throw new RunnerProtocolContractError(`${label} evidence identities do not agree`);
  if (outcomeCallId !== toolCallId || activation.descriptorToolId !== toolName || outcomeActivation.canonicalIdentity !== activation.canonicalIdentity) throw new RunnerProtocolContractError(`${label} evidence identities do not agree`);
  requireRecord(audit.input, `${label}.auditRecord.input`);
  requireNonEmptyString(audit.startedAt, `${label}.auditRecord.startedAt`);
  requireNonEmptyString(audit.completedAt, `${label}.auditRecord.completedAt`);
  if (typeof audit.durationMs !== "number" || !Number.isFinite(audit.durationMs) || audit.durationMs < 0) throw new RunnerProtocolContractError(`${label}.auditRecord.durationMs is invalid`);
  if (result.projections !== undefined) requireRecord(result.projections, `${label}.projections`);
  if (result.presentation !== undefined) requireRecord(result.presentation, `${label}.presentation`);
}

function validateAgentToolActivationV1(value: unknown, label: string): { descriptorToolId: string; contractRevision: string; canonicalIdentity: string } {
  const activation = requireRecord(value, label);
  rejectUnknownFields(activation, label, ["version", "descriptor", "registryGeneration", "scopeFingerprint"]);
  if (activation.version !== "v1") throw new RunnerProtocolContractError(`${label}.version must be 'v1'`);
  requireNonEmptyString(activation.registryGeneration, `${label}.registryGeneration`);
  validateCanonicalSha256(activation.scopeFingerprint, `${label}.scopeFingerprint`);
  const descriptor = requireRecord(activation.descriptor, `${label}.descriptor`);
  rejectUnknownFields(descriptor, `${label}.descriptor`, ["version", "toolId", "sourceKind", "sourceId", "contractRevision", "inputSchemaHash", "outputContractHash"]);
  if (descriptor.version !== "v1") throw new RunnerProtocolContractError(`${label}.descriptor.version must be 'v1'`);
  const descriptorToolId = requireNonEmptyString(descriptor.toolId, `${label}.descriptor.toolId`);
  if (!["builtin", "embedded", "mcp"].includes(String(descriptor.sourceKind))) throw new RunnerProtocolContractError(`${label}.descriptor.sourceKind is invalid`);
  requireNonEmptyString(descriptor.sourceId, `${label}.descriptor.sourceId`);
  validateCanonicalSha256(descriptor.contractRevision, `${label}.descriptor.contractRevision`);
  validateCanonicalSha256(descriptor.inputSchemaHash, `${label}.descriptor.inputSchemaHash`);
  validateCanonicalSha256(descriptor.outputContractHash, `${label}.descriptor.outputContractHash`);
  return {
    descriptorToolId,
    contractRevision: descriptor.contractRevision as string,
    canonicalIdentity: [descriptor.version, descriptor.toolId, descriptor.sourceKind, descriptor.sourceId, descriptor.contractRevision, descriptor.inputSchemaHash, descriptor.outputContractHash, activation.registryGeneration, activation.scopeFingerprint].join("\u0000"),
  };
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

function validateSha256(value: unknown, label: string): void {
  if (typeof value !== "string" || /^[a-f0-9]{64}$/u.test(value) === false) {
    throw new RunnerProtocolContractError(`${label} must be a SHA-256 digest`);
  }
}

function validateCanonicalSha256(value: unknown, label: string): void {
  if (typeof value !== "string" || /^sha256:[a-f0-9]{64}$/u.test(value) === false) {
    throw new RunnerProtocolContractError(`${label} must be a canonical SHA-256 digest`);
  }
}

function validateProfileResolutionProvenance(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  requireNonEmptyString(record.id, `${label}.id`);
  const version = requireNonNegativeInteger(record.version, `${label}.version`);
  if (version < 1) {
    throw new RunnerProtocolContractError(`${label}.version must be positive`);
  }
}

function validateEnvironmentPresetProvenance(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  validateEnum(record.id, `${label}.id`, [
    "cli_safe_local",
    "cli_dev_local",
    "desktop_safe_local",
    "desktop_dev_local",
    "workspace_hosted",
  ]);
  const version = requireNonNegativeInteger(record.version, `${label}.version`);
  if (version < 1) {
    throw new RunnerProtocolContractError(`${label}.version must be positive`);
  }
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

function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new RunnerProtocolContractError(`${label} must be an ISO timestamp`);
  }
  return timestamp;
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

function validateUniqueNonEmptyStringArray(value: unknown, label: string): void {
  validateNonEmptyStringArray(value, label);
  if (new Set(value as string[]).size !== (value as string[]).length) {
    throw new RunnerProtocolContractError(`${label} must not contain duplicates`);
  }
}

function validateEffectiveToolDecisionV1(
  value: Record<string, unknown>,
  label: string,
): void {
  if (value.version !== "effective_tool_decision_v1") {
    throw new RunnerProtocolContractError(
      `${label}.version must be effective_tool_decision_v1`,
    );
  }
  requireBoolean(value.available, `${label}.available`);
  validateEnum(value.availabilityReason, `${label}.availabilityReason`, [
    "available",
    "approval_policy",
    "interaction_mode",
    "tool_class_policy",
    "capability_policy",
    "approval_policy",
    "actor_access",
  ]);
  const disposition = requireRecord(
    value.approvalDisposition,
    `${label}.approvalDisposition`,
  );
  validateEnum(disposition.mode, `${label}.approvalDisposition.mode`, [
    "auto",
    "ask",
    "deny",
  ]);
  validateEnum(
    disposition.reasonCode,
    `${label}.approvalDisposition.reasonCode`,
    [
      "tool_minimum",
      "environment_policy",
      "project_restriction",
      "subject_restriction",
      "runtime_strict",
      "remembered_thread",
    ],
  );
  const authority = requireRecord(
    disposition.authority,
    `${label}.approvalDisposition.authority`,
  );
  validateEnum(authority.kind, `${label}.approvalDisposition.authority.kind`, [
    "runtime_policy",
    "hosted_mcp_grant",
    "hosted_app_policy",
  ]);
  requireNonEmptyString(
    authority.revision,
    `${label}.approvalDisposition.authority.revision`,
  );
  requireBoolean(
    value.rememberApprovalEligible,
    `${label}.rememberApprovalEligible`,
  );
  requireNonEmptyString(value.authorityRevision, `${label}.authorityRevision`);
  const evidence = requireRecord(value.evidence, `${label}.evidence`);
  validateEnum(evidence.interactionMode, `${label}.evidence.interactionMode`, [
    "chat",
    "plan",
    "build",
  ]);
  validateEnum(evidence.toolClass, `${label}.evidence.toolClass`, [
    "read_only",
    "planning_write",
    "sandboxed_only",
    "external_side_effect",
  ]);
  validateStringArray(
    evidence.requiredCapabilities,
    `${label}.evidence.requiredCapabilities`,
  );
  validateOptionalEnum(
    evidence.blockedCapability,
    `${label}.evidence.blockedCapability`,
    [
      "workspace.read",
      "workspace.write",
      "shell.exec",
      "mission_control.work_item.write",
      "network.call",
      "code.execute",
      "mcp.invoke",
      "delegation.control",
      "external.confirm",
    ],
  );
  requireBoolean(evidence.actorAccess, `${label}.evidence.actorAccess`);
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
