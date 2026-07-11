import type { RunnerEvent } from "../contracts.js";

interface RunnerSseError extends Error {
  code: string;
  details?: Record<string, unknown> | undefined;
}

export async function consumeSseEventPayloads(
  response: Response,
  onMessage: (eventType: string, data: string) => void,
): Promise<void> {
  if (response.body === null) {
    throw createRunnerSseError("KESTREL_SSE_BODY_UNREADABLE", "SSE response body is empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let data = "";

  const flushEvent = () => {
    if (data.length === 0) {
      eventType = "";
      return;
    }
    onMessage(eventType, data);
    eventType = "";
    data = "";
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n");
    while (boundary >= 0) {
      const rawLine = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) {
        flushEvent();
      } else if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        const next = line.slice("data:".length).trim();
        data = data.length === 0 ? next : `${data}\n${next}`;
      }
      boundary = buffer.indexOf("\n");
    }
  }

  const trailing = buffer.trim();
  if (trailing.length > 0) {
    const lines = trailing.split(/\r?\n/u);
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        const next = line.slice("data:".length).trim();
        data = data.length === 0 ? next : `${data}\n${next}`;
      }
    }
  }

  flushEvent();
}

export function parseRunnerEvent(value: string): RunnerEvent | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.type !== "string" ||
    typeof record.ts !== "string" ||
    record.payload === undefined
  ) {
    return undefined;
  }
  return parsed as RunnerEvent;
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
