export interface CliContractMatrixV1 {
  version: "cli_contract_matrix_v1";
  generatedAt?: string | undefined;
  executables: Array<{
    name: string;
    entrypoint: string;
    aliases: string[];
  }>;
  commandMode: Array<{
    command: string;
    usage: string;
    flags: string[];
  }>;
  slashCommands: string[];
  runnerProtocol: {
    commands: string[];
    events: string[];
    streamingCommands: string[];
  };
  notes: string[];
}

export const COMMAND_MODE_COMMANDS = [
  "model",
  "status",
  "workspace",
  "web",
  "job",
  "operator",
  "runtime",
  "setup",
] as const;

export const SLASH_COMMANDS = [
  "help",
  "profiles",
  "model",
  "theme",
  "mode",
  "start",
  "new",
  "sessions",
  "workspace",
  "tasks",
  "switch",
  "resume",
  "status",
  "mcp",
  "code",
  "skill",
  "compact",
  "snapshot",
  "restore",
  "approve",
  "deny",
  "reject",
  "reply",
  "retry",
  "steer",
  "queue",
  "stop",
  "focus",
  "checkpoint",
  "assembly",
  "child",
  "fanin",
  "operator",
  "quit",
] as const;

export const RUNNER_PROTOCOL_COMMANDS = [
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
  "project.snapshot.get",
  "project.snapshot.update",
  "project.action",
  "project.review.get",
  "project.review.action",
  "runner.ping",
  "mcp.status",
  "mcp.refresh",
] as const;

export const RUNNER_PROTOCOL_EVENTS = [
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
  "project.snapshot",
  "project.review",
  "mcp.status",
  "mcp.refreshed",
] as const;

export function buildCliContractMatrixV1(generatedAt = new Date().toISOString()): CliContractMatrixV1 {
  return {
    version: "cli_contract_matrix_v1",
    generatedAt,
    executables: [
      {
        name: "kestrel",
        entrypoint: "bin/kestrel.js",
        aliases: ["ks"],
      },
      {
        name: "kcron",
        entrypoint: "bin/kcron.js",
        aliases: [],
      },
    ],
    commandMode: [
      {
        command: "model",
        usage: "kestrel model <show|search|set-provider|set> ...",
        flags: [],
      },
      {
        command: "status",
        usage: "kestrel status",
        flags: [],
      },
      {
        command: "workspace",
        usage: "kestrel workspace <status|list>",
        flags: [],
      },
      {
        command: "web",
        usage: "kestrel web ...",
        flags: [],
      },
      {
        command: "job",
        usage: "kestrel job run --json-in <file> --json-out <file> [--profile <id>]",
        flags: ["--json-in", "--json-out", "--profile"],
      },
      {
        command: "operator",
        usage: "kestrel operator <resume-wait|approve|retry-delegation|doctor-export> ...",
        flags: [
          "--thread-id",
          "--request-id",
          "--allow-tool-class",
          "--allow-capability",
          "--delegation-id",
          "--run-id",
          "--out",
          "--reason",
        ],
      },
      {
        command: "runtime",
        usage:
          "kestrel runtime <replay|doctor> <query> [--json]; kestrel runtime bundle <query> --out <file>",
        flags: ["--run-id", "--session-id", "--thread-id", "--delegation-id", "--out", "--limit", "--json"],
      },
      {
        command: "setup",
        usage: "kestrel setup [--profile <id>] [--approval-pack dev|ci_bot|production] [--full]",
        flags: ["--profile", "--approval-pack", "--full"],
      },
    ],
    slashCommands: [...SLASH_COMMANDS],
    runnerProtocol: {
      commands: [...RUNNER_PROTOCOL_COMMANDS],
      events: [...RUNNER_PROTOCOL_EVENTS],
      streamingCommands: ["run.start", "job.run"],
    },
    notes: [
      "Legacy ambiguous command/flag aliases are intentionally excluded from the frozen matrix.",
      "Streaming protocol commands must use /commands/stream on runner-service.",
      "job.run is the protocol-native non-interactive surface for strict JSON IO.",
      "Local Core owns persistence selection for every local command and run.",
    ],
  };
}
