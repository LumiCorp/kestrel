import type { ThreadRecord } from "../kestrel/contracts/orchestration.js";
import type { FollowUpQueueEntry, FollowUpQueuePauseReason, FollowUpQueueView } from "./contracts.js";

const OPERATOR_CONTROL_KEY = "operatorControl";
const FOLLOW_UP_QUEUE_KEY = "followUpQueue";

export function readFollowUpQueue(thread: ThreadRecord): FollowUpQueueView {
  const operatorControl = asRecord(thread.metadata?.[OPERATOR_CONTROL_KEY]);
  const queue = asRecord(operatorControl?.[FOLLOW_UP_QUEUE_KEY]);
  const items = Array.isArray(queue?.items)
    ? queue.items.flatMap(normalizeEntry)
    : [];
  const pauseReason = normalizePauseReason(queue?.pauseReason);
  return {
    state: queue?.state === "paused" ? "paused" : "ready",
    ...(pauseReason !== undefined ? { pauseReason } : {}),
    items,
  };
}

export function enqueueFollowUp(thread: ThreadRecord, entry: FollowUpQueueEntry): ThreadRecord {
  const queue = readFollowUpQueue(thread);
  if (queue.items.some((item) => item.followUpId === entry.followUpId)) return thread;
  return writeFollowUpQueue(thread, { ...queue, items: [...queue.items, entry] });
}

export function markFollowUpStarting(thread: ThreadRecord, followUpId: string): ThreadRecord {
  const queue = readFollowUpQueue(thread);
  return writeFollowUpQueue(thread, {
    ...queue,
    items: queue.items.map((entry) => entry.followUpId === followUpId
      ? { ...entry, state: "starting" }
      : entry),
  });
}

export function removeFollowUp(thread: ThreadRecord, followUpId: string): ThreadRecord {
  const queue = readFollowUpQueue(thread);
  return writeFollowUpQueue(thread, {
    ...queue,
    items: queue.items.filter((entry) => entry.followUpId !== followUpId),
  });
}

export function editFollowUp(thread: ThreadRecord, followUpId: string, message: string): ThreadRecord {
  const queue = readFollowUpQueue(thread);
  return writeFollowUpQueue(thread, {
    ...queue,
    items: queue.items.map((entry) => entry.followUpId === followUpId ? { ...entry, message } : entry),
  });
}

export function pauseFollowUpQueue(thread: ThreadRecord, pauseReason: FollowUpQueuePauseReason): ThreadRecord {
  const queue = readFollowUpQueue(thread);
  return writeFollowUpQueue(thread, {
    state: "paused",
    pauseReason,
    items: queue.items.map((entry) => entry.state === "starting" ? { ...entry, state: "queued" } : entry),
  });
}

export function resumeFollowUps(thread: ThreadRecord): ThreadRecord {
  const queue = readFollowUpQueue(thread);
  return writeFollowUpQueue(thread, {
    state: "ready",
    items: queue.items.map((entry) => entry.state === "starting" ? { ...entry, state: "queued" } : entry),
  });
}

function writeFollowUpQueue(thread: ThreadRecord, queue: FollowUpQueueView): ThreadRecord {
  const metadata = { ...(thread.metadata ?? {}) };
  const operatorControl = { ...(asRecord(metadata[OPERATOR_CONTROL_KEY]) ?? {}) };
  if (queue.items.length === 0 && queue.state === "ready") {
    delete operatorControl[FOLLOW_UP_QUEUE_KEY];
  } else {
    operatorControl[FOLLOW_UP_QUEUE_KEY] = {
      state: queue.state,
      ...(queue.pauseReason !== undefined ? { pauseReason: queue.pauseReason } : {}),
      items: queue.items,
    };
  }
  if (Object.keys(operatorControl).length === 0) delete metadata[OPERATOR_CONTROL_KEY];
  else metadata[OPERATOR_CONTROL_KEY] = operatorControl;
  return { ...thread, metadata, updatedAt: new Date().toISOString() };
}

function normalizeEntry(value: unknown): FollowUpQueueEntry[] {
  const entry = asRecord(value);
  const followUpId = nonEmptyString(entry?.followUpId);
  const message = nonEmptyString(entry?.message);
  const createdAt = nonEmptyString(entry?.createdAt);
  if (followUpId === undefined || message === undefined || createdAt === undefined) return [];
  const attachmentIds = Array.isArray(entry?.attachmentIds)
    ? entry.attachmentIds.flatMap((id) => typeof id === "string" && id.trim().length > 0 ? [id.trim()] : [])
    : [];
  const interactionMode = entry?.interactionMode === "chat" || entry?.interactionMode === "plan" || entry?.interactionMode === "build"
    ? entry.interactionMode : undefined;
  const actSubmode = entry?.actSubmode === "strict" || entry?.actSubmode === "safe" || entry?.actSubmode === "full_auto"
    ? entry.actSubmode : undefined;
  return [{ followUpId, message, attachmentIds,
    ...(interactionMode !== undefined ? { interactionMode } : {}),
    ...(actSubmode !== undefined ? { actSubmode } : {}),
    createdAt, state: entry?.state === "starting" ? "starting" : "queued" }];
}

function normalizePauseReason(value: unknown): FollowUpQueuePauseReason | undefined {
  return value === "waiting" || value === "failed" || value === "cancelled" || value === "operator" ? value : undefined;
}
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false ? value as Record<string, unknown> : undefined;
}
