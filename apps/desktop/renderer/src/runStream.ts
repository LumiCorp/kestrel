import {
  reduceConversationActivity,
  type ConversationActivityItem,
} from "@kestrel-agents/conversation";

import type {
  DesktopConversationMessageRoute,
  DesktopConversationTurn,
  DesktopRunnerEvent,
} from "../../src/contracts";
import type { RendererTranscriptLine } from "./state";
import { adaptDesktopConversation } from "./conversationAdapter";

export type DesktopRunStreamItem = ConversationActivityItem;

export type DesktopConversationTimelineItem =
  | { id: string; type: "transcript"; line: RendererTranscriptLine }
  | { id: string; type: "run_stream"; item: DesktopRunStreamItem };

export function projectDesktopRunStream(
  current: readonly DesktopRunStreamItem[],
  event: DesktopRunnerEvent,
): DesktopRunStreamItem[] {
  const update = readRecord((event.payload as { update?: unknown }).update);
  const runId = readString(update?.runId) ?? event.runId;
  const normalizedEvent = {
    id: event.id,
    type: event.type,
    ts: event.ts,
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    payload: event.payload as Record<string, unknown>,
  };
  if (runId === undefined) {
    return reduceConversationActivity(current, normalizedEvent);
  }

  const firstRunIndex = current.findIndex((item) => item.runId === runId);
  const currentRun = current.filter((item) => item.runId === runId);
  const nextRun = reduceConversationActivity(currentRun, normalizedEvent);
  if (firstRunIndex < 0) return [...current, ...nextRun];

  const before = current.slice(0, firstRunIndex).filter((item) => item.runId !== runId);
  const after = current.slice(firstRunIndex).filter((item) => item.runId !== runId);
  return [...before, ...nextRun, ...after];
}

/**
 * Projects the Desktop transcript around durable Local Core turn identities.
 * The legacy fallback is used only for pre-authority threads with no turn
 * records. Durable turn ownership is never inferred from timestamp, text, or
 * adjacency. Unowned legacy entries retain chronological display placement
 * without being assigned to a turn.
 */
