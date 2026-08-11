import { createHash } from "node:crypto";

import {
  parseRunnerExternalApprovalBindingV1,
  serializeCanonicalApprovalPayload,
} from "@kestrel-agents/protocol";

import type {
  Guardrails,
} from "./Guardrails.js";
import type { RegionScheduler } from "./RegionScheduler.js";
import type { RunLifecycleController } from "./RunLifecycleController.js";
import type { StepCommitPipeline } from "./StepCommitPipeline.js";
import { validateTransition } from "./TransitionValidator.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import {
  asPlainRecord,
  buildStateTransitionLogMetadata,
  parseApprovalDecisionFromPayload,
} from "./ExecutionEngineSupport.js";
import { buildRunToolEvent, buildRunToolUpdate } from "./RuntimeIO.js";
import type { RunEventType, RuntimeError } from "../kestrel/contracts/base.js";
import type { ProgressCode, ProgressPhase, RunEvent, RunLogEntry, RuntimeEvent, RuntimeEventIntent } from "../kestrel/contracts/events.js";
import type { NormalizedOutput, RegionWorkItem, RuntimeDependencies, StepCommit, StepContext, StepIO, StepTransition } from "../kestrel/contracts/execution.js";
import type { EffectStore, PersistedEffect, SessionRecord } from "../kestrel/contracts/store.js";
import type { HeapPressureSample } from "../runtime/heapDiagnostics.js";
import { RecoveryToolTransitionRequired } from "./recovery/RecoveryCoordinator.js";


export interface StepRunnerObservabilityFrame {
  stepIndex: number;
  runLogs: RunLogEntry[];
  runEvents: RunEvent[];
}

export interface StepRunnerState {
  event: RuntimeEvent;
  session: SessionRecord;
  currentStep: string | undefined;
  lastStepAgent: string | undefined;
  laneCursor: string | undefined;
  stepIndex: number;
  progressSeq: number;
  continuation?: NormalizedOutput["continuation"] | undefined;
}

type StepSelection = Awaited<ReturnType<RegionScheduler["beforeStep"]>>;

type StepExecutionResult =
  | { transition: StepTransition }
  | { checkpoint: NormalizedOutput };

function countModelAuthoredToolEffects(
  guardrails: Guardrails,
  effects: PersistedEffect[],
): void {
  for (const effect of effects) {
    if (effect.type !== "execute_tool_call" && effect.type !== "tool.execute") {
      continue;
    }
    const payload = effect.payload;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
    guardrails.onEffectToolCall(toolName);
  }
}

