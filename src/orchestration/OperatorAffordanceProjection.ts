import type { NormalizedOutput } from "../kestrel/contracts/execution.js";

import type {
  ActSubmode,
  ExecutionPolicyOverride,
  InteractionMode,
  ToolExecutionClass,
} from "../mode/contracts.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  normalizeInteractionMode,
  resolveAllowedToolClasses,
} from "../mode/contracts.js";
import type { ModelProviderId } from "../profile/runtimeProfile.js";
import { extractWaitDetail, extractWaitPrompt } from "../runtime/waitForPrompt.js";
import { readActiveWaitState } from "../runtime/waitState.js";
import type {
  OperatorAssemblySummary,
  OperatorCheckpointSummary,
  OperatorChildBlockerChainSummary,
  OperatorChildBlockerSummary,
  OperatorEvidenceRecoverySummary,
  OperatorFanInDispositionSummary,
  OperatorInboxSummary,
  OperatorReasoningSummary,
  OperatorRuntimePlanSummary,
  OperatorSteeringSummary,
  OperatorSupervisedChildSummary,
  OperatorSupervisionSummary,
  OperatorAdaptationSummary,
  OperatorSessionProjection,
} from "./OperatorSessionProjection.js";
import type { OperatorChildResultSummary } from "./contracts.js";

export type OperatorCompactionState = "idle" | "armed" | "applied" | "suppressed";

export interface OperatorContextSummary {
  promptBudgetChars: number;
  estimatedChars: number;
  degradationMode: "full" | "compact" | "minimal";
  droppedSections: string[];
  compactionState?: OperatorCompactionState | undefined;
  compactionReason?: string | undefined;
  manualCompactionApplied?: boolean | undefined;
  manualCompactionArmed?: boolean | undefined;
}

export interface OperatorBlockReason {
  code: string;
  summary: string;
  details?: Record<string, unknown> | undefined;
}

export interface OperatorRecommendedAction {
  code: string;
  summary: string;
}

export interface OperatorWaitSummary {
  eventType: string;
  prompt?: string | undefined;
  detail?: string | undefined;
}

export interface OperatorTaskInboxSummary {
  total: number;
  active: number;
  waiting: number;
  completed: number;
  failed: number;
}

export interface OperatorAffordancePayload {
  interactionMode: InteractionMode;
  actSubmode?: ActSubmode | undefined;
  allowedToolClasses?: ToolExecutionClass[] | undefined;
  blockReason?: OperatorBlockReason | undefined;
  recommendedAction?: OperatorRecommendedAction | undefined;
  context?: OperatorContextSummary | undefined;
  wait?: OperatorWaitSummary | undefined;
  provider?:
    | {
        id: ModelProviderId;
        model: string;
      }
    | undefined;
  activeSkillPack?:
    | {
        id: string;
        label: string;
        allowedTools: string[];
      }
    | undefined;
  assembly?: OperatorAssemblySummary | undefined;
  focusedThreadId?: string | undefined;
  inbox?: OperatorInboxSummary | undefined;
  latestCheckpoint?: OperatorCheckpointSummary | undefined;
  latestCheckpointDisposition?: OperatorCheckpointSummary["status"] | undefined;
  latestFanInDisposition?: OperatorFanInDispositionSummary | undefined;
  supervision?: OperatorSupervisionSummary | undefined;
  childBlocker?: OperatorChildBlockerSummary | undefined;
  childThreads?: OperatorSupervisedChildSummary[] | undefined;
  childResults?: OperatorChildResultSummary[] | undefined;
  childBlockerChainDetails?: OperatorChildBlockerChainSummary[] | undefined;
  blockerChain?: string[] | undefined;
  dominantBlocker?: string | undefined;
  contextPosture?: string | undefined;
  latestSteering?: OperatorSteeringSummary | undefined;
  latestReasoning?: OperatorReasoningSummary | undefined;
  latestAdaptation?: OperatorAdaptationSummary | undefined;
  latestEvidenceRecovery?: OperatorEvidenceRecoverySummary | undefined;
  nextAction?: string | undefined;
  runtimePlan?: OperatorRuntimePlanSummary | undefined;
  taskInbox?: OperatorTaskInboxSummary | undefined;
}

