import { RunnerProtocolContractError } from "./errors.js";

export type RunnerProjectGitActionType =
  | "branch.create"
  | "branch.switch"
  | "worktree.create"
  | "commit.create"
  | "git.push"
  | "pull_request.create"
  | "pull_request.merge";

interface RunnerProjectActionBase extends Record<string, unknown> {
  sessionId: string;
  taskId?: string | undefined;
}

export type RunnerProjectGitAction =
  | ({
      type: "branch.create" | "branch.switch";
      branchName: string;
    } & RunnerProjectActionBase)
  | ({
      type: "worktree.create";
      branchName: string;
      targetPath: string;
    } & RunnerProjectActionBase)
  | ({
      type: "commit.create";
      message: string;
    } & RunnerProjectActionBase)
  | ({
      type: "git.push";
      branchName?: string | undefined;
    } & RunnerProjectActionBase)
  | ({
      type: "pull_request.create";
      title: string;
      body?: string | undefined;
      baseBranch?: string | undefined;
      branchName?: string | undefined;
    } & RunnerProjectActionBase)
  | ({
      type: "pull_request.merge";
      pullRequestNumber: number;
    } & RunnerProjectActionBase);

export type RunnerProjectAction = RunnerProjectGitAction;
export type RunnerProjectActionType = RunnerProjectGitActionType;

const GIT_ACTION_TYPES: ReadonlySet<string> = new Set([
  "branch.create",
  "branch.switch",
  "worktree.create",
  "commit.create",
  "git.push",
  "pull_request.create",
  "pull_request.merge",
]);

export function parseRunnerProjectAction(value: unknown): RunnerProjectAction {
  const record = requireRecord(value, "project.action payload");
  const type = requireNonEmptyString(
    record.type,
    "project.action payload.type",
  );
  if (GIT_ACTION_TYPES.has(type) === false) {
    throw new RunnerProtocolContractError(
      "project.action payload.type is invalid",
    );
  }
  return parseGitAction(record, type as RunnerProjectGitActionType);
}

function parseGitAction(
  record: Record<string, unknown>,
  type: RunnerProjectGitActionType,
): RunnerProjectGitAction {
  const sessionId = requireNonEmptyString(
    record.sessionId,
    "project.action payload.sessionId",
  );
  const taskId = optionalNonEmptyString(record.taskId, "taskId");
  const base = {
    sessionId,
    ...(taskId !== undefined ? { taskId } : {}),
  };
  switch (type) {
    case "branch.create":
    case "branch.switch":
      return {
        ...base,
        type,
        branchName: requireNonEmptyString(
          record.branchName,
          "project.action payload.branchName",
        ),
      };
    case "worktree.create":
      return {
        ...base,
        type,
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
        ...base,
        type,
        message: requireNonEmptyString(
          record.message,
          "project.action payload.message",
        ),
      };
    case "git.push":
      return {
        ...base,
        type,
        ...(optionalString(record.branchName) !== undefined
          ? { branchName: optionalString(record.branchName) }
          : {}),
      };
    case "pull_request.create":
      return {
        ...base,
        type,
        title: requireNonEmptyString(
          record.title,
          "project.action payload.title",
        ),
        ...(optionalString(record.body) !== undefined
          ? { body: optionalString(record.body) }
          : {}),
        ...(optionalString(record.baseBranch) !== undefined
          ? { baseBranch: optionalString(record.baseBranch) }
          : {}),
        ...(optionalString(record.branchName) !== undefined
          ? { branchName: optionalString(record.branchName) }
          : {}),
      };
    case "pull_request.merge":
      if (
        typeof record.pullRequestNumber !== "number" ||
        Number.isSafeInteger(record.pullRequestNumber) === false ||
        record.pullRequestNumber <= 0
      ) {
        throw new RunnerProtocolContractError(
          "project.action payload.pullRequestNumber must be a positive integer",
        );
      }
      return {
        ...base,
        type,
        pullRequestNumber: record.pullRequestNumber,
      };
  }
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerProtocolContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunnerProtocolContractError(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new RunnerProtocolContractError(
      "project.action optional field must be a string",
    );
  }
  return value;
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  return value === undefined
    ? undefined
    : requireNonEmptyString(value, `project.action payload.${field}`);
}
