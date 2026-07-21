import type { StepAgent, Transition, WaitForMatcher } from "../../../../src/kestrel/contracts/execution.js";

import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
import {
  createReferenceReactLastActionResultPatch,
  createReferenceReactNextActionPatch,
  createReferenceReactRetryContextPatch,
  getAgentStateFromRuntimeState,
} from "../state.js";
import {
  readCompiledActionKind,
  validateCompiledNextAction,
  type CompiledActionValidationFailure,
} from "../actionValidation.js";
import {
  applyReferenceReactExecutionSubstate,
  createReferenceReactExecutionCheckpoint,
  ReferenceReactCommandProcessor,
  type ReferenceReactCommand,
  type ReferenceReactCommandBatch,
} from "../commandProcessor.js";
import { createExecutionStepReducer, type ActerStepConfig } from "./acter.js";
import { createContinuationHandoffWaitTransition } from "./planHandoffWait.js";

export interface ExecStepConfig extends Omit<ActerStepConfig, "acterStepId" | "deliberationStepId" | "loopStepId"> {
  loopStepId?: string | undefined;
  dispatchStepId: string;
  waitEffectStepId: string;
  waitApprovalStepId: string;
  waitUserStepId: string;
  collectStepId: string;
  finalizeStepId: string;
}

export function createExecDispatchStep(config: ExecStepConfig): StepAgent {
  const executionReducer = createExecutionReducer(config);
  return async (ctx, io) => {
    const reactState = getAgentStateFromRuntimeState(ctx.session.state);
    const initialValidation = validateCompiledNextAction(reactState.nextAction);
    if (initialValidation.ok === false && hasQueuedExecutionWork(reactState) === false) {
      return toExecutionStateTransition({
        transition: createCompiledActionValidationTransition({
          reactState,
          runId: ctx.runId,
          sessionId: ctx.session.sessionId,
          stepIndex: ctx.stepIndex,
          currentStepAgent: config.dispatchStepId,
          loopStepId: resolveLoopStepId(config),
          failure: initialValidation.failure,
        }),
        substate: "dispatch",
        sourceChild: "exec.dispatch",
      });
    }
    const commandCheckpoint = checkpointReadyCommandBatch({
      runId: ctx.runId,
      sessionId: ctx.session.sessionId,
      stepIndex: ctx.stepIndex,
      reactState,
      currentStepAgent: config.dispatchStepId,
      nextStepAgent: config.dispatchStepId,
    });
    const checkpointedReactState = commandCheckpoint?.reactState ?? reactState;
    const executionCtx =
      commandCheckpoint === undefined
        ? ctx
        : {
            ...ctx,
            session: {
              ...ctx.session,
              state: {
                ...ctx.session.state,
                agent: checkpointedReactState,
              },
            },
          };
    const checkpointedValidation = validateCompiledNextAction(checkpointedReactState.nextAction);
    if (checkpointedValidation.ok === false && hasQueuedExecutionWork(checkpointedReactState) === false) {
      return toExecutionStateTransition({
        transition: mergeCommandCheckpointEvents(createCompiledActionValidationTransition({
          reactState: checkpointedReactState,
          runId: ctx.runId,
          sessionId: ctx.session.sessionId,
          stepIndex: ctx.stepIndex,
          currentStepAgent: config.dispatchStepId,
          loopStepId: resolveLoopStepId(config),
          failure: checkpointedValidation.failure,
        }), commandCheckpoint),
        substate: "dispatch",
        sourceChild: "exec.dispatch",
      });
    }
    const actionKind = checkpointedValidation.ok
      ? checkpointedValidation.kind
      : readCompiledActionKind(checkpointedReactState.nextAction);
    if (actionKind === "finalize" || actionKind === "cannot_satisfy" || actionKind === "handoff_to_build" || actionKind === "switch_mode") {
      return toExecutionStateTransition({
        transition: mergeCommandCheckpointEvents({
          ...createReferenceReactExecutionCheckpoint({
            snapshot: {
              runId: ctx.runId,
              sessionId: ctx.session.sessionId,
              stepIndex: ctx.stepIndex,
              currentStepAgent: config.dispatchStepId,
              nextStepAgent: config.finalizeStepId,
              reactState: checkpointedReactState,
            },
            nextStepAgent: config.finalizeStepId,
            substate: "finalize",
          }),
        }, commandCheckpoint),
        substate: "finalize",
        sourceChild: "exec.dispatch",
      });
    }

    if (hasPendingEffect(checkpointedReactState)) {
      return toExecutionStateTransition({
        transition: mergeCommandCheckpointEvents({
          ...createReferenceReactExecutionCheckpoint({
            snapshot: {
              runId: ctx.runId,
              sessionId: ctx.session.sessionId,
              stepIndex: ctx.stepIndex,
              currentStepAgent: config.dispatchStepId,
              nextStepAgent: config.waitEffectStepId,
              reactState: checkpointedReactState,
            },
            nextStepAgent: config.waitEffectStepId,
            substate: "wait_effect",
          }),
        }, commandCheckpoint),
        substate: "wait_effect",
        sourceChild: "exec.dispatch",
      });
    }
    if (hasPendingApproval(checkpointedReactState)) {
      return toExecutionStateTransition({
        transition: mergeCommandCheckpointEvents({
          ...createReferenceReactExecutionCheckpoint({
            snapshot: {
              runId: ctx.runId,
              sessionId: ctx.session.sessionId,
              stepIndex: ctx.stepIndex,
              currentStepAgent: config.dispatchStepId,
              nextStepAgent: config.waitApprovalStepId,
              reactState: checkpointedReactState,
            },
            nextStepAgent: config.waitApprovalStepId,
            substate: "wait_approval",
          }),
        }, commandCheckpoint),
        substate: "wait_approval",
        sourceChild: "exec.dispatch",
      });
    }
    if (hasPendingUserWait(checkpointedReactState)) {
      return toExecutionStateTransition({
        transition: mergeCommandCheckpointEvents({
          ...createReferenceReactExecutionCheckpoint({
            snapshot: {
              runId: ctx.runId,
              sessionId: ctx.session.sessionId,
              stepIndex: ctx.stepIndex,
              currentStepAgent: config.dispatchStepId,
              nextStepAgent: config.waitUserStepId,
              reactState: checkpointedReactState,
            },
            nextStepAgent: config.waitUserStepId,
            substate: "wait_user",
          }),
        }, commandCheckpoint),
        substate: "wait_user",
        sourceChild: "exec.dispatch",
      });
    }

    const transition = mergeCommandCheckpointEvents(
      await executionReducer(executionCtx, io),
      commandCheckpoint,
    );
    return normalizeExecutionTransition(transition, config, "exec.dispatch");
  };
}

