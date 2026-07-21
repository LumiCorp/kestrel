export type WorkspaceGitOperation =
  | "branch_create"
  | "fetch"
  | "commit"
  | "push"
  | "pr_create"
  | "pr_ready"
  | "pr_comment";

export type WorkspaceGitAction =
  | { kind: "branch_create"; branchName: string }
  | { kind: "fetch"; remote: string }
  | { kind: "commit"; message: string; paths: string[] }
  | { kind: "push"; remote: string; branch: string; setUpstream: boolean }
  | {
      kind: "pr_create";
      title: string;
      body: string;
      baseBranch: string;
      draft: boolean;
    }
  | { kind: "pr_ready"; number: number }
  | {
      kind: "pr_comment";
      number: number;
      body: string;
      path?: string | undefined;
      line?: number | undefined;
      side?: "LEFT" | "RIGHT" | undefined;
    };

export interface WorkspaceGitFileStatus {
  path: string;
  previousPath?: string | undefined;
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "conflicted"
    | "untracked"
    | "unknown";
  staged: boolean;
  unstaged: boolean;
}

export interface WorkspaceGitRemote {
  name: string;
  fetchUrl?: string | undefined;
  pushUrl?: string | undefined;
}

export interface WorkspaceGitCommit {
  sha: string;
  summary: string;
  authoredAt: string;
}

export interface WorkspaceGitHubCheck {
  id: string;
  name: string;
  status: string;
  conclusion?: string | undefined;
  detailsUrl?: string | undefined;
}

export interface WorkspaceGitHubComment {
  id: string;
  body: string;
  author: string;
  createdAt?: string | undefined;
  path?: string | undefined;
  line?: number | undefined;
  state?: string | undefined;
}

export interface WorkspacePullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  mergeable?: string | undefined;
  mergeState?: string | undefined;
  reviewDecision?: string | undefined;
  changedFiles: Array<{ path: string; additions: number; deletions: number }>;
  checks: WorkspaceGitHubCheck[];
  comments: WorkspaceGitHubComment[];
}

export interface WorkspaceGitHubStatus {
  available: boolean;
  authenticated: boolean;
  account?: string | undefined;
  repository?: string | undefined;
  guidance?: string | undefined;
}

export interface WorkspaceGitAuditRecord {
  auditId: string;
  sessionId: string;
  threadId: string;
  operation: WorkspaceGitOperation;
  status: "succeeded" | "failed";
  summary: string;
  at: string;
  candidateFingerprint?: string | undefined;
  headSha?: string | undefined;
  error?: string | undefined;
  errorCode?: string | undefined;
}

export interface WorkspaceGitNotification {
  notificationId: string;
  pullRequestNumber: number;
  kind: "check_state_changed";
  message: string;
  at: string;
}

export interface WorkspaceGitSnapshot {
  sessionId: string;
  threadId: string;
  workspaceRoot: string;
  repoRoot: string;
  candidateFingerprint: string;
  validationReadiness: "not_run" | "running" | "ready" | "blocked" | "stale";
  deliveryReady: boolean;
  deliveryReadinessMessage: string;
  branch?: string | undefined;
  headSha?: string | undefined;
  upstream?: string | undefined;
  relation: "untracked" | "up_to_date" | "ahead" | "behind" | "diverged";
  pushState: "not_pushed" | "succeeded" | "rejected" | "failed";
  ahead: number;
  behind: number;
  files: WorkspaceGitFileStatus[];
  branches: string[];
  remotes: WorkspaceGitRemote[];
  recentCommits: WorkspaceGitCommit[];
  github: WorkspaceGitHubStatus;
  pullRequest?: WorkspacePullRequest | undefined;
  audits: WorkspaceGitAuditRecord[];
  notifications: WorkspaceGitNotification[];
  generatedAt: string;
}
