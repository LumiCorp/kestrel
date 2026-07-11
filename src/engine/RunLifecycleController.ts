import { randomUUID } from "node:crypto";

import type { RunEventType, RuntimeError, TransitionStatus } from "../kestrel/contracts/base.js";
import type { ProgressCode, ProgressPhase, RuntimeEvent } from "../kestrel/contracts/events.js";
import type { GuardrailConfig, NormalizedOutput, RuntimeDependencies, Transition } from "../kestrel/contracts/execution.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";

import { computeQualityMetrics } from "../quality/QualityMetrics.js";
import { asRuntimeError, createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { FilesystemResumeReadBudgetDetail } from "../runtime/filesystemResumeBudget.js";
import type { Guardrails } from "./Guardrails.js";
import { Guardrails as GuardrailsRuntime } from "./Guardrails.js";
import type { WaitResumeCoordinator } from "./WaitResumeCoordinator.js";

interface RunLifecycleLogEntry {
  runId: string;
  sessionId: string;
  eventName: string;
  metadata?: Record<string, unknown> | undefined;
  stepIndex?: number | undefined;
}

interface RunLifecycleControllerOptions {
  deps: Pick<RuntimeDependencies, "store" | "outputNormalizer">;
  guardrailConfig: GuardrailConfig;
  waitResumeCoordinator: WaitResumeCoordinator;
  normalizeLegacyExecutionSession: (
    session: SessionRecord | null | undefined,
  ) => SessionRecord | undefined;
  appendRunEvent: (
    runId: string,
    sessionId: string,
    type: RunEventType,
    level: "INFO" | "WARN" | "ERROR",
    metadata?: Record<string, unknown> | undefined,
    stepIndex?: number | undefined,
  ) => Promise<void>;
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
  }) => Promise<number>;
  logInfo: (entry: RunLifecycleLogEntry) => Promise<void>;
  logWarn: (entry: RunLifecycleLogEntry) => Promise<void>;
  logError: (entry: RunLifecycleLogEntry) => Promise<void>;
  releaseManagedWorktreeLeaseForRun: (
    runId: string,
    session: SessionRecord,
    terminalStatus?: TransitionStatus,
  ) => Promise<void>;
  resolveRuntimeBudget: (
    event: RuntimeEvent,
  ) => { externalDeadlineMs?: number | undefined } | undefined;
  resolveProgressPhase: (stepAgent: string | undefined) => ProgressPhase;
  resolveFilesystemResumeReadBudget: (input: {
    session: SessionRecord | null;
    status: TransitionStatus;
    stopReason: string | undefined;
  }) => FilesystemResumeReadBudgetDetail;
  mergeOrchestrationEventMetadata: (
    event?: RuntimeEvent | undefined,
    waitFor?: Transition["waitFor"],
  ) => Record<string, unknown>;
}

export class RunLifecycleController {
  private readonly options: RunLifecycleControllerOptions;

  constructor(options: RunLifecycleControllerOptions) {
    this.options = options;
  }

  createRunId(): string {
    return randomUUID();
  }

  createGuardrails(event: RuntimeEvent): Guardrails {
    return new GuardrailsRuntime(
      this.options.guardrailConfig,
      undefined,
      this.options.resolveRuntimeBudget(event),
    );
  }

