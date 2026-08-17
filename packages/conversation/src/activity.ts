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
  reasoningKey?: string | undefined;
  toolName?: string | undefined;
  toolInput?: unknown;
  toolOutput?: unknown;
}

export const MAX_CONVERSATION_ACTIVITY_ITEMS = 80;

export function reduceConversationActivity(
  current: readonly ConversationActivityItem[],
  event: ConversationRuntimeEventLike,
): ConversationActivityItem[] {
  if (event.type === "run.started") return [];
  const update = readRecord(event.payload.update);
  if (!update) return [...current];
  const runId = readString(update.runId) ?? event.runId ?? "run";
  const timestamp = readString(update.ts) ?? event.ts;
  const sequence = readNumber(update.seq);

  if (event.type === "run.agent_progress") {
    return appendDistinct(current, {
      id: `agent-progress:${event.id}`,
      kind: "agent_progress",
      label: "Agent progress",
      text: readString(update.message) ?? "Working…",
      timestamp,
      status: "active",
      runId,
      ...(sequence !== undefined ? { sequence } : {}),
    });
  }
  if (event.type === "run.progress") {
    const text = readString(update.message);
    if (!text) return [...current];
    return appendDistinct(current, {
      id: `status:${event.id}`,
      kind: "status",
      label: "Runtime",
      text,
      timestamp,
      status: readString(update.phase) === "failed" ? "failed" : "completed",
      runId,
      ...(sequence !== undefined ? { sequence } : {}),
    });
  }
  if (event.type.startsWith("run.model.reasoning.")) {
    return reduceReasoning(current, event, update, runId, timestamp, sequence);
  }
  if (event.type === "run.tool.started" || event.type === "run.tool.completed" || event.type === "run.tool.failed") {
    const toolCallId = readString(update.toolCallId) ?? event.id;
    const toolName = readString(update.toolName) ?? "tool";
    const displayName = readString(update.displayName) ?? toolName;
    const identity = displayName === toolName ? toolName : `${displayName} (${toolName})`;
    const phase = event.type.slice("run.tool.".length);
    const error = readRecord(update.error);
    const failure = readString(error?.message);
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
) {
  const attempt = readNumber(update.attempt) ?? 0;
  const reasoningKey = `${runId}:${attempt}`;
  const phase = event.type.slice("run.model.reasoning.".length);
  const index = findLastIndex(current, (item) => item.kind === "reasoning" && item.reasoningKey === reasoningKey);
  const existing = index < 0 ? undefined : current[index];
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
    reasoningKey,
  };
  if (index < 0) return [...current, item].slice(-MAX_CONVERSATION_ACTIVITY_ITEMS);
  const next = [...current];
  next[index] = item;
  return next;
}

function appendDistinct(current: readonly ConversationActivityItem[], item: ConversationActivityItem) {
  const previous = current.at(-1);
  if (previous?.kind === item.kind && previous.text === item.text) return [...current];
  return [...current, item].slice(-MAX_CONVERSATION_ACTIVITY_ITEMS);
}

function upsert(current: readonly ConversationActivityItem[], item: ConversationActivityItem) {
  const index = current.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...current, item].slice(-MAX_CONVERSATION_ACTIVITY_ITEMS);
  const next = [...current];
  next[index] = { ...item, timestamp: current[index]!.timestamp };
  return next;
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
