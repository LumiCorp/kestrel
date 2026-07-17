import {
  type ActSubmode,
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  formatUserFacingModeLabel,
  type InteractionMode,
  normalizeInteractionMode,
} from "./mode/contracts.js";
import type { CodeModeProfileConfig } from "./code/contracts.js";
import type { McpStatusSnapshot } from "./mcp/contracts.js";
import type {
  CapabilityPackId,
  ShellKind,
  ShellPresetId,
} from "./profile/runtimeProfile.js";
import { createRuntimeFailure } from "./runtime/RuntimeFailure.js";
import {
  normalizeThreadWorkspaceBinding,
  type ThreadWorkspaceBinding,
} from "./workspace/threadWorkspaceBinding.js";
import type { WorkspaceCheckpointRecord } from "./workspaceCheckpoints/contracts.js";

export type OperatorLifecycleState = "waiting" | "failed" | "running" | "completed" | "ready";
export type OperatorRecommendedAction =
  | "resume_waiting"
  | "recover_failed"
  | "continue_active"
  | "review_completed"
  | "resume_recent";

export interface OperatorRuntimeIdentity {
  agentProfileId?: string | undefined;
  agentProfileLabel?: string | undefined;
  environmentShellKind?: ShellKind | undefined;
  environmentPresetId?: ShellPresetId | undefined;
  environmentCapabilityPackIds?: CapabilityPackId[] | undefined;
  effectiveAssemblyId?: string | undefined;
  effectiveAssemblyLabel?: string | undefined;
}

export interface OperatorSessionSurface extends OperatorRuntimeIdentity {
  id: string;
  title: string;
  updatedAt: string;
  interactionMode?: string | undefined;
  actSubmode?: string | undefined;
  pendingWaitEventType?: string | undefined;
  lastRunStatus?: string | undefined;
  lastPreview?: string | undefined;
  isActive?: boolean | undefined;
}

export interface OperatorSessionJourney {
  id: string;
  title: string;
  updatedAt: string;
  modeLabel: string;
  lifecycle: OperatorLifecycleState;
  recommendedAction: OperatorRecommendedAction;
  recommendedLabel: string;
  detail: string;
  lastPreview?: string | undefined;
  isActive: boolean;
}

export interface OperatorHistoryHomeSurface extends OperatorSessionSurface {
  profileLabel?: string | undefined;
  workspaceLabel?: string | undefined;
  launchSummary?: string | undefined;
  hasArtifacts?: boolean | undefined;
  hasSummary?: boolean | undefined;
  restartAvailable?: boolean | undefined;
}

export interface OperatorHistoryHomeEntry extends OperatorSessionJourney, OperatorRuntimeIdentity {
  profileLabel?: string | undefined;
  workspaceLabel?: string | undefined;
  launchSummary?: string | undefined;
  latestPreview?: string | undefined;
  hasArtifacts: boolean;
  hasSummary: boolean;
  restartAvailable: boolean;
}

export interface OperatorStatusSnapshot {
  headline: string;
  subline: string;
  lifecycle: OperatorLifecycleState;
  recommendedAction: OperatorRecommendedAction;
  recommendedLabel: string;
  modeLabel: string;
}

export interface OperatorWorkspaceAction {
  id: string;
  label: string;
  command?: string | undefined;
  draft?: string | undefined;
}

export type OperatorJourneyDestination =
  | "history"
  | "workspace"
  | "mcp"
  | "code"
  | "delegation"
  | "recovery"
  | "chat"
  | "start";

export interface OperatorNextAction {
  id: string;
  label: string;
  reason: string;
  targetDestination?: OperatorJourneyDestination | undefined;
  command?: string | undefined;
  draft?: string | undefined;
}

export interface OperatorNextActionsSnapshot {
  destination: OperatorJourneyDestination;
  orderedActions: OperatorNextAction[];
  rationaleSummary: string;
}

export function formatOperatorJourneyDestinationLabel(destination: OperatorJourneyDestination): string {
  if (destination === "history") {
    return "History";
  }
  if (destination === "workspace") {
    return "Workspace";
  }
  if (destination === "mcp") {
    return "MCP Workspace";
  }
  if (destination === "code") {
    return "Code Workspace";
  }
  if (destination === "delegation") {
    return "Delegation Review";
  }
  if (destination === "recovery") {
    return "Recovery Center";
  }
  if (destination === "start") {
    return "Start Task";
  }
  return "Chat";
}

export function buildOperatorBackActionLabel(
  previousDestination: OperatorJourneyDestination | undefined,
): string {
  if (previousDestination === undefined) {
    return "Back to Chat";
  }
  return `Back to ${formatOperatorJourneyDestinationLabel(previousDestination)}`;
}

function buildBackWorkspaceAction(label?: string): OperatorWorkspaceAction {
  return {
    id: "nav.back",
    label: label ?? "Back",
  };
}

export interface OperatorProfilePresetSummary {
  id: "coding" | "investigation" | "review" | "orchestration";
  label: string;
  description: string;
  interactionMode: InteractionMode;
  actSubmode?: ActSubmode | undefined;
  codePosture: "enabled" | "disabled";
  approvalPosture: "auto" | "manual" | "profile";
}

export interface OperatorTaskTemplateSummary {
  id: "coding-task" | "investigation-task" | "review-task" | "orchestration-task";
  label: string;
  description: string;
  presetId: OperatorProfilePresetSummary["id"];
  defaultTitle: string;
  interactionMode: InteractionMode;
  actSubmode?: ActSubmode | undefined;
  promptSeed?: string | undefined;
  followUpSurface: "history" | "delegation" | "recovery" | "chat";
}

export interface OperatorRecentLaunchShortcut extends OperatorRuntimeIdentity {
  id: string;
  title: string;
  profileLabel: string;
  workspaceLabel: string;
  modeLabel: string;
  launchSummary: string;
  recommendedLabel: string;
  presetId?: OperatorProfilePresetSummary["id"] | undefined;
  templateId?: OperatorTaskTemplateSummary["id"] | undefined;
}

export interface OperatorLaunchSetupSnapshot {
  presets: OperatorProfilePresetSummary[];
  templates: OperatorTaskTemplateSummary[];
  recentLaunches: OperatorRecentLaunchShortcut[];
  workspaceOptions: Array<{
    binding: OperatorWorkspaceBindingIntent;
    label: string;
    workspaceId?: string | undefined;
    workspaceRoot?: string | undefined;
  }>;
  selectedPresetId?: OperatorProfilePresetSummary["id"] | undefined;
  selectedTemplateId?: OperatorTaskTemplateSummary["id"] | undefined;
  policySummary: string;
  approvalPosture: string;
  codePosture: string;
  executionBoundarySummary: string;
  bootstrapHint?: string | undefined;
}

export interface OperatorWorkspaceSnapshot {
  title: string;
  headline: string;
  subline: string;
  lifecycle: OperatorLifecycleState;
  recommendedAction: OperatorRecommendedAction;
  recommendedLabel: string;
  modeLabel: string;
  profileLabel: string;
  workspaceLabel?: string | undefined;
  sessionTitle: string;
  statusChips: string[];
  issueFlags: string[];
  primaryActions: OperatorWorkspaceAction[];
  secondaryActions: OperatorWorkspaceAction[];
  nextActions?: OperatorNextActionsSnapshot | undefined;
}

export interface OperatorBootstrapSnapshot {
  workspaceDetection: "detected" | "missing";
  profilePresetReadiness: "ready" | "missing";
  runnerPreflightStatus: "ready" | "running" | "degraded";
  recommendedInitialDestination: "start" | "history" | "chat";
  summary: string;
}

export interface OperatorWorkspaceJourneyEntry {
  workspaceId?: string | undefined;
  label: string;
  rootPath?: string | undefined;
  isCurrentBinding: boolean;
  isLaunchWorkspace: boolean;
}

export interface OperatorWorkspaceJourneySnapshot extends OperatorWorkspaceSnapshot {
  currentWorkspaceLabel: string;
  launchWorkspaceLabel: string;
  mismatchSummary?: string | undefined;
  discoveredWorkspaces: OperatorWorkspaceJourneyEntry[];
  recentLaunches: OperatorRecentLaunchShortcut[];
}

export interface OperatorMcpWorkspaceServerEntry {
  id: string;
  transport: string;
  enabled: boolean;
  healthy: boolean;
  connected: boolean;
  toolCount: number;
  checkedAt: string;
  error?: string | undefined;
}

export interface OperatorMcpWorkspaceToolEntry {
  id: string;
  serverId: string;
  allowlisted: boolean;
}

export interface OperatorMcpWorkspaceSnapshot extends OperatorWorkspaceSnapshot {
  healthLabel: string;
  servers: OperatorMcpWorkspaceServerEntry[];
  tools: OperatorMcpWorkspaceToolEntry[];
  checkedAt?: string | undefined;
}

export interface OperatorCodeWorkspaceSnapshot extends OperatorWorkspaceSnapshot {
  enabled: boolean;
  approvalMode: string;
  sandboxSummary: string;
  retentionSummary: string;
  languages: string[];
  latestHint?: string | undefined;
}

export interface OperatorDelegationChildEntry {
  threadId: string;
  title: string;
  status: string;
  waitEventType?: string | undefined;
  reason?: string | undefined;
  result?: import("./kestrel/contracts/orchestration.js").SubAgentResultEnvelope | undefined;
  resultStatus?: import("./kestrel/contracts/orchestration.js").SubAgentResultEnvelope["status"] | undefined;
  errorCode?: string | undefined;
  error?: string | undefined;
  references?: string[] | undefined;
}

