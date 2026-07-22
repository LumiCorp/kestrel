import { createHash } from "node:crypto";

import type { RunEventType, RuntimeError, TransitionStatus } from "../kestrel/contracts/base.js";
import type { ProgressPhase } from "../kestrel/contracts/events.js";
import type { Transition } from "../kestrel/contracts/execution.js";
import type { ModelBudgetClass, ModelRequest } from "../kestrel/contracts/model-io.js";

import { DEFAULT_MODEL_TIMING_POLICY } from "../io/ModelTimingPolicy.js";
import { DEFAULT_TOOL_TIMING_POLICY, deriveShellRunTimeoutDecision } from "../io/ToolTimingPolicy.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { readHighConfidenceApprovalDecision, readUserReplyIntent } from "../runtime/userReplyIntent.js";
import {
  buildWaitResumeToken as buildRuntimeWaitResumeToken,
  type RuntimeWaitMatcher,
} from "../runtime/waitState.js";
import type {
  normalizeRetrievalGuardInput,
  normalizeRetrievalGuardOutput,
} from "./retrievalLoopGuard.js";

const DELIBERATOR_EXTERNAL_DEADLINE_CLOSEOUT_RESERVE_MS = 15_000;

export function readModelRequestSchemaName(request: ModelRequest): string | undefined {
  return (
    request.providerOptions?.openrouter?.responseSchemaName ??
    request.providerOptions?.openai?.responseSchemaName ??
    request.providerOptions?.anthropic?.responseSchemaName
  );
}

export function readModelBudgetClass(request: ModelRequest): ModelBudgetClass {
  const metadata = asPlainRecord(request.metadata);
  return metadata?.modelBudgetClass === "maintenance" ? "maintenance" : "action";
}

export const KNOWN_RUN_EVENT_TYPES = new Set<RunEventType>([
  "run.started",
  "run.resumed",
  "run.waiting",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "terminal.normalized",
  "step.selected",
  "step.started",
  "step.committed",
  "step.transitioned",
  "step.contract_failed",
  "effects.resumed",
  "effects.executed",
  "outbox.dispatched",
  "policy.checkpoint",
  "quality.computed",
  "progress.stage",
  "progress.tool",
  "progress.waiting",
  "progress.heartbeat",
  "reasoning.update",
  "tool.queue.enqueued",
  "tool.queue.dequeued",
  "tool.queue.overflow",
  "tool.validated",
  "tool.chunk.started",
  "tool.chunk.completed",
  "tool.result_summarized",
  "tool.retry",
  "model.requested",
  "model.completed",
  "decision.generated",
  "decision.compiled",
  "decision.policy_passed",
  "decision.rejected",
  "decision.executed",
  "route.decision",
  "route.override",
  "resolver.generated",
  "resolver.rejected",
  "resolver.bypassed",
  "planner.tool_intent_promoted",
  "planner.finalize_blocked",
  "mode.legacy_migrated",
  "clarification.triggered",
  "progress.blocked",
  "region.scheduled",
  "region.started",
  "region.completed",
  "region.synced",
  "region.merge_conflict",
  "region.scheduler.claimed",
  "region.scheduler.spawned",
  "region.scheduler.synced",
  "region.scheduler.waiting",
  "wait.entered",
  "wait.resumed",
  "run.continuation_requested",
  "run.continuation_granted",
  "run.continuation_declined",
  "context.compaction_armed",
  "context.compaction_applied",
  "context.adaptation_applied",
  "context.compaction_suppressed",
  "interaction.requested",
  "interaction.resolved",
  "approval.granted",
  "managed_worktree.approval_requested",
  "managed_worktree.auto_requested",
  "managed_worktree.created",
  "managed_worktree.reused",
  "managed_worktree.orphan_detected",
  "managed_worktree.orphan_reclaimed",
  "managed_worktree.rotated",
  "managed_worktree.blocked",
  "managed_worktree.bound",
  "managed_worktree.leased",
  "managed_worktree.lease_blocked",
  "managed_worktree.released",
  "managed_worktree.process_attached",
  "managed_worktree.process_released",
  "managed_worktree.fan_in_candidate",
  "managed_worktree.fan_in_applied",
  "runtime.state_persisted",
  "runtime.resume_blocked",
  "delegation.requested",
  "delegation.spawned",
  "delegation.progress",
  "dialog.opened",
  "dialog.message",
  "dialog.execution_failed",
  "dialog.execution_cancelled",
  "dialog.closed",
  "delegation.waiting",
  "delegation.completed",
  "delegation.failed",
  "loop.guard_triggered",
  "loop.stall_detected",
  "loop.stall_converted",
  "loop.stall_resumed",
  "migration.session_archived",
  "migration.session_migrated",
]);