export function buildRuntimeOperatorAffordance(input: {
  reactState: Record<string, unknown> | undefined;
  turn: {
    interactionMode?: string | undefined;
    actSubmode?: string | undefined;
    executionPolicy?: ExecutionPolicyOverride | undefined;
    manualCompaction?: boolean | undefined;
    autoCompaction?:
      | {
          enabled?: boolean | undefined;
          state?: string | undefined;
          suppressOnce?: boolean | undefined;
        }
      | undefined;
  };
  output: NormalizedOutput;
  activeAssembly?: OperatorAffordancePayload["assembly"] | undefined;
}): OperatorAffordancePayload {
  const reactState = input.reactState;
  const modeResolution = normalizeInteractionMode({
    interactionMode: asString(reactState?.interactionMode) ?? input.turn.interactionMode,
    actSubmode: asString(reactState?.actSubmode) ?? input.turn.actSubmode,
    defaultInteractionMode: DEFAULT_INTERACTION_MODE,
    defaultActSubmode: DEFAULT_ACT_SUBMODE,
  });
  const executionPolicy =
    readExecutionPolicy(reactState?.executionPolicy) ?? input.turn.executionPolicy;
  const waitFor = input.output.waitFor ?? readWaitFor(readActiveWaitState(reactState));
  const blockReason = deriveOperatorBlockReason(waitFor);
  const context = readOperatorContextSummary(asRecord(asRecord(reactState?.contextCache)?.contextTelemetry));
  const runtimePlan = readOperatorRuntimePlanSummary(reactState);

  return {
    interactionMode: modeResolution.interactionMode,
    ...(modeResolution.actSubmode !== undefined ? { actSubmode: modeResolution.actSubmode } : {}),
    allowedToolClasses: resolveAllowedToolClasses(modeResolution, executionPolicy),
    ...(blockReason !== undefined ? { blockReason } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(waitFor !== undefined
      ? {
          wait: buildOperatorWaitSummary(waitFor),
        }
      : {}),
    ...(input.activeAssembly !== undefined ? { assembly: input.activeAssembly } : {}),
    ...(runtimePlan !== undefined ? { runtimePlan } : {}),
    recommendedAction: deriveOperatorRecommendedAction(waitFor, blockReason, context),
  };
}

export function buildOperatorAffordanceFromSessionProjection(input: {
  session: {
    interactionMode?: string | undefined;
    actSubmode?: string | undefined;
    executionPolicy?: ExecutionPolicyOverride | undefined;
  };
  projection: Pick<
    OperatorSessionProjection,
    | "sessionId"
    | "waitFor"
    | "activeAssembly"
    | "operatorInbox"
    | "childBlocker"
    | "childThreads"
    | "childBlockerChainDetails"
    | "blockerChain"
    | "dominantBlocker"
    | "latestCheckpoint"
    | "latestCheckpointDisposition"
    | "latestFanInDisposition"
    | "latestSteering"
    | "latestReasoning"
    | "latestAdaptation"
    | "latestEvidenceRecovery"
    | "supervision"
    | "nextAction"
    | "contextPosture"
    | "focusedThreadId"
    | "operatorThreadView"
  >;
}): OperatorAffordancePayload {
  const operatorView = input.projection.operatorThreadView;
  const dominantBlocker =
    input.projection.dominantBlocker ??
    (operatorView?.childBlocker !== undefined
      ? `child:${operatorView.childBlocker.childThreadId} status:${operatorView.childBlocker.status.toLowerCase()}`
      : operatorView?.activeWait?.detail ?? undefined);
  const blockerChain =
    input.projection.blockerChain ??
    (operatorView?.activeWait?.lineage !== undefined
      ? [...operatorView.activeWait.lineage]
      : undefined);
  const childBlockerChainDetails =
    input.projection.childBlockerChainDetails ??
    (operatorView?.childBlockerChain !== undefined
      ? operatorView.childBlockerChain.map((entry) => ({
          threadId: entry.threadId,
          title: entry.title,
          status: entry.status,
          ...(entry.delegationId !== undefined ? { delegationId: entry.delegationId } : {}),
          ...(entry.waitEventType !== undefined ? { waitEventType: entry.waitEventType } : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        }))
      : undefined);
  const childThreads =
    input.projection.childThreads ??
    (operatorView?.childThreads !== undefined
      ? operatorView.childThreads.map((child) => ({
          threadId: child.threadId,
          title: child.title,
          status: child.status,
          updatedAt: child.updatedAt,
          ...(child.waitFor?.eventType !== undefined ? { waitEventType: child.waitFor.eventType } : {}),
          ...(child.lastRunStatus !== undefined ? { lastRunStatus: child.lastRunStatus } : {}),
        }))
      : undefined);
  const nextAction = input.projection.nextAction ?? operatorView?.nextAction?.summary;
  const checkpointDisposition =
    input.projection.latestCheckpointDisposition ??
    operatorView?.latestCheckpointDisposition?.status ??
    operatorView?.latestCheckpoint?.status;
  const contextPosture =
    input.projection.contextPosture ??
    (operatorView?.latestCheckpoint !== undefined
      ? `checkpoint:${operatorView.latestCheckpoint.recommendedAction}:${operatorView.latestCheckpoint.status.toLowerCase()}`
      : undefined);
  const base = buildRuntimeOperatorAffordance({
    reactState: undefined,
    turn: {
      interactionMode: input.session.interactionMode,
      actSubmode: input.session.actSubmode,
      executionPolicy: input.session.executionPolicy,
    },
    output: {
      status: input.projection.waitFor !== undefined ? "WAITING" : "COMPLETED",
      sessionId: input.projection.sessionId,
      runId: `describe:${input.projection.sessionId}`,
      ...(input.projection.waitFor !== undefined ? { waitFor: input.projection.waitFor } : {}),
      errors: [],
      quality: {
        citationCoverage: 0,
        unresolvedClaims: 0,
        reworkRate: 0,
        thrashIndex: 0,
      },
      telemetry: {
        stepsExecuted: 0,
        toolCalls: 0,
        modelCalls: 0,
        durationMs: 0,
      },
    },
    ...(input.projection.activeAssembly !== undefined
      ? { activeAssembly: input.projection.activeAssembly }
      : {}),
  });
  return {
    ...base,
    ...(dominantBlocker !== undefined
      ? {
          blockReason: {
            code: "operator_thread_blocker",
            summary: dominantBlocker,
          },
        }
      : {}),
    ...(nextAction !== undefined
      ? {
          recommendedAction: {
            code: "operator_next_action",
            summary: nextAction,
          },
        }
      : {}),
    ...(input.projection.operatorInbox !== undefined ? { inbox: input.projection.operatorInbox } : {}),
    ...(input.projection.childBlocker !== undefined ? { childBlocker: input.projection.childBlocker } : {}),
    ...(childThreads !== undefined ? { childThreads } : {}),
    ...(childBlockerChainDetails !== undefined ? { childBlockerChainDetails } : {}),
    ...(blockerChain !== undefined ? { blockerChain } : {}),
    ...(dominantBlocker !== undefined ? { dominantBlocker } : {}),
    ...(input.projection.latestCheckpoint !== undefined ? { latestCheckpoint: input.projection.latestCheckpoint } : {}),
    ...(checkpointDisposition !== undefined ? { latestCheckpointDisposition: checkpointDisposition } : {}),
    ...(input.projection.latestFanInDisposition !== undefined
      ? { latestFanInDisposition: input.projection.latestFanInDisposition }
      : {}),
    ...(input.projection.latestSteering !== undefined ? { latestSteering: input.projection.latestSteering } : {}),
    ...(input.projection.latestReasoning !== undefined ? { latestReasoning: input.projection.latestReasoning } : {}),
    ...(input.projection.latestAdaptation !== undefined ? { latestAdaptation: input.projection.latestAdaptation } : {}),
    ...(input.projection.latestEvidenceRecovery !== undefined
      ? { latestEvidenceRecovery: input.projection.latestEvidenceRecovery }
      : {}),
    ...(contextPosture !== undefined ? { contextPosture } : {}),
    ...(input.projection.supervision !== undefined ? { supervision: input.projection.supervision } : {}),
    ...(nextAction !== undefined ? { nextAction } : {}),
    ...(input.projection.focusedThreadId !== undefined ? { focusedThreadId: input.projection.focusedThreadId } : {}),
  };
}

export function deriveOperatorBlockReason(
  waitFor: Exclude<NormalizedOutput["waitFor"], undefined> | undefined,
): OperatorBlockReason | undefined {
  if (waitFor === undefined) {
    return undefined;
  }

  const metadata = asRecord(waitFor.metadata);
  const reason = asString(metadata?.reason);
  if (
    reason === "route_mode_blocked" ||
    reason === "planner_mode_blocked" ||
    reason === "acter_mode_blocked"
  ) {
    const requiredToolClass = asString(metadata?.requiredToolClass) ?? "read_only";
    const toolName = asString(metadata?.toolName);
    const subject = toolName !== undefined ? ` '${toolName}'` : "";
    return {
      code: reason,
      summary: `Current mode does not allow${subject} because it requires ${requiredToolClass}.`,
      details: {
        requiredToolClass,
        ...(toolName !== undefined ? { toolName } : {}),
      },
    };
  }

  if (reason === "max_steps_continuation") {
    return {
      code: reason,
      summary: "Run reached the current step budget and is waiting for operator approval to continue.",
    };
  }

  if (reason !== undefined) {
    return {
      code: reason,
      summary: readOperatorWaitPrompt(waitFor) ?? `Waiting for '${waitFor.eventType}'.`,
    };
  }

  return undefined;
}

export function deriveOperatorRecommendedAction(
  waitFor: Exclude<NormalizedOutput["waitFor"], undefined> | undefined,
  blockReason: OperatorBlockReason | undefined,
  context: OperatorContextSummary | undefined,
): OperatorAffordancePayload["recommendedAction"] {
  if (
    blockReason?.code === "route_mode_blocked" ||
    blockReason?.code === "planner_mode_blocked" ||
    blockReason?.code === "acter_mode_blocked"
  ) {
    const detail = waitFor === undefined ? undefined : readOperatorWaitDetail(waitFor);
    return {
      code: "switch_mode",
      summary: detail ?? "Switch to a Build mode that allows the required tool class, then continue.",
    };
  }

  if (blockReason?.code === "max_steps_continuation") {
    const detail = waitFor === undefined ? undefined : readOperatorWaitDetail(waitFor);
    return {
      code: "grant_continuation",
      summary: detail ?? "Reply naturally to continue.",
    };
  }

  if (waitFor !== undefined) {
    return {
      code: "reply_to_prompt",
      summary: "Reply to the waiting prompt to resume the run.",
    };
  }

  if (context?.compactionState === "armed") {
    return {
      code: "auto_compaction_armed",
      summary: "Context pressure is high; use /compact suppress to skip the next automatic trim.",
    };
  }

  if (context !== undefined && context.degradationMode !== "full" && context.manualCompactionApplied !== true) {
    return {
      code: "manual_compact",
      summary: "Use /compact before the next turn if you want a more aggressive context trim.",
    };
  }

  return {
    code: "send_message",
    summary: "Send the next operator message.",
  };
}

export function buildOperatorWaitSummary(
  waitFor: Exclude<NormalizedOutput["waitFor"], undefined> | undefined,
): OperatorAffordancePayload["wait"] {
  if (waitFor === undefined) {
    return undefined;
  }

  return {
    eventType: waitFor.eventType,
    ...(readOperatorWaitPrompt(waitFor) !== undefined ? { prompt: readOperatorWaitPrompt(waitFor) } : {}),
    ...(readOperatorWaitDetail(waitFor) !== undefined ? { detail: readOperatorWaitDetail(waitFor) } : {}),
  };
}

export function readOperatorContextSummary(
  value: Record<string, unknown> | undefined,
): OperatorAffordancePayload["context"] {
  if (value === undefined) {
    return undefined;
  }

  const promptBudgetChars = asNumber(value.promptBudgetChars);
  const estimatedChars = asNumber(value.estimatedChars);
  const degradationMode = asString(value.degradationMode);
  if (
    promptBudgetChars === undefined ||
    estimatedChars === undefined ||
    (degradationMode !== "full" && degradationMode !== "compact" && degradationMode !== "minimal")
  ) {
    return undefined;
  }

  return {
    promptBudgetChars,
    estimatedChars,
    degradationMode,
    droppedSections: readStringArray(value.droppedSections),
    ...(asString(value.compactionState) !== undefined
      ? { compactionState: asString(value.compactionState) as OperatorCompactionState }
      : {}),
    ...(asString(value.compactionReason) !== undefined
      ? { compactionReason: asString(value.compactionReason) }
      : {}),
    ...(value.manualCompactionApplied === true ? { manualCompactionApplied: true } : {}),
  };
}

export function readOperatorRuntimePlanSummary(
  reactState: Record<string, unknown> | undefined,
): OperatorAffordancePayload["runtimePlan"] {
  if (reactState === undefined) {
    return undefined;
  }
  const workingPlan = asRecord(reactState.workingPlan);
  const commandProcessor = asRecord(reactState.commandProcessor);
  const lastCheckpoint = asRecord(commandProcessor?.lastCheckpoint);
  if (workingPlan === undefined && commandProcessor === undefined) {
    return undefined;
  }
  const checkpoint =
    lastCheckpoint === undefined
      ? undefined
      : {
          ...(asString(lastCheckpoint.substate) !== undefined ? { substate: asString(lastCheckpoint.substate) } : {}),
          ...(asString(lastCheckpoint.currentStepAgent) !== undefined
            ? { currentStepAgent: asString(lastCheckpoint.currentStepAgent) }
            : {}),
          ...(asString(lastCheckpoint.nextStepAgent) !== undefined
            ? { nextStepAgent: asString(lastCheckpoint.nextStepAgent) }
            : {}),
          ...(asNumber(lastCheckpoint.updatedAtStepIndex) !== undefined
            ? { updatedAtStepIndex: asNumber(lastCheckpoint.updatedAtStepIndex) }
            : {}),
        };
  return {
    ...(asString(reactState.phase) !== undefined ? { phase: asString(reactState.phase) } : {}),
    ...(asString(workingPlan?.currentChunk) !== undefined ? { currentChunk: asString(workingPlan?.currentChunk) } : {}),
    ...(asString(workingPlan?.status) !== undefined ? { status: asString(workingPlan?.status) } : {}),
    ...(asString(workingPlan?.expectedNextCommand) !== undefined
      ? { expectedNextCommand: asString(workingPlan?.expectedNextCommand) }
      : {}),
    ...(asString(workingPlan?.waitReason) !== undefined ? { waitReason: asString(workingPlan?.waitReason) } : {}),
    ...(asString(workingPlan?.blocker) !== undefined ? { blocker: asString(workingPlan?.blocker) } : {}),
    ...(asString(commandProcessor?.batchId) !== undefined ? { commandBatchId: asString(commandProcessor?.batchId) } : {}),
    ...(asString(commandProcessor?.executionMode) !== undefined
      ? { executionMode: asString(commandProcessor?.executionMode) }
      : {}),
    ...(readStringArray(commandProcessor?.commandNames).length > 0
      ? { commandNames: readStringArray(commandProcessor?.commandNames) }
      : readStringArray(workingPlan?.commandNames).length > 0
        ? { commandNames: readStringArray(workingPlan?.commandNames) }
        : {}),
    ...(checkpoint !== undefined && Object.keys(checkpoint).length > 0 ? { lastCheckpoint: checkpoint } : {}),
  };
}

export function readOperatorWaitPrompt(
  waitFor: Exclude<NormalizedOutput["waitFor"], undefined>,
): string | undefined {
  return extractWaitPrompt(waitFor);
}

export function readOperatorWaitDetail(
  waitFor: Exclude<NormalizedOutput["waitFor"], undefined>,
): string | undefined {
  return extractWaitDetail(waitFor);
}

function readExecutionPolicy(value: unknown): ExecutionPolicyOverride | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as ExecutionPolicyOverride;
}

function readWaitFor(value: unknown): Exclude<NormalizedOutput["waitFor"], undefined> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const kind = asString(record.kind);
  const eventType = asString(record.eventType);
  if (
    eventType === undefined ||
    (kind !== "approval" && kind !== "effect" && kind !== "region_merge" && kind !== "user")
  ) {
    return undefined;
  }
  const metadata = asRecord(record.metadata);
  if (kind === "user") {
    const prompt = asString(metadata?.prompt);
    if (prompt === undefined) {
      return undefined;
    }
    return {
      kind,
      eventType,
      ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
      metadata: {
        ...metadata,
        prompt,
      },
    };
  }
  return {
    kind,
    eventType,
    ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== undefined && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
