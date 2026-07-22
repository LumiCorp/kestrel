import type { RunConsoleUpdateV1 } from "../kestrel/contracts/events.js";
import type { ConsoleReporter } from "../kestrel/contracts/execution.js";
import type { ToolConsoleSink } from "../kestrel/contracts/model-io.js";

import {
  isDevShellConsoleTool,
  readConsoleCommand,
  readConsoleCwd,
  readConsoleExitCode,
  readConsoleProcessId,
  takeUtf8Prefix,
} from "./ExecutionEngineSupport.js";

const DEV_SHELL_CONSOLE_CHUNK_MAX_BYTES = 8192;
const DEV_SHELL_CONSOLE_TOTAL_MAX_BYTES = 65_536;

export function createToolConsoleBridge(input: {
  consoleReporter: ConsoleReporter | undefined;
  runId: string;
  sessionId: string;
  stepIndex: number;
  toolCallId: string;
  toolName: string;
  input: unknown;
  sequence: () => number;
}): {
  sink: ToolConsoleSink | undefined;
  emitStatus: (status: "started" | "completed", result?: unknown) => Promise<void>;
} {
  if (input.consoleReporter === undefined || isDevShellConsoleTool(input.toolName) === false) {
    return {
      sink: undefined,
      emitStatus: async () => {},
    };
  }

  let emittedBytes = 0;
  let truncated = false;
  const emitUpdate = async (
    partial: Omit<RunConsoleUpdateV1, "version" | "runId" | "sessionId" | "ts" | "seq" | "toolName">,
  ): Promise<void> => {
    await input.consoleReporter?.emit({
      version: "v1",
      runId: input.runId,
      sessionId: input.sessionId,
      ts: new Date().toISOString(),
      seq: input.sequence(),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      ...partial,
    });
  };
  const emitTruncated = async (): Promise<void> => {
    if (truncated) {
      return;
    }
    truncated = true;
    await emitUpdate({
      status: "truncated",
      truncated: true,
      text: "\n[console output truncated]\n",
    });
  };
  const sink: ToolConsoleSink = async (event) => {
    if (event.text.length === 0) {
      return;
    }
    if (truncated) {
      return;
    }
    const remainingBytes = DEV_SHELL_CONSOLE_TOTAL_MAX_BYTES - emittedBytes;
    if (remainingBytes <= 0) {
      await emitTruncated();
      return;
    }
    const limited = takeUtf8Prefix(
      event.text,
      Math.min(DEV_SHELL_CONSOLE_CHUNK_MAX_BYTES, remainingBytes),
    );
    if (limited.text.length === 0) {
      await emitTruncated();
      return;
    }
    emittedBytes += limited.byteLength;
    await emitUpdate({
      status: event.status,
      channel: event.channel,
      text: limited.text,
      byteLength: limited.byteLength,
      cursor: event.cursor,
      nextCursor: event.nextCursor,
      processId: event.processId,
      command: event.command ?? readConsoleCommand(input.input),
      cwd: event.cwd ?? readConsoleCwd(input.input),
      truncated: event.truncated === true || limited.truncated,
    });
    if (event.truncated === true || limited.truncated || emittedBytes >= DEV_SHELL_CONSOLE_TOTAL_MAX_BYTES) {
      await emitTruncated();
    }
  };

  return {
    sink,
    emitStatus: async (status, result) => {
      const completedOutput = readAgentToolOutput(result);
      await emitUpdate({
        status,
        command: readConsoleCommand(input.input),
        cwd: readConsoleCwd(input.input),
        processId: readConsoleProcessId(completedOutput) ?? readConsoleProcessId(input.input),
        exitCode: readConsoleExitCode(completedOutput),
      });
    },
  };
}

function readAgentToolOutput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const auditRecord = (value as Record<string, unknown>).auditRecord;
  if (typeof auditRecord !== "object" || auditRecord === null || Array.isArray(auditRecord)) {
    return value;
  }
  return (auditRecord as Record<string, unknown>).output;
}

export async function emitDevShellConsoleStatus(input: {
  consoleReporter: ConsoleReporter | undefined;
  runId: string;
  sessionId: string;
  seq: number;
  toolName: string;
  input: unknown;
  status: "failed";
}): Promise<void> {
  if (input.consoleReporter === undefined || isDevShellConsoleTool(input.toolName) === false) {
    return;
  }
  await input.consoleReporter.emit({
    version: "v1",
    runId: input.runId,
    sessionId: input.sessionId,
    ts: new Date().toISOString(),
    seq: input.seq,
    toolName: input.toolName,
    status: input.status,
    command: readConsoleCommand(input.input),
    cwd: readConsoleCwd(input.input),
    processId: readConsoleProcessId(input.input),
  });
}
