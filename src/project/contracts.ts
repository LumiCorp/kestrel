import type { ProductTaskGraph } from "../taskGraph/contracts.js";
import type { TaskAction, TaskQueue } from "../missionControl/contracts.js";

export type ProductSandboxMode = "workspace_write" | "read_only" | "full_access";
export type ProductApprovalMode = "manual" | "on_request" | "auto";
export type ProductCapabilityScope = "disabled" | "task" | "project";
export type ProductBoardLane = "idea" | "planned" | "wip" | "testing" | "done";
export type ProductBoardThreadKind = "implementation" | "testing";
export type ProductBoardEvidenceSource =
  | "autopilot"
  | "copilot"
  | "operator"
  | "implementation_thread"
  | "testing_thread"
  | "tool";
export type ProductBoardEvidenceOutcome =
  | "created"
  | "updated"
  | "moved"
  | "deleted"
  | "claimed"
  | "claim_failed"
  | "thread_started"
  | "thread_stopped"
  | "success"
  | "failure"
  | "manual_done"
  | "verdict_pass"
  | "verdict_fail";

export interface ProductBoardSettings {
  autopilotEnabled: boolean;
  autopilotConfirmedAt?: string | undefined;
  wipLimit: number;
}

export interface ProductBoardClaim {
  threadId: string;
  sessionId: string;
  kind: ProductBoardThreadKind;
  claimedAt: string;
  claimReason: "autopilot" | "copilot";
}

export interface ProductBoardThreadLink {
  threadId: string;
  sessionId: string;
  kind: ProductBoardThreadKind;
  startedAt: string;
  completedAt?: string | undefined;
  status?: "active" | "completed" | "failed" | "stopped" | undefined;
}

export interface ProductBoardEvidenceEntry {
  id: string;
  timestamp: string;
  source: ProductBoardEvidenceSource;
  outcome: ProductBoardEvidenceOutcome;
  summary: string;
  threadId?: string | undefined;
}

export interface ProductBoardCard {
  id: string;
  title: string;
  prompt: string;
  lane: ProductBoardLane;
  order: number;
  createdAt: string;
  updatedAt: string;
  activeClaim?: ProductBoardClaim | undefined;
  threads: ProductBoardThreadLink[];
  evidence: ProductBoardEvidenceEntry[];
}

export interface ProductBoardSnapshot {
  version: 1;
  boardVersion: number;
  nextCardNumber: number;
  lanes: ProductBoardLane[];
  settings: ProductBoardSettings;
  cards: Record<string, ProductBoardCard>;
}

export interface ProductTaskPolicyOverride {
  sandboxMode?: ProductSandboxMode | undefined;
  approvalMode?: ProductApprovalMode | undefined;
  toolClassPolicy?: Partial<Record<"read_only" | "sandboxed_only" | "external_side_effect", boolean>> | undefined;
}

export interface ProductPolicyDecisionRecord {
  id: string;
  timestamp: string;
  summary: string;
  taskId?: string | undefined;
}

export interface ProductProjectSetupState {
  workspaceRoot: string;
  repoRoot: string;
  repoLabel: string;
  defaultBranch: string;
  providerProfileId: string;
  githubOwner?: string | undefined;
  githubRepo?: string | undefined;
  githubConnected: boolean;
  browserReady: boolean;
  codeReady: boolean;
  mcpReady: boolean;
}

export interface ProductProjectPolicyState {
  sandboxMode: ProductSandboxMode;
  approvalMode: ProductApprovalMode;
  toolClassPolicy: Partial<Record<"read_only" | "sandboxed_only" | "external_side_effect", boolean>>;
  browserScope: ProductCapabilityScope;
  githubScope: ProductCapabilityScope;
  mcpScope: ProductCapabilityScope;
  taskOverrides: Record<string, ProductTaskPolicyOverride>;
  recentDecisions: ProductPolicyDecisionRecord[];
}

export interface ProductBranchSummary {
  name: string;
  current?: boolean | undefined;
}

export interface ProductWorktreeSummary {
  path: string;
  branch?: string | undefined;
  current?: boolean | undefined;
}

export interface ProductPullRequestSummary {
  number: number;
  title: string;
  branch: string;
  baseBranch: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  url?: string | undefined;
}

export interface ProductCommitSummary {
  sha: string;
  summary: string;
}

