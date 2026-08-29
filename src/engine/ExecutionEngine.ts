import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RunEventType, RuntimeError, TransitionStatus } from "../kestrel/contracts/base.js";
import type { MemorySnapshot, ProgressPhase, ProgressUpdateV1, RunEvent, RunLogEntry, RuntimeEvent } from "../kestrel/contracts/events.js";
import type { Effect, GuardrailConfig, ManagedTaskWorktreeBinding, NormalizedOutput, RegionWorkItem, ResolvedEffect, RuntimeDependencies, StepContext, StepIO, StepTransition, Transition } from "../kestrel/contracts/execution.js";
import type { AgentToolResult, ModelRequest, ToolConsoleSink } from "../kestrel/contracts/model-io.js";
import {
  parseDurablePreparedToolCallV1,
  type AgentToolResultV2,
} from "../kestrel/contracts/tool-invocation.js";
import {
  hashCanonical,
  parseToolSurfaceSnapshotV1,
} from "../kestrel/contracts/tool-contract.js";
import type {
  PersistedEffect,
  SessionRecord,
} from "../kestrel/contracts/store.js";
import { validatePreparedApprovalCleanupDoneEvidence } from "../kestrel/contracts/store.js";
import { replaceAgentToolResultOutput } from "../../tools/toolResult.js";
import {
  createRunnerStructuredReviewInteractionV1,
  parseRunnerExternalApprovalBindingV1,
  parseRunnerExternalApprovalBindingV2,
  parseRunnerPreparedApprovalCleanupV1,
  serializeCanonicalApprovalPayload,
} from "@kestrel-agents/protocol";

import { GuardrailViolationError, Guardrails } from "./Guardrails.js";
import { ToolJobQueue } from "./ToolJobQueue.js";
import { asRuntimeError, createRuntimeFailure, RunCancelledError } from "../runtime/RuntimeFailure.js";
import { normalizeInteractionMode } from "../mode/contracts.js";
import {
  clearRuntimeWaitState,
  readActiveWaitState,
} from "../runtime/waitState.js";
import {
  classifyUserReplyIntent,
  readUserReplyIntent,
} from "../runtime/userReplyIntent.js";
import {
  buildRecoveryAdaptationVerdict,
  isResearchRecoveryToolName,
} from "../runtime/recoveryVerdict.js";
import {
  LEGACY_FILESYSTEM_RESUME_STOP_REASON,
  isBroadResumeBudgetExhausted,
  buildFilesystemResumeReadBudgetDetail,
  type FilesystemResumeReadBudgetDetail,
} from "../runtime/filesystemResumeBudget.js";
import { validateRuntimeSessionState } from "../runtime/state.js";
import {
  buildRuntimeStateDiagnosticMetadata,
  readInvalidStatePath,
} from "../runtime/stateDiagnostics.js";
import {
  compactModelTranscript,
  rebaseModelTranscriptAfterCompaction,
} from "../runtime/modelTranscript.js";
import type { HeapPressureSample } from "../runtime/heapDiagnostics.js";
import {
  isRetrievalToolName,
  readRetrievalToolFamily,
} from "./retrievalLoopGuard.js";
import { isMutationCapableToolName } from "../runtime/mutationTools.js";
import { RegionScheduler } from "./RegionScheduler.js";
import type { ProductProjectSetupState } from "../project/contracts.js";
import { WorkspaceLifecycleService } from "../workspace/WorkspaceLifecycleService.js";
import { WorkspaceLifecycleCoordinator } from "./WorkspaceLifecycleCoordinator.js";
import { WaitResumeCoordinator } from "./WaitResumeCoordinator.js";
import { StepCommitPipeline } from "./StepCommitPipeline.js";
import { LoopGuardCoordinator } from "./LoopGuardCoordinator.js";
import { RunLifecycleController } from "./RunLifecycleController.js";
import {
  StepRunner,
  type StepRunnerObservabilityFrame,
  type StepRunnerState,
} from "./StepRunner.js";
import {
  ContinuationCoordinator,
  FRESH_TURN_AGENT_CONTROL_KEYS,
  type ContinuationState,
  type ContinuationWaitReason,
} from "./ContinuationCoordinator.js";
import {
  KNOWN_RUN_EVENT_TYPES,
  assertModelCallAdmission,
  buildContinuationNextActions,
  buildContinuationPartialAnswer,
  buildModelInputSnapshot,
  buildResearchStallPartialAnswer,
  countTrailingLoopCyclesWithSameEvidence,
  isRecoverableDispatchLoopGuard,
  latestObservationSummary,
  parseApprovalDecisionFromPayload,
  readActiveToolName,
  readCapabilityClassesFromFeedback,
  readLastToolSnapshot,
  readLoopHistory,
  readModelBudgetClass,
  readMaybeNumber,
  readResearchObjective,
  readTruncatedToolArtifactsForResume,
  resolveExecSubstateForStep,
  resolveLegacyExecutionStep,
  resolveTerminalReasonCode,
  summarizeUnknown,
} from "./ExecutionEngineSupport.js";
import { RuntimeIO } from "./RuntimeIO.js";
import {
  RuntimeEvaluationCoordinator,
  type RuntimeEvaluationEvidenceInputV1,
  type RuntimeEvaluationHookResultV1,
} from "../evaluation/RuntimeEvaluationCoordinator.js";
import {
  createEvaluationReviewBindingV1,
  parseEvaluationReviewBindingV1,
  parseRuntimeEvaluationDecisionV1,
  parseRuntimeEvaluationRequestV1,
  parseRuntimeEvaluationVerdictV1,
  type EvaluationReviewBindingV1,
} from "../kestrel/contracts/evaluation.js";
import {
  digestCanonicalValue as digestBoundaryValue,
  parseExecutionBoundaryDecisionV1,
} from "../kestrel/contracts/execution-boundary-policy.js";
import { resolveKestrelHomePath } from "../runtime/kestrelHome.js";
import { ExecutionBoundaryPolicyRuntime } from "../security/ExecutionBoundaryPolicy.js";
import {
  buildPersistedRuntimeEventFromProgressUpdate,
} from "../events/RuntimeEventProjections.js";
import { resolveKestrelTurnObjective } from "../runtime/turnObjective.js";
import { redactDiagnosticText } from "../diagnostics/redaction.js";
import { isPreparedApprovalCleanupRelease } from "../effects/EffectRunner.js";
import { parsePreparedApprovalCleanupTerminalV1 } from "../runtime/preparedApprovalCleanupTerminal.js";
import type { PreparedApprovalCleanupTerminalV1 } from "../runtime/preparedApprovalCleanupTerminal.js";

export { readModelRequestSchemaName } from "./ExecutionEngineSupport.js";

export { FRESH_TURN_AGENT_CONTROL_KEYS } from "./ContinuationCoordinator.js";

const DEFAULT_GUARDRAILS: GuardrailConfig = {
  maxStepsPerRun: 1000,
  maxToolCallsPerRun: 500,
  maxModelCallsPerRun: 100,
  maxMaintenanceModelCallsPerRun: 8,
  maxStepVisits: 80,
  maxConcurrentToolJobsPerRun: 8,
  maxConcurrentToolJobsGlobal: 24,
  maxQueuedToolJobsPerRun: 50,
  maxQueuedToolJobsGlobal: 200,
  toolBatchCheckpointSize: 10,
  toolCallRetryCount: 1,
};
const RECOVERY_FAILURE_SUMMARY_MAX_CHARS = 512;
const DEFAULT_PROGRESS_HEARTBEAT_MS = 2000;
const MAX_PROGRESS_MESSAGE_LENGTH = 140;
const MODEL_PROMPT_DUMP_ENV = "KESTREL_MODEL_PROMPT_DUMP";
const MODEL_PROMPT_DUMP_DIR_ENV = "KESTREL_MODEL_PROMPT_DUMP_DIR";
const RETIRED_FRESH_TURN_AGENT_CONTROL_KEYS = [
  // Compatibility scrub only: these were persisted by the retired observer role.
  "observerJudgment",
  "observerStatus",
  "observerHandoff",
  "observerConvergence",
] as const;
const ALL_FRESH_TURN_AGENT_CONTROL_KEYS = [
  ...FRESH_TURN_AGENT_CONTROL_KEYS,
  ...RETIRED_FRESH_TURN_AGENT_CONTROL_KEYS,
] as const;

function summarizeRecoveryFailureMessage(message: string): string | undefined {
  const summary = redactDiagnosticText(message).value.replace(/\s+/gu, " ").trim();
  if (summary.length === 0) {
    return undefined;
  }
  if (summary.length <= RECOVERY_FAILURE_SUMMARY_MAX_CHARS) {
    return summary;
  }
  return `${summary.slice(0, RECOVERY_FAILURE_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

function recoveryReviewOptionDescriptor(id: string): {
  id: string;
  label: string;
  description: string;
  kind: "retry" | "terminal" | "alternative";
} {
  if (id === "retry.primary") {
    return {
      id,
      label: "Retry",
      description: "Retry the primary recovery route.",
      kind: "retry",
    };
  }
  if (id === "terminal.fail") {
    return {
      id,
      label: "Stop",
      description: "Stop recovery and fail this run.",
      kind: "terminal",
    };
  }
  return {
    id,
    label: id,
    description: "Continue with this recovery option.",
    kind: "alternative",
  };
}

interface RunLifecycleObservabilityFrame {
  runId: string;
  sessionId: string;
  runLogs: RunLogEntry[];
  runEvents: RunEvent[];
}

function buildFinalEvaluationEvidence(input: {
  agent: Record<string, unknown>;
  transition: StepTransition;
}): RuntimeEvaluationEvidenceInputV1[] {
  const evidence: RuntimeEvaluationEvidenceInputV1[] = [];
  if (input.agent.lastActionResult !== undefined) {
    evidence.push({
      evidenceId: "final-last-action-result",
      kind: "tool",
      value: input.agent.lastActionResult,
    });
  }
  if ((input.transition.claims?.length ?? 0) > 0) {
    evidence.push({
      evidenceId: "final-transition-claims",
      kind: "claim",
      value: input.transition.claims,
    });
  }
  if ((input.transition.artifacts?.length ?? 0) > 0) {
    evidence.push({
      evidenceId: "final-transition-artifacts",
      kind: "artifact",
      value: input.transition.artifacts,
    });
  }
  return evidence;
}

function buildEvaluationRevisionContext(input: {
  candidate: string;
  result: RuntimeEvaluationHookResultV1;
}): Record<string, unknown> {
  const verdict = input.result.verdict;
  return {
    failure: {
      code: input.result.decision.reasonCode,
      message: "The previous candidate did not pass the configured delivery evaluation.",
    },
    requiredCorrection: {
      evaluation: {
        action: "revise_final_output",
        decisionId: input.result.decision.decisionId,
        rationale: verdict?.rationale ?? input.result.decision.reasonCode,
        reasonCodes: verdict?.reasonCodes ?? [input.result.decision.reasonCode],
        assertions: verdict?.assertions.map((assertion) => ({
          assertionId: assertion.assertionId,
          passed: assertion.passed,
          rationale: assertion.rationale,
          evidenceRefs: assertion.evidenceRefs,
        })) ?? [],
        evidenceReferences: verdict?.assertions.flatMap(
          (assertion) => assertion.evidenceRefs,
        ) ?? [],
      },
    },
    previousResponse: input.candidate,
  };
}

function evaluationRecoveryFailureCode(
  decision: ReturnType<typeof parseRuntimeEvaluationDecisionV1>,
): string {
  switch (decision.reasonCode) {
    case "EVALUATION_QUARANTINED":
      return "EVALUATION_QUARANTINED";
    case "EVALUATION_LOW_CONFIDENCE":
      return "EVALUATION_LOW_CONFIDENCE";
    case "EVALUATION_REJECTED_AFTER_REVISION":
      return "EVALUATION_REJECTED_AFTER_REVISION";
    default:
      return "EVALUATION_UNAVAILABLE";
  }
}

function digestEvaluationCandidate(candidate: string): string {
  return `sha256:${createHash("sha256").update(candidate).digest("hex")}`;
}

function readPendingToolApproval(
  state: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  return record(record(record(state.agent)?.exec)?.pendingApproval) ??
    record(record(record(state.react)?.exec)?.pendingApproval);
}

function digestExternalApprovalPayload(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(serializeCanonicalApprovalPayload(value))
    .digest("hex")}`;
}

interface RunEventAppendOptions {
  bypassBuffer?: boolean;
}

interface ProgressEmitOptions extends Omit<ProgressUpdateV1, "version" | "ts"> {
  bypassRunEventBuffer?: boolean;
}

type ProgressPersistGranularity = "full" | "compact";

export function shouldPersistProgressUpdate(
  update: ProgressUpdateV1,
  granularity: ProgressPersistGranularity,
): boolean {
  if (granularity === "full") {
    return true;
  }
  if (update.code.endsWith("FAILED")) {
    return true;
  }
  return (
    update.code === "RUN_STARTED" ||
    update.code === "RUN_COMPLETED" ||
    update.code === "RUN_TERMINAL" ||
    update.code === "WAITING_FOR_EVENT" ||
    update.code === "STEP_COMMITTED" ||
    update.code === "TOOL_CALL_DONE" ||
    update.code === "MODEL_CALL_DONE" ||
    update.code === "MODEL_ATTEMPT_RETRYING"
  );
}

export class ExecutionEngine {
  private readonly deps: RuntimeDependencies;
  private readonly guardrailConfig: GuardrailConfig;
  private readonly toolJobQueue = new ToolJobQueue();
  private readonly toolQueueEnabled: boolean;
  private readonly stepFrameStore = new AsyncLocalStorage<StepRunnerObservabilityFrame>();
  private readonly runLifecycleFrameStore = new AsyncLocalStorage<RunLifecycleObservabilityFrame>();
  private readonly regionScheduler: RegionScheduler;
  private readonly workspaceLifecycleService: WorkspaceLifecycleService | undefined;
  private readonly workspaceLifecycleCoordinator: WorkspaceLifecycleCoordinator;
  private readonly waitResumeCoordinator: WaitResumeCoordinator;
  private readonly stepCommitPipeline: StepCommitPipeline;
  private readonly continuationCoordinator: ContinuationCoordinator;
  private readonly loopGuardCoordinator: LoopGuardCoordinator;
  private readonly runLifecycleController: RunLifecycleController;
  private readonly stepRunner: StepRunner;
  private readonly stepFrameBufferEnabled: boolean;
  private readonly progressPersistGranularity: ProgressPersistGranularity;
  private readonly loggedHeapPressureKeys = new Set<string>();
  private readonly evaluationCoordinator: RuntimeEvaluationCoordinator | undefined;
  private readonly executionBoundaryRuntime: ExecutionBoundaryPolicyRuntime;

