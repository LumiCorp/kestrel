import type { StepAgent, StepContext, StepIO, Transition, UserWaitForMatcher } from "../../../../src/kestrel/contracts/execution.js";
import type { ModelReasoningRequest, ModelRequest, ModelResponse, ModelToolSpec } from "../../../../src/kestrel/contracts/model-io.js";
import {
  buildModelRequestEconomicsManifest,
  buildToolSurfaceManifest,
  countTextTokens,
  parseHarnessEconomicsControlV1,
  resolveModelEconomicsProfileV1,
  resolveModelTokenCounter,
  selectToolsForEconomicsPolicyV1,
  type HarnessEconomicsPolicyV1,
  type ModelEconomicsProfileV1,
  type ToolExposureSelectionV1,
} from "../../../../src/economics/index.js";

import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  formatUserFacingModeLabel,
  isToolClassAllowed,
  isToolEligibleForInteractionMode,
  needsPerCallApproval,
  normalizeInteractionMode,
  parseExecutionPolicyOverride,
  readBlockedApprovalCapability,
  type ActSubmode,
  type ExecutionPolicyOverride,
  type InteractionMode,
  type ToolExecutionClass,
} from "../../../../src/mode/contracts.js";
import { resolveBlockedResumeRequest } from "../blockedResume.js";
import {
  compileAgentAction,
  compileIntentState,
  buildToolIntentContextFromCompiledIntent,
  evaluateGoalSatisfiedCloseoutReadiness,
  mapDecisionCompileError,
  type CompiledDecision,
  type DecisionPhase,
} from "../decision/compileIntent.js";
import {
  type ParsedExecutionIntentState,
  buildParsedExecutionIntentState,
  buildToolIntentContext,
} from "../toolIntent.js";
import {
  buildInternalDecisionContext,
  type InternalDecisionContext,
} from "../context/InternalDecisionContext.js";
import {
  buildKestrelAgentContext as buildContextRequest,
  buildKestrelAgentCompactedTranscript,
  buildKestrelAgentCompactionMessages,
  buildKestrelCompactionSummarySchema,
  buildKestrelCompactionSufficiencyMessages,
  buildKestrelAgentValidationFeedbackMessage,
  estimateKestrelCompactionSourceTokens,
  planKestrelAgentCompaction,
  shouldCompactKestrelAgentContext,
  KESTREL_COMPACTION_SUMMARY_SCHEMA,
  KESTREL_COMPACTION_SUFFICIENCY_SCHEMA,
  parseKestrelCompactionSummaryV2,
  parseKestrelCompactionSufficiencyVerdictV1,
  type KestrelAgentCannotSatisfyReasonCode,
  type KestrelAgentCompactionCorrectionV1,
  type KestrelCompactionSummaryV2,
  type KestrelAgentFinalizeStatus,
} from "../../../../src/runtime/KestrelAgentContextBuilder.js";
import {
  RuntimeFailure,
  createRuntimeFailure,
} from "../../../../src/runtime/RuntimeFailure.js";
import {
  appendAssistantToolCallsToTranscript,
  appendCorrectionToTranscript,
  appendToolResultToTranscript,
  appendTodoUpdateToTranscript,
  estimateModelTranscriptItemsTokens,
  findUserTranscriptItemIdBySourceEvent,
  planTokenBudgetedModelTranscriptCompaction,
  readActiveTaskItemIdFromTranscript,
  normalizeModelTranscript,
  rebaseModelTranscriptForFreshTask,
  type ModelTranscript,
  type ModelTranscriptCompactionPlan,
} from "../../../../src/runtime/modelTranscript.js";
import {
  resolveDeliberatorPromptVariant,
} from "../prompt/deliberatorPrompt.js";
import { readActiveProjectContext } from "../prompt/projectContext.js";
import {
  buildWorkspaceModelContext,
  readActiveWorkspaceContext,
} from "../prompt/workspace.js";
import type { ReferenceReactAgentState } from "../state.js";
import {
  createReferenceReactLastActionResultPatch,
  createReferenceReactNextActionPatch,
  createReferenceReactRetryContextPatch,
  createReferenceReactTerminalPatch,
  createReferenceReactWaitingForPatch,
  getAgentStateFromRuntimeState,
} from "../state.js";
import { buildReferenceReactCommandBatchFromAction } from "../commandProcessor.js";
import { isFilesystemInspectionToolName } from "../filesystemInspection.js";
import {
  filterDeliberatorToolsForContext,
  type DeliberatorToolAvailability,
} from "../deliberatorToolSurface.js";
import {
  ModelToolCallActionError,
  buildModelToolAliasRegistry,
  normalizeModelToolCallsToAgentTurn,
} from "../modelToolCallActions.js";
import type {
  DecisionFailureCode,
  DecisionContextExecutionIntent,
  DecisionTrace,
  FilesystemInventoryFact,
  ToolCapabilityManifestItem,
} from "../types.js";
import { normalizeContinuationOffer } from "../../../../src/runtime/continuationOffer.js";
import {
  approveRuntimeContinuation,
  createRuntimeContinuationState,
  invalidateRuntimeContinuation,
  normalizeRuntimeContinuationState,
  type RuntimeContinuationInvalidationReason,
  type RuntimeContinuationStateV1,
} from "../../../../src/runtime/continuationState.js";
import { normalizeRuntimePlanDocumentSnapshot } from "../../../../src/runtime/planDocument.js";
import {
  analyzeVisibleTodoFinalizeReadiness,
  normalizeVisibleTodoState,
  normalizeVisibleTodoResidualGapData,
  renderVisibleTodosForModel,
  type VisibleTodoState,
} from "../../../../src/runtime/visibleTodos.js";
import {
  classifyUserReplyIntent,
  isHighConfidenceContinuation,
} from "../../../../src/runtime/userReplyIntent.js";
import { readActiveWaitState } from "../../../../src/runtime/waitState.js";
import { readActiveSkillPackContext } from "../../../../src/runtime/agent-context/runtimeContext.js";
import {
  buildActiveProcessEvidence,
  buildRecentFilesystemEvidence,
  buildRecentToolResultEvidence,
} from "../../../../src/runtime/agent-context/evidenceContext.js";
import {
  resolveKestrelTurnObjective,
  readActiveTaskGoalFromState,
  readActiveTaskItemIdFromState,
  readActiveTurnIntent,
  readSubmissionKind,
  readTurnPayloadInstruction,
  shouldPreserveTranscriptTaskForTurn,
  shouldStartFreshUserMessageTaskEpoch,
  type ActiveTurnIntentV1,
  type ConversationSubmissionKind,
} from "../../../../src/runtime/turnObjective.js";
import { buildModeBlockedWaitGuidance } from "./modeBlockedPrompt.js";

interface AgentLoopStepConfig {
  agentProvider?: string | undefined;
  agentModel: string;
  maintenanceModel?: string | undefined;
  agentToolsProvider: (ctx: StepContext) => ModelToolSpec[];
  capabilityManifestProvider: (ctx: StepContext) => ToolCapabilityManifestItem[];
  defaultGoal: string;
  loopStepId: string;
  execDispatchStepId: string;
  reasoningRequest?: Omit<ModelReasoningRequest, "continuation"> | undefined;
  reasoningRetention?: { mode: "live_only" | "provider_visible"; days: number } | undefined;
  reasoningRetentionScope?: string | undefined;
}

const DELIBERATOR_SCHEMA_RETRY_LIMIT = 3;
const EXECUTION_MODE_CONTROL_TOOL_NAMES = [
  "kestrel.finalize",
  "kestrel.ask_user",
  "kestrel.cannot_satisfy",
  "kestrel.request_mode_switch",
  "kestrel.switch_mode",
  "kestrel.todo_update",
] as const;
const NONINTERACTIVE_EXECUTION_MODE_CONTROL_TOOL_NAMES = [
  "kestrel.finalize",
  "kestrel.cannot_satisfy",
  "kestrel.request_mode_switch",
  "kestrel.switch_mode",
  "kestrel.todo_update",
] as const;
const PLAN_MODE_CONTROL_TOOL_NAMES = [
  ...EXECUTION_MODE_CONTROL_TOOL_NAMES,
  "kestrel.handoff_to_build",
] as const;
const CLOSEOUT_CONTROL_TOOL_NAMES = new Set([
  "kestrel.finalize",
  "kestrel.cannot_satisfy",
  "kestrel.ask_user",
  "kestrel.handoff_to_build",
]);

function controlToolNamesForInteractionMode(input: {
  interactionMode: InteractionMode;
  eventType: string;
  eventPayload: Record<string, unknown>;
  executableWorkspaceToolsAvailable: boolean;
  modeSwitchRequestAvailable: boolean;
}): readonly string[] {
  const withAvailableModeRequest = (names: readonly string[]) =>
    input.modeSwitchRequestAvailable
      ? names
      : names.filter((name) => name !== "kestrel.request_mode_switch");
  if (input.interactionMode === "build" && input.executableWorkspaceToolsAvailable) {
    const buildControlTools = isNoninteractiveExecutionContext(input.eventType, input.eventPayload)
      ? NONINTERACTIVE_EXECUTION_MODE_CONTROL_TOOL_NAMES
      : EXECUTION_MODE_CONTROL_TOOL_NAMES;
    return withAvailableModeRequest(
      buildControlTools.filter((name) => name !== "kestrel.cannot_satisfy"),
    );
  }
  if (isNoninteractiveExecutionContext(input.eventType, input.eventPayload)) {
    return withAvailableModeRequest(input.interactionMode === "plan"
      ? PLAN_MODE_CONTROL_TOOL_NAMES.filter((name) => name !== "kestrel.ask_user")
      : NONINTERACTIVE_EXECUTION_MODE_CONTROL_TOOL_NAMES);
  }
  return withAvailableModeRequest(input.interactionMode === "plan"
    ? PLAN_MODE_CONTROL_TOOL_NAMES
    : EXECUTION_MODE_CONTROL_TOOL_NAMES);
}

function finalizeStatusesForInteractionMode(input: {
  interactionMode: InteractionMode;
  executableWorkspaceToolsAvailable: boolean;
}): readonly KestrelAgentFinalizeStatus[] | undefined {
  if (input.interactionMode === "build") {
    return ["goal_satisfied", "out_of_scope"];
  }
  return ;
}

function cannotSatisfyReasonCodesForInteractionMode(input: {
  interactionMode: InteractionMode;
}): readonly KestrelAgentCannotSatisfyReasonCode[] | undefined {
  if (input.interactionMode !== "build") {
    return ;
  }
  return ["missing_required_capability", "requested_tool_unavailable"];
}

function isNoninteractiveExecutionContext(eventType: string, eventPayload: Record<string, unknown>): boolean {
  if (eventType === "job.run") {
    return true;
  }
  const benchmark = asRecord(eventPayload.benchmark) ??
    asRecord(asRecord(eventPayload.metadata)?.benchmark);
  const context = asRecord(benchmark?.context);
  return benchmark?.name === "terminal-bench" || context?.source === "terminal-bench";
}

/**
 * Deliberator chooses the next executable action.
 */
