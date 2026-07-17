import { randomUUID } from "node:crypto";

import type { ProductTaskGraph } from "../taskGraph/contracts.js";
import type {
  ProductActivityItem,
  ProductProjectAction,
  ProductProjectBoardAction,
  ProductProjectPolicyState,
  ProductProjectSetupState,
  ProductProjectSnapshot,
  ProductReviewSnapshot,
  ProductWorkspaceCheckpointSummary,
} from "./contracts.js";
import { DEFAULT_WEB_PROFILE_ID } from "../web/profile.js";
import {
  applyProjectBoardAction,
  createEmptyProjectBoard,
  normalizeProjectBoard,
} from "./board.js";
import {
  applyTaskQueueAction,
  createEmptyTaskQueue,
  normalizeTaskQueue,
} from "../missionControl/queue.js";

export function createEmptyProjectSetupState(): ProductProjectSetupState {
  return {
    workspaceRoot: "",
    repoRoot: "",
    repoLabel: "",
    defaultBranch: "main",
    providerProfileId: DEFAULT_WEB_PROFILE_ID,
    githubConnected: false,
    browserReady: false,
    codeReady: true,
    mcpReady: false,
  };
}

export function createEmptyProjectPolicyState(): ProductProjectPolicyState {
  return {
    sandboxMode: "workspace_write",
    approvalMode: "manual",
    toolClassPolicy: {
      read_only: true,
      sandboxed_only: true,
      external_side_effect: false,
    },
    browserScope: "task",
    githubScope: "task",
    mcpScope: "project",
    taskOverrides: {},
    recentDecisions: [],
  };
}

export function createEmptyReviewSnapshot(): ProductReviewSnapshot {
  return {
    branches: [],
    worktrees: [],
    pullRequests: [],
    recentCommits: [],
  };
}

export function createEmptyProjectSnapshot(graphVersion: ProductTaskGraph["version"] = 1): ProductProjectSnapshot {
  return {
    version: 1,
    graphVersion,
    setup: createEmptyProjectSetupState(),
    policy: createEmptyProjectPolicyState(),
    board: createEmptyProjectBoard(),
    taskQueue: createEmptyTaskQueue(),
    review: createEmptyReviewSnapshot(),
    workspaceCheckpoints: createEmptyWorkspaceCheckpointSummary(),
    activity: [],
  };
}

export function normalizeProjectSnapshot(value: unknown, graphVersion: ProductTaskGraph["version"] = 1): ProductProjectSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createEmptyProjectSnapshot(graphVersion);
  }
  const record = value as Record<string, unknown>;
  const setup = normalizeProjectSetup(record.setup);
  const policy = normalizeProjectPolicy(record.policy);
  const board = normalizeProjectBoard(record.board);
  const taskQueue = normalizeTaskQueue(record.taskQueue);
  const review = normalizeReviewSnapshot(record.review);
  const activity = Array.isArray(record.activity)
    ? record.activity.map(normalizeActivityItem).filter((item): item is ProductActivityItem => item !== undefined)
    : [];
  return {
    version: 1,
    graphVersion,
    setup,
    policy,
    board,
    taskQueue,
    review,
    workspaceCheckpoints: normalizeWorkspaceCheckpointSummary(record.workspaceCheckpoints),
    activity,
  };
}

export function readProjectSnapshotFromRuntimeState(
  state: Record<string, unknown>,
  graphVersion: ProductTaskGraph["version"] = 1,
): ProductProjectSnapshot {
  const product = asRecord(state.product);
  return normalizeProjectSnapshot(product?.projectSnapshot, graphVersion);
}

export function buildProjectSnapshotStatePatch(
  state: Record<string, unknown>,
  snapshot: ProductProjectSnapshot,
): Record<string, unknown> {
  const product = asRecord(state.product) ?? {};
  return {
    product: {
      ...product,
      projectSnapshot: normalizeProjectSnapshot(snapshot, snapshot.graphVersion),
    },
  };
}

export function appendPolicyDecision(
  policy: ProductProjectPolicyState,
  summary: string,
  taskId?: string | undefined,
): ProductProjectPolicyState {
  return {
    ...policy,
    recentDecisions: [
      {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        summary,
        ...(taskId !== undefined ? { taskId } : {}),
      },
      ...policy.recentDecisions,
    ].slice(0, 12),
  };
}

