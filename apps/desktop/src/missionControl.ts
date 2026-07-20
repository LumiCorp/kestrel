import { parseTaskAction } from "../../../src/missionControl/contracts.js";
import { parseProductProjectBoardAction } from "../../../src/project/contracts.js";
import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import type {
  DesktopProjectAction,
  DesktopProjectSnapshotResponse,
  DesktopRuntimeRunIndex,
  DesktopRuntimeRunIndexEntry,
  DesktopRuntimeRunIndexQuery,
  DesktopRuntimeRunInspection,
  DesktopRuntimeRunStatus,
  DesktopRuntimeSessionIndexEntry,
  DesktopRuntimeRunTimelineEntry,
  DesktopRuntimeThreadBlocker,
  DesktopRuntimeThreadInspection,
  DesktopRuntimeThreadNextAction,
  DesktopRuntimeThreadPlan,
  DesktopRuntimeThreadStatus,
  DesktopRuntimeThreadSummary,
  DesktopOperatorControlRequest,
} from "./contracts.js";
import { createDesktopError } from "./errors.js";

export async function getDesktopProjectSnapshot(input: {
  adapter: Pick<WebRunnerAdapter, "sendControl">;
  sessionId: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopProjectSnapshotResponse> {
  const sessionId = parseSessionId(input.sessionId);
  const event = await input.adapter.sendControl(
    { type: "project.snapshot.get", sessionId },
    input.context,
  );
  if (event.type !== "project.snapshot") {
    throw createDesktopError({
      code: "desktop.project_snapshot_unexpected_response",
      message: `Runner returned '${event.type}' for project.snapshot.get.`,
    });
  }
  return event.payload;
}

export async function runDesktopProjectAction(input: {
  adapter: Pick<WebRunnerAdapter, "sendControl">;
  action: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopProjectSnapshotResponse> {
  let action: DesktopProjectAction;
  try {
    action = parseDesktopProjectAction(input.action);
  } catch (error) {
    throw createDesktopError({
      code: "desktop.invalid_project_action",
      message: "Desktop project action is invalid.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
  const event = await input.adapter.sendControl(
    { type: "project.action", action },
    input.context,
  );
  if (event.type !== "project.snapshot") {
    throw createDesktopError({
      code: "desktop.task_action_unexpected_response",
      message: `Runner returned '${event.type}' for project.action.`,
    });
  }
  return event.payload;
}

export async function getDesktopOperatorThread(input: {
  adapter: Pick<WebRunnerAdapter, "sendControl">;
  threadId: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopRuntimeThreadInspection> {
  const threadId = parseThreadId(input.threadId);
  const event = await input.adapter.sendControl(
    { type: "operator.thread", threadId },
    input.context,
  );
  if (event.type !== "operator.thread") {
    throw createDesktopError({
      code: "desktop.operator_thread_unexpected_response",
      message: `Runner returned '${event.type}' for operator.thread.`,
    });
  }
  try {
    return parseDesktopRuntimeThreadInspection(event.payload.view);
  } catch (error) {
    throw createDesktopError({
      code: "desktop.operator_thread_invalid_response",
      message: "Runner returned an invalid operator thread view.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runDesktopOperatorControl(input: {
  adapter: Pick<WebRunnerAdapter, "sendControl">;
  request: DesktopOperatorControlRequest & { attachments?: import("../../../src/kestrel/contracts/orchestration.js").RunTurnAttachment[] | undefined };
  context: WebRunnerRequestContext;
}): Promise<DesktopRuntimeThreadInspection> {
  const event = await input.adapter.sendControl({ type: "operator.control", ...input.request }, input.context);
  if (event.type !== "operator.controlled") {
    throw createDesktopError({ code: "desktop.operator_control_unexpected_response", message: `Runner returned '${event.type}' for operator.control.` });
  }
  const view = event.payload.view;
  if (view === undefined) throw createDesktopError({ code: "desktop.operator_control_missing_view", message: "Runner did not return the authoritative thread view." });
  return parseDesktopRuntimeThreadInspection(view);
}

export async function getDesktopOperatorRun(input: {
  adapter: Pick<WebRunnerAdapter, "sendControl">;
  runId: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopRuntimeRunInspection> {
  const runId = parseRunId(input.runId);
  const event = await input.adapter.sendControl(
    { type: "operator.run", runId },
    input.context,
  );
  if (event.type !== "operator.run") {
    throw createDesktopError({
      code: "desktop.operator_run_unexpected_response",
      message: `Runner returned '${event.type}' for operator.run.`,
    });
  }
  try {
    return parseDesktopRuntimeRunInspection(event.payload.view);
  } catch (error) {
    throw createDesktopError({
      code: "desktop.operator_run_invalid_response",
      message: "Runner returned an invalid operator run view.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listDesktopOperatorRuns(input: {
  adapter: Pick<WebRunnerAdapter, "sendControl">;
  query?: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopRuntimeRunIndex> {
  const query = parseDesktopRuntimeRunIndexQuery(input.query);
  const event = await input.adapter.sendControl(
    { type: "operator.runs", ...query },
    input.context,
  );
  if (event.type !== "operator.runs") {
    throw createDesktopError({
      code: "desktop.operator_runs_unexpected_response",
      message: `Runner returned '${event.type}' for operator.runs.`,
    });
  }
  try {
    return parseDesktopRuntimeRunIndex(event.payload.view);
  } catch (error) {
    throw createDesktopError({
      code: "desktop.operator_runs_invalid_response",
      message: "Runner returned an invalid operator run index.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseDesktopRuntimeThreadInspection(
  value: unknown,
): DesktopRuntimeThreadInspection {
  const view = requireRecord(value, "operator thread view");
  const childThreads = requireArray(view.childThreads, "operator thread view.childThreads")
    .map((thread, index) => parseRuntimeThreadSummary(thread, `operator thread view.childThreads[${index}]`));
  const focusedThreadId = optionalString(view.focusedThreadId, "operator thread view.focusedThreadId");
  const parentThread = view.parentThread === undefined
    ? undefined
    : parseRuntimeThreadSummary(view.parentThread, "operator thread view.parentThread");
  const operatorPhase = parseOperatorPhase(view.operatorPhase);
  const blocker = view.blocker === undefined ? undefined : parseThreadBlocker(view.blocker);
  const nextAction = view.nextAction === undefined ? undefined : parseThreadNextAction(view.nextAction);
  const runtimePlan = view.runtimePlan === undefined ? undefined : parseThreadRuntimePlan(view.runtimePlan);
  const latestSteering = view.latestSteering === undefined
    ? undefined
    : parseLatestSteering(view.latestSteering);
  const activeRun = view.activeRun === undefined ? undefined : parseActiveRun(view.activeRun);
  const followUpQueue = parseFollowUpQueue(view.followUpQueue);
  const inboxItems = view.inboxItems === undefined
    ? []
    : requireArray(view.inboxItems, "operator thread view.inboxItems").map(parseInboxItem);
  return {
    thread: parseRuntimeThreadSummary(view.thread, "operator thread view.thread"),
    ...(focusedThreadId !== undefined ? { focusedThreadId } : {}),
    ...(parentThread !== undefined ? { parentThread } : {}),
    childThreads,
    ...(operatorPhase !== undefined ? { operatorPhase } : {}),
    ...(blocker !== undefined ? { blocker } : {}),
    ...(nextAction !== undefined ? { nextAction } : {}),
    ...(runtimePlan !== undefined ? { runtimePlan } : {}),
    ...(latestSteering !== undefined ? { latestSteering } : {}),
    ...(activeRun !== undefined ? { activeRun } : {}),
    followUpQueue,
    inboxItems,
  };
}

function parseActiveRun(value: unknown): NonNullable<DesktopRuntimeThreadInspection["activeRun"]> {
  const run = requireRecord(value, "operator thread view.activeRun");
  if (run.status !== "RUNNING" && run.status !== "WAITING") throw new Error("operator thread view.activeRun.status is invalid.");
  return { runId: requireString(run.runId, "operator thread view.activeRun.runId"), status: run.status };
}

function parseFollowUpQueue(value: unknown): DesktopRuntimeThreadInspection["followUpQueue"] {
  if (value === undefined) return { state: "ready", items: [] };
  const queue = requireRecord(value, "operator thread view.followUpQueue");
  if (queue.state !== "ready" && queue.state !== "paused") throw new Error("operator thread view.followUpQueue.state is invalid.");
  const pauseReason = queue.pauseReason;
  if (pauseReason !== undefined && pauseReason !== "waiting" && pauseReason !== "failed" && pauseReason !== "cancelled" && pauseReason !== "operator") {
    throw new Error("operator thread view.followUpQueue.pauseReason is invalid.");
  }
  return {
    state: queue.state,
    ...(pauseReason !== undefined ? { pauseReason } : {}),
    items: requireArray(queue.items, "operator thread view.followUpQueue.items").map((value, index) => {
      const item = requireRecord(value, `operator thread view.followUpQueue.items[${index}]`);
      if (item.state !== "queued" && item.state !== "starting") throw new Error("operator follow-up state is invalid.");
      const interactionMode = item.interactionMode;
      const actSubmode = item.actSubmode;
      return {
        followUpId: requireString(item.followUpId, "followUpId"),
        message: requireString(item.message, "message"),
        attachmentIds: requireArray(item.attachmentIds, "attachmentIds").map((id) => requireString(id, "attachmentId")),
        ...(interactionMode === "chat" || interactionMode === "plan" || interactionMode === "build" ? { interactionMode } : {}),
        ...(actSubmode === "strict" || actSubmode === "safe" || actSubmode === "full_auto" ? { actSubmode } : {}),
        createdAt: requireTimestamp(item.createdAt, "createdAt"),
        state: item.state,
      };
    }),
  };
}

function parseInboxItem(value: unknown, index: number): DesktopRuntimeThreadInspection["inboxItems"][number] {
  const item = requireRecord(value, `operator thread view.inboxItems[${index}]`);
  const kinds = new Set(["approval_request", "user_input_request", "context_checkpoint", "child_thread_blocker", "stalled_thread_attention", "assembly_change_proposal", "compatibility_downgrade_attention", "fan_in_checkpoint", "child_outcome_review"]);
  if (typeof item.kind !== "string" || kinds.has(item.kind) === false || typeof item.actionable !== "boolean") throw new Error("operator inbox item is invalid.");
  return {
    itemId: requireString(item.itemId, "itemId"),
    kind: item.kind as DesktopRuntimeThreadInspection["inboxItems"][number]["kind"],
    threadId: requireString(item.threadId, "threadId"),
    sessionId: requireString(item.sessionId, "sessionId"),
    title: requireString(item.title, "title"),
    actionable: item.actionable,
    createdAt: requireTimestamp(item.createdAt, "createdAt"),
    ...optionalField(item.requestId, "requestId", "requestId"),
    ...optionalField(item.checkpointId, "checkpointId", "checkpointId"),
    ...optionalField(item.delegationId, "delegationId", "delegationId"),
    ...optionalField(item.childThreadId, "childThreadId", "childThreadId"),
    ...optionalField(item.recommendedAction, "recommendedAction", "recommendedAction"),
    ...optionalField(item.detail, "detail", "detail"),
    ...(typeof item.metadata === "object" && item.metadata !== null && Array.isArray(item.metadata) === false ? { metadata: item.metadata as Record<string, unknown> } : {}),
  };
}

export function parseDesktopRuntimeRunInspection(
  value: unknown,
): DesktopRuntimeRunInspection {
  const view = requireRecord(value, "operator run view");
  if (view.version !== "operator-run-v1") {
    throw new Error("operator run view.version is invalid.");
  }
  const run = requireRecord(view.run, "operator run view.run");
  const summary = requireRecord(view.summary, "operator run view.summary");
  const diagnosis = requireRecord(view.diagnosis, "operator run view.diagnosis");
  const modelProvenance = requireRecord(
    view.modelProvenance,
    "operator run view.modelProvenance",
  );
  const error = run.error === undefined
    ? undefined
    : parseRunError(run.error);
  const dominantFailure = diagnosis.dominantFailure === undefined
    ? undefined
    : parseRunDominantFailure(diagnosis.dominantFailure);
  const wait = diagnosis.wait === undefined
    ? undefined
    : parseRunWait(diagnosis.wait);
  const latestReasoning = diagnosis.latestReasoning === undefined
    ? undefined
    : parseRunLatestReasoning(diagnosis.latestReasoning);
  const runtimePlan = view.runtimePlan === undefined
    ? undefined
    : parseThreadRuntimePlan(view.runtimePlan, "operator run view.runtimePlan");
  return {
    version: "operator-run-v1",
    run: {
      runId: requireString(run.runId, "operator run view.run.runId"),
      sessionId: requireString(run.sessionId, "operator run view.run.sessionId"),
      eventType: requireString(run.eventType, "operator run view.run.eventType"),
      status: parseRunStatus(run.status, "operator run view.run.status"),
      startedAt: requireTimestamp(run.startedAt, "operator run view.run.startedAt"),
      ...optionalTimestampField(
        run.completedAt,
        "operator run view.run.completedAt",
        "completedAt",
      ),
      ...(error !== undefined ? { error } : {}),
    },
    ...optionalField(view.threadId, "operator run view.threadId", "threadId"),
    summary: {
      eventCount: requireNonNegativeInteger(
        summary.eventCount,
        "operator run view.summary.eventCount",
      ),
      ...optionalTimestampField(
        summary.firstEventAt,
        "operator run view.summary.firstEventAt",
        "firstEventAt",
      ),
      ...optionalTimestampField(
        summary.lastEventAt,
        "operator run view.summary.lastEventAt",
        "lastEventAt",
      ),
      ...(summary.terminalStatus !== undefined
        ? {
            terminalStatus: parseRunStatus(
              summary.terminalStatus,
              "operator run view.summary.terminalStatus",
            ),
          }
        : {}),
      stepsObserved: requireNonNegativeInteger(
        summary.stepsObserved,
        "operator run view.summary.stepsObserved",
      ),
      progressToolCalls: requireNonNegativeInteger(
        summary.progressToolCalls,
        "operator run view.summary.progressToolCalls",
      ),
      waitingMilestones: requireNonNegativeInteger(
        summary.waitingMilestones,
        "operator run view.summary.waitingMilestones",
      ),
      truncated: requireBoolean(summary.truncated, "operator run view.summary.truncated"),
      ...optionalIntegerField(
        summary.requestedLimit,
        "operator run view.summary.requestedLimit",
        "requestedLimit",
      ),
    },
    diagnosis: {
      status: parseRunDiagnosisStatus(diagnosis.status),
      ...optionalField(diagnosis.finalStep, "operator run view.diagnosis.finalStep", "finalStep"),
      ...optionalField(
        diagnosis.terminalReasonCode,
        "operator run view.diagnosis.terminalReasonCode",
        "terminalReasonCode",
      ),
      actionable: requireBoolean(
        diagnosis.actionable,
        "operator run view.diagnosis.actionable",
      ),
      ...(dominantFailure !== undefined ? { dominantFailure } : {}),
      ...(wait !== undefined ? { wait } : {}),
      ...(latestReasoning !== undefined ? { latestReasoning } : {}),
    },
    modelProvenance: {
      retention: parseModelRetention(modelProvenance.retention),
      callCount: requireNonNegativeInteger(
        modelProvenance.callCount,
        "operator run view.modelProvenance.callCount",
      ),
      actionCallCount: requireNonNegativeInteger(
        modelProvenance.actionCallCount,
        "operator run view.modelProvenance.actionCallCount",
      ),
      maintenanceCallCount: requireNonNegativeInteger(
        modelProvenance.maintenanceCallCount,
        "operator run view.modelProvenance.maintenanceCallCount",
      ),
      providers: parseStringArray(
        modelProvenance.providers,
        "operator run view.modelProvenance.providers",
      ),
      models: parseStringArray(
        modelProvenance.models,
        "operator run view.modelProvenance.models",
      ),
    },
    ...(runtimePlan !== undefined ? { runtimePlan } : {}),
    timeline: requireArray(view.timeline, "operator run view.timeline")
      .map((entry, index) => parseRunTimelineEntry(entry, index)),
  };
}

export function parseDesktopRuntimeRunIndex(value: unknown): DesktopRuntimeRunIndex {
  const view = requireRecord(value, "operator run index");
  if (view.version !== "operator-run-index-v1") {
    throw new Error("operator run index.version is invalid.");
  }
  const filters = requireRecord(view.filters, "operator run index.filters");
  return {
    version: "operator-run-index-v1",
    generatedAt: requireTimestamp(view.generatedAt, "operator run index.generatedAt"),
    filters: {
      ...optionalField(filters.sessionId, "operator run index.filters.sessionId", "sessionId"),
      ...(filters.status !== undefined
        ? { status: parseRunStatus(filters.status, "operator run index.filters.status") }
        : {}),
      limit: requireBoundedPositiveInteger(
        filters.limit,
        "operator run index.filters.limit",
        50,
      ),
    },
    hasMore: requireBoolean(view.hasMore, "operator run index.hasMore"),
    runs: requireArray(view.runs, "operator run index.runs")
      .map((entry, index) => parseRunIndexEntry(entry, index)),
    sessions: requireArray(view.sessions, "operator run index.sessions")
      .map((entry, index) => parseSessionIndexEntry(entry, index)),
  };
}

function parseDesktopRuntimeRunIndexQuery(value: unknown): DesktopRuntimeRunIndexQuery {
  if (value === undefined) {
    return {};
  }
  const query = requireRecord(value, "operator run index query");
  return {
    ...optionalField(query.sessionId, "operator run index query.sessionId", "sessionId"),
    ...(query.status !== undefined
      ? { status: parseRunStatus(query.status, "operator run index query.status") }
      : {}),
    ...(query.limit !== undefined
      ? {
          limit: requireBoundedPositiveInteger(
            query.limit,
            "operator run index query.limit",
            50,
          ),
        }
      : {}),
  };
}

function parseRunIndexEntry(value: unknown, index: number): DesktopRuntimeRunIndexEntry {
  const label = `operator run index.runs[${index}]`;
  const entry = requireRecord(value, label);
  const run = requireRecord(entry.run, `${label}.run`);
  const summary = requireRecord(entry.summary, `${label}.summary`);
  const diagnosis = requireRecord(entry.diagnosis, `${label}.diagnosis`);
  return {
    run: {
      runId: requireString(run.runId, `${label}.run.runId`),
      sessionId: requireString(run.sessionId, `${label}.run.sessionId`),
      eventType: requireString(run.eventType, `${label}.run.eventType`),
      status: parseRunStatus(run.status, `${label}.run.status`),
      startedAt: requireTimestamp(run.startedAt, `${label}.run.startedAt`),
      ...optionalTimestampField(run.completedAt, `${label}.run.completedAt`, "completedAt"),
      ...(run.error !== undefined ? { error: parseRunError(run.error) } : {}),
    },
    ...optionalField(entry.threadId, `${label}.threadId`, "threadId"),
    summary: {
      eventCount: requireNonNegativeInteger(summary.eventCount, `${label}.summary.eventCount`),
      truncated: requireBoolean(summary.truncated, `${label}.summary.truncated`),
    },
    diagnosis: {
      status: parseRunDiagnosisStatus(diagnosis.status),
      ...optionalField(diagnosis.finalStep, `${label}.diagnosis.finalStep`, "finalStep"),
      ...optionalField(
        diagnosis.terminalReasonCode,
        `${label}.diagnosis.terminalReasonCode`,
        "terminalReasonCode",
      ),
      actionable: requireBoolean(diagnosis.actionable, `${label}.diagnosis.actionable`),
      ...(diagnosis.dominantFailure !== undefined
        ? { dominantFailure: parseRunDominantFailure(diagnosis.dominantFailure) }
        : {}),
      ...(diagnosis.wait !== undefined ? { wait: parseRunWait(diagnosis.wait) } : {}),
    },
  };
}

function parseSessionIndexEntry(
  value: unknown,
  index: number,
): DesktopRuntimeSessionIndexEntry {
  const label = `operator run index.sessions[${index}]`;
  const entry = requireRecord(value, label);
  const statusCounts = requireRecord(entry.statusCounts, `${label}.statusCounts`);
  return {
    sessionId: requireString(entry.sessionId, `${label}.sessionId`),
    runCount: requireNonNegativeInteger(entry.runCount, `${label}.runCount`),
    statusCounts: {
      RUNNING: requireNonNegativeInteger(statusCounts.RUNNING, `${label}.statusCounts.RUNNING`),
      WAITING: requireNonNegativeInteger(statusCounts.WAITING, `${label}.statusCounts.WAITING`),
      COMPLETED: requireNonNegativeInteger(
        statusCounts.COMPLETED,
        `${label}.statusCounts.COMPLETED`,
      ),
      FAILED: requireNonNegativeInteger(statusCounts.FAILED, `${label}.statusCounts.FAILED`),
    },
    latestRunId: requireString(entry.latestRunId, `${label}.latestRunId`),
    latestStatus: parseRunStatus(entry.latestStatus, `${label}.latestStatus`),
    latestStartedAt: requireTimestamp(entry.latestStartedAt, `${label}.latestStartedAt`),
  };
}

function parseDesktopProjectAction(value: unknown): DesktopProjectAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop project action must be an object.");
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") {
    throw new Error("Desktop project action type is invalid.");
  }
  if (type.startsWith("task.")) {
    return parseTaskAction(value);
  }
  if (type.startsWith("board.")) {
    return parseProductProjectBoardAction(value);
  }
  throw new Error("Desktop project action type is invalid.");
}

function parseSessionId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_project_session",
      message: "Desktop project session ID must be a non-empty string.",
    });
  }
  return value;
}

function parseThreadId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_operator_thread_id",
      message: "Desktop runtime thread ID must be a non-empty string.",
    });
  }
  return value.trim();
}

function parseRunId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_operator_run_id",
      message: "Desktop runtime run ID must be a non-empty string.",
    });
  }
  return value.trim();
}

function parseRuntimeThreadSummary(value: unknown, label: string): DesktopRuntimeThreadSummary {
  const thread = requireRecord(value, label);
  const status = parseThreadStatus(thread.status, `${label}.status`);
  return {
    threadId: requireString(thread.threadId, `${label}.threadId`),
    sessionId: requireString(thread.sessionId, `${label}.sessionId`),
    title: requireString(thread.title, `${label}.title`),
    status,
    ...optionalField(thread.agentProfileId, `${label}.agentProfileId`, "agentProfileId"),
    ...optionalField(thread.agentProfileLabel, `${label}.agentProfileLabel`, "agentProfileLabel"),
    ...optionalField(thread.parentThreadId, `${label}.parentThreadId`, "parentThreadId"),
    ...optionalField(thread.activeRunId, `${label}.activeRunId`, "activeRunId"),
    ...optionalField(thread.currentRequestId, `${label}.currentRequestId`, "currentRequestId"),
    ...optionalField(thread.lastRunStatus, `${label}.lastRunStatus`, "lastRunStatus"),
    createdAt: requireTimestamp(thread.createdAt, `${label}.createdAt`),
    updatedAt: requireTimestamp(thread.updatedAt, `${label}.updatedAt`),
  };
}

function parseThreadStatus(value: unknown, label: string): DesktopRuntimeThreadStatus {
  if (
    value !== "IDLE"
    && value !== "RUNNING"
    && value !== "WAITING"
    && value !== "COMPLETED"
    && value !== "FAILED"
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseRunStatus(value: unknown, label: string): DesktopRuntimeRunStatus {
  if (
    value !== "RUNNING"
    && value !== "WAITING"
    && value !== "COMPLETED"
    && value !== "FAILED"
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseThreadBlocker(value: unknown): DesktopRuntimeThreadBlocker {
  const blocker = requireRecord(value, "operator thread view.blocker");
  if (
    blocker.kind !== "wait"
    && blocker.kind !== "child_thread"
    && blocker.kind !== "checkpoint"
    && blocker.kind !== "stalled"
  ) {
    throw new Error("operator thread view.blocker.kind is invalid.");
  }
  if (typeof blocker.actionable !== "boolean") {
    throw new Error("operator thread view.blocker.actionable must be a boolean.");
  }
  return {
    kind: blocker.kind,
    summary: requireString(blocker.summary, "operator thread view.blocker.summary"),
    actionable: blocker.actionable,
    ...optionalField(blocker.threadId, "operator thread view.blocker.threadId", "threadId"),
    ...optionalField(blocker.childThreadId, "operator thread view.blocker.childThreadId", "childThreadId"),
    ...optionalField(blocker.requestId, "operator thread view.blocker.requestId", "requestId"),
    ...optionalField(blocker.checkpointId, "operator thread view.blocker.checkpointId", "checkpointId"),
    ...optionalField(blocker.delegationId, "operator thread view.blocker.delegationId", "delegationId"),
    ...optionalField(blocker.eventType, "operator thread view.blocker.eventType", "eventType"),
  };
}

function parseThreadNextAction(value: unknown): DesktopRuntimeThreadNextAction {
  const nextAction = requireRecord(value, "operator thread view.nextAction");
  if (
    nextAction.kind !== "approve"
    && nextAction.kind !== "reply"
    && nextAction.kind !== "retry"
    && nextAction.kind !== "focus_thread"
    && nextAction.kind !== "resolve_context_checkpoint"
    && nextAction.kind !== "resolve_fan_in_checkpoint"
    && nextAction.kind !== "approve_assembly_change"
    && nextAction.kind !== "switch_thread"
    && nextAction.kind !== "wait"
  ) {
    throw new Error("operator thread view.nextAction.kind is invalid.");
  }
  return {
    kind: nextAction.kind,
    summary: requireString(nextAction.summary, "operator thread view.nextAction.summary"),
    ...optionalField(nextAction.threadId, "operator thread view.nextAction.threadId", "threadId"),
    ...optionalField(nextAction.requestId, "operator thread view.nextAction.requestId", "requestId"),
    ...optionalField(nextAction.checkpointId, "operator thread view.nextAction.checkpointId", "checkpointId"),
    ...optionalField(nextAction.proposalId, "operator thread view.nextAction.proposalId", "proposalId"),
    ...optionalField(nextAction.childThreadId, "operator thread view.nextAction.childThreadId", "childThreadId"),
  };
}

function parseThreadRuntimePlan(
  value: unknown,
  label = "operator thread view.runtimePlan",
): DesktopRuntimeThreadPlan {
  const plan = requireRecord(value, label);
  let commandNames: string[] | undefined;
  if (plan.commandNames !== undefined) {
    commandNames = requireArray(plan.commandNames, `${label}.commandNames`)
      .map((name, index) => requireString(name, `${label}.commandNames[${index}]`));
  }
  return {
    ...optionalField(plan.phase, `${label}.phase`, "phase"),
    ...optionalField(plan.currentChunk, `${label}.currentChunk`, "currentChunk"),
    ...optionalField(plan.status, `${label}.status`, "status"),
    ...optionalField(plan.expectedNextCommand, `${label}.expectedNextCommand`, "expectedNextCommand"),
    ...optionalField(plan.waitReason, `${label}.waitReason`, "waitReason"),
    ...optionalField(plan.blocker, `${label}.blocker`, "blocker"),
    ...(commandNames !== undefined ? { commandNames } : {}),
  };
}

function parseLatestSteering(value: unknown): NonNullable<DesktopRuntimeThreadInspection["latestSteering"]> {
  const steering = requireRecord(value, "operator thread view.latestSteering");
  return {
    message: requireString(steering.message, "operator thread view.latestSteering.message"),
    ...optionalField(steering.issuedBy, "operator thread view.latestSteering.issuedBy", "issuedBy"),
    at: requireTimestamp(steering.at, "operator thread view.latestSteering.at"),
    ...optionalField(steering.runId, "operator thread view.latestSteering.runId", "runId"),
  };
}

function parseOperatorPhase(
  value: unknown,
): DesktopRuntimeThreadInspection["operatorPhase"] {
  if (value === undefined) {
    return ;
  }
  if (
    value !== "assemble"
    && value !== "decide"
    && value !== "act"
    && value !== "observe"
    && value !== "wait"
    && value !== "finalize"
  ) {
    throw new Error("operator thread view.operatorPhase is invalid.");
  }
  return value;
}

function parseRunError(
  value: unknown,
): NonNullable<DesktopRuntimeRunInspection["run"]["error"]> {
  const error = requireRecord(value, "operator run view.run.error");
  return {
    code: requireString(error.code, "operator run view.run.error.code"),
    message: requireString(error.message, "operator run view.run.error.message"),
  };
}

function parseRunDominantFailure(
  value: unknown,
): NonNullable<DesktopRuntimeRunInspection["diagnosis"]["dominantFailure"]> {
  const failure = requireRecord(value, "operator run view.diagnosis.dominantFailure");
  return {
    classification: requireString(
      failure.classification,
      "operator run view.diagnosis.dominantFailure.classification",
    ),
    message: requireString(
      failure.message,
      "operator run view.diagnosis.dominantFailure.message",
    ),
  };
}

function parseRunWait(
  value: unknown,
): NonNullable<DesktopRuntimeRunInspection["diagnosis"]["wait"]> {
  const wait = requireRecord(value, "operator run view.diagnosis.wait");
  if (
    wait.kind !== "approval"
    && wait.kind !== "user_input"
    && wait.kind !== "delegation"
    && wait.kind !== "scheduler_wait"
    && wait.kind !== "compaction_checkpoint"
    && wait.kind !== "unknown"
  ) {
    throw new Error("operator run view.diagnosis.wait.kind is invalid.");
  }
  return {
    kind: wait.kind,
    actionable: requireBoolean(
      wait.actionable,
      "operator run view.diagnosis.wait.actionable",
    ),
    ...optionalField(wait.eventType, "operator run view.diagnosis.wait.eventType", "eventType"),
    ...optionalField(wait.threadId, "operator run view.diagnosis.wait.threadId", "threadId"),
    ...optionalField(
      wait.delegationId,
      "operator run view.diagnosis.wait.delegationId",
      "delegationId",
    ),
    ...optionalField(wait.requestId, "operator run view.diagnosis.wait.requestId", "requestId"),
    ...optionalTimestampField(
      wait.enteredAt,
      "operator run view.diagnosis.wait.enteredAt",
      "enteredAt",
    ),
  };
}

function parseRunLatestReasoning(
  value: unknown,
): NonNullable<DesktopRuntimeRunInspection["diagnosis"]["latestReasoning"]> {
  const reasoning = requireRecord(value, "operator run view.diagnosis.latestReasoning");
  return {
    message: requireString(
      reasoning.message,
      "operator run view.diagnosis.latestReasoning.message",
    ),
    at: requireTimestamp(reasoning.at, "operator run view.diagnosis.latestReasoning.at"),
  };
}

function parseRunTimelineEntry(
  value: unknown,
  index: number,
): DesktopRuntimeRunTimelineEntry {
  const label = `operator run view.timeline[${index}]`;
  const entry = requireRecord(value, label);
  return {
    seq: requirePositiveInteger(entry.seq, `${label}.seq`),
    at: requireTimestamp(entry.at, `${label}.at`),
    label: requireString(entry.label, `${label}.label`),
    ...optionalField(entry.detail, `${label}.detail`, "detail"),
    source: parseRunTimelineSource(entry.source, `${label}.source`),
    ...optionalField(entry.step, `${label}.step`, "step"),
    ...optionalIntegerField(entry.stepIndex, `${label}.stepIndex`, "stepIndex"),
  };
}

function parseRunTimelineSource(
  value: unknown,
  label: string,
): DesktopRuntimeRunTimelineEntry["source"] {
  if (
    value !== "engine"
    && value !== "agent"
    && value !== "wait"
    && value !== "scheduler"
    && value !== "terminal"
    && value !== "tooling"
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseRunDiagnosisStatus(
  value: unknown,
): DesktopRuntimeRunInspection["diagnosis"]["status"] {
  if (value === "UNKNOWN" || value === "STALLED") {
    return value;
  }
  return parseRunStatus(value, "operator run view.diagnosis.status");
}

function parseModelRetention(
  value: unknown,
): DesktopRuntimeRunInspection["modelProvenance"]["retention"] {
  if (value !== "hash_only") {
    throw new Error("operator run view.modelProvenance.retention is invalid.");
  }
  return value;
}

function parseStringArray(value: unknown, label: string): string[] {
  return requireArray(value, label)
    .map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function optionalField<Key extends string>(
  value: unknown,
  label: string,
  key: Key,
): { [Field in Key]?: string } {
  const parsed = optionalString(value, label);
  return parsed === undefined ? {} : { [key]: parsed } as { [Field in Key]?: string };
}

function optionalTimestampField<Key extends string>(
  value: unknown,
  label: string,
  key: Key,
): { [Field in Key]?: string } {
  if (value === undefined) {
    return {};
  }
  return { [key]: requireTimestamp(value, label) } as { [Field in Key]?: string };
}

function optionalIntegerField<Key extends string>(
  value: unknown,
  label: string,
  key: Key,
): { [Field in Key]?: number } {
  if (value === undefined) {
    return {};
  }
  return { [key]: requireNonNegativeInteger(value, label) } as { [Field in Key]?: number };
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireTimestamp(value: unknown, label: string): string {
  const parsed = requireString(value, label);
  const date = new Date(parsed);
  if (Number.isFinite(date.getTime()) === false) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return parsed;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isInteger(value) === false || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = requireNonNegativeInteger(value, label);
  if (parsed === 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function requireBoundedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  const parsed = requirePositiveInteger(value, label);
  if (parsed > maximum) {
    throw new Error(`${label} must be no greater than ${maximum}.`);
  }
  return parsed;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value) === false) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}