export function createAgentLoopStep(config: AgentLoopStepConfig): StepAgent {
  return async (ctx, io) => {
    const deliberatorTools = config.agentToolsProvider(ctx);
    const capabilityManifest = config.capabilityManifestProvider(ctx);
    let reactState = getAgentStateFromRuntimeState(ctx.session.state);
    let eventPayload = asRecord(ctx.event.payload) ?? {};
    const eventIdentity = ctx.event.id ?? ctx.runId;
    const inferredContinuationResume = await shouldTreatUserReplyAsContinuationResume({
      eventType: ctx.event.type,
      eventPayload,
      reactState,
      model: config.agentModel,
      io,
    });
    if (inferredContinuationResume === true) {
      eventPayload = {
        ...eventPayload,
        resumeBlockedRun: true,
      };
    }
    eventPayload = attachTurnIdentityMetadata({
      eventId: eventIdentity,
      eventType: ctx.event.type,
      eventPayload,
      reactState,
    });
    reactState = resetTaskScopedStateForFreshUserMessageEpoch({
      eventId: eventIdentity,
      eventType: ctx.event.type,
      eventPayload,
      reactState,
    });
    const resumeRequest = resolveBlockedResumeRequest(reactState, {
      ...ctx.event,
      payload: eventPayload,
    });
    const persistedGoal = asString(reactState.goal)?.trim();
    const isResumeTurn = eventPayload.resumeBlockedRun === true;
    const fallbackGoal =
      resumeRequest.goal ??
      (isResumeTurn && persistedGoal !== undefined && persistedGoal.length > 0
        ? persistedGoal
        : undefined);
    let goal = resolveKestrelTurnObjective({
      reactState,
      eventType: ctx.event.type,
      eventPayload,
      fallbackGoal,
      eventId: eventIdentity,
    }).goal ?? config.defaultGoal;
    if (resumeRequest.applyEventOverride === true) {
      eventPayload = {
        ...eventPayload,
        message: resumeRequest.userRequest,
        goal,
      };
    }
    eventPayload = {
      ...eventPayload,
      ...(resumeRequest.interactionMode !== undefined
        ? { interactionMode: resumeRequest.interactionMode }
        : {}),
      ...(resumeRequest.actSubmode !== undefined ? { actSubmode: resumeRequest.actSubmode } : {}),
      ...(resumeRequest.resumeBlockedRun === true ? { resumeBlockedRun: true } : {}),
    };
    const modeResolution = normalizeInteractionMode({
      interactionMode: eventPayload.interactionMode ?? reactState.interactionMode,
      actSubmode: eventPayload.actSubmode ?? reactState.actSubmode,
      defaultInteractionMode: DEFAULT_INTERACTION_MODE,
      defaultActSubmode: DEFAULT_ACT_SUBMODE,
    });
    const executionPolicy = parseExecutionPolicyOverride(
      eventPayload.executionPolicy ?? reactState.executionPolicy,
    );
    reactState = normalizeLegacyContinuationRuntimeState(reactState);
    const activeContinuation = normalizeRuntimeContinuationState(reactState.activeContinuation);
    if (isPendingRuntimeContinuationReply(reactState, ctx.event.type)) {
      if (activeContinuation === undefined) {
        return toContinuationInvalidatedTransition({
          stepIndex: ctx.stepIndex,
          loopStepId: config.loopStepId,
          execDispatchStepId: config.execDispatchStepId,
          reactState,
          goal,
          reason: "missing_continuation",
        });
      }
      const invalidationReason = validateRuntimeContinuationResume({
        reactState,
        activeContinuation,
      });
      if (invalidationReason !== undefined) {
        return toContinuationInvalidatedTransition({
          stepIndex: ctx.stepIndex,
          loopStepId: config.loopStepId,
          execDispatchStepId: config.execDispatchStepId,
          reactState,
          goal,
          activeContinuation,
          reason: invalidationReason,
        });
      }
      if (
        isToolClassAllowed({
          interactionMode: modeResolution.interactionMode,
          actSubmode: modeResolution.actSubmode,
          toolClass: activeContinuation.requiredToolClass,
          executionPolicy,
        }) === false
      ) {
        return toPlannerModeBlockedTransition({
          stepIndex: ctx.stepIndex,
          loopStepId: config.loopStepId,
          execDispatchStepId: config.execDispatchStepId,
          reactState,
          goal: activeContinuation.objective,
          interactionMode: modeResolution.interactionMode,
          actSubmode: modeResolution.actSubmode,
          requiredToolClass: activeContinuation.requiredToolClass,
          blockedActionKind: "continuation_offer",
          blockedActionId: activeContinuation.sourceRunId,
          activeContinuation,
        });
      }

      reactState = {
        ...reactState,
        activeContinuation: approveRuntimeContinuation(activeContinuation),
        pendingContinuationOffer: undefined,
      };
      goal = activeContinuation.objective;
      eventPayload = {
        ...eventPayload,
        goal: activeContinuation.objective,
        resumeBlockedRun: true,
      };
    }
    const decisionContext = buildInternalDecisionContext({
      reactState,
      eventPayload,
    });
    const activeWorkspace = readActiveWorkspaceContext(ctx.event.payload.workspace);
    const projectSnapshot = readProjectSnapshotContext(ctx.session.state);

    const activeWorkspaceModelContext = buildWorkspaceModelContext(activeWorkspace);
    const activeWorkspaceSkills = ctx.event.payload.workspaceSkills;
    const activeProjectContext = readActiveProjectContext(ctx.event.payload.projectContext);
    const activeSkillPackContext = readActiveSkillPackContext(ctx.event.payload.skillPack);
    const runtimeEconomics = readRuntimeEconomics(eventPayload);
    const closeoutAttemptActive = isCloseoutAttemptActive(reactState.closeoutLatch);
    const tokenCounter = runtimeEconomics.modelProfile?.counting.method === "model_tokenizer"
      ? resolveModelTokenCounter(
          runtimeEconomics.modelProfile.counting.counter,
          runtimeEconomics.modelProfile.counting.counterVersion,
        )
      : undefined;
    const modeScopedDeliberatorTools = closeoutAttemptActive
      ? []
      : filterDeliberatorToolsForMode({
          tools: deliberatorTools,
          capabilityManifest,
          modeResolution,
          executionPolicy,
        });
    const economicsScopedDeliberatorTools = selectToolsForEconomicsPolicyV1({
      tools: modeScopedDeliberatorTools,
      capabilityManifest,
      ...(runtimeEconomics.policy !== undefined ? { policy: runtimeEconomics.policy } : {}),
      phase: "agent.loop",
    });
    const activeDevShellProcesses = buildDevShellToolFilterProcesses(
      decisionContext.devShellProcesses,
      asRecord(reactState.postToolVerification),
    );
    const initialFilteredTools = filterDeliberatorToolsForContext(
      economicsScopedDeliberatorTools.tools,
      {
        devShellProcesses: activeDevShellProcesses,
        postToolVerification: asRecord(reactState.postToolVerification),
        managedEntrypoints: decisionContext.managedEntrypoints,
        artifactTarget: readManagedEntrypointToolFilterArtifactTarget(decisionContext),
      },
    );
    const executableWorkspaceToolsAvailable = hasExecutableWorkspaceTools({
      tools: initialFilteredTools.tools,
      capabilityManifest,
    });
    const resolvedPromptVariant = resolveDeliberatorPromptVariant({
      interactionMode: modeResolution.interactionMode,
      promptVariant: readRuntimeAssemblyPromptVariant(eventPayload),
    });
    let contextRequest = buildContextRequest({
      reactState,
      eventPayload,
      goal,
      eventType: ctx.event.type,
      interactionMode: modeResolution.interactionMode,
      actSubmode: modeResolution.actSubmode,
      projectSnapshot,
      promptVariant: resolvedPromptVariant,
      systemPrompt: {
        kind: "kestrel-deliberator",
        interactionMode: modeResolution.interactionMode,
        promptVariant: resolvedPromptVariant,
        ...readRuntimeShellKind(eventPayload),
        ...readSystemInstructions(eventPayload),
      },
      retryContext: asRecord(reactState.retryContext),
      activeWorkspace: activeWorkspaceModelContext,
      activeWorkspaceSkills,
      activeProjectContext,
      activeSkillPack: activeSkillPackContext,
      stepIndex: ctx.stepIndex,
      ...(tokenCounter !== undefined ? { tokenCounter } : {}),
    });
    const activeTurnIntent = resolveActiveTurnIntentForContext({
      reactState,
      eventId: eventIdentity,
      eventPayload,
      goal,
      transcript: contextRequest.transcript,
    });
    reactState = {
      ...reactState,
      ...(activeTurnIntent !== undefined ? { activeTurnIntent } : {}),
    };
    const observedCapabilities =
      extractObservedCapabilitiesFromFeedback(reactState);
    const canonicalIntentContext = readCanonicalIntentContextFromState(
      reactState,
      capabilityManifest,
    );
    const closeoutReadiness = evaluateGoalSatisfiedCloseoutReadiness({
      interactionMode: modeResolution.interactionMode,
      observedCapabilities,
      ...canonicalIntentContext,
      postToolVerification: asRecord(reactState.postToolVerification),
      lastActionResult: reactState.lastActionResult,
      devShellProcesses: activeDevShellProcesses,
      evidenceContext: decisionContext.evidenceContext,
      evidenceLedger: decisionContext.evidenceLedger,
      visibleTodos: decisionContext.visibleTodos,
      hasPendingExecutionBoundary: hasPendingExecutionBoundary(reactState),
    });
    const closeoutOnly = closeoutReadiness.ready;
    const projectedDeliberatorTools = closeoutOnly ? [] : initialFilteredTools.tools;
    const initialParallelToolCalls = closeoutOnly
      ? false
      : shouldEnableParallelToolCalls({
          tools: projectedDeliberatorTools,
          capabilityManifest,
          modeResolution,
          executionPolicy,
        });
    const availableModeControlToolNames = controlToolNamesForInteractionMode({
      interactionMode: modeResolution.interactionMode,
      eventType: ctx.event.type,
      eventPayload,
      executableWorkspaceToolsAvailable,
      modeSwitchRequestAvailable: hasModeHiddenWorkspaceTool({
        allTools: deliberatorTools,
        modeScopedTools: modeScopedDeliberatorTools,
        capabilityManifest,
        modeResolution,
        executionPolicy,
      }),
    });
    const modeScopedControlToolNames = closeoutOnly
      ? ["kestrel.finalize"] as const
      : closeoutAttemptActive
        ? availableModeControlToolNames.filter((name) => CLOSEOUT_CONTROL_TOOL_NAMES.has(name))
        : availableModeControlToolNames;
    const askUserAvailable = modeScopedControlToolNames.some(
      (name) => name === "kestrel.ask_user",
    );
    const finalizeStatuses = closeoutOnly
      ? ["goal_satisfied"] as const
      : finalizeStatusesForInteractionMode({
          interactionMode: modeResolution.interactionMode,
          executableWorkspaceToolsAvailable,
        });
    const cannotSatisfyReasonCodes = closeoutOnly
      ? undefined
      : cannotSatisfyReasonCodesForInteractionMode({
        interactionMode: modeResolution.interactionMode,
      });
    const initialActionTools = buildModelToolAliasRegistry(
      projectedDeliberatorTools,
      {
        controlToolNames: modeScopedControlToolNames,
        finalizeStatuses,
        cannotSatisfyReasonCodes,
      },
    ).requestTools;
    contextRequest = await compactContextRequestIfNeeded({
      io,
      config,
      contextRequest,
      actionTools: initialActionTools,
      actionParallelToolCalls: initialParallelToolCalls,
      reactState,
      eventPayload,
      goal,
      retryContext: asRecord(reactState.retryContext),
      eventType: ctx.event.type,
      interactionMode: modeResolution.interactionMode,
      actSubmode: modeResolution.actSubmode,
      projectSnapshot,
      promptVariant: resolvedPromptVariant,
      activeWorkspace: activeWorkspaceModelContext,
      activeWorkspaceSkills,
      activeProjectContext,
      activeSkillPack: activeSkillPackContext,
      stepIndex: ctx.stepIndex,
    });
    goal = activeTurnIntent?.objective ?? goal;

    let activeReactState: Record<string, unknown> = {
      ...reactState,
      modelTranscript: contextRequest.transcript,
    };
    let response = await askDeliberator(
      io,
      config,
      contextRequest.modelInput,
      contextRequest.messages,
      contextRequest.metadata,
      projectedDeliberatorTools,
      "required",
      initialParallelToolCalls,
      modeScopedControlToolNames,
      finalizeStatuses,
      cannotSatisfyReasonCodes,
      economicsScopedDeliberatorTools.selection,
    );
    if (response.toolIntents.length === 0) {
      return toRequiredToolCallMissingTransition({
        stepIndex: ctx.stepIndex,
        reactState: activeReactState,
        response,
        actionToolCount: buildModelToolAliasRegistry(projectedDeliberatorTools, {
          controlToolNames: modeScopedControlToolNames,
          finalizeStatuses,
          cannotSatisfyReasonCodes,
        }).requestTools.length,
      });
    }
    let activeModelTranscript = contextRequest.transcript;
    let attemptNumber = 1;
    let schemaRetriesUsed = 0;
    let policyRetriesUsed = 0;
    const seenPolicyReasons = new Set<string>();
    let attempt = runDeliberatorCompileAttempt({
      response,
      reactState: activeReactState,
      stepIndex: ctx.stepIndex,
      runId: ctx.runId,
      interactionMode: modeResolution.interactionMode,
      deliberatorTools: closeoutOnly ? [] : economicsScopedDeliberatorTools.tools,
      capabilityManifest,
      decisionContext,
      observedCapabilities,
      executionPolicy,
      workspaceRoot: activeWorkspace?.workspaceRoot,
      controlToolNames: modeScopedControlToolNames,
      finalizeStatuses,
      cannotSatisfyReasonCodes,
    });
    while (attempt.ok === false) {
      const retryKind = readDeliberatorRetryKind(attempt.error);
      if (retryKind === undefined || attemptNumber >= 4) {
        break;
      }
      if (retryKind === "schema") {
        if (schemaRetriesUsed >= DELIBERATOR_SCHEMA_RETRY_LIMIT) {
          break;
        }
        schemaRetriesUsed += 1;
      } else {
        const policySignature = readDeliberatorPolicyFailureSignature(attempt.error);
        if (policyRetriesUsed >= 2 || seenPolicyReasons.has(policySignature)) {
          break;
        }
        seenPolicyReasons.add(policySignature);
        policyRetriesUsed += 1;
      }
      attemptNumber += 1;
      const retryTools = attempt.prepared?.filteredTools ?? (
        closeoutOnly
          ? { ...initialFilteredTools, tools: [] }
          : initialFilteredTools
      );
      const retryContext = buildThinkerRetryContext({
        attempt: attemptNumber,
        maxAttempts: 4,
        previousResponse: buildDeliberatorRejectedResponse(response),
        failure: attempt.error,
        toolAvailability: retryTools.availability,
        executionIntent: attempt.prepared?.canonicalIntentContext.executionIntent,
        filesystemInventory: decisionContext.filesystemInventory,
      });
      const retryRequest = buildContextRequest({
        reactState: activeReactState,
        eventPayload,
        goal,
        eventType: ctx.event.type,
        interactionMode: modeResolution.interactionMode,
        actSubmode: modeResolution.actSubmode,
        projectSnapshot,
        promptVariant: resolvedPromptVariant,
        systemPrompt: {
          kind: "kestrel-deliberator",
          interactionMode: modeResolution.interactionMode,
          promptVariant: resolvedPromptVariant,
          ...readRuntimeShellKind(eventPayload),
          ...readSystemInstructions(eventPayload),
        },
        retryContext,
        activeWorkspace: activeWorkspaceModelContext,
        activeWorkspaceSkills,
        activeProjectContext,
        activeSkillPack: activeSkillPackContext,
        stepIndex: ctx.stepIndex,
      });
      const assistantProgressRepairToolName = readAssistantProgressRepairToolName(attempt.error);
      activeModelTranscript = retryRequest.transcript;
      activeReactState = {
        ...activeReactState,
        modelTranscript: activeModelTranscript,
      };
      response = await askDeliberator(
        io,
        config,
        retryRequest.modelInput,
        retryRequest.messages,
        retryRequest.metadata,
        retryTools.tools,
        "required",
        closeoutOnly === false &&
          assistantProgressRepairToolName === undefined &&
          shouldEnableParallelToolCalls({
            tools: retryTools.tools,
            capabilityManifest,
            modeResolution,
            executionPolicy,
          }),
        modeScopedControlToolNames,
        finalizeStatuses,
        cannotSatisfyReasonCodes,
        economicsScopedDeliberatorTools.selection,
        assistantProgressRepairToolName,
      );
      if (response.toolIntents.length === 0) {
        return toRequiredToolCallMissingTransition({
          stepIndex: ctx.stepIndex,
          reactState: activeReactState,
          response,
          actionToolCount: buildModelToolAliasRegistry(retryTools.tools, {
            controlToolNames: modeScopedControlToolNames,
            finalizeStatuses,
            cannotSatisfyReasonCodes,
          }).requestTools.length,
        });
      }
      attempt = runDeliberatorCompileAttempt({
        response,
        reactState: activeReactState,
        stepIndex: ctx.stepIndex,
        runId: ctx.runId,
        interactionMode: modeResolution.interactionMode,
        deliberatorTools: closeoutOnly ? [] : economicsScopedDeliberatorTools.tools,
        capabilityManifest,
        decisionContext,
        observedCapabilities,
        executionPolicy,
        workspaceRoot: activeWorkspace?.workspaceRoot,
        controlToolNames: modeScopedControlToolNames,
        finalizeStatuses,
        cannotSatisfyReasonCodes,
      });
    }

    if (attempt.ok === false) {
      if (
        readDeliberatorRetryKind(attempt.error) === "schema" &&
        schemaRetriesUsed >= DELIBERATOR_SCHEMA_RETRY_LIMIT
      ) {
        return toDeliberatorContractFailureTransition({
          stepIndex: ctx.stepIndex,
          reactState: {
            ...(attempt.prepared?.reducedReactState ?? reactState),
            modelTranscript: activeModelTranscript,
          },
          error: attempt.error,
          attemptCount: attemptNumber,
          previousResponse: buildDeliberatorRejectedResponse(response),
        });
      }
      const schemaCategory = inferSchemaCategory(
        attempt.error.code,
        attempt.error.details,
      );
      return toAgentLoopValidationFeedbackTransition({
        stepIndex: ctx.stepIndex,
        loopStepId: config.loopStepId,
        reactState: {
          ...(attempt.prepared?.reducedReactState ?? reactState),
          modelTranscript: activeModelTranscript,
        },
        goal,
        error: attempt.error,
        schemaCategory,
        previousResponse: buildDeliberatorRejectedResponse(response),
      });
    }

    if (attempt.compiled === undefined) {
      return toAgentLoopTodoOnlyTransition({
        stepIndex: ctx.stepIndex,
        loopStepId: config.loopStepId,
        reactState: {
          ...attempt.prepared.reducedReactState,
          modelTranscript: activeModelTranscript,
        },
        goal,
        visibleTodos: attempt.visibleTodosOnly,
        modelToolCalls: attempt.modelToolCalls,
        ...(attempt.assistantProgress !== undefined ? { assistantProgress: attempt.assistantProgress } : {}),
      });
    }

    const compiled = attempt.compiled.value;
    const repeatedActionFailure = readRepeatedActionFailureForNextStep({
      action: compiled.action,
      reactState: attempt.prepared.reducedReactState,
    });
    if (repeatedActionFailure !== undefined) {
      return toAgentLoopValidationFeedbackTransition({
        stepIndex: ctx.stepIndex,
        loopStepId: config.loopStepId,
        reactState: {
          ...attempt.prepared.reducedReactState,
          modelTranscript: activeModelTranscript,
        },
        goal,
        error: repeatedActionFailure,
        schemaCategory: inferSchemaCategory(
          repeatedActionFailure.code,
          repeatedActionFailure.details,
        ),
        previousResponse: buildDeliberatorRejectedResponse(response),
      });
    }
    return toAgentLoopActionTransition(
      ctx.stepIndex,
      {
        ...attempt.prepared.reducedReactState,
        modelTranscript: activeModelTranscript,
      },
      goal,
      compiled,
      capabilityManifest,
      config.loopStepId,
      config.execDispatchStepId,
      ctx.runId,
      modeResolution,
      executionPolicy,
      response.output,
      attempt.modelToolCalls,
      askUserAvailable,
      attempt.assistantProgress,
    );
  };
}

function resetTaskScopedStateForFreshUserMessageEpoch(input: {
  eventId: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
  reactState: ReferenceReactAgentState;
}): ReferenceReactAgentState {
  if (shouldStartFreshUserMessageTaskEpoch(input) === false) {
    return input.reactState;
  }
  return {
    ...input.reactState,
    goal: undefined,
    modelTranscript: rebaseModelTranscriptForFreshTask(input.reactState.modelTranscript),
    retryContext: undefined,
    lastAction: undefined,
    lastActionResult: undefined,
    commandBatch: undefined,
    visibleTodos: undefined,
    observations: [],
    evidenceLedger: undefined,
    postToolVerification: undefined,
    decisionVerification: undefined,
    nextAction: undefined,
    waitingFor: undefined,
    activeContinuation: undefined,
    pendingContinuationOffer: undefined,
    exec: {},
    decisionReason: undefined,
    decisionTrace: undefined,
    loopGuard: undefined,
    closeoutLatch: undefined,
    terminal: undefined,
    assistantText: null,
    finalOutput: undefined,
    finalized: undefined,
    activeTurnIntent: undefined,
    phase: undefined,
  } as ReferenceReactAgentState;
}

function attachTurnIdentityMetadata(input: {
  eventId: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
  reactState: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata = asRecord(input.eventPayload.metadata) ?? {};
  const explicitSubmissionKind = readSubmissionKind(input.eventPayload);
  const submissionKind: ConversationSubmissionKind = explicitSubmissionKind ?? (
    input.eventPayload.resumeBlockedRun === true || input.eventType === "user.reply"
      ? "resume"
      : input.eventType === "user.message"
        ? readTurnPayloadInstruction(input.eventPayload) === undefined || shouldPreserveTranscriptTaskForTurn({
            reactState: input.reactState,
            eventType: input.eventType,
            eventPayload: input.eventPayload,
            eventId: input.eventId,
          }) ? "resume" : "initial"
        : "resume"
  );
  const activeIntent = readActiveTurnIntent(input.reactState);
  const turnId = asString(metadata.turnId)?.trim() || (
    submissionKind === "resume" || submissionKind === "steer"
      ? activeIntent?.turnId ?? input.eventId
      : input.eventId
  );
  return {
    ...input.eventPayload,
    metadata: {
      ...metadata,
      turnId,
      submissionKind,
      sourceEventId: input.eventId,
    },
  };
}

function resolveActiveTurnIntentForContext(input: {
  reactState: Record<string, unknown>;
  eventId: string;
  eventPayload: Record<string, unknown>;
  goal: string;
  transcript: ModelTranscript;
}): ActiveTurnIntentV1 | undefined {
  const existing = readActiveTurnIntent(input.reactState);
  const submissionKind = readSubmissionKind(input.eventPayload);
  const fresh = submissionKind === "initial" || submissionKind === "follow_up";
  if (fresh === false && existing !== undefined) return existing;
  const metadata = asRecord(input.eventPayload.metadata) ?? {};
  const turnId = asString(metadata.turnId)?.trim() || input.eventId;
  const activeTranscriptItemId = fresh
    ? findUserTranscriptItemIdBySourceEvent(input.transcript, input.eventId)
    : readActiveTaskItemIdFromState({ ...input.reactState, modelTranscript: input.transcript });
  const objective = fresh ? input.goal : readActiveTaskGoalFromState(input.reactState) ?? input.goal;
  if (activeTranscriptItemId === undefined || objective.trim().length === 0) return existing;
  return {
    version: "v1",
    turnId,
    rootEventId: fresh ? input.eventId : existing?.rootEventId ?? input.eventId,
    objective: objective.trim(),
    activeTranscriptItemId,
  };
}

function buildAgentLoopStatePatch(agentPatch: Record<string, unknown>): Record<string, unknown> {
  const { evidenceLedger, ...agent } = agentPatch;
  return {
    agent,
    evidenceLedger,
  };
}

function isCloseoutAttemptActive(value: unknown): boolean {
  const record = asRecord(value);
  return record?.version === "v1" &&
    record.closeoutAttempted === true &&
    record.active === true &&
    typeof record.closeoutRequiredForEvidenceHash === "string" &&
    record.closeoutRequiredForEvidenceHash.trim().length > 0;
}

function clearLegacyGoalPatch(): { goal?: undefined } {
  return { goal: undefined };
}

function filterDeliberatorToolsForMode(input: {
  tools: ModelToolSpec[];
  capabilityManifest: ToolCapabilityManifestItem[];
  modeResolution: { interactionMode: InteractionMode; actSubmode?: ActSubmode | undefined };
  executionPolicy: ExecutionPolicyOverride | undefined;
}): ModelToolSpec[] {
  const toolClassByName = new Map(
    input.capabilityManifest.map((tool) => [tool.name, tool.executionClass ?? "read_only"] as const),
  );
  const toolApprovalCapabilitiesByName = new Map(
    input.capabilityManifest.map((tool) => [tool.name, tool.approvalCapabilities ?? []] as const),
  );
  const toolAllowedInteractionModesByName = new Map(
    input.capabilityManifest.map((tool) => [tool.name, tool.allowedInteractionModes] as const),
  );
  return input.tools.filter((tool) =>
    toolClassByName.has(tool.name) &&
    isToolEligibleForInteractionMode({
      interactionMode: input.modeResolution.interactionMode,
      actSubmode: input.modeResolution.actSubmode,
      toolClass: toolClassByName.get(tool.name) ?? "read_only",
      allowedInteractionModes: toolAllowedInteractionModesByName.get(tool.name),
      executionPolicy: input.executionPolicy,
      requiredCapabilities: toolApprovalCapabilitiesByName.get(tool.name),
    })
  );
}

function hasModeHiddenWorkspaceTool(input: {
  allTools: ModelToolSpec[];
  modeScopedTools: ModelToolSpec[];
  capabilityManifest: ToolCapabilityManifestItem[];
  modeResolution: { interactionMode: InteractionMode; actSubmode?: ActSubmode | undefined };
  executionPolicy: ExecutionPolicyOverride | undefined;
}): boolean {
  const configuredByName = new Map(input.capabilityManifest.map((tool) => [tool.name, tool] as const));
  const visibleNames = new Set(input.modeScopedTools.map((tool) => tool.name));
  return input.allTools.some((tool) => {
    const configured = configuredByName.get(tool.name);
    if (configured === undefined || visibleNames.has(tool.name)) return false;
    const executionClass = configured.executionClass ?? "read_only";
    if (input.executionPolicy?.toolClassPolicy?.[executionClass] === false) return false;
    if (readBlockedApprovalCapability({
      executionPolicy: input.executionPolicy,
      requiredCapabilities: configured.approvalCapabilities,
    }) !== undefined) return false;
    return isToolEligibleForInteractionMode({
      interactionMode: input.modeResolution.interactionMode,
      actSubmode: input.modeResolution.actSubmode,
      toolClass: executionClass,
      allowedInteractionModes: configured.allowedInteractionModes,
      requiredCapabilities: configured.approvalCapabilities,
    }) === false;
  });
}

function hasExecutableWorkspaceTools(input: {
  tools: ModelToolSpec[];
  capabilityManifest: ToolCapabilityManifestItem[];
}): boolean {
  const executionClassByName = new Map(
    input.capabilityManifest.map((tool) => [tool.name, tool.executionClass ?? "read_only"] as const),
  );
  return input.tools.some((tool) => {
    const executionClass = executionClassByName.get(tool.name);
    return executionClass === "sandboxed_only" || executionClass === "external_side_effect";
  });
}

function shouldEnableParallelToolCalls(input: {
  tools: ModelToolSpec[];
  capabilityManifest: ToolCapabilityManifestItem[];
  modeResolution: { interactionMode: InteractionMode; actSubmode?: ActSubmode | undefined };
  executionPolicy: ExecutionPolicyOverride | undefined;
}): boolean {
  if (needsPerCallApproval({
    interactionMode: input.modeResolution.interactionMode,
    actSubmode: input.modeResolution.actSubmode,
    executionPolicy: input.executionPolicy,
  })) {
    return false;
  }

  const surfacedToolNames = new Set(input.tools.map((tool) => tool.name));
  return input.capabilityManifest.every((tool) =>
    surfacedToolNames.has(tool.name) === false ||
    tool.approvalCapabilities?.includes("external.confirm") !== true
  );
}

type DeliberatorPreparedCompileAttempt = {
  ok: true;
  response: ModelResponse<unknown>;
  prepared: {
    reducedReactState: Record<string, unknown>;
    filteredTools: ReturnType<typeof filterDeliberatorToolsForContext>;
    canonicalIntentContext: CanonicalIntentContext;
  };
  compiled?: {
    ok: true;
    value: CompiledDecision;
  } | undefined;
  visibleTodosOnly?: ReturnType<typeof normalizeModelToolCallsToAgentTurn>["visibleTodos"] | undefined;
  modelToolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string | undefined }>;
  assistantProgress?: string | undefined;
};

type DeliberatorFailedCompileAttempt = {
  ok: false;
  response: ModelResponse<unknown>;
  prepared?: {
    reducedReactState: Record<string, unknown>;
    filteredTools: ReturnType<typeof filterDeliberatorToolsForContext>;
    canonicalIntentContext: CanonicalIntentContext;
  } | undefined;
  error: {
    code: DecisionFailureCode;
    message: string;
    details?: Record<string, unknown> | undefined;
  };
};

type CanonicalIntentContext = {
  compiledIntent?: ReturnType<typeof compileIntentState> | undefined;
  executionIntent?: ParsedExecutionIntentState["execution"] | undefined;
  intentMetadata?: ParsedExecutionIntentState["metadata"] | undefined;
  intentConfidence?: number | undefined;
  toolIntent?: ReturnType<typeof buildToolIntentContext> | undefined;
};

