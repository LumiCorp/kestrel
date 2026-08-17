import type { RunEventType, RuntimeError } from "../kestrel/contracts/base.js";
import type { RuntimeEvent } from "../kestrel/contracts/events.js";
import type { GuardrailConfig, NormalizedOutput, RuntimeDependencies, Transition } from "../kestrel/contracts/execution.js";
import type { ModelRequest } from "../kestrel/contracts/model-io.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";

import { createRuntimeFailure, RunCancelledError } from "../runtime/RuntimeFailure.js";
import { readActiveTaskGoalFromState } from "../runtime/turnObjective.js";
import { normalizeVisibleTodoState } from "../runtime/visibleTodos.js";
import { clearRuntimeWaitState, readActiveWaitState } from "../runtime/waitState.js";
import {
  classifyUserReplyIntent,
  isHighConfidenceContinuation,
} from "../runtime/userReplyIntent.js";
import { Guardrails } from "./Guardrails.js";
import type { WaitResumeCoordinator } from "./WaitResumeCoordinator.js";

const LEGACY_CONTINUATION_EXTRA_STEPS = 50;
const CONTINUATION_CHECKPOINT_MAX_CHARS = 600;
const CONTINUATION_CHECKPOINT_CONTEXT_MAX_CHARS = 400;
const CONTINUATION_CHECKPOINT_FORBIDDEN_LANGUAGE =
  /\b(?:model\s+calls?|calls?|steps?|counters?|budgets?|limits?|internal\s+agents?|runtime\s+machinery)\b/iu;
const CONTINUATION_CHECKPOINT_INVITATION =
  /\b(?:continue|keep going|go on|proceed|carry on)\b/iu;
const CONTINUATION_CHECKPOINT_FUTURE_WORK =
  /\b(?:next(?:\s+up)?|remaining|still\s+need\s+to|then|after\s+that)\b/iu;
const CONTINUATION_CHECKPOINT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: {
      type: "string",
      minLength: 1,
      maxLength: CONTINUATION_CHECKPOINT_MAX_CHARS,
      description:
        "A natural user-facing progress checkpoint that states concrete progress, identifies the next remaining work, and ends by asking whether to continue.",
    },
  },
  required: ["message"],
};

export const FRESH_TURN_AGENT_CONTROL_KEYS = [
  "goal",
  "plan",
  "visibleTodos",
  "contextCache",
  "observations",
  "lastAction",
  "lastExecutableAction",
  "lastActionResult",
  "postToolVerification",
  "retryContext",
  "progress",
  "latestEvidenceDelta",
  "capabilityEvidence",
  "decisionTrace",
  "decisionVerification",
  "decisionConfidence",
  "loopConvergence",
  "loopStall",
  "closeoutLatch",
] as const;

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

export type ContinuationWaitReason = "max_steps_continuation" | "max_model_calls_continuation";
export type ContinuationGrantMode = "additive" | "reset_window";

export interface ContinuationRequestState {
  extraStepsRequested: number;
  extraModelCallsRequested?: number | undefined;
  grantMode: ContinuationGrantMode;
  budget: "steps" | "model_calls";
  completedSoFar: string[];
  blockedOn: string;
  nextIfApproved: string[];
  partialAnswer?: string | undefined;
  resumeStepAgent: string;
  lastStepIndex: number;
  stepsConsumed: number;
  modelCallsConsumed: number;
}

export interface ContinuationState {
  accountingVersion: 1 | 2;
  baseMaxStepsPerRun: number;
  grantedExtraSteps: number;
  baseMaxModelCallsPerRun: number;
  grantedExtraModelCalls: number;
  grantMode: ContinuationGrantMode;
  windowStartSteps: number;
  windowStartModelCalls: number;
  continuationCount: number;
  stepsConsumed: number;
  modelCallsConsumed: number;
  pendingContinuationRequest?: ContinuationRequestState | undefined;
}

type RunEventLevel = "INFO" | "WARN" | "ERROR";

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

export interface ContinuationCoordinatorDependencies {
  runtimeDeps: Pick<RuntimeDependencies, "modelGateway" | "store">;
  guardrailConfig: GuardrailConfig;
  waitResumeCoordinator: WaitResumeCoordinator;
  appendRunEvent: (
    runId: string,
    sessionId: string,
    type: RunEventType,
    level: RunEventLevel,
    metadata: Record<string, unknown>,
    stepIndex?: number | undefined,
  ) => Promise<void>;
  mapError: (error: unknown) => RuntimeError;
  checkpointModel?: string | undefined;
  callMaintenanceModel: (input: {
    request: ModelRequest;
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string;
    stepIndex: number;
    guardrails: Guardrails;
    progressSeq: number;
    signal?: AbortSignal | undefined;
  }) => Promise<
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
  >;
  returnTerminal: ReturnTerminal;
}

export class ContinuationCoordinator {
  private readonly deps: ContinuationCoordinatorDependencies["runtimeDeps"];
  private readonly guardrailConfig: GuardrailConfig;
  private readonly waitResumeCoordinator: WaitResumeCoordinator;
  private readonly appendRunEvent: ContinuationCoordinatorDependencies["appendRunEvent"];
  private readonly mapError: ContinuationCoordinatorDependencies["mapError"];
  private readonly checkpointModel: string | undefined;
  private readonly callMaintenanceModel: ContinuationCoordinatorDependencies["callMaintenanceModel"];
  private readonly returnTerminal: ReturnTerminal;

  constructor(deps: ContinuationCoordinatorDependencies) {
    this.deps = deps.runtimeDeps;
    this.guardrailConfig = deps.guardrailConfig;
    this.waitResumeCoordinator = deps.waitResumeCoordinator;
    this.appendRunEvent = deps.appendRunEvent;
    this.mapError = deps.mapError;
    this.checkpointModel = deps.checkpointModel;
    this.callMaintenanceModel = deps.callMaintenanceModel;
    this.returnTerminal = deps.returnTerminal;
  }

  resolveGuardrailConfigForSession(
    continuationState: ContinuationState | undefined,
  ): GuardrailConfig {
    if (continuationState === undefined) {
      return this.guardrailConfig;
    }
    return {
      ...this.guardrailConfig,
      maxStepsPerRun:
        continuationState.grantMode === "reset_window"
          ? continuationState.windowStartSteps + continuationState.baseMaxStepsPerRun
          : continuationState.baseMaxStepsPerRun + continuationState.grantedExtraSteps,
      maxModelCallsPerRun:
        continuationState.grantMode === "reset_window"
          ? continuationState.windowStartModelCalls + continuationState.baseMaxModelCallsPerRun
          : continuationState.baseMaxModelCallsPerRun
            + continuationState.grantedExtraModelCalls,
    };
  }

