import { createHash } from "node:crypto";

import type { MissionControlProjectRepository } from "../kestrel/contracts/store.js";
import {
  parseMissionControlMigrationState,
  type MissionControlMigrationState,
} from "./migrationContracts.js";
import {
  parseMissionControlCompletionContract,
  parseMissionControlReviewBundle,
  parseMissionControlReviewDecision,
  type MissionControlCompletionContract,
  type MissionControlReviewBundle,
  type MissionControlReviewDecision,
} from "./reviewContracts.js";

export const MISSION_CONTROL_PROJECT_SCHEMA_VERSION = 1 as const;
export const MISSION_CONTROL_AUTHORITY_EPOCH = 1 as const;

const PROJECT_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type MissionControlWorkPhase =
  | "proposed"
  | "ready"
  | "active"
  | "needs_attention"
  | "review"
  | "done"
  | "discarded";

export type MissionControlWorkCreator = "operator" | "agent";

export type MissionControlAttemptStatus =
  | "starting"
  | "running"
  | "waiting"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

export type MissionControlAttentionReason =
  | "start_rejected"
  | "execution_failed"
  | "operator_stopped"
  | "runner_orphaned"
  | "runtime_authority_changed";

export interface MissionControlAttemptRun {
  sessionId: string;
  threadId: string;
  runId: string;
  commandId: string;
  acceptedAt: string;
}

export interface MissionControlPendingRequest {
  requestId: string;
  threadId: string;
  kind:
    | "approval"
    | "user_input"
    | "delegation"
    | "scheduler_wait"
    | "compaction_checkpoint"
    | "unknown";
  eventType?: string | undefined;
  enteredAt?: string | undefined;
}

export interface MissionControlExecutionAttempt {
  id: string;
  generation: number;
  initiatedBy: "operator" | "autopilot";
  status: MissionControlAttemptStatus;
  version: number;
  profileId: string;
  requestedSessionId: string;
  requestedThreadId: string;
  dispatchCommandId: string;
  dispatchRunId: string;
  runs: MissionControlAttemptRun[];
  currentRunId?: string | undefined;
  pendingRequest?: MissionControlPendingRequest | undefined;
  pendingResponse?: {
    requestId: string;
    commandId: string;
    runId: string;
  } | undefined;
  terminalReason?: string | undefined;
  terminalReasonCode?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface MissionControlWorkItem {
  id: string;
  title: string;
  instructions: string;
  createdBy: MissionControlWorkCreator;
  completionContract?: MissionControlCompletionContract | undefined;
  phase: MissionControlWorkPhase;
  order: number;
  attempts: MissionControlExecutionAttempt[];
  currentAttemptId?: string | undefined;
  attentionReason?: MissionControlAttentionReason | undefined;
  reviewBundles?: MissionControlReviewBundle[] | undefined;
  currentReviewBundleId?: string | undefined;
  reviewDecisions?: MissionControlReviewDecision[] | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type MissionControlHistoryActionType =
  | MissionControlProjectAction["type"]
  | "execution.start"
  | "execution.accepted"
  | "execution.start_rejected"
  | "execution.waiting"
  | "execution.reply"
  | "execution.resumed"
  | "execution.stop"
  | "execution.stop_rejected"
  | "execution.cancel_confirmed"
  | "execution.failed"
  | "execution.orphaned"
  | "execution.completed"
  | "execution.retry"
  | "review.admit"
  | "review.accept"
  | "review.request_changes"
  | "migration.stage"
  | "migration.rebind"
  | "migration.resolve"
  | "migration.clear"
  | "authority.activate"
  | "authority.rollback";

export interface MissionControlHistoryEntry {
  actionId: string;
  actionType: MissionControlHistoryActionType;
  revision: number;
  timestamp: string;
  itemId?: string | undefined;
  attemptId?: string | undefined;
  disposition?: "applied" | "stale" | "noop" | undefined;
}

export interface MissionControlProjectDocument {
  schemaVersion: typeof MISSION_CONTROL_PROJECT_SCHEMA_VERSION;
  projectId: string;
  autopilot: {
    enabled: boolean;
    wipLimit: number;
    confirmedAt?: string | undefined;
  };
  items: Record<string, MissionControlWorkItem>;
  history: MissionControlHistoryEntry[];
  migration?: MissionControlMigrationState | undefined;
}

export interface MissionControlProjectStateRecord {
  projectId: string;
  schemaVersion: typeof MISSION_CONTROL_PROJECT_SCHEMA_VERSION;
  revision: number;
  authorityEpoch: number;
  document: MissionControlProjectDocument;
  createdAt: string;
  updatedAt: string;
}

export interface MissionControlOutboxIntent {
  effectId: string;
  effectType: string;
  payload: Record<string, unknown>;
}

export interface MissionControlOutboxRecord extends MissionControlOutboxIntent {
  id: number;
  projectId: string;
  actionId: string;
  status: "PENDING" | "DELIVERED" | "FAILED";
  attemptCount: number;
  lastError?: string | undefined;
  createdAt: string;
}

export interface MissionControlPersistedMutationResult {
  project: MissionControlProjectStateRecord;
  effects: MissionControlOutboxRecord[];
}

export interface MissionControlProjectMutationResult
  extends MissionControlPersistedMutationResult {
  duplicate: boolean;
}

export interface MissionControlProjectMutationInput {
  projectId: string;
  actionId: string;
  requestFingerprint: string;
  expectedRevision: number;
  apply: (current: MissionControlProjectDocument) => {
    document: MissionControlProjectDocument;
    effects: MissionControlOutboxIntent[];
  };
}

interface MissionControlActionBase {
  projectId: string;
  actionId: string;
  actionTs: string;
  expectedRevision: number;
}

interface MissionControlItemActionBase extends MissionControlActionBase {
  itemId: string;
  expectedItemVersion: number;
}

export type MissionControlProjectAction =
  | (MissionControlActionBase & {
      type: "item.create";
      itemId: string;
      title: string;
      instructions: string;
      createdBy: MissionControlWorkCreator;
      completionContract?: MissionControlCompletionContract | undefined;
      order: number;
    })
  | (MissionControlItemActionBase & {
      type: "item.approve";
    })
  | (MissionControlItemActionBase & {
      type: "item.reorder";
      targetPhase: MissionControlWorkPhase;
      order: number;
    })
  | (MissionControlItemActionBase & {
      type: "item.return_to_ready";
    })
  | (MissionControlItemActionBase & {
      type: "item.discard";
    })
  | (MissionControlItemActionBase & {
      type: "item.restore";
    })
  | (MissionControlActionBase & {
      type: "autopilot.configure";
      enabled: boolean;
      wipLimit: number;
      confirmedAt?: string | undefined;
    });

export class MissionControlRevisionConflictError extends Error {
  readonly code = "MISSION_CONTROL_REVISION_CONFLICT";

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Mission Control project revision conflict: expected=${expectedRevision} actual=${actualRevision}.`,
    );
    this.name = "MissionControlRevisionConflictError";
  }
}

export class MissionControlItemVersionConflictError extends Error {
  readonly code = "MISSION_CONTROL_ITEM_VERSION_CONFLICT";

  constructor(itemId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Mission Control item ${itemId} version conflict: expected=${expectedVersion} actual=${actualVersion}.`,
    );
    this.name = "MissionControlItemVersionConflictError";
  }
}

