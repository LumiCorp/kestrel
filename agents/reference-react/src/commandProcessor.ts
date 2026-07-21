import type { MemorySnapshot } from "../../../src/kestrel/contracts/events.js";
import type { Effect, Transition, WaitForMatcher } from "../../../src/kestrel/contracts/execution.js";

import { createRuntimeFailure } from "../../../src/runtime/RuntimeFailure.js";
import {
  materializeUserFacingWaitInteraction,
  readInteractionPrompt,
} from "../../../src/runtime/assistantResponseContract.js";
import type { ToolExecutionClass } from "../../../src/mode/contracts.js";
import {
  buildCanonicalWaitingFor,
  buildWaitResumeToken,
  clearRuntimeWaitState,
} from "../../../src/runtime/waitState.js";
import {
  applyReferenceReactExecPatch,
  createReferenceReactAssistantTextPatch,
  createReferenceReactWaitingForPatch,
} from "./state.js";
import type { ReactAction } from "./types.js";

export type ReferenceReactCommandClass = "read" | "write" | "effect" | "finalize" | "wait" | "observe";
type ReferenceReactWaitMatcher = WaitForMatcher & { kind: "effect" | "approval" | "region_merge" | "tool" | "user" };

export interface ReferenceReactCommand {
  commandId: string;
  kind: "tool" | "effect" | "finalize" | "wait" | "observe";
  commandClass: ReferenceReactCommandClass;
  name: string;
  input?: unknown | undefined;
  waitFor?: WaitForMatcher | undefined;
  effect?: Effect | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ReferenceReactCommandBatch {
  batchId: string;
  commands: ReferenceReactCommand[];
  planningSummary?: string | undefined;
}

export interface ReferenceReactCommandSnapshot {
  runId: string;
  sessionId: string;
  stepIndex: number;
  currentStepAgent: string;
  nextStepAgent: string;
  reactState: Record<string, unknown>;
  memory?: MemorySnapshot | undefined;
}

export interface ReferenceReactCommandProcessorResult {
  transition: Transition;
  executionMode: "parallel_read_batch" | "ordered_checkpoint";
  workingPlan: {
    currentChunk: string;
    commandCount: number;
    commandNames: string[];
  };
}

export type ReferenceReactExecutionSubstate =
  | "dispatch"
  | "wait_effect"
  | "wait_approval"
  | "wait_user"
  | "collect"
  | "finalize"
  | undefined;

export class ReferenceReactCommandProcessor {
  process(
    snapshot: ReferenceReactCommandSnapshot,
    batch: ReferenceReactCommandBatch,
  ): ReferenceReactCommandProcessorResult {
    if (batch.commands.length === 0) {
      throw createRuntimeFailure(
        "REFERENCE_REACT_COMMAND_BATCH_EMPTY",
        "ReferenceReactCommandProcessor requires at least one command.",
        { batchId: batch.batchId },
      );
    }
    const executionMode = batch.commands.every((command) => command.commandClass === "read")
      ? "parallel_read_batch"
      : "ordered_checkpoint";
    if (executionMode === "ordered_checkpoint") {
      const sideEffectCount = batch.commands.filter((command) => command.commandClass !== "read").length;
      if (sideEffectCount > 1) {
        throw createRuntimeFailure(
          "REFERENCE_REACT_COMMAND_BATCH_UNORDERED_EFFECTS",
          "Ordered checkpoints may include only one side-effect command.",
          {
            batchId: batch.batchId,
            sideEffectCount,
          },
        );
      }
    }

    const currentChunk = batch.planningSummary ?? describeCommandBatch(batch);
    const commandNames = batch.commands.map((command) => command.name);
    const primary = batch.commands[0]!;
    const workingPlan = buildReferenceReactWorkingPlan({
      existing: asRecord(snapshot.reactState.workingPlan),
      currentChunk,
      status: executionMode === "parallel_read_batch" ? "gathering_context" : "checkpointing",
      commandNames,
      expectedNextCommand: snapshot.nextStepAgent,
      stepIndex: snapshot.stepIndex,
    });
    const reactPatch = {
      ...snapshot.reactState,
      commandProcessor: {
        batchId: batch.batchId,
        executionMode,
        currentChunk,
        commandNames,
        updatedAtStepIndex: snapshot.stepIndex,
      },
      workingPlan,
    };
      const statePatch = createReferenceReactStatePatch({
      reactPatch: primary.kind === "wait"
        ? reactPatch
        : clearRuntimeWaitState(reactPatch, {
          clearConsumedAskUserAction: true,
        }),
    });

    if (primary.kind === "wait" && primary.waitFor !== undefined) {
      return {
        executionMode,
        workingPlan: { currentChunk, commandCount: batch.commands.length, commandNames },
        transition: {
          status: "WAITING",
          nextStepAgent: snapshot.nextStepAgent,
          statePatch,
          waitFor: primary.waitFor,
        },
      };
    }

    return {
      executionMode,
      workingPlan: { currentChunk, commandCount: batch.commands.length, commandNames },
      transition: {
        status: primary.kind === "finalize" ? "COMPLETED" : "RUNNING",
        nextStepAgent: snapshot.nextStepAgent,
        statePatch,
        effects: batch.commands.flatMap((command) => command.effect === undefined ? [] : [command.effect]),
        emitEvents: [
          {
            type: "decision.executed",
            payload: {
              commandBatchId: batch.batchId,
              executionMode,
              commandNames,
              currentChunk,
            },
          },
        ],
      },
    };
  }
}

export function createReferenceReactExecutionCheckpoint(input: {
  snapshot: ReferenceReactCommandSnapshot;
  nextStepAgent: string;
  substate: Exclude<ReferenceReactExecutionSubstate, undefined>;
  phase?: string | undefined;
  clearWaitingForUser?: boolean | undefined;
  clearPendingBatch?: boolean | undefined;
  emitEvents?: Transition["emitEvents"] | undefined;
}): Transition {
  const cleanedReactState = clearRuntimeWaitState(input.snapshot.reactState, {
    clearConsumedAskUserAction: true,
  });
  const existingExec = asRecord(cleanedReactState.exec) ?? {};
  const execPatch = {
    ...existingExec,
    ...(input.clearPendingBatch === true ? { pendingBatch: undefined } : {}),
    substate: input.substate,
  };
  const currentChunk = describeExecutionCheckpoint(input.substate);
  const workingPlan = buildReferenceReactWorkingPlan({
    existing: asRecord(input.snapshot.reactState.workingPlan),
    currentChunk,
    status: describeExecutionCheckpointStatus(input.substate),
    expectedNextCommand: input.nextStepAgent,
    stepIndex: input.snapshot.stepIndex,
  });
  return {
    status: "RUNNING",
    nextStepAgent: input.nextStepAgent,
    statePatch: {
      agent: {
        ...cleanedReactState,
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
        exec: execPatch,
        commandProcessor: {
          ...(asRecord(input.snapshot.reactState.commandProcessor) ?? {}),
          lastCheckpoint: {
            substate: input.substate,
            currentStepAgent: input.snapshot.currentStepAgent,
            nextStepAgent: input.nextStepAgent,
            updatedAtStepIndex: input.snapshot.stepIndex,
          },
        },
        workingPlan,
      },
    },
    emitEvents: input.emitEvents,
  };
}

export function createReferenceReactWaitCheckpoint(input: {
  memory?: MemorySnapshot | undefined;
  reactState: Record<string, unknown>;
  currentStepAgent: string;
  nextStepAgent: string;
  stepIndex: number;
  waitFor: WaitForMatcher;
  substate: "wait_effect" | "wait_approval" | "wait_user";
  phase?: string | undefined;
  reactPatch?: Record<string, unknown> | undefined;
  execPatch?: Record<string, unknown> | undefined;
  activeRegion?: string | undefined;
  regionReactPatch?: Record<string, unknown> | undefined;
  regionExecPatch?: Record<string, unknown> | undefined;
  emitEvents?: Transition["emitEvents"] | undefined;
}): Transition {
  const runtimeWaitFor = materializeUserFacingWaitInteraction(
    toReferenceReactWaitMatcher(input.waitFor),
  );
  const assistantText = readInteractionPrompt(runtimeWaitFor) ?? null;
  const currentChunk = describeExecutionCheckpoint(input.substate);
  const waitReason = describeWaitReason(runtimeWaitFor);
  const workingPlan = buildReferenceReactWorkingPlan({
    existing: asRecord(input.reactState.workingPlan),
    currentChunk,
    status: "waiting",
    expectedNextCommand: input.nextStepAgent,
    waitReason,
    blocker: waitReason,
    stepIndex: input.stepIndex,
  });
  const reactPatch = applyReferenceReactExecPatch(
    {
      ...input.reactState,
      ...(input.reactPatch ?? {}),
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
      commandProcessor: {
        ...(asRecord(input.reactState.commandProcessor) ?? {}),
        lastCheckpoint: {
          substate: input.substate,
          currentStepAgent: input.currentStepAgent,
          nextStepAgent: input.nextStepAgent,
          updatedAtStepIndex: input.stepIndex,
        },
      },
      workingPlan,
    },
    input.execPatch ?? {},
  );
  const reactPatchWithWait = applyReferenceReactExecPatch(reactPatch, { substate: input.substate });
  const resumeToken = buildWaitResumeToken({
    waitFor: runtimeWaitFor,
    resumeStepAgent: input.nextStepAgent,
  });
  const waitingFor = buildCanonicalWaitingFor({
    waitFor: runtimeWaitFor,
    resumeStepAgent: input.nextStepAgent,
    resumeToken,
    reason: waitReason,
    resumeInstruction: `Resume when ${runtimeWaitFor.eventType} is received.`,
    blockedAction: asRecord(reactPatchWithWait.nextAction),
  });
  const regionPatch =
    input.regionReactPatch === undefined && input.regionExecPatch === undefined
      ? undefined
      : applyReferenceReactExecPatch(input.regionReactPatch ?? {}, input.regionExecPatch ?? {});
  return {
    status: "WAITING",
    nextStepAgent: input.nextStepAgent,
    waitFor: runtimeWaitFor,
    emitEvents: input.emitEvents,
    statePatch: createReferenceReactStatePatch({
      reactPatch: {
        ...reactPatchWithWait,
        ...createReferenceReactAssistantTextPatch(assistantText),
        ...createReferenceReactWaitingForPatch(waitingFor),
      },
      activeRegion: input.activeRegion,
      regionPatch,
    }),
  };
}

export function createReferenceReactEffectDispatchCheckpoint(input: {
  memory?: MemorySnapshot | undefined;
  reactState: Record<string, unknown>;
  currentStepAgent: string;
  nextStepAgent: string;
  stepIndex: number;
  effects: Effect[];
  phase?: string | undefined;
  reactPatch?: Record<string, unknown> | undefined;
  execPatch?: Record<string, unknown> | undefined;
  activeRegion?: string | undefined;
  regionReactPatch?: Record<string, unknown> | undefined;
  regionExecPatch?: Record<string, unknown> | undefined;
  emitEvents?: Transition["emitEvents"] | undefined;
}): Transition {
  const currentChunk = describeExecutionCheckpoint("dispatch");
  const workingPlan = buildReferenceReactWorkingPlan({
    existing: asRecord(input.reactState.workingPlan),
    currentChunk,
    status: "dispatching",
    expectedNextCommand: input.nextStepAgent,
    stepIndex: input.stepIndex,
  });
  const reactPatch = clearRuntimeWaitState(applyReferenceReactExecPatch(
    {
      ...input.reactState,
      ...(input.reactPatch ?? {}),
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
      commandProcessor: {
        ...(asRecord(input.reactState.commandProcessor) ?? {}),
        lastCheckpoint: {
          substate: "dispatch",
          currentStepAgent: input.currentStepAgent,
          nextStepAgent: input.nextStepAgent,
          updatedAtStepIndex: input.stepIndex,
        },
      },
      workingPlan,
    },
    input.execPatch ?? {},
  ), {
    clearConsumedAskUserAction: true,
  });
  const regionPatch =
    input.regionReactPatch === undefined && input.regionExecPatch === undefined
      ? undefined
      : applyReferenceReactExecPatch(input.regionReactPatch ?? {}, input.regionExecPatch ?? {});
  return {
    status: "RUNNING",
    nextStepAgent: input.nextStepAgent,
    effects: input.effects,
    emitEvents: input.emitEvents,
    statePatch: createReferenceReactStatePatch({
      reactPatch,
      activeRegion: input.activeRegion,
      regionPatch,
    }),
  };
}

export function createReferenceReactEffectCollectCheckpoint(input: {
  memory?: MemorySnapshot | undefined;
  reactState: Record<string, unknown>;
  currentStepAgent: string;
  nextStepAgent: string;
  stepIndex: number;
  phase?: string | undefined;
  reactPatch?: Record<string, unknown> | undefined;
  execPatch?: Record<string, unknown> | undefined;
  activeRegion?: string | undefined;
  regionReactPatch?: Record<string, unknown> | undefined;
  regionExecPatch?: Record<string, unknown> | undefined;
  artifacts?: Transition["artifacts"] | undefined;
  emitEvents?: Transition["emitEvents"] | undefined;
}): Transition {
  const currentChunk = describeExecutionCheckpoint("collect");
  const workingPlan = buildReferenceReactWorkingPlan({
    existing: asRecord(input.reactState.workingPlan),
    currentChunk,
    status: "collecting",
    expectedNextCommand: input.nextStepAgent,
    stepIndex: input.stepIndex,
  });
  const reactPatch = clearRuntimeWaitState(applyReferenceReactExecPatch(
    {
      ...input.reactState,
      ...(input.reactPatch ?? {}),
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
      commandProcessor: {
        ...(asRecord(input.reactState.commandProcessor) ?? {}),
        lastCheckpoint: {
          substate: "collect",
          currentStepAgent: input.currentStepAgent,
          nextStepAgent: input.nextStepAgent,
          updatedAtStepIndex: input.stepIndex,
        },
      },
      workingPlan,
    },
    input.execPatch ?? {},
  ), {
    clearConsumedAskUserAction: true,
  });
  const regionPatch =
    input.regionReactPatch === undefined && input.regionExecPatch === undefined
      ? undefined
      : applyReferenceReactExecPatch(input.regionReactPatch ?? {}, input.regionExecPatch ?? {});
  return {
    status: "RUNNING",
    nextStepAgent: input.nextStepAgent,
    ...(input.artifacts !== undefined && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
    emitEvents: input.emitEvents,
    statePatch: createReferenceReactStatePatch({
      reactPatch,
      activeRegion: input.activeRegion,
      regionPatch,
    }),
  };
}

export function createReferenceReactFinalizeCheckpoint(input: {
  memory?: MemorySnapshot | undefined;
  reactState: Record<string, unknown>;
  currentStepAgent: string;
  stepIndex: number;
  phase?: string | undefined;
  reactPatch?: Record<string, unknown> | undefined;
  execPatch?: Record<string, unknown> | undefined;
  activeRegion?: string | undefined;
  regionReactPatch?: Record<string, unknown> | undefined;
  regionExecPatch?: Record<string, unknown> | undefined;
  emitEvents?: Transition["emitEvents"] | undefined;
  stateNode?: Transition["stateNode"] | undefined;
}): Transition {
  const currentChunk = describeExecutionCheckpoint("finalize");
  const workingPlan = buildReferenceReactWorkingPlan({
    existing: asRecord(input.reactState.workingPlan),
    currentChunk,
    status: "finalizing",
    expectedNextCommand: "final response",
    stepIndex: input.stepIndex,
  });
  const baseReactState = clearRuntimeWaitState(input.reactState);
  const reactPatch = clearRuntimeWaitState(applyReferenceReactExecPatch(
    {
      ...baseReactState,
      ...(input.reactPatch ?? {}),
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
      commandProcessor: {
        ...(asRecord(baseReactState.commandProcessor) ?? {}),
        lastCheckpoint: {
          substate: "finalize",
          currentStepAgent: input.currentStepAgent,
          nextStepAgent: undefined,
          updatedAtStepIndex: input.stepIndex,
        },
      },
      workingPlan,
    },
    input.execPatch ?? {},
  ));
  const regionPatch =
    input.regionReactPatch === undefined && input.regionExecPatch === undefined
      ? undefined
      : applyReferenceReactExecPatch(input.regionReactPatch ?? {}, input.regionExecPatch ?? {});
  return {
    status: "COMPLETED",
    emitEvents: input.emitEvents,
    statePatch: createReferenceReactStatePatch({
      reactPatch,
      activeRegion: input.activeRegion,
      regionPatch,
    }),
    stateNode: input.stateNode,
  };
}

export function applyReferenceReactExecutionSubstate(input: {
  transition: Transition;
  substate: ReferenceReactExecutionSubstate;
  sourceChild: string;
}): Transition {
  const statePatch = asRecord(input.transition.statePatch);
  const reactPatch = asRecord(statePatch?.agent) ?? {};
  const execPatch = asRecord(reactPatch.exec) ?? {};
  const commandProcessorPatch = asRecord(reactPatch.commandProcessor);
  const lastCheckpoint = asRecord(commandProcessorPatch?.lastCheckpoint);
  const nextCommandProcessorPatch =
    input.substate !== undefined && commandProcessorPatch !== undefined && lastCheckpoint !== undefined
      ? {
          ...commandProcessorPatch,
          lastCheckpoint: {
            ...lastCheckpoint,
            substate: input.substate,
            nextStepAgent: input.transition.nextStepAgent,
          },
        }
      : commandProcessorPatch;
  return {
    ...input.transition,
    statePatch: {
      ...(statePatch ?? {}),
      agent: {
        ...reactPatch,
        ...(nextCommandProcessorPatch !== undefined ? { commandProcessor: nextCommandProcessorPatch } : {}),
        exec: {
          ...execPatch,
          substate: input.substate,
        },
      },
    },
    stateNode: input.transition.stateNode ?? {
      parent: "react",
      child: input.sourceChild,
    },
  };
}

export function createReferenceReactStatePatch(input: {
  reactPatch: Record<string, unknown>;
  activeRegion?: string | undefined;
  regionPatch?: Record<string, unknown> | undefined;
  memoryPatch?: MemorySnapshot | undefined;
}): Record<string, unknown> {
  const memoryPatch = input.memoryPatch;
  const { evidenceLedger, ...agentPatch } = input.reactPatch;
  const regionPatch = input.regionPatch === undefined ? undefined : stripEvidenceLedgerFromRegionPatch(input.regionPatch);
  const topLevelEvidencePatch = evidenceLedger !== undefined ? { evidenceLedger } : {};
  if (input.activeRegion === undefined || input.activeRegion.trim().length === 0 || input.regionPatch === undefined) {
    return {
      agent: agentPatch,
      ...topLevelEvidencePatch,
      ...(memoryPatch !== undefined ? { memory: memoryPatch } : {}),
    };
  }
  return {
    agent: agentPatch,
    ...topLevelEvidencePatch,
    ...(memoryPatch !== undefined ? { memory: memoryPatch } : {}),
    regions: {
      [input.activeRegion]: regionPatch,
    },
  };
}

function stripEvidenceLedgerFromRegionPatch(regionPatch: Record<string, unknown>): Record<string, unknown> {
  const { evidenceLedger: _evidenceLedger, ...patch } = regionPatch;
  return patch;
}

export { applyReferenceReactExecPatch } from "./state.js";

export function buildReferenceReactCommandBatchFromAction(input: {
  action: ReactAction;
  stepIndex: number;
  toolExecutionClassByName?: Record<string, ToolExecutionClass> | undefined;
  planningSummary?: string | undefined;
}): ReferenceReactCommandBatch {
  const action = input.action;
  const batchId = `command-batch-${input.stepIndex}-${action.kind}`;
  if (action.kind === "tool") {
    return {
      batchId,
      commands: [
	        buildToolCommand({
	          commandId: `${batchId}-0`,
	          name: action.name,
	          input: action.input,
	          executionClass: input.toolExecutionClassByName?.[action.name],
	          metadata: buildToolCommandMetadata({
	            executionRole: action.executionRole,
	          }),
	        }),
      ],
      planningSummary: input.planningSummary ?? action.name,
    };
  }
  if (action.kind === "tool_batch") {
    const commands = action.items.map((item, index) =>
      buildToolCommand({
	        commandId: `${batchId}-${index}`,
	        name: item.name,
	        input: item.input,
	        executionClass: input.toolExecutionClassByName?.[item.name],
	        metadata: buildToolCommandMetadata({
	          executionRole: item.executionRole,
	        }),
	      })
    );
    const sideEffectCount = commands.filter((command) => command.commandClass !== "read").length;
    if (sideEffectCount > 1) {
      return {
        batchId,
        commands: [
          {
            commandId: `${batchId}-checkpoint`,
            kind: "effect",
            commandClass: "effect",
            name: "tool_batch",
            input: { items: action.items },
            metadata: {
              aggregateCheckpoint: true,
              sideEffectCount,
            },
          },
        ],
        planningSummary: input.planningSummary ?? "tool_batch",
      };
    }
    return {
      batchId,
      commands,
      planningSummary: input.planningSummary ?? commands.map((command) => command.name).join(", "),
    };
  }
  if (action.kind === "effect") {
    return {
      batchId,
      commands: [
        {
          commandId: `${batchId}-0`,
          kind: "effect",
          commandClass: "effect",
          name: action.type,
          input: action.payload,
          metadata: action.idempotencyKey !== undefined ? { idempotencyKey: action.idempotencyKey } : undefined,
        },
      ],
      planningSummary: input.planningSummary ?? action.type,
    };
  }
  if (action.kind === "ask_user") {
    return {
      batchId,
      commands: [
        {
          commandId: `${batchId}-0`,
          kind: "wait",
          commandClass: "wait",
          name: "ask_user",
          input: { prompt: action.prompt },
          waitFor: action.waitFor,
        },
      ],
      planningSummary: input.planningSummary ?? "ask_user",
    };
  }
  if (action.kind === "resolve_tool") {
    return {
      batchId,
      commands: [
        {
          commandId: `${batchId}-0`,
          kind: "observe",
          commandClass: "observe",
          name: "resolve_tool",
          input: {
            intent: action.intent,
            constraints: action.constraints,
            candidateTools: action.candidateTools,
          },
        },
      ],
      planningSummary: input.planningSummary ?? "resolve_tool",
    };
  }
  if (action.kind === "handoff_to_build") {
    return {
      batchId,
      commands: [
        {
          commandId: `${batchId}-0`,
          kind: "finalize",
          commandClass: "finalize",
          name: "handoff_to_build",
          input: {
            message: action.message,
            continuation: action.continuation,
            ...(action.data !== undefined ? { data: action.data } : {}),
          },
        },
      ],
      planningSummary: input.planningSummary ?? "handoff_to_build",
    };
  }
  if (action.kind === "switch_mode") {
    return {
      batchId,
      commands: [
        {
          commandId: `${batchId}-0`,
          kind: "finalize",
          commandClass: "finalize",
          name: "switch_mode",
          input: {
            mode: action.mode,
            message: action.message,
          },
        },
      ],
      planningSummary: input.planningSummary ?? "switch_mode",
    };
  }
  return {
    batchId,
    commands: [
      {
        commandId: `${batchId}-0`,
        kind: "finalize",
        commandClass: "finalize",
        name: action.kind,
        input: action.kind === "finalize" ? action.input : { reasonCode: action.reasonCode, message: action.message },
      },
    ],
    planningSummary: input.planningSummary ?? action.kind,
  };
}

function buildToolCommandMetadata(input: {
  executionRole?: unknown;
}): Record<string, unknown> | undefined {
  const metadata = {
    ...(input.executionRole !== undefined ? { executionRole: input.executionRole } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function buildToolCommand(input: {
  commandId: string;
  name: string;
  input: Record<string, unknown>;
  executionClass: ToolExecutionClass | undefined;
  metadata?: Record<string, unknown> | undefined;
}): ReferenceReactCommand {
  const commandClass =
    input.executionClass === "planning_write"
      ? "write"
      : input.executionClass === "read_only" || input.executionClass === undefined
        ? "read"
        : "effect";
  return {
    commandId: input.commandId,
    kind: "tool",
    commandClass,
    name: input.name,
    input: input.input,
    metadata: input.metadata,
  };
}

function describeCommandBatch(batch: ReferenceReactCommandBatch): string {
  return batch.commands.map((command) => command.name).join(", ");
}

function describeExecutionCheckpoint(substate: Exclude<ReferenceReactExecutionSubstate, undefined>): string {
  if (substate === "wait_effect") {
    return "waiting for effect result";
  }
  if (substate === "wait_approval") {
    return "waiting for approval";
  }
  if (substate === "wait_user") {
    return "waiting for user reply";
  }
  if (substate === "collect") {
    return "collecting execution result";
  }
  if (substate === "finalize") {
    return "finalizing response";
  }
  return "dispatching execution command";
}

function describeExecutionCheckpointStatus(substate: Exclude<ReferenceReactExecutionSubstate, undefined>): string {
  if (substate === "wait_effect" || substate === "wait_approval" || substate === "wait_user") {
    return "waiting";
  }
  if (substate === "collect") {
    return "collecting";
  }
  if (substate === "finalize") {
    return "finalizing";
  }
  return "dispatching";
}

function buildReferenceReactWorkingPlan(input: {
  existing: Record<string, unknown> | undefined;
  currentChunk: string;
  status: string;
  commandNames?: string[] | undefined;
  expectedNextCommand?: string | undefined;
  waitReason?: string | undefined;
  blocker?: string | undefined;
  stepIndex: number;
}): Record<string, unknown> & { status: string; expectedNextCommand?: string | undefined } {
  return {
    ...(input.existing ?? {}),
    currentChunk: input.currentChunk,
    status: input.status,
    ...(input.commandNames !== undefined ? { commandNames: input.commandNames } : {}),
    ...(input.expectedNextCommand !== undefined ? { expectedNextCommand: input.expectedNextCommand } : {}),
    ...(input.waitReason !== undefined ? { waitReason: input.waitReason } : {}),
    ...(input.blocker !== undefined ? { blocker: input.blocker } : {}),
    lastUpdatedAtStepIndex: input.stepIndex,
  };
}

function describeWaitReason(waitFor: WaitForMatcher): string {
  const metadata = asRecord(waitFor.metadata);
  const prompt = asString(metadata?.prompt);
  if (prompt !== undefined) {
    return prompt;
  }
  const reason = asString(metadata?.reason);
  if (reason !== undefined) {
    return reason;
  }
  const toolName = asString(metadata?.toolName);
  if (toolName !== undefined) {
    return `waiting on ${toolName}`;
  }
  return `waiting for ${waitFor.eventType}`;
}

function toReferenceReactWaitMatcher(waitFor: WaitForMatcher): ReferenceReactWaitMatcher {
  if (
    waitFor.kind === "effect" ||
    waitFor.kind === "approval" ||
    waitFor.kind === "region_merge" ||
    waitFor.kind === "tool" ||
    waitFor.kind === "user"
  ) {
    return waitFor as ReferenceReactWaitMatcher;
  }
  throw createRuntimeFailure(
    "REFERENCE_REACT_WAIT_KIND_MISSING",
    "Reference React wait checkpoints require an explicit wait kind.",
    {
      eventType: waitFor.eventType,
    },
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