interface StepRunnerDependencies {
  registry: RuntimeDependencies["registry"];
  store: Pick<EffectStore, "listReadyRegionWorkItems">;
  effectRunner: RuntimeDependencies["effectRunner"];
  outbox: RuntimeDependencies["outbox"];
  regionScheduler: RegionScheduler;
  stepCommitPipeline: StepCommitPipeline;
  runLifecycleController: RunLifecycleController;
  buildRegionMergeWait: (input: {
    session: SessionRecord;
    step: string;
    waitFor: { kind: "region_merge"; eventType: "system.meta_reasoning" };
  }) => {
    transition: StepTransition;
    state: Record<string, unknown>;
  };
  throwIfAborted: (signal: AbortSignal | undefined) => void;
  resolveProgressPhase: (stepAgent: string | undefined) => ProgressPhase;
  prepareAutoManagedWorktreeForSelectedDevTool: (input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    stepName: string;
    stepIndex: number;
  }) => Promise<{ event: RuntimeEvent; session: SessionRecord }>;
  createStepContext: (
    runId: string,
    session: StepContext["session"],
    event: RuntimeEvent,
    stepIndex: number,
    memory: StepContext["memory"],
    budget: StepContext["budget"],
    stateNode: StepContext["stateNode"],
    region: StepContext["region"],
  ) => StepContext;
  createStepIO: (
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
  ) => StepIO;
  resolveMemorySnapshot: (sessionState: Record<string, unknown>) => StepContext["memory"];
  resolveStateNode: (sessionState: Record<string, unknown>) => StepContext["stateNode"];
  appendRunEvent: (
    runId: string,
    sessionId: string,
    type: RunEventType,
    level: "INFO" | "WARN" | "ERROR",
    metadata?: Record<string, unknown> | undefined,
    stepIndex?: number | undefined,
    options?: { bypassBuffer?: boolean | undefined } | undefined,
  ) => Promise<void>;
  logInfo: (entry: Omit<RunLogEntry, "level">) => Promise<void>;
  logWarn: (entry: Omit<RunLogEntry, "level">) => Promise<void>;
  emitProgress: (input: {
    runId: string;
    sessionId: string;
    seq: number;
    kind: "stage" | "tool" | "waiting" | "heartbeat";
    phase: ProgressPhase;
    code: ProgressCode;
    message: string;
    stepIndex?: number | undefined;
    stepAgent?: string | undefined;
    waitFor?: {
      eventType: string;
      timeoutMs?: number | undefined;
    } | undefined;
    progress?: {
      completedSteps: number;
      maxSteps: number;
    } | undefined;
    persist: boolean;
    bypassRunEventBuffer?: boolean | undefined;
  }) => Promise<number>;
  appendRuntimeEventIntents: (input: {
    runId: string;
    sessionId: string;
    emitEvents: RuntimeEventIntent[] | undefined;
    stepIndex: number;
  }) => Promise<void>;
  maybeAppendManagedWorktreeApprovalRequested: (
    runId: string,
    sessionId: string,
    transition: StepTransition,
    stepIndex: number,
  ) => Promise<void>;
  createStepObservabilityFrame: (stepIndex: number) => StepRunnerObservabilityFrame;
  runStepWithFrame: <T>(
    frame: StepRunnerObservabilityFrame,
    execute: () => Promise<T>,
  ) => Promise<T>;
  flushStepObservabilityFrame: (frame: StepRunnerObservabilityFrame) => Promise<void>;
  appendDecisionTraceEvents: (
    runId: string,
    sessionId: string,
    stepIndex: number,
    statePatch: Record<string, unknown> | undefined,
  ) => Promise<void>;
  stripDecisionTraceFromStatePatch: (
    statePatch: Record<string, unknown> | undefined,
  ) => {
    statePatch: Record<string, unknown> | undefined;
    strippedDecisionTrace: unknown[];
  };
  mapError: (error: unknown) => RuntimeError;
  buildRunningTransition: (sessionState: Record<string, unknown>) => StepTransition;
  maybeBuildConcreteRepairContinuation: (input: {
    event: RuntimeEvent;
    runId: string;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    previousState: Record<string, unknown>;
    transition: StepTransition;
    runtimeError: RuntimeError;
  }) => Promise<
    | {
        transition: StepTransition;
        statePatch: Record<string, unknown>;
        targetPath: string;
      }
    | undefined
  >;
  recordConcreteRepairContinuation: (input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    targetPath: string;
    runtimeError: RuntimeError;
  }) => Promise<void>;
  maybeBuildVerifiedRetrievalContinuation: (input: {
    event: RuntimeEvent;
    runId: string;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    previousState: Record<string, unknown>;
    transition: StepTransition;
    runtimeError: RuntimeError;
  }) => Promise<
    | {
        transition: StepTransition;
        statePatch: Record<string, unknown>;
        objectiveKey: string;
        guardToolName?: string | undefined;
      }
    | undefined
  >;
  recordVerifiedRetrievalContinuation: (input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    objective: string;
    guardToolName?: string | undefined;
  }) => Promise<void>;
  applyRuntimeStateGuards: (
    runId: string,
    sessionId: string,
    stepIndex: number,
    stepName: string,
    sessionState: Record<string, unknown>,
    statePatch: Record<string, unknown> | undefined,
    transition: StepTransition,
  ) => Promise<Record<string, unknown> | undefined>;
  mergeStatePatchWithRegionLaneCursor: (
    sessionState: Record<string, unknown>,
    statePatch: Record<string, unknown> | undefined,
    laneCursor: string | undefined,
  ) => Record<string, unknown> | undefined;
  resolveEffects: (
    effects: NonNullable<StepTransition["effects"]>,
    runId: string,
    stepIndex: number,
    runtimePayload: Record<string, unknown> | undefined,
    session: SessionRecord,
    runtimeBudgetRemainingMs: number,
  ) => Promise<StepCommit["resolvedEffects"]>;
  resolveTransitionMemory: (
    sessionState: Record<string, unknown>,
    statePatch: Record<string, unknown> | undefined,
    fallback: StepContext["memory"],
  ) => StepContext["memory"];
  handleRegionMergeConflict: (input: {
    runId: string;
    sessionId: string;
    currentStep: string;
    stepIndex: number;
    session: SessionRecord;
    activeRegionItem: RegionWorkItem | undefined;
    conflict: string;
    errors: RuntimeError[];
    guardrails: Guardrails;
    progressSeq: number;
    continuation?: NormalizedOutput["continuation"] | undefined;
  }) => Promise<NormalizedOutput | undefined>;
  validateStepContract: (input: {
    runId: string;
    sessionId: string;
    stepName: string;
    transition: StepTransition;
    context: StepContext;
    stepIndex: number;
  }) => Promise<void>;
  sampleHeap: (input: {
    component: string;
    phase?: "before" | "after" | "point" | undefined;
    runId?: string | undefined;
    sessionId?: string | undefined;
    stepIndex?: number | undefined;
    stepAgent?: string | undefined;
    reason?: string | undefined;
  }) => Promise<HeapPressureSample | undefined>;
  runtimeEvaluationEnabled: boolean;
  evaluateRuntimeTransition: (input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    stepName: string;
    stepIndex: number;
    transition: StepTransition;
    statePatch: Record<string, unknown> | undefined;
    guardrails: Guardrails;
    signal?: AbortSignal | undefined;
  }) => Promise<{
    transition: StepTransition;
    statePatch: Record<string, unknown> | undefined;
    disposition?: "continue" | "revise" | "review" | "quarantine" | undefined;
  }>;
}

export class StepRunner {
  private readonly deps: StepRunnerDependencies;

  constructor(deps: StepRunnerDependencies) {
    this.deps = deps;
  }

  async runIteration(input: {
    runId: string;
    runStartedAt: number;
    state: StepRunnerState;
    guardrails: Guardrails;
    errors: RuntimeError[];
    signal?: AbortSignal | undefined;
  }): Promise<NormalizedOutput | undefined> {
    this.deps.throwIfAborted(input.signal);

    const selection = await this.selectStep({
      event: input.state.event,
      session: input.state.session,
      currentStep: input.state.currentStep,
      stepIndex: input.state.stepIndex,
      laneCursor: input.state.laneCursor,
    });
    if (selection.kind === "wait_for_merge") {
      await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "region.scheduler.waiting", "INFO", {
        step: selection.step,
        waitFor: selection.waitFor,
      });
      const mergeWait = this.deps.buildRegionMergeWait({
        session: input.state.session,
        step: selection.step,
        waitFor: selection.waitFor,
      });
      const waitingOutput = await this.deps.runLifecycleController.returnTerminal({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        currentStep: selection.step,
        transition: mergeWait.transition,
        errors: input.errors,
        guardrails: input.guardrails,
        progressSeq: input.state.progressSeq,
        continuation: input.state.continuation,
      });
      if (waitingOutput !== undefined) {
        input.state.currentStep = selection.step;
        input.state.lastStepAgent = selection.step;
        return waitingOutput;
      }
      throw createRuntimeFailure(
        "RUN_REGION_WAIT_INVALID",
        "Expected waiting output for region merge scheduler wait.",
        {
          subsystem: "runtime",
          classification: "determinism",
          stepAgent: selection.step,
          waitFor: selection.waitFor,
        },
      );
    }

    const stepName = selection.step;
    const activeRegionItem = selection.kind === "claim_region_work" ? selection.regionItem : undefined;
    const progressPhase = this.deps.resolveProgressPhase(stepName);
    input.state.currentStep = stepName;
    input.state.lastStepAgent = stepName;

