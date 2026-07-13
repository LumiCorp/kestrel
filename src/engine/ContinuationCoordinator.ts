import type { RunEventType, RuntimeError } from "../kestrel/contracts/base.js";
import type { RuntimeEvent } from "../kestrel/contracts/events.js";
import type { GuardrailConfig, NormalizedOutput, RuntimeDependencies, Transition } from "../kestrel/contracts/execution.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { clearRuntimeWaitState, readActiveWaitState } from "../runtime/waitState.js";
import {
  classifyUserReplyIntent,
  isHighConfidenceContinuation,
} from "../runtime/userReplyIntent.js";
import { Guardrails } from "./Guardrails.js";
import { WaitResumeCoordinator } from "./WaitResumeCoordinator.js";

const CONTINUATION_EXTRA_STEPS = 50;
const CONTINUATION_EXTRA_MODEL_CALLS = 50;

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

export interface ContinuationRequestState {
  extraStepsRequested: number;
  extraModelCallsRequested?: number | undefined;
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
  baseMaxStepsPerRun: number;
  grantedExtraSteps: number;
  baseMaxModelCallsPerRun: number;
  grantedExtraModelCalls: number;
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
  returnTerminal: ReturnTerminal;
}

export class ContinuationCoordinator {
  private readonly deps: ContinuationCoordinatorDependencies["runtimeDeps"];
  private readonly guardrailConfig: GuardrailConfig;
  private readonly waitResumeCoordinator: WaitResumeCoordinator;
  private readonly appendRunEvent: ContinuationCoordinatorDependencies["appendRunEvent"];
  private readonly mapError: ContinuationCoordinatorDependencies["mapError"];
  private readonly returnTerminal: ReturnTerminal;

