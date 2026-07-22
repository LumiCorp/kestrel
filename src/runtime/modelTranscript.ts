import type { ModelMessage } from "../kestrel/contracts/model-io.js";
import { buildAgentToolSuccessResult, isAgentToolResult } from "../../tools/toolResult.js";

import { renderVisibleTodosForModel, type VisibleTodoState } from "./visibleTodos.js";

export { buildRuntimeContextFragment } from "./agent-context/runtimeContext.js";

export type ModelTranscriptItemKind =
  | "user"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "correction"
  | "todo_update"
  | "compaction_summary";

export interface ModelTranscriptItem {
  id: string;
  createdAt: string;
  kind: ModelTranscriptItemKind;
  content?: string | undefined;
  toolName?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  toolOutput?: unknown | undefined;
  toolCallId?: string | undefined;
  rawOutputRef?: string | undefined;
  truncated?: boolean | undefined;
}

export interface ModelTranscript {
  version: 1;
  windowId: number;
  items: ModelTranscriptItem[];
  compactions?: ModelTranscriptCompactionRecord[] | undefined;
}

export interface ModelTranscriptCompactionRecord {
  id: string;
  createdAt: string;
  summaryItemId: string;
  replacedItemIds: string[];
  retainedItemIds: string[];
}

export interface ModelTranscriptCompactionPlan {
  retainedItems: ModelTranscriptItem[];
  replacedItems: ModelTranscriptItem[];
}

export interface ModelTranscriptValidationResult {
  ok: boolean;
  value?: ModelTranscript | undefined;
  error?: { path: string; message: string } | undefined;
}

const MAX_TRANSCRIPT_ITEMS = 120;

export function normalizeModelTranscript(value: unknown): ModelTranscript | undefined {
  const record = asRecord(value);
  if (record === undefined || record.version !== 1 || Array.isArray(record.items) === false) {
    return ;
  }
  const windowId = typeof record.windowId === "number" && Number.isFinite(record.windowId)
    ? Math.max(1, Math.trunc(record.windowId))
    : 1;
  const items = limitTranscriptItems(dedupeTranscriptItemsById(asArray(record.items)
    .map(normalizeTranscriptItem)
    .filter((item): item is ModelTranscriptItem => item !== undefined)));
  const compactions = normalizeCompactions(record.compactions);
  return {
    version: 1,
    windowId,
    items,
    ...(compactions.length > 0 ? { compactions } : {}),
  };
}

export function validateModelTranscript(value: unknown): ModelTranscriptValidationResult {
  const transcript = normalizeModelTranscript(value);
  if (transcript === undefined) {
    return {
      ok: false,
      error: {
        path: "state.agent.modelTranscript",
        message: "state.agent.modelTranscript must be a versioned transcript object",
      },
    };
  }
  return { ok: true, value: transcript };
}

export function readActiveTaskGoalFromTranscript(value: unknown): string | undefined {
  const transcript = normalizeModelTranscript(value);
  if (transcript === undefined) {
    return ;
  }
  return readActiveTaskItemFromTranscript(transcript)?.content?.trim();
}

export function readActiveTaskItemIdFromTranscript(value: unknown): string | undefined {
  const transcript = normalizeModelTranscript(value);
  if (transcript === undefined) {
    return ;
  }
  return readActiveTaskItemFromTranscript(transcript)?.id;
}

export function appendModelTranscriptItems(
  value: unknown,
  items: ModelTranscriptItem[],
): ModelTranscript {
  const transcript = normalizeModelTranscript(value) ?? { version: 1, windowId: 1, items: [] };
  const startIndex = nextTranscriptOrdinal(transcript.items, transcript.windowId);
  const normalizedItems = items.map((item, index) =>
    assignTranscriptItemIdentity(item, transcript.windowId, startIndex + index + 1)
  );
  return {
    ...transcript,
    items: limitTranscriptItems(dedupeTranscriptItemsById([...transcript.items, ...normalizedItems])),
  };
}