  async startRun(input: {
    runId: string;
    event: RuntimeEvent;
  }): Promise<{ session: SessionRecord; progressSeq: number; lastStepAgent: string | undefined }> {
    const session = this.options.normalizeLegacyExecutionSession(
      await this.options.deps.store.ensureSession(input.event.sessionId, input.event.stepAgent),
    );
    if (session === undefined) {
      throw createRuntimeFailure(
        "RUN_SESSION_LOAD_FAILED",
        "Session could not be initialized.",
        {
          subsystem: "runtime",
          classification: "runtime",
          sessionId: input.event.sessionId,
        },
      );
    }

    await this.options.deps.store.startRun(input.runId, input.event);
    await this.options.appendRunEvent(input.runId, input.event.sessionId, "run.started", "INFO", {
      eventType: input.event.type,
      stepAgentOverride: input.event.stepAgent,
    });
    const legacyModeMigration = asRecord(input.event.payload.legacyModeMigration);
    if (legacyModeMigration?.migrated === true) {
      await this.options.appendRunEvent(input.runId, input.event.sessionId, "mode.legacy_migrated", "INFO", {
        interactionMode: asString(legacyModeMigration.interactionMode),
        legacyInteractionMode: asString(legacyModeMigration.legacyInteractionMode),
        reason:
          asString(legacyModeMigration.reason) ??
          "reference harness forced mode-system v2",
      });
    }
    await this.options.logInfo({
      runId: input.runId,
      sessionId: input.event.sessionId,
      eventName: "run_started",
      metadata: {
        eventType: input.event.type,
        stepAgentOverride: input.event.stepAgent,
      },
    });
    const progressSeq = await this.options.emitProgress({
      runId: input.runId,
      sessionId: input.event.sessionId,
      seq: 0,
      kind: "stage",
      phase: "engine",
      code: "RUN_STARTED",
      message: `Run started for event '${input.event.type}'.`,
      persist: true,
    });

    return {
      session,
      progressSeq,
      lastStepAgent: session.currentStepAgent ?? input.event.stepAgent,
    };
  }

