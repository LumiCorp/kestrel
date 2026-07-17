export type DevShellLifecycleKind = "start" | "read" | "write" | "stop" | "unknown";
export type DevShellLifecycleStatus = "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT" | "STOPPED";

export interface DevShellLifecycleFacts {
  toolName: string;
  kind: DevShellLifecycleKind;
  status?: DevShellLifecycleStatus | undefined;
  processId?: string | undefined;
  sessionId?: string | undefined;
  command?: string | undefined;
  stdin?: string | undefined;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
  outputText?: string | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  exitCode?: number | undefined;
  truncated?: boolean | undefined;
  cursor?: number | undefined;
}

export function isDevShellLifecycleTool(toolName: string): boolean {
  return toolName === "exec_command" ||
    toolName === "dev.shell.run" ||
    toolName === "dev.process.start" ||
    toolName === "dev.process.read" ||
    toolName === "dev.process.write" ||
    toolName === "dev.process.write_and_read" ||
    toolName === "dev.process.stop";
}

export function normalizeDevShellLifecycle(
  toolName: string,
  input: unknown,
  output: unknown,
): DevShellLifecycleFacts | undefined {
  if (isDevShellLifecycleTool(toolName) === false) {
    return ;
  }
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(output);
  const processId = readProcessId(toolName, inputRecord, outputRecord);
  const sessionId = readSessionId(toolName, inputRecord, outputRecord, processId);
  return removeUndefined({
    toolName,
    kind: readLifecycleKind(toolName, inputRecord),
    status: normalizeDevShellLifecycleStatus(asString(outputRecord?.status)),
    processId,
    sessionId,
    command: firstString(outputRecord?.command, inputRecord?.command),
    stdin: readStdin(toolName, inputRecord),
    cwd: firstString(outputRecord?.cwd, inputRecord?.cwd),
    workspaceRoot: firstString(outputRecord?.workspaceRoot, inputRecord?.workspaceRoot),
    outputText: firstString(outputRecord?.output, outputRecord?.text, outputRecord?.chunk),
    stdout: asString(outputRecord?.stdout),
    stderr: asString(outputRecord?.stderr),
    exitCode: typeof outputRecord?.exitCode === "number" ? Math.trunc(outputRecord.exitCode) : undefined,
    truncated: typeof outputRecord?.truncated === "boolean" ? outputRecord.truncated : undefined,
    cursor: firstNumber(outputRecord?.cursor, outputRecord?.nextCursor),
  });
}

export function normalizeDevShellLifecycleStatus(value: string | undefined): DevShellLifecycleStatus | undefined {
  if (value === undefined) {
    return ;
  }
  switch (value.trim().toUpperCase()) {
    case "RUNNING":
      return "RUNNING";
    case "COMPLETED":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    case "TIMEOUT":
    case "TIMED_OUT":
      return "TIMEOUT";
    case "STOPPED":
    case "LOST":
      return "STOPPED";
    default:
      return ;
  }
}

function readLifecycleKind(
  toolName: string,
  input: Record<string, unknown> | undefined,
): DevShellLifecycleKind {
  switch (toolName) {
    case "dev.shell.run":
    case "dev.process.start":
      return "start";
    case "dev.process.read":
      return "read";
    case "dev.process.write":
    case "dev.process.write_and_read":
      return "write";
    case "dev.process.stop":
      return "stop";
    case "exec_command":
      if (asString(input?.command) !== undefined) {
        return "start";
      }
      if (input?.stop === true) {
        return "stop";
      }
      if (Object.hasOwn(input ?? {}, "stdin")) {
        return "write";
      }
      if (asString(input?.sessionId) !== undefined) {
        return "read";
      }
      return "unknown";
    default:
      return "unknown";
  }
}

function readProcessId(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: Record<string, unknown> | undefined,
): string | undefined {
  return firstString(
    output?.processId,
    toolName === "exec_command" ? output?.sessionId : undefined,
    input?.processId,
    toolName === "exec_command" ? input?.sessionId : undefined,
  );
}

function readSessionId(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: Record<string, unknown> | undefined,
  processId: string | undefined,
): string | undefined {
  if (toolName !== "exec_command") {
    return ;
  }
  return firstString(output?.sessionId, input?.sessionId, processId);
}

function readStdin(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (toolName === "exec_command") {
    return asString(input?.stdin);
  }
  if (toolName === "dev.process.write" || toolName === "dev.process.write_and_read") {
    return firstString(input?.data, input?.input, input?.chars);
  }
  return ;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text !== undefined) {
      return text;
    }
  }
  return ;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
  }
  return ;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      output[key] = item;
    }
  }
  return output as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
