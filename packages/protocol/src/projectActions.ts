import { RunnerProtocolContractError } from "./errors.js";

export type RunnerProjectGitActionType =
  | "branch.create"
  | "branch.switch"
  | "worktree.create"
  | "commit.create"
  | "git.push"
  | "pull_request.create"
  | "pull_request.merge";

export type RunnerProjectBoardActionType =
  | "board.autopilot.configure"
  | "board.autopilot.tick"
  | "board.card.create"
  | "board.card.update"
  | "board.card.move"
  | "board.card.manual_done"
  | "board.card.delete"
  | "board.card.start_implementation"
  | "board.card.start_testing"
  | "board.card.thread_completed"
  | "board.card.thread_failed"
  | "board.card.thread_stopped"
  | "board.card.testing_verdict";

export type RunnerTaskActionType =
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

export type RunnerProjectActionType =
  | RunnerProjectGitActionType
  | RunnerProjectBoardActionType
  | RunnerTaskActionType;

export type RunnerProjectBoardLane =
  | "idea"
  | "planned"
  | "wip"
  | "testing"
  | "done";

export type RunnerProjectBoardEvidenceSource =
  | "autopilot"
  | "copilot"
  | "operator"
  | "implementation_thread"
  | "testing_thread"
  | "tool";

export type RunnerTaskPriority = "low" | "medium" | "high" | "urgent";
export type RunnerTaskAttentionReason =
  | "blocked"
  | "failed"
  | "approval_needed"
  | "human_reply_needed";

export interface RunnerTaskReview {
  submittedAt: string;
  summary: string;
  changedFileCount?: number | undefined;
  testsSummary?: string | undefined;
  previewUrl?: string | undefined;
  pullRequestUrl?: string | undefined;
}

interface RunnerProjectActionBase extends Record<string, unknown> {
  sessionId: string;
  taskId?: string | undefined;
}

interface RunnerProjectBoardActionBase extends RunnerProjectActionBase {
  type: RunnerProjectBoardActionType;
  actionId: string;
  actionTs: string;
  expectedBoardVersion?: number | undefined;
  summary?: string | undefined;
  source?: RunnerProjectBoardEvidenceSource | undefined;
}

interface RunnerTaskActionBase extends RunnerProjectActionBase {
  type: RunnerTaskActionType;
  actionId: string;
  actionTs: string;
  summary?: string | undefined;
}

export type RunnerProjectGitAction =
  | ({ type: "branch.create" | "branch.switch"; branchName: string } & RunnerProjectActionBase)
  | ({ type: "worktree.create"; branchName: string; targetPath: string } & RunnerProjectActionBase)
  | ({ type: "commit.create"; message: string } & RunnerProjectActionBase)
  | ({ type: "git.push"; branchName?: string | undefined } & RunnerProjectActionBase)
  | ({
      type: "pull_request.create";
      title: string;
      body?: string | undefined;
      baseBranch?: string | undefined;
      branchName?: string | undefined;
    } & RunnerProjectActionBase)
  | ({ type: "pull_request.merge"; pullRequestNumber: number } & RunnerProjectActionBase);

export type RunnerProjectBoardAction =
  | ({
      type: "board.autopilot.configure";
      autopilotEnabled?: boolean | undefined;
      autopilotConfirmedAt?: string | undefined;
      wipLimit?: number | undefined;
    } & RunnerProjectBoardActionBase)
  | ({ type: "board.autopilot.tick" } & RunnerProjectBoardActionBase)
  | ({ type: "board.card.create"; title: string; prompt: string } & RunnerProjectBoardActionBase)
  | ({
      type: "board.card.update";
      cardId: string;
      title?: string | undefined;
      prompt?: string | undefined;
    } & RunnerProjectBoardActionBase)
  | ({
      type: "board.card.move";
      cardId: string;
      targetLane: RunnerProjectBoardLane;
      lane?: RunnerProjectBoardLane | undefined;
      order?: number | undefined;
    } & RunnerProjectBoardActionBase)
  | ({
      type: "board.card.manual_done";
      cardId: string;
      reason?: string | undefined;
    } & RunnerProjectBoardActionBase)
  | ({
      type:
        | "board.card.delete"
        | "board.card.start_implementation"
        | "board.card.start_testing"
        | "board.card.thread_completed"
        | "board.card.thread_failed"
        | "board.card.thread_stopped";
      cardId: string;
    } & RunnerProjectBoardActionBase)
  | ({
      type: "board.card.testing_verdict";
      cardId: string;
      testingVerdict: "pass" | "fail";
    } & RunnerProjectBoardActionBase);