export function buildContinuationNextActions(
  nextAction: Record<string, unknown> | undefined,
  currentStep: string,
): string[] {
  if (nextAction?.kind === "tool" && typeof nextAction.name === "string") {
    return [
      `Run ${nextAction.name} to gather the missing evidence.`,
      "Synthesize the new evidence into a final answer.",
    ];
  }
  if (nextAction?.kind === "tool_batch" && Array.isArray(nextAction.items)) {
    const toolNames = nextAction.items
      .map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          return ;
        }
        const record = item as Record<string, unknown>;
        return typeof record.name === "string" ? record.name : undefined;
      })
      .filter((value): value is string => value !== undefined)
      .slice(0, 2);
    if (toolNames.length > 0) {
      return [
        `Run ${toolNames.join(" and ")} to gather the remaining evidence.`,
        "Compare the collected results and finalize the answer.",
      ];
    }
  }
  if (nextAction?.kind === "ask_user") {
    return [
      "Process the resumed input and continue the task.",
      "Finalize once the remaining evidence is assembled.",
    ];
  }
  return [
    `Resume at ${currentStep} and continue gathering evidence.`,
    "Complete the final synthesis once the remaining checks are done.",
  ];
}

export function buildContinuationPartialAnswer(
  assistantText: string | undefined,
  lastObservation: string,
  completedSoFar: string[],
): string | undefined {
  if (assistantText !== undefined && assistantText.trim().length > 0) {
    return assistantText.trim();
  }
  if (lastObservation.trim().length > 0) {
    return lastObservation.trim();
  }
  if (completedSoFar.length === 0) {
    return ;
  }
  return `Current verified progress so far:\n- ${completedSoFar.join("\n- ")}`;
}

export function buildResearchStallPartialAnswer(input: {
  completedSoFar: string[];
  blockedOn: string;
  blockerLabel: string;
  nextIfContinued: string[];
}): string {
  const sections = [
    "Current verified progress so far:",
    ...input.completedSoFar.map((item) => `- ${item}`),
    "",
    `${input.blockerLabel}: ${input.blockedOn}`,
  ];
  if (input.nextIfContinued.length > 0) {
    sections.push("", "Next if you want me to continue:");
    sections.push(...input.nextIfContinued.map((item) => `- ${item}`));
  }
  return sections.join("\n");
}

export function isRecoverableDispatchLoopGuard(runtimeError: RuntimeError, currentStep: string | undefined): boolean {
  if (runtimeError.code !== "LOOP_GUARD_TRIGGERED") {
    return false;
  }
  const details = asPlainRecord(runtimeError.details);
  return currentStep === "agent.exec.dispatch" &&
    (details?.guardType === "IDENTICAL_CONTROL_STATE" ||
      details?.guardType === "NO_PROGRESS_REASONING_LOOP");
}

export function readNumeric(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  if (typeof candidate !== "number" || Number.isFinite(candidate) === false) {
    return ;
  }
  return candidate;
}

export function readMaybeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

export function summarizeUnknown(value: unknown, maxChars: number): string {
  try {
    const serialized = JSON.stringify(sortValue(value));
    if (serialized.length <= maxChars) {
      return serialized;
    }
    return `${serialized.slice(0, Math.max(0, maxChars - 3))}...`;
  } catch {
    return String(value).slice(0, maxChars);
  }
}

export function buildModelInputSnapshot(request: ModelRequest): Record<string, unknown> {
  const input = asPlainRecord(request.input);
  const inputKeys = input !== undefined ? Object.keys(input).sort((left, right) => left.localeCompare(right)) : [];
  return {
    inputKeys,
    ...(input !== undefined
      ? {
          payloadSections: summarizeModelInputSections(input),
        }
      : {}),
  };
}

function summarizeModelInputSections(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, summarizeModelInputSection(value)]),
  );
}

function summarizeModelInputSection(value: unknown): Record<string, unknown> {
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const serialized = summarizeUnknown(value, Number.MAX_SAFE_INTEGER);
  return {
    type,
    serializedLength: serialized.length,
    omittedFromPayload: false,
    clippedInPayload: false,
    snapshotPreviewClipped: serialized.length > 4000,
  };
}

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}

