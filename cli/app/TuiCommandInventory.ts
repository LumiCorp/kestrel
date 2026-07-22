import { SLASH_COMMANDS } from "../contractMatrix.js";
import type { PaletteAction } from "../ink/overlays/CommandPalette.js";

export const TUI_SLASH_COMMANDS = SLASH_COMMANDS;

export type TuiSlashCommand = (typeof TUI_SLASH_COMMANDS)[number];

export const UNKNOWN_COMMAND_HELP_MARKER = "__unknown_command__";

export type TuiCommandGroup =
  | "navigation"
  | "session"
  | "workspace"
  | "operator"
  | "runtime"
  | "mcp"
  | "code"
  | "preferences"
  | "templates"
  | "dynamic";

export interface TuiCommandDescriptor {
  id: string;
  root?: TuiSlashCommand | undefined;
  label: string;
  detail: string;
  group: TuiCommandGroup;
  order: number;
  command?: string | undefined;
  draft?: string | undefined;
  aliases?: readonly string[] | undefined;
  paletteOnly?: boolean | undefined;
  hidden?: boolean | undefined;
  requiresContext?: "waiting-session" | "active-workspace" | "mcp-server" | "child-task" | undefined;
}

const GROUP_LABELS: Record<TuiCommandGroup, string> = {
  navigation: "Navigation",
  session: "Start and resume",
  workspace: "Workspace",
  operator: "Operator controls",
  runtime: "Inspect and recovery",
  mcp: "MCP",
  code: "Code",
  preferences: "Preferences",
  templates: "Templates",
  dynamic: "Dynamic",
};

const GROUP_ORDER: Record<TuiCommandGroup, number> = {
  navigation: 10,
  session: 20,
  workspace: 30,
  operator: 40,
  runtime: 50,
  mcp: 60,
  code: 70,
  preferences: 80,
  templates: 90,
  dynamic: 100,
};

