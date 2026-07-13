import { z } from "zod";

export type KestrelStreamEventForUi = {
  type: string;
  payload?: unknown;
};

export type KestrelTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "runner_error"
  | "empty";

export type KestrelStreamUiUpdate =
  | {
      kind: "progress";
      severity: "info" | "error";
      text: string;
      errorMessage: string | null;
    }
  | {
      kind: "terminal";
      severity: "info" | "error" | "cancelled";
      terminalStatus: KestrelTerminalStatus;
      text: string;
      errorMessage: string | null;
    };

const runnerEventSchema = z
  .object({
    type: z.string().min(1),
    payload: z.unknown().optional(),
  })
  .passthrough();

export function createKestrelStreamUiUpdateFilter() {
  let lastProgressText = "";

  return {
    read(event: KestrelStreamEventForUi) {
      const update = getKestrelStreamUiUpdate(event);
      if (!update) {
        return null;
      }

      if (update.kind === "terminal") {
        return update;
      }

      if (update.text === lastProgressText) {
        return null;
      }

      lastProgressText = update.text;
      return update;
    },
  };
}

export function getKestrelStreamUiUpdate(
  event: KestrelStreamEventForUi
): KestrelStreamUiUpdate | null {
  const parsedEvent = runnerEventSchema.safeParse(event);
  if (!parsedEvent.success) {
    return null;
  }
  const parsed = parsedEvent.data;

  if (parsed.type === "run.completed") {
    const terminalText = getKestrelStreamTerminalText(parsed);
    return {
      kind: "terminal",
      severity: "info",
      terminalStatus: terminalText ? "completed" : "empty",
      text: terminalText,
      errorMessage: null,
    };
  }

  if (parsed.type === "run.failed") {
    const payload = parsed.payload as { error?: { message?: unknown } };
    const errorMessage = typeof payload.error?.message === "string"
      ? payload.error.message
      : "The run failed before it produced a final assistant message.";
    return {
      kind: "terminal",
      severity: "error",
      terminalStatus: "failed",
      text: "",
      errorMessage,
    };
  }

  if (parsed.type === "run.cancelled") {
    return {
      kind: "terminal",
      severity: "cancelled",
      terminalStatus: "cancelled",
      text: "",
      errorMessage: "The run was cancelled before it finished.",
    };
  }

  const progressText = getKestrelStreamProgressText(parsed);
  if (progressText) {
    const isError = parsed.type === "runner.error";
    return {
      kind: "progress",
      severity: isError ? "error" : "info",
      text: progressText,
      errorMessage: isError ? progressText : null,
    };
  }

  return null;
}

export function getKestrelStreamTerminalText(event: KestrelStreamEventForUi) {
  if (event.type === "run.completed") {
    const payload = event.payload as {
      result?: { assistantText?: unknown };
    };
    return asNonEmptyString(payload.result?.assistantText) ?? "";
  }

  return "";
}

export function getKestrelStreamProgressText(event: KestrelStreamEventForUi) {
  if (event.type === "run.started") {
    return "Started the Kestrel run.";
  }

  if (event.type === "run.progress") {
    const payload = asRecord(event.payload);
    const update = asRecord(payload?.update);
    return (
      readProgressMessage(update) ??
      readProgressMessage(payload) ??
      ""
    );
  }

  if (event.type === "run.reasoning") {
    const payload = asRecord(event.payload);
    const update = asRecord(payload?.update);
    return asNonEmptyString(update?.message) ?? asNonEmptyString(payload?.message) ?? "";
  }

  if (event.type === "runner.error") {
    const payload = asRecord(event.payload);
    return asNonEmptyString(payload?.message) ?? "The Kestrel runtime stream failed.";
  }

  return "";
}

function readProgressMessage(
  update: Record<string, unknown> | undefined
): string | undefined {
  if (!update) {
    return undefined;
  }

  const message = asNonEmptyString(update.message);
  const tool = asRecord(update.tool);
  const toolName = asNonEmptyString(tool?.name);
  const toolStatus = asNonEmptyString(tool?.status);

  if (toolName && toolStatus) {
    return formatToolProgress(toolName, toolStatus);
  }

  return message;
}

function formatToolProgress(toolName: string, status: string) {
  const normalizedStatus = status.trim().toLowerCase();

  if (toolName === "kestrel_one.search_knowledge_documents") {
    if (
      normalizedStatus === "started" ||
      normalizedStatus === "running" ||
      normalizedStatus === "input-available"
    ) {
      return "Searching organization knowledge.";
    }
    if (
      normalizedStatus === "completed" ||
      normalizedStatus === "complete" ||
      normalizedStatus === "success" ||
      normalizedStatus === "succeeded"
    ) {
      return "Finished searching organization knowledge.";
    }
    if (normalizedStatus === "failed" || normalizedStatus === "error") {
      return "Knowledge search failed.";
    }
  }

  return `Tool ${toolName}: ${normalizedStatus}.`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