export interface ProductReviewChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface ProductReviewDiffHunk {
  header: string;
  lines: string[];
}

export interface ProductReviewComment {
  id: string;
  body: string;
  author: string;
  createdAt?: string | undefined;
  path?: string | undefined;
  line?: number | undefined;
  state?: string | undefined;
}

export interface ProductReviewCheckRun {
  id: string;
  name: string;
  status: string;
  conclusion?: string | undefined;
  detailsUrl?: string | undefined;
}

export interface ProductReviewTarget {
  taskId?: string | undefined;
  branchName?: string | undefined;
  worktreePath?: string | undefined;
  pullRequestNumber?: number | undefined;
  filePath?: string | undefined;
}

export interface ProductReviewDetail {
  target: ProductReviewTarget;
  repoRoot?: string | undefined;
  branchName?: string | undefined;
  worktreePath?: string | undefined;
  pullRequestNumber?: number | undefined;
  pullRequestTitle?: string | undefined;
  pullRequestState?: "OPEN" | "MERGED" | "CLOSED" | undefined;
  pullRequestUrl?: string | undefined;
  baseBranch?: string | undefined;
  headSha?: string | undefined;
  mergeState?: string | undefined;
  reviewDecision?: string | undefined;
  selectedFilePath?: string | undefined;
  changedFiles: ProductReviewChangedFile[];
  diffHunks: ProductReviewDiffHunk[];
  recentCommits: ProductCommitSummary[];
  checks: ProductReviewCheckRun[];
  comments: ProductReviewComment[];
}

export interface ProductReviewAction {
  type: "review.refresh" | "review.comment.create";
  sessionId: string;
  target: ProductReviewTarget;
  body?: string | undefined;
  path?: string | undefined;
  line?: number | undefined;
  side?: "LEFT" | "RIGHT" | undefined;
}

export interface ProductReviewSnapshot {
  repoRoot?: string | undefined;
  currentBranch?: string | undefined;
  statusSummary?: string | undefined;
  branches: ProductBranchSummary[];
  worktrees: ProductWorktreeSummary[];
  pullRequests: ProductPullRequestSummary[];
  recentCommits: ProductCommitSummary[];
}

export interface ProductActivityItem {
  id: string;
  kind:
    | "task"
    | "approval"
    | "checkpoint"
    | "delegation"
    | "code"
    | "browser"
    | "terminal"
    | "review"
    | "result";
  title: string;
  detail: string;
  timestamp: string;
  taskId?: string | undefined;
  threadId?: string | undefined;
  status?: string | undefined;
  badges?: string[] | undefined;
}

export interface ProductWorkspaceCheckpointActivity {
  id: string;
  kind: "capture" | "restore" | "cleanup" | "promotion";
  checkpointId?: string | undefined;
  restoreId?: string | undefined;
  promotionId?: string | undefined;
  label: string;
  status: string;
  timestamp: string;
}

export interface ProductWorkspaceCheckpointSummary {
  latestCheckpointId?: string | undefined;
  latestRestoreId?: string | undefined;
  latestRestoreStatus?: string | undefined;
  latestPromotionId?: string | undefined;
  latestPromotionStatus?: string | undefined;
  latestCleanupId?: string | undefined;
  latestCleanupAt?: string | undefined;
  latestCleanupDeletedCheckpointCount?: number | undefined;
  retainedCheckpointCount?: number | undefined;
  retainedBytes?: number | undefined;
  recentActivity: ProductWorkspaceCheckpointActivity[];
}

export interface ProductProjectSnapshot {
  version: 1;
  graphVersion: ProductTaskGraph["version"];
  setup: ProductProjectSetupState;
  policy: ProductProjectPolicyState;
  board: ProductBoardSnapshot;
  taskQueue: TaskQueue;
  review: ProductReviewSnapshot;
  workspaceCheckpoints: ProductWorkspaceCheckpointSummary;
  activity: ProductActivityItem[];
}

export type ProductProjectGitActionType =
  | "branch.create"
  | "branch.switch"
  | "worktree.create"
  | "commit.create"
  | "git.push"
  | "pull_request.create"
  | "pull_request.merge";

export type ProductProjectBoardActionType =
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

interface ProductProjectActionBase {
  sessionId: string;
  taskId?: string | undefined;
}

