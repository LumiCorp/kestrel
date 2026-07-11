const ALLOWED_COMMANDS = new Set([
  "find",
  "ls",
  "tree",
  "grep",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "diff",
  "echo",
  "stat",
  "file",
  "du",
  "basename",
  "dirname",
  "realpath",
  "xargs",
]);

const BLOCKED_PATTERNS = [
  /(^|[^\w])(rm|mv|cp|curl|wget|git|ssh|sudo|chmod|chown|dd|kill|pkill)([^\w]|$)/i,
  /\$\(/,
  /`/,
  /(^|[^&])&&([^&]|$)/,
  /(^|[^|])\|\|([^|]|$)/,
  />/,
  /</,
];

export function validateShellCommand(
  command: string,
  allowedBaseDirectory: string
) {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false as const, reason: "Command is empty" };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false as const, reason: "Command blocked by shell policy" };
    }
  }

  const segments = trimmed
    .split("|")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return { ok: false as const, reason: "Command is empty" };
  }

  for (const segment of segments) {
    const base = segment.split(/\s+/)[0]?.trim();
    if (!(base && ALLOWED_COMMANDS.has(base))) {
      return {
        ok: false as const,
        reason: `Command "${base || segment}" is not allowed`,
      };
    }
  }

  if (trimmed.includes("..")) {
    return {
      ok: false as const,
      reason: "Parent directory traversal is not allowed",
    };
  }

  if (!allowedBaseDirectory) {
    return {
      ok: false as const,
      reason: "Sandbox base directory is not configured",
    };
  }

  return { ok: true as const };
}
