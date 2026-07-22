import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  Task,
  TaskAction,
  TaskAttentionReason,
  TaskCreator,
  TaskEvidence,
  TaskPriority,
  TaskQueue,
  TaskReview,
  TaskStatus,
} from "./contracts.js";

export function createEmptyTaskQueue(): TaskQueue {
  return {
    version: 1,
    queueVersion: 1,
    nextTaskNumber: 1,
    tasks: {},
  };
}

export function sortTaskQueueTasks(queue: TaskQueue): Task[] {
  return Object.values(normalizeTaskQueue(queue).tasks).sort(compareTasks);
}

export function normalizeTaskQueue(value: unknown): TaskQueue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createEmptyTaskQueue();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.tasks !== "object" || record.tasks === null || Array.isArray(record.tasks)) {
    return createEmptyTaskQueue();
  }
  const tasks: Record<string, Task> = {};
  for (const [taskId, taskValue] of Object.entries(record.tasks as Record<string, unknown>)) {
    const task = normalizeTask(taskId, taskValue);
    if (task !== undefined) {
      tasks[task.id] = task;
    }
  }
  const highestTaskNumber = Object.keys(tasks).reduce((highest, taskId) => {
    const match = /^T-(\d+)$/u.exec(taskId);
    return match === null ? highest : Math.max(highest, Number(match[1]));
  }, 0);
  return {
    version: 1,
    queueVersion: positiveInteger(record.queueVersion, 1),
    nextTaskNumber: positiveInteger(record.nextTaskNumber, highestTaskNumber + 1, highestTaskNumber + 1),
    tasks,
  };
}

export function applyTaskQueueAction(queue: TaskQueue, action: TaskAction): TaskQueue {
  const current = normalizeTaskQueue(queue);
  switch (action.type) {
    case "task.create":
      return createTask(current, action, "user", "queued");
    case "task.propose":
      return action.taskId === undefined
        ? createTask(current, action, "agent", "proposed")
        : reviseProposedTask(current, action);
    case "task.approve":
      return updateTask(current, requireTask(current, action.taskId), action, {
        status: "queued",
        attentionReason: undefined,
        review: undefined,
      });
    case "task.update":
      return updateTask(current, requireTask(current, action.taskId), action, {
        ...(action.title !== undefined ? { title: requiredString(action.title, "title") } : {}),
        ...(action.instructions !== undefined ? { instructions: requiredString(action.instructions, "instructions") } : {}),
        ...(action.acceptanceCriteria !== undefined ? { acceptanceCriteria: cleanOptionalString(action.acceptanceCriteria) } : {}),
        ...(action.priority !== undefined ? { priority: normalizePriority(action.priority) } : {}),
        ...(action.projectPath !== undefined ? { projectPath: cleanOptionalString(action.projectPath) } : {}),
        ...(action.projectLabel !== undefined ? { projectLabel: cleanOptionalString(action.projectLabel) } : {}),
      });
    case "task.reorder":
      return updateTask(current, requireTask(current, action.taskId), action, {}, action.order);
    case "task.claim":
    case "task.mark_running":
      return claimTask(current, action);
    case "task.needs_attention":
      return updateTask(current, requireTask(current, action.taskId), action, {
        status: "needs_attention",
        attentionReason: normalizeAttentionReason(action.attentionReason),
      });
    case "task.submit_review":
      return updateTask(current, requireTask(current, action.taskId), action, {
        status: "ready_for_review",
        attentionReason: undefined,
        review: normalizeReview(action.review, action.actionTs),
      });
    case "task.request_changes":
      return updateTask(current, requireTask(current, action.taskId), action, {
        status: "queued",
        attentionReason: undefined,
        ...(action.instructions !== undefined ? { instructions: requiredString(action.instructions, "instructions") } : {}),
      });
    case "task.retry":
      return updateTask(current, requireTask(current, action.taskId), action, {
        status: "queued",
        attentionReason: undefined,
      });
    case "task.accept":
      return updateTask(current, requireTaskWithStatus(current, action.taskId, "ready_for_review"), action, {
        status: "done",
        attentionReason: undefined,
      });
    case "task.discard":
      return updateTask(current, requireTask(current, action.taskId), action, {
        status: "discarded",
        attentionReason: undefined,
      });
    case "task.stop":
      return updateTask(current, requireTask(current, action.taskId), action, {
        status: "needs_attention",
        attentionReason: "blocked",
      });
    default:
      return current;
  }
}

const STATUS_ORDER: Record<TaskStatus, number> = {
  proposed: 0,
  queued: 1,
  running: 2,
  needs_attention: 3,
  ready_for_review: 4,
  done: 5,
  discarded: 6,
};

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function compareTasks(left: Task, right: Task): number {
  return STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
    PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
    left.order - right.order ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id);
}