interface ProductProjectBoardActionBase extends ProductProjectActionBase {
  type: ProductProjectBoardActionType;
  actionId: string;
  actionTs: string;
  expectedBoardVersion?: number | undefined;
  summary?: string | undefined;
  source?: ProductBoardEvidenceSource | undefined;
}

export type ProductProjectBoardAction =
  | ({
      type: "board.autopilot.configure";
      autopilotEnabled?: boolean | undefined;
      autopilotConfirmedAt?: string | undefined;
      wipLimit?: number | undefined;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.autopilot.tick";
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.create";
      title: string;
      prompt: string;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.update";
      cardId: string;
      title?: string | undefined;
      prompt?: string | undefined;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.move";
      cardId: string;
      targetLane: ProductBoardLane;
      lane?: ProductBoardLane | undefined;
      order?: number | undefined;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.manual_done";
      cardId: string;
      reason?: string | undefined;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.delete";
      cardId: string;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.start_implementation";
      cardId: string;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.start_testing";
      cardId: string;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.thread_completed";
      cardId: string;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.thread_failed";
      cardId: string;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.thread_stopped";
      cardId: string;
    } & ProductProjectBoardActionBase)
  | ({
      type: "board.card.testing_verdict";
      cardId: string;
      testingVerdict: "pass" | "fail";
    } & ProductProjectBoardActionBase);

export type ProductProjectGitAction =
  | ({
      type: "branch.create";
      branchName: string;
    } & ProductProjectActionBase)
  | ({
      type: "branch.switch";
      branchName: string;
    } & ProductProjectActionBase)
  | ({
      type: "worktree.create";
      branchName: string;
      targetPath: string;
    } & ProductProjectActionBase)
  | ({
      type: "commit.create";
      message: string;
    } & ProductProjectActionBase)
  | ({
      type: "git.push";
      branchName?: string | undefined;
    } & ProductProjectActionBase)
  | ({
      type: "pull_request.create";
      title: string;
      body?: string | undefined;
      baseBranch?: string | undefined;
      branchName?: string | undefined;
    } & ProductProjectActionBase)
  | ({
      type: "pull_request.merge";
      pullRequestNumber: number;
    } & ProductProjectActionBase);

export type ProductProjectAction =
  | ProductProjectBoardAction
  | ProductProjectGitAction
  | TaskAction;

export interface ProductProjectActionLegacyFields {
  branchName?: string | undefined;
  targetPath?: string | undefined;
  message?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  baseBranch?: string | undefined;
  pullRequestNumber?: number | undefined;
}

