import { createHash } from "node:crypto";

import {
  parseRunnerExternalApprovalBindingV1,
  parseRunnerExternalApprovalBindingV2,
  RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
  RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
  serializeCanonicalApprovalPayload,
  type RunnerExternalApprovalAuthorityKind,
  type RunnerExternalApprovalBindingV1,
  type RunnerExternalApprovalBindingV2,
} from "@kestrel-agents/protocol";

import type { StepIO, Transition, WaitForMatcher } from "../../../../../src/kestrel/contracts/execution.js";

import {
  createRuntimeFailure,
  RuntimeFailure,
} from "../../../../../src/runtime/RuntimeFailure.js";
import { evaluateAutonomyPolicy } from "../../../../../src/governance/autonomy.js";
import type { AutonomyPolicy } from "../../../../../src/governance/contracts.js";
import {
  needsPerCallApproval,
  readBlockedApprovalCapability,
  resolveEffectiveToolDecisionV1,
  type EffectiveToolDecisionV1,
  type ToolApprovalDispositionV1,
} from "../../../../../src/mode/contracts.js";
import { isMutationCapableToolName } from "../../../../../src/runtime/mutationTools.js";
import {
  parseDurablePreparedToolCallV1,
  parsePreparedToolCallV1,
  type PreparedToolCallV1,
} from "../../../../../src/kestrel/contracts/tool-invocation.js";
import {
  approvalReasonExplanation,
  buildToolApprovalPresentation,
} from "../../../../../src/runtime/toolApprovalPresentation.js";
import {
  sanitizeJsonValue,
  stringifySanitizedJson,
} from "../../../../../src/runtime/jsonSanitizer.js";
import {
  classifyUserReplyIntent,
  readHighConfidenceApprovalDecision,
  readUserReplyIntent,
} from "../../../../../src/runtime/userReplyIntent.js";
import {
  deriveManagedWorktreeWorkspaceTaskKey,
  type ManagedTaskWorktreeProposal,
  type ManagedTaskWorktreeRequest,
} from "../../../../../src/workspace/ManagedTaskWorktreeService.js";
import { isAutoProvisionedWorkspaceTool } from "../../../../../src/workspace/WorkspaceLifecycleService.js";
import { asRecord, asString } from "../../../../shared/valueAccess.js";
import {
  createReferenceReactEffectCollectCheckpoint,
  createReferenceReactWaitCheckpoint,
} from "../../commandProcessor.js";
import { buildModeBlockedWaitGuidance } from "../modeBlockedPrompt.js";
import type {
  ActSubmode,
  CanonicalInteractionMode,
  ExecutionPolicy,
  ToolExecutionClass,
} from "./shared.js";
import { appendAgentObservation } from "./shared.js";

export type PolicyGateResult =
  | { kind: "allowed"; preparedToolCall?: PreparedToolCallV1 | undefined }
  | { kind: "blocked"; transition: Transition };

export async function checkToolPolicyGate(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  acterStepId: string;
  deliberationStepId: string;
  loopStepId: string;
  currentStepAgent: string;
  runId: string;
  sessionId: string;
  stepIndex: number;
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  toolName: string;
  toolInput: unknown;
  toolClass: ToolExecutionClass;
  allowedInteractionModes?: readonly CanonicalInteractionMode[] | undefined;
  requiredApprovalCapabilities?: readonly string[] | undefined;
  approvalDisposition?: ToolApprovalDispositionV1 | undefined;
  approvalAuthority?:
    | {
        kind: RunnerExternalApprovalAuthorityKind;
        revision: string;
      }
    | undefined;
  toolIntent?:
    | {
        modelToolCallId?: string | undefined;
        toolSurfaceSnapshot?:
          | import("../../../../../src/kestrel/contracts/tool-contract.js").ToolSurfaceSnapshotV1
          | undefined;
      }
    | undefined;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  modeSystemV2Enabled: boolean;
  executionPolicy: ExecutionPolicy | undefined;
  autonomyPolicy: AutonomyPolicy | undefined;
  autonomyEvidence: string[];
  autonomyRiskSignals: string[];
  proposalProvider?: ((request: ManagedTaskWorktreeRequest) => Promise<ManagedTaskWorktreeProposal>) | undefined;
  io: StepIO;
}): Promise<PolicyGateResult> {
  const effectiveDecision = resolveEffectiveToolDecisionV1({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    toolClass: input.toolClass,
    allowedInteractionModes: input.allowedInteractionModes,
    executionPolicy: input.executionPolicy,
    requiredCapabilities: input.requiredApprovalCapabilities,
    approvalDisposition:
      input.approvalDisposition ??
      legacyApprovalDisposition(input.requiredApprovalCapabilities),
  });
  const currentPendingApproval = asRecord(
    asRecord(input.reactState.exec)?.pendingApproval,
  );
  if (input.modeSystemV2Enabled && currentPendingApproval !== undefined) {
    const approvalTransition = await maybeRequireToolApproval({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      deliberationStepId: input.deliberationStepId,
      acterStepId: input.acterStepId,
      currentStepAgent: input.currentStepAgent,
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventType: input.eventType,
      eventPayload: input.eventPayload,
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolClass: input.toolClass,
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      executionPolicy: input.executionPolicy,
      requiredApprovalCapabilities: input.requiredApprovalCapabilities,
      approvalDisposition: effectiveDecision.approvalDisposition,
      effectiveDecision,
      approvalAuthority: input.approvalAuthority,
      toolIntent: input.toolIntent,
      io: input.io,
    });
    if (
      approvalTransition !== undefined &&
      "preparedToolCall" in approvalTransition
    ) {
      return {
        kind: "allowed",
        preparedToolCall: approvalTransition.preparedToolCall,
      };
    }
    if (approvalTransition !== undefined) {
      return { kind: "blocked", transition: approvalTransition };
    }
  }
  const modeGate = checkModeAndCapabilityPolicy({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      acterStepId: input.acterStepId,
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      toolClass: input.toolClass,
      allowedInteractionModes: input.allowedInteractionModes,
      requiredApprovalCapabilities: input.requiredApprovalCapabilities,
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      executionPolicy: input.executionPolicy,
      effectiveDecision,
  });
  if (modeGate.kind === "blocked") {
    return modeGate;
  }

  if (input.autonomyPolicy !== undefined) {
    const autonomyTransition = await maybeRequireAutonomyEscalation({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      acterStepId: input.acterStepId,
      deliberationStepId: input.deliberationStepId,
      currentStepAgent: input.currentStepAgent,
      loopStepId: input.loopStepId,
      runId: input.runId,
      stepIndex: input.stepIndex,
      eventType: input.eventType,
      eventPayload: input.eventPayload,
      policy: input.autonomyPolicy,
      actionKey: `tool.${input.toolClass}`,
      actionLabel: input.toolName,
      toolClass: input.toolClass,
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      io: input.io,
      evidence: input.autonomyEvidence,
      riskSignals: input.autonomyRiskSignals,
    });
    if (autonomyTransition !== undefined) {
      return { kind: "blocked", transition: autonomyTransition };
    }
  }

  const managedWorktreeTransition = await maybeRequireManagedWorktreeApproval({
    reactState: input.reactState,
    activeRegion: input.activeRegion,
    acterStepId: input.acterStepId,
    deliberationStepId: input.deliberationStepId,
    currentStepAgent: input.currentStepAgent,
    runId: input.runId,
    sessionId: input.sessionId,
    stepIndex: input.stepIndex,
    eventType: input.eventType,
    eventPayload: input.eventPayload,
    toolName: input.toolName,
    toolInput: input.toolInput,
    toolClass: input.toolClass,
    autoProvisionAllowed: true,
    proposalProvider: input.proposalProvider,
    io: input.io,
  });
  if (managedWorktreeTransition !== undefined) {
    return { kind: "blocked", transition: managedWorktreeTransition };
  }

  if (input.modeSystemV2Enabled) {
    const approvalTransition = await maybeRequireToolApproval({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      deliberationStepId: input.deliberationStepId,
      acterStepId: input.acterStepId,
      currentStepAgent: input.currentStepAgent,
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventType: input.eventType,
      eventPayload: input.eventPayload,
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolClass: input.toolClass,
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      executionPolicy: input.executionPolicy,
      requiredApprovalCapabilities: input.requiredApprovalCapabilities,
      approvalDisposition: effectiveDecision.approvalDisposition,
      effectiveDecision,
      approvalAuthority: input.approvalAuthority,
      toolIntent: input.toolIntent,
      io: input.io,
    });
    if (
      approvalTransition !== undefined &&
      "preparedToolCall" in approvalTransition
    ) {
      return {
        kind: "allowed",
        preparedToolCall: approvalTransition.preparedToolCall,
      };
    }
    if (approvalTransition !== undefined) {
      return { kind: "blocked", transition: approvalTransition };
    }
  }

  return { kind: "allowed" };
}