export function stableHash(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "undefined";
}

export function hashUnknown(value: unknown): string {
  return createHash("sha256").update(stableHash(value)).digest("hex");
}

export function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function buildToolInputEventMetadata(input: unknown): Record<string, unknown> {
  return {
    toolInput: sortValue(input),
    toolInputHash: stableHash(input),
  };
}

export function applyExternalDeadlineToolBudget(input: {
  toolName: string;
  input: unknown;
  runtimeBudgetRemainingMs: number;
}): {
  input: unknown;
  metadata: Record<string, unknown>;
  shortCircuitResult?: unknown | undefined;
} {
  if (input.toolName === "exec_command") {
    return applyExecCommandObservationBudget(input.input, input.runtimeBudgetRemainingMs);
  }
  if (input.toolName !== "dev.shell.run") {
    return { input: input.input, metadata: {} };
  }
  const record = asPlainRecord(input.input);
  if (record === undefined) {
    return { input: input.input, metadata: {} };
  }
  const requestedTimeoutMs =
    typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
      ? record.timeoutMs
      : undefined;
  const decision = deriveShellRunTimeoutDecision({
    requestedTimeoutMs,
    remainingMs: input.runtimeBudgetRemainingMs,
  });
  if (decision.kind === "unchanged") {
    return { input: input.input, metadata: {} };
  }
  if (decision.kind === "clamped") {
    const adjustedInput = {
      ...record,
      timeoutMs: decision.deadlineAdjustedTimeoutMs,
    };
    return {
      input: adjustedInput,
      metadata: {
        requestedTimeoutMs: decision.requestedTimeoutMs,
        deadlineAdjustedTimeoutMs: decision.deadlineAdjustedTimeoutMs,
        runtimeBudgetRemainingMs: decision.remainingMs,
        toolCloseoutReserveMs: decision.closeoutReserveMs,
      },
    };
  }

  return {
    input: input.input,
    metadata: {
      ...(decision.requestedTimeoutMs !== undefined
        ? { requestedTimeoutMs: decision.requestedTimeoutMs }
        : {}),
      runtimeBudgetRemainingMs: decision.remainingMs,
      toolCloseoutReserveMs: decision.closeoutReserveMs,
      minToolDispatchMs: decision.minDispatchMs,
      toolDeadlineAdmission: "deadline_exhausted",
    },
    shortCircuitResult: buildDevShellRunDeadlineFailureResult(record, decision.failureReason),
  };
}

function applyExecCommandObservationBudget(
  value: unknown,
  runtimeBudgetRemainingMs: number,
): {
  input: unknown;
  metadata: Record<string, unknown>;
  shortCircuitResult?: unknown | undefined;
} {
  const record = asPlainRecord(value);
  if (record === undefined || record.stop === true || Number.isFinite(runtimeBudgetRemainingMs) === false) {
    return { input: value, metadata: {} };
  }
  const remainingMs = Math.max(0, Math.floor(runtimeBudgetRemainingMs));
  const availableMs = Math.max(0, remainingMs - DEFAULT_TOOL_TIMING_POLICY.closeoutReserveMs);
  if (availableMs < DEFAULT_TOOL_TIMING_POLICY.minDispatchMs) {
    const failureReason =
      "Not enough external runtime budget remains to dispatch exec_command " +
      `(${remainingMs}ms remaining, ${DEFAULT_TOOL_TIMING_POLICY.closeoutReserveMs}ms reserved for closeout).`;
    return {
      input: value,
      metadata: {
        runtimeBudgetRemainingMs: remainingMs,
        toolCloseoutReserveMs: DEFAULT_TOOL_TIMING_POLICY.closeoutReserveMs,
        minToolDispatchMs: DEFAULT_TOOL_TIMING_POLICY.minDispatchMs,
        toolDeadlineAdmission: "deadline_exhausted",
      },
      shortCircuitResult: {
        status: "failed",
        output: `${failureReason}\n`,
        durationMs: 0,
        truncated: false,
        exitCode: 124,
        failureReason,
        ...(typeof record.command === "string" ? { command: record.command } : {}),
        ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
      },
    };
  }
  const defaultObservationMs = typeof record.command === "string" ? 5000 : 1000;
  const requestedObservationMs = typeof record.yieldTimeMs === "number" && Number.isFinite(record.yieldTimeMs)
    ? Math.max(0, Math.floor(record.yieldTimeMs))
    : defaultObservationMs;
  const adjustedObservationMs = Math.min(requestedObservationMs, availableMs);
  if (adjustedObservationMs === requestedObservationMs) {
    return { input: value, metadata: {} };
  }
  return {
    input: {
      ...record,
      yieldTimeMs: adjustedObservationMs,
    },
    metadata: {
      requestedYieldTimeMs: requestedObservationMs,
      deadlineAdjustedYieldTimeMs: adjustedObservationMs,
      runtimeBudgetRemainingMs: remainingMs,
      toolCloseoutReserveMs: DEFAULT_TOOL_TIMING_POLICY.closeoutReserveMs,
    },
  };
}