export function makeModelTranscriptItem(
  kind: ModelTranscriptItemKind,
  input: Omit<ModelTranscriptItem, "id" | "createdAt" | "kind"> & { stepIndex?: number | undefined } = {},
): ModelTranscriptItem {
  const createdAt = new Date().toISOString();
  const { stepIndex: _stepIndex, ...rest } = input;
  return {
    id: `pending_${kind}_${input.stepIndex ?? "x"}`,
    createdAt,
    kind,
    ...rest,
  };
}

export function appendUserTurnToTranscript(input: {
  transcript: unknown;
  message: string;
  stepIndex?: number | undefined;
}): ModelTranscript {
  const message = input.message.trim();
  if (message.length === 0) {
    return normalizeModelTranscript(input.transcript) ?? { version: 1, windowId: 1, items: [] };
  }
  const current = normalizeModelTranscript(input.transcript);
  if (
    current !== undefined &&
    current.items.some((item) => item.kind === "user" && item.content?.trim() === message)
  ) {
    return current;
  }
  return appendModelTranscriptItems(input.transcript, [
    makeModelTranscriptItem("user", {
      content: message,
      stepIndex: input.stepIndex,
    }),
  ]);
}

export function appendAssistantToolCallsToTranscript(input: {
  transcript: unknown;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string | undefined }>;
  stepIndex?: number | undefined;
}): ModelTranscript {
  return appendModelTranscriptItems(input.transcript, input.toolCalls.map((toolCall) =>
    makeModelTranscriptItem("tool_call", {
      toolName: toolCall.name,
      toolInput: toolCall.input,
      ...(toolCall.id !== undefined ? { toolCallId: toolCall.id } : {}),
      stepIndex: input.stepIndex,
    })
  ));
}

export function appendToolResultToTranscript(input: {
  transcript: unknown;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  stepIndex?: number | undefined;
  toolCallId?: string | undefined;
}): ModelTranscript {
  const toolResult = isAgentToolResult(input.toolOutput)
    ? input.toolOutput
    : buildAgentToolSuccessResult({
      toolName: input.toolName,
      input: input.toolInput,
      output: input.toolOutput,
    });
  const toolCallId = input.toolCallId ?? findPendingToolCallId({
    transcript: input.transcript,
    toolName: input.toolName,
    toolInput: input.toolInput,
  });
  return appendModelTranscriptItems(input.transcript, [
    makeModelTranscriptItem("tool_result", {
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolOutput: toolResult.modelContext,
      truncated: toolResult.modelContext.truncated,
      rawOutputRef: toolResult.modelContext.rawOutputRef,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      stepIndex: input.stepIndex,
    }),
  ]);
}

export function appendCorrectionToTranscript(input: {
  transcript: unknown;
  message: string;
  stepIndex?: number | undefined;
}): ModelTranscript {
  return appendModelTranscriptItems(input.transcript, [
    makeModelTranscriptItem("correction", {
      content: input.message,
      stepIndex: input.stepIndex,
    }),
  ]);
}

export function appendTodoUpdateToTranscript(input: {
  transcript: unknown;
  visibleTodos: VisibleTodoState;
  stepIndex?: number | undefined;
}): ModelTranscript {
  return appendModelTranscriptItems(input.transcript, [
    makeModelTranscriptItem("todo_update", {
      content: renderVisibleTodosForModel(input.visibleTodos),
      stepIndex: input.stepIndex,
    }),
  ]);
}

export function compactModelTranscript(input: {
  transcript: unknown;
  summary: string;
  retainedTailItems?: number | undefined;
}): ModelTranscript {
  const transcript = normalizeModelTranscript(input.transcript) ?? { version: 1, windowId: 1, items: [] };
  const plan = planModelTranscriptCompaction({
    transcript,
    retainedTailItems: input.retainedTailItems,
  });
  const retainedItems = plan.retainedItems;
  const replacedItems = plan.replacedItems;
  const nextWindowId = transcript.windowId + 1;
  const summaryItem = assignTranscriptItemIdentity(
    makeModelTranscriptItem("compaction_summary", {
      content: input.summary.trim(),
    }),
    nextWindowId,
    1,
  );
  const compactionRecord: ModelTranscriptCompactionRecord = {
    id: `compaction_${nextWindowId}`,
    createdAt: summaryItem.createdAt,
    summaryItemId: summaryItem.id,
    replacedItemIds: replacedItems.map((item) => item.id),
    retainedItemIds: retainedItems.map((item) => item.id),
  };
  return {
    version: 1,
    windowId: nextWindowId,
    items: limitTranscriptItems(dedupeTranscriptItemsById([
      summaryItem,
      ...retainedItems,
    ]), {
      pinnedItemIds: [summaryItem.id],
    }),
    compactions: [
      ...(transcript.compactions ?? []),
      compactionRecord,
    ].slice(-20),
  };
}

