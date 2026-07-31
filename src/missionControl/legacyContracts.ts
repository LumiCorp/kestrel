import type { ProductTaskGraph } from "../taskGraph/contracts.js";
import type { ProductProjectSnapshot } from "../project/contracts.js";
import { normalizeProjectSnapshot } from "../project/state.js";

const LEGACY_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/**
 * Read-only shapes for explaining and verifying pre-cutover data.
 * No reducer or write adapter accepts these contracts.
 */
export type LegacyTaskStatus =
  | "proposed"
  | "queued"
  | "running"
  | "needs_attention"
  | "ready_for_review"
  | "done"
  | "discarded";

export interface LegacyTask {
  id: string;
  title: string;
  projectPath?: string | undefined;
  projectLabel?: string | undefined;
  instructions: string;
  acceptanceCriteria?: string | undefined;
  priority: "low" | "medium" | "high" | "urgent";
  status: LegacyTaskStatus;
  createdBy: "user" | "agent";
  createdAt: string;
  updatedAt: string;
  order: number;
  attentionReason?:
    | "blocked"
    | "failed"
    | "approval_needed"
    | "human_reply_needed"
    | undefined;
  assignedAgentId?: string | undefined;
  threadId?: string | undefined;
  sessionId?: string | undefined;
  worktreePath?: string | undefined;
  evidence: Array<{
    id: string;
    timestamp: string;
    summary: string;
    source: "user" | "agent" | "runtime" | "system";
    threadId?: string | undefined;
    runId?: string | undefined;
  }>;
  review?: {
    submittedAt: string;
    summary: string;
    changedFileCount?: number | undefined;
    testsSummary?: string | undefined;
    previewUrl?: string | undefined;
    pullRequestUrl?: string | undefined;
  } | undefined;
}

export interface LegacyTaskQueue {
  version: 1;
  queueVersion: number;
  nextTaskNumber: number;
  tasks: Record<string, LegacyTask>;
}

export type LegacyBoardLane = "idea" | "planned" | "wip" | "testing" | "done";

export interface LegacyBoardCard {
  id: string;
  title: string;
  prompt: string;
  lane: LegacyBoardLane;
  order: number;
  createdAt: string;
  updatedAt: string;
  activeClaim?: {
    threadId: string;
    sessionId: string;
    kind: "implementation" | "testing";
    claimedAt: string;
    claimReason: "autopilot" | "copilot";
  } | undefined;
  threads: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
}

export interface LegacyBoardSnapshot {
  version: 1;
  boardVersion: number;
  nextCardNumber: number;
  lanes: LegacyBoardLane[];
  settings: {
    autopilotEnabled: boolean;
    autopilotConfirmedAt?: string | undefined;
    wipLimit: number;
  };
  cards: Record<string, LegacyBoardCard>;
}

export interface MissionControlLegacyProjectSnapshot
  extends ProductProjectSnapshot {
  board: LegacyBoardSnapshot;
  taskQueue: LegacyTaskQueue;
}

export function parseMissionControlLegacyProjectSnapshot(
  value: unknown,
  graphVersion: ProductTaskGraph["version"] = 1,
): MissionControlLegacyProjectSnapshot {
  const record = object(value);
  return {
    ...normalizeProjectSnapshot(value, graphVersion),
    board: parseLegacyBoard(record.board),
    taskQueue: parseLegacyTaskQueue(record.taskQueue),
  };
}

function parseLegacyTaskQueue(value: unknown): LegacyTaskQueue {
  const record = object(value);
  const tasksRecord = object(record.tasks);
  const tasks: Record<string, LegacyTask> = {};
  for (const [id, entry] of Object.entries(tasksRecord)) {
    const parsed = parseLegacyTask(id, entry);
    if (parsed !== undefined) tasks[id] = parsed;
  }
  const highestTaskNumber = Object.keys(tasks).reduce((highest, taskId) => {
    const match = /^T-(\d+)$/u.exec(taskId);
    return match === null ? highest : Math.max(highest, Number(match[1]));
  }, 0);
  return {
    version: 1,
    queueVersion: positiveInteger(record.queueVersion),
    nextTaskNumber: positiveInteger(
      record.nextTaskNumber,
      highestTaskNumber + 1,
    ),
    tasks,
  };
}