export interface OperatorDelegationOutcomeEntry {
  threadId: string;
  title: string;
  status: string;
  waitEventType?: string | undefined;
  readiness?: "ready" | "waiting" | "blocked" | "unknown";
  recommendedAction?: string;
  latestPreview?: string | undefined;
  hasSummary?: boolean | undefined;
  hasArtifacts?: boolean | undefined;
  result?: import("./kestrel/contracts/orchestration.js").SubAgentResultEnvelope | undefined;
  resultStatus?: import("./kestrel/contracts/orchestration.js").SubAgentResultEnvelope["status"] | undefined;
  summary?: string | undefined;
  errorCode?: string | undefined;
  error?: string | undefined;
  references?: string[] | undefined;
}

export interface OperatorChildMissionDraft {
  title: string;
  scope: string;
  profileLabel: string;
  modeLabel: string;
  returnCondition: string;
}

export interface OperatorDelegationWorkspaceSnapshot extends OperatorWorkspaceSnapshot {
  nextActionSummary?: string | undefined;
  nextValidActionSummary?: string | undefined;
  activeBlocker?: string | undefined;
  fanInSummary?: string | undefined;
  missionDraft?: OperatorChildMissionDraft | undefined;
  childThreads: OperatorDelegationChildEntry[];
  childOutcomes: OperatorDelegationOutcomeEntry[];
}

export interface OperatorDelegationWorkspaceInput {
  childThreads?: OperatorDelegationChildEntry[] | undefined;
  childOutcomes?: OperatorDelegationOutcomeEntry[] | undefined;
  nextActionKind?: string | undefined;
  nextActionSummary?: string | undefined;
  blockerSummary?: string | undefined;
  childBlockerReason?: string | undefined;
  fanInDisposition?: {
    status: string;
    checkpointId?: string | undefined;
    summary?: string | undefined;
  } | undefined;
  inboxChildBlockers?: number | undefined;
  missionDraft?: {
    title?: string | undefined;
    scope?: string | undefined;
    returnCondition?: string | undefined;
    profileLabel?: string | undefined;
    interactionMode?: InteractionMode | undefined;
    actSubmode?: ActSubmode | undefined;
  } | undefined;
}

export interface OperatorRecoveryTimelineEntry {
  id: string;
  kind: "context_checkpoint" | "fan_in" | "workspace_checkpoint";
  origin: "runtime" | "fan_in" | "workspace";
  disposition: string;
  label: string;
  status: string;
  detail: string;
  actionConsequence: string;
  actionHint?: string | undefined;
  createdAt?: string | undefined;
}

export interface OperatorWorkspaceRestorePreview {
  checkpointId: string;
  label: string;
  workspaceLabel?: string | undefined;
  workspaceRoot?: string | undefined;
  summary: string;
  consequence: string;
}

export interface OperatorIncidentRecoverySnapshot {
  summary: string;
  cause: string;
  recommendedAction: string;
  nextValidAction: string;
  latestEvidence?: string | undefined;
  restartAvailable: boolean;
}

export interface OperatorPostRunSummarySnapshot {
  outcome: string;
  blockers: string[];
  childOutcomes: string[];
  summaryState: "ready" | "missing";
  artifactState: "ready" | "missing";
  approvalsUsed: string[];
  recommendedAction: string;
}

export interface OperatorNotebookEntry {
  id: string;
  kind: "launch" | "checkpoint" | "child" | "summary" | "artifact" | "setup";
  label: string;
  detail: string;
}

export interface OperatorRecoveryCenterSnapshot extends OperatorWorkspaceSnapshot {
  incidentLabel: string;
  latestEvidence?: string | undefined;
  workspaceRoot?: string | undefined;
  timeline: OperatorRecoveryTimelineEntry[];
  restorePreview?: OperatorWorkspaceRestorePreview | undefined;
  incident: OperatorIncidentRecoverySnapshot;
  postRunSummary: OperatorPostRunSummarySnapshot;
  notebook: OperatorNotebookEntry[];
}

export interface OperatorRecoveryCenterInput {
  latestCheckpoint?:
    | {
        checkpointId: string;
        status: string;
        recommendedAction: string;
        reason: string;
      }
    | undefined;
  fanInDisposition?:
    | {
        status: string;
        checkpointId?: string | undefined;
        summary?: string | undefined;
        at?: string | undefined;
      }
    | undefined;
  blockerSummary?: string | undefined;
  activeWaitDetail?: string | undefined;
  contextPosture?: string | undefined;
  latestReasoningMessage?: string | undefined;
  latestSteeringMessage?: string | undefined;
  latestEvidenceIssues?: string[] | undefined;
  latestEvidenceTerminalOutcome?: string | undefined;
  latestPreview?: string | undefined;
  childOutcomes?: string[] | undefined;
  approvalsUsed?: string[] | undefined;
  launchSummary?: string | undefined;
  setupSummary?: string | undefined;
}

export type OperatorLaunchKind = "empty" | "prompt_seeded" | "resume_like";
export type OperatorWorkspaceBindingIntent = "active" | "detached";

export interface OperatorStartTaskWorkspace extends ThreadWorkspaceBinding {
  binding: OperatorWorkspaceBindingIntent;
  label: string;
}

export interface OperatorStartTaskInput extends OperatorRuntimeIdentity {
  title: string;
  presetId?: OperatorProfilePresetSummary["id"] | undefined;
  templateId?: OperatorTaskTemplateSummary["id"] | undefined;
  profileId?: string | undefined;
  profileLabel?: string | undefined;
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  initialPrompt?: string | undefined;
  launchKind?: OperatorLaunchKind | undefined;
  workspaceBinding?: OperatorWorkspaceBindingIntent | undefined;
  workspaceId?: string | undefined;
  workspaceLabel?: string | undefined;
  workspaceRoot?: string | undefined;
}

export interface ResolveOperatorStartTaskOptions extends OperatorStartTaskInput {
  defaultProfileId: string;
  defaultProfileLabel?: string | undefined;
  defaultInteractionMode?: InteractionMode | undefined;
  defaultActSubmode?: ActSubmode | undefined;
  requireTitle?: boolean | undefined;
}

export interface OperatorResolvedStartTask extends OperatorRuntimeIdentity {
  title: string;
  presetId?: OperatorProfilePresetSummary["id"] | undefined;
  templateId?: OperatorTaskTemplateSummary["id"] | undefined;
  profileId: string;
  profileLabel: string;
  interactionMode: InteractionMode;
  actSubmode?: ActSubmode | undefined;
  initialPrompt?: string | undefined;
  launchKind: OperatorLaunchKind;
  workspace: OperatorStartTaskWorkspace;
}

export function formatOperatorMode(
  interactionMode: string | undefined,
  actSubmode: string | undefined,
): string {
  // Legacy display normalization only; operator launches emit "build".
  if (interactionMode === "act" || interactionMode === "work") {
    return "Build";
  }
  return formatUserFacingModeLabel({
    interactionMode: interactionMode ?? DEFAULT_INTERACTION_MODE,
    actSubmode: actSubmode ?? DEFAULT_ACT_SUBMODE,
  });
}

export function deriveOperatorLifecycle(session: OperatorSessionSurface): OperatorLifecycleState {
  if (session.pendingWaitEventType !== undefined || session.lastRunStatus === "WAITING") {
    return "waiting";
  }
  if (session.lastRunStatus === "FAILED") {
    return "failed";
  }
  if (session.lastRunStatus === "RUNNING") {
    return "running";
  }
  if (session.lastRunStatus === "COMPLETED") {
    return "completed";
  }
  return "ready";
}

export function deriveOperatorJourney(session: OperatorSessionSurface): OperatorSessionJourney {
  const lifecycle = deriveOperatorLifecycle(session);
  const modeLabel = formatOperatorMode(session.interactionMode, session.actSubmode);

  if (lifecycle === "waiting") {
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      modeLabel,
      lifecycle,
      recommendedAction: "resume_waiting",
      recommendedLabel: "Resume waiting session",
      detail: session.pendingWaitEventType !== undefined
        ? `Waiting for ${session.pendingWaitEventType}`
        : "Waiting for operator input",
      ...(session.lastPreview !== undefined ? { lastPreview: session.lastPreview } : {}),
      isActive: Boolean(session.isActive),
    };
  }

  if (lifecycle === "failed") {
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      modeLabel,
      lifecycle,
      recommendedAction: "recover_failed",
      recommendedLabel: "Recover failed session",
      detail: "Inspect the last failure and choose the next recovery action",
      ...(session.lastPreview !== undefined ? { lastPreview: session.lastPreview } : {}),
      isActive: Boolean(session.isActive),
    };
  }

  if (lifecycle === "running" || session.isActive === true) {
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      modeLabel,
      lifecycle,
      recommendedAction: "continue_active",
      recommendedLabel: "Continue active work",
      detail: lifecycle === "running" ? "Run is currently in progress" : "Open the active operator surface",
      ...(session.lastPreview !== undefined ? { lastPreview: session.lastPreview } : {}),
      isActive: Boolean(session.isActive),
    };
  }

  if (lifecycle === "completed") {
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      modeLabel,
      lifecycle,
      recommendedAction: "review_completed",
      recommendedLabel: "Review completed session",
      detail: "Inspect the latest summary, artifacts, and next steps",
      ...(session.lastPreview !== undefined ? { lastPreview: session.lastPreview } : {}),
      isActive: Boolean(session.isActive),
    };
  }

  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    modeLabel,
    lifecycle,
    recommendedAction: "resume_recent",
    recommendedLabel: "Resume recent session",
    detail: "Reopen the recent task context and continue from the latest state",
    ...(session.lastPreview !== undefined ? { lastPreview: session.lastPreview } : {}),
    isActive: Boolean(session.isActive),
  };
}