export type RunnerTaskAction =
  | ({
      type: "task.create" | "task.propose";
      title: string;
      instructions: string;
      acceptanceCriteria?: string | undefined;
      priority?: RunnerTaskPriority | undefined;
      projectPath?: string | undefined;
      projectLabel?: string | undefined;
    } & RunnerTaskActionBase)
  | ({ type: "task.approve" | "task.retry"; taskId: string } & RunnerTaskActionBase)
  | ({
      type: "task.update";
      taskId: string;
      title?: string | undefined;
      instructions?: string | undefined;
      acceptanceCriteria?: string | undefined;
      priority?: RunnerTaskPriority | undefined;
      projectPath?: string | undefined;
      projectLabel?: string | undefined;
    } & RunnerTaskActionBase)
  | ({ type: "task.reorder"; taskId: string; order: number } & RunnerTaskActionBase)
  | ({
      type: "task.claim" | "task.mark_running";
      taskId: string;
      assignedAgentId?: string | undefined;
      threadId?: string | undefined;
      worktreePath?: string | undefined;
    } & RunnerTaskActionBase)
  | ({
      type: "task.needs_attention";
      taskId: string;
      attentionReason: RunnerTaskAttentionReason;
    } & RunnerTaskActionBase)
  | ({ type: "task.submit_review"; taskId: string; review: RunnerTaskReview } & RunnerTaskActionBase)
  | ({
      type: "task.request_changes";
      taskId: string;
      instructions?: string | undefined;
    } & RunnerTaskActionBase)
  | ({
      type: "task.accept" | "task.discard" | "task.stop";
      taskId: string;
    } & RunnerTaskActionBase);

export type RunnerProjectAction =
  | RunnerProjectGitAction
  | RunnerProjectBoardAction
  | RunnerTaskAction;

const GIT_ACTION_TYPES: ReadonlySet<string> = new Set([
  "branch.create",
  "branch.switch",
  "worktree.create",
  "commit.create",
  "git.push",
  "pull_request.create",
  "pull_request.merge",
]);

const BOARD_ACTION_TYPES: ReadonlySet<string> = new Set([
  "board.autopilot.configure",
  "board.autopilot.tick",
  "board.card.create",
  "board.card.update",
  "board.card.move",
  "board.card.manual_done",
  "board.card.delete",
  "board.card.start_implementation",
  "board.card.start_testing",
  "board.card.thread_completed",
  "board.card.thread_failed",
  "board.card.thread_stopped",
  "board.card.testing_verdict",
]);

const TASK_ACTION_TYPES: ReadonlySet<string> = new Set([
  "task.create",
  "task.propose",
  "task.approve",
  "task.update",
  "task.reorder",
  "task.claim",
  "task.mark_running",
  "task.needs_attention",
  "task.submit_review",
  "task.request_changes",
  "task.retry",
  "task.accept",
  "task.discard",
  "task.stop",
]);

export function parseRunnerProjectAction(value: unknown): RunnerProjectAction {
  const record = requireRecord(value, "project.action payload");
  const type = requireNonEmptyString(record.type, "project.action payload.type");
  if (GIT_ACTION_TYPES.has(type)) {
    return parseGitAction(record, type as RunnerProjectGitActionType) as RunnerProjectAction;
  }
  if (BOARD_ACTION_TYPES.has(type)) {
    return parseBoardAction(record, type as RunnerProjectBoardActionType) as RunnerProjectAction;
  }
  if (TASK_ACTION_TYPES.has(type)) {
    return parseTaskAction(record, type as RunnerTaskActionType) as RunnerProjectAction;
  }
  throw new RunnerProtocolContractError("project.action payload.type is invalid");
}

