import type { WorkspaceChangeScope } from "../changes/contracts.js";

export type WorkspaceFeedbackStatus =
  | "pending"
  | "submitted"
  | "resolved"
  | "stale";

export interface WorkspaceFeedbackComment {
  commentId: string;
  sessionId: string;
  threadId: string;
  candidateFingerprint: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  status: WorkspaceFeedbackStatus;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string | undefined;
  submissionRunId?: string | undefined;
  resolvedAt?: string | undefined;
}

export interface WorkspaceFeedbackSnapshot {
  sessionId: string;
  threadId: string;
  candidateFingerprint: string;
  comments: WorkspaceFeedbackComment[];
}

export type WorkspaceReviewFindingSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low";
export type WorkspaceReviewFindingStatus =
  | "open"
  | "accepted"
  | "dismissed"
  | "fixed"
  | "stale";
export type WorkspaceReviewStatus =
  | "running"
  | "completed"
  | "failed"
  | "stale";

export interface WorkspaceReviewFinding {
  findingId: string;
  reviewId: string;
  severity: WorkspaceReviewFindingSeverity;
  confidence: number;
  path: string;
  line: number;
  problem: string;
  impact: string;
  evidence: string;
  remediation: string;
  verification: string;
  status: WorkspaceReviewFindingStatus;
  staleFromStatus?: Exclude<WorkspaceReviewFindingStatus, "stale"> | undefined;
  dismissalReason?: string | undefined;
  submissionRunId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceReviewRecord {
  reviewId: string;
  sessionId: string;
  threadId: string;
  candidateFingerprint: string;
  scopeLabel: string;
  scope: WorkspaceChangeScope;
  mode: "current_thread" | "detached_thread";
  status: WorkspaceReviewStatus;
  reviewerProfileId?: string | undefined;
  reviewerModel?: string | undefined;
  runId?: string | undefined;
  delegationId?: string | undefined;
  childThreadId?: string | undefined;
  error?: string | undefined;
  findings: WorkspaceReviewFinding[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
}

export interface WorkspaceReviewSnapshot {
  sessionId: string;
  threadId: string;
  candidateFingerprint: string;
  reviews: WorkspaceReviewRecord[];
}