const OPERATOR_PROFILE_PRESETS: OperatorProfilePresetSummary[] = [
  {
    id: "coding",
    label: "Coding",
    description:
      "Bias toward workspace inspection, implementation, validation, and host-shell workflows when permitted.",
    interactionMode: "build",
    actSubmode: "safe",
    codePosture: "enabled",
    approvalPosture: "auto",
  },
  {
    id: "investigation",
    label: "Investigation",
    description: "Bias toward evidence gathering and planning before execution.",
    interactionMode: "plan",
    codePosture: "enabled",
    approvalPosture: "profile",
  },
  {
    id: "review",
    label: "Review",
    description: "Bias toward reading, inspection, and summary-first review work.",
    interactionMode: "plan",
    codePosture: "disabled",
    approvalPosture: "profile",
  },
  {
    id: "orchestration",
    label: "Orchestration",
    description: "Bias toward supervision, child work, and fan-in review.",
    interactionMode: "plan",
    codePosture: "enabled",
    approvalPosture: "manual",
  },
];

const OPERATOR_TASK_TEMPLATES: OperatorTaskTemplateSummary[] = [
  {
    id: "coding-task",
    label: "Coding Task",
    description: "Inspect, implement, validate, and report a concrete repository change.",
    presetId: "coding",
    defaultTitle: "Implement requested change",
    interactionMode: "build",
    actSubmode: "safe",
    promptSeed:
      "Inspect the workspace, implement the requested change, run relevant validation, and summarize outcome plus residual risk. Use host-shell workflows when permitted.",
    followUpSurface: "chat",
  },
  {
    id: "investigation-task",
    label: "Investigation Task",
    description: "Investigate a problem, gather evidence, and recommend a next step.",
    presetId: "investigation",
    defaultTitle: "Investigate current issue",
    interactionMode: "plan",
    promptSeed: "Investigate the issue, gather explicit evidence, and recommend the next action.",
    followUpSurface: "history",
  },
  {
    id: "review-task",
    label: "Review Task",
    description: "Review recent work, identify issues, and summarize risks.",
    presetId: "review",
    defaultTitle: "Review recent work",
    interactionMode: "plan",
    promptSeed: "Review the recent work, identify concrete findings, and summarize residual risks.",
    followUpSurface: "history",
  },
  {
    id: "orchestration-task",
    label: "Orchestration Task",
    description: "Coordinate child work and keep the fan-in path explicit.",
    presetId: "orchestration",
    defaultTitle: "Coordinate delegated work",
    interactionMode: "plan",
    promptSeed: "Break the work into child missions, supervise progress, and prepare a fan-in decision.",
    followUpSurface: "delegation",
  },
];

export function listOperatorProfilePresets(): OperatorProfilePresetSummary[] {
  return OPERATOR_PROFILE_PRESETS.map((preset) => ({ ...preset }));
}

export function listOperatorTaskTemplates(): OperatorTaskTemplateSummary[] {
  return OPERATOR_TASK_TEMPLATES.map((template) => ({ ...template }));
}

export function getOperatorProfilePreset(
  presetId: OperatorProfilePresetSummary["id"] | undefined,
): OperatorProfilePresetSummary | undefined {
  return presetId === undefined
    ? undefined
    : OPERATOR_PROFILE_PRESETS.find((preset) => preset.id === presetId);
}

export function getOperatorTaskTemplate(
  templateId: OperatorTaskTemplateSummary["id"] | undefined,
): OperatorTaskTemplateSummary | undefined {
  return templateId === undefined
    ? undefined
    : OPERATOR_TASK_TEMPLATES.find((template) => template.id === templateId);
}

export function buildOperatorLaunchSetup(input: {
  profileLabel: string;
  workspaceLabel?: string | undefined;
  workspaceRoot?: string | undefined;
  selectedPresetId?: OperatorProfilePresetSummary["id"] | undefined;
  selectedTemplateId?: OperatorTaskTemplateSummary["id"] | undefined;
  recentSessions?: Array<{
    id: string;
    title: string;
    profileLabel: string;
    agentProfileId?: string | undefined;
    agentProfileLabel?: string | undefined;
    environmentShellKind?: ShellKind | undefined;
    environmentPresetId?: ShellPresetId | undefined;
    environmentCapabilityPackIds?: CapabilityPackId[] | undefined;
    effectiveAssemblyId?: string | undefined;
    effectiveAssemblyLabel?: string | undefined;
    workspaceLabel: string;
    interactionMode?: string | undefined;
    actSubmode?: string | undefined;
    launchSummary: string;
    recommendedLabel: string;
    presetId?: OperatorProfilePresetSummary["id"] | undefined;
    templateId?: OperatorTaskTemplateSummary["id"] | undefined;
  }> | undefined;
}): OperatorLaunchSetupSnapshot {
  const workspaceOptions = [
    {
      binding: "active" as const,
      label: input.workspaceLabel ?? "Current workspace",
      ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    },
    {
      binding: "detached" as const,
      label: "Detached workspace",
    },
  ];

  const activePreset = getOperatorProfilePreset(input.selectedPresetId);
  const codePosture = activePreset?.codePosture ?? "profile default";
  const approvalPosture = activePreset?.approvalPosture ?? "profile default";
  const bootstrap = buildOperatorBootstrapSnapshot({
    hasWorkspace: input.workspaceRoot !== undefined,
    profileLabel: input.profileLabel,
    presetCount: OPERATOR_PROFILE_PRESETS.length,
    runnerPreflightStatus: "ready",
    hasPriorSessionContext: (input.recentSessions?.length ?? 0) > 0,
    hasWaitingOrFailed: (input.recentSessions ?? []).some((session) => {
      const status = session.recommendedLabel.toLowerCase();
      return status.includes("waiting") || status.includes("failed");
    }),
  });

  return {
    presets: listOperatorProfilePresets(),
    templates: listOperatorTaskTemplates(),
    recentLaunches: (input.recentSessions ?? []).map((session) => ({
      id: session.id,
      title: session.title,
      profileLabel: session.profileLabel,
      ...(session.agentProfileId !== undefined ? { agentProfileId: session.agentProfileId } : {}),
      ...(session.agentProfileLabel !== undefined ? { agentProfileLabel: session.agentProfileLabel } : {}),
      ...(session.environmentShellKind !== undefined ? { environmentShellKind: session.environmentShellKind } : {}),
      ...(session.environmentPresetId !== undefined ? { environmentPresetId: session.environmentPresetId } : {}),
      ...(session.environmentCapabilityPackIds !== undefined
        ? { environmentCapabilityPackIds: [...session.environmentCapabilityPackIds] }
        : {}),
      ...(session.effectiveAssemblyId !== undefined ? { effectiveAssemblyId: session.effectiveAssemblyId } : {}),
      ...(session.effectiveAssemblyLabel !== undefined ? { effectiveAssemblyLabel: session.effectiveAssemblyLabel } : {}),
      workspaceLabel: session.workspaceLabel,
      modeLabel: formatOperatorMode(session.interactionMode, session.actSubmode),
      launchSummary: session.launchSummary,
      recommendedLabel: session.recommendedLabel,
      ...(session.presetId !== undefined ? { presetId: session.presetId } : {}),
      ...(session.templateId !== undefined ? { templateId: session.templateId } : {}),
    })),
    workspaceOptions,
    ...(input.selectedPresetId !== undefined ? { selectedPresetId: input.selectedPresetId } : {}),
    ...(input.selectedTemplateId !== undefined ? { selectedTemplateId: input.selectedTemplateId } : {}),
    policySummary: `${input.profileLabel} · ${input.workspaceLabel ?? "Detached workspace"}`,
    approvalPosture,
    codePosture,
    executionBoundarySummary: `mode/profile boundaries stay profile-driven (${input.profileLabel})`,
    bootstrapHint: bootstrap.summary,
  };
}

