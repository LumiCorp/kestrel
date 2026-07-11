import type {
  ActSubmode,
  CodeModeProfileConfig,
  DevShellProfileConfig,
  ExecutionPolicyOverride,
  GuardrailConfig,
  InteractionMode,
  McpServerConfig,
  NormalizedOutput,
  ProgressUpdateV1,
  ReasoningUpdateV1,
  ToolExecutionClass,
} from "../src/index.js";
import type {
  OperatorAffordancePayload,
  OperatorBlockReason,
  OperatorCompactionState,
  OperatorContextSummary,
  OperatorRecommendedAction,
  OperatorTaskInboxSummary,
  OperatorWaitSummary,
} from "../src/orchestration/OperatorAffordanceProjection.js";
import type {
  OperatorAssemblySummary,
  OperatorCheckpointSummary,
  OperatorChildBlockerChainSummary,
  OperatorChildBlockerSummary,
  OperatorEvidenceRecoverySummary,
  OperatorFanInDispositionSummary,
  OperatorInboxSummary,
  OperatorReasoningSummary,
  OperatorRuntimePlanSummary,
  OperatorSteeringSummary,
  OperatorSupervisedChildSummary,
  OperatorSupervisionSummary,
  OperatorAdaptationSummary,
} from "../src/orchestration/OperatorSessionProjection.js";
import type {
  CapabilityPackId,
  RuntimeIdentityMetadata,
  ShellKind,
  ShellPresetId,
} from "../src/profile/runtimeProfile.js";
import type { SubAgentResultEnvelope } from "../src/kestrel/contracts/orchestration.js";

import type { OperatorChildResultSummary } from "../src/orchestration/contracts.js";
import type { ThemeMode, ThemeOverrides, ThemePresetId } from "./ink/theme/tokens.js";

export type { ProgressUpdateV1 };
export type { ReasoningUpdateV1 };
export type { NormalizedOutput };
export type {
  OperatorAffordancePayload,
  OperatorAssemblySummary,
  OperatorBlockReason,
  OperatorCheckpointSummary,
  OperatorChildBlockerChainSummary,
  OperatorChildBlockerSummary,
  OperatorCompactionState,
  OperatorContextSummary,
  OperatorEvidenceRecoverySummary,
  OperatorFanInDispositionSummary,
  OperatorInboxSummary,
  OperatorRecommendedAction,
  OperatorReasoningSummary,
  OperatorRuntimePlanSummary,
  OperatorSteeringSummary,
  OperatorSupervisedChildSummary,
  OperatorSupervisionSummary,
  OperatorAdaptationSummary,
  OperatorTaskInboxSummary,
  OperatorWaitSummary,
};

export type SupportedAgent = "reference-react";
export type ModelProviderId = "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";
export type StoreDriverId = "auto" | "postgres" | "sqlite";
export type ApprovalPolicyPackId = "dev" | "ci_bot" | "production";
export interface AgentStageConfig {
  modelByStage?: Record<string, string> | undefined;
}

export type DelegationTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED";

export interface SkillPackDefinition {
  id: string;
  label: string;
  instructions: string[];
  allowedTools: string[];
}

export interface WorkspaceManifest {
  version: 1;
  workspaceId: string;
  label?: string | undefined;
  appRoot?: string | undefined;
  packageManager?: string | undefined;
  commands?: WorkspaceCommandContract | undefined;
}

export interface WorkspaceCommandContract {
  install?: string | undefined;
  dev?: string | undefined;
  build?: string | undefined;
  test?: string | undefined;
}

export interface WorkspaceRegistryEntry {
  workspaceId: string;
  rootPath: string;
  launchCwd?: string | undefined;
  label?: string | undefined;
  automationEnabled: boolean;
  automationEnabledAt?: string | undefined;
  discoveredAt: string;
  updatedAt: string;
  lastUsedAt?: string | undefined;
}

export interface WorkspacesFile {
  version: 3;
  workspaces: WorkspaceRegistryEntry[];
}

export interface WorkspaceRuntimeContext {
  workspaceId: string;
  workspaceRoot: string;
  launchCwd?: string | undefined;
  appRoot: string;
  packageManager?: string | undefined;
  commands: WorkspaceCommandContract;
  label?: string | undefined;
  managedWorktreeIsolation?: "scoped" | "session" | undefined;
}

export interface ResolvedWorkspace {
  rootPath: string;
  manifest: WorkspaceManifest;
  registryEntry: WorkspaceRegistryEntry;
  runtimeContext: WorkspaceRuntimeContext;
}

export interface DelegationPolicyConfig {
  allowAgentSpawn?: boolean | undefined;
  maxConcurrentChildSessions?: number | undefined;
  maxDepth?: number | undefined;
}