export async function checkToolBatchPolicyGate(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  acterStepId: string;
  deliberationStepId: string;
  loopStepId: string;
  currentStepAgent: string;
  runId: string;
  sessionId: string;
  stepIndex: number;
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  items: Array<{ name: string; input: Record<string, unknown> }>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolApprovalDispositionByName: Record<
    string,
    ToolApprovalDispositionV1 | undefined
  >;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  toolAllowedInteractionModesByName: Record<string, CanonicalInteractionMode[] | undefined>;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  modeSystemV2Enabled: boolean;
  executionPolicy: ExecutionPolicy | undefined;
  autonomyPolicy: AutonomyPolicy | undefined;
  autonomyEvidence: string[];
  autonomyRiskSignals: string[];
  proposalProvider?: ((request: ManagedTaskWorktreeRequest) => Promise<ManagedTaskWorktreeProposal>) | undefined;
  io: StepIO;
}): Promise<PolicyGateResult> {
  if (
    input.modeSystemV2Enabled &&
    input.items.some((item) =>
      requiresExplicitToolApproval({
        interactionMode: input.interactionMode,
        actSubmode: input.actSubmode,
        executionPolicy: input.executionPolicy,
        requiredApprovalCapabilities:
          input.toolApprovalCapabilitiesByName[item.name] ?? [],
        approvalDisposition: input.toolApprovalDispositionByName[item.name],
      }),
    )
  ) {
    if (isNoninteractiveEventPayload(input.eventPayload)) {
      return {
        kind: "blocked",
        transition: toNoninteractiveApprovalBlockedTransition({
          reactState: input.reactState,
          activeRegion: input.activeRegion,
          deliberationStepId: input.deliberationStepId,
          currentStepAgent: input.currentStepAgent,
          stepIndex: input.stepIndex,
          toolName: "tool_batch",
          toolClass: "external_side_effect",
          reason: "The batch includes an operation that requires approval, which an autonomous turn cannot request.",
        }),
      };
    }
    return {
      kind: "blocked",
      transition: toPolicyBlockedTransition({
        reactState: input.reactState,
        activeRegion: input.activeRegion,
        acterStepId: input.acterStepId,
        stepIndex: input.stepIndex,
        toolName: "tool_batch",
        toolClass: "external_side_effect",
        reason:
          "tool_batch cannot include operations whose effective approval disposition is Ask; use single tool calls",
        interactionMode: input.interactionMode,
        actSubmode: input.actSubmode,
      }),
    };
  }

  const modeGate = checkToolItemsModeAndCapabilityPolicy({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      acterStepId: input.acterStepId,
      stepIndex: input.stepIndex,
      items: input.items,
      toolApprovalCapabilitiesByName: input.toolApprovalCapabilitiesByName,
      toolExecutionClassByName: input.toolExecutionClassByName,
      toolAllowedInteractionModesByName: input.toolAllowedInteractionModesByName,
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      executionPolicy: input.executionPolicy,
  });
  if (modeGate.kind === "blocked") {
    return modeGate;
  }

  if (input.autonomyPolicy !== undefined) {
    const batchToolClass = highestToolClass(input.items, input.toolExecutionClassByName);
    const autonomyTransition = await maybeRequireAutonomyEscalation({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      acterStepId: input.acterStepId,
      deliberationStepId: input.deliberationStepId,
      currentStepAgent: input.currentStepAgent,
      loopStepId: input.loopStepId,
      runId: input.runId,
      stepIndex: input.stepIndex,
      eventType: input.eventType,
      eventPayload: input.eventPayload,
      policy: input.autonomyPolicy,
      actionKey: "tool_batch",
      actionLabel: "tool_batch",
      toolClass: batchToolClass,
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      io: input.io,
      evidence: input.autonomyEvidence,
      riskSignals: input.autonomyRiskSignals,
    });
    if (autonomyTransition !== undefined) {
      return { kind: "blocked", transition: autonomyTransition };
    }
  }

  const firstMutationItem = input.items.find((item) => isMutationCapableToolName(item.name));
  if (firstMutationItem !== undefined) {
    const managedWorktreeTransition = await maybeRequireManagedWorktreeApproval({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      acterStepId: input.acterStepId,
      deliberationStepId: input.deliberationStepId,
      currentStepAgent: input.currentStepAgent,
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventType: input.eventType,
      eventPayload: input.eventPayload,
      toolName: firstMutationItem.name,
      toolInput: firstMutationItem.input,
      autoProvisionAllowed: true,
      proposalProvider: input.proposalProvider,
      io: input.io,
    });
    if (managedWorktreeTransition !== undefined) {
      return { kind: "blocked", transition: managedWorktreeTransition };
    }
  }

  return { kind: "allowed" };
}

export function checkToolBatchChunkPolicyGate(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  acterStepId: string;
  stepIndex: number;
  items: Array<{ name: string; input: Record<string, unknown> }>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  toolAllowedInteractionModesByName: Record<string, CanonicalInteractionMode[] | undefined>;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  modeSystemV2Enabled: boolean;
  executionPolicy: ExecutionPolicy | undefined;
  requiredApprovalCapabilities?: readonly string[] | undefined;
  approvalDisposition?: ToolApprovalDispositionV1 | undefined;
  approvalAuthority?:
    | {
        kind: RunnerExternalApprovalAuthorityKind;
        revision: string;
      }
    | undefined;
}): PolicyGateResult {
  return checkToolItemsModeAndCapabilityPolicy(input);
}

function checkToolItemsModeAndCapabilityPolicy(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  acterStepId: string;
  stepIndex: number;
  items: Array<{ name: string; input: Record<string, unknown> }>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  toolAllowedInteractionModesByName: Record<string, CanonicalInteractionMode[] | undefined>;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  executionPolicy: ExecutionPolicy | undefined;
}): PolicyGateResult {
  const disallowedItem = input.items.find((item) => {
    const toolClass = input.toolExecutionClassByName[item.name] ?? "read_only";
    return resolveEffectiveToolDecisionV1({
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      toolClass,
      allowedInteractionModes: input.toolAllowedInteractionModesByName[item.name],
      executionPolicy: input.executionPolicy,
      requiredCapabilities: input.toolApprovalCapabilitiesByName[item.name],
      approvalDisposition: {
        mode: "auto",
        reasonCode: "environment_policy",
        authority: { kind: "runtime_policy", revision: "legacy-default:v1" },
      },
    }).available === false;
  });

  if (disallowedItem === undefined) {
    return { kind: "allowed" };
  }

  const blockedCapability = readBlockedApprovalCapability({
    executionPolicy: input.executionPolicy,
    requiredCapabilities: input.toolApprovalCapabilitiesByName[disallowedItem.name],
  });

  return {
    kind: "blocked",
    transition: toPolicyBlockedTransition({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      acterStepId: input.acterStepId,
      stepIndex: input.stepIndex,
      toolName: disallowedItem.name,
      toolClass: input.toolExecutionClassByName[disallowedItem.name] ?? "read_only",
      reason: blockedCapability !== undefined
        ? `tool requires blocked capability '${blockedCapability}'`
        : "tool class is blocked by current interaction mode or execution policy",
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      blockedCapability,
    }),
  };
}

function checkModeAndCapabilityPolicy(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  acterStepId: string;
  stepIndex: number;
  toolName: string;
  toolClass: ToolExecutionClass;
  allowedInteractionModes?: readonly CanonicalInteractionMode[] | undefined;
  requiredApprovalCapabilities?: readonly string[] | undefined;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  executionPolicy: ExecutionPolicy | undefined;
  effectiveDecision: EffectiveToolDecisionV1;
}): PolicyGateResult {
  if (input.effectiveDecision.available === false) {
    const blockedCapability = input.effectiveDecision.evidence.blockedCapability;
    return {
      kind: "blocked",
      transition: toPolicyBlockedTransition({
        reactState: input.reactState,
        activeRegion: input.activeRegion,
        acterStepId: input.acterStepId,
        stepIndex: input.stepIndex,
        toolName: input.toolName,
        toolClass: input.toolClass,
        reason:
          blockedCapability === undefined
            ? `tool is unavailable because of ${input.effectiveDecision.availabilityReason}`
            : `tool requires blocked capability '${blockedCapability}'`,
        interactionMode: input.interactionMode,
        actSubmode: input.actSubmode,
        blockedCapability,
      }),
    };
  }
  return { kind: "allowed" };
}

function highestToolClass(
  items: Array<{ name: string; input: Record<string, unknown> }>,
  toolExecutionClassByName: Record<string, ToolExecutionClass>,
): ToolExecutionClass {
  if (items.some((item) => (toolExecutionClassByName[item.name] ?? "read_only") === "external_side_effect")) {
    return "external_side_effect";
  }
  if (items.some((item) => (toolExecutionClassByName[item.name] ?? "read_only") === "sandboxed_only")) {
    return "sandboxed_only";
  }
  return "read_only";
}