  async returnTerminal(input: {
    runId: string;
    sessionId: string;
    currentStep?: string | undefined;
    transition: Transition;
    errors: RuntimeError[];
    guardrails: Guardrails;
    progressSeq: number;
    continuation?: NormalizedOutput["continuation"] | undefined;
    stepIndex?: number | undefined;
    skipRunStatusEvent?: boolean | undefined;
    skipWaitingEvents?: boolean | undefined;
    progressOverride?: {
      kind?: "stage" | "tool" | "waiting" | "heartbeat" | undefined;
      phase?: ProgressPhase | undefined;
      code?: ProgressCode | undefined;
      message?: string | undefined;
      stepAgent?: string | undefined;
    } | undefined;
    checkpointOverride?: {
      stateNode?: string | undefined;
      resumeToken: string;
    } | undefined;
    terminalMetadata?: Record<string, unknown> | undefined;
    qualityMetadata?: Record<string, unknown> | undefined;
  }): Promise<NormalizedOutput | undefined> {
    if (input.transition.status === "RUNNING") {
      return undefined;
    }

    const status = input.transition.status;
    const synthesizedTerminalError = status === "FAILED"
      ? readFailedTransitionError(input.transition)
      : undefined;
    const terminalErrors =
      input.errors.length === 0 && synthesizedTerminalError !== undefined
        ? [synthesizedTerminalError]
        : input.errors;
    const failedReasonCode = status === "FAILED"
      ? terminalErrors[0]?.code ?? readFailedTransitionReasonCode(input.transition)
      : undefined;
    await this.options.deps.store.completeRun(input.runId, status, terminalErrors[0]);
    const terminalSessionForLease = await this.options.deps.store.getSession(input.sessionId);
    const terminalSession = this.options.normalizeLegacyExecutionSession(terminalSessionForLease);
    if (terminalSession !== undefined) {
      await this.options.releaseManagedWorktreeLeaseForRun(input.runId, terminalSession, status);
    }
    const waitReasonCode =
      status === "WAITING"
        ? asString(asRecord(input.transition.waitFor?.metadata)?.reason)
        : undefined;
    const readBudgets = {
      filesystemResume: this.options.resolveFilesystemResumeReadBudget({
        session: terminalSession ?? null,
        status,
        stopReason: waitReasonCode,
      }),
    };

    await this.options.logInfo({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventName: "run_terminal",
      metadata: {
        status,
        finalStep: input.currentStep,
        readBudgets,
      },
    });
    if (input.skipRunStatusEvent !== true) {
      await this.options.appendRunEvent(
        input.runId,
        input.sessionId,
        status === "FAILED" ? "run.failed" : "run.completed",
        status === "FAILED" ? "ERROR" : "INFO",
        {
          status,
          finalStep: input.currentStep,
          readBudgets,
          ...(failedReasonCode !== undefined ? { reasonCode: failedReasonCode } : {}),
        },
        input.stepIndex,
      );
    }
    if (status === "WAITING" && input.skipWaitingEvents !== true) {
      const orchestrationMetadata = this.options.mergeOrchestrationEventMetadata(
        undefined,
        input.transition.waitFor,
      );
      await this.options.waitResumeCoordinator.appendWaitingEvents({
        runId: input.runId,
        sessionId: input.sessionId,
        finalStep: input.currentStep ?? input.transition.nextStepAgent ?? "agent.loop",
        transition: input.transition,
        orchestrationMetadata,
        stepIndex: input.stepIndex,
      });
    }
    await this.options.appendRunEvent(input.runId, input.sessionId, "terminal.normalized", "INFO", {
      status,
      finalStep: input.currentStep,
      ...(failedReasonCode !== undefined ? { reasonCode: failedReasonCode } : {}),
      ...(waitReasonCode !== undefined ? { reasonCode: waitReasonCode } : {}),
      readBudgets,
      ...(status === "WAITING" && input.transition.waitFor !== undefined
        ? {
            waitFor: {
              eventType: input.transition.waitFor.eventType,
              ...(input.transition.waitFor.metadata !== undefined
                ? { metadata: input.transition.waitFor.metadata }
                : {}),
            },
          }
        : {}),
      ...(input.terminalMetadata ?? {}),
    }, input.stepIndex);
    await this.options.emitProgress({
      runId: input.runId,
      sessionId: input.sessionId,
      seq: input.progressSeq,
      kind: input.progressOverride?.kind ?? (status === "WAITING" ? "waiting" : "stage"),
      phase:
        input.progressOverride?.phase ??
        this.options.resolveProgressPhase(input.currentStep),
      code:
        input.progressOverride?.code ??
        (status === "FAILED"
          ? "RUN_FAILED"
          : status === "WAITING"
            ? "WAITING_FOR_EVENT"
            : "RUN_COMPLETED"),
      message:
        input.progressOverride?.message ??
        (status === "FAILED"
          ? `Run failed: ${failedReasonCode ?? "RUN_FAILED"}.`
          : status === "WAITING"
            ? `Run waiting for '${input.transition.waitFor?.eventType ?? "event"}'.`
            : `Run completed at step '${input.currentStep}'.`),
      stepAgent: input.progressOverride?.stepAgent ?? input.currentStep,
      stepIndex: input.stepIndex,
      ...(status === "WAITING" && input.transition.waitFor !== undefined
        ? {
            waitFor: {
              eventType: input.transition.waitFor.eventType,
              timeoutMs: input.transition.waitFor.timeoutMs,
            },
          }
        : {}),
      persist: true,
    });
    const quality = computeQualityMetrics({
      sessionState: terminalSession?.state ?? {},
      stepsExecuted: input.guardrails.telemetry().stepsExecuted,
      thrashIndex: input.guardrails.thrashIndex(),
    });
    await this.options.logInfo({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventName: "quality_computed",
      metadata: {
        status,
        finalStep: input.currentStep,
        quality,
      },
    });
    await this.options.appendRunEvent(input.runId, input.sessionId, "quality.computed", "INFO", {
      citationCoverage: quality.citationCoverage,
      unresolvedClaims: quality.unresolvedClaims,
      reworkRate: quality.reworkRate,
      thrashIndex: quality.thrashIndex,
      status,
      finalStep: input.currentStep,
      ...(input.qualityMetadata ?? {}),
    }, input.stepIndex);

    const telemetry = input.guardrails.telemetry();
    return this.options.deps.outputNormalizer.normalize({
      status,
      sessionId: input.sessionId,
      runId: input.runId,
      finalStep: input.currentStep,
      waitFor: status === "WAITING" ? input.transition.waitFor : undefined,
      continuation: input.continuation,
      quality,
      checkpoint:
        input.checkpointOverride ??
        (status === "WAITING"
          ? {
              stateNode:
                input.transition.stateNode === undefined
                  ? undefined
                  : `${input.transition.stateNode.parent}/${input.transition.stateNode.child}${input.transition.stateNode.region === undefined ? "" : `:${input.transition.stateNode.region}`}`,
              resumeToken: `${input.runId}:${input.currentStep}`,
            }
          : undefined),
      errors: terminalErrors,
      telemetry,
      readBudgets,
    });
  }

