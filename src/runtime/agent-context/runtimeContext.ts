import {
  renderVisibleTodosForModel,
  type VisibleTodoState,
} from "../visibleTodos.js";

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

export function buildRuntimeContextFragment(input: {
  taskInstruction?: string | undefined;
  eventType: string;
  interactionMode: string;
  actSubmode?: string | undefined;
  promptVariant?: string | undefined;
  workspaceContext?: unknown;
  skillPackContext?: unknown;
  activeProcessEvidence?: string[] | undefined;
  recentFilesystemEvidence?: string[] | undefined;
  recentToolResultEvidence?: string[] | undefined;
  projectTaskQueueContext?: string | undefined;
  recoveryContext?: unknown;
  visibleTodos?: VisibleTodoState | undefined;
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
  const skillPack = renderSkillPackContext(input.skillPackContext);
  if (skillPack !== undefined) {
    lines.push("", skillPack);
  }
  const workState = renderWorkState(input.visibleTodos, input.activeWait);
  if (workState !== undefined) {
    lines.push("", workState);
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

export function readActiveWorkspaceContext(value: unknown): ActiveWorkspaceContext | undefined {
  const record = asRecord(value);
  const workspaceId = asString(record?.workspaceId);
  const workspaceRoot = asString(record?.workspaceRoot);
  if (workspaceId === undefined || workspaceRoot === undefined) {
    return undefined;
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
    return undefined;
  }
  return {
    workspaceId: workspace.workspaceId,
    workspaceRoot: workspace.workspaceRoot,
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

export function readActiveSkillPackContext(value: unknown): ActiveSkillPackContext | undefined {
  const record = asRecord(value);
  const id = asString(record?.id);
  const label = asString(record?.label);
  if (id === undefined || label === undefined) {
    return undefined;
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
      "Use exec_command with the listed sessionId and stdin/read to continue; do not start a fresh command unless intentionally resetting or starting unrelated work.",
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
      "Use these observed tool results before repeating the same failed action.",
    );
  }
  if (input.projectTaskQueueContext !== undefined && input.projectTaskQueueContext.trim().length > 0) {
    lines.push(input.projectTaskQueueContext.trim());
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

function renderWorkspaceContext(value: unknown): string | undefined {
  const workspace = readActiveWorkspaceContext(value);
  if (workspace === undefined) {
    return undefined;
  }

  return [
    `Workspace: ${workspace.workspaceId}${workspace.label !== undefined ? ` (${workspace.label})` : ""}.`,
    `- root: ${workspace.workspaceRoot}`,
    `- appRoot: ${workspace.appRoot}`,
    ...(workspace.packageManager !== undefined ? [`- packageManager: ${workspace.packageManager}`] : []),
    ...formatWorkspaceCommands(workspace.commands),
  ].join("\n");
}

function renderSkillPackContext(value: unknown): string | undefined {
  const skillPack = readActiveSkillPackContext(value);
  if (skillPack === undefined) {
    return undefined;
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
    return undefined;
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
    return undefined;
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