export const TUI_COMMAND_DESCRIPTORS: readonly TuiCommandDescriptor[] = [
  { id: "cmd.help", root: "help", label: "/help", detail: "Show command help", group: "runtime", order: 10, command: "/help" },
  { id: "cmd.status", root: "status", label: "/status", detail: "Show runtime status", group: "runtime", order: 20, command: "/status" },
  { id: "cmd.quit", root: "quit", label: "/quit", detail: "Exit kchat", group: "runtime", order: 90, command: "/quit" },

  { id: "cmd.sessions", root: "sessions", label: "/sessions", detail: "List known sessions", group: "session", order: 10, command: "/sessions" },
  { id: "cmd.new.quick", root: "new", label: "/new quick session", detail: "Create a new timestamped session", group: "session", order: 20, command: "/new session-${nowMs}" },
  { id: "draft.new", root: "new", label: "Insert /new template", detail: "Insert a new-session template into the composer", group: "templates", order: 10, draft: "/new " },
  { id: "draft.switch", root: "switch", label: "Insert /switch template", detail: "Insert a session-switch template into the composer", group: "templates", order: 20, draft: "/switch " },
  { id: "draft.resume", root: "resume", label: "Insert /resume template", detail: "Insert a session-resume template into the composer", group: "templates", order: 30, draft: "/resume " },
  { id: "draft.start.recent", root: "start", label: "Insert /start recent", detail: "Seed launch from recent session metadata", group: "templates", order: 40, draft: "/start recent" },

  { id: "cmd.profiles", root: "profiles", label: "/profiles", detail: "List available profiles", group: "preferences", order: 10, command: "/profiles" },
  { id: "draft.profiles.use", root: "profiles", label: "Insert /profiles use template", detail: "Insert a profile-switch template into the composer", group: "templates", order: 50, draft: "/profiles use " },
  { id: "cmd.model", root: "model", label: "/model", detail: "Show the shared model policy, recommendations, and search guidance", group: "preferences", order: 15, command: "/model" },
  { id: "draft.model.setProvider", root: "model", label: "Insert /model set-provider template", detail: "Insert a model-provider template into the composer", group: "templates", order: 55, draft: "/model set-provider " },
  { id: "draft.model.search", root: "model", label: "Insert /model search template", detail: "Insert a model search template into the composer", group: "templates", order: 56, draft: "/model search " },
  { id: "draft.model.set", root: "model", label: "Insert /model set template", detail: "Insert a model template into the composer", group: "templates", order: 57, draft: "/model set " },
  { id: "cmd.theme", root: "theme", label: "/theme", detail: "Show active theme mode and resolved tokens", group: "preferences", order: 20, command: "/theme" },
  { id: "cmd.theme.list", root: "theme", label: "/theme list", detail: "List theme modes", group: "preferences", order: 21, command: "/theme list" },
  { id: "cmd.mode.status", root: "mode", label: "/mode status", detail: "Show current interaction mode", group: "preferences", order: 30, command: "/mode status" },
  { id: "cmd.mode.chat", root: "mode", label: "/mode chat", detail: "Switch the session to chat mode", group: "preferences", order: 31, command: "/mode chat" },
  { id: "cmd.mode.plan", root: "mode", label: "/mode plan", detail: "Switch the session to plan mode", group: "preferences", order: 32, command: "/mode plan" },
  { id: "cmd.mode.build", root: "mode", label: "/mode build", detail: "Switch the session to build mode", group: "preferences", order: 33, command: "/mode build" },
  { id: "cmd.compact", root: "compact", label: "/compact", detail: "Compact this conversation on the next turn", group: "preferences", order: 50, command: "/compact" },
  { id: "cmd.compact.status", root: "compact", label: "/compact status", detail: "Show automatic compaction state", group: "preferences", order: 51, command: "/compact status" },
  { id: "cmd.compact.on", root: "compact", label: "/compact on", detail: "Enable automatic compaction", group: "preferences", order: 52, command: "/compact on" },
  { id: "cmd.compact.off", root: "compact", label: "/compact off", detail: "Disable automatic compaction", group: "preferences", order: 53, command: "/compact off" },
  { id: "cmd.compact.suppress", root: "compact", label: "/compact suppress", detail: "Suppress automatic compaction once", group: "preferences", order: 54, command: "/compact suppress" },

  { id: "cmd.workspace.open", root: "workspace", label: "/workspace", detail: "Open the workspace journey", group: "workspace", order: 10, command: "/workspace" },
  { id: "cmd.workspace.status", root: "workspace", label: "/workspace status", detail: "Show the active workspace binding", group: "workspace", order: 20, command: "/workspace status" },
  { id: "cmd.workspace.list", root: "workspace", label: "/workspace list", detail: "List discovered workspaces", group: "workspace", order: 30, command: "/workspace list" },
  { id: "cmd.workspace.use.detached", root: "workspace", label: "/workspace use detached", detail: "Detach the active session from a workspace", group: "workspace", order: 40, command: "/workspace use detached" },
  { id: "draft.workspace.use", root: "workspace", label: "Insert /workspace use template", detail: "Insert a workspace binding command", group: "templates", order: 70, draft: "/workspace use " },
  { id: "cmd.snapshot", root: "snapshot", label: "/snapshot", detail: "Save the current workspace files", group: "workspace", order: 50, command: "/snapshot" },
  { id: "draft.snapshot", root: "snapshot", label: "Insert /snapshot template", detail: "Insert a workspace snapshot command", group: "templates", order: 71, draft: "/snapshot " },
  { id: "cmd.restore", root: "restore", label: "/restore", detail: "Open workspace snapshot restore", group: "workspace", order: 60, command: "/restore" },
  { id: "draft.restore", root: "restore", label: "Insert /restore template", detail: "Insert a workspace restore command", group: "templates", order: 72, draft: "/restore " },

  { id: "cmd.tasks", root: "tasks", label: "/tasks", detail: "Show child task inbox", group: "operator", order: 10, command: "/tasks" },
  { id: "draft.tasks.open", root: "tasks", label: "Insert /tasks open template", detail: "Insert a task-open template into the composer", group: "templates", order: 80, draft: "/tasks open " },
  { id: "draft.tasks.launch", root: "tasks", label: "Insert /tasks launch template", detail: "Insert a task-launch template", group: "templates", order: 81, draft: "/tasks launch " },
  { id: "cmd.approve", root: "approve", label: "/approve", detail: "Approve a pending operator request", group: "operator", order: 20, command: "/approve" },
  { id: "cmd.deny", root: "deny", label: "/deny", detail: "Deny a pending operator request", group: "operator", order: 21, command: "/deny" },
  { id: "cmd.reject", root: "reject", label: "/reject", detail: "Reject a pending operator request", group: "operator", order: 21, command: "/reject", hidden: true },
  { id: "cmd.retry", root: "retry", label: "/retry", detail: "Retry the focused operator thread", group: "operator", order: 22, command: "/retry" },
  { id: "cmd.stop", root: "stop", label: "/stop", detail: "Stop current work and wait", group: "operator", order: 23, command: "/stop" },
  { id: "draft.operator.queue", root: "queue", label: "Insert /queue template", detail: "Queue a user message after the active run", group: "templates", order: 89, draft: "/queue " },
  { id: "draft.operator.stop", root: "stop", label: "Insert /stop template", detail: "Insert a stop-and-wait operator message", group: "templates", order: 90, draft: "/stop " },
  { id: "draft.operator.steer", root: "steer", label: "Insert /steer template", detail: "Insert a steering message for the focused thread", group: "templates", order: 91, draft: "/steer " },
  { id: "draft.reply", root: "reply", label: "Insert /reply template", detail: "Insert a user-reply operator command", group: "templates", order: 92, draft: "/reply " },
  { id: "draft.focus", root: "focus", label: "Insert /focus template", detail: "Insert a focus-thread command", group: "templates", order: 93, draft: "/focus " },
  { id: "cmd.operator.resume-wait", root: "operator", label: "/operator resume-wait", detail: "Resume a blocked wait on the focused thread", group: "operator", order: 30, command: "/operator resume-wait" },
  { id: "cmd.operator.approve.template", root: "operator", label: "/operator approve --request-id <id>", detail: "Approve a request with optional scope flags", group: "templates", order: 100, draft: "/operator approve --request-id " },
  { id: "cmd.operator.retry-delegation.template", root: "operator", label: "/operator retry-delegation --delegation-id <id>", detail: "Retry a child delegation by superseding it", group: "templates", order: 101, draft: "/operator retry-delegation --delegation-id " },
  { id: "cmd.assembly.approve", root: "assembly", label: "/assembly approve", detail: "Approve pending assembly proposal", group: "operator", order: 40, command: "/assembly approve" },
  { id: "cmd.assembly.reject", root: "assembly", label: "/assembly reject", detail: "Reject pending assembly proposal", group: "operator", order: 41, command: "/assembly reject" },
  { id: "cmd.child.open", root: "child", label: "/child", detail: "Open delegation review", group: "operator", order: 50, command: "/child" },
  { id: "draft.child.spawn", root: "child", label: "Insert /child spawn template", detail: "Insert a child delegation template", group: "templates", order: 110, draft: "/child spawn " },
  { id: "draft.child.supersede", root: "child", label: "Insert /child supersede template", detail: "Insert a child supersede template", group: "templates", order: 111, draft: "/child supersede " },
  { id: "cmd.fanin.open", root: "fanin", label: "/fanin", detail: "Open delegation review with fan-in actions", group: "operator", order: 60, command: "/fanin" },
  { id: "draft.fanin.accept", root: "fanin", label: "Insert /fanin accept template", detail: "Insert a fan-in accept template", group: "templates", order: 120, draft: "/fanin accept " },

  { id: "cmd.checkpoint.open", root: "checkpoint", label: "/checkpoint", detail: "Open recovery center", group: "runtime", order: 30, command: "/checkpoint", hidden: true },
  { id: "cmd.checkpoint.accept", root: "checkpoint", label: "/checkpoint accept", detail: "Accept the active context checkpoint", group: "runtime", order: 31, command: "/checkpoint accept", hidden: true },
  { id: "cmd.checkpoint.defer", root: "checkpoint", label: "/checkpoint defer", detail: "Defer the active context checkpoint", group: "runtime", order: 32, command: "/checkpoint defer", hidden: true },
  { id: "draft.checkpoint.inspect", root: "checkpoint", label: "Insert /checkpoint inspect template", detail: "Insert a checkpoint inspect template", group: "templates", order: 130, draft: "/checkpoint inspect ", hidden: true },
  { id: "draft.checkpoint.restore", root: "checkpoint", label: "Insert /checkpoint restore template", detail: "Insert a checkpoint restore template", group: "templates", order: 131, draft: "/checkpoint restore ", hidden: true },
  { id: "draft.checkpoint.undoLastPromotion", root: "checkpoint", label: "Insert /checkpoint undo-last-promotion", detail: "Undo the latest source promotion", group: "templates", order: 132, draft: "/checkpoint undo-last-promotion", hidden: true },

  { id: "cmd.code.open", root: "code", label: "/code", detail: "Open the code workspace", group: "code", order: 10, command: "/code" },
  { id: "cmd.code.help", root: "code", label: "/code help", detail: "Show built-in code-mode commands", group: "code", order: 20, command: "/code help" },
  { id: "cmd.code.status", root: "code", label: "/code status", detail: "Show built-in code-mode status", group: "code", order: 30, command: "/code status" },
  { id: "cmd.code.policy", root: "code", label: "/code policy", detail: "Show code-mode policy", group: "code", order: 40, command: "/code policy" },
  { id: "cmd.code.enable", root: "code", label: "/code enable", detail: "Enable built-in code-mode", group: "code", order: 50, command: "/code enable" },
  { id: "cmd.code.disable", root: "code", label: "/code disable", detail: "Disable built-in code-mode", group: "code", order: 60, command: "/code disable" },

  { id: "cmd.mcp.open", root: "mcp", label: "/mcp", detail: "Open the MCP workspace", group: "mcp", order: 10, command: "/mcp" },
  { id: "cmd.mcp.help", root: "mcp", label: "/mcp help", detail: "Show MCP command inventory", group: "mcp", order: 20, command: "/mcp help" },
  { id: "cmd.mcp.status", root: "mcp", label: "/mcp status", detail: "Show MCP health and tool discovery status", group: "mcp", order: 30, command: "/mcp status" },
  { id: "cmd.mcp.refresh", root: "mcp", label: "/mcp refresh", detail: "Refresh MCP health and tool discovery", group: "mcp", order: 40, command: "/mcp refresh" },
  { id: "cmd.mcp.servers", root: "mcp", label: "/mcp servers", detail: "List configured MCP servers", group: "mcp", order: 50, command: "/mcp servers" },
  { id: "cmd.mcp.tools", root: "mcp", label: "/mcp tools", detail: "List discovered MCP tools", group: "mcp", order: 60, command: "/mcp tools" },
  { id: "cmd.mcp.allow.template", root: "mcp", label: "/mcp allow <toolId>", detail: "Allowlist a discovered MCP tool", group: "templates", order: 140, draft: "/mcp allow " },
  { id: "cmd.mcp.deny.template", root: "mcp", label: "/mcp deny <toolId>", detail: "Denylist a discovered MCP tool", group: "templates", order: 141, draft: "/mcp deny " },
  { id: "cmd.mcp.remove.template", root: "mcp", label: "/mcp remove <serverId>", detail: "Remove an MCP server", group: "templates", order: 142, draft: "/mcp remove " },
  { id: "cmd.mcp.add.stdio.template", root: "mcp", label: "/mcp add stdio <id> <command> [args...]", detail: "Add a stdio MCP server", group: "templates", order: 143, draft: "/mcp add stdio " },
  { id: "cmd.mcp.add.http.template", root: "mcp", label: "/mcp add http <id> <url>", detail: "Add an HTTP MCP server", group: "templates", order: 144, draft: "/mcp add http " },
  { id: "cmd.mcp.add.sse.template", root: "mcp", label: "/mcp add sse <id> <url>", detail: "Add an SSE MCP server", group: "templates", order: 145, draft: "/mcp add sse " },
  { id: "cmd.mcp.docker", root: "mcp", label: "/mcp docker", detail: "Connect Docker MCP gateway and auto-allow discovered tools", group: "mcp", order: 70, command: "/mcp docker" },
] as const;

