import { createHash } from "node:crypto";

import type { MissionControlProjectRepository } from "../kestrel/contracts/store.js";
import {
  MissionControlItemVersionConflictError,
  MissionControlProjectService,
  MissionControlTransitionError,
  type MissionControlAttentionReason,
  type MissionControlExecutionAttempt,
  type MissionControlHistoryEntry,
  type MissionControlOutboxIntent,
  type MissionControlPendingRequest,
  type MissionControlProjectDocument,
  type MissionControlProjectMutationResult,
  type MissionControlWorkItem,
  parseMissionControlProjectDocument,
  requireMissionControlActionId,
  requireMissionControlExpectedRevision,
  requireMissionControlProjectId,
} from "./projectAuthority.js";

interface ExecutionActionBase {
  projectId: string;
  actionId: string;
  actionTs: string;
  expectedRevision: number;
  itemId: string;
  expectedItemVersion: number;
}

interface AttemptActionBase extends ExecutionActionBase {
  attemptId: string;
  expectedAttemptVersion: number;
}

export type MissionControlExecutionAction =
  | (ExecutionActionBase & {
      type: "execution.start";
      attemptId: string;
      initiatedBy: "operator" | "autopilot";
      profileId: string;
      sessionId: string;
      threadId: string;
    })
  | (AttemptActionBase & {
      type: "execution.accepted";
      sessionId: string;
      threadId: string;
      runId: string;
      commandId: string;
    })
  | (AttemptActionBase & {
      type: "execution.start_rejected";
      reason: string;
      reasonCode?: string | undefined;
    })
  | (AttemptActionBase & {
      type: "execution.waiting";
      runId: string;
      request: MissionControlPendingRequest;
    })
  | (AttemptActionBase & {
      type: "execution.reply";
      requestId: string;
      message: string;
    })
  | (AttemptActionBase & {
      type: "execution.resumed";
      requestId: string;
      sessionId: string;
      threadId: string;
      runId: string;
      commandId: string;
    })
  | (AttemptActionBase & {
      type: "execution.stop";
      runId: string;
      commandId: string;
    })
  | (AttemptActionBase & {
      type: "execution.stop_rejected";
      outcome: "already_stopped" | "run_changed" | "finalizing";
      activeRunId?: string | undefined;
      activeCommandId?: string | undefined;
    })
  | (AttemptActionBase & {
      type: "execution.cancel_confirmed";
      runId: string;
      outcome: "cancelled" | "already_stopped";
    })
  | (AttemptActionBase & {
      type: "execution.failed";
      runId?: string | undefined;
      reason: string;
      reasonCode?: string | undefined;
    })
  | (AttemptActionBase & {
      type: "execution.orphaned";
      runId?: string | undefined;
      reason: string;
      reasonCode?: string | undefined;
    })
  | (AttemptActionBase & {
      type: "execution.completed";
      runId: string;
    })
  | (ExecutionActionBase & {
      type: "execution.retry";
      attemptId: string;
    });

export class MissionControlAttemptVersionConflictError extends Error {
  readonly code = "MISSION_CONTROL_ATTEMPT_VERSION_CONFLICT";