function createTask(
  queue: TaskQueue,
  action: Extract<TaskAction, { type: "task.create" | "task.propose" }>,
  createdBy: TaskCreator,
  status: TaskStatus,
): TaskQueue {
  const taskId = `T-${queue.nextTaskNumber}`;
  const task: Task = {
    id: taskId,
    title: requiredString(action.title, "title"),
    instructions: requiredString(action.instructions, "instructions"),
    ...(action.acceptanceCriteria !== undefined ? { acceptanceCriteria: cleanOptionalString(action.acceptanceCriteria) } : {}),
    priority: normalizePriority(action.priority),
    status,
    createdBy,
    createdAt: action.actionTs,
    updatedAt: action.actionTs,
    order: nextOrder(queue),
    ...(action.projectPath !== undefined ? { projectPath: cleanOptionalString(action.projectPath) } : {}),
    ...(action.projectLabel !== undefined ? { projectLabel: cleanOptionalString(action.projectLabel) } : {}),
    evidence: [makeEvidence(action, status === "proposed" ? "Task proposed." : "Task created.")],
  };
  const tasks = {
    ...queue.tasks,
    [taskId]: task,
  };
  return bumpQueue({
    ...queue,
    nextTaskNumber: queue.nextTaskNumber + 1,
    tasks: action.type === "task.propose" && action.order !== undefined
      ? moveTaskToOrder(tasks, taskId, action.order)
      : tasks,
  });
}

function reviseProposedTask(
  queue: TaskQueue,
  action: Extract<TaskAction, { type: "task.propose" }>,
): TaskQueue {
  const task = requireTask(queue, action.taskId);
  if (task.createdBy !== "agent" || task.status !== "proposed") {
    throw createRuntimeFailure(
      "MISSION_CONTROL_TASK_PROPOSAL_REVISION_INVALID",
      "Only agent-created proposed tasks can be revised through task.propose.",
      {
        taskId: task.id,
        createdBy: task.createdBy,
        status: task.status,
      },
    );
  }
  return updateTask(queue, task, action, {
    title: requiredString(action.title, "title"),
    instructions: requiredString(action.instructions, "instructions"),
    ...(action.acceptanceCriteria !== undefined
      ? { acceptanceCriteria: cleanOptionalString(action.acceptanceCriteria) }
      : {}),
    ...(action.priority !== undefined ? { priority: normalizePriority(action.priority) } : {}),
    ...(action.projectPath !== undefined ? { projectPath: cleanOptionalString(action.projectPath) } : {}),
    ...(action.projectLabel !== undefined ? { projectLabel: cleanOptionalString(action.projectLabel) } : {}),
  }, action.order);
}

function claimTask(
  queue: TaskQueue,
  action: Extract<TaskAction, { type: "task.claim" | "task.mark_running" }>,
): TaskQueue {
  const task = requireTaskWithStatus(queue, action.taskId, "queued");
  return updateTask(queue, task, action, {
    status: "running",
    attentionReason: undefined,
    ...(action.assignedAgentId !== undefined ? { assignedAgentId: cleanOptionalString(action.assignedAgentId) } : {}),
    ...(action.threadId !== undefined ? { threadId: cleanOptionalString(action.threadId) } : {}),
    ...(action.worktreePath !== undefined ? { worktreePath: cleanOptionalString(action.worktreePath) } : {}),
  });
}

function updateTask(
  queue: TaskQueue,
  task: Task,
  action: TaskAction,
  patch: Partial<Task>,
  requestedOrder?: number | undefined,
): TaskQueue {
  const next: Task = {
    ...task,
    ...patch,
    updatedAt: action.actionTs,
    evidence: [
      ...task.evidence,
      makeEvidence(action, action.summary ?? defaultActionSummary(action.type)),
    ],
  };
  const tasks = {
    ...queue.tasks,
    [next.id]: next,
  };
  return bumpQueue({
    ...queue,
    tasks: requestedOrder === undefined
      ? tasks
      : moveTaskToOrder(tasks, next.id, requestedOrder),
  });
}

function moveTaskToOrder(
  tasks: Record<string, Task>,
  taskId: string,
  requestedOrder: number,
): Record<string, Task> {
  const target = tasks[taskId];
  if (target === undefined) {
    return tasks;
  }
  const ordered = Object.values(tasks)
    .filter((task) => task.id !== taskId)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const targetIndex = Math.min(Math.max(Math.trunc(requestedOrder) - 1, 0), ordered.length);
  ordered.splice(targetIndex, 0, target);
  return Object.fromEntries(
    ordered.map((task, index) => [task.id, { ...task, order: index + 1 }]),
  );
}

function requireTask(queue: TaskQueue, taskId: string | undefined): Task {
  if (taskId === undefined || queue.tasks[taskId] === undefined) {
    throw createRuntimeFailure("MISSION_CONTROL_TASK_NOT_FOUND", "Task was not found.", { taskId });
  }
  return queue.tasks[taskId] as Task;
}

