import type {
  OperatorInboxSnapshot,
  OperatorThreadView,
} from "../orchestration/contracts.js";
import type { SubAgentResultEnvelope } from "../kestrel/contracts/orchestration.js";

import type {
  TaskChildActivityStatus,
  TaskChildActivitySummary,
  ProductTaskGraph,
  ProductTaskNode,
  ProductPullRequestLink,
  ProductTaskSource,
  ProductTaskStatus,
  TaskMemoryLedger,
  TaskRuntimeSummary,
} from "./contracts.js";

export interface ProductDelegationTask {
  taskId: string;
  title: string;
  status: "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  childSessionId: string;
  waitEventType?: string | undefined;
  result?: SubAgentResultEnvelope | undefined;
  resultSummary?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  references?: string[] | undefined;
  updatedAt: string;
}

export interface ProductTaskRuntimeSignalInput {
  pendingWaitEventType?: string | undefined;
  taskStatus?: ProductDelegationTask["status"] | undefined;
  operatorView?: OperatorThreadView | undefined;
  operatorInbox?: OperatorInboxSnapshot | undefined;
  result?: SubAgentResultEnvelope | undefined;
  resultSummary?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  references?: string[] | undefined;
  latestArtifactSummary?: string | undefined;
  repoStatusSummary?: string | undefined;
}

const DELEGATION_WAIT_BLOCKER_PREFIX = "waiting:";

export function createEmptyTaskMemory(): TaskMemoryLedger {
  return {
    goal: "",
    currentPlan: "",
    findings: "",
    decisions: "",
    openQuestions: "",
    nextAction: "",
    linkedArtifacts: [],
  };
}

export function createEmptyTaskGraph(): ProductTaskGraph {
  return {
    version: 1,
    rootTaskIds: [],
    tasks: {},
  };
}

export function normalizeProductTaskGraph(value: unknown): ProductTaskGraph {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createEmptyTaskGraph();
  }
  const parsed = value as Partial<ProductTaskGraph>;
  if (parsed.version !== 1 || typeof parsed.tasks !== "object" || parsed.tasks === null) {
    return createEmptyTaskGraph();
  }
  const tasks = Object.fromEntries(
    Object.entries(parsed.tasks)
      .map(([taskId, taskValue]) => {
        const normalized = parseTaskNode(taskId, taskValue);
        return normalized === undefined ? undefined : [taskId, normalized];
      })
      .filter((entry): entry is [string, ProductTaskNode] => entry !== undefined),
  );
  const rootTaskIds = Array.isArray(parsed.rootTaskIds)
    ? parsed.rootTaskIds.filter((taskId): taskId is string => typeof taskId === "string" && tasks[taskId] !== undefined)
    : [];
  return {
    version: 1,
    ...(typeof parsed.activeTaskId === "string" && tasks[parsed.activeTaskId] !== undefined
      ? { activeTaskId: parsed.activeTaskId }
      : {}),
    rootTaskIds,
    tasks,
  };
}

export function readTaskGraphFromRuntimeState(state: Record<string, unknown>): ProductTaskGraph {
  const product = asRecord(state.product);
  return normalizeProductTaskGraph(product?.taskGraph);
}

export function buildTaskGraphStatePatch(
  state: Record<string, unknown>,
  graph: ProductTaskGraph,
): Record<string, unknown> {
  const product = asRecord(state.product) ?? {};
  return {
    product: {
      ...product,
      taskGraph: normalizeProductTaskGraph(graph),
    },
  };
}

export function rootTaskIdForThread(threadId: string): string {
  return `task:thread:${threadId}`;
}

