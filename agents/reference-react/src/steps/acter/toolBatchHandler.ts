import type { StepIO, Transition } from "../../../../../src/kestrel/contracts/execution.js";
import type { PreparedToolCallV1 } from "../../../../../src/kestrel/contracts/tool-invocation.js";
import { hashCanonical } from "../../../../../src/kestrel/contracts/tool-contract.js";

import type { AutonomyPolicy } from "../../../../../src/governance/contracts.js";
import type { ToolApprovalDispositionV1 } from "../../../../../src/mode/contracts.js";
import { applyReferenceReactExecPatch } from "../../commandProcessor.js";
import {
  buildRuntimePolicyRevision,
  checkToolBatchPolicyGate,
  checkToolPolicyGate,
  prepareExactToolCallForPolicyGate,
} from "./policyGates.js";
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
  toolApprovalDispositionByName: Record<
    string,
    ToolApprovalDispositionV1 | undefined
  >;
  toolApprovalAuthorityByName: ToolApprovalAuthorityByName;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  toolInputDependentPreparationByName: Record<string, boolean>;
  toolAllowedInteractionModesByName: Record<string, CanonicalInteractionMode[] | undefined>;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  modeSystemV2Enabled: boolean;
  executionPolicy: ExecutionPolicy | undefined;
  autonomyPolicy: AutonomyPolicy | undefined;
  autonomyEvidence: string[];
  autonomyRiskSignals: string[];
  currentStepAgent: string;
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  deliberationStepId: string;
  duplicateLedger: DuplicateLedger;
  io: StepIO;
  continueDurableToolBatch: ContinueDurableToolBatch;
  executeToolBatchChunk: ExecuteToolBatchChunk;
}): Promise<Transition> | Transition {
  if (input.pendingBatch.executionMode === "durable") {
    if (input.pendingBatch.policyMode === "per_item") {
      return continuePolicyBoundDurableToolBatch(input);
    }
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
    toolAllowedInteractionModesByName: input.toolAllowedInteractionModesByName,
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
  toolApprovalDispositionByName: Record<
    string,
    ToolApprovalDispositionV1 | undefined
  >;
  toolApprovalAuthorityByName: ToolApprovalAuthorityByName;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  toolInputDependentPreparationByName: Record<string, boolean>;
  toolAllowedInteractionModesByName: Record<string, CanonicalInteractionMode[] | undefined>;
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
  if (
    input.action.items.some(
      (item) => input.toolInputDependentPreparationByName[item.name] === true,
    )
  ) {
    return continuePolicyBoundDurableToolBatch({
      ...input,
      pendingBatch: {
        items: readPendingToolBatchItemsFromAction(input.action),
        nextIndex: 0,
        completedItems: [],
        checkpointSize: input.checkpointSize,
        executionMode: "durable",
        policyMode: "per_item",
      },
    });
  }
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
    toolApprovalDispositionByName: input.toolApprovalDispositionByName,
    toolExecutionClassByName: input.toolExecutionClassByName,
    toolAllowedInteractionModesByName: input.toolAllowedInteractionModesByName,
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
    toolAllowedInteractionModesByName: input.toolAllowedInteractionModesByName,
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
      ...(item.toolSurfaceSnapshot === undefined
        ? {}
        : { toolSurfaceSnapshot: item.toolSurfaceSnapshot }),
      ...(item.activation === undefined ? {} : { activation: item.activation }),
    };
  });
}