export function createExecWaitEffectStep(config: ExecStepConfig): StepAgent {
  const executionReducer = createExecutionReducer(config);
  return async (ctx, io) => {
    const reactState = getAgentStateFromRuntimeState(ctx.session.state);
    if (hasPendingEffect(reactState) === false) {
      return toExecutionStateTransition({
        transition: createReferenceReactExecutionCheckpoint({
          snapshot: {
            runId: ctx.runId,
            sessionId: ctx.session.sessionId,
            stepIndex: ctx.stepIndex,
            currentStepAgent: config.waitEffectStepId,
            nextStepAgent: config.collectStepId,
            reactState,
          },
          nextStepAgent: config.collectStepId,
          substate: "collect",
        }),
        substate: "collect",
        sourceChild: "exec.wait_effect",
      });
    }

    const transition = await executionReducer(ctx, io);
    return normalizeExecutionTransition(transition, config, "exec.wait_effect");
  };
}

export function createExecWaitApprovalStep(config: ExecStepConfig): StepAgent {
  const executionReducer = createExecutionReducer(config);
  return async (ctx, io) => {
    const reactState = getAgentStateFromRuntimeState(ctx.session.state);
    if (hasPendingApproval(reactState) === false) {
      return toExecutionStateTransition({
        transition: createReferenceReactExecutionCheckpoint({
          snapshot: {
            runId: ctx.runId,
            sessionId: ctx.session.sessionId,
            stepIndex: ctx.stepIndex,
            currentStepAgent: config.waitApprovalStepId,
            nextStepAgent: config.dispatchStepId,
            reactState,
          },
          nextStepAgent: config.dispatchStepId,
          substate: "dispatch",
        }),
        substate: "dispatch",
        sourceChild: "exec.wait_approval",
      });
    }

    const transition = await executionReducer(ctx, io);
    return normalizeExecutionTransition(transition, config, "exec.wait_approval");
  };
}