async function maybeRequireToolApproval(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  deliberationStepId: string;
  acterStepId: string;
  currentStepAgent: string;
  runId: string;
  sessionId: string;
  stepIndex: number;
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  toolName: string;
  toolInput: unknown;
  toolClass: ToolExecutionClass;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  model?: string | undefined;
  io: StepIO;
  executionPolicy: ExecutionPolicy | undefined;
  requiredApprovalCapabilities?: readonly string[] | undefined;
  approvalDisposition?: ToolApprovalDispositionV1 | undefined;
  effectiveDecision?: EffectiveToolDecisionV1 | undefined;
  approvalAuthority?:
    | {
        kind: RunnerExternalApprovalAuthorityKind;
        revision: string;
      }
    | undefined;
  toolIntent?:
    | {
        modelToolCallId?: string | undefined;
        toolSurfaceSnapshot?:
          | import("../../../../../src/kestrel/contracts/tool-contract.js").ToolSurfaceSnapshotV1
          | undefined;
      }
    | undefined;
}): Promise<
  Transition | { preparedToolCall: PreparedToolCallV1 } | undefined
> {
  const currentPendingApproval = asRecord(
    asRecord(input.reactState.exec)?.pendingApproval,
  );
  if (
    currentPendingApproval === undefined &&
    !requiresExplicitToolApproval({
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      executionPolicy: input.executionPolicy,
      requiredApprovalCapabilities: input.requiredApprovalCapabilities,
      approvalDisposition: input.approvalDisposition,
    })
  ) {
    return ;
  }

  if (isNoninteractiveEventPayload(input.eventPayload)) {
    return toNoninteractiveApprovalBlockedTransition({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      deliberationStepId: input.deliberationStepId,
      currentStepAgent: input.currentStepAgent,
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      toolClass: input.toolClass,
      reason: `Tool '${input.toolName}' requires approval, which an autonomous turn cannot request.`,
    });
  }

  const currentWaitMetadata = asRecord(
    asRecord(input.reactState.waitingFor)?.metadata,
  );
  const runtimePolicyRevision = buildRuntimePolicyRevision({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    executionPolicy: input.executionPolicy,
  });
  const upstreamApprovalAuthorityRevision =
    input.approvalAuthority?.revision ?? runtimePolicyRevision;
  let persistedPreparedToolCall;
  const hasPersistedV2Evidence =
    currentPendingApproval?.version === "hosted_tool_approval_v2" ||
    currentPendingApproval?.preparedInvocationId !== undefined ||
    currentPendingApproval?.preparedToolCall !== undefined ||
    currentWaitMetadata?.preparedToolCall !== undefined ||
    asRecord(currentPendingApproval?.externalApprovalBinding)?.version ===
      RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION;
  if (hasPersistedV2Evidence) {
    try {
      if (currentPendingApproval?.version !== "hosted_tool_approval_v2") {
        throw new Error("persisted hosted approval is missing its V2 discriminator");
      }
      if (currentPendingApproval.preparedToolCall !== undefined) {
        throw new Error("persisted hosted approval contains a duplicate prepared invocation");
      }
      persistedPreparedToolCall = parseDurablePreparedToolCallV1(
        currentWaitMetadata?.preparedToolCall,
      );
      if (
        asString(currentPendingApproval.preparedInvocationId) !==
        persistedPreparedToolCall.callId
      ) {
        throw new Error(
          "persisted hosted approval does not reference its canonical prepared invocation",
        );
      }
      if (
        input.eventType === "user.approval" &&
        input.eventPayload?.decision === "decline" &&
        asString(input.eventPayload.approvalId) ===
          asString(currentPendingApproval.approvalId)
      ) {
        assertPreparedApprovalMatchesStableHostedAuthority({
          preparedToolCall: persistedPreparedToolCall,
          eventPayload: input.eventPayload,
          requiredCapabilities: input.requiredApprovalCapabilities ?? [],
        });
        return toToolApprovalDeniedTransition({
          ...input,
          approvalId: asString(currentPendingApproval.approvalId)!,
          preparedToolCall: persistedPreparedToolCall,
        });
      }
      assertPreparedApprovalMatchesStableHostedAuthority({
        preparedToolCall: persistedPreparedToolCall,
        eventPayload: input.eventPayload,
        requiredCapabilities: input.requiredApprovalCapabilities ?? [],
      });
      if (input.effectiveDecision?.available === false) {
        return toToolApprovalPolicyChangedTransition({
          ...input,
          approvalId: asString(currentPendingApproval.approvalId)!,
          preparedToolCall: persistedPreparedToolCall,
          availabilityReason: input.effectiveDecision.availabilityReason,
        });
      }
      if (
        !preparedApprovalMatchesCurrentHostedAuthority({
          preparedToolCall: persistedPreparedToolCall,
          policyRevision: runtimePolicyRevision,
          approvalAuthorityRevision: upstreamApprovalAuthorityRevision,
        })
      ) {
        return toToolApprovalPolicyChangedTransition({
          ...input,
          approvalId: asString(currentPendingApproval.approvalId)!,
          preparedToolCall: persistedPreparedToolCall,
          availabilityReason: "approval_policy",
          approvalReasonCode:
            input.effectiveDecision?.approvalDisposition.reasonCode,
        });
      }
    } catch (error) {
      throw createRuntimeFailure(
        "HOSTED_PREPARED_APPROVAL_INVALID",
        "The persisted hosted approval invocation is invalid.",
        {
          subsystem: "react",
          classification: "policy",
          recoverable: false,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  const newlyPreparedToolCall =
    persistedPreparedToolCall === undefined &&
    hasHostedPreparedApprovalAuthority(input.eventPayload) &&
    input.io.prepareToolForApproval !== undefined
      ? await input.io.prepareToolForApproval(
          input.toolName,
          input.toolInput,
          {
            policyRevision: runtimePolicyRevision,
            authorityRevision: upstreamApprovalAuthorityRevision,
            capabilities: input.requiredApprovalCapabilities ?? [],
          },
          input.toolIntent,
        )
      : undefined;
  const preparedToolCall =
    persistedPreparedToolCall ??
    (newlyPreparedToolCall?.stableAuthority !== undefined
      ? newlyPreparedToolCall
      : undefined);
  const effectiveToolInput =
    preparedToolCall?.effectiveInput ??
    (input.io.inspectTool === undefined
      ? input.toolInput
      : (
          await input.io.inspectTool(
            input.toolName,
            input.toolInput,
            input.toolIntent,
          )
        ).effectiveInput);
  const approvalId =
    preparedToolCall?.approval?.approvalId ??
    buildApprovalId(
      input.runId,
      input.stepIndex,
      input.toolName,
      effectiveToolInput,
    );
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(requestedAt) + 5 * 60_000,
  ).toISOString();
  const effectiveDisposition = resolveEffectiveApprovalDisposition(input);
  const approvalPresentation = buildToolApprovalPresentation({
    toolName: input.toolName,
    effectiveInput: effectiveToolInput,
    disposition: effectiveDisposition,
  });
  const approvalReason = approvalReasonExplanation(
    effectiveDisposition.reasonCode,
  );
  const binding =
    input.toolClass === "external_side_effect"
      ? preparedToolCall?.stableAuthority !== undefined &&
        preparedToolCall.stableToolIdentity !== undefined
        ? preparedToolCall.approval?.externalApprovalBinding?.version ===
          RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION
          ? parseRunnerExternalApprovalBindingV2(
              preparedToolCall.approval!.externalApprovalBinding,
            )
          : buildExternalApprovalBindingV2({
              preparedToolCall,
              approvalId,
              toolClass: input.toolClass,
              authorityKind:
                input.approvalAuthority?.kind ?? "runtime_policy",
              requestedAt,
              expiresAt,
            })
        : buildExternalApprovalBinding({
          approvalId,
          threadId: readApprovalThreadId(input.eventPayload) ?? input.sessionId,
          runId: input.runId,
          toolName: input.toolName,
          toolInput: effectiveToolInput,
          toolClass: input.toolClass,
          requiredApprovalCapabilities: input.requiredApprovalCapabilities,
          approvalAuthority: input.approvalAuthority,
          interactionMode: input.interactionMode,
          actSubmode: input.actSubmode,
          executionPolicy: input.executionPolicy,
          requestedAt,
          expiresAt,
          })
      : undefined;
  const durablePreparedToolCall =
    preparedToolCall === undefined
      ? undefined
      : parseDurablePreparedToolCallV1({
          ...preparedToolCall,
          approval: {
            ...preparedToolCall.approval,
            ...(binding?.version === RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION
              ? { externalApprovalBinding: binding }
              : {}),
          },
        });
  const currentPendingApprovalId = asString(currentPendingApproval?.approvalId);
  const decision = await resolveApprovalDecision({
    eventType: input.eventType,
    eventPayload: input.eventPayload,
    strictV2: durablePreparedToolCall !== undefined,
    model: input.model,
    io: input.io,
    waitFor: {
      eventType: "user.approval",
      metadata: {
        approvalId,
        toolName: input.toolName,
        toolClass: input.toolClass,
        reason: approvalReason,
        reasonCode: effectiveDisposition.reasonCode,
        approvalPresentation,
      },
    },
  });

  if (input.eventType === "user.approval" && currentPendingApprovalId === approvalId && decision === "approve") {
    let exactApprovalMatches = true;
    if (binding?.version === RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION) {
      try {
        validatePendingExternalApproval({
          currentPendingApproval,
          expected: binding,
        });
      } catch (error) {
        if (
          error instanceof RuntimeFailure &&
          (
            error.code === "EXTERNAL_APPROVAL_BINDING_INVALID" ||
            error.code === "EXTERNAL_APPROVAL_BINDING_CHANGED" ||
            error.code === "EXTERNAL_APPROVAL_EXPIRED"
          )
        ) {
          exactApprovalMatches = false;
        } else {
          throw error;
        }
      }
    } else if (binding?.version === RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION) {
      try {
        validatePendingExternalApprovalV2({
          currentPendingApproval,
          preparedToolCall: parseDurablePreparedToolCallV1(durablePreparedToolCall),
          expected: binding,
        });
      } catch (error) {
        if (
          error instanceof RuntimeFailure &&
          error.code === "EXTERNAL_APPROVAL_EXPIRED"
        ) {
          const expiredPreparedToolCall =
            parseDurablePreparedToolCallV1(durablePreparedToolCall);
          const lastActionResult = {
            ok: false,
            kind: "approval_expiration",
            status: "expired",
            approvalId,
            toolName: input.toolName,
            toolClass: input.toolClass,
            ts: new Date().toISOString(),
          };
          return createReferenceReactEffectCollectCheckpoint({
            reactState: input.reactState,
            currentStepAgent: input.currentStepAgent,
            nextStepAgent: input.deliberationStepId,
            stepIndex: input.stepIndex,
            activeRegion: input.activeRegion,
            phase: "THINK",
            effects: [
              {
                type: "release_prepared_tool_call",
                payload: { preparedToolCall: expiredPreparedToolCall },
                idempotencyKey: `${expiredPreparedToolCall.callId}:release`,
                failurePolicy: "STOP",
              },
            ],
            reactPatch: {
              lastActionResult,
              observations: appendAgentObservation(input.reactState, lastActionResult),
              decisionTrace: [
                {
                  eventType: "decision.executed",
                  phase: "acter",
                  decisionCode: "tool_approval_expired",
                  metadata: {
                    approvalId,
                    toolName: input.toolName,
                    toolClass: input.toolClass,
                  },
                },
              ],
            },
            execPatch: {
              pendingApproval: undefined,
            },
            regionExecPatch: {
              pendingApproval: undefined,
            },
          });
        }
        if (
          error instanceof RuntimeFailure &&
          (
            error.code === "EXTERNAL_APPROVAL_BINDING_INVALID" ||
            error.code === "EXTERNAL_APPROVAL_BINDING_CHANGED"
          )
        ) {
          exactApprovalMatches = false;
        } else {
          throw error;
        }
      }
    }
    if (exactApprovalMatches) {
      return durablePreparedToolCall === undefined
        ? undefined
        : {
            preparedToolCall:
              parseDurablePreparedToolCallV1(durablePreparedToolCall),
          };
    }
  }

  if (input.eventType === "user.approval" && currentPendingApprovalId === approvalId && decision === "deny") {
    const declinedPreparedToolCall = durablePreparedToolCall === undefined
      ? undefined
      : parseDurablePreparedToolCallV1(durablePreparedToolCall);
    return toToolApprovalDeniedTransition({
      ...input,
      approvalId,
      preparedToolCall: declinedPreparedToolCall,
    });
  }

  const prompt = durablePreparedToolCall === undefined
    ? `Approve ${input.toolName}? Reply 'approve' or 'deny'.`
    : `Approve ${input.toolName}? Reply with decision 'approve_once' or 'decline'.`;
  const waitFor: WaitForMatcher = {
    kind: "approval",
    eventType: "user.approval",
    metadata: {
      approvalId,
      toolName: input.toolName,
      toolInput: effectiveToolInput,
      toolClass: input.toolClass,
      riskLevel: riskLevelForToolClass(input.toolClass),
      reason: approvalReason,
      reasonCode: effectiveDisposition.reasonCode,
      approvalPresentation,
      expiresAt,
      ...(binding !== undefined ? { externalApprovalBinding: binding } : {}),
      ...(durablePreparedToolCall === undefined
        ? {}
        : { preparedToolCall: durablePreparedToolCall }),
      prompt,
    },
  };

  return createReferenceReactWaitCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.acterStepId,
    nextStepAgent: input.acterStepId,
    stepIndex: input.stepIndex,
    waitFor,
    substate: "wait_approval",
    emitEvents: [
      {
        type: "ui.prompt",
        payload: {
          text: prompt,
        },
      },
    ],
    activeRegion: input.activeRegion,
    phase: "ACT",
    reactPatch: {
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "tool_approval_requested",
          metadata: {
            approvalId,
            toolName: input.toolName,
            toolClass: input.toolClass,
          },
        },
      ],
    },
    execPatch: {
      pendingApproval: {
        ...(durablePreparedToolCall === undefined
          ? {}
          : {
              version: "hosted_tool_approval_v2",
              preparedInvocationId: durablePreparedToolCall.callId,
            }),
        approvalId,
        toolName: input.toolName,
        toolClass: input.toolClass,
        expiresAt,
        ...(binding !== undefined ? { externalApprovalBinding: binding } : {}),
      },
    },
    regionExecPatch: {
      pendingApproval: {
        ...(durablePreparedToolCall === undefined
          ? {}
          : {
              version: "hosted_tool_approval_v2",
              preparedInvocationId: durablePreparedToolCall.callId,
            }),
        approvalId,
        toolName: input.toolName,
        toolClass: input.toolClass,
        expiresAt,
        ...(binding !== undefined ? { externalApprovalBinding: binding } : {}),
      },
    },
  });
}

