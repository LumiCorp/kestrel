import type { ParsedInput } from "../contracts.js";
import { TUI_SLASH_COMMANDS, UNKNOWN_COMMAND_HELP_MARKER, type TuiSlashCommand } from "./TuiCommandInventory.js";

const COMMANDS = new Set<string>(TUI_SLASH_COMMANDS);

const INTERACTIVE_OPERATOR_COMMANDS = new Set<TuiSlashCommand>([
  "approve",
  "deny",
  "reject",
  "reply",
  "retry",
  "steer",
  "stop",
  "focus",
  "checkpoint",
  "assembly",
  "child",
  "fanin",
  "operator",
]);

export function parseInput(rawLine: string): ParsedInput {
  const line = rawLine.trim();

  if (line.startsWith("/") === false) {
    return {
      kind: "message",
      message: rawLine,
    };
  }

  const withoutSlash = line.slice(1).trim();
  const [name, ...args] = withoutSlash.split(/\s+/u).filter((chunk) => chunk.length > 0);

  if (name === undefined || COMMANDS.has(name) === false) {
    return {
      kind: "command",
      command: "help",
      args: [UNKNOWN_COMMAND_HELP_MARKER, ...(name !== undefined ? [name] : [])],
    };
  }

  return {
    kind: "command",
    command: name as TuiSlashCommand,
    args,
  };
}

export function isInteractiveOperatorCommandDraft(rawLine: string): boolean {
  const parsed = parseInput(rawLine);
  return parsed.kind === "command" && INTERACTIVE_OPERATOR_COMMANDS.has(parsed.command);
}
