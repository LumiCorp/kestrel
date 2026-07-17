import { createHash } from "node:crypto";

import type { StepIO, Transition, WaitForMatcher } from "../../../../../src/kestrel/contracts/execution.js";

import { createRuntimeFailure } from "../../../../../src/runtime/RuntimeFailure.js";
import { evaluateAutonomyPolicy } from "../../../../../src/governance/autonomy.js";
import type { AutonomyPolicy } from "../../../../../src/governance/contracts.js";
import {
  areApprovalCapabilitiesAllowed,
  isToolEligibleForInteractionMode,
  needsPerCallApproval,
  readBlockedApprovalCapability,
} from "../../../../../src/mode/contracts.js";
import { isMutationCapableToolName } from "../../../../../src/runtime/mutationTools.js";
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
  | { kind: "allowed" }
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
  });
  if (modeGate.kind === "blocked") {
    return modeGate;
  }

  if (input.autonomyPolicy !== undefined) {
    const autonomyTransition = await maybeRequireAutonomyEscalation({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      acterStepId: input.acterStepId,
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
      io: input.io,
    });
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
    (requiresExplicitToolApproval({
        interactionMode: input.interactionMode,
        actSubmode: input.actSubmode,
        executionPolicy: input.executionPolicy,
        requiredApprovalCapabilities: input.items.flatMap(
          (item) => input.toolApprovalCapabilitiesByName[item.name] ?? []
        ),
      }))
  ) {
    return {
      kind: "blocked",
      transition: toPolicyBlockedTransition({
        reactState: input.reactState,
        activeRegion: input.activeRegion,
        acterStepId: input.acterStepId,
        stepIndex: input.stepIndex,
        toolName: "tool_batch",
        toolClass: "external_side_effect",
        reason: "tool_batch is not supported in Build: Ask First; use single tool calls",
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
    const classAllowed = isToolEligibleForInteractionMode({
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      toolClass,
      allowedInteractionModes: input.toolAllowedInteractionModesByName[item.name],
      executionPolicy: input.executionPolicy,
    });
    if (classAllowed === false) {
      return true;
    }
    return areApprovalCapabilitiesAllowed({
      executionPolicy: input.executionPolicy,
      requiredCapabilities: input.toolApprovalCapabilitiesByName[item.name],
    }) === false;
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
}): PolicyGateResult {
  if (
    isToolEligibleForInteractionMode({
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      toolClass: input.toolClass,
      allowedInteractionModes: input.allowedInteractionModes,
      executionPolicy: input.executionPolicy,
    }) === false
  ) {
    return {
      kind: "blocked",
      transition: toPolicyBlockedTransition({
        reactState: input.reactState,
        activeRegion: input.activeRegion,
        acterStepId: input.acterStepId,
        stepIndex: input.stepIndex,
        toolName: input.toolName,
        toolClass: input.toolClass,
        reason: "tool class is blocked by current interaction mode or execution policy",
        interactionMode: input.interactionMode,
        actSubmode: input.actSubmode,
      }),
    };
  }

  const blockedCapability = readBlockedApprovalCapability({
    executionPolicy: input.executionPolicy,
    requiredCapabilities: input.requiredApprovalCapabilities,
  });
  if (blockedCapability === undefined) {
    return { kind: "allowed" };
  }

  return {
    kind: "blocked",
    transition: toPolicyBlockedTransition({
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      acterStepId: input.acterStepId,
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      toolClass: input.toolClass,
      reason: `tool requires blocked capability '${blockedCapability}'`,
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      blockedCapability,
    }),
  };
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
}): Promise<Transition | undefined> {
  if (
    !requiresExplicitToolApproval({
      interactionMode: input.interactionMode,
      actSubmode: input.actSubmode,
      executionPolicy: input.executionPolicy,
      requiredApprovalCapabilities: input.requiredApprovalCapabilities,
    })
  ) {
    return ;
  }

  const approvalId = buildApprovalId(input.runId, input.stepIndex, input.toolName, input.toolInput);
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
        toolName: input.toolName,
        toolClass: input.toolClass,
        reason: "Build: Ask First requires per-call approval",
      },
    },
  });

  if (input.eventType === "user.approval" && currentPendingApprovalId === approvalId && decision === "approve") {
    return ;
  }

  if (input.eventType === "user.approval" && currentPendingApprovalId === approvalId && decision === "deny") {
    const lastActionResult = {
      ok: false,
      kind: "approval_denial",
      status: "denied",
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
      reactPatch: {
        lastActionResult,
        observations: appendAgentObservation(input.reactState, lastActionResult),
        decisionTrace: [
          {
            eventType: "decision.executed",
            phase: "acter",
            decisionCode: "tool_approval_denied",
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

  const prompt = `Approve ${input.toolName}? Reply 'approve' or 'deny'.`;
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const waitFor: WaitForMatcher = {
    kind: "approval",
    eventType: "user.approval",
    metadata: {
      approvalId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolClass: input.toolClass,
      riskLevel: riskLevelForToolClass(input.toolClass),
      reason: "Build: Ask First requires per-call approval",
      expiresAt,
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
        approvalId,
        toolName: input.toolName,
        toolClass: input.toolClass,
        expiresAt,
      },
    },
    regionExecPatch: {
      pendingApproval: {
        approvalId,
        toolName: input.toolName,
        toolClass: input.toolClass,
        expiresAt,
      },
    },
  });
}

export function requiresExplicitToolApproval(input: {
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  executionPolicy: ExecutionPolicy | undefined;
  requiredApprovalCapabilities?: readonly string[] | undefined;
}) {
  return (
    input.requiredApprovalCapabilities?.includes("external.confirm") === true ||
    needsPerCallApproval(input)
  );
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

async function resolveApprovalDecision(input: {
  eventType: string;
  eventPayload: Record<string, unknown> | undefined;
  waitFor: { eventType: "user.approval"; metadata: Record<string, unknown> };
  model?: string | undefined;
  io?: StepIO | undefined;
}): Promise<"approve" | "deny" | undefined> {
  if (input.eventType !== "user.approval") {
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