function runDeliberatorCompileAttempt(input: {
  response: ModelResponse<unknown>;
  reactState: Record<string, unknown>;
  stepIndex: number;
  runId: string;
  interactionMode: InteractionMode;
  deliberatorTools: ModelToolSpec[];
  capabilityManifest: ToolCapabilityManifestItem[];
  decisionContext: InternalDecisionContext;
  observedCapabilities: string[];
  executionPolicy: ExecutionPolicyOverride | undefined;
  workspaceRoot?: string | undefined;
  controlToolNames?: readonly string[] | undefined;
  finalizeStatuses?: readonly KestrelAgentFinalizeStatus[] | undefined;
  cannotSatisfyReasonCodes?: readonly KestrelAgentCannotSatisfyReasonCode[] | undefined;
}): DeliberatorPreparedCompileAttempt | DeliberatorFailedCompileAttempt {
  const reducedReactState = input.reactState;
  const filteredTools = filterDeliberatorToolsForContext(
    input.deliberatorTools,
    {
      devShellProcesses: buildDevShellToolFilterProcesses(
        input.decisionContext.devShellProcesses,
        asRecord(reducedReactState.postToolVerification),
      ),
      postToolVerification: asRecord(reducedReactState.postToolVerification),
      managedEntrypoints: input.decisionContext.managedEntrypoints,
      artifactTarget: readManagedEntrypointToolFilterArtifactTarget(input.decisionContext),
    },
  );
  const canonicalIntentContext = readCanonicalIntentContextFromState(
    reducedReactState,
    input.capabilityManifest,
  );
  const prepared = {
    reducedReactState,
    filteredTools,
    canonicalIntentContext,
  };

  let normalizedTurn: ReturnType<typeof normalizeModelToolCallsToAgentTurn>;
  try {
    normalizedTurn = normalizeModelToolCallsToAgentTurn({
      toolIntents: input.response.toolIntents,
      aliasRegistry: buildModelToolAliasRegistry(filteredTools.tools, {
        controlToolNames: input.controlToolNames,
        finalizeStatuses: input.finalizeStatuses,
        cannotSatisfyReasonCodes: input.cannotSatisfyReasonCodes,
      }),
      sourceRunId: input.runId,
    });
  } catch (error) {
    return {
      ok: false,
      response: input.response,
      prepared,
      error: mapModelToolCallActionError(error),
    };
  }

  if (normalizedTurn.action === undefined) {
    return {
      ok: true,
      response: input.response,
      prepared,
      visibleTodosOnly: normalizedTurn.visibleTodos,
      modelToolCalls: normalizedTurn.transcriptToolCalls,
      ...(normalizedTurn.assistantProgress !== undefined ? { assistantProgress: normalizedTurn.assistantProgress } : {}),
    };
  }

  const compiled = tryCompileAgentAction(
    "deliberator",
    normalizedTurn,
    input.observedCapabilities,
    input.capabilityManifest,
    prepared.filteredTools.tools,
    input.decisionContext.repetitionSignals,
    input.decisionContext.recoveryVerdict,
    input.decisionContext.evidenceRecoverySummary,
    asRecord(prepared.reducedReactState.postToolVerification),
    input.decisionContext.devShellProcesses,
    input.decisionContext.evidenceContext,
    input.decisionContext.evidenceLedger,
    input.decisionContext.visibleTodos,
    input.reactState.lastActionResult,
    input.runId,
    input.interactionMode,
    input.executionPolicy,
    prepared.canonicalIntentContext,
    input.workspaceRoot,
    input.decisionContext.plan,
    input.response.text,
  );
  if (compiled.ok === false) {
    const remappedError = remapToolAvailabilityPolicyError({
      error: compiled.error,
      capabilityManifest: input.capabilityManifest,
      interactionMode: input.interactionMode,
      executionPolicy: input.executionPolicy,
    });
    return {
      ok: false,
      response: input.response,
      prepared,
      error: remappedError,
    };
  }
  return {
    ok: true,
    response: input.response,
    prepared,
    compiled,
    modelToolCalls: normalizedTurn.transcriptToolCalls,
    ...(normalizedTurn.assistantProgress !== undefined ? { assistantProgress: normalizedTurn.assistantProgress } : {}),
  };
}

function readCanonicalIntentContextFromState(
  reactState: Record<string, unknown>,
  capabilityManifest: ToolCapabilityManifestItem[],
): CanonicalIntentContext {
  const compiledIntent = compileIntentState({
    value: reactState.compiledIntent,
    capabilityManifest,
  });
  if (compiledIntent !== undefined) {
    return {
      compiledIntent,
      toolIntent: buildToolIntentContextFromCompiledIntent(compiledIntent),
    };
  }
  const parsedExecutionState = buildParsedExecutionIntentState(reactState.toolIntent);
  if (parsedExecutionState !== undefined) {
    return {
      executionIntent: parsedExecutionState.execution,
      intentMetadata: parsedExecutionState.metadata,
      intentConfidence: parsedExecutionState.confidence,
      toolIntent: buildToolIntentContext(reactState.toolIntent, capabilityManifest),
    };
  }
  return {};
}

async function askDeliberator(
  io: StepIO,
  config: AgentLoopStepConfig,
  input: Record<string, unknown>,
  messages: ModelRequest["messages"],
  contextMetadata: ReturnType<typeof buildContextRequest>["metadata"],
  deliberatorTools: ModelToolSpec[],
  toolChoice: "required" = "required",
  parallelToolCalls = true,
  controlToolNames?: readonly string[] | undefined,
  finalizeStatuses?: readonly KestrelAgentFinalizeStatus[] | undefined,
  cannotSatisfyReasonCodes?: readonly KestrelAgentCannotSatisfyReasonCode[] | undefined,
  economicsToolExposureSelection?: ToolExposureSelectionV1 | undefined,
  requiredProviderToolName?: string | undefined,
): Promise<ModelResponse<unknown>> {
  const promptInput = readDeliberatorPromptInput(input);
  const resolvedPromptVariant = resolveDeliberatorPromptVariant(promptInput);
  const aliasRegistry = buildModelToolAliasRegistry(deliberatorTools, {
    controlToolNames,
    finalizeStatuses,
    cannotSatisfyReasonCodes,
  });
  const requestTools = requiredProviderToolName === undefined
    ? aliasRegistry.requestTools
    : aliasRegistry.requestTools.filter((tool) => tool.name === requiredProviderToolName);
  if (requiredProviderToolName !== undefined && requestTools.length !== 1) {
    throw new Error(`Contract repair tool '${requiredProviderToolName}' is not available in the current model tool surface.`);
  }
  const request: ModelRequest = {
    model: config.agentModel,
    input,
    messages: messages ?? [],
    tools: requestTools,
    reasoning: config.reasoningRequest ?? { mode: "provider_visible" },
    providerOptions: deliberatorProviderOptions(toolChoice, parallelToolCalls),
    metadata: {
      phase: "agent.loop",
      stepAgent: "agent.loop",
      requestedModel: config.agentModel,
      ...(config.agentProvider !== undefined ? { requestedProvider: config.agentProvider } : {}),
      modelRole: "tool_action",
      promptVariant: resolvedPromptVariant,
      interactionMode: promptInput.interactionMode,
      ...(promptInput.actSubmode !== undefined ? { actSubmode: promptInput.actSubmode } : {}),
      reasoningRetention: config.reasoningRetention ?? { mode: "live_only", days: 7 },
      reasoningRetentionScope: config.reasoningRetentionScope ?? "default",
      contextBuilder: contextMetadata.builder,
      contextBuilderVersion: contextMetadata.version,
      contextSections: contextMetadata.manifestSections,
      contextPipeline: contextMetadata.pipelineSections,
      ...(economicsToolExposureSelection !== undefined
        ? { economicsToolExposureSelection }
        : {}),
    },
  };
  return io.useModel<ModelResponse<unknown>>(request);
}

function isRunCancellation(error: unknown): boolean {
  if (error instanceof RuntimeFailure && error.code === "RUN_CANCELLED") {
    return true;
  }
  const record = asRecord(error);
  return record?.code === "RUN_CANCELLED";
}

async function compactContextRequestIfNeeded(input: {
  io: StepIO;
  config: AgentLoopStepConfig;
  contextRequest: ReturnType<typeof buildContextRequest>;
  actionTools: ModelToolSpec[];
  actionParallelToolCalls: boolean;
  reactState: Record<string, unknown>;
  eventPayload: Record<string, unknown>;
  goal: string;
  retryContext?: Record<string, unknown> | undefined;
  eventType: string;
  interactionMode: InteractionMode;
  actSubmode?: ActSubmode | undefined;
  projectSnapshot?: unknown;
  promptVariant?: string | undefined;
  activeWorkspace?: unknown;
  activeWorkspaceSkills?: unknown;
  activeProjectContext?: unknown;
  activeSkillPack?: unknown;
  stepIndex: number;
}): Promise<ReturnType<typeof buildContextRequest>> {
  return compactContextRequestTokenAware(input);
}

type CompactionRequestInput = Parameters<
  typeof compactContextRequestIfNeeded
>[0];

interface CompactionBudget {
  retainedTailTokenBudget: number;
  maxMaintenanceSourceTokens: number;
  summaryTokenBudget?: number | undefined;
  legacy: boolean;
}

async function compactContextRequestTokenAware(
  input: CompactionRequestInput,
): Promise<ReturnType<typeof buildContextRequest>> {
  const runtimeEconomics = readRuntimeEconomics(input.eventPayload);
  const actionTokenCounter = tokenCounterForProfile(
    runtimeEconomics.modelProfile,
  );
  const toolSchemaTokens = buildToolSurfaceManifest(
    input.actionTools,
    actionTokenCounter,
  ).count.tokens;
  const configuredMaintenanceModel =
    input.config.maintenanceModel ?? input.config.agentModel;
  const configuredMaintenanceEconomics = readRuntimeEconomics(
    input.eventPayload,
    configuredMaintenanceModel,
  );
  const maintenanceModel =
    runtimeEconomics.policy === undefined ||
    configuredMaintenanceModel === input.config.agentModel ||
    configuredMaintenanceEconomics.modelProfile !== undefined
      ? configuredMaintenanceModel
      : input.config.agentModel;
  const maintenanceProfile =
    maintenanceModel === configuredMaintenanceModel
      ? configuredMaintenanceEconomics.modelProfile
      : runtimeEconomics.modelProfile;
  const maintenanceTokenCounter = tokenCounterForProfile(maintenanceProfile);
  const maxSummaryAttempts =
    runtimeEconomics.policy?.compaction.maxSummaryAttempts ?? 1;
  let contextRequest = input.contextRequest;
  let maintenanceUnavailableFailureCode: string | undefined;

  while (true) {
    const contextTokens = totalContextTokens(contextRequest);
    const providerOverheadTokens = estimateActionProviderOverheadTokens({
      model: input.config.agentModel,
      contextRequest,
      reasoning:
        input.config.reasoningRequest ?? { mode: "provider_visible" },
      toolChoice: "required",
      parallelToolCalls: input.actionParallelToolCalls,
      modelProfile: runtimeEconomics.modelProfile,
    });
    if (
      shouldCompactKestrelAgentContext({
        transcript: contextRequest.transcript,
        ...(runtimeEconomics.policy !== undefined
          ? { policy: runtimeEconomics.policy }
          : {}),
        ...(runtimeEconomics.modelProfile !== undefined
          ? { modelProfile: runtimeEconomics.modelProfile }
          : {}),
        contextTokens,
        toolSchemaTokens,
        providerOverheadTokens,
      }) === false
    ) {
      return contextRequest;
    }

    const compactionSource = normalizeModelTranscript(
      contextRequest.transcript,
    );
    if (compactionSource === undefined) {
      throw new Error("Compaction requires a valid model transcript.");
    }
    const activeTaskItemId = readActiveTaskItemIdFromState(input.reactState);
    const budget = buildCompactionBudget({
      contextRequest,
      transcript: compactionSource,
      policy: runtimeEconomics.policy,
      actionProfile: runtimeEconomics.modelProfile,
      maintenanceProfile,
      maintenanceModel,
      toolSchemaTokens,
      providerOverheadTokens,
      actionTokenCounter,
      maintenanceTokenCounter,
      ...(activeTaskItemId !== undefined ? { activeTaskItemId } : {}),
    });
    const plan = buildRuntimeCompactionPlan({
      transcript: compactionSource,
      budget,
      tailTokenCounter: actionTokenCounter,
      maintenanceTokenCounter,
      ...(activeTaskItemId !== undefined ? { activeTaskItemId } : {}),
    });
    if (plan.replacedItems.length === 0) {
      throwRequiredContextBudgetFailure(contextTokens, toolSchemaTokens);
    }
    const summaryTokenBudget =
      budget.summaryTokenBudget ??
      Math.max(
        minimumRuntimeFallbackSummaryTokens(actionTokenCounter),
        Math.min(
          maintenanceProfile?.maxOutputTokens ??
            LEGACY_COMPACTION_MAX_OUTPUT_TOKENS,
          estimateModelTranscriptItemsTokens(
            plan.replacedItems,
            actionTokenCounter,
          ) - 1,
        ),
      );

    const sourceTokens = estimateKestrelCompactionSourceTokens(
      plan.replacedItems,
      maintenanceTokenCounter,
    );
    let acceptedSummary: KestrelCompactionSummaryV2 | undefined;
    let fallbackFailureCode: string | undefined =
      sourceTokens > budget.maxMaintenanceSourceTokens
        ? "HARNESS_ECONOMICS_COMPACTION_SOURCE_OVERSIZED"
        : maintenanceUnavailableFailureCode;
    let correction: KestrelAgentCompactionCorrectionV1 | undefined;

    if (fallbackFailureCode === undefined) {
      for (
        let compactionAttempt = 1;
        compactionAttempt <= maxSummaryAttempts;
        compactionAttempt += 1
      ) {
        const compactionAttemptKind =
          compactionAttempt === 1 ? "initial" : "correction";
        let response: ModelResponse<unknown>;
        try {
          response = await input.io.useModel<ModelResponse<unknown>>({
            model: maintenanceModel,
            input: { version: "compaction-v2" },
            messages: buildKestrelAgentCompactionMessages({
              sourceItems: plan.replacedItems,
              ...(correction !== undefined ? { correction } : {}),
            }),
            responseFormat: "json",
            responseSchema: buildKestrelCompactionSummarySchema(),
            reasoning: { mode: "off" },
            providerOptions: maintenanceProviderOptions(summaryTokenBudget),
            metadata: {
              phase: "agent.compaction",
              stepAgent: "agent.loop",
              requestedModel: maintenanceModel,
              ...(input.config.agentProvider !== undefined
                ? { requestedProvider: input.config.agentProvider }
                : {}),
              modelRole: "compaction",
              modelBudgetClass: "maintenance",
              reasoningRetentionScope:
                input.config.reasoningRetentionScope ?? "default",
              contextBuilder: contextRequest.metadata.builder,
              contextBuilderVersion: contextRequest.metadata.version,
              compactionAttempt,
              maxSummaryAttempts,
              compactionAttemptKind,
            },
          });
        } catch (error) {
          if (isRunCancellation(error)) {
            throw error;
          }
          fallbackFailureCode = readMaintenanceFailureCode(
            error,
            "COMPACTION_MAINTENANCE_PROVIDER_FAILED",
          );
          maintenanceUnavailableFailureCode = fallbackFailureCode;
          break;
        }

        try {
          acceptedSummary = parseKestrelCompactionSummaryV2(
            response.output ?? response.text,
          );
          assertCompactionSummaryFitsTokenBudget(
            acceptedSummary,
            summaryTokenBudget,
            actionTokenCounter,
          );
        } catch (error) {
          const failure = readCompactionFailure(error);
          if (failure === undefined) {
            throw error;
          }
          acceptedSummary = undefined;
          if (compactionAttempt < maxSummaryAttempts) {
            correction = {
              source: "summary_validation",
              reason: failure.message,
            };
            continue;
          }
          fallbackFailureCode = failure.code;
          break;
        }

        if (runtimeEconomics.policy?.mode === "enforce") {
          let sufficiencyResponse: ModelResponse<unknown>;
          try {
            sufficiencyResponse = await input.io.useModel<
              ModelResponse<unknown>
            >({
              model: maintenanceModel,
              input: { version: "compaction-sufficiency-v1" },
              messages: buildKestrelCompactionSufficiencyMessages({
                sourceItems: plan.replacedItems,
                proposedSummary: acceptedSummary,
              }),
              responseFormat: "json",
              responseSchema:
                KESTREL_COMPACTION_SUFFICIENCY_SCHEMA as unknown as Record<
                  string,
                  unknown
                >,
              reasoning: { mode: "off" },
              providerOptions: maintenanceProviderOptions(summaryTokenBudget),
              metadata: {
                phase: "agent.compaction.verify",
                stepAgent: "agent.loop",
                requestedModel: maintenanceModel,
                ...(input.config.agentProvider !== undefined
                  ? { requestedProvider: input.config.agentProvider }
                  : {}),
                modelRole: "compaction_sufficiency",
                modelBudgetClass: "maintenance",
                reasoningRetentionScope:
                  input.config.reasoningRetentionScope ?? "default",
                contextBuilder: contextRequest.metadata.builder,
                contextBuilderVersion: contextRequest.metadata.version,
                compactionAttempt,
                maxSummaryAttempts,
                compactionAttemptKind,
              },
            });
          } catch (error) {
            if (isRunCancellation(error)) {
              throw error;
            }
            acceptedSummary = undefined;
            fallbackFailureCode = readMaintenanceFailureCode(
              error,
              "COMPACTION_VERIFIER_PROVIDER_FAILED",
            );
            maintenanceUnavailableFailureCode = fallbackFailureCode;
            break;
          }
          try {
            parseKestrelCompactionSufficiencyVerdictV1(
              sufficiencyResponse.output ?? sufficiencyResponse.text,
            );
          } catch (error) {
            const failure = readCompactionFailure(error);
            if (failure === undefined) {
              throw error;
            }
            if (failure.details?.reason !== "semantic_verifier_rejected") {
              acceptedSummary = undefined;
              fallbackFailureCode = failure.code;
              break;
            }
            acceptedSummary = undefined;
            if (compactionAttempt < maxSummaryAttempts) {
              const verifierCategories = readVerifierCategories(failure);
              correction = {
                source: "semantic_verifier",
                reason: failure.message,
                ...(verifierCategories !== undefined
                  ? { verifierCategories }
                  : {}),
              };
              continue;
            }
            fallbackFailureCode = failure.code;
            break;
          }
        }
        break;
      }
      if (acceptedSummary === undefined && fallbackFailureCode !== undefined) {
        maintenanceUnavailableFailureCode = fallbackFailureCode;
      }
    }

    const summarySource =
      acceptedSummary === undefined
        ? ("runtime_fallback" as const)
        : ("model" as const);
    let compactedTranscript = buildKestrelAgentCompactedTranscript({
      transcript: contextRequest.transcript,
      plan,
      summary:
        acceptedSummary ??
        buildRuntimeFallbackCompactionSummary(
          input.reactState,
          compactionSource,
          summaryTokenBudget,
          actionTokenCounter,
        ),
      summarySource,
      ...(summarySource === "runtime_fallback"
        ? {
            failureCode:
              fallbackFailureCode ?? "COMPACTION_SUMMARY_ATTEMPTS_EXHAUSTED",
          }
        : {}),
    });
    let nextContextRequest = rebuildCompactedContextRequest(
      input,
      compactedTranscript,
      runtimeEconomics.modelProfile,
    );

    if (
      acceptedSummary !== undefined &&
      totalContextTokens(nextContextRequest) >= contextTokens
    ) {
      maintenanceUnavailableFailureCode =
        "HARNESS_ECONOMICS_COMPACTION_NON_REDUCING";
      compactedTranscript = buildKestrelAgentCompactedTranscript({
        transcript: contextRequest.transcript,
        plan,
        summary: buildRuntimeFallbackCompactionSummary(
          input.reactState,
          compactionSource,
          summaryTokenBudget,
          actionTokenCounter,
        ),
        summarySource: "runtime_fallback",
        failureCode: maintenanceUnavailableFailureCode,
      });
      nextContextRequest = rebuildCompactedContextRequest(
        input,
        compactedTranscript,
        runtimeEconomics.modelProfile,
      );
    }
    if (totalContextTokens(nextContextRequest) >= contextTokens) {
      throwRequiredContextBudgetFailure(contextTokens, toolSchemaTokens);
    }
    contextRequest = nextContextRequest;
  }
}

