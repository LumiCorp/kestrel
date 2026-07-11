import type { StepIO, Transition } from "../../../../../src/kestrel/contracts/execution.js";

import type { AutonomyPolicy } from "../../../../../src/governance/contracts.js";
import { checkToolBatchPolicyGate } from "./policyGates.js";
import type {
  ActerStepConfig,
  ActSubmode,
  CanonicalInteractionMode,
  DuplicateLedger,
  ExecutionPolicy,
  PendingToolBatchItem,
  PendingToolBatchState,
  ToolBatchAction,
  ToolExecutionClass,
} from "./shared.js";

export function handlePendingToolBatch(input: {
  runId: string;
  sessionId: string;
  stepIndex: number;
  pendingBatch: PendingToolBatchState;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  config: ActerStepConfig;
  checkpointSize: number;
  toolCapabilityClassesByName: Record<string, string[]>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  modeSystemV2Enabled: boolean;
  executionPolicy: ExecutionPolicy | undefined;
  duplicateLedger: DuplicateLedger;
  io: StepIO;
  continueDurableToolBatch: ContinueDurableToolBatch;
  executeToolBatchChunk: ExecuteToolBatchChunk;
}): Promise<Transition> | Transition {
  if (input.pendingBatch.executionMode === "durable") {
    return input.continueDurableToolBatch({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      pendingBatch: input.pendingBatch,
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      loopStepId: input.config.loopStepId,
      acterStepId: input.config.acterStepId,
      toolCapabilityClassesByName: input.toolCapabilityClassesByName,
      duplicateLedger: input.duplicateLedger,
    });
  }
  return input.executeToolBatchChunk({
    runId: input.runId,
    pendingBatch: input.pendingBatch,
    checkpointSize: input.checkpointSize,
    reactState: input.reactState,
    activeRegion: input.activeRegion,
    stepIndex: input.stepIndex,
    loopStepId: input.config.loopStepId,
    acterStepId: input.config.acterStepId,
    toolCapabilityClassesByName: input.toolCapabilityClassesByName,
    toolApprovalCapabilitiesByName: input.toolApprovalCapabilitiesByName,
    toolExecutionClassByName: input.toolExecutionClassByName,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    modeSystemV2Enabled: input.modeSystemV2Enabled,
    executionPolicy: input.executionPolicy,
    duplicateLedger: input.duplicateLedger,
    io: input.io,
  });
}

export async function handleToolBatchAction(input: {
  action: ToolBatchAction;
  runId: string;
  sessionId: string;
  currentStepAgent: string;
  stepIndex: number;
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  config: ActerStepConfig;
  checkpointSize: number;
  toolCapabilityClassesByName: Record<string, string[]>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  modeSystemV2Enabled: boolean;
  executionPolicy: ExecutionPolicy | undefined;
  autonomyPolicy: AutonomyPolicy | undefined;
  autonomyEvidence: string[];
  autonomyRiskSignals: string[];
  duplicateLedger: DuplicateLedger;
  io: StepIO;
  deliberationStepId: string;
  continueDurableToolBatch: ContinueDurableToolBatch;
  executeToolBatchChunk: ExecuteToolBatchChunk;
}): Promise<Transition> {
  const policyGate = await checkToolBatchPolicyGate({
    reactState: input.reactState,
    activeRegion: input.activeRegion,
    acterStepId: input.config.acterStepId,
    loopStepId: input.config.loopStepId,
    deliberationStepId: input.deliberationStepId,
    currentStepAgent: input.currentStepAgent,
    runId: input.runId,
    sessionId: input.sessionId,
    stepIndex: input.stepIndex,
    eventType: input.eventType,
    eventPayload: input.eventPayload,
    items: input.action.items,
    toolApprovalCapabilitiesByName: input.toolApprovalCapabilitiesByName,
    toolExecutionClassByName: input.toolExecutionClassByName,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    modeSystemV2Enabled: input.modeSystemV2Enabled,
    executionPolicy: input.executionPolicy,
    autonomyPolicy: input.autonomyPolicy,
    autonomyEvidence: input.autonomyEvidence,
    autonomyRiskSignals: input.autonomyRiskSignals,
    proposalProvider: input.config.managedWorktreeProposalProvider,
    io: input.io,
  });
  if (policyGate.kind === "blocked") {
    return policyGate.transition;
  }

  if (
    input.action.items.some((item) => {
      const toolClass = input.toolExecutionClassByName[item.name] ?? "read_only";
      return toolClass !== "read_only" && toolClass !== "planning_write";
    })
  ) {
    const pendingItems = readPendingToolBatchItemsFromAction(input.action);
    return input.continueDurableToolBatch({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      pendingBatch: {
        items: pendingItems,
        nextIndex: 0,
        completedItems: [],
        checkpointSize: input.checkpointSize,
        executionMode: "durable",
      },
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      loopStepId: input.config.loopStepId,
      acterStepId: input.config.acterStepId,
      toolCapabilityClassesByName: input.toolCapabilityClassesByName,
      duplicateLedger: input.duplicateLedger,
    });
  }

  return input.executeToolBatchChunk({
    runId: input.runId,
    pendingBatch: {
      items: readPendingToolBatchItemsFromAction(input.action),
      nextIndex: 0,
      completedItems: [],
      checkpointSize: input.checkpointSize,
    },
    checkpointSize: input.checkpointSize,
    reactState: input.reactState,
    activeRegion: input.activeRegion,
    stepIndex: input.stepIndex,
    loopStepId: input.config.loopStepId,
    acterStepId: input.config.acterStepId,
    toolCapabilityClassesByName: input.toolCapabilityClassesByName,
    toolApprovalCapabilitiesByName: input.toolApprovalCapabilitiesByName,
    toolExecutionClassByName: input.toolExecutionClassByName,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    modeSystemV2Enabled: input.modeSystemV2Enabled,
    executionPolicy: input.executionPolicy,
    duplicateLedger: input.duplicateLedger,
    io: input.io,
  });
}

function readPendingToolBatchItemsFromAction(action: ToolBatchAction): PendingToolBatchItem[] {
  return action.items.map((item) => {
    const record = item as Record<string, unknown>;
    const toolCallId = typeof record.toolCallId === "string" && record.toolCallId.length > 0
      ? record.toolCallId
      : undefined;
    return {
      name: item.name,
      input: item.input,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    };
  });
}

type ContinueDurableToolBatch = (input: {
  runId: string;
  sessionId: string;
  stepIndex: number;
  pendingBatch: PendingToolBatchState;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  loopStepId: string;
  acterStepId: string;
  toolCapabilityClassesByName: Record<string, string[]>;
  duplicateLedger: DuplicateLedger;
}) => Transition;

type ExecuteToolBatchChunk = (input: {
  runId?: string | undefined;
  pendingBatch: PendingToolBatchState;
  checkpointSize: number;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  stepIndex: number;
  loopStepId: string;
  acterStepId: string;
  toolCapabilityClassesByName: Record<string, string[]>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  modeSystemV2Enabled: boolean;
  executionPolicy: ExecutionPolicy | undefined;
  duplicateLedger: DuplicateLedger;
  io: StepIO;
}) => Promise<Transition>;
