export type TaskStatus =
  | "proposed"
  | "queued"
  | "running"
  | "needs_attention"
  | "ready_for_review"
  | "done"
  | "discarded";

export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskCreator = "user" | "agent";
export type TaskAttentionReason =
  | "blocked"
  | "failed"
  | "approval_needed"
  | "human_reply_needed";

export interface TaskEvidence {
  id: string;
  timestamp: string;
  summary: string;
  source: "user" | "agent" | "runtime" | "system";
  threadId?: string | undefined;
  runId?: string | undefined;
}

export interface TaskReview {
  submittedAt: string;
  summary: string;
  changedFileCount?: number | undefined;
  testsSummary?: string | undefined;
  previewUrl?: string | undefined;
  pullRequestUrl?: string | undefined;
}

export interface Task {
  id: string;
  title: string;
  projectPath?: string | undefined;
  projectLabel?: string | undefined;
  instructions: string;
  acceptanceCriteria?: string | undefined;
  priority: TaskPriority;
  status: TaskStatus;
  createdBy: TaskCreator;
  createdAt: string;
  updatedAt: string;
  order: number;
  attentionReason?: TaskAttentionReason | undefined;
  assignedAgentId?: string | undefined;
  threadId?: string | undefined;
  sessionId?: string | undefined;
  worktreePath?: string | undefined;
  evidence: TaskEvidence[];
  review?: TaskReview | undefined;
}

export interface TaskQueue {
  version: 1;
  queueVersion: number;
  nextTaskNumber: number;
  tasks: Record<string, Task>;
}

export type TaskActionType =
  | "task.create"
  | "task.propose"
  | "task.approve"
  | "task.update"
  | "task.reorder"
  | "task.claim"
  | "task.mark_running"
  | "task.needs_attention"
  | "task.submit_review"
  | "task.request_changes"
  | "task.retry"
  | "task.accept"
  | "task.discard"
  | "task.stop";

export interface TaskActionBase {
  type: TaskActionType;
  sessionId: string;
  actionId: string;
  actionTs: string;
  taskId?: string | undefined;
  summary?: string | undefined;
}

export type TaskAction =
  | ({
      type: "task.create" | "task.propose";
      title: string;
      instructions: string;
      acceptanceCriteria?: string | undefined;
      priority?: TaskPriority | undefined;
      projectPath?: string | undefined;
      projectLabel?: string | undefined;
    } & TaskActionBase)
  | ({
      type: "task.approve" | "task.retry";
      taskId: string;
    } & TaskActionBase)
  | ({
      type: "task.update";
      taskId: string;
      title?: string | undefined;
      instructions?: string | undefined;
      acceptanceCriteria?: string | undefined;
      priority?: TaskPriority | undefined;
      projectPath?: string | undefined;
      projectLabel?: string | undefined;
    } & TaskActionBase)
  | ({
      type: "task.reorder";
      taskId: string;
      order: number;
    } & TaskActionBase)
  | ({
      type: "task.claim" | "task.mark_running";
      taskId: string;
      assignedAgentId?: string | undefined;
      threadId?: string | undefined;
      worktreePath?: string | undefined;
    } & TaskActionBase)
  | ({
      type: "task.needs_attention";
      taskId: string;
      attentionReason: TaskAttentionReason;
    } & TaskActionBase)
  | ({
      type: "task.submit_review";
      taskId: string;
      review: TaskReview;
    } & TaskActionBase)
  | ({
      type: "task.request_changes";
      taskId: string;
      instructions?: string | undefined;
    } & TaskActionBase)
  | ({
      type: "task.accept" | "task.discard" | "task.stop";
      taskId: string;
    } & TaskActionBase);