function parseGitAction(
  record: Record<string, unknown>,
  type: RunnerProjectGitActionType,
): Record<string, unknown> {
  const sessionId = requireNonEmptyString(
    record.sessionId,
    "project.action payload.sessionId",
  );
  const taskId = optionalNonEmptyString(
    record.taskId,
    "project.action payload.taskId",
    "taskId",
  );
  switch (type) {
    case "branch.create":
    case "branch.switch":
      return {
        type,
        sessionId,
        ...taskId,
        branchName: requireNonEmptyString(
          record.branchName,
          "project.action payload.branchName",
        ),
      };
    case "worktree.create":
      return {
        type,
        sessionId,
        ...taskId,
        branchName: requireNonEmptyString(
          record.branchName,
          "project.action payload.branchName",
        ),
        targetPath: requireNonEmptyString(
          record.targetPath,
          "project.action payload.targetPath",
        ),
      };
    case "commit.create":
      return {
        type,
        sessionId,
        ...taskId,
        message: requireNonEmptyString(
          record.message,
          "project.action payload.message",
        ),
      };
    case "git.push":
      return {
        type,
        sessionId,
        ...taskId,
        ...optionalString(
          record.branchName,
          "project.action payload.branchName",
          "branchName",
        ),
      };
    case "pull_request.create":
      return {
        type,
        sessionId,
        ...taskId,
        title: requireNonEmptyString(
          record.title,
          "project.action payload.title",
        ),
        ...optionalString(record.body, "project.action payload.body", "body"),
        ...optionalString(
          record.baseBranch,
          "project.action payload.baseBranch",
          "baseBranch",
        ),
        ...optionalString(
          record.branchName,
          "project.action payload.branchName",
          "branchName",
        ),
      };
    case "pull_request.merge":
      if (
        typeof record.pullRequestNumber !== "number"
        || Number.isInteger(record.pullRequestNumber) === false
        || record.pullRequestNumber <= 0
      ) {
        throw new RunnerProtocolContractError(
          "project.action payload.pullRequestNumber must be a positive integer",
        );
      }
      return {
        type,
        sessionId,
        ...taskId,
        pullRequestNumber: record.pullRequestNumber,
      };
  }
}

function parseBoardAction(
  record: Record<string, unknown>,
  type: RunnerProjectBoardActionType,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type,
    sessionId: requireNonEmptyString(
      record.sessionId,
      "project.action payload.sessionId",
    ),
    actionId: requireNonEmptyString(
      record.actionId,
      "project.action payload.actionId",
    ),
    actionTs: requireTimestamp(
      record.actionTs,
      "project.action payload.actionTs",
    ),
    ...optionalNonNegativeInteger(
      record.expectedBoardVersion,
      "project.action payload.expectedBoardVersion",
      "expectedBoardVersion",
    ),
    ...optionalNonEmptyString(
      record.taskId,
      "project.action payload.taskId",
      "taskId",
    ),
    ...optionalString(record.summary, "project.action payload.summary", "summary"),
    ...optionalEnum(
      record.source,
      "project.action payload.source",
      "source",
      [
        "autopilot",
        "copilot",
        "operator",
        "implementation_thread",
        "testing_thread",
        "tool",
      ],
    ),
  };
  switch (type) {
    case "board.autopilot.configure": {
      const wipLimit = optionalPositiveIntegerValue(
        record.wipLimit,
        "project.action payload.wipLimit",
      );
      return {
        ...base,
        ...optionalBoolean(
          record.autopilotEnabled,
          "project.action payload.autopilotEnabled",
          "autopilotEnabled",
        ),
        ...(record.autopilotConfirmedAt === undefined
          ? {}
          : {
              autopilotConfirmedAt: requireTimestamp(
                record.autopilotConfirmedAt,
                "project.action payload.autopilotConfirmedAt",
              ),
            }),
        ...(wipLimit === undefined ? {} : { wipLimit }),
      };
    }
    case "board.autopilot.tick":
      return base;
    case "board.card.create":
      return {
        ...base,
        title: requireNonEmptyString(record.title, "project.action payload.title"),
        prompt: requireNonEmptyString(record.prompt, "project.action payload.prompt"),
      };
    case "board.card.update":
      return {
        ...base,
        cardId: requireNonEmptyString(record.cardId, "project.action payload.cardId"),
        ...optionalNonEmptyString(record.title, "project.action payload.title", "title"),
        ...optionalNonEmptyString(record.prompt, "project.action payload.prompt", "prompt"),
      };
    case "board.card.move":
      return {
        ...base,
        cardId: requireNonEmptyString(record.cardId, "project.action payload.cardId"),
        targetLane: requireEnum(
          record.targetLane,
          "project.action payload.targetLane",
          ["idea", "planned", "wip", "testing", "done"],
        ),
        ...optionalEnum(
          record.lane,
          "project.action payload.lane",
          "lane",
          ["idea", "planned", "wip", "testing", "done"],
        ),
        ...optionalFiniteNumber(record.order, "project.action payload.order", "order"),
      };
    case "board.card.manual_done":
      return {
        ...base,
        cardId: requireNonEmptyString(record.cardId, "project.action payload.cardId"),
        ...optionalString(record.reason, "project.action payload.reason", "reason"),
      };
    case "board.card.delete":
    case "board.card.start_implementation":
    case "board.card.start_testing":
    case "board.card.thread_completed":
    case "board.card.thread_failed":
    case "board.card.thread_stopped":
      return {
        ...base,
        cardId: requireNonEmptyString(record.cardId, "project.action payload.cardId"),
      };
    case "board.card.testing_verdict":
      return {
        ...base,
        cardId: requireNonEmptyString(record.cardId, "project.action payload.cardId"),
        testingVerdict: requireEnum(
          record.testingVerdict,
          "project.action payload.testingVerdict",
          ["pass", "fail"],
        ),
      };
  }
}