export function createExecWaitUserStep(config: ExecStepConfig): StepAgent {
  const executionReducer = createExecutionReducer(config);
  return async (ctx, io) => {
    const reactState = getAgentStateFromRuntimeState(ctx.session.state);
    if (readActionKind(reactState.nextAction) !== "ask_user") {
      return toExecutionStateTransition({
        transition: createReferenceReactExecutionCheckpoint({
          snapshot: {
            runId: ctx.runId,
            sessionId: ctx.session.sessionId,
            stepIndex: ctx.stepIndex,
            currentStepAgent: config.waitUserStepId,
            nextStepAgent: config.dispatchStepId,
            reactState,
          },
          nextStepAgent: config.dispatchStepId,
          substate: "dispatch",
          clearWaitingForUser: true,
        }),
        substate: "dispatch",
        sourceChild: "exec.wait_user",
      });
    }

    const transition = await executionReducer(ctx, io);
    return normalizeExecutionTransition(transition, config, "exec.wait_user");
  };
}

export function createExecCollectStep(config: ExecStepConfig): StepAgent {
  return async (ctx) => {
    const reactState = getAgentStateFromRuntimeState(ctx.session.state);
    const exec = asRecord(reactState.exec);
    const pendingBatch = readPendingBatch(exec?.pendingBatch);
    const hasRemaining =
      pendingBatch !== undefined && pendingBatch.nextIndex < pendingBatch.items.length;

    return toExecutionStateTransition({
      transition: createReferenceReactExecutionCheckpoint({
        snapshot: {
          runId: ctx.runId,
          sessionId: ctx.session.sessionId,
          stepIndex: ctx.stepIndex,
          currentStepAgent: config.collectStepId,
          nextStepAgent: hasRemaining ? config.dispatchStepId : resolveLoopStepId(config),
          reactState,
        },
        nextStepAgent: hasRemaining ? config.dispatchStepId : resolveLoopStepId(config),
        substate: hasRemaining ? "dispatch" : "collect",
        phase: hasRemaining ? "ACT" : "LOOP",
        clearPendingBatch: hasRemaining === false && pendingBatch !== undefined && pendingBatch.nextIndex >= pendingBatch.items.length,
      }),
      substate: hasRemaining ? "dispatch" : "collect",
      sourceChild: "exec.collect",
    });
  };
}

export function createExecFinalizeStep(config: ExecStepConfig): StepAgent {
  const executionReducer = createExecutionReducer(config);
  return async (ctx, io) => {
    const reactState = getAgentStateFromRuntimeState(ctx.session.state);
    const actionKind = readActionKind(reactState.nextAction);
    if (actionKind !== "finalize" && actionKind !== "cannot_satisfy" && actionKind !== "handoff_to_build" && actionKind !== "switch_mode") {
      return toExecutionStateTransition({
        transition: createReferenceReactExecutionCheckpoint({
          snapshot: {
            runId: ctx.runId,
            sessionId: ctx.session.sessionId,
            stepIndex: ctx.stepIndex,
            currentStepAgent: config.finalizeStepId,
            nextStepAgent: config.dispatchStepId,
            reactState,
          },
          nextStepAgent: config.dispatchStepId,
          substate: "dispatch",
        }),
        substate: "dispatch",
        sourceChild: "exec.finalize",
      });
    }

    const planHandoffWait = createContinuationHandoffWaitTransition({
      config,
      reactState,
      stepIndex: ctx.stepIndex,
    });
    if (planHandoffWait !== undefined) {
      return toExecutionStateTransition({
        transition: planHandoffWait,
        substate: "wait_user",
        sourceChild: "exec.finalize",
      });
    }

    const transition = await executionReducer(ctx, io);
    return toExecutionStateTransition({
      transition,
      substate: "finalize",
      sourceChild: "exec.finalize",
    });
  };
}