export function planModelTranscriptCompaction(input: {
  transcript: unknown;
  retainedTailItems?: number | undefined;
}): ModelTranscriptCompactionPlan {
  const transcript = normalizeModelTranscript(input.transcript) ?? { version: 1, windowId: 1, items: [] };
  const retainedTailItems = Math.max(0, Math.trunc(input.retainedTailItems ?? 24));
  const tail = retainedTailItems > 0 ? selectProviderValidTail(transcript.items, retainedTailItems) : [];
  const activeTaskItem = readActiveTaskItemFromTranscript(transcript);
  const retainedItems = dedupeTranscriptItemsById([
    ...(activeTaskItem !== undefined ? [activeTaskItem] : []),
    ...tail,
  ]);
  const retainedIds = new Set(retainedItems.map((item) => item.id));
  return {
    retainedItems,
    replacedItems: transcript.items.filter((item) => retainedIds.has(item.id) === false),
  };
}

function readActiveTaskItemFromTranscript(transcript: ModelTranscript): ModelTranscriptItem | undefined {
  return transcript.items.find((item) => {
    if (item.kind !== "user") {
      return false;
    }
    const content = item.content?.trim();
    return content !== undefined && content.length > 0;
  });
}

function limitTranscriptItems(
  items: ModelTranscriptItem[],
  options: { pinnedItemIds?: string[] | undefined } = {},
): ModelTranscriptItem[] {
  if (items.length <= MAX_TRANSCRIPT_ITEMS) {
    return items;
  }
  const protectedIds = new Set(options.pinnedItemIds ?? []);
  const activeTaskItem = readActiveTaskItemFromTranscript({
    version: 1,
    windowId: 1,
    items,
  });
  if (activeTaskItem !== undefined) {
    protectedIds.add(activeTaskItem.id);
  }
  if (protectedIds.size === 0) {
    return items.slice(-MAX_TRANSCRIPT_ITEMS);
  }
  const rawTail = items.slice(-MAX_TRANSCRIPT_ITEMS);
  if ([...protectedIds].every((id) => rawTail.some((item) => item.id === id))) {
    return rawTail;
  }
  const tailCapacity = Math.max(0, MAX_TRANSCRIPT_ITEMS - protectedIds.size);
  const tailIds = new Set(items
    .filter((item) => protectedIds.has(item.id) === false)
    .slice(-tailCapacity)
    .map((item) => item.id));
  const retainedIds = new Set([...protectedIds, ...tailIds]);
  const tail = items
    .filter((item) => retainedIds.has(item.id));
  return tail.slice(-MAX_TRANSCRIPT_ITEMS);
}

export function rebaseModelTranscriptAfterCompaction(input: {
  compactedTranscript: unknown;
  outgoingTranscript: unknown;
}): ModelTranscript | undefined {
  const compacted = normalizeModelTranscript(input.compactedTranscript);
  const outgoing = normalizeModelTranscript(input.outgoingTranscript);
  const latestCompaction = compacted?.compactions?.at(-1);
  if (compacted === undefined || outgoing === undefined || latestCompaction === undefined) {
    return ;
  }

  const existingIds = new Set(compacted.items.map((item) => item.id));
  const skippedIds = new Set([
    ...latestCompaction.replacedItemIds,
    ...latestCompaction.retainedItemIds,
    ...existingIds,
  ]);
  const newItems = dedupeTranscriptItemsById(outgoing.items)
    .filter((item) => skippedIds.has(item.id) === false);
  if (newItems.length === 0) {
    return compacted;
  }
  return appendModelTranscriptItems(compacted, newItems);
}