export function buildDevShellRunDeadlineFailureResult(
  input: Record<string, unknown>,
  failureReason: string,
): Record<string, unknown> {
  return {
    status: "FAILED",
    stdout: `${failureReason}\n`,
    text: `${failureReason}\n`,
    truncated: false,
    exitCode: 124,
    failureReason,
    ...(typeof input.command === "string" ? { command: input.command } : {}),
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
    ...(typeof input.workspaceRoot === "string" ? { workspaceRoot: input.workspaceRoot } : {}),
  };
}

export function latestObservationSummary(value: unknown): string {
  if (Array.isArray(value) === false || value.length === 0) {
    return "";
  }
  const last = value[value.length - 1];
  if (typeof last !== "object" || last === null || Array.isArray(last)) {
    return "";
  }
  const summary = (last as Record<string, unknown>).summary;
  return typeof summary === "string" ? summary : "";
}

export function readCapabilityClassesFromFeedback(reactState: Record<string, unknown>): string[] {
  const capabilities = new Set<string>();
  const add = (value: unknown): void => {
    if (Array.isArray(value) === false) {
      return;
    }
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }
      const normalized = item.trim();
      if (normalized.length > 0) {
        capabilities.add(normalized);
      }
    }
  };
  if (Array.isArray(reactState.observations)) {
    for (const item of reactState.observations) {
      add(asPlainRecord(item)?.capabilityClasses);
    }
  }
  const lastActionResult = asPlainRecord(reactState.lastActionResult);
  add(lastActionResult?.capabilityClasses);
  const resultItems = Array.isArray(lastActionResult?.items) ? lastActionResult.items : [];
  for (const item of resultItems) {
    add(asPlainRecord(item)?.capabilityClasses);
  }
  return [...capabilities].sort((left, right) => left.localeCompare(right));
}

export function normalizeAgentFeedbackForLoopGuard(reactState: Record<string, unknown>): Record<string, unknown> {
  const lastActionResult = asPlainRecord(reactState.lastActionResult);
  return {
    capabilities: readCapabilityClassesFromFeedback(reactState),
    lastActionResultKind: typeof lastActionResult?.kind === "string" ? lastActionResult.kind : "",
    lastActionResultStatus: typeof lastActionResult?.status === "string" ? lastActionResult.status : "",
    lastActionTool:
      typeof lastActionResult?.toolName === "string"
        ? lastActionResult.toolName
        : typeof lastActionResult?.name === "string"
          ? lastActionResult.name
          : "",
  };
}

export function readLatestEvidenceLedgerEntry(value: unknown): unknown {
  if (Array.isArray(value) === false || value.length === 0) {
    return ;
  }
  const entry = asPlainRecord(value[value.length - 1]);
  if (entry === undefined) {
    return ;
  }
  const target = asPlainRecord(entry.target);
  const nextUse = asPlainRecord(entry.nextUse);
  return {
    id: typeof entry.id === "string" ? entry.id : "",
    kind: typeof entry.kind === "string" ? entry.kind : "",
    status: typeof entry.status === "string" ? entry.status : "",
    summary: typeof entry.summary === "string" ? entry.summary : "",
    targetType: typeof target?.type === "string" ? target.type : "",
    targetValue: typeof target?.value === "string" ? target.value : "",
    requiresAction: typeof nextUse?.requiresAction === "string" ? nextUse.requiresAction : "",
    blocks: typeof nextUse?.blocks === "string" ? nextUse.blocks : "",
  };
}