function createExecutionReducer(config: ExecStepConfig): StepAgent {
  return createExecutionStepReducer({
    acterStepId: config.dispatchStepId,
    deliberationStepId: resolveLoopStepId(config),
    loopStepId: resolveLoopStepId(config),
    effectResultLookupTool: config.effectResultLookupTool,
    finalizeToolName: config.finalizeToolName,
    ...(config.managedWorktreeProposalProvider !== undefined
      ? { managedWorktreeProposalProvider: config.managedWorktreeProposalProvider }
      : {}),
    capabilityManifestProvider: config.capabilityManifestProvider,
  });
}

function createCompiledActionValidationTransition(input: {
  reactState: Record<string, unknown>;
  runId: string;
  sessionId: string;
  stepIndex: number;
  currentStepAgent: string;
  loopStepId: string;
  failure: CompiledActionValidationFailure;
  idempotencyKey?: string | undefined;
}): Transition {
  const timestamp = new Date().toISOString();
  const failure = input.failure;
  const validationObservation = {
    kind: "validation_feedback",
    status: "failed",
    errorCode: failure.code,
    message: failure.message,
    schemaCategory: failure.schemaCategory,
    timestamp,
    details: failure.details,
  };
  const observations = [
    ...asArray(input.reactState.observations),
    validationObservation,
  ].slice(-50);
  return createReferenceReactExecutionCheckpoint({
    snapshot: {
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      currentStepAgent: input.currentStepAgent,
      nextStepAgent: input.loopStepId,
      reactState: {
        ...input.reactState,
        phase: "LOOP",
        ...createReferenceReactNextActionPatch(undefined),
        commandBatch: undefined,
        observations,
        ...createReferenceReactRetryContextPatch({
          failure,
          previousAction: input.reactState.lastAction,
        }),
        ...createReferenceReactLastActionResultPatch({
          ok: false,
          kind: "validation_feedback",
          status: "failed",
          error: failure,
          timestamp,
        }),
        decisionTrace: [
          {
            eventType: "decision.rejected",
            phase: "agent.exec.dispatch",
            decisionCode: failure.code,
            metadata: {
              message: failure.message,
              details: failure.details,
            },
          },
        ],
      },
    },
    nextStepAgent: input.loopStepId,
    substate: "dispatch",
    phase: "LOOP",
  });
}

function checkpointReadyCommandBatch(input: {
  runId: string;
  sessionId: string;
  stepIndex: number;
  reactState: Record<string, unknown>;
  currentStepAgent: string;
  nextStepAgent: string;
}): { reactState: Record<string, unknown>; emitEvents: Transition["emitEvents"] } | undefined {
  const commandBatchRecord = asRecord(input.reactState.commandBatch);
  if (commandBatchRecord === undefined || asString(commandBatchRecord.status) === "processed") {
    return ;
  }
  const batch = readReferenceReactCommandBatch(commandBatchRecord);
  if (batch === undefined) {
    return ;
  }
  const result = new ReferenceReactCommandProcessor().process(
    {
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      currentStepAgent: input.currentStepAgent,
      nextStepAgent: input.nextStepAgent,
      reactState: input.reactState,
    },
    batch,
  );
  const processorReactState = asRecord(result.transition.statePatch?.agent) ?? input.reactState;
  return {
    reactState: {
      ...processorReactState,
      commandBatch: {
        ...commandBatchRecord,
        status: "processed",
        executionMode: result.executionMode,
        processedAtStepIndex: input.stepIndex,
      },
    },
    emitEvents: result.transition.emitEvents,
  };
}