  constructor(deps: ContinuationCoordinatorDependencies) {
    this.deps = deps.runtimeDeps;
    this.guardrailConfig = deps.guardrailConfig;
    this.waitResumeCoordinator = deps.waitResumeCoordinator;
    this.appendRunEvent = deps.appendRunEvent;
    this.mapError = deps.mapError;
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
        continuationState.baseMaxStepsPerRun + continuationState.grantedExtraSteps,
      maxModelCallsPerRun:
        continuationState.baseMaxModelCallsPerRun
        + continuationState.grantedExtraModelCalls,
    };
  }

  readContinuationState(
    sessionState: Record<string, unknown>,
  ): ContinuationState | undefined {
    const react = asRecord(sessionState.agent);
    const continuation = asRecord(react?.continuation);
    if (continuation === undefined) {
      return undefined;
    }
    return {
      baseMaxStepsPerRun:
        readMaybeNumber(continuation.baseMaxStepsPerRun) ?? this.guardrailConfig.maxStepsPerRun,
      grantedExtraSteps: readMaybeNumber(continuation.grantedExtraSteps) ?? 0,
      baseMaxModelCallsPerRun:
        readMaybeNumber(continuation.baseMaxModelCallsPerRun)
        ?? this.guardrailConfig.maxModelCallsPerRun,
      grantedExtraModelCalls: readMaybeNumber(continuation.grantedExtraModelCalls) ?? 0,
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
    const waitReason = readContinuationWaitReason(reactState);
    if (continuationState !== undefined && isContinuationWaitReason(waitReason)) {
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
      return undefined;
    }
    const reactState = asRecord(input.session.state.agent) ?? {};
    const waitReason = readContinuationWaitReason(reactState);
    const reply =
      asString(input.event.payload.message) ??
      asString(input.event.payload.text) ??
      "";
    if (isContinuationWaitReason(waitReason) === false) {
      return undefined;
    }

    const continuationState = this.readContinuationState(input.session.state);
    const pending = continuationState?.pendingContinuationRequest;
    if (continuationState === undefined || pending === undefined) {
      return undefined;
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
      const nextContinuationState: ContinuationState = {
        baseMaxStepsPerRun: continuationState.baseMaxStepsPerRun,
        grantedExtraSteps:
          continuationState.grantedExtraSteps + pending.extraStepsRequested,
        baseMaxModelCallsPerRun: continuationState.baseMaxModelCallsPerRun,
        grantedExtraModelCalls:
          continuationState.grantedExtraModelCalls + (pending.extraModelCallsRequested ?? 0),
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
    return undefined;
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
  }): Promise<NormalizedOutput | undefined> {
    const prior = this.readContinuationState(input.session.state);
    const reactState = asRecord(input.session.state.agent) ?? {};
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
    const extraModelCallsRequested =
      input.reason === "max_model_calls_continuation" ? CONTINUATION_EXTRA_MODEL_CALLS : undefined;
    const continuationState: ContinuationState = {
      baseMaxStepsPerRun: prior?.baseMaxStepsPerRun ?? this.guardrailConfig.maxStepsPerRun,
      grantedExtraSteps: prior?.grantedExtraSteps ?? 0,
      baseMaxModelCallsPerRun:
        prior?.baseMaxModelCallsPerRun ?? this.guardrailConfig.maxModelCallsPerRun,
      grantedExtraModelCalls: prior?.grantedExtraModelCalls ?? 0,
      continuationCount: prior?.continuationCount ?? 0,
      stepsConsumed,
      modelCallsConsumed,
      pendingContinuationRequest: {
        extraStepsRequested: CONTINUATION_EXTRA_STEPS,
        ...(extraModelCallsRequested !== undefined ? { extraModelCallsRequested } : {}),
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
      extraStepsRequested: CONTINUATION_EXTRA_STEPS,
      ...(extraModelCallsRequested !== undefined ? { extraModelCallsRequested } : {}),
      completedSoFar: [...completedSoFar],
      blockedOn: summary.blockedOn,
      nextIfApproved: [...nextIfApproved],
      ...(summary.partialAnswer !== undefined ? { partialAnswer: summary.partialAnswer } : {}),
      continuationCount: continuationState.continuationCount,
      question:
        input.reason === "max_model_calls_continuation"
          ? `Should I continue this run with ${CONTINUATION_EXTRA_MODEL_CALLS} more model calls and ${CONTINUATION_EXTRA_STEPS} more steps?`
          : `Should I continue this run with ${CONTINUATION_EXTRA_STEPS} more steps?`,
      resumeReply: "continue",
      prompt:
        input.reason === "max_model_calls_continuation"
          ? "I hit the current model-call budget before finishing this task."
          : "I hit the current step budget before finishing this task.",
    };
    const waitFor = {
      kind: "user" as const,
      eventType: "user.reply",
      metadata: waitMetadata,
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
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
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
    await this.appendRunEvent(input.runId, input.session.sessionId, "run.continuation_requested", "WARN", {
      reason: input.reason,
      budget: budgetLabel,
      extraStepsRequested: CONTINUATION_EXTRA_STEPS,
      ...(extraModelCallsRequested !== undefined ? { extraModelCallsRequested } : {}),
      continuationCount: continuationState.continuationCount,
      stepsConsumed,
      modelCallsConsumed,
    }, input.stepIndex);
    return this.returnTerminal(
      input.runId,
      input.session.sessionId,
      input.currentStep,
      {
        status: "WAITING",
        nextStepAgent: input.currentStep,
        waitFor,
      },
      [],
      new Guardrails(
        this.resolveGuardrailConfigForSession(continuationState),
        { stepsExecuted: stepsConsumed, modelCalls: modelCallsConsumed },
      ),
      input.progressSeq,
      {
        outcome: "requested",
        extraStepsRequested: CONTINUATION_EXTRA_STEPS,
        ...(extraModelCallsRequested !== undefined ? { extraModelCallsRequested } : {}),
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
      return undefined;
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
      return undefined;
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
      continuationState?.grantedExtraModelCalls
        !== nextContinuationState.grantedExtraModelCalls ||
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
          expectedGrantedExtraModelCalls: nextContinuationState.grantedExtraModelCalls,
          actualGrantedExtraModelCalls: continuationState?.grantedExtraModelCalls,
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
  const nextIfApproved = buildContinuationNextActions(nextAction, currentStep);
  const partialAnswer = buildContinuationPartialAnswer(
    asString(reactState.assistantText),
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

function parseContinuationRequestState(
  value: Record<string, unknown> | undefined,
): ContinuationRequestState | undefined {
  if (value === undefined) {
    return undefined;
  }
  const resumeStepAgent =
    typeof value.resumeStepAgent === "string" && value.resumeStepAgent.trim().length > 0
      ? value.resumeStepAgent
      : undefined;
  if (resumeStepAgent === undefined) {
    return undefined;
  }
  return {
    extraStepsRequested: readMaybeNumber(value.extraStepsRequested) ?? CONTINUATION_EXTRA_STEPS,
    ...(readMaybeNumber(value.extraModelCallsRequested) !== undefined
      ? { extraModelCallsRequested: readMaybeNumber(value.extraModelCallsRequested) }
      : {}),
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
    baseMaxStepsPerRun: value.baseMaxStepsPerRun,
    grantedExtraSteps: value.grantedExtraSteps,
    baseMaxModelCallsPerRun: value.baseMaxModelCallsPerRun,
    grantedExtraModelCalls: value.grantedExtraModelCalls,
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
    return undefined;
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
    return undefined;
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
    return undefined;
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
    return undefined;
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
    return undefined;
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
    return undefined;
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
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
