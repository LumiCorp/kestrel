import { createHash } from "node:crypto";

import type { MissionControlProjectRepository } from "../kestrel/contracts/store.js";
import type { ProductProjectSnapshot } from "../project/contracts.js";
import type { Task, TaskStatus } from "./contracts.js";
import {
  fingerprintLegacySource,
} from "./migrationAuthority.js";
import type {
  MissionControlLegacyProjectSource,
  MissionControlMigrationSourceProvenance,
} from "./migrationContracts.js";
import {
  MissionControlProjectService,
  MissionControlTransitionError,
  parseMissionControlProjectDocument,
  requireMissionControlActionId,
  requireMissionControlExpectedRevision,
  requireMissionControlProjectId,
  type MissionControlProjectDocument,
  type MissionControlProjectMutationResult,
  type MissionControlWorkItem,
} from "./projectAuthority.js";

interface AuthorityActionBase {
  projectId: string;
  actionId: string;
  actionTs: string;
  expectedRevision: number;
}

export type MissionControlAuthorityAction =
  | (AuthorityActionBase & { type: "authority.activate" })
  | (AuthorityActionBase & {
      type: "authority.rollback";
      operatorId: string;
    });

type AuthorityRepository = Pick<
  MissionControlProjectRepository,
  | "getMissionControlProjectState"
  | "updateMissionControlProjectState"
  | "listMissionControlLegacySources"
>;

export type MissionControlAuthorityGateReason =
  | "already_active"
  | "not_active"
  | "migration_not_ready"
  | "source_drift"
  | "active_execution";

export class MissionControlAuthorityGateError extends Error {
  readonly code = "MISSION_CONTROL_AUTHORITY_REJECTED";

  constructor(
    readonly reason: MissionControlAuthorityGateReason,
    message: string,
  ) {
    super(message);
    this.name = "MissionControlAuthorityGateError";
  }
}

export class MissionControlAuthorityService {
  readonly projects: MissionControlProjectService;

  constructor(private readonly store: AuthorityRepository) {
    this.projects = new MissionControlProjectService(store);
  }

  async execute(
    actionValue: unknown,
  ): Promise<MissionControlProjectMutationResult> {
    const action = parseMissionControlAuthorityAction(actionValue);
    const current = await this.projects.getProject(action.projectId);
    if (
      current.document.history.some(
        (entry) => entry.actionId === action.actionId,
      )
    ) {
      return this.replay(action);
    }
    if (action.type === "authority.activate") {
      if (current.authorityEpoch !== 0) {
        throw gate("already_active", "Mission Control project authority is already active.");
      }
      const migration = current.document.migration;
      if (
        migration === undefined ||
        (migration.status !== "staged_empty" &&
          migration.status !== "staged" &&
          migration.status !== "resolved")
      ) {
        throw gate(
          "migration_not_ready",
          "Mission Control migration must be deterministically resolved before activation.",
        );
      }
      const sources = await this.listLegacySources();
      assertSourceFingerprints(migration.sources, sources);
      return this.store.updateMissionControlProjectState({
        projectId: action.projectId,
        actionId: action.actionId,
        requestFingerprint: fingerprint(action),
        expectedRevision: action.expectedRevision,
        authorityTransition: {
          type: "activate",
          sourceClaims: migration.sources.map((source) => ({
            sourceId: source.sourceId,
            sourceFingerprint: source.sourceFingerprint,
          })),
          transitionedAt: action.actionTs,
        },
        apply: (document) => ({
          document: appendAuthorityHistory(document, action),
          effects: [],
        }),
      });
    }

    if (current.authorityEpoch === 0) {
      throw gate("not_active", "Mission Control canonical authority is not active.");
    }
    if (hasActiveExecution(current.document)) {
      throw gate(
        "active_execution",
        "Mission Control rollback requires every execution attempt to be settled.",
      );
    }
    const sources = await this.listLegacySources();
    const migrationSources = current.document.migration?.sources ?? [];
    const exports = migrationSources.map((source) => {
      const legacy = sources.find((candidate) => candidate.sourceId === source.sourceId);
      if (legacy === undefined) {
        throw gate(
          "source_drift",
          `Frozen Mission Control legacy source is unavailable: ${source.sourceId}.`,
        );
      }
      return {
        sourceId: source.sourceId,
        snapshot: exportCanonicalProject(
          legacy.snapshot,
          current.document,
          current.revision,
          action.actionTs,
        ),
      };
    });
    return this.store.updateMissionControlProjectState({
      projectId: action.projectId,
      actionId: action.actionId,
      requestFingerprint: fingerprint(action),
      expectedRevision: action.expectedRevision,
      authorityTransition: {
        type: "rollback",
        exports,
        transitionedAt: action.actionTs,
      },
      apply: (document) => ({
        document: appendAuthorityHistory(
          {
            ...document,
            autopilot: {
              ...document.autopilot,
              enabled: false,
              confirmedAt: undefined,
            },
          },
          action,
        ),
        effects: [],
      }),
    });
  }