export function parseTaskAction(value: unknown): TaskAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task action must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.startsWith("task.") === false) {
    throw new Error("task action type is invalid");
  }
  const sessionId = requireTaskActionString(record.sessionId, "sessionId");
  const actionId = requireTaskActionString(record.actionId, "actionId");
  if (typeof record.actionTs !== "string" || Number.isNaN(Date.parse(record.actionTs))) {
    throw new Error("task action actionTs must be an ISO timestamp");
  }
  const base = {
    sessionId,
    actionId,
    actionTs: record.actionTs,
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
  };

  switch (record.type) {
    case "task.create":
    case "task.propose":
      return {
        ...base,
        type: record.type,
        title: requireTaskActionString(record.title, "title"),
        instructions: requireTaskActionString(record.instructions, "instructions"),
        ...(typeof record.acceptanceCriteria === "string"
          ? { acceptanceCriteria: record.acceptanceCriteria }
          : {}),
        ...(isTaskPriority(record.priority) ? { priority: record.priority } : {}),
        ...(typeof record.projectPath === "string" ? { projectPath: record.projectPath } : {}),
        ...(typeof record.projectLabel === "string" ? { projectLabel: record.projectLabel } : {}),
      };
    case "task.update":
      return {
        ...base,
        type: record.type,
        taskId: requireTaskActionString(record.taskId, "taskId"),
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        ...(typeof record.instructions === "string" ? { instructions: record.instructions } : {}),
        ...(typeof record.acceptanceCriteria === "string"
          ? { acceptanceCriteria: record.acceptanceCriteria }
          : {}),
        ...(isTaskPriority(record.priority) ? { priority: record.priority } : {}),
        ...(typeof record.projectPath === "string" ? { projectPath: record.projectPath } : {}),
        ...(typeof record.projectLabel === "string" ? { projectLabel: record.projectLabel } : {}),
      };
    case "task.reorder":
      if (typeof record.order !== "number" || Number.isFinite(record.order) === false) {
        throw new Error("task action order must be a finite number");
      }
      return {
        ...base,
        type: record.type,
        taskId: requireTaskActionString(record.taskId, "taskId"),
        order: record.order,
      };
    case "task.claim":
    case "task.mark_running":
      return {
        ...base,
        type: record.type,
        taskId: requireTaskActionString(record.taskId, "taskId"),
        ...(typeof record.assignedAgentId === "string"
          ? { assignedAgentId: record.assignedAgentId }
          : {}),
        ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
        ...(typeof record.worktreePath === "string" ? { worktreePath: record.worktreePath } : {}),
      };
    case "task.needs_attention":
      if (isTaskAttentionReason(record.attentionReason) === false) {
        throw new Error("task action attentionReason is invalid");
      }
      return {
        ...base,
        type: record.type,
        taskId: requireTaskActionString(record.taskId, "taskId"),
        attentionReason: record.attentionReason,
      };
    case "task.submit_review":
      return {
        ...base,
        type: record.type,
        taskId: requireTaskActionString(record.taskId, "taskId"),
        review: parseTaskReview(record.review),
      };
    case "task.request_changes":
      return {
        ...base,
        type: record.type,
        taskId: requireTaskActionString(record.taskId, "taskId"),
        ...(typeof record.instructions === "string" ? { instructions: record.instructions } : {}),
      };
    case "task.approve":
    case "task.retry":
    case "task.accept":
    case "task.discard":
    case "task.stop":
      return {
        ...base,
        type: record.type,
        taskId: requireTaskActionString(record.taskId, "taskId"),
      };
    default:
      throw new Error("task action type is invalid");
  }
}

function requireTaskActionString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`task action ${field} must be a non-empty string`);
  }
  return value;
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return value === "low" || value === "medium" || value === "high" || value === "urgent";
}

function isTaskAttentionReason(value: unknown): value is TaskAttentionReason {
  return value === "blocked"
    || value === "failed"
    || value === "approval_needed"
    || value === "human_reply_needed";
}

function parseTaskReview(value: unknown): TaskReview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task action review must be an object");
  }
  const record = value as Record<string, unknown>;
  const submittedAt = requireTaskActionString(record.submittedAt, "review.submittedAt");
  if (Number.isNaN(Date.parse(submittedAt))) {
    throw new Error("task action review.submittedAt must be an ISO timestamp");
  }
  if (
    record.changedFileCount !== undefined
    && (
      typeof record.changedFileCount !== "number"
      || Number.isInteger(record.changedFileCount) === false
      || record.changedFileCount < 0
    )
  ) {
    throw new Error("task action review.changedFileCount must be a non-negative integer");
  }
  for (const field of ["testsSummary", "previewUrl", "pullRequestUrl"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      throw new Error(`task action review.${field} must be a string`);
    }
  }
  return {
    submittedAt,
    summary: requireTaskActionString(record.summary, "review.summary"),
    ...(record.changedFileCount !== undefined
      ? { changedFileCount: record.changedFileCount as number }
      : {}),
    ...(typeof record.testsSummary === "string" ? { testsSummary: record.testsSummary } : {}),
    ...(typeof record.previewUrl === "string" ? { previewUrl: record.previewUrl } : {}),
    ...(typeof record.pullRequestUrl === "string"
      ? { pullRequestUrl: record.pullRequestUrl }
      : {}),
  };
}