function parseLegacyTask(id: string, value: unknown): LegacyTask | undefined {
  const record = object(value);
  const title = stringValue(record.title);
  const instructions = stringValue(record.instructions);
  const status = legacyTaskStatus(record.status);
  if (title === undefined || instructions === undefined || status === undefined) {
    return;
  }
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.flatMap((entry) => {
        const item = object(entry);
        const evidenceId = stringValue(item.id);
        const evidenceTimestamp = stringValue(item.timestamp);
        const summary = stringValue(item.summary);
        if (
          evidenceId === undefined ||
          evidenceTimestamp === undefined ||
          summary === undefined
        ) {
          return [];
        }
        const source: LegacyTask["evidence"][number]["source"] =
          item.source === "agent" ||
          item.source === "runtime" ||
          item.source === "system"
            ? item.source
            : "user";
        return [{
          id: evidenceId,
          timestamp: evidenceTimestamp,
          summary,
          source,
          ...(stringValue(item.threadId) !== undefined
            ? { threadId: stringValue(item.threadId) }
            : {}),
          ...(stringValue(item.runId) !== undefined
            ? { runId: stringValue(item.runId) }
            : {}),
        }];
      })
    : [];
  const attentionReason = legacyAttentionReason(record.attentionReason);
  const review = parseLegacyReview(record.review);
  return {
    id: stringValue(record.id) ?? id,
    title,
    instructions,
    priority:
      record.priority === "low" ||
      record.priority === "high" ||
      record.priority === "urgent"
        ? record.priority
        : "medium",
    status,
    createdBy: record.createdBy === "agent" ? "agent" : "user",
    createdAt: stringValue(record.createdAt) ?? LEGACY_TIMESTAMP,
    updatedAt: stringValue(record.updatedAt) ?? LEGACY_TIMESTAMP,
    order: finiteNumber(record.order),
    evidence,
    ...(stringValue(record.projectPath) !== undefined
      ? { projectPath: stringValue(record.projectPath) }
      : {}),
    ...(stringValue(record.projectLabel) !== undefined
      ? { projectLabel: stringValue(record.projectLabel) }
      : {}),
    ...(stringValue(record.acceptanceCriteria) !== undefined
      ? { acceptanceCriteria: stringValue(record.acceptanceCriteria) }
      : {}),
    ...(attentionReason !== undefined ? { attentionReason } : {}),
    ...(stringValue(record.assignedAgentId) !== undefined
      ? { assignedAgentId: stringValue(record.assignedAgentId) }
      : {}),
    ...(stringValue(record.threadId) !== undefined
      ? { threadId: stringValue(record.threadId) }
      : {}),
    ...(stringValue(record.sessionId) !== undefined
      ? { sessionId: stringValue(record.sessionId) }
      : {}),
    ...(stringValue(record.worktreePath) !== undefined
      ? { worktreePath: stringValue(record.worktreePath) }
      : {}),
    ...(review !== undefined ? { review } : {}),
  };
}

function parseLegacyBoard(value: unknown): LegacyBoardSnapshot {
  const record = object(value);
  const cardsRecord = object(record.cards);
  const cards: Record<string, LegacyBoardCard> = {};
  for (const [id, entry] of Object.entries(cardsRecord)) {
    const parsed = parseLegacyCard(id, entry);
    if (parsed !== undefined) cards[id] = parsed;
  }
  const highestCardNumber = Object.keys(cards).reduce((highest, cardId) => {
    const match = /^K-(\d+)$/u.exec(cardId);
    return match === null ? highest : Math.max(highest, Number(match[1]));
  }, 0);
  const settings = object(record.settings);
  return {
    version: 1,
    boardVersion: positiveInteger(record.boardVersion),
    nextCardNumber: positiveInteger(
      record.nextCardNumber,
      highestCardNumber + 1,
    ),
    lanes: ["idea", "planned", "wip", "testing", "done"],
    settings: {
      autopilotEnabled: settings.autopilotEnabled === true,
      wipLimit: positiveInteger(settings.wipLimit),
      ...(timestamp(settings.autopilotConfirmedAt) !== undefined
        ? { autopilotConfirmedAt: timestamp(settings.autopilotConfirmedAt) }
        : {}),
    },
    cards,
  };
}