  private replay(
    action: MissionControlAuthorityAction,
  ): Promise<MissionControlProjectMutationResult> {
    return this.store.updateMissionControlProjectState({
      projectId: action.projectId,
      actionId: action.actionId,
      requestFingerprint: fingerprint(action),
      expectedRevision: action.expectedRevision,
      apply: (document) => ({ document, effects: [] }),
    });
  }

  private listLegacySources(): Promise<MissionControlLegacyProjectSource[]> {
    if (this.store.listMissionControlLegacySources === undefined) {
      throw new MissionControlTransitionError(
        "Mission Control legacy source inventory is unavailable.",
      );
    }
    return this.store.listMissionControlLegacySources();
  }
}

export function parseMissionControlAuthorityAction(
  value: unknown,
): MissionControlAuthorityAction {
  const record = object(value, "Mission Control authority action");
  const type = text(record.type, "type");
  const base = {
    projectId: requireMissionControlProjectId(record.projectId),
    actionId: requireMissionControlActionId(record.actionId),
    actionTs: timestamp(record.actionTs, "actionTs"),
    expectedRevision: requireMissionControlExpectedRevision(
      record.expectedRevision,
    ),
  };
  if (type === "authority.activate") {
    exactKeys(record, [
      "type",
      "projectId",
      "actionId",
      "actionTs",
      "expectedRevision",
    ]);
    return { ...base, type };
  }
  if (type === "authority.rollback") {
    exactKeys(record, [
      "type",
      "projectId",
      "actionId",
      "actionTs",
      "expectedRevision",
      "operatorId",
    ]);
    return {
      ...base,
      type,
      operatorId: text(record.operatorId, "operatorId"),
    };
  }
  throw new Error(`Unsupported Mission Control authority action: ${type}.`);
}

export function isMissionControlProjectActive(authorityEpoch: number): boolean {
  return Number.isSafeInteger(authorityEpoch) && authorityEpoch > 0;
}

function assertSourceFingerprints(
  expected: MissionControlMigrationSourceProvenance[],
  current: MissionControlLegacyProjectSource[],
): void {
  for (const source of expected) {
    const actual = current.find((candidate) => candidate.sourceId === source.sourceId);
    if (
      actual === undefined ||
      fingerprintLegacySource(actual) !== source.sourceFingerprint
    ) {
      throw gate(
        "source_drift",
        `Mission Control legacy source changed before activation: ${source.sourceId}.`,
      );
    }
  }
}

function hasActiveExecution(document: MissionControlProjectDocument): boolean {
  return Object.values(document.items).some((item) => {
    const attempt = item.attempts.find(
      (candidate) => candidate.id === item.currentAttemptId,
    );
    return (
      attempt?.status === "starting" ||
      attempt?.status === "running" ||
      attempt?.status === "waiting" ||
      attempt?.status === "cancelling"
    );
  });
}