export function buildOperatorWorkspaceJourney(input: {
  sessionTitle: string;
  profileLabel: string;
  workspaceLabel?: string | undefined;
  launchWorkspaceLabel?: string | undefined;
  interactionMode?: string | undefined;
  actSubmode?: string | undefined;
  pendingWaitEventType?: string | undefined;
  lastRunStatus?: string | undefined;
  isActive?: boolean | undefined;
  discoveredWorkspaces?: OperatorWorkspaceJourneyEntry[] | undefined;
  recentSessions?: Array<{
    id: string;
    title: string;
    profileLabel: string;
    agentProfileId?: string | undefined;
    agentProfileLabel?: string | undefined;
    environmentShellKind?: ShellKind | undefined;
    environmentPresetId?: ShellPresetId | undefined;
    environmentCapabilityPackIds?: CapabilityPackId[] | undefined;
    effectiveAssemblyId?: string | undefined;
    effectiveAssemblyLabel?: string | undefined;
    workspaceLabel: string;
    interactionMode?: string | undefined;
    actSubmode?: string | undefined;
    launchSummary: string;
    recommendedLabel: string;
    presetId?: OperatorProfilePresetSummary["id"] | undefined;
    templateId?: OperatorTaskTemplateSummary["id"] | undefined;
  }> | undefined;
}): OperatorWorkspaceJourneySnapshot {
  const base = buildOperatorStatusSnapshot({
    title: input.sessionTitle,
    profileLabel: input.profileLabel,
    workspaceLabel: input.workspaceLabel,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    pendingWaitEventType: input.pendingWaitEventType,
    lastRunStatus: input.lastRunStatus,
    isActive: input.isActive,
  });
  const currentWorkspaceLabel = input.workspaceLabel ?? "Detached workspace";
  const launchWorkspaceLabel = input.launchWorkspaceLabel ?? "Detached workspace";
  const mismatchSummary =
    currentWorkspaceLabel !== launchWorkspaceLabel
      ? `Launch workspace ${launchWorkspaceLabel} differs from session workspace ${currentWorkspaceLabel}.`
      : undefined;
  const discoveredWorkspaces = input.discoveredWorkspaces ?? [];
  const issueFlags = [
    mismatchSummary,
    discoveredWorkspaces.length === 0 ? "No discovered workspaces recorded" : undefined,
  ].filter((value): value is string => value !== undefined);
  const recentLaunches = buildOperatorLaunchSetup({
    profileLabel: input.profileLabel,
    workspaceLabel: input.workspaceLabel,
    recentSessions: input.recentSessions,
  }).recentLaunches;

  return {
    title: "Workspace",
    headline:
      mismatchSummary !== undefined
        ? "Workspace mismatch needs attention"
        : currentWorkspaceLabel === "Detached workspace"
          ? "Workspace is detached"
          : "Workspace journey is ready",
    subline: [
      input.profileLabel,
      `session ${currentWorkspaceLabel}`,
      `launch ${launchWorkspaceLabel}`,
    ].filter((value): value is string => value.length > 0).join(" · "),
    lifecycle: base.lifecycle,
    recommendedAction: base.recommendedAction,
    recommendedLabel:
      mismatchSummary !== undefined
        ? "Inspect workspace mismatch"
        : currentWorkspaceLabel === "Detached workspace"
          ? "Bind a workspace"
          : "Review workspace actions",
    modeLabel: base.modeLabel,
    profileLabel: input.profileLabel,
    ...(input.workspaceLabel !== undefined ? { workspaceLabel: input.workspaceLabel } : {}),
    sessionTitle: input.sessionTitle,
    statusChips: [
      currentWorkspaceLabel,
      `${discoveredWorkspaces.length} discovered`,
      `${recentLaunches.length} recent`,
    ],
    issueFlags,
    primaryActions: [
      { id: "workspace.start", label: "Start task in selected workspace", command: "/start" },
      { id: "workspace.detach", label: "Switch to detached", command: "/workspace use detached" },
      { id: "view.history", label: "Open History Home" },
    ],
    secondaryActions: [
      buildBackWorkspaceAction(),
      { id: "workspace.status", label: "Inspect workspace status", command: "/workspace status" },
      { id: "workspace.list", label: "List discovered workspaces", command: "/workspace list" },
      ...discoveredWorkspaces.map((workspace) => ({
        id: `workspace.use.${workspace.workspaceId ?? workspace.rootPath ?? workspace.label}`,
        label: `Use workspace: ${workspace.label}`,
        ...(workspace.workspaceId !== undefined
          ? { command: `/workspace use ${workspace.workspaceId}` }
          : workspace.rootPath !== undefined
            ? { command: `/workspace use ${workspace.rootPath}` }
            : {}),
      })),
      ...recentLaunches.map((session) => ({
        id: `workspace.resume.${session.id}`,
        label: `Open recent session: ${session.title}`,
        command: `/switch ${session.title}`,
      })),
    ],
    nextActions: buildOperatorNextActionsSnapshot({
      destination: "workspace",
      recommendedLabel:
        mismatchSummary !== undefined
          ? "Resolve workspace mismatch before continuing task work."
          : "Use the workspace journey to launch or resume with explicit bindings.",
      issueFlags,
      actions: [
        { id: "workspace.status", label: "Inspect workspace status", command: "/workspace status" },
        { id: "workspace.start", label: "Start task in selected workspace", command: "/start" },
        { id: "workspace.detach", label: "Switch to detached", command: "/workspace use detached" },
      ],
      preferredActionIds:
        mismatchSummary !== undefined
          ? ["workspace.status", "workspace.start"]
          : ["workspace.start", "view.history"],
    }),
    currentWorkspaceLabel,
    launchWorkspaceLabel,
    ...(mismatchSummary !== undefined ? { mismatchSummary } : {}),
    discoveredWorkspaces,
    recentLaunches,
  };
}

export function buildChildMissionPrompt(input: {
  title: string;
  scope: string;
  returnCondition: string;
  profileLabel: string;
  interactionMode: InteractionMode;
  actSubmode?: ActSubmode | undefined;
}): string {
  return [
    `Mission: ${input.title.trim()}`,
    `Scope: ${input.scope.trim()}`,
    `Return condition: ${input.returnCondition.trim()}`,
    `Profile: ${input.profileLabel}`,
    `Mode: ${formatOperatorMode(input.interactionMode, input.actSubmode)}`,
  ].join("\n");
}

export function resolveOperatorStartTask(
  options: ResolveOperatorStartTaskOptions,
): OperatorResolvedStartTask {
  const title = options.title.trim();
  if (options.requireTitle === true && title.length === 0) {
    throw createRuntimeFailure("START_TASK_TITLE_REQUIRED", "Task title is required.");
  }

  const prompt = options.initialPrompt?.trim();
  const profileId = options.profileId?.trim() || options.defaultProfileId;
  const profileLabel = options.profileLabel?.trim() || options.defaultProfileLabel?.trim() || profileId;
  const agentProfileId = options.agentProfileId?.trim() || profileId;
  const agentProfileLabel = options.agentProfileLabel?.trim() || profileLabel;
  const resolvedMode = normalizeInteractionMode({
    interactionMode: options.interactionMode,
    actSubmode: options.actSubmode,
    defaultInteractionMode: options.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
    defaultActSubmode: options.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
  });
  const workspace = normalizeThreadWorkspaceBinding({
    binding: options.workspaceBinding ?? (options.workspaceId !== undefined ? "active" : "detached"),
    workspaceId: options.workspaceId,
    workspaceRoot: options.workspaceRoot,
    label: options.workspaceLabel,
  });

  return {
    title,
    ...(options.presetId !== undefined ? { presetId: options.presetId } : {}),
    ...(options.templateId !== undefined ? { templateId: options.templateId } : {}),
    profileId,
    profileLabel,
    agentProfileId,
    agentProfileLabel,
    interactionMode: resolvedMode.interactionMode,
    ...(resolvedMode.actSubmode !== undefined ? { actSubmode: resolvedMode.actSubmode } : {}),
    ...(options.environmentShellKind !== undefined ? { environmentShellKind: options.environmentShellKind } : {}),
    ...(options.environmentPresetId !== undefined ? { environmentPresetId: options.environmentPresetId } : {}),
    ...(options.environmentCapabilityPackIds !== undefined
      ? { environmentCapabilityPackIds: [...options.environmentCapabilityPackIds] }
      : {}),
    ...(options.effectiveAssemblyId !== undefined ? { effectiveAssemblyId: options.effectiveAssemblyId } : {}),
    ...(options.effectiveAssemblyLabel !== undefined ? { effectiveAssemblyLabel: options.effectiveAssemblyLabel } : {}),
    ...(prompt !== undefined && prompt.length > 0 ? { initialPrompt: prompt } : {}),
    launchKind: options.launchKind ?? (prompt !== undefined && prompt.length > 0 ? "prompt_seeded" : "empty"),
    workspace: {
      binding: workspace.binding,
      label: workspace.label ?? "Detached workspace",
      ...(workspace.workspaceId !== undefined ? { workspaceId: workspace.workspaceId } : {}),
      ...(workspace.workspaceRoot !== undefined ? { workspaceRoot: workspace.workspaceRoot } : {}),
      ...(workspace.source !== undefined ? { source: workspace.source } : {}),
      ...(workspace.runtimeContext !== undefined ? { runtimeContext: workspace.runtimeContext } : {}),
    },
  };
}

export function formatOperatorLaunchSummary(launch: OperatorResolvedStartTask): string {
  const segments = [
    `Task=${launch.title}`,
    ...(launch.presetId !== undefined
      ? [`Preset=${getOperatorProfilePreset(launch.presetId)?.label ?? launch.presetId}`]
      : []),
    ...(launch.templateId !== undefined
      ? [`Template=${getOperatorTaskTemplate(launch.templateId)?.label ?? launch.templateId}`]
      : []),
    `Profile=${launch.profileLabel}`,
    `Mode=${formatOperatorMode(launch.interactionMode, launch.actSubmode)}`,
    `Workspace=${launch.workspace.label}`,
    `Launch=${launch.launchKind}`,
  ];

  if (launch.initialPrompt !== undefined && launch.initialPrompt.length > 0) {
    segments.push(`Prompt=${launch.initialPrompt}`);
  }

  return segments.join(" · ");
}