  constructor(deps: RuntimeDependencies, guardrailConfig?: Partial<GuardrailConfig>) {
    this.deps = deps;
    this.executionBoundaryRuntime =
      deps.executionBoundaryRuntime ?? new ExecutionBoundaryPolicyRuntime();
    this.guardrailConfig = {
      ...DEFAULT_GUARDRAILS,
      ...guardrailConfig,
      maxMaintenanceModelCallsPerRun: 8,
    };
    this.toolQueueEnabled = this.resolveToolQueueEnabled();
    const evaluationRuntime = this.deps.evaluationRuntime;
    this.evaluationCoordinator = evaluationRuntime === undefined
      ? undefined
      : new RuntimeEvaluationCoordinator({
          ...evaluationRuntime,
          store: this.deps.store,
          executionBoundaryRuntime: this.executionBoundaryRuntime,
          appendLifecycleEvent: (event) =>
            this.appendRunEvent(
              event.runId,
              event.sessionId,
              event.type,
              event.level,
              event.metadata,
              event.stepIndex,
              { bypassBuffer: true },
            ),
        });
    this.regionScheduler = new RegionScheduler({
      store: this.deps.store,
    });
    this.workspaceLifecycleService = this.deps.managedTaskWorktreeService === undefined
      ? undefined
      : new WorkspaceLifecycleService(this.deps.managedTaskWorktreeService);
    this.workspaceLifecycleCoordinator = new WorkspaceLifecycleCoordinator({
      runtimeDeps: this.deps,
      ...(this.workspaceLifecycleService !== undefined
        ? { workspaceLifecycleService: this.workspaceLifecycleService }
        : {}),
      appendRunEvent: (runId, sessionId, type, level, metadata, stepIndex) =>
        this.appendRunEvent(runId, sessionId, type, level, metadata, stepIndex),
      classifyApprovalIntent: (event, pendingApproval) =>
        this.withClassifiedApprovalIntent(event, pendingApproval),
    });
    this.waitResumeCoordinator = new WaitResumeCoordinator({
      appendRunEvent: (runId, sessionId, type, level, metadata, stepIndex) =>
        this.appendRunEvent(runId, sessionId, type, level, metadata, stepIndex),
    });
    this.runLifecycleController = new RunLifecycleController({
      deps: {
        store: this.deps.store,
        outputNormalizer: this.deps.outputNormalizer,
      },
      guardrailConfig: this.guardrailConfig,
      waitResumeCoordinator: this.waitResumeCoordinator,
      normalizeLegacyExecutionSession: (session) =>
        session === null || session === undefined
          ? undefined
          : this.normalizeLegacyExecutionSession(session),
      appendRunEvent: (runId, sessionId, type, level, metadata, stepIndex) =>
        this.appendRunEvent(runId, sessionId, type, level, metadata, stepIndex),
      emitProgress: (input) => this.emitProgress(input),
      logInfo: (entry) => this.logInfo(entry),
      logWarn: (entry) => this.logWarn(entry),
      logError: (entry) => this.logError(entry),
      releaseManagedWorktreeLeaseForRun: (runId, session, terminalStatus) =>
        this.releaseManagedWorktreeLeaseForRun(runId, session, terminalStatus),
      settleOwnedExecCommandProcesses: (runId, session) =>
        this.settleOwnedExecCommandProcesses(runId, session),
      resolveRuntimeBudget: (event) => this.resolveRuntimeBudget(event),
      resolveProgressPhase: (stepAgent) => this.resolveProgressPhase(stepAgent),
      resolveFilesystemResumeReadBudget: (input) => this.resolveFilesystemResumeReadBudget(input),
      mergeOrchestrationEventMetadata: (event, waitFor) =>
        this.mergeOrchestrationEventMetadata(event, waitFor),
    });
    this.stepCommitPipeline = new StepCommitPipeline({
      store: this.deps.store,
    });
    this.continuationCoordinator = new ContinuationCoordinator({
      runtimeDeps: this.deps,
      guardrailConfig: this.guardrailConfig,
      waitResumeCoordinator: this.waitResumeCoordinator,
      appendRunEvent: (runId, sessionId, type, level, metadata, stepIndex) =>
        this.appendRunEvent(runId, sessionId, type, level, metadata, stepIndex),
      mapError: (error) => this.mapError(error),
      ...(this.deps.continuationCheckpointModel !== undefined
        ? { checkpointModel: this.deps.continuationCheckpointModel }
        : {}),
      callMaintenanceModel: (input) => this.callContinuationMaintenanceModel(input),
      returnTerminal: (
        runId,
        sessionId,
        finalStep,
        transition,
        errors,
        guardrails,
        progressSeq,
        continuation,
      ) =>
        this.runLifecycleController.returnTerminal({
          runId,
          sessionId,
          currentStep: finalStep,
          transition,
          errors,
          guardrails,
          progressSeq,
          continuation,
        }),
    });
    this.loopGuardCoordinator = new LoopGuardCoordinator({
      runtimeDeps: this.deps,
      waitResumeCoordinator: this.waitResumeCoordinator,
      appendRunEvent: (runId, sessionId, type, level, metadata, stepIndex) =>
        this.appendRunEvent(runId, sessionId, type, level, metadata, stepIndex),
      logInfo: (entry) => this.logInfo(entry),
      returnTerminal: (
        runId,
        sessionId,
        finalStep,
        transition,
        errors,
        guardrails,
        progressSeq,
        continuation,
      ) =>
        this.runLifecycleController.returnTerminal({
          runId,
          sessionId,
          currentStep: finalStep,
          transition,
          errors,
          guardrails,
          progressSeq,
          continuation,
        }),
      normalizeReactRuntimePatch: (stepName, reactPatch, transition) =>
        this.normalizeReactRuntimePatch(stepName, reactPatch, transition),
      readConcreteRepairTargetPath: (reactState) =>
        this.readConcreteRepairTargetPath(reactState),
      isUnattendedRepairContinuation: (event, reactState) =>
        this.isUnattendedRepairContinuation(event, reactState),
      buildResearchStallSummary: (reactState, currentStep, runtimeError) =>
        this.buildResearchStallSummary(reactState, currentStep, runtimeError),
      isBuildModeRun: (reactState, event) =>
        this.isBuildModeRun(reactState, event),
    });
    this.stepRunner = new StepRunner({
      registry: this.deps.registry,
      store: this.deps.store,
      effectRunner: this.deps.effectRunner,
      outbox: this.deps.outbox,
      regionScheduler: this.regionScheduler,
      stepCommitPipeline: this.stepCommitPipeline,
      runLifecycleController: this.runLifecycleController,
      buildRegionMergeWait: (input) =>
        this.waitResumeCoordinator.buildRegionMergeWait(input),
      throwIfAborted: (signal) => this.throwIfAborted(signal),
      resolveProgressPhase: (stepAgent) => this.resolveProgressPhase(stepAgent),
      prepareAutoManagedWorktreeForSelectedDevTool: (input) =>
        this.prepareAutoManagedWorktreeForSelectedDevTool(input),
      createStepContext: (
        runId,
        session,
        event,
        stepIndex,
        memory,
        budget,
        stateNode,
        region,
      ) =>
        this.createStepContext(runId, session, event, stepIndex, memory, budget, stateNode, region),
      createStepIO: (guardrails, progress, session, runtimeMetadata, runtimePayload, onSessionUpdated) =>
        this.createStepIO(guardrails, progress, session, runtimeMetadata, runtimePayload, onSessionUpdated),
      resolveMemorySnapshot: (sessionState) => this.resolveMemorySnapshot(sessionState),
      resolveStateNode: (sessionState) => this.resolveStateNode(sessionState),
      appendRunEvent: (runId, sessionId, type, level, metadata, stepIndex, options) =>
        this.appendRunEvent(
          runId,
          sessionId,
          type,
          level,
          metadata,
          stepIndex,
          options?.bypassBuffer === undefined ? undefined : { bypassBuffer: options.bypassBuffer },
        ),
      logInfo: (entry) => this.logInfo(entry),
      logWarn: (entry) => this.logWarn(entry),
      emitProgress: (input) => {
        const progressInput = {
          runId: input.runId,
          sessionId: input.sessionId,
          seq: input.seq,
          kind: input.kind,
          phase: input.phase,
          code: input.code,
          message: input.message,
          ...(input.stepIndex === undefined ? {} : { stepIndex: input.stepIndex }),
          ...(input.stepAgent === undefined ? {} : { stepAgent: input.stepAgent }),
          ...(input.waitFor === undefined ? {} : { waitFor: input.waitFor }),
          ...(input.progress === undefined ? {} : { progress: input.progress }),
          persist: input.persist,
          ...(input.bypassRunEventBuffer === undefined
            ? {}
            : { bypassRunEventBuffer: input.bypassRunEventBuffer }),
        };
        return this.emitProgress(progressInput);
      },
      appendRuntimeEventIntents: (input) => this.appendRuntimeEventIntents(input),
      maybeAppendManagedWorktreeApprovalRequested: (runId, sessionId, transition, stepIndex) =>
        this.maybeAppendManagedWorktreeApprovalRequested(runId, sessionId, transition, stepIndex),
      createStepObservabilityFrame: (stepIndex) => this.createStepObservabilityFrame(stepIndex),
      runStepWithFrame: (frame, execute) =>
        this.stepFrameBufferEnabled ? this.stepFrameStore.run(frame, execute) : execute(),
      flushStepObservabilityFrame: (frame) => this.flushStepObservabilityFrame(frame),
      appendDecisionTraceEvents: (runId, sessionId, stepIndex, statePatch) =>
        this.appendDecisionTraceEvents(runId, sessionId, stepIndex, statePatch),
      stripDecisionTraceFromStatePatch: (statePatch) =>
        this.stripDecisionTraceFromStatePatch(statePatch),
      mapError: (error) => this.mapError(error),
      buildRunningTransition: (sessionState) => ({
        status: "RUNNING",
        statePatch: {
          agent: this.asRecord(sessionState.agent) ?? {},
        },
      }),
      maybeBuildConcreteRepairContinuation: (input) => this.maybeBuildConcreteRepairContinuation(input),
      recordConcreteRepairContinuation: (input) => this.recordConcreteRepairContinuation(input),
      maybeBuildVerifiedRetrievalContinuation: (input) => this.maybeBuildVerifiedRetrievalContinuation(input),
      recordVerifiedRetrievalContinuation: (input) => this.recordVerifiedRetrievalContinuation(input),
      applyRuntimeStateGuards: (runId, sessionId, stepIndex, stepName, sessionState, statePatch, transition) =>
        this.applyRuntimeStateGuards(runId, sessionId, stepIndex, stepName, sessionState, statePatch, transition),
      mergeStatePatchWithRegionLaneCursor: (sessionState, statePatch, laneCursor) =>
        this.mergeStatePatchWithRegionLaneCursor(sessionState, statePatch, laneCursor),
      resolveEffects: (
        effects,
        runId,
        stepIndex,
        runtimePayload,
        session,
        runtimeBudgetRemainingMs,
      ) => this.resolveEffects(
        effects,
        runId,
        stepIndex,
        runtimePayload,
        session,
        runtimeBudgetRemainingMs,
      ),
      resolveTransitionMemory: (sessionState, statePatch, fallback) =>
        this.resolveTransitionMemory(sessionState, statePatch, fallback),
      handleRegionMergeConflict: (input) => this.handleRegionMergeConflict(input),
      validateStepContract: async (input) => {
        if (this.deps.stepContractRegistry === undefined) {
          return;
        }
        try {
          this.deps.stepContractRegistry.validate({
            stepName: input.stepName,
            transition: input.transition,
            context: input.context,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.appendRunEvent(
            input.runId,
            input.sessionId,
            "step.contract_failed",
            "WARN",
            {
              step: input.stepName,
              message,
            },
            input.stepIndex,
          );
          throw error;
        }
      },
      sampleHeap: (input) => this.sampleHeap(input),
      runtimeEvaluationEnabled: this.evaluationCoordinator !== undefined,
      evaluateRuntimeTransition: (input) =>
        this.evaluateRuntimeTransition(input),
    });
    this.stepFrameBufferEnabled = this.resolveStepFrameBufferEnabled();
    this.progressPersistGranularity = this.resolveProgressPersistGranularity();
  }

  async evaluateAdvisoryRuntimeHook(
    input: import("../evaluation/RuntimeEvaluationCoordinator.js").RuntimeEvaluationHookInputV1,
  ): Promise<RuntimeEvaluationHookResultV1 | undefined> {
    if (input.hookKind === "pre_delivery") {
      throw new Error(
        "The blocking pre-delivery hook may only run through StepRunner.",
      );
    }
    return this.evaluationCoordinator?.evaluateHook(input);
  }

  async run(
    event: RuntimeEvent,
    options: {
      signal?: AbortSignal | undefined;
      runId?: string | undefined;
      runStart?: "create" | "prestarted" | undefined;
    } = {},
  ): Promise<NormalizedOutput> {
    const runId = options.runId ?? this.runLifecycleController.createRunId();
    const runStartedAt = Date.now();
    let guardrails = this.runLifecycleController.createGuardrails(event);
    const errors: RuntimeError[] = [];
    let continuation: NormalizedOutput["continuation"] | undefined;
    let progressSeq = 0;
    let lastStepAgent: string | undefined = event.stepAgent;
    let session: SessionRecord | undefined;
    let stepRunnerState: StepRunnerState | undefined;
    let runStarted = false;
    const runLifecycleFrame = this.createRunLifecycleObservabilityFrame(runId, event.sessionId);

    return this.runLifecycleFrameStore.run(runLifecycleFrame, async () => {
      try {
        await this.sampleHeap({
          component: "runtime.run",
          phase: "before",
          runId,
          sessionId: event.sessionId,
          stepAgent: event.stepAgent,
        });
        this.throwIfAborted(options.signal);
        const runStart = await this.runLifecycleController.startRun({
          runId,
          event,
          prestarted: options.runStart === "prestarted",
        });
        session = runStart.session;
        lastStepAgent = runStart.lastStepAgent ?? lastStepAgent;
        runStarted = true;
        progressSeq = runStart.progressSeq;

        const evaluationReviewResume = await this.maybeHandleEvaluationReviewResume({
          runId,
          event,
          session,
          guardrails,
          progressSeq,
        });
        if (evaluationReviewResume?.output !== undefined) {
          return evaluationReviewResume.output;
        }
        if (evaluationReviewResume?.session !== undefined) {
          session = evaluationReviewResume.session;
        }

        await this.validateResumedRuntimeState({
          runId,
          event,
          session,
          currentStepAgent: session.currentStepAgent ?? lastStepAgent,
        });
        session = await this.runLifecycleController.resetFinalizationArtifacts(session);
        session = await this.maybeResetContinuationStateForFreshTurn(runId, event, session);
        lastStepAgent = session.currentStepAgent ?? lastStepAgent;
        const managedWorktreeRunContext = await this.prepareManagedWorktreeRunContext(runId, event, session);
        event = managedWorktreeRunContext.event;
        session = managedWorktreeRunContext.session;

      if (this.deps.toolGateway.preRun !== undefined) {
        await this.deps.toolGateway.preRun({
          runId,
          event,
          session,
        });
      }

      const resumeOutcome = await this.resumePendingEffects(
        runId,
        event,
        session,
        errors,
        options.signal,
      );
      if (resumeOutcome !== undefined) {
        const cleanupCompleted = resumeOutcome.cleanupCompleted === true;
        await this.appendRunEvent(
          runId,
          session.sessionId,
          cleanupCompleted ? "run.completed" : "run.failed",
          cleanupCompleted ? "INFO" : "WARN",
          {
            reason: cleanupCompleted
              ? "prepared_approval_cleanup_completed"
              : "resume_pending_effects_stop",
            status: resumeOutcome.status,
          },
        );
        const terminalOutput = await this.runLifecycleController.returnTerminal({
          runId,
          sessionId: session.sessionId,
          currentStep: session.currentStepAgent,
          transition: {
            status: resumeOutcome.status,
            nextStepAgent: session.currentStepAgent ?? "agent.loop",
          },
          errors: resumeOutcome.errors,
          guardrails,
          progressSeq,
          continuation,
          skipRunStatusEvent: true,
          skipWaitingEvents: true,
          progressOverride: {
            kind: "stage",
            phase: "engine",
            code: cleanupCompleted
              ? "RUN_TERMINAL"
              : resumeOutcome.status === "FAILED"
                ? "RUN_FAILED"
                : "RUN_TERMINAL",
            message: cleanupCompleted
              ? "Prepared approval cleanup completed."
              : `Run terminated while resuming pending effects (${resumeOutcome.status}).`,
            stepAgent: session.currentStepAgent,
          },
        });
        if (terminalOutput === undefined) {
          throw createRuntimeFailure(
            "RUN_TERMINALIZATION_INCOMPLETE",
            "Pending-effect stop did not produce terminal output.",
            {
              subsystem: "runtime",
              classification: "runtime",
              status: resumeOutcome.status,
              sessionId: session.sessionId,
            },
          );
        }
        return terminalOutput;
      }

      let currentStep = this.resolveCurrentStep(event, session.state, session.currentStepAgent);
      lastStepAgent = currentStep ?? lastStepAgent;
      let laneCursor = this.resolveRegionLaneCursor(session.state);
      let stepIndex = 0;

      if (event.type !== "user.message") {
        const orchestrationMetadata = this.mergeOrchestrationEventMetadata(event);
        await this.waitResumeCoordinator.appendResumeEvents({
          runId,
          session,
          event,
          orchestrationMetadata,
        });
        progressSeq = await this.emitProgress({
          runId,
          sessionId: session.sessionId,
          seq: progressSeq,
          kind: "stage",
          phase: "engine",
          code: "RESUMED_FROM_WAIT",
          message: `Resumed run from event '${event.type}'.`,
          persist: true,
        });
      }

      const continuationOutcome = await this.maybeHandleContinuationReply({
        runId,
        event,
        session,
        currentStep,
        stepIndex,
      });
      if (continuationOutcome?.output !== undefined) {
        return continuationOutcome.output;
      }
      if (continuationOutcome?.session !== undefined) {
        session = continuationOutcome.session;
        currentStep = continuationOutcome.currentStep;
        lastStepAgent = continuationOutcome.currentStep ?? lastStepAgent;
        continuation = continuationOutcome.continuation;
      }
      const loopStallResumeOutcome = await this.maybeHandleLoopVisitStallReply({
        runId,
        event,
        session,
        currentStep,
        stepIndex,
        errors,
        guardrails,
        progressSeq,
        continuation,
      });
      if (loopStallResumeOutcome?.output !== undefined) {
        return loopStallResumeOutcome.output;
      }
      if (loopStallResumeOutcome?.session !== undefined) {
        session = loopStallResumeOutcome.session;
        currentStep = loopStallResumeOutcome.currentStep;
        lastStepAgent = loopStallResumeOutcome.currentStep ?? lastStepAgent;
      }
      const continuationState = this.readContinuationState(session.state);
      guardrails = new Guardrails(
        this.resolveGuardrailConfigForSession(continuationState),
        {
          stepsExecuted: continuationState?.stepsConsumed,
          modelCalls: continuationState?.modelCallsConsumed,
        },
        this.resolveRuntimeBudget(event),
      );

      stepRunnerState = {
        event,
        session,
        currentStep,
        lastStepAgent,
        laneCursor,
        stepIndex,
        progressSeq,
        continuation,
      };
      while (true) {
        const terminalOutput = await this.stepRunner.runIteration({
          runId,
          runStartedAt,
          state: stepRunnerState,
          guardrails,
          errors,
          signal: options.signal,
        });
        event = stepRunnerState.event;
        session = stepRunnerState.session;
        currentStep = stepRunnerState.currentStep;
        lastStepAgent = stepRunnerState.lastStepAgent;
        laneCursor = stepRunnerState.laneCursor;
        stepIndex = stepRunnerState.stepIndex;
        progressSeq = stepRunnerState.progressSeq;
        continuation = stepRunnerState.continuation;
        if (stepIndex % 25 === 0) {
          await this.sampleHeap({
            component: "runtime.step",
            phase: "after",
            runId,
            sessionId: session.sessionId,
            stepIndex,
            stepAgent: currentStep,
          });
        }
        if (terminalOutput !== undefined) {
          await this.sampleHeap({
            component: "runtime.run",
            phase: "after",
            runId,
            sessionId: session.sessionId,
            stepIndex,
            stepAgent: currentStep,
            reason: "terminal_output",
          });
          return terminalOutput;
        }
      }
    } catch (error) {
      const runtimeError = this.mapError(error);
      errors.push(runtimeError);
      if (stepRunnerState !== undefined) {
        event = stepRunnerState.event;
        session = stepRunnerState.session;
        lastStepAgent = stepRunnerState.lastStepAgent ?? lastStepAgent;
        continuation = stepRunnerState.continuation;
        progressSeq = stepRunnerState.progressSeq;
      }

      try {
        if (session !== undefined && lastStepAgent !== undefined) {
          if (
            runtimeError.code === "MAX_STEPS_EXCEEDED" ||
            runtimeError.code === "MAX_STEP_VISITS_EXCEEDED" ||
            runtimeError.code === "AGENT_DISPATCH_STALL_DETECTED" ||
            isRecoverableDispatchLoopGuard(runtimeError, lastStepAgent)
          ) {
            const stalledOutput =
              await this.loopGuardCoordinator.maybeCompleteResearchStall({
              runId,
              session: session!,
              currentStep: lastStepAgent!,
              stepIndex: guardrails.telemetry().stepsExecuted,
              guardrails,
              progressSeq,
              runtimeError,
              });
            if (stalledOutput !== undefined) {
              return stalledOutput;
            }
            const documentedFinalizeGapOutput =
              await this.loopGuardCoordinator.maybeCompleteDocumentedFinalizeGap({
              runId,
              session: session!,
              currentStep: lastStepAgent!,
              stepIndex: guardrails.telemetry().stepsExecuted,
              runtimeError,
              guardrails,
              progressSeq,
              });
            if (documentedFinalizeGapOutput !== undefined) {
              return documentedFinalizeGapOutput;
            }
            const loopStallOutput =
              await this.loopGuardCoordinator.maybeResolveLoopVisitStall({
              runId,
              session: session!,
              currentStep: lastStepAgent!,
              stepIndex: guardrails.telemetry().stepsExecuted,
              runtimeError,
              guardrails,
              progressSeq,
              });
            if (loopStallOutput !== undefined) {
              return loopStallOutput;
            }
          }
          if (
            runtimeError.code === "MAX_STEPS_EXCEEDED" ||
            runtimeError.code === "MAX_MODEL_CALLS_EXCEEDED"
          ) {
            const stalledOutput =
              await this.loopGuardCoordinator.maybeCompleteResearchStall({
              runId,
              session: session!,
              currentStep: lastStepAgent!,
              stepIndex: guardrails.telemetry().stepsExecuted,
              guardrails,
              progressSeq,
              runtimeError,
              });
            if (stalledOutput !== undefined) {
              return stalledOutput;
            }
            const continuationOutput = await this.maybeRequestContinuation({
              runId,
              event,
              session,
              currentStep: lastStepAgent,
              stepIndex: guardrails.telemetry().stepsExecuted,
              guardrails,
              progressSeq,
              reason:
                runtimeError.code === "MAX_MODEL_CALLS_EXCEEDED"
                  ? "max_model_calls_continuation"
                  : "max_steps_continuation",
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
              onCheckpointStateUpdated: (updated) => {
                session = updated.session;
                progressSeq = updated.progressSeq;
              },
            });
            if (continuationOutput !== undefined) {
              return continuationOutput;
            }
          }
        }
        if (session !== undefined && lastStepAgent !== undefined) {
          const loopTimeoutWaitOutput = await this.maybeEnterAgentLoopTimeoutResumeWait({
            runId,
            event,
            session: session!,
            currentStep: lastStepAgent!,
            stepIndex: guardrails.telemetry().stepsExecuted,
            runtimeError,
            errors,
            guardrails,
            progressSeq,
            continuation,
          });
          if (loopTimeoutWaitOutput !== undefined) {
            return loopTimeoutWaitOutput;
          }
        }
        if (
          runtimeError.code === "LOOP_GUARD_TRIGGERED" &&
          session !== undefined &&
          lastStepAgent !== undefined
        ) {
          const loopResolutionOutput =
            await this.maybeRequestToolInputInvalidLoopResolution({
            runId,
            session: session!,
            currentStep: lastStepAgent!,
            stepIndex: guardrails.telemetry().stepsExecuted,
            runtimeError,
            guardrails,
            progressSeq,
            });
          if (loopResolutionOutput !== undefined) {
            return loopResolutionOutput;
          }

          const documentedFinalizeGapOutput =
            await this.loopGuardCoordinator.maybeCompleteDocumentedFinalizeGap({
            runId,
            session: session!,
            currentStep: lastStepAgent!,
            stepIndex: guardrails.telemetry().stepsExecuted,
            runtimeError,
            guardrails,
            progressSeq,
            });
          if (documentedFinalizeGapOutput !== undefined) {
            return documentedFinalizeGapOutput;
          }

          const errorDetails = this.asRecord(runtimeError.details);
          if (errorDetails?.guardType === "REPEATED_REDUNDANT_RETRIEVAL_PIVOT") {
            const recoveryIO = this.createStepIO(
              guardrails,
              {
                runId,
                sessionId: session.sessionId,
                stepIndex: guardrails.telemetry().stepsExecuted,
                stepAgent: lastStepAgent,
                phase: this.resolveProgressPhase(lastStepAgent),
                signal: options.signal,
                sequence: () => {
                  progressSeq += 1;
                  return progressSeq;
                },
              },
              session,
              {
                ...(this.asRecord(event.payload.orchestration) ?? {}),
                ...(this.asRecord(event.payload.metadata) ?? {}),
                ...(this.asRecord(event.payload.workspace) !== undefined
                  ? { workspace: this.asRecord(event.payload.workspace) }
                  : {}),
              },
              event.payload,
              (updated) => {
                session = updated;
              },
            );
            const synthesizedOutput =
              await this.loopGuardCoordinator.maybeCompleteVerifiedRetrievalSynthesis({
              runId,
              event,
              session: session!,
              currentStep: lastStepAgent!,
              stepIndex: guardrails.telemetry().stepsExecuted,
              guardrails,
              progressSeq,
              getProgressSeq: () => progressSeq,
              runtimeError,
              signal: options.signal,
              useModel: recoveryIO.useModel,
              });
            if (synthesizedOutput !== undefined) {
              return synthesizedOutput;
            }
            const stalledOutput =
              await this.loopGuardCoordinator.maybeCompleteResearchStall({
              runId,
              session: session!,
              currentStep: lastStepAgent!,
              stepIndex: guardrails.telemetry().stepsExecuted,
              guardrails,
              progressSeq,
              runtimeError,
              });
            if (stalledOutput !== undefined) {
              return stalledOutput;
            }
          }
        }
        return await this.runLifecycleController.failRun({
          runId,
          event,
          runtimeError,
          errors,
          guardrails,
          progressSeq,
          lastStepAgent,
          session,
          continuation,
        });
      } catch (recoveryError) {
        const recoveryRuntimeError = this.mapError(recoveryError);
        if (recoveryRuntimeError.code === "RUN_CANCELLED") {
          errors.splice(0, errors.length, recoveryRuntimeError);
          return await this.runLifecycleController.failRun({
            runId,
            event,
            runtimeError: recoveryRuntimeError,
            errors,
            guardrails,
            progressSeq,
            lastStepAgent,
            session,
            continuation,
          });
        }
        // Preserve the original runtime failure when recovery itself cannot complete.
      }

      return this.deps.outputNormalizer.normalize({
        status: "FAILED",
        sessionId: event.sessionId,
        runId,
        finalStep: lastStepAgent,
        continuation,
        quality: {
          citationCoverage: 0,
          unresolvedClaims: 0,
          reworkRate: 0,
          thrashIndex: guardrails.thrashIndex(),
        },
        errors,
        telemetry: guardrails.telemetry(),
      });
      } finally {
        if (this.deps.providerReasoningVault !== undefined) {
          const runtimeMetadata = {
            ...(this.asRecord(event.payload.orchestration) ?? {}),
            ...(this.asRecord(event.payload.metadata) ?? {}),
          };
          const turnId = this.asString(runtimeMetadata.turnId ?? runtimeMetadata.activeTurnId);
          await this.deps.providerReasoningVault.purgeActiveTurn({
            sessionId: session?.sessionId ?? event.sessionId,
            ...(turnId !== undefined ? { turnId } : { runId }),
          });
        }
        await this.sampleHeap({
          component: "runtime.run",
          phase: "after",
          runId,
          sessionId: session?.sessionId ?? event.sessionId,
          stepIndex: stepRunnerState?.stepIndex,
          stepAgent: lastStepAgent,
          reason: "finally",
        });
        if (runStarted) {
          await this.flushRunLifecycleObservabilityFrame(runLifecycleFrame);
        }
        this.clearHeapPressureLogKeys(runId);
      }
    });
  }

  async cancelActiveRun(sessionId: string): Promise<{ runId?: string | undefined }> {
    return this.runLifecycleController.cancelActiveRun(sessionId);
  }

  private createStepContext(
    runId: string,
    session: StepContext["session"],
    event: RuntimeEvent,
    stepIndex: number,
    memory: MemorySnapshot,
    budget: StepContext["budget"],
    stateNode: StepContext["stateNode"],
    region: StepContext["region"],
  ): StepContext {
    return {
      runId,
      session,
      event,
      stepIndex,
      memory,
      budget,
      stateNode,
      region,
    };
  }

  private async prepareManagedWorktreeRunContext(
    runId: string,
    event: RuntimeEvent,
    session: SessionRecord,
  ): Promise<{ event: RuntimeEvent; session: SessionRecord }> {
    return this.workspaceLifecycleCoordinator.prepareManagedWorktreeRunContext(runId, event, session);
  }

  private async prepareAutoManagedWorktreeForSelectedDevTool(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    stepName: string;
    stepIndex: number;
  }): Promise<{ event: RuntimeEvent; session: SessionRecord }> {
    return this.workspaceLifecycleCoordinator.prepareAutoManagedWorktreeForSelectedDevTool(input);
  }

  private async validateResumedRuntimeState(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    currentStepAgent: string | undefined;
  }): Promise<void> {
    if (input.event.type === "user.message") {
      return;
    }

    const validationError = validateRuntimeSessionState(input.session.state);
    if (validationError !== undefined) {
      const invalidStatePath = readInvalidStatePath(validationError);
      await this.appendResumeBlockedEvent({
        ...input,
        code: validationError.code,
        message: validationError.message,
        invalidStatePath,
      });
      throw createRuntimeFailure(validationError.code, validationError.message, {
        sessionId: input.session.sessionId,
        runId: input.runId,
        version: input.session.version,
        currentStepAgent: input.currentStepAgent,
        eventType: input.event.type,
        ...(invalidStatePath !== undefined ? { invalidStatePath } : {}),
      });
    }

    const agent = this.asRecord(input.session.state.agent) ?? {};
    const exec = this.asRecord(agent.exec) ?? {};
    const pendingApproval = this.asRecord(exec.pendingApproval);
    const event = await this.withClassifiedApprovalIntent(input.event, pendingApproval);
    if (
      event.type === "user.approval" &&
      pendingApproval?.purpose === "managed_worktree" &&
      parseApprovalDecisionFromPayload(event.payload) === "approve"
    ) {
      const nextAction = this.asRecord(agent.nextAction);
      if (nextAction === undefined) {
        await this.appendResumeBlockedEvent({
          ...input,
          code: "RUNTIME_RESUME_STATE_INVALID",
          message: "Managed worktree approval resume requires object-shaped state.agent.nextAction.",
          invalidStatePath: "state.agent.nextAction",
        });
        throw createRuntimeFailure(
          "RUNTIME_RESUME_STATE_INVALID",
          "Managed worktree approval resume requires object-shaped state.agent.nextAction.",
          {
            sessionId: input.session.sessionId,
            runId: input.runId,
            version: input.session.version,
            currentStepAgent: input.currentStepAgent,
            eventType: input.event.type,
            invalidStatePath: "state.agent.nextAction",
          },
        );
      }
      const kind = this.asString(nextAction.kind);
      if (kind === undefined || kind.trim().length === 0) {
        await this.appendResumeBlockedEvent({
          ...input,
          code: "RUNTIME_RESUME_STATE_INVALID",
          message: "Managed worktree approval resume requires state.agent.nextAction.kind.",
          invalidStatePath: "state.agent.nextAction.kind",
        });
        throw createRuntimeFailure(
          "RUNTIME_RESUME_STATE_INVALID",
          "Managed worktree approval resume requires state.agent.nextAction.kind.",
          {
            sessionId: input.session.sessionId,
            runId: input.runId,
            version: input.session.version,
            currentStepAgent: input.currentStepAgent,
            eventType: input.event.type,
            invalidStatePath: "state.agent.nextAction.kind",
          },
        );
      }
    }
  }