  async failRun(input: {
    runId: string;
    event: RuntimeEvent;
    runtimeError: RuntimeError;
    errors: RuntimeError[];
    guardrails: Guardrails;
    progressSeq: number;
    lastStepAgent: string | undefined;
    session?: SessionRecord | undefined;
    continuation?: NormalizedOutput["continuation"] | undefined;
  }): Promise<NormalizedOutput> {
    const errorDetails = asRecord(input.runtimeError.details);
    if (input.runtimeError.code.startsWith("DECISION_")) {
      const extraDecisionEventType = readRunEventType(errorDetails?.eventType);
      if (extraDecisionEventType !== undefined) {
        await this.options.appendRunEvent(input.runId, input.event.sessionId, extraDecisionEventType, "WARN", {
          decisionErrorCode: input.runtimeError.code,
          message: input.runtimeError.message,
          ...(errorDetails !== undefined ? errorDetails : {}),
        });
      }
      await this.options.appendRunEvent(input.runId, input.event.sessionId, "decision.rejected", "WARN", {
        decisionErrorCode: input.runtimeError.code,
        decisionCode: "runtime_failure",
        decisionPhase: "unknown",
        message: input.runtimeError.message,
        ...(errorDetails !== undefined ? errorDetails : {}),
      });
      await this.options.logWarn({
        runId: input.runId,
        sessionId: input.event.sessionId,
        eventName: "decision_rejected",
        metadata: {
          decisionErrorCode: input.runtimeError.code,
          message: input.runtimeError.message,
          ...(errorDetails !== undefined ? errorDetails : {}),
        },
      });
    }
    if (input.runtimeError.code === "LOOP_GUARD_TRIGGERED") {
      await this.options.appendRunEvent(input.runId, input.event.sessionId, "loop.guard_triggered", "WARN", {
        message: input.runtimeError.message,
        ...(input.runtimeError.details !== undefined ? { details: input.runtimeError.details } : {}),
      });
    }
    if (input.runtimeError.code === "RUN_CANCELLED") {
      await this.options.appendRunEvent(input.runId, input.event.sessionId, "run.cancelled", "WARN", {
        message: input.runtimeError.message,
        ...(input.runtimeError.details !== undefined ? { details: input.runtimeError.details } : {}),
      });
    }
    await this.options.deps.store.completeRun(input.runId, "FAILED", input.runtimeError);
    if (input.session !== undefined) {
      await this.options.releaseManagedWorktreeLeaseForRun(input.runId, input.session, "FAILED");
    }
    await this.options.appendRunEvent(input.runId, input.event.sessionId, "run.failed", "ERROR", {
      code: input.runtimeError.code,
      message: input.runtimeError.message,
      ...(errorDetails !== undefined ? { details: errorDetails } : {}),
    });
    await this.options.appendRunEvent(input.runId, input.event.sessionId, "terminal.normalized", "INFO", {
      status: "FAILED",
      finalStep: input.lastStepAgent,
      reasonCode: input.runtimeError.code,
    });
    const progressSeq = await this.options.emitProgress({
      runId: input.runId,
      sessionId: input.event.sessionId,
      seq: input.progressSeq,
      kind: "stage",
      phase: "engine",
      code: "RUN_FAILED",
      message: `Run failed: ${input.runtimeError.code}.`,
      persist: true,
    });
    await this.options.logError({
      runId: input.runId,
      sessionId: input.event.sessionId,
      eventName: "run_failed",
      metadata: {
        code: input.runtimeError.code,
        message: input.runtimeError.message,
        ...(errorDetails !== undefined ? { details: errorDetails } : {}),
      },
    });

    const telemetry = input.guardrails.telemetry();
    return this.options.deps.outputNormalizer.normalize({
      status: "FAILED",
      sessionId: input.event.sessionId,
      runId: input.runId,
      finalStep: input.lastStepAgent,
      continuation: input.continuation,
      quality: {
        citationCoverage: 0,
        unresolvedClaims: 0,
        reworkRate: 0,
        thrashIndex: input.guardrails.thrashIndex(),
      },
      errors: input.errors,
      telemetry,
    });
  }