function parseTaskAction(
  record: Record<string, unknown>,
  type: RunnerTaskActionType,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type,
    sessionId: requireNonEmptyString(
      record.sessionId,
      "project.action payload.sessionId",
    ),
    actionId: requireNonEmptyString(
      record.actionId,
      "project.action payload.actionId",
    ),
    actionTs: requireTimestamp(
      record.actionTs,
      "project.action payload.actionTs",
    ),
    ...optionalString(record.summary, "project.action payload.summary", "summary"),
  };
  switch (type) {
    case "task.create":
    case "task.propose":
      return {
        ...base,
        title: requireNonEmptyString(record.title, "project.action payload.title"),
        instructions: requireNonEmptyString(
          record.instructions,
          "project.action payload.instructions",
        ),
        ...optionalString(
          record.acceptanceCriteria,
          "project.action payload.acceptanceCriteria",
          "acceptanceCriteria",
        ),
        ...optionalTaskPriority(record.priority),
        ...optionalString(
          record.projectPath,
          "project.action payload.projectPath",
          "projectPath",
        ),
        ...optionalString(
          record.projectLabel,
          "project.action payload.projectLabel",
          "projectLabel",
        ),
      };
    case "task.update":
      return {
        ...base,
        taskId: requireNonEmptyString(record.taskId, "project.action payload.taskId"),
        ...optionalString(record.title, "project.action payload.title", "title"),
        ...optionalString(
          record.instructions,
          "project.action payload.instructions",
          "instructions",
        ),
        ...optionalString(
          record.acceptanceCriteria,
          "project.action payload.acceptanceCriteria",
          "acceptanceCriteria",
        ),
        ...optionalTaskPriority(record.priority),
        ...optionalString(
          record.projectPath,
          "project.action payload.projectPath",
          "projectPath",
        ),
        ...optionalString(
          record.projectLabel,
          "project.action payload.projectLabel",
          "projectLabel",
        ),
      };
    case "task.reorder":
      if (typeof record.order !== "number" || Number.isFinite(record.order) === false) {
        throw new RunnerProtocolContractError(
          "project.action payload.order must be a finite number",
        );
      }
      return {
        ...base,
        taskId: requireNonEmptyString(record.taskId, "project.action payload.taskId"),
        order: record.order,
      };
    case "task.claim":
    case "task.mark_running":
      return {
        ...base,
        taskId: requireNonEmptyString(record.taskId, "project.action payload.taskId"),
        ...optionalString(
          record.assignedAgentId,
          "project.action payload.assignedAgentId",
          "assignedAgentId",
        ),
        ...optionalString(
          record.threadId,
          "project.action payload.threadId",
          "threadId",
        ),
        ...optionalString(
          record.worktreePath,
          "project.action payload.worktreePath",
          "worktreePath",
        ),
      };
    case "task.needs_attention":
      return {
        ...base,
        taskId: requireNonEmptyString(record.taskId, "project.action payload.taskId"),
        attentionReason: requireEnum(
          record.attentionReason,
          "project.action payload.attentionReason",
          ["blocked", "failed", "approval_needed", "human_reply_needed"],
        ),
      };
    case "task.submit_review":
      return {
        ...base,
        taskId: requireNonEmptyString(record.taskId, "project.action payload.taskId"),
        review: parseTaskReview(record.review),
      };
    case "task.request_changes":
      return {
        ...base,
        taskId: requireNonEmptyString(record.taskId, "project.action payload.taskId"),
        ...optionalString(
          record.instructions,
          "project.action payload.instructions",
          "instructions",
        ),
      };
    case "task.approve":
    case "task.retry":
    case "task.accept":
    case "task.discard":
    case "task.stop":
      return {
        ...base,
        taskId: requireNonEmptyString(record.taskId, "project.action payload.taskId"),
      };
  }
}

