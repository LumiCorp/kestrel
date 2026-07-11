import type { SubAgentResultEnvelope } from "../kestrel/contracts/orchestration.js";


export type ProductTaskStatus =
  | "planned"
  | "active"
  | "blocked"
  | "waiting"
  | "done"
  | "failed";

export type ProductTaskSource = "thread" | "delegation" | "manual" | "agent_proposed";

export interface TaskMemoryLedger {
  goal: string;
  currentPlan: string;
  findings: string;
  decisions: string;
  openQuestions: string;
  nextAction: string;
  linkedArtifacts: string[];
}

export type TaskChildActivityStatus = "active" | "blocked" | "failed" | "completed";

export interface TaskChildActivitySummary {
  total: number;
  active: number;
  blocked: number;
  failed: number;
  completed: number;
  latestResult?: string | undefined;
}

export interface TaskRuntimeSummary {
  threadTitle?: string | undefined;
  blocker?: string | undefined;
  approvalPrompt?: string | undefined;
  checkpoint?: string | undefined;
  fanIn?: string | undefined;
  childSummary?: string | undefined;
  childActivity?: TaskChildActivitySummary | undefined;
  childStatusByDelegation?: Record<string, TaskChildActivityStatus> | undefined;
  childUpdatedAtByDelegation?: Record<string, string> | undefined;
  evidenceSummary?: string | undefined;
  nextAction?: string | undefined;
  result?: SubAgentResultEnvelope | undefined;
  resultStatus?: SubAgentResultEnvelope["status"] | undefined;
  resultSummary?: string | undefined;
  resultDelegationTaskId?: string | undefined;
  errorCode?: string | undefined;
  references?: string[] | undefined;
  repoStatusSummary?: string | undefined;
  latestArtifactSummary?: string | undefined;
}

export interface ProductPullRequestLink {
  number: number;
  title: string;
  state?: "OPEN" | "MERGED" | "CLOSED" | undefined;
  url?: string | undefined;
}

export interface ProductTaskNode {
  id: string;
  title: string;
  description?: string | undefined;
  order: number;
  status: ProductTaskStatus;
  source: ProductTaskSource;
  proposedByAgent: boolean;
  parentTaskId?: string | undefined;
  linkedThreadId?: string | undefined;
  linkedSessionId?: string | undefined;
  activeThreadLineageId?: string | undefined;
  childSessionId?: string | undefined;
  linkedBranch?: string | undefined;
  linkedWorktree?: string | undefined;
  linkedPullRequest?: ProductPullRequestLink | undefined;
  titleLocked?: boolean | undefined;
  memory: TaskMemoryLedger;
  runtime: TaskRuntimeSummary;
  updatedAt: string;
}

export interface ProductTaskGraph {
  version: 1;
  activeTaskId?: string | undefined;
  rootTaskIds: string[];
  tasks: Record<string, ProductTaskNode>;
}
