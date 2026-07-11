import path from "node:path";

export const ALLOWED_BASH_COMMANDS = new Set([
  "find",
  "ls",
  "tree",
  "grep",
  "egrep",
  "fgrep",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "sort",
  "uniq",
  "cut",
  "awk",
  "sed",
  "tr",
  "column",
  "echo",
  "printf",
  "test",
  "[",
  "true",
  "false",
  "basename",
  "dirname",
  "realpath",
  "file",
  "stat",
  "du",
  "diff",
  "comm",
  "xargs",
  "tee",
  "md5sum",
  "sha256sum",
]);

export const BLOCKED_SHELL_PATTERNS = [
  /\$\(/,
  /`[^`]+`/,
  /\beval\b/,
  /\bexec\b/,
  /\bsource\b/,
  /\bbash\b/,
  /\bsh\b/,
  /\bzsh\b/,
  /\benv\b/,
  />\s*[^\s|]/,
  /\bpython\b/,
  /\bnode\b/,
  /\bperl\b/,
  /\bruby\b/,
];

function isPathWithinDirectory(filePath: string, directory: string) {
  const resolvedPath = path.resolve(filePath);
  const resolvedDir = path.resolve(directory);
  return (
    resolvedPath.startsWith(`${resolvedDir}${path.sep}`) ||
    resolvedPath === resolvedDir
  );
}

function extractPotentialPathTokens(command: string) {
  const tokenRegex = /(?:^|\s)(\/[^\s|;&]+|\.{1,2}\/[^\s|;&]+)/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = tokenRegex.exec(command)) !== null) {
    const [, token] = match;
    if (token) {
      tokens.push(token.replace(/^['"]|['"]$/g, ""));
    }
  }

  return tokens;
}

export function validateShellCommand(
  command: string,
  options?: {
    allowedCommands?: Set<string>;
    blockedPatterns?: RegExp[];
    allowedBaseDirectory?: string;
  }
): { ok: true } | { ok: false; reason: string } {
  const blockedPatterns = options?.blockedPatterns ?? BLOCKED_SHELL_PATTERNS;
  const allowedCommands = options?.allowedCommands ?? ALLOWED_BASH_COMMANDS;

  for (const pattern of blockedPatterns) {
    if (pattern.test(command)) {
      return {
        ok: false,
        reason: `Command contains blocked pattern: ${command.slice(0, 80)}`,
      };
    }
  }

  const segments = command.split(/\s*(?:\|(?!\|)|\|\||&&|;)\s*/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/);
    const cmdName = words.find((word) => !word.includes("=")) || words[0];

    if (!(cmdName && allowedCommands.has(cmdName))) {
      return {
        ok: false,
        reason: `Command not allowed: ${cmdName || "unknown"}`,
      };
    }
  }

  if (options?.allowedBaseDirectory) {
    for (const token of extractPotentialPathTokens(command)) {
      if (token.startsWith("../")) {
        return { ok: false, reason: `Path traversal is not allowed: ${token}` };
      }
      if (
        token.startsWith("/") &&
        !isPathWithinDirectory(token, options.allowedBaseDirectory)
      ) {
        return {
          ok: false,
          reason: `Path outside sandbox is not allowed: ${token}`,
        };
      }
    }
  }

  return { ok: true };
}