export class MissionControlActionIdentityConflictError extends Error {
  readonly code = "MISSION_CONTROL_ACTION_ID_REUSED";

  constructor(actionId: string) {
    super(`Mission Control action ${actionId} was already used with different input.`);
    this.name = "MissionControlActionIdentityConflictError";
  }
}

export class MissionControlTransitionError extends Error {
  readonly code = "MISSION_CONTROL_TRANSITION_REJECTED";

  constructor(message: string) {
    super(message);
    this.name = "MissionControlTransitionError";
  }
}

export class MissionControlProjectService {
  private readonly store: Pick<
    MissionControlProjectRepository,
    "getMissionControlProjectState" | "updateMissionControlProjectState"
  >;

  constructor(
    store: Pick<
      MissionControlProjectRepository,
      "getMissionControlProjectState" | "updateMissionControlProjectState"
    >,
  ) {
    this.store = store;
  }

  async getProject(projectIdValue: unknown): Promise<MissionControlProjectStateRecord> {
    const projectId = requireMissionControlProjectId(projectIdValue);
    const current = await this.store.getMissionControlProjectState(projectId);
    if (current !== null) {
      return current;
    }
    const timestamp = new Date(0).toISOString();
    return {
      projectId,
      schemaVersion: MISSION_CONTROL_PROJECT_SCHEMA_VERSION,
      revision: 0,
      authorityEpoch: MISSION_CONTROL_AUTHORITY_EPOCH,
      document: createEmptyMissionControlProjectDocument(projectId),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async execute(actionValue: unknown): Promise<MissionControlProjectMutationResult> {
    const action = parseMissionControlProjectAction(actionValue);
    return this.store.updateMissionControlProjectState({
      projectId: action.projectId,
      actionId: action.actionId,
      requestFingerprint: fingerprintMissionControlProjectAction(action),
      expectedRevision: action.expectedRevision,
      apply: (current) => reduceMissionControlProjectAction(current, action),
    });
  }
}

export function createEmptyMissionControlProjectDocument(
  projectIdValue: unknown,
): MissionControlProjectDocument {
  const projectId = requireMissionControlProjectId(projectIdValue);
  return {
    schemaVersion: MISSION_CONTROL_PROJECT_SCHEMA_VERSION,
    projectId,
    autopilot: {
      enabled: false,
      wipLimit: 1,
    },
    items: {},
    history: [],
  };
}

export function parseMissionControlProjectAction(
  value: unknown,
): MissionControlProjectAction {
  const record = requireRecord(value, "Mission Control action");
  const type = requireString(record.type, "type");
  const base = {
    projectId: requireMissionControlProjectId(record.projectId),
    actionId: requireMissionControlActionId(record.actionId),
    actionTs: requireTimestamp(record.actionTs, "actionTs"),
    expectedRevision: requireMissionControlExpectedRevision(
      record.expectedRevision,
    ),
  };

  switch (type) {
    case "item.create":
      assertAllowedKeys(record, [
        "type",
        "projectId",
        "actionId",
        "actionTs",
        "expectedRevision",
        "itemId",
        "title",
        "instructions",
        "createdBy",
        "completionContract",
        "order",
      ]);
      return {
        ...base,
        type,
        itemId: requireBoundedString(record.itemId, "itemId", 256),
        title: requireBoundedString(record.title, "title", 512),
        instructions: requireBoundedString(record.instructions, "instructions", 32_000),
        createdBy: requireWorkCreator(record.createdBy),
        ...(record.completionContract === undefined
          ? {}
          : {
              completionContract: parseMissionControlCompletionContract(
                record.completionContract,
              ),
            }),
        order: requireNonNegativeInteger(record.order, "order"),
      };
    case "item.approve":
    case "item.return_to_ready":
    case "item.discard":
    case "item.restore":
      assertAllowedKeys(record, [
        "type",
        "projectId",
        "actionId",
        "actionTs",
        "expectedRevision",
        "itemId",
        "expectedItemVersion",
      ]);
      return {
        ...base,
        type,
        itemId: requireBoundedString(record.itemId, "itemId", 256),
        expectedItemVersion: requirePositiveInteger(
          record.expectedItemVersion,
          "expectedItemVersion",
        ),
      };
    case "item.reorder":
      assertAllowedKeys(record, [
        "type",
        "projectId",
        "actionId",
        "actionTs",
        "expectedRevision",
        "itemId",
        "expectedItemVersion",
        "targetPhase",
        "order",
      ]);
      return {
        ...base,
        type,
        itemId: requireBoundedString(record.itemId, "itemId", 256),
        expectedItemVersion: requirePositiveInteger(
          record.expectedItemVersion,
          "expectedItemVersion",
        ),
        targetPhase: requireWorkPhase(record.targetPhase),
        order: requireNonNegativeInteger(record.order, "order"),
      };
    case "autopilot.configure":
      assertAllowedKeys(record, [
        "type",
        "projectId",
        "actionId",
        "actionTs",
        "expectedRevision",
        "enabled",
        "wipLimit",
        "confirmedAt",
      ]);
      return {
        ...base,
        type,
        enabled: requireBoolean(record.enabled, "enabled"),
        wipLimit: requirePositiveInteger(record.wipLimit, "wipLimit"),
        ...(record.confirmedAt === undefined
          ? {}
          : { confirmedAt: requireTimestamp(record.confirmedAt, "confirmedAt") }),
      };
    default:
      throw new Error(`Unsupported Mission Control action type: ${type}.`);
  }
}

export function parseMissionControlProjectDocument(
  value: unknown,
  expectedProjectIdValue: unknown,
): MissionControlProjectDocument {
  const expectedProjectId = requireMissionControlProjectId(expectedProjectIdValue);
  const record = requireRecord(value, "Mission Control project document");
  assertAllowedKeys(record, [
    "schemaVersion",
    "projectId",
    "autopilot",
    "items",
    "history",
    "migration",
  ]);
  if (record.schemaVersion !== MISSION_CONTROL_PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Mission Control project schema version: ${String(record.schemaVersion)}.`,
    );
  }
  const projectId = requireMissionControlProjectId(record.projectId);
  if (projectId !== expectedProjectId) {
    throw new Error(
      `Mission Control document project mismatch: expected=${expectedProjectId} actual=${projectId}.`,
    );
  }
  const autopilotRecord = requireRecord(record.autopilot, "autopilot");
  assertAllowedKeys(autopilotRecord, [
    "enabled",
    "wipLimit",
    "confirmedAt",
  ]);
  const itemsRecord = requireRecord(record.items, "items");
  const items = Object.fromEntries(
    Object.entries(itemsRecord).map(([itemId, item]) => [
      itemId,
      parseWorkItem(item, itemId, projectId),
    ]),
  );
  if (Array.isArray(record.history) === false) {
    throw new Error("history must be an array.");
  }
  const history = record.history.map((entry, index) =>
    parseHistoryEntry(entry, index),
  );
  return {
    schemaVersion: MISSION_CONTROL_PROJECT_SCHEMA_VERSION,
    projectId,
    autopilot: {
      enabled: requireBoolean(autopilotRecord.enabled, "autopilot.enabled"),
      wipLimit: requirePositiveInteger(
        autopilotRecord.wipLimit,
        "autopilot.wipLimit",
      ),
      ...(autopilotRecord.confirmedAt === undefined
        ? {}
        : {
            confirmedAt: requireTimestamp(
              autopilotRecord.confirmedAt,
              "autopilot.confirmedAt",
            ),
          }),
    },
    items,
    history,
    ...(record.migration === undefined
      ? {}
      : { migration: parseMissionControlMigrationState(record.migration) }),
  };
}

export function parseMissionControlProjectStateRecord(
  value: unknown,
): MissionControlProjectStateRecord {
  const record = requireRecord(value, "Mission Control project state");
  assertAllowedKeys(record, [
    "projectId",
    "schemaVersion",
    "revision",
    "authorityEpoch",
    "document",
    "createdAt",
    "updatedAt",
  ]);
  const projectId = requireMissionControlProjectId(record.projectId);
  if (record.schemaVersion !== MISSION_CONTROL_PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Mission Control project schema version: ${String(record.schemaVersion)}.`,
    );
  }
  return {
    projectId,
    schemaVersion: MISSION_CONTROL_PROJECT_SCHEMA_VERSION,
    revision: requireNonNegativeInteger(record.revision, "revision"),
    authorityEpoch: requirePositiveInteger(
      record.authorityEpoch,
      "authorityEpoch",
    ),
    document: parseMissionControlProjectDocument(record.document, projectId),
    createdAt: requireTimestamp(record.createdAt, "createdAt"),
    updatedAt: requireTimestamp(record.updatedAt, "updatedAt"),
  };
}

export function parseMissionControlPersistedMutationResult(
  value: unknown,
): MissionControlPersistedMutationResult {
  const record = requireRecord(value, "Mission Control mutation result");
  assertAllowedKeys(record, ["project", "effects"]);
  if (Array.isArray(record.effects) === false) {
    throw new Error("Mission Control mutation effects must be an array.");
  }
  return {
    project: parseMissionControlProjectStateRecord(record.project),
    effects: record.effects.map((effect, index) =>
      parseMissionControlOutboxRecord(effect, index),
    ),
  };
}

export function reduceMissionControlProjectAction(
  currentValue: MissionControlProjectDocument,
  action: MissionControlProjectAction,
): {
  document: MissionControlProjectDocument;
  effects: MissionControlOutboxIntent[];
} {
  const current = parseMissionControlProjectDocument(
    currentValue,
    action.projectId,
  );
  const nextRevision = action.expectedRevision + 1;

  switch (action.type) {
    case "item.create": {
      if (current.items[action.itemId] !== undefined) {
        throw new MissionControlTransitionError(
          `Mission Control item already exists: ${action.itemId}.`,
        );
      }
      const item: MissionControlWorkItem = {
        id: action.itemId,
        title: action.title,
        instructions: action.instructions,
        createdBy: action.createdBy,
        ...(action.completionContract === undefined
          ? {}
          : { completionContract: action.completionContract }),
        phase: action.createdBy === "agent" ? "proposed" : "ready",
        order: action.order,
        attempts: [],
        reviewBundles: [],
        reviewDecisions: [],
        version: 1,
        createdAt: action.actionTs,
        updatedAt: action.actionTs,
      };
      return {
        document: appendHistory(
          replaceWorkItem(current, item),
          action,
          nextRevision,
        ),
        effects: [],
      };
    }
    case "item.approve": {
      const item = requireVersionedItem(current, action);
      if (item.phase !== "proposed") {
        throw new MissionControlTransitionError(
          "Only a Proposed Mission Control item can be approved.",
        );
      }
      return {
        document: appendHistory(
          replaceWorkItem(current, {
            ...item,
            phase: "ready",
            version: item.version + 1,
            updatedAt: action.actionTs,
          }),
          action,
          nextRevision,
        ),
        effects: [],
      };
    }
    case "item.reorder": {
      const item = requireVersionedItem(current, action);
      if (action.targetPhase !== item.phase) {
        throw new MissionControlTransitionError(
          "Mission Control items may be reordered only within their current phase; lifecycle changes require an explicit action.",
        );
      }
      return {
        document: appendHistory(
          replaceWorkItem(current, {
            ...item,
            order: action.order,
            version: item.version + 1,
            updatedAt: action.actionTs,
          }),
          action,
          nextRevision,
        ),
        effects: [],
      };
    }
    case "item.return_to_ready": {
      const item = requireVersionedItem(current, action);
      if (item.phase !== "needs_attention") {
        throw new MissionControlTransitionError(
          "Only a Needs attention Mission Control item can return to Ready.",
        );
      }
      return {
        document: appendHistory(
          replaceWorkItem(current, {
            ...item,
            phase: "ready",
            version: item.version + 1,
            updatedAt: action.actionTs,
          }),
          action,
          nextRevision,
        ),
        effects: [],
      };
    }
    case "item.discard": {
      const item = requireVersionedItem(current, action);
      if (
        item.phase !== "proposed" &&
        item.phase !== "ready" &&
        item.phase !== "needs_attention"
      ) {
        throw new MissionControlTransitionError(
          "Only Proposed, Ready, or Needs attention work can be discarded.",
        );
      }
      return {
        document: appendHistory(
          replaceWorkItem(current, {
            ...item,
            phase: "discarded",
            version: item.version + 1,
            updatedAt: action.actionTs,
          }),
          action,
          nextRevision,
        ),
        effects: [],
      };
    }
    case "item.restore": {
      const item = requireVersionedItem(current, action);
      if (item.phase !== "discarded") {
        throw new MissionControlTransitionError(
          "Only discarded Mission Control work can be restored.",
        );
      }
      return {
        document: appendHistory(
          replaceWorkItem(current, {
            ...item,
            phase: "ready",
            version: item.version + 1,
            updatedAt: action.actionTs,
          }),
          action,
          nextRevision,
        ),
        effects: [],
      };
    }
    case "autopilot.configure": {
      if (action.enabled && action.confirmedAt === undefined) {
        throw new MissionControlTransitionError(
          "Enabling Mission Control Autopilot requires explicit confirmation.",
        );
      }
      return {
        document: appendHistory(
          {
            ...current,
            autopilot: {
              enabled: action.enabled,
              wipLimit: action.wipLimit,
              ...(action.confirmedAt === undefined
                ? {}
                : { confirmedAt: action.confirmedAt }),
            },
          },
          action,
          nextRevision,
        ),
        effects: [],
      };
    }
  }
}

export function fingerprintMissionControlProjectAction(
  action: MissionControlProjectAction,
): string {
  return createHash("sha256")
    .update(stableJson(action))
    .digest("hex");
}

export function requireMissionControlProjectId(value: unknown): string {
  if (
    typeof value !== "string" ||
    PROJECT_UUID_V4_PATTERN.test(value) === false
  ) {
    throw new Error("Mission Control projectId must be a version-4 UUID.");
  }
  return value.toLowerCase();
}

export function requireMissionControlActionId(value: unknown): string {
  return requireBoundedString(value, "actionId", 256);
}

export function requireMissionControlRequestFingerprint(value: unknown): string {
  if (
    typeof value !== "string" ||
    /^[0-9a-f]{64}$/u.test(value) === false
  ) {
    throw new Error(
      "Mission Control requestFingerprint must be a lowercase SHA-256 digest.",
    );
  }
  return value;
}

export function requireMissionControlExpectedRevision(value: unknown): number {
  return requireNonNegativeInteger(value, "expectedRevision");
}

export function assertMissionControlExpectedRevision(
  actualRevision: number,
  expectedRevision: number,
): void {
  if (actualRevision !== expectedRevision) {
    throw new MissionControlRevisionConflictError(
      expectedRevision,
      actualRevision,
    );
  }
}

export function assertMissionControlReceiptFingerprint(
  actionId: string,
  actualFingerprint: string,
  expectedFingerprint: string,
): void {
  if (actualFingerprint !== expectedFingerprint) {
    throw new MissionControlActionIdentityConflictError(actionId);
  }
}

function requireVersionedItem(
  current: MissionControlProjectDocument,
  action: Extract<
    MissionControlProjectAction,
    { expectedItemVersion: number }
  >,
): MissionControlWorkItem {
  const item = current.items[action.itemId];
  if (item === undefined) {
    throw new MissionControlTransitionError(
      `Mission Control item not found: ${action.itemId}.`,
    );
  }
  if (action.expectedItemVersion !== item.version) {
    throw new MissionControlItemVersionConflictError(
      item.id,
      action.expectedItemVersion,
      item.version,
    );
  }
  return item;
}

function replaceWorkItem(
  current: MissionControlProjectDocument,
  item: MissionControlWorkItem,
): MissionControlProjectDocument {
  return {
    ...current,
    items: {
      ...current.items,
      [item.id]: item,
    },
  };
}

function appendHistory(
  current: MissionControlProjectDocument,
  action: MissionControlProjectAction,
  revision: number,
): MissionControlProjectDocument {
  return {
    ...current,
    history: [
      ...current.history,
      {
        actionId: action.actionId,
        actionType: action.type,
        revision,
        timestamp: action.actionTs,
        ...("itemId" in action ? { itemId: action.itemId } : {}),
      },
    ],
  };
}

function parseWorkItem(
  value: unknown,
  itemKey: string,
  projectId: string,
): MissionControlWorkItem {
  const record = requireRecord(value, `items.${itemKey}`);
  assertAllowedKeys(record, [
    "id",
    "title",
    "instructions",
    "createdBy",
    "completionContract",
    "phase",
    "order",
    "attempts",
    "currentAttemptId",
    "attentionReason",
    "reviewBundles",
    "currentReviewBundleId",
    "reviewDecisions",
    "version",
    "createdAt",
    "updatedAt",
  ]);
  const id = requireBoundedString(record.id, `items.${itemKey}.id`, 256);
  if (id !== itemKey) {
    throw new Error(`Mission Control item key mismatch: ${itemKey} != ${id}.`);
  }
  if (record.attempts !== undefined && Array.isArray(record.attempts) === false) {
    throw new Error(`items.${itemKey}.attempts must be an array.`);
  }
  const attempts = (record.attempts ?? []).map((attempt, index) =>
    parseExecutionAttempt(attempt, itemKey, index),
  );
  if (
    record.reviewBundles !== undefined &&
    Array.isArray(record.reviewBundles) === false
  ) {
    throw new Error(`items.${itemKey}.reviewBundles must be an array.`);
  }
  const reviewBundles = (record.reviewBundles ?? []).map((bundle, index) =>
    parseMissionControlReviewBundle(
      bundle,
      `items.${itemKey}.reviewBundles.${index}`,
    ),
  );
  if (
    record.reviewDecisions !== undefined &&
    Array.isArray(record.reviewDecisions) === false
  ) {
    throw new Error(`items.${itemKey}.reviewDecisions must be an array.`);
  }
  const reviewDecisions = (record.reviewDecisions ?? []).map((decision, index) =>
    parseMissionControlReviewDecision(
      decision,
      `items.${itemKey}.reviewDecisions.${index}`,
    ),
  );
  const currentAttemptId =
    record.currentAttemptId === undefined
      ? undefined
      : requireBoundedString(
          record.currentAttemptId,
          `items.${itemKey}.currentAttemptId`,
          256,
        );
  if (
    currentAttemptId !== undefined &&
    attempts.some((attempt) => attempt.id === currentAttemptId) === false
  ) {
    throw new Error(
      `items.${itemKey}.currentAttemptId must identify a persisted attempt.`,
    );
  }
  for (const bundle of reviewBundles) {
    if (bundle.projectId !== projectId || bundle.itemId !== itemKey) {
      throw new Error(
        `items.${itemKey}.reviewBundles must remain project and item scoped.`,
      );
    }
    const attempt = attempts.find((candidate) => candidate.id === bundle.attemptId);
    const execution = bundle.evidence.find(
      (evidence) => evidence.kind === "execution",
    );
    const run =
      attempt === undefined || execution?.kind !== "execution"
        ? undefined
        : attempt.runs.find(
            (candidate) =>
              candidate.sessionId === execution.sessionId &&
              candidate.threadId === execution.threadId &&
              candidate.runId === execution.runId &&
              candidate.commandId === execution.referenceId,
          );
    if (attempt === undefined || run === undefined) {
      throw new Error(
        `items.${itemKey}.reviewBundles must identify an exact persisted attempt run.`,
      );
    }
  }
  for (const decision of reviewDecisions) {
    const bundle = reviewBundles.find(
      (candidate) => candidate.id === decision.bundleId,
    );
    if (
      decision.projectId !== projectId ||
      decision.itemId !== itemKey ||
      bundle === undefined ||
      decision.attemptId !== bundle.attemptId ||
      decision.candidateFingerprint !== bundle.candidate.candidateFingerprint
    ) {
      throw new Error(
        `items.${itemKey}.reviewDecisions must identify an exact persisted Review bundle.`,
      );
    }
  }
  const currentReviewBundleId =
    record.currentReviewBundleId === undefined
      ? undefined
      : requireBoundedString(
          record.currentReviewBundleId,
          `items.${itemKey}.currentReviewBundleId`,
          80,
        );
  if (
    currentReviewBundleId !== undefined &&
    reviewBundles.some((bundle) => bundle.id === currentReviewBundleId) === false
  ) {
    throw new Error(
      `items.${itemKey}.currentReviewBundleId must identify a persisted bundle.`,
    );
  }
  return {
    id,
    title: requireBoundedString(record.title, `items.${itemKey}.title`, 512),
    instructions: requireBoundedString(
      record.instructions,
      `items.${itemKey}.instructions`,
      32_000,
    ),
    createdBy: requireWorkCreator(record.createdBy),
    ...(record.completionContract === undefined
      ? {}
      : {
          completionContract: parseMissionControlCompletionContract(
            record.completionContract,
            `items.${itemKey}.completionContract`,
          ),
        }),
    phase: requireWorkPhase(record.phase),
    order: requireNonNegativeInteger(record.order, `items.${itemKey}.order`),
    attempts,
    ...(currentAttemptId === undefined ? {} : { currentAttemptId }),
    ...(record.attentionReason === undefined
      ? {}
      : {
          attentionReason: requireAttentionReason(
            record.attentionReason,
            `items.${itemKey}.attentionReason`,
          ),
        }),
    reviewBundles,
    ...(currentReviewBundleId === undefined
      ? {}
      : { currentReviewBundleId }),
    reviewDecisions,
    version: requirePositiveInteger(record.version, `items.${itemKey}.version`),
    createdAt: requireTimestamp(record.createdAt, `items.${itemKey}.createdAt`),
    updatedAt: requireTimestamp(record.updatedAt, `items.${itemKey}.updatedAt`),
  };
}

function parseHistoryEntry(
  value: unknown,
  index: number,
): MissionControlHistoryEntry {
  const record = requireRecord(value, `history.${index}`);
  assertAllowedKeys(record, [
    "actionId",
    "actionType",
    "revision",
    "timestamp",
    "itemId",
    "attemptId",
    "disposition",
  ]);
  const actionType = requireString(record.actionType, `history.${index}.actionType`);
  const parsedActionType = requireHistoryActionType(actionType);
  return {
    actionId: requireBoundedString(
      record.actionId,
      `history.${index}.actionId`,
      256,
    ),
    actionType: parsedActionType,
    revision: requirePositiveInteger(
      record.revision,
      `history.${index}.revision`,
    ),
    timestamp: requireTimestamp(
      record.timestamp,
      `history.${index}.timestamp`,
    ),
    ...(record.itemId === undefined
      ? {}
      : {
          itemId: requireBoundedString(
            record.itemId,
            `history.${index}.itemId`,
            256,
          ),
        }),
    ...(record.attemptId === undefined
      ? {}
      : {
          attemptId: requireBoundedString(
            record.attemptId,
            `history.${index}.attemptId`,
            256,
          ),
        }),
    ...(record.disposition === undefined
      ? {}
      : {
          disposition: requireHistoryDisposition(
            record.disposition,
            `history.${index}.disposition`,
          ),
        }),
  };
}

function parseExecutionAttempt(
  value: unknown,
  itemId: string,
  index: number,
): MissionControlExecutionAttempt {
  const field = `items.${itemId}.attempts.${index}`;
  const record = requireRecord(value, field);
  assertAllowedKeys(record, [
    "id",
    "generation",
    "initiatedBy",
    "status",
    "version",
    "profileId",
    "requestedSessionId",
    "requestedThreadId",
    "dispatchCommandId",
    "dispatchRunId",
    "runs",
    "currentRunId",
    "pendingRequest",
    "pendingResponse",
    "terminalReason",
    "terminalReasonCode",
    "createdAt",
    "updatedAt",
  ]);
  if (Array.isArray(record.runs) === false) {
    throw new Error(`${field}.runs must be an array.`);
  }
  const runs = record.runs.map((run, runIndex) =>
    parseAttemptRun(run, `${field}.runs.${runIndex}`),
  );
  const currentRunId =
    record.currentRunId === undefined
      ? undefined
      : requireBoundedString(record.currentRunId, `${field}.currentRunId`, 256);
  if (
    currentRunId !== undefined &&
    runs.some((run) => run.runId === currentRunId) === false
  ) {
    throw new Error(`${field}.currentRunId must identify an accepted run.`);
  }
  return {
    id: requireBoundedString(record.id, `${field}.id`, 256),
    generation: requirePositiveInteger(record.generation, `${field}.generation`),
    initiatedBy: requireAttemptInitiator(record.initiatedBy, `${field}.initiatedBy`),
    status: requireAttemptStatus(record.status, `${field}.status`),
    version: requirePositiveInteger(record.version, `${field}.version`),
    profileId: requireBoundedString(record.profileId, `${field}.profileId`, 256),
    requestedSessionId: requireBoundedString(
      record.requestedSessionId,
      `${field}.requestedSessionId`,
      256,
    ),
    requestedThreadId: requireBoundedString(
      record.requestedThreadId,
      `${field}.requestedThreadId`,
      256,
    ),
    dispatchCommandId: requireBoundedString(
      record.dispatchCommandId,
      `${field}.dispatchCommandId`,
      256,
    ),
    dispatchRunId: requireBoundedString(
      record.dispatchRunId,
      `${field}.dispatchRunId`,
      256,
    ),
    runs,
    ...(currentRunId === undefined ? {} : { currentRunId }),
    ...(record.pendingRequest === undefined
      ? {}
      : {
          pendingRequest: parsePendingRequest(
            record.pendingRequest,
            `${field}.pendingRequest`,
          ),
        }),
    ...(record.pendingResponse === undefined
      ? {}
      : {
          pendingResponse: parsePendingResponse(
            record.pendingResponse,
            `${field}.pendingResponse`,
          ),
        }),
    ...(record.terminalReason === undefined
      ? {}
      : {
          terminalReason: requireBoundedString(
            record.terminalReason,
            `${field}.terminalReason`,
            32_000,
          ),
        }),
    ...(record.terminalReasonCode === undefined
      ? {}
      : {
          terminalReasonCode: requireBoundedString(
            record.terminalReasonCode,
            `${field}.terminalReasonCode`,
            256,
          ),
        }),
    createdAt: requireTimestamp(record.createdAt, `${field}.createdAt`),
    updatedAt: requireTimestamp(record.updatedAt, `${field}.updatedAt`),
  };
}

function parseAttemptRun(
  value: unknown,
  field: string,
): MissionControlAttemptRun {
  const record = requireRecord(value, field);
  assertAllowedKeys(record, [
    "sessionId",
    "threadId",
    "runId",
    "commandId",
    "acceptedAt",
  ]);
  return {
    sessionId: requireBoundedString(record.sessionId, `${field}.sessionId`, 256),
    threadId: requireBoundedString(record.threadId, `${field}.threadId`, 256),
    runId: requireBoundedString(record.runId, `${field}.runId`, 256),
    commandId: requireBoundedString(record.commandId, `${field}.commandId`, 256),
    acceptedAt: requireTimestamp(record.acceptedAt, `${field}.acceptedAt`),
  };
}

function parsePendingRequest(
  value: unknown,
  field: string,
): MissionControlPendingRequest {
  const record = requireRecord(value, field);
  assertAllowedKeys(record, [
    "requestId",
    "threadId",
    "kind",
    "eventType",
    "enteredAt",
  ]);
  return {
    requestId: requireBoundedString(record.requestId, `${field}.requestId`, 256),
    threadId: requireBoundedString(record.threadId, `${field}.threadId`, 256),
    kind: requirePendingRequestKind(record.kind, `${field}.kind`),
    ...(record.eventType === undefined
      ? {}
      : {
          eventType: requireBoundedString(
            record.eventType,
            `${field}.eventType`,
            256,
          ),
        }),
    ...(record.enteredAt === undefined
      ? {}
      : { enteredAt: requireTimestamp(record.enteredAt, `${field}.enteredAt`) }),
  };
}

function parsePendingResponse(
  value: unknown,
  field: string,
): NonNullable<MissionControlExecutionAttempt["pendingResponse"]> {
  const record = requireRecord(value, field);
  assertAllowedKeys(record, ["requestId", "commandId", "runId"]);
  return {
    requestId: requireBoundedString(record.requestId, `${field}.requestId`, 256),
    commandId: requireBoundedString(record.commandId, `${field}.commandId`, 256),
    runId: requireBoundedString(record.runId, `${field}.runId`, 256),
  };
}

function parseMissionControlOutboxRecord(
  value: unknown,
  index: number,
): MissionControlOutboxRecord {
  const record = requireRecord(value, `effects.${index}`);
  assertAllowedKeys(record, [
    "id",
    "projectId",
    "actionId",
    "effectId",
    "effectType",
    "payload",
    "status",
    "attemptCount",
    "lastError",
    "createdAt",
  ]);
  if (
    record.status !== "PENDING" &&
    record.status !== "DELIVERED" &&
    record.status !== "FAILED"
  ) {
    throw new Error(`effects.${index}.status is invalid.`);
  }
  return {
    id: requirePositiveInteger(record.id, `effects.${index}.id`),
    projectId: requireMissionControlProjectId(record.projectId),
    actionId: requireBoundedString(
      record.actionId,
      `effects.${index}.actionId`,
      256,
    ),
    effectId: requireBoundedString(
      record.effectId,
      `effects.${index}.effectId`,
      256,
    ),
    effectType: requireBoundedString(
      record.effectType,
      `effects.${index}.effectType`,
      256,
    ),
    payload: requireRecord(record.payload, `effects.${index}.payload`),
    status: record.status,
    attemptCount: requireNonNegativeInteger(
      record.attemptCount,
      `effects.${index}.attemptCount`,
    ),
    ...(record.lastError === undefined
      ? {}
      : {
          lastError: requireBoundedString(
            record.lastError,
            `effects.${index}.lastError`,
            32_000,
          ),
        }),
    createdAt: requireTimestamp(record.createdAt, `effects.${index}.createdAt`),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  const text = requireString(value, field).trim();
  if (text.length === 0 || text.length > maximumLength) {
    throw new Error(
      `${field} must contain 1 to ${maximumLength} non-whitespace characters.`,
    );
  }
  return text;
}

function requireTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    Number.isSafeInteger(value) === false ||
    value < 0
  ) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const result = requireNonNegativeInteger(value, field);
  if (result === 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return result;
}

function requireWorkCreator(value: unknown): MissionControlWorkCreator {
  if (value !== "operator" && value !== "agent") {
    throw new Error("createdBy must be operator or agent.");
  }
  return value;
}

function requireWorkPhase(value: unknown): MissionControlWorkPhase {
  if (
    value !== "proposed" &&
    value !== "ready" &&
    value !== "active" &&
    value !== "needs_attention" &&
    value !== "review" &&
    value !== "done" &&
    value !== "discarded"
  ) {
    throw new Error("targetPhase must be a supported Mission Control phase.");
  }
  return value;
}

function requireAttemptInitiator(
  value: unknown,
  field: string,
): MissionControlExecutionAttempt["initiatedBy"] {
  if (value !== "operator" && value !== "autopilot") {
    throw new Error(`${field} must be operator or autopilot.`);
  }
  return value;
}

function requireAttemptStatus(
  value: unknown,
  field: string,
): MissionControlAttemptStatus {
  if (
    value !== "starting" &&
    value !== "running" &&
    value !== "waiting" &&
    value !== "cancelling" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled" &&
    value !== "orphaned"
  ) {
    throw new Error(`${field} must be a supported attempt status.`);
  }
  return value;
}

function requireAttentionReason(
  value: unknown,
  field: string,
): MissionControlAttentionReason {
  if (
    value !== "start_rejected" &&
    value !== "execution_failed" &&
    value !== "operator_stopped" &&
    value !== "runner_orphaned" &&
    value !== "runtime_authority_changed"
  ) {
    throw new Error(`${field} must be a supported attention reason.`);
  }
  return value;
}

function requirePendingRequestKind(
  value: unknown,
  field: string,
): MissionControlPendingRequest["kind"] {
  if (
    value !== "approval" &&
    value !== "user_input" &&
    value !== "delegation" &&
    value !== "scheduler_wait" &&
    value !== "compaction_checkpoint" &&
    value !== "unknown"
  ) {
    throw new Error(`${field} must be a supported pending request kind.`);
  }
  return value;
}

function requireHistoryActionType(value: string): MissionControlHistoryActionType {
  if (
    value !== "item.create" &&
    value !== "item.approve" &&
    value !== "item.reorder" &&
    value !== "item.return_to_ready" &&
    value !== "item.discard" &&
    value !== "item.restore" &&
    value !== "autopilot.configure" &&
    value !== "execution.start" &&
    value !== "execution.accepted" &&
    value !== "execution.start_rejected" &&
    value !== "execution.waiting" &&
    value !== "execution.reply" &&
    value !== "execution.resumed" &&
    value !== "execution.stop" &&
    value !== "execution.stop_rejected" &&
    value !== "execution.cancel_confirmed" &&
    value !== "execution.failed" &&
    value !== "execution.orphaned" &&
    value !== "execution.completed" &&
    value !== "execution.retry" &&
    value !== "review.admit" &&
    value !== "review.accept" &&
    value !== "review.request_changes" &&
    value !== "migration.stage" &&
    value !== "migration.rebind" &&
    value !== "migration.resolve" &&
    value !== "migration.clear" &&
    value !== "authority.activate" &&
    value !== "authority.rollback"
  ) {
    throw new Error(`Unsupported Mission Control history action: ${value}.`);
  }
  return value;
}

function requireHistoryDisposition(
  value: unknown,
  field: string,
): NonNullable<MissionControlHistoryEntry["disposition"]> {
  if (value !== "applied" && value !== "stale" && value !== "noop") {
    throw new Error(`${field} must be applied, stale, or noop.`);
  }
  return value;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: string[],
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).filter((key) => allowed.has(key) === false);
  if (unexpected.length > 0) {
    throw new Error(`Unexpected Mission Control fields: ${unexpected.sort().join(", ")}.`);
  }
}