  readContinuationState(
    sessionState: Record<string, unknown>,
  ): ContinuationState | undefined {
    const react = asRecord(sessionState.agent);
    const continuation = asRecord(react?.continuation);
    if (continuation === undefined) {
      return ;
    }
    const grantMode = continuation.grantMode === "reset_window"
      ? "reset_window"
      : "additive";
    return {
      accountingVersion: grantMode === "reset_window" ? 2 : 1,
      baseMaxStepsPerRun:
        readMaybeNumber(continuation.baseMaxStepsPerRun) ?? this.guardrailConfig.maxStepsPerRun,
      grantedExtraSteps: readMaybeNumber(continuation.grantedExtraSteps) ?? 0,
      baseMaxModelCallsPerRun:
        readMaybeNumber(continuation.baseMaxModelCallsPerRun)
        ?? this.guardrailConfig.maxModelCallsPerRun,
      grantedExtraModelCalls: readMaybeNumber(continuation.grantedExtraModelCalls) ?? 0,
      grantMode,
      windowStartSteps:
        grantMode === "reset_window"
          ? readMaybeNumber(continuation.windowStartSteps) ?? 0
          : 0,
      windowStartModelCalls:
        grantMode === "reset_window"
          ? readMaybeNumber(continuation.windowStartModelCalls) ?? 0
          : 0,
      continuationCount: readMaybeNumber(continuation.continuationCount) ?? 0,
      stepsConsumed: readMaybeNumber(continuation.stepsConsumed) ?? 0,
      modelCallsConsumed: readMaybeNumber(continuation.modelCallsConsumed) ?? 0,
      pendingContinuationRequest: parseContinuationRequestState(
        asRecord(continuation.pendingContinuationRequest),
      ),
    };
  }

