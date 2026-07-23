import type { RunEventType, RuntimeError } from "../kestrel/contracts/base.js";
import type { RuntimeEvent } from "../kestrel/contracts/events.js";
import type { NormalizedOutput, RuntimeDependencies, StepIO, Transition } from "../kestrel/contracts/execution.js";
import type { PersistedArtifact, SessionRecord } from "../kestrel/contracts/store.js";

import { isFilesystemInspectionToolName } from "../../agents/reference-react/src/filesystemInspection.js";
import { isModeBlockedWait } from "../runtime/blockedWaitModeReply.js";
import { isLowYieldSourceClusterStalled } from "../runtime/recoveryVerdict.js";
import { asRuntimeError } from "../runtime/RuntimeFailure.js";
import { isMutationCapableToolName } from "../runtime/mutationTools.js";
import { clearRuntimeWaitState, readActiveWaitState, type RuntimeWaitMatcher } from "../runtime/waitState.js";
import {
  analyzeVisibleTodoFinalizeReadiness,
  normalizeVisibleTodoResidualGapData,
  normalizeVisibleTodoState,
} from "../runtime/visibleTodos.js";
import { normalizeSourceCluster, normalizeWebExtractionRetrySummary } from "../runtime/webExtraction.js";
import {
  classifyRetrievalRedundancy,
  isRetrievalToolName,
  normalizeRetrievalGuardInput,
  normalizeRetrievalGuardOutput,
  readRetrievalToolFamily,
} from "./retrievalLoopGuard.js";
import { type Guardrails, GuardrailViolationError } from "./Guardrails.js";
import type { WaitResumeCoordinator } from "./WaitResumeCoordinator.js";

type RunEventLevel = "INFO" | "WARN" | "ERROR";
const LOOP_GUARD_HISTORY_WINDOW = 12;

interface RetrievalLoopHistoryEntry {
  toolName: string;
  input: ReturnType<typeof normalizeRetrievalGuardInput>;
  output: ReturnType<typeof normalizeRetrievalGuardOutput>;
}

type ToolCycleMarker = {
  toolName: string;
  inputHash: string;
  sourceCluster?: string | undefined;
  lowYield: boolean;
};

interface ResearchStallSummary {
  objectiveKey: string;
  guardToolName?: string | undefined;
  verifiedEvidenceAvailable?: boolean | undefined;
  stallKind?: string | undefined;
  guardType?: string | undefined;
  guardRepeats?: number | undefined;
  guardThreshold?: number | undefined;
  lowProgressCycles: number;
  retrievalToolFamily?: string | undefined;
  lowSignalState?: string | undefined;
  completedSoFar: string[];
  blockedOn: string;
  nextIfContinued: string[];
  partialAnswer: string;
  evidenceRecovery?: Record<string, unknown> | undefined;
  webExtraction?: Record<string, unknown> | undefined;
  lowYieldClusters?: Array<Record<string, unknown>> | undefined;
}

type ReturnTerminal = (
  runId: string,
  sessionId: string,
  finalStep: string,
  transition: Transition,
  errors: RuntimeError[],
  guardrails: Guardrails,
  progressSeq: number,
  continuation?: NormalizedOutput["continuation"] | undefined,
) => Promise<NormalizedOutput | undefined>;