export function estimateModelTranscriptChars(value: unknown): number {
  const transcript = normalizeModelTranscript(value);
  if (transcript === undefined) {
    return 0;
  }
  return transcript.items.reduce((total, item) => total + stringifyForTranscript(item).length, 0);
}

export function renderModelTranscriptMessages(input: {
  transcript: unknown;
  runtimeContext?: string | undefined;
  suppressCorrectionContent?: string | undefined;
}): ModelMessage[] {
  const transcript = normalizeModelTranscript(input.transcript);
  const messages: ModelMessage[] = [];
  const transcriptItems = transcript?.items ?? [];
  const completedCallIds = new Set(
    transcriptItems
      .filter((item) => item.kind === "tool_result" && item.toolCallId !== undefined)
      .map((item) => item.toolCallId as string),
  );
  const emittedToolCallIds = new Set<string>();
  if (input.runtimeContext !== undefined && input.runtimeContext.trim().length > 0) {
    messages.push({
      role: "user",
      content: `<runtime_context>\n${input.runtimeContext.trim()}\n</runtime_context>`,
    });
  }
  for (const item of transcriptItems) {
    const message = transcriptItemToMessage(item, {
      completedCallIds,
      emittedToolCallIds,
      suppressCorrectionContent: input.suppressCorrectionContent,
    });
    if (message !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}

function transcriptItemToMessage(
  item: ModelTranscriptItem,
  context: {
    completedCallIds: ReadonlySet<string>;
    emittedToolCallIds: Set<string>;
    suppressCorrectionContent?: string | undefined;
  },
): ModelMessage | undefined {
  if (item.kind === "user") {
    return item.content !== undefined ? { role: "user", content: item.content } : undefined;
  }
  if (item.kind === "assistant_text" || item.kind === "compaction_summary") {
    return item.content !== undefined ? { role: "assistant", content: item.content } : undefined;
  }
  if (item.kind === "tool_call") {
    const toolCallId = canonicalToolCallId(item);
    if (context.completedCallIds.has(toolCallId) === false) {
      return {
        role: "assistant",
        content: renderDanglingToolCallRepairContent(item, toolCallId),
      };
    }
    context.emittedToolCallIds.add(toolCallId);
    return {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: toolCallId,
          name: item.toolName ?? "unknown",
          input: item.toolInput ?? {},
        },
      ],
    };
  }
  if (item.kind === "tool_result") {
    if (item.toolCallId === undefined || context.emittedToolCallIds.has(item.toolCallId) === false) {
      return {
        role: "assistant",
        content: renderOrphanToolResultRepairContent(item),
      };
    }
    return {
      role: "tool",
      name: item.toolName,
      ...(item.toolCallId !== undefined ? { toolCallId: item.toolCallId } : {}),
      content: renderToolResultContent(item),
    };
  }
  if (item.kind === "correction") {
    if (item.content !== undefined && item.content === context.suppressCorrectionContent) {
      return ;
    }
    return item.content !== undefined ? { role: "user", content: `Correction: ${item.content}` } : undefined;
  }
  if (item.kind === "todo_update") {
    return item.content !== undefined ? { role: "assistant", content: item.content } : undefined;
  }
  return ;
}

function renderDanglingToolCallRepairContent(item: ModelTranscriptItem, toolCallId: string): string {
  return [
    "Transcript repair: a previous assistant tool call was recorded without a matching tool result.",
    `Tool call: ${item.toolName ?? "unknown"}`,
    `Tool call id: ${toolCallId}`,
    `Input: ${JSON.stringify(item.toolInput ?? {})}`,
    "Continue from the visible conversation and current runtime context.",
  ].join("\n");
}

function renderOrphanToolResultRepairContent(item: ModelTranscriptItem): string {
  return [
    "Transcript repair: a tool result was recorded without a provider-visible assistant tool call.",
    renderToolResultContent(item),
    "Continue from the visible conversation and current runtime context.",
  ].join("\n");
}