function toToolApprovalDeniedTransition(input: {
  reactState: Record<string, unknown>;
  currentStepAgent: string;
  deliberationStepId: string;
  stepIndex: number;
  activeRegion: string | undefined;
  approvalId: string;
  toolName: string;
  toolClass: ToolExecutionClass;
  preparedToolCall?: PreparedToolCallV1 | undefined;
}): Transition {
  const lastActionResult = {
    ok: false,
    kind: "approval_denial",
    status: "denied",
    approvalId: input.approvalId,
    toolName: input.toolName,
    toolClass: input.toolClass,
    ts: new Date().toISOString(),
  };
  return createReferenceReactEffectCollectCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.currentStepAgent,
    nextStepAgent: input.deliberationStepId,
    stepIndex: input.stepIndex,
    activeRegion: input.activeRegion,
    phase: "THINK",
    effects: input.preparedToolCall === undefined
      ? undefined
      : [
          {
            type: "release_prepared_tool_call",
            payload: { preparedToolCall: input.preparedToolCall },
            idempotencyKey: `${input.preparedToolCall.callId}:release`,
            failurePolicy: "STOP",
          },
        ],
    reactPatch: {
      lastActionResult,
      observations: appendAgentObservation(input.reactState, lastActionResult),
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "tool_approval_denied",
          metadata: {
            approvalId: input.approvalId,
            toolName: input.toolName,
            toolClass: input.toolClass,
          },
        },
      ],
    },
    execPatch: { pendingApproval: undefined },
    regionExecPatch: { pendingApproval: undefined },
  });
}

function toToolApprovalPolicyChangedTransition(input: {
  reactState: Record<string, unknown>;
  currentStepAgent: string;
  deliberationStepId: string;
  stepIndex: number;
  activeRegion: string | undefined;
  approvalId: string;
  toolName: string;
  toolClass: ToolExecutionClass;
  preparedToolCall: PreparedToolCallV1;
  availabilityReason: EffectiveToolDecisionV1["availabilityReason"];
  approvalReasonCode?: ToolApprovalDispositionV1["reasonCode"] | undefined;
}): Transition {
  const lastActionResult = {
    ok: false,
    kind: "approval_policy_change",
    status: "denied",
    reason: "policy_changed",
    availabilityReason: input.availabilityReason,
    ...(input.approvalReasonCode === undefined
      ? {}
      : { approvalReasonCode: input.approvalReasonCode }),
    approvalId: input.approvalId,
    toolName: input.toolName,
    toolClass: input.toolClass,
    ts: new Date().toISOString(),
  };
  return createReferenceReactEffectCollectCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.currentStepAgent,
    nextStepAgent: input.deliberationStepId,
    stepIndex: input.stepIndex,
    activeRegion: input.activeRegion,
    phase: "THINK",
    effects: [
      {
        type: "release_prepared_tool_call",
        payload: { preparedToolCall: input.preparedToolCall },
        idempotencyKey: `${input.preparedToolCall.callId}:release`,
        failurePolicy: "STOP",
      },
    ],
    reactPatch: {
      lastActionResult,
      observations: appendAgentObservation(input.reactState, lastActionResult),
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "tool_approval_policy_changed",
          metadata: {
            approvalId: input.approvalId,
            toolName: input.toolName,
            toolClass: input.toolClass,
            availabilityReason: input.availabilityReason,
            ...(input.approvalReasonCode === undefined
              ? {}
              : { approvalReasonCode: input.approvalReasonCode }),
          },
        },
      ],
    },
    execPatch: { pendingApproval: undefined },
    regionExecPatch: { pendingApproval: undefined },
  });
}