export function buildStaticPaletteActions(nowMs: number): PaletteAction[] {
  return [...TUI_COMMAND_DESCRIPTORS]
    .filter((descriptor) => descriptor.hidden !== true)
    .sort(compareDescriptors)
    .map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      detail: descriptor.detail,
      group: descriptor.group,
      groupLabel: GROUP_LABELS[descriptor.group],
      searchText: buildDescriptorSearchText(descriptor),
      ...(descriptor.command !== undefined ? { command: materializeTimeToken(descriptor.command, nowMs) } : {}),
      ...(descriptor.draft !== undefined ? { draft: materializeTimeToken(descriptor.draft, nowMs) } : {}),
    }));
}

export function buildTuiCommandHelp(): string {
  const grouped = new Map<TuiCommandGroup, string[]>();
  const rootsWithCommands = new Set<TuiSlashCommand>();

  for (const descriptor of TUI_COMMAND_DESCRIPTORS) {
    if (descriptor.hidden === true) {
      continue;
    }
    if (descriptor.root !== undefined && descriptor.command !== undefined) {
      rootsWithCommands.add(descriptor.root);
    }
  }

  for (const descriptor of [...TUI_COMMAND_DESCRIPTORS].sort(compareDescriptors)) {
    if (descriptor.hidden === true) {
      continue;
    }
    if (descriptor.command === undefined && descriptor.draft === undefined) {
      continue;
    }
    if (
      descriptor.draft !== undefined &&
      descriptor.command === undefined &&
      descriptor.root !== undefined &&
      rootsWithCommands.has(descriptor.root)
    ) {
      continue;
    }
    const value = descriptor.command ?? formatDraftHelpValue(descriptor);
    if (value === undefined) {
      continue;
    }
    const entries = grouped.get(descriptor.group) ?? [];
    entries.push(value);
    grouped.set(descriptor.group, entries);
  }

  return [
    "Commands",
    ...[...grouped.entries()].map(([group, commands]) => `${GROUP_LABELS[group]}: ${dedupe(commands).join(" ")}`),
  ].join("\n");
}