function requireTaskWithStatus(queue: TaskQueue, taskId: string | undefined, status: TaskStatus): Task {
  const task = requireTask(queue, taskId);
  if (task.status !== status) {
    throw createRuntimeFailure("MISSION_CONTROL_TASK_STATUS_INVALID", `Task must be ${status}.`, {
      taskId,
      status: task.status,
      expectedStatus: status,
    });
  }
  return task;
}

function makeEvidence(action: TaskAction, fallbackSummary: string): TaskEvidence {
  return {
    id: `${action.actionId}:evidence`,
    timestamp: action.actionTs,
    summary: action.summary ?? fallbackSummary,
    source: action.type === "task.create" ? "user" : action.type === "task.propose" ? "agent" : "runtime",
  };
}

function normalizeTask(taskId: string, value: unknown): Task | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.title !== "string" || typeof record.instructions !== "string") {
    return ;
  }
  const status = normalizeStatus(record.status);
  if (status === undefined) {
    return ;
  }
  return {
    id: typeof record.id === "string" ? record.id : taskId,
    title: record.title,
    ...(typeof record.projectPath === "string" ? { projectPath: record.projectPath } : {}),
    ...(typeof record.projectLabel === "string" ? { projectLabel: record.projectLabel } : {}),
    instructions: record.instructions,
    ...(typeof record.acceptanceCriteria === "string" ? { acceptanceCriteria: record.acceptanceCriteria } : {}),
    priority: normalizePriority(record.priority),
    status,
    createdBy: record.createdBy === "agent" ? "agent" : "user",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "1970-01-01T00:00:00.000Z",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "1970-01-01T00:00:00.000Z",
    order: typeof record.order === "number" && Number.isFinite(record.order) ? record.order : 0,
    ...(normalizeAttentionReason(record.attentionReason) !== undefined ? { attentionReason: normalizeAttentionReason(record.attentionReason) } : {}),
    ...(typeof record.assignedAgentId === "string" ? { assignedAgentId: record.assignedAgentId } : {}),
    ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(typeof record.worktreePath === "string" ? { worktreePath: record.worktreePath } : {}),
    evidence: Array.isArray(record.evidence)
      ? record.evidence.map(normalizeEvidence).filter((entry): entry is TaskEvidence => entry !== undefined)
      : [],
    ...(asRecord(record.review) !== undefined ? { review: normalizeReview(record.review, "1970-01-01T00:00:00.000Z") } : {}),
  };
}

function normalizeEvidence(value: unknown): TaskEvidence | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== "string" || typeof record.timestamp !== "string" || typeof record.summary !== "string") {
    return ;
  }
  return {
    id: record.id,
    timestamp: record.timestamp,
    summary: record.summary,
    source:
      record.source === "agent" || record.source === "runtime" || record.source === "system"
        ? record.source
        : "user",
    ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
  };
}

function normalizeReview(value: unknown, fallbackSubmittedAt: string): TaskReview {
  const record = asRecord(value) ?? {};
  return {
    submittedAt: typeof record.submittedAt === "string" ? record.submittedAt : fallbackSubmittedAt,
    summary: typeof record.summary === "string" && record.summary.trim().length > 0 ? record.summary : "Ready for review.",
    ...(typeof record.changedFileCount === "number" ? { changedFileCount: record.changedFileCount } : {}),
    ...(typeof record.testsSummary === "string" ? { testsSummary: record.testsSummary } : {}),
    ...(typeof record.previewUrl === "string" ? { previewUrl: record.previewUrl } : {}),
    ...(typeof record.pullRequestUrl === "string" ? { pullRequestUrl: record.pullRequestUrl } : {}),
  };
}

function normalizeStatus(value: unknown): TaskStatus | undefined {
  return value === "proposed" ||
    value === "queued" ||
    value === "running" ||
    value === "needs_attention" ||
    value === "ready_for_review" ||
    value === "done" ||
    value === "discarded"
    ? value
    : undefined;
}

function normalizePriority(value: unknown): TaskPriority {
  return value === "low" || value === "high" || value === "urgent" ? value : "medium";
}

function normalizeAttentionReason(value: unknown): TaskAttentionReason | undefined {
  return value === "blocked" ||
    value === "failed" ||
    value === "approval_needed" ||
    value === "human_reply_needed"
    ? value
    : undefined;
}

function requiredString(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw createRuntimeFailure("MISSION_CONTROL_TASK_FIELD_INVALID", `Task ${field} is required.`, { field });
  }
  return trimmed;
}

function cleanOptionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function defaultActionSummary(type: TaskAction["type"]): string {
  return type.replace(/^task\./u, "Task ");
}

function nextOrder(queue: TaskQueue): number {
  return Object.values(queue.tasks).reduce((highest, task) => Math.max(highest, task.order), 0) + 1;
}

function bumpQueue(queue: TaskQueue): TaskQueue {
  return {
    ...queue,
    queueVersion: queue.queueVersion + 1,
  };
}

function positiveInteger(value: unknown, fallback: number, minimum = 1): number {
  return Number.isInteger(value) && Number(value) >= minimum ? Number(value) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