function resolveEffectiveApprovalDisposition(input: {
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  executionPolicy: ExecutionPolicy | undefined;
  approvalDisposition?: ToolApprovalDispositionV1 | undefined;
}): ToolApprovalDispositionV1 {
  if (needsPerCallApproval(input)) {
    return {
      mode: "ask",
      reasonCode: "runtime_strict",
      authority: {
        kind: "runtime_policy",
        revision: "strict-approval-per-call:v1",
      },
    };
  }
  return (
    input.approvalDisposition ?? {
      mode: "ask",
      reasonCode: "tool_minimum",
      authority: {
        kind: "runtime_policy",
        revision: "legacy-external-confirm",
      },
    }
  );
}

export function requiresExplicitToolApproval(input: {
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  executionPolicy: ExecutionPolicy | undefined;
  requiredApprovalCapabilities?: readonly string[] | undefined;
  approvalDisposition?: ToolApprovalDispositionV1 | undefined;
}) {
  if (needsPerCallApproval(input)) return true;
  if (input.approvalDisposition !== undefined) {
    return input.approvalDisposition.mode === "ask";
  }
  return (
    input.requiredApprovalCapabilities?.includes("external.confirm") === true
  );
}

function legacyApprovalDisposition(
  requiredCapabilities: readonly string[] | undefined,
): ToolApprovalDispositionV1 {
  return requiredCapabilities?.includes("external.confirm") === true
    ? {
        mode: "ask",
        reasonCode: "tool_minimum",
        authority: {
          kind: "runtime_policy",
          revision: "legacy-external-confirm",
        },
      }
    : {
        mode: "auto",
        reasonCode: "environment_policy",
        authority: { kind: "runtime_policy", revision: "legacy-default:v1" },
      };
}

async function maybeRequireManagedWorktreeApproval(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  acterStepId: string;
  deliberationStepId: string;
  currentStepAgent: string;
  runId: string;
  sessionId: string;
  stepIndex: number;
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  toolName: string;
  toolInput: unknown;
  toolClass?: ToolExecutionClass | undefined;
  autoProvisionAllowed?: boolean | undefined;
  proposalProvider?: ((request: ManagedTaskWorktreeRequest) => Promise<ManagedTaskWorktreeProposal>) | undefined;
  model?: string | undefined;
  io?: StepIO | undefined;
}): Promise<Transition | undefined> {
  if (isMutationCapableToolName(input.toolName) === false) {
    return ;
  }
  if (input.autoProvisionAllowed === true && isAutoProvisionedWorkspaceTool(input.toolName)) {
    return ;
  }
  if (hasManagedWorktreeContext(input.reactState)) {
    return ;
  }
  const workspace = asRecord(input.eventPayload?.workspace);
  if (workspace?.managedWorktreeRequired === false) {
    return ;
  }
  if (isNoninteractiveEventPayload(input.eventPayload)) {
    return toNoninteractiveApprovalBlockedTransition({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      deliberationStepId: input.deliberationStepId,
      currentStepAgent: input.currentStepAgent,
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      toolClass: input.toolClass ?? "sandboxed_only",
      reason: `Tool '${input.toolName}' requires managed-worktree approval, which an autonomous turn cannot request.`,
    });
  }
  const sourceWorkspaceRoot = asString(workspace?.sourceWorkspaceRoot) ?? asString(workspace?.workspaceRoot);
  if (sourceWorkspaceRoot === undefined) {
    return ;
  }
  if (input.proposalProvider === undefined) {
    throw createRuntimeFailure(
      "MANAGED_WORKTREE_PROPOSAL_PROVIDER_REQUIRED",
      "Managed Kestrel worktree provisioning is required before mutation-capable tools can run.",
      {
        subsystem: "workspace",
        step: "agent.exec.dispatch",
        classification: "runtime",
        recoverable: true,
        toolName: input.toolName,
      },
    );
  }

  const sourceRepoRootForRequest = asString(workspace?.sourceRepoRoot) ?? asString(workspace?.repoRoot);
  const taskId = readManagedWorktreeTaskId(input.reactState, input.eventPayload);
  const taskKey = readManagedWorktreeTaskKey(input.reactState, input.eventPayload);
  const threadId = readManagedWorktreeThreadId(input.eventPayload);
  const request = {
    sessionId: input.sessionId,
    sourceWorkspaceRoot,
    ...(sourceRepoRootForRequest !== undefined ? { sourceRepoRoot: sourceRepoRootForRequest } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(taskKey !== undefined ? { taskKey } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    triggeringTool: input.toolName,
  };
  const approvalId = buildApprovalId(input.runId, input.stepIndex, `managed_worktree:${input.toolName}`, {
    request,
    toolInput: input.toolInput,
  });
  const currentPendingApproval = asRecord(asRecord(input.reactState.exec)?.pendingApproval);
  const currentPendingApprovalId = asString(currentPendingApproval?.approvalId);
  const decision = await resolveApprovalDecision({
    eventType: input.eventType,
    eventPayload: input.eventPayload,
    model: input.model,
    io: input.io,
    waitFor: {
      eventType: "user.approval",
      metadata: {
        approvalId,
        purpose: "managed_worktree",
        toolName: input.toolName,
        reason: "Managed worktree approval required",
      },
    },
  });

  if (input.eventType === "user.approval" && currentPendingApprovalId === approvalId && decision === "approve") {
    if (hasManagedWorktreeContext(input.reactState)) {
      return ;
    }
    throw createRuntimeFailure(
      "MANAGED_WORKTREE_APPROVAL_NOT_BOUND",
      "Managed Kestrel worktree approval was accepted, but the runtime did not bind a managed worktree before resuming the mutation.",
      {
        subsystem: "workspace",
        classification: "runtime",
        recoverable: true,
        approvalId,
        toolName: input.toolName,
      },
    );
  }

  if (input.eventType === "user.approval" && currentPendingApprovalId === approvalId && decision === "deny") {
    const lastActionResult = {
      ok: false,
      kind: "approval_denial",
      status: "denied",
      approvalId,
      toolName: input.toolName,
      purpose: "managed_worktree",
      ts: new Date().toISOString(),
    };
    return createReferenceReactEffectCollectCheckpoint({
      reactState: input.reactState,
      currentStepAgent: input.currentStepAgent,
      nextStepAgent: input.deliberationStepId,
      stepIndex: input.stepIndex,
      activeRegion: input.activeRegion,
      phase: "THINK",
      reactPatch: {
        lastActionResult,
        observations: appendAgentObservation(input.reactState, lastActionResult),
        decisionTrace: [
          {
            eventType: "decision.executed",
            phase: "acter",
            decisionCode: "managed_worktree_approval_denied",
            metadata: {
              approvalId,
              toolName: input.toolName,
            },
          },
        ],
      },
      execPatch: {
        pendingApproval: undefined,
      },
      regionExecPatch: {
        pendingApproval: undefined,
      },
    });
  }

  const proposal = asRecord(await input.proposalProvider(request));
  const proposalSourceWorkspaceRoot = asString(proposal?.sourceWorkspaceRoot);
  const worktreeRoot = asString(proposal?.worktreeRoot);
  const baseHead = asString(proposal?.baseHead);
  const sourceRepoRoot = asString(proposal?.sourceRepoRoot);
  const lastObservedSourceHead = asString(proposal?.lastObservedSourceHead);
  const scope = asRecord(proposal?.scope);
  const scopeKind = asString(scope?.kind);
  const scopeValue = asString(scope?.value);
  if (proposalSourceWorkspaceRoot === undefined || worktreeRoot === undefined || baseHead === undefined || sourceRepoRoot === undefined) {
    throw createRuntimeFailure(
      "MANAGED_WORKTREE_PREPARE_INVALID",
      "Managed Kestrel worktree prepare result was missing required fields.",
      {
        subsystem: "workspace",
        classification: "runtime",
        recoverable: true,
        approvalId,
        toolName: input.toolName,
      },
    );
  }

  const prompt = [
    `Approve a scoped Kestrel worktree before ${input.toolName}?`,
    `Source repo: ${sourceRepoRoot}`,
    ...(scopeKind !== undefined && scopeValue !== undefined ? [`Scope: ${scopeKind}:${scopeValue}`] : []),
    `Source HEAD: ${baseHead}`,
    ...(lastObservedSourceHead !== undefined ? [`Last observed source HEAD: ${lastObservedSourceHead}`] : []),
    `Scoped worktree: ${worktreeRoot}`,
    "State: pending approval; lease will be checked before provisioning.",
    "Dirty checkout changes will not be imported. Reply 'approve' or 'deny'.",
  ].join("\n");
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const waitFor: WaitForMatcher = {
    kind: "approval",
    eventType: "user.approval",
    metadata: {
      approvalId,
      purpose: "managed_worktree",
      toolName: input.toolName,
      prompt,
      expiresAt,
      request: {
        ...request,
        sourceWorkspaceRoot: proposalSourceWorkspaceRoot,
        sourceRepoRoot,
        worktreeRoot,
        baseHead,
        ...(lastObservedSourceHead !== undefined ? { lastObservedSourceHead } : {}),
        ...(scopeKind !== undefined && scopeValue !== undefined ? { scope: { kind: scopeKind, value: scopeValue } } : {}),
      },
    },
  };

  return createReferenceReactWaitCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.acterStepId,
    nextStepAgent: input.acterStepId,
    stepIndex: input.stepIndex,
    waitFor,
    substate: "wait_approval",
    emitEvents: [
      {
        type: "ui.prompt",
        payload: {
          text: prompt,
        },
      },
    ],
    activeRegion: input.activeRegion,
    phase: "ACT",
    reactPatch: {
      decisionTrace: [
        {
          eventType: "managed_worktree.approval_requested",
          phase: "acter",
          decisionCode: "managed_worktree_approval_requested",
          metadata: {
            approvalId,
            toolName: input.toolName,
            sourceRepoRoot,
            worktreeRoot,
            baseHead,
          },
        },
      ],
    },
    execPatch: {
      pendingApproval: {
        approvalId,
        purpose: "managed_worktree",
        toolName: input.toolName,
        expiresAt,
        request: {
          ...request,
          sourceWorkspaceRoot: proposalSourceWorkspaceRoot,
          sourceRepoRoot,
          worktreeRoot,
          baseHead,
        },
      },
    },
    regionExecPatch: {
      pendingApproval: {
        approvalId,
        purpose: "managed_worktree",
        toolName: input.toolName,
        expiresAt,
        request: {
          ...request,
          sourceWorkspaceRoot: proposalSourceWorkspaceRoot,
          sourceRepoRoot,
          worktreeRoot,
          baseHead,
        },
      },
    },
  });
}