export function parseUnknownCommandName(args: string[]): string | undefined {
  return args[0] === UNKNOWN_COMMAND_HELP_MARKER ? args[1] : undefined;
}

export function assertTuiCommandDescriptorCoverage(): void {
  const roots = new Set<TuiSlashCommand>(TUI_SLASH_COMMANDS);
  const covered = new Set<TuiSlashCommand>();

  for (const descriptor of TUI_COMMAND_DESCRIPTORS) {
    if (descriptor.paletteOnly === true || descriptor.root === undefined) {
      continue;
    }
    if (roots.has(descriptor.root) === false) {
      throw new Error(`TUI command descriptor '${descriptor.id}' references unknown root '${descriptor.root}'`);
    }
    if (descriptor.command !== undefined || descriptor.draft !== undefined) {
      covered.add(descriptor.root);
    }
  }

  for (const root of roots) {
    if (covered.has(root) === false) {
      throw new Error(`TUI slash command '/${root}' has no command descriptor coverage`);
    }
  }
}

function compareDescriptors(left: TuiCommandDescriptor, right: TuiCommandDescriptor): number {
  const groupDelta = GROUP_ORDER[left.group] - GROUP_ORDER[right.group];
  if (groupDelta !== 0) {
    return groupDelta;
  }
  const orderDelta = left.order - right.order;
  if (orderDelta !== 0) {
    return orderDelta;
  }
  return left.id.localeCompare(right.id);
}

function buildDescriptorSearchText(descriptor: TuiCommandDescriptor): string {
  return [
    descriptor.label,
    descriptor.detail,
    descriptor.command,
    descriptor.draft,
    descriptor.root,
    ...(descriptor.aliases ?? []),
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ");
}

function materializeTimeToken(value: string, nowMs: number): string {
  return value.replace("${nowMs}", String(nowMs));
}

function formatDraftHelpValue(descriptor: TuiCommandDescriptor): string | undefined {
  if (descriptor.root !== undefined) {
    return `/${descriptor.root}`;
  }
  return descriptor.draft?.trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
