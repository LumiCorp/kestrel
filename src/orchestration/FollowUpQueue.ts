import type { RunTurnAttachment, ThreadRecord } from "../kestrel/contracts/orchestration.js";
import type {
  FollowUpQueueEntry,
  FollowUpQueuePauseReason,
  FollowUpQueueView,
  FollowUpRuntimeContext,
} from "./contracts.js";
import type { RuntimeTurnActor } from "../runtime/RuntimeTurn.js";

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

export function refreshDialogFollowUp(
  thread: ThreadRecord,
  followUpId: string,
  dialog: { status: "open" | "closed"; activity: "idle" | "working" | "waiting" | "interrupted" },
): ThreadRecord {
  const queue = readFollowUpQueue(thread);
  return writeFollowUpQueue(thread, {
    ...queue,
    items: queue.items.map((entry) => entry.followUpId === followUpId
      ? { ...entry, dialogStatus: dialog.status, dialogActivity: dialog.activity }
      : entry),
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
  const attachments = Array.isArray(entry?.attachments)
    ? entry.attachments.filter((attachment): attachment is RunTurnAttachment =>
        typeof attachment === "object" && attachment !== null && Array.isArray(attachment) === false)
    : undefined;
  const interactionMode = entry?.interactionMode === "chat" || entry?.interactionMode === "plan" || entry?.interactionMode === "build"
    ? entry.interactionMode : undefined;
  const actSubmode = entry?.actSubmode === "strict" || entry?.actSubmode === "safe" || entry?.actSubmode === "full_auto"
    ? entry.actSubmode : undefined;
  const runtimeContext = normalizeRuntimeContext(entry?.runtimeContext);
  const runtimeActor = normalizeRuntimeActor(entry?.runtimeActor);
  const dialogStatus = entry?.dialogStatus === "open" || entry?.dialogStatus === "closed" ? entry.dialogStatus : undefined;
  const dialogActivity = entry?.dialogActivity === "idle" || entry?.dialogActivity === "working" || entry?.dialogActivity === "waiting" || entry?.dialogActivity === "interrupted" ? entry.dialogActivity : undefined;
  return [{ followUpId, message, attachmentIds,
    ...(attachments !== undefined ? { attachments } : {}),
    ...(interactionMode !== undefined ? { interactionMode } : {}),
    ...(actSubmode !== undefined ? { actSubmode } : {}),
    ...(entry?.source === "dialog" ? { source: "dialog" as const } : entry?.source === "human" ? { source: "human" as const } : {}),
    ...(nonEmptyString(entry?.dialogId) !== undefined ? { dialogId: nonEmptyString(entry?.dialogId) } : {}),
    ...(nonEmptyString(entry?.dialogName) !== undefined ? { dialogName: nonEmptyString(entry?.dialogName) } : {}),
    ...(nonEmptyString(entry?.sourceMessageId) !== undefined ? { sourceMessageId: nonEmptyString(entry?.sourceMessageId) } : {}),
    ...(dialogStatus !== undefined ? { dialogStatus } : {}),
    ...(dialogActivity !== undefined ? { dialogActivity } : {}),
    ...(runtimeContext !== undefined ? { runtimeContext } : {}),
    ...(runtimeActor !== undefined ? { runtimeActor } : {}),
    createdAt, state: entry?.state === "starting" ? "starting" : "queued" }];
}

function normalizeRuntimeContext(value: unknown): FollowUpRuntimeContext | undefined {
  const context = asRecord(value);
  if (context === undefined) return undefined;
  const normalized: FollowUpRuntimeContext = {};
  if (typeof context.runId === "string" && context.runId.trim().length > 0) {
    normalized.runId = context.runId;
  }
  if (typeof context.stepAgent === "string") normalized.stepAgent = context.stepAgent;
  if (context.modeSystemV2Enabled === true || context.modeSystemV2Enabled === false) {
    normalized.modeSystemV2Enabled = context.modeSystemV2Enabled;
  }
  if (context.interactionMode === "chat" || context.interactionMode === "plan" || context.interactionMode === "build") {
    normalized.interactionMode = context.interactionMode;
  }
  if (context.actSubmode === "strict" || context.actSubmode === "safe" || context.actSubmode === "full_auto") {
    normalized.actSubmode = context.actSubmode;
  }
  if (asRecord(context.mcpContext) !== undefined) normalized.mcpContext = context.mcpContext as FollowUpRuntimeContext["mcpContext"];
  if (asRecord(context.metadata) !== undefined) normalized.metadata = context.metadata as Record<string, unknown>;
  if (asRecord(context.clientCapabilities) !== undefined) {
    normalized.clientCapabilities = context.clientCapabilities as FollowUpRuntimeContext["clientCapabilities"];
  }
  if (asRecord(context.executionPolicy) !== undefined) {
    normalized.executionPolicy = context.executionPolicy as FollowUpRuntimeContext["executionPolicy"];
  }
  if (Array.isArray(context.systemInstructions)) {
    normalized.systemInstructions = context.systemInstructions.filter((item): item is string => typeof item === "string");
  }
  if (Array.isArray(context.history)) normalized.history = context.history as FollowUpRuntimeContext["history"];
  if (asRecord(context.projectContext) !== undefined) {
    normalized.projectContext = context.projectContext as FollowUpRuntimeContext["projectContext"];
  }
  if (context.manualCompaction === true || context.manualCompaction === false) {
    normalized.manualCompaction = context.manualCompaction;
  }
  if (asRecord(context.autoCompaction) !== undefined) {
    normalized.autoCompaction = context.autoCompaction as FollowUpRuntimeContext["autoCompaction"];
  }
  if (Object.hasOwn(context, "workspace")) normalized.workspace = context.workspace;
  if (Array.isArray(context.workspaceSkills)) {
    normalized.workspaceSkills = context.workspaceSkills as FollowUpRuntimeContext["workspaceSkills"];
  }
  return normalized;
}

function normalizeRuntimeActor(value: unknown): RuntimeTurnActor | undefined {
  const actor = asRecord(value);
  const actorType = actor?.actorType;
  const actorId = nonEmptyString(actor?.actorId);
  if (
    actorId === undefined
    || (actorType !== "end_user" && actorType !== "operator" && actorType !== "service")
  ) return undefined;
  return {
    actorType,
    actorId,
    ...(nonEmptyString(actor?.displayName) !== undefined ? { displayName: nonEmptyString(actor?.displayName) } : {}),
    ...(nonEmptyString(actor?.tenantId) !== undefined ? { tenantId: nonEmptyString(actor?.tenantId) } : {}),
  };
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
