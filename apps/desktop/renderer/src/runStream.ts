import type { DesktopRunnerEvent } from "../../src/contracts";
import type { RendererTranscriptLine } from "./state";

export interface DesktopRunStreamItem {
  id: string;
  kind: "assistant" | "reasoning" | "tool" | "status";
  label: string;
  text: string;
  timestamp: string;
  status: "active" | "completed" | "failed";
  reasoningKey?: string | undefined;
}

export type DesktopConversationTimelineItem =
  | {
      id: string;
      type: "transcript";
      line: RendererTranscriptLine;
    }
  | {
      id: string;
      type: "run_stream";
      item: DesktopRunStreamItem;
    };

const MAX_STREAM_ITEMS = 80;

export function projectDesktopConversationTimeline(
  transcript: readonly RendererTranscriptLine[],
  runStream: readonly DesktopRunStreamItem[],
): DesktopConversationTimelineItem[] {
  const activeTurnStart = findLastIndex(transcript, (line) => line.role === "user");
  const beforeRun = transcript.slice(0, activeTurnStart + 1);
  const afterRun = transcript.slice(activeTurnStart + 1);
  return [
    ...beforeRun.map(toTranscriptTimelineItem),
    ...runStream.map((item) => ({
      id: `run-stream:${item.id}`,
      type: "run_stream" as const,
      item,
    })),
    ...afterRun.map((line, index) => toTranscriptTimelineItem(line, activeTurnStart + 1 + index)),
  ];
}

export function projectDesktopRunStream(
  current: readonly DesktopRunStreamItem[],
  event: DesktopRunnerEvent,
): DesktopRunStreamItem[] {
  if (event.type === "run.started") return [];
  const update = readRecord((event.payload as { update?: unknown }).update);
  if (update === undefined) return [...current];
  const runId = readString(update.runId) ?? event.runId ?? "run";

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
    const attempt = typeof update.attempt === "number" ? update.attempt : 0;
    const format = readString(update.format) ?? "provider_reasoning_text";
    const reasoningKey = `${runId}:${attempt}:${format}`;
    const phase = event.type.slice("run.model.reasoning.".length);
    if (phase === "completed" || phase === "failed") {
      return completeMostRecentReasoning(
        current,
        reasoningKey,
        phase === "failed" ? "failed" : "completed",
      );
    }
    const contentState = update.contentState === "not_retained" ? "not_retained" : "live";
    const delta = phase === "delta" && contentState === "live" ? readString(update.delta) : undefined;
    const last = current.at(-1);
    const continuesTail = phase !== "started"
      && last?.kind === "reasoning"
      && last.reasoningKey === reasoningKey
      && last.status === "active";
    const text = contentState === "not_retained"
      ? "Provider reasoning is not retained for this run."
      : `${continuesTail ? last.text : ""}${delta ?? ""}`;
    const item: DesktopRunStreamItem = {
      id: continuesTail ? last.id : `reasoning:${event.id}`,
      kind: "reasoning",
      label: update.format === "summary" ? "Reasoning summary" : "Reasoning",
      text,
      timestamp: readString(update.ts) ?? event.ts,
      status: phase === "unavailable" ? "completed" : "active",
      reasoningKey,
    };
    if (continuesTail) return replaceLast(current, item);
    return [...current, item].slice(-MAX_STREAM_ITEMS);
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

export function describeDesktopRunnerActivity(event: DesktopRunnerEvent): string {
  if (event.type === "run.progress") {
    const update = readRecord(event.payload.update);
    return readString(update?.message) ?? "Runtime active";
  }
  if (event.type === "run.agent_progress") {
    const update = readRecord(event.payload.update);
    return readString(update?.message) ?? "Working";
  }
  return "";
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
  next[index] = { ...item, timestamp: next[index]!.timestamp };
  return next;
}

function replaceLast(
  current: readonly DesktopRunStreamItem[],
  item: DesktopRunStreamItem,
): DesktopRunStreamItem[] {
  return [...current.slice(0, -1), item];
}

function completeMostRecentReasoning(
  current: readonly DesktopRunStreamItem[],
  reasoningKey: string,
  status: "completed" | "failed",
): DesktopRunStreamItem[] {
  const index = findLastIndex(current, (item) => (
    item.kind === "reasoning"
    && item.reasoningKey === reasoningKey
    && item.status === "active"
  ));
  if (index < 0) return [...current];
  const next = [...current];
  next[index] = { ...next[index]!, status };
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

function toTranscriptTimelineItem(
  line: RendererTranscriptLine,
  index: number,
): DesktopConversationTimelineItem {
  return {
    id: `transcript:${index}:${line.timestamp}`,
    type: "transcript",
    line,
  };
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}