function buildCompactionBudget(input: {
  contextRequest: ReturnType<typeof buildContextRequest>;
  transcript: ModelTranscript;
  policy?: HarnessEconomicsPolicyV1 | undefined;
  actionProfile?: ModelEconomicsProfileV1 | undefined;
  maintenanceProfile?: ModelEconomicsProfileV1 | undefined;
  maintenanceModel: string;
  toolSchemaTokens: number;
  providerOverheadTokens: number;
  actionTokenCounter?: ReturnType<typeof resolveModelTokenCounter>;
  maintenanceTokenCounter?: ReturnType<typeof resolveModelTokenCounter>;
  activeTaskItemId?: string | undefined;
}): CompactionBudget {
  if (input.policy === undefined || input.actionProfile === undefined) {
    return {
      retainedTailTokenBudget: Number.MAX_SAFE_INTEGER,
      maxMaintenanceSourceTokens: 120_000,
      legacy: true,
    };
  }
  const nonTranscriptTokens = input.contextRequest.metadata.manifestSections
    .filter((section) => section.id.startsWith("transcript:") === false)
    .reduce((total, section) => total + section.count.tokens, 0);
  const availableActionInput = Math.max(
    0,
    input.actionProfile.contextWindowTokens -
      input.policy.context.outputReserveTokens -
      input.policy.context.safetyReserveTokens -
      input.toolSchemaTokens -
      input.providerOverheadTokens,
  );
  const maintenanceProfile = input.maintenanceProfile ?? input.actionProfile;
  const summaryTokenBudget = Math.max(
    input.policy.context.outputReserveTokens,
    minimumRuntimeFallbackSummaryTokens(input.actionTokenCounter),
  );
  const activeTaskItemId = readActiveTaskItemIdFromTranscript(
    input.transcript,
    input.activeTaskItemId,
  );
  const activeTaskTokens = estimateModelTranscriptItemsTokens(
    input.transcript.items.filter((item) => item.id === activeTaskItemId),
    input.actionTokenCounter,
  );
  return {
    retainedTailTokenBudget: Math.max(
      0,
      availableActionInput -
        nonTranscriptTokens -
        activeTaskTokens -
        summaryTokenBudget,
    ),
    maxMaintenanceSourceTokens: Math.max(
      1,
      maintenanceProfile.contextWindowTokens -
        summaryTokenBudget -
        input.policy.context.safetyReserveTokens -
        estimateMaintenanceOverheadTokens({
          model: input.maintenanceModel,
          tokenCounter: input.maintenanceTokenCounter,
          mode: input.policy.mode,
          maxSummaryAttempts: input.policy.compaction.maxSummaryAttempts,
          summaryInputReserveTokens: summaryTokenBudget,
        }),
    ),
    summaryTokenBudget,
    legacy: false,
  };
}

function buildRuntimeCompactionPlan(input: {
  transcript: ModelTranscript;
  budget: CompactionBudget;
  tailTokenCounter?: ReturnType<typeof resolveModelTokenCounter>;
  maintenanceTokenCounter?: ReturnType<typeof resolveModelTokenCounter>;
  activeTaskItemId?: string | undefined;
}): ModelTranscriptCompactionPlan {
  if (input.budget.legacy) {
    const legacyPlan = planKestrelAgentCompaction(
      input.transcript,
      input.activeTaskItemId,
    ).plan;
    const legacySourceTokens = estimateKestrelCompactionSourceTokens(
      legacyPlan.replacedItems,
      input.maintenanceTokenCounter,
    );
    if (legacySourceTokens <= input.budget.maxMaintenanceSourceTokens) {
      return legacyPlan;
    }
    const activeTaskItemId = readActiveTaskItemIdFromTranscript(
      input.transcript,
      input.activeTaskItemId,
    );
    return planTokenBudgetedModelTranscriptCompaction({
      transcript: input.transcript,
      retainedTailTokenBudget: estimateModelTranscriptItemsTokens(
        legacyPlan.retainedItems.filter(
          (item) => item.id !== activeTaskItemId,
        ),
        input.tailTokenCounter,
      ),
      maxReplacedTokens: input.budget.maxMaintenanceSourceTokens,
      tokenCounter: input.tailTokenCounter,
      estimateReplacedItemsTokens: (items) =>
        estimateKestrelCompactionSourceTokens(
          items,
          input.maintenanceTokenCounter,
        ),
      ...(activeTaskItemId !== undefined ? { activeTaskItemId } : {}),
    });
  }
  return planTokenBudgetedModelTranscriptCompaction({
    transcript: input.transcript,
    retainedTailTokenBudget: input.budget.retainedTailTokenBudget,
    maxReplacedTokens: input.budget.maxMaintenanceSourceTokens,
    tokenCounter: input.tailTokenCounter,
    estimateReplacedItemsTokens: (items) =>
      estimateKestrelCompactionSourceTokens(
        items,
        input.maintenanceTokenCounter,
      ),
    ...(input.activeTaskItemId !== undefined ? { activeTaskItemId: input.activeTaskItemId } : {}),
  });
}

function rebuildCompactedContextRequest(
  input: CompactionRequestInput,
  compactedTranscript: ModelTranscript,
  modelProfile?: ModelEconomicsProfileV1 | undefined,
): ReturnType<typeof buildContextRequest> {
  return buildContextRequest({
    reactState: {
      ...input.reactState,
      modelTranscript: compactedTranscript,
    },
    eventPayload: input.eventPayload,
    goal: input.goal,
    eventType: input.eventType,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    projectSnapshot: input.projectSnapshot,
    promptVariant: input.promptVariant,
    retryContext: input.retryContext,
    systemPrompt: {
      kind: "kestrel-deliberator",
      interactionMode: input.interactionMode,
      promptVariant: input.promptVariant,
      ...readRuntimeShellKind(input.eventPayload),
      ...readSystemInstructions(input.eventPayload),
    },
    activeWorkspace: input.activeWorkspace,
    activeWorkspaceSkills: input.activeWorkspaceSkills,
    activeProjectContext: input.activeProjectContext,
    activeSkillPack: input.activeSkillPack,
    stepIndex: input.stepIndex,
    ...(modelProfile?.counting.method === "model_tokenizer"
      ? {
          tokenCounter: resolveModelTokenCounter(
            modelProfile.counting.counter,
            modelProfile.counting.counterVersion,
          ),
        }
      : {}),
  });
}

function buildRuntimeFallbackCompactionSummary(
  reactState: Record<string, unknown>,
  transcript: ModelTranscript,
  maxTokens: number,
  tokenCounter?: ReturnType<typeof resolveModelTokenCounter>,
): KestrelCompactionSummaryV2 {
  const activeTaskGoal = readActiveTaskGoalFromState({
    ...reactState,
    modelTranscript: transcript,
  });
  const plan =
    asRecord(reactState.planDocument) ??
    asRecord(reactState.plan) ??
    asRecord(reactState.activePlan);
  const visibleTodos = normalizeVisibleTodoState(reactState.visibleTodos);
  const nextAction = asRecord(reactState.nextAction);
  const waitingFor = asRecord(reactState.waitingFor);
  const lastAction = asRecord(reactState.lastActionResult);
  return fitRuntimeFallbackSummaryToTokenBudget({
    summary: {
      decisions: boundedStrings([
        activeTaskGoal !== undefined
          ? `Active task: ${activeTaskGoal}`
          : undefined,
        asString(reactState.decisionReason),
        asString(asRecord(reactState.decision)?.reason),
        compactRuntimeValue(plan),
      ]),
      constraints: boundedStrings([
        compactRuntimeValue(plan?.successCriteria),
        compactRuntimeValue(plan?.constraints),
      ]),
      evidence: boundedStrings([
        ...(buildRecentToolResultEvidence({
          lastActionResult: reactState.lastActionResult,
          transcript,
        }) ?? []),
        ...(buildActiveProcessEvidence(reactState, transcript) ?? []),
        RUNTIME_FALLBACK_AUTHORITY_NOTE,
      ]),
      fileState: boundedStrings(
        buildRecentFilesystemEvidence(reactState) ?? [],
      ),
      blockers: boundedStrings([
        asString(waitingFor?.reason),
        asString(waitingFor?.message),
        asString(lastAction?.error),
        compactRuntimeValue(waitingFor),
      ]),
      nextActions: boundedStrings([
        renderVisibleTodosForModel(visibleTodos),
        compactRuntimeValue(nextAction),
      ]),
    },
    maxTokens,
    tokenCounter,
  });
}

const RUNTIME_FALLBACK_AUTHORITY_NOTE =
  "Earlier freeform details were not semantically summarized; persisted artifacts and current runtime evidence remain authoritative.";

const COMPACTION_SUMMARY_FIELDS = [
  "decisions",
  "constraints",
  "blockers",
  "nextActions",
  "fileState",
  "evidence",
] as const;

function minimumRuntimeFallbackSummary(): KestrelCompactionSummaryV2 {
  return {
    decisions: [],
    constraints: [],
    evidence: [RUNTIME_FALLBACK_AUTHORITY_NOTE],
    fileState: [],
    blockers: [],
    nextActions: [],
  };
}

function minimumRuntimeFallbackSummaryTokens(
  tokenCounter?: ReturnType<typeof resolveModelTokenCounter>,
): number {
  return compactionSummaryTokens(
    minimumRuntimeFallbackSummary(),
    tokenCounter,
  );
}

function fitRuntimeFallbackSummaryToTokenBudget(input: {
  summary: KestrelCompactionSummaryV2;
  maxTokens: number;
  tokenCounter?: ReturnType<typeof resolveModelTokenCounter>;
}): KestrelCompactionSummaryV2 {
  const fitted = minimumRuntimeFallbackSummary();
  const maxTokens = Math.max(
    minimumRuntimeFallbackSummaryTokens(input.tokenCounter),
    Math.trunc(input.maxTokens),
  );
  const deferred: Array<{
    field: (typeof COMPACTION_SUMMARY_FIELDS)[number];
    value: string;
  }> = [];
  const maxFieldLength = Math.max(
    ...COMPACTION_SUMMARY_FIELDS.map(
      (field) => input.summary[field].length,
    ),
  );
  for (let index = 0; index < maxFieldLength; index += 1) {
    for (const field of COMPACTION_SUMMARY_FIELDS) {
      const value = input.summary[field][index];
      if (value === undefined) {
        continue;
      }
      if (value === RUNTIME_FALLBACK_AUTHORITY_NOTE) {
        continue;
      }
      const candidate = {
        ...fitted,
        [field]: [...fitted[field], value],
      };
      if (compactionSummaryTokens(candidate, input.tokenCounter) <= maxTokens) {
        fitted[field].push(value);
        continue;
      }
      deferred.push({ field, value });
    }
  }
  for (const { field, value } of deferred) {
    const prefix = longestCompactionSummaryValuePrefix({
        summary: fitted,
        field,
        value,
        maxTokens,
        tokenCounter: input.tokenCounter,
      });
    if (prefix !== undefined) {
      fitted[field].push(prefix);
      break;
    }
  }
  return fitted;
}

function longestCompactionSummaryValuePrefix(input: {
  summary: KestrelCompactionSummaryV2;
  field: (typeof COMPACTION_SUMMARY_FIELDS)[number];
  value: string;
  maxTokens: number;
  tokenCounter?: ReturnType<typeof resolveModelTokenCounter>;
}): string | undefined {
  let lower = 0;
  let upper = input.value.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    const candidate = {
      ...input.summary,
      [input.field]: [
        ...input.summary[input.field],
        input.value.slice(0, midpoint),
      ],
    };
    if (
      compactionSummaryTokens(candidate, input.tokenCounter) <= input.maxTokens
    ) {
      lower = midpoint;
    } else {
      upper = midpoint - 1;
    }
  }
  const prefix = input.value.slice(0, lower);
  return prefix.length > 0 ? prefix : undefined;
}

function compactionSummaryTokens(
  summary: KestrelCompactionSummaryV2,
  tokenCounter?: ReturnType<typeof resolveModelTokenCounter>,
): number {
  return countTextTokens(JSON.stringify(summary), tokenCounter).tokens;
}

function assertCompactionSummaryFitsTokenBudget(
  summary: KestrelCompactionSummaryV2,
  maxTokens: number,
  tokenCounter?: ReturnType<typeof resolveModelTokenCounter>,
): void {
  const summaryTokens = compactionSummaryTokens(summary, tokenCounter);
  if (summaryTokens > maxTokens) {
    throw createRuntimeFailure(
      "HARNESS_ECONOMICS_COMPACTION_SUMMARY_INVALID",
      "Compaction summary exceeds the reserved summary token budget.",
      {
        reason: "summary_token_budget_exceeded",
        summaryTokens,
        maxTokens,
      },
    );
  }
}

function boundedStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter(
          (value): value is string => value !== undefined && value.length > 0,
        )
        .map((value) => value.slice(0, 1_200)),
    ),
  ].slice(0, 8);
}

function compactRuntimeValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function totalContextTokens(
  contextRequest: ReturnType<typeof buildContextRequest>,
): number {
  return contextRequest.metadata.manifestSections.reduce(
    (total, section) => total + section.count.tokens,
    0,
  );
}

function tokenCounterForProfile(profile?: ModelEconomicsProfileV1 | undefined) {
  return profile?.counting.method === "model_tokenizer"
    ? resolveModelTokenCounter(
        profile.counting.counter,
        profile.counting.counterVersion,
      )
    : undefined;
}

function estimateMaintenanceOverheadTokens(input: {
  model: string;
  tokenCounter?: ReturnType<typeof resolveModelTokenCounter>;
  mode: HarnessEconomicsPolicyV1["mode"];
  maxSummaryAttempts: number;
  summaryInputReserveTokens: number;
}): number {
  const requestTokens = (
    messages: ModelRequest["messages"],
    responseSchema: Record<string, unknown>,
  ) =>
    countTextTokens(
      JSON.stringify({
        model: input.model,
        messages,
        responseSchema,
        responseFormat: "json",
        reasoning: { mode: "off" },
        providerOptions: maintenanceProviderOptions(
          input.summaryInputReserveTokens,
        ),
      }),
      input.tokenCounter,
    ).tokens;
  const estimates = [
    requestTokens(
      buildKestrelAgentCompactionMessages({ sourceItems: [] }),
      buildKestrelCompactionSummarySchema(),
    ),
  ];
  if (input.maxSummaryAttempts > 1) {
    estimates.push(
      requestTokens(
        buildKestrelAgentCompactionMessages({
          sourceItems: [],
          correction: {
            source: "semantic_verifier",
            reason: "",
            verifierCategories: {
              decisions: false,
              constraints: false,
              evidence: false,
              fileState: false,
              blockers: false,
              nextActions: false,
            },
          },
        }),
        buildKestrelCompactionSummarySchema(),
      ) +
        (input.mode === "enforce"
          ? input.summaryInputReserveTokens
          : 0),
    );
  }
  if (input.mode === "enforce") {
    estimates.push(
      requestTokens(
        buildKestrelCompactionSufficiencyMessages({
          sourceItems: [],
          proposedSummary: {
            decisions: [],
            constraints: [],
            evidence: [],
            fileState: [],
            blockers: [],
            nextActions: [],
          },
        }),
        KESTREL_COMPACTION_SUFFICIENCY_SCHEMA as unknown as Record<
          string,
          unknown
        >,
      ) + input.summaryInputReserveTokens,
    );
  }
  return Math.max(...estimates);
}

const LEGACY_COMPACTION_MAX_OUTPUT_TOKENS = 4_096;

function estimateActionProviderOverheadTokens(input: {
  model: string;
  contextRequest: ReturnType<typeof buildContextRequest>;
  reasoning: ModelReasoningRequest;
  toolChoice: "required";
  parallelToolCalls: boolean;
  modelProfile?: ModelEconomicsProfileV1 | undefined;
}): number {
  return buildModelRequestEconomicsManifest({
    request: {
      model: input.model,
      input: input.contextRequest.modelInput,
      messages: input.contextRequest.messages,
      reasoning: input.reasoning,
      providerOptions: deliberatorProviderOptions(
        input.toolChoice,
        input.parallelToolCalls,
      ),
    },
    contextSections: input.contextRequest.metadata.manifestSections,
    ...(input.modelProfile !== undefined
      ? { modelProfile: input.modelProfile }
      : {}),
  }).providerOverhead.tokens;
}

function deliberatorProviderOptions(
  toolChoice: "required",
  parallelToolCalls: boolean,
) {
  return {
    openrouter: {
      endpoint: "chat" as const,
      toolChoice,
      parallelToolCalls,
    },
    openai: {
      toolChoice,
      parallelToolCalls,
    },
    anthropic: {
      toolChoice,
      parallelToolCalls,
    },
  };
}

function maintenanceProviderOptions(maxTokens: number) {
  const boundedMaxTokens = Math.max(1, Math.trunc(maxTokens));
  return {
    openrouter: {
      endpoint: "chat" as const,
      toolChoice: "none" as const,
      maxTokens: boundedMaxTokens,
    },
    openai: {
      toolChoice: "none" as const,
      maxTokens: boundedMaxTokens,
    },
    anthropic: {
      toolChoice: "none" as const,
      maxTokens: boundedMaxTokens,
    },
  };
}

function throwRequiredContextBudgetFailure(
  contextTokens: number,
  toolSchemaTokens: number,
): never {
  throw createRuntimeFailure(
    "HARNESS_ECONOMICS_CONTEXT_ADMISSION_BLOCKED",
    "Required model context cannot fit the selected economics budget after deterministic compaction.",
    {
      reason: "required_budget_exhausted",
      contextTokens,
      toolSchemaTokens,
    },
  );
}

function readCompactionFailure(error: unknown): RuntimeFailure | undefined {
  return error instanceof RuntimeFailure &&
    error.code === "HARNESS_ECONOMICS_COMPACTION_SUMMARY_INVALID"
    ? error
    : undefined;
}

function readMaintenanceFailureCode(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof RuntimeFailure) {
    return error.code;
  }
  return asString(asRecord(error)?.code) ?? fallback;
}

function readVerifierCategories(
  failure: RuntimeFailure,
):
  | NonNullable<
      KestrelAgentCompactionCorrectionV1["verifierCategories"]
    >
  | undefined {
  const value = failure.details?.verifierCategories;
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const fields = [
    "decisions",
    "constraints",
    "evidence",
    "fileState",
    "blockers",
    "nextActions",
  ] as const;
  if (fields.some((field) => typeof record[field] !== "boolean")) {
    return undefined;
  }
  return Object.fromEntries(
    fields.map((field) => [field, record[field]]),
  ) as NonNullable<
    KestrelAgentCompactionCorrectionV1["verifierCategories"]
  >;
}

function readDeliberatorPromptInput(input: Record<string, unknown>): {
  interactionMode: InteractionMode;
  actSubmode?: ActSubmode | undefined;
  promptVariant?: string | undefined;
} {
  const modeResolution = normalizeInteractionMode({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    defaultInteractionMode: DEFAULT_INTERACTION_MODE,
    defaultActSubmode: DEFAULT_ACT_SUBMODE,
  });
  const promptVariant = asString(input.promptVariant);
  return {
    interactionMode: modeResolution.interactionMode,
    ...(modeResolution.actSubmode !== undefined ? { actSubmode: modeResolution.actSubmode } : {}),
    ...(promptVariant !== undefined ? { promptVariant } : {}),
  };
}

function readSystemInstructions(
  eventPayload: Record<string, unknown>,
): { systemInstructions?: string[] | undefined } {
  if (Array.isArray(eventPayload.systemInstructions) === false) {
    return {};
  }
  const systemInstructions = eventPayload.systemInstructions.flatMap(
    (entry) => {
      const instruction = asString(entry)?.trim();
      return instruction === undefined || instruction.length === 0
        ? []
        : [instruction];
    },
  );
  return systemInstructions.length > 0 ? { systemInstructions } : {};
}

function readRuntimeAssemblyPromptVariant(eventPayload: Record<string, unknown>): string | undefined {
  const runtimeAssembly =
    asRecord(asRecord(eventPayload.metadata)?.runtimeAssembly) ??
    asRecord(eventPayload.runtimeAssembly);
  return asString(runtimeAssembly?.promptVariant);
}

function readRuntimeEconomics(eventPayload: Record<string, unknown>, requestedModel?: string): {
  policy?: HarnessEconomicsPolicyV1 | undefined;
  modelProfile?: ModelEconomicsProfileV1 | undefined;
} {
  const runtimeAssembly =
    asRecord(asRecord(eventPayload.metadata)?.runtimeAssembly) ??
    asRecord(eventPayload.runtimeAssembly);
  if (runtimeAssembly?.harnessEconomics === undefined) return {};
  const control = parseHarnessEconomicsControlV1(runtimeAssembly.harnessEconomics);
  const provider = asString(runtimeAssembly.modelProvider);
  const model = requestedModel ?? asString(runtimeAssembly.model);
  return {
    policy: control.policy,
    ...(provider !== undefined && model !== undefined
      ? { modelProfile: resolveModelEconomicsProfileV1(control, provider, model) }
      : {}),
  };
}

function readRuntimeShellKind(
  eventPayload: Record<string, unknown>,
): { environmentShellKind?: "cli" | "web" | "desktop" | undefined } {
  const runtimeAssembly =
    asRecord(asRecord(eventPayload.metadata)?.runtimeAssembly) ??
    asRecord(eventPayload.runtimeAssembly);
  const shellKind = asString(runtimeAssembly?.environmentShellKind);
  return shellKind === "cli" || shellKind === "web" || shellKind === "desktop"
    ? { environmentShellKind: shellKind }
    : {};
}

function readProjectSnapshotContext(sessionState: Record<string, unknown>): unknown {
  return asRecord(asRecord(sessionState.product)?.projectSnapshot);
}

function buildDevShellToolFilterProcesses(
  devShellProcesses: InternalDecisionContext["devShellProcesses"],
  postToolVerification: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (devShellProcesses.length > 0) {
    return devShellProcesses;
  }
  const devShell = asRecord(postToolVerification?.devShell);
  const activeProcessId = asString(devShell?.activeProcessId)?.trim();
  if (activeProcessId === undefined || activeProcessId.length === 0 || devShell?.activeProcessPresent !== true) {
    return [];
  }
  return [
    {
      processId: activeProcessId,
      live: true,
      ...(asString(devShell?.status) !== undefined ? { status: asString(devShell?.status) } : {}),
    },
  ];
}