function hasManagedWorktreeContext(
  reactState: Record<string, unknown>,
): boolean {
  const binding = asRecord(asRecord(reactState.exec)?.managedWorktreeBinding);
  return binding?.status === "bound" && asString(binding.worktreeRoot) !== undefined;
}

function readManagedWorktreeTaskId(
  reactState: Record<string, unknown>,
  eventPayload: Record<string, unknown> | undefined,
): string | undefined {
  return (
    asString(asRecord(eventPayload?.orchestration)?.taskId) ??
    asString(asRecord(eventPayload?.metadata)?.taskId) ??
    asString(asRecord(asRecord(reactState.exec)?.managedWorktreeBinding)?.taskId)
  );
}

function readManagedWorktreeTaskKey(
  reactState: Record<string, unknown>,
  eventPayload: Record<string, unknown> | undefined,
): string | undefined {
  return (
    asString(asRecord(eventPayload?.orchestration)?.taskKey) ??
    asString(asRecord(eventPayload?.metadata)?.taskKey) ??
    deriveManagedWorktreeWorkspaceTaskKey(asRecord(eventPayload?.workspace)) ??
    asString(asRecord(asRecord(reactState.exec)?.managedWorktreeBinding)?.taskKey)
  );
}

function readManagedWorktreeThreadId(eventPayload: Record<string, unknown> | undefined): string | undefined {
  return (
    asString(asRecord(eventPayload?.orchestration)?.threadId) ??
    asString(asRecord(eventPayload?.metadata)?.threadId)
  );
}

function buildApprovalId(
  runId: string,
  stepIndex: number,
  toolName: string,
  toolInput: unknown,
): string {
  const hash = createHash("sha256")
    .update(`${toolName}:${stableStringify(toolInput)}`)
    .digest("hex")
    .slice(0, 12);
  return `${runId}:${stepIndex}:${hash}`;
}

function buildExternalApprovalBinding(input: {
  approvalId: string;
  threadId: string;
  runId: string;
  toolName: string;
  toolInput: unknown;
  toolClass: "external_side_effect";
  requiredApprovalCapabilities?: readonly string[] | undefined;
  approvalAuthority?: {
    kind: RunnerExternalApprovalAuthorityKind;
    revision: string;
  } | undefined;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  executionPolicy: ExecutionPolicy | undefined;
  requestedAt: string;
  expiresAt: string;
}): RunnerExternalApprovalBindingV1 {
  const capabilities = [...new Set(input.requiredApprovalCapabilities ?? [])]
    .filter((capability) => capability.trim().length > 0)
    .sort();
  if (capabilities.length === 0) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_CAPABILITIES_REQUIRED",
      `External-effect tool '${input.toolName}' cannot request approval without contract-derived capabilities.`,
      {
        subsystem: "react",
        step: "agent.exec.dispatch",
        classification: "policy",
        recoverable: false,
        toolName: input.toolName,
      },
    );
  }
  const runtimePolicyRevision = buildRuntimePolicyRevision({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    executionPolicy: input.executionPolicy,
  });
  const toolAuthority = input.approvalAuthority ?? {
    kind: "runtime_policy" as const,
    revision: runtimePolicyRevision,
  };
  const authority = {
    kind: toolAuthority.kind,
    revision: digestApprovalPayload({
      version: "prepared-tool-approval-authority-v1",
      toolName: input.toolName,
      toolAuthorityRevision: toolAuthority.revision,
      runtimePolicyRevision,
    }),
  };
  return parseRunnerExternalApprovalBindingV1({
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
    approvalId: input.approvalId,
    threadId: input.threadId,
    runId: input.runId,
    actionKey: input.toolName,
    payloadHash: digestApprovalPayload(input.toolInput),
    toolClass: input.toolClass,
    capabilities,
    authorityKind: authority.kind,
    authorityRevision: authority.revision,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
  });
}

function buildExternalApprovalBindingV2(input: {
  preparedToolCall: PreparedToolCallV1;
  approvalId: string;
  toolClass: "external_side_effect";
  authorityKind: RunnerExternalApprovalAuthorityKind;
  requestedAt: string;
  expiresAt: string;
}): RunnerExternalApprovalBindingV2 {
  const stableAuthority = input.preparedToolCall.stableAuthority;
  const stableToolIdentity = input.preparedToolCall.stableToolIdentity;
  if (stableAuthority === undefined || stableToolIdentity === undefined) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_BINDING_INVALID",
      "A new-version external approval requires stable prepared authority.",
      { classification: "policy", recoverable: false },
    );
  }
  return parseRunnerExternalApprovalBindingV2({
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
    approvalId: input.approvalId,
    preparedInvocationId: input.preparedToolCall.callId,
    threadId: stableAuthority.threadId,
    actionKey: input.preparedToolCall.activation.descriptor.toolId,
    payloadHash: digestApprovalPayload(input.preparedToolCall.effectiveInput),
    stableAuthorityFingerprint: stableAuthority.fingerprint,
    stableToolIdentity,
    requestingActor: stableAuthority.actor,
    toolClass: input.toolClass,
    capabilities: stableAuthority.capabilities,
    authorityKind: input.authorityKind,
    authorityRevision: stableToolIdentity.approvalAuthorityRevision,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
  });
}

function validatePendingExternalApproval(input: {
  currentPendingApproval: Record<string, unknown> | undefined;
  expected: RunnerExternalApprovalBindingV1;
}): void {
  let pending: RunnerExternalApprovalBindingV1;
  try {
    pending = parseRunnerExternalApprovalBindingV1(
      input.currentPendingApproval?.externalApprovalBinding,
    );
  } catch (error) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_BINDING_INVALID",
      "External-effect approval is missing its exact action binding.",
      {
        subsystem: "react",
        step: "agent.exec.dispatch",
        classification: "policy",
        recoverable: false,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const expectedIdentity = {
    approvalId: input.expected.approvalId,
    threadId: input.expected.threadId,
    runId: input.expected.runId,
    actionKey: input.expected.actionKey,
    payloadHash: input.expected.payloadHash,
    toolClass: input.expected.toolClass,
    capabilities: input.expected.capabilities,
    authorityKind: input.expected.authorityKind,
    authorityRevision: input.expected.authorityRevision,
  };
  const pendingIdentity = {
    approvalId: pending.approvalId,
    threadId: pending.threadId,
    runId: pending.runId,
    actionKey: pending.actionKey,
    payloadHash: pending.payloadHash,
    toolClass: pending.toolClass,
    capabilities: pending.capabilities,
    authorityKind: pending.authorityKind,
    authorityRevision: pending.authorityRevision,
  };
  if (
    serializeCanonicalApprovalPayload(pendingIdentity) !==
    serializeCanonicalApprovalPayload(expectedIdentity)
  ) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_BINDING_CHANGED",
      "External-effect approval no longer matches the pending tool action.",
      {
        subsystem: "react",
        step: "agent.exec.dispatch",
        classification: "policy",
        recoverable: false,
        approvalId: pending.approvalId,
      },
    );
  }
  if (Date.parse(pending.expiresAt) <= Date.now()) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_EXPIRED",
      "External-effect approval expired before the action could resume.",
      {
        subsystem: "react",
        step: "agent.exec.dispatch",
        classification: "policy",
        recoverable: true,
        approvalId: pending.approvalId,
      },
    );
  }
}