  async maybeResetContinuationStateForFreshTurn(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
  }): Promise<SessionRecord> {
    if (isFreshTurnResetEvent(input.event) === false) {
      return input.session;
    }
    const continuationState = this.readContinuationState(input.session.state);
    const reactState = asRecord(input.session.state.agent) ?? {};
    if (readActiveWaitState(reactState)?.kind === "region_merge") {
      return input.session;
    }
    const nextReactState = this.buildFreshTurnReactState(
      reactState,
      continuationState !== undefined,
      asRecord(input.event.payload) ?? {},
    );
    if (nextReactState === undefined) {
      return input.session;
    }

    const commit = await this.deps.store.commitStep({
      runId: input.runId,
      event: {
        id: `${input.runId}:continuation-reset`,
        type: "system.meta_reasoning",
        sessionId: input.session.sessionId,
        payload: {
          reason: "fresh_turn_reset",
        },
      },
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.session.currentStepAgent,
      nextStepAgent: input.session.currentStepAgent,
      statePatch: {
        agent: nextReactState,
        evidenceLedger: undefined,
      },
      effects: [],
      emitEvents: [],
      stepIndex: 0,
    });
    return this.readCommittedSessionAfterStateReset(commit.session);
  }

  async maybeHandleContinuationReply(input: {
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
    if (input.event.type !== "user.reply") {
      return ;
    }
    const reactState = asRecord(input.session.state.agent) ?? {};
    const waitReason = readContinuationWaitReason(reactState);
    const reply =
      asString(input.event.payload.message) ??
      asString(input.event.payload.text) ??
      "";
    if (isContinuationWaitReason(waitReason) === false) {
      return ;
    }

    const continuationState = this.readContinuationState(input.session.state);
    const pending = continuationState?.pendingContinuationRequest;
    if (continuationState === undefined || pending === undefined) {
      return ;
    }
    const intent = await classifyUserReplyIntent({
      reply,
      waitFor: {
        eventType: "user.reply",
        metadata: { reason: waitReason },
      },
      useModel: (request) => this.deps.modelGateway.call(request),
    });
    if (isHighConfidenceContinuation(intent)) {
      const nextContinuationState: ContinuationState = pending.grantMode === "reset_window"
        ? {
            accountingVersion: 2,
            baseMaxStepsPerRun: continuationState.baseMaxStepsPerRun,
            grantedExtraSteps: continuationState.grantedExtraSteps,
            baseMaxModelCallsPerRun: continuationState.baseMaxModelCallsPerRun,
            grantedExtraModelCalls: continuationState.grantedExtraModelCalls,
            grantMode: "reset_window",
            windowStartSteps: pending.stepsConsumed,
            windowStartModelCalls: pending.modelCallsConsumed,
            continuationCount: continuationState.continuationCount + 1,
            stepsConsumed: pending.stepsConsumed,
            modelCallsConsumed: pending.modelCallsConsumed,
          }
        : {
            accountingVersion: continuationState.accountingVersion,
            baseMaxStepsPerRun: continuationState.baseMaxStepsPerRun,
            grantedExtraSteps:
              continuationState.grantedExtraSteps + pending.extraStepsRequested,
            baseMaxModelCallsPerRun: continuationState.baseMaxModelCallsPerRun,
            grantedExtraModelCalls:
              continuationState.grantedExtraModelCalls + (pending.extraModelCallsRequested ?? 0),
            grantMode: continuationState.grantMode,
            windowStartSteps: continuationState.windowStartSteps,
            windowStartModelCalls: continuationState.windowStartModelCalls,
            continuationCount: continuationState.continuationCount + 1,
            stepsConsumed: pending.stepsConsumed,
            modelCallsConsumed: pending.modelCallsConsumed,
          };
      const commit = await this.deps.store.commitStep({
        runId: input.runId,
        event: input.event,
        sessionId: input.session.sessionId,
        expectedVersion: input.session.version,
        stepAgent: input.currentStep ?? pending.resumeStepAgent,
        nextStepAgent: pending.resumeStepAgent,
        statePatch: {
          agent: clearRuntimeWaitState({
            ...reactState,
            continuation: serializeContinuationState(nextContinuationState),
            terminal: undefined,
          }),
        },
        effects: [],
        emitEvents: [],
        stepIndex: input.stepIndex,
      });
      const committedSession = await this.readCommittedContinuationSession(commit.session);
      this.assertContinuationGrantState(committedSession, pending, nextContinuationState);
      await this.appendRunEvent(
        input.runId,
        input.session.sessionId,
        "run.continuation_granted",
        "INFO",
        {
          grantMode: pending.grantMode,
          window: {
            maxSteps: pending.extraStepsRequested,
            maxModelCalls: pending.extraModelCallsRequested ?? 0,
          },
          extraStepsGranted: pending.extraStepsRequested,
          ...(pending.extraModelCallsRequested !== undefined
            ? { extraModelCallsGranted: pending.extraModelCallsRequested }
            : {}),
          continuationCount: nextContinuationState.continuationCount,
          resumeStepAgent: pending.resumeStepAgent,
        },
        input.stepIndex,
      );
      return {
        session: committedSession,
        currentStep: pending.resumeStepAgent,
        continuation: {
          outcome: "granted",
          grantMode: pending.grantMode,
          window: {
            maxSteps: pending.extraStepsRequested,
            maxModelCalls: pending.extraModelCallsRequested ?? 0,
          },
          extraStepsRequested: pending.extraStepsRequested,
          extraStepsGranted: pending.extraStepsRequested,
          ...(pending.extraModelCallsRequested !== undefined
            ? {
                extraModelCallsRequested: pending.extraModelCallsRequested,
                extraModelCallsGranted: pending.extraModelCallsRequested,
              }
            : {}),
          continuationCount: nextContinuationState.continuationCount,
        },
      };
    }

    const declineError = this.mapError(
      createRuntimeFailure(
        "CONTINUATION_DECLINED",
        "User declined to grant more steps.",
        {
          subsystem: "runtime",
          classification: "runtime",
          continuationCount: continuationState.continuationCount,
        },
      ),
    );
    const partialOutput =
      typeof pending.partialAnswer === "string" && pending.partialAnswer.trim().length > 0
        ? {
            message: pending.partialAnswer.trim(),
            data: {
              continuationDeclined: true,
              completedSoFar: pending.completedSoFar,
              blockedOn: pending.blockedOn,
              nextIfApproved: pending.nextIfApproved,
            },
          }
        : undefined;
    await this.deps.store.commitStep({
      runId: input.runId,
      event: input.event,
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.currentStep ?? pending.resumeStepAgent,
      nextStepAgent: pending.resumeStepAgent,
      statePatch: {
        agent: clearRuntimeWaitState({
          ...reactState,
          continuation: undefined,
          assistantText: partialOutput?.message ?? null,
          ...(partialOutput !== undefined ? { finalOutput: partialOutput } : {}),
          terminal: {
            status: partialOutput !== undefined ? "COMPLETED" : "FAILED",
            reasonCode:
              partialOutput !== undefined
                ? "continuation_declined_partial"
                : "CONTINUATION_DECLINED",
            finalStepAgent: pending.resumeStepAgent,
            finalizedAt: new Date().toISOString(),
            ...(partialOutput !== undefined ? { outputRef: "agent.finalOutput" } : {}),
          },
        }),
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });
    await this.appendRunEvent(
      input.runId,
      input.session.sessionId,
      "run.continuation_declined",
      partialOutput !== undefined ? "INFO" : "WARN",
      {
        continuationCount: continuationState.continuationCount,
        ...(partialOutput !== undefined ? { partialAnswer: true } : {}),
      },
      input.stepIndex,
    );
    if (partialOutput !== undefined) {
      const completed = await this.returnTerminal(
        input.runId,
        input.session.sessionId,
        pending.resumeStepAgent,
        {
          status: "COMPLETED",
        },
        [],
        new Guardrails(
          this.resolveGuardrailConfigForSession(continuationState),
          {
            stepsExecuted: continuationState.stepsConsumed,
            modelCalls: continuationState.modelCallsConsumed,
          },
        ),
        0,
        {
          outcome: "declined",
          continuationCount: continuationState.continuationCount,
        },
      );
      if (completed !== undefined) {
        return { output: completed };
      }
    }
    const failed = await this.returnTerminal(
      input.runId,
      input.session.sessionId,
      pending.resumeStepAgent,
      {
        status: "FAILED",
      },
      [declineError],
      new Guardrails(
        this.resolveGuardrailConfigForSession(continuationState),
        {
          stepsExecuted: continuationState.stepsConsumed,
          modelCalls: continuationState.modelCallsConsumed,
        },
      ),
      0,
      {
        outcome: "declined",
        continuationCount: continuationState.continuationCount,
      },
    );
    if (failed !== undefined) {
      return { output: failed };
    }
    return ;
  }

  async maybeRequestContinuation(input: {
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
    let effectiveSession = input.session;
    let progressSeq = input.progressSeq;
    let prior = this.readContinuationState(effectiveSession.state);
    let reactState = asRecord(effectiveSession.state.agent) ?? {};
    const summary = buildContinuationSummary(reactState, input.currentStep);
    const telemetry = input.guardrails.telemetry();
    const stepsConsumed = Math.max(0, telemetry.stepsExecuted - 1);
    const actionModelCalls = telemetry.actionModelCalls ?? telemetry.modelCalls;
    const modelCallsConsumed =
      input.reason === "max_model_calls_continuation"
        ? Math.max(0, actionModelCalls - 1)
        : Math.max(0, actionModelCalls);
    const completedSoFar = [...summary.completedSoFar];
    const nextIfApproved = [...summary.nextIfApproved];
    const resumeStepAgent = prior?.pendingContinuationRequest?.resumeStepAgent ?? input.currentStep;
    const budgetLabel = input.reason === "max_model_calls_continuation" ? "model_calls" : "steps";
    const isMigratingLegacyAccounting = prior?.grantMode === "additive";
    const baseMaxStepsPerRun = isMigratingLegacyAccounting
      ? this.guardrailConfig.maxStepsPerRun
      : prior?.baseMaxStepsPerRun ?? this.guardrailConfig.maxStepsPerRun;
    const baseMaxModelCallsPerRun = isMigratingLegacyAccounting
      ? this.guardrailConfig.maxModelCallsPerRun
      : prior?.baseMaxModelCallsPerRun ?? this.guardrailConfig.maxModelCallsPerRun;
    let question = buildContinuationFallbackQuestion(summary);
    let checkpointSource: "model" | "fallback" = "fallback";
    try {
      const authored = await this.callMaintenanceModel({
        request: buildContinuationCheckpointRequest(
          summary,
          input.event.payload,
          this.checkpointModel,
        ),
        runId: input.runId,
        event: input.event,
        session: effectiveSession,
        currentStep: input.currentStep,
        stepIndex: input.stepIndex,
        guardrails: input.guardrails,
        progressSeq,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      effectiveSession = authored.session;
      progressSeq = authored.progressSeq;
      input.onCheckpointStateUpdated({
        session: effectiveSession,
        progressSeq,
      });
      prior = this.readContinuationState(effectiveSession.state);
      reactState = asRecord(effectiveSession.state.agent) ?? {};
      if (authored.ok === false) {
        if (isRunCancellation(authored.error)) {
          throw authored.error;
        }
      } else {
        const authoredQuestion = readContinuationCheckpointMessage(authored.value);
        if (authoredQuestion !== undefined) {
          question = authoredQuestion;
          checkpointSource = "model";
        }
      }
    } catch (error) {
      if (isRunCancellation(error)) {
        throw error;
      }
      // The continuation wait is more important than presentation generation.
      // A deterministic, context-backed question remains available on every failure path.
    }
    const continuationState: ContinuationState = {
      accountingVersion: prior?.accountingVersion ?? 2,
      baseMaxStepsPerRun,
      grantedExtraSteps: prior?.grantedExtraSteps ?? 0,
      baseMaxModelCallsPerRun,
      grantedExtraModelCalls: prior?.grantedExtraModelCalls ?? 0,
      grantMode: prior?.grantMode ?? "reset_window",
      windowStartSteps: prior?.windowStartSteps ?? 0,
      windowStartModelCalls: prior?.windowStartModelCalls ?? 0,
      continuationCount: prior?.continuationCount ?? 0,
      stepsConsumed,
      modelCallsConsumed,
      pendingContinuationRequest: {
        extraStepsRequested: baseMaxStepsPerRun,
        extraModelCallsRequested: baseMaxModelCallsPerRun,
        grantMode: "reset_window",
        budget: budgetLabel,
        completedSoFar,
        blockedOn: summary.blockedOn,
        nextIfApproved,
        ...(summary.partialAnswer !== undefined ? { partialAnswer: summary.partialAnswer } : {}),
        resumeStepAgent,
        lastStepIndex: input.stepIndex,
        stepsConsumed,
        modelCallsConsumed,
      },
    };
    const waitMetadata = {
      reason: input.reason,
      budget: budgetLabel,
      grantMode: "reset_window",
      window: {
        maxSteps: baseMaxStepsPerRun,
        maxModelCalls: baseMaxModelCallsPerRun,
      },
      extraStepsRequested: baseMaxStepsPerRun,
      extraModelCallsRequested: baseMaxModelCallsPerRun,
      completedSoFar: [...completedSoFar],
      blockedOn: summary.blockedOn,
      nextIfApproved: [...nextIfApproved],
      ...(summary.partialAnswer !== undefined ? { partialAnswer: summary.partialAnswer } : {}),
      continuationCount: continuationState.continuationCount,
      stepsConsumed,
      modelCallsConsumed,
      checkpointSource,
      question,
      resumeReply: "continue",
      prompt: question,
    };
    const waitFor = {
      kind: "user" as const,
      eventType: "user.reply",
      metadata: waitMetadata,
      interaction: {
        version: "v1" as const,
        requestId: `${input.runId}:continuation:${continuationState.continuationCount}`,
        kind: "user_input" as const,
        eventType: "user.reply",
        prompt: question,
        metadata: {
          reason: input.reason,
          budget: budgetLabel,
          grantMode: "reset_window",
          window: {
            maxSteps: baseMaxStepsPerRun,
            maxModelCalls: baseMaxModelCallsPerRun,
          },
          stepsConsumed,
          modelCallsConsumed,
          checkpointSource,
          continuationCount: continuationState.continuationCount,
        },
      },
    };
    await this.deps.store.commitStep({
      runId: input.runId,
      event: {
        id: `${input.runId}:continuation-request`,
        type: "user.reply",
        sessionId: input.session.sessionId,
        payload: {
          reason: input.reason,
        },
      },
      sessionId: effectiveSession.sessionId,
      expectedVersion: effectiveSession.version,
      stepAgent: input.currentStep,
      nextStepAgent: input.currentStep,
      statePatch: {
        agent: {
          ...reactState,
          continuation: serializeContinuationState(continuationState),
          waitingFor: this.waitResumeCoordinator.buildWaitingFor({
            waitFor: {
              ...waitFor,
              metadata: {
                ...waitMetadata,
                completedSoFar: [...waitMetadata.completedSoFar],
                nextIfApproved: [...waitMetadata.nextIfApproved],
              },
            },
            resumeStepAgent,
            reason: input.reason,
            resumeInstruction: "Reply with a continuation instruction to resume.",
          }),
          terminal: {
            status: "WAITING",
            reasonCode: input.reason,
            finalStepAgent: input.currentStep,
            finalizedAt: new Date().toISOString(),
          },
        },
      },
      effects: [],
      emitEvents: [],
      stepIndex: input.stepIndex,
    });
    await this.appendRunEvent(input.runId, effectiveSession.sessionId, "run.continuation_requested", "WARN", {
      reason: input.reason,
      budget: budgetLabel,
      grantMode: "reset_window",
      window: {
        maxSteps: baseMaxStepsPerRun,
        maxModelCalls: baseMaxModelCallsPerRun,
      },
      extraStepsRequested: baseMaxStepsPerRun,
      extraModelCallsRequested: baseMaxModelCallsPerRun,
      checkpointSource,
      continuationCount: continuationState.continuationCount,
      stepsConsumed,
      modelCallsConsumed,
    }, input.stepIndex);
    const finalTelemetry = input.guardrails.telemetry();
    const maintenanceModelCalls = finalTelemetry.maintenanceModelCalls ?? 0;
    return this.returnTerminal(
      input.runId,
      effectiveSession.sessionId,
      input.currentStep,
      {
        status: "WAITING",
        nextStepAgent: input.currentStep,
        waitFor,
      },
      [],
      new Guardrails(
        this.resolveGuardrailConfigForSession(continuationState),
        {
          stepsExecuted: stepsConsumed,
          modelCalls: modelCallsConsumed + maintenanceModelCalls,
          actionModelCalls: modelCallsConsumed,
          maintenanceModelCalls,
        },
      ),
      progressSeq,
      {
        outcome: "requested",
        grantMode: "reset_window",
        window: {
          maxSteps: baseMaxStepsPerRun,
          maxModelCalls: baseMaxModelCallsPerRun,
        },
        extraStepsRequested: baseMaxStepsPerRun,
        extraModelCallsRequested: baseMaxModelCallsPerRun,
        continuationCount: continuationState.continuationCount,
      },
    );
  }

  private buildFreshTurnReactState(
    reactState: Record<string, unknown>,
    clearContinuation: boolean,
    eventPayload: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (shouldPreserveBlockedResumeLineageForFreshTurn(reactState, eventPayload)) {
      return ;
    }
    const execState = asRecord(reactState.exec);
    const hasResidualExecState =
      execState !== undefined &&
      (
        execState.substate !== undefined ||
        execState.pendingEffectKey !== undefined ||
        execState.pendingEffectType !== undefined ||
        execState.pendingApproval !== undefined ||
        execState.pendingBatch !== undefined ||
        execState.pendingToolCall !== undefined
      );
    const hasResidualExecutableIntentState =
      reactState.toolIntent !== undefined ||
      reactState.compiledIntent !== undefined ||
      reactState.requiredCapabilities !== undefined ||
      reactState.activeExecutableIntent !== undefined;
    const hasResidualPerTurnNarrativeState = ALL_FRESH_TURN_AGENT_CONTROL_KEYS.some((key) =>
      reactState[key] !== undefined
    );
    const hasResidualControlState =
      clearContinuation ||
      reactState.waitingFor !== undefined ||
      reactState.terminal !== undefined ||
      reactState.nextAction !== undefined ||
      reactState.commandBatch !== undefined ||
      reactState.pendingContinuationOffer !== undefined ||
      reactState.finalOutput !== undefined ||
      reactState.finalized !== undefined ||
      reactState.goalMet !== undefined ||
      reactState.phase !== undefined ||
      reactState.workItem !== undefined ||
      reactState.loopGuard !== undefined ||
      hasResidualPerTurnNarrativeState ||
      hasResidualExecutableIntentState ||
      hasResidualExecState;
    if (hasResidualControlState === false) {
      return ;
    }

    return clearRuntimeWaitState({
      ...reactState,
      ...this.clearFreshTurnReactControlState(),
      ...(clearContinuation ? { continuation: undefined } : {}),
      terminal: undefined,
      nextAction: undefined,
      commandBatch: undefined,
      pendingContinuationOffer: undefined,
      assistantText: null,
      finalOutput: undefined,
      finalized: undefined,
      goalMet: undefined,
      phase: undefined,
      workItem: undefined,
      loopGuard: undefined,
      toolIntent: undefined,
      compiledIntent: undefined,
      requiredCapabilities: undefined,
      activeExecutableIntent: undefined,
      exec: {
        ...(execState ?? {}),
        substate: undefined,
        pendingEffectKey: undefined,
        pendingEffectType: undefined,
        pendingApproval: undefined,
        pendingBatch: undefined,
        pendingToolCall: undefined,
      },
    }, {
      clearConsumedAskUserAction: true,
    });
  }

  private clearFreshTurnReactControlState(): Record<string, undefined> {
    return Object.fromEntries(
      ALL_FRESH_TURN_AGENT_CONTROL_KEYS.map((key) => [key, undefined]),
    );
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

  private assertContinuationGrantState(
    session: SessionRecord,
    pending: ContinuationRequestState,
    nextContinuationState: ContinuationState,
  ): void {
    const continuationState = this.readContinuationState(session.state);
    const reactState = asRecord(session.state.agent) ?? {};
    if (
      continuationState?.grantedExtraSteps !== nextContinuationState.grantedExtraSteps ||
      continuationState?.accountingVersion !== nextContinuationState.accountingVersion ||
      continuationState?.grantedExtraModelCalls
        !== nextContinuationState.grantedExtraModelCalls ||
      continuationState?.grantMode !== nextContinuationState.grantMode ||
      continuationState?.windowStartSteps !== nextContinuationState.windowStartSteps ||
      continuationState?.windowStartModelCalls !== nextContinuationState.windowStartModelCalls ||
      continuationState?.continuationCount !== nextContinuationState.continuationCount ||
      continuationState?.modelCallsConsumed !== nextContinuationState.modelCallsConsumed ||
      continuationState?.pendingContinuationRequest !== undefined ||
      reactState.waitingFor !== undefined ||
      reactState.terminal !== undefined ||
      session.currentStepAgent !== pending.resumeStepAgent
    ) {
      throw createRuntimeFailure(
        "CONTINUATION_GRANT_STATE_INVALID",
        "Continuation approval was accepted, but the persisted continuation state was not advanced.",
        {
          sessionId: session.sessionId,
          expectedResumeStepAgent: pending.resumeStepAgent,
          actualResumeStepAgent: session.currentStepAgent,
          expectedGrantedExtraSteps: nextContinuationState.grantedExtraSteps,
          actualGrantedExtraSteps: continuationState?.grantedExtraSteps,
          expectedAccountingVersion: nextContinuationState.accountingVersion,
          actualAccountingVersion: continuationState?.accountingVersion,
          expectedGrantedExtraModelCalls: nextContinuationState.grantedExtraModelCalls,
          actualGrantedExtraModelCalls: continuationState?.grantedExtraModelCalls,
          expectedGrantMode: nextContinuationState.grantMode,
          actualGrantMode: continuationState?.grantMode,
          expectedWindowStartSteps: nextContinuationState.windowStartSteps,
          actualWindowStartSteps: continuationState?.windowStartSteps,
          expectedWindowStartModelCalls: nextContinuationState.windowStartModelCalls,
          actualWindowStartModelCalls: continuationState?.windowStartModelCalls,
          expectedModelCallsConsumed: nextContinuationState.modelCallsConsumed,
          actualModelCallsConsumed: continuationState?.modelCallsConsumed,
          expectedContinuationCount: nextContinuationState.continuationCount,
          actualContinuationCount: continuationState?.continuationCount,
          hasPendingContinuationRequest: continuationState?.pendingContinuationRequest !== undefined,
          hasWaitState: reactState.waitingFor !== undefined,
          hasTerminalState: reactState.terminal !== undefined,
        },
      );
    }
  }

  private async readCommittedContinuationSession(committedSession: SessionRecord): Promise<SessionRecord> {
    const persistedSession = await this.deps.store.getSession(committedSession.sessionId);
    if (persistedSession === null || persistedSession.version < committedSession.version) {
      throw createRuntimeFailure(
        "CONTINUATION_GRANT_STATE_INVALID",
        "Continuation approval was accepted, but the committed session state could not be verified.",
        {
          sessionId: committedSession.sessionId,
          expectedVersion: committedSession.version,
          actualVersion: persistedSession?.version,
          sessionMissing: persistedSession === null,
        },
      );
    }
    return persistedSession;
  }
}

function buildContinuationSummary(
  reactState: Record<string, unknown>,
  currentStep: string,
): {
  objective?: string | undefined;
  completedSoFar: string[];
  remainingWork: string[];
  checkpointNextActions: string[];
  blockedOn: string;
  nextIfApproved: string[];
  partialAnswer?: string | undefined;
} {
  const completedSoFar: string[] = [];
  const visibleTodos = normalizeVisibleTodoState(reactState.visibleTodos);
  const objective = visibleTodos?.objective ?? readActiveTaskGoalFromState(reactState);
  appendUniqueLines(
    completedSoFar,
    visibleTodos?.items
      .filter((item) => item.status === "done")
      .slice(-2)
      .map((item) => item.note ?? item.text) ?? [],
  );
  const lastObservation = latestObservationSummary(reactState.observations);
  if (lastObservation.trim().length > 0) {
    completedSoFar.push(lastObservation.trim());
  }
  const lastActionResult = asRecord(reactState.lastActionResult);
  const lastToolName = asString(lastActionResult?.toolName) ?? asString(lastActionResult?.name);
  const structuredProgress = readStructuredContinuationProgress(reactState);
  appendUniqueLines(completedSoFar, structuredProgress);
  if (lastToolName !== undefined && structuredProgress.length === 0) {
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

  const nextAction = asRecord(reactState.nextAction);
  const remainingWork = visibleTodos?.items
    .filter((item) => item.status !== "done")
    .slice(0, 3)
    .map((item) => item.note ?? item.text) ?? [];
  const checkpointNextActions = [...remainingWork];
  appendUniqueLines(checkpointNextActions, buildCheckpointNextActions(nextAction, currentStep));
  const nextIfApproved = [...remainingWork];
  appendUniqueLines(nextIfApproved, buildContinuationNextActions(nextAction, currentStep));
  const partialAnswer = buildContinuationPartialAnswer(
    asString(reactState.assistantText),
    lastObservation,
    completedSoFar,
  );
  return {
    ...(objective !== undefined && objective.trim().length > 0
      ? { objective: objective.trim() }
      : {}),
    completedSoFar: completedSoFar.slice(0, 3),
    remainingWork,
    checkpointNextActions: checkpointNextActions.slice(0, 3),
    blockedOn:
      "The current work window ended before I could finish the remaining work.",
    nextIfApproved: nextIfApproved.slice(0, 3),
    ...(partialAnswer !== undefined ? { partialAnswer } : {}),
  };
}

function buildContinuationFallbackQuestion(summary: {
  objective?: string | undefined;
  completedSoFar: string[];
  remainingWork: string[];
  checkpointNextActions: string[];
  nextIfApproved: string[];
}): string {
  const objective = summary.objective?.trim();
  const next = summary.checkpointNextActions[0]?.trim();
  if (objective !== undefined && next !== undefined) {
    const candidate = boundContinuationQuestion(
      `I’ve made progress on ${stripTrailingPunctuation(objective)}. Next up: ${ensureTrailingPunctuation(next)} Want me to keep going?`,
    );
    return isValidContinuationCheckpointMessage(candidate)
      ? candidate
      : "I’m not finished yet, but I can continue from where I left off. Want me to keep going?";
  }
  if (next !== undefined) {
    const candidate = boundContinuationQuestion(
      `I’ve made progress on this task. Next up: ${ensureTrailingPunctuation(next)} Want me to keep going?`,
    );
    return isValidContinuationCheckpointMessage(candidate)
      ? candidate
      : "I’m not finished yet, but I can continue from where I left off. Want me to keep going?";
  }
  return "I’m not finished yet, but I can continue from where I left off. Want me to keep going?";
}

function buildContinuationCheckpointRequest(
  summary: {
    objective?: string | undefined;
    completedSoFar: string[];
    remainingWork: string[];
    checkpointNextActions: string[];
    nextIfApproved: string[];
  },
  eventPayload: Record<string, unknown>,
  configuredCheckpointModel: string | undefined,
): ModelRequest {
  const context = {
    objective: boundCheckpointContext(summary.objective),
    completedSoFar: summary.completedSoFar
      .map((value) => boundCheckpointContext(value))
      .filter((value): value is string => value !== undefined),
    remainingWork: summary.remainingWork
      .map((value) => boundCheckpointContext(value))
      .filter((value): value is string => value !== undefined),
    nextActions: summary.checkpointNextActions
      .map((value) => boundCheckpointContext(value))
      .filter((value): value is string => value !== undefined),
  };
  const checkpointModel =
    configuredCheckpointModel ?? readContinuationCheckpointModel(eventPayload);
  return {
    ...(checkpointModel !== undefined
      ? { model: checkpointModel }
      : {}),
    input: {
      version: "continuation_checkpoint_v1",
      context,
    },
    messages: [
      {
        role: "system",
        content: [
          "You write Kestrel's brief user-facing continuation checkpoint.",
          "Use only the supplied runtime facts; do not invent completed work, blockers, or results.",
          "Write one to three natural sentences in the first person.",
          "State concrete progress and identify the next remaining work.",
          "End with a direct question that uses either 'continue' or 'keep going'.",
          "Do not mention model calls, steps, counters, budgets, limits, internal agents, or runtime machinery.",
          "Return only JSON matching the response schema.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          "Write the continuation checkpoint from this bounded runtime context:",
          JSON.stringify(context),
        ].join("\n"),
      },
    ],
    responseFormat: "json",
    responseSchema: CONTINUATION_CHECKPOINT_SCHEMA,
    reasoning: { mode: "off" },
    providerOptions: {
      openrouter: {
        endpoint: "chat",
        toolChoice: "none",
        responseSchemaName: "kestrel_continuation_checkpoint",
      },
      openai: {
        toolChoice: "none",
        responseSchemaName: "kestrel_continuation_checkpoint",
      },
      anthropic: {
        toolChoice: "none",
        responseSchemaName: "kestrel_continuation_checkpoint",
      },
    },
    metadata: {
      phase: "runtime.continuation_checkpoint",
      modelRole: "continuation_checkpoint",
      modelBudgetClass: "maintenance",
    },
  };
}

function readContinuationCheckpointMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  let root: unknown = record?.output ?? value;
  if (record?.output === undefined && typeof record?.text === "string") {
    try {
      root = JSON.parse(record.text);
    } catch {
      return ;
    }
  }
  const rootRecord = asRecord(root);
  if (
    rootRecord === undefined ||
    Object.keys(rootRecord).some((key) => key !== "message")
  ) {
    return ;
  }
  const message = asString(rootRecord.message)?.trim();
  if (
    message === undefined ||
    message.length === 0 ||
    message.length > CONTINUATION_CHECKPOINT_MAX_CHARS ||
    isValidContinuationCheckpointMessage(message) === false
  ) {
    return ;
  }
  return message;
}

function isValidContinuationCheckpointMessage(message: string): boolean {
  if (
    CONTINUATION_CHECKPOINT_FORBIDDEN_LANGUAGE.test(message) ||
    message.endsWith("?") === false
  ) {
    return false;
  }
  const sentenceCount = message.match(/[.!?](?=\s|$)/gu)?.length ?? 0;
  if (sentenceCount < 1 || sentenceCount > 3) {
    return false;
  }
  const futureWork = CONTINUATION_CHECKPOINT_FUTURE_WORK.exec(message);
  if (futureWork?.index === undefined) {
    return false;
  }
  const progressText = message.slice(0, futureWork.index).trim();
  if (progressText.length === 0 || progressText.endsWith("?")) {
    return false;
  }
  const finalSentence = message.split(/(?<=[.!?])\s+/u).at(-1) ?? message;
  const invitation = CONTINUATION_CHECKPOINT_INVITATION.exec(finalSentence);
  if (invitation?.index === undefined) {
    return false;
  }
  const invitationIndex = message.length - finalSentence.length + invitation.index;
  return futureWork.index < invitationIndex;
}

function isRunCancellation(error: unknown): boolean {
  return error instanceof RunCancelledError || asString(asRecord(error)?.code) === "RUN_CANCELLED";
}

function readContinuationCheckpointModel(eventPayload: Record<string, unknown>): string | undefined {
  const runtimeAssembly =
    asRecord(asRecord(eventPayload.metadata)?.runtimeAssembly) ??
    asRecord(eventPayload.runtimeAssembly);
  const stageConfig = asRecord(runtimeAssembly?.agentStageConfig);
  const modelByStage = asRecord(stageConfig?.modelByStage);
  return asString(modelByStage?.["agent.maintenance"]) ?? asString(runtimeAssembly?.model);
}

function boundCheckpointContext(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return ;
  }
  if (trimmed.length <= CONTINUATION_CHECKPOINT_CONTEXT_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, CONTINUATION_CHECKPOINT_CONTEXT_MAX_CHARS - 1).trimEnd()}…`;
}

function boundContinuationQuestion(value: string): string {
  if (value.length <= 600) {
    return value;
  }
  return `${value.slice(0, 596).trimEnd()}…`;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/u, "");
}

function ensureTrailingPunctuation(value: string): string {
  return /[.!?]$/u.test(value) ? value : `${value}.`;
}

function parseContinuationRequestState(
  value: Record<string, unknown> | undefined,
): ContinuationRequestState | undefined {
  if (value === undefined) {
    return ;
  }
  const resumeStepAgent =
    typeof value.resumeStepAgent === "string" && value.resumeStepAgent.trim().length > 0
      ? value.resumeStepAgent
      : undefined;
  if (resumeStepAgent === undefined) {
    return ;
  }
  return {
    extraStepsRequested:
      readMaybeNumber(value.extraStepsRequested) ?? LEGACY_CONTINUATION_EXTRA_STEPS,
    ...(readMaybeNumber(value.extraModelCallsRequested) !== undefined
      ? { extraModelCallsRequested: readMaybeNumber(value.extraModelCallsRequested) }
      : {}),
    grantMode: value.grantMode === "reset_window" ? "reset_window" : "additive",
    budget: value.budget === "model_calls" ? "model_calls" : "steps",
    completedSoFar: readStringArray(value.completedSoFar),
    blockedOn:
      typeof value.blockedOn === "string" && value.blockedOn.trim().length > 0
        ? value.blockedOn.trim()
        : "Need more steps to continue.",
    nextIfApproved: readStringArray(value.nextIfApproved),
    ...(typeof value.partialAnswer === "string" && value.partialAnswer.trim().length > 0
      ? { partialAnswer: value.partialAnswer.trim() }
      : {}),
    resumeStepAgent,
    lastStepIndex: readMaybeNumber(value.lastStepIndex) ?? 0,
    stepsConsumed: readMaybeNumber(value.stepsConsumed) ?? 0,
    modelCallsConsumed: readMaybeNumber(value.modelCallsConsumed) ?? 0,
  };
}

function serializeContinuationState(value: ContinuationState): Record<string, unknown> {
  return {
    accountingVersion: value.accountingVersion,
    baseMaxStepsPerRun: value.baseMaxStepsPerRun,
    grantedExtraSteps: value.grantedExtraSteps,
    baseMaxModelCallsPerRun: value.baseMaxModelCallsPerRun,
    grantedExtraModelCalls: value.grantedExtraModelCalls,
    grantMode: value.grantMode,
    windowStartSteps: value.windowStartSteps,
    windowStartModelCalls: value.windowStartModelCalls,
    continuationCount: value.continuationCount,
    stepsConsumed: value.stepsConsumed,
    modelCallsConsumed: value.modelCallsConsumed,
    ...(value.pendingContinuationRequest !== undefined
      ? {
          pendingContinuationRequest: {
            extraStepsRequested: value.pendingContinuationRequest.extraStepsRequested,
            ...(value.pendingContinuationRequest.extraModelCallsRequested !== undefined
              ? { extraModelCallsRequested: value.pendingContinuationRequest.extraModelCallsRequested }
              : {}),
            grantMode: value.pendingContinuationRequest.grantMode,
            budget: value.pendingContinuationRequest.budget,
            completedSoFar: value.pendingContinuationRequest.completedSoFar,
            blockedOn: value.pendingContinuationRequest.blockedOn,
            nextIfApproved: value.pendingContinuationRequest.nextIfApproved,
            ...(value.pendingContinuationRequest.partialAnswer !== undefined
              ? { partialAnswer: value.pendingContinuationRequest.partialAnswer }
              : {}),
            resumeStepAgent: value.pendingContinuationRequest.resumeStepAgent,
            lastStepIndex: value.pendingContinuationRequest.lastStepIndex,
            stepsConsumed: value.pendingContinuationRequest.stepsConsumed,
            modelCallsConsumed: value.pendingContinuationRequest.modelCallsConsumed,
          },
        }
      : {}),
  };
}

function readContinuationWaitReason(reactState: Record<string, unknown>): string | undefined {
  const waitState = readActiveWaitState(reactState);
  const waitReason = readMaybeContinuationReason(waitState?.metadata);
  if (waitReason !== undefined) {
    return waitReason;
  }

  const terminal = asRecord(reactState.terminal);
  return typeof terminal?.reasonCode === "string" ? terminal.reasonCode : undefined;
}

function isContinuationWaitReason(value: string | undefined): value is ContinuationWaitReason {
  return value === "max_steps_continuation" || value === "max_model_calls_continuation";
}

function readMaybeContinuationReason(value: unknown): string | undefined {
  if (typeof value === "string") {
    return ;
  }
  const record = asRecord(value);
  return typeof record?.reason === "string" ? record.reason : undefined;
}

function shouldPreserveBlockedResumeLineageForFreshTurn(
  reactState: Record<string, unknown>,
  eventPayload: Record<string, unknown>,
): boolean {
  if (eventPayload.resumeBlockedRun !== true) {
    return false;
  }
  const activeExecutableIntent = asRecord(reactState.activeExecutableIntent);
  const lineage = asRecord(activeExecutableIntent?.lineage);
  if (lineage === undefined) {
    return false;
  }
  const blockedWaitReason =
    typeof lineage.blockedWaitReason === "string" ? lineage.blockedWaitReason : undefined;
  const currentWaitReason = readContinuationWaitReason(reactState);
  if (
    blockedWaitReason !== "route_mode_blocked" &&
    blockedWaitReason !== "planner_mode_blocked" &&
    blockedWaitReason !== "acter_mode_blocked"
  ) {
    return false;
  }
  if (currentWaitReason !== undefined && currentWaitReason !== blockedWaitReason) {
    return false;
  }
  const resumeEventType =
    typeof lineage.resumeEventType === "string" ? lineage.resumeEventType : undefined;
  return resumeEventType === undefined || resumeEventType === "user.reply";
}

function isFreshTurnResetEvent(event: RuntimeEvent): boolean {
  return event.type === "user.message" || event.type === "operator.steer";
}

function buildContinuationNextActions(
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
        const record = asRecord(item);
        return typeof record?.name === "string" ? record.name : undefined;
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

function buildCheckpointNextActions(
  nextAction: Record<string, unknown> | undefined,
  currentStep: string,
): string[] {
  if (nextAction === undefined) {
    return [];
  }
  const authoredSummary =
    asString(nextAction.summary) ??
    asString(nextAction.description) ??
    asString(nextAction.instruction);
  if (authoredSummary !== undefined && authoredSummary.trim().length > 0) {
    return [authoredSummary.trim()];
  }
  return buildContinuationNextActions(nextAction, currentStep);
}

function buildContinuationPartialAnswer(
  assistantText: string | undefined,
  lastObservation: string,
  completedSoFar: string[],
): string | undefined {
  if (assistantText !== undefined && assistantText.trim().length > 0) {
    return assistantText.trim();
  }
  if (completedSoFar.length > 1) {
    return `Current verified progress so far:\n- ${completedSoFar.join("\n- ")}`;
  }
  if (lastObservation.trim().length > 0) {
    return lastObservation.trim();
  }
  if (completedSoFar.length === 0) {
    return ;
  }
  return `Current verified progress so far:\n- ${completedSoFar.join("\n- ")}`;
}

function readStructuredContinuationProgress(reactState: Record<string, unknown>): string[] {
  const progress: string[] = [];
  appendUniqueLines(progress, readDevShellProcessProgress(reactState));
  appendUniqueLines(progress, readToolEvidenceProgress(reactState));
  appendUniqueLines(progress, readRuntimeEvidenceTokenProgress(reactState));
  return progress;
}

function readDevShellProcessProgress(reactState: Record<string, unknown>): string[] {
  const exec = asRecord(reactState.exec);
  const devShell = asRecord(exec?.devShell);
  const processes = asRecord(devShell?.processes);
  if (processes === undefined) {
    return [];
  }

  const entries = Object.values(processes)
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value !== undefined);
  if (entries.length === 0) {
    return [];
  }

  const statusCounts = new Map<string, number>();
  for (const entry of entries) {
    const status = asString(entry.status);
    if (status !== undefined) {
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    }
  }

  const lines: string[] = [];
  const statusLine = formatDevShellStatusCounts(statusCounts);
  if (statusLine !== undefined) {
    lines.push(statusLine);
  }

  const latestProcess = selectLatestDevShellProcess(entries);
  const latestLine = latestProcess === undefined ? undefined : formatLatestDevShellProcess(latestProcess);
  if (latestLine !== undefined) {
    lines.push(latestLine);
  }
  return lines;
}

function formatDevShellStatusCounts(statusCounts: Map<string, number>): string | undefined {
  const orderedStatuses = ["COMPLETED", "FAILED", "STOPPED", "LOST", "RUNNING"];
  const parts = orderedStatuses
    .map((status) => {
      const count = statusCounts.get(status) ?? 0;
      return count > 0 ? `${count} ${formatStatusLabel(status)}` : undefined;
    })
    .filter((part): part is string => part !== undefined);
  if (parts.length === 0) {
    return ;
  }
  return `Dev shell process state: ${parts.join(", ")}.`;
}

function selectLatestDevShellProcess(
  entries: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  let selected: Record<string, unknown> | undefined;
  let selectedTimestamp = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const timestamp = readLatestTimestamp(entry);
    if (selected === undefined || timestamp >= selectedTimestamp) {
      selected = entry;
      selectedTimestamp = timestamp;
    }
  }
  return selected;
}

function readLatestTimestamp(entry: Record<string, unknown>): number {
  const values = [
    entry.updatedAt,
    entry.completedAt,
    entry.startedAt,
    entry.submittedAt,
    entry.lastStdinAt,
  ];
  const parsed = values
    .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  return parsed.length > 0 ? Math.max(...parsed) : Number.NEGATIVE_INFINITY;
}

function formatLatestDevShellProcess(entry: Record<string, unknown>): string | undefined {
  const command = asString(entry.command);
  const status = asString(entry.status);
  if (command === undefined && status === undefined) {
    return ;
  }
  const statusLabel = status === undefined ? "recorded" : formatStatusLabel(status);
  const exitCode = readMaybeNumber(entry.exitCode);
  const exitText = exitCode === undefined ? "" : ` (exit ${exitCode})`;
  if (command === undefined) {
    return `Latest dev shell command ${statusLabel}${exitText}.`;
  }
  return `Latest dev shell command ${statusLabel}: ${summarizeInline(command)}${exitText}.`;
}

function readToolEvidenceProgress(reactState: Record<string, unknown>): string[] {
  const toolEvidence = asRecord(reactState.toolEvidenceSummary);
  if (toolEvidence === undefined) {
    return [];
  }
  const successful = formatToolCallCounts(toolEvidence.successfulCalls);
  const failed = formatToolCallCounts(toolEvidence.failedCalls);
  if (successful === undefined && failed === undefined) {
    return [];
  }
  const parts = [
    successful === undefined ? undefined : `${successful} succeeded`,
    failed === undefined ? undefined : `${failed} failed`,
  ].filter((part): part is string => part !== undefined);
  return [`Tool evidence: ${parts.join("; ")}.`];
}

function formatToolCallCounts(value: unknown): string | undefined {
  if (Array.isArray(value) === false) {
    return ;
  }
  const parts = value
    .map((entry) => {
      const record = asRecord(entry);
      const toolName = asString(record?.toolName);
      const count = readMaybeNumber(record?.count);
      return toolName !== undefined && count !== undefined && count > 0
        ? `${toolName} x${count}`
        : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .slice(0, 3);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function readRuntimeEvidenceTokenProgress(reactState: Record<string, unknown>): string[] {
  const runtimeEvidence = asRecord(reactState.runtimeEvidenceSummary);
  const supportedTokens = readStringArray(runtimeEvidence?.supportedTokens);
  if (supportedTokens.length === 0) {
    return [];
  }

  const files = supportedTokens
    .filter((token) => token.startsWith("file:"))
    .map((token) => token.slice("file:".length));
  const checks = supportedTokens
    .filter((token) => token.startsWith("check:"))
    .map((token) => token.slice("check:".length));

  const lines: string[] = [];
  const fileSummary = summarizeEvidenceItems(files, 3);
  if (fileSummary !== undefined) {
    lines.push(`Recorded file evidence: ${fileSummary}.`);
  }
  const checkSummary = summarizeEvidenceItems(checks, 2);
  if (checkSummary !== undefined) {
    lines.push(`Recorded check evidence: ${checkSummary}.`);
  }
  return lines;
}

function summarizeEvidenceItems(items: string[], limit: number): string | undefined {
  const normalized = items
    .map((item) => summarizeInline(item, 80))
    .filter((item) => item.length > 0);
  if (normalized.length === 0) {
    return ;
  }
  const visible = normalized.slice(0, limit);
  const hiddenCount = normalized.length - visible.length;
  return hiddenCount > 0 ? `${visible.join(", ")} and ${hiddenCount} more` : visible.join(", ");
}

function appendUniqueLines(target: string[], lines: string[]): void {
  const existing = new Set(target);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && existing.has(trimmed) === false) {
      target.push(trimmed);
      existing.add(trimmed);
    }
  }
}

function formatStatusLabel(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

function summarizeInline(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function latestObservationSummary(value: unknown): string {
  if (Array.isArray(value) === false || value.length === 0) {
    return "";
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(value[index]);
    if (typeof entry?.summary === "string" && entry.summary.trim().length > 0) {
      return entry.summary.trim();
    }
  }
  return "";
}

function readCapabilityClassesFromFeedback(reactState: Record<string, unknown>): string[] {
  const feedback = asRecord(reactState.postToolVerification);
  const capabilityEvidence = asRecord(reactState.capabilityEvidence);
  const classes = [
    ...(Array.isArray(feedback?.capabilityClasses) ? feedback.capabilityClasses : []),
    ...(Array.isArray(capabilityEvidence?.classes) ? capabilityEvidence.classes : []),
  ];
  return [
    ...new Set(
      classes
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ];
}

function readMaybeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