export interface DelegationTaskMeta {
  taskId: string;
  parentSessionId?: string | undefined;
  parentRunId?: string | undefined;
  title: string;
  status: DelegationTaskStatus;
  childSessionId?: string | undefined;
  childSessionName?: string | undefined;
  profileId: string;
  provider: ModelProviderId;
  model: string;
  skillPackId?: string | undefined;
  waitEventType?: string | undefined;
  result?: SubAgentResultEnvelope | undefined;
  resultSummary?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  references?: string[] | undefined;
  launchedBy?: "operator" | "agent" | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ToolQueueProfileConfig {
  perRunConcurrency?: number | undefined;
  globalConcurrency?: number | undefined;
  maxQueuedJobsPerRun?: number | undefined;
  checkpointSize?: number | undefined;
  retryCount?: number | undefined;
}

export interface TuiProfile {
  id: string;
  label: string;
  agent: SupportedAgent;
  sessionPrefix: string;
  agentProfileId?: string | undefined;
  agentProfileLabel?: string | undefined;
  shellKind?: ShellKind | undefined;
  presetId?: ShellPresetId | undefined;
  capabilityPacks?: CapabilityPackId[] | undefined;
  environmentShellKind?: ShellKind | undefined;
  environmentPresetId?: ShellPresetId | undefined;
  environmentCapabilityPackIds?: CapabilityPackId[] | undefined;
  modelProvider?: ModelProviderId | undefined;
  model?: string | undefined;
  modelCapabilities?:
    | {
        visionInputEnabled?: boolean | undefined;
      }
    | undefined;
  agentStageConfig?: AgentStageConfig | undefined;
  modelTimeoutMs?: number | undefined;
  storeDriver?: StoreDriverId | undefined;
  approvalPolicyPackId?: ApprovalPolicyPackId | undefined;
  modeSystemV2Enabled?: boolean | undefined;
  defaultInteractionMode?: InteractionMode | undefined;
  defaultActSubmode?: ActSubmode | undefined;
  act?:
    | {
        extractorModel?: string | undefined;
        extractorTimeoutMs?: number | undefined;
        extractorFallbackToMainModel?: boolean | undefined;
      }
    | undefined;
  toolPolicies?:
    | {
        classes?: ToolExecutionClass[] | undefined;
        modePolicies?:
          | {
              chat?: ToolExecutionClass[] | undefined;
              plan?: ToolExecutionClass[] | undefined;
              "act.strict"?: ToolExecutionClass[] | undefined;
              "act.safe"?: ToolExecutionClass[] | undefined;
              "act.full_auto"?: ToolExecutionClass[] | undefined;
            }
          | undefined;
      }
    | undefined;
  guardrails?: Partial<GuardrailConfig> | undefined;
  toolAllowlist?: string[] | undefined;
  mcpServers?: McpServerConfig[] | undefined;
  toolQueue?: ToolQueueProfileConfig | undefined;
  codeMode?: CodeModeProfileConfig | undefined;
  devShell?: DevShellProfileConfig | undefined;
  delegation?: DelegationPolicyConfig | undefined;
  theme?: ThemeOverrides | undefined;
  default?: boolean | undefined;
}

export interface ProfilesFile {
  version: 3;
  profiles: TuiProfile[];
}

export interface TuiSessionMeta {
  name: string;
  sessionId: string;
  profileId: string;
  profileLabel?: string | undefined;
  agentProfileId?: string | undefined;
  agentProfileLabel?: string | undefined;
  environmentShellKind?: RuntimeIdentityMetadata["environmentShellKind"] | undefined;
  environmentPresetId?: RuntimeIdentityMetadata["environmentPresetId"] | undefined;
  environmentCapabilityPackIds?: RuntimeIdentityMetadata["environmentCapabilityPackIds"] | undefined;
  effectiveAssemblyId?: string | undefined;
  effectiveAssemblyLabel?: string | undefined;
  launchPresetId?: "coding" | "investigation" | "review" | "orchestration" | undefined;
  launchTemplateId?: "coding-task" | "investigation-task" | "review-task" | "orchestration-task" | undefined;
  workspaceBinding?: "active" | "detached" | undefined;
  workspaceId?: string | undefined;
  workspaceRoot?: string | undefined;
  workspaceLabel?: string | undefined;
  createdAt: string;
  updatedAt: string;
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  started: boolean;
  lastRunStatus?: NormalizedOutput["status"] | undefined;
  pendingWaitFor?: Exclude<NormalizedOutput["waitFor"], undefined> | undefined;
  lastMessagePreview?: string | undefined;
  launchSummary?: string | undefined;
  hasArtifacts?: boolean | undefined;
  hasSummary?: boolean | undefined;
  activeSkillPackId?: string | undefined;
  pendingManualCompaction?: boolean | undefined;
  autoCompactionEnabled?: boolean | undefined;
  suppressAutoCompactionOnce?: boolean | undefined;
  delegation?: DelegationTaskMeta | undefined;
  operatorState?: OperatorAffordancePayload | undefined;
  focusedThreadId?: string | undefined;
}

export interface SessionsFile {
  version?: 2 | 3 | 4 | 5;
  activeSessionName?: string | undefined;
  sessions: TuiSessionMeta[];
}

export type HistoryRole = "user" | "assistant" | "system";

export interface TuiHistoryRecord {
  source: "runner";
  eventId: string;
  timestamp: string;
  sessionName: string;
  sessionId: string;
  profileId: string;
  role: HistoryRole;
  text: string;
  data?: Record<string, unknown> | undefined;
  run?: {
    runId: string;
    status: NormalizedOutput["status"];
    telemetry: NormalizedOutput["telemetry"];
    errors: NormalizedOutput["errors"];
  };
}

export interface TranscriptLine {
  role: HistoryRole;
  text: string;
  data?: Record<string, unknown> | undefined;
  timestamp: string;
  run?: TuiHistoryRecord["run"] | undefined;
}

export interface AgentRunLogLine {
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR";
  eventName: string;
  runId?: string | undefined;
  stepIndex?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type AppView =
  | "chat"
  | "history"
  | "workspace"
  | "logs"
  | "sessions"
  | "tasks"
  | "mcp"
  | "code"
  | "delegation"
  | "recovery";
export type LayoutProfile = "narrow" | "standard" | "wide";
export type DensityMode = "dense";
export type OverlayLayout = "adaptive";
export type LayoutMode = "minimal";

export interface UiPaneSizes {
  sessions: number;
  chat: number;
  logs: number;
}

export type SplashPreflightCheckState = "pending" | "running" | "ok" | "warn" | "fail" | "skip";

export interface SplashPreflightCheck {
  id: string;
  label: string;
  state: SplashPreflightCheckState;
  detail?: string | undefined;
}

export interface SplashPreflightState {
  phase: "running" | "ready" | "failed";
  summary: string;
  checks: SplashPreflightCheck[];
}

export type UiActiveRegion =
  | "sessions"
  | "chat_list"
  | "composer"
  | "logs"
  | "details"
  | "command_bar";

export type LogLevelFilter = "ALL" | "INFO" | "WARN" | "ERROR";

export interface UiLogFilters {
  level: LogLevelFilter;
  eventQuery: string;
  runIdQuery: string;
  paused: boolean;
  grouped: boolean;
}

export interface ViewScrollState {
  offset: number;
  cursor: number;
  tailLocked: boolean;
}

export interface UiDetailDrawerState {
  open: boolean;
  source: AppView;
  expanded?: boolean | undefined;
}

export interface UiState {
  version?: number | undefined;
  activeView: AppView;
  activeRegion?: UiActiveRegion | undefined;
  layoutMode?: LayoutMode | undefined;
  paneSizes?: UiPaneSizes | undefined;
  themeMode?: ThemeMode | undefined;
  themePreset?: ThemePresetId | undefined;
  splashVisible: boolean;
  densityMode: DensityMode;
  layoutProfile: LayoutProfile;
  overlayLayout: OverlayLayout;
  logFilters: UiLogFilters;
  scroll: {
    chat: ViewScrollState;
    logs: ViewScrollState;
    sessions: ViewScrollState;
  };
  detailDrawer: UiDetailDrawerState;
  activeProgressByRun?: Record<string, ProgressUpdateV1> | undefined;
  latestProgressForSession?: ProgressUpdateV1 | undefined;
  chatUnreadCount?: number | undefined;
  lastSelectedSession?: string | undefined;
  paletteRecentCommands: string[];
  recentModelsByProvider?: Partial<Record<ModelProviderId, string[]>> | undefined;
}

export interface UiStateFile {
  version: 1 | 2 | 3 | 4 | 5;
  state: UiState;
}

export type ParsedInput =
  | {
      kind: "command";
      command:
        | "help"
        | "profiles"
        | "model"
        | "theme"
        | "mode"
        | "start"
        | "new"
        | "sessions"
        | "workspace"
        | "tasks"
        | "switch"
        | "resume"
        | "status"
        | "mcp"
        | "code"
        | "skill"
        | "compact"
        | "snapshot"
        | "restore"
        | "approve"
        | "deny"
        | "reject"
        | "reply"
        | "retry"
        | "steer"
        | "queue"
        | "stop"
        | "focus"
        | "checkpoint"
        | "assembly"
        | "child"
        | "fanin"
        | "operator"
        | "quit";
      args: string[];
    }
  | {
      kind: "message";
      message: string;
    };

export interface AppRenderState {
  appName: string;
  activeProfile: TuiProfile;
  activeSession: TuiSessionMeta;
  transcript: TranscriptLine[];
  runLogs: AgentRunLogLine[];
  statusLine: string;
}
