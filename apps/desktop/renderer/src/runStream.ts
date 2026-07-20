import type { DesktopRunnerEvent } from "../../src/contracts";

export interface DesktopRunStreamItem {
  id: string;
  kind: "assistant" | "reasoning" | "tool" | "status";
  label: string;
  text: string;
  timestamp: string;
  status: "active" | "completed" | "failed";
}

const MAX_STREAM_ITEMS = 80;

export function projectDesktopRunStream(
  current: readonly DesktopRunStreamItem[],
  event: DesktopRunnerEvent,
): DesktopRunStreamItem[] {
  if (event.type === "run.started") return [];
  const update = readRecord((event.payload as { update?: unknown }).update);
  if (update === undefined) return [...current];

  if (event.type === "run.agent_progress") {
    return appendDistinct(current, {
      id: `assistant:${event.id}`,
      kind: "assistant",
      label: "Kestrel",
      text: readString(update.message) ?? "Working…",
      timestamp: readString(update.ts) ?? event.ts,
      status: "active",
    });
  }

  if (event.type === "run.progress") {
    return [...current];
  }

  if (event.type.startsWith("run.model.reasoning.")) {
    const runId = readString(update.runId) ?? event.runId ?? "run";
    const attempt = typeof update.attempt === "number" ? update.attempt : 0;
    const format = readString(update.format) ?? "provider_reasoning_text";
    const id = `reasoning:${runId}:${attempt}:${format}`;
    const phase = event.type.slice("run.model.reasoning.".length);
    const existing = current.find((item) => item.id === id);
    const contentState = update.contentState === "not_retained" ? "not_retained" : "live";
    const delta = phase === "delta" && contentState === "live" ? readString(update.delta) : undefined;
    const text = contentState === "not_retained"
      ? "Provider reasoning is not retained for this run."
      : `${existing?.text ?? ""}${delta ?? ""}`;
    return upsert(current, {
      id,
      kind: "reasoning",
      label: update.format === "summary" ? "Reasoning summary" : "Reasoning",
      text,
      timestamp: readString(update.ts) ?? event.ts,
      status: phase === "failed" ? "failed" : phase === "completed" || phase === "unavailable" ? "completed" : "active",
    });
  }

  if (event.type === "run.tool.started" || event.type === "run.tool.completed" || event.type === "run.tool.failed") {
    const toolCallId = readString(update.toolCallId) ?? event.id;
    const toolName = readString(update.displayName) ?? readString(update.toolName) ?? "tool";
    const phase = event.type.slice("run.tool.".length);
    const error = readRecord(update.error);
    const failure = readString(error?.message);
    return upsert(current, {
      id: `tool:${toolCallId}`,
      kind: "tool",
      label: "Tool",
      text: phase === "started"
        ? `Running ${toolName}`
        : phase === "failed"
          ? `${toolName} failed${failure === undefined ? "" : `: ${failure}`}`
          : `Completed ${toolName}`,
      timestamp: readString(update.ts) ?? event.ts,
      status: phase === "failed" ? "failed" : phase === "completed" ? "completed" : "active",
    });
  }

  return [...current];
}

function appendDistinct(
  current: readonly DesktopRunStreamItem[],
  item: DesktopRunStreamItem,
): DesktopRunStreamItem[] {
  const previous = current.at(-1);
  if (previous?.kind === item.kind && previous.text === item.text) return [...current];
  return [...current, item].slice(-MAX_STREAM_ITEMS);
}

function upsert(
  current: readonly DesktopRunStreamItem[],
  item: DesktopRunStreamItem,
): DesktopRunStreamItem[] {
  const index = current.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...current, item].slice(-MAX_STREAM_ITEMS);
  const next = [...current];
  next[index] = item;
  return next;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
