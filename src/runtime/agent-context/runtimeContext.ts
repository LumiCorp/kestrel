import {
  renderVisibleTodosForModel,
  type VisibleTodoState,
} from "../visibleTodos.js";
import type {
  WorkspaceFreshnessEvidenceRef,
  WorkspaceFreshnessSummary,
} from "../workspaceFreshness.js";

export interface ActiveWorkspaceContext {
  workspaceId: string;
  workspaceRoot: string;
  appRoot: string;
  packageManager?: string | undefined;
  commands: WorkspaceCommandContext;
  label?: string | undefined;
}

export interface ActiveWorkspaceModelContext {
  workspaceId: string;
  workspaceRoot: string;
  appRoot: string;
  packageManager?: string | undefined;
  commands: WorkspaceCommandContext;
  label?: string | undefined;
}

export interface WorkspaceCommandContext {
  install?: string | undefined;
  dev?: string | undefined;
  build?: string | undefined;
  test?: string | undefined;
}

export interface ActiveSkillPackContext {
  id: string;
  label: string;
  instructions: string[];
  allowedTools: string[];
}

export interface ActiveProjectContext {
  projectId: string;
  contextRevisionId: string;
  contextRevision: number;
  content: string;
}

export function buildRuntimeContextFragment(input: {
  taskInstruction?: string | undefined;
  eventType: string;
  interactionMode: string;
  actSubmode?: string | undefined;
  promptVariant?: string | undefined;
  workspaceContext?: unknown;
  projectContext?: unknown;
  skillPackContext?: unknown;
  activeProcessEvidence?: string[] | undefined;
  recentFilesystemEvidence?: string[] | undefined;
  recentToolResultEvidence?: string[] | undefined;
  projectTaskQueueContext?: string | undefined;
  recoveryContext?: unknown;
  visibleTodos?: VisibleTodoState | undefined;
  workspaceFreshness?: WorkspaceFreshnessSummary | undefined;
  activeExecCommandSessions?: WorkspaceFreshnessEvidenceRef[] | undefined;
  correction?: string | undefined;
  activeWait?: unknown;
}): string {
  const lines = input.taskInstruction !== undefined && input.taskInstruction.trim().length > 0
    ? [
      "Task:",
      input.taskInstruction,
      "",
    ]
    : [];
  lines.push(
    "Mode:",
    `- event: ${input.eventType}`,
    `- interaction: ${input.interactionMode}`,
  );
  if (input.actSubmode !== undefined) {
    lines.push(`- submode: ${input.actSubmode}`);
  }
  if (input.promptVariant !== undefined) {
    lines.push(`- promptVariant: ${input.promptVariant}`);
  }
  const workspace = renderWorkspaceContext(input.workspaceContext);
  if (workspace !== undefined) {
    lines.push("", workspace);
  }
  const projectContext = renderProjectContext(input.projectContext);
  if (projectContext !== undefined) {
    lines.push("", projectContext);
  }
  const skillPack = renderSkillPackContext(input.skillPackContext);
  if (skillPack !== undefined) {
    lines.push("", skillPack);
  }
  const workState = renderWorkState(input.visibleTodos, input.activeWait);
  if (workState !== undefined) {
    lines.push("", workState);
  }
  const workspaceStatus = renderWorkspaceStatus(
    input.workspaceFreshness,
    input.activeExecCommandSessions,
  );
  if (workspaceStatus !== undefined) {
    lines.push("", workspaceStatus);
  }
  const evidence = renderEvidence({
    activeProcessEvidence: input.activeProcessEvidence,
    recentFilesystemEvidence: input.recentFilesystemEvidence,
    recentToolResultEvidence: input.recentToolResultEvidence,
    projectTaskQueueContext: input.projectTaskQueueContext,
  });
  if (evidence !== undefined) {
    lines.push("", evidence);
  }
  const recoveryContext = renderObjectBlock("Recovery checkpoint", input.recoveryContext);
  if (recoveryContext !== undefined) {
    lines.push(
      "",
      [
        "Recovery:",
        recoveryContext,
        "Do not issue the blocked action from this checkpoint again.",
        "Use existing evidence and choose a different next action, finalize, or ask the user.",
      ].join("\n"),
    );
  }
  if (input.correction !== undefined && input.correction.trim().length > 0) {
    lines.push("", `Correction needed: ${input.correction.trim()}`);
  }
  return lines.join("\n");
}