function findPendingToolCallId(input: {
  transcript: unknown;
  toolName: string;
  toolInput: Record<string, unknown>;
}): string | undefined {
  const transcript = normalizeModelTranscript(input.transcript);
  if (transcript === undefined) {
    return ;
  }
  const completedCallIds = new Set(
    transcript.items
      .filter((item) => item.kind === "tool_result" && item.toolCallId !== undefined)
      .map((item) => item.toolCallId as string),
  );
  const expectedInput = stringifyForTranscript(input.toolInput);
  let sameNameFallback: string | undefined;
  for (const item of [...transcript.items].reverse()) {
    if (
      item.kind === "tool_call" &&
      item.toolName === input.toolName &&
      completedCallIds.has(canonicalToolCallId(item)) === false
    ) {
      if (stringifyForTranscript(item.toolInput ?? {}) === expectedInput) {
        return canonicalToolCallId(item);
      }
      sameNameFallback ??= canonicalToolCallId(item);
    }
  }
  return sameNameFallback;
}

function selectProviderValidTail(items: ModelTranscriptItem[], retainedTailItems: number): ModelTranscriptItem[] {
  if (retainedTailItems <= 0) {
    return [];
  }
  const selected = new Set(items.slice(-retainedTailItems).map((item) => item.id));
  const callsById = new Map<string, ModelTranscriptItem>();
  const resultsByCallId = new Map<string, ModelTranscriptItem[]>();
  for (const item of items) {
    if (item.kind === "tool_call") {
      callsById.set(canonicalToolCallId(item), item);
    } else if (item.kind === "tool_result" && item.toolCallId !== undefined) {
      const existing = resultsByCallId.get(item.toolCallId) ?? [];
      existing.push(item);
      resultsByCallId.set(item.toolCallId, existing);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (selected.has(item.id) === false) {
        continue;
      }
      if (item.kind === "tool_call") {
        for (const result of resultsByCallId.get(canonicalToolCallId(item)) ?? []) {
          if (selected.has(result.id) === false) {
            selected.add(result.id);
            changed = true;
          }
        }
      } else if (item.kind === "tool_result" && item.toolCallId !== undefined) {
        const call = callsById.get(item.toolCallId);
        if (call !== undefined && selected.has(call.id) === false) {
          selected.add(call.id);
          changed = true;
        }
      }
    }
  }
  const selectedCallIds = new Set<string>();
  const selectedResultCallIds = new Set<string>();
  for (const item of items) {
    if (selected.has(item.id) === false) {
      continue;
    }
    if (item.kind === "tool_call") {
      selectedCallIds.add(canonicalToolCallId(item));
    } else if (item.kind === "tool_result" && item.toolCallId !== undefined) {
      selectedResultCallIds.add(item.toolCallId);
    }
  }
  return dedupeTranscriptItemsById(items.filter((item) =>
    selected.has(item.id) &&
    isProviderRenderableTranscriptTailItem(item, {
      selectedCallIds,
      selectedResultCallIds,
    })
  ));
}

function isProviderRenderableTranscriptTailItem(
  item: ModelTranscriptItem,
  selected: {
    selectedCallIds: ReadonlySet<string>;
    selectedResultCallIds: ReadonlySet<string>;
  },
): boolean {
  if (item.kind === "tool_call") {
    return selected.selectedResultCallIds.has(canonicalToolCallId(item));
  }
  if (item.kind === "tool_result") {
    return item.toolCallId !== undefined && selected.selectedCallIds.has(item.toolCallId);
  }
  return true;
}

function canonicalToolCallId(item: ModelTranscriptItem): string {
  return item.toolCallId ?? item.id;
}

function renderToolResultContent(item: ModelTranscriptItem): string {
  const modelContext = asRecord(item.toolOutput);
  const text = asStringForSummary(modelContext?.text);
  if (text !== undefined) {
    return text;
  }
  return buildAgentToolSuccessResult({
    toolName: item.toolName ?? "unknown",
    input: item.toolInput ?? {},
    output: item.toolOutput,
  }).modelContext.text;
}

const TOOL_INPUT_PREVIEW_CHARS = 500;

function renderToolInputForTranscript(item: ModelTranscriptItem): string {
  const compact = compactKnownToolInputForTranscript(item);
  return JSON.stringify(compact ?? item.toolInput ?? {});
}