export function rankOperatorJourneys(
  sessions: OperatorSessionSurface[],
  limit = sessions.length,
): OperatorSessionJourney[] {
  return sessions
    .map((session) => deriveOperatorJourney(session))
    .sort((left, right) => {
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit);
}

export function pickResumeTarget(sessions: OperatorSessionSurface[]): OperatorSessionJourney | undefined {
  const journeys = rankOperatorJourneys(sessions);
  return (
    journeys.find((session) => session.recommendedAction === "resume_waiting") ??
    journeys.find((session) => session.recommendedAction === "recover_failed") ??
    journeys.find((session) => session.recommendedAction === "continue_active") ??
    journeys.find((session) => session.recommendedAction === "resume_recent") ??
    journeys[0]
  );
}

export function buildOperatorHistoryHome(
  sessions: OperatorHistoryHomeSurface[],
  limit = sessions.length,
): OperatorHistoryHomeEntry[] {
  return sessions
    .map((session) => {
      const journey = deriveOperatorJourney(session);
      return {
        ...journey,
        ...(session.profileLabel !== undefined ? { profileLabel: session.profileLabel } : {}),
        ...(session.agentProfileId !== undefined ? { agentProfileId: session.agentProfileId } : {}),
        ...(session.agentProfileLabel !== undefined ? { agentProfileLabel: session.agentProfileLabel } : {}),
        ...(session.environmentShellKind !== undefined ? { environmentShellKind: session.environmentShellKind } : {}),
        ...(session.environmentPresetId !== undefined ? { environmentPresetId: session.environmentPresetId } : {}),
        ...(session.environmentCapabilityPackIds !== undefined
          ? { environmentCapabilityPackIds: [...session.environmentCapabilityPackIds] }
          : {}),
        ...(session.effectiveAssemblyId !== undefined ? { effectiveAssemblyId: session.effectiveAssemblyId } : {}),
        ...(session.effectiveAssemblyLabel !== undefined ? { effectiveAssemblyLabel: session.effectiveAssemblyLabel } : {}),
        ...(session.workspaceLabel !== undefined ? { workspaceLabel: session.workspaceLabel } : {}),
        ...(session.launchSummary !== undefined ? { launchSummary: session.launchSummary } : {}),
        ...(journey.lastPreview !== undefined ? { latestPreview: journey.lastPreview } : {}),
        hasArtifacts: session.hasArtifacts === true,
        hasSummary: session.hasSummary === true,
        restartAvailable: session.restartAvailable === true,
      };
    })
    .sort((left, right) => {
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }

      const leftPriority = historyPriority(left.recommendedAction);
      const rightPriority = historyPriority(right.recommendedAction);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit);
}

export function buildOperatorHistoryNextActions(
  entries: OperatorHistoryHomeEntry[],
): OperatorNextActionsSnapshot {
  const primary = entries[0];
  const orderedActions: OperatorNextAction[] = [];
  if (primary !== undefined) {
    orderedActions.push({
      id: `history.open.${primary.id}`,
      label: primary.recommendedLabel,
      reason: primary.detail,
      targetDestination: "chat",
      command: "/resume recent",
    });
  }
  orderedActions.push({
    id: "history.start",
    label: "Start task",
    reason: "Launch a new task contract with explicit profile, mode, and workspace.",
    targetDestination: "start",
    command: "/start",
  });
  orderedActions.push({
    id: "history.recover",
    label: "Open Recovery Center",
    reason: "Inspect checkpoints, restore previews, and post-run anchors from one destination.",
    targetDestination: "recovery",
    command: "/checkpoint inspect",
  });
  return {
    destination: "history",
    orderedActions: orderedActions.slice(0, 3),
    rationaleSummary:
      primary !== undefined
        ? `Highest-priority session action: ${primary.recommendedLabel.toLowerCase()}.`
        : "No prior session context is recorded; start a new task journey.",
  };
}

export function buildOperatorStatusSnapshot(input: {
  title: string;
  workspaceLabel?: string | undefined;
  profileLabel: string;
  interactionMode?: string | undefined;
  actSubmode?: string | undefined;
  pendingWaitEventType?: string | undefined;
  lastRunStatus?: string | undefined;
  mcpSummary?: string | undefined;
  isActive?: boolean | undefined;
}): OperatorStatusSnapshot {
  const session: OperatorSessionSurface = {
    id: input.title,
    title: input.title,
    updatedAt: "",
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    pendingWaitEventType: input.pendingWaitEventType,
    lastRunStatus: input.lastRunStatus,
    isActive: input.isActive,
  };
  const journey = deriveOperatorJourney(session);
  const headline =
    journey.lifecycle === "waiting"
      ? `${input.title} is waiting`
      : journey.lifecycle === "failed"
        ? `${input.title} needs recovery`
        : journey.lifecycle === "running"
          ? `${input.title} is running`
          : journey.lifecycle === "completed"
            ? `${input.title} is completed`
            : `${input.title} is ready`;

  const subline = [
    input.profileLabel,
    input.workspaceLabel,
    `Mode ${journey.modeLabel}`,
    input.mcpSummary,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" · ");

  return {
    headline,
    subline,
    lifecycle: journey.lifecycle,
    recommendedAction: journey.recommendedAction,
    recommendedLabel: journey.recommendedLabel,
    modeLabel: journey.modeLabel,
  };
}

export function buildOperatorMcpWorkspace(input: {
  sessionTitle: string;
  profileLabel: string;
  workspaceLabel?: string | undefined;
  interactionMode?: string | undefined;
  actSubmode?: string | undefined;
  pendingWaitEventType?: string | undefined;
  lastRunStatus?: string | undefined;
  isActive?: boolean | undefined;
  status?: McpStatusSnapshot | undefined;
}): OperatorMcpWorkspaceSnapshot {
  const base = buildOperatorStatusSnapshot({
    title: input.sessionTitle,
    profileLabel: input.profileLabel,
    workspaceLabel: input.workspaceLabel,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    pendingWaitEventType: input.pendingWaitEventType,
    lastRunStatus: input.lastRunStatus,
    mcpSummary: summarizeMcpHealth(input.status),
    isActive: input.isActive,
  });
  const status = input.status;
  const healthLabel = summarizeMcpHealth(status) ?? "unknown";
  const serverCount = status?.servers.length ?? 0;
  const toolCount = status?.tools.length ?? 0;
  const degraded = status !== undefined && status.healthy === false;
  const discoveryEmpty = serverCount > 0 && toolCount === 0;
  const stale = status?.checkedAt === undefined;
  const issueFlags = [
    degraded ? "MCP health degraded" : undefined,
    discoveryEmpty ? "No tools discovered" : undefined,
    stale ? "Status not refreshed" : undefined,
  ].filter((value): value is string => value !== undefined);
  const preferredActionIds =
    degraded || stale
      ? ["mcp.refresh", "mcp.servers"]
      : discoveryEmpty
        ? ["mcp.tools", "mcp.servers"]
        : ["mcp.servers", "mcp.tools"];

  return {
    title: "MCP Workspace",
    headline: degraded
      ? "MCP needs attention"
      : serverCount === 0
        ? "MCP is ready to connect"
        : "MCP workspace is ready",
    subline: [
      input.profileLabel,
      input.workspaceLabel,
      `Health ${healthLabel}`,
      `${serverCount} server${serverCount === 1 ? "" : "s"}`,
      `${toolCount} tool${toolCount === 1 ? "" : "s"}`,
    ].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · "),
    lifecycle: base.lifecycle,
    recommendedAction: base.recommendedAction,
    recommendedLabel:
      degraded || stale
        ? "Refresh MCP status"
        : discoveryEmpty
          ? "Inspect MCP tools"
          : "Inspect MCP servers",
    modeLabel: base.modeLabel,
    profileLabel: input.profileLabel,
    ...(input.workspaceLabel !== undefined ? { workspaceLabel: input.workspaceLabel } : {}),
    sessionTitle: input.sessionTitle,
    statusChips: [
      healthLabel,
      `${serverCount} server${serverCount === 1 ? "" : "s"}`,
      `${toolCount} tool${toolCount === 1 ? "" : "s"}`,
    ],
    issueFlags,
    primaryActions: [
      { id: "mcp.refresh", label: "Refresh status", command: "/mcp refresh" },
      { id: "mcp.servers", label: "Inspect servers", command: "/mcp servers" },
    ],
    secondaryActions: [
      buildBackWorkspaceAction(),
      { id: "mcp.tools", label: "Inspect tools", command: "/mcp tools" },
      { id: "mcp.allow", label: "Prepare allowlist", draft: "/mcp allow " },
      { id: "mcp.deny", label: "Prepare denylist", draft: "/mcp deny " },
      ...((status?.servers ?? []).map((server) => ({
        id: `mcp.remove.${server.serverId}`,
        label: `Remove server ${server.serverId}`,
        command: `/mcp remove ${server.serverId}`,
      }))),
    ],
    nextActions: buildOperatorNextActionsSnapshot({
      destination: "mcp",
      recommendedLabel:
        degraded || stale
          ? "Refresh MCP health before using MCP tools."
          : discoveryEmpty
            ? "Inspect discovered tools to verify allowlist posture."
            : "Inspect servers and tools before execution.",
      issueFlags,
      actions: [
        { id: "mcp.refresh", label: "Refresh status", command: "/mcp refresh" },
        { id: "mcp.servers", label: "Inspect servers", command: "/mcp servers" },
        { id: "mcp.tools", label: "Inspect tools", command: "/mcp tools" },
      ],
      preferredActionIds,
    }),
    healthLabel,
    servers: (status?.servers ?? []).map((server) => ({
      id: server.serverId,
      transport: server.transport,
      enabled: server.enabled,
      healthy: server.healthy,
      connected: server.connected,
      toolCount: server.toolCount,
      checkedAt: server.checkedAt,
      ...(server.error !== undefined ? { error: server.error } : {}),
    })),
    tools: (status?.tools ?? []).map((tool) => ({
      id: tool.namespacedToolName,
      serverId: tool.serverId,
      allowlisted: tool.allowlisted === true,
    })),
    ...(status?.checkedAt !== undefined ? { checkedAt: status.checkedAt } : {}),
  };
}

export function buildOperatorCodeWorkspace(input: {
  sessionTitle: string;
  profileLabel: string;
  workspaceLabel?: string | undefined;
  interactionMode?: string | undefined;
  actSubmode?: string | undefined;
  pendingWaitEventType?: string | undefined;
  lastRunStatus?: string | undefined;
  isActive?: boolean | undefined;
  sandboxCodeEnabled?: boolean | undefined;
  codeMode?: CodeModeProfileConfig | undefined;
  latestHint?: string | undefined;
  hasArtifacts?: boolean | undefined;
  hasSummary?: boolean | undefined;
}): OperatorCodeWorkspaceSnapshot {
  const base = buildOperatorStatusSnapshot({
    title: input.sessionTitle,
    profileLabel: input.profileLabel,
    workspaceLabel: input.workspaceLabel,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    pendingWaitEventType: input.pendingWaitEventType,
    lastRunStatus: input.lastRunStatus,
    isActive: input.isActive,
  });
  const policy = input.codeMode;
  const enabled = input.sandboxCodeEnabled ?? policy?.enabled === true;
  const languages = policy?.languages ?? [];
  const sandboxSummary =
    policy === undefined
      ? "No sandbox policy configured"
      : `${policy.sandbox.executor} timeout=${policy.sandbox.timeoutMs}ms memory=${policy.sandbox.memoryMb}MB network=${policy.sandbox.networkDefault}`;
  const retentionSummary =
    policy === undefined
      ? "No retention policy configured"
      : `summary=${policy.retention.persistSummary ? "on" : "off"} artifacts=${policy.retention.persistArtifacts ? "on" : "off"}`;
  const issueFlags = [
    policy === undefined ? "Code policy not configured" : undefined,
    enabled === false ? "Sandbox code disabled" : undefined,
    languages.length === 0 ? "No execution languages allowed" : undefined,
  ].filter((value): value is string => value !== undefined);
  const preferredActionIds = enabled
    ? ["code.policy", "code.disable", "code.run"]
    : ["code.enable", "code.policy"];

  return {
    title: "Code Workspace",
    headline: enabled ? "Code workspace is ready" : "Code workspace needs sandbox code enabled",
    subline: [
      input.profileLabel,
      input.workspaceLabel,
      enabled ? "Sandbox code enabled" : "Sandbox code disabled",
      policy !== undefined ? `approval ${policy.approvalMode}` : undefined,
    ].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · "),
    lifecycle: base.lifecycle,
    recommendedAction: base.recommendedAction,
    recommendedLabel: enabled ? "Inspect code policy" : "Enable sandbox code",
    modeLabel: base.modeLabel,
    profileLabel: input.profileLabel,
    ...(input.workspaceLabel !== undefined ? { workspaceLabel: input.workspaceLabel } : {}),
    sessionTitle: input.sessionTitle,
    statusChips: [
      enabled ? "enabled" : "disabled",
      `languages ${languages.join(",") || "none"}`,
      `retention ${policy?.retention.persistArtifacts === true ? "artifacts" : "summary-only"}`,
    ],
    issueFlags,
    primaryActions: enabled
      ? [
          { id: "code.policy", label: "Inspect policy", command: "/code policy" },
          { id: "code.disable", label: "Disable sandbox code", command: "/code disable" },
        ]
      : [
          { id: "code.enable", label: "Enable sandbox code", command: "/code enable" },
          { id: "code.policy", label: "Inspect policy", command: "/code policy" },
        ],
    secondaryActions: [
      buildBackWorkspaceAction(),
      { id: "code.status", label: "Show status", command: "/code status" },
      { id: "code.run", label: "Prepare code-oriented run", draft: enabled ? "/steer run the next step with sandbox code enabled" : "/code enable" },
    ],
    nextActions: buildOperatorNextActionsSnapshot({
      destination: "code",
      recommendedLabel: enabled
        ? "Inspect code posture before execution."
        : "Enable sandbox code from the active capability packs.",
      issueFlags,
      actions: [
        enabled
          ? { id: "code.policy", label: "Inspect policy", command: "/code policy" }
          : { id: "code.enable", label: "Enable sandbox code", command: "/code enable" },
        enabled
          ? { id: "code.disable", label: "Disable sandbox code", command: "/code disable" }
          : { id: "code.policy", label: "Inspect policy", command: "/code policy" },
        { id: "code.run", label: "Continue in chat", targetDestination: "chat", command: "/status" },
      ],
      preferredActionIds,
    }),
    enabled,
    approvalMode: policy?.approvalMode ?? "not configured",
    sandboxSummary,
    retentionSummary,
    languages,
    ...(input.latestHint !== undefined ? { latestHint: input.latestHint } : {}),
  };
}

export function buildOperatorDelegationWorkspace(input: {
  sessionTitle: string;
  profileLabel: string;
  workspaceLabel?: string | undefined;
  interactionMode?: string | undefined;
  actSubmode?: string | undefined;
  pendingWaitEventType?: string | undefined;
  lastRunStatus?: string | undefined;
  isActive?: boolean | undefined;
  delegation?: OperatorDelegationWorkspaceInput | undefined;
}): OperatorDelegationWorkspaceSnapshot {
  const base = buildOperatorStatusSnapshot({
    title: input.sessionTitle,
    profileLabel: input.profileLabel,
    workspaceLabel: input.workspaceLabel,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    pendingWaitEventType: input.pendingWaitEventType,
    lastRunStatus: input.lastRunStatus,
    isActive: input.isActive,
  });
  const childThreads = input.delegation?.childThreads ?? [];
  const childOutcomes = (input.delegation?.childOutcomes ?? []).map((entry) => {
    const statusUpper = entry.status.toUpperCase();
    const summary = entry.summary ?? entry.result?.result;
    const resultStatus = entry.resultStatus ?? entry.result?.status;
    const errorCode = entry.errorCode ?? entry.result?.error?.code;
    const error = entry.error ?? entry.result?.error?.message;
    const references = entry.references ?? entry.result?.references;
    const readiness =
      entry.readiness ??
      (statusUpper === "COMPLETED"
        ? "ready"
        : statusUpper === "WAITING"
          ? "waiting"
          : statusUpper === "FAILED"
            ? "blocked"
            : "unknown");
    const recommendedAction =
      entry.recommendedAction ??
      (readiness === "ready"
        ? "Consider fan-in accept."
        : readiness === "waiting"
          ? "Resolve waiting blocker before fan-in."
          : readiness === "blocked"
            ? "Supersede or retry child branch."
            : "Inspect child status details.");
    return {
      ...entry,
      readiness,
      recommendedAction,
      ...(summary !== undefined
        ? {
            summary,
            hasSummary: entry.hasSummary ?? true,
            latestPreview: entry.latestPreview ?? summary,
          }
        : {}),
      ...(resultStatus !== undefined ? { resultStatus } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(references !== undefined ? { references } : {}),
    };
  });
  const activeBlocker =
    input.delegation?.childBlockerReason ??
    input.delegation?.blockerSummary;
  const fanInSummary = input.delegation?.fanInDisposition !== undefined
    ? `${input.delegation.fanInDisposition.status.toLowerCase()}${input.delegation.fanInDisposition.checkpointId !== undefined ? ` checkpoint ${input.delegation.fanInDisposition.checkpointId}` : ""}`
    : undefined;
  const issueFlags = [
    activeBlocker !== undefined ? activeBlocker : undefined,
    childThreads.length === 0 ? "No delegated child work recorded" : undefined,
    input.delegation?.inboxChildBlockers
      ? `${input.delegation.inboxChildBlockers} child blocker${input.delegation.inboxChildBlockers === 1 ? "" : "s"}`
      : undefined,
  ].filter((value): value is string => value !== undefined);

  const missionDraft = input.delegation?.missionDraft;
  const nextValidActionSummary =
    activeBlocker !== undefined
      ? "Resolve the blocker or supersede the child branch."
      : childOutcomes.length > 0
        ? "Review child outcomes and decide the next fan-in action."
      : "Prepare a child mission to delegate the next bounded task.";
  const preferredActionIds =
    activeBlocker !== undefined
      ? ["focus.child", "child.spawn"]
      : childOutcomes.length > 0
        ? ["fanin.accept", "fanin.defer", "child.spawn"]
        : ["child.spawn", "focus.child", "preview.fanin"];
  const fanInCheckpointId = input.delegation?.fanInDisposition?.checkpointId;
  const focusTarget = childThreads.find((child) => child.status === "WAITING" || child.status === "FAILED") ?? childThreads[0];

  return {
    title: "Delegation Review",
    headline: childThreads.length > 0 ? "Delegation review is ready" : "No child work recorded yet",
    subline: [
      input.profileLabel,
      input.workspaceLabel,
      `${childThreads.length} child thread${childThreads.length === 1 ? "" : "s"}`,
      `${childOutcomes.length} outcome${childOutcomes.length === 1 ? "" : "s"}`,
    ].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · "),
    lifecycle: base.lifecycle,
    recommendedAction: base.recommendedAction,
    recommendedLabel:
      activeBlocker !== undefined
        ? "Inspect blocked child work"
        : childOutcomes.length > 0
          ? "Review child outcomes"
          : "Spawn a child mission",
    modeLabel: base.modeLabel,
    profileLabel: input.profileLabel,
    ...(input.workspaceLabel !== undefined ? { workspaceLabel: input.workspaceLabel } : {}),
    sessionTitle: input.sessionTitle,
    statusChips: [
      `${childThreads.length} child thread${childThreads.length === 1 ? "" : "s"}`,
      `${childOutcomes.length} outcome${childOutcomes.length === 1 ? "" : "s"}`,
      input.delegation?.nextActionKind ?? "manual review",
    ],
    issueFlags,
    primaryActions: [
      { id: "child.spawn", label: "Prepare child mission", draft: "/child spawn " },
      ...(fanInCheckpointId !== undefined
        ? [{ id: "fanin.accept", label: "Accept fan-in", command: `/fanin accept ${fanInCheckpointId}` }]
        : []),
    ],
    secondaryActions: [
      buildBackWorkspaceAction(),
      ...(fanInCheckpointId !== undefined
        ? [{ id: "fanin.defer", label: "Defer fan-in", command: `/fanin defer ${fanInCheckpointId}` }]
        : []),
      ...(focusTarget !== undefined
        ? [{ id: "focus.child", label: `Focus child ${focusTarget.threadId}`, command: `/focus ${focusTarget.threadId}` }]
        : []),
    ],
    nextActions: buildOperatorNextActionsSnapshot({
      destination: "delegation",
      recommendedLabel: nextValidActionSummary,
      issueFlags,
      actions: [
        { id: "child.spawn", label: "Prepare child mission", draft: "/child spawn " },
        ...(fanInCheckpointId !== undefined
          ? [
              { id: "fanin.accept", label: "Accept fan-in", command: `/fanin accept ${fanInCheckpointId}` },
              { id: "fanin.defer", label: "Defer fan-in", command: `/fanin defer ${fanInCheckpointId}` },
            ]
          : []),
        ...(focusTarget !== undefined
          ? [{ id: "focus.child", label: `Focus child ${focusTarget.threadId}`, command: `/focus ${focusTarget.threadId}` }]
          : []),
      ],
      preferredActionIds,
    }),
    ...(input.delegation?.nextActionSummary !== undefined
      ? { nextActionSummary: input.delegation.nextActionSummary }
      : {}),
    nextValidActionSummary,
    ...(activeBlocker !== undefined ? { activeBlocker } : {}),
    ...(fanInSummary !== undefined ? { fanInSummary } : {}),
    ...(missionDraft !== undefined &&
      missionDraft.title?.trim().length &&
      missionDraft.scope?.trim().length &&
      missionDraft.returnCondition?.trim().length
      ? {
          missionDraft: {
            title: missionDraft.title.trim(),
            scope: missionDraft.scope.trim(),
            returnCondition: missionDraft.returnCondition.trim(),
            profileLabel: missionDraft.profileLabel ?? input.profileLabel,
            modeLabel: formatOperatorMode(missionDraft.interactionMode, missionDraft.actSubmode),
          },
        }
      : {}),
    childThreads,
    childOutcomes,
  };
}

export function buildOperatorRecoveryCenter(input: {
  sessionTitle: string;
  profileLabel: string;
  workspaceLabel?: string | undefined;
  workspaceRoot?: string | undefined;
  interactionMode?: string | undefined;
  actSubmode?: string | undefined;
  pendingWaitEventType?: string | undefined;
  lastRunStatus?: string | undefined;
  isActive?: boolean | undefined;
  recovery?: OperatorRecoveryCenterInput | undefined;
  checkpoints?: WorkspaceCheckpointRecord[] | undefined;
}): OperatorRecoveryCenterSnapshot {
  const base = buildOperatorStatusSnapshot({
    title: input.sessionTitle,
    profileLabel: input.profileLabel,
    workspaceLabel: input.workspaceLabel,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    pendingWaitEventType: input.pendingWaitEventType,
    lastRunStatus: input.lastRunStatus,
    isActive: input.isActive,
  });
  const timeline: OperatorRecoveryTimelineEntry[] = [];
  const latestCheckpoint = input.recovery?.latestCheckpoint;
  if (latestCheckpoint !== undefined) {
    timeline.push({
      id: latestCheckpoint.checkpointId,
      kind: "context_checkpoint",
      origin: "runtime",
      disposition: latestCheckpoint.status,
      label: `Context checkpoint ${latestCheckpoint.checkpointId}`,
      status: latestCheckpoint.status,
      detail: `${latestCheckpoint.recommendedAction} · ${latestCheckpoint.reason}`,
      actionConsequence: "Continuing applies the checkpoint resolution to runtime/orchestration state.",
      actionHint: "Inspect checkpoint disposition before continuing.",
    });
  }
  if (input.recovery?.fanInDisposition !== undefined) {
    timeline.push({
      id: input.recovery.fanInDisposition.checkpointId ?? "fan-in",
      kind: "fan_in",
      origin: "fan_in",
      disposition: input.recovery.fanInDisposition.status,
      label: input.recovery.fanInDisposition.checkpointId !== undefined
        ? `Fan-in checkpoint ${input.recovery.fanInDisposition.checkpointId}`
        : "Fan-in disposition",
      status: input.recovery.fanInDisposition.status,
      detail: input.recovery.fanInDisposition.summary ?? "Fan-in disposition recorded.",
      actionConsequence: "Accept/defer updates fan-in disposition for delegated child outcomes.",
      actionHint: "Review child outcomes before changing fan-in state.",
      ...(input.recovery.fanInDisposition.at !== undefined
        ? { createdAt: input.recovery.fanInDisposition.at }
        : {}),
    });
  }
  for (const checkpoint of input.checkpoints ?? []) {
    timeline.push({
      id: checkpoint.checkpointId,
      kind: "workspace_checkpoint",
      origin: "workspace",
      disposition: checkpoint.captureStatus,
      label: checkpoint.label,
      status: checkpoint.captureStatus,
      detail: `${checkpoint.kind} · ${checkpoint.reason}`,
      actionConsequence: "Restoring rewrites workspace files to the selected anchor; it does not replay runtime state.",
      actionHint: "Compare workspace state before restoring this anchor.",
      createdAt: checkpoint.createdAt,
    });
  }
  timeline.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));

  const issueFlags = [
    input.recovery?.blockerSummary,
    input.recovery?.activeWaitDetail,
    input.recovery?.latestEvidenceTerminalOutcome !== undefined
      ? `Evidence recovery ${input.recovery.latestEvidenceTerminalOutcome.toLowerCase()}`
      : undefined,
  ].filter((value): value is string => value !== undefined);
  const incidentLabel =
    input.lastRunStatus === "FAILED"
      ? "Failed run needs recovery"
      : input.pendingWaitEventType !== undefined
        ? `Waiting for ${input.pendingWaitEventType}`
        : timeline.length > 0
          ? "Recovery anchors available"
          : "No recovery anchors recorded";
  const latestEvidence =
    input.recovery?.latestEvidenceIssues?.join(", ") ??
    input.recovery?.latestReasoningMessage ??
    input.recovery?.latestSteeringMessage;
  const latestWorkspaceCheckpoint = (input.checkpoints ?? [])
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const workspaceCheckpointId = latestWorkspaceCheckpoint?.checkpointId;
  const restorePreview =
    latestWorkspaceCheckpoint === undefined
      ? undefined
      : {
          checkpointId: latestWorkspaceCheckpoint.checkpointId,
          label: latestWorkspaceCheckpoint.label,
          ...(input.workspaceLabel !== undefined ? { workspaceLabel: input.workspaceLabel } : {}),
          ...(latestWorkspaceCheckpoint.workspaceRoot !== undefined
            ? { workspaceRoot: latestWorkspaceCheckpoint.workspaceRoot }
            : input.workspaceRoot !== undefined
              ? { workspaceRoot: input.workspaceRoot }
              : {}),
          summary: `Restore preview targets ${latestWorkspaceCheckpoint.label}.`,
          consequence: "Workspace restore rewrites files to the selected checkpoint. It does not replay the run.",
        } satisfies OperatorWorkspaceRestorePreview;
  const incident = {
    summary: incidentLabel,
    cause:
      input.recovery?.activeWaitDetail ??
      input.recovery?.blockerSummary ??
      (input.pendingWaitEventType !== undefined ? `Waiting on ${input.pendingWaitEventType}` : "No explicit cause recorded."),
    recommendedAction:
      latestCheckpoint !== undefined
        ? "Inspect checkpoint options"
        : restorePreview !== undefined
          ? "Compare the latest workspace anchor before restoring"
          : "Capture a fresh recovery anchor",
    nextValidAction:
      latestCheckpoint !== undefined
        ? "Use checkpoint accept/defer after reviewing consequences."
        : restorePreview !== undefined
          ? "Inspect checkpoint files before restore."
          : "Capture checkpoint to create recovery anchor.",
    ...(latestEvidence !== undefined ? { latestEvidence } : {}),
    restartAvailable: timeline.length > 0,
  } satisfies OperatorIncidentRecoverySnapshot;
  const postRunSummary = {
    outcome:
      input.lastRunStatus === "FAILED"
        ? "Run ended in failure and needs a recovery decision."
        : input.lastRunStatus === "COMPLETED"
          ? "Run completed; review the resulting summary and artifacts."
          : input.pendingWaitEventType !== undefined
            ? `Run is waiting for ${input.pendingWaitEventType}.`
            : "Run outcome is not yet recorded.",
    blockers: [
      input.recovery?.blockerSummary,
      input.recovery?.activeWaitDetail,
    ].filter((value): value is string => value !== undefined),
    childOutcomes: input.recovery?.childOutcomes ?? [],
    summaryState: input.recovery?.latestPreview !== undefined ? "ready" : "missing",
    artifactState: (input.checkpoints?.length ?? 0) > 0 ? "ready" : "missing",
    approvalsUsed: input.recovery?.approvalsUsed ?? [],
    recommendedAction:
      latestCheckpoint !== undefined
        ? "Inspect the latest checkpoint"
        : restorePreview !== undefined
          ? "Review workspace restore preview"
          : "Capture a checkpoint before changing state",
  } satisfies OperatorPostRunSummarySnapshot;
  const notebook: OperatorNotebookEntry[] = [
    ...(input.recovery?.launchSummary !== undefined
      ? [{
          id: "launch:summary",
          kind: "launch" as const,
          label: "Launch summary",
          detail: input.recovery.launchSummary,
        }]
      : []),
    ...(input.recovery?.setupSummary !== undefined
      ? [{
          id: "setup:summary",
          kind: "setup" as const,
          label: "Setup posture",
          detail: input.recovery.setupSummary,
        }]
      : []),
    ...(latestCheckpoint !== undefined
      ? [{
          id: `checkpoint:${latestCheckpoint.checkpointId}`,
          kind: "checkpoint" as const,
          label: `Checkpoint ${latestCheckpoint.checkpointId}`,
          detail: `${latestCheckpoint.status} · ${latestCheckpoint.reason}`,
        }]
      : []),
    ...(input.recovery?.childOutcomes ?? []).map((summary, index) => ({
      id: `child:${index}`,
      kind: "child" as const,
      label: `Child outcome ${index + 1}`,
      detail: summary,
    })),
    ...(input.recovery?.latestPreview !== undefined
      ? [{
          id: "summary:latest",
          kind: "summary" as const,
          label: "Latest summary",
          detail: input.recovery.latestPreview,
        }]
      : []),
    ...((input.checkpoints ?? []).slice(0, 2).map((checkpoint) => ({
      id: `artifact:${checkpoint.checkpointId}`,
      kind: "artifact" as const,
      label: checkpoint.label,
      detail: `${checkpoint.kind} · ${checkpoint.reason}`,
    }))),
  ];

  return {
    title: "Recovery Center",
    headline: incidentLabel,
    subline: [
      input.profileLabel,
      input.workspaceLabel,
      `${timeline.length} recovery anchor${timeline.length === 1 ? "" : "s"}`,
    ].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · "),
    lifecycle: base.lifecycle,
    recommendedAction: base.recommendedAction,
    recommendedLabel:
      latestCheckpoint !== undefined
        ? "Inspect checkpoint options"
        : (input.checkpoints?.length ?? 0) > 0
          ? "Inspect workspace restore anchors"
          : "Capture a recovery checkpoint",
    modeLabel: base.modeLabel,
    profileLabel: input.profileLabel,
    ...(input.workspaceLabel !== undefined ? { workspaceLabel: input.workspaceLabel } : {}),
    sessionTitle: input.sessionTitle,
    statusChips: [
      incidentLabel,
      `${timeline.length} anchor${timeline.length === 1 ? "" : "s"}`,
      input.recovery?.contextPosture ?? "no context posture",
    ],
    issueFlags,
    primaryActions: [
      ...(workspaceCheckpointId !== undefined
        ? [
            { id: "checkpoint.inspect.latest", label: "Inspect latest workspace checkpoint", command: `/checkpoint inspect ${workspaceCheckpointId}` },
            { id: "checkpoint.restore.latest", label: "Prepare latest workspace restore", draft: `/checkpoint restore ${workspaceCheckpointId} ` },
          ]
        : []),
      ...(latestCheckpoint !== undefined
        ? [{ id: "checkpoint.accept", label: "Continue latest context checkpoint", command: "/checkpoint accept" }]
        : []),
      { id: "checkpoint.capture", label: "Capture workspace checkpoint", command: "/checkpoint capture" },
    ],
    secondaryActions: [
      buildBackWorkspaceAction(),
      ...(latestCheckpoint !== undefined
        ? [{ id: "checkpoint.defer", label: "Defer latest context checkpoint", command: "/checkpoint defer" }]
        : []),
      { id: "run.retry", label: "Retry run", command: "/retry" },
    ],
    nextActions: buildOperatorNextActionsSnapshot({
      destination: "recovery",
      recommendedLabel:
        latestCheckpoint !== undefined
          ? "Preview checkpoint consequence, then accept or defer."
          : restorePreview !== undefined
            ? "Inspect workspace restore preview before restoring."
            : "Capture a checkpoint to create a recovery anchor.",
      issueFlags,
      actions: [
        ...(workspaceCheckpointId !== undefined
          ? [
              { id: "checkpoint.inspect.latest", label: "Inspect latest workspace checkpoint", command: `/checkpoint inspect ${workspaceCheckpointId}` },
              { id: "checkpoint.restore.latest", label: "Prepare latest workspace restore", draft: `/checkpoint restore ${workspaceCheckpointId} ` },
            ]
          : []),
        ...(latestCheckpoint !== undefined
          ? [
              { id: "checkpoint.accept", label: "Continue latest context checkpoint", command: "/checkpoint accept" },
              { id: "checkpoint.defer", label: "Defer latest context checkpoint", command: "/checkpoint defer" },
            ]
          : []),
        { id: "checkpoint.capture", label: "Capture workspace checkpoint", command: "/checkpoint capture" },
      ],
      preferredActionIds:
        restorePreview !== undefined
          ? ["checkpoint.inspect.latest", "checkpoint.restore.latest", "checkpoint.accept"]
          : ["checkpoint.accept", "checkpoint.defer", "checkpoint.capture"],
    }),
    incidentLabel,
    ...(latestEvidence !== undefined ? { latestEvidence } : {}),
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    timeline,
    ...(restorePreview !== undefined ? { restorePreview } : {}),
    incident,
    postRunSummary,
    notebook,
  };
}