function exportCanonicalProject(
  frozen: ProductProjectSnapshot,
  document: MissionControlProjectDocument,
  revision: number,
  exportedAt: string,
): ProductProjectSnapshot {
  const tasks = Object.fromEntries(
    Object.values(document.items)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((item) => [item.id, exportTask(item, document.migration?.registeredPath)]),
  );
  return {
    ...frozen,
    setup: {
      ...frozen.setup,
      ...(document.migration?.registeredPath === undefined
        ? {}
        : {
            workspaceRoot: document.migration.registeredPath,
            repoRoot: document.migration.registeredPath,
          }),
    },
    board: {
      ...frozen.board,
      boardVersion: frozen.board.boardVersion + 1,
      settings: {
        autopilotEnabled: false,
        wipLimit: document.autopilot.wipLimit,
      },
      cards: {},
    },
    taskQueue: {
      version: 1,
      queueVersion: Math.max(frozen.taskQueue.queueVersion + 1, revision),
      nextTaskNumber: nextTaskNumber(Object.keys(tasks)),
      tasks,
    },
    activity: [
      ...frozen.activity,
      {
        id: `mission-control-rollback-${revision}`,
        kind: "result",
        title: "Mission Control canonical rollback export",
        detail: `Exported canonical project revision ${revision}.`,
        timestamp: exportedAt,
      },
    ],
  };
}

function exportTask(
  item: MissionControlWorkItem,
  projectPath: string | undefined,
): Task {
  const attempt = item.attempts.find(
    (candidate) => candidate.id === item.currentAttemptId,
  );
  const bundle = item.reviewBundles?.find(
    (candidate) => candidate.id === item.currentReviewBundleId,
  );
  return {
    id: item.id,
    title: item.title,
    ...(projectPath === undefined ? {} : { projectPath }),
    instructions: item.instructions,
    priority: "medium",
    status: legacyStatus(item.phase),
    createdBy: item.createdBy === "operator" ? "user" : "agent",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    order: item.order,
    ...(item.phase === "needs_attention"
      ? { attentionReason: "failed" as const }
      : {}),
    ...(attempt === undefined
      ? {}
      : {
          sessionId: attempt.requestedSessionId,
          threadId: attempt.requestedThreadId,
        }),
    evidence: item.attempts.flatMap((candidate) =>
      candidate.runs.map((run) => ({
        id: `${candidate.id}:${run.runId}`,
        timestamp: run.acceptedAt,
        summary: `Mission Control attempt ${candidate.id} (${candidate.status}).`,
        source: "runtime" as const,
        threadId: run.threadId,
        runId: run.runId,
      }))),
    ...(bundle === undefined
      ? {}
      : {
          review: {
            submittedAt: bundle.frozenAt,
            summary: `Frozen Mission Control evidence bundle ${bundle.id}.`,
            testsSummary: bundle.evidence
              .filter((entry) => entry.kind === "validation")
              .map((entry) => `${entry.referenceId}: ${entry.outcome}`)
              .join(", "),
          },
        }),
  };
}

function legacyStatus(phase: MissionControlWorkItem["phase"]): TaskStatus {
  switch (phase) {
    case "proposed":
      return "proposed";
    case "ready":
      return "queued";
    case "active":
      return "running";
    case "needs_attention":
      return "needs_attention";
    case "review":
      return "ready_for_review";
    case "done":
      return "done";
    case "discarded":
      return "discarded";
  }
}

function nextTaskNumber(ids: string[]): number {
  return (
    ids.reduce((highest, id) => {
      const match = /^T-(\d+)$/u.exec(id);
      return match === null ? highest : Math.max(highest, Number(match[1]));
    }, 0) + 1
  );
}

function appendAuthorityHistory(
  currentValue: MissionControlProjectDocument,
  action: MissionControlAuthorityAction,
): MissionControlProjectDocument {
  const current = parseMissionControlProjectDocument(
    currentValue,
    action.projectId,
  );
  return {
    ...current,
    history: [
      ...current.history,
      {
        actionId: action.actionId,
        actionType: action.type,
        revision: action.expectedRevision + 1,
        timestamp: action.actionTs,
      },
    ],
  };
}

function fingerprint(action: MissionControlAuthorityAction): string {
  return createHash("sha256")
    .update(JSON.stringify(sort(action)))
    .digest("hex");
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sort(entry)]),
  );
}

function gate(
  reason: MissionControlAuthorityGateReason,
  message: string,
): MissionControlAuthorityGateError {
  return new MissionControlAuthorityGateError(reason, message);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function timestamp(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return parsed;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key) === false) {
      throw new Error(`Mission Control authority action contains unknown field '${key}'.`);
    }
  }
}