function validatePendingExternalApprovalV2(input: {
  currentPendingApproval: Record<string, unknown> | undefined;
  preparedToolCall: PreparedToolCallV1;
  expected: RunnerExternalApprovalBindingV2;
}): void {
  let pending: RunnerExternalApprovalBindingV2;
  try {
    pending = parseRunnerExternalApprovalBindingV2(
      input.preparedToolCall.approval?.externalApprovalBinding,
    );
  } catch (error) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_BINDING_INVALID",
      "External-effect approval is missing its persisted prepared invocation binding.",
      {
        subsystem: "react",
        classification: "policy",
        recoverable: false,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const {
    requestedAt: _expectedRequestedAt,
    expiresAt: _expectedExpiresAt,
    ...expectedIdentity
  } = input.expected;
  const {
    requestedAt: _pendingRequestedAt,
    expiresAt: _pendingExpiresAt,
    ...pendingIdentity
  } = pending;
  if (
    serializeCanonicalApprovalPayload(pendingIdentity) !==
      serializeCanonicalApprovalPayload(expectedIdentity) ||
    input.currentPendingApproval?.version !== "hosted_tool_approval_v2" ||
    input.currentPendingApproval.preparedToolCall !== undefined ||
    asString(input.currentPendingApproval.preparedInvocationId) !==
      input.preparedToolCall.callId ||
    input.preparedToolCall.callId !== pending.preparedInvocationId ||
    input.preparedToolCall.stableAuthority?.fingerprint !==
      pending.stableAuthorityFingerprint ||
    input.preparedToolCall.stableToolIdentity?.approvalAuthorityRevision !==
      pending.authorityRevision ||
    serializeCanonicalApprovalPayload(input.preparedToolCall.stableToolIdentity) !==
      serializeCanonicalApprovalPayload(pending.stableToolIdentity) ||
    digestApprovalPayload(input.preparedToolCall.effectiveInput) !== pending.payloadHash
  ) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_BINDING_CHANGED",
      "External-effect approval no longer matches the persisted prepared invocation.",
      {
        subsystem: "react",
        classification: "policy",
        recoverable: false,
        approvalId: pending.approvalId,
      },
    );
  }
  if (Date.parse(pending.expiresAt) <= Date.now()) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_EXPIRED",
      "External-effect approval expired before the action could resume.",
      {
        subsystem: "react",
        classification: "policy",
        recoverable: true,
        approvalId: pending.approvalId,
      },
    );
  }
}