export function projectDesktopConversationTimeline(
  transcript: readonly RendererTranscriptLine[],
  runStream: readonly DesktopRunStreamItem[],
  conversationTurns: readonly DesktopConversationTurn[] = [],
  messageRoutes: readonly DesktopConversationMessageRoute[] = [],
): DesktopConversationTimelineItem[] {
  if (conversationTurns.length === 0) {
    return projectLegacyTimeline(transcript, runStream);
  }

  const adapted = adaptDesktopConversation({
    threadId: conversationTurns[0]?.threadId ?? "desktop-thread",
    transcript,
    turns: conversationTurns,
    messageRoutes,
  });
  const turnByRunId = new Map<string, string>();
  for (const turn of adapted.snapshot.turns) {
    for (const runId of [turn.rootRunId, turn.activeRunId, turn.terminalRunId]) {
      if (runId) turnByRunId.set(runId, turn.id);
    }
  }
  const turnIdByMessageId = new Map<string, string>();
  for (const item of adapted.projection.items) {
    if (item.kind !== "durable_turn") continue;
    for (const message of item.messages) turnIdByMessageId.set(message.id, item.turnId);
  }
  for (const route of messageRoutes) {
    if (route.runId === undefined) continue;
    const turnId = route.turnId ?? turnIdByMessageId.get(route.messageId);
    if (turnId !== undefined) turnByRunId.set(route.runId, turnId);
  }

  const activityByTurnId = new Map<string, DesktopRunStreamItem[]>();
  const standaloneActivity: DesktopRunStreamItem[] = [];
  for (const item of runStream) {
    if (item.visible === false) continue;
    const turnId = item.runId === undefined ? undefined : turnByRunId.get(item.runId);
    if (turnId === undefined) {
      standaloneActivity.push(item);
      continue;
    }
    const current = activityByTurnId.get(turnId) ?? [];
    current.push(item);
    activityByTurnId.set(turnId, current);
  }

  const segments = new Map<string, {
    id: string;
    turnId: string;
    turnSequence: number | null;
    segmentOrder: number;
    timestamp: string;
    items: DesktopConversationTimelineItem[];
  }>();
  const standaloneMessages: DesktopConversationTimelineItem[] = [];
  const provisionalMessages: DesktopConversationTimelineItem[] = [];
  for (const item of adapted.projection.items) {
    if (item.kind === "standalone_message") {
      const timelineItem = toTranscriptTimelineItem(
        item.message.line,
        transcript.indexOf(item.message.line),
      );
      if (item.message.metadata?.deliveryState === "submitting") {
        provisionalMessages.push(timelineItem);
      } else {
        standaloneMessages.push(timelineItem);
      }
      continue;
    }
    const activities = activityByTurnId.get(item.turnId) ?? [];
    const messageIds = new Set(item.messages.map((message) => message.id));
    const routedRunIds = messageRoutes
      .filter((route) =>
        route.runId !== undefined &&
        (route.turnId === item.turnId || messageIds.has(route.messageId)),
      )
      .slice()
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId),
      )
      .map((route) => route.runId!);
    const runIds = new Set<string>();
    if (item.turn?.rootRunId) runIds.add(item.turn.rootRunId);
    for (const runId of routedRunIds) runIds.add(runId);
    for (const message of item.messages) {
      if (message.metadata?.kestrelRunId) runIds.add(message.metadata.kestrelRunId);
    }
    for (const activity of activities) {
      if (activity.runId) runIds.add(activity.runId);
    }
    let segmentOrder = 0;
    for (const runId of runIds) {
      const runMessages = item.messages.filter(
        (message) => message.metadata?.kestrelRunId === runId,
      );
      const runActivities = activities.filter((activity) => activity.runId === runId);
      const timelineItems = weaveRunActivityAroundMessages(
        runMessages.map((message) =>
          toTranscriptTimelineItem(message.line, transcript.indexOf(message.line))),
        runActivities.map(toRunStreamTimelineItem),
      );
      if (timelineItems.length === 0) continue;
      const key = `turn:${item.turnId}:run:${runId}`;
      segments.set(key, {
        id: key,
        turnId: item.turnId,
        turnSequence: item.turn?.sequence ?? null,
        segmentOrder,
        timestamp: earliestTimelineTimestamp(timelineItems),
        items: timelineItems,
      });
      segmentOrder += 1;
    }

    const ungroupedMessages = item.messages.filter(
      (message) => message.metadata?.kestrelRunId === undefined,
    );
    const ungroupedActivities = activities.filter((activity) => activity.runId === undefined);
    if (ungroupedMessages.length > 0 || ungroupedActivities.length > 0) {
      const timelineItems = weaveRunActivityAroundMessages(
        ungroupedMessages.map((message) =>
          toTranscriptTimelineItem(message.line, transcript.indexOf(message.line))),
        ungroupedActivities.map(toRunStreamTimelineItem),
      );
      const key = `turn:${item.turnId}:unsegmented`;
      segments.set(key, {
        id: key,
        turnId: item.turnId,
        turnSequence: item.turn?.sequence ?? null,
        segmentOrder,
        timestamp: earliestTimelineTimestamp(timelineItems),
        items: timelineItems,
      });
    }
  }

  const orderedSegments = [...segments.values()]
    .sort((left, right) => {
      if (left.turnSequence === null || right.turnSequence === null) {
        if (left.turnSequence === null && right.turnSequence === null) {
          return left.turnId.localeCompare(right.turnId)
            || left.segmentOrder - right.segmentOrder
            || left.id.localeCompare(right.id);
        }
        return left.turnSequence === null ? 1 : -1;
      }
      return left.turnSequence - right.turnSequence
        || left.turnId.localeCompare(right.turnId)
        || left.segmentOrder - right.segmentOrder
        || left.id.localeCompare(right.id);
    });
  const unownedItems = [
    ...standaloneMessages,
    ...provisionalMessages,
    ...standaloneActivity.map(toRunStreamTimelineItem),
  ].sort(compareTimelineItems);
  const projected: DesktopConversationTimelineItem[] = [];
  let unownedIndex = 0;
  for (const segment of orderedSegments) {
    while (
      unownedIndex < unownedItems.length &&
      timelineItemTimestamp(unownedItems[unownedIndex]!) <= segment.timestamp
    ) {
      projected.push(unownedItems[unownedIndex]!);
      unownedIndex += 1;
    }
    projected.push(...segment.items);
  }
  projected.push(...unownedItems.slice(unownedIndex));
  return projected;
}