    if (activeRegionItem !== undefined) {
      await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "region.scheduler.claimed", "INFO", {
        region: activeRegionItem.region,
        itemId: activeRegionItem.id,
        step: stepName,
      }, input.state.stepIndex);
    }
    await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "step.selected", "INFO", {
      step: stepName,
      ...(activeRegionItem !== undefined
        ? { region: activeRegionItem.region, regionItemId: activeRegionItem.id }
        : {}),
    }, input.state.stepIndex);
    input.state.progressSeq = await this.deps.emitProgress({
      runId: input.runId,
      sessionId: input.state.session.sessionId,
      seq: input.state.progressSeq,
      kind: "stage",
      phase: progressPhase,
      code: "STEP_SELECTED",
      message: `Selected step '${stepName}'.`,
      stepIndex: input.state.stepIndex,
      stepAgent: stepName,
      progress: {
        completedSteps: input.guardrails.telemetry().stepsExecuted,
        maxSteps: input.guardrails.configSnapshot().maxStepsPerRun,
      },
      persist: true,
    });

    const pendingRegionItems = await this.deps.store.listReadyRegionWorkItems(input.state.session.sessionId);
    const pendingRegions = [
      ...new Set(
        [
          ...pendingRegionItems.map((item) => item.region),
          ...(activeRegionItem !== undefined ? [activeRegionItem.region] : []),
        ]
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    ];

    input.guardrails.onStep(stepName);

    const autoManagedWorktreeContext = await this.deps.prepareAutoManagedWorktreeForSelectedDevTool({
      runId: input.runId,
      event: input.state.event,
      session: input.state.session,
      stepName,
      stepIndex: input.state.stepIndex,
    });
    input.state.event = autoManagedWorktreeContext.event;
    input.state.session = autoManagedWorktreeContext.session;

    const step = this.deps.registry.resolve(stepName);
    const memorySnapshot = this.deps.resolveMemorySnapshot(input.state.session.state);
    const stepContext = this.deps.createStepContext(
      input.runId,
      input.state.session,
      input.state.event,
      input.state.stepIndex,
      memorySnapshot,
      input.guardrails.budgetSnapshot(),
      this.deps.resolveStateNode(input.state.session.state),
      {
        ...(activeRegionItem !== undefined ? { currentRegion: activeRegionItem.region } : {}),
        ...(input.state.laneCursor !== undefined ? { laneCursor: input.state.laneCursor } : {}),
        pendingRegions,
      },
    );
    const stepFrame = this.deps.createStepObservabilityFrame(input.state.stepIndex);
    let stepExecutionResult: StepExecutionResult;
    let requiresPostCatchValidation = false;
    const executeStep = async (): Promise<StepExecutionResult> => {
      if (activeRegionItem !== undefined) {
        await this.deps.logInfo({
          runId: input.runId,
          sessionId: input.state.session.sessionId,
          stepIndex: input.state.stepIndex,
          eventName: "region_started",
          metadata: {
            region: activeRegionItem.region,
            itemId: activeRegionItem.id,
            cursor: input.state.laneCursor,
          },
        });
        await this.deps.appendRunEvent(
          input.runId,
          input.state.session.sessionId,
          "region.started",
          "INFO",
          {
            region: activeRegionItem.region,
            itemId: activeRegionItem.id,
            cursor: input.state.laneCursor,
          },
          input.state.stepIndex,
        );
      }

      await this.deps.logInfo({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        stepIndex: input.state.stepIndex,
        eventName: "step_started",
        metadata: {
          step: stepName,
          version: input.state.session.version,
          ...(activeRegionItem !== undefined ? { region: activeRegionItem.region } : {}),
        },
      });
      await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "step.started", "INFO", {
        step: stepName,
        version: input.state.session.version,
        stepIndex: input.state.stepIndex,
        ...(activeRegionItem !== undefined ? { region: activeRegionItem.region } : {}),
      }, input.state.stepIndex, { bypassBuffer: true });
      input.state.progressSeq = await this.deps.emitProgress({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        seq: input.state.progressSeq,
        kind: "stage",
        phase: progressPhase,
        code: "STEP_STARTED",
        message: `Started step '${stepName}'.`,
        stepIndex: input.state.stepIndex,
        stepAgent: stepName,
        progress: {
          completedSteps: input.guardrails.telemetry().stepsExecuted,
          maxSteps: input.guardrails.configSnapshot().maxStepsPerRun,
        },
        persist: true,
        bypassRunEventBuffer: true,
      });

      const recoveryApprovalTransition = await this.buildRecoveryToolApprovalTransition({
        runId: input.runId,
        session: input.state.session,
        event: input.state.event,
        stepName,
        stepIndex: input.state.stepIndex,
      });
      const transition = recoveryApprovalTransition ?? await step(
        stepContext,
        this.deps.createStepIO(
          input.guardrails,
          {
            runId: input.runId,
            sessionId: input.state.session.sessionId,
            stepIndex: input.state.stepIndex,
            stepAgent: stepName,
            phase: progressPhase,
            signal: input.signal,
            sequence: () => {
              input.state.progressSeq += 1;
              return input.state.progressSeq;
            },
          },
          input.state.session,
          {
            ...(asPlainRecord(input.state.event.payload.orchestration) ?? {}),
            ...(asPlainRecord(input.state.event.payload.metadata) ?? {}),
            ...(asPlainRecord(input.state.event.payload.workspace) !== undefined
              ? { workspace: asPlainRecord(input.state.event.payload.workspace) }
              : {}),
          },
          input.state.event.payload,
          (session) => {
            input.state.session = session;
          },
        ),
      );

      validateTransition(transition);
      await this.deps.validateStepContract({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        stepName,
        transition,
        context: stepContext,
        stepIndex: input.state.stepIndex,
      });

      const syncConflict = this.deps.regionScheduler.detectSyncConflict(activeRegionItem, transition);
      if (syncConflict !== undefined) {
        const checkpoint = await this.deps.handleRegionMergeConflict({
          runId: input.runId,
          sessionId: input.state.session.sessionId,
          currentStep: stepName,
          stepIndex: input.state.stepIndex,
          session: input.state.session,
          activeRegionItem,
          conflict: syncConflict,
          errors: input.errors,
          guardrails: input.guardrails,
          progressSeq: input.state.progressSeq,
          continuation: input.state.continuation,
        });
        if (checkpoint !== undefined) {
          return { checkpoint };
        }
      }

      const traceStatePatch = this.deps.stripDecisionTraceFromStatePatch(transition.statePatch);
      if (traceStatePatch.strippedDecisionTrace.length > 0) {
        await this.deps.appendDecisionTraceEvents(
          input.runId,
          input.state.session.sessionId,
          input.state.stepIndex,
          transition.statePatch,
        );
      }

      return {
        transition:
          traceStatePatch.statePatch === transition.statePatch
            ? transition
            : {
                ...transition,
                statePatch: traceStatePatch.statePatch,
              },
      };
    };

    try {
      stepExecutionResult = await this.deps.runStepWithFrame(stepFrame, executeStep);
    } catch (error) {
      await this.deps.flushStepObservabilityFrame(stepFrame);
      if (error instanceof RecoveryToolTransitionRequired) {
        requiresPostCatchValidation = true;
        const targetInput = asPlainRecord(error.targetInput);
        if (targetInput === undefined) {
          await this.deps.appendRunEvent(
            input.runId,
            input.state.session.sessionId,
            "recovery.action.failed",
            "ERROR",
            {
              decisionId: error.decision.decisionId,
              failureCode: "RECOVERY_TARGET_INPUT_INVALID",
            },
            input.state.stepIndex,
            { bypassBuffer: true },
          );
          throw createRuntimeFailure(
            "RECOVERY_TARGET_INPUT_INVALID",
            "Recovery tool adapter target input must be an object.",
          );
        }
        await this.deps.appendRunEvent(
          input.runId,
          input.state.session.sessionId,
          "recovery.action.started",
          "INFO",
          {
            decisionId: error.decision.decisionId,
            adapterId: error.adapter.adapterId,
            targetToolId: error.adapter.targetToolId,
          },
          input.state.stepIndex,
          { bypassBuffer: true },
        );
        const agent = asPlainRecord(input.state.session.state.agent) ?? {};
        const exec = asPlainRecord(agent.exec) ?? {};
        const recoveryState = {
          decision: structuredClone(error.decision),
          adapterId: error.adapter.adapterId,
          sourceToolId: error.adapter.sourceToolId,
          targetToolId: error.adapter.targetToolId,
          targetInput: structuredClone(targetInput),
          idempotencyKey: `${error.decision.decisionId}:tool:${error.adapter.targetToolId}`,
        };
        if (error.externalApprovalBinding !== undefined) {
          const approvalId = error.externalApprovalBinding.approvalId;
          await this.deps.appendRunEvent(
            input.runId,
            input.state.session.sessionId,
            "recovery.waiting",
            "INFO",
            {
              decisionId: error.decision.decisionId,
              adapterId: error.adapter.adapterId,
              approvalId,
              waitKind: "approval",
            },
            input.state.stepIndex,
            { bypassBuffer: true },
          );
          stepExecutionResult = {
            transition: {
              status: "WAITING",
              nextStepAgent: stepName,
              waitFor: {
                kind: "approval",
                eventType: "user.approval",
                metadata: {
                  approvalId,
                  toolName: error.adapter.targetToolId,
                  toolInput: structuredClone(targetInput),
                  toolClass: "external_side_effect",
                  reason: "Recovery selected an alternate external-effect tool.",
                  externalApprovalBinding: structuredClone(error.externalApprovalBinding),
                  prompt: `Approve recovery tool ${error.adapter.targetToolId}? Reply 'approve' or 'deny'.`,
                },
              },
              statePatch: {
                agent: {
                  ...agent,
                  exec: {
                    ...exec,
                    pendingApproval: {
                      approvalId,
                      toolName: error.adapter.targetToolId,
                      toolInput: structuredClone(targetInput),
                      toolClass: "external_side_effect",
                      externalApprovalBinding: structuredClone(error.externalApprovalBinding),
                      recovery: recoveryState,
                    },
                  },
                  recovery: { pending: recoveryState },
                },
              },
            },
          };
        } else {
          stepExecutionResult = {
            transition: {
              status: "RUNNING",
              nextStepAgent: stepName,
              statePatch: {
                agent: {
                  ...agent,
                  recovery: { pending: recoveryState },
                },
              },
              effects: [{
                type: "tool.execute",
                payload: {
                  toolName: error.adapter.targetToolId,
                  toolInput: structuredClone(targetInput),
                  recoveryDecision: structuredClone(error.decision),
                  recoveryAdapterId: error.adapter.adapterId,
                  recoverySourceToolId: error.adapter.sourceToolId,
                },
                idempotencyKey: recoveryState.idempotencyKey,
                failurePolicy: "STOP",
              }],
            },
          };
        }
      } else {
        const runtimeError = this.deps.mapError(error);
        const recovery = await this.deps.maybeBuildConcreteRepairContinuation({
        event: input.state.event,
        runId: input.runId,
        session: input.state.session,
        currentStep: stepName,
        stepIndex: input.state.stepIndex,
        previousState: input.state.session.state,
        transition: this.deps.buildRunningTransition(input.state.session.state),
        runtimeError,
      });
        if (recovery !== undefined) {
        await this.deps.recordConcreteRepairContinuation({
          runId: input.runId,
          sessionId: input.state.session.sessionId,
          stepIndex: input.state.stepIndex,
          targetPath: recovery.targetPath,
          runtimeError,
        });
        stepExecutionResult = {
          transition: recovery.transition,
        };
        } else {
          const verifiedRetrievalRecovery = await this.deps.maybeBuildVerifiedRetrievalContinuation({
          event: input.state.event,
          runId: input.runId,
          session: input.state.session,
          currentStep: stepName,
          stepIndex: input.state.stepIndex,
          previousState: input.state.session.state,
          transition: this.deps.buildRunningTransition(input.state.session.state),
          runtimeError,
        });
          if (verifiedRetrievalRecovery !== undefined) {
          await this.deps.recordVerifiedRetrievalContinuation({
            runId: input.runId,
            sessionId: input.state.session.sessionId,
            stepIndex: input.state.stepIndex,
            objective: verifiedRetrievalRecovery.objectiveKey,
            guardToolName: verifiedRetrievalRecovery.guardToolName,
          });
          stepExecutionResult = {
            transition: verifiedRetrievalRecovery.transition,
          };
          } else {
            throw error;
          }
        }
      }
    }

    if ("checkpoint" in stepExecutionResult) {
      await this.deps.flushStepObservabilityFrame(stepFrame);
      return stepExecutionResult.checkpoint;
    }
    if (requiresPostCatchValidation) {
      validateTransition(stepExecutionResult.transition);
      await this.deps.validateStepContract({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        stepName,
        transition: stepExecutionResult.transition,
        context: stepContext,
        stepIndex: input.state.stepIndex,
      });
    }

    const previousSessionState = input.state.session.state;
    let transition = stepExecutionResult.transition;
    let statePatch: Record<string, unknown> | undefined;
    try {
      statePatch = await this.deps.applyRuntimeStateGuards(
        input.runId,
        input.state.session.sessionId,
        input.state.stepIndex,
        stepName,
        previousSessionState,
        this.deps.mergeStatePatchWithRegionLaneCursor(
          previousSessionState,
          transition.statePatch,
          activeRegionItem?.region,
        ),
        transition,
      );
    } catch (error) {
      const runtimeError = this.deps.mapError(error);
      const recovery = await this.deps.maybeBuildConcreteRepairContinuation({
        event: input.state.event,
        runId: input.runId,
        session: input.state.session,
        currentStep: stepName,
        stepIndex: input.state.stepIndex,
        previousState: previousSessionState,
        transition,
        runtimeError,
      });
      if (recovery === undefined) {
        const verifiedRetrievalRecovery = await this.deps.maybeBuildVerifiedRetrievalContinuation({
          event: input.state.event,
          runId: input.runId,
          session: input.state.session,
          currentStep: stepName,
          stepIndex: input.state.stepIndex,
          previousState: previousSessionState,
          transition,
          runtimeError,
        });
        if (verifiedRetrievalRecovery === undefined) {
          await this.deps.flushStepObservabilityFrame(stepFrame);
          throw error;
        }
        transition = verifiedRetrievalRecovery.transition;
        statePatch = verifiedRetrievalRecovery.statePatch;
        await this.deps.recordVerifiedRetrievalContinuation({
          runId: input.runId,
          sessionId: input.state.session.sessionId,
          stepIndex: input.state.stepIndex,
          objective: verifiedRetrievalRecovery.objectiveKey,
          guardToolName: verifiedRetrievalRecovery.guardToolName,
        });
      } else {
        transition = recovery.transition;
        statePatch = recovery.statePatch;
        await this.deps.recordConcreteRepairContinuation({
          runId: input.runId,
          sessionId: input.state.session.sessionId,
          stepIndex: input.state.stepIndex,
          targetPath: recovery.targetPath,
          runtimeError,
        });
      }
    }

    if (
      this.deps.runtimeEvaluationEnabled &&
      transition.status === "COMPLETED"
    ) {
      input.state.progressSeq = await this.deps.emitProgress({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        seq: input.state.progressSeq,
        kind: "stage",
        phase: "engine",
        code: "EVALUATION_CHECKING",
        message: "Checking result…",
        stepIndex: input.state.stepIndex,
        stepAgent: stepName,
        persist: true,
      });
    }
    const evaluatedTransition = await this.deps.evaluateRuntimeTransition({
      runId: input.runId,
      event: input.state.event,
      session: input.state.session,
      stepName,
      stepIndex: input.state.stepIndex,
      transition,
      statePatch,
      guardrails: input.guardrails,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    transition = evaluatedTransition.transition;
    statePatch = evaluatedTransition.statePatch;
    if (evaluatedTransition.disposition === "revise") {
      input.state.progressSeq = await this.deps.emitProgress({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        seq: input.state.progressSeq,
        kind: "stage",
        phase: "engine",
        code: "EVALUATION_REVISING",
        message: "Revising result…",
        stepIndex: input.state.stepIndex,
        stepAgent: stepName,
        persist: true,
      });
    } else if (
      evaluatedTransition.disposition === "review" ||
      evaluatedTransition.disposition === "quarantine"
    ) {
      input.state.progressSeq = await this.deps.emitProgress({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        seq: input.state.progressSeq,
        kind: "waiting",
        phase: "engine",
        code: "EVALUATION_REVIEW_REQUIRED",
        message: "Result requires review.",
        stepIndex: input.state.stepIndex,
        stepAgent: stepName,
        persist: true,
      });
    }

    await this.deps.sampleHeap({
      component: "runtime.commitStep",
      phase: "before",
      runId: input.runId,
      sessionId: input.state.session.sessionId,
      stepIndex: input.state.stepIndex,
      stepAgent: stepName,
    });
    const commit = await this.deps.stepCommitPipeline.commitTransition({
      runId: input.runId,
      event: input.state.event,
      session: input.state.session,
      stepName,
      stepIndex: input.state.stepIndex,
      transition,
      statePatch,
      resolvedEffects: await this.deps.resolveEffects(
        transition.effects ?? [],
        input.runId,
        input.state.stepIndex,
        input.state.event.payload,
        input.state.session,
        input.guardrails.budgetSnapshot().remainingMs,
      ),
      emitEvents: transition.emitEvents,
      ...(stepFrame.runLogs.length > 0 || stepFrame.runEvents.length > 0
        ? {
            stepFrame: {
              runLogs: stepFrame.runLogs,
              runEvents: stepFrame.runEvents,
            },
          }
        : {}),
      artifacts: transition.artifacts,
      claims: transition.claims,
      memory: this.deps.resolveTransitionMemory(previousSessionState, statePatch, memorySnapshot),
      budget: input.guardrails.budgetSnapshot(),
    });
    await this.deps.sampleHeap({
      component: "runtime.commitStep",
      phase: "after",
      runId: input.runId,
      sessionId: commit.session.sessionId,
      stepIndex: input.state.stepIndex,
      stepAgent: stepName,
    });

    input.state.session = commit.session;
    await this.deps.appendRuntimeEventIntents({
      runId: input.runId,
      sessionId: input.state.session.sessionId,
      emitEvents: transition.emitEvents ?? [],
      stepIndex: input.state.stepIndex,
    });
    await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "step.transitioned", "INFO", {
      step: stepName,
      nextStepAgent: transition.nextStepAgent,
      status: transition.status,
    }, input.state.stepIndex);
    await this.deps.maybeAppendManagedWorktreeApprovalRequested(
      input.runId,
      input.state.session.sessionId,
      transition,
      input.state.stepIndex,
    );

    await this.deps.logInfo({
      runId: input.runId,
      sessionId: input.state.session.sessionId,
      stepIndex: input.state.stepIndex,
      eventName: "state_transition",
      metadata: buildStateTransitionLogMetadata({
        step: stepName,
        nextStepAgent: transition.nextStepAgent,
        transitionStatus: transition.status,
        stateNode: transition.stateNode,
        previousState: previousSessionState,
        nextState: input.state.session.state,
        statePatch: statePatch ?? {},
      }),
    });
    await this.deps.logInfo({
      runId: input.runId,
      sessionId: input.state.session.sessionId,
      stepIndex: input.state.stepIndex,
      eventName: "step_committed",
      metadata: {
        version: input.state.session.version,
        effects: commit.persistedEffects.length,
        outboxEvents: commit.persistedOutboxEventIds.length,
        artifacts: commit.persistedArtifacts.length,
        claims: commit.persistedClaims.length,
        transitionStatus: transition.status,
        stateNode: transition.stateNode,
      },
    });
    await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "step.committed", "INFO", {
      version: input.state.session.version,
      effects: commit.persistedEffects.length,
      outboxEvents: commit.persistedOutboxEventIds.length,
      artifacts: commit.persistedArtifacts.length,
      claims: commit.persistedClaims.length,
      transitionStatus: transition.status,
      step: stepName,
      stateNode: transition.stateNode,
    }, input.state.stepIndex);
    const agentProgress = transition.agentProgress?.trim();
    if (
      agentProgress !== undefined &&
      agentProgress.length > 0 &&
      agentProgress.length <= 600 &&
      transition.status === "RUNNING"
    ) {
      input.state.progressSeq += 1;
      await this.deps.appendRunEvent(
        input.runId,
        input.state.session.sessionId,
        "agent.progress",
        "INFO",
        {
          version: "v1",
          seq: input.state.progressSeq,
          ts: new Date().toISOString(),
          message: agentProgress,
          stepAgent: stepName,
        },
        input.state.stepIndex,
      );
    }
    input.state.progressSeq = await this.deps.emitProgress({
      runId: input.runId,
      sessionId: input.state.session.sessionId,
      seq: input.state.progressSeq,
      kind: "stage",
      phase: progressPhase,
      code: "STEP_COMMITTED",
      message: `Committed step '${stepName}' with status '${transition.status}'.`,
      stepIndex: input.state.stepIndex,
      stepAgent: stepName,
      progress: {
        completedSteps: input.guardrails.telemetry().stepsExecuted,
        maxSteps: input.guardrails.configSnapshot().maxStepsPerRun,
      },
      persist: true,
    });

    const regionActions = this.deps.regionScheduler.afterTransition({
      transition,
      ...(activeRegionItem !== undefined ? { activeRegionItem } : {}),
    });
    for (const action of regionActions) {
      if (action.kind === "spawn_region_work") {
        await this.deps.regionScheduler.spawnRegionWorkItems(input.state.session.sessionId, action.items ?? []);
        await this.deps.logInfo({
          runId: input.runId,
          sessionId: input.state.session.sessionId,
          stepIndex: input.state.stepIndex,
          eventName: "region_scheduled",
          metadata: {
            count: action.items?.length ?? 0,
            regions: (action.items ?? []).map((item) => item.region),
          },
        });
        await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "region.scheduled", "INFO", {
          count: action.items?.length ?? 0,
          regions: (action.items ?? []).map((item) => item.region),
        }, input.state.stepIndex);
        await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "region.scheduler.spawned", "INFO", {
          count: action.items?.length ?? 0,
          regions: (action.items ?? []).map((item) => item.region),
        }, input.state.stepIndex);
      }
      if (action.kind === "complete_named_regions") {
        const completed = await this.deps.regionScheduler.completeNamedRegions(
          input.state.session.sessionId,
          action.regions,
        );
        if (completed.length > 0) {
          await this.deps.logInfo({
            runId: input.runId,
            sessionId: input.state.session.sessionId,
            stepIndex: input.state.stepIndex,
            eventName: "region_completed",
            metadata: {
              completedIds: completed.map((item) => item.id),
              regions: completed.map((item) => item.region),
            },
          });
          await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "region.completed", "INFO", {
            completedIds: completed.map((item) => item.id),
            regions: completed.map((item) => item.region),
          }, input.state.stepIndex);
        }
      }
      if (action.kind === "complete_claim") {
        await this.deps.regionScheduler.completeClaim(action.regionItem, action.outcome, action.error);
        input.state.laneCursor = action.regionItem.region;
        await this.deps.logInfo({
          runId: input.runId,
          sessionId: input.state.session.sessionId,
          stepIndex: input.state.stepIndex,
          eventName: "region_completed",
          metadata: {
            itemId: action.regionItem.id,
            region: action.regionItem.region,
            outcome: action.outcome,
          },
        });
        await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "region.completed", "INFO", {
          itemId: action.regionItem.id,
          region: action.regionItem.region,
          outcome: action.outcome,
        }, input.state.stepIndex);
      }
      if (action.kind === "sync_primary" && (await this.deps.regionScheduler.isSyncNodeSettled(input.state.session.sessionId))) {
          await this.deps.logInfo({
            runId: input.runId,
            sessionId: input.state.session.sessionId,
            stepIndex: input.state.stepIndex,
            eventName: "region_synced",
            metadata: {
              syncNode: action.syncNode,
            },
          });
          await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "region.synced", "INFO", {
            syncNode: action.syncNode,
          }, input.state.stepIndex);
          await this.deps.appendRunEvent(
            input.runId,
            input.state.session.sessionId,
            "region.scheduler.synced",
            "INFO",
            {
              syncNode: action.syncNode,
            },
            input.state.stepIndex,
          );
        }
    }

    await this.deps.sampleHeap({
      component: "runtime.effects",
      phase: "before",
      runId: input.runId,
      sessionId: input.state.session.sessionId,
      stepIndex: input.state.stepIndex,
      stepAgent: stepName,
      reason: String(commit.persistedEffects.length),
    });
    countModelAuthoredToolEffects(input.guardrails, commit.persistedEffects);
    let effectOutcome: Awaited<ReturnType<RuntimeDependencies["effectRunner"]["runEffects"]>>;
    try {
      effectOutcome = await this.deps.effectRunner.runEffects(commit.persistedEffects, {
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        stepIndex: input.state.stepIndex,
        runtimeBudgetRemainingMs: input.guardrails.budgetSnapshot().remainingMs,
        signal: input.signal,
        onToolActivity: async (activity) => {
          input.state.progressSeq += 1;
          const update = buildRunToolUpdate({
            runId: input.runId,
            sessionId: input.state.session.sessionId,
            seq: input.state.progressSeq,
            stepIndex: input.state.stepIndex,
            stepAgent: stepName,
            ...activity,
          });
          const event = buildRunToolEvent(update);
          await this.deps.appendRunEvent(
            input.runId,
            input.state.session.sessionId,
            event.type,
            event.level,
            event.metadata,
            input.state.stepIndex,
          );
        },
      });
    } finally {
      await this.deps.sampleHeap({
        component: "runtime.effects",
        phase: "after",
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        stepIndex: input.state.stepIndex,
        stepAgent: stepName,
        reason: String(commit.persistedEffects.length),
      });
    }
    const recoveryEffects = commit.persistedEffects.filter((effect) =>
      asPlainRecord(effect.payload)?.recoveryDecision !== undefined);
    for (const effect of recoveryEffects) {
      const recoveryDecision = asPlainRecord(asPlainRecord(effect.payload)?.recoveryDecision);
      const decisionId = typeof recoveryDecision?.decisionId === "string"
        ? recoveryDecision.decisionId
        : undefined;
      if (decisionId === undefined) continue;
      await this.deps.appendRunEvent(
        input.runId,
        input.state.session.sessionId,
        effectOutcome.stop ? "recovery.action.failed" : "recovery.action.completed",
        effectOutcome.stop ? "ERROR" : "INFO",
        {
          decisionId,
          targetToolId: asPlainRecord(effect.payload)?.toolName,
          ...(effectOutcome.errors[0]?.code !== undefined
            ? { failureCode: effectOutcome.errors[0].code }
            : {}),
        },
        input.state.stepIndex,
        { bypassBuffer: true },
      );
    }
    if (effectOutcome.stop) {
      input.errors.push(...effectOutcome.errors);
      const terminalStatus = effectOutcome.terminalStatus ?? "FAILED";
      await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "run.failed", "WARN", {
        terminalStatus,
        reason: "effect_failure_policy_stop",
      }, input.state.stepIndex);
      await this.deps.logWarn({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        stepIndex: input.state.stepIndex,
        eventName: "run_stopped_by_effect_failure",
        metadata: {
          terminalStatus,
          ...(effectOutcome.errors[0] !== undefined
            ? {
                errorCode: effectOutcome.errors[0].code,
                errorMessage: effectOutcome.errors[0].message,
              }
            : {}),
        },
      });
      input.state.progressSeq = await this.deps.emitProgress({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        seq: input.state.progressSeq,
        kind: "stage",
        phase: progressPhase,
        code: terminalStatus === "FAILED" ? "RUN_FAILED" : "RUN_TERMINAL",
        message: `Run stopped due to effect failure policy (${terminalStatus}).`,
        stepIndex: input.state.stepIndex,
        stepAgent: input.state.currentStep,
        persist: true,
      });

      const terminalOutput = await this.deps.runLifecycleController.returnTerminal({
        runId: input.runId,
        sessionId: input.state.session.sessionId,
        currentStep: input.state.currentStep,
        transition: {
          status: terminalStatus,
          nextStepAgent: input.state.currentStep,
        },
        errors: input.errors,
        guardrails: input.guardrails,
        progressSeq: input.state.progressSeq,
        continuation: input.state.continuation,
        stepIndex: input.state.stepIndex,
        skipRunStatusEvent: true,
        skipWaitingEvents: true,
        progressOverride: {
          kind: "stage",
          phase: progressPhase,
          code: terminalStatus === "FAILED" ? "RUN_FAILED" : "RUN_TERMINAL",
          message: `Run stopped due to effect failure policy (${terminalStatus}).`,
          stepAgent: input.state.currentStep,
        },
      });
      if (terminalOutput === undefined) {
        throw createRuntimeFailure(
          "RUN_TERMINALIZATION_INCOMPLETE",
          "Effect failure stop did not produce terminal output.",
          {
            subsystem: "runtime",
            classification: "runtime",
            status: terminalStatus,
            sessionId: input.state.session.sessionId,
            stepAgent: input.state.currentStep,
          },
        );
      }
      return terminalOutput;
    }

    await this.deps.outbox.dispatchInline(input.runId);
    await this.deps.appendRunEvent(input.runId, input.state.session.sessionId, "outbox.dispatched", "INFO", {
      runId: input.runId,
    }, input.state.stepIndex);

    const terminalOutput = await this.deps.runLifecycleController.returnTerminal({
      runId: input.runId,
      sessionId: input.state.session.sessionId,
      currentStep: input.state.currentStep,
      transition,
      errors: input.errors,
      guardrails: input.guardrails,
      progressSeq: input.state.progressSeq,
      continuation: input.state.continuation,
    });
    if (terminalOutput !== undefined) {
      return terminalOutput;
    }

    input.state.currentStep = transition.nextStepAgent;
    input.state.lastStepAgent = stepName;
    input.state.stepIndex += 1;
    return ;
  }

  private async buildRecoveryToolApprovalTransition(input: {
    runId: string;
    session: SessionRecord;
    event: RuntimeEvent;
    stepName: string;
    stepIndex: number;
  }): Promise<StepTransition | undefined> {
    if (input.event.type !== "user.approval") return;
    const agent = asPlainRecord(input.session.state.agent);
    const exec = asPlainRecord(agent?.exec);
    const pendingApproval = asPlainRecord(exec?.pendingApproval);
    const recovery = asPlainRecord(pendingApproval?.recovery);
    if (pendingApproval === undefined || recovery === undefined) return;

    let binding;
    try {
      binding = parseRunnerExternalApprovalBindingV1(pendingApproval.externalApprovalBinding);
    } catch {
      throw createRuntimeFailure(
        "EXTERNAL_APPROVAL_BINDING_INVALID",
        "Recovery tool approval binding is invalid.",
      );
    }
    const decision = asPlainRecord(recovery.decision);
    const toolName = typeof pendingApproval.toolName === "string" ? pendingApproval.toolName : undefined;
    const toolInput = asPlainRecord(pendingApproval.toolInput);
    const adapterId = typeof recovery.adapterId === "string" ? recovery.adapterId : undefined;
    const sourceToolId = typeof recovery.sourceToolId === "string" ? recovery.sourceToolId : undefined;
    const decisionId = typeof decision?.decisionId === "string" ? decision.decisionId : undefined;
    const decisionRunId = typeof decision?.runId === "string" ? decision.runId : undefined;
    const metadata = asPlainRecord(input.event.payload.metadata);
    const actor = asPlainRecord(metadata?.actor ?? input.event.payload.actor);
    const actorId = typeof actor?.actorId === "string" && actor.actorId.trim().length > 0
      ? actor.actorId.trim()
      : undefined;
    const actorType = typeof actor?.actorType === "string" ? actor.actorType : undefined;
    const approvalId = typeof input.event.payload.approvalId === "string"
      ? input.event.payload.approvalId
      : undefined;
    const threadId = typeof metadata?.threadId === "string"
      ? metadata.threadId
      : input.session.sessionId;
    const payloadHash = toolName === undefined || toolInput === undefined
      ? undefined
      : `sha256:${createHash("sha256").update(serializeCanonicalApprovalPayload({
          toolName,
          toolInput,
        })).digest("hex")}`;
    if (
      toolName === undefined ||
      toolInput === undefined ||
      adapterId === undefined ||
      sourceToolId === undefined ||
      decisionId === undefined ||
      decisionRunId === undefined ||
      actorId === undefined ||
      (actorType !== "end_user" && actorType !== "operator" && actorType !== "service") ||
      approvalId !== binding.approvalId ||
      pendingApproval.approvalId !== binding.approvalId ||
      binding.threadId !== threadId ||
      binding.runId !== decisionRunId ||
      binding.actionKey !== toolName ||
      binding.payloadHash !== payloadHash ||
      Date.parse(binding.expiresAt) <= Date.now()
    ) {
      throw createRuntimeFailure(
        "EXTERNAL_APPROVAL_IDENTITY_MISMATCH",
        "Recovery tool approval does not match the exact pending action and authority.",
      );
    }
    const approvalDecision = parseApprovalDecisionFromPayload(input.event.payload);
    if (approvalDecision === undefined) {
      throw createRuntimeFailure(
        "APPROVAL_DECISION_INVALID",
        "Recovery tool approval requires an exact approve or deny decision.",
      );
    }
    if (approvalDecision === "deny") {
      await this.deps.appendRunEvent(
        input.runId,
        input.session.sessionId,
        "recovery.action.failed",
        "WARN",
        { decisionId, adapterId, failureCode: "APPROVAL_DENIED", actorId },
        input.stepIndex,
        { bypassBuffer: true },
      );
      throw createRuntimeFailure("APPROVAL_DENIED", "Recovery tool approval was denied.");
    }

    await this.deps.appendRunEvent(
      input.runId,
      input.session.sessionId,
      "interaction.resolved",
      "INFO",
      { kind: "recovery_tool_approval", decisionId, adapterId, approvalId, actorId },
      input.stepIndex,
      { bypassBuffer: true },
    );
    return {
      status: "RUNNING",
      nextStepAgent: input.stepName,
      statePatch: {
        agent: {
          ...(agent ?? {}),
          exec: {
            ...(exec ?? {}),
            pendingApproval: undefined,
          },
          recovery: { pending: recovery },
        },
      },
      effects: [{
        type: "tool.execute",
        payload: {
          toolName,
          toolInput: structuredClone(toolInput),
          recoveryDecision: structuredClone(decision),
          recoveryAdapterId: adapterId,
          recoverySourceToolId: sourceToolId,
          externalApprovalBinding: structuredClone(binding),
        },
        idempotencyKey: typeof recovery.idempotencyKey === "string"
          ? recovery.idempotencyKey
          : `${decisionId}:tool:${toolName}`,
        failurePolicy: "STOP",
      }],
    };
  }

  private async selectStep(input: {
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string | undefined;
    stepIndex: number;
    laneCursor: string | undefined;
  }): Promise<StepSelection> {
    return this.deps.regionScheduler.beforeStep({
      event: input.event,
      session: input.session,
      currentStep: input.currentStep,
      stepIndex: input.stepIndex,
      laneCursor: input.laneCursor,
    });
  }
}