function summarizeMcpHealth(status: McpStatusSnapshot | undefined): string | undefined {
  if (status === undefined) {
    return ;
  }
  if (status.servers.length === 0) {
    return "no-servers";
  }
  return status.healthy ? "healthy" : "degraded";
}

export function buildOperatorNextActionsSnapshot(input: {
  destination: OperatorJourneyDestination;
  recommendedLabel: string;
  issueFlags?: string[] | undefined;
  actions: Array<OperatorWorkspaceAction & { targetDestination?: OperatorJourneyDestination | undefined }>;
  preferredActionIds?: string[] | undefined;
  maxActions?: number | undefined;
}): OperatorNextActionsSnapshot {
  const preferred = input.preferredActionIds ?? [];
  const maxActions = Math.max(1, input.maxActions ?? 3);
  const selected: OperatorNextAction[] = [];
  const seen = new Set<string>();
  const ordered = [
    ...preferred
      .map((id) => input.actions.find((action) => action.id === id))
      .filter((action): action is OperatorWorkspaceAction & { targetDestination?: OperatorJourneyDestination | undefined } => action !== undefined),
    ...input.actions,
  ];
  const reasons = input.issueFlags ?? [];
  for (const action of ordered) {
    if (action.id === "nav.back" || seen.has(action.id)) {
      continue;
    }
    seen.add(action.id);
    selected.push({
      id: action.id,
      label: action.label,
      reason: reasons[selected.length] ?? input.recommendedLabel,
      ...(action.targetDestination !== undefined ? { targetDestination: action.targetDestination } : {}),
      ...(action.command !== undefined ? { command: action.command } : {}),
      ...(action.draft !== undefined ? { draft: action.draft } : {}),
    });
    if (selected.length >= maxActions) {
      break;
    }
  }

  return {
    destination: input.destination,
    orderedActions: selected,
    rationaleSummary: reasons[0] ?? input.recommendedLabel,
  };
}