export function ensureRootTask(
  graph: ProductTaskGraph,
  input: {
    threadId: string;
    sessionId: string;
    title: string;
    updatedAt: string;
  },
): ProductTaskGraph {
  const taskId = rootTaskIdForThread(input.threadId);
  const current = graph.tasks[taskId];
  const task: ProductTaskNode = {
    id: taskId,
    title: current?.titleLocked === true ? current.title : input.title,
    order: current?.order ?? graph.rootTaskIds.length,
    status: current?.status ?? "planned",
    source: "thread",
    proposedByAgent: false,
    linkedThreadId: input.threadId,
    linkedSessionId: input.sessionId,
    activeThreadLineageId: input.threadId,
    memory: current?.memory ?? createEmptyTaskMemory(),
    runtime: current?.runtime ?? {},
    updatedAt: input.updatedAt,
    ...(current?.titleLocked === true ? { titleLocked: true } : {}),
    ...(current?.description !== undefined ? { description: current.description } : {}),
    ...(current?.linkedBranch !== undefined ? { linkedBranch: current.linkedBranch } : {}),
    ...(current?.linkedWorktree !== undefined ? { linkedWorktree: current.linkedWorktree } : {}),
    ...(current?.linkedPullRequest !== undefined ? { linkedPullRequest: current.linkedPullRequest } : {}),
  };
  return {
    ...graph,
    rootTaskIds: graph.rootTaskIds.includes(taskId) ? graph.rootTaskIds : [...graph.rootTaskIds, taskId],
    tasks: {
      ...graph.tasks,
      [taskId]: task,
    },
    ...(graph.activeTaskId !== undefined ? { activeTaskId: graph.activeTaskId } : { activeTaskId: taskId }),
  };
}

export function ensureDelegationTask(
  graph: ProductTaskGraph,
  input: {
    task: ProductDelegationTask;
    parentTaskId?: string | undefined;
  },
): ProductTaskGraph {
  const current = graph.tasks[input.task.taskId];
  if (current !== undefined && current.updatedAt > input.task.updatedAt) {
    return graph;
  }
  const task: ProductTaskNode = {
    id: input.task.taskId,
    title: current?.titleLocked === true ? current.title : input.task.title,
    order: current?.order ?? nextSiblingOrder(graph, input.parentTaskId),
    status: deriveTaskStatus({
      taskStatus: input.task.status,
      resultSummary: input.task.resultSummary,
      errorMessage: input.task.errorMessage,
    }),
    source: "delegation",
    proposedByAgent: true,
    ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
    linkedThreadId: current?.linkedThreadId,
    linkedSessionId: input.task.childSessionId,
    childSessionId: input.task.childSessionId,
    activeThreadLineageId: current?.activeThreadLineageId,
    memory: current?.memory ?? createEmptyTaskMemory(),
    runtime: mergeDelegationRuntimeFields(current?.runtime, input.task, { includeWaitBlocker: true }),
    updatedAt: input.task.updatedAt,
    ...(current?.titleLocked === true ? { titleLocked: true } : {}),
    ...(current?.description !== undefined ? { description: current.description } : {}),
    ...(current?.linkedBranch !== undefined ? { linkedBranch: current.linkedBranch } : {}),
    ...(current?.linkedWorktree !== undefined ? { linkedWorktree: current.linkedWorktree } : {}),
    ...(current?.linkedPullRequest !== undefined ? { linkedPullRequest: current.linkedPullRequest } : {}),
  };
  return {
    ...graph,
    rootTaskIds:
      input.parentTaskId === undefined && graph.rootTaskIds.includes(task.id) === false
        ? [...graph.rootTaskIds, task.id]
        : graph.rootTaskIds,
    tasks: {
      ...graph.tasks,
      [task.id]: task,
    },
    ...(graph.activeTaskId !== undefined ? { activeTaskId: graph.activeTaskId } : { activeTaskId: task.id }),
  };
}