export function buildStateTransitionLogMetadata(input: {
  step: string;
  nextStepAgent?: string | undefined;
  transitionStatus: TransitionStatus;
  stateNode?: unknown;
  previousState: Record<string, unknown>;
  nextState: Record<string, unknown>;
  statePatch: Record<string, unknown>;
}): Record<string, unknown> {
  const previousReact = hydrateReactForTransitionLog(input.previousState);
  const nextReact = hydrateReactForTransitionLog(input.nextState);
  const patchReact = hydrateReactForTransitionLog(input.statePatch);

  const previous = compactReactStateForTransitionLog(previousReact);
  const next = compactReactStateForTransitionLog(nextReact);
  return {
    step: input.step,
    nextStepAgent: input.nextStepAgent,
    transitionStatus: input.transitionStatus,
    stateNode: input.stateNode,
    changed: {
      phase: previous.phase !== next.phase,
      feedbackEvidence:
        stableHashForTransitionLog(normalizeAgentFeedbackForLoopGuard(previous)) !==
          stableHashForTransitionLog(normalizeAgentFeedbackForLoopGuard(next)),
      nextAction:
        stableHashForTransitionLog(previous.nextAction) !== stableHashForTransitionLog(next.nextAction),
      evidenceLedger: previous.evidenceLedgerCount !== next.evidenceLedgerCount ||
        stableHashForTransitionLog(previous.latestEvidence) !==
          stableHashForTransitionLog(next.latestEvidence),
    },
    previous,
    next,
    patch: {
      statePatchKeys: Object.keys(input.statePatch).sort((left, right) => left.localeCompare(right)),
      reactKeys: Object.keys(patchReact).sort((left, right) => left.localeCompare(right)),
      hasNextAction: Object.hasOwn(patchReact, "nextAction"),
      hasEvidenceLedger: Object.hasOwn(input.statePatch, "evidenceLedger"),
    },
  };
}

export function compactReactStateForTransitionLog(reactState: Record<string, unknown>): Record<string, unknown> {
  return {
    phase: typeof reactState.phase === "string" ? reactState.phase : "",
    nextAction: compactActionForStateTransitionLog(reactState.nextAction),
    evidenceLedgerCount: Array.isArray(reactState.evidenceLedger) ? reactState.evidenceLedger.length : 0,
    latestEvidence: readLatestEvidenceLedgerEntry(reactState.evidenceLedger),
  };
}

function hydrateReactForTransitionLog(state: Record<string, unknown>): Record<string, unknown> {
  const react = asPlainRecord(state.agent) ?? {};
  return {
    ...react,
    ...(Array.isArray(state.evidenceLedger) ? { evidenceLedger: state.evidenceLedger } : {}),
  };
}

export function compactActionForStateTransitionLog(value: unknown): unknown {
  const action = asPlainRecord(value);
  if (action === undefined) {
    return ;
  }
  const input = asPlainRecord(action.input);
  return {
    kind: typeof action.kind === "string" ? action.kind : "",
    name:
      typeof action.name === "string"
        ? action.name
        : typeof action.type === "string"
          ? action.type
          : "",
    processId: typeof input?.processId === "string" ? input.processId : "",
    path: typeof input?.path === "string" ? input.path : "",
    command: typeof input?.command === "string" ? truncateTransitionLogText(input.command, 240) : "",
    inputHash: input === undefined ? "" : stableHashForTransitionLog(input),
    itemCount: Array.isArray(action.items) ? action.items.length : undefined,
  };
}

export function truncateTransitionLogText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function stableHashForTransitionLog(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "";
}

export function readLoopHistory(
  value: unknown,
): Array<{
  stepName: string;
  fingerprint: string;
  evidenceHash: string;
  observationMarker: string;
  waitToken: string;
  pendingExecutionHash: string;
  actionSignature: string;
  cycleKind: string;
  toolActionName: string;
  toolActionInputHash: string;
  toolActionSourceCluster: string;
  toolActionLowYield: boolean;
  retrievalToolName?: string | undefined;
  retrievalInput?: ReturnType<typeof normalizeRetrievalGuardInput> | undefined;
  retrievalOutput?: ReturnType<typeof normalizeRetrievalGuardOutput> | undefined;
}> {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.fingerprint !== "string" ||
      typeof record.evidenceHash !== "string" ||
      typeof record.observationMarker !== "string"
    ) {
      return [];
    }
    return [{
      stepName: typeof record.stepName === "string" ? record.stepName : "",
      fingerprint: record.fingerprint,
      evidenceHash: record.evidenceHash,
      observationMarker: record.observationMarker,
      waitToken: typeof record.waitToken === "string" ? record.waitToken : "",
      pendingExecutionHash:
        typeof record.pendingExecutionHash === "string" ? record.pendingExecutionHash : "",
      actionSignature: typeof record.actionSignature === "string" ? record.actionSignature : "",
      cycleKind: typeof record.cycleKind === "string" ? record.cycleKind : "",
      toolActionName: typeof record.toolActionName === "string" ? record.toolActionName : "",
      toolActionInputHash:
        typeof record.toolActionInputHash === "string" ? record.toolActionInputHash : "",
      toolActionSourceCluster:
        typeof record.toolActionSourceCluster === "string" ? record.toolActionSourceCluster : "",
      toolActionLowYield: record.toolActionLowYield === true,
      ...(typeof record.retrievalToolName === "string"
        ? {
            retrievalToolName: record.retrievalToolName,
            retrievalInput: readNormalizedRetrievalInput(record.retrievalInput),
            retrievalOutput: readNormalizedRetrievalOutput(record.retrievalOutput),
          }
        : {}),
    }];
  });
}

