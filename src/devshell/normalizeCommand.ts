export interface DevShellCommandSafetyIssue {
  code: "UNQUOTED_SHELL_GLOB_PATH_SEGMENT";
  token: string;
  message: string;
  correction: string;
}

export function normalizeDevShellExecCommand(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const unfenced = unwrapMarkdownCodeFence(trimmed);
  const unwrapped = unwrapWholeCommandQuotes(unfenced);
  const command = unwrapped.trim();
  if (command.length === 0) {
    return undefined;
  }
  return normalizeEscapedNewlinePythonInlineCommand(command) ??
    normalizePythonHeredocCommand(command) ??
    command;
}

export function findDevShellCommandSafetyIssue(command: string): DevShellCommandSafetyIssue | undefined {
  const token = findUnquotedShellGlobPathSegment(commandWithoutHeredocBodies(command));
  if (token === undefined) {
    return undefined;
  }
  return {
    code: "UNQUOTED_SHELL_GLOB_PATH_SEGMENT",
    token,
    message:
      `Command contains an unquoted shell glob path segment: ${token}. Quote or escape bracketed path segments before running shell commands.`,
    correction:
      "Quote or escape bracketed path segments in shell commands, for example 'src/app/[id]' or src/app/\\[id\\]. Use file tools for source writes when available.",
  };
}

function commandWithoutHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const retained: string[] = [];
  const pendingLabels: string[] = [];
  for (const line of lines) {
    if (pendingLabels.length > 0) {
      const label = pendingLabels[0];
      if (label !== undefined && line.trim() === label) {
        pendingLabels.shift();
      }
      continue;
    }
    retained.push(line);
    pendingLabels.push(...readHeredocLabels(line));
  }
  return retained.join("\n");
}

function readHeredocLabels(line: string): string[] {
  const labels: string[] = [];
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === undefined) {
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char !== "<" || line[index + 1] !== "<") {
      continue;
    }
    let cursor = index + 2;
    if (line[cursor] === "-") {
      cursor += 1;
    }
    while (line[cursor] === " " || line[cursor] === "\t") {
      cursor += 1;
    }
    const label = readHeredocLabelAt(line, cursor);
    if (label !== undefined) {
      labels.push(label.value);
      index = label.endIndex - 1;
    }
  }
  return labels;
}

function readHeredocLabelAt(
  line: string,
  startIndex: number,
): { value: string; endIndex: number } | undefined {
  const quote = line[startIndex];
  if (quote === "'" || quote === "\"") {
    const endIndex = line.indexOf(quote, startIndex + 1);
    if (endIndex <= startIndex + 1) {
      return undefined;
    }
    return {
      value: line.slice(startIndex + 1, endIndex),
      endIndex: endIndex + 1,
    };
  }
  const match = line.slice(startIndex).match(/^([A-Za-z_][A-Za-z0-9_]*)/u);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  return {
    value: match[1],
    endIndex: startIndex + match[1].length,
  };
}

function findUnquotedShellGlobPathSegment(command: string): string | undefined {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  let current: Array<{ char: string; quoted: boolean }> = [];

  const flush = (): string | undefined => {
    const token = readUnquotedGlobPathToken(current);
    current = [];
    return token;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) {
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        current.push({ char, quoted: true });
        escaped = false;
        continue;
      }
      if (char === "\\") {
        current.push({ char, quoted: true });
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current.push({ char, quoted: true });
      continue;
    }
    if (escaped) {
      current.push({ char, quoted: true });
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (isShellWordBoundary(char)) {
      const token = flush();
      if (token !== undefined) {
        return token;
      }
      continue;
    }
    current.push({ char, quoted: false });
  }
  return flush();
}

function readUnquotedGlobPathToken(chars: Array<{ char: string; quoted: boolean }>): string | undefined {
  if (chars.length === 0) {
    return undefined;
  }
  for (let index = 0; index < chars.length; index += 1) {
    const item = chars[index];
    if (item?.char !== "[" || item.quoted) {
      continue;
    }
    const segmentStart = findPathSegmentStart(chars, index);
    const segmentEnd = findPathSegmentEnd(chars, index);
    const segment = chars.slice(segmentStart, segmentEnd);
    if (
      segment.every((part) => !part.quoted) &&
      isBracketedRouteSegment(segment.map((part) => part.char).join(""))
    ) {
      return chars.map((part) => part.char).join("");
    }
  }
  return undefined;
}

function findPathSegmentStart(chars: Array<{ char: string; quoted: boolean }>, index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (chars[cursor]?.char === "/") {
      return cursor + 1;
    }
  }
  return 0;
}

function findPathSegmentEnd(chars: Array<{ char: string; quoted: boolean }>, index: number): number {
  for (let cursor = index + 1; cursor < chars.length; cursor += 1) {
    if (chars[cursor]?.char === "/") {
      return cursor;
    }
  }
  return chars.length;
}

function isBracketedRouteSegment(segment: string): boolean {
  return /^\[(?:\.\.\.)?[A-Za-z0-9_-]+\]$/u.test(segment) ||
    /^\[\[(?:\.\.\.)?[A-Za-z0-9_-]+\]\]$/u.test(segment);
}