function renderWorkspaceStatus(
  freshness: WorkspaceFreshnessSummary | undefined,
  activeSessions: WorkspaceFreshnessEvidenceRef[] | undefined,
): string | undefined {
  const live = activeSessions ?? [];
  if (
    live.length === 0 &&
    freshness?.status !== "stale" &&
    freshness?.status !== "attempted_unresolved"
  ) {
    return ;
  }
  const lines = ["Workspace status:"];
  if (live.length > 0) {
    const sessions = live.filter((item): item is WorkspaceFreshnessEvidenceRef & { processId: string } =>
      typeof item.processId === "string" && item.processId.length > 0
    );
    lines.push(
      `- live exec_command sessions: ${sessions.length}`,
      ...sessions.map((session) =>
        `- sessionId: ${session.processId}; status: ${session.status ?? "running"}; command: ${JSON.stringify(session.command ?? "unknown")}; cwd: ${JSON.stringify(session.cwd ?? ".")}`
      ),
      "- successful finalization is blocked until each session exits, is stopped and its final result is collected, or is explicitly listed in finalize data.keepRunningSessionIds because it is itself part of the requested completed result.",
      ...sessions.map((session) =>
        `- next action for ${session.processId}: call exec_command with {"sessionId":"${session.processId}","assistantProgress":"I am checking the running process."} and no command to collect unread output and the current process state. Repeat if it returns running. Use {"sessionId":"${session.processId}","stop":true,"assistantProgress":"I am stopping the unneeded process."} only if the process is no longer needed.`
      ),
    );
  }
  const mutation = freshness?.latestMutation;
  if (mutation !== undefined) {
    lines.push(
      `- latest mutation: ${mutation.summary}`,
      ...(mutation.changedFiles !== undefined && mutation.changedFiles.length > 0
        ? [`- changed files: ${mutation.changedFiles.join(", ")}`]
        : []),
    );
  }
  if (freshness?.status === "stale") {
    lines.push(
      "- validation state: stale. Earlier checks predate the current workspace.",
      "- next action: update the visible plan as needed, then run or read back the planned validation after the final mutation.",
    );
  } else if (freshness?.status === "attempted_unresolved") {
    lines.push(
      "- validation state: attempted but unresolved.",
      ...((freshness.unresolvedEvidence ?? []).map((item) => `- unresolved: ${item.summary}`)),
      "- next action: resolve or rerun the check, or explicitly report the remaining unverified result if no actionable work remains.",
    );
  }
  return lines.join("\n");
}

export function readActiveWorkspaceContext(value: unknown): ActiveWorkspaceContext | undefined {
  const record = asRecord(value);
  const workspaceId = asString(record?.workspaceId);
  const workspaceRoot = asString(record?.workspaceRoot);
  if (workspaceId === undefined || workspaceRoot === undefined) {
    return ;
  }

  return {
    workspaceId,
    workspaceRoot,
    appRoot: asString(record?.appRoot) ?? ".",
    ...(asString(record?.packageManager) !== undefined ? { packageManager: asString(record?.packageManager) } : {}),
    commands: readWorkspaceCommands(record?.commands),
    ...(asString(record?.label) !== undefined ? { label: asString(record?.label) } : {}),
  };
}

export function buildWorkspaceModelContext(
  value: unknown,
): ActiveWorkspaceModelContext | undefined {
  const workspace = readActiveWorkspaceContext(value);
  if (workspace === undefined) {
    return ;
  }
  return {
    workspaceId: workspace.workspaceId,
    // The runtime root can be a host-only path. Model-facing tools operate in a
    // workspace-relative coordinate system, so do not teach the model to reuse
    // the host path as tool input.
    workspaceRoot: ".",
    appRoot: workspace.appRoot,
    ...(workspace.packageManager !== undefined ? { packageManager: workspace.packageManager } : {}),
    commands: workspace.commands,
    ...(workspace.label !== undefined ? { label: workspace.label } : {}),
  };
}

export function buildWorkspaceSystemMessages(value: unknown): string[] {
  const rendered = renderWorkspaceContext(value);
  return rendered !== undefined ? [rendered] : [];
}

export function readActiveProjectContext(value: unknown): ActiveProjectContext | undefined {
  const record = asRecord(value);
  const projectId = asString(record?.projectId);
  const contextRevisionId = asString(record?.contextRevisionId);
  const contextRevision = record?.contextRevision;
  const content = asString(record?.content);
  if (
    projectId === undefined ||
    contextRevisionId === undefined ||
    typeof contextRevision !== "number" ||
    Number.isSafeInteger(contextRevision) === false ||
    contextRevision < 1 ||
    content === undefined
  ) {
    return ;
  }
  return {
    projectId,
    contextRevisionId,
    contextRevision,
    content,
  };
}

export function readActiveSkillPackContext(value: unknown): ActiveSkillPackContext | undefined {
  const record = asRecord(value);
  const id = asString(record?.id);
  const label = asString(record?.label);
  if (id === undefined || label === undefined) {
    return ;
  }

  return {
    id,
    label,
    instructions: readStringArray(record?.instructions),
    allowedTools: readStringArray(record?.allowedTools),
  };
}

export function buildSkillPackSystemMessage(value: unknown): string | undefined {
  return renderSkillPackContext(value);
}

