export type WorkspaceChangeScope =
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "uncommitted" }
  | { kind: "branch"; baseRef: string }
  | { kind: "commit"; commitSha: string }
  | { kind: "pull_request"; number?: number | undefined }
  | { kind: "latest_run"; runId?: string | undefined }
  | { kind: "latest_turn"; turnId?: string | undefined }
  | { kind: "promotion"; promotionId: string };

export interface WorkspaceDiffOptions {
  contextLines: number;
  whitespace: "show" | "ignore_all" | "ignore_eol";
}

export type WorkspaceChangeFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "unknown";

export interface WorkspaceChangeFile {
  path: string;
  previousPath?: string | undefined;
  status: WorkspaceChangeFileStatus;
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface WorkspaceDiffHunk {
  hunkId: string;
  filePath: string;
  header: string;
  lines: string[];
  oldStart: number;
  newStart: number;
  origin: "staged" | "unstaged" | "committed";
}

export interface WorkspaceChangeSnapshot {
  sessionId: string;
  threadId: string;
  workspaceRoot: string;
  repoRoot: string;
  scope: WorkspaceChangeScope;
  options: WorkspaceDiffOptions;
  readOnly: boolean;
  candidateFingerprint: string;
  currentBranch?: string | undefined;
  headSha?: string | undefined;
  baseRef?: string | undefined;
  mergeBase?: string | undefined;
  pullRequest?: { number: number; url: string; baseSha: string; headSha: string } | undefined;
  upstream?: string | undefined;
  ahead: number;
  behind: number;
  conflicted: boolean;
  files: WorkspaceChangeFile[];
  hunks: WorkspaceDiffHunk[];
  diff: string;
  diffBytes: number;
  truncated: boolean;
  generatedAt: string;
}

export type WorkspaceChangeMutation =
  | { operation: "stage_file"; path: string }
  | { operation: "unstage_file"; path: string }
  | { operation: "revert_file"; path: string; confirmation: "revert_file" }
  | { operation: "stage_hunk"; path: string; hunkId: string }
  | { operation: "unstage_hunk"; path: string; hunkId: string }
  | { operation: "revert_hunk"; path: string; hunkId: string; confirmation: "revert_hunk" };

export interface WorkspaceChangeMutationResult {
  operation: WorkspaceChangeMutation["operation"];
  previousFingerprint: string;
  snapshot: WorkspaceChangeSnapshot;
}