function hasPendingExecutionBoundary(reactState: Record<string, unknown>): boolean {
  const exec = asRecord(reactState.exec);
  const commandBatch = asRecord(reactState.commandBatch);
  return (
    readActiveWaitState(reactState) !== undefined ||
    (commandBatch !== undefined && asString(commandBatch.status) !== "processed") ||
    asRecord(exec?.pendingAction) !== undefined ||
    asRecord(exec?.pendingToolCall) !== undefined ||
    asRecord(exec?.pendingToolBatch) !== undefined ||
    asRecord(exec?.pendingBatch) !== undefined ||
    asRecord(exec?.pendingApproval) !== undefined ||
    asString(exec?.pendingEffectKey) !== undefined ||
    asString(exec?.pendingEffectType) !== undefined
  );
}

function readManagedEntrypointToolFilterArtifactTarget(
  decisionContext: InternalDecisionContext,
): string | undefined {
  void decisionContext;
  return ;
}

function tryCompileAgentAction(
  phase: DecisionPhase,
  normalizedTurn: ReturnType<typeof normalizeModelToolCallsToAgentTurn>,
  observedCapabilities: string[],
  capabilityManifest: ToolCapabilityManifestItem[],
  availableTools: ModelToolSpec[],
  repetitionSignals: InternalDecisionContext["repetitionSignals"],
  recoveryVerdict: InternalDecisionContext["recoveryVerdict"],
  evidenceRecoverySummary: InternalDecisionContext["evidenceRecoverySummary"],
  postToolVerification: Record<string, unknown> | undefined,
  devShellProcesses: InternalDecisionContext["devShellProcesses"],
  evidenceContext: InternalDecisionContext["evidenceContext"],
  evidenceLedger: InternalDecisionContext["evidenceLedger"],
  visibleTodos: InternalDecisionContext["visibleTodos"],
  lastActionResult: unknown,
  runId: string,
  interactionMode?: InteractionMode,
  executionPolicy?: ExecutionPolicyOverride,
  canonicalIntentContext?: CanonicalIntentContext,
  workspaceRoot?: string | undefined,
  activePlan?: InternalDecisionContext["plan"],
  modelText?: string | undefined,
):
  | {
      ok: true;
      value: CompiledDecision;
    }
  | {
      ok: false;
      error: {
        code: DecisionFailureCode;
        message: string;
        details?: Record<string, unknown> | undefined;
      };
    } {
  if (normalizedTurn.action === undefined) {
    return {
      ok: false,
      error: {
        code: "DECISION_SCHEMA_FAILED",
        message: "Model tool-call turn did not include an executable action.",
        details: {
          schemaCategory: "tool_call",
          reason: "missing_executable_action",
        },
      },
    };
  }
  try {
    const compiled = compileAgentAction({
      phase,
      action: normalizedTurn.action,
      ...(normalizedTurn.visibleTodos !== undefined ? { visibleTodosPatch: normalizedTurn.visibleTodos } : {}),
      reason: buildToolCallDecisionReason(normalizedTurn, modelText),
      actionProvenance: normalizedTurn.provenance,
      sourceRunId: runId,
      observedCapabilities,
      capabilityManifest,
      availableTools,
      ...(repetitionSignals !== undefined ? { repetitionSignals } : {}),
      ...(recoveryVerdict !== undefined ? { recoveryVerdict } : {}),
      ...(evidenceRecoverySummary !== undefined ? { evidenceRecoverySummary } : {}),
      ...(postToolVerification !== undefined ? { postToolVerification } : {}),
      devShellProcesses,
      evidenceContext,
      evidenceLedger,
      visibleTodos,
      lastActionResult,
      interactionMode,
      executionPolicy,
      workspaceRoot,
      activePlan,
      ...(canonicalIntentContext?.compiledIntent !== undefined
        ? { compiledIntent: canonicalIntentContext.compiledIntent }
        : {}),
      ...(canonicalIntentContext?.executionIntent !== undefined
        ? { executionIntent: canonicalIntentContext.executionIntent }
        : {}),
      ...(canonicalIntentContext?.intentMetadata !== undefined
        ? { intentMetadata: canonicalIntentContext.intentMetadata }
        : {}),
      ...(canonicalIntentContext?.intentConfidence !== undefined
        ? { intentConfidence: canonicalIntentContext.intentConfidence }
        : {}),
      ...(canonicalIntentContext?.toolIntent !== undefined
        ? { toolIntent: canonicalIntentContext.toolIntent }
        : {}),
    });
    return {
      ok: true,
      value: compiled,
    };
  } catch (error) {
    return {
      ok: false,
      error: mapDecisionCompileError(error),
    };
  }
}

function buildToolCallDecisionReason(
  normalizedTurn: ReturnType<typeof normalizeModelToolCallsToAgentTurn>,
  modelText?: string | undefined,
): string {
  const trimmedModelText = modelText?.trim();
  if (trimmedModelText !== undefined && trimmedModelText.length > 0) {
    return trimmedModelText;
  }
  const names = normalizedTurn.provenance.canonicalNames.filter((name) => name !== "kestrel.todo_update");
  return names.length > 0
    ? `Use ${names.join(", ")} to advance the task.`
    : "Update the visible task checklist.";
}

function mapModelToolCallActionError(error: unknown): {
  code: DecisionFailureCode;
  message: string;
  details?: Record<string, unknown> | undefined;
} {
  if (error instanceof ModelToolCallActionError) {
    return {
      code: "DECISION_SCHEMA_FAILED",
      message: error.message,
      details: {
        schemaCategory: "tool_call",
        ...error.details,
      },
    };
  }
  return mapDecisionCompileError(error);
}

function toAgentLoopTodoOnlyTransition(input: {
  stepIndex: number;
  loopStepId: string;
  reactState: Record<string, unknown>;
  goal: string | undefined;
  visibleTodos: ReturnType<typeof normalizeModelToolCallsToAgentTurn>["visibleTodos"] | undefined;
  modelToolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string | undefined }>;
  assistantProgress?: string | undefined;
}): Transition {
  let modelTranscript = appendAssistantToolCallsToTranscript({
    transcript: input.reactState.modelTranscript,
    stepIndex: input.stepIndex,
    toolCalls: input.modelToolCalls,
  });
  for (const toolCall of input.modelToolCalls) {
    if (toolCall.name !== "kestrel.todo_update") {
      continue;
    }
    modelTranscript = appendToolResultToTranscript({
      transcript: modelTranscript,
      toolName: toolCall.name,
      toolInput: toolCall.input,
      toolOutput: {
        ok: true,
        summary: "Visible todos updated.",
      },
      toolCallId: toolCall.id,
      stepIndex: input.stepIndex,
    });
  }
  if (input.visibleTodos !== undefined) {
    modelTranscript = appendTodoUpdateToTranscript({
      transcript: modelTranscript,
      visibleTodos: input.visibleTodos,
      stepIndex: input.stepIndex,
    });
  }
  return {
    status: "RUNNING",
    nextStepAgent: input.loopStepId,
    statePatch: buildAgentLoopStatePatch({
      ...input.reactState,
      ...createReferenceReactNextActionPatch(undefined),
      ...createReferenceReactRetryContextPatch(undefined),
      ...(input.visibleTodos !== undefined ? { visibleTodos: input.visibleTodos } : {}),
      modelTranscript,
      ...clearLegacyGoalPatch(),
      decisionReason: "Updated visible todos.",
      lastDecisionAtStep: input.stepIndex,
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "agent.loop",
          decisionCode: "visible_todo_update",
          metadata: {
            toolCallCount: input.modelToolCalls.length,
            itemCount: input.visibleTodos?.items.length ?? 0,
          },
        },
      ],
      phase: "THINK",
    }),
    stateNode: {
      parent: "agent",
      child: "loop",
    },
    ...(input.assistantProgress !== undefined ? { agentProgress: input.assistantProgress } : {}),
  };
}

function toAgentLoopActionTransition(
  stepIndex: number,
  reactState: Record<string, unknown>,
  goal: string,
  compiled: CompiledDecision,
  capabilityManifest: ToolCapabilityManifestItem[],
  loopStepId: string,
  execDispatchStepId: string,
  runId: string,
  modeResolution: { interactionMode: InteractionMode; actSubmode?: ActSubmode | undefined },
  executionPolicy: ExecutionPolicyOverride | undefined,
  previousResponse: unknown,
  modelToolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string | undefined }>,
  askUserAvailable: boolean,
  assistantProgress?: string | undefined,
): Transition {
  const action = compiled.action;
  if (action === undefined) {
    throw new Error("Agent loop compiled decision is missing next action.");
  }
  if (action.kind === "request_mode_switch") {
    const modelTranscript = appendAssistantToolCallsToTranscript({
      transcript: reactState.modelTranscript,
      toolCalls: modelToolCalls,
      stepIndex,
    });
    return toPlannerModeBlockedTransition({
      stepIndex,
      loopStepId,
      execDispatchStepId,
      reactState: { ...reactState, modelTranscript },
      goal,
      interactionMode: modeResolution.interactionMode,
      actSubmode: modeResolution.actSubmode,
      requiredToolClass: action.requiredToolClass,
      blockedActionKind: "mode_switch_request",
      requestReason: action.reason,
    });
  }
  const targetStep = execDispatchStepId;
  const traces = [...compiled.trace];
  const visibleTodoContinuation = buildVisibleTodoFinalizeContinuationTransition({
    action,
    compiled,
    reactState,
    goal,
    loopStepId,
    traces,
    stepIndex,
    askUserAvailable,
  });
  if (visibleTodoContinuation !== undefined && visibleTodoContinuation.kind === "continue") {
      return visibleTodoContinuation.transition;
    }
  const visibleTodosForState = visibleTodoContinuation?.visibleTodos ?? compiled.visibleTodos;
  traces.push({
    eventType: "agent.action_selected",
    phase: "agent.loop",
    decisionCode: action.kind,
    metadata: {
      reason: "single_loop_action",
    },
  });
  const toolExecutionClassByName = Object.fromEntries(
    capabilityManifest.map((tool) => [tool.name, tool.executionClass ?? "read_only"]),
  );
  const toolApprovalCapabilitiesByName = Object.fromEntries(
    capabilityManifest.map((tool) => [tool.name, tool.approvalCapabilities ?? []]),
  );
  const toolAllowedInteractionModesByName = Object.fromEntries(
    capabilityManifest.map((tool) => [tool.name, tool.allowedInteractionModes]),
  );
  const blockedToolClass = resolveBlockedActionPolicy({
    action,
    toolExecutionClassByName,
    toolApprovalCapabilitiesByName,
    toolAllowedInteractionModesByName,
    modeResolution,
    executionPolicy,
  });
  if (blockedToolClass !== undefined) {
    if (blockedToolClass.blockedCapability !== undefined) {
      return toAgentLoopValidationFeedbackTransition({
        stepIndex,
        loopStepId,
        reactState,
        goal,
        error: {
          code: "DECISION_POLICY_FAILED",
          message:
            `Current execution policy blocks capability '${blockedToolClass.blockedCapability}' for ${blockedToolClass.toolName}. Choose a different allowed tool or ask the operator to change policy.`,
          details: {
            reason: "capability_policy_blocked",
            blockedActionKind: action.kind,
            blockedActionId: blockedToolClass.toolName,
            requiredToolClass: blockedToolClass.toolClass,
            blockedCapability: blockedToolClass.blockedCapability,
            interactionMode: modeResolution.interactionMode,
          },
        },
        schemaCategory: "mode_policy",
        previousResponse,
      });
    }
    if (
      modeResolution.interactionMode === "plan" &&
      blockedToolClass.toolClass === "external_side_effect"
    ) {
      return toAgentLoopValidationFeedbackTransition({
        stepIndex,
        loopStepId,
        reactState,
        goal,
        error: {
          code: "DECISION_POLICY_FAILED",
          message:
            "Plan mode cannot request external side-effect tools. Choose a read-only tool, ask_user, or finalize with the available planning evidence.",
          details: {
            reason: "plan_mode_external_side_effect_disallowed",
            blockedActionKind: action.kind,
            blockedActionId: blockedToolClass.toolName,
            requiredToolClass: blockedToolClass.toolClass,
            interactionMode: modeResolution.interactionMode,
            allowedPlanModeActions: [
              "read_only tool",
              "ask_user",
              "finalize",
            ],
          },
        },
        schemaCategory: "mode_policy",
        previousResponse,
      });
    }
    return toPlannerModeBlockedTransition({
      stepIndex,
      loopStepId,
      execDispatchStepId,
      reactState,
      goal,
      interactionMode: modeResolution.interactionMode,
      actSubmode: modeResolution.actSubmode,
      requiredToolClass: blockedToolClass.toolClass,
      blockedActionKind: action.kind,
      blockedActionId: blockedToolClass.toolName,
    });
  }

  const decisionReason = compiled.reason ?? asString(asRecord(previousResponse)?.reason);
  const activeRetryContext = asRecord(reactState.retryContext);
  const retryContextResolved = activeRetryContext !== undefined;
  const actionWithToolCallIds = attachModelToolCallIdsToToolBatchAction(action, modelToolCalls);
  const commandBatch = buildReferenceReactCommandBatchFromAction({
    action: cloneActionSnapshot(actionWithToolCallIds),
    stepIndex,
    toolExecutionClassByName,
    planningSummary: decisionReason,
  });
  let modelTranscript = appendActionToTranscript({
    transcript: reactState.modelTranscript,
    action: actionWithToolCallIds,
    modelToolCalls,
    stepIndex,
  });
  for (const toolCall of modelToolCalls) {
    if (toolCall.name !== "kestrel.todo_update") {
      continue;
    }
    modelTranscript = appendToolResultToTranscript({
      transcript: modelTranscript,
      toolName: toolCall.name,
      toolInput: toolCall.input,
      toolOutput: {
        ok: true,
        summary: "Visible todos updated.",
      },
      toolCallId: toolCall.id,
      stepIndex,
    });
  }
  if (visibleTodosForState !== undefined) {
    modelTranscript = appendTodoUpdateToTranscript({
      transcript: modelTranscript,
      visibleTodos: visibleTodosForState,
      stepIndex,
    });
  }
  const nextAction = cloneActionSnapshot(actionWithToolCallIds);
  const lastAction = cloneActionSnapshot(actionWithToolCallIds);
  const closeoutLatch = asRecord(reactState.closeoutLatch);
  const transition: Transition = {
    status: "RUNNING",
    nextStepAgent: targetStep,
    statePatch: buildAgentLoopStatePatch({
      ...reactState,
      ...createReferenceReactNextActionPatch(nextAction),
      lastAction,
      ...(reactState.pendingContinuationOffer !== undefined
        ? { pendingContinuationOffer: undefined }
        : {}),
      commandBatch: {
        ...commandBatch,
        status: "ready",
        sourceStepAgent: "agent.loop",
        targetStepAgent: targetStep,
        createdAtStepIndex: stepIndex,
      },
      ...createReferenceReactRetryContextPatch(
        retryContextResolved ? undefined : activeRetryContext,
      ),
      ...(visibleTodosForState !== undefined ? { visibleTodos: visibleTodosForState } : {}),
      modelTranscript,
      ...clearLegacyGoalPatch(),
      ...(compiled.verification !== undefined ? { decisionVerification: compiled.verification } : {}),
      ...(closeoutLatch !== undefined
        ? {
            closeoutLatch: {
              ...closeoutLatch,
              active: false,
              selectedActionKind: action.kind,
            },
          }
        : {}),
      decisionReason,
      lastDecisionAtStep: stepIndex,
      decisionTrace: traces,
      phase: "ACT",
    }),
    stateNode: {
      parent: "agent",
      child: "loop",
    },
    ...(assistantProgress !== undefined && action.kind !== "finalize" && action.kind !== "cannot_satisfy" && action.kind !== "ask_user"
      ? { agentProgress: assistantProgress }
      : {}),
  };
  return transition;
}

function buildVisibleTodoFinalizeContinuationTransition(input: {
  action: NonNullable<CompiledDecision["action"]>;
  compiled: CompiledDecision;
  reactState: Record<string, unknown>;
  goal: string;
  loopStepId: string;
  traces: DecisionTrace[];
  stepIndex: number;
  askUserAvailable: boolean;
}):
  | { kind: "continue"; transition: Transition }
  | { kind: "allow"; visibleTodos?: VisibleTodoState | undefined }
  | undefined {
  if (
    input.action.kind !== "finalize" ||
    input.action.finalizeReason !== "goal_satisfied"
  ) {
    return ;
  }
  const visibleTodos = input.compiled.visibleTodos ?? normalizeVisibleTodoState(input.reactState.visibleTodos);
  if (visibleTodos === undefined) {
    return ;
  }
  const finalizeData = normalizeVisibleTodoResidualGapData(asRecord(input.action.input)?.data);
  const analysis = analyzeVisibleTodoFinalizeReadiness({
    todos: visibleTodos,
    ...(finalizeData !== undefined ? { residualGap: finalizeData } : {}),
  });
  if (analysis.complete) {
    return { kind: "allow" };
  }
  const openItem = analysis.blockingOpenItems[0];
  if (openItem === undefined) {
    return ;
  }
  const decisionReason = buildVisibleTodoFinalizeContinuationCorrection({
    itemId: openItem.id,
    itemText: openItem.text,
    itemStatus: openItem.status,
    note: openItem.note,
    askUserAvailable: input.askUserAvailable,
  });
  const correctionAction = input.askUserAvailable
    ? "advance_close_or_wait_on_user_before_finalize"
    : "advance_or_close_visible_todo_before_finalize";
  const allowedNextActions = [
    "call a workspace tool that directly advances the open item",
    ...(input.askUserAvailable
      ? ["if the open item cannot advance until the user replies, call kestrel_ask_user with the direct question and leave the item open across the wait"]
      : []),
    "if observed evidence already proves the item complete, combine kestrel_todo_update marking that exact item done with an evidence note and kestrel_finalize",
  ];
  const retryContext = {
    failure: {
      code: "DECISION_POLICY_FAILED",
      message: "Visible checklist still has open work; success finalization should continue from the open item.",
      details: {
        reason: "visible_todo_finalize_continuation",
        openVisibleTodoItemId: openItem.id,
        openVisibleTodoItemText: openItem.text,
        openVisibleTodoItemStatus: openItem.status,
        ...(openItem.note !== undefined ? { openVisibleTodoItemNote: openItem.note } : {}),
        modelFeedback: decisionReason,
      },
      schemaCategory: "visible_todos",
    },
    requiredCorrection: {
      visibleTodoBeforeFinalize: {
        action: correctionAction,
        openItem: {
          id: openItem.id,
          text: openItem.text,
          status: openItem.status,
          ...(openItem.note !== undefined ? { note: openItem.note } : {}),
        },
        forbiddenActionWhileOpen: "kestrel_finalize by itself",
        allowedNextActions,
        ...(openItem.status === "blocked"
          ? {
              blockedItemRecovery:
                "If this is a documented residual risk instead of actionable work, include it in finalize data.openGap or data.knownWarnings and close the exact item with a note in the same turn.",
            }
          : {}),
      },
    },
  };
  const traces = [
    ...input.traces,
    {
      eventType: "decision.redirected" as const,
      phase: "agent.loop" as const,
      decisionCode: "visible_todo_finalize_continuation",
      metadata: {
        actionKind: input.action.kind,
        finalizeReason: input.action.finalizeReason,
        openVisibleTodoItemId: openItem.id,
        openVisibleTodoItemText: openItem.text,
        openVisibleTodoItemStatus: openItem.status,
      },
    },
  ];
  return {
    kind: "continue",
    transition: {
      status: "RUNNING",
      nextStepAgent: input.loopStepId,
      statePatch: buildAgentLoopStatePatch({
        ...input.reactState,
        ...createReferenceReactNextActionPatch(undefined),
        lastAction: cloneActionSnapshot(input.action),
        commandBatch: undefined,
        ...createReferenceReactRetryContextPatch(retryContext),
        visibleTodos,
        ...clearLegacyGoalPatch(),
        decisionReason,
        lastDecisionAtStep: input.stepIndex,
        decisionTrace: traces,
        phase: "THINK",
      }),
      stateNode: {
        parent: "agent",
        child: "loop",
      },
    },
  };
}

function buildVisibleTodoFinalizeContinuationCorrection(input: {
  itemId: string;
  itemText: string;
  itemStatus: string;
  note: string | undefined;
  askUserAvailable: boolean;
}): string {
  const blocker = input.itemStatus === "blocked" && input.note !== undefined
    ? ` Blocker: ${input.note}.`
    : "";
  const residualGuidance = input.itemStatus === "blocked"
    ? " If this is a residual risk rather than actionable work, document it in kestrel_finalize data.openGap or data.knownWarnings, mark the item done with a note, and finalize."
    : "";
  const waitGuidance = input.askUserAvailable
    ? " If the item cannot advance until the user replies, call kestrel_ask_user with the direct question and leave the item open across the wait."
    : "";
  return `Still open: ${input.itemText}.${blocker} Do not call kestrel_finalize by itself again while this item remains open. Continue actionable work with a workspace tool.${waitGuidance} If existing evidence proves it is complete, combine kestrel_todo_update with item '${input.itemId}' marked done and a note naming the observed validation result in the same response as kestrel_finalize.${residualGuidance}`;
}

