export interface ConversationRuntimeEventLike {
  id: string;
  type: string;
  ts: string;
  runId?: string | undefined;
  payload: Record<string, unknown>;
}

export interface ConversationActivityItem {
  id: string;
  kind: "agent_progress" | "reasoning" | "tool" | "status";
  label: string;
  text: string;
  timestamp: string;
  status: "active" | "completed" | "failed";
  runId?: string | undefined;
  sequence?: number | undefined;
  sourceEventId?: string | undefined;
  runStartEventId?: string | undefined;
  reasoningKey?: string | undefined;
  toolName?: string | undefined;
  toolInput?: unknown;
  toolOutput?: unknown;
  /** Internal lifecycle markers remain in reducer state but are not presented by hosts. */
  visible?: boolean | undefined;
}

export const MAX_CONVERSATION_ACTIVITY_ITEMS = 80;

export function reduceConversationActivity(
  current: readonly ConversationActivityItem[],
  event: ConversationRuntimeEventLike,
): ConversationActivityItem[] {
  if (
    event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled"
  ) {
    const runId = event.runId ?? readTerminalRunId(event.payload);
    return runId === undefined
      ? [...current]
      : current.filter((item) => item.runId !== runId);
  }
  if (event.type === "run.started") {
    if (event.runId === undefined) return [...current];
    if (current.some((item) => item.sourceEventId === event.id || item.runStartEventId === event.id)) {
      return [...current];
    }
    const marker: ConversationActivityItem = {
      id: `run-start:${event.id}`,
      kind: "status",
      label: "Run",
      text: "Started",
      timestamp: event.ts,
      status: "active",
      runId: event.runId,
      sourceEventId: event.id,
      runStartEventId: event.id,
      visible: false,
    };
    return capActivity([
      ...current.filter((item) => item.runId !== event.runId),
      marker,
    ]);
  }
  const update = readRecord(event.payload.update);
  if (!update) return [...current];
  const runId = readString(update.runId) ?? event.runId ?? "run";
  const timestamp = readString(update.ts) ?? event.ts;
  const sequence = readNumber(update.seq);
  const runStartEventId = current.find((item) => item.runId === runId)?.runStartEventId;

  if (event.type === "run.agent_progress") {
    return upsertSequencedActivity(current, {
      id: `agent-progress:${event.id}`,
      kind: "agent_progress",
      label: "Agent progress",
      text: readString(update.message) ?? "Working…",
      timestamp,
      status: "active",
      runId,
      ...(sequence !== undefined ? { sequence } : {}),
      sourceEventId: event.id,
      ...(runStartEventId !== undefined ? { runStartEventId } : {}),
    });
  }
  if (event.type === "run.progress") {
    const text = readString(update.message);
    if (!text) return [...current];
    return upsertSequencedActivity(current, {
      id: `status:${event.id}`,
      kind: "status",
      label: "Runtime",
      text,
      timestamp,
      status: readString(update.phase) === "failed" ? "failed" : "completed",
      runId,
      ...(sequence !== undefined ? { sequence } : {}),
      sourceEventId: event.id,
      ...(runStartEventId !== undefined ? { runStartEventId } : {}),
    });
  }
  if (event.type.startsWith("run.model.reasoning.")) {
    return reduceReasoning(current, event, update, runId, timestamp, sequence, runStartEventId);
  }
  if (event.type === "run.tool.started" || event.type === "run.tool.completed" || event.type === "run.tool.failed") {
    const toolCallId = readString(update.toolCallId) ?? event.id;
    const toolName = readString(update.toolName) ?? "tool";
    const displayName = readString(update.displayName) ?? toolName;
    const identity = displayName === toolName ? toolName : `${displayName} (${toolName})`;
    const phase = event.type.slice("run.tool.".length);
    const error = readRecord(update.error);
    const failure = readString(error?.message);
    const existing = current.find((candidate) => candidate.id === `tool:${toolCallId}`);
    if (
      (existing !== undefined && existing.sourceEventId === event.id) ||
      (sequence !== undefined && existing?.sequence !== undefined && sequence < existing.sequence)
    ) return [...current];
    return upsert(current, {
      id: `tool:${toolCallId}`,
      kind: "tool",
      label: "Tool action",
      text: phase === "started"
        ? `Running ${identity}`
        : phase === "failed"
          ? `${identity} failed${failure ? `: ${failure}` : ""}`
          : `Completed ${identity}`,
      timestamp,
      status: phase === "failed" ? "failed" : phase === "completed" ? "completed" : "active",
      runId,
      ...(sequence !== undefined ? { sequence } : {}),
      sourceEventId: event.id,
      ...(runStartEventId !== undefined ? { runStartEventId } : {}),
      toolName,
      ...("input" in update ? { toolInput: update.input } : {}),
      ...("output" in update ? { toolOutput: update.output } : {}),
    });
  }
  return [...current];
}