export function applyProjectSnapshotAction(
  snapshot: ProductProjectSnapshot,
  action: ProductProjectAction,
): ProductProjectSnapshot {
  if (isProjectTaskAction(action)) {
    return {
      ...snapshot,
      taskQueue: applyTaskQueueAction(snapshot.taskQueue, action),
    };
  }
  if (isProjectBoardAction(action)) {
    return {
      ...snapshot,
      board: applyProjectBoardAction(snapshot.board, action),
    };
  }
  return snapshot;
}

function normalizeProjectSetup(value: unknown): ProductProjectSetupState {
  const record = asRecord(value) ?? {};
  return {
    workspaceRoot: typeof record.workspaceRoot === "string" ? record.workspaceRoot : "",
    repoRoot: typeof record.repoRoot === "string" ? record.repoRoot : "",
    repoLabel: typeof record.repoLabel === "string" ? record.repoLabel : "",
    defaultBranch: typeof record.defaultBranch === "string" ? record.defaultBranch : "main",
    providerProfileId: typeof record.providerProfileId === "string" ? record.providerProfileId : DEFAULT_WEB_PROFILE_ID,
    ...(typeof record.githubOwner === "string" ? { githubOwner: record.githubOwner } : {}),
    ...(typeof record.githubRepo === "string" ? { githubRepo: record.githubRepo } : {}),
    githubConnected: record.githubConnected === true,
    browserReady: record.browserReady === true,
    codeReady: record.codeReady !== false,
    mcpReady: record.mcpReady === true,
  };
}

function normalizeProjectPolicy(value: unknown): ProductProjectPolicyState {
  const record = asRecord(value) ?? {};
  const taskOverridesRecord = asRecord(record.taskOverrides) ?? {};
  return {
    sandboxMode:
      record.sandboxMode === "read_only" || record.sandboxMode === "full_access"
        ? record.sandboxMode
        : "workspace_write",
    approvalMode:
      record.approvalMode === "on_request" || record.approvalMode === "auto"
        ? record.approvalMode
        : "manual",
    toolClassPolicy: normalizeToolClassPolicy(record.toolClassPolicy),
    browserScope: normalizeCapabilityScope(record.browserScope, "task"),
    githubScope: normalizeCapabilityScope(record.githubScope, "task"),
    mcpScope: normalizeCapabilityScope(record.mcpScope, "project"),
    taskOverrides: Object.fromEntries(
      Object.entries(taskOverridesRecord).map(([taskId, override]) => [taskId, normalizeTaskOverride(override)]),
    ),
    recentDecisions: Array.isArray(record.recentDecisions)
      ? record.recentDecisions
          .map(normalizeDecisionRecord)
          .filter((item): item is ProductProjectPolicyState["recentDecisions"][number] => item !== undefined)
      : [],
  };
}

function isProjectBoardAction(action: ProductProjectAction): action is ProductProjectBoardAction {
  return action.type.startsWith("board.");
}

function isProjectTaskAction(action: ProductProjectAction): action is Extract<ProductProjectAction, { type: `task.${string}` }> {
  return action.type.startsWith("task.");
}