function resolveBlockedActionPolicy(input: {
  action: NonNullable<CompiledDecision["action"]>;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolAllowedInteractionModesByName: Record<string, InteractionMode[] | undefined>;
  modeResolution: { interactionMode: InteractionMode; actSubmode?: ActSubmode | undefined };
  executionPolicy: ExecutionPolicyOverride | undefined;
}): { toolName: string; toolClass: ToolExecutionClass; blockedCapability?: string | undefined } | undefined {
  const toolNames = readToolNamesFromAction(input.action);
  for (const toolName of toolNames) {
    const toolClass = input.toolExecutionClassByName[toolName] ?? "read_only";
    if (
      isToolEligibleForInteractionMode({
        interactionMode: input.modeResolution.interactionMode,
        actSubmode: input.modeResolution.actSubmode,
        toolClass,
        allowedInteractionModes: input.toolAllowedInteractionModesByName[toolName],
        executionPolicy: input.executionPolicy,
      }) === false
    ) {
      return { toolName, toolClass };
    }
    const blockedCapability = readBlockedApprovalCapability({
      executionPolicy: input.executionPolicy,
      requiredCapabilities: input.toolApprovalCapabilitiesByName[toolName],
    });
    if (blockedCapability !== undefined) {
      return { toolName, toolClass, blockedCapability };
    }
  }
  return ;
}

function remapToolAvailabilityPolicyError(input: {
  error: {
    code: DecisionFailureCode;
    message: string;
    details?: Record<string, unknown> | undefined;
  };
  capabilityManifest: ToolCapabilityManifestItem[];
  interactionMode: InteractionMode;
  executionPolicy: ExecutionPolicyOverride | undefined;
}): {
  code: DecisionFailureCode;
  message: string;
  details?: Record<string, unknown> | undefined;
} {
  const details = asRecord(input.error.details);
  const toolName = asString(details?.toolName);
  if (
    input.error.code !== "DECISION_SCHEMA_FAILED" ||
    asString(details?.reason) !== "tool_not_available" ||
    toolName === undefined
  ) {
    return input.error;
  }
  const manifestItem = input.capabilityManifest.find((item) => item.name === toolName);
  if (manifestItem === undefined) {
    return input.error;
  }
  const toolClass = manifestItem.executionClass ?? "read_only";
  if (
    isToolEligibleForInteractionMode({
      interactionMode: input.interactionMode,
      toolClass,
      allowedInteractionModes: manifestItem.allowedInteractionModes,
      executionPolicy: input.executionPolicy,
    }) === false
  ) {
    return {
      code: "DECISION_POLICY_FAILED",
      message: `Tool '${toolName}' is blocked by the current interaction mode or execution policy.`,
      details: {
        ...details,
        reason: "mode_policy_blocked",
        requiredToolClass: toolClass,
      },
    };
  }
  const blockedCapability = readBlockedApprovalCapability({
    executionPolicy: input.executionPolicy,
    requiredCapabilities: manifestItem.approvalCapabilities,
  });
  if (blockedCapability === undefined) {
    return input.error;
  }
  return {
    code: "DECISION_POLICY_FAILED",
    message: `Current execution policy blocks capability '${blockedCapability}' for ${toolName}. Choose a different allowed tool or ask the operator to change policy.`,
    details: {
      ...details,
      reason: "capability_policy_blocked",
      requiredToolClass: toolClass,
      blockedCapability,
      blockedActionId: toolName,
    },
  };
}

function readToolNamesFromAction(action: NonNullable<CompiledDecision["action"]>): string[] {
  if (action.kind === "tool") {
    return [action.name];
  }
  if (action.kind === "tool_batch") {
    return action.items.map((item) => item.name);
  }
  return [];
}

function isPendingRuntimeContinuationReply(
  reactState: Record<string, unknown>,
  eventType: string,
): boolean {
  const waitFor = readActiveWaitFor(reactState);
  if (waitFor?.eventType !== eventType || eventType !== "user.reply") {
    return false;
  }
  const metadata = asRecord(waitFor.metadata);
  const reason = asString(metadata?.reason);
  return reason !== undefined && PLAN_HANDOFF_CONTINUATION_REASONS.has(reason);
}

function validateRuntimeContinuationResume(input: {
  reactState: Record<string, unknown>;
  activeContinuation: RuntimeContinuationStateV1;
}): RuntimeContinuationInvalidationReason | undefined {
  const { activeContinuation } = input;
  if (activeContinuation.status !== "awaiting_user") {
    return "continuation_already_consumed";
  }
  const waitFor = readActiveWaitFor(input.reactState);
  const metadata = asRecord(waitFor?.metadata);
  const waitContinuationId = asString(metadata?.continuationId);
  if (
    waitContinuationId !== undefined &&
    waitContinuationId !== activeContinuation.id
  ) {
    return "continuation_id_mismatch";
  }
  if (activeContinuation.planDocumentPath !== undefined) {
    const planDocument = normalizeRuntimePlanDocumentSnapshot(input.reactState.planDocument);
    if (
      planDocument === undefined ||
      planDocument.exists !== true ||
      planDocument.path !== activeContinuation.planDocumentPath
    ) {
      return "missing_plan_document";
    }
  }
  return ;
}

const PLAN_HANDOFF_CONTINUATION_REASONS = new Set([
  "continuation_handoff",
  "plan_handoff",
  "route_mode_blocked",
  "planner_mode_blocked",
  "acter_mode_blocked",
]);

function normalizeLegacyContinuationRuntimeState(
  reactState: ReferenceReactAgentState,
): ReferenceReactAgentState {
  const activeContinuation = normalizeRuntimeContinuationState(reactState.activeContinuation);
  if (activeContinuation !== undefined) {
    return reactState.pendingContinuationOffer === undefined
      ? reactState
      : {
          ...reactState,
          pendingContinuationOffer: undefined,
        };
  }
  const pendingContinuationOffer = normalizeContinuationOffer(reactState.pendingContinuationOffer, "legacy-handoff");
  if (pendingContinuationOffer === undefined) {
    return reactState;
  }
  const activeWait = readActiveWaitFor(reactState);
  const activeWaitRecord = asRecord(activeWait);
  const metadata = asRecord(activeWait?.metadata);
  const reason = asString(metadata?.reason) ?? asString(activeWaitRecord?.reason);
  if (reason === undefined || PLAN_HANDOFF_CONTINUATION_REASONS.has(reason) === false) {
    return {
      ...reactState,
      pendingContinuationOffer: undefined,
    };
  }
  const planDocument = normalizeRuntimePlanDocumentSnapshot(reactState.planDocument);
  const runtimeContinuation = createRuntimeContinuationState({
    offer: pendingContinuationOffer,
    resumeStepAgent: asString(activeWaitRecord?.resumeStepAgent) ?? "agent.exec.wait_user",
    planDocumentPath: planDocument?.path,
    proposedNextAction: asString(metadata?.proposedNextAction),
    handoffMessage: asString(metadata?.prompt),
  });
  const waitingFor = asRecord(reactState.waitingFor);
  const nextReason = reason === "plan_handoff" ? "continuation_handoff" : reason;
  return {
    ...reactState,
    activeContinuation: runtimeContinuation,
    pendingContinuationOffer: undefined,
    ...(waitingFor !== undefined
      ? {
          ...createReferenceReactWaitingForPatch({
            ...waitingFor,
            reason: nextReason,
            metadata: {
              ...(metadata ?? {}),
              reason: nextReason,
              continuationId: runtimeContinuation.id,
            },
          }),
        }
      : {}),
  };
}

function readBlockedWaitReason(reactState: Record<string, unknown>): string | undefined {
  return asString(readActiveWaitFor(reactState)?.metadata?.reason);
}

async function shouldTreatUserReplyAsContinuationResume(input: {
  eventType: string;
  eventPayload: Record<string, unknown>;
  reactState: Record<string, unknown>;
  model: string;
  io: StepIO;
}): Promise<boolean> {
  if (input.eventType !== "user.reply") {
    return false;
  }
  const message = asString(input.eventPayload?.message) ?? asString(input.eventPayload?.text);
  if (message === undefined || message.length === 0) {
    return false;
  }
  const waitReason = readBlockedWaitReason(input.reactState);
  if (waitReason === undefined || PLAN_HANDOFF_CONTINUATION_REASONS.has(waitReason) === false) {
    return false;
  }

  const intent = await classifyUserReplyIntent({
    reply: message,
    waitFor: readActiveWaitFor(input.reactState),
    model: input.model,
    useModel: input.io.useModel,
  });
  input.eventPayload.userReplyIntent = intent;
  return isHighConfidenceContinuation(intent) || intent.kind === "mode_switch" && intent.proceed === true && intent.confidence === "high";
}

function readActiveWaitFor(reactState: Record<string, unknown>): UserWaitForMatcher | undefined {
  const wait = readActiveWaitState(reactState);
  return wait?.kind === "user" ? wait as unknown as UserWaitForMatcher : undefined;
}

function readRepeatedActionFailureForNextStep(input: {
  action: NonNullable<CompiledDecision["action"]> | undefined;
  reactState: Record<string, unknown>;
}): {
  code: DecisionFailureCode;
  message: string;
  details?: Record<string, unknown> | undefined;
} | undefined {
  const nextAction = input.action;
  if (nextAction === undefined) {
    return ;
  }
  const lastAction = asRecord(input.reactState.lastAction);
  const lastActionResult = asRecord(input.reactState.lastActionResult);
  if (
    lastAction === undefined ||
    lastActionResult === undefined ||
    !isActionEquivalent(nextAction, lastAction)
  ) {
    return ;
  }

  if (hasObservedExecutionFailure(lastActionResult)) {
    return {
      code: "DECISION_POLICY_FAILED",
      message: "Deliberator repeated the same failed executable action without a repair or changed input.",
      details: {
        reason: "repeated_failed_action_without_repair",
        actionKind: asString(nextAction.kind),
        actionName: readActionName(nextAction),
        lastActionKind: asString(lastAction.kind),
        lastActionStatus: asString(lastActionResult.status),
        lastActionResultKind: asString(lastActionResult.kind),
        previousFailure: summarizeFailedActionResult(lastActionResult),
        requiredCorrection: buildRepeatedFailedActionCorrection(nextAction),
      },
    };
  }

  if (!hasObservedExecutionSuccess(lastActionResult)) {
    return ;
  }
  if (isFilesystemInspectionAction(nextAction)) {
    return ;
  }
  return {
      code: "DECISION_POLICY_FAILED",
      message: "Deliberator repeated the same executable action without observable progress.",
      details: {
        reason: "repeated_action_no_progress",
        actionKind: asString(nextAction.kind),
        actionName: readActionName(nextAction),
        lastActionKind: asString(lastAction.kind),
        lastActionStatus: asString(lastActionResult.status),
        lastActionResultKind: asString(lastActionResult.kind),
      },
  };
}

function buildRepeatedFailedActionCorrection(action: NonNullable<CompiledDecision["action"]>): string {
  if (isFilesystemInspectionAction(action)) {
    return [
      "use the existing filesystem evidence to choose a concrete write, edit, install, or build action",
      "or inspect a different specific file only if that file content is needed",
      "do not repeat the same filesystem inspection",
    ].join("; ");
  }
  return "choose a changed command/cwd, inspect the failure cause, or perform a repair action before retrying";
}

function isFilesystemInspectionAction(action: NonNullable<CompiledDecision["action"]>): boolean {
  if (action.kind === "tool") {
    return isFilesystemInspectionToolName(action.name);
  }
  if (action.kind !== "tool_batch") {
    return false;
  }
  const items = asArray(action.items);
  return items.length > 0 &&
    items.every((item) => {
      const name = asString(asRecord(item)?.name);
      return name !== undefined && isFilesystemInspectionToolName(name);
    });
}

function hasObservedExecutionFailure(lastActionResult: Record<string, unknown>): boolean {
  if (asString(lastActionResult.status) === "failed" || lastActionResult.ok === false) {
    return true;
  }
  const kind = asString(lastActionResult.kind);
  if (kind !== "tool_batch") {
    const output = asRecord(lastActionResult.output);
    return asObservedFailureRecord(output);
  }
  return asArray(lastActionResult.items)
    .map((item) => asRecord(item))
    .some((item) => item !== undefined && asObservedFailureRecord(item));
}

function hasObservedExecutionSuccess(lastActionResult: Record<string, unknown>): boolean {
  if (hasObservedExecutionFailure(lastActionResult)) {
    return false;
  }
  const status = asString(lastActionResult.status);
  if (status === undefined || status === "failed") {
    return false;
  }
  const kind = asString(lastActionResult.kind);
  if (kind === "tool_batch") {
    return asArray(lastActionResult.items).length > 0 || asRecord(lastActionResult.output) !== undefined;
  }
  return kind === "tool";
}

function readActionName(action: NonNullable<CompiledDecision["action"]>): string | undefined {
  return asString(action.kind === "tool_batch"
    ? asString(asRecord(asArray(action.items)[0])?.name)
    : action.name);
}

function summarizeFailedActionResult(lastActionResult: Record<string, unknown>): Record<string, unknown> {
  const error = asRecord(lastActionResult.error);
  const failedBatchItems = asString(lastActionResult.kind) === "tool_batch"
    ? asArray(lastActionResult.items)
      .map((item, itemIndex) => ({ item: asRecord(item), itemIndex }))
      .filter(({ item }) => item !== undefined && asObservedFailureRecord(item))
      .slice(0, 4)
      .map(({ item, itemIndex }) => {
        const output = asRecord(item?.output);
        const itemError = asRecord(item?.error);
        return omitUndefined({
          itemIndex,
          toolName: asString(item?.name) ?? asString(item?.toolName),
          status: asString(item?.status) ?? asString(output?.status),
          inputHash: asString(item?.inputHash),
          errorCode: asString(item?.errorCode) ?? asString(itemError?.code) ?? asString(output?.errorCode),
          errorMessage: clampRetryDetail(
            asString(item?.message) ??
              asString(itemError?.message) ??
              asString(output?.message) ??
              asString(output?.error) ??
              asString(output?.stderr) ??
              asString(output?.chunk),
          ),
        });
      })
    : undefined;
  return omitUndefined({
    name: asString(lastActionResult.name) ?? asString(lastActionResult.toolName),
    status: asString(lastActionResult.status),
    kind: asString(lastActionResult.kind),
    inputHash: asString(lastActionResult.inputHash),
    errorCode: asString(error?.code),
    errorMessage: asString(error?.message),
    outputSummary: clampRetryDetail(asString(lastActionResult.outputSummary)),
    failedBatchItems,
  });
}

function asObservedFailureRecord(record: Record<string, unknown> | undefined): boolean {
  if (record === undefined) {
    return false;
  }
  if (record.ok === false) {
    return true;
  }
  const status = asString(record.status)?.toLowerCase();
  if (status === "failed" || status === "failure" || status === "denied") {
    return true;
  }
  const output = asRecord(record.output);
  if (output === undefined) {
    return asRecord(record.error) !== undefined || asString(record.errorCode) !== undefined;
  }
  const outputStatus = asString(output.status)?.toLowerCase();
  return output.ok === false ||
    outputStatus === "failed" ||
    outputStatus === "failure" ||
    outputStatus === "denied" ||
    asRecord(output.error) !== undefined ||
    asString(output.errorCode) !== undefined ||
    asString(output.error) !== undefined;
}

function clampRetryDetail(value: string | undefined): string | undefined {
  if (value === undefined) {
    return ;
  }
  return value.length <= 1200 ? value : `${value.slice(0, 1197)}...`;
}

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function isActionEquivalent(
  left: NonNullable<CompiledDecision["action"]>,
  right: Record<string, unknown>,
): boolean {
  const rightKind = asString(right.kind);
  if (rightKind === undefined || rightKind !== left.kind) {
    return false;
  }
  if (left.kind === "tool_batch") {
    const leftItems = asArray(left.items);
    const rightItems = asArray(right.items);
    if (leftItems.length !== rightItems.length) {
      return false;
    }
    return leftItems.every((leftItem, index) => {
      const leftItemRecord = asRecord(leftItem);
      const rightItemRecord = asRecord(rightItems[index]);
      return isToolItemEquivalent(leftItemRecord, rightItemRecord);
    });
  }
  if (left.kind !== "tool") {
    return false;
  }
  return (
    left.name === asString(right.name) &&
    areJsonValuesEqual(left.input, right.input)
  );
}