export function readNormalizedRetrievalInput(
  value: unknown,
): ReturnType<typeof normalizeRetrievalGuardInput> | undefined {
  const record = asPlainRecord(value);
  const toolName = typeof record?.toolName === "string" ? record.toolName : undefined;
  const primaryText = typeof record?.primaryText === "string" ? record.primaryText : undefined;
  const comparableFields = asPlainRecord(record?.comparableFields);
  if (toolName === undefined || primaryText === undefined || comparableFields === undefined) {
    return ;
  }
  const normalizedComparableFields: Record<string, string> = {};
  for (const [key, entry] of Object.entries(comparableFields)) {
    if (typeof entry === "string") {
      normalizedComparableFields[key] = entry;
    }
  }
  return {
    toolName,
    primaryText,
    comparableFields: normalizedComparableFields,
  };
}

export function readNormalizedRetrievalOutput(
  value: unknown,
): ReturnType<typeof normalizeRetrievalGuardOutput> | undefined {
  const record = asPlainRecord(value);
  if (record === undefined) {
    return ;
  }
  return {
    topUrls: readStringArray(record.topUrls),
    topDomains: readStringArray(record.topDomains),
    topSignals: readStringArray(record.topSignals),
  };
}

export function readResearchObjective(reactState: Record<string, unknown>): string | undefined {
  const goal = typeof reactState.goal === "string" ? reactState.goal.trim() : "";
  if (goal.length > 0) {
    return goal;
  }
  const plan = asPlainRecord(reactState.plan);
  const intent = typeof plan?.intent === "string" ? plan.intent.trim() : "";
  return intent.length > 0 ? intent : undefined;
}

export function readActiveToolName(reactState: Record<string, unknown>): string | undefined {
  const nextAction = asPlainRecord(reactState.nextAction);
  if (nextAction?.kind === "tool" && typeof nextAction.name === "string") {
    return nextAction.name;
  }
  const lastActionResult = asPlainRecord(reactState.lastActionResult);
  if (typeof lastActionResult?.name === "string") {
    return lastActionResult.name;
  }
  if (typeof lastActionResult?.toolName === "string") {
    return lastActionResult.toolName;
  }
  const exec = asPlainRecord(reactState.exec);
  const dispatchReuseGuard = asPlainRecord(exec?.dispatchReuseGuard);
  return typeof dispatchReuseGuard?.toolName === "string"
    ? dispatchReuseGuard.toolName
    : undefined;
}

export function readLastToolSnapshot(
  reactState: Record<string, unknown>,
): { lastToolName?: string | undefined; lastToolInputHash?: string | undefined } {
  const lastActionResult = asPlainRecord(reactState.lastActionResult);
  const toolName =
    typeof lastActionResult?.toolName === "string"
      ? lastActionResult.toolName
      : typeof lastActionResult?.name === "string"
        ? lastActionResult.name
        : undefined;
  const input =
    asPlainRecord(lastActionResult?.input) ??
    asPlainRecord(asPlainRecord(reactState.nextAction)?.input);
  return {
    ...(toolName !== undefined ? { lastToolName: toolName } : {}),
    ...(input !== undefined ? { lastToolInputHash: stableHash(sortValue(input)) } : {}),
  };
}

