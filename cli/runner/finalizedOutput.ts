import type { RunTurnResult } from "../runtime/KestrelChatRuntime.js";

export function extractFinalizedAssistantText(finalizedPayload: unknown): string | undefined {
  if (typeof finalizedPayload === "string") {
    const trimmed = finalizedPayload.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  const record = asRecord(finalizedPayload);
  if (record === undefined) {
    return undefined;
  }

  const message = asNonEmptyString(record.message);
  if (message !== undefined) {
    return message;
  }

  const content = asNonEmptyString(record.content);
  if (content !== undefined) {
    return content;
  }

  const text = asNonEmptyString(record.text);
  if (text !== undefined) {
    return text;
  }

  const data = asRecord(record.data);
  if (data !== undefined) {
    const nestedMessage = asNonEmptyString(data.message);
    if (nestedMessage !== undefined) {
      return nestedMessage;
    }
    const nestedText = asNonEmptyString(data.text);
    if (nestedText !== undefined) {
      return nestedText;
    }
  }

  return undefined;
}

export function summarizeRunTurnResult(result: RunTurnResult): {
  text: string;
  raw: unknown;
} {
  const text = extractFinalizedAssistantText(result.finalizedPayload);
  if (text !== undefined) {
    return {
      text,
      raw: result.finalizedPayload,
    };
  }

  if (result.finalizedPayload !== undefined) {
    return {
      text: safeStringify(result.finalizedPayload),
      raw: result.finalizedPayload,
    };
  }

  if (result.output.errors.length > 0) {
    return {
      text: result.output.errors.map((error) => `${error.code}: ${error.message}`).join("\n"),
      raw: result.output,
    };
  }

  if (result.output.status === "WAITING") {
    return {
      text: `Waiting for '${result.output.waitFor?.eventType ?? "input"}'.`,
      raw: result.output,
    };
  }

  return {
    text: "",
    raw: result.output,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