export function parseProductProjectBoardAction(value: unknown): ProductProjectBoardAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("project board action must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.startsWith("board.") === false) {
    throw new Error("project board action type is invalid");
  }

  const sessionId = requireProjectBoardString(record.sessionId, "sessionId");
  const actionId = requireProjectBoardString(record.actionId, "actionId");
  const actionTs = requireProjectBoardTimestamp(record.actionTs, "actionTs");
  const expectedBoardVersion = optionalProjectBoardNonNegativeInteger(
    record.expectedBoardVersion,
    "expectedBoardVersion",
  );
  const taskId = optionalProjectBoardNonEmptyString(record.taskId, "taskId");
  const summary = optionalProjectBoardString(record.summary, "summary");
  const source = optionalProjectBoardEvidenceSource(record.source);
  const base = {
    sessionId,
    actionId,
    actionTs,
    ...(expectedBoardVersion !== undefined ? { expectedBoardVersion } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(source !== undefined ? { source } : {}),
  };

  switch (record.type) {
    case "board.autopilot.configure": {
      const autopilotEnabled = optionalProjectBoardBoolean(
        record.autopilotEnabled,
        "autopilotEnabled",
      );
      const autopilotConfirmedAt = record.autopilotConfirmedAt === undefined
        ? undefined
        : requireProjectBoardTimestamp(record.autopilotConfirmedAt, "autopilotConfirmedAt");
      const wipLimit = optionalProjectBoardPositiveInteger(record.wipLimit, "wipLimit");
      return {
        ...base,
        type: record.type,
        ...(autopilotEnabled !== undefined ? { autopilotEnabled } : {}),
        ...(autopilotConfirmedAt !== undefined ? { autopilotConfirmedAt } : {}),
        ...(wipLimit !== undefined ? { wipLimit } : {}),
      };
    }
    case "board.autopilot.tick":
      return { ...base, type: record.type };
    case "board.card.create":
      return {
        ...base,
        type: record.type,
        title: requireProjectBoardString(record.title, "title"),
        prompt: requireProjectBoardString(record.prompt, "prompt"),
      };
    case "board.card.update":
      return {
        ...base,
        type: record.type,
        cardId: requireProjectBoardString(record.cardId, "cardId"),
        ...(record.title !== undefined
          ? { title: requireProjectBoardString(record.title, "title") }
          : {}),
        ...(record.prompt !== undefined
          ? { prompt: requireProjectBoardString(record.prompt, "prompt") }
          : {}),
      };
    case "board.card.move": {
      const lane = record.lane === undefined
        ? undefined
        : requireProjectBoardLane(record.lane, "lane");
      const order = optionalProjectBoardFiniteNumber(record.order, "order");
      return {
        ...base,
        type: record.type,
        cardId: requireProjectBoardString(record.cardId, "cardId"),
        targetLane: requireProjectBoardLane(record.targetLane, "targetLane"),
        ...(lane !== undefined ? { lane } : {}),
        ...(order !== undefined ? { order } : {}),
      };
    }
    case "board.card.manual_done": {
      const reason = optionalProjectBoardString(record.reason, "reason");
      return {
        ...base,
        type: record.type,
        cardId: requireProjectBoardString(record.cardId, "cardId"),
        ...(reason !== undefined ? { reason } : {}),
      };
    }
    case "board.card.delete":
    case "board.card.start_implementation":
    case "board.card.start_testing":
    case "board.card.thread_completed":
    case "board.card.thread_failed":
    case "board.card.thread_stopped":
      return {
        ...base,
        type: record.type,
        cardId: requireProjectBoardString(record.cardId, "cardId"),
      };
    case "board.card.testing_verdict":
      if (record.testingVerdict !== "pass" && record.testingVerdict !== "fail") {
        throw new Error("project board action testingVerdict must be pass or fail");
      }
      return {
        ...base,
        type: record.type,
        cardId: requireProjectBoardString(record.cardId, "cardId"),
        testingVerdict: record.testingVerdict,
      };
    default:
      throw new Error("project board action type is invalid");
  }
}

function requireProjectBoardString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`project board action ${field} must be a non-empty string`);
  }
  return value;
}

function requireProjectBoardTimestamp(value: unknown, field: string): string {
  const timestamp = requireProjectBoardString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`project board action ${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function requireProjectBoardLane(value: unknown, field: string): ProductBoardLane {
  if (
    value !== "idea"
    && value !== "planned"
    && value !== "wip"
    && value !== "testing"
    && value !== "done"
  ) {
    throw new Error(`project board action ${field} must be a valid lane`);
  }
  return value;
}

function optionalProjectBoardString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return ;
  }
  if (typeof value !== "string") {
    throw new Error(`project board action ${field} must be a string`);
  }
  return value;
}

function optionalProjectBoardNonEmptyString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireProjectBoardString(value, field);
}

function optionalProjectBoardBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return ;
  }
  if (typeof value !== "boolean") {
    throw new Error(`project board action ${field} must be a boolean`);
  }
  return value;
}

function optionalProjectBoardNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return ;
  }
  if (typeof value !== "number" || Number.isInteger(value) === false || value < 0) {
    throw new Error(`project board action ${field} must be a non-negative integer`);
  }
  return value;
}

function optionalProjectBoardPositiveInteger(value: unknown, field: string): number | undefined {
  const parsed = optionalProjectBoardNonNegativeInteger(value, field);
  if (parsed === 0) {
    throw new Error(`project board action ${field} must be a positive integer`);
  }
  return parsed;
}

function optionalProjectBoardFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return ;
  }
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    throw new Error(`project board action ${field} must be a finite number`);
  }
  return value;
}

function optionalProjectBoardEvidenceSource(
  value: unknown,
): ProductBoardEvidenceSource | undefined {
  if (value === undefined) {
    return ;
  }
  if (
    value !== "autopilot"
    && value !== "copilot"
    && value !== "operator"
    && value !== "implementation_thread"
    && value !== "testing_thread"
    && value !== "tool"
  ) {
    throw new Error("project board action source is invalid");
  }
  return value;
}