function isToolItemEquivalent(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  return (
    left.name === asString(right.name) &&
    areJsonValuesEqual(left.input, right.input)
  );
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray || rightIsArray) {
    if (leftIsArray === false || rightIsArray === false) {
      return false;
    }
    const leftArray = left as unknown[];
    const rightArray = right as unknown[];
    if (leftArray.length !== rightArray.length) {
      return false;
    }
    return leftArray.every((leftItem, index) => areJsonValuesEqual(leftItem, rightArray[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord !== undefined && rightRecord !== undefined) {
    const leftEntries = Object.entries(leftRecord);
    const rightEntries = Object.entries(rightRecord);
    if (leftEntries.length !== rightEntries.length) {
      return false;
    }
    for (const [key, leftValue] of leftEntries) {
      if (!(Object.hasOwn(rightRecord, key) && areJsonValuesEqual(leftValue, rightRecord[key]))) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function toPlannerModeBlockedTransition(input: {
  stepIndex: number;
  loopStepId: string;
  execDispatchStepId: string;
  reactState: Record<string, unknown>;
  goal: string;
  interactionMode: InteractionMode;
  actSubmode?: ActSubmode | undefined;
  requiredToolClass: ToolExecutionClass;
  blockedActionKind: string;
  blockedActionId?: string | undefined;
  activeContinuation?: RuntimeContinuationStateV1 | undefined;
  requestReason?: string | undefined;
}): Transition {
  const guidance = buildModeBlockedWaitGuidance({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    requiredToolClass: input.requiredToolClass,
    ...(input.requestReason !== undefined ? { reason: input.requestReason } : {}),
  });
  const currentMode = formatModeLabel(input.interactionMode, input.actSubmode);
  const requiredMode = requiredModeForToolClass(input.requiredToolClass);
  const decisionReason = input.requestReason ?? `The selected ${describeBlockedActionKind(input.blockedActionKind)} requires ${requiredMode}, but the run is currently in ${currentMode}.`;
  const waitFor: UserWaitForMatcher = {
    kind: "user",
    eventType: "user.reply",
    metadata: {
      waitContractVersion: 1,
      reason: "planner_mode_blocked",
      blockedActionKind: input.blockedActionKind,
      ...(input.blockedActionId !== undefined ? { blockedActionId: input.blockedActionId } : {}),
      reasonCode: "mode_policy_blocked",
      requiredToolClass: input.requiredToolClass,
      currentMode,
      requiredMode,
      question: guidance.question,
      resumeReply: guidance.resumeReply,
      resumeCommand: guidance.resumeCommand,
      resumeHint: "Reply after switching to an execution mode that allows this action.",
      prompt: guidance.prompt,
      ...(input.activeContinuation !== undefined
        ? { continuationId: input.activeContinuation.id }
        : {}),
    },
  };
  const nextAction = {
    kind: "ask_user" as const,
    prompt: guidance.prompt,
    waitFor,
  };
  const commandBatch = buildReferenceReactCommandBatchFromAction({
    action: nextAction,
    stepIndex: input.stepIndex,
    toolExecutionClassByName: {},
    planningSummary: "Ask for a mode switch before continuing.",
  });
  return {
    status: "RUNNING",
    nextStepAgent: input.execDispatchStepId,
    statePatch: buildAgentLoopStatePatch({
      ...input.reactState,
      ...clearLegacyGoalPatch(),
      ...createReferenceReactNextActionPatch(nextAction),
      lastAction: nextAction,
      commandBatch: {
        ...commandBatch,
        status: "ready",
        sourceStepAgent: input.loopStepId,
        targetStepAgent: input.execDispatchStepId,
        createdAtStepIndex: input.stepIndex,
      },
      ...createReferenceReactRetryContextPatch(undefined),
      decisionReason,
      ...(input.activeContinuation !== undefined
        ? { activeContinuation: input.activeContinuation }
        : {}),
      lastDecisionAtStep: input.stepIndex,
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "agent.loop",
          decisionCode: "planner_mode_blocked",
          metadata: {
            blockedActionKind: input.blockedActionKind,
            blockedActionId: input.blockedActionId,
            requiredToolClass: input.requiredToolClass,
            interactionMode: input.interactionMode,
            actSubmode: input.actSubmode,
            prompt: guidance.prompt,
          },
        },
      ],
      phase: "PLAN",
    }),
    stateNode: {
      parent: "agent",
      child: "loop",
    },
  };
}

function toContinuationInvalidatedTransition(input: {
  stepIndex: number;
  loopStepId: string;
  execDispatchStepId: string;
  reactState: Record<string, unknown>;
  goal: string;
  reason: RuntimeContinuationInvalidationReason;
  activeContinuation?: RuntimeContinuationStateV1 | undefined;
}): Transition {
  const prompt = buildContinuationInvalidationPrompt(input.reason);
  const waitFor: UserWaitForMatcher = {
    kind: "user",
    eventType: "user.reply",
    metadata: {
      waitContractVersion: 1,
      reason: "continuation_invalidated",
      invalidationReason: input.reason,
      prompt,
    },
  };
  const nextAction = {
    kind: "ask_user" as const,
    prompt,
    waitFor,
  };
  const commandBatch = buildReferenceReactCommandBatchFromAction({
    action: nextAction,
    stepIndex: input.stepIndex,
    toolExecutionClassByName: {},
    planningSummary: "Explain why the saved build handoff can no longer resume automatically.",
  });
  return {
    status: "RUNNING",
    nextStepAgent: input.execDispatchStepId,
    statePatch: buildAgentLoopStatePatch({
      ...input.reactState,
      ...clearLegacyGoalPatch(),
      ...createReferenceReactNextActionPatch(nextAction),
      lastAction: nextAction,
      commandBatch: {
        ...commandBatch,
        status: "ready",
        sourceStepAgent: input.loopStepId,
        targetStepAgent: input.execDispatchStepId,
        createdAtStepIndex: input.stepIndex,
      },
      ...createReferenceReactRetryContextPatch(undefined),
      decisionReason: prompt,
      pendingContinuationOffer: undefined,
      ...(input.activeContinuation !== undefined
        ? { activeContinuation: invalidateRuntimeContinuation(input.activeContinuation, input.reason) }
        : {}),
      lastDecisionAtStep: input.stepIndex,
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "agent.loop",
          decisionCode: "continuation.invalidated",
          metadata: {
            reason: input.reason,
          },
        },
      ],
      phase: "PLAN",
    }),
    stateNode: {
      parent: "agent",
      child: "loop",
    },
  };
}

function buildContinuationInvalidationPrompt(
  reason: RuntimeContinuationInvalidationReason,
): string {
  if (reason === "missing_plan_document") {
    return "The saved build handoff can’t resume because the session PLAN.md is no longer available in runtime state. Reply if you want me to recreate the handoff from the current planning context.";
  }
  if (reason === "continuation_id_mismatch") {
    return "The saved build handoff no longer matches the active wait contract, so I can’t resume it safely. Reply if you want me to recreate the handoff from the current planning context.";
  }
  if (reason === "continuation_already_consumed") {
    return "The saved build handoff was already consumed or invalidated, so it can’t be resumed again. Reply if you want me to recreate the handoff from the current planning context.";
  }
  return "The saved build handoff is missing from runtime state, so I can’t resume it safely. Reply if you want me to recreate the handoff from the current planning context.";
}

function requiredModeForToolClass(toolClass: ToolExecutionClass): string {
  if (toolClass === "read_only" || toolClass === "planning_write") {
    return "Plan";
  }
  return "Build";
}

function describeBlockedActionKind(kind: string): string {
  if (kind === "continuation_offer") {
    return "continuation offer";
  }
  return `${kind.replace(/_/gu, " ")} action`;
}

function formatModeLabel(mode: InteractionMode, actSubmode: ActSubmode | undefined): string {
  return formatUserFacingModeLabel({ interactionMode: mode, actSubmode });
}

function cloneActionSnapshot<T>(action: T): T {
  return structuredClone(action);
}

function attachModelToolCallIdsToToolBatchAction(
  action: NonNullable<CompiledDecision["action"]>,
  modelToolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string | undefined }>,
): NonNullable<CompiledDecision["action"]> {
  if (action.kind !== "tool_batch" || modelToolCalls.length === 0) {
    return action;
  }
  const unusedToolCallIndexes = new Set(modelToolCalls.map((_, index) => index));
  const items = action.items.map((item, index) => {
    const indexedCall = modelToolCalls[index];
    let matchedIndex: number | undefined;
    if (indexedCall !== undefined && toolBatchItemMatchesModelToolCall(item, indexedCall)) {
      matchedIndex = index;
    } else {
      matchedIndex = [...unusedToolCallIndexes].find((candidateIndex) =>
        toolBatchItemMatchesModelToolCall(item, modelToolCalls[candidateIndex])
      );
    }
    if (matchedIndex === undefined) {
      return item;
    }
    unusedToolCallIndexes.delete(matchedIndex);
    const modelToolCall = modelToolCalls[matchedIndex];
    if (modelToolCall?.id === undefined) {
      return item;
    }
    return {
      ...item,
      toolCallId: modelToolCall.id,
    };
  });
  return {
    ...action,
    items,
  } as NonNullable<CompiledDecision["action"]>;
}

function toolBatchItemMatchesModelToolCall(
  item: { name: string; input: Record<string, unknown> },
  modelToolCall: { name: string; input: Record<string, unknown> } | undefined,
): boolean {
  return modelToolCall !== undefined &&
    item.name === modelToolCall.name &&
    JSON.stringify(item.input) === JSON.stringify(modelToolCall.input);
}

function appendActionToTranscript(input: {
  transcript: unknown;
  action: NonNullable<CompiledDecision["action"]>;
  modelToolCalls?: Array<{ name: string; input: Record<string, unknown>; id?: string | undefined }> | undefined;
  stepIndex: number;
}): ReturnType<typeof appendAssistantToolCallsToTranscript> {
  if (input.modelToolCalls !== undefined && input.modelToolCalls.length > 0) {
    return appendAssistantToolCallsToTranscript({
      transcript: input.transcript,
      stepIndex: input.stepIndex,
      toolCalls: input.modelToolCalls,
    });
  }
  if (input.action.kind === "tool") {
    return appendAssistantToolCallsToTranscript({
      transcript: input.transcript,
      stepIndex: input.stepIndex,
      toolCalls: [
        {
          name: input.action.name,
          input: input.action.input,
        },
      ],
    });
  }
  if (input.action.kind === "tool_batch") {
    return appendAssistantToolCallsToTranscript({
      transcript: input.transcript,
      stepIndex: input.stepIndex,
      toolCalls: input.action.items.map((item) => ({
        name: item.name,
        input: item.input,
      })),
    });
  }
  return appendAssistantToolCallsToTranscript({
    transcript: input.transcript,
    stepIndex: input.stepIndex,
    toolCalls: [
      {
        name: `kestrel.${input.action.kind}`,
        input: cloneActionSnapshot(input.action) as Record<string, unknown>,
      },
    ],
  });
}

function toAgentLoopValidationFeedbackTransition(input: {
  stepIndex: number;
  loopStepId: string;
  reactState: Record<string, unknown>;
  goal: string;
  error: {
    code: DecisionFailureCode;
    message: string;
    details?: Record<string, unknown> | undefined;
  };
  schemaCategory: string | undefined;
  previousResponse: unknown;
}): Transition {
  const existingRetry = asRecord(input.reactState.retryContext);
  const loopAttempt = typeof existingRetry?.loopAttempt === "number"
    ? existingRetry.loopAttempt + 1
    : 1;
  const maxLoopAttempts = 4;
  const exhausted = loopAttempt > maxLoopAttempts;
  const timestamp = new Date().toISOString();
  const feedbackError = exhausted
    ? {
        code: "AGENT_VALIDATION_RETRY_EXHAUSTED",
        message: `Agent validation failed ${loopAttempt} consecutive times; aborting the run.`,
        details: {
          originalCode: input.error.code,
          originalMessage: input.error.message,
          originalDetails: input.error.details ?? {},
          schemaCategory: input.schemaCategory,
          loopAttempt,
          maxLoopAttempts,
        },
        schemaCategory: input.schemaCategory,
      }
    : {
        code: input.error.code,
        message: input.error.message,
        details: input.error.details ?? {},
        schemaCategory: input.schemaCategory,
      };
  const validationObservation = {
    kind: "validation_feedback",
    status: "failed",
    errorCode: feedbackError.code,
    message: feedbackError.message,
    schemaCategory: input.schemaCategory,
    timestamp,
    ...(input.error.details !== undefined ? { details: input.error.details } : {}),
  };
  const feedbackMessage = buildKestrelAgentValidationFeedbackMessage({
    code: feedbackError.code,
    message: feedbackError.message,
    schemaCategory: input.schemaCategory,
    details: input.error.details,
    loopAttempt,
    maxLoopAttempts,
    exhausted,
  });
  const decisionReason = feedbackMessage;
  const structuredCorrection = stripModelVisibleCorrectionText(
    buildThinkerRequiredCorrection(input.error),
  );
  const retryContext = {
    loopAttempt,
    maxLoopAttempts,
    failure: {
      code: input.error.code,
      message: input.error.message,
      details: {
        ...(input.error.details ?? {}),
        modelFeedback: feedbackMessage,
      },
      schemaCategory: input.schemaCategory,
    },
    previousResponse: input.previousResponse,
    ...(structuredCorrection !== undefined ? { requiredCorrection: structuredCorrection } : {}),
  };
  const observations = [
    ...asArray(input.reactState.observations),
    validationObservation,
  ].slice(-50);
  const modelTranscript = appendCorrectionToTranscript({
    transcript: input.reactState.modelTranscript,
    message: feedbackMessage,
    stepIndex: input.stepIndex,
  });
  return {
    status: exhausted ? "FAILED" : "RUNNING",
    ...(exhausted ? {} : { nextStepAgent: input.loopStepId }),
    statePatch: buildAgentLoopStatePatch({
      ...input.reactState,
      ...createReferenceReactNextActionPatch(undefined),
      ...createReferenceReactRetryContextPatch(retryContext),
      decisionReason,
      modelTranscript,
      ...clearLegacyGoalPatch(),
      observations,
      ...createReferenceReactLastActionResultPatch({
        ok: false,
        kind: "validation_feedback",
        status: "failed",
        error: feedbackError,
        loopAttempt,
        maxLoopAttempts,
        timestamp,
      }),
      ...(exhausted
        ? {
            ...createReferenceReactTerminalPatch({
              status: "FAILED",
              reasonCode: "AGENT_VALIDATION_RETRY_EXHAUSTED",
              message: feedbackError.message,
            }),
          }
        : {}),
      decisionTrace: [
        {
          eventType: "decision.rejected",
          phase: "agent.loop",
          decisionCode: feedbackError.code,
          metadata: {
            message: feedbackError.message,
            loopAttempt,
            maxLoopAttempts,
            ...(input.error.details !== undefined ? { details: input.error.details } : {}),
          },
        },
      ],
      phase: "LOOP",
    }),
    stateNode: {
      parent: "agent",
      child: "loop",
    },
  };
}

function toRequiredToolCallMissingTransition(input: {
  stepIndex: number;
  reactState: Record<string, unknown>;
  response: ModelResponse<unknown>;
  actionToolCount: number;
}): Transition {
  const code = "MODEL_REQUIRED_TOOL_CALL_MISSING";
  const message = "The model did not return the required structured action.";
  const timestamp = new Date().toISOString();
  const details = {
    provider: input.response.provider.name,
    model: input.response.provider.model,
    phase: "agent.loop",
    actionToolCount: input.actionToolCount,
    textPresent: typeof input.response.text === "string" && input.response.text.trim().length > 0,
  };
  return {
    status: "FAILED",
    statePatch: buildAgentLoopStatePatch({
      ...input.reactState,
      ...createReferenceReactNextActionPatch(undefined),
      ...createReferenceReactRetryContextPatch(undefined),
      ...clearLegacyGoalPatch(),
      decisionReason: message,
      observations: [
        ...asArray(input.reactState.observations),
        {
          kind: "model_contract_failure",
          status: "failed",
          errorCode: code,
          message,
          details,
          timestamp,
        },
      ].slice(-50),
      ...createReferenceReactLastActionResultPatch({
        ok: false,
        kind: "model_contract_failure",
        status: "failed",
        error: { code, message, details },
        timestamp,
      }),
      ...createReferenceReactTerminalPatch({
        status: "FAILED",
        reasonCode: code,
        message,
      }),
      decisionTrace: [
        {
          eventType: "decision.rejected",
          phase: "agent.loop",
          decisionCode: code,
          metadata: details,
        },
      ],
      phase: "LOOP",
    }),
    stateNode: {
      parent: "agent",
      child: "loop",
    },
  };
}

function toDeliberatorContractFailureTransition(input: {
  stepIndex: number;
  reactState: Record<string, unknown>;
  error: {
    code: DecisionFailureCode;
    message: string;
    details?: Record<string, unknown> | undefined;
  };
  attemptCount: number;
  previousResponse: unknown;
}): Transition {
  const timestamp = new Date().toISOString();
  const schemaCategory = inferSchemaCategory(input.error.code, input.error.details);
  const message = `Model action contract remained invalid after ${input.attemptCount} attempts: ${input.error.message}`;
  const details = {
    ...(input.error.details ?? {}),
    attemptCount: input.attemptCount,
    schemaRetryLimit: DELIBERATOR_SCHEMA_RETRY_LIMIT,
  };
  return {
    status: "FAILED",
    statePatch: buildAgentLoopStatePatch({
      ...input.reactState,
      ...createReferenceReactNextActionPatch(undefined),
      ...createReferenceReactRetryContextPatch({
        failure: {
          code: input.error.code,
          message: input.error.message,
          details,
          schemaCategory,
        },
        previousResponse: input.previousResponse,
        attemptCount: input.attemptCount,
        exhausted: true,
      }),
      ...clearLegacyGoalPatch(),
      decisionReason: message,
      observations: [
        ...asArray(input.reactState.observations),
        {
          kind: "model_contract_failure",
          status: "failed",
          errorCode: input.error.code,
          message,
          schemaCategory,
          details,
          timestamp,
        },
      ].slice(-50),
      ...createReferenceReactLastActionResultPatch({
        ok: false,
        kind: "model_contract_failure",
        status: "failed",
        error: { code: input.error.code, message, details },
        timestamp,
      }),
      ...createReferenceReactTerminalPatch({
        status: "FAILED",
        reasonCode: input.error.code,
        message,
      }),
      decisionTrace: [
        {
          eventType: "decision.rejected",
          phase: "agent.loop",
          decisionCode: input.error.code,
          metadata: {
            message,
            schemaCategory,
            details,
          },
        },
      ],
      phase: "LOOP",
    }),
    stateNode: {
      parent: "agent",
      child: "loop",
    },
  };
}

function buildThinkerRetryContext(input: {
  attempt: number;
  maxAttempts: number;
  previousResponse: unknown;
  failure: {
    code: DecisionFailureCode;
    message: string;
    details?: Record<string, unknown> | undefined;
  };
  toolAvailability?: DeliberatorToolAvailability | undefined;
  executionIntent?: DecisionContextExecutionIntent | undefined;
  filesystemInventory?: FilesystemInventoryFact | undefined;
}): Record<string, unknown> {
  const failure = {
    code: input.failure.code,
    message: input.failure.message,
    details: input.failure.details ?? {},
  };
  const requiredCorrection = buildThinkerRequiredCorrection(
    input.failure,
    input.toolAvailability,
    input.executionIntent,
    input.filesystemInventory,
  );
  const structuredCorrection = stripModelVisibleCorrectionText(requiredCorrection);
  return {
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    previousResponse: input.previousResponse,
    failure,
    ...(structuredCorrection !== undefined ? { requiredCorrection: structuredCorrection } : {}),
  };
}

function buildDeliberatorRejectedResponse(response: ModelResponse<unknown>): Record<string, unknown> {
  return {
    ...(response.output !== undefined ? { output: response.output } : {}),
    toolCalls: response.toolIntents.map((intent) => ({
      name: intent.name,
      input: intent.input,
    })),
  };
}

function stripModelVisibleCorrectionText(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  const stripped = asRecord(stripCorrectionFields(record));
  if (stripped === undefined) {
    return ;
  }
  return Object.keys(stripped).length > 0 ? stripped : undefined;
}

function stripCorrectionFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripCorrectionFields);
  }
  const record = asRecord(value);
  if (record === undefined) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "correction") {
      continue;
    }
    output[key] = stripCorrectionFields(item);
  }
  return output;
}

function readDeliberatorRetryKind(error: {
  code: DecisionFailureCode;
  details?: Record<string, unknown> | undefined;
}): "schema" | "policy" | undefined {
  const details = asRecord(error.details);
  if (
    (error.code === "DECISION_SCHEMA_FAILED" || error.code === "DECISION_PARSE_FAILED") &&
    (
      asString(details?.path) === "nextAction" ||
      asString(details?.path) === "reason" ||
      asString(details?.path) === "version" ||
      asString(details?.path) === "nextAction.type" ||
      asString(details?.path) === "nextAction.kind" ||
      asString(details?.path) === "nextAction.status" ||
      asString(details?.path) === "nextAction.message" ||
      asString(details?.path) === "nextAction.continuation" ||
      asString(details?.path) === "nextAction.data" ||
      asString(details?.path) === "nextAction.executionRole" ||
      asString(details?.path) === "understanding" ||
      asString(details?.path) === "verification.verificationSteps" ||
      asString(details?.path) === "verification.expectedRepoDelta" ||
      (
        asString(details?.schemaCategory) === "tool_call" &&
        asString(details?.reason) === "invalid_assistant_progress"
      ) ||
      asString(details?.reason) === "invalid_deliberator_understanding" ||
      asString(details?.reason) === "forbidden_deliberator_field" ||
      asString(details?.reason) === "invalid_deliberator_output_object" ||
      asString(details?.reason) === "missing_model_tool_call"
    )
  ) {
    return "schema";
  }
  if (error.code !== "DECISION_POLICY_FAILED") {
    return ;
  }
  return readThinkerPolicyRetryDirective(error) !== undefined ? "policy" : undefined;
}

function readAssistantProgressRepairToolName(error: {
  code: DecisionFailureCode;
  details?: Record<string, unknown> | undefined;
}): string | undefined {
  const details = asRecord(error.details);
  return error.code === "DECISION_SCHEMA_FAILED" &&
    asString(details?.schemaCategory) === "tool_call" &&
    asString(details?.reason) === "invalid_assistant_progress"
    ? asString(details?.providerName)
    : undefined;
}

function readDeliberatorPolicyFailureReason(error: {
  code: DecisionFailureCode;
  message: string;
  details?: Record<string, unknown> | undefined;
}): string {
  const details = asRecord(error.details);
  return asString(details?.reason) ?? `${error.code}:${error.message}`;
}