function parseLegacyCard(
  id: string,
  value: unknown,
): LegacyBoardCard | undefined {
  const record = object(value);
  const title = stringValue(record.title);
  const prompt = stringValue(record.prompt);
  const lane = legacyBoardLane(record.lane);
  if (title === undefined || prompt === undefined || lane === undefined) {
    return;
  }
  const activeClaim = parseLegacyClaim(record.activeClaim);
  return {
    id: stringValue(record.id) ?? id,
    title,
    prompt,
    lane,
    order: finiteNumber(record.order),
    createdAt: stringValue(record.createdAt) ?? LEGACY_TIMESTAMP,
    updatedAt: stringValue(record.updatedAt) ?? LEGACY_TIMESTAMP,
    ...(activeClaim !== undefined ? { activeClaim } : {}),
    threads: Array.isArray(record.threads)
      ? record.threads.map(object)
      : [],
    evidence: Array.isArray(record.evidence)
      ? record.evidence.map(object)
      : [],
  };
}

function parseLegacyClaim(
  value: unknown,
): LegacyBoardCard["activeClaim"] | undefined {
  const record = object(value);
  const threadId = stringValue(record.threadId);
  const sessionId = stringValue(record.sessionId);
  if (
    threadId === undefined ||
    sessionId === undefined ||
    (record.kind !== "implementation" && record.kind !== "testing")
  ) {
    return;
  }
  return {
    threadId,
    sessionId,
    kind: record.kind,
    claimedAt: stringValue(record.claimedAt) ?? LEGACY_TIMESTAMP,
    claimReason: record.claimReason === "copilot" ? "copilot" : "autopilot",
  };
}

function parseLegacyReview(value: unknown): LegacyTask["review"] | undefined {
  if (isObject(value) === false) return;
  const record = value;
  return {
    submittedAt: stringValue(record.submittedAt) ?? LEGACY_TIMESTAMP,
    summary:
      text(record.summary) ?? "Ready for review.",
    ...(typeof record.changedFileCount === "number"
      ? { changedFileCount: record.changedFileCount }
      : {}),
    ...(stringValue(record.testsSummary) !== undefined
      ? { testsSummary: stringValue(record.testsSummary) }
      : {}),
    ...(stringValue(record.previewUrl) !== undefined
      ? { previewUrl: stringValue(record.previewUrl) }
      : {}),
    ...(stringValue(record.pullRequestUrl) !== undefined
      ? { pullRequestUrl: stringValue(record.pullRequestUrl) }
      : {}),
  };
}

function legacyAttentionReason(
  value: unknown,
): LegacyTask["attentionReason"] {
  return value === "blocked" ||
    value === "failed" ||
    value === "approval_needed" ||
    value === "human_reply_needed"
    ? value
    : undefined;
}

function legacyTaskStatus(value: unknown): LegacyTaskStatus | undefined {
  return value === "proposed" ||
    value === "queued" ||
    value === "running" ||
    value === "needs_attention" ||
    value === "ready_for_review" ||
    value === "done" ||
    value === "discarded"
    ? value
    : undefined;
}

function legacyBoardLane(value: unknown): LegacyBoardLane | undefined {
  return value === "idea" ||
    value === "planned" ||
    value === "wip" ||
    value === "testing" ||
    value === "done"
    ? value
    : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function timestamp(value: unknown): string | undefined {
  const parsed = text(value);
  return parsed !== undefined && Number.isNaN(Date.parse(parsed)) === false
    ? parsed
    : undefined;
}

function positiveInteger(value: unknown, fallback = 1): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