function digestApprovalPayload(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(serializeCanonicalApprovalPayload(value))
    .digest("hex")}`;
}

function buildRuntimePolicyRevision(input: {
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  executionPolicy: ExecutionPolicy | undefined;
}): string {
  return digestApprovalPayload({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode ?? null,
    executionPolicy: input.executionPolicy ?? null,
  });
}

function readApprovalThreadId(
  eventPayload: Record<string, unknown> | undefined,
): string | undefined {
  return (
    asString(asRecord(eventPayload?.orchestration)?.threadId) ??
    asString(asRecord(eventPayload?.metadata)?.threadId)
  );
}

function hasHostedPreparedApprovalAuthority(
  eventPayload: Record<string, unknown> | undefined,
): boolean {
  const authority = asRecord(eventPayload?.hostedApprovalAuthority);
  const actor = asRecord(eventPayload?.actor);
  return (
    asString(authority?.organizationId) !== undefined &&
    asString(authority?.environmentId) !== undefined &&
    asString(authority?.projectId) !== undefined &&
    asString(authority?.threadId) !== undefined &&
    asString(actor?.actorId) !== undefined
  );
}

function assertPreparedApprovalMatchesStableHostedAuthority(input: {
  preparedToolCall: PreparedToolCallV1;
  eventPayload: Record<string, unknown> | undefined;
  requiredCapabilities: readonly string[];
}): void {
  const authority = asRecord(input.eventPayload?.hostedApprovalAuthority);
  const actorInput = asRecord(input.eventPayload?.actor);
  const actorType = asString(actorInput?.actorType);
  const actorId = asString(actorInput?.actorId);
  const actorTenantId = asString(actorInput?.tenantId);
  const organizationId = asString(authority?.organizationId);
  const environmentId = asString(authority?.environmentId);
  const projectId = asString(authority?.projectId);
  const threadId = asString(authority?.threadId);
  if (
    authority?.version !== "runner_hosted_approval_authority_v1" ||
    (actorType !== "end_user" &&
      actorType !== "operator" &&
      actorType !== "service") ||
    actorId === undefined ||
    organizationId === undefined ||
    environmentId === undefined ||
    projectId === undefined ||
    threadId === undefined
  ) {
    throw new Error(
      "current hosted approval authority is missing or incomplete",
    );
  }
  if (actorTenantId !== undefined && actorTenantId !== organizationId) {
    throw new Error(
      "current hosted approval actor tenant does not match organization",
    );
  }
  const stableAuthority = input.preparedToolCall.stableAuthority;
  if (stableAuthority === undefined) {
    throw new Error(
      "persisted hosted approval is missing stable hosted authority",
    );
  }
  if (
    stableAuthority.actor.actorType !== actorType ||
    stableAuthority.actor.actorId !== actorId ||
    stableAuthority.actor.tenantId !== actorTenantId ||
    stableAuthority.organizationId !== organizationId ||
    stableAuthority.environmentId !== environmentId ||
    stableAuthority.projectId !== projectId ||
    stableAuthority.threadId !== threadId
  ) {
    throw new Error(
      "persisted hosted approval authority does not match the current hosted context",
    );
  }
  if (
    JSON.stringify([...stableAuthority.capabilities].sort()) !==
    JSON.stringify([...new Set(input.requiredCapabilities)].sort())
  ) {
    throw new Error(
      "persisted hosted approval capability context does not match the current tool",
    );
  }
}

function preparedApprovalMatchesCurrentHostedAuthority(input: {
  preparedToolCall: PreparedToolCallV1;
  policyRevision: string;
  approvalAuthorityRevision: string;
}): boolean {
  const stableAuthority = input.preparedToolCall.stableAuthority;
  if (stableAuthority === undefined) {
    throw new Error(
      "persisted hosted approval is missing stable hosted authority",
    );
  }
  return stableAuthority.policyRevision === input.policyRevision &&
    stableAuthority.approvalAuthorityRevision ===
      input.approvalAuthorityRevision;
}

async function resolveApprovalDecision(input: {
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  strictV2?: boolean | undefined;
  waitFor: { eventType: "user.approval"; metadata: Record<string, unknown> };
  model?: string | undefined;
  io?: StepIO | undefined;
}): Promise<"approve" | "deny" | undefined> {
  if (input.eventType !== "user.approval") {
    return ;
  }
  if (input.strictV2 === true) {
    if (
      input.eventPayload?.decision === "approve_once" ||
      input.eventPayload?.decision === "remember_approval"
    ) return "approve";
    if (input.eventPayload?.decision === "decline") return "deny";
    return ;
  }
  const existing = readHighConfidenceApprovalDecision(readUserReplyIntent(input.eventPayload?.userReplyIntent));
  if (existing !== undefined) {
    return existing;
  }
  const message = asString(input.eventPayload?.message) ?? asString(input.eventPayload?.text);
  const explicitDecision = readExplicitApprovalDecision(message);
  if (explicitDecision !== undefined) {
    if (input.eventPayload !== undefined) {
      input.eventPayload.userReplyIntent = {
        kind: "approval_decision",
        decision: explicitDecision,
        confidence: "high",
        reason: "explicit_approval_reply",
      };
    }
    return explicitDecision;
  }
  if (message === undefined || input.io === undefined) {
    return ;
  }
  const intent = await classifyUserReplyIntent({
    reply: message,
    waitFor: input.waitFor,
    model: input.model,
    useModel: input.io.useModel,
  });
  if (input.eventPayload !== undefined) {
    input.eventPayload.userReplyIntent = intent;
  }
  return readHighConfidenceApprovalDecision(intent);
}

function readExplicitApprovalDecision(value: unknown): "approve" | "deny" | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "approve") {
    return "approve";
  }
  if (normalized === "deny") {
    return "deny";
  }
  return ;
}

function riskLevelForToolClass(
  toolClass: ToolExecutionClass,
): "low" | "medium" | "high" {
  if (toolClass === "read_only" || toolClass === "planning_write") {
    return "low";
  }
  if (toolClass === "sandboxed_only") {
    return "medium";
  }
  return "high";
}

function isNoninteractiveEventPayload(
  eventPayload: Record<string, unknown> | undefined,
): boolean {
  return eventPayload?.noninteractive === true ||
    asRecord(eventPayload?.metadata)?.noninteractive === true;
}

function toNoninteractiveApprovalBlockedTransition(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  deliberationStepId: string;
  currentStepAgent: string;
  stepIndex: number;
  toolName: string;
  toolClass: ToolExecutionClass;
  reason: string;
}): Transition {
  const lastActionResult = {
    ok: false,
    kind: "approval_unavailable",
    status: "blocked",
    noninteractive: true,
    toolName: input.toolName,
    toolClass: input.toolClass,
    reason: input.reason,
    ts: new Date().toISOString(),
  };
  return createReferenceReactEffectCollectCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.currentStepAgent,
    nextStepAgent: input.deliberationStepId,
    stepIndex: input.stepIndex,
    activeRegion: input.activeRegion,
    phase: "THINK",
    reactPatch: {
      lastActionResult,
      observations: appendAgentObservation(input.reactState, lastActionResult),
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "noninteractive_approval_blocked",
          metadata: {
            toolName: input.toolName,
            toolClass: input.toolClass,
            reason: input.reason,
          },
        },
      ],
    },
    execPatch: {
      pendingApproval: undefined,
    },
    regionExecPatch: {
      pendingApproval: undefined,
    },
  });
}

function toPolicyBlockedTransition(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  acterStepId: string;
  stepIndex: number;
  toolName: string;
  toolClass: ToolExecutionClass;
  reason: string;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  blockedCapability?: string | undefined;
}): Transition {
  const guidance = buildModeBlockedWaitGuidance({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    requiredToolClass: input.toolClass,
  });
  const prompt = input.blockedCapability !== undefined
    ? [
        `Question: The current execution policy blocks capability '${input.blockedCapability}' for ${input.toolName}.`,
        "Reply with an alternative allowed approach or explicitly change policy before retrying.",
        "The run will resume automatically after your reply.",
      ].join("\n")
    : guidance.prompt;
  const waitFor: WaitForMatcher = {
    kind: "user",
    eventType: "user.reply",
    metadata: {
      waitContractVersion: 1,
      reason: "acter_mode_blocked",
      blockedActionKind: "executable_action",
      blockedActionId: input.toolName,
      reasonCode: input.blockedCapability !== undefined ? "capability_policy_blocked" : "mode_policy_blocked",
      toolName: input.toolName,
      requiredToolClass: input.toolClass,
      ...(input.blockedCapability !== undefined ? { blockedCapability: input.blockedCapability } : {}),
      question: input.blockedCapability !== undefined
        ? `The current execution policy blocks capability '${input.blockedCapability}' for ${input.toolName}.`
        : guidance.question,
      resumeReply: input.blockedCapability !== undefined ? "use a different allowed tool" : guidance.resumeReply,
      resumeCommand: input.blockedCapability !== undefined ? "" : guidance.resumeCommand,
      resumeHint: input.blockedCapability !== undefined
        ? "Reply with a different allowed approach or an explicit policy change."
        : "Reply after switching to an execution mode that allows this action.",
      prompt,
    },
  };
  const lastActionResult = {
    ok: false,
    kind: "policy_feedback",
    status: "blocked",
    prompt,
    blockedTool: input.toolName,
    policy: {
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      toolClass: input.toolClass,
    },
    ts: new Date().toISOString(),
  };
  return createReferenceReactWaitCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.acterStepId,
    nextStepAgent: input.acterStepId,
    stepIndex: input.stepIndex,
    waitFor,
    substate: "wait_user",
    emitEvents: [
      {
        type: "ui.prompt",
        payload: {
          text: prompt,
        },
      },
    ],
    activeRegion: input.activeRegion,
    phase: "ACT",
    reactPatch: {
      lastActionResult,
      observations: appendAgentObservation(input.reactState, lastActionResult),
      nextAction: {
        kind: "ask_user",
        prompt,
        waitFor,
      },
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "tool_policy_blocked",
          metadata: {
            toolName: input.toolName,
            toolClass: input.toolClass,
            interactionMode: input.interactionMode,
            actSubmode: input.actSubmode,
            reason: input.reason,
            prompt,
          },
        },
      ],
    },
    execPatch: {},
    regionReactPatch: {
      lastActionResult,
    },
    regionExecPatch: {},
  });
}

async function maybeRequireAutonomyEscalation(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  acterStepId: string;
  deliberationStepId: string;
  currentStepAgent: string;
  loopStepId: string;
  runId: string;
  stepIndex: number;
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  policy: AutonomyPolicy;
  actionKey: string;
  actionLabel: string;
  toolClass: ToolExecutionClass;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  model?: string | undefined;
  io: StepIO;
  evidence: string[];
  riskSignals: string[];
}): Promise<Transition | undefined> {
  const autonomy = evaluateAutonomyPolicy({
    policy: input.policy,
    action: input.actionKey,
    evidence: input.evidence,
    riskSignals: input.riskSignals,
  });
  if (autonomy.allowed && autonomy.escalateReasons.length === 0) {
    return ;
  }

  if (isNoninteractiveEventPayload(input.eventPayload)) {
    return toNoninteractiveApprovalBlockedTransition({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      deliberationStepId: input.deliberationStepId,
      currentStepAgent: input.currentStepAgent,
      stepIndex: input.stepIndex,
      toolName: input.actionLabel,
      toolClass: input.toolClass,
      reason: `Action '${input.actionLabel}' requires autonomy-policy approval, which an autonomous turn cannot request.`,
    });
  }

  const approvalPayload = {
    actionKey: input.actionKey,
    actionLabel: input.actionLabel,
    missingEvidence: autonomy.missingEvidence,
    escalateReasons: autonomy.escalateReasons,
    policyLevel: input.policy.level,
  };
  const approvalId = buildApprovalId(
    input.runId,
    input.stepIndex,
    `autonomy:${input.actionLabel}`,
    approvalPayload,
  );
  const currentPendingApproval = asRecord(asRecord(input.reactState.exec)?.pendingApproval);
  const currentPendingApprovalId = asString(currentPendingApproval?.approvalId);
  const decision = await resolveApprovalDecision({
    eventType: input.eventType,
    eventPayload: input.eventPayload,
    model: input.model,
    io: input.io,
    waitFor: {
      eventType: "user.approval",
      metadata: {
        approvalId,
        toolName: input.actionLabel,
        toolClass: input.toolClass,
        policyLevel: input.policy.level,
        reason: "Autonomy escalation approval required",
      },
    },
  });

  if (
    input.eventType === "user.approval" &&
    currentPendingApprovalId === approvalId &&
    decision === "approve"
  ) {
    return ;
  }
  if (
    input.eventType === "user.approval" &&
    currentPendingApprovalId === approvalId &&
    decision === "deny"
  ) {
    return toPolicyBlockedTransition({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      acterStepId: input.acterStepId,
      stepIndex: input.stepIndex,
      toolName: input.actionLabel,
      toolClass: input.toolClass,
      reason: `Autonomy escalation denied at ${input.policy.level}.`,
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
    });
  }

  const prompt =
    autonomy.missingEvidence.length > 0
      ? `Autonomy ${input.policy.level} requires review before ${input.actionLabel}. Missing evidence: ${autonomy.missingEvidence.join(", ")}. Reply 'approve' or 'deny'.`
      : `Autonomy ${input.policy.level} requires review before ${input.actionLabel}. Risk signals: ${autonomy.escalateReasons.join(", ")}. Reply 'approve' or 'deny'.`;
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const waitFor: WaitForMatcher = {
    kind: "approval",
    eventType: "user.approval",
    metadata: {
      approvalId,
      toolName: input.actionLabel,
      toolClass: input.toolClass,
      policyLevel: input.policy.level,
      missingEvidence: autonomy.missingEvidence,
      escalateReasons: autonomy.escalateReasons,
      prompt,
      expiresAt,
    },
  };

  return createReferenceReactWaitCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.acterStepId,
    nextStepAgent: input.acterStepId,
    stepIndex: input.stepIndex,
    waitFor,
    substate: "wait_approval",
    emitEvents: [
      {
        type: "ui.prompt",
        payload: {
          text: prompt,
        },
      },
    ],
    activeRegion: input.activeRegion,
    phase: "ACT",
    reactPatch: {
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "tool_approval_requested",
          metadata: {
            approvalId,
            toolName: input.actionLabel,
            toolClass: input.toolClass,
            policyLevel: input.policy.level,
            missingEvidence: autonomy.missingEvidence,
            escalateReasons: autonomy.escalateReasons,
          },
        },
      ],
    },
    execPatch: {
      pendingApproval: {
        approvalId,
        toolName: input.actionLabel,
        toolClass: input.toolClass,
        expiresAt,
        policyLevel: input.policy.level,
      },
    },
    regionExecPatch: {
      pendingApproval: {
        approvalId,
        toolName: input.actionLabel,
        toolClass: input.toolClass,
        expiresAt,
        policyLevel: input.policy.level,
      },
    },
  });
}

function stableStringify(value: unknown): string {
  return stringifySanitizedJson(sortValue(sanitizeJsonValue(value)));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}