export function readTruncatedToolArtifactsForResume(
  lastActionResult: unknown,
):
  | {
      artifactIds: string[];
      digestArtifactIds: string[];
      digestSummaries: Record<string, unknown>[];
    }
  | undefined {
  const lastAction = asPlainRecord(lastActionResult);
  if (lastAction === undefined) {
    return ;
  }

  const outputs: Record<string, unknown>[] = [];
  const directOutput = asPlainRecord(lastAction.output);
  if (directOutput !== undefined) {
    outputs.push(directOutput);
  }
  const itemOutputs = (Array.isArray(lastAction.items) ? lastAction.items : [])
    .map((item) => asPlainRecord(asPlainRecord(item)?.output))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  outputs.push(...itemOutputs);

  const truncatedOutputs = outputs.filter((output) => output.truncated === true);
  if (truncatedOutputs.length === 0) {
    return ;
  }

  const artifactIds = [
    ...new Set(
      truncatedOutputs.flatMap((output) =>
        (Array.isArray(output.artifactIds) ? output.artifactIds : [])
          .map((entry) => (typeof entry === "string" ? entry : undefined))
          .filter((entry): entry is string => entry !== undefined && entry.trim().length > 0),
      ),
    ),
  ];
  if (artifactIds.length === 0) {
    return ;
  }
  const digestArtifactIds = [
    ...new Set(
      truncatedOutputs
        .map((output) =>
          typeof output.digestArtifactId === "string" && output.digestArtifactId.trim().length > 0
            ? output.digestArtifactId
            : undefined)
        .filter((entry): entry is string => entry !== undefined),
    ),
  ];
  const digestSummaries = truncatedOutputs
    .map((output) => asPlainRecord(output.digestSummary))
    .filter((summary): summary is Record<string, unknown> => summary !== undefined)
    .slice(0, 5);

  return {
    artifactIds,
    digestArtifactIds,
    digestSummaries,
  };
}

export function countTrailingLoopCyclesWithSameEvidence(history: ReturnType<typeof readLoopHistory>): number {
  let evidenceHash: string | undefined;
  let repeats = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.stepName !== "agent.loop") {
      continue;
    }
    if (evidenceHash === undefined) {
      evidenceHash = entry.evidenceHash;
      repeats = 1;
      continue;
    }
    if (entry.evidenceHash !== evidenceHash) {
      break;
    }
    repeats += 1;
  }
  return repeats;
}

export function buildWaitResumeToken(
  waitFor: Transition["waitFor"],
  resumeStepAgent: string | undefined,
): string {
  return buildRuntimeWaitResumeToken({
    waitFor: toRuntimeWaitMatcher(waitFor),
    resumeStepAgent,
  });
}

export function toRuntimeWaitMatcher(waitFor: Transition["waitFor"]): RuntimeWaitMatcher | undefined {
  if (waitFor === undefined || waitFor.kind === undefined) {
    return ;
  }
  return {
    kind: waitFor.kind,
    eventType: waitFor.eventType,
    ...(waitFor.timeoutMs !== undefined ? { timeoutMs: waitFor.timeoutMs } : {}),
    ...(waitFor.metadata !== undefined ? { metadata: waitFor.metadata } : {}),
  };
}

export function resolveLegacyExecutionStep(reactState: Record<string, unknown>): string {
  const exec = asPlainRecord(reactState.exec);
  const pendingEffectKey =
    typeof exec?.pendingEffectKey === "string" ? exec.pendingEffectKey : reactState.pendingEffectKey;
  if (typeof pendingEffectKey === "string" && pendingEffectKey.trim().length > 0) {
    return "agent.exec.wait_effect";
  }
  if (
    typeof (exec?.pendingApproval ?? reactState.pendingApproval) === "object" &&
    (exec?.pendingApproval ?? reactState.pendingApproval) !== null &&
    Array.isArray(exec?.pendingApproval ?? reactState.pendingApproval) === false
  ) {
    return "agent.exec.wait_approval";
  }
  if (
    typeof reactState.waitingFor === "object" &&
    reactState.waitingFor !== null &&
    Array.isArray(reactState.waitingFor) === false
  ) {
    return "agent.exec.wait_user";
  }
  const nextAction = asPlainRecord(reactState.nextAction);
  const kind = typeof nextAction?.kind === "string" ? nextAction.kind : "";
  if (kind === "finalize" || kind === "cannot_satisfy") {
    return "agent.exec.finalize";
  }
  return "agent.exec.dispatch";
}