function normalizeReviewSnapshot(value: unknown): ProductReviewSnapshot {
  const record = asRecord(value) ?? {};
  const branches: ProductReviewSnapshot["branches"] = [];
  if (Array.isArray(record.branches)) {
    for (const entry of record.branches) {
      const parsed = asRecord(entry);
      if (parsed === undefined || typeof parsed.name !== "string") {
        continue;
      }
      branches.push({
        name: parsed.name,
        ...(parsed.current === true ? { current: true } : {}),
      });
    }
  }
  const worktrees: ProductReviewSnapshot["worktrees"] = [];
  if (Array.isArray(record.worktrees)) {
    for (const entry of record.worktrees) {
      const parsed = asRecord(entry);
      if (parsed === undefined || typeof parsed.path !== "string") {
        continue;
      }
      worktrees.push({
        path: parsed.path,
        ...(typeof parsed.branch === "string" ? { branch: parsed.branch } : {}),
        ...(parsed.current === true ? { current: true } : {}),
      });
    }
  }
  const pullRequests: ProductReviewSnapshot["pullRequests"] = [];
  if (Array.isArray(record.pullRequests)) {
    for (const entry of record.pullRequests) {
      const parsed = asRecord(entry);
      if (
        parsed === undefined ||
        typeof parsed.number !== "number" ||
        typeof parsed.title !== "string" ||
        typeof parsed.branch !== "string" ||
        typeof parsed.baseBranch !== "string"
      ) {
        continue;
      }
      pullRequests.push({
        number: parsed.number,
        title: parsed.title,
        branch: parsed.branch,
        baseBranch: parsed.baseBranch,
        state:
          parsed.state === "MERGED" || parsed.state === "CLOSED"
            ? parsed.state
            : "OPEN",
        ...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
      });
    }
  }
  const recentCommits: ProductReviewSnapshot["recentCommits"] = [];
  if (Array.isArray(record.recentCommits)) {
    for (const entry of record.recentCommits) {
      const parsed = asRecord(entry);
      if (parsed === undefined || typeof parsed.sha !== "string" || typeof parsed.summary !== "string") {
        continue;
      }
      recentCommits.push({
        sha: parsed.sha,
        summary: parsed.summary,
      });
    }
  }
  return {
    ...(typeof record.repoRoot === "string" ? { repoRoot: record.repoRoot } : {}),
    ...(typeof record.currentBranch === "string" ? { currentBranch: record.currentBranch } : {}),
    ...(typeof record.statusSummary === "string" ? { statusSummary: record.statusSummary } : {}),
    branches,
    worktrees,
    pullRequests,
    recentCommits,
  };
}

function createEmptyWorkspaceCheckpointSummary(): ProductWorkspaceCheckpointSummary {
  return {
    recentActivity: [],
  };
}

function normalizeWorkspaceCheckpointSummary(value: unknown): ProductWorkspaceCheckpointSummary {
  const record = asRecord(value) ?? {};
  const recentActivity: ProductWorkspaceCheckpointSummary["recentActivity"] = [];
  if (Array.isArray(record.recentActivity)) {
    for (const entry of record.recentActivity) {
      const item = asRecord(entry);
      if (
        item === undefined ||
        typeof item.id !== "string" ||
        typeof item.kind !== "string" ||
        typeof item.label !== "string" ||
        typeof item.status !== "string" ||
        typeof item.timestamp !== "string"
      ) {
        continue;
      }
      recentActivity.push({
        id: item.id,
        kind: item.kind === "restore" || item.kind === "cleanup" ? item.kind : "capture",
        label: item.label,
        status: item.status,
        timestamp: item.timestamp,
        ...(typeof item.checkpointId === "string" ? { checkpointId: item.checkpointId } : {}),
        ...(typeof item.restoreId === "string" ? { restoreId: item.restoreId } : {}),
      });
    }
  }
  return {
    ...(typeof record.latestCheckpointId === "string" ? { latestCheckpointId: record.latestCheckpointId } : {}),
    ...(typeof record.latestRestoreId === "string" ? { latestRestoreId: record.latestRestoreId } : {}),
    ...(typeof record.latestRestoreStatus === "string" ? { latestRestoreStatus: record.latestRestoreStatus } : {}),
    ...(typeof record.latestCleanupId === "string" ? { latestCleanupId: record.latestCleanupId } : {}),
    ...(typeof record.latestCleanupAt === "string" ? { latestCleanupAt: record.latestCleanupAt } : {}),
    ...(typeof record.latestCleanupDeletedCheckpointCount === "number"
      ? { latestCleanupDeletedCheckpointCount: record.latestCleanupDeletedCheckpointCount }
      : {}),
    ...(typeof record.retainedCheckpointCount === "number" ? { retainedCheckpointCount: record.retainedCheckpointCount } : {}),
    ...(typeof record.retainedBytes === "number" ? { retainedBytes: record.retainedBytes } : {}),
    recentActivity,
  };
}

function normalizeActivityItem(value: unknown): ProductActivityItem | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    typeof record.id !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.title !== "string" ||
    typeof record.detail !== "string" ||
    typeof record.timestamp !== "string"
  ) {
    return ;
  }
  return {
    id: record.id,
    kind:
      record.kind === "approval" ||
      record.kind === "checkpoint" ||
      record.kind === "delegation" ||
      record.kind === "code" ||
      record.kind === "browser" ||
      record.kind === "terminal" ||
      record.kind === "review" ||
      record.kind === "result"
        ? record.kind
        : "task",
    title: record.title,
    detail: record.detail,
    timestamp: record.timestamp,
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
    ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(Array.isArray(record.badges)
      ? { badges: record.badges.filter((entry): entry is string => typeof entry === "string") }
      : {}),
  };
}