function isShellWordBoundary(char: string): boolean {
  return /\s/u.test(char) || char === ";" || char === "&" || char === "|" ||
    char === "(" || char === ")" || char === "<" || char === ">";
}

function unwrapMarkdownCodeFence(command: string): string {
  const fenceMatch = command.match(/^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/u);
  if (fenceMatch === null) {
    return command;
  }
  const inner = fenceMatch[1]?.trim();
  return inner ?? "";
}

function unwrapWholeCommandQuotes(command: string): string {
  if (command.length < 2) {
    return command;
  }
  if (command.startsWith("\"") && command.endsWith("\"")) {
    return command.slice(1, -1)
      .replace(/\\\\/gu, "\\")
      .replace(/\\"/gu, "\"")
      .trim();
  }
  if (command.startsWith("'") && command.endsWith("'")) {
    return command.slice(1, -1)
      .replace(/'\\''/gu, "'")
      .trim();
  }
  return command;
}

function normalizeEscapedNewlinePythonInlineCommand(command: string): string | undefined {
  const match = command.match(/^(python(?:3(?:\.\d+)?)?)\s+-c\s+"([\s\S]*)"\s*$/u);
  if (match === null) {
    return undefined;
  }
  const executable = match[1];
  const payload = match[2];
  if (executable === undefined || payload === undefined || !payload.includes("\\n")) {
    return undefined;
  }
  const decoded = decodeEscapedPythonPhysicalNewlines(payload.replace(/\\"/gu, "\""));
  if (decoded === undefined || decoded.trim().length === 0) {
    return undefined;
  }
  const repaired = escapePhysicalNewlinesInPythonStringLiterals(decoded);
  const label = chooseHeredocLabel(repaired);
  return `${executable} <<'${label}'\n${repaired.trimEnd()}\n${label}`;
}

function normalizePythonHeredocCommand(command: string): string | undefined {
  const match = command.match(/^(python(?:3(?:\.\d+)?)?)\s+<<'([A-Za-z_][A-Za-z0-9_]*)'\n([\s\S]*)\n\2\s*$/u);
  if (match === null) {
    return undefined;
  }
  const executable = match[1];
  const label = match[2];
  const payload = match[3];
  if (executable === undefined || label === undefined || payload === undefined) {
    return undefined;
  }
  const decoded = decodeEscapedPythonPhysicalNewlines(payload) ?? payload;
  const repaired = escapePhysicalNewlinesInPythonStringLiterals(decoded);
  if (repaired === payload) {
    return undefined;
  }
  return `${executable} <<'${label}'\n${repaired.trimEnd()}\n${label}`;
}

function decodeEscapedPythonPhysicalNewlines(payload: string): string | undefined {
  let output = "";
  let quote: "'" | "\"" | undefined;
  let tripleQuote = false;
  let escaped = false;
  let inComment = false;
  let converted = false;

  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    const next = payload[index + 1];
    if (char === undefined) {
      continue;
    }

    if (quote === undefined) {
      if (char === "\\" && next === "n") {
        output += "\n";
        converted = true;
        inComment = false;
        index += 1;
        continue;
      }
      if (inComment) {
        output += char;
        continue;
      }
      if (char === "#") {
        inComment = true;
        output += char;
        continue;
      }
      if (char === "'" || char === "\"") {
        quote = char;
        if (payload[index + 1] === char && payload[index + 2] === char) {
          tripleQuote = true;
          output += char + char + char;
          index += 2;
          continue;
        }
        tripleQuote = false;
        output += char;
        continue;
      }
      output += char;
      continue;
    }

    output += char;
    if (tripleQuote) {
      if (char === quote && payload[index + 1] === quote && payload[index + 2] === quote) {
        output += quote + quote;
        index += 2;
        quote = undefined;
        tripleQuote = false;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) {
      quote = undefined;
    }
  }

  return converted ? output : undefined;
}

function escapePhysicalNewlinesInPythonStringLiterals(payload: string): string {
  let output = "";
  let quote: "'" | "\"" | undefined;
  let tripleQuote = false;
  let escaped = false;
  let inComment = false;

  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (char === undefined) {
      continue;
    }

    if (quote === undefined) {
      if (inComment) {
        output += char;
        if (char === "\n") {
          inComment = false;
        }
        continue;
      }
      if (char === "#") {
        inComment = true;
        output += char;
        continue;
      }
      if (char === "'" || char === "\"") {
        quote = char;
        if (payload[index + 1] === char && payload[index + 2] === char) {
          tripleQuote = true;
          output += char + char + char;
          index += 2;
          continue;
        }
        tripleQuote = false;
        output += char;
        continue;
      }
      output += char;
      continue;
    }

    if (tripleQuote) {
      output += char;
      if (char === quote && payload[index + 1] === quote && payload[index + 2] === quote) {
        output += quote + quote;
        index += 2;
        quote = undefined;
        tripleQuote = false;
      }
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === "\n") {
      output += "\\n";
      continue;
    }
    output += char;
    if (char === quote) {
      quote = undefined;
    }
  }

  return output;
}

function chooseHeredocLabel(content: string): string {
  for (const label of ["PY", "PYCODE", "KESTREL_PY"]) {
    if (!content.split("\n").some((line) => line.trim() === label)) {
      return label;
    }
  }
  return `KESTREL_PY_${content.length}`;
}