function reduceReasoning(
  current: readonly ConversationActivityItem[],
  event: ConversationRuntimeEventLike,
  update: Record<string, unknown>,
  runId: string,
  timestamp: string,
  sequence: number | undefined,
  runStartEventId: string | undefined,
) {
  const attempt = readNumber(update.attempt) ?? 0;
  const reasoningKey = `${runId}:${attempt}`;
  const phase = event.type.slice("run.model.reasoning.".length);
  const index = findLastIndex(current, (item) => item.kind === "reasoning" && item.reasoningKey === reasoningKey);
  const existing = index < 0 ? undefined : current[index];
  if (
    (existing !== undefined && existing.sourceEventId === event.id) ||
    (sequence !== undefined && existing?.sequence !== undefined && sequence < existing.sequence)
  ) return [...current];
  if (phase === "started" && existing?.status === "active") return [...current];
  if (phase === "completed" || phase === "failed") {
    if (!existing) return [...current];
    const next = [...current];
    next[index] = {
      ...existing,
      status: phase === "failed" ? "failed" : "completed",
      ...(existing.text.length === 0
        ? { text: phase === "failed" ? "Provider reasoning failed before returning visible detail." : "Provider returned no visible reasoning detail." }
        : {}),
      ...(sequence !== undefined ? { sequence } : {}),
      sourceEventId: event.id,
      ...(runStartEventId !== undefined ? { runStartEventId } : {}),
    };
    return next;
  }
  const contentState = update.contentState === "not_retained" ? "not_retained" : "live";
  const delta = phase === "delta" && contentState === "live" ? readRawString(update.delta) : undefined;
  const format = readString(update.format) ?? "provider_reasoning_text";
  const label = phase === "unavailable"
    ? "Provider reasoning unavailable"
    : format === "summary"
      ? "Provider reasoning summary"
      : format === "provider_thinking"
        ? "Provider-visible thinking"
        : "Provider reasoning";
  const item: ConversationActivityItem = {
    id: existing?.id ?? `reasoning:${runId}:${attempt}`,
    kind: "reasoning",
    label,
    text: phase === "unavailable"
      ? "Provider reasoning is unavailable for this model."
      : contentState === "not_retained"
        ? "Provider reasoning is not retained for this run."
        : `${existing?.text ?? ""}${delta ?? ""}`,
    timestamp: existing?.timestamp ?? timestamp,
    status: phase === "unavailable" ? "completed" : "active",
    runId,
    ...(sequence !== undefined ? { sequence } : {}),
    sourceEventId: event.id,
    ...(runStartEventId !== undefined ? { runStartEventId } : {}),
    reasoningKey,
  };
  if (index < 0) return appendTransferred(current, item);
  const next = [...current];
  next[index] = item;
  return removeTransferredMarker(next, item);
}

function upsert(current: readonly ConversationActivityItem[], item: ConversationActivityItem) {
  const index = current.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return appendTransferred(current, item);
  const next = [...current];
  next[index] = { ...item, timestamp: current[index]!.timestamp };
  return removeTransferredMarker(next, item);
}

function upsertSequencedActivity(
  current: readonly ConversationActivityItem[],
  item: ConversationActivityItem,
): ConversationActivityItem[] {
  const next = upsert(current, item);
  const itemSequence = item.sequence;
  if (itemSequence === undefined || item.runId === undefined) return next;
  const currentIndex = next.findIndex((candidate) => candidate.id === item.id);
  if (currentIndex < 0) return next;
  const insertionIndex = next.findIndex((candidate, index) => {
    if (
      index === currentIndex
      || candidate.runId !== item.runId
      || (candidate.kind !== "agent_progress" && candidate.kind !== "status")
      || candidate.sequence === undefined
    ) return false;
    if (candidate.sequence !== itemSequence) return candidate.sequence > itemSequence;
    return (candidate.sourceEventId ?? candidate.id).localeCompare(item.sourceEventId ?? item.id) > 0;
  });
  if (insertionIndex < 0 || insertionIndex > currentIndex) return next;
  const reordered = [...next];
  const [sequenced] = reordered.splice(currentIndex, 1);
  if (sequenced !== undefined) reordered.splice(insertionIndex, 0, sequenced);
  return reordered;
}

function appendTransferred(
  current: readonly ConversationActivityItem[],
  item: ConversationActivityItem,
): ConversationActivityItem[] {
  return capActivity([...removeTransferredMarker(current, item), item]);
}

function removeTransferredMarker(
  current: readonly ConversationActivityItem[],
  item: ConversationActivityItem,
): ConversationActivityItem[] {
  if (item.runStartEventId === undefined) return [...current];
  return current.filter((candidate) => !(
    candidate.visible === false
    && candidate.sourceEventId === item.runStartEventId
  ));
}

function capActivity(items: readonly ConversationActivityItem[]): ConversationActivityItem[] {
  let visibleCount = 0;
  let hiddenCount = 0;
  const retained: ConversationActivityItem[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.visible === false) {
      if (hiddenCount >= MAX_CONVERSATION_ACTIVITY_ITEMS) continue;
      hiddenCount += 1;
    } else {
      if (visibleCount >= MAX_CONVERSATION_ACTIVITY_ITEMS) continue;
      visibleCount += 1;
    }
    retained.push(item);
  }
  retained.reverse();
  return retained;
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readRawString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTerminalRunId(payload: Record<string, unknown>): string | undefined {
  const result = readRecord(payload.result);
  const output = readRecord(result?.output);
  return readString(output?.runId);
}