async function continuePolicyBoundDurableToolBatch(input: {
  runId: string;
  sessionId: string;
  currentStepAgent: string;
  stepIndex: number;
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  pendingBatch: PendingToolBatchState;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  config: ActerStepConfig;
  toolCapabilityClassesByName: Record<string, string[]>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolApprovalDispositionByName: Record<
    string,
    ToolApprovalDispositionV1 | undefined
  >;
  toolApprovalAuthorityByName: ToolApprovalAuthorityByName;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  toolInputDependentPreparationByName: Record<string, boolean>;
  toolAllowedInteractionModesByName: Record<string, CanonicalInteractionMode[] | undefined>;
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
}): Promise<Transition> {
  const nextItem = input.pendingBatch.items[input.pendingBatch.nextIndex];
  if (nextItem === undefined) {
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

  const toolIntent = {
    ...(nextItem.toolCallId === undefined
      ? {}
      : { modelToolCallId: nextItem.toolCallId }),
    ...(nextItem.toolSurfaceSnapshot === undefined
      ? {}
      : { toolSurfaceSnapshot: nextItem.toolSurfaceSnapshot }),
  };
  const trustedInspection =
    input.toolInputDependentPreparationByName[nextItem.name] === true
      ? await input.io.inspectTool?.(nextItem.name, nextItem.input, toolIntent)
      : undefined;
  const policyInput = trustedInspection?.effectiveInput ?? nextItem.input;
  const toolClass =
    trustedInspection?.executionClass ??
    input.toolExecutionClassByName[nextItem.name] ??
    "read_only";
  const trustedPolicy = trustedInspection?.policy;
  const configuredApprovalCapabilities =
    input.toolApprovalCapabilitiesByName[nextItem.name] ?? [];
  const configuredAuthority = input.toolApprovalAuthorityByName[nextItem.name];
  const boundApprovalAuthority =
    configuredAuthority === undefined ||
    nextItem.activation === undefined ||
    configuredAuthority.kind === "hosted_app_policy"
      ? configuredAuthority
      : {
          kind: configuredAuthority.kind,
          revision: hashCanonical({
            version: "tool-activation-approval-authority-v1",
            activation: nextItem.activation,
            upstreamAuthority: configuredAuthority,
          }),
        };
  const runtimePolicyRevision = buildRuntimePolicyRevision({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    executionPolicy: input.executionPolicy,
  });
  const inspectedApprovalCapabilities =
    trustedPolicy !== undefined && trustedPolicy.decision !== "approval_required"
      ? configuredApprovalCapabilities.filter(
          (capability) => capability !== "external.confirm",
        )
      : configuredApprovalCapabilities;
  const currentPendingApproval = (
    input.reactState.exec as Record<string, unknown> | undefined
  )?.pendingApproval;
  const preparation =
    trustedInspection !== undefined &&
    trustedPolicy?.decision !== "deny" &&
    currentPendingApproval === undefined
      ? await prepareExactToolCallForPolicyGate({
          io: input.io,
          toolName: nextItem.name,
          toolInput: policyInput,
          policyRevision: runtimePolicyRevision,
          authorityRevision:
            boundApprovalAuthority?.revision ?? runtimePolicyRevision,
          capabilities: inspectedApprovalCapabilities,
          toolIntent,
        })
      : undefined;
  const trustedPolicyDecision =
    preparation?.kind === "denied"
      ? "deny" as const
      : preparation?.preparedToolCall.policy.decision ?? trustedPolicy?.decision;
  const effectiveApprovalCapabilities =
    trustedPolicy !== undefined && trustedPolicyDecision !== "approval_required"
      ? configuredApprovalCapabilities.filter(
          (capability) => capability !== "external.confirm",
        )
      : configuredApprovalCapabilities;
  const configuredDisposition =
    input.toolApprovalDispositionByName[nextItem.name];
  const approvalDisposition =
    trustedPolicy === undefined
      ? configuredDisposition
      : {
          mode:
            trustedPolicyDecision === "approval_required"
              ? "ask" as const
              : trustedPolicyDecision === "deny"
                ? "deny" as const
                : "auto" as const,
          reasonCode:
            configuredDisposition?.reasonCode ?? "environment_policy" as const,
          authority:
            configuredDisposition?.authority ?? {
              kind: "runtime_policy" as const,
              revision: trustedPolicy.policyRevision,
            },
        };
  const preparedToolCall =
    preparation?.kind === "prepared"
      ? preparation.preparedToolCall
      : undefined;
  const policyGate = await checkToolPolicyGate({
    reactState: input.reactState,
    activeRegion: input.activeRegion,
    acterStepId: input.config.acterStepId,
    deliberationStepId: input.deliberationStepId,
    loopStepId: input.config.loopStepId,
    currentStepAgent: input.currentStepAgent,
    runId: input.runId,
    sessionId: input.sessionId,
    stepIndex: input.stepIndex,
    eventType: input.eventType,
    eventPayload: input.eventPayload,
    toolName: nextItem.name,
    toolInput: policyInput,
    toolClass,
    allowedInteractionModes:
      input.toolAllowedInteractionModesByName[nextItem.name],
    requiredApprovalCapabilities: effectiveApprovalCapabilities,
    approvalDisposition,
    trustedPolicyDecision,
    trustedPolicyRevision: trustedPolicy?.policyRevision,
    approvalAuthority: boundApprovalAuthority,
    toolIntent,
    preparedToolCall,
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
    const statePatch = policyGate.transition.statePatch ?? {};
    const agentPatch = statePatch.agent ?? {};
    return {
      ...policyGate.transition,
      statePatch: {
        ...statePatch,
        agent: applyReferenceReactExecPatch(
          agentPatch as Record<string, unknown>,
          {
            pendingBatch: input.pendingBatch as unknown as Record<string, unknown>,
          },
        ),
      },
    };
  }
  const approvedPreparedToolCall = policyGate.preparedToolCall;

  const updatedItems = input.pendingBatch.items.map((item, index) =>
    index === input.pendingBatch.nextIndex
      ? { ...item, input: policyInput }
      : item
  );
  return input.continueDurableToolBatch({
    runId: input.runId,
    sessionId: input.sessionId,
    stepIndex: input.stepIndex,
    pendingBatch: {
      ...input.pendingBatch,
      items: updatedItems,
    },
    reactState: input.reactState,
    activeRegion: input.activeRegion,
    loopStepId: input.config.loopStepId,
    acterStepId: input.config.acterStepId,
    toolCapabilityClassesByName: input.toolCapabilityClassesByName,
    duplicateLedger: input.duplicateLedger,
    preparedToolCall: approvedPreparedToolCall,
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
  preparedToolCall?: PreparedToolCallV1 | undefined;
}) => Transition;

type ToolApprovalAuthorityByName = Record<
  string,
  | {
      kind: "runtime_policy" | "hosted_mcp_grant" | "hosted_app_policy";
      revision: string;
    }
  | undefined
>;

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
  toolAllowedInteractionModesByName: Record<string, CanonicalInteractionMode[] | undefined>;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  modeSystemV2Enabled: boolean;
  executionPolicy: ExecutionPolicy | undefined;
  duplicateLedger: DuplicateLedger;
  io: StepIO;
}) => Promise<Transition>;