function mergeCommandCheckpointEvents(
  transition: Transition,
  checkpoint: { emitEvents: Transition["emitEvents"] } | undefined,
): Transition {
  const checkpointEvents = checkpoint?.emitEvents ?? [];
  if (checkpointEvents.length === 0) {
    return transition;
  }
  return {
    ...transition,
    emitEvents: [
      ...checkpointEvents,
      ...(transition.emitEvents ?? []),
    ],
  };
}

function readReferenceReactCommandBatch(value: Record<string, unknown>): ReferenceReactCommandBatch | undefined {
  const batchId = asString(value.batchId);
  if (batchId === undefined) {
    return ;
  }
  const commands = asArray(value.commands)
    .map(readReferenceReactCommand)
    .filter((command): command is ReferenceReactCommand => command !== undefined);
  if (commands.length === 0) {
    return ;
  }
  return {
    batchId,
    commands,
    planningSummary: asString(value.planningSummary),
  };
}

function readReferenceReactCommand(value: unknown): ReferenceReactCommand | undefined {
  const record = asRecord(value);
  const commandId = asString(record?.commandId);
  const kind = readCommandKind(record?.kind);
  const commandClass = readCommandClass(record?.commandClass);
  const name = asString(record?.name);
  if (commandId === undefined || kind === undefined || commandClass === undefined || name === undefined) {
    return ;
  }
  const metadata = asRecord(record?.metadata);
  return {
    commandId,
    kind,
    commandClass,
    name,
    input: record?.input,
    waitFor: asRecord(record?.waitFor) as ReferenceReactCommand["waitFor"],
    metadata,
  };
}

function readCommandKind(value: unknown): ReferenceReactCommand["kind"] | undefined {
  const kind = asString(value);
  return kind === "tool" || kind === "effect" || kind === "finalize" || kind === "wait" || kind === "observe"
    ? kind
    : undefined;
}

function readCommandClass(value: unknown): ReferenceReactCommand["commandClass"] | undefined {
  const commandClass = asString(value);
  return commandClass === "read" ||
    commandClass === "write" ||
    commandClass === "effect" ||
    commandClass === "finalize" ||
    commandClass === "wait" ||
    commandClass === "observe"
    ? commandClass
    : undefined;
}

function normalizeExecutionTransition(
  transition: Transition,
  config: ExecStepConfig,
  sourceChild: string,
): Transition {
  const reactPatch = asRecord(transition.statePatch?.agent) ?? {};
  if (transition.status === "WAITING") {
    return toExecutionStateTransition({
      transition: {
        ...transition,
        nextStepAgent: resolveWaitStepAgent(transition.waitFor?.kind, config),
      },
      substate: resolveWaitSubstate(transition.waitFor?.kind),
      sourceChild,
    });
  }

  if (transition.status === "COMPLETED" || transition.status === "FAILED") {
    return toExecutionStateTransition({
      transition,
      substate: "finalize",
      sourceChild,
    });
  }

  if (transition.nextStepAgent === resolveLoopStepId(config)) {
    if (hasDecisionCode(reactPatch.decisionTrace, "tool_policy_blocked")) {
      return toExecutionStateTransition({
        transition,
        substate: "dispatch",
        sourceChild,
      });
    }
    return toExecutionStateTransition({
      transition: sourceChild === "exec.wait_effect"
        ? {
            ...transition,
            nextStepAgent: config.collectStepId,
          }
        : transition,
      substate: "collect",
      sourceChild,
    });
  }

  if (transition.nextStepAgent === config.dispatchStepId) {
    if (hasPendingEffect(reactPatch)) {
      return toExecutionStateTransition({
        transition: {
          ...transition,
          nextStepAgent: config.waitEffectStepId,
        },
        substate: "wait_effect",
        sourceChild,
      });
    }
    if (hasPendingApproval(reactPatch)) {
      return toExecutionStateTransition({
        transition: {
          ...transition,
          nextStepAgent: config.waitApprovalStepId,
        },
        substate: "wait_approval",
        sourceChild,
      });
    }
    if (hasPendingUserWait(reactPatch)) {
      return toExecutionStateTransition({
        transition: {
          ...transition,
          nextStepAgent: config.waitUserStepId,
        },
        substate: "wait_user",
        sourceChild,
      });
    }
    if (readPendingBatch(asRecord(reactPatch.exec)?.pendingBatch) !== undefined) {
      return toExecutionStateTransition({
        transition: {
          ...transition,
          nextStepAgent: config.collectStepId,
        },
        substate: "collect",
        sourceChild,
      });
    }
    return toExecutionStateTransition({
      transition,
      substate: "dispatch",
      sourceChild,
    });
  }

  return toExecutionStateTransition({
    transition,
    substate: undefined,
    sourceChild,
  });
}