function parseTaskReview(value: unknown): Record<string, unknown> {
  const record = requireRecord(value, "project.action payload.review");
  const submittedAt = requireTimestamp(
    record.submittedAt,
    "project.action payload.review.submittedAt",
  );
  if (
    record.changedFileCount !== undefined
    && (typeof record.changedFileCount !== "number"
      || Number.isInteger(record.changedFileCount) === false
      || record.changedFileCount < 0)
  ) {
    throw new RunnerProtocolContractError(
      "project.action payload.review.changedFileCount must be a non-negative integer",
    );
  }
  for (const field of ["testsSummary", "previewUrl", "pullRequestUrl"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      throw new RunnerProtocolContractError(
        `project.action payload.review.${field} must be a string`,
      );
    }
  }
  return {
    submittedAt,
    summary: requireNonEmptyString(
      record.summary,
      "project.action payload.review.summary",
    ),
    ...(record.changedFileCount !== undefined
      ? { changedFileCount: record.changedFileCount }
      : {}),
    ...(typeof record.testsSummary === "string"
      ? { testsSummary: record.testsSummary }
      : {}),
    ...(typeof record.previewUrl === "string" ? { previewUrl: record.previewUrl } : {}),
    ...(typeof record.pullRequestUrl === "string"
      ? { pullRequestUrl: record.pullRequestUrl }
      : {}),
  };
}

function optionalTaskPriority(value: unknown): Record<string, unknown> {
  return optionalEnum(
    value,
    "project.action payload.priority",
    "priority",
    ["low", "medium", "high", "urgent"],
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerProtocolContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunnerProtocolContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new RunnerProtocolContractError(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || allowed.includes(value) === false) {
    throw new RunnerProtocolContractError(
      `${label} must be one of ${allowed.join(", ")}`,
    );
  }
  return value as T[number];
}

function optionalString(
  value: unknown,
  label: string,
  key: string,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new RunnerProtocolContractError(`${label} must be a string`);
  }
  return { [key]: value };
}

function optionalNonEmptyString(
  value: unknown,
  label: string,
  key: string,
): Record<string, unknown> {
  return value === undefined ? {} : { [key]: requireNonEmptyString(value, label) };
}

function optionalBoolean(
  value: unknown,
  label: string,
  key: string,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "boolean") {
    throw new RunnerProtocolContractError(`${label} must be a boolean`);
  }
  return { [key]: value };
}

function optionalFiniteNumber(
  value: unknown,
  label: string,
  key: string,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    throw new RunnerProtocolContractError(`${label} must be a finite number`);
  }
  return { [key]: value };
}

function optionalNonNegativeInteger(
  value: unknown,
  label: string,
  key: string,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || Number.isInteger(value) === false || value < 0) {
    throw new RunnerProtocolContractError(
      `${label} must be a non-negative integer`,
    );
  }
  return { [key]: value };
}

function optionalPositiveIntegerValue(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isInteger(value) === false || value <= 0) {
    throw new RunnerProtocolContractError(`${label} must be a positive integer`);
  }
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  label: string,
  key: string,
  allowed: T,
): Record<string, unknown> {
  return value === undefined ? {} : { [key]: requireEnum(value, label, allowed) };
}