export interface LoopGuardCoordinatorDependencies {
  runtimeDeps: Pick<RuntimeDependencies, "store">;
  waitResumeCoordinator: WaitResumeCoordinator;
  appendRunEvent: (
    runId: string,
    sessionId: string,
    type: RunEventType,
    level: RunEventLevel,
    metadata: Record<string, unknown>,
    stepIndex?: number | undefined,
  ) => Promise<void>;
  returnTerminal: ReturnTerminal;
  logInfo: (entry: {
    runId: string;
    sessionId: string;
    stepIndex?: number | undefined;
    eventName: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  normalizeReactRuntimePatch: (
    stepName: string,
    reactPatch: Record<string, unknown>,
    transition: Transition,
  ) => Record<string, unknown>;
  readConcreteRepairTargetPath: (reactState: Record<string, unknown>) => string | undefined;
  isUnattendedRepairContinuation: (
    event: RuntimeEvent,
    reactState: Record<string, unknown>,
  ) => boolean;
  buildResearchStallSummary: (
    reactState: Record<string, unknown>,
    currentStep: string,
    runtimeError?: RuntimeError | undefined,
  ) => ResearchStallSummary | undefined;
  isBuildModeRun: (reactState: Record<string, unknown>, event: RuntimeEvent) => boolean;
}

export class LoopGuardCoordinator {
  private readonly deps: LoopGuardCoordinatorDependencies["runtimeDeps"];
  private readonly waitResumeCoordinator: WaitResumeCoordinator;
  private readonly appendRunEvent: LoopGuardCoordinatorDependencies["appendRunEvent"];
  private readonly returnTerminal: ReturnTerminal;
  private readonly logInfo: LoopGuardCoordinatorDependencies["logInfo"];
  private readonly normalizeReactRuntimePatch: LoopGuardCoordinatorDependencies["normalizeReactRuntimePatch"];
  private readonly readConcreteRepairTargetPath: LoopGuardCoordinatorDependencies["readConcreteRepairTargetPath"];
  private readonly isUnattendedRepairContinuation: LoopGuardCoordinatorDependencies["isUnattendedRepairContinuation"];
  private readonly buildResearchStallSummary: LoopGuardCoordinatorDependencies["buildResearchStallSummary"];
  private readonly isBuildModeRun: LoopGuardCoordinatorDependencies["isBuildModeRun"];

  constructor(deps: LoopGuardCoordinatorDependencies) {
    this.deps = deps.runtimeDeps;
    this.waitResumeCoordinator = deps.waitResumeCoordinator;
    this.appendRunEvent = deps.appendRunEvent;
    this.returnTerminal = deps.returnTerminal;
    this.logInfo = deps.logInfo;
    this.normalizeReactRuntimePatch = deps.normalizeReactRuntimePatch;
    this.readConcreteRepairTargetPath = deps.readConcreteRepairTargetPath;
    this.isUnattendedRepairContinuation = deps.isUnattendedRepairContinuation;
    this.buildResearchStallSummary = deps.buildResearchStallSummary;
    this.isBuildModeRun = deps.isBuildModeRun;
  }

  applyRuntimeStateGuards(input: {
    stepName: string;
    sessionState: Record<string, unknown>;
    statePatch: Record<string, unknown> | undefined;
    transition: Transition;
  }): Record<string, unknown> | undefined {
    if (input.statePatch === undefined) {
      return input.statePatch;
    }

    const reactPatch = asRecord(input.statePatch.agent);
    if (reactPatch === undefined) {
      return input.statePatch;
    }

    const priorReact = asRecord(input.sessionState.agent) ?? {};
    const loopHistory = readLoopHistory(asRecord(priorReact.loopGuard)?.history);
    const priorWait = asRecord(priorReact.wait);
    const loopGuardNextAction = canonicalizeLoopGuardNextAction(reactPatch, reactPatch.nextAction);
    const loopGuardReactPatch = loopGuardNextAction === reactPatch.nextAction
      ? reactPatch
      : {
          ...reactPatch,
          nextAction: loopGuardNextAction,
        };
    const actionSignature = buildLoopGuardActionSignature(
      loopGuardReactPatch,
      loopGuardNextAction,
      input.transition.nextStepAgent,
    );
    const fingerprint = buildLoopFingerprint(
      input.stepName,
      loopGuardReactPatch,
      input.transition.waitFor,
      actionSignature,
    );
    const evidenceHash = stableHash(normalizeAgentFeedbackForLoopGuard(reactPatch));
    const observationMarker = latestObservationSummary(reactPatch.observations);
    const waitToken = this.waitResumeCoordinator.buildWaitResumeToken(
      input.transition.waitFor,
      input.transition.nextStepAgent,
    );
    const pendingExecutionHash = stableHash(readPendingExecutionSnapshot(reactPatch));
    const cycleKind = readCycleKind(input.stepName);
    const toolCycleMarker = readToolCycleMarker(reactPatch, loopGuardNextAction);
    const retrievalCycleMarker = readRetrievalCycleMarker(priorReact, reactPatch);
    const attemptedActionDiagnostics = buildLoopGuardAttemptDiagnostics({
      stepName: input.stepName,
      toolCycleMarker,
      retrievalCycleMarker,
      actionSignature,
      latestEvidenceHash: evidenceHash,
    });
    const repeatableModeBlockedWait = isModeBlockedWait(input.transition.waitFor);
    const nextHistory = [
      ...loopHistory,
      {
        stepName: input.stepName,
        fingerprint,
        evidenceHash,
        observationMarker,
        waitToken,
        pendingExecutionHash,
        actionSignature,
        cycleKind,
        toolActionName: toolCycleMarker?.toolName ?? "",
        toolActionInputHash: toolCycleMarker?.inputHash ?? "",
        toolActionSourceCluster: toolCycleMarker?.sourceCluster ?? "",
        toolActionLowYield: toolCycleMarker?.lowYield === true,
        ...(retrievalCycleMarker !== undefined
          ? {
              retrievalToolName: retrievalCycleMarker.toolName,
              retrievalInput: retrievalCycleMarker.input,
              retrievalOutput: retrievalCycleMarker.output,
            }
          : {}),
      },
    ].slice(-LOOP_GUARD_HISTORY_WINDOW);

    const repeats = nextHistory.filter(
      (entry) =>
        entry.fingerprint === fingerprint &&
        entry.evidenceHash === evidenceHash &&
        entry.observationMarker === observationMarker &&
        entry.pendingExecutionHash === pendingExecutionHash,
    ).length;
    if (repeatableModeBlockedWait === false && input.stepName !== "agent.loop" && repeats >= 3) {
      throw new GuardrailViolationError(
        "LOOP_GUARD_TRIGGERED",
        `Loop guard triggered for step '${input.stepName}' after repeated identical control states.`,
        {
          guardType: "IDENTICAL_CONTROL_STATE",
          ...attemptedActionDiagnostics,
        },
      );
    }

    if (cycleKind === "reasoning") {
      const reasoningRepeats = nextHistory.filter(
        (entry) =>
          entry.cycleKind === "reasoning" &&
          entry.actionSignature === actionSignature &&
          entry.evidenceHash === evidenceHash &&
          entry.observationMarker === observationMarker &&
          entry.pendingExecutionHash === pendingExecutionHash,
      ).length;
      const reasoningLoopThreshold = 3;
      if (reasoningRepeats >= reasoningLoopThreshold) {
        throw new GuardrailViolationError(
          "LOOP_GUARD_TRIGGERED",
          `Loop guard triggered for step '${input.stepName}' after repeated no-progress reasoning cycles.`,
          {
            ...buildNoProgressReasoningLoopDetails(loopGuardReactPatch, reasoningLoopThreshold),
            ...attemptedActionDiagnostics,
          },
        );
      }
    }

    if (
      input.stepName === "agent.loop" &&
      toolCycleMarker !== undefined
    ) {
      const repeatedToolCycles = nextHistory.filter(
        (entry) =>
          entry.stepName === "agent.loop" &&
          entry.cycleKind === "reasoning" &&
          entry.toolActionName === toolCycleMarker.toolName &&
          entry.toolActionInputHash === toolCycleMarker.inputHash &&
          entry.evidenceHash === evidenceHash,
      ).length;
      const repeatedSameToolCycleThreshold = 3;
      if (repeatedToolCycles >= repeatedSameToolCycleThreshold) {
        throw new GuardrailViolationError(
          "LOOP_GUARD_TRIGGERED",
          `Loop guard triggered for step '${input.stepName}' after repeated same-tool cycles for '${toolCycleMarker.toolName}'.`,
          {
            guardType: "REPEATED_SAME_TOOL_CYCLE",
            toolName: toolCycleMarker.toolName,
            toolInputHash: toolCycleMarker.inputHash,
            repeats: repeatedToolCycles,
            threshold: repeatedSameToolCycleThreshold,
            ...attemptedActionDiagnostics,
          },
        );
      }
      if (retrievalCycleMarker !== undefined) {
        const repeatedRetrievalPivots = nextHistory.filter((entry) => {
          if (isRetrievalHistoryEntry(entry) === false) {
            return false;
          }
          return classifyRetrievalRedundancy({
            prior: {
              toolName: entry.retrievalToolName,
              input: entry.retrievalInput,
              output: entry.retrievalOutput,
            },
            current: {
              toolName: retrievalCycleMarker.toolName,
              input: retrievalCycleMarker.input,
              output: retrievalCycleMarker.output,
            },
          }).redundant;
        }).length;
        const redundantRetrievalPivotThreshold = 3;
        if (repeatedRetrievalPivots >= redundantRetrievalPivotThreshold) {
          throw new GuardrailViolationError(
            "LOOP_GUARD_TRIGGERED",
            `Loop guard triggered for step '${input.stepName}' after repeated redundant retrieval pivots for '${retrievalCycleMarker.toolName}'.`,
            {
              guardType: "REPEATED_REDUNDANT_RETRIEVAL_PIVOT",
              toolName: retrievalCycleMarker.toolName,
              retrievalFamily: readRetrievalToolFamily(retrievalCycleMarker.toolName),
              repeats: repeatedRetrievalPivots,
              threshold: redundantRetrievalPivotThreshold,
              ...attemptedActionDiagnostics,
            },
          );
        }
      }
      if (toolCycleMarker.lowYield === true && toolCycleMarker.sourceCluster !== undefined) {
        const repeatedLowYieldSourceCycles = nextHistory.filter(
          (entry) =>
            entry.cycleKind === "reasoning" &&
            entry.toolActionLowYield === true &&
            entry.toolActionSourceCluster === toolCycleMarker.sourceCluster &&
            entry.toolActionInputHash === toolCycleMarker.inputHash,
        ).length;
        if (repeatedLowYieldSourceCycles >= 3) {
          throw new GuardrailViolationError(
            "LOOP_GUARD_TRIGGERED",
            `Loop guard triggered for step '${input.stepName}' after repeated low-yield web extraction cycles for '${toolCycleMarker.sourceCluster}'.`,
            {
              guardType: "REPEATED_LOW_YIELD_WEB_EXTRACTION",
              toolName: toolCycleMarker.toolName,
              sourceCluster: toolCycleMarker.sourceCluster,
              repeats: repeatedLowYieldSourceCycles,
              ...attemptedActionDiagnostics,
            },
          );
        }
      }
    }

    if (waitToken.length > 0 && repeatableModeBlockedWait === false) {
      const priorPendingExecutionHash = stableHash(readPendingExecutionSnapshot(priorReact));
      if (
        typeof priorWait?.resumeToken === "string" &&
        priorWait.resumeToken === waitToken &&
        priorPendingExecutionHash === pendingExecutionHash
      ) {
        throw new GuardrailViolationError(
          "LOOP_GUARD_TRIGGERED",
          `Loop guard triggered for step '${input.stepName}' after repeated wait state '${waitToken}'.`,
          {
            guardType: "REPEATED_WAIT_LOOP",
          },
        );
      }
      const waitRepeats = nextHistory.filter(
        (entry) =>
          entry.waitToken === waitToken &&
          entry.pendingExecutionHash === pendingExecutionHash,
      ).length;
      if (waitRepeats >= 2) {
        throw new GuardrailViolationError(
          "LOOP_GUARD_TRIGGERED",
          `Loop guard triggered for step '${input.stepName}' after repeated wait state '${waitToken}'.`,
          {
            guardType: "REPEATED_WAIT_LOOP",
          },
        );
      }
    }

    const normalizedReactPatch = this.normalizeReactRuntimePatch(
      input.stepName,
      reactPatch,
      input.transition,
    );

    return {
      ...input.statePatch,
      agent: {
        ...normalizedReactPatch,
        loopGuard: {
          history: nextHistory,
        },
      },
    };
  }

  async maybeHandleLoopVisitStallReply(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string | undefined;
    stepIndex: number;
    errors: RuntimeError[];
    guardrails: Guardrails;
    progressSeq: number;
    continuation?: NormalizedOutput["continuation"] | undefined;
  }): Promise<{ session: SessionRecord; currentStep: string | undefined; output?: undefined } | { output: NormalizedOutput } | undefined> {
    if (input.event.type !== "user.reply") {
      return ;
    }
    const reactState = asRecord(input.session.state.agent) ?? {};
    const activeWait = readActiveWaitState(reactState);
    const waitMetadata = asRecord(activeWait?.metadata);
    if (activeWait?.kind !== "user" || waitMetadata?.reason !== "loop_visit_stall") {
      return ;
    }

    const payload = asRecord(input.event.payload) ?? {};
    const explicitResume = payload.resumeBlockedRun === true;
    const message = asString(payload.message) ?? asString(payload.text);
    const shouldResume = explicitResume || isExplicitLoopStallContinuationReply(message, activeWait.metadata);
    if (shouldResume === false) {
      const waitingStepAgent = activeWait.resumeStepAgent ?? input.currentStep ?? input.session.currentStepAgent;
      if (waitingStepAgent === undefined) {
        return ;
      }
      const waitFor: RuntimeWaitMatcher = {
        kind: activeWait.kind,
        eventType: activeWait.eventType,
        ...(activeWait.timeoutMs !== undefined ? { timeoutMs: activeWait.timeoutMs } : {}),
        ...(activeWait.metadata !== undefined ? { metadata: activeWait.metadata } : {}),
      };
      const output = await this.returnTerminal(
        input.runId,
        input.session.sessionId,
        waitingStepAgent,
        {
          status: "WAITING",
          nextStepAgent: waitingStepAgent,
          waitFor,
        },
        input.errors,
        input.guardrails,
        input.progressSeq,
        input.continuation,
      );
      return output === undefined ? undefined : { output };
    }

    const storedResumeStepAgent = activeWait.resumeStepAgent ?? input.currentStep ?? input.session.currentStepAgent;
    const resumeStepAgent =
      storedResumeStepAgent?.startsWith("agent.exec.") === true
        ? "agent.loop"
        : storedResumeStepAgent;
    const now = new Date().toISOString();
    const loopStall = asRecord(reactState.loopStall);
    const loopGuard = asRecord(reactState.loopGuard);
    const execState = asRecord(reactState.exec);
    const blockedAction = asRecord(activeWait.blockedAction) ?? asRecord(loopStall?.blockedAction);
    const waitDiagnostic = asRecord(waitMetadata?.diagnostic) ?? asRecord(loopStall?.diagnostic);
    const waitTarget = asRecord(waitMetadata?.target) ?? asRecord(loopStall?.target);
    const resumeInstruction = activeWait.resumeInstruction ?? asString(loopStall?.resumeInstruction);
    const clearedReact = clearRuntimeWaitState(reactState);
    const commit = await this.deps.store.commitStep({
      runId: input.runId,
      event: input.event,
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.currentStep,
      nextStepAgent: resumeStepAgent,
      statePatch: {
        agent: {
          ...clearedReact,
          nextAction: undefined,
          commandBatch: undefined,
          terminal: undefined,
          loopStall: {
            ...(loopStall ?? {}),
            status: "resumed",
            resumedAt: now,
            resumeEventId: input.event.id,
            ...(resumeInstruction !== undefined ? { resumeInstruction } : {}),
            ...(waitTarget !== undefined ? { target: waitTarget } : {}),
            ...(waitDiagnostic !== undefined ? { diagnostic: waitDiagnostic } : {}),
            ...(blockedAction !== undefined ? { blockedAction } : {}),
            ...(storedResumeStepAgent !== resumeStepAgent ? { storedResumeStepAgent } : {}),
          },
          loopGuard: {
            ...(loopGuard ?? {}),
            history: [],
          },
          exec: {
            ...(execState ?? {}),
            pendingEffectKey: undefined,
            pendingEffectType: undefined,
            pendingApproval: undefined,
            pendingBatch: undefined,
            pendingToolCall: undefined,
          },
        },
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });
    const committedSession = await this.readCommittedSessionAfterStateReset(commit.session);
    await this.appendRunEvent(input.runId, input.session.sessionId, "loop.stall_resumed", "INFO", {
      reason: "loop_visit_stall",
      resumeStepAgent,
    }, input.stepIndex);
    return {
      session: committedSession,
      currentStep: resumeStepAgent,
    };
  }

  async maybeCompleteResearchStall(input: {
    runId: string;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    guardrails: Guardrails;
    progressSeq: number;
    runtimeError?: RuntimeError | undefined;
  }): Promise<NormalizedOutput | undefined> {
    const reactState = asRecord(input.session.state.agent) ?? {};
    const summary = this.buildResearchStallSummary(reactState, input.currentStep, input.runtimeError);
    if (summary === undefined) {
      return ;
    }
    const loopStallDiagnostics = buildLoopStallDiagnostics(
      reactState,
      input.currentStep,
      input.runtimeError,
    );
    if (loopStallDiagnostics !== undefined) {
      await this.appendRunEvent(input.runId, input.session.sessionId, "loop.stall_detected", "WARN", {
        ...loopStallDiagnostics,
        resolution: "research_stalled_partial",
      }, input.stepIndex);
    }
    if (input.runtimeError?.code === "LOOP_GUARD_TRIGGERED") {
      await this.appendRunEvent(input.runId, input.session.sessionId, "loop.guard_triggered", "WARN", {
        message: input.runtimeError.message,
        ...(input.runtimeError.details !== undefined ? { details: input.runtimeError.details } : {}),
      }, input.stepIndex);
    }

    const finalOutput = {
      message: summary.partialAnswer,
      data: {
        researchStalled: true,
        objective: summary.objectiveKey,
        ...(summary.stallKind !== undefined ? { stallKind: summary.stallKind } : {}),
        ...(summary.guardType !== undefined ? { guardType: summary.guardType } : {}),
        ...(summary.guardToolName !== undefined ? { guardToolName: summary.guardToolName } : {}),
        ...(summary.guardRepeats !== undefined ? { guardRepeats: summary.guardRepeats } : {}),
        ...(summary.guardThreshold !== undefined ? { guardThreshold: summary.guardThreshold } : {}),
        ...(summary.verifiedEvidenceAvailable !== undefined
          ? { verifiedEvidenceAvailable: summary.verifiedEvidenceAvailable }
          : {}),
        lowProgressCycles: summary.lowProgressCycles,
        ...(summary.retrievalToolFamily !== undefined
          ? { retrievalToolFamily: summary.retrievalToolFamily }
          : {}),
        ...(summary.lowSignalState !== undefined ? { lowSignalState: summary.lowSignalState } : {}),
        completedSoFar: summary.completedSoFar,
        blockedOn: summary.blockedOn,
        nextIfContinued: summary.nextIfContinued,
        ...(summary.evidenceRecovery !== undefined ? { evidenceRecovery: summary.evidenceRecovery } : {}),
        ...(summary.webExtraction !== undefined ? { webExtraction: summary.webExtraction } : {}),
        ...(summary.lowYieldClusters !== undefined ? { lowYieldClusters: summary.lowYieldClusters } : {}),
      },
    };
    const supportEvidence = {
      reason: "research_stalled_partial",
      objective: summary.objectiveKey,
      ...(summary.stallKind !== undefined ? { stallKind: summary.stallKind } : {}),
      ...(summary.guardType !== undefined ? { guardType: summary.guardType } : {}),
      ...(summary.guardToolName !== undefined ? { guardToolName: summary.guardToolName } : {}),
      ...(summary.guardRepeats !== undefined ? { guardRepeats: summary.guardRepeats } : {}),
      ...(summary.guardThreshold !== undefined ? { guardThreshold: summary.guardThreshold } : {}),
      ...(summary.verifiedEvidenceAvailable !== undefined
        ? { verifiedEvidenceAvailable: summary.verifiedEvidenceAvailable }
        : {}),
      lowProgressCycles: summary.lowProgressCycles,
      ...(summary.retrievalToolFamily !== undefined
        ? { retrievalToolFamily: summary.retrievalToolFamily }
        : {}),
      ...(summary.lowSignalState !== undefined ? { lowSignalState: summary.lowSignalState } : {}),
      ...(summary.lowYieldClusters !== undefined ? { lowYieldClusters: summary.lowYieldClusters } : {}),
    };
    const nextAction = {
      kind: "finalize",
      finalizeReason: "tool_unavailable",
      input: {
        message: summary.partialAnswer,
      },
      supportEvidence,
    };
    const now = new Date().toISOString();
    await this.deps.store.commitStep({
      runId: input.runId,
      event: {
        id: `${input.runId}:research-stalled-partial`,
        type: "system.meta_reasoning",
        sessionId: input.session.sessionId,
        payload: {
          reason: "research_stalled_partial",
          objective: summary.objectiveKey,
          lowProgressCycles: summary.lowProgressCycles,
        },
      },
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.currentStep,
      nextStepAgent: input.currentStep,
      statePatch: {
        agent: clearRuntimeWaitState({
          ...reactState,
          nextAction,
          assistantText: summary.partialAnswer.trim(),
          finalOutput,
          terminal: {
            status: "COMPLETED",
            reasonCode: "research_stalled_partial",
            finalStepAgent: input.currentStep,
            finalizedAt: now,
            outputRef: "agent.finalOutput",
          },
        }),
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });
    await this.appendRunEvent(input.runId, input.session.sessionId, "progress.blocked", "WARN", {
      reason: "research_stalled_partial",
      objective: summary.objectiveKey,
      ...(summary.stallKind !== undefined ? { stallKind: summary.stallKind } : {}),
      ...(summary.guardType !== undefined ? { guardType: summary.guardType } : {}),
      ...(summary.guardToolName !== undefined ? { guardToolName: summary.guardToolName } : {}),
      ...(summary.guardRepeats !== undefined ? { guardRepeats: summary.guardRepeats } : {}),
      ...(summary.guardThreshold !== undefined ? { guardThreshold: summary.guardThreshold } : {}),
      ...(summary.verifiedEvidenceAvailable !== undefined
        ? { verifiedEvidenceAvailable: summary.verifiedEvidenceAvailable }
        : {}),
      lowProgressCycles: summary.lowProgressCycles,
      blockedOn: summary.blockedOn,
      ...(summary.retrievalToolFamily !== undefined
        ? { retrievalToolFamily: summary.retrievalToolFamily }
        : {}),
    }, input.stepIndex);
    if (loopStallDiagnostics !== undefined) {
      await this.appendRunEvent(input.runId, input.session.sessionId, "loop.stall_converted", "WARN", {
        ...loopStallDiagnostics,
        resolution: "research_stalled_partial",
      }, input.stepIndex);
    }

    return this.returnTerminal(
      input.runId,
      input.session.sessionId,
      input.currentStep,
      {
        status: "COMPLETED",
        statePatch: {
          agent: {
            nextAction,
            assistantText: summary.partialAnswer.trim(),
            finalOutput,
          },
        },
      },
      [],
      input.guardrails,
      input.progressSeq,
    );
  }

  async maybeCompleteDocumentedFinalizeGap(input: {
    runId: string;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    guardrails: Guardrails;
    progressSeq: number;
    runtimeError: RuntimeError;
  }): Promise<NormalizedOutput | undefined> {
    if (input.runtimeError.code !== "LOOP_GUARD_TRIGGERED" || input.currentStep !== "agent.loop") {
      return ;
    }
    const errorDetails = asRecord(input.runtimeError.details);
    if (asString(errorDetails?.guardType) !== "NO_PROGRESS_REASONING_LOOP") {
      return ;
    }
    const reactState = asRecord(input.session.state.agent) ?? {};
    if (hasVisibleTodoFinalizeContinuationSignal(reactState) === false) {
      return ;
    }
    if (hasSuccessfulExecutionEvidence(input.session.state, reactState) === false) {
      return ;
    }

    const visibleTodos = normalizeVisibleTodoState(reactState.visibleTodos);
    const finalizeAction = asRecord(reactState.lastAction);
    if (finalizeAction?.kind !== "finalize" || finalizeAction.finalizeReason !== "goal_satisfied") {
      return ;
    }
    const finalizeInput = asRecord(finalizeAction.input);
    const finalizeData = asRecord(finalizeInput?.data);
    const residualGap = normalizeVisibleTodoResidualGapData(finalizeData);
    if (residualGap === undefined) {
      return ;
    }
    const readiness = analyzeVisibleTodoFinalizeReadiness({
      todos: visibleTodos,
      residualGap,
    });
    if (readiness.complete === false || readiness.residualOpenItems.length === 0) {
      return ;
    }

    const residualTodoIds = readiness.residualOpenItems.map((item) => item.id);
    const message = asString(finalizeInput?.message)?.trim() ??
      buildDocumentedFinalizeGapMessage(residualGap);
    const diagnostics = buildLoopStallDiagnostics(reactState, input.currentStep, input.runtimeError);
    const finalOutput = {
      message,
      data: {
        ...(finalizeData ?? {}),
        finalizeReason: "goal_satisfied",
        documentedResidualGapFinalized: true,
        residualTodoIds,
      },
    };
    const supportEvidence = {
      reason: "documented_residual_gap_finalized",
      validationEvidenceAvailable: true,
      residualTodoIds,
      ...(residualGap.openGap !== undefined ? { openGap: residualGap.openGap } : {}),
      ...(residualGap.knownWarnings.length > 0 ? { knownWarnings: residualGap.knownWarnings } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    };
    const nextAction = {
      kind: "finalize",
      finalizeReason: "goal_satisfied",
      input: finalOutput,
      supportEvidence,
    };
    const now = new Date().toISOString();

    await this.appendRunEvent(input.runId, input.session.sessionId, "loop.guard_triggered", "WARN", {
      message: input.runtimeError.message,
      ...(input.runtimeError.details !== undefined ? { details: input.runtimeError.details } : {}),
    }, input.stepIndex);
    await this.appendRunEvent(input.runId, input.session.sessionId, "loop.stall_converted", "WARN", {
      ...(diagnostics ?? { guardType: "NO_PROGRESS_REASONING_LOOP", stepAgent: input.currentStep }),
      resolution: "documented_residual_gap_finalized",
      residualTodoIds,
    }, input.stepIndex);

    await this.deps.store.commitStep({
      runId: input.runId,
      event: {
        id: `${input.runId}:documented-residual-gap-finalized`,
        type: "system.meta_reasoning",
        sessionId: input.session.sessionId,
        payload: {
          reason: "documented_residual_gap_finalized",
          residualTodoIds,
        },
      },
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.currentStep,
      nextStepAgent: input.currentStep,
      statePatch: {
        agent: clearRuntimeWaitState({
          ...reactState,
          nextAction,
          assistantText: message,
          finalOutput,
          terminal: {
            status: "COMPLETED",
            reasonCode: "goal_satisfied",
            finalStepAgent: input.currentStep,
            finalizedAt: now,
            outputRef: "agent.finalOutput",
          },
        }),
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });

    return this.returnTerminal(
      input.runId,
      input.session.sessionId,
      input.currentStep,
      {
        status: "COMPLETED",
        statePatch: {
          agent: {
            nextAction,
            assistantText: message,
            finalOutput,
          },
        },
      },
      [],
      input.guardrails,
      input.progressSeq,
    );
  }

  async maybeResolveLoopVisitStall(input: {
    runId: string;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    runtimeError: RuntimeError;
    guardrails: Guardrails;
    progressSeq: number;
  }): Promise<NormalizedOutput | undefined> {
    if (
      input.runtimeError.code !== "MAX_STEP_VISITS_EXCEEDED" &&
      isRecoverableDispatchLoopGuard(input.runtimeError, input.currentStep) === false
    ) {
      return ;
    }
    if (input.currentStep !== "agent.loop" && input.currentStep !== "agent.exec.dispatch") {
      return ;
    }

    const reactState = asRecord(input.session.state.agent) ?? {};
    const history = readLoopHistory(asRecord(reactState.loopGuard)?.history);
    if (history.length < 3) {
      return ;
    }

    const activeToolName = readActiveToolName(reactState);
    if (activeToolName !== undefined && isMutationCapableToolName(activeToolName)) {
      return ;
    }

    const diagnostic = buildLoopStallDiagnostics(reactState, input.currentStep, input.runtimeError) ?? {
      guardType: input.runtimeError.code,
      stepAgent: input.currentStep,
    };
    const target = readConcreteLoopStallTarget(reactState);
    const resumeStepAgent = input.currentStep.startsWith("agent.exec.") ? "agent.loop" : input.currentStep;
    const resolution = target !== undefined ? "checkpoint_wait" : "clarification_wait";
    const question = target !== undefined
      ? `I hit a repeated control loop while working on ${target.label}. Reply "continue" to re-plan from this checkpoint without repeating the same action, or give a narrower instruction.`
      : "I hit a repeated control loop without a concrete next target. Which narrower slice should I inspect or finish first?";
    const waitFor = {
      kind: "user" as const,
      eventType: "user.reply",
      metadata: {
        reason: "loop_visit_stall",
        resolution,
        question,
        prompt: question,
        resumeReply: "continue",
        ...(target !== undefined ? { target } : {}),
        diagnostic,
      },
    };
    const now = new Date().toISOString();
    const blockedAction = asRecord(reactState.nextAction);

    await this.appendRunEvent(input.runId, input.session.sessionId, "loop.stall_detected", "WARN", {
      ...diagnostic,
      resolution,
      ...(target !== undefined ? { target } : {}),
    }, input.stepIndex);
    if (input.runtimeError.code === "LOOP_GUARD_TRIGGERED") {
      await this.appendRunEvent(input.runId, input.session.sessionId, "loop.guard_triggered", "WARN", {
        message: input.runtimeError.message,
        ...(input.runtimeError.details !== undefined ? { details: input.runtimeError.details } : {}),
      }, input.stepIndex);
    }
    await this.deps.store.commitStep({
      runId: input.runId,
      event: {
        id: `${input.runId}:loop-visit-stall`,
        type: "system.meta_reasoning",
        sessionId: input.session.sessionId,
        payload: {
          reason: "loop_visit_stall",
          resolution,
          ...(target !== undefined ? { target } : {}),
        },
      },
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.currentStep,
      nextStepAgent: resumeStepAgent,
      statePatch: {
        agent: {
          ...reactState,
          loopStall: {
            reason: "loop_visit_stall",
            resolution,
            diagnostic,
            ...(target !== undefined ? { target } : {}),
            ...(blockedAction !== undefined ? { blockedAction } : {}),
            resumeInstruction: question,
            checkpointedAt: now,
          },
          waitingFor: this.waitResumeCoordinator.buildWaitingFor({
            waitFor,
            resumeStepAgent,
            reason: "loop_visit_stall",
            resumeInstruction: question,
            ...(blockedAction !== undefined ? { blockedAction } : {}),
          }),
          terminal: {
            status: "WAITING",
            reasonCode: "loop_visit_stall",
            finalStepAgent: input.currentStep,
            finalizedAt: now,
          },
        },
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });
    await this.appendRunEvent(input.runId, input.session.sessionId, "loop.stall_converted", "WARN", {
      ...diagnostic,
      resolution,
      ...(target !== undefined ? { target } : {}),
    }, input.stepIndex);
    await this.appendRunEvent(input.runId, input.session.sessionId, "progress.blocked", "WARN", {
      reason: "loop_visit_stall",
      resolution,
      question,
      ...(target !== undefined ? { target } : {}),
    }, input.stepIndex);

    return this.returnTerminal(
      input.runId,
      input.session.sessionId,
      resumeStepAgent,
      {
        status: "WAITING",
        nextStepAgent: resumeStepAgent,
        waitFor,
      },
      [],
      input.guardrails,
      input.progressSeq,
    );
  }

  async maybeCompleteVerifiedRetrievalSynthesis(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    guardrails: Guardrails;
    progressSeq: number;
    getProgressSeq: () => number;
    runtimeError: RuntimeError;
    signal?: AbortSignal | undefined;
    useModel: StepIO["useModel"];
  }): Promise<NormalizedOutput | undefined> {
    const reactState = asRecord(input.session.state.agent) ?? {};
    const summary = this.buildResearchStallSummary(reactState, input.currentStep, input.runtimeError);
    if (summary?.verifiedEvidenceAvailable !== true) {
      return ;
    }
    if (this.isBuildModeRun(reactState, input.event)) {
      return ;
    }

    const synthesisResult = await this.synthesizeVerifiedRetrievalAnswer({
      runId: input.runId,
      sessionId: input.session.sessionId,
      currentStep: input.currentStep,
      stepIndex: input.stepIndex,
      guardrails: input.guardrails,
      reactState,
      summary,
      signal: input.signal,
      useModel: input.useModel,
    });
    if (synthesisResult === undefined) {
      return ;
    }

    const artifactEvidenceUnavailable = synthesisResult.completionState === "artifact_evidence_unavailable";
    const finalizeReason = artifactEvidenceUnavailable ? "tool_unavailable" : "goal_satisfied";
    const terminalReasonCode = artifactEvidenceUnavailable ? "artifact_evidence_unavailable" : "goal_satisfied";
    const verifiedEvidenceAvailable = artifactEvidenceUnavailable ? false : true;

    await this.appendRunEvent(input.runId, input.session.sessionId, "loop.guard_triggered", "WARN", {
      message: input.runtimeError.message,
      ...(input.runtimeError.details !== undefined ? { details: input.runtimeError.details } : {}),
    }, input.stepIndex);

    const finalOutput = {
      message: synthesisResult.message,
      data: {
        completionState: synthesisResult.completionState,
        finalizeReason,
        objective: summary.objectiveKey,
        ...(synthesisResult.artifactRecovery !== undefined
          ? { artifactRecovery: synthesisResult.artifactRecovery }
          : {}),
        ...(summary.stallKind !== undefined ? { stallKind: summary.stallKind } : {}),
        ...(summary.guardType !== undefined ? { guardType: summary.guardType } : {}),
        ...(summary.guardToolName !== undefined ? { guardToolName: summary.guardToolName } : {}),
        ...(summary.guardRepeats !== undefined ? { guardRepeats: summary.guardRepeats } : {}),
        ...(summary.guardThreshold !== undefined ? { guardThreshold: summary.guardThreshold } : {}),
        verifiedEvidenceAvailable,
        lowProgressCycles: summary.lowProgressCycles,
        ...(summary.retrievalToolFamily !== undefined
          ? { retrievalToolFamily: summary.retrievalToolFamily }
          : {}),
        ...(summary.lowSignalState !== undefined ? { lowSignalState: summary.lowSignalState } : {}),
        ...(summary.evidenceRecovery !== undefined ? { evidenceRecovery: summary.evidenceRecovery } : {}),
        ...(summary.webExtraction !== undefined ? { webExtraction: summary.webExtraction } : {}),
      },
    };
    const supportEvidence = {
      reason: "verified_retrieval_synthesis",
      objective: summary.objectiveKey,
      ...(summary.stallKind !== undefined ? { stallKind: summary.stallKind } : {}),
      ...(summary.guardType !== undefined ? { guardType: summary.guardType } : {}),
      ...(summary.guardToolName !== undefined ? { guardToolName: summary.guardToolName } : {}),
      ...(summary.guardRepeats !== undefined ? { guardRepeats: summary.guardRepeats } : {}),
      ...(summary.guardThreshold !== undefined ? { guardThreshold: summary.guardThreshold } : {}),
      verifiedEvidenceAvailable,
      lowProgressCycles: summary.lowProgressCycles,
      ...(summary.retrievalToolFamily !== undefined ? { retrievalToolFamily: summary.retrievalToolFamily } : {}),
      ...(summary.lowSignalState !== undefined ? { lowSignalState: summary.lowSignalState } : {}),
    };
    const nextAction = {
      kind: "finalize",
      finalizeReason,
      input: finalOutput,
      supportEvidence,
    };
    const now = new Date().toISOString();
    await this.deps.store.commitStep({
      runId: input.runId,
      event: {
        id: `${input.runId}:verified-retrieval-synthesis`,
        type: "system.meta_reasoning",
        sessionId: input.session.sessionId,
        payload: {
          reason: "verified_retrieval_synthesis",
          objective: summary.objectiveKey,
          guardType: summary.guardType,
          guardToolName: summary.guardToolName,
        },
      },
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.currentStep,
      nextStepAgent: input.currentStep,
      statePatch: {
        agent: clearRuntimeWaitState({
          ...reactState,
          nextAction,
          assistantText: synthesisResult.message.trim(),
          finalOutput,
          terminal: {
            status: "COMPLETED",
            reasonCode: terminalReasonCode,
            finalStepAgent: input.currentStep,
            finalizedAt: now,
            outputRef: "agent.finalOutput",
          },
        }),
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });

    return this.returnTerminal(
      input.runId,
      input.session.sessionId,
      input.currentStep,
      {
        status: "COMPLETED",
        statePatch: {
          agent: {
            nextAction,
            assistantText: synthesisResult.message.trim(),
            finalOutput,
          },
        },
      },
      [],
      input.guardrails,
      input.getProgressSeq(),
    );
  }

  private async synthesizeVerifiedRetrievalAnswer(input: {
    runId: string;
    sessionId: string;
    currentStep: string;
    stepIndex: number;
    guardrails: Guardrails;
    reactState: Record<string, unknown>;
    summary: ResearchStallSummary;
    signal?: AbortSignal | undefined;
    useModel: StepIO["useModel"];
  }): Promise<
    | {
      message: string;
      completionState: "synthesized_from_verified_retrieval" | "artifact_evidence_unavailable";
      artifactRecovery?: Record<string, unknown> | undefined;
    }
    | undefined
  > {
    try {
      const evidence = await this.buildVerifiedRetrievalSynthesisEvidence({
        sessionId: input.sessionId,
        reactState: input.reactState,
        summary: input.summary,
      });
      const artifactRecovery = asRecord(evidence.artifactRecovery);
      const artifactIds = Array.isArray(artifactRecovery?.artifactIds)
        ? artifactRecovery.artifactIds.filter((item): item is string => typeof item === "string")
        : [];
      const recoveredCount = typeof artifactRecovery?.recoveredCount === "number"
        ? artifactRecovery.recoveredCount
        : undefined;
      if (artifactIds.length > 0 && recoveredCount === 0) {
        await this.appendRunEvent(input.runId, input.sessionId, "progress.blocked", "WARN", {
          reason: "artifact_evidence_unavailable",
          artifactRecovery,
        }, input.stepIndex);
        const missingArtifactIds = Array.isArray(artifactRecovery?.missingArtifactIds)
          ? artifactRecovery.missingArtifactIds.filter((item): item is string => typeof item === "string")
          : artifactIds;
        return {
          message: [
            "I could not produce a source-grounded final answer because the compacted retrieval result points to stored evidence artifacts that are not available.",
            `Missing artifact ids: ${missingArtifactIds.join(", ")}.`,
          ].join(" "),
          completionState: "artifact_evidence_unavailable",
          ...(artifactRecovery !== undefined ? { artifactRecovery } : {}),
        };
      }

      const response = await input.useModel<unknown>({
          responseFormat: "text",
          tools: [],
          messages: [
            {
              role: "system",
              content: renderVerifiedRetrievalSynthesisSystemPrompt(),
            },
            {
              role: "user",
              content: renderVerifiedRetrievalSynthesisUserPrompt({
                objective: input.summary.objectiveKey,
                evidence,
              }),
            },
          ],
          input: {
            objective: input.summary.objectiveKey,
            evidence,
          },
          providerOptions: {
            openrouter: {
              temperature: 0.2,
              maxTokens: 900,
              toolChoice: "none",
            },
            openai: {
              temperature: 0.2,
              maxTokens: 900,
              toolChoice: "none",
            },
            anthropic: {
              temperature: 0.2,
              maxTokens: 900,
              toolChoice: "none",
            },
          },
          metadata: {
            phase: "verified_retrieval_synthesis",
            modelRole: "synthesis",
            stepAgent: input.currentStep,
            runId: input.runId,
            sessionId: input.sessionId,
            stepIndex: input.stepIndex,
          },
        });
      const message = extractVerifiedRetrievalSynthesisMessage(response);
      return message !== undefined && asksToContinue(message) === false
        ? {
            message,
            completionState: "synthesized_from_verified_retrieval",
            ...(artifactRecovery !== undefined ? { artifactRecovery } : {}),
          }
        : undefined;
    } catch (error) {
      const runtimeError = asRuntimeError(error);
      await this.appendRunEvent(input.runId, input.sessionId, "progress.blocked", "WARN", {
        reason: "verified_retrieval_synthesis_failed",
        code: runtimeError.code,
        message: runtimeError.message,
      }, input.stepIndex);
      return ;
    }
  }

  private async buildVerifiedRetrievalSynthesisEvidence(input: {
    sessionId: string;
    reactState: Record<string, unknown>;
    summary: ResearchStallSummary;
  }): Promise<Record<string, unknown>> {
    const evidence = buildVerifiedRetrievalSynthesisEvidenceSnapshot(input.reactState, input.summary);
    const truncatedArtifacts = readTruncatedToolArtifactsForResume(input.reactState.lastActionResult);
    if (truncatedArtifacts === undefined) {
      return evidence;
    }

    const recoveredToolArtifacts: PersistedArtifact[] = [];
    const missingArtifactIds: string[] = [];
    for (const artifactId of truncatedArtifacts.artifactIds.slice(0, 8)) {
      const artifact = await this.deps.store.getArtifact({
        artifactId,
        sessionId: input.sessionId,
      });
      if (artifact === null) {
        missingArtifactIds.push(artifactId);
        continue;
      }
      recoveredToolArtifacts.push(artifact);
    }

    return {
      ...evidence,
      artifactRecovery: {
        artifactIds: truncatedArtifacts.artifactIds,
        digestArtifactIds: truncatedArtifacts.digestArtifactIds,
        recoveredCount: recoveredToolArtifacts.length,
        ...(missingArtifactIds.length > 0 ? { missingArtifactIds } : {}),
      },
      ...(recoveredToolArtifacts.length > 0 ? { recoveredToolArtifacts } : {}),
      ...(recoveredToolArtifacts.length > 0
        ? { sourceIndex: buildRecoveredArtifactSourceIndex(recoveredToolArtifacts) }
        : {}),
    };
  }

  async maybeBuildConcreteRepairContinuation(input: {
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string;
    previousState: Record<string, unknown>;
    transition: Transition;
    runtimeError: RuntimeError;
  }): Promise<
    | {
      transition: Transition;
      statePatch: Record<string, unknown>;
      targetPath: string;
    }
    | undefined
  > {
    if (input.runtimeError.code !== "LOOP_GUARD_TRIGGERED") {
      return ;
    }
    const errorDetails = asRecord(input.runtimeError.details);
    const guardType = asString(errorDetails?.guardType);
    const retrievalFamily =
      asString(errorDetails?.retrievalFamily) ??
        asString(errorDetails?.toolName);
    const toolName = asString(errorDetails?.toolName);
    const isFilesystemLoopGuard =
      retrievalFamily === "filesystem.read_like" ||
      readRetrievalToolFamily(retrievalFamily ?? "") === "filesystem.read_like" ||
      (toolName !== undefined && isFilesystemInspectionToolName(toolName));
    if (isFilesystemLoopGuard === false) {
      return ;
    }

    const transitionPatch = asRecord(input.transition.statePatch) ?? {};
    const priorReact: Record<string, unknown> = {
      ...(asRecord(input.previousState.agent) ?? {}),
      ...(Array.isArray(input.previousState.evidenceLedger) ? { evidenceLedger: input.previousState.evidenceLedger } : {}),
    };
    const patchReact: Record<string, unknown> = {
      ...(asRecord(transitionPatch.agent) ?? {}),
      ...(Array.isArray(transitionPatch.evidenceLedger) ? { evidenceLedger: transitionPatch.evidenceLedger } : {}),
    };
    const reactState = {
      ...priorReact,
      ...patchReact,
    };
    if (this.isUnattendedRepairContinuation(input.event, reactState) === false) {
      return ;
    }
    const targetPath = this.readConcreteRepairTargetPath(reactState);
    if (targetPath === undefined) {
      return ;
    }

    const nextAction =
      asRecord(reactState.nextAction) ?? {
        kind: "tool",
        name: "fs.read_text",
        input: {
          path: targetPath,
        },
      };
    const resolvedExecutionStep = resolveLegacyExecutionStep({
      ...reactState,
      nextAction,
    });
    const transitionNextStepAgent =
      typeof input.transition.nextStepAgent === "string" &&
        input.transition.nextStepAgent.trim().length > 0
        ? input.transition.nextStepAgent
        : undefined;
    const nextStepAgent =
      transitionNextStepAgent !== undefined && transitionNextStepAgent !== input.currentStep
        ? transitionNextStepAgent
        : resolvedExecutionStep;
    const now = new Date().toISOString();
    const observations = [
      ...(Array.isArray(reactState.observations) ? reactState.observations : []),
      {
        summary:
          `Continuing unattended concrete repair for ${targetPath}; user clarification is not required because structured evidence names the repair target.`,
        goalMet: false,
        timestamp: now,
      },
    ].slice(-24);
    const exec = asRecord(reactState.exec) ?? {};
    const nextReact = clearRuntimeWaitState({
      ...reactState,
      observations,
      nextAction,
      terminal: undefined,
      exec: {
        ...exec,
        substate: resolveExecSubstateForStep(nextStepAgent),
      },
    });
    const statePatch = {
      agent: nextReact,
    };

    return {
      targetPath,
      statePatch,
      transition: {
        ...input.transition,
        status: "RUNNING",
        nextStepAgent,
        statePatch,
      },
    };
  }

  async recordConcreteRepairContinuation(input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    targetPath: string;
    runtimeError: RuntimeError;
  }): Promise<void> {
    await this.appendRunEvent(input.runId, input.sessionId, "clarification.triggered", "INFO", {
      reason: "concrete_repair_continuation",
      sourceReason: "concrete_repair_evidence",
      targetPath: input.targetPath,
      message: input.runtimeError.message,
    }, input.stepIndex);
    await this.logInfo({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventName: "concrete_repair_continuation",
      metadata: {
        reason: "concrete_repair_continuation",
        sourceReason: "concrete_repair_evidence",
        targetPath: input.targetPath,
        originalErrorCode: input.runtimeError.code,
      },
    });
  }

  async maybeBuildVerifiedRetrievalContinuation(input: {
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string;
    previousState: Record<string, unknown>;
    transition: Transition;
    runtimeError: RuntimeError;
  }): Promise<
    | {
      transition: Transition;
      statePatch: Record<string, unknown>;
      objectiveKey: string;
      guardToolName?: string | undefined;
    }
    | undefined
  > {
    if (input.runtimeError.code !== "LOOP_GUARD_TRIGGERED") {
      return ;
    }
    const errorDetails = asRecord(input.runtimeError.details);
    if (asString(errorDetails?.guardType) !== "REPEATED_REDUNDANT_RETRIEVAL_PIVOT") {
      return ;
    }

    const priorReact = asRecord(input.previousState.agent) ?? {};
    const patchReact = asRecord(asRecord(input.transition.statePatch)?.agent) ?? {};
    const reactState = {
      ...priorReact,
      ...patchReact,
    };
    const summary = this.buildResearchStallSummary(reactState, input.currentStep, input.runtimeError);
    if (summary?.verifiedEvidenceAvailable !== true) {
      return ;
    }
    if (this.isBuildModeRun(reactState, input.event) === false) {
      return ;
    }

    const now = new Date().toISOString();
    const observations = [
      ...(Array.isArray(reactState.observations) ? reactState.observations : []),
      {
        summary:
          "Verified retrieval evidence is already available. Stop retrieval and continue the remaining implementation and verification work from the collected evidence.",
        goalMet: false,
        timestamp: now,
      },
    ].slice(-24);
    const exec = asRecord(reactState.exec) ?? {};
    const nextReact = clearRuntimeWaitState({
      ...reactState,
      observations,
      nextAction: undefined,
      commandBatch: undefined,
      terminal: undefined,
      toolIntent: undefined,
      compiledIntent: undefined,
      requiredCapabilities: undefined,
      activeExecutableIntent: undefined,
      loopGuard: {
        history: [],
      },
      loopStall: {
        ...(asRecord(reactState.loopStall) ?? {}),
        status: "resumed",
        resumedAt: now,
        reason: "verified_retrieval_continuation",
      },
      exec: {
        ...exec,
        substate: resolveExecSubstateForStep(input.currentStep),
        pendingEffectKey: undefined,
        pendingEffectType: undefined,
        pendingApproval: undefined,
        pendingBatch: undefined,
        pendingToolCall: undefined,
      },
    });
    const statePatch = {
      agent: nextReact,
    };

    return {
      objectiveKey: summary.objectiveKey,
      ...(summary.guardToolName !== undefined ? { guardToolName: summary.guardToolName } : {}),
      statePatch,
      transition: {
        ...input.transition,
        status: "RUNNING",
        nextStepAgent: input.currentStep,
        statePatch,
      },
    };
  }

  async recordVerifiedRetrievalContinuation(input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    objective: string;
    guardToolName?: string | undefined;
  }): Promise<void> {
    await this.appendRunEvent(input.runId, input.sessionId, "loop.stall_resumed", "INFO", {
      reason: "verified_retrieval_continuation",
      objective: input.objective,
      ...(input.guardToolName !== undefined ? { guardToolName: input.guardToolName } : {}),
    }, input.stepIndex);
    await this.logInfo({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventName: "verified_retrieval_continuation",
      metadata: {
        reason: "verified_retrieval_continuation",
        objective: input.objective,
        ...(input.guardToolName !== undefined ? { guardToolName: input.guardToolName } : {}),
      },
    });
  }

  private async readCommittedSessionAfterStateReset(session: SessionRecord): Promise<SessionRecord> {
    const persistedSession = await this.deps.store.getSession(session.sessionId);
    const effectiveSession =
      persistedSession === null || persistedSession.version < session.version
        ? session
        : persistedSession;
    const agent = asRecord(effectiveSession.state.agent);
    if (agent === undefined) {
      return effectiveSession;
    }
    effectiveSession.state = {
      ...effectiveSession.state,
      agent: {
        ...clearRuntimeWaitState(agent),
        terminal: undefined,
      },
    };
    return effectiveSession;
  }
}

function isExplicitLoopStallContinuationReply(
  message: string | undefined,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (message === undefined) {
    return false;
  }
  const normalizedReply = normalizeExactControlReply(message);
  if (normalizedReply === "continue" || normalizedReply === "proceed" || normalizedReply === "yes") {
    return true;
  }
  const resumeReply = typeof metadata?.resumeReply === "string"
    ? normalizeExactControlReply(metadata.resumeReply)
    : undefined;
  return resumeReply !== undefined && resumeReply.length > 0 && normalizedReply === resumeReply;
}

function normalizeExactControlReply(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!?,:;]+$/gu, "")
    .replace(/\s+/gu, " ");
}

function latestObservationSummary(value: unknown): string {
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

function readCapabilityClassesFromFeedback(reactState: Record<string, unknown>): string[] {
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
      add(asRecord(item)?.capabilityClasses);
    }
  }
  const lastActionResult = asRecord(reactState.lastActionResult);
  add(lastActionResult?.capabilityClasses);
  const resultItems = Array.isArray(lastActionResult?.items) ? lastActionResult.items : [];
  for (const item of resultItems) {
    add(asRecord(item)?.capabilityClasses);
  }
  return [...capabilities].sort((left, right) => left.localeCompare(right));
}

function normalizeAgentFeedbackForLoopGuard(reactState: Record<string, unknown>): Record<string, unknown> {
  const lastActionResult = asRecord(reactState.lastActionResult);
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

function buildNoProgressReasoningLoopDetails(
  reactState: Record<string, unknown>,
  threshold: number,
): Record<string, unknown> {
  const toolInputRejection = readLoopGuardToolInputRejection(reactState);
  return {
    guardType: "NO_PROGRESS_REASONING_LOOP",
    threshold,
    ...(toolInputRejection !== undefined
      ? {
          loopClassification: "tool_input_invalid",
          lastRejection: toolInputRejection,
        }
      : {}),
  };
}

function buildLoopGuardAttemptDiagnostics(input: {
  stepName: string;
  toolCycleMarker?: ToolCycleMarker | undefined;
  retrievalCycleMarker?: RetrievalLoopHistoryEntry | undefined;
  actionSignature: string;
  latestEvidenceHash: string;
}): Record<string, unknown> {
  return {
    step: input.stepName,
    ...(input.toolCycleMarker !== undefined
      ? {
          toolName: input.toolCycleMarker.toolName,
          toolInputHash: input.toolCycleMarker.inputHash,
        }
      : {}),
    ...(input.retrievalCycleMarker !== undefined
      ? {
          retrievalToolName: input.retrievalCycleMarker.toolName,
          normalizedInputHash: stableHash(input.retrievalCycleMarker.input),
        }
      : {}),
    actionSignatureHash: stableHash(input.actionSignature),
    latestEvidenceHash: input.latestEvidenceHash,
  };
}

function readLoopGuardToolInputRejection(reactState: Record<string, unknown>): Record<string, unknown> | undefined {
  const lastActionResult = asRecord(reactState.lastActionResult);
  const details = asRecord(lastActionResult?.details);
  const code = readNonEmptyString(lastActionResult?.errorCode) ?? readNonEmptyString(lastActionResult?.code);
  if (code !== "TOOL_INPUT_INVALID") {
    return ;
  }
  const path = readNonEmptyString(details?.path) ?? readNonEmptyString(lastActionResult?.path);
  if (path === undefined) {
    return ;
  }
  const reason =
    readNonEmptyString(lastActionResult?.message) ??
    readNonEmptyString(lastActionResult?.reason) ??
    readNonEmptyString(lastActionResult?.summary);
  const toolName = readNonEmptyString(details?.toolName) ?? readNonEmptyString(lastActionResult?.toolName);
  return {
    code,
    ...(reason !== undefined ? { reason } : {}),
    path,
    ...(toolName !== undefined ? { toolName } : {}),
  };
}

function canonicalizeLoopGuardNextAction(
  reactPatch: Record<string, unknown>,
  value: unknown,
): unknown {
  const action = asRecord(value);
  if (action === undefined || action.kind !== "tool" || typeof action.name !== "string") {
    return value;
  }
  if (
    action.name !== "dev.process.write" &&
    action.name !== "dev.process.write_and_read" &&
    action.name !== "dev.process.read" &&
    action.name !== "dev.process.stop"
  ) {
    return value;
  }
  const devShell = asRecord(asRecord(reactPatch.exec)?.devShell);
  const activeProcessId =
    typeof devShell?.activeProcessId === "string" && devShell.activeProcessId.trim().length > 0
      ? devShell.activeProcessId
      : typeof devShell?.processId === "string" && devShell.processId.trim().length > 0
        ? devShell.processId
      : undefined;
  if (activeProcessId === undefined) {
    return value;
  }
  const input = asRecord(action.input);
  if (typeof input?.processId === "string" && input.processId === activeProcessId) {
    return value;
  }
  return {
    ...action,
    input: {
      ...(input ?? {}),
      processId: activeProcessId,
    },
  };
}

function buildLoopFingerprint(
  stepName: string,
  reactPatch: Record<string, unknown>,
  waitFor: Transition["waitFor"],
  actionSignature: string,
): string {
  const waitingFor = asRecord(reactPatch.waitingFor);
  const waitEventType =
    typeof waitFor?.eventType === "string"
      ? waitFor.eventType
      : typeof waitingFor?.eventType === "string"
        ? String(waitingFor.eventType)
        : "";

  return JSON.stringify({
    stepName,
    actionSignature,
    requiredCapabilities: stableHash(reactPatch.requiredCapabilities),
    feedbackEvidence: stableHash(normalizeAgentFeedbackForLoopGuard(reactPatch)),
    waitEventType,
  });
}

function buildLoopGuardActionSignature(
  reactPatch: Record<string, unknown>,
  nextAction: unknown,
  nextStepAgent: string | undefined,
): string {
  const actionSignature = buildActionSignature(nextAction);
  if (actionSignature.length > 0) {
    return actionSignature;
  }

  const redirectedDecision = readLatestDecisionRedirect(
    reactPatch.decisionTrace ?? reactPatch.loopGuardDecisionTrace,
  );
  if (redirectedDecision === undefined) {
    return buildNoActionReasoningStateSignature(reactPatch, nextStepAgent);
  }

  return JSON.stringify({
    kind: "decision_redirected",
    nextStepAgent: nextStepAgent ?? "",
    phase: redirectedDecision.phase,
    decisionCode: redirectedDecision.decisionCode,
    reason: redirectedDecision.reason,
    toolName: redirectedDecision.toolName,
    modeKind: redirectedDecision.modeKind,
    allowedToolNames: redirectedDecision.allowedToolNames,
  });
}

function buildNoActionReasoningStateSignature(
  reactPatch: Record<string, unknown>,
  nextStepAgent: string | undefined,
): string {
  const retryContext = asRecord(reactPatch.retryContext);
  const latestLedgerEntry = readLatestEvidenceLedgerEntry(reactPatch.evidenceLedger);
  if (
    retryContext === undefined &&
    latestLedgerEntry === undefined
  ) {
    return "";
  }

  return JSON.stringify({
    kind: "no_action_reasoning_state",
    nextStepAgent: nextStepAgent ?? "",
    retryContext: compactRetryContextForLoopGuard(retryContext),
    latestEvidence: latestLedgerEntry,
  });
}

function compactRetryContextForLoopGuard(value: Record<string, unknown> | undefined): unknown {
  if (value === undefined) {
    return ;
  }
  const failure = asRecord(value.failure);
  const details = asRecord(failure?.details);
  return {
    code: typeof failure?.code === "string" ? failure.code : "",
    reason: typeof details?.reason === "string" ? details.reason : "",
    toolName: typeof details?.toolName === "string" ? details.toolName : "",
  };
}

function readLatestEvidenceLedgerEntry(value: unknown): unknown {
  if (Array.isArray(value) === false || value.length === 0) {
    return ;
  }
  const entry = asRecord(value[value.length - 1]);
  if (entry === undefined) {
    return ;
  }
  const target = asRecord(entry.target);
  const nextUse = asRecord(entry.nextUse);
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

function readLatestDecisionRedirect(value: unknown):
  | {
      phase: string;
      decisionCode: string;
      reason: string;
      toolName: string;
      modeKind: string;
      allowedToolNames: unknown;
    }
  | undefined {
  if (Array.isArray(value) === false) {
    return ;
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(value[index]);
    if (entry?.eventType !== "decision.redirected") {
      continue;
    }
    const metadata = asRecord(entry.metadata);
    return {
      phase: typeof entry.phase === "string" ? entry.phase : "",
      decisionCode: typeof entry.decisionCode === "string" ? entry.decisionCode : "",
      reason: typeof metadata?.reason === "string" ? metadata.reason : "",
      toolName: typeof metadata?.toolName === "string" ? metadata.toolName : "",
      modeKind: typeof metadata?.modeKind === "string" ? metadata.modeKind : "",
      allowedToolNames: Array.isArray(metadata?.allowedToolNames) ? metadata.allowedToolNames : [],
    };
  }
  return ;
}

function readLoopHistory(
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
    const record = asRecord(entry);
    if (
      record === undefined ||
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

function buildActionSignature(value: unknown): string {
  const action = asRecord(value);
  if (action === undefined) {
    return "";
  }
  return JSON.stringify({
    kind: typeof action.kind === "string" ? action.kind : "",
    name:
      typeof action.name === "string"
        ? action.name
        : typeof action.type === "string"
          ? action.type
          : "",
    input: sortValue(action.input),
    items: Array.isArray(action.items) ? sortValue(action.items) : undefined,
  });
}

function readToolCycleMarker(
  reactState: Record<string, unknown>,
  value: unknown,
): ToolCycleMarker | undefined {
  const action = asRecord(value);
  if (action === undefined || action.kind !== "tool" || typeof action.name !== "string") {
    return ;
  }
  if (action.name !== "internet.extract") {
    return {
      toolName: action.name,
      inputHash: stableHash(sortValue(action.input)),
      lowYield: false,
    };
  }
  const actionInput = asRecord(action.input);
  const sourceUrl =
    typeof actionInput?.url === "string"
      ? String(actionInput.url)
      : Array.isArray(actionInput?.urls) && typeof actionInput.urls[0] === "string"
        ? String(actionInput.urls[0])
        : undefined;
  const sourceCluster = normalizeSourceCluster(sourceUrl);
  const retrySummary = normalizeWebExtractionRetrySummary(
    asRecord(asRecord(reactState.postToolVerification)?.webExtractionRetrySummary),
  );
  const lowYield =
    sourceCluster !== undefined && isLowYieldSourceClusterStalled(retrySummary, sourceCluster);
  return {
    toolName: action.name,
    inputHash: stableHash(sortValue(action.input)),
    ...(sourceCluster !== undefined ? { sourceCluster } : {}),
    lowYield,
  };
}

function readRetrievalCycleMarker(
  priorReact: Record<string, unknown>,
  reactPatch: Record<string, unknown>,
): RetrievalLoopHistoryEntry | undefined {
  const nextAction = asRecord(reactPatch.nextAction);
  if (nextAction?.kind !== "tool" || typeof nextAction.name !== "string" || isRetrievalToolName(nextAction.name) === false) {
    return ;
  }
  const lastActionResult = asRecord(priorReact.lastActionResult);
  const outputToolName =
    typeof lastActionResult?.toolName === "string"
      ? lastActionResult.toolName
      : typeof lastActionResult?.name === "string"
        ? lastActionResult.name
        : undefined;
  if (
    lastActionResult === undefined ||
    outputToolName === undefined ||
    isRetrievalToolName(outputToolName) === false
  ) {
    return ;
  }
  const inputRecord = asRecord(nextAction.input);
  if (inputRecord === undefined) {
    return ;
  }
  const input = normalizeRetrievalGuardInput(nextAction.name, inputRecord);
  const output = normalizeRetrievalGuardOutput(outputToolName, lastActionResult);
  return {
    toolName: nextAction.name,
    input,
    output,
  };
}

function readNormalizedRetrievalInput(
  value: unknown,
): ReturnType<typeof normalizeRetrievalGuardInput> | undefined {
  const record = asRecord(value);
  const toolName = typeof record?.toolName === "string" ? record.toolName : undefined;
  const primaryText = typeof record?.primaryText === "string" ? record.primaryText : undefined;
  const comparableFields = asRecord(record?.comparableFields);
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

function readNormalizedRetrievalOutput(
  value: unknown,
): ReturnType<typeof normalizeRetrievalGuardOutput> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  return {
    topUrls: readStringArray(record.topUrls),
    topDomains: readStringArray(record.topDomains),
    topSignals: readStringArray(record.topSignals),
  };
}

function isRetrievalHistoryEntry(
  entry: {
    retrievalToolName?: string | undefined;
    retrievalInput?: ReturnType<typeof normalizeRetrievalGuardInput> | undefined;
    retrievalOutput?: ReturnType<typeof normalizeRetrievalGuardOutput> | undefined;
  },
): entry is {
  retrievalToolName: string;
  retrievalInput: ReturnType<typeof normalizeRetrievalGuardInput>;
  retrievalOutput: ReturnType<typeof normalizeRetrievalGuardOutput>;
} {
  return (
    typeof entry.retrievalToolName === "string" &&
    entry.retrievalInput !== undefined &&
    entry.retrievalOutput !== undefined
  );
}

function readPendingExecutionSnapshot(reactState: Record<string, unknown>): Record<string, unknown> {
  const exec = asRecord(reactState.exec);
  return {
    pendingEffectKey: typeof exec?.pendingEffectKey === "string" ? exec.pendingEffectKey : undefined,
    pendingEffectType: typeof exec?.pendingEffectType === "string" ? exec.pendingEffectType : undefined,
    pendingApproval: exec?.pendingApproval,
    waitingFor: reactState.waitingFor,
    pendingToolBatch: exec?.pendingBatch,
    pendingToolCall: exec?.pendingToolCall,
    exec,
  };
}

function buildLoopStallDiagnostics(
  reactState: Record<string, unknown>,
  currentStep: string,
  runtimeError?: RuntimeError | undefined,
): Record<string, unknown> | undefined {
  const history = readLoopHistory(asRecord(reactState.loopGuard)?.history);
  const latestLoopEntry = [...history]
    .reverse()
    .find((entry) => entry.stepName === currentStep || entry.stepName === "agent.loop");
  const activeToolName = readActiveToolName(reactState);
  const runtimeDetails = asRecord(runtimeError?.details);
  const actionSignature = latestLoopEntry?.actionSignature ??
    buildLoopGuardActionSignature(reactState, reactState.nextAction, currentStep);
  const evidenceHash = latestLoopEntry?.evidenceHash ??
    stableHash(normalizeAgentFeedbackForLoopGuard(reactState));
  const visits = readStepVisitCount(runtimeError);
  const guardType =
    typeof runtimeDetails?.guardType === "string"
      ? runtimeDetails.guardType
      : runtimeError?.code ?? "loop_stall";

  const diagnostics: Record<string, unknown> = {
    guardType,
    stepAgent: currentStep,
  };
  if (visits !== undefined) {
    diagnostics.visits = visits;
  }
  if (actionSignature.length > 0) {
    diagnostics.actionSignature = actionSignature;
  }
  if (activeToolName !== undefined || latestLoopEntry?.toolActionName) {
    diagnostics.toolName = activeToolName ?? latestLoopEntry?.toolActionName;
  }
  if (evidenceHash.length > 0) {
    diagnostics.evidenceHash = evidenceHash;
  }
  return Object.keys(diagnostics).length > 2 || runtimeError !== undefined
    ? diagnostics
    : undefined;
}

function hasVisibleTodoFinalizeContinuationSignal(reactState: Record<string, unknown>): boolean {
  const retryContext = asRecord(reactState.retryContext);
  const failure = asRecord(retryContext?.failure);
  const details = asRecord(failure?.details);
  if (asString(details?.reason) === "visible_todo_finalize_continuation") {
    return true;
  }
  const traces = [
    ...asArray(reactState.loopGuardDecisionTrace),
    ...asArray(reactState.decisionTrace),
  ];
  return traces.some((item) =>
    asString(asRecord(item)?.decisionCode) === "visible_todo_finalize_continuation"
  );
}

function hasSuccessfulExecutionEvidence(
  sessionState: Record<string, unknown>,
  reactState: Record<string, unknown>,
): boolean {
  if (hasPassedEvidenceLedger(sessionState)) {
    return true;
  }
  const postToolVerification = asRecord(reactState.postToolVerification);
  if (postToolVerification !== undefined && hasPositivePostToolVerification(postToolVerification)) {
    return true;
  }
  const lastActionResult = asRecord(reactState.lastActionResult);
  if (lastActionResult !== undefined && hasObservedExecutionSuccess(lastActionResult)) {
    return true;
  }
  return false;
}

function hasPassedEvidenceLedger(sessionState: Record<string, unknown>): boolean {
  return asArray(sessionState.evidenceLedger)
    .map((item) => asRecord(item))
    .some((item) => item?.status === "passed");
}

function hasPositivePostToolVerification(verification: Record<string, unknown>): boolean {
  if (asString(verification.resultQuality) !== "ok") {
    return false;
  }
  const newFactsCount = asNumber(verification.newFactsCount);
  if (newFactsCount !== undefined && newFactsCount > 0) {
    return true;
  }
  return asArray(verification.newCapabilities).length > 0;
}

function hasObservedExecutionSuccess(lastActionResult: Record<string, unknown>): boolean {
  if (lastActionResult.ok === false || asString(lastActionResult.status) === "failed") {
    return false;
  }
  const status = asString(lastActionResult.status);
  if (status === undefined) {
    return false;
  }
  const kind = asString(lastActionResult.kind);
  if (kind === "tool_batch") {
    return asArray(lastActionResult.items).length > 0 || asRecord(lastActionResult.output) !== undefined;
  }
  return kind === "tool" && asRecord(lastActionResult.output) !== undefined;
}

function buildDocumentedFinalizeGapMessage(gap: {
  openGap?: string | undefined;
  knownWarnings: string[];
}): string {
  const gapText = gap.openGap ?? gap.knownWarnings[0] ?? "A residual validation risk was documented.";
  return `The requested work has validation evidence and is ready to finalize. Remaining residual risk: ${gapText}`;
}

function isRecoverableDispatchLoopGuard(runtimeError: RuntimeError, currentStep: string | undefined): boolean {
  if (runtimeError.code !== "LOOP_GUARD_TRIGGERED") {
    return false;
  }
  const details = asRecord(runtimeError.details);
  return currentStep === "agent.exec.dispatch" &&
    (details?.guardType === "IDENTICAL_CONTROL_STATE" ||
      details?.guardType === "NO_PROGRESS_REASONING_LOOP");
}

function readStepVisitCount(runtimeError: RuntimeError | undefined): number | undefined {
  if (runtimeError === undefined) {
    return ;
  }
  const match = runtimeError.message.match(/visited\s+(\d+)\s+times/u);
  if (match === null) {
    return ;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

function readConcreteLoopStallTarget(
  reactState: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const nextAction = asRecord(reactState.nextAction);
  if (nextAction === undefined) {
    return ;
  }
  if (nextAction.kind === "tool") {
    return readConcreteToolTarget(nextAction);
  }
  if (nextAction.kind !== "tool_batch" || Array.isArray(nextAction.items) === false) {
    return ;
  }
  for (const item of nextAction.items) {
    const target = readConcreteToolTarget(asRecord(item));
    if (target !== undefined) {
      return {
        ...target,
        batch: true,
      };
    }
  }
  return ;
}

function readConcreteToolTarget(
  action: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (action === undefined || typeof action.name !== "string") {
    return ;
  }
  const input = asRecord(action.input);
  if (input === undefined) {
    return ;
  }
  const fields = [
    "path",
    "targetPath",
    "sourcePath",
    "cwd",
    "workspaceRoot",
    "sourceWorkspaceRoot",
    "processId",
    "sessionId",
    "url",
    "command",
  ];
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    const trimmed = value.trim();
    const displayValue = trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
    return {
      kind: "tool_input",
      toolName: action.name,
      field,
      value: displayValue,
      label: `${action.name} ${field}=${displayValue}`,
    };
  }
  return ;
}

function readActiveToolName(reactState: Record<string, unknown>): string | undefined {
  const nextAction = asRecord(reactState.nextAction);
  if (nextAction?.kind === "tool" && typeof nextAction.name === "string") {
    return nextAction.name;
  }
  const lastActionResult = asRecord(reactState.lastActionResult);
  if (typeof lastActionResult?.name === "string") {
    return lastActionResult.name;
  }
  if (typeof lastActionResult?.toolName === "string") {
    return lastActionResult.toolName;
  }
  const exec = asRecord(reactState.exec);
  const dispatchReuseGuard = asRecord(exec?.dispatchReuseGuard);
  return typeof dispatchReuseGuard?.toolName === "string"
    ? dispatchReuseGuard.toolName
    : undefined;
}

function buildVerifiedRetrievalSynthesisEvidenceSnapshot(
  reactState: Record<string, unknown>,
  summary: ResearchStallSummary,
): Record<string, unknown> {
  return {
    objective: summary.objectiveKey,
    completedSoFar: summary.completedSoFar,
    retrievalGuard: {
      verifiedEvidenceAvailable: true,
      ...(summary.guardType !== undefined ? { guardType: summary.guardType } : {}),
      ...(summary.guardToolName !== undefined ? { guardToolName: summary.guardToolName } : {}),
      ...(summary.guardRepeats !== undefined ? { guardRepeats: summary.guardRepeats } : {}),
      ...(summary.guardThreshold !== undefined ? { guardThreshold: summary.guardThreshold } : {}),
      ...(summary.retrievalToolFamily !== undefined ? { retrievalToolFamily: summary.retrievalToolFamily } : {}),
    },
    ...(summary.evidenceRecovery !== undefined ? { evidenceRecovery: summary.evidenceRecovery } : {}),
    ...(summary.webExtraction !== undefined ? { webExtraction: summary.webExtraction } : {}),
    ...(reactState.lastActionResult !== undefined ? { lastActionResult: reactState.lastActionResult } : {}),
    ...(reactState.postToolVerification !== undefined
      ? { postToolVerification: reactState.postToolVerification }
      : {}),
    ...(reactState.capabilityEvidence !== undefined ? { capabilityEvidence: reactState.capabilityEvidence } : {}),
    ...(reactState.observations !== undefined ? { observations: reactState.observations } : {}),
  };
}

function readTruncatedToolArtifactsForResume(
  lastActionResult: unknown,
):
  | {
      artifactIds: string[];
      digestArtifactIds: string[];
      digestSummaries: Record<string, unknown>[];
    }
  | undefined {
  const lastAction = asRecord(lastActionResult);
  if (lastAction === undefined) {
    return ;
  }

  const outputs: Record<string, unknown>[] = [];
  const directOutput = asRecord(lastAction.output);
  if (directOutput !== undefined) {
    outputs.push(directOutput);
  }
  const itemOutputs = (Array.isArray(lastAction.items) ? lastAction.items : [])
    .map((item) => asRecord(asRecord(item)?.output))
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
    .map((output) => asRecord(output.digestSummary))
    .filter((summary): summary is Record<string, unknown> => summary !== undefined)
    .slice(0, 5);

  return {
    artifactIds,
    digestArtifactIds,
    digestSummaries,
  };
}

function buildRecoveredArtifactSourceIndex(artifacts: PersistedArtifact[]): Record<string, unknown>[] {
  return artifacts
    .flatMap((artifact) => {
      const payload = asRecord(artifact.payload);
      const output = asRecord(payload?.output);
      const toolName = readNonEmptyString(payload?.toolName);
      const results = Array.isArray(output?.results)
        ? output.results
        : Array.isArray(output?.items)
          ? output.items
          : [];
      return results.flatMap((item) => {
        const result = asRecord(item);
        if (result === undefined) {
          return [];
        }
        const title =
          readNonEmptyString(result.title) ??
          readNonEmptyString(result.name) ??
          readNonEmptyString(result.headline);
        const url =
          readNonEmptyString(result.url) ??
          readNonEmptyString(result.link) ??
          readNonEmptyString(result.href);
        if (title === undefined && url === undefined) {
          return [];
        }
        const source =
          readNonEmptyString(result.source) ??
          readNonEmptyString(result.publisher) ??
          readNonEmptyString(result.domain);
        const publishedAt =
          readNonEmptyString(result.publishedAt) ??
          readNonEmptyString(result.published_at) ??
          readNonEmptyString(result.date);
        return [{
          artifactId: artifact.artifactId,
          ...(title !== undefined ? { title } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(publishedAt !== undefined ? { publishedAt } : {}),
          ...(toolName !== undefined ? { toolName } : {}),
        }];
      });
    })
    .slice(0, 25);
}

function extractVerifiedRetrievalSynthesisMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeSynthesisMessage(value);
  }
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  const direct =
    readNonEmptyString(record.message) ??
    readNonEmptyString(record.text) ??
    readNonEmptyString(record.output);
  if (direct !== undefined) {
    return normalizeSynthesisMessage(direct);
  }
  const output = asRecord(record.output);
  if (output === undefined) {
    return ;
  }
  return normalizeSynthesisMessage(
    readNonEmptyString(output.message) ??
      readNonEmptyString(output.text) ??
      readNonEmptyString(output.summary),
  );
}

function normalizeSynthesisMessage(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function asksToContinue(message: string): boolean {
  return /next if you want me to continue|if you want me to continue|should i continue|want me to continue/iu.test(
    message,
  );
}

function renderVerifiedRetrievalSynthesisSystemPrompt(): string {
  return [
    "You are Kestrel's Retrieval Finalizer.",
    "Your job is to write a user-facing final answer after retrieval was stopped for redundancy.",
    "Use only the verified evidence in the user message.",
    "Do not ask whether to continue.",
    "Do not call or mention tools.",
    "If URLs are present in the verified evidence, cite them directly in the answer.",
  ].join(" ");
}

function renderVerifiedRetrievalSynthesisUserPrompt(input: {
  objective: string;
  evidence: unknown;
}): string {
  return [
    "Write the final answer from the verified retrieval evidence.",
    "",
    "<context_guide>",
    "- `objective` is the user's requested answer or output.",
    "- `verifiedEvidence` is the only evidence you may use.",
    "- Evidence may include recovered artifacts, source indexes, summaries, URLs, and recovery diagnostics.",
    "- If a claim is not supported by `verifiedEvidence`, omit it or caveat it as unsupported.",
    "- Do not infer beyond the provided evidence and do not suggest another retrieval step.",
    "</context_guide>",
    "",
    "<answer_rule>",
    "Answer the objective directly. Cite URLs that appear in the verified evidence. Keep unsupported uncertainty explicit.",
    "</answer_rule>",
    "",
    "<context_json>",
    JSON.stringify({
      objective: input.objective,
      verifiedEvidence: input.evidence,
    }),
    "</context_json>",
  ].join("\n");
}

function readMaybeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCycleKind(stepName: string): string {
  if (
    stepName === "agent.loop" ||
    stepName === "agent.loop" ||
    stepName === "agent.exec.dispatch"
  ) {
    return "reasoning";
  }
  return "";
}

function resolveLegacyExecutionStep(reactState: Record<string, unknown>): string {
  const exec = asRecord(reactState.exec);
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
  const nextAction = asRecord(reactState.nextAction);
  const kind = typeof nextAction?.kind === "string" ? nextAction.kind : "";
  if (kind === "finalize" || kind === "cannot_satisfy") {
    return "agent.exec.finalize";
  }
  return "agent.exec.dispatch";
}

function resolveExecSubstateForStep(stepAgent: string): string | undefined {
  if (stepAgent.startsWith("agent.exec.")) {
    return stepAgent.slice("agent.exec.".length);
  }
  return ;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function stableHash(value: unknown): string {
  return hashUnknown(sortValue(value));
}

function hashUnknown(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