function readDeliberatorPolicyFailureSignature(error: {
  code: DecisionFailureCode;
  message: string;
  details?: Record<string, unknown> | undefined;
}): string {
  const reason = readDeliberatorPolicyFailureReason(error);
  const details = asRecord(error.details);
  if (
    reason !== "command_role_mismatch"
  ) {
    return reason;
  }
  return [
    reason,
    asString(details?.actionKind),
    asString(details?.toolName),
    asString(details?.requiredArtifactTarget),
    asString(details?.requiredSourcePath),
    asString(details?.requiredCorrection),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("|");
}

function mapDeliberatorPreparationError(error: unknown): {
  code: DecisionFailureCode;
  message: string;
  details?: Record<string, unknown> | undefined;
} {
  const record = error as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  const code =
    record.code === "DECISION_SCHEMA_FAILED" ||
    record.code === "DECISION_PARSE_FAILED" ||
    record.code === "DECISION_POLICY_FAILED" ||
    record.code === "DECISION_MODEL_EMPTY_RESPONSE" ||
    record.code === "DECISION_CAPABILITY_EVIDENCE_REQUIRED"
      ? record.code
      : "DECISION_SCHEMA_FAILED";
  return {
    code,
    message: record.message,
    details: record.details,
  };
}

function buildThinkerRequiredCorrection(
  failure: {
    code: DecisionFailureCode;
    message: string;
    details?: Record<string, unknown> | undefined;
  },
  toolAvailability?: DeliberatorToolAvailability | undefined,
  executionIntent?: DecisionContextExecutionIntent | undefined,
  filesystemInventory?: FilesystemInventoryFact | undefined,
): Record<string, unknown> | undefined {
  const details = asRecord(failure.details);
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    asString(details?.schemaCategory) === "tool_call" &&
    asString(details?.reason) === "invalid_assistant_progress"
  ) {
    return {
      assistantProgressContract: {
        action: "repeat_rejected_tool_call_with_valid_assistant_progress",
        rejectedReason: "invalid_assistant_progress",
        rejectedToolCallIndex: details?.index,
        rejectedProviderToolName: details?.providerName,
        rejectedCanonicalToolName: details?.canonicalName,
        requiredField: "assistantProgress",
        minimumLength: 1,
        maximumLength: 600,
        requiredContent: "a concise user-facing description of the concrete work the tool is about to perform",
        requiredResponse: "the corrected structured tool call only",
      },
    };
  }
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    (
      asString(details?.path) === "understanding" ||
      asString(details?.reason) === "invalid_deliberator_understanding"
    )
  ) {
    return {
      deliberatorUnderstandingShape: {
        action: "emit_compact_understanding_object",
        rejectedPath: asString(details?.path),
        rejectedReason: asString(details?.reason),
        responseShape: asRecord(details?.responseShape),
        requiredFields: ["task", "facts", "currentGap", "actionBasis"],
        forbiddenShape: [
          "string",
          "missing fields",
          "empty fields",
          "extra top-level keys inside understanding",
        ],
        correction:
          "Emit understanding as an object with exactly task, facts, currentGap, and actionBasis. facts must be a non-empty array of strings. Do not use a string, omit fields, or add extra keys.",
      },
    };
  }
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    asString(details?.path) === "nextAction.continuation"
  ) {
    return {
      handoffToBuildShape: {
        action: "call_handoff_to_build_with_compact_continuation",
        rejectedPath: asString(details?.path),
        requiredShape: {
          tool: "kestrel_handoff_to_build",
          input: {
            message: "operator-facing handoff summary",
            continuation: {
              objective: "implementation objective",
              requiredToolClass: "read_only | sandboxed_only | external_side_effect",
              requiredCapabilities: ["capability.ids"],
              resumeMessage: "optional continuation prompt",
            },
          },
        },
        runtimeSupplied: ["version", "kind", "requiredMode", "sourceRunId"],
        correction:
          "Call kestrel_handoff_to_build with a user-facing message and a compact continuation containing objective, requiredToolClass, and requiredCapabilities. Do not include version, kind, requiredMode, or sourceRunId.",
      },
    };
  }
  const requiredAction = asString(details?.requiredAction);
  if (requiredAction === "write_session_plan_before_handoff") {
    return {
      planDocumentBeforeHandoff: {
        action: requiredAction,
        rejectedAction: "handoff_to_build",
        rejectedReason: asString(details?.reason),
        interactionMode: asString(details?.interactionMode),
        requiredTool: "planning.write_document",
        requiredModelTool: "planning_write_document",
        requiredOrder: [
          "call planning.write_document to create or update the current session PLAN.md",
          "wait for the planning.write_document tool result",
          "only then call kestrel_handoff_to_build",
        ],
        forbiddenActionUntilPlanExists: "kestrel_handoff_to_build",
        planDocumentRequired: true,
        activePlanPresent: false,
      },
    };
  }
  if (requiredAction === "write_session_plan_before_task_publication") {
    return {
      planDocumentBeforeTaskPublication: {
        action: requiredAction,
        rejectedAction: "task.propose",
        rejectedReason: asString(details?.reason),
        interactionMode: asString(details?.interactionMode),
        requiredTool: "planning.write_document",
        requiredModelTool: "planning_write_document",
        requiredOrder: [
          "call planning.write_document to create or update the current session PLAN.md",
          "wait for the planning.write_document tool result",
          "only then call task.propose",
        ],
        forbiddenActionUntilPlanExists: "task.propose",
        planDocumentRequired: true,
        activePlanPresent: false,
      },
    };
  }
  if (
    requiredAction === "call_finalize_with_user_facing_message" ||
    requiredAction === "call_handoff_to_build_with_compact_continuation" ||
    requiredAction === "include_plan_handoff" ||
    requiredAction === "choose_valid_build_mode_action" ||
    requiredAction === "choose_available_tool_or_concrete_blocker"
  ) {
    return {
      actionContract: {
        action: requiredAction,
        rejectedReason: asString(details?.reason),
        rejectedPath: asString(details?.path),
        actionKind: asString(details?.actionKind),
        interactionMode: asString(details?.interactionMode),
        reasonCode: asString(details?.reasonCode),
        availableToolHints: details?.availableToolHints,
        availableCandidateTools: details?.availableCandidateTools,
        knownCapabilityClasses: details?.knownCapabilityClasses,
      },
    };
  }
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    (
      asString(details?.path) === "nextAction.status" ||
      asString(details?.path) === "nextAction.message" ||
      asString(details?.path) === "nextAction.data"
    )
  ) {
    return {
      finalizeActionShape: {
        action: "call_finalize_with_user_facing_message",
        rejectedPath: asString(details?.path),
        requiredShape: {
          tool: "kestrel_finalize",
          input: {
            status: "goal_satisfied | out_of_scope",
            message: "user-facing closeout",
            data: "optional structured finalize data",
          },
        },
        correction:
          asString(details?.requiredCorrection) ??
          "Call kestrel_finalize with status and a user-facing message. Do not emit runtime-only finalizeReason or nested input.message.",
      },
    };
  }
  if (
    (failure.code === "DECISION_SCHEMA_FAILED" || failure.code === "DECISION_PARSE_FAILED") &&
    (
      asString(details?.path) === "nextAction" ||
      asString(details?.path) === "reason" ||
      asString(details?.path) === "version" ||
      asString(details?.path) === "nextAction.status" ||
      asString(details?.path) === "nextAction.message" ||
      asString(details?.path) === "nextAction.data" ||
      asString(details?.path) === "understanding" ||
      asString(details?.reason) === "invalid_deliberator_understanding" ||
      asString(details?.reason) === "forbidden_deliberator_field" ||
      asString(details?.reason) === "invalid_deliberator_output_object"
    )
  ) {
    return {
      deliberatorOutputShape: {
        action: "call_available_tool",
        requiredFields: ["native model tool call"],
        optionalFields: ["kestrel_todo_update before workspace work; include a final check-work todo for file or artifact changes"],
        forbiddenFields: ["JSON action envelope", "internal progress fields", "requiredCapabilities", "confidence", "verification", "executionRole"],
        rejectedPath: asString(details?.path),
        rejectedReason: asString(details?.reason),
        responseShape: asRecord(details?.responseShape),
        correction:
          "Call one or more available tools directly. Do not return a JSON action envelope.",
        completionContract:
          "Use workspace tools for work and Kestrel control tools to finish, ask, block, or hand off.",
        compactToolInput:
          "Keep tool input compact. If using a shell tool, use a short bounded command; do not embed heredocs, raw scripts, or multiline commands.",
      },
    };
  }
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    asString(details?.reason) === "invalid_visible_todos"
  ) {
    return {
      visibleTodosMetadataShape: {
        action: "emit_valid_visible_todos",
        rejectedPath: asString(details?.path),
        correction:
          "If using visibleTodos, emit a small checklist with objective and items containing id, text, and status only.",
      },
    };
  }
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    asString(details?.path) === "verification.browserEvidence"
  ) {
    return {
      browserEvidenceMetadataShape: {
        action: "omit_or_fix_optional_browser_evidence",
        rejectedPath: asString(details?.path),
        correction:
          "Omit verification.browserEvidence unless it is an array of objects with url, assertion, and evidenceType.",
      },
    };
  }
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    (
      asString(details?.path) === "verification.verificationSteps" ||
      asString(details?.path) === "verification.expectedRepoDelta"
    )
  ) {
    const rejectedPath = asString(details?.path);
    const expectationField = rejectedPath === "verification.expectedRepoDelta"
      ? "verification.expectedRepoDelta"
      : "verification.verificationSteps";
    return {
      evidenceExpectationSemanticValue: {
        action: "emit_non_empty_evidence_expectation_values",
        rejectedPath,
        semanticKind: asString(details?.semanticKind),
        rejectedValue: asString(details?.rejectedValue),
        expectationField,
        correction:
          rejectedPath === "verification.expectedRepoDelta"
            ? "Omit verification.expectedRepoDelta from model output; report changed files in the user-facing closeout when useful."
            : "Omit verification.verificationSteps from model output; report executed checks in the user-facing closeout when useful.",
      },
    };
  }
  if (
    asString(details?.reason) === "interactive_editor_exec_rejected" ||
    asString(details?.reason) === "interactive_interpreter_exec_rejected"
  ) {
    return {
      sourceAuthoringPolicy: {
        action: "write_or_repair_source_without_interactive_editor",
        rejectedToolName: asString(details?.toolName),
        command: asString(details?.command),
        executable: asString(details?.executable),
        correction:
          asString(details?.requiredCorrection) ??
          "write_source_with_typed_filesystem_tool",
      },
    };
  }
  if (asString(details?.reason) === "user_visible_text_not_operator_facing") {
    return {
      userVisibleTextContract: {
        action: "rewrite_operator_facing_text",
        field: asString(details?.field),
        rejectedPath: asString(details?.path),
        matchedText: asString(details?.matchedText),
        correction:
          asString(details?.correction) ??
          "Rewrite the user-visible field so it directly addresses the operator instead of narrating internal workflow.",
      },
    };
  }
  if (asString(details?.reason) === "low_yield_source_cluster_exhausted") {
    return {
      lowYieldSourceClusterExhausted: {
        action: "choose_allowed_recovery",
        objectiveKey: asString(details?.objectiveKey),
        sourceCluster: asString(details?.sourceCluster),
        observedStreak: details?.observedStreak,
        allowedRecoveryChoices: asArray(details?.allowedRecoveryChoices),
        correction:
          asString(details?.requiredCorrection) ??
          "Choose a different source cluster, use targeted search, or close out with a qualified partial result.",
      },
    };
  }
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    (asString(details?.path) === "nextAction.type" || asString(details?.path) === "nextAction.kind") &&
    readCanonicalToolNameFromActionShapeFailure(failure, toolAvailability) !== undefined
  ) {
    const canonicalToolName = readCanonicalToolNameFromActionShapeFailure(failure, toolAvailability);
    return {
      toolActionShapeMismatch: {
        action: "call_available_tool_directly",
        rejectedEffectType: asString(details?.actionId),
        canonicalToolName,
        allowedToolNames: toolAvailability?.allowedToolNames ?? [],
        correction: `Call the available tool '${canonicalToolName}' directly with its input object.`,
      },
    };
  }
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    (asString(details?.path) === "nextAction.type" || asString(details?.path) === "nextAction.kind")
  ) {
    return {
      toolActionShapeMismatch: {
        action: "call_available_tool_directly",
        rejectedEffectType: asString(details?.actionId),
        allowedToolNames: toolAvailability?.allowedToolNames ?? [],
        correction:
          "Call one available tool directly with its input object.",
      },
    };
  }
  if (
    failure.code === "DECISION_SCHEMA_FAILED" &&
    asString(details?.path) === "nextAction.executionRole"
  ) {
    return {
      toolExecutionRoleShapeMismatch: {
        action: "remove_execution_role",
        allowedToolNames: toolAvailability?.allowedToolNames ?? [],
        correction:
          "Remove executionRole. Command roles are internal runtime bookkeeping; call the chosen tool with only its documented input fields.",
      },
    };
  }
  if (asString(details?.reason) === "dev_process_stop_batch_rejected") {
    return {
      devShellStopBatchRejected: {
        action: "emit_single_stop_action",
        rejectedToolName: "dev.process.stop",
        correction: "Emit one stop action for the live process by itself, then observe the stopped process result before planning any read, exec, or artifact check.",
      },
    };
  }
  if (asString(details?.reason) === "dev_shell_unknown_process_id") {
    const liveProcessIds = asArray(details?.liveProcessIds)
      .map((item) => asString(item))
      .filter((item): item is string => item !== undefined);
    return {
      devShellUnknownProcessId: {
        action: "target_known_process_or_start_new_process",
        ...(asString(details?.toolName) !== undefined ? { rejectedToolName: asString(details?.toolName) } : {}),
        ...(asString(details?.processId) !== undefined ? { rejectedProcessId: asString(details?.processId) } : {}),
        knownProcessIds: asArray(details?.knownProcessIds)
          .map((item) => asString(item))
          .filter((item): item is string => item !== undefined),
        liveProcessIds,
        correction: liveProcessIds.length === 0
          ? "Do not invent process handles. No live process remains; use the available terminal command tool for new bounded work, or inspect or patch a controller file."
          : "Do not invent process handles. Use one of the listed live process/session ids, or start the needed live command with the available terminal command tool.",
      },
    };
  }
  if (asString(details?.reason) === "dev_shell_inactive_process_target") {
    const liveProcessIds = asArray(details?.liveProcessIds)
      .map((item) => asString(item))
      .filter((item): item is string => item !== undefined);
    return {
      devShellInactiveProcessTarget: {
        action: "target_live_process_or_start_new_process",
        ...(asString(details?.toolName) !== undefined ? { rejectedToolName: asString(details?.toolName) } : {}),
        ...(asString(details?.processId) !== undefined ? { rejectedProcessId: asString(details?.processId) } : {}),
        ...(asString(details?.status) !== undefined ? { status: asString(details?.status) } : {}),
        liveProcessIds,
        correction: liveProcessIds.length === 0
          ? "The chosen process is not live and cannot be stopped or written to. No live process remains; use the available terminal command tool for new bounded work, or inspect or patch a controller file."
          : "The chosen process is not live and cannot be stopped or written to. Use one of the listed live process/session ids or start the needed live command with the available terminal command tool.",
      },
    };
  }
  if (asString(details?.reason) === "live_dev_process_start_replay_requires_process_continuation") {
    const managedEntrypoints = inputContextManagedEntrypointsForRetry(toolAvailability);
    return {
      liveDevShellExecReplay: {
        action: managedEntrypoints ? "stop_live_process_or_run_bounded_controller" : "continue_live_process_by_process_id",
        rejectedToolName: "dev.process.start",
        ...(asString(details?.command) !== undefined ? { command: asString(details?.command) } : {}),
        ...(asString(details?.processId) !== undefined ? { processId: asString(details?.processId) } : {}),
        liveProcessIds: asArray(details?.liveProcessIds)
          .map((item) => asString(item))
          .filter((item): item is string => item !== undefined),
        correction: managedEntrypoints
          ? "A live managed process already exists. Do not start the same command again; stop it for cleanup, or run a bounded controller or checker after cleanup."
          : "Use the live process/session id to write, read, or stop instead of starting the same managed process again.",
      },
    };
  }
  if (
    asString(details?.reason) === "active_process_exec_multiline_rejected" ||
    asString(details?.reason) === "active_process_exec_literal_escaped_newline_rejected"
  ) {
    return {
      activeProcessExecInputRejected: {
        action: "stop_live_process_or_use_process_tools_or_file_tools",
        rejectedToolName: "dev.process.start",
        ...(asString(details?.activeProcessId) !== undefined ? { activeProcessId: asString(details?.activeProcessId) } : {}),
        liveProcessIds: asArray(details?.liveProcessIds)
          .map((item) => asString(item))
          .filter((item): item is string => item !== undefined),
        ...(asString(details?.commandPreview) !== undefined ? { commandPreview: asString(details?.commandPreview) } : {}),
        correction:
          asString(details?.requiredCorrection) ??
          "A live process is active. Do not start controller scripts or escaped newline text as a new command. Use the live process/session id, stop it, or create files with file tools.",
      },
    };
  }
  return ;
}

function isRecoverableToolActionShapeMismatch(
  error: {
    code: DecisionFailureCode;
    details?: Record<string, unknown> | undefined;
  },
  toolAvailability?: DeliberatorToolAvailability | undefined,
): boolean {
  return readCanonicalToolNameFromActionShapeFailure(error, toolAvailability) !== undefined;
}

function readCanonicalToolNameFromActionShapeFailure(
  error: {
    code: DecisionFailureCode;
    details?: Record<string, unknown> | undefined;
  },
  toolAvailability?: DeliberatorToolAvailability | undefined,
): string | undefined {
  if (error.code !== "DECISION_SCHEMA_FAILED") {
    return ;
  }
  const details = asRecord(error.details);
  if (asString(details?.path) !== "nextAction.type" && asString(details?.path) !== "nextAction.kind") {
    return ;
  }
  const actionId = asString(details?.actionId)?.trim();
  if (actionId === undefined || actionId.length === 0) {
    return ;
  }
  const allowed = toolAvailability?.allowedToolNames ?? [];
  if (allowed.includes(actionId)) {
    return actionId;
  }
  const withoutRequestPrefix = actionId.startsWith("request_") ? actionId.slice("request_".length) : undefined;
  if (withoutRequestPrefix !== undefined && allowed.includes(withoutRequestPrefix)) {
    return withoutRequestPrefix;
  }
  return ;
}

function inputContextManagedEntrypointsForRetry(
  toolAvailability: DeliberatorToolAvailability | undefined,
): boolean {
  return (toolAvailability?.hiddenTools ?? []).some((tool) =>
    tool.reason.includes("Managed-entrypoint artifact work")
  );
}

function readThinkerPolicyRetryDirective(error: {
  code: DecisionFailureCode;
  details?: Record<string, unknown> | undefined;
}): "dev_shell_retry" | undefined {
  const details = asRecord(error.details);
  if (
    (error.code === "DECISION_SCHEMA_FAILED" || error.code === "DECISION_PARSE_FAILED") &&
    (
      asString(details?.path) === "nextAction" ||
      asString(details?.path) === "reason" ||
      asString(details?.path) === "version" ||
      asString(details?.reason) === "forbidden_deliberator_field" ||
      asString(details?.reason) === "invalid_deliberator_output_object"
    )
  ) {
    return "dev_shell_retry";
  }
  if (
    error.code === "DECISION_SCHEMA_FAILED" &&
    (asString(details?.path) === "nextAction.type" || asString(details?.path) === "nextAction.kind")
  ) {
    return "dev_shell_retry";
  }
  if (
    error.code === "DECISION_SCHEMA_FAILED" &&
    asString(details?.path) === "nextAction.executionRole"
  ) {
    return "dev_shell_retry";
  }
  if (
    error.code === "DECISION_SCHEMA_FAILED" &&
    (
      asString(details?.path) === "nextAction.status" ||
      asString(details?.path) === "nextAction.message" ||
      asString(details?.path) === "nextAction.data"
    )
  ) {
    return "dev_shell_retry";
  }
  if (error.code !== "DECISION_POLICY_FAILED") {
    return ;
  }
  const reason = asString(details?.reason);
  if (reason === "work_item_action_mismatch") {
    return "dev_shell_retry";
  }
  return isLiveDevShellExecReplayReason(reason) ||
    reason === "active_process_exec_multiline_rejected" ||
    reason === "active_process_exec_literal_escaped_newline_rejected" ||
    reason === "dev_process_stop_batch_rejected" ||
    reason === "interactive_editor_exec_rejected" ||
    reason === "interactive_interpreter_exec_rejected" ||
    reason === "user_visible_text_not_operator_facing" ||
    reason === "low_yield_source_cluster_exhausted" ||
    reason === "dev_shell_unknown_process_id" ||
    reason === "dev_shell_inactive_process_target" ||
    reason === "command_role_work_item_mismatch"
    ? "dev_shell_retry"
    : undefined;
}

function isLiveDevShellExecReplayReason(reason: string | undefined): boolean {
  return reason === "live_dev_process_start_replay_requires_process_continuation";
}

function extractObservedCapabilitiesFromFeedback(reactState: Record<string, unknown>): string[] {
  const capabilities = new Set<string>();
  const add = (value: unknown) => {
    for (const capability of asArray(value)) {
      if (typeof capability !== "string") {
        continue;
      }
      const normalized = capability.trim();
      if (normalized.length > 0) {
        capabilities.add(normalized);
      }
    }
  };
  for (const observation of asArray(reactState.observations)) {
    add(asRecord(observation)?.capabilityClasses);
  }
  const lastActionResult = asRecord(reactState.lastActionResult);
  add(lastActionResult?.capabilityClasses);
  for (const item of asArray(lastActionResult?.items)) {
    add(asRecord(item)?.capabilityClasses);
  }
  return [...capabilities];
}

function mapDecisionCodeToSchemaCategory(
  code: DecisionFailureCode,
): "schema" | "parse" | "canonicalize" | "policy" | "capability" | "evidence" {
  if (code === "DECISION_SCHEMA_FAILED") {
    return "schema";
  }
  if (code === "DECISION_PARSE_FAILED") {
    return "parse";
  }
  if (code === "DECISION_POLICY_FAILED") {
    return "policy";
  }
  if (code === "DECISION_CAPABILITY_EVIDENCE_REQUIRED") {
    return "evidence";
  }
  if (code === "DECISION_MODEL_EMPTY_RESPONSE") {
    return "capability";
  }
  return "capability";
}

function inferSchemaCategory(
  code: DecisionFailureCode,
  details: Record<string, unknown> | undefined,
): "schema" | "parse" | "canonicalize" | "policy" | "capability" | "evidence" {
  const category = asString(asRecord(details)?.category);
  if (
    category === "schema" ||
    category === "parse" ||
    category === "canonicalize" ||
    category === "policy" ||
    category === "capability" ||
    category === "evidence"
  ) {
    return category;
  }
  return mapDecisionCodeToSchemaCategory(code);
}

function createDecisionError(
  code: DecisionFailureCode,
  message: string,
  details?: Record<string, unknown> | undefined,
): Error {
  const error = new Error(message) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}
