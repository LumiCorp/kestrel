import { parseRunnerEventV2 } from "@kestrel-agents/protocol";

import type { RunnerEvent } from "../contracts.js";
import { KestrelProtocolError } from "../errors.js";

interface RunnerSseError extends Error {
  code: string;
  details?: Record<string, unknown> | undefined;
}

export async function consumeSseEventPayloads(
  response: Response,
  onMessage: (eventType: string, data: string) => void | boolean,
): Promise<void> {
  if (response.body === null) {
    throw createRunnerSseError("KESTREL_SSE_BODY_UNREADABLE", "SSE response body is empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new RunnerSseParser(onMessage);

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      if (parser.push(decoder.decode()) === false) {
        return;
      }
      break;
    }
    if (parser.push(decoder.decode(chunk.value, { stream: true })) === false) {
      await reader.cancel();
      return;
    }
  }

  parser.finish();
}

export function parseRunnerEvent(value: string): RunnerEvent | undefined {
  if (value.trim().length === 0) {
    return ;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return ;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return ;
  }
  try {
    return parseRunnerEventV2(parsed) as RunnerEvent;
  } catch (error) {
    const eventType = typeof (parsed as Record<string, unknown>).type === "string"
      ? String((parsed as Record<string, unknown>).type)
      : "unknown";
    throw new KestrelProtocolError(
      `Invalid runner event: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "RUNNER_PROTOCOL_INVALID",
        details: { eventType },
      },
    );
  }
}

export class RunnerSseParser {
  private buffer = "";
  private eventType = "";
  private data = "";
  private stopped = false;

  constructor(
    private readonly onMessage: (eventType: string, data: string) => void | boolean,
  ) {}

  push(chunk: string): boolean {
    if (this.stopped) {
      return false;
    }
    this.buffer += chunk;
    let boundary = this.buffer.indexOf("\n");
    while (boundary >= 0 && this.stopped === false) {
      const rawLine = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      this.consumeLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
      boundary = this.buffer.indexOf("\n");
    }
    return this.stopped === false;
  }

  finish(): boolean {
    if (this.stopped) {
      return false;
    }
    if (this.buffer.length > 0) {
      const rawLine = this.buffer;
      this.buffer = "";
      this.consumeLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
    }
    this.flushEvent();
    return this.stopped === false;
  }

  private consumeLine(line: string): void {
    if (line.length === 0) {
      this.flushEvent();
      return;
    }
    if (line.startsWith("event:")) {
      this.eventType = line.slice("event:".length).trim();
      return;
    }
    if (line.startsWith("data:")) {
      const next = line.slice("data:".length).trim();
      this.data = this.data.length === 0 ? next : `${this.data}\n${next}`;
    }
  }

  private flushEvent(): void {
    if (this.data.length > 0) {
      this.stopped = this.onMessage(this.eventType, this.data) === false;
    }
    this.eventType = "";
    this.data = "";
  }
}

function createRunnerSseError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RunnerSseError {
  const error = new Error(message) as RunnerSseError;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}