export function buildOperatorBootstrapSnapshot(input: {
  hasWorkspace: boolean;
  profileLabel?: string | undefined;
  presetCount: number;
  runnerPreflightStatus: "ready" | "running" | "failed" | "degraded";
  hasPriorSessionContext: boolean;
  hasWaitingOrFailed: boolean;
}): OperatorBootstrapSnapshot {
  const runnerPreflightStatus =
    input.runnerPreflightStatus === "failed"
      ? "degraded"
      : input.runnerPreflightStatus;
  const workspaceDetection = input.hasWorkspace ? "detected" : "missing";
  const profilePresetReadiness = input.presetCount > 0 ? "ready" : "missing";
  const recommendedInitialDestination =
    input.hasPriorSessionContext === false
      ? "start"
      : input.hasWaitingOrFailed
        ? "history"
        : "chat";

  return {
    workspaceDetection,
    profilePresetReadiness,
    runnerPreflightStatus,
    recommendedInitialDestination,
    summary: [
      `workspace ${workspaceDetection}`,
      `profile ${input.profileLabel ?? "active"} presets ${profilePresetReadiness}`,
      `runner ${runnerPreflightStatus}`,
      `next ${recommendedInitialDestination}`,
    ].join(" · "),
  };
}

function historyPriority(action: OperatorRecommendedAction): number {
  switch (action) {
    case "resume_waiting":
      return 0;
    case "recover_failed":
      return 1;
    case "continue_active":
      return 2;
    case "review_completed":
      return 3;
    case "resume_recent":
    default:
      return 4;
  }
}
