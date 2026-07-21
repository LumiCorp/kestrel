import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import type { DesktopUserTerminal, DesktopUserTerminalReadResult } from "./contracts.js";
import { createDesktopError } from "./errors.js";

type ControlAdapter = Pick<WebRunnerAdapter, "sendControl">;

export async function runDesktopUserTerminalCommand(input: {
  adapter: ControlAdapter;
  request: unknown;
  operation: "start" | "list" | "read" | "write" | "resize" | "stop";
  context: WebRunnerRequestContext;
}): Promise<DesktopUserTerminal | DesktopUserTerminal[] | DesktopUserTerminalReadResult> {
  const request = objectInput(input.request);
  const sessionId = requiredString(request.sessionId, "sessionId");
  const terminalId = input.operation === "start" || input.operation === "list"
    ? undefined
    : requiredString(request.terminalId, "terminalId");
  const command = input.operation === "start"
    ? { type: "user.terminal.start" as const, sessionId, threadId: requiredString(request.threadId, "threadId"), ...optionalDimensions(request) }
    : input.operation === "list"
      ? { type: "user.terminal.list" as const, sessionId, ...(typeof request.threadId === "string" ? { threadId: requiredString(request.threadId, "threadId") } : {}) }
      : input.operation === "read"
        ? { type: "user.terminal.read" as const, sessionId, terminalId: terminalId!, ...(request.cursor !== undefined ? { cursor: integer(request.cursor, "cursor", 0) } : {}) }
        : input.operation === "write"
          ? { type: "user.terminal.write" as const, sessionId, terminalId: terminalId!, data: terminalData(request.data) }
          : input.operation === "resize"
            ? { type: "user.terminal.resize" as const, sessionId, terminalId: terminalId!, cols: integer(request.cols, "cols", 2, 1000), rows: integer(request.rows, "rows", 2, 1000) }
            : { type: "user.terminal.stop" as const, sessionId, terminalId: terminalId! };
  const event = await input.adapter.sendControl(command, input.context);
  if (event.type !== "user.terminal" || event.payload.sessionId !== sessionId || event.payload.operation !== input.operation) {
    throw terminalError("DESKTOP_USER_TERMINAL_RESPONSE_INVALID", "Local Core returned an invalid user terminal response.");
  }
  if (input.operation === "list") {
    if (!Array.isArray(event.payload.terminals)) throw terminalError("DESKTOP_USER_TERMINAL_RESPONSE_INVALID", "Terminal list is missing.");
    return event.payload.terminals;
  }
  if (input.operation === "read") {
    if (!event.payload.terminal || typeof event.payload.output !== "string" || typeof event.payload.nextCursor !== "number") throw terminalError("DESKTOP_USER_TERMINAL_RESPONSE_INVALID", "Terminal output is missing.");
    return { terminal: event.payload.terminal, output: event.payload.output, cursor: event.payload.cursor ?? 0, nextCursor: event.payload.nextCursor, truncated: event.payload.truncated === true };
  }
  if (!event.payload.terminal) throw terminalError("DESKTOP_USER_TERMINAL_RESPONSE_INVALID", "Terminal record is missing.");
  return event.payload.terminal;
}

function objectInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw terminalError("DESKTOP_USER_TERMINAL_INPUT_INVALID", "Terminal request must be an object.");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw terminalError("DESKTOP_USER_TERMINAL_INPUT_INVALID", `${label} must be a non-empty string.`);
  return value;
}

function integer(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw terminalError("DESKTOP_USER_TERMINAL_INPUT_INVALID", `${label} is outside the allowed range.`);
  return Number(value);
}

function terminalData(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw terminalError("DESKTOP_USER_TERMINAL_INPUT_INVALID", "data must contain at most 64 KB.");
  }
  return value;
}

function terminalError(code: string, message: string): Error {
  return createDesktopError({ code, message });
}

function optionalDimensions(record: Record<string, unknown>): { cols?: number; rows?: number } {
  return {
    ...(record.cols !== undefined ? { cols: integer(record.cols, "cols", 2, 1000) } : {}),
    ...(record.rows !== undefined ? { rows: integer(record.rows, "rows", 2, 1000) } : {}),
  };
}
