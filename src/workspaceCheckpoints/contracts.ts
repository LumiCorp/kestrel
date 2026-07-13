export type WorkspaceCheckpointCaptureStatus = "CAPTURED" | "FAILED";
export type WorkspaceDiffTargetKind = "checkpoint" | "working_tree" | "git_ref";
export type WorkspaceCheckpointKind =
  | "manual"
  | "pre_mutation"
  | "recovery_anchor"
  | "source_pre_promotion"
  | "source_post_promotion";
export type WorkspaceCheckpointRole = "source" | "managed_worktree";
export type WorkspacePromotionPhase = "pre" | "post";
export type WorkspaceDiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"
  | "binary"
  | "oversized";
export type WorkspaceRestoreStatus = "COMPLETED" | "FAILED" | "REJECTED";
export type WorkspaceCheckpointCleanupTrigger = "automatic" | "manual";
export type WorkspacePromotionStatus =
  | "promoted"
  | "noop"
  | "blocked"
  | "pending_review"
  | "skipped"
  | "failed";

export interface WorkspaceCheckpointCleanupPolicy {
  maxCheckpointCount: number;
  maxRetainedBytes: number;
  maxAgeDaysByClass?: {
    manual?: number | undefined;
    pre_mutation?: number | undefined;
    recovery_anchor?: number | undefined;
    source_pre_promotion?: number | undefined;
    source_post_promotion?: number | undefined;
  } | undefined;
  protectLabeled: boolean;
  protectLatestPerThread: boolean;
  protectLatestPerRun: boolean;
  protectLatestPerTask: boolean;
}

export interface WorkspaceCheckpointFileRecord {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
  contentKind: "text" | "binary";
}

export interface WorkspaceCheckpointRecord {
  checkpointId: string;
  sessionId: string;
  threadId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  workspaceRoot: string;
  repoRoot: string;
  branch?: string | undefined;
  headSha?: string | undefined;
  label: string;
  isExplicitLabel: boolean;
  reason: string;
  createdBy: string;
  createdAt: string;
  storageKind: "git_ref_v1";
  gitRef: string;
  baseCheckpointId?: string | undefined;
  kind: WorkspaceCheckpointKind;
  retentionClass: WorkspaceCheckpointKind;
  workspaceRole?: WorkspaceCheckpointRole | undefined;
  promotionId?: string | undefined;
  promotionPhase?: WorkspacePromotionPhase | undefined;
  pinnedAt?: string | undefined;
  pinnedBy?: string | undefined;
  captureStatus: WorkspaceCheckpointCaptureStatus;
  manifestHash: string;
  fileCount: number;
  totalBytes: number;
}

export interface WorkspaceCheckpointDetail {
  checkpoint: WorkspaceCheckpointRecord;
  files: WorkspaceCheckpointFileRecord[];
}

export interface WorkspaceDiffEndpoint {
  kind: WorkspaceDiffTargetKind;
  checkpointId?: string | undefined;
  gitRef?: string | undefined;
  label: string;
}

export interface WorkspaceDiffFileChange {
  path: string;
  status: WorkspaceDiffFileStatus;
  previousPath?: string | undefined;
  beforeSha256?: string | undefined;
  afterSha256?: string | undefined;
  beforeSize?: number | undefined;
  afterSize?: number | undefined;
  hunks?: string[] | undefined;
}

export interface WorkspaceDiffRecord {
  diffId: string;
  sessionId: string;
  source: WorkspaceDiffEndpoint;
  target: WorkspaceDiffEndpoint;
  createdAt: string;
  fileCount: number;
  files: WorkspaceDiffFileChange[];
}

export interface WorkspaceRestoreRecord {
  restoreId: string;
  sessionId: string;
  checkpointId: string;
  recoveryCheckpointId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  promotionId?: string | undefined;
  workspaceRoot: string;
  repoRoot: string;
  restoredBy: string;
  reason: string;
  validationMessages: string[];
  status: WorkspaceRestoreStatus;
  createdAt: string;
  restoredAt?: string | undefined;
}

export interface WorkspacePromotionRecord {
  promotionId: string;
  sessionId: string;
  runId: string;
  sourceWorkspaceRoot: string;
  sourceRepoRoot: string;
  managedWorktreeRoot: string;
  baseHead: string;
  status: WorkspacePromotionStatus;
  changedFiles: string[];
  conflictPaths: string[];
  invalidPaths: string[];
  sourcePreCheckpointId?: string | undefined;
  sourcePostCheckpointId?: string | undefined;
  candidateFingerprint?: string | undefined;
  blockedReason?: string | undefined;
  createdAt: string;
  completedAt?: string | undefined;
  appliedBy?: string | undefined;
  undoRestoreId?: string | undefined;
  undoneAt?: string | undefined;
  undoneBy?: string | undefined;
}

export interface WorkspacePromotionPreview {
  promotion: WorkspacePromotionRecord;
  status: "ready" | "empty" | "blocked";
  changedFiles: string[];
  conflictPaths: string[];
  invalidPaths: string[];
  candidateFingerprint?: string | undefined;
  blockedReason?: string | undefined;
  diff: WorkspaceDiffRecord;
}

export interface WorkspaceCheckpointCleanupRecord {
  cleanupId: string;
  sessionId: string;
  trigger: WorkspaceCheckpointCleanupTrigger;
  reason: string;
  createdAt: string;
  policy: WorkspaceCheckpointCleanupPolicy;
  deletedCheckpointIds: string[];
  deletedBytes: number;
  retainedCheckpointCount: number;
  retainedBytes: number;
}

export interface WorkspaceCheckpointCleanupResult {
  cleanup: WorkspaceCheckpointCleanupRecord;
  deletedCheckpoints: WorkspaceCheckpointRecord[];
  remainingCheckpointCount: number;
  remainingBytes: number;
}

export interface WorkspaceCheckpointState {
  version: 1;
  checkpoints: WorkspaceCheckpointRecord[];
  restores: WorkspaceRestoreRecord[];
  promotions: WorkspacePromotionRecord[];
  cleanupPolicy: WorkspaceCheckpointCleanupPolicy;
  cleanups: WorkspaceCheckpointCleanupRecord[];
}