function compactKnownToolInputForTranscript(item: ModelTranscriptItem): Record<string, unknown> | undefined {
  const input = item.toolInput;
  if (input === undefined) {
    return ;
  }
  if (item.toolName !== "fs.write_text" && item.toolName !== "fs_write_text") {
    return ;
  }
  const content = asStringForSummary(input.content);
  if (content === undefined) {
    return input;
  }
  const contentBytes = Buffer.byteLength(content, "utf8");
  return {
    ...input,
    contentBytes,
    contentPreview: previewText(content, TOOL_INPUT_PREVIEW_CHARS),
    contentTruncated: content.length > TOOL_INPUT_PREVIEW_CHARS,
    content: undefined,
  };
}

function asStringForSummary(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function previewText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n[omitted ${value.length - maxChars} chars]`;
}

function dedupeTranscriptItemsById(items: ModelTranscriptItem[]): ModelTranscriptItem[] {
  const latestIndexById = new Map<string, number>();
  items.forEach((item, index) => {
    latestIndexById.set(item.id, index);
  });
  return items.filter((item, index) => latestIndexById.get(item.id) === index);
}

function nextTranscriptOrdinal(items: ModelTranscriptItem[], windowId: number): number {
  const prefix = `mt_${windowId}_`;
  return items.reduce((max, item) => {
    if (item.id.startsWith(prefix) === false) {
      return max;
    }
    const ordinal = Number.parseInt(item.id.slice(prefix.length, prefix.length + 4), 10);
    return Number.isFinite(ordinal) ? Math.max(max, ordinal) : max;
  }, 0);
}

function normalizeTranscriptItem(value: unknown): ModelTranscriptItem | undefined {
  const record = asRecord(value);
  const id = asString(record?.id);
  const createdAt = asString(record?.createdAt);
  const kind = asString(record?.kind);
  if (record === undefined || id === undefined || createdAt === undefined || isTranscriptKind(kind) === false) {
    return ;
  }
  return {
    id,
    createdAt,
    kind,
    ...(asString(record.content) !== undefined ? { content: asString(record.content) } : {}),
    ...(asString(record.toolName) !== undefined ? { toolName: asString(record.toolName) } : {}),
    ...(asRecord(record.toolInput) !== undefined ? { toolInput: asRecord(record.toolInput) } : {}),
    ...(record.toolOutput !== undefined ? { toolOutput: record.toolOutput } : {}),
    ...(asString(record.toolCallId) !== undefined ? { toolCallId: asString(record.toolCallId) } : {}),
    ...(asString(record.rawOutputRef) !== undefined ? { rawOutputRef: asString(record.rawOutputRef) } : {}),
    ...(typeof record.truncated === "boolean" ? { truncated: record.truncated } : {}),
  };
}

function assignTranscriptItemIdentity(
  item: ModelTranscriptItem,
  windowId: number,
  ordinal: number,
): ModelTranscriptItem {
  const id = `mt_${windowId}_${String(ordinal).padStart(4, "0")}_${item.kind}`;
  return {
    ...item,
    id,
    createdAt: new Date(ordinal * 1000).toISOString(),
    ...(item.kind === "tool_call" && item.toolCallId === undefined ? { toolCallId: id } : {}),
  };
}

function normalizeCompactions(value: unknown): ModelTranscriptCompactionRecord[] {
  return asArray(value)
    .map((entry) => {
      const record = asRecord(entry);
      const id = asString(record?.id);
      const createdAt = asString(record?.createdAt);
      const summaryItemId = asString(record?.summaryItemId);
      if (record === undefined || id === undefined || createdAt === undefined || summaryItemId === undefined) {
        return ;
      }
      return {
        id,
        createdAt,
        summaryItemId,
        replacedItemIds: asArray(record.replacedItemIds).map(asString).filter(isString),
        retainedItemIds: asArray(record.retainedItemIds).map(asString).filter(isString),
      };
    })
    .filter((entry): entry is ModelTranscriptCompactionRecord => entry !== undefined)
    .slice(-20);
}

function isTranscriptKind(value: string | undefined): value is ModelTranscriptItemKind {
  return value === "user" ||
    value === "assistant_text" ||
    value === "tool_call" ||
    value === "tool_result" ||
    value === "correction" ||
    value === "todo_update" ||
    value === "compaction_summary";
}

function stringifyForTranscript(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