  private async withClassifiedApprovalIntent(
    event: RuntimeEvent,
    pendingApproval: Record<string, unknown> | undefined,
  ): Promise<RuntimeEvent> {
    if (
      event.type !== "user.approval" ||
      pendingApproval === undefined ||
      readUserReplyIntent(this.asRecord(event.payload)?.userReplyIntent) !== undefined
    ) {
      return event;
    }
    const message =
      this.asString(event.payload.message) ??
      this.asString(event.payload.text);
    if (message === undefined) {
      return event;
    }
    const intent = await classifyUserReplyIntent({
      reply: message,
      waitFor: {
        eventType: "user.approval",
        metadata: {
          approvalId: this.asString(pendingApproval.approvalId),
          purpose: this.asString(pendingApproval.purpose),
          toolName: this.asString(pendingApproval.toolName),
          reason: "approval required",
        },
      },
      useModel: (request) => this.deps.modelGateway.call(request),
    });
    return {
      ...event,
      payload: {
        ...(this.asRecord(event.payload) ?? {}),
        userReplyIntent: intent,
      },
    };
  }

  private async appendResumeBlockedEvent(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    currentStepAgent: string | undefined;
    code: string;
    message: string;
    invalidStatePath?: string | undefined;
  }): Promise<void> {
    const agent = this.asRecord(input.session.state.agent);
    const wait = readActiveWaitState(agent);
    await this.appendRunEvent(input.runId, input.session.sessionId, "runtime.resume_blocked", "ERROR", {
      code: input.code,
      message: input.message,
      sessionId: input.session.sessionId,
      runId: input.runId,
      version: input.session.version,
      currentStepAgent: input.currentStepAgent,
      eventType: input.event.type,
      ...(wait?.eventType !== undefined ? { waitEventType: wait.eventType } : {}),
      ...(wait?.source !== undefined ? { waitSource: wait.source } : {}),
      ...(wait?.resumeStepAgent !== undefined ? { resumeStepAgent: wait.resumeStepAgent } : {}),
      ...(input.invalidStatePath !== undefined ? { invalidStatePath: input.invalidStatePath } : {}),
      runtimeStateDiagnostic: buildRuntimeStateDiagnosticMetadata({
        sessionId: input.session.sessionId,
        runId: input.runId,
        version: input.session.version,
        stepAgent: input.currentStepAgent,
        nextStepAgent: input.currentStepAgent,
        state: input.session.state,
      }),
    });
  }

  private readManagedWorktreeBindingFromSession(session: SessionRecord): ManagedTaskWorktreeBinding | undefined {
    return this.workspaceLifecycleCoordinator.readManagedWorktreeBindingFromSession(session);
  }

  private async releaseManagedWorktreeLeaseForRun(
    runId: string,
    session: SessionRecord,
    terminalStatus: TransitionStatus = "FAILED",
  ): Promise<void> {
    await this.workspaceLifecycleCoordinator.releaseManagedWorktreeLeaseForRun(runId, session, terminalStatus);
    if (terminalStatus !== "WAITING") {
      await this.deps.toolGateway.releaseToolRun?.(runId, session.sessionId);
    }
  }

  private readManagedWorktreeBindingFromState(state: Record<string, unknown>): ManagedTaskWorktreeBinding | undefined {
    return this.workspaceLifecycleCoordinator.readManagedWorktreeBindingFromState(state);
  }

  private toManagedWorktreeEventPayload(
    binding: ManagedTaskWorktreeBinding,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return this.workspaceLifecycleCoordinator.toManagedWorktreeEventPayload(binding, extra);
  }

  private async maybeAppendManagedWorktreeApprovalRequested(
    runId: string,
    sessionId: string,
    transition: Transition,
    stepIndex: number,
  ): Promise<void> {
    await this.workspaceLifecycleCoordinator.maybeAppendManagedWorktreeApprovalRequested(
      runId,
      sessionId,
      transition,
      stepIndex,
    );
  }

  private async evaluateRuntimeTransition(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    stepName: string;
    stepIndex: number;
    transition: StepTransition;
    statePatch: Record<string, unknown> | undefined;
    guardrails: Guardrails;
    signal?: AbortSignal | undefined;
  }): Promise<{
    transition: StepTransition;
    statePatch: Record<string, unknown> | undefined;
    disposition?: "continue" | "revise" | "review" | "quarantine" | undefined;
  }> {
    const coordinator = this.evaluationCoordinator;
    if (coordinator === undefined) {
      return { transition: input.transition, statePatch: input.statePatch };
    }
    this.throwIfAborted(input.signal);
    const sessionAgent = this.asRecord(input.session.state.agent) ?? {};
    const patchAgent = this.asRecord(input.statePatch?.agent) ?? {};
    const mergedAgent = { ...sessionAgent, ...patchAgent };
    const sessionExec = this.asRecord(sessionAgent.exec) ?? {};
    const patchExec = this.asRecord(patchAgent.exec) ?? {};
    const mergedExec = { ...sessionExec, ...patchExec };
    const eventMetadata = this.asRecord(input.event.payload.metadata);
    const threadId =
      this.asString(eventMetadata?.threadId ?? input.event.payload.threadId) ??
      input.session.sessionId;
    const objective =
      resolveKestrelTurnObjective({
        reactState: mergedAgent,
        eventType: input.event.type,
        eventPayload: input.event.payload,
        fallbackGoal: this.asString(input.event.payload.goal),
      }).goal ?? "Complete the active user request.";
    const stateNodeId = input.transition.stateNode === undefined
      ? undefined
      : `${input.transition.stateNode.parent}/${input.transition.stateNode.child}${input.transition.stateNode.region === undefined ? "" : `:${input.transition.stateNode.region}`}`;

    if (
      stateNodeId !== undefined &&
      coordinator.matchesHook("milestone", stateNodeId)
    ) {
      await coordinator.evaluateHook({
        runId: input.runId,
        sessionId: input.session.sessionId,
        threadId,
        stepIndex: input.stepIndex,
        hookKind: "milestone",
        sourceId: stateNodeId,
        objective,
        evidence: [{
          evidenceId: `milestone-${input.stepIndex}`,
          kind: "milestone",
          value: {
            stateNode: input.transition.stateNode,
            status: input.transition.status,
            statePatch: input.statePatch ?? {},
          },
        }],
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    }

    if (input.transition.status !== "COMPLETED") {
      return { transition: input.transition, statePatch: input.statePatch };
    }
    if ((input.transition.effects?.length ?? 0) > 0) {
      throw createRuntimeFailure(
        "EVALUATION_UNRESOLVED_EFFECTS",
        "An evaluation-enabled completion must settle effects before proposing delivery.",
        { runId: input.runId, stepIndex: input.stepIndex },
      );
    }
    const candidate = this.asString(mergedAgent.assistantText);
    if (candidate === undefined) {
      throw createRuntimeFailure(
        "EVALUATION_CANDIDATE_MISSING",
        "An evaluation-enabled completion must provide a candidate assistant result.",
        { runId: input.runId, stepIndex: input.stepIndex },
      );
    }
    const priorEvaluation = this.asRecord(mergedExec.evaluation);
    const finalRevisionsUsed = Math.max(
      0,
      Math.trunc(readMaybeNumber(priorEvaluation?.finalRevisionsUsed) ?? 0),
    );
    const result = await coordinator.evaluateHook({
      runId: input.runId,
      sessionId: input.session.sessionId,
      threadId,
      stepIndex: input.stepIndex,
      hookKind: "pre_delivery",
      sourceId: "pre_delivery",
      objective,
      candidateOutput: candidate,
      finalRevisionsUsed,
      evidence: buildFinalEvaluationEvidence({
        agent: mergedAgent,
        transition: input.transition,
      }),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (result === undefined) {
      throw createRuntimeFailure(
        "EVALUATOR_UNAVAILABLE",
        "The configured pre-delivery evaluator hook could not be resolved.",
      );
    }
    const sanitizedCandidate = result.sanitizedCandidate;
    if (sanitizedCandidate === undefined) {
      throw createRuntimeFailure(
        "EVALUATION_CANDIDATE_MISSING",
        "The pre-delivery evaluator did not preserve a sanitized candidate.",
      );
    }
    if (result.decision.disposition === "continue") {
      return {
        transition: input.transition,
        statePatch: {
          ...(input.statePatch ?? {}),
          agent: {
            ...patchAgent,
            assistantText: sanitizedCandidate,
            finalOutput: sanitizedCandidate,
            exec: {
              ...patchExec,
              evaluation: {
                status: "passed",
                finalRevisionsUsed,
                requestId: result.request.requestId,
                decision: structuredClone(result.decision),
                ...(result.verdict !== undefined
                  ? { verdict: structuredClone(result.verdict) }
                  : {}),
                ...(result.assistantOutputBoundaryDecision !== undefined
                  ? {
                      assistantOutputBoundaryDecision: structuredClone(
                        result.assistantOutputBoundaryDecision,
                      ),
                    }
                  : {}),
              },
            },
          },
        },
        disposition: "continue",
      };
    }
    if (result.decision.disposition === "revise") {
      return this.buildEvaluationRevisionTransition({
        ...input,
        result,
        sanitizedCandidate,
        patchAgent,
        patchExec,
        threadId,
        finalRevisionsUsed,
      });
    }
    if (
      result.decision.disposition === "review" ||
      result.decision.disposition === "quarantine"
    ) {
      return this.buildEvaluationReviewTransition({
        ...input,
        result,
        sanitizedCandidate,
        patchAgent,
        patchExec,
        threadId,
        finalRevisionsUsed,
      });
    }
    throw createRuntimeFailure(
      "EVALUATION_DISPOSITION_INVALID",
      `Blocking evaluation produced unsupported disposition '${result.decision.disposition}'.`,
    );
  }

  private async buildEvaluationRevisionTransition(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    stepName: string;
    stepIndex: number;
    transition: StepTransition;
    statePatch: Record<string, unknown> | undefined;
    guardrails: Guardrails;
    signal?: AbortSignal | undefined;
    result: RuntimeEvaluationHookResultV1;
    sanitizedCandidate: string;
    patchAgent: Record<string, unknown>;
    patchExec: Record<string, unknown>;
    threadId: string;
    finalRevisionsUsed: number;
  }): Promise<{
    transition: StepTransition;
    statePatch: Record<string, unknown>;
    disposition: "revise";
  }> {
    const evaluationDecision = input.result.decision;
    return {
      transition: {
        ...input.transition,
        status: "RUNNING",
        nextStepAgent: "agent.loop",
        effects: [],
        waitFor: undefined,
      },
      statePatch: {
        ...(input.statePatch ?? {}),
        agent: {
          ...input.patchAgent,
          assistantText: null,
          finalOutput: undefined,
          retryContext: buildEvaluationRevisionContext({
            candidate: input.sanitizedCandidate,
            result: { ...input.result, decision: evaluationDecision },
          }),
          exec: {
            ...input.patchExec,
            pendingEvaluation: undefined,
            evaluation: {
              status: "revising",
              finalRevisionsUsed: input.finalRevisionsUsed + 1,
              evaluationDecision: structuredClone(evaluationDecision),
            },
          },
        },
      },
      disposition: "revise",
    };
  }

  private async buildEvaluationReviewTransition(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    stepName: string;
    stepIndex: number;
    transition: StepTransition;
    statePatch: Record<string, unknown> | undefined;
    guardrails: Guardrails;
    signal?: AbortSignal | undefined;
    result: RuntimeEvaluationHookResultV1;
    sanitizedCandidate: string;
    patchAgent: Record<string, unknown>;
    patchExec: Record<string, unknown>;
    threadId: string;
    finalRevisionsUsed: number;
  }): Promise<{
    transition: StepTransition;
    statePatch: Record<string, unknown>;
    disposition: "review" | "quarantine";
  }> {
    const allowedOptionIds: EvaluationReviewBindingV1["allowedOptionIds"] =
      ["evaluation.accept_once"];
    if (
      input.finalRevisionsUsed <
      this.evaluationCoordinator!.policy.budget.maxFinalRevisions
    ) {
      allowedOptionIds.push("evaluation.revise");
    }
    allowedOptionIds.push("terminal.fail");
    const evaluationDecision = input.result.decision;
    const reviewRequestId = `evaluation-review:${evaluationDecision.decisionId}`;
    const actor = this.asRecord(
      this.asRecord(input.event.payload.metadata)?.actor ??
        input.event.payload.actor,
    );
    const tenantId = this.asString(actor?.tenantId);
    const evaluationReviewBinding = createEvaluationReviewBindingV1({
      requestId: reviewRequestId,
      threadId: input.threadId,
      runId: input.runId,
      evaluationDecisionId: evaluationDecision.decisionId,
      policyRevision: this.evaluationCoordinator!.policy.revision,
      profileFingerprint: this.evaluationCoordinator!.executionProfileFingerprint,
      allowedOptionIds,
      issuedAt: new Date().toISOString(),
      ...(tenantId !== undefined ? { tenantId } : {}),
    });
    const technicalDisclosure = {
      candidate: input.sanitizedCandidate,
      ...(input.result.verdict !== undefined
        ? {
            score: input.result.verdict.score,
            confidence: input.result.verdict.confidence,
            assertions: structuredClone(input.result.verdict.assertions),
            rationale: input.result.verdict.rationale,
            evidenceReferences: input.result.verdict.assertions.flatMap(
              (assertion) => assertion.evidenceRefs,
            ),
          }
        : {
            reasonCode: input.result.decision.reasonCode,
            assertions: [],
            evidenceReferences: [],
          }),
    };
    const waitFor = {
      kind: "user" as const,
      eventType: "user.reply",
      metadata: {
        reason: "evaluation_review",
        prompt: "Result requires review.",
        decisionId: evaluationDecision.decisionId,
        allowedOptionIds: [...allowedOptionIds],
        evaluationReviewBinding: structuredClone(evaluationReviewBinding),
        evaluationTechnicalDisclosure: technicalDisclosure,
      },
      interaction: createRunnerStructuredReviewInteractionV1({
        reason: "evaluation_review",
        requestId: reviewRequestId,
        prompt: "Result requires review.",
        allowedOptionIds,
        evaluationTechnicalDisclosure: technicalDisclosure,
      }),
    };
    const pendingEvaluation = {
      status: input.result.decision.disposition === "quarantine"
        ? "quarantined"
        : "review",
      candidate: input.sanitizedCandidate,
      candidateDigest: digestEvaluationCandidate(input.sanitizedCandidate),
      finalOutput: input.sanitizedCandidate,
      evaluationDecision: structuredClone(evaluationDecision),
      ...(input.result.verdict !== undefined
        ? { verdict: structuredClone(input.result.verdict) }
        : {}),
      request: structuredClone(input.result.request),
      reviewRequestId,
      threadId: input.threadId,
      policyRevision: this.evaluationCoordinator!.policy.revision,
      profileFingerprint: this.evaluationCoordinator!.executionProfileFingerprint,
      allowedOptionIds: [...allowedOptionIds],
      evaluationReviewBinding: structuredClone(evaluationReviewBinding),
      finalRevisionsUsed: input.finalRevisionsUsed,
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(input.result.assistantOutputBoundaryDecision !== undefined
        ? {
            assistantOutputBoundaryDecision: structuredClone(
              input.result.assistantOutputBoundaryDecision,
            ),
          }
        : {}),
    };
    return {
      transition: {
        ...input.transition,
        status: "WAITING",
        nextStepAgent: input.stepName,
        effects: [],
        waitFor,
      },
      statePatch: {
        ...(input.statePatch ?? {}),
        agent: {
          ...input.patchAgent,
          assistantText: null,
          finalOutput: undefined,
          waitingFor: this.waitResumeCoordinator.buildWaitingFor({
            waitFor,
            resumeStepAgent: input.stepName,
            reason: "evaluation_review",
            resumeInstruction: "Choose one exact evaluation option.",
          }),
          exec: {
            ...input.patchExec,
            pendingEvaluation,
          },
        },
      },
      disposition:
        input.result.decision.disposition === "quarantine"
          ? "quarantine"
          : "review",
    };
  }

  private createStepIO(
    guardrails: Guardrails,
    progress: {
      runId: string;
      sessionId: string;
      stepIndex: number;
      stepAgent: string;
      phase: ProgressPhase;
      signal?: AbortSignal | undefined;
      sequence: () => number;
    },
    session: SessionRecord,
    runtimeMetadata: Record<string, unknown> | undefined,
    runtimePayload: Record<string, unknown> | undefined,
    onSessionUpdated: (session: SessionRecord) => void,
  ): StepIO {
    let currentSession = session;
    const runtimeIO = new RuntimeIO({
      deps: {
        store: this.deps.store,
        modelGateway: this.deps.modelGateway,
        ...(this.deps.effectiveModelContractResolver !== undefined
          ? { effectiveModelContractResolver: this.deps.effectiveModelContractResolver }
          : {}),
        toolGateway: this.deps.toolGateway,
        ...(this.deps.providerReasoningVault !== undefined
          ? { providerReasoningVault: this.deps.providerReasoningVault }
          : {}),
        ...(this.deps.consoleReporter !== undefined ? { consoleReporter: this.deps.consoleReporter } : {}),
        reasoningReporter: this.deps.reasoningReporter,
      },
      guardrailConfig: this.guardrailConfig,
      toolJobQueue: this.toolJobQueue,
      toolQueueEnabled: this.toolQueueEnabled,
      guardrails,
      progress,
      getSessionState: () => currentSession.state,
      runtimeMetadata,
      runtimePayload,
      emitProgressFromSequence: (input) => this.emitProgressFromSequence(input),
      appendRunEvent: (runId, sessionId, type, level, metadata, stepIndex) =>
        this.appendRunEvent(runId, sessionId, type, level, metadata, stepIndex),
      logInfo: (entry) => this.logInfo(entry),
      logWarn: (entry) => this.logWarn(entry),
      withProgressHeartbeat: (options, work) => this.withProgressHeartbeat(options, work),
      mapError: (error) => this.mapError(error),
      buildModelTimeoutMetadata: (state, modelProgress, request, runtimeBudgetRemainingMs) =>
        this.buildModelTimeoutMetadata(state, modelProgress, request, runtimeBudgetRemainingMs),
      summarizePromptInput: (request) => this.summarizePromptInput(request),
      persistModelPromptDump: (input) => this.persistModelPromptDump(input),
      persistModelResponseDump: (input) => this.persistModelResponseDump(input),
      extractModelUsage: (value) => this.extractModelUsage(value),
      extractModelMetadata: (value) => this.extractModelMetadata(value),
      callTool: (input) =>
        this.callToolWithWorkspaceCheckpoint({
          ...input,
          trustedManagedWorktreeBinding: this.readManagedWorktreeBindingFromState(input.sessionState),
        }),
      afterToolResult: (input) => this.maybeAttachManagedWorktreeProcess(input),
      isRetryableToolError: (error) => this.isRetryableToolError(error),
      ...(this.evaluationCoordinator !== undefined
        ? { evaluationCoordinator: this.evaluationCoordinator }
        : {}),
      executionBoundaryRuntime: this.executionBoundaryRuntime,
    });

    return {
      useModel: async <T>(request: ModelRequest): Promise<T> => {
        const budget = guardrails.budgetSnapshot();
        assertModelCallAdmission({
          remainingMs: budget.remainingMs,
          phase: progress.phase,
          stepAgent: progress.stepAgent,
        });
        await this.enforceHeapAdmission({
          component: "runtime.model",
          runId: progress.runId,
          sessionId: progress.sessionId,
          stepIndex: progress.stepIndex,
          stepAgent: progress.stepAgent,
          guardrails,
          session: currentSession,
          onSessionUpdated: (updated) => {
            currentSession = updated;
            onSessionUpdated(updated);
          },
        });
        guardrails.onModelCall(readModelBudgetClass(request));
        try {
          return await runtimeIO.model<T>(request);
        } finally {
          await this.sampleHeap({
            component: "runtime.model",
            phase: "after",
            runId: progress.runId,
            sessionId: progress.sessionId,
            stepIndex: progress.stepIndex,
            stepAgent: progress.stepAgent,
          });
        }
      },
      useTool: async (name: string, input: unknown) => {
        await this.enforceHeapAdmission({
          component: "runtime.tool",
          runId: progress.runId,
          sessionId: progress.sessionId,
          stepIndex: progress.stepIndex,
          stepAgent: progress.stepAgent,
          guardrails,
          reason: name,
          session: currentSession,
          onSessionUpdated: (updated) => {
            currentSession = updated;
            onSessionUpdated(updated);
          },
        });
        try {
          return await runtimeIO.tool(name, input);
        } finally {
          await this.sampleHeap({
            component: "runtime.tool",
            phase: "after",
            runId: progress.runId,
            sessionId: progress.sessionId,
            stepIndex: progress.stepIndex,
            stepAgent: progress.stepAgent,
            reason: name,
          });
        }
      },
      inspectTool: (name, input, intent) =>
        runtimeIO.inspectTool(name, input, intent),
      prepareToolForApproval: (name, input, approval, intent) =>
        runtimeIO.prepareToolForApproval(name, input, approval, intent),
      releasePreparedToolCall: (prepared) =>
        runtimeIO.releasePreparedToolCall(prepared),
    };
  }

  private async callContinuationMaintenanceModel(input: {
    request: ModelRequest;
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    guardrails: Guardrails;
    progressSeq: number;
    signal?: AbortSignal | undefined;
  }): Promise<
    | {
        ok: true;
        value: unknown;
        session: SessionRecord;
        progressSeq: number;
      }
    | {
        ok: false;
        error: unknown;
        session: SessionRecord;
        progressSeq: number;
      }
  > {
    let currentSession = input.session;
    let progressSeq = input.progressSeq;
    const runtimeMetadata = {
      ...(this.asRecord(input.event.payload.orchestration) ?? {}),
      ...(this.asRecord(input.event.payload.metadata) ?? {}),
      ...(this.asRecord(input.event.payload.workspace) !== undefined
        ? { workspace: this.asRecord(input.event.payload.workspace) }
        : {}),
    };
    try {
      const io = this.createStepIO(
        input.guardrails,
        {
          runId: input.runId,
          sessionId: currentSession.sessionId,
          stepIndex: input.stepIndex,
          stepAgent: input.currentStep,
          phase: this.resolveProgressPhase(input.currentStep),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          sequence: () => {
            progressSeq += 1;
            return progressSeq;
          },
        },
        currentSession,
        runtimeMetadata,
        input.event.payload,
        (session) => {
          currentSession = session;
        },
      );
      this.throwIfAborted(input.signal);
      const value = await io.useModel(input.request);
      return {
        ok: true,
        value,
        session: currentSession,
        progressSeq,
      };
    } catch (error) {
      return {
        ok: false,
        error,
        session: currentSession,
        progressSeq,
      };
    }
  }

  private async enforceHeapAdmission(input: {
    component: string;
    runId: string;
    sessionId: string;
    stepIndex: number;
    stepAgent: string;
    guardrails: Guardrails;
    reason?: string | undefined;
    session: SessionRecord;
    onSessionUpdated: (session: SessionRecord) => void;
  }): Promise<void> {
    let sample = await this.sampleHeap({
      component: input.component,
      phase: "before",
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      stepAgent: input.stepAgent,
      reason: input.reason,
    });
    if (sample === undefined || sample.pressureLevel === "ok" || sample.guardMode === "off") {
      return;
    }

    await this.logHeapPressure(sample);
    if (sample.pressureLevel !== "critical") {
      return;
    }

    if (sample.guardMode === "compact") {
      const pressureSample = sample;
      const compacted = await this.compactSessionForHeapPressure(
        input.session,
        pressureSample,
      );
      if (compacted !== undefined) {
        input.onSessionUpdated(compacted);
      }
      sample = await this.sampleHeap({
        component: input.component,
        phase: "after",
        runId: input.runId,
        sessionId: input.sessionId,
        stepIndex: input.stepIndex,
        stepAgent: input.stepAgent,
        reason: input.reason === undefined
          ? "heap_pressure_compaction"
          : `${input.reason}:heap_pressure_compaction`,
      }) ?? sample;
      await this.logHeapPressure(sample);
      if (sample.pressureLevel !== "critical") {
        return;
      }
    }

    if (sample.guardMode === "stop" || sample.guardMode === "compact") {
      throw createRuntimeFailure(
        "RUNTIME_HEAP_PRESSURE",
        "Runtime heap pressure reached the critical threshold before starting another model or tool call.",
        {
          subsystem: "runtime",
          classification: "resource_pressure",
          component: sample.component,
          phase: sample.phase,
          runId: sample.runId,
          sessionId: sample.sessionId,
          stepIndex: sample.stepIndex,
          stepAgent: sample.stepAgent,
          reason: sample.reason,
          pressureLevel: sample.pressureLevel,
          guardMode: sample.guardMode,
          heapUsedBytes: sample.heapUsedBytes,
          heapLimitBytes: sample.heapLimitBytes,
          heapUsedPercentOfLimit: sample.heapUsedPercentOfLimit,
        },
      );
    }
  }

  private async compactSessionForHeapPressure(
    session: SessionRecord,
    sample: HeapPressureSample,
  ): Promise<SessionRecord | undefined> {
    if (this.deps.store.patchSessionState === undefined) {
      return ;
    }
    const agent = this.asRecord(session.state.agent) ?? {};
    if (agent.modelTranscript === undefined) {
      return ;
    }
    const compactedTranscript = compactModelTranscript({
      transcript: agent.modelTranscript,
      retainedTailItems: 12,
      summary: [
        "Runtime compacted earlier model/tool transcript items because heap pressure reached the critical threshold.",
        "Recent transcript tail items were retained; older tool details should be recovered from persisted artifacts or run diagnostics if needed.",
      ].join(" "),
    });
    const updated = await this.deps.store.patchSessionState({
      sessionId: session.sessionId,
      expectedVersion: session.version,
      reason: "heap_pressure_compaction",
      statePatch: {
        agent: {
          ...agent,
          modelTranscript: compactedTranscript,
        },
      },
    });
    await this.logWarn({
      runId: sample.runId ?? "unknown",
      sessionId: session.sessionId,
      stepIndex: sample.stepIndex,
      eventName: "heap_pressure_compacted",
      metadata: this.heapPressureMetadata(sample),
    });
    return updated;
  }

  private async logHeapPressure(sample: HeapPressureSample): Promise<void> {
    if (sample.runId === undefined || sample.sessionId === undefined) {
      return;
    }
    const key = [
      sample.runId,
      sample.component,
      sample.phase ?? "point",
      sample.reason ?? "",
      sample.pressureLevel,
      sample.guardMode,
    ].join(":");
    if (this.loggedHeapPressureKeys.has(key)) {
      return;
    }
    this.loggedHeapPressureKeys.add(key);
    const entry = {
      runId: sample.runId,
      sessionId: sample.sessionId,
      stepIndex: sample.stepIndex,
      eventName: "heap_pressure",
      metadata: this.heapPressureMetadata(sample),
    };
    if (sample.pressureLevel === "critical") {
      await this.logError(entry);
    } else {
      await this.logWarn(entry);
    }
  }

  private clearHeapPressureLogKeys(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.loggedHeapPressureKeys) {
      if (key.startsWith(prefix)) {
        this.loggedHeapPressureKeys.delete(key);
      }
    }
  }

  private heapPressureMetadata(sample: HeapPressureSample): Record<string, unknown> {
    return {
      component: sample.component,
      ...(sample.phase !== undefined ? { phase: sample.phase } : {}),
      ...(sample.reason !== undefined ? { reason: sample.reason } : {}),
      pressureLevel: sample.pressureLevel,
      guardMode: sample.guardMode,
      heapUsedBytes: sample.heapUsedBytes,
      heapTotalBytes: sample.heapTotalBytes,
      externalBytes: sample.externalBytes,
      rssBytes: sample.rssBytes,
      heapLimitBytes: sample.heapLimitBytes,
      heapUsedPercentOfLimit: sample.heapUsedPercentOfLimit,
    };
  }

  private async sampleHeap(input: {
    component: string;
    phase?: "before" | "after" | "point" | undefined;
    runId?: string | undefined;
    sessionId?: string | undefined;
    stepIndex?: number | undefined;
    stepAgent?: string | undefined;
    reason?: string | undefined;
  }): Promise<HeapPressureSample | undefined> {
    if (this.deps.heapDiagnostics === undefined) {
      return ;
    }
    try {
      return await this.deps.heapDiagnostics.sample(input);
    } catch {
      // Diagnostics must not change runtime behavior.
      return ;
    }
  }

  private async callToolWithWorkspaceCheckpoint(input: {
    preparedToolCall: import("../kestrel/contracts/tool-invocation.js").PreparedToolCallV1;
    sessionId: string;
    runId: string;
    stepIndex: number;
    stepAgent: string;
    runtimeMetadata: Record<string, unknown> | undefined;
    runtimePayload: Record<string, unknown> | undefined;
    sessionState: Record<string, unknown>;
    trustedManagedWorktreeBinding?: ManagedTaskWorktreeBinding | undefined;
    signal?: AbortSignal | undefined;
    console?: ToolConsoleSink | undefined;
  }) {
    const toolName = input.preparedToolCall.activation.descriptor.toolId;
    if (this.deps.toolGateway.preRun !== undefined) {
      await this.deps.toolGateway.preRun({
        runId: input.runId,
        event: {
          id: `tool-execute:${input.runId}:${randomUUID()}`,
          type: "tool.execute",
          sessionId: input.sessionId,
          payload: input.runtimePayload ?? {},
          stepAgent: input.stepAgent,
        },
        session: {
          sessionId: input.sessionId,
          version: 0,
          state: input.sessionState,
          currentStepAgent: input.stepAgent,
          updatedAt: new Date().toISOString(),
        },
      });
    }
    const checkpointContext = this.resolveMutationCheckpointContext(
      toolName,
      input.runtimeMetadata,
      input.trustedManagedWorktreeBinding,
    );
    const toolRunContext = {
      runId: input.runId,
      sessionId: input.sessionId,
      payload: input.runtimePayload ?? {},
      sessionState: input.sessionState,
    };
    if (checkpointContext === undefined) {
      const result = await this.deps.toolGateway.executePreparedToolCall(input.preparedToolCall, {
        signal: input.signal,
        runContext: toolRunContext,
        ...(input.console !== undefined ? { console: input.console } : {}),
      });
      this.throwIfExecutionAuthorizationFailed(result, toolName);
      return result;
    }

    const preAction = await this.deps.workspaceCheckpointService!.capture({
      sessionId: input.sessionId,
      setup: checkpointContext.setup,
      kind: "pre_mutation",
      label: `pre:${toolName}:${input.stepIndex}`,
      reason: `Pre-action checkpoint for ${toolName}`,
      runId: input.runId,
      taskId: checkpointContext.taskId,
      createdBy: "runtime",
    });
    const observationBaseline = this.readLatestWorkspaceObservationBaseline(input.sessionState) ?? {
      checkpointId: preAction.checkpoint.checkpointId,
      gitRef: preAction.checkpoint.gitRef,
    };

    try {
      const result = await this.deps.toolGateway.executePreparedToolCall(input.preparedToolCall, {
        signal: input.signal,
        runContext: toolRunContext,
        ...(input.console !== undefined ? { console: input.console } : {}),
      });
      if (result.status === "FAILED") {
        if (result.outcome.kind === "cancellation") {
          throw new RunCancelledError();
        }
        const outcomeError = result.outcome.kind === "failure"
          ? result.outcome.error
          : undefined;
        throw createRuntimeFailure(
          result.outcome.kind === "failure"
            ? result.outcome.normalizedFailureCode
            : "TOOL_EXECUTION_FAILED",
          outcomeError?.message ?? `Tool '${toolName}' failed.`,
          {
            recoverable: result.outcome.kind === "failure"
              ? result.outcome.retryable
              : false,
            toolName,
            effectState: result.outcome.effectState,
            ...(outcomeError?.details ?? {}),
          },
        );
      }
      this.assertManagedWorktreeSourceWriteGuardMode(toolName, result.auditRecord.output);
      const diff = await this.deps.workspaceCheckpointService!.diff({
        sessionId: input.sessionId,
        setup: checkpointContext.setup,
        source: { checkpointId: observationBaseline.checkpointId },
        target: { workingTree: true },
        includeHunks: false,
      });
      const changedFiles = diff.files.map((file) => file.path);
      const resultOutput = this.asRecord(result.auditRecord.output);
      const processStillRunning = this.asString(resultOutput?.status)?.trim().toUpperCase() === "RUNNING";
      const postAction = changedFiles.length === 0 && processStillRunning === false
        ? preAction
        : await this.deps.workspaceCheckpointService!.capture({
            sessionId: input.sessionId,
            setup: checkpointContext.setup,
            kind: "pre_mutation",
            label: `post:${toolName}:${input.stepIndex}`,
            reason: `Post-action checkpoint for ${toolName}`,
            runId: input.runId,
            taskId: checkpointContext.taskId,
            createdBy: "runtime",
            baseCheckpointId: preAction.checkpoint.checkpointId,
          });
      return this.attachWorkspaceCheckpointEvidence(result, {
        toolName,
        changedFiles,
        preActionCheckpointId: observationBaseline.checkpointId,
        preActionGitRef: observationBaseline.gitRef,
        postActionCheckpointId: postAction?.checkpoint.checkpointId,
        postActionGitRef: postAction?.checkpoint.gitRef,
      });
    } catch (error) {
      const diff = await this.deps.workspaceCheckpointService!.diff({
        sessionId: input.sessionId,
        setup: checkpointContext.setup,
        source: { checkpointId: preAction.checkpoint.checkpointId },
        target: { workingTree: true },
        includeHunks: false,
      });
      if (diff.files.length === 0) {
        throw error;
      }
      try {
        await this.deps.workspaceCheckpointService!.restore({
          sessionId: input.sessionId,
          setup: checkpointContext.setup,
          checkpointId: preAction.checkpoint.checkpointId,
          reason: `Rollback failed ${toolName}`,
          runId: input.runId,
          taskId: checkpointContext.taskId,
          restoredBy: "runtime",
        });
      } catch (rollbackError) {
        throw createRuntimeFailure("WORKSPACE_CHECKPOINT_ROLLBACK_FAILED", `Failed to roll back changes from '${toolName}'.`, {
          toolName,
          preActionCheckpointId: preAction.checkpoint.checkpointId,
          changedFiles: diff.files.map((file) => file.path),
          rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          originalError: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private throwIfExecutionAuthorizationFailed(
    result: AgentToolResultV2,
    toolName: string,
  ) {
    if (
      result.outcome.kind !== "failure" ||
      ![
        "EXECUTION_AUTH_EXPIRED",
        "EXECUTION_AUTH_RENEWAL_DENIED",
        "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
      ].includes(result.outcome.normalizedFailureCode)
    ) {
      return;
    }
    throw createRuntimeFailure(
      result.outcome.normalizedFailureCode,
      result.outcome.error.message,
      {
        recoverable: false,
        toolName,
        effectState: result.outcome.effectState,
        ...(result.outcome.error.details ?? {}),
      },
    );
  }

  private readLatestWorkspaceObservationBaseline(
    sessionState: Record<string, unknown>,
  ): { checkpointId: string; gitRef: string } | undefined {
    const agentState = this.asRecord(sessionState.agent);
    const ledger = Array.isArray(agentState?.evidenceLedger) ? agentState.evidenceLedger : [];
    for (const item of [...ledger].reverse()) {
      const entry = this.asRecord(item);
      const facts = this.asRecord(entry?.facts);
      const checkpoint = this.asRecord(facts?.workspaceCheckpoint);
      const checkpointId = this.asString(checkpoint?.postActionCheckpointId);
      const gitRef = this.asString(checkpoint?.postActionGitRef);
      if (checkpointId !== undefined && gitRef !== undefined) {
        return { checkpointId, gitRef };
      }
    }
    return ;
  }

  private assertManagedWorktreeSourceWriteGuardMode(toolName: string, result: unknown): void {
    const resultRecord = this.asRecord(result);
    const sourceWriteGuard = this.asRecord(resultRecord?.sourceWriteGuard);
    const mode = this.asString(sourceWriteGuard?.mode);
    if (mode !== "source_readonly") {
      return;
    }
    throw createRuntimeFailure(
      "MANAGED_WORKTREE_SOURCE_WRITE_GUARD_MODE_MISMATCH",
      `Managed worktree tool '${toolName}' ran with source-readonly dev-shell guard mode.`,
      {
        toolName,
        sourceWriteGuardMode: mode,
        expectedSourceWriteGuardMode: "checkpoint_worktree",
        recoverable: false,
      },
    );
  }

  private resolveMutationCheckpointContext(
    toolName: string,
    runtimeMetadata: Record<string, unknown> | undefined,
    trustedBinding: ManagedTaskWorktreeBinding | undefined,
  ): { setup: ProductProjectSetupState; taskId?: string | undefined } | undefined {
    if (this.deps.workspaceCheckpointService === undefined || isMutationCapableToolName(toolName) === false) {
      return ;
    }
    if (trustedBinding === undefined) {
      return ;
    }
    const workspace = this.asRecord(runtimeMetadata?.workspace);
    if (workspace?.managedWorktree !== true || this.asString(workspace.workspaceRoot) !== trustedBinding.worktreeRoot) {
      return ;
    }
    const workspaceRoot = this.asString(workspace.workspaceRoot);
    if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
      throw createRuntimeFailure("WORKSPACE_CHECKPOINT_WORKTREE_REQUIRED", "Managed coding mutations require a workspaceRoot.");
    }
    const repoRoot = this.asString(workspace.repoRoot) ?? workspaceRoot;
    return {
      setup: {
        workspaceRoot,
        repoRoot,
        repoLabel: this.asString(workspace.repoLabel) ?? "managed-worktree",
        defaultBranch: this.asString(workspace.defaultBranch) ?? "HEAD",
        providerProfileId: this.asString(workspace.providerProfileId) ?? "runtime",
        githubConnected: workspace.githubConnected === true,
        browserReady: workspace.browserReady === true,
        codeReady: workspace.codeReady !== false,
        mcpReady: workspace.mcpReady === true,
      },
      ...(this.asString(runtimeMetadata?.taskId) !== undefined ? { taskId: this.asString(runtimeMetadata?.taskId) } : {}),
    };
  }

  private async settleOwnedExecCommandProcesses(
    runId: string,
    session: SessionRecord,
  ): Promise<void> {
    const sessionState = session.state as Record<string, unknown>;
    const agent = this.asRecord(sessionState.agent);
    const execState = this.asRecord(agent?.exec);
    const devShell = this.asRecord(execState?.devShell);
    const processes = this.asRecord(devShell?.processes) ?? {};
    const ownedProcessIds = Object.values(processes)
      .map((value) => this.asRecord(value))
      .filter((process): process is Record<string, unknown> =>
        process !== undefined &&
        this.asString(process.ownerRunId) === runId &&
        this.asString(process.status)?.trim().toUpperCase() === "RUNNING")
      .map((process) => this.asString(process.processId))
      .filter((processId): processId is string => processId !== undefined);
    if (ownedProcessIds.length === 0) {
      return;
    }

    const binding = this.readManagedWorktreeBindingFromState(sessionState);
    const workspace = binding === undefined
      ? undefined
      : {
          workspaceRoot: binding.worktreeRoot,
          repoRoot: binding.worktreeRoot,
          managedWorktree: true,
          sourceWorkspaceRoot: binding.sourceWorkspaceRoot,
          sourceRepoRoot: binding.sourceRepoRoot,
        };
    const runtimePayload = workspace === undefined ? {} : { workspace };
    const ledger = Array.isArray(agent?.evidenceLedger) ? agent.evidenceLedger : [];
    const latestStepIndex = ledger.reduce((latest, value) => {
      const stepIndex = this.asRecord(value)?.stepIndex;
      return typeof stepIndex === "number" && Number.isFinite(stepIndex)
        ? Math.max(latest, Math.trunc(stepIndex))
        : latest;
    }, 0);

    for (const processId of ownedProcessIds) {
      const toolInput = { sessionId: processId, stop: true, yieldTimeMs: 1000 };
      const runContext = {
        runId,
        sessionId: session.sessionId,
        payload: runtimePayload,
        sessionState,
      };
      const snapshot = await this.deps.toolGateway.createToolSurfaceSnapshot({
        runContext,
        toolNames: ["exec_command"],
      });
      const activation = snapshot.tools.find(
        (candidate) => candidate.descriptor.toolId === "exec_command",
      );
      if (activation === undefined) {
        await this.deps.toolGateway.releaseToolSurfaceSnapshot?.(snapshot.snapshotId);
        throw createRuntimeFailure(
          "TOOL_SNAPSHOT_LOOKUP_FAILED",
          "Runtime closeout tool 'exec_command' is unavailable.",
          { recoverable: false, toolName: "exec_command" },
        );
      }
      const preparedToolCall = await this.deps.toolGateway.prepareToolCall(
        {
          runId,
          sessionId: session.sessionId,
          callId: `runtime-closeout:${runId}:${processId}`,
          activation,
          origin: {
            kind: "trusted_runtime",
            producerId: "runtime.process-closeout:v1",
            adapterId: "runtime.process-stop:v1",
          },
          rawInput: toolInput,
          policy: {
            decision: "allow",
            policyRevision: hashCanonical({
              version: "v1",
              source: "runtime.process-closeout",
              activation,
              payload: toolInput,
            }),
          },
        },
        { runContext },
      );
      try {
        const result = await this.callToolWithWorkspaceCheckpoint({
          preparedToolCall,
          sessionId: session.sessionId,
          runId,
          stepIndex: latestStepIndex + 1,
          stepAgent: session.currentStepAgent ?? "runtime.closeout",
          runtimeMetadata: runtimePayload,
          runtimePayload,
          sessionState,
          ...(binding !== undefined ? { trustedManagedWorktreeBinding: binding } : {}),
        });
        await this.maybeAttachManagedWorktreeProcess({
          runId,
          sessionId: session.sessionId,
          toolName: "exec_command",
          toolInput: { sessionId: processId, stop: true },
          result,
          sessionState,
        });
        const output = this.asRecord(this.asRecord(result)?.auditRecord)?.output ?? result;
        const outputRecord = this.asRecord(output);
        await this.appendRunEvent(runId, session.sessionId, "run.tool.completed", "WARN", {
          toolName: "exec_command",
          lifecycle: "runtime_closeout_stop",
          processId,
          status: this.asString(outputRecord?.status),
          exitCode: outputRecord?.exitCode,
          changedFiles: outputRecord?.changedFiles,
          workspaceCheckpoint: outputRecord?.workspaceCheckpoint,
        }, latestStepIndex + 1);
      } catch (error) {
        await this.appendRunEvent(runId, session.sessionId, "run.tool.failed", "ERROR", {
          toolName: "exec_command",
          lifecycle: "runtime_closeout_stop",
          processId,
          message: error instanceof Error ? error.message : String(error),
        }, latestStepIndex + 1);
      } finally {
        await this.deps.toolGateway.releaseToolSurfaceSnapshot?.(snapshot.snapshotId);
      }
    }
  }

  private async maybeAttachManagedWorktreeProcess(input: {
    runId: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
    result: unknown;
    sessionState: Record<string, unknown>;
  }): Promise<void> {
    if (this.deps.managedTaskWorktreeService === undefined) {
      return;
    }
    const resultOutput = this.asRecord(this.asRecord(input.result)?.auditRecord)?.output ?? input.result;
    const toolInput = this.asRecord(input.toolInput);
    const output = this.asRecord(resultOutput);
    const isExecCommandContinuation = input.toolName === "exec_command" &&
      this.asString(toolInput?.sessionId) !== undefined;
    if (
      input.toolName === "dev.process.stop" ||
      input.toolName === "dev.process.read" ||
      input.toolName === "dev.process.write_and_read" ||
      isExecCommandContinuation
    ) {
      const processId = this.asString(toolInput?.processId) ??
        this.asString(toolInput?.sessionId) ??
        this.asString(output?.processId) ??
        this.asString(output?.sessionId);
      const binding = this.readManagedWorktreeBindingFromState(input.sessionState);
      const status = this.asString(output?.status)?.trim().toUpperCase();
      if (processId !== undefined && binding !== undefined && status !== "RUNNING") {
        await this.deps.managedTaskWorktreeService.releaseProcess({
          worktreeRoot: binding.worktreeRoot,
          processId,
        });
        await this.appendRunEvent(input.runId, input.sessionId, "managed_worktree.process_released", "INFO", {
          processId,
          ...this.toManagedWorktreeEventPayload(binding),
        });
      }
      return;
    }
    const isExecCommandStart = input.toolName === "exec_command" &&
      this.asString(toolInput?.command) !== undefined;
    if (input.toolName !== "dev.process.start" && isExecCommandStart === false) {
      return;
    }
    const processId = this.asString(output?.processId) ?? this.asString(output?.sessionId);
    const status = this.asString(output?.status)?.trim().toUpperCase();
    if (processId === undefined || status !== "RUNNING") {
      return;
    }
    const binding = this.readManagedWorktreeBindingFromState(input.sessionState);
    if (binding === undefined) {
      return;
    }
    await this.deps.managedTaskWorktreeService.attachProcess(binding, {
      processId,
      runId: input.runId,
      sessionId: input.sessionId,
    });
    await this.appendRunEvent(input.runId, input.sessionId, "managed_worktree.process_attached", "INFO", {
      processId,
      ...this.toManagedWorktreeEventPayload(binding),
    });
  }

  private attachWorkspaceCheckpointEvidence(
    result: AgentToolResultV2,
    evidence: {
      toolName: string;
      changedFiles: string[];
      preActionCheckpointId: string;
      preActionGitRef: string;
      postActionCheckpointId?: string | undefined;
      postActionGitRef?: string | undefined;
    },
  ): AgentToolResultV2 {
    const resultRecord = this.asRecord(result.auditRecord.output);
    if (resultRecord === undefined) {
      return result;
    }
    const existingChangedFiles = Array.isArray(resultRecord.changedFiles)
      ? resultRecord.changedFiles.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const changedFiles = [...new Set([...existingChangedFiles, ...evidence.changedFiles])];
    const checkpointEvidence = {
      preActionCheckpointId: evidence.preActionCheckpointId,
      preActionGitRef: evidence.preActionGitRef,
      ...(evidence.postActionCheckpointId !== undefined
        ? { postActionCheckpointId: evidence.postActionCheckpointId }
        : {}),
      ...(evidence.postActionGitRef !== undefined ? { postActionGitRef: evidence.postActionGitRef } : {}),
    };
    const output = {
      ...resultRecord,
      ...(changedFiles.length > 0 ? { changedFiles } : {}),
      workspaceCheckpoint: checkpointEvidence,
      ...(this.asRecord(resultRecord.sourceWriteGuard) !== undefined
        ? {
            sourceWriteGuard: {
              ...this.asRecord(resultRecord.sourceWriteGuard),
              ...(changedFiles.length > 0 ? { changedFiles } : {}),
              preActionCheckpointId: evidence.preActionCheckpointId,
              ...(evidence.postActionCheckpointId !== undefined
                ? { postActionCheckpointId: evidence.postActionCheckpointId }
                : {}),
            },
          }
        : {}),
    };
    const replaced = replaceAgentToolResultOutput(result, output) as AgentToolResultV2;
    return result.outcome.kind === "success" || result.outcome.kind === "partial"
      ? {
          ...replaced,
          outcome: {
            ...result.outcome,
            rawOutput: output,
          },
        }
      : replaced;
  }

  private buildModelTimeoutMetadata(
    sessionState: Record<string, unknown>,
    progress: {
      runId: string;
      sessionId: string;
      stepIndex: number;
      stepAgent: string;
      phase: ProgressPhase;
    },
    request: ModelRequest,
    runtimeBudgetRemainingMs: number,
  ): Record<string, unknown> {
    const reactState = this.asRecord(sessionState.agent) ?? {};
    const objective = readResearchObjective(reactState);
    const lastToolSnapshot = readLastToolSnapshot(reactState);
    return {
      runId: progress.runId,
      phase: progress.phase,
      stepAgent: progress.stepAgent,
      runtimeBudgetRemainingMs,
      ...(typeof request.model === "string" ? { model: request.model } : {}),
      ...(objective !== undefined ? { objective } : {}),
      ...(lastToolSnapshot.lastToolName !== undefined
        ? { lastToolName: lastToolSnapshot.lastToolName }
        : {}),
      ...(lastToolSnapshot.lastToolInputHash !== undefined
        ? { lastToolInputHash: lastToolSnapshot.lastToolInputHash }
        : {}),
    };
  }

  private resolveProgressPhase(stepAgent: string | undefined): ProgressPhase {
    if (stepAgent === undefined) {
      return "engine";
    }
    if (stepAgent === "agent.loop") {
      return "agent";
    }
    if (stepAgent.endsWith("route")) {
      return "route";
    }
    if (stepAgent.endsWith("chat")) {
      return "chat";
    }
    if (stepAgent.endsWith("thinker")) {
      return "thinker";
    }
    if (stepAgent.endsWith("resolve")) {
      return "resolver";
    }
    if (stepAgent.endsWith("acter") || stepAgent.startsWith("agent.exec.")) {
      return "acter";
    }
    return "engine";
  }

  private async withProgressHeartbeat<T>(
    options: {
      runId: string;
      sessionId: string;
      stepIndex?: number | undefined;
      stepAgent?: string | undefined;
      phase: ProgressPhase;
      sequence: () => number;
      message: string;
    },
    work: () => Promise<T>,
  ): Promise<T> {
    const heartbeatMs = this.resolveHeartbeatMs();
    if (heartbeatMs <= 0) {
      return work();
    }

    let timer: NodeJS.Timeout | undefined;
    timer = setInterval(() => {
      const nextSeq = options.sequence();
      void this.emitProgressFromSequence({
        runId: options.runId,
        sessionId: options.sessionId,
        seq: nextSeq,
        kind: "heartbeat",
        phase: options.phase,
        code: "RUN_STILL_ACTIVE",
        message: options.message,
        stepIndex: options.stepIndex,
        stepAgent: options.stepAgent,
        persist: false,
      });
    }, heartbeatMs);

    try {
      return await work();
    } finally {
      if (timer !== undefined) {
        clearInterval(timer);
      }
    }
  }

  private resolveHeartbeatMs(): number {
    const raw = process.env.KCHAT_PROGRESS_HEARTBEAT_MS;
    if (raw === undefined) {
      return DEFAULT_PROGRESS_HEARTBEAT_MS;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return DEFAULT_PROGRESS_HEARTBEAT_MS;
    }
    return parsed;
  }

  private resolveToolQueueEnabled(): boolean {
    const raw = process.env.KCHAT_TOOL_QUEUE_ENABLED;
    if (raw === undefined) {
      return true;
    }
    return raw.trim().toLowerCase() !== "false";
  }

  private resolveStepFrameBufferEnabled(): boolean {
    const raw = process.env.KESTREL_STEP_FRAME_BUFFER;
    if (raw === undefined) {
      return true;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized !== "0" && normalized !== "false" && normalized !== "off";
  }

  private resolveProgressPersistGranularity(): ProgressPersistGranularity {
    const raw = process.env.KCHAT_PROGRESS_PERSIST_GRANULARITY;
    if (raw === undefined) {
      return "full";
    }
    return raw.trim().toLowerCase() === "compact" ? "compact" : "full";
  }

  private isRetryableToolError(error: unknown): boolean {
    if (error instanceof Error === false) {
      return false;
    }

    const code = typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code?: string }).code).toUpperCase()
      : "";
    const message = error.message.toLowerCase();
    return (
      code.includes("TIMEOUT") ||
      code.includes("RATE_LIMIT") ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "EAI_AGAIN" ||
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("fetch failed") ||
      message.includes("status 429") ||
      message.includes("rate limit")
    );
  }

  private async emitProgressFromSequence(
    input: ProgressEmitOptions,
  ): Promise<void> {
    const update = this.buildProgressUpdate(input);
    const validationError = this.validateProgressUpdate(update);
    if (validationError !== undefined) {
      await this.logWarn({
        runId: update.runId,
        sessionId: update.sessionId,
        ...(update.stepIndex !== undefined ? { stepIndex: update.stepIndex } : {}),
        eventName: "progress_invalid",
        metadata: {
          reason: validationError,
          code: update.code,
          kind: update.kind,
        },
      });
      return;
    }

    await this.deps.progressReporter.emit(update);
    if (update.persist && this.shouldPersistProgressEvent(update)) {
      const event = buildPersistedRuntimeEventFromProgressUpdate(update);
      await this.appendRunEvent(
        event.runId,
        event.sessionId,
        event.type,
        event.level,
        event.metadata,
        event.stepIndex,
        input.bypassRunEventBuffer === true ? { bypassBuffer: true } : undefined,
      );
    }
  }

  private shouldPersistProgressEvent(update: ProgressUpdateV1): boolean {
    return shouldPersistProgressUpdate(
      update,
      this.progressPersistGranularity,
    );
  }

  private async emitProgress(
    input: ProgressEmitOptions,
  ): Promise<number> {
    const seq = input.seq + 1;
    await this.emitProgressFromSequence({
      ...input,
      seq,
    });
    return seq;
  }

  private buildProgressUpdate(
    input: Omit<ProgressUpdateV1, "version" | "ts">,
  ): ProgressUpdateV1 {
    const message = this.sanitizeProgressMessage(input.message);
    return {
      version: "v1",
      ...input,
      message,
      ts: new Date().toISOString(),
    };
  }

  private sanitizeProgressMessage(message: string): string {
    const ascii = message.replace(/[^\x20-\x7E]/gu, " ").replace(/\s+/gu, " ").trim();
    if (ascii.length <= MAX_PROGRESS_MESSAGE_LENGTH) {
      return ascii.length === 0 ? "Working..." : ascii;
    }
    return `${ascii.slice(0, MAX_PROGRESS_MESSAGE_LENGTH - 3)}...`;
  }

  private validateProgressUpdate(update: ProgressUpdateV1): string | undefined {
    if (update.message.trim().length === 0) {
      return "message_empty";
    }
    if (update.message.length > MAX_PROGRESS_MESSAGE_LENGTH) {
      return "message_too_long";
    }
    if (!Number.isFinite(update.seq) || update.seq < 1) {
      return "invalid_seq";
    }
    if (update.kind === "tool" && update.tool === undefined) {
      return "tool_details_required";
    }
    if (update.kind === "waiting" && update.waitFor === undefined) {
      return "waitfor_required";
    }
    return ;
  }

  private async resolveEffects(
    effects: Effect[],
    runId: string,
    stepIndex: number,
    runtimePayload: Record<string, unknown> | undefined,
    session: SessionRecord,
    runtimeBudgetRemainingMs: number,
  ): Promise<ResolvedEffect[]> {
    return Promise.all(effects.map(async (effect, index) => {
      const idempotencyKey =
        effect.idempotencyKey ?? `${runId}:step:${stepIndex}:effect:${index}:${effect.type}`;
      if (effect.type !== "execute_tool_call" && effect.type !== "tool.execute") {
        return {
          type: effect.type,
          payload: effect.payload,
          idempotencyKey,
          failurePolicy: effect.failurePolicy ?? "STOP",
        };
      }
      const payload = this.asRecord(effect.payload);
      const retiredRecoveryFields = [
        "recoveryDecision",
        "recoveryAdapterId",
        "recoverySourceToolId",
      ].filter((field) => payload !== undefined && Object.hasOwn(payload, field));
      if (retiredRecoveryFields.length > 0) {
        throw createRuntimeFailure(
          "TOOL_EFFECT_PREPARATION_FAILED",
          "Tool effects cannot contain retired recovery transition fields.",
          {
            recoverable: false,
            effectType: effect.type,
            fields: retiredRecoveryFields,
          },
        );
      }
      if (payload?.preparedToolCall !== undefined) {
        const mixedPreparedFields = [
          "toolName",
          "toolInput",
          "modelToolCallId",
          "toolSurfaceSnapshot",
        ].filter((field) => Object.hasOwn(payload, field));
        if (mixedPreparedFields.length > 0) {
          throw createRuntimeFailure(
            "TOOL_EFFECT_PREPARATION_FAILED",
            "A prepared tool effect cannot include reconstructible tool-call fields.",
            {
              recoverable: false,
              effectType: effect.type,
              fields: mixedPreparedFields,
            },
          );
        }
        let preparedToolCall;
        try {
          preparedToolCall = parseDurablePreparedToolCallV1(
            payload.preparedToolCall,
          );
        } catch (error) {
          throw createRuntimeFailure(
            "TOOL_EFFECT_PREPARATION_FAILED",
            "The durable prepared invocation is invalid.",
            {
              recoverable: false,
              effectType: effect.type,
              cause: error instanceof Error ? error.message : String(error),
            },
          );
        }
        if (
          preparedToolCall.sessionId !== session.sessionId ||
          preparedToolCall.callId !== idempotencyKey
        ) {
          throw createRuntimeFailure(
            "TOOL_EFFECT_PREPARATION_FAILED",
            "The durable prepared invocation does not match the committed effect identity.",
            {
              recoverable: false,
              effectType: effect.type,
              preparedInvocationId: preparedToolCall.callId,
            },
          );
        }
        if (preparedToolCall.policy.decision === "approval_required") {
          const pendingApproval = readPendingToolApproval(session.state);
          const authority = preparedToolCall.stableAuthority;
          if (authority === undefined) {
            if (
              pendingApproval?.version !== "local_tool_approval_v1" ||
              pendingApproval.preparedInvocationId !== preparedToolCall.callId ||
              pendingApproval.approvalId !== preparedToolCall.approval?.approvalId ||
              pendingApproval.toolName !==
                preparedToolCall.activation.descriptor.toolId
            ) {
              throw createRuntimeFailure(
                "TOOL_EFFECT_PREPARATION_FAILED",
                "The approved local prepared invocation does not match the committed approval wait.",
                {
                  recoverable: false,
                  effectType: effect.type,
                  preparedInvocationId: preparedToolCall.callId,
                },
              );
            }
            if (pendingApproval.toolClass === "external_side_effect") {
              let preparedApprovalBinding;
              let pendingApprovalBinding;
              try {
                preparedApprovalBinding = parseRunnerExternalApprovalBindingV1(
                  preparedToolCall.approval?.externalApprovalBinding,
                );
                pendingApprovalBinding = parseRunnerExternalApprovalBindingV1(
                  pendingApproval.externalApprovalBinding,
                );
              } catch (error) {
                throw createRuntimeFailure(
                  "TOOL_EFFECT_PREPARATION_FAILED",
                  "The approved local prepared invocation binding is invalid.",
                  {
                    recoverable: false,
                    effectType: effect.type,
                    preparedInvocationId: preparedToolCall.callId,
                    cause: error instanceof Error ? error.message : String(error),
                  },
                );
              }
              if (
                preparedApprovalBinding.approvalId !==
                  preparedToolCall.approval?.approvalId ||
                preparedApprovalBinding.threadId !== preparedToolCall.sessionId ||
                preparedApprovalBinding.runId !== preparedToolCall.runId ||
                preparedApprovalBinding.actionKey !==
                  preparedToolCall.activation.descriptor.toolId ||
                preparedApprovalBinding.payloadHash !==
                  hashCanonical(preparedToolCall.effectiveInput) ||
                pendingApproval.toolClass !== preparedApprovalBinding.toolClass ||
                serializeCanonicalApprovalPayload(pendingApprovalBinding) !==
                  serializeCanonicalApprovalPayload(preparedApprovalBinding) ||
                Date.parse(preparedApprovalBinding.expiresAt) <= Date.now()
              ) {
                throw createRuntimeFailure(
                  "TOOL_EFFECT_PREPARATION_FAILED",
                  "The approved local prepared invocation does not match the committed approval wait.",
                  {
                    recoverable: false,
                    effectType: effect.type,
                    preparedInvocationId: preparedToolCall.callId,
                  },
                );
              }
            } else if (
              preparedToolCall.approval?.externalApprovalBinding !== undefined ||
              pendingApproval.externalApprovalBinding !== undefined ||
              typeof pendingApproval.expiresAt !== "string" ||
              Date.parse(pendingApproval.expiresAt) <= Date.now()
            ) {
              throw createRuntimeFailure(
                "TOOL_EFFECT_PREPARATION_FAILED",
                "The approved local prepared invocation has inconsistent approval evidence.",
                {
                  recoverable: false,
                  effectType: effect.type,
                  preparedInvocationId: preparedToolCall.callId,
                },
              );
            }
          } else {
            if (
              pendingApproval?.version !== "hosted_tool_approval_v2" ||
              pendingApproval.preparedInvocationId !== preparedToolCall.callId ||
              pendingApproval.approvalId !== preparedToolCall.approval?.approvalId ||
              pendingApproval.toolName !==
                preparedToolCall.activation.descriptor.toolId ||
              (authority.version === "prepared_tool_stable_authority_v2" &&
                pendingApproval.toolClass !== authority.executionClass)
            ) {
              throw createRuntimeFailure(
                "TOOL_EFFECT_PREPARATION_FAILED",
                "The approved prepared invocation does not match the committed approval wait.",
                {
                  recoverable: false,
                  effectType: effect.type,
                  preparedInvocationId: preparedToolCall.callId,
                },
              );
            }
            let preparedApprovalBinding;
            let pendingApprovalBinding;
            try {
              preparedApprovalBinding = parseRunnerExternalApprovalBindingV2(
                preparedToolCall.approval?.externalApprovalBinding,
              );
              pendingApprovalBinding = parseRunnerExternalApprovalBindingV2(
                pendingApproval.externalApprovalBinding,
              );
            } catch (error) {
              throw createRuntimeFailure(
                "TOOL_EFFECT_PREPARATION_FAILED",
                "The approved prepared invocation binding is invalid.",
                {
                  recoverable: false,
                  effectType: effect.type,
                  preparedInvocationId: preparedToolCall.callId,
                  cause: error instanceof Error ? error.message : String(error),
                },
              );
            }
            if (
              preparedApprovalBinding.preparedInvocationId !==
                preparedToolCall.callId ||
              pendingApproval.toolClass !== preparedApprovalBinding.toolClass ||
              serializeCanonicalApprovalPayload(pendingApprovalBinding) !==
                serializeCanonicalApprovalPayload(preparedApprovalBinding) ||
              Date.parse(preparedApprovalBinding.expiresAt) <= Date.now()
            ) {
              throw createRuntimeFailure(
                "TOOL_EFFECT_PREPARATION_FAILED",
                "The approved prepared invocation does not match the committed approval wait.",
                {
                  recoverable: false,
                  effectType: effect.type,
                  preparedInvocationId: preparedToolCall.callId,
                },
              );
            }
          }
        } else if (
          preparedToolCall.policy.decision !== "allow" ||
          preparedToolCall.approval?.externalApprovalBinding !== undefined
        ) {
          throw createRuntimeFailure(
            "TOOL_EFFECT_PREPARATION_FAILED",
            "A non-approved prepared invocation must be an unbound allow call.",
            {
              recoverable: false,
              effectType: effect.type,
              preparedInvocationId: preparedToolCall.callId,
            },
          );
        }
        if (this.deps.toolGateway.preRun !== undefined) {
          await this.deps.toolGateway.preRun({
            runId,
            event: {
              id: `tool-resume:${runId}:${idempotencyKey}`,
              type: effect.type,
              sessionId: session.sessionId,
              payload: runtimePayload ?? {},
              ...(session.currentStepAgent === undefined
                ? {}
                : { stepAgent: session.currentStepAgent }),
            },
            session,
          });
        }
        return {
          type: effect.type,
          payload: {
            preparedToolCall,
            ...(runtimePayload === undefined ? {} : { runtimePayload }),
          },
          idempotencyKey,
          failurePolicy: effect.failurePolicy ?? "STOP",
        };
      }
      const toolName = this.asString(payload?.toolName);
      const rawInput = this.asRecord(payload?.toolInput);
      if (payload === undefined || toolName === undefined || rawInput === undefined) {
        throw createRuntimeFailure(
          "TOOL_EFFECT_PREPARATION_FAILED",
          "Tool effects require exact toolName and object toolInput fields before persistence.",
          { recoverable: false, effectType: effect.type },
        );
      }
      const runContext = {
        runId,
        sessionId: session.sessionId,
        payload: runtimePayload ?? {},
        sessionState: session.state,
      };
      if (this.deps.toolGateway.preRun !== undefined) {
        await this.deps.toolGateway.preRun({
          runId,
          event: {
            id: `tool-prepare:${runId}:${idempotencyKey}`,
            type: effect.type,
            sessionId: session.sessionId,
            payload: runtimePayload ?? {},
            ...(session.currentStepAgent === undefined
              ? {}
              : { stepAgent: session.currentStepAgent }),
          },
          session,
        });
      }
      const authoredSnapshot = payload.toolSurfaceSnapshot === undefined
        ? undefined
        : parseToolSurfaceSnapshotV1(payload.toolSurfaceSnapshot);
      const snapshot = authoredSnapshot ??
        await this.deps.toolGateway.createToolSurfaceSnapshot({
          runContext,
          toolNames: [toolName],
        });
      const modelToolCallId = this.asString(payload.modelToolCallId);
      const resolvedIntent = authoredSnapshot !== undefined
        ? this.deps.toolGateway.resolveModelToolIntent({
            snapshot,
            toolCall: {
              id: modelToolCallId ?? idempotencyKey,
              name: toolName,
              input: rawInput,
            },
          })
        : undefined;
      const activation = resolvedIntent?.activation ?? snapshot.tools.find(
        (candidate) => candidate.descriptor.toolId === toolName,
      );
      if (activation === undefined) {
        throw createRuntimeFailure(
          "TOOL_SNAPSHOT_LOOKUP_FAILED",
          `Tool '${toolName}' was not exposed in snapshot '${snapshot.snapshotId}'.`,
          { recoverable: false, toolName },
        );
      }
      const origin = resolvedIntent === undefined
        ? {
            kind: "trusted_runtime" as const,
            producerId: "runtime.step-transition:v1",
            adapterId: "runtime.effect-tool:v1",
          }
        : {
            kind: "model" as const,
            snapshotId: snapshot.snapshotId,
            modelToolCallId: resolvedIntent.modelToolCallId,
          };
      const pendingApproval = readPendingToolApproval(session.state);
      const approvalBinding = this.asRecord(
        pendingApproval?.externalApprovalBinding,
      );
      const approvalId = this.asString(approvalBinding?.approvalId);
      const bindingAuthorityRevision = this.asString(
        approvalBinding?.authorityRevision,
      );
      let preparedRunId = runId;
      const policyRevision = hashCanonical({
        version: "v1",
        source: "runtime.tool-effect",
        descriptorRevision: activation.descriptor.contractRevision,
        scopeFingerprint: activation.scopeFingerprint,
        ...(bindingAuthorityRevision === undefined
          ? { authority: "automatic" }
          : { authority: bindingAuthorityRevision }),
      });
      let exactApprovalBinding:
        | ReturnType<typeof parseRunnerExternalApprovalBindingV1>
        | undefined;
      if (approvalId !== undefined) {
        try {
          exactApprovalBinding = parseRunnerExternalApprovalBindingV1(approvalBinding);
        } catch (error) {
          throw createRuntimeFailure(
            "TOOL_APPROVAL_BINDING_INVALID",
            "Prepared tool execution requires a valid external approval binding.",
            {
              recoverable: false,
              toolName,
              cause: error instanceof Error ? error.message : String(error),
            },
          );
        }
        if (
          exactApprovalBinding.actionKey !== toolName ||
          Date.parse(exactApprovalBinding.expiresAt) <= Date.now()
        ) {
          throw createRuntimeFailure(
            "TOOL_APPROVAL_BINDING_CHANGED",
            "External approval no longer matches the exact prepared tool action.",
            {
              recoverable: true,
              toolName,
              approvalId: exactApprovalBinding.approvalId,
              bindingRunId: exactApprovalBinding.runId,
              preparedRunId: runId,
              bindingActionKey: exactApprovalBinding.actionKey,
              descriptorRevision: activation.descriptor.contractRevision,
              scopeFingerprint: activation.scopeFingerprint,
            },
          );
        }
        // Approval resume events may execute in a continuation run. The
        // prepared invocation retains the run identity that the operator
        // actually approved instead of silently rebinding that authority to
        // the continuation run.
        preparedRunId = exactApprovalBinding.runId;
      }
      const approval = approvalId === undefined
        ? undefined
        : {
            authorityRevision: bindingAuthorityRevision!,
            approvalId,
            ...(exactApprovalBinding === undefined
              ? {}
              : { externalApprovalBinding: exactApprovalBinding }),
          };
      const preparedToolCall = await this.deps.toolGateway.prepareToolCall(
        {
          runId: preparedRunId,
          sessionId: session.sessionId,
          callId: idempotencyKey,
          activation,
          origin,
          rawInput,
          policy: {
            decision: approval === undefined ? "allow" : "approval_required",
            policyRevision,
          },
          ...(approval === undefined ? {} : { approval }),
        },
        { runContext, runtimeBudgetRemainingMs },
      );
      if (exactApprovalBinding !== undefined) {
        const preparedPayloadHash = digestExternalApprovalPayload(
          preparedToolCall.effectiveInput,
        );
        if (exactApprovalBinding.payloadHash !== preparedPayloadHash) {
          throw createRuntimeFailure(
            "TOOL_APPROVAL_BINDING_CHANGED",
            "External approval no longer matches the normalized executable tool action.",
            {
              recoverable: true,
              toolName,
              approvalId: exactApprovalBinding.approvalId,
              bindingRunId: exactApprovalBinding.runId,
              preparedRunId,
              bindingActionKey: exactApprovalBinding.actionKey,
              bindingPayloadHash: exactApprovalBinding.payloadHash,
              preparedPayloadHash,
              descriptorRevision: activation.descriptor.contractRevision,
              scopeFingerprint: activation.scopeFingerprint,
            },
          );
        }
      }
      const {
        toolName: _toolName,
        toolInput: _toolInput,
        toolSurfaceSnapshot: _toolSurfaceSnapshot,
        modelToolCallId: _modelToolCallId,
        ...remainingPayload
      } = payload;
      return {
        type: effect.type,
        payload: {
          ...remainingPayload,
          preparedToolCall,
          ...(runtimePayload === undefined ? {} : { runtimePayload }),
        },
        idempotencyKey,
        failurePolicy: effect.failurePolicy ?? "STOP",
      };
    }));
  }

  private async resumePendingEffects(
    runId: string,
    event: RuntimeEvent,
    session: SessionRecord,
    errors: RuntimeError[],
    signal?: AbortSignal,
  ): Promise<{
    status: TransitionStatus;
    errors: RuntimeError[];
    cleanupCompleted?: boolean | undefined;
  } | undefined> {
    const sessionId = session.sessionId;
    await this.prepareFailedPreparedApprovalCleanupForResume({
      event,
      session,
    });
    const pendingEffects = await this.deps.store.listPendingEffects(sessionId);
    if (pendingEffects.length === 0) {
      return this.recoverCompletedPreparedApprovalCleanup({
        event,
        session,
        errors,
      });
    }

    await this.logInfo({
      runId,
      sessionId,
      eventName: "resume_pending_effects",
      metadata: {
        count: pendingEffects.length,
      },
    });
    await this.appendRunEvent(runId, sessionId, "effects.resumed", "INFO", {
      count: pendingEffects.length,
    });

    const runtimeBudgetRemainingMs = this.resolveRuntimeBudgetRemainingMs(event);
    const outcome = await this.deps.effectRunner.runEffects(pendingEffects, {
      runId,
      sessionId,
      stepIndex: -1,
      ...(runtimeBudgetRemainingMs !== undefined ? { runtimeBudgetRemainingMs } : {}),
      signal,
    });

    if (outcome.stop) {
      errors.push(...outcome.errors);
      return {
        status: outcome.terminalStatus ?? "FAILED",
        errors,
      };
    }

    if (pendingEffects.every(isPreparedApprovalCleanupRelease)) {
      await this.validateCompletedPreparedApprovalCleanupEffects(
        pendingEffects,
        sessionId,
      );
      return {
        status: "COMPLETED",
        errors,
        cleanupCompleted: true,
      };
    }

    return ;
  }

  private async prepareFailedPreparedApprovalCleanupForResume(input: {
    event: RuntimeEvent;
    session: SessionRecord;
  }): Promise<void> {
    try {
      const evidence = await this.readPreparedApprovalCleanupRecoveryEvidence(
        input,
      );
      if (evidence?.effect.status !== "FAILED") return;
      const result = await this.deps.store.getEffectResult(
        evidence.effect.idempotencyKey,
      );
      if (result?.status === "DONE") {
        const quarantine =
          await this.deps.store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
            evidence.effect.idempotencyKey,
            evidence.effect,
          );
        if (quarantine === "conflict") {
          throw new Error(
            "cleanup DONE evidence could not be validated or quarantined",
          );
        }
        return;
      }
      const reset =
        await this.deps.store.resetPreparedApprovalCleanupEffectExecution(
          evidence.effect.idempotencyKey,
          evidence.effect,
        );
      if (reset === "done") {
        const quarantine =
          await this.deps.store.quarantineInvalidPreparedApprovalCleanupDoneEvidence(
            evidence.effect.idempotencyKey,
            evidence.effect,
          );
        if (quarantine === "conflict") {
          throw new Error(
            "cleanup reset completion could not be validated or quarantined",
          );
        }
        return;
      }
      if (reset !== "reset") {
        throw new Error(
          "failed cleanup release could not be reset under its exact identity",
        );
      }
    } catch (error) {
      throw this.createPreparedApprovalCleanupEvidenceFailure(
        input.session.sessionId,
        error,
      );
    }
  }

  private async validateCompletedPreparedApprovalCleanupEffects(
    effects: PersistedEffect[],
    sessionId: string,
  ): Promise<void> {
    try {
      if (this.deps.store.getPersistedEffect === undefined) {
        throw new Error("cleanup completion requires persisted effect lookup");
      }
      for (const effect of effects) {
        const current = await this.deps.store.getPersistedEffect(
          effect.idempotencyKey,
        );
        const result = await this.deps.store.getEffectResult(
          effect.idempotencyKey,
        );
        if (current?.status !== "DONE" || result?.status !== "DONE") {
          throw new Error(
            "pending cleanup terminalization lacks exact DONE evidence",
          );
        }
        validatePreparedApprovalCleanupDoneEvidence({
          effect: current,
          result,
        });
      }
    } catch (error) {
      throw this.createPreparedApprovalCleanupEvidenceFailure(
        sessionId,
        error,
      );
    }
  }

  private async recoverCompletedPreparedApprovalCleanup(input: {
    event: RuntimeEvent;
    session: SessionRecord;
    errors: RuntimeError[];
  }): Promise<{
    status: TransitionStatus;
    errors: RuntimeError[];
    cleanupCompleted: true;
  } | undefined> {
    try {
      const evidence = await this.readPreparedApprovalCleanupRecoveryEvidence(
        input,
      );
      if (evidence === undefined) return;
      const { effect, terminalCleanup } = evidence;
      const result = await this.deps.store.getEffectResult(
        terminalCleanup.releaseEffectIdempotencyKey,
      );
      if (
        effect.status !== "DONE" ||
        result === null ||
        result.idempotencyKey !== effect.idempotencyKey ||
        result.status !== "DONE"
      ) {
        throw new Error(
          "cleanup recovery does not have an exact durable DONE effect and result",
        );
      }
      validatePreparedApprovalCleanupDoneEvidence({ effect, result });
      return {
        status: "COMPLETED",
        errors: input.errors,
        cleanupCompleted: true,
      };
    } catch (error) {
      throw this.createPreparedApprovalCleanupEvidenceFailure(
        input.session.sessionId,
        error,
      );
    }
  }

  private async readPreparedApprovalCleanupRecoveryEvidence(input: {
    event: RuntimeEvent;
    session: SessionRecord;
  }): Promise<{
    effect: PersistedEffect;
    terminalCleanup: PreparedApprovalCleanupTerminalV1;
  } | undefined> {
    const eventPayload = this.asRecord(input.event.payload);
    if (eventPayload?.preparedApprovalCleanup === undefined) return;
    const agent = this.asRecord(input.session.state.agent);
    const terminal = this.asRecord(agent?.terminal);
    if (terminal?.preparedApprovalCleanup === undefined) return;
    const eventCleanup = parseRunnerPreparedApprovalCleanupV1(
      eventPayload.preparedApprovalCleanup,
    );
    const terminalCleanup = parsePreparedApprovalCleanupTerminalV1(
      terminal.preparedApprovalCleanup,
    );
    if (
      serializeCanonicalApprovalPayload(eventCleanup) !==
        serializeCanonicalApprovalPayload(terminalCleanup.cleanup)
    ) {
      throw new Error(
        "cleanup recovery event does not match the terminal cleanup identity",
      );
    }
    if (this.deps.store.getPersistedEffect === undefined) {
      throw new Error("cleanup recovery requires persisted effect lookup");
    }
    const effect = await this.deps.store.getPersistedEffect(
      terminalCleanup.releaseEffectIdempotencyKey,
    );
    if (
      effect === null ||
      effect.sessionId !== input.session.sessionId ||
      effect.idempotencyKey !== terminalCleanup.releaseEffectIdempotencyKey ||
      !isPreparedApprovalCleanupRelease(effect)
    ) {
      throw new Error(
        "cleanup recovery does not match an exact persisted release effect",
      );
    }
    const effectPayload = this.asRecord(effect.payload);
    const effectCleanup = parseRunnerPreparedApprovalCleanupV1(
      effectPayload?.preparedApprovalCleanup,
    );
    const preparedToolCall = parseDurablePreparedToolCallV1(
      effectPayload?.preparedToolCall,
    );
    if (
      serializeCanonicalApprovalPayload(effectCleanup) !==
        serializeCanonicalApprovalPayload(terminalCleanup.cleanup) ||
      preparedToolCall.sessionId !== input.session.sessionId ||
      `${preparedToolCall.callId}:release` !== effect.idempotencyKey
    ) {
      throw new Error(
        "cleanup recovery effect does not match its terminal identity",
      );
    }
    return { effect, terminalCleanup };
  }

  private createPreparedApprovalCleanupEvidenceFailure(
    sessionId: string,
    error: unknown,
  ) {
    return createRuntimeFailure(
      "PREPARED_APPROVAL_CLEANUP_DONE_EVIDENCE_INVALID",
      "Prepared approval cleanup could not prove its exact durable release result.",
      {
        subsystem: "runtime",
        classification: "runtime",
        sessionId,
        cause: error instanceof Error ? error.message : "unknown",
      },
    );
  }

  private resolveRegionLaneCursor(sessionState: Record<string, unknown>): string | undefined {
    const regionState = this.asRecord(sessionState.region);
    if (regionState === undefined) {
      return ;
    }

    const cursor = regionState.laneCursor;
    if (typeof cursor !== "string" || cursor.trim().length === 0) {
      return ;
    }
    return cursor;
  }

  private async selectStepForIteration(input: {
    event: RuntimeEvent;
    session: {
      sessionId: string;
      version: number;
      state: Record<string, unknown>;
      currentStepAgent?: string | undefined;
      updatedAt: string;
    };
    sessionId: string;
    currentStep: string | undefined;
    stepIndex: number;
    laneCursor: string | undefined;
  }): Promise<
    | { kind: "claim_region_work"; step: string; regionItem: RegionWorkItem }
    | { kind: "use_current_step"; step: string }
    | {
        kind: "wait_for_merge";
        step: string;
        waitFor: { kind: "region_merge"; eventType: "system.meta_reasoning" };
      }
  > {
    return this.regionScheduler.beforeStep({
      event: input.event,
      session: input.session,
      currentStep: input.currentStep,
      stepIndex: input.stepIndex,
      laneCursor: input.laneCursor,
    });
  }

  private async handleRegionMergeConflict(input: {
    runId: string;
    sessionId: string;
    currentStep: string;
    stepIndex: number;
    session: {
      sessionId: string;
      version: number;
      state: Record<string, unknown>;
      currentStepAgent?: string | undefined;
      updatedAt: string;
    };
    activeRegionItem: RegionWorkItem | undefined;
    conflict: string;
    errors: RuntimeError[];
    guardrails: Guardrails;
    progressSeq: number;
    continuation?: NormalizedOutput["continuation"] | undefined;
  }): Promise<NormalizedOutput | undefined> {
    const runtimeError: RuntimeError = {
      code: "REGION_MERGE_CONFLICT",
      message: input.conflict,
      ...(input.activeRegionItem !== undefined
        ? {
            details: {
              region: input.activeRegionItem.region,
              itemId: input.activeRegionItem.id,
            },
          }
        : {}),
    };
    input.errors.push(runtimeError);
    const waitFor = {
      kind: "region_merge" as const,
      eventType: "system.meta_reasoning" as const,
      metadata: {
        reason: "region_merge_conflict",
        ...(input.activeRegionItem !== undefined ? { region: input.activeRegionItem.region } : {}),
      },
    };

    if (input.activeRegionItem !== undefined) {
      await this.regionScheduler.failClaim(input.activeRegionItem, {
        code: runtimeError.code,
        message: runtimeError.message,
      });
    }

    const commit = await this.deps.store.commitStep({
      runId: input.runId,
      event: {
        id: `${input.runId}:region-merge-conflict`,
        type: "system.meta_reasoning",
        sessionId: input.sessionId,
        payload: {
          reason: "region_merge_conflict",
        },
      },
      sessionId: input.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.currentStep,
      nextStepAgent: input.currentStep,
      statePatch: {
        agent: {
          ...(this.asRecord(input.session.state.agent) ?? {}),
          waitingFor: this.waitResumeCoordinator.buildWaitingFor({
            waitFor,
            resumeStepAgent: input.currentStep,
            reason: "region_merge_conflict",
            resumeInstruction: `Resume when ${waitFor.eventType} is received.`,
          }),
          terminal: {
            status: "WAITING",
            reasonCode: "region_merge_conflict",
            finalStepAgent: input.currentStep,
            finalizedAt: new Date().toISOString(),
          },
        },
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });

    await this.logWarn({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventName: "region_merge_conflict",
      metadata: {
        message: runtimeError.message,
        region: input.activeRegionItem?.region,
      },
    });
    await this.appendRunEvent(
      input.runId,
      input.sessionId,
      "region.merge_conflict",
      "WARN",
      {
        message: runtimeError.message,
        region: input.activeRegionItem?.region,
      },
      input.stepIndex,
    );
    await this.appendRunEvent(
      input.runId,
      input.sessionId,
      "region.scheduler.waiting",
      "WARN",
      {
        reason: "region_merge_conflict",
        region: input.activeRegionItem?.region,
        waitFor,
      },
      input.stepIndex,
    );
    await this.appendRunEvent(
      input.runId,
      input.sessionId,
      "policy.checkpoint",
      "WARN",
      {
        reason: "region_merge_conflict",
        region: input.activeRegionItem?.region,
        finalStep: input.currentStep,
      },
      input.stepIndex,
    );
    return this.runLifecycleController.returnTerminal({
      runId: input.runId,
      sessionId: input.sessionId,
      currentStep: input.currentStep,
      transition: {
        status: "WAITING",
        nextStepAgent: input.currentStep,
        waitFor,
      },
      errors: input.errors,
      guardrails: input.guardrails,
      progressSeq: input.progressSeq,
      continuation: input.continuation,
      stepIndex: input.stepIndex,
      skipRunStatusEvent: true,
      progressOverride: {
        kind: "waiting",
        phase: this.resolveProgressPhase(input.currentStep),
        code: "WAITING_FOR_EVENT",
        message: "Run paused due to merge conflict.",
        stepAgent: input.currentStep,
      },
      checkpointOverride: {
        stateNode:
          input.activeRegionItem?.stateNode === undefined
            ? undefined
            : `${input.activeRegionItem.stateNode.parent}/${input.activeRegionItem.stateNode.child}${input.activeRegionItem.stateNode.region === undefined ? "" : `:${input.activeRegionItem.stateNode.region}`}`,
        resumeToken: `${input.runId}:${input.currentStep}:region-merge-conflict`,
      },
      qualityMetadata: {
        reason: "region_merge_conflict",
      },
    });
  }

  private async maybeEnterAgentLoopTimeoutResumeWait(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    runtimeError: RuntimeError;
    errors: RuntimeError[];
    guardrails: Guardrails;
    progressSeq: number;
    continuation?: NormalizedOutput["continuation"] | undefined;
  }): Promise<NormalizedOutput | undefined> {
    if (input.runtimeError.code !== "IO_MODEL_TIMEOUT") {
      return ;
    }
    const timeoutDetails = this.asRecord(input.runtimeError.details);
    const phase = this.asString(timeoutDetails?.phase);
    if (phase !== "agent" && this.resolveProgressPhase(input.currentStep) !== "agent") {
      return ;
    }
    const reactState = this.asRecord(input.session.state.agent) ?? {};
    const truncatedArtifacts = readTruncatedToolArtifactsForResume(reactState.lastActionResult);
    if (truncatedArtifacts === undefined) {
      return ;
    }

    const waitMetadata: Record<string, unknown> = {
      reason: "agent_timeout_resume",
      autoResumeEligible: true,
      resumeStepAgent: "agent.loop",
      artifactIds: truncatedArtifacts.artifactIds,
      digestArtifactIds: truncatedArtifacts.digestArtifactIds,
      ...(truncatedArtifacts.digestSummaries.length > 0
        ? { digestSummaries: truncatedArtifacts.digestSummaries }
        : {}),
      timeout: {
        code: input.runtimeError.code,
        message: input.runtimeError.message,
        ...(timeoutDetails !== undefined ? { details: timeoutDetails } : {}),
      },
    };
    const waitFor = {
      kind: "effect" as const,
      eventType: "system.meta_reasoning",
      metadata: waitMetadata,
    };

    await this.deps.store.commitStep({
      runId: input.runId,
      event: {
        id: `${input.runId}:agent-timeout-resume`,
        type: "system.meta_reasoning",
        sessionId: input.event.sessionId,
        payload: {
          reason: "agent_timeout_resume",
        },
      },
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.currentStep,
      nextStepAgent: "agent.loop",
      statePatch: {
        agent: {
          ...reactState,
          waitingFor: this.waitResumeCoordinator.buildWaitingFor({
            waitFor: {
              ...waitFor,
              metadata: waitMetadata,
            },
            resumeStepAgent: "agent.loop",
            reason: "filesystem_clarification",
            resumeInstruction: "Reply with how to handle the truncated tool artifacts.",
          }),
          terminal: {
            status: "WAITING",
            reasonCode: "agent_timeout_resume",
            finalStepAgent: input.currentStep,
            finalizedAt: new Date().toISOString(),
          },
        },
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });

    return this.runLifecycleController.returnTerminal({
      runId: input.runId,
      sessionId: input.session.sessionId,
      currentStep: input.currentStep,
      transition: {
        status: "WAITING",
        nextStepAgent: "agent.loop",
        waitFor,
      },
      errors: input.errors,
      guardrails: input.guardrails,
      progressSeq: input.progressSeq,
      continuation: input.continuation,
    });
  }

  private resolveGuardrailConfigForSession(
    continuationState: ContinuationState | undefined,
  ): GuardrailConfig {
    return this.continuationCoordinator.resolveGuardrailConfigForSession(continuationState);
  }

  private resolveRuntimeBudget(event: RuntimeEvent): { externalDeadlineMs?: number | undefined } | undefined {
    const externalDeadlineMs =
      readMaybeNumber(this.asRecord(event.payload.metadata)?.externalDeadlineMs) ??
      readMaybeNumber(this.asRecord(event.payload.orchestration)?.externalDeadlineMs) ??
      readMaybeNumber(event.payload.externalDeadlineMs);
    return externalDeadlineMs !== undefined && externalDeadlineMs > 0
      ? { externalDeadlineMs: Math.trunc(externalDeadlineMs) }
      : undefined;
  }

  private resolveRuntimeBudgetRemainingMs(event: RuntimeEvent): number | undefined {
    const externalDeadlineMs = this.resolveRuntimeBudget(event)?.externalDeadlineMs;
    return externalDeadlineMs === undefined
      ? undefined
      : Math.max(0, externalDeadlineMs - Date.now());
  }

  private readContinuationState(
    sessionState: Record<string, unknown>,
  ): ContinuationState | undefined {
    return this.continuationCoordinator.readContinuationState(sessionState);
  }

  private async maybeResetContinuationStateForFreshTurn(
    runId: string,
    event: RuntimeEvent,
    session: SessionRecord,
  ): Promise<SessionRecord> {
    return this.continuationCoordinator.maybeResetContinuationStateForFreshTurn({
      runId,
      event,
      session,
    });
  }

  private async maybeHandleContinuationReply(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string | undefined;
    stepIndex: number;
  }): Promise<
    | {
        session: SessionRecord;
        currentStep: string;
        continuation?: NonNullable<NormalizedOutput["continuation"]>;
        output?: undefined;
      }
    | { output: NormalizedOutput; session?: undefined; currentStep?: undefined }
    | undefined
  > {
    return this.continuationCoordinator.maybeHandleContinuationReply(input);
  }

  private async maybeHandleLoopVisitStallReply(input: {
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
    return this.loopGuardCoordinator.maybeHandleLoopVisitStallReply(input);
  }

  private async maybeRequestContinuation(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    guardrails: Guardrails;
    progressSeq: number;
    reason: ContinuationWaitReason;
    signal?: AbortSignal | undefined;
    onCheckpointStateUpdated: (input: {
      session: SessionRecord;
      progressSeq: number;
    }) => void;
  }): Promise<NormalizedOutput | undefined> {
    return this.continuationCoordinator.maybeRequestContinuation(input);
  }

  private async maybeHandleEvaluationReviewResume(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    guardrails: Guardrails;
    progressSeq: number;
  }): Promise<{
    session?: SessionRecord | undefined;
    output?: NormalizedOutput | undefined;
  } | undefined> {
    const evaluationCoordinator = this.evaluationCoordinator;
    if (
      evaluationCoordinator === undefined ||
      input.event.type !== "user.reply"
    ) {
      return;
    }
    const agent = this.asRecord(input.session.state.agent);
    const exec = this.asRecord(agent?.exec);
    const pending = this.asRecord(exec?.pendingEvaluation);
    if (pending === undefined) return;

    const evaluationDecision = parseRuntimeEvaluationDecisionV1(
      pending.evaluationDecision,
    );
    const evaluationReviewBinding = parseEvaluationReviewBindingV1(
      pending.evaluationReviewBinding,
    );
    const request = parseRuntimeEvaluationRequestV1(pending.request);
    const verdict = pending.verdict === undefined
      ? undefined
      : parseRuntimeEvaluationVerdictV1(pending.verdict);
    const metadata = this.asRecord(input.event.payload.metadata);
    const actor = this.asRecord(metadata?.actor ?? input.event.payload.actor);
    const actorId = this.asString(actor?.actorId);
    const actorType = this.asString(actor?.actorType);
    const optionId = this.asString(input.event.payload.recoveryOptionId);
    const reviewRequestId = this.asString(pending.reviewRequestId);
    const allowedOptionIds = Array.isArray(pending.allowedOptionIds)
      ? pending.allowedOptionIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const threadId =
      this.asString(metadata?.threadId ?? input.event.payload.threadId) ??
      input.session.sessionId;
    const candidate = this.asString(pending.candidate);
    const boundaryDecision = parseExecutionBoundaryDecisionV1(
      pending.assistantOutputBoundaryDecision,
    );
    if (
      actorId === undefined ||
      (actorType !== "end_user" && actorType !== "operator") ||
      optionId === undefined ||
      reviewRequestId === undefined ||
      candidate === undefined
    ) {
      throw createRuntimeFailure(
        "EVALUATION_RESUME_INVALID",
        "Evaluation review resume requires trusted actor metadata and one exact option.",
      );
    }
    if (
      pending.threadId !== threadId ||
      pending.policyRevision !== evaluationCoordinator.policy.revision ||
      pending.profileFingerprint !==
        evaluationCoordinator.executionProfileFingerprint ||
      evaluationDecision.policyRevision !==
        evaluationCoordinator.policy.revision ||
      evaluationDecision.profileFingerprint !==
        evaluationCoordinator.executionProfileFingerprint ||
      reviewRequestId !== `evaluation-review:${evaluationDecision.decisionId}` ||
      evaluationReviewBinding.requestId !== reviewRequestId ||
      evaluationReviewBinding.threadId !== threadId ||
      evaluationReviewBinding.runId !== evaluationDecision.runId ||
      evaluationReviewBinding.evaluationDecisionId !== evaluationDecision.decisionId ||
      evaluationReviewBinding.policyRevision !== evaluationCoordinator.policy.revision ||
      evaluationReviewBinding.profileFingerprint !==
        evaluationCoordinator.executionProfileFingerprint ||
      evaluationReviewBinding.allowedOptionIds.length !== allowedOptionIds.length ||
      evaluationReviewBinding.allowedOptionIds.some(
        (allowedOptionId, index) => allowedOptionId !== allowedOptionIds[index],
      ) ||
      (evaluationReviewBinding.expiresAt !== undefined &&
        Date.parse(evaluationReviewBinding.expiresAt) <= Date.now()) ||
      request.requestId !== evaluationDecision.requestId ||
      pending.candidateDigest !== digestEvaluationCandidate(candidate) ||
      boundaryDecision.policyRevision !==
        this.executionBoundaryRuntime.policy.revision ||
      boundaryDecision.outputDigest !==
        digestBoundaryValue({ assistantText: candidate }) ||
      allowedOptionIds.length === 0 ||
      allowedOptionIds.includes(optionId) === false ||
      evaluationCoordinator.policy.actions.reviewOptionIds.includes(
        optionId as "evaluation.accept_once" | "evaluation.revise" | "terminal.fail",
      ) === false ||
      (this.asString(pending.tenantId) !== undefined &&
        this.asString(pending.tenantId) !== this.asString(actor?.tenantId)) ||
      (evaluationReviewBinding.tenantId !== undefined &&
        evaluationReviewBinding.tenantId !== this.asString(actor?.tenantId))
    ) {
      throw createRuntimeFailure(
        "EVALUATION_REVIEW_STALE",
        "Evaluation review evidence no longer matches the exact pending candidate and policy.",
      );
    }
    await this.appendRunEvent(
      input.runId,
      input.session.sessionId,
      "interaction.resolved",
      "INFO",
      {
        kind: "evaluation_review",
        requestId: reviewRequestId,
        evaluationDecisionId: evaluationDecision.decisionId,
        optionId,
        actorId,
      },
      undefined,
      { bypassBuffer: true },
    );
    await this.appendRunEvent(
      input.runId,
      input.session.sessionId,
      "evaluation.action.selected",
      optionId === "terminal.fail" ? "WARN" : "INFO",
      {
        requestId: request.requestId,
        reviewRequestId,
        evaluationDecisionId: evaluationDecision.decisionId,
        optionId,
        actorId,
      },
      undefined,
      { bypassBuffer: true },
    );

    if (optionId === "terminal.fail") {
      return {
        output: await this.runLifecycleController.returnTerminal({
          runId: input.runId,
          sessionId: input.session.sessionId,
          currentStep: input.session.currentStepAgent,
          transition: {
            status: "FAILED",
            nextStepAgent: input.session.currentStepAgent ?? "agent.loop",
          },
          errors: [{
            code: "EVALUATION_DECLINED",
            message: "The operator declined the evaluated result.",
          }],
          guardrails: input.guardrails,
          progressSeq: input.progressSeq,
        }),
      };
    }
    if (this.deps.store.patchSessionState === undefined) {
      throw createRuntimeFailure(
        "EVALUATION_RESUME_UNAVAILABLE",
        "Evaluation review resume requires durable session patch support.",
      );
    }
    const nextAgent = { ...(agent ?? {}) };
    const nextExec = { ...(exec ?? {}) };
    delete nextExec.pendingEvaluation;
    delete nextAgent.waitingFor;
    delete nextAgent.terminal;

    if (optionId === "evaluation.accept_once") {
      nextAgent.assistantText = candidate;
      nextAgent.finalOutput = candidate;
      nextExec.evaluation = {
        status: "accepted_once",
        finalRevisionsUsed: Math.max(
          0,
          Math.trunc(readMaybeNumber(pending.finalRevisionsUsed) ?? 0),
        ),
        evaluationDecision: structuredClone(evaluationDecision),
        assistantOutputBoundaryDecision: structuredClone(boundaryDecision),
      };
      nextAgent.exec = nextExec;
      const session = await this.deps.store.patchSessionState({
        sessionId: input.session.sessionId,
        expectedVersion: input.session.version,
        nextStepAgent: input.session.currentStepAgent,
        reason: "evaluation_accept_once",
        statePatch: { agent: nextAgent },
      });
      return {
        session,
        output: await this.runLifecycleController.returnTerminal({
          runId: input.runId,
          sessionId: input.session.sessionId,
          currentStep: input.session.currentStepAgent,
          transition: {
            status: "COMPLETED",
            nextStepAgent: input.session.currentStepAgent ?? "agent.loop",
          },
          errors: [],
          guardrails: input.guardrails,
          progressSeq: input.progressSeq,
        }),
      };
    }

    if (optionId !== "evaluation.revise") {
      throw createRuntimeFailure(
        "EVALUATION_OPTION_NOT_ALLOWED",
        "The selected evaluation option is not implemented.",
      );
    }
    const finalRevisionsUsed = Math.max(
      0,
      Math.trunc(readMaybeNumber(pending.finalRevisionsUsed) ?? 0),
    );
    if (
      finalRevisionsUsed >=
      evaluationCoordinator.policy.budget.maxFinalRevisions
    ) {
      throw createRuntimeFailure(
        "EVALUATION_REVISION_BOUND_REACHED",
        "The final-output evaluation revision bound has been reached.",
      );
    }
    nextAgent.assistantText = null;
    nextAgent.finalOutput = undefined;
    nextAgent.retryContext = buildEvaluationRevisionContext({
      candidate,
      result: {
        request,
        ...(verdict !== undefined ? { verdict } : {}),
        decision: evaluationDecision,
        sanitizedCandidate: candidate,
        assistantOutputBoundaryDecision: boundaryDecision,
      },
    });
    nextExec.evaluation = {
      status: "revising",
      finalRevisionsUsed: finalRevisionsUsed + 1,
      evaluationDecision: structuredClone(evaluationDecision),
    };
    nextAgent.exec = nextExec;
    const session = await this.deps.store.patchSessionState({
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      nextStepAgent: "agent.loop",
      reason: "evaluation_review_revision",
      statePatch: { agent: nextAgent },
    });
    return { session };
  }

  private async maybeRequestToolInputInvalidLoopResolution(input: {
    runId: string;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    runtimeError: RuntimeError;
    guardrails: Guardrails;
    progressSeq: number;
  }): Promise<NormalizedOutput | undefined> {
    if (input.runtimeError.code !== "LOOP_GUARD_TRIGGERED") {
      return ;
    }
    const loopDetails = this.asRecord(input.runtimeError.details);
    if (loopDetails?.loopClassification !== "tool_input_invalid") {
      return ;
    }
    const lastRejection = this.asRecord(loopDetails.lastRejection);
    const rawPath = this.asString(lastRejection?.path);
    const path = typeof rawPath === "string" ? rawPath.trim() : undefined;
    if (path === undefined || path.length === 0) {
      return ;
    }
    const toolName = this.asString(lastRejection?.toolName) ?? "filesystem tool";
    const question = `I repeatedly reached the same no-progress loop because the filesystem path '${path}' does not exist. What should I do: create it, use a different path, or skip this step?`;
    const waitFor = {
      kind: "user" as const,
      eventType: "user.reply",
      metadata: {
        reason: "tool_input_invalid",
        question,
        prompt: question,
        path,
        toolName,
        resumeReply: "continue",
      },
    };
    const reactState = this.asRecord(input.session.state.agent) ?? {};
    await this.deps.store.commitStep({
      runId: input.runId,
      event: {
        id: `${input.runId}:tool-input-loop-resolution`,
        type: "user.reply",
        sessionId: input.session.sessionId,
        payload: {
          reason: "tool_input_invalid",
          toolName,
          path,
        },
      },
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.currentStep,
      nextStepAgent: input.currentStep,
      statePatch: {
        agent: {
          ...reactState,
          waitingFor: this.waitResumeCoordinator.buildWaitingFor({
            waitFor: {
              ...waitFor,
              metadata: {
                ...waitFor.metadata,
                path,
                toolName,
              },
            },
            resumeStepAgent: input.currentStep,
            reason: "tool_input_invalid",
            resumeInstruction: `Reply with how to handle ${toolName} path ${path}.`,
            blockedAction: this.asRecord(reactState.nextAction),
          }),
          terminal: {
            status: "WAITING",
            reasonCode: "tool_input_invalid",
            finalStepAgent: input.currentStep,
            finalizedAt: new Date().toISOString(),
          },
        },
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });
    const waiting = await this.runLifecycleController.returnTerminal({
      runId: input.runId,
      sessionId: input.session.sessionId,
      currentStep: input.currentStep,
      transition: {
        status: "WAITING",
        nextStepAgent: input.currentStep,
        waitFor,
      },
      errors: [],
      guardrails: input.guardrails,
      progressSeq: input.progressSeq,
    });
    return waiting;
  }

  private buildContinuationSummary(
    reactState: Record<string, unknown>,
    currentStep: string,
  ): {
    completedSoFar: string[];
    blockedOn: string;
    nextIfApproved: string[];
    partialAnswer?: string | undefined;
  } {
    const completedSoFar: string[] = [];
    const lastObservation = latestObservationSummary(reactState.observations);
    if (lastObservation.trim().length > 0) {
      completedSoFar.push(lastObservation.trim());
    }
    const lastActionResult = this.asRecord(reactState.lastActionResult);
    const lastToolName = this.asString(lastActionResult?.toolName) ?? this.asString(lastActionResult?.name);
    if (lastToolName !== undefined) {
      completedSoFar.push(`Used ${lastToolName}.`);
    }
    const evidencedCapabilities = readCapabilityClassesFromFeedback(reactState)
      .slice(0, 3);
    if (evidencedCapabilities.length > 0) {
      completedSoFar.push(`Collected evidence for ${evidencedCapabilities.join(", ")}.`);
    }
    if (completedSoFar.length === 0) {
      completedSoFar.push("Started the task and gathered initial runtime context.");
    }

    const nextAction = this.asRecord(reactState.nextAction);
    const nextIfApproved = buildContinuationNextActions(nextAction, currentStep);
    const partialAnswer = buildContinuationPartialAnswer(
      this.asString(reactState.assistantText),
      lastObservation,
      completedSoFar,
    );
    return {
      completedSoFar: completedSoFar.slice(0, 3),
      blockedOn:
        "I hit the current step budget before I could finish the next verification and synthesis pass.",
      nextIfApproved: nextIfApproved.slice(0, 3),
      ...(partialAnswer !== undefined ? { partialAnswer } : {}),
    };
  }

  private buildResearchStallSummary(
    reactState: Record<string, unknown>,
    currentStep: string,
    runtimeError?: RuntimeError | undefined,
  ): {
    objectiveKey: string;
    stallKind?: string | undefined;
    guardType?: string | undefined;
    guardToolName?: string | undefined;
    guardRepeats?: number | undefined;
    guardThreshold?: number | undefined;
    verifiedEvidenceAvailable?: boolean | undefined;
    lowProgressCycles: number;
    retrievalToolFamily?: string | undefined;
    lowSignalState?: string | undefined;
    completedSoFar: string[];
    blockedOn: string;
    blockerLabel: string;
    nextIfContinued: string[];
    partialAnswer: string;
    evidenceRecovery?: Record<string, unknown> | undefined;
    webExtraction?: Record<string, unknown> | undefined;
    lowYieldClusters?: Array<Record<string, unknown>> | undefined;
  } | undefined {
    const postToolVerification = this.asRecord(reactState.postToolVerification);
    const activeToolName = readActiveToolName(reactState);
    const forcedRetrievalStall =
      runtimeError?.code === "LOOP_GUARD_TRIGGERED" &&
      this.asRecord(runtimeError.details)?.guardType === "REPEATED_REDUNDANT_RETRIEVAL_PIVOT";
    const runtimeErrorDetails = this.asRecord(runtimeError?.details);
    if (forcedRetrievalStall) {
      if (activeToolName === undefined || isRetrievalToolName(activeToolName) === false) {
        return ;
      }
    } else if (activeToolName === undefined || isResearchRecoveryToolName(activeToolName) === false) {
      return ;
    }

    const lowProgressCycles = countTrailingLoopCyclesWithSameEvidence(
      readLoopHistory(this.asRecord(reactState.loopGuard)?.history),
    );
    const evidenceRecoverySummary = this.asRecord(postToolVerification?.evidenceRecoverySummary);
    const evidenceLowSignalCycles =
      typeof evidenceRecoverySummary?.consecutiveLowSignal === "number" &&
        Number.isFinite(evidenceRecoverySummary.consecutiveLowSignal)
        ? Math.max(0, Math.trunc(evidenceRecoverySummary.consecutiveLowSignal))
        : 0;
    const observedLowProgressCycles = Math.max(lowProgressCycles, evidenceLowSignalCycles);
    const verdict = buildRecoveryAdaptationVerdict({
      evidenceRecovery: evidenceRecoverySummary,
      webExtraction: this.asRecord(postToolVerification?.webExtractionRetrySummary),
      lowProgressCycles: observedLowProgressCycles,
      researchToolActive: true,
    });
    if (
      forcedRetrievalStall === false &&
      verdict.evidenceRecovery === undefined &&
      verdict.lowYieldClusters.length > 0 &&
      verdict.lowYieldClusters.every((cluster) => cluster.lastToolName !== activeToolName)
    ) {
      return ;
    }
    const objectiveKey = verdict.objectiveKey ?? readResearchObjective(reactState);
    const effectiveLowProgressCycles = forcedRetrievalStall
      ? Math.max(observedLowProgressCycles, 3)
      : observedLowProgressCycles;
    if (
      objectiveKey === undefined ||
      (forcedRetrievalStall === false && verdict.researchStall.active === false)
    ) {
      return ;
    }

    const continuation = this.buildContinuationSummary(reactState, currentStep);
    const latestEvidenceRecovery = this.asRecord(evidenceRecoverySummary?.latest);
    const latestQuality = this.asString(latestEvidenceRecovery?.quality);
    const latestLowSignal = latestEvidenceRecovery?.lowSignal;
    const verifiedEvidenceAvailable =
      forcedRetrievalStall &&
      verdict.lowYieldClusters.length === 0 &&
      evidenceLowSignalCycles === 0 &&
      (latestQuality === "high" || latestLowSignal === false);
    const blockedOn = forcedRetrievalStall
      ? verifiedEvidenceAvailable
        ? "The run repeated retrieval after verified evidence was already available, so further retrieval was stopped to avoid cycling."
        : "The run repeated overlapping retrieval without making progress, so further retrieval was stopped to avoid cycling."
      : "The run is cycling through low-yield retrieval without adding new verified evidence.";
    const blockerLabel = forcedRetrievalStall ? "Retrieval guard" : "Evidence gap";
    const nextIfContinued = forcedRetrievalStall && verifiedEvidenceAvailable
      ? [
          "Synthesize the verified retrieval results already collected.",
          "Finish the answer using citations from the collected evidence.",
        ]
      : continuation.nextIfApproved;
    return {
      objectiveKey,
      ...(forcedRetrievalStall ? { stallKind: "redundant_retrieval" } : {}),
      ...(forcedRetrievalStall && this.asString(runtimeErrorDetails?.guardType) !== undefined
        ? { guardType: this.asString(runtimeErrorDetails?.guardType) }
        : {}),
      ...(forcedRetrievalStall && this.asString(runtimeErrorDetails?.toolName) !== undefined
        ? { guardToolName: this.asString(runtimeErrorDetails?.toolName) }
        : {}),
      ...(forcedRetrievalStall && typeof runtimeErrorDetails?.repeats === "number"
        ? { guardRepeats: runtimeErrorDetails.repeats }
        : {}),
      ...(forcedRetrievalStall && typeof runtimeErrorDetails?.threshold === "number"
        ? { guardThreshold: runtimeErrorDetails.threshold }
        : {}),
      ...(forcedRetrievalStall ? { verifiedEvidenceAvailable } : {}),
      lowProgressCycles: effectiveLowProgressCycles,
      ...(activeToolName !== undefined ? { retrievalToolFamily: readRetrievalToolFamily(activeToolName) } : {}),
      ...(verdict.lowSignalState !== undefined ? { lowSignalState: verdict.lowSignalState } : {}),
      completedSoFar: continuation.completedSoFar,
      blockedOn,
      blockerLabel,
      nextIfContinued,
      partialAnswer: buildResearchStallPartialAnswer({
        completedSoFar: continuation.completedSoFar,
        blockedOn,
        blockerLabel,
        nextIfContinued,
      }),
      ...(verdict.evidenceRecovery !== undefined
        ? {
            evidenceRecovery: {
              family: verdict.evidenceRecovery.family,
              attempts: verdict.evidenceRecovery.attempts,
              consecutiveLowSignal: verdict.evidenceRecovery.consecutiveLowSignal,
              latestQuality: verdict.evidenceRecovery.latest?.quality,
              latestIssues: verdict.evidenceRecovery.latest?.issues,
            },
          }
        : {}),
      ...(verdict.webExtraction !== undefined
        ? {
            webExtraction: {
              searchFallbackUsed: verdict.webExtraction.searchFallbackUsed,
              lowYieldClusters: verdict.lowYieldClusters.slice(0, 3),
            },
          }
        : {}),
      ...(verdict.lowYieldClusters.length > 0
        ? {
            lowYieldClusters: verdict.lowYieldClusters.slice(0, 3).map((cluster) => ({
              sourceCluster: cluster.sourceCluster,
              consecutiveLowYield: cluster.consecutiveLowYield,
              lastToolName: cluster.lastToolName,
              lastQuality: cluster.lastQuality,
            })),
          }
        : {}),
    };
  }

  private async maybeBuildConcreteRepairContinuation(input: {
    event: RuntimeEvent;
    runId: string;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
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
    return this.loopGuardCoordinator.maybeBuildConcreteRepairContinuation(input);
  }

  private async recordConcreteRepairContinuation(input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    targetPath: string;
    runtimeError: RuntimeError;
  }): Promise<void> {
    await this.loopGuardCoordinator.recordConcreteRepairContinuation(input);
  }

  private async maybeBuildVerifiedRetrievalContinuation(input: {
    event: RuntimeEvent;
    runId: string;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
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
    return this.loopGuardCoordinator.maybeBuildVerifiedRetrievalContinuation(input);
  }

  private async recordVerifiedRetrievalContinuation(input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    objective: string;
    guardToolName?: string | undefined;
  }): Promise<void> {
    await this.loopGuardCoordinator.recordVerifiedRetrievalContinuation(input);
  }

  private isBuildModeRun(reactState: Record<string, unknown>, event: RuntimeEvent): boolean {
    const eventPayload = this.asRecord(event.payload);
    const modeResolution = normalizeInteractionMode({
      interactionMode: eventPayload?.interactionMode ?? reactState.interactionMode,
      actSubmode: eventPayload?.actSubmode ?? reactState.actSubmode,
    });
    return modeResolution.interactionMode === "build";
  }

  private isUnattendedRepairContinuation(
    event: RuntimeEvent,
    reactState: Record<string, unknown>,
  ): boolean {
    if (event.type === "job.run") {
      return true;
    }
    const eventPayload = this.asRecord(event.payload);
    const eventMetadata = this.asRecord(eventPayload?.metadata);
    const modeResolution = normalizeInteractionMode({
      interactionMode:
        eventPayload?.interactionMode ??
        eventMetadata?.interactionMode ??
        reactState.interactionMode,
      actSubmode:
        eventPayload?.actSubmode ??
        eventMetadata?.actSubmode ??
        reactState.actSubmode,
    });
    return modeResolution.interactionMode === "build" &&
      modeResolution.actSubmode === "full_auto";
  }

  private readConcreteRepairTargetPath(reactState: Record<string, unknown>): string | undefined {
    const ledgerTarget = this.readConcreteRepairTargetPathFromEvidenceLedger(reactState.evidenceLedger);
    if (ledgerTarget !== undefined) {
      return ledgerTarget;
    }

    const latestEvidence = this.asRecord(reactState.latestEvidenceDelta);
    if (this.evidenceRequiresRepair(latestEvidence)) {
      return this.readPathFromEvidence(latestEvidence) ??
        this.readFilesystemActionPath(this.asRecord(reactState.nextAction)) ??
        this.readFilesystemActionPath(this.asRecord(reactState.lastActionResult));
    }

    const lastActionResult = this.asRecord(reactState.lastActionResult);
    if (this.actionResultRequiresConcreteRepair(lastActionResult)) {
      return this.readFilesystemActionPath(lastActionResult) ??
        this.readFilesystemActionPath(this.asRecord(reactState.nextAction));
    }

    return ;
  }

  private readConcreteRepairTargetPathFromEvidenceLedger(value: unknown): string | undefined {
    if (Array.isArray(value) === false) {
      return ;
    }
    for (const entryValue of value.slice(-6).reverse()) {
      const entry = this.asRecord(entryValue);
      if (this.evidenceRequiresRepair(entry) === false) {
        continue;
      }
      const target = this.readPathFromEvidence(entry);
      if (target !== undefined) {
        return target;
      }
    }
    return ;
  }

  private evidenceRequiresRepair(entry: Record<string, unknown> | undefined): boolean {
    if (entry === undefined) {
      return false;
    }
    const nextUse = this.asRecord(entry.nextUse);
    return this.asString(nextUse?.requiresAction) === "repair_or_choose_new_action" ||
      this.asString(entry.requiresAction) === "repair_or_choose_new_action";
  }

  private readPathFromEvidence(entry: Record<string, unknown> | undefined): string | undefined {
    if (entry === undefined) {
      return ;
    }
    const target = this.asRecord(entry.target);
    const targetType = this.asString(target?.type) ?? this.asString(entry.targetType);
    const targetValue = this.asString(target?.value) ?? this.asString(entry.targetValue);
    if (targetValue === undefined || targetValue.trim().length === 0) {
      return ;
    }
    return targetType === undefined || targetType === "path" || targetType === "file" || targetType === ""
      ? this.normalizeFilesystemClarificationPath(targetValue)
      : undefined;
  }

  private actionResultRequiresConcreteRepair(value: Record<string, unknown> | undefined): boolean {
    if (value === undefined) {
      return false;
    }
    const output = this.asRecord(value.output);
    if (this.outputIndicatesNoChange(output)) {
      return true;
    }
    const items = Array.isArray(value.items) ? value.items : [];
    if (items.length > 0) {
      return items.some((item) =>
        this.actionResultRequiresConcreteRepair(this.asRecord(item))
      );
    }
    return false;
  }

  private outputIndicatesNoChange(output: Record<string, unknown> | undefined): boolean {
    if (output === undefined) {
      return false;
    }
    if (output.changed === false || output.replacements === 0) {
      return true;
    }
    const status = this.asString(output.status);
    const message = this.asString(output.message) ?? "";
    return status === "NO_CHANGE" || /No occurrences matched|file was not changed/u.test(message);
  }

  private mapError(error: unknown): RuntimeError {
    if (error instanceof GuardrailViolationError) {
      return {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      };
    }
    return asRuntimeError(error);
  }

  private resolveCurrentStep(
    event: RuntimeEvent,
    sessionState: Record<string, unknown>,
    currentStepAgent: string | undefined,
  ): string | undefined {
    if (event.stepAgent !== undefined) {
      return event.stepAgent;
    }

    if (currentStepAgent !== undefined) {
      return currentStepAgent;
    }

    const regionItems = Array.isArray(sessionState.regionWorkItems) ? sessionState.regionWorkItems : [];
    const next = regionItems.find((item) => typeof item === "object" && item !== null) as
      | { stepAgent?: unknown }
      | undefined;
    return typeof next?.stepAgent === "string" ? next.stepAgent : undefined;
  }

  private resolveMemorySnapshot(sessionState: Record<string, unknown>): MemorySnapshot {
    const memory = this.asRecord(sessionState.memory);
    const working = this.asRecord(memory?.working) ?? {};
    return {
      working,
      episodicRef:
        typeof memory?.episodicRef === "string" && memory.episodicRef.trim().length > 0
          ? memory.episodicRef
          : `episodic:${Date.now()}`,
      semanticRef:
        typeof memory?.semanticRef === "string" && memory.semanticRef.trim().length > 0
          ? memory.semanticRef
          : "semantic:default",
    };
  }

  private resolveTransitionMemory(
    sessionState: Record<string, unknown>,
    statePatch: Record<string, unknown> | undefined,
    fallback: MemorySnapshot,
  ): MemorySnapshot {
    const patchMemory = this.asRecord(statePatch?.memory);
    if (patchMemory !== undefined) {
      const working = this.asRecord(patchMemory.working) ?? fallback.working;
      return {
        working,
        episodicRef:
          typeof patchMemory.episodicRef === "string" ? patchMemory.episodicRef : fallback.episodicRef,
        semanticRef:
          typeof patchMemory.semanticRef === "string" ? patchMemory.semanticRef : fallback.semanticRef,
      };
    }

    return this.resolveMemorySnapshot(sessionState);
  }

  private mergeStatePatchWithRegionLaneCursor(
    sessionState: Record<string, unknown>,
    statePatch: Record<string, unknown> | undefined,
    laneCursor: string | undefined,
  ): Record<string, unknown> | undefined {
    if (laneCursor === undefined) {
      return statePatch;
    }

    const basePatch = statePatch ?? {};
    const sessionRegion = this.asRecord(sessionState.region) ?? {};
    const patchRegion = this.asRecord(basePatch.region) ?? {};

    return {
      ...basePatch,
      region: {
        ...sessionRegion,
        ...patchRegion,
        laneCursor,
      },
    };
  }

  private resolveStateNode(sessionState: Record<string, unknown>): StepContext["stateNode"] {
    const stateNode = this.asRecord(sessionState.stateNode);
    if (stateNode === undefined) {
      return ;
    }

    const parent = typeof stateNode.parent === "string" ? stateNode.parent : undefined;
    const child = typeof stateNode.child === "string" ? stateNode.child : undefined;
    const region = typeof stateNode.region === "string" ? stateNode.region : undefined;
    if (parent === undefined || child === undefined) {
      return ;
    }

    return {
      parent,
      child,
      ...(region !== undefined ? { region } : {}),
    };
  }

  private readFilesystemActionPath(value: Record<string, unknown> | undefined): string | undefined {
    if (value === undefined) {
      return ;
    }
    const input = this.asRecord(value.input);
    return this.asString(input?.path) ?? this.asString(value.path);
  }

  private normalizeFilesystemClarificationPath(path: string | undefined): string | undefined {
    if (path === undefined) {
      return ;
    }
    const trimmed = path.trim();
    if (trimmed.length === 0) {
      return ;
    }
    if (trimmed === "./") {
      return ".";
    }
    return trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return ;
    }

    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new RunCancelledError();
    }
  }

  private summarizePromptInput(request: ModelRequest): Record<string, unknown> {
    return {
      inputPreview: summarizeUnknown(request.input, 800),
      modelInputSnapshot: buildModelInputSnapshot(request),
      messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
      toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
      responseFormat: request.responseFormat ?? "text",
    };
  }

  private shouldPersistFullModelPrompt(): boolean {
    const raw = process.env[MODEL_PROMPT_DUMP_ENV];
    if (typeof raw !== "string") {
      return false;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  }

  private resolveModelPromptDumpRoot(): string {
    const explicit = process.env[MODEL_PROMPT_DUMP_DIR_ENV];
    if (typeof explicit === "string" && explicit.trim().length > 0) {
      return path.resolve(explicit.trim());
    }
    return path.join(resolveKestrelHomePath(), "model-prompts");
  }

  private async persistModelPromptDump(input: {
    callId: string;
    progress: { runId: string; sessionId: string; stepIndex: number; stepAgent: string; phase: string };
    request: ModelRequest;
    providerRequest: ModelRequest;
    requestedModel: string | undefined;
    requestedProvider: string | undefined;
    modelRole: string | undefined;
    turnId: string | undefined;
    threadId: string | undefined;
    assemblyId: string | undefined;
    providerPayloadHash: string;
    componentHash: string;
    toolManifestHash: string | undefined;
    createdAt: string;
  }): Promise<{ jsonPath: string } | undefined> {
    if (this.shouldPersistFullModelPrompt() === false) {
      return ;
    }
    const fileStem = `step-${String(input.progress.stepIndex).padStart(5, "0")}-call-${input.callId}`;
    const directory = path.join(
      this.resolveModelPromptDumpRoot(),
      input.progress.sessionId,
      input.progress.runId,
    );
    const jsonPath = path.join(directory, `${fileStem}.json`);
    const payload = {
      version: 1,
      callId: input.callId,
      createdAt: input.createdAt,
      sessionId: input.progress.sessionId,
      runId: input.progress.runId,
      stepIndex: input.progress.stepIndex,
      stepAgent: input.progress.stepAgent,
      phase: input.progress.phase,
      requestedModel: input.requestedModel,
      requestedProvider: input.requestedProvider,
      modelRole: input.modelRole,
      turnId: input.turnId,
      threadId: input.threadId,
      assemblyId: input.assemblyId,
      providerPayloadHash: input.providerPayloadHash,
      componentHash: input.componentHash,
      ...(input.toolManifestHash !== undefined ? { toolManifestHash: input.toolManifestHash } : {}),
      request: input.request,
      providerRequest: input.providerRequest,
      promptSummary: this.summarizePromptInput(input.request),
    };
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      return { jsonPath };
    } catch (error) {
      await this.logWarn({
        runId: input.progress.runId,
        sessionId: input.progress.sessionId,
        stepIndex: input.progress.stepIndex,
        eventName: "model_prompt_dump_failed",
        metadata: {
          callId: input.callId,
          path: jsonPath,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return ;
    }
  }

  private async persistModelResponseDump(input: {
    promptDump: { jsonPath: string } | undefined;
    callId: string;
    progress: { runId: string; sessionId: string; stepIndex: number };
    status: "COMPLETED" | "FAILED";
    completedAt: string;
    latencyMs: number;
    response?: unknown;
    error?: RuntimeError | undefined;
  }): Promise<void> {
    if (input.promptDump === undefined) {
      return;
    }
    const payload = {
      status: input.status,
      completedAt: input.completedAt,
      latencyMs: input.latencyMs,
      ...(input.response !== undefined ? { response: input.response } : {}),
      ...(input.error !== undefined
        ? {
            responseError: {
              code: input.error.code,
              message: input.error.message,
              ...(input.error.details !== undefined ? { details: input.error.details } : {}),
            },
          }
        : {}),
    };
    try {
      const current = JSON.parse(await readFile(input.promptDump.jsonPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        input.promptDump.jsonPath,
        `${JSON.stringify({ ...current, modelResult: payload }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      await this.logWarn({
        runId: input.progress.runId,
        sessionId: input.progress.sessionId,
        stepIndex: input.progress.stepIndex,
        eventName: "model_response_dump_failed",
        metadata: {
          callId: input.callId,
          path: input.promptDump.jsonPath,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private extractModelUsage(value: unknown):
    | {
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
      totalTokens?: number | undefined;
      cachedInputTokens?: number | undefined;
      cacheWriteInputTokens?: number | undefined;
      reasoningTokens?: number | undefined;
      }
    | undefined {
    const record = this.asRecord(value);
    const usage = this.asRecord(record?.usage);
    if (usage === undefined) {
      return ;
    }

    const inputTokens = readMaybeNumber(usage.inputTokens);
    const outputTokens = readMaybeNumber(usage.outputTokens);
    const totalTokens = readMaybeNumber(usage.totalTokens);
    const cachedInputTokens = readMaybeNumber(usage.cachedInputTokens);
    const cacheWriteInputTokens = readMaybeNumber(usage.cacheWriteInputTokens);
    const reasoningTokens = readMaybeNumber(usage.reasoningTokens);
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      totalTokens === undefined &&
      cachedInputTokens === undefined &&
      cacheWriteInputTokens === undefined &&
      reasoningTokens === undefined
    ) {
      return ;
    }

    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    };
  }

  private extractModelMetadata(value: unknown): Record<string, unknown> | undefined {
    const record = this.asRecord(value);
    const provider = this.asRecord(record?.provider);
    if (provider === undefined) {
      return ;
    }

    const structuredOutput = this.asRecord(provider.structuredOutput);
    return {
      ...(typeof provider.name === "string" ? { provider: provider.name } : {}),
      ...(typeof provider.model === "string" ? { model: provider.model } : {}),
      ...(typeof provider.endpoint === "string" ? { endpoint: provider.endpoint } : {}),
      ...(typeof provider.requestId === "string" ? { requestId: provider.requestId } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    };
  }

  private async applyRuntimeStateGuards(
    runId: string,
    sessionId: string,
    stepIndex: number,
    stepName: string,
    sessionState: Record<string, unknown>,
    statePatch: Record<string, unknown> | undefined,
    transition: Transition,
  ): Promise<Record<string, unknown> | undefined> {
    const rebasedStatePatch = this.rebaseHeapCompactedModelTranscript(sessionState, statePatch);
    return this.loopGuardCoordinator.applyRuntimeStateGuards({
      runId,
      sessionId,
      stepIndex,
      stepName,
      sessionState,
      statePatch: rebasedStatePatch,
      transition,
    });
  }

  private rebaseHeapCompactedModelTranscript(
    sessionState: Record<string, unknown>,
    statePatch: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    const patch = this.asRecord(statePatch);
    const patchAgent = this.asRecord(patch?.agent);
    if (patch === undefined || patchAgent === undefined || patchAgent.modelTranscript === undefined) {
      return statePatch;
    }
    const currentAgent = this.asRecord(sessionState.agent);
    const rebased = rebaseModelTranscriptAfterCompaction({
      compactedTranscript: currentAgent?.modelTranscript,
      outgoingTranscript: patchAgent.modelTranscript,
    });
    if (rebased === undefined || rebased === patchAgent.modelTranscript) {
      return statePatch;
    }
    return {
      ...patch,
      agent: {
        ...patchAgent,
        modelTranscript: rebased,
      },
    };
  }

  private normalizeLegacyExecutionSession(session: {
    sessionId: string;
    version: number;
    state: Record<string, unknown>;
    currentStepAgent?: string | undefined;
    updatedAt: string;
  }) {
    const reactState = this.asRecord(session.state.agent) ?? {};
    const hasLegacyExecutionShape =
      session.currentStepAgent === "react.acter" ||
      typeof reactState.pendingEffectKey === "string" ||
      this.asRecord(reactState.pendingApproval) !== undefined;
    if (hasLegacyExecutionShape === false) {
      return session;
    }
    const normalizedStep =
      session.currentStepAgent === "react.acter"
        ? resolveLegacyExecutionStep(reactState)
        : session.currentStepAgent;
    const exec = this.asRecord(reactState.exec) ?? {};
    return {
      ...session,
      currentStepAgent: normalizedStep,
      state: {
        ...session.state,
        agent: {
          ...reactState,
          exec: {
            ...exec,
            ...(typeof reactState.pendingEffectKey === "string"
              ? { pendingEffectKey: reactState.pendingEffectKey }
              : {}),
            ...(typeof reactState.pendingEffectType === "string"
              ? { pendingEffectType: reactState.pendingEffectType }
              : {}),
            ...(this.asRecord(reactState.pendingApproval) !== undefined
              ? { pendingApproval: this.asRecord(reactState.pendingApproval) }
              : {}),
            ...(this.asRecord(reactState.pendingToolBatch) !== undefined
              ? { pendingBatch: this.asRecord(reactState.pendingToolBatch) }
              : {}),
            ...(this.asRecord(reactState.pendingToolCall) !== undefined
              ? { pendingToolCall: this.asRecord(reactState.pendingToolCall) }
              : {}),
            ...(normalizedStep !== undefined
              ? { substate: resolveExecSubstateForStep(normalizedStep) }
              : {}),
          },
          pendingEffectKey: undefined,
          pendingEffectType: undefined,
          pendingApproval: undefined,
          pendingToolBatch: undefined,
          pendingToolCall: undefined,
        },
      },
    };
  }

  private normalizeReactRuntimePatch(
    stepName: string,
    reactPatch: Record<string, unknown>,
    transition: Transition,
  ): Record<string, unknown> {
    const exec = this.asRecord(reactPatch.exec) ?? {};
    const nextPatch: Record<string, unknown> = {
      ...reactPatch,
      exec: {
        ...exec,
      },
      loopGuardDecisionTrace: undefined,
      pendingEffectKey: undefined,
      pendingEffectType: undefined,
      pendingApproval: undefined,
      pendingToolBatch: undefined,
      pendingToolCall: undefined,
    };
    if (transition.status === "WAITING" && transition.waitFor !== undefined && transition.nextStepAgent !== undefined) {
      const waitingFor = this.waitResumeCoordinator.buildWaitingForFromTransition({
        waitFor: transition.waitFor,
        resumeStepAgent: transition.nextStepAgent,
        blockedAction: this.asRecord(reactPatch.nextAction),
      });
      if (waitingFor !== undefined) {
        nextPatch.waitingFor = waitingFor;
      }
      nextPatch.terminal = {
        status: "WAITING",
        reasonCode: transition.waitFor.eventType,
        finalStepAgent: stepName,
        finalizedAt: new Date().toISOString(),
      };
      return nextPatch;
    }

    const clearedPatch = clearRuntimeWaitState(nextPatch);
    if (transition.status === "COMPLETED" || transition.status === "FAILED") {
      clearedPatch.terminal = {
        status: transition.status,
        reasonCode: resolveTerminalReasonCode(reactPatch, transition.status),
        finalStepAgent: stepName,
        finalizedAt: new Date().toISOString(),
        ...(reactPatch.finalOutput !== undefined ? { outputRef: "agent.finalOutput" } : {}),
      };
      if (transition.status === "COMPLETED") {
        clearedPatch.phase = "DONE";
      }
      return clearedPatch;
    }

    clearedPatch.terminal = undefined;
    return clearedPatch;
  }

  private createStepObservabilityFrame(stepIndex: number): StepRunnerObservabilityFrame {
    return {
      stepIndex,
      runLogs: [],
      runEvents: [],
    };
  }

  private createRunLifecycleObservabilityFrame(
    runId: string,
    sessionId: string,
  ): RunLifecycleObservabilityFrame {
    return {
      runId,
      sessionId,
      runLogs: [],
      runEvents: [],
    };
  }

  private async flushStepObservabilityFrame(frame: StepRunnerObservabilityFrame): Promise<void> {
    if (frame.runLogs.length > 0) {
      await this.deps.store.appendRunLogsBatch(frame.runLogs);
    }
    if (frame.runEvents.length > 0) {
      await this.deps.store.appendRunEventsBatch(frame.runEvents);
    }
  }

  private async flushRunLifecycleObservabilityFrame(
    frame: RunLifecycleObservabilityFrame,
  ): Promise<void> {
    if (frame.runLogs.length > 0) {
      await this.deps.store.appendRunLogsBatch(frame.runLogs);
    }
    if (frame.runEvents.length > 0) {
      await this.deps.store.appendRunEventsBatch(frame.runEvents);
    }
  }

  private shouldBufferStepEntry(stepIndex: number | undefined): boolean {
    if (this.stepFrameBufferEnabled === false) {
      return false;
    }
    if (stepIndex === undefined) {
      return false;
    }
    const frame = this.stepFrameStore.getStore();
    return frame !== undefined && frame.stepIndex === stepIndex;
  }

  private resolveRunLifecycleFrame(
    runId: string,
    sessionId: string,
    stepIndex: number | undefined,
  ): RunLifecycleObservabilityFrame | undefined {
    if (stepIndex !== undefined) {
      return ;
    }
    const frame = this.runLifecycleFrameStore.getStore();
    if (frame === undefined) {
      return ;
    }
    if (frame.runId !== runId || frame.sessionId !== sessionId) {
      return ;
    }
    return frame;
  }

  private async logInfo(entry: Omit<RunLogEntry, "level">): Promise<void> {
    const fullEntry: RunLogEntry = { ...entry, level: "INFO" };
    if (this.shouldBufferStepEntry(entry.stepIndex)) {
      this.stepFrameStore.getStore()?.runLogs.push(fullEntry);
      await this.notifyRunLogListener(fullEntry);
      return;
    }
    const lifecycleFrame = this.resolveRunLifecycleFrame(
      entry.runId,
      entry.sessionId,
      entry.stepIndex,
    );
    if (lifecycleFrame !== undefined) {
      lifecycleFrame.runLogs.push(fullEntry);
      await this.notifyRunLogListener(fullEntry);
      return;
    }
    await this.deps.runLogger.info(entry);
  }

  private async logWarn(entry: Omit<RunLogEntry, "level">): Promise<void> {
    const fullEntry: RunLogEntry = { ...entry, level: "WARN" };
    if (this.shouldBufferStepEntry(entry.stepIndex)) {
      this.stepFrameStore.getStore()?.runLogs.push(fullEntry);
      await this.notifyRunLogListener(fullEntry);
      return;
    }
    const lifecycleFrame = this.resolveRunLifecycleFrame(
      entry.runId,
      entry.sessionId,
      entry.stepIndex,
    );
    if (lifecycleFrame !== undefined) {
      lifecycleFrame.runLogs.push(fullEntry);
      await this.notifyRunLogListener(fullEntry);
      return;
    }
    await this.deps.runLogger.warn(entry);
  }

  private async logError(entry: Omit<RunLogEntry, "level">): Promise<void> {
    const fullEntry: RunLogEntry = { ...entry, level: "ERROR" };
    if (this.shouldBufferStepEntry(entry.stepIndex)) {
      this.stepFrameStore.getStore()?.runLogs.push(fullEntry);
      await this.notifyRunLogListener(fullEntry);
      return;
    }
    const lifecycleFrame = this.resolveRunLifecycleFrame(
      entry.runId,
      entry.sessionId,
      entry.stepIndex,
    );
    if (lifecycleFrame !== undefined) {
      lifecycleFrame.runLogs.push(fullEntry);
      await this.notifyRunLogListener(fullEntry);
      return;
    }
    await this.deps.runLogger.error(entry);
  }

  private async notifyRunLogListener(entry: RunLogEntry): Promise<void> {
    if (typeof this.deps.runLogger.notify === "function") {
      await this.deps.runLogger.notify(entry);
    }
  }

  private async appendDecisionTraceEvents(
    runId: string,
    sessionId: string,
    stepIndex: number,
    statePatch: Record<string, unknown> | undefined,
  ): Promise<void> {
    const react = this.asRecord(statePatch?.agent);
    const traces = Array.isArray(react?.decisionTrace) ? react.decisionTrace : [];

    for (const item of traces) {
      const trace = this.asRecord(item);
      const eventType = trace?.eventType;
      if (
        eventType !== "decision.generated" &&
        eventType !== "decision.compiled" &&
        eventType !== "decision.rejected" &&
        eventType !== "decision.redirected" &&
        eventType !== "decision.executed" &&
        eventType !== "route.decision" &&
        eventType !== "route.override" &&
        eventType !== "resolver.generated" &&
        eventType !== "resolver.rejected" &&
        eventType !== "resolver.bypassed" &&
        eventType !== "clarification.triggered" &&
        eventType !== "progress.blocked" &&
        eventType !== "tool.result_summarized" &&
        eventType !== "tool.chunk.started" &&
        eventType !== "tool.chunk.completed"
      ) {
        continue;
      }

      const metadata: Record<string, unknown> = {
        decisionPhase:
          typeof trace?.phase === "string" ? trace.phase : "unknown",
        decisionCode:
          typeof trace?.decisionCode === "string" ? trace.decisionCode : "unknown",
      };
      if (typeof trace?.decisionErrorCode === "string") {
        metadata.decisionErrorCode = trace.decisionErrorCode;
      }
      const extraMetadata = this.asRecord(trace?.metadata);
      if (extraMetadata !== undefined) {
        Object.assign(metadata, extraMetadata);
      }

      const logName = eventType.replace(".", "_");
      if (eventType === "decision.rejected" || eventType === "resolver.rejected") {
        await this.logWarn({
          runId,
          sessionId,
          stepIndex,
          eventName: logName,
          metadata,
        });
      } else {
        await this.logInfo({
          runId,
          sessionId,
          stepIndex,
          eventName: logName,
          metadata,
        });
      }

      await this.appendRunEvent(
        runId,
        sessionId,
        eventType,
        eventType === "decision.rejected" || eventType === "resolver.rejected"
          ? "WARN"
          : "INFO",
        metadata,
        stepIndex,
      );
    }
  }

  private stripDecisionTraceFromStatePatch(
    statePatch: Record<string, unknown> | undefined,
  ): {
    statePatch: Record<string, unknown> | undefined;
    strippedDecisionTrace: unknown[];
  } {
    const patch = this.asRecord(statePatch);
    const react = this.asRecord(patch?.agent);
    const traces = Array.isArray(react?.decisionTrace) ? react.decisionTrace : [];
    if (patch === undefined || react === undefined || traces.length === 0) {
      return {
        statePatch,
        strippedDecisionTrace: [],
      };
    }

    const nextReact: Record<string, unknown> = { ...react };
    delete nextReact.decisionTrace;
    nextReact.loopGuardDecisionTrace = traces;
    return {
      statePatch: {
        ...patch,
        agent: nextReact,
      },
      strippedDecisionTrace: traces,
    };
  }

  private async appendRunEvent(
    runId: string,
    sessionId: string,
    type: RunEventType,
    level: "INFO" | "WARN" | "ERROR",
    metadata?: Record<string, unknown>,
    stepIndex?: number,
    options?: RunEventAppendOptions,
  ): Promise<void> {
    const event: RunEvent = {
      runId,
      sessionId,
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      type,
      level,
      timestamp: new Date().toISOString(),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    await this.notifyRunEventListener(event);
    if (options?.bypassBuffer !== true && this.shouldBufferStepEntry(stepIndex)) {
      this.stepFrameStore.getStore()?.runEvents.push(event);
      return;
    }
    const lifecycleFrame =
      options?.bypassBuffer === true
        ? undefined
        : this.resolveRunLifecycleFrame(runId, sessionId, stepIndex);
    if (lifecycleFrame !== undefined) {
      lifecycleFrame.runEvents.push(event);
      return;
    }
    await this.deps.store.appendRunEventsBatch([event]);
  }

  private async notifyRunEventListener(event: RunEvent): Promise<void> {
    if (this.deps.runEventListener === undefined) {
      return;
    }
    try {
      await this.deps.runEventListener(event);
    } catch {
      // Listener errors should not fail runtime execution.
    }
  }

  private async appendRuntimeEventIntents(input: {
    runId: string;
    sessionId: string;
    emitEvents: Transition["emitEvents"];
    stepIndex: number;
  }): Promise<void> {
    for (const event of input.emitEvents ?? []) {
      const eventType = this.readRunEventType(event.type);
      if (eventType === undefined) {
        continue;
      }
      await this.appendRunEvent(
        input.runId,
        input.sessionId,
        eventType,
        eventType === "planner.finalize_blocked" ? "WARN" : "INFO",
        event.payload,
        input.stepIndex,
      );
    }
  }

  private resolveFilesystemResumeReadBudget(input: {
    session: SessionRecord | null;
    status: TransitionStatus;
    stopReason?: string | undefined;
  }): FilesystemResumeReadBudgetDetail {
    const reactState = this.asRecord(input.session?.state.agent);
    const postToolVerification = this.asRecord(reactState?.postToolVerification);
    const evidenceRecoverySummary = this.asRecord(postToolVerification?.evidenceRecoverySummary);
    const filesystemInspection = this.asRecord(evidenceRecoverySummary?.filesystemInspection);
    const inventoryActions = readMaybeNumber(filesystemInspection?.inventoryActions);
    const groundedReadActions = readMaybeNumber(filesystemInspection?.groundedReadActions);
    const isBudgetExhausted = isBroadResumeBudgetExhausted({
      inventoryActions: inventoryActions ?? 0,
      groundedReadActions: groundedReadActions ?? 0,
    });
    return buildFilesystemResumeReadBudgetDetail({
      inventoryActions,
      groundedReadActions,
      stoppedByBudget:
      input.status === "WAITING" &&
        (isBudgetExhausted || input.stopReason === LEGACY_FILESYSTEM_RESUME_STOP_REASON),
      stopReason: input.stopReason,
    });
  }

  private readRunEventType(value: unknown): RunEventType | undefined {
    if (typeof value !== "string") {
      return ;
    }
    if (KNOWN_RUN_EVENT_TYPES.has(value as RunEventType) === false) {
      return ;
    }
    return value as RunEventType;
  }

  private mergeOrchestrationEventMetadata(
    event?: RuntimeEvent | undefined,
    waitFor?: Transition["waitFor"],
  ): Record<string, unknown> {
    const orchestration = this.asRecord(event?.payload?.orchestration);
    const waitMetadata = this.asRecord(waitFor?.metadata);
    const metadata: Record<string, unknown> = {};
    for (const key of ["threadId", "delegationId", "requestId", "grantId"]) {
      const candidate =
        typeof orchestration?.[key] === "string"
          ? orchestration[key]
          : typeof waitMetadata?.[key] === "string"
            ? waitMetadata[key]
            : undefined;
      if (typeof candidate === "string" && candidate.length > 0) {
        metadata[key] = candidate;
      }
    }
    return metadata;
  }
}