  constructor(attemptId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Mission Control attempt ${attemptId} version conflict: expected=${expectedVersion} actual=${actualVersion}.`,
    );
    this.name = "MissionControlAttemptVersionConflictError";
  }
}

export class MissionControlExecutionService {
  private readonly store: Pick<
    MissionControlProjectRepository,
    "getMissionControlProjectState" | "updateMissionControlProjectState"
  >;
  readonly projects: MissionControlProjectService;

  constructor(
    store: Pick<
      MissionControlProjectRepository,
      "getMissionControlProjectState" | "updateMissionControlProjectState"
    >,
  ) {
    this.store = store;
    this.projects = new MissionControlProjectService(store);
  }

  async execute(
    actionValue: unknown,
  ): Promise<MissionControlProjectMutationResult> {
    const action = parseMissionControlExecutionAction(actionValue);
    return this.store.updateMissionControlProjectState({
      projectId: action.projectId,
      actionId: action.actionId,
      requestFingerprint: fingerprint(action),
      expectedRevision: action.expectedRevision,
      apply: (current) => reduceMissionControlExecutionAction(current, action),
    });
  }
}

export function parseMissionControlExecutionAction(
  value: unknown,
): MissionControlExecutionAction {
  const record = requireRecord(value, "Mission Control execution action");
  const type = requireText(record.type, "type", 128);
  const base = {
    projectId: requireMissionControlProjectId(record.projectId),
    actionId: requireMissionControlActionId(record.actionId),
    actionTs: requireTimestamp(record.actionTs, "actionTs"),
    expectedRevision: requireMissionControlExpectedRevision(
      record.expectedRevision,
    ),
    itemId: requireText(record.itemId, "itemId", 256),
    expectedItemVersion: requirePositiveInteger(
      record.expectedItemVersion,
      "expectedItemVersion",
    ),
  };

  switch (type) {
    case "execution.start":
      assertKeys(record, [
        ...BASE_KEYS,
        "attemptId",
        "initiatedBy",
        "profileId",
        "sessionId",
        "threadId",
      ]);
      return {
        ...base,
        type,
        attemptId: requireText(record.attemptId, "attemptId", 256),
        initiatedBy: requireInitiator(record.initiatedBy),
        profileId: requireText(record.profileId, "profileId", 256),
        sessionId: requireText(record.sessionId, "sessionId", 256),
        threadId: requireText(record.threadId, "threadId", 256),
      };
    case "execution.accepted":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "sessionId",
        "threadId",
        "runId",
        "commandId",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        sessionId: requireText(record.sessionId, "sessionId", 256),
        threadId: requireText(record.threadId, "threadId", 256),
        runId: requireText(record.runId, "runId", 256),
        commandId: requireText(record.commandId, "commandId", 256),
      };
    case "execution.start_rejected":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "reason",
        "reasonCode",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        reason: requireText(record.reason, "reason", 32_000),
        ...(record.reasonCode === undefined
          ? {}
          : { reasonCode: requireText(record.reasonCode, "reasonCode", 256) }),
      };
    case "execution.waiting":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "runId",
        "request",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        runId: requireText(record.runId, "runId", 256),
        request: parsePendingRequest(record.request),
      };
    case "execution.reply":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "requestId",
        "message",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        requestId: requireText(record.requestId, "requestId", 256),
        message: requireText(record.message, "message", 32_000),
      };
    case "execution.resumed":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "requestId",
        "sessionId",
        "threadId",
        "runId",
        "commandId",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        requestId: requireText(record.requestId, "requestId", 256),
        sessionId: requireText(record.sessionId, "sessionId", 256),
        threadId: requireText(record.threadId, "threadId", 256),
        runId: requireText(record.runId, "runId", 256),
        commandId: requireText(record.commandId, "commandId", 256),
      };
    case "execution.stop":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "runId",
        "commandId",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        runId: requireText(record.runId, "runId", 256),
        commandId: requireText(record.commandId, "commandId", 256),
      };
    case "execution.stop_rejected":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "outcome",
        "activeRunId",
        "activeCommandId",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        outcome: requireStopRejectionOutcome(record.outcome),
        ...(record.activeRunId === undefined
          ? {}
          : { activeRunId: requireText(record.activeRunId, "activeRunId", 256) }),
        ...(record.activeCommandId === undefined
          ? {}
          : {
              activeCommandId: requireText(
                record.activeCommandId,
                "activeCommandId",
                256,
              ),
            }),
      };
    case "execution.cancel_confirmed":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "runId",
        "outcome",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        runId: requireText(record.runId, "runId", 256),
        outcome: requireCancelOutcome(record.outcome),
      };
    case "execution.failed":
    case "execution.orphaned":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "runId",
        "reason",
        "reasonCode",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        ...(record.runId === undefined
          ? {}
          : { runId: requireText(record.runId, "runId", 256) }),
        reason: requireText(record.reason, "reason", 32_000),
        ...(record.reasonCode === undefined
          ? {}
          : { reasonCode: requireText(record.reasonCode, "reasonCode", 256) }),
      };
    case "execution.completed":
      assertKeys(record, [
        ...ATTEMPT_KEYS,
        "runId",
      ]);
      return {
        ...parseAttemptBase(base, record),
        type,
        runId: requireText(record.runId, "runId", 256),
      };
    case "execution.retry":
      assertKeys(record, [...BASE_KEYS, "attemptId"]);
      return {
        ...base,
        type,
        attemptId: requireText(record.attemptId, "attemptId", 256),
      };
    default:
      throw new Error(`Unsupported Mission Control execution action: ${type}.`);
  }
}

export function reduceMissionControlExecutionAction(
  currentValue: MissionControlProjectDocument,
  action: MissionControlExecutionAction,
): {
  document: MissionControlProjectDocument;
  effects: MissionControlOutboxIntent[];
} {
  const current = parseMissionControlProjectDocument(
    currentValue,
    action.projectId,
  );
  const item = requireItem(current, action);
  const revision = action.expectedRevision + 1;

  switch (action.type) {
    case "execution.start": {
      if (item.phase !== "ready") {
        throw new MissionControlTransitionError(
          "Mission Control execution can start only from Ready.",
        );
      }
      if (currentAttempt(item)?.status !== undefined &&
          isActiveAttemptStatus(currentAttempt(item)!.status)) {
        throw new MissionControlTransitionError(
          "Mission Control item already has unresolved execution.",
        );
      }
      if (activeWorkCount(current) >= current.autopilot.wipLimit) {
        throw new MissionControlTransitionError(
          "Mission Control project WIP limit has been reached.",
        );
      }
      if (action.initiatedBy === "autopilot" && current.autopilot.enabled === false) {
        throw new MissionControlTransitionError(
          "Mission Control Autopilot is disabled.",
        );
      }
      if (action.sessionId !== action.threadId) {
        throw new MissionControlTransitionError(
          "A new Mission Control run must use the same initial session and thread identity.",
        );
      }
      requireUniqueAttemptId(item, action.attemptId);
      const dispatchCommandId = effectId(action, "start");
      const attempt: MissionControlExecutionAttempt = {
        id: action.attemptId,
        generation: nextGeneration(item),
        initiatedBy: action.initiatedBy,
        status: "starting",
        version: 1,
        profileId: action.profileId,
        requestedSessionId: action.sessionId,
        requestedThreadId: action.threadId,
        dispatchCommandId,
        dispatchRunId: attemptRunId(action, "start"),
        runs: [],
        createdAt: action.actionTs,
        updatedAt: action.actionTs,
      };
      return changed(current, action, revision, {
        ...item,
        phase: "active",
        attempts: [...item.attempts, attempt],
        currentAttemptId: attempt.id,
        attentionReason: undefined,
        version: item.version + 1,
        updatedAt: action.actionTs,
      }, [{
        effectId: dispatchCommandId,
        effectType: "mission-control.execution.start",
        payload: {
          itemId: item.id,
          attemptId: attempt.id,
          profileId: attempt.profileId,
          sessionId: attempt.requestedSessionId,
          threadId: attempt.requestedThreadId,
          runId: attempt.dispatchRunId,
          message: buildExecutionMessage(item),
          projectRevision: revision,
          workspaceRoot: current.migration?.registeredPath,
        },
      }]);
    }
    case "execution.retry": {
      if (item.phase !== "needs_attention") {
        throw new MissionControlTransitionError(
          "Mission Control retry requires Needs attention.",
        );
      }
      const previous = requireCurrentAttempt(item);
      if (
        previous.status !== "failed" &&
        previous.status !== "orphaned" &&
        previous.status !== "cancelled"
      ) {
        throw new MissionControlTransitionError(
          "Only failed, orphaned, or operator-stopped attempts can be retried.",
        );
      }
      if (activeWorkCount(current) >= current.autopilot.wipLimit) {
        throw new MissionControlTransitionError(
          "Mission Control project WIP limit has been reached.",
        );
      }
      requireUniqueAttemptId(item, action.attemptId);
      const priorRun = currentRun(previous);
      if (priorRun === undefined) {
        throw new MissionControlTransitionError(
          "Mission Control retry requires an authoritative prior thread.",
        );
      }
      const dispatchCommandId = effectId(action, "retry");
      const dispatchRunId = attemptRunId(action, "retry");
      const attempt: MissionControlExecutionAttempt = {
        id: action.attemptId,
        generation: nextGeneration(item),
        initiatedBy: "operator",
        status: "starting",
        version: 1,
        profileId: previous.profileId,
        requestedSessionId: priorRun.sessionId,
        requestedThreadId: priorRun.threadId,
        dispatchCommandId,
        dispatchRunId,
        runs: [],
        createdAt: action.actionTs,
        updatedAt: action.actionTs,
      };
      return changed(current, action, revision, {
        ...item,
        phase: "active",
        attempts: [...item.attempts, attempt],
        currentAttemptId: attempt.id,
        attentionReason: undefined,
        version: item.version + 1,
        updatedAt: action.actionTs,
      }, [{
        effectId: dispatchCommandId,
        effectType: "mission-control.execution.retry",
        payload: {
          itemId: item.id,
          attemptId: attempt.id,
          threadId: priorRun.threadId,
          runId: dispatchRunId,
          message: `Retry Mission Control work item: ${item.title}`,
        },
      }]);
    }
    case "execution.accepted": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        return unchanged(current, action, revision, "stale");
      }
      if (attempt.status !== "starting") {
        return unchanged(current, action, revision, "noop");
      }
      if (
        action.sessionId !== attempt.requestedSessionId ||
        action.threadId !== attempt.requestedThreadId ||
        action.runId !== attempt.dispatchRunId ||
        action.commandId !== attempt.dispatchCommandId
      ) {
        throw new MissionControlTransitionError(
          "Runner acceptance identity does not match the reserved Mission Control attempt.",
        );
      }
      return updateAttempt(current, item, attempt, action, revision, {
        ...attempt,
        status: "running",
        runs: [...attempt.runs, acceptedRun(action)],
        currentRunId: action.runId,
        version: attempt.version + 1,
        updatedAt: action.actionTs,
      });
    }
    case "execution.start_rejected": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        return unchanged(current, action, revision, "stale");
      }
      if (attempt.status !== "starting") {
        return unchanged(current, action, revision, "noop");
      }
      return finishAttempt(current, item, attempt, action, revision, {
        status: "failed",
        attentionReason: "start_rejected",
        reason: action.reason,
        reasonCode: action.reasonCode,
      });
    }
    case "execution.waiting": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        return unchanged(current, action, revision, "stale");
      }
      requireCurrentRun(attempt, action.runId);
      if (attempt.status !== "running" && attempt.status !== "waiting") {
        return unchanged(current, action, revision, "noop");
      }
      if (action.request.threadId !== currentRun(attempt)?.threadId) {
        throw new MissionControlTransitionError(
          "Pending request thread does not match the current Mission Control run.",
        );
      }
      if (
        attempt.status === "waiting" &&
        attempt.pendingResponse === undefined &&
        attempt.pendingRequest !== undefined &&
        pendingRequestsEqual(attempt.pendingRequest, action.request)
      ) {
        return unchanged(current, action, revision, "noop");
      }
      return updateAttempt(current, item, attempt, action, revision, {
        ...attempt,
        status: "waiting",
        pendingRequest: action.request,
        version: attempt.version + 1,
        updatedAt: action.actionTs,
      });
    }
    case "execution.reply": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        return unchanged(current, action, revision, "stale");
      }
      if (
        attempt.status !== "waiting" ||
        attempt.pendingRequest?.requestId !== action.requestId
      ) {
        throw new MissionControlTransitionError(
          "Mission Control reply must target the exact current pending request.",
        );
      }
      const run = currentRun(attempt);
      if (run === undefined || run.threadId !== attempt.pendingRequest.threadId) {
        throw new MissionControlTransitionError(
          "Mission Control pending request has no matching authoritative thread.",
        );
      }
      const commandId = effectId(action, "reply");
      const runId = attemptRunId(action, "reply");
      if (attempt.pendingResponse !== undefined) {
        throw new MissionControlTransitionError(
          "Mission Control already has a response pending for this request.",
        );
      }
      return updateAttempt(current, item, attempt, action, revision, {
        ...attempt,
        pendingResponse: {
          requestId: action.requestId,
          commandId,
          runId,
        },
        version: attempt.version + 1,
        updatedAt: action.actionTs,
      }, [{
          effectId: commandId,
          effectType: "mission-control.execution.reply",
          payload: {
            itemId: item.id,
            attemptId: attempt.id,
            threadId: run.threadId,
            requestId: action.requestId,
            runId,
            message: action.message,
          },
        }]);
    }
    case "execution.resumed": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        return unchanged(current, action, revision, "stale");
      }
      if (
        attempt.status !== "waiting" ||
        attempt.pendingRequest?.requestId !== action.requestId ||
        attempt.pendingResponse?.requestId !== action.requestId ||
        attempt.pendingResponse.commandId !== action.commandId ||
        attempt.pendingResponse.runId !== action.runId
      ) {
        return unchanged(current, action, revision, "noop");
      }
      if (action.threadId !== attempt.pendingRequest.threadId) {
        throw new MissionControlTransitionError(
          "Resumed run thread does not match the pending request.",
        );
      }
      return updateAttempt(current, item, attempt, action, revision, {
        ...attempt,
        status: "running",
        runs: [...attempt.runs, acceptedRun(action)],
        currentRunId: action.runId,
        pendingRequest: undefined,
        pendingResponse: undefined,
        version: attempt.version + 1,
        updatedAt: action.actionTs,
      });
    }
    case "execution.stop": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        throw new MissionControlTransitionError(
          "A stale Mission Control Stop cannot target a newer attempt.",
        );
      }
      requireCurrentRun(attempt, action.runId, action.commandId);
      if (attempt.status === "cancelling") {
        return unchanged(current, action, revision, "noop");
      }
      if (
        attempt.status === "completed" ||
        attempt.status === "failed" ||
        attempt.status === "cancelled" ||
        attempt.status === "orphaned"
      ) {
        return unchanged(current, action, revision, "noop");
      }
      if (attempt.status !== "running" && attempt.status !== "waiting") {
        throw new MissionControlTransitionError(
          "Only Running or Waiting Mission Control work can be stopped.",
        );
      }
      const commandId = effectId(action, "cancel");
      return updateAttempt(current, item, attempt, action, revision, {
        ...attempt,
        status: "cancelling",
        version: attempt.version + 1,
        updatedAt: action.actionTs,
      }, [{
        effectId: commandId,
        effectType: "mission-control.execution.cancel",
        payload: {
          itemId: item.id,
          attemptId: attempt.id,
          sessionId: currentRun(attempt)!.sessionId,
          runId: action.runId,
          commandId: action.commandId,
        },
      }]);
    }
    case "execution.stop_rejected": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        return unchanged(current, action, revision, "stale");
      }
      if (attempt.status !== "cancelling") {
        return unchanged(current, action, revision, "noop");
      }
      if (action.outcome === "already_stopped") {
        return unchanged(current, action, revision, "noop");
      }
      if (action.outcome === "finalizing") {
        return updateAttempt(current, item, attempt, action, revision, {
          ...attempt,
          status: "running",
          version: attempt.version + 1,
          updatedAt: action.actionTs,
        });
      }
      return finishAttempt(current, item, attempt, action, revision, {
        status: "orphaned",
        attentionReason: "runtime_authority_changed",
        reason:
          `Runner authority changed while stopping the exact run` +
          `${action.activeRunId === undefined ? "" : `; activeRunId=${action.activeRunId}`}` +
          `${action.activeCommandId === undefined ? "" : `; activeCommandId=${action.activeCommandId}`}.`,
        reasonCode: "MISSION_CONTROL_CANCEL_TARGET_CHANGED",
      });
    }
    case "execution.cancel_confirmed": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        return unchanged(current, action, revision, "stale");
      }
      if (currentRun(attempt)?.runId !== action.runId) {
        return unchanged(current, action, revision, "stale");
      }
      if (attempt.status === "cancelled") {
        return unchanged(current, action, revision, "noop");
      }
      if (
        attempt.status !== "running" &&
        attempt.status !== "waiting" &&
        attempt.status !== "cancelling"
      ) {
        throw new MissionControlTransitionError(
          "Only authoritative active Mission Control work can confirm cancellation.",
        );
      }
      return finishAttempt(current, item, attempt, action, revision, {
        status: "cancelled",
        attentionReason: "operator_stopped",
        reason: action.outcome,
        reasonCode: "RUN_CANCELLED",
      });
    }
    case "execution.failed":
    case "execution.orphaned": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        return unchanged(current, action, revision, "stale");
      }
      if (action.runId !== undefined) {
        if (currentRun(attempt)?.runId !== action.runId) {
          return unchanged(current, action, revision, "stale");
        }
      }
      if (isTerminalAttemptStatus(attempt.status)) {
        return unchanged(current, action, revision, "noop");
      }
      return finishAttempt(current, item, attempt, action, revision, {
        status: action.type === "execution.orphaned" ? "orphaned" : "failed",
        attentionReason:
          action.type === "execution.orphaned"
            ? "runner_orphaned"
            : "execution_failed",
        reason: action.reason,
        reasonCode: action.reasonCode,
      });
    }
    case "execution.completed": {
      const attempt = requireAttempt(item, action);
      if (isStaleAttempt(item, attempt)) {
        return unchanged(current, action, revision, "stale");
      }
      if (currentRun(attempt)?.runId !== action.runId) {
        return unchanged(current, action, revision, "stale");
      }
      if (attempt.status === "completed") {
        return unchanged(current, action, revision, "noop");
      }
      if (
        attempt.status !== "running" &&
        attempt.status !== "waiting"
      ) {
        throw new MissionControlTransitionError(
          "Only an authoritative active run can complete Mission Control work.",
        );
      }
      return updateAttempt(
        current,
        item,
        attempt,
        action,
        revision,
        {
          ...attempt,
          status: "completed",
          pendingRequest: undefined,
          version: attempt.version + 1,
          updatedAt: action.actionTs,
        },
        [],
        undefined,
        "active",
      );
    }
  }
}

export function missionControlActiveWorkCount(
  document: MissionControlProjectDocument,
): number {
  return activeWorkCount(document);
}

export function isMissionControlAttemptActive(
  status: MissionControlExecutionAttempt["status"],
): boolean {
  return isActiveAttemptStatus(status);
}

function changed(
  current: MissionControlProjectDocument,
  action: MissionControlExecutionAction,
  revision: number,
  item: MissionControlWorkItem,
  effects: MissionControlOutboxIntent[],
): {
  document: MissionControlProjectDocument;
  effects: MissionControlOutboxIntent[];
} {
  return {
    document: appendExecutionHistory(
      replaceItem(current, item),
      action,
      revision,
      "applied",
    ),
    effects,
  };
}

function unchanged(
  current: MissionControlProjectDocument,
  action: MissionControlExecutionAction,
  revision: number,
  disposition: NonNullable<MissionControlHistoryEntry["disposition"]>,
  effects: MissionControlOutboxIntent[] = [],
): {
  document: MissionControlProjectDocument;
  effects: MissionControlOutboxIntent[];
} {
  return {
    document: appendExecutionHistory(current, action, revision, disposition),
    effects,
  };
}

function updateAttempt(
  current: MissionControlProjectDocument,
  item: MissionControlWorkItem,
  attempt: MissionControlExecutionAttempt,
  action: MissionControlExecutionAction,
  revision: number,
  updatedAttempt: MissionControlExecutionAttempt,
  effects: MissionControlOutboxIntent[] = [],
  attentionReason?: MissionControlAttentionReason | undefined,
  phase: MissionControlWorkItem["phase"] = item.phase,
): {
  document: MissionControlProjectDocument;
  effects: MissionControlOutboxIntent[];
} {
  const attempts = item.attempts.map((entry) =>
    entry.id === attempt.id ? updatedAttempt : entry,
  );
  return changed(current, action, revision, {
    ...item,
    phase,
    attempts,
    ...(attentionReason === undefined ? {} : { attentionReason }),
    ...(attentionReason === undefined && phase !== "active"
      ? { attentionReason: undefined }
      : {}),
    version: item.version + 1,
    updatedAt: action.actionTs,
  }, effects);
}

function finishAttempt(
  current: MissionControlProjectDocument,
  item: MissionControlWorkItem,
  attempt: MissionControlExecutionAttempt,
  action: MissionControlExecutionAction,
  revision: number,
  input: {
    status: "failed" | "cancelled" | "orphaned";
    attentionReason: MissionControlAttentionReason;
    reason: string;
    reasonCode?: string | undefined;
  },
): {
  document: MissionControlProjectDocument;
  effects: MissionControlOutboxIntent[];
} {
  return updateAttempt(
    current,
    item,
    attempt,
    action,
    revision,
    {
      ...attempt,
      status: input.status,
      pendingRequest: undefined,
      pendingResponse: undefined,
      terminalReason: input.reason,
      ...(input.reasonCode === undefined
        ? {}
        : { terminalReasonCode: input.reasonCode }),
      version: attempt.version + 1,
      updatedAt: action.actionTs,
    },
    [],
    input.attentionReason,
    "needs_attention",
  );
}

function appendExecutionHistory(
  current: MissionControlProjectDocument,
  action: MissionControlExecutionAction,
  revision: number,
  disposition: NonNullable<MissionControlHistoryEntry["disposition"]>,
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
        itemId: action.itemId,
        attemptId: action.attemptId,
        disposition,
      },
    ],
  };
}

function replaceItem(
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

function requireItem(
  current: MissionControlProjectDocument,
  action: ExecutionActionBase,
): MissionControlWorkItem {
  const item = current.items[action.itemId];
  if (item === undefined) {
    throw new MissionControlTransitionError(
      `Mission Control item not found: ${action.itemId}.`,
    );
  }
  if (item.version !== action.expectedItemVersion) {
    throw new MissionControlItemVersionConflictError(
      item.id,
      action.expectedItemVersion,
      item.version,
    );
  }
  return item;
}

function requireAttempt(
  item: MissionControlWorkItem,
  action: AttemptActionBase,
): MissionControlExecutionAttempt {
  const attempt = item.attempts.find((entry) => entry.id === action.attemptId);
  if (attempt === undefined) {
    throw new MissionControlTransitionError(
      `Mission Control attempt not found: ${action.attemptId}.`,
    );
  }
  if (attempt.version !== action.expectedAttemptVersion) {
    throw new MissionControlAttemptVersionConflictError(
      attempt.id,
      action.expectedAttemptVersion,
      attempt.version,
    );
  }
  return attempt;
}

function requireCurrentAttempt(
  item: MissionControlWorkItem,
): MissionControlExecutionAttempt {
  const attempt = currentAttempt(item);
  if (attempt === undefined) {
    throw new MissionControlTransitionError(
      "Mission Control item has no current execution attempt.",
    );
  }
  return attempt;
}

function currentAttempt(
  item: MissionControlWorkItem,
): MissionControlExecutionAttempt | undefined {
  return item.currentAttemptId === undefined
    ? undefined
    : item.attempts.find((attempt) => attempt.id === item.currentAttemptId);
}

function currentRun(
  attempt: MissionControlExecutionAttempt,
) {
  return attempt.currentRunId === undefined
    ? undefined
    : attempt.runs.find((run) => run.runId === attempt.currentRunId);
}

function requireCurrentRun(
  attempt: MissionControlExecutionAttempt,
  runId: string,
  commandId?: string | undefined,
): void {
  const run = currentRun(attempt);
  if (
    run === undefined ||
    run.runId !== runId ||
    (commandId !== undefined && run.commandId !== commandId)
  ) {
    throw new MissionControlTransitionError(
      "Mission Control runtime identity does not match the current attempt.",
    );
  }
}

function isStaleAttempt(
  item: MissionControlWorkItem,
  attempt: MissionControlExecutionAttempt,
): boolean {
  return item.currentAttemptId !== attempt.id;
}

function activeWorkCount(current: MissionControlProjectDocument): number {
  return Object.values(current.items).filter((item) => {
    const attempt = currentAttempt(item);
    return attempt !== undefined && isActiveAttemptStatus(attempt.status);
  }).length;
}

function isActiveAttemptStatus(
  status: MissionControlExecutionAttempt["status"],
): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "waiting" ||
    status === "cancelling"
  );
}

function isTerminalAttemptStatus(
  status: MissionControlExecutionAttempt["status"],
): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "orphaned"
  );
}

function requireUniqueAttemptId(
  item: MissionControlWorkItem,
  attemptId: string,
): void {
  if (item.attempts.some((attempt) => attempt.id === attemptId)) {
    throw new MissionControlTransitionError(
      `Mission Control attempt already exists: ${attemptId}.`,
    );
  }
}

function nextGeneration(item: MissionControlWorkItem): number {
  return item.attempts.reduce(
    (maximum, attempt) => Math.max(maximum, attempt.generation),
    0,
  ) + 1;
}

function acceptedRun(
  action:
    | Extract<MissionControlExecutionAction, { type: "execution.accepted" }>
    | Extract<MissionControlExecutionAction, { type: "execution.resumed" }>,
) {
  return {
    sessionId: action.sessionId,
    threadId: action.threadId,
    runId: action.runId,
    commandId: action.commandId,
    acceptedAt: action.actionTs,
  };
}

function buildExecutionMessage(item: MissionControlWorkItem): string {
  return `${item.title}\n\n${item.instructions}`;
}

function effectId(
  action: MissionControlExecutionAction,
  kind: string,
): string {
  return createHash("sha256")
    .update(`${action.projectId}:${action.actionId}:${kind}`)
    .digest("hex");
}

function attemptRunId(
  action: MissionControlExecutionAction,
  kind: "start" | "retry" | "reply",
): string {
  return kind === "start" ? action.attemptId : effectId(action, `${kind}-run`);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
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

const BASE_KEYS = [
  "type",
  "projectId",
  "actionId",
  "actionTs",
  "expectedRevision",
  "itemId",
  "expectedItemVersion",
] as const;

const ATTEMPT_KEYS = [
  ...BASE_KEYS,
  "attemptId",
  "expectedAttemptVersion",
] as const;

function parseAttemptBase(
  base: ExecutionActionBase,
  record: Record<string, unknown>,
): AttemptActionBase {
  return {
    ...base,
    attemptId: requireText(record.attemptId, "attemptId", 256),
    expectedAttemptVersion: requirePositiveInteger(
      record.expectedAttemptVersion,
      "expectedAttemptVersion",
    ),
  };
}

function parsePendingRequest(value: unknown): MissionControlPendingRequest {
  const record = requireRecord(value, "request");
  assertKeys(record, [
    "requestId",
    "threadId",
    "kind",
    "eventType",
    "enteredAt",
  ]);
  return {
    requestId: requireText(record.requestId, "request.requestId", 256),
    threadId: requireText(record.threadId, "request.threadId", 256),
    kind: requirePendingKind(record.kind),
    ...(record.eventType === undefined
      ? {}
      : { eventType: requireText(record.eventType, "request.eventType", 256) }),
    ...(record.enteredAt === undefined
      ? {}
      : { enteredAt: requireTimestamp(record.enteredAt, "request.enteredAt") }),
  };
}

function pendingRequestsEqual(
  left: MissionControlPendingRequest,
  right: MissionControlPendingRequest,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.threadId === right.threadId &&
    left.kind === right.kind &&
    left.eventType === right.eventType &&
    left.enteredAt === right.enteredAt
  );
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > maximumLength) {
    throw new Error(
      `${field} must contain 1 to ${maximumLength} non-whitespace characters.`,
    );
  }
  return text;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    Number.isSafeInteger(value) === false ||
    value <= 0
  ) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function requireInitiator(
  value: unknown,
): "operator" | "autopilot" {
  if (value !== "operator" && value !== "autopilot") {
    throw new Error("initiatedBy must be operator or autopilot.");
  }
  return value;
}

function requirePendingKind(
  value: unknown,
): MissionControlPendingRequest["kind"] {
  if (
    value !== "approval" &&
    value !== "user_input" &&
    value !== "delegation" &&
    value !== "scheduler_wait" &&
    value !== "compaction_checkpoint" &&
    value !== "unknown"
  ) {
    throw new Error("request.kind is invalid.");
  }
  return value;
}

function requireStopRejectionOutcome(
  value: unknown,
): "already_stopped" | "run_changed" | "finalizing" {
  if (
    value !== "already_stopped" &&
    value !== "run_changed" &&
    value !== "finalizing"
  ) {
    throw new Error("outcome must be already_stopped, run_changed, or finalizing.");
  }
  return value;
}

function requireCancelOutcome(
  value: unknown,
): "cancelled" | "already_stopped" {
  if (value !== "cancelled" && value !== "already_stopped") {
    throw new Error("outcome must be cancelled or already_stopped.");
  }
  return value;
}

function assertKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).filter((key) => allowed.has(key) === false);
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected Mission Control execution fields: ${unexpected.sort().join(", ")}.`,
    );
  }
}