export function applyDelegationActivityToParentTask(
  graph: ProductTaskGraph,
  parentTaskId: string,
  task: ProductDelegationTask,
): ProductTaskGraph {
  const parent = graph.tasks[parentTaskId];
  if (parent === undefined) {
    return graph;
  }
  const previousUpdatedAt = parent.runtime.childUpdatedAtByDelegation?.[task.taskId];
  if (previousUpdatedAt !== undefined && previousUpdatedAt > task.updatedAt) {
    return graph;
  }
  const nextStatus = mapDelegationStatusToChildActivity(task.status);
  const childStatusByDelegation: Record<string, TaskChildActivityStatus> = {
    ...(parent.runtime.childStatusByDelegation ?? {}),
    [task.taskId]: nextStatus,
  };
  const childUpdatedAtByDelegation: Record<string, string> = {
    ...(parent.runtime.childUpdatedAtByDelegation ?? {}),
    [task.taskId]: task.updatedAt,
  };
  const childActivity = summarizeChildActivity(
    childStatusByDelegation,
    task.resultSummary ?? task.result?.result ?? parent.runtime.childActivity?.latestResult,
  );
  return {
    ...graph,
    tasks: {
      ...graph.tasks,
      [parentTaskId]: {
        ...parent,
        runtime: {
          ...mergeDelegationRuntimeFields(parent.runtime, task, {
            includeWaitBlocker: false,
            resultSourceTaskId: task.taskId,
          }),
          childStatusByDelegation,
          childUpdatedAtByDelegation,
          childActivity,
          childSummary: summarizeChildActivityText(childActivity),
        },
        updatedAt: task.updatedAt,
      },
    },
  };
}