export function describeDesktopRunnerActivity(event: DesktopRunnerEvent): string {
  if (event.type !== "run.progress" && event.type !== "run.agent_progress") return "";
  const update = readRecord((event.payload as { update?: unknown }).update);
  return readString(update?.message) ?? (event.type === "run.agent_progress" ? "Working" : "Runtime active");
}

function projectLegacyTimeline(
  transcript: readonly RendererTranscriptLine[],
  runStream: readonly DesktopRunStreamItem[],
): DesktopConversationTimelineItem[] {
  const activeTurnStart = findLastIndex(transcript, (line) => line.role === "user");
  return [
    ...transcript.slice(0, activeTurnStart + 1).map(toTranscriptTimelineItem),
    ...runStream.filter((item) => item.visible !== false).map(toRunStreamTimelineItem),
    ...transcript.slice(activeTurnStart + 1).map((line, index) =>
      toTranscriptTimelineItem(line, activeTurnStart + 1 + index)),
  ];
}

function toRunStreamTimelineItem(item: DesktopRunStreamItem): DesktopConversationTimelineItem {
  return { id: `run-stream:${item.id}`, type: "run_stream", item };
}

function toTranscriptTimelineItem(line: RendererTranscriptLine, index: number): DesktopConversationTimelineItem {
  return { id: `transcript:${messageIdentity(line) ?? `${index}:${line.timestamp}`}`, type: "transcript", line };
}

/**
 * Shared projection has already established message order. Runtime activity is
 * displayed in timestamp order around those fixed anchors, while retaining the
 * run stream's own sequence when timestamps arrive out of order.
 */
function weaveRunActivityAroundMessages(
  messages: readonly DesktopConversationTimelineItem[],
  activities: readonly DesktopConversationTimelineItem[],
): DesktopConversationTimelineItem[] {
  const activityBuckets = Array.from({ length: messages.length + 1 }, () =>
    [] as DesktopConversationTimelineItem[]);
  let earliestAllowedBucket = 0;
  for (const activity of activities) {
    let bucket = 0;
    while (
      bucket < messages.length &&
      compareTimelineItems(messages[bucket]!, activity) <= 0
    ) {
      bucket += 1;
    }
    bucket = Math.max(bucket, earliestAllowedBucket);
    activityBuckets[bucket]!.push(activity);
    earliestAllowedBucket = bucket;
  }

  const timeline: DesktopConversationTimelineItem[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    timeline.push(...activityBuckets[index]!, messages[index]!);
  }
  timeline.push(...activityBuckets[messages.length]!);
  return timeline;
}

function earliestTimelineTimestamp(items: readonly DesktopConversationTimelineItem[]): string {
  return items.reduce((earliest, item) => {
    const timestamp = item.type === "transcript" ? item.line.timestamp : item.item.timestamp;
    return earliest === "" || timestamp < earliest ? timestamp : earliest;
  }, "");
}

function compareTimelineItems(
  left: DesktopConversationTimelineItem,
  right: DesktopConversationTimelineItem,
): number {
  return timelineItemTimestamp(left).localeCompare(timelineItemTimestamp(right))
    || timelineItemKindOrder(left) - timelineItemKindOrder(right)
    || left.id.localeCompare(right.id);
}

function timelineItemTimestamp(item: DesktopConversationTimelineItem): string {
  return item.type === "transcript" ? item.line.timestamp : item.item.timestamp;
}

function timelineItemKindOrder(item: DesktopConversationTimelineItem): number {
  return item.type === "transcript" && item.line.role === "user"
    ? 0
    : item.type === "run_stream"
      ? 1
      : 2;
}

function messageIdentity(line: RendererTranscriptLine) {
  return userMessageId(line) ?? line.dialog?.messageId ?? (line.terminal?.runId === undefined ? undefined : `terminal:${line.terminal.runId}`);
}

function userMessageId(line: RendererTranscriptLine): string | undefined {
  const data = readRecord(line.data);
  return data?.kind === "desktop.user-message.v1" ? readString(data.messageId) : undefined;
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