function renderWorkState(visibleTodos: VisibleTodoState | undefined, activeWait: unknown): string | undefined {
  const lines = ["Work state:"];
  const todos = visibleTodos !== undefined ? renderVisibleTodosForModel(visibleTodos) : undefined;
  if (todos !== undefined) {
    lines.push(todos);
  }
  const wait = renderObjectBlock("Active wait", activeWait);
  if (wait !== undefined) {
    lines.push(wait);
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

function renderEvidence(input: {
  activeProcessEvidence?: string[] | undefined;
  recentFilesystemEvidence?: string[] | undefined;
  recentToolResultEvidence?: string[] | undefined;
  projectTaskQueueContext?: string | undefined;
}): string | undefined {
  const lines = ["Evidence:"];
  if (input.activeProcessEvidence !== undefined && input.activeProcessEvidence.length > 0) {
    lines.push(
      "Active process evidence:",
      ...input.activeProcessEvidence.map((item) => `- ${item}`),
    );
  }
  if (input.recentFilesystemEvidence !== undefined && input.recentFilesystemEvidence.length > 0) {
    lines.push(
      "Recent filesystem evidence:",
      ...input.recentFilesystemEvidence.map((item) => `- ${item}`),
      "Use these persisted results before repeating the same filesystem inspection.",
    );
  }
  if (input.recentToolResultEvidence !== undefined && input.recentToolResultEvidence.length > 0) {
    lines.push(
      "Recent tool-result evidence:",
      ...input.recentToolResultEvidence.map((item) => `- ${item}`),
      "Treat the latest observed result as authoritative for the completed action. Use these results before repeating or replacing an action.",
    );
  }
  if (input.projectTaskQueueContext !== undefined && input.projectTaskQueueContext.trim().length > 0) {
    lines.push(input.projectTaskQueueContext.trim());
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

function renderWorkspaceContext(value: unknown): string | undefined {
  const workspace = buildWorkspaceModelContext(value);
  if (workspace === undefined) {
    return ;
  }

  return [
    `Workspace: ${workspace.workspaceId}${workspace.label !== undefined ? ` (${workspace.label})` : ""}.`,
    `- usable root: ${workspace.workspaceRoot}`,
    `- appRoot: ${workspace.appRoot}`,
    "- Use workspace-relative paths for file tools and exec_command cwd. Host-absolute paths are not valid tool input.",
    ...(workspace.packageManager !== undefined ? [`- packageManager: ${workspace.packageManager}`] : []),
    ...formatWorkspaceCommands(workspace.commands),
  ].join("\n");
}

function renderProjectContext(value: unknown): string | undefined {
  const projectContext = readActiveProjectContext(value);
  if (projectContext === undefined) {
    return ;
  }
  return [
    "Project context:",
    `- projectId: ${projectContext.projectId}`,
    `- contextRevisionId: ${projectContext.contextRevisionId}`,
    `- contextRevision: ${projectContext.contextRevision}`,
    projectContext.content,
  ].join("\n");
}

function renderSkillPackContext(value: unknown): string | undefined {
  const skillPack = readActiveSkillPackContext(value);
  if (skillPack === undefined) {
    return ;
  }

  const lines = [
    `Skill pack: ${skillPack.id} (${skillPack.label}).`,
    "- Treat these as additional operator instructions.",
    "- Tool legality is enforced outside the model; stay aligned with this skill's intent.",
  ];

  if (skillPack.instructions.length > 0) {
    lines.push("Skill instructions:");
    for (const [index, instruction] of skillPack.instructions.entries()) {
      lines.push(`${index + 1}. ${instruction}`);
    }
  }

  if (skillPack.allowedTools.length > 0) {
    lines.push(`Skill-allowed tools: ${skillPack.allowedTools.join(", ")}`);
  }

  return lines.join("\n");
}

function renderObjectBlock(label: string, value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined || Object.keys(record).length === 0) {
    return ;
  }
  return `${label}: ${JSON.stringify(record)}`;
}

function readWorkspaceCommands(value: unknown): WorkspaceCommandContext {
  const record = asRecord(value);
  if (record === undefined) {
    return {};
  }
  return {
    ...(asString(record.install) !== undefined ? { install: asString(record.install) } : {}),
    ...(asString(record.dev) !== undefined ? { dev: asString(record.dev) } : {}),
    ...(asString(record.build) !== undefined ? { build: asString(record.build) } : {}),
    ...(asString(record.test) !== undefined ? { test: asString(record.test) } : {}),
  };
}

function formatWorkspaceCommands(commands: WorkspaceCommandContext): string[] {
  return [
    commands.install !== undefined ? `- install: ${commands.install}` : undefined,
    commands.dev !== undefined ? `- dev: ${commands.dev}` : undefined,
    commands.build !== undefined ? `- build: ${commands.build}` : undefined,
    commands.test !== undefined ? `- test: ${commands.test}` : undefined,
  ].filter((line): line is string => line !== undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }

  return value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== undefined);
}