function resolveLoopStepId(config: ExecStepConfig): string {
  return config.loopStepId ?? "agent.loop";
}

function toExecutionStateTransition(input: {
  transition: Transition;
  substate: "dispatch" | "wait_effect" | "wait_approval" | "wait_user" | "collect" | "finalize" | undefined;
  sourceChild: string;
}): Transition {
  return applyReferenceReactExecutionSubstate({
    transition: input.transition,
    substate: input.substate,
    sourceChild: input.sourceChild,
  });
}

function resolveWaitStepAgent(
  waitKind: WaitForMatcher["kind"] | undefined,
  config: ExecStepConfig,
): string {
  if (waitKind === "effect" || waitKind === "tool") {
    return config.waitEffectStepId;
  }
  if (waitKind === "approval") {
    return config.waitApprovalStepId;
  }
  return config.waitUserStepId;
}

function resolveWaitSubstate(
  waitKind: WaitForMatcher["kind"] | undefined,
): "wait_effect" | "wait_approval" | "wait_user" {
  if (waitKind === "effect" || waitKind === "tool") {
    return "wait_effect";
  }
  if (waitKind === "approval") {
    return "wait_approval";
  }
  return "wait_user";
}

function readActionKind(value: unknown): string | undefined {
  return readCompiledActionKind(value);
}

function hasPendingEffect(reactState: Record<string, unknown>): boolean {
  const exec = asRecord(reactState.exec);
  const pendingEffectKey = asString(exec?.pendingEffectKey);
  return typeof pendingEffectKey === "string" && pendingEffectKey.trim().length > 0;
}

function hasPendingApproval(reactState: Record<string, unknown>): boolean {
  const exec = asRecord(reactState.exec);
  return typeof asRecord(exec?.pendingApproval)?.approvalId === "string";
}

function hasPendingUserWait(reactState: Record<string, unknown>): boolean {
  return typeof asRecord(reactState.waitingFor)?.eventType === "string";
}

function hasQueuedExecutionWork(reactState: Record<string, unknown>): boolean {
  const exec = asRecord(reactState.exec);
  return hasPendingEffect(reactState) ||
    hasPendingApproval(reactState) ||
    hasPendingUserWait(reactState) ||
    readPendingBatch(exec?.pendingBatch) !== undefined;
}

function readPendingBatch(value: unknown):
  | {
      items: Array<{ name: string; input: Record<string, unknown> }>;
      nextIndex: number;
    }
  | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  const items = asArray(record.items)
    .map((item) => {
      const entry = asRecord(item);
      const name = asString(entry?.name);
      const input = asRecord(entry?.input);
      if (name === undefined || input === undefined) {
        return ;
      }
      return {
        name,
        input,
      };
    })
    .filter((entry): entry is { name: string; input: Record<string, unknown> } => entry !== undefined);
  if (items.length === 0) {
    return ;
  }
  const nextIndex = typeof record.nextIndex === "number" && Number.isFinite(record.nextIndex)
    ? Math.max(0, Math.floor(record.nextIndex))
    : 0;
  return {
    items,
    nextIndex,
  };
}

function hasDecisionCode(value: unknown, code: string): boolean {
  return asArray(value).some((entry) => asString(asRecord(entry)?.decisionCode) === code);
}