export function applyTaskRuntimeSignals(
  graph: ProductTaskGraph,
  taskId: string,
  input: ProductTaskRuntimeSignalInput,
): ProductTaskGraph {
  const task = graph.tasks[taskId];
  if (task === undefined) {
    return graph;
  }
  const runtime = readRuntimeSummary(input);
  return {
    ...graph,
    tasks: {
      ...graph.tasks,
      [taskId]: {
        ...task,
        status: deriveTaskStatus(input),
        runtime: {
          ...task.runtime,
          ...runtime,
        },
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

function mergeDelegationRuntimeFields(
  current: TaskRuntimeSummary | undefined,
  task: ProductDelegationTask,
  options: { includeWaitBlocker: boolean; resultSourceTaskId?: string | undefined },
): TaskRuntimeSummary {
  const runtime: TaskRuntimeSummary = { ...(current ?? {}) };
  const hasResultFields = hasDelegationResultFields(task);
  const resultSourceMatches =
    options.resultSourceTaskId !== undefined &&
    runtime.resultDelegationTaskId === options.resultSourceTaskId;
  const shouldReplaceResultFields = options.resultSourceTaskId === undefined || hasResultFields || resultSourceMatches;

  // Delegation updates are authoritative for the result surface. Do not carry
  // stale wait/error/reference fields across later lifecycle updates. Parent
  // aggregate updates only replace the top-level result for the child that
  // produced it, so unrelated child lifecycle events do not erase another
  // child's completed result.
  if (shouldReplaceResultFields) {
    delete runtime.result;
    delete runtime.resultStatus;
    delete runtime.resultSummary;
    delete runtime.resultDelegationTaskId;
    delete runtime.errorCode;
    delete runtime.references;
  }
  if (options.includeWaitBlocker && runtime.blocker?.startsWith(DELEGATION_WAIT_BLOCKER_PREFIX) === true) {
    delete runtime.blocker;
  }

  if (options.includeWaitBlocker && task.waitEventType !== undefined) {
    runtime.blocker = `${DELEGATION_WAIT_BLOCKER_PREFIX}${task.waitEventType}`;
  }
  if (task.result !== undefined) {
    runtime.result = task.result;
    runtime.resultStatus = task.result.status;
  }
  const resultSummary = task.resultSummary ?? task.errorMessage;
  if (resultSummary !== undefined) {
    runtime.resultSummary = resultSummary;
  }
  const errorCode = task.errorCode ?? task.result?.error?.code;
  if (errorCode !== undefined) {
    runtime.errorCode = errorCode;
  }
  const references = task.references ?? task.result?.references;
  if (references !== undefined) {
    runtime.references = references;
  }
  if (hasResultFields && options.resultSourceTaskId !== undefined) {
    runtime.resultDelegationTaskId = options.resultSourceTaskId;
  }
  return runtime;
}

function hasDelegationResultFields(task: ProductDelegationTask): boolean {
  return task.result !== undefined ||
    task.resultSummary !== undefined ||
    task.errorCode !== undefined ||
    task.errorMessage !== undefined ||
    task.references !== undefined;
}

function deriveTaskStatus(input: ProductTaskRuntimeSignalInput): ProductTaskStatus {
  if (input.errorMessage !== undefined || input.taskStatus === "FAILED") {
    return "failed";
  }
  if (input.operatorView?.blocker?.kind === "child_thread") {
    return "blocked";
  }
  if (input.operatorView?.latestCheckpoint?.status === "PENDING" || input.operatorInbox?.summary.checkpoints) {
    return "waiting";
  }
  if (input.operatorInbox?.summary.approvals) {
    return "waiting";
  }
  if (input.pendingWaitEventType !== undefined || input.taskStatus === "WAITING") {
    return "waiting";
  }
  if (input.taskStatus === "COMPLETED" || input.resultSummary !== undefined) {
    return "done";
  }
  if (input.taskStatus === "RUNNING" || input.operatorView !== undefined) {
    return "active";
  }
  return "planned";
}

function mapDelegationStatusToChildActivity(status: ProductDelegationTask["status"]): TaskChildActivityStatus {
  switch (status) {
    case "FAILED":
      return "failed";
    case "WAITING":
      return "blocked";
    case "COMPLETED":
      return "completed";
    case "PENDING":
    case "RUNNING":
      return "active";
  }
}

function summarizeChildActivity(
  childStatusByDelegation: Record<string, TaskChildActivityStatus>,
  latestResult: string | undefined,
): TaskChildActivitySummary {
  const summary: TaskChildActivitySummary = {
    total: 0,
    active: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
  };
  for (const status of Object.values(childStatusByDelegation)) {
    summary.total += 1;
    summary[status] += 1;
  }
  if (latestResult !== undefined) {
    summary.latestResult = latestResult;
  }
  return summary;
}

function summarizeChildActivityText(summary: TaskChildActivitySummary): string {
  return [
    `children:${summary.total}`,
    `active:${summary.active}`,
    `blocked:${summary.blocked}`,
    `failed:${summary.failed}`,
    `completed:${summary.completed}`,
  ].join(" ");
}

function readRuntimeSummary(input: ProductTaskRuntimeSignalInput): TaskRuntimeSummary {
  const runtime: TaskRuntimeSummary = {};
  const approvalPrompt = readApprovalPrompt(input.operatorView);
  if (approvalPrompt !== undefined) {
    runtime.approvalPrompt = approvalPrompt;
  }
  if (input.operatorView?.blocker?.summary !== undefined) {
    runtime.blocker = input.operatorView.blocker.summary;
  } else if (input.pendingWaitEventType !== undefined) {
    runtime.blocker = `waiting:${input.pendingWaitEventType}`;
  }
  const checkpoint = input.operatorView?.latestCheckpoint;
  if (checkpoint !== undefined) {
    runtime.checkpoint = `${checkpoint.recommendedAction}:${checkpoint.status.toLowerCase()}`;
  }
  const fanIn = input.operatorView?.latestFanInDisposition;
  if (fanIn?.status !== undefined && fanIn.status !== "not_recorded") {
    runtime.fanIn = fanIn.checkpointId !== undefined ? `${fanIn.status}:${fanIn.checkpointId}` : fanIn.status;
  }
  if (input.operatorView?.supervision !== undefined) {
    runtime.childSummary = summarizeSupervision(
      input.operatorView.supervision.childCount,
      input.operatorView.supervision.activeCount,
      input.operatorView.supervision.terminalCount,
      input.operatorView.latestFanInDisposition?.status,
    );
  }
  if (input.operatorView?.latestEvidenceRecovery !== undefined) {
    runtime.evidenceSummary = summarizeEvidence(input.operatorView.latestEvidenceRecovery.latestIssues ?? []);
  }
  if (input.operatorView?.nextAction?.summary !== undefined) {
    runtime.nextAction = input.operatorView.nextAction.summary;
  }
  if (input.resultSummary !== undefined) {
    runtime.resultSummary = input.resultSummary;
  }
  if (input.result !== undefined) {
    runtime.result = input.result;
    runtime.resultStatus = input.result.status;
  }
  if (input.errorCode !== undefined) {
    runtime.errorCode = input.errorCode;
  }
  if (input.errorMessage !== undefined) {
    runtime.resultSummary = input.errorMessage;
  }
  if (input.references !== undefined) {
    runtime.references = input.references;
  }
  if (input.latestArtifactSummary !== undefined) {
    runtime.latestArtifactSummary = input.latestArtifactSummary;
  }
  if (input.repoStatusSummary !== undefined) {
    runtime.repoStatusSummary = input.repoStatusSummary;
  }
  if (input.operatorView?.thread.title !== undefined) {
    runtime.threadTitle = input.operatorView.thread.title;
  }
  return runtime;
}

function readApprovalPrompt(view: OperatorThreadView | undefined): string | undefined {
  const eventType = view?.activeWait?.eventType;
  if (eventType !== "user.approval") {
    return undefined;
  }
  const metadata = view?.activeWait?.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return "approval required";
  }
  const prompt = (metadata as Record<string, unknown>).prompt;
  return typeof prompt === "string" && prompt.trim().length > 0 ? prompt : "approval required";
}

function summarizeSupervision(
  childCount: number,
  activeCount: number,
  terminalCount: number,
  fanInStatus: string | undefined,
): string {
  const parts = [`children:${childCount}`, `active:${activeCount}`, `terminal:${terminalCount}`];
  if (fanInStatus !== undefined && fanInStatus !== "not_recorded") {
    parts.push(`fan-in:${fanInStatus}`);
  }
  return parts.join(" ");
}

function summarizeEvidence(issues: string[]): string | undefined {
  if (issues.length === 0) {
    return undefined;
  }
  return issues.join(", ");
}

function parseTaskNode(taskId: string, value: unknown): ProductTaskNode | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || typeof record.order !== "number" || typeof record.status !== "string") {
    return undefined;
  }
  return {
    id: taskId,
    title: record.title,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    order: record.order,
    status: parseTaskStatus(record.status),
    source: parseTaskSource(record.source),
    proposedByAgent: record.proposedByAgent === true,
    ...(typeof record.parentTaskId === "string" ? { parentTaskId: record.parentTaskId } : {}),
    ...(typeof record.linkedThreadId === "string" ? { linkedThreadId: record.linkedThreadId } : {}),
    ...(typeof record.linkedSessionId === "string" ? { linkedSessionId: record.linkedSessionId } : {}),
    ...(typeof record.activeThreadLineageId === "string" ? { activeThreadLineageId: record.activeThreadLineageId } : {}),
    ...(typeof record.childSessionId === "string" ? { childSessionId: record.childSessionId } : {}),
    ...(typeof record.linkedBranch === "string" ? { linkedBranch: record.linkedBranch } : {}),
    ...(typeof record.linkedWorktree === "string" ? { linkedWorktree: record.linkedWorktree } : {}),
    ...(parsePullRequestLink(record.linkedPullRequest) !== undefined
      ? { linkedPullRequest: parsePullRequestLink(record.linkedPullRequest) }
      : {}),
    ...(record.titleLocked === true ? { titleLocked: true } : {}),
    memory: parseTaskMemory(record.memory),
    runtime: parseTaskRuntime(record.runtime),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

function parseTaskStatus(value: unknown): ProductTaskStatus {
  return value === "active" ||
    value === "blocked" ||
    value === "waiting" ||
    value === "done" ||
    value === "failed"
    ? value
    : "planned";
}

function parseTaskSource(value: unknown): ProductTaskSource {
  return value === "thread" || value === "delegation" || value === "manual"
    ? value
    : "agent_proposed";
}

function parseTaskMemory(value: unknown): TaskMemoryLedger {
  const record = asRecord(value) ?? {};
  return {
    goal: typeof record.goal === "string" ? record.goal : "",
    currentPlan: typeof record.currentPlan === "string" ? record.currentPlan : "",
    findings: typeof record.findings === "string" ? record.findings : "",
    decisions: typeof record.decisions === "string" ? record.decisions : "",
    openQuestions: typeof record.openQuestions === "string" ? record.openQuestions : "",
    nextAction: typeof record.nextAction === "string" ? record.nextAction : "",
    linkedArtifacts: Array.isArray(record.linkedArtifacts)
      ? record.linkedArtifacts.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function parseTaskRuntime(value: unknown): TaskRuntimeSummary {
  const record = asRecord(value) ?? {};
  const childActivity = parseChildActivitySummary(record.childActivity);
  const childStatusByDelegation = parseChildStatusByDelegation(record.childStatusByDelegation);
  const childUpdatedAtByDelegation = parseStringRecord(record.childUpdatedAtByDelegation);
  const result = parseSubAgentResult(record.result);
  const references = parseStringArray(record.references);
  return {
    ...(typeof record.threadTitle === "string" ? { threadTitle: record.threadTitle } : {}),
    ...(typeof record.blocker === "string" ? { blocker: record.blocker } : {}),
    ...(typeof record.approvalPrompt === "string" ? { approvalPrompt: record.approvalPrompt } : {}),
    ...(typeof record.checkpoint === "string" ? { checkpoint: record.checkpoint } : {}),
    ...(typeof record.fanIn === "string" ? { fanIn: record.fanIn } : {}),
    ...(typeof record.childSummary === "string" ? { childSummary: record.childSummary } : {}),
    ...(childActivity !== undefined ? { childActivity } : {}),
    ...(childStatusByDelegation !== undefined ? { childStatusByDelegation } : {}),
    ...(childUpdatedAtByDelegation !== undefined ? { childUpdatedAtByDelegation } : {}),
    ...(typeof record.evidenceSummary === "string" ? { evidenceSummary: record.evidenceSummary } : {}),
    ...(typeof record.nextAction === "string" ? { nextAction: record.nextAction } : {}),
    ...(result !== undefined ? { result, resultStatus: result.status } : {}),
    ...(typeof record.resultSummary === "string" ? { resultSummary: record.resultSummary } : {}),
    ...(typeof record.resultDelegationTaskId === "string" ? { resultDelegationTaskId: record.resultDelegationTaskId } : {}),
    ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
    ...(references !== undefined ? { references } : {}),
    ...(typeof record.repoStatusSummary === "string" ? { repoStatusSummary: record.repoStatusSummary } : {}),
    ...(typeof record.latestArtifactSummary === "string" ? { latestArtifactSummary: record.latestArtifactSummary } : {}),
  };
}

function parseSubAgentResult(value: unknown): SubAgentResultEnvelope | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    (record.status !== "completed" && record.status !== "blocked" && record.status !== "failed") ||
    typeof record.result !== "string"
  ) {
    return undefined;
  }
  const references = parseStringArray(record.references);
  const error = asRecord(record.error);
  return {
    status: record.status,
    result: record.result,
    ...(references !== undefined ? { references } : {}),
    ...(typeof error?.code === "string" && typeof error.message === "string"
      ? { error: { code: error.code, message: error.message } }
      : {}),
  };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) === false) {
    return undefined;
  }
  const items = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function parseChildActivitySummary(value: unknown): TaskChildActivitySummary | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    typeof record.total !== "number" ||
    typeof record.active !== "number" ||
    typeof record.blocked !== "number" ||
    typeof record.failed !== "number" ||
    typeof record.completed !== "number"
  ) {
    return undefined;
  }
  return {
    total: record.total,
    active: record.active,
    blocked: record.blocked,
    failed: record.failed,
    completed: record.completed,
    ...(typeof record.latestResult === "string" ? { latestResult: record.latestResult } : {}),
  };
}

function parseChildStatusByDelegation(
  value: unknown,
): Record<string, TaskChildActivityStatus> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const entries = Object.entries(record).filter(
    (entry): entry is [string, TaskChildActivityStatus] =>
      entry[1] === "active" || entry[1] === "blocked" || entry[1] === "failed" || entry[1] === "completed",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const entries = Object.entries(record).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parsePullRequestLink(value: unknown): ProductPullRequestLink | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.number !== "number" || typeof record.title !== "string") {
    return undefined;
  }
  return {
    number: record.number,
    title: record.title,
    ...(record.state === "OPEN" || record.state === "MERGED" || record.state === "CLOSED"
      ? { state: record.state }
      : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
  };
}

function nextSiblingOrder(graph: ProductTaskGraph, parentTaskId: string | undefined): number {
  return Object.values(graph.tasks).filter((task) => task.parentTaskId === parentTaskId).length;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}
