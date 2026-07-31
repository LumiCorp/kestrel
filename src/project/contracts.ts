import type { ProductTaskGraph } from "../taskGraph/contracts.js";

export type ProductSandboxMode = "workspace_write" | "read_only" | "full_access";
export type ProductApprovalMode = "manual" | "on_request" | "auto";
export type ProductCapabilityScope = "disabled" | "task" | "project";

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

interface ProductProjectActionBase {
  sessionId: string;
  taskId?: string | undefined;
}

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

export type ProductProjectAction = ProductProjectGitAction;

export interface ProductProjectActionLegacyFields {
  branchName?: string | undefined;
  targetPath?: string | undefined;
  message?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  baseBranch?: string | undefined;
  pullRequestNumber?: number | undefined;
}