  async cancelActiveRun(sessionId: string): Promise<{ runId?: string | undefined }> {
    const sessionRecord = await this.options.deps.store.getSession(sessionId);
    const session = this.options.normalizeLegacyExecutionSession(sessionRecord);
    const runtimeError = createRuntimeFailure("RUN_CANCELLED", "Run cancelled.", {
      sessionId,
      ...(session?.currentStepAgent !== undefined ? { currentStepAgent: session.currentStepAgent } : {}),
    });
    const result = await this.options.deps.store.cancelActiveRun(sessionId, asRuntimeError(runtimeError));
    if (result.runId === undefined) {
      return result;
    }

    if (session !== undefined) {
      await this.options.releaseManagedWorktreeLeaseForRun(result.runId, session, "FAILED");
    }

    const errorDetails = asRecord(runtimeError.details);
    await this.options.appendRunEvent(result.runId, sessionId, "run.cancelled", "WARN", {
      message: runtimeError.message,
      ...(errorDetails !== undefined ? { details: errorDetails } : {}),
    });
    await this.options.appendRunEvent(result.runId, sessionId, "run.failed", "ERROR", {
      code: runtimeError.code,
      message: runtimeError.message,
      ...(errorDetails !== undefined ? { details: errorDetails } : {}),
    });
    await this.options.appendRunEvent(result.runId, sessionId, "terminal.normalized", "INFO", {
      status: "FAILED",
      ...(session?.currentStepAgent !== undefined ? { finalStep: session.currentStepAgent } : {}),
      reasonCode: runtimeError.code,
    });

    return result;
  }
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

function readFailedTransitionError(transition: Transition): RuntimeError | undefined {
  const agent = asRecord(transition.statePatch?.agent);
  const terminal = asRecord(agent?.terminal);
  const lastActionError = asRecord(asRecord(agent?.lastActionResult)?.error);
  const code =
    asString(terminal?.reasonCode) ??
    asString(lastActionError?.code);
  const message =
    asString(terminal?.message) ??
    asString(lastActionError?.message);
  if (code === undefined && message === undefined) {
    return undefined;
  }
  const terminalStatus = asString(terminal?.status);
  const decisionReason = asString(agent?.decisionReason);
  const details = {
    ...(asRecord(lastActionError?.details) ?? {}),
    ...(terminalStatus !== undefined ? { terminalStatus } : {}),
    ...(decisionReason !== undefined ? { decisionReason } : {}),
  };
  return asRuntimeError(createRuntimeFailure(
    code ?? "RUN_FAILED",
    message ?? "Run failed.",
    Object.keys(details).length > 0 ? details : undefined,
  ));
}

function readFailedTransitionReasonCode(transition: Transition): string | undefined {
  const agent = asRecord(transition.statePatch?.agent);
  return asString(asRecord(agent?.terminal)?.reasonCode) ??
    asString(asRecord(asRecord(agent?.lastActionResult)?.error)?.code);
}

function readRunEventType(value: unknown): RunEventType | undefined {
  return typeof value === "string" && value.length > 0 ? value as RunEventType : undefined;
}