export function resolveExecSubstateForStep(stepAgent: string): string | undefined {
  if (stepAgent.startsWith("agent.exec.")) {
    return stepAgent.slice("agent.exec.".length);
  }
  return ;
}

export function resolveTerminalReasonCode(
  reactPatch: Record<string, unknown>,
  status: "COMPLETED" | "FAILED",
): string {
  if (status === "FAILED") {
    return "runtime_failure";
  }
  const nextAction = asPlainRecord(reactPatch.nextAction);
  const kind = typeof nextAction?.kind === "string" ? nextAction.kind : "";
  if (kind === "cannot_satisfy") {
    return nextAction !== undefined && typeof nextAction.reasonCode === "string"
      ? nextAction.reasonCode
      : "cannot_satisfy";
  }
  if (kind === "finalize" && nextAction !== undefined && typeof nextAction.finalizeReason === "string") {
    return nextAction.finalizeReason;
  }
  return "completed";
}

export function readRequestedModelProvider(request: ModelRequest): string | undefined {
  const metadata = asPlainRecord(request.metadata);
  if (typeof metadata?.requestedProvider === "string" && metadata.requestedProvider.trim().length > 0) {
    return metadata.requestedProvider.trim();
  }
  const providerOptions = asPlainRecord(request.providerOptions);
  const configuredProviders = providerOptions === undefined
    ? []
    : Object.keys(providerOptions).filter((key) => asPlainRecord(providerOptions[key]) !== undefined);
  if (configuredProviders.length === 1) {
    return configuredProviders[0];
  }
  if (typeof request.model === "string") {
    const separatorIndex = request.model.indexOf("/");
    if (separatorIndex > 0) {
      return request.model.slice(0, separatorIndex);
    }
  }
  return ;
}

export function assertModelCallAdmission(input: {
  remainingMs: number;
  phase: ProgressPhase;
  stepAgent: string;
}): void {
  if (
    Number.isFinite(input.remainingMs) === false ||
    input.remainingMs >= Number.MAX_SAFE_INTEGER / 2
  ) {
    return;
  }
  const minimumRequiredMs =
    DEFAULT_MODEL_TIMING_POLICY.minTimeoutMs +
    DEFAULT_MODEL_TIMING_POLICY.reserveMs +
    (input.stepAgent === "agent.loop" ? DELIBERATOR_EXTERNAL_DEADLINE_CLOSEOUT_RESERVE_MS : 0);
  if (input.remainingMs > minimumRequiredMs) {
    return;
  }
  throw createRuntimeFailure(
    "RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED",
    `Not enough external runtime budget remains to start another decision model call (${Math.max(0, Math.round(input.remainingMs))}ms remaining).`,
    {
      subsystem: "runtime",
      classification: "runtime",
      recoverable: false,
      remainingMs: input.remainingMs,
      minimumRequiredMs,
      phase: input.phase,
      stepAgent: input.stepAgent,
    },
  );
}

export function isDevShellConsoleTool(toolName: string): boolean {
  return toolName === "exec_command" || toolName === "dev.shell.run" || toolName.startsWith("dev.process.");
}

export function readConsoleCommand(value: unknown): string | undefined {
  const record = asPlainRecord(value);
  const command = record?.command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

export function readConsoleCwd(value: unknown): string | undefined {
  const record = asPlainRecord(value);
  const cwd = record?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

export function readConsoleProcessId(value: unknown): string | undefined {
  const record = asPlainRecord(value);
  const processId = record?.processId;
  return typeof processId === "string" && processId.length > 0 ? processId : undefined;
}

export function readConsoleExitCode(value: unknown): number | undefined {
  const record = asPlainRecord(value);
  const exitCode = record?.exitCode;
  return typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : undefined;
}

export function parseApprovalDecisionFromPayload(payload: unknown): "approve" | "deny" | undefined {
  return readHighConfidenceApprovalDecision(readUserReplyIntent(asPlainRecord(payload)?.userReplyIntent));
}

export function takeUtf8Prefix(value: string, maxBytes: number): {
  text: string;
  byteLength: number;
  truncated: boolean;
} {
  if (maxBytes <= 0) {
    return {
      text: "",
      byteLength: 0,
      truncated: value.length > 0,
    };
  }
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return {
      text: value,
      byteLength: buffer.byteLength,
      truncated: false,
    };
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  const text = buffer.subarray(0, end).toString("utf8");
  return {
    text,
    byteLength: Buffer.byteLength(text, "utf8"),
    truncated: true,
  };
}

export function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}