function normalizeTaskOverride(value: unknown): ProductProjectPolicyState["taskOverrides"][string] {
  const record = asRecord(value) ?? {};
  return {
    ...(record.sandboxMode === "read_only" || record.sandboxMode === "workspace_write" || record.sandboxMode === "full_access"
      ? { sandboxMode: record.sandboxMode }
      : {}),
    ...(record.approvalMode === "manual" || record.approvalMode === "on_request" || record.approvalMode === "auto"
      ? { approvalMode: record.approvalMode }
      : {}),
    ...(record.toolClassPolicy !== undefined ? { toolClassPolicy: normalizeToolClassPolicy(record.toolClassPolicy) } : {}),
  };
}

function normalizeToolClassPolicy(
  value: unknown,
): ProductProjectPolicyState["toolClassPolicy"] {
  const record = asRecord(value) ?? {};
  return {
    ...(typeof record.read_only === "boolean" ? { read_only: record.read_only } : {}),
    ...(typeof record.sandboxed_only === "boolean" ? { sandboxed_only: record.sandboxed_only } : {}),
    ...(typeof record.external_side_effect === "boolean"
      ? { external_side_effect: record.external_side_effect }
      : {}),
  };
}

function normalizeDecisionRecord(value: unknown): ProductProjectPolicyState["recentDecisions"][number] | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    typeof record.id !== "string" ||
    typeof record.timestamp !== "string" ||
    typeof record.summary !== "string"
  ) {
    return ;
  }
  return {
    id: record.id,
    timestamp: record.timestamp,
    summary: record.summary,
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
  };
}

function normalizeCapabilityScope(value: unknown, fallback: "disabled" | "task" | "project") {
  return value === "disabled" || value === "task" || value === "project" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildActivityFromGraph(graph: ProductTaskGraph): ProductActivityItem[] {
  return Object.values(graph.tasks)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 24)
    .map((task) => {
      const badges = [
        task.status,
        ...(task.linkedBranch !== undefined ? [`branch:${task.linkedBranch}`] : []),
        ...(task.linkedWorktree !== undefined ? [`worktree:${task.linkedWorktree}`] : []),
        ...(task.linkedPullRequest !== undefined ? [`pr:#${task.linkedPullRequest.number}`] : []),
      ];
      const detail = [
        task.runtime.latestArtifactSummary,
        task.runtime.resultSummary,
        task.runtime.nextAction,
        task.runtime.blocker,
      ]
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .join(" | ");
      return {
        id: `activity:${task.id}`,
        kind: inferActivityKind(task.runtime.latestArtifactSummary, task.runtime),
        title: task.title,
        detail: detail.length > 0 ? detail : "No artifact summary recorded yet.",
        timestamp: task.updatedAt,
        taskId: task.id,
        ...(task.linkedThreadId !== undefined ? { threadId: task.linkedThreadId } : {}),
        status: task.status,
        badges,
      };
    });
}

function inferActivityKind(
  latestArtifactSummary: string | undefined,
  runtime: ProductTaskGraph["tasks"][string]["runtime"],
): ProductActivityItem["kind"] {
  const summary = `${latestArtifactSummary ?? ""} ${runtime.resultSummary ?? ""}`.toLowerCase();
  if (runtime.approvalPrompt !== undefined) {
    return "approval";
  }
  if (runtime.checkpoint !== undefined) {
    return "checkpoint";
  }
  if (runtime.childSummary !== undefined || runtime.fanIn !== undefined) {
    return "delegation";
  }
  if (summary.includes("browser")) {
    return "browser";
  }
  if (summary.includes("command") || summary.includes("terminal")) {
    return "terminal";
  }
  if (summary.includes("commit") || summary.includes("pull request") || summary.includes("pr")) {
    return "review";
  }
  if (summary.includes("file") || summary.includes("code")) {
    return "code";
  }
  if (runtime.resultSummary !== undefined) {
    return "result";
  }
  return "task";
}
