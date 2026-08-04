import type {
  DecisionContextExecutionIntent,
  ReactAction,
  ToolCapabilityManifestItem,
} from "../types.js";
import {
  isToolEligibleForInteractionMode,
  readBlockedApprovalCapability,
  type ExecutionPolicyOverride,
  type InteractionMode,
} from "../../../../src/mode/contracts.js";
import type { ModelToolSpec } from "../../../../src/kestrel/contracts/model-io.js";
import { findUserVisibleTextViolation } from "../userVisibleTextPolicy.js";
import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
import type {
  WorkspaceFreshnessEvidenceRef,
  WorkspaceFreshnessSummary,
} from "../../../../src/runtime/workspaceFreshness.js";
import {
  analyzeVisibleTodosCompletion,
  type VisibleTodoState,
} from "../../../../src/runtime/visibleTodos.js";
import { readKeepRunningSessionIds } from "../finalizationPolicy.js";

export interface GoalSatisfiedCloseoutReadiness {
  ready: boolean;
  explicitAllDoneChecklist: boolean;
  missingCapabilityEvidence: string[];
  hasExecutionEvidence: boolean;
  workspaceFreshness: WorkspaceFreshnessSummary;
  activeExecCommandSessions: WorkspaceFreshnessEvidenceRef[];
  hasPendingExecutionBoundary: boolean;
}

export function assessGoalSatisfiedCloseoutReadiness(input: {
  interactionMode?: InteractionMode | undefined;
  visibleTodos?: VisibleTodoState | undefined;
  requiredCapabilities: string[];
  observedCapabilities: string[];
  hasExecutionEvidence: boolean;
  workspaceFreshness: WorkspaceFreshnessSummary;
  activeExecCommandSessions: WorkspaceFreshnessEvidenceRef[];
  hasPendingExecutionBoundary?: boolean | undefined;
}): GoalSatisfiedCloseoutReadiness {
  const observedCapabilities = new Set(
    input.observedCapabilities.map((capability) => normalizeCapabilityToken(capability)),
  );
  const missingCapabilityEvidence = input.requiredCapabilities.filter(
    (capability) => observedCapabilities.has(normalizeCapabilityToken(capability)) === false,
  );
  const explicitAllDoneChecklist =
    input.visibleTodos !== undefined &&
    input.visibleTodos.items.length > 0 &&
    analyzeVisibleTodosCompletion(input.visibleTodos).openItems.length === 0;
  const hasPendingExecutionBoundary = input.hasPendingExecutionBoundary === true;
  const workspaceValidationReady =
    input.workspaceFreshness.status === "not_applicable" ||
    input.workspaceFreshness.status === "fresh";
  return {
    ready:
      input.interactionMode === "build" &&
      explicitAllDoneChecklist &&
      missingCapabilityEvidence.length === 0 &&
      input.hasExecutionEvidence &&
      workspaceValidationReady &&
      input.activeExecCommandSessions.length === 0 &&
      hasPendingExecutionBoundary === false,
    explicitAllDoneChecklist,
    missingCapabilityEvidence,
    hasExecutionEvidence: input.hasExecutionEvidence,
    workspaceFreshness: input.workspaceFreshness,
    activeExecCommandSessions: input.activeExecCommandSessions,
    hasPendingExecutionBoundary,
  };
}

export interface DecisionPolicyContext {
  phase: "deliberator";
  action: ReactAction;
  requiredCapabilities: string[];
  observedCapabilities: string[];
  hasExecutionEvidence?: boolean | undefined;
  workspaceFreshness?: WorkspaceFreshnessSummary | undefined;
  activeExecCommandSessions?: WorkspaceFreshnessEvidenceRef[] | undefined;
  hasOpenVisibleTodos?: boolean | undefined;
  capabilityManifest: ToolCapabilityManifestItem[];
  availableTools?: ModelToolSpec[] | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  executionIntent?: DecisionContextExecutionIntent | undefined;
  interactionMode?: InteractionMode | undefined;
  goalSatisfiedCloseoutReadiness?: GoalSatisfiedCloseoutReadiness | undefined;
}

export function validateDecisionPolicy(context: DecisionPolicyContext): string[] {
  const checksPassed: string[] = [];

  checksPassed.push("phase_action_allowed");

  if (
    context.phase === "deliberator" &&
    context.action.kind === "finalize" &&
    context.action.finalizeReason === "tool_unavailable"
  ) {
    throw decisionPolicyError(
      "Agent loop cannot finalize with finalizeReason='tool_unavailable'. Emit cannot_satisfy for unavailable tools/capabilities, or choose tool/tool_batch when an executable recovery is available.",
    );
  }
  if (
    context.phase === "deliberator" &&
    context.action.kind === "finalize" &&
    context.action.finalizeReason === "policy_blocked"
  ) {
    throw decisionPolicyError(
      "Agent loop cannot finalize with finalizeReason='policy_blocked'. Use out_of_scope for a user-request mismatch, cannot_satisfy for concrete unavailable capabilities, ask_user for a concrete decision, or choose tool/tool_batch when work is possible.",
      "DECISION_POLICY_FAILED",
      {
        finalizeReason: context.action.finalizeReason,
        requiredAction: "choose_valid_deliberator_action",
      },
    );
  }

  validateExecutionIntentPolicy(context);

  if (context.action.kind === "finalize") {
    validateFinalizeActionPolicy(context);
    validateKeepRunningSessionPolicy(context);
    validateBuildModeGoalSatisfiedEvidence(context);
    checksPassed.push("finalize_semantics_valid");
  }
  if (context.action.kind === "handoff_to_build") {
    validateHandoffToBuildActionPolicy(context.action);
    checksPassed.push("handoff_semantics_valid");
  }
  if (context.action.kind === "ask_user") {
    validateAskUserActionPolicy(context.action);
    checksPassed.push("ask_user_prompt_valid");
  }
  if (context.action.kind === "request_mode_switch") {
    validateModeSwitchRequestPolicy(context);
    checksPassed.push("mode_switch_request_valid");
  }
  if (context.action.kind === "cannot_satisfy") {
    validateCannotSatisfyUserVisibleMessage(context.action);
    validateCannotSatisfyActionPolicy(
      context.action,
      context.requiredCapabilities,
      context.capabilityManifest,
      context.availableTools ?? [],
      context.executionIntent,
      context.interactionMode,
      context.executionPolicy,
    );
    checksPassed.push("cannot_satisfy_capability_consistency");
  }

  validateActionToolsExist(context.action, context.capabilityManifest);
  if (context.action.kind === "tool" || context.action.kind === "tool_batch") {
    checksPassed.push("tool_allowlist_valid");
  }
  return checksPassed;
}

function validateModeSwitchRequestPolicy(context: DecisionPolicyContext): void {
  if (context.action.kind !== "request_mode_switch") return;
  const requiredToolClass = context.action.requiredToolClass;
  const matchingManifestTools = context.capabilityManifest.filter(
    (tool) => tool.executionClass === requiredToolClass,
  );
  if (matchingManifestTools.length === 0) {
    throw decisionPolicyError(
      `No configured tool uses requiredToolClass='${requiredToolClass}'. Report the concrete missing capability instead.`,
      "DECISION_CAPABILITY_UNAVAILABLE",
      { requiredAction: "report_concrete_missing_capability" },
    );
  }
  const availableNames = new Set((context.availableTools ?? []).map((tool) => tool.name));
  if (matchingManifestTools.some((tool) => availableNames.has(tool.name))) {
    throw decisionPolicyError(
      `requiredToolClass='${requiredToolClass}' is already available in the current tool surface. Use the available tool.`,
      "DECISION_POLICY_FAILED",
      { requiredAction: "choose_available_tool" },
    );
  }
  const modeHiddenTools = matchingManifestTools.filter((tool) =>
    isToolEligibleForInteractionMode({
      interactionMode: context.interactionMode ?? "chat",
      toolClass: requiredToolClass,
      allowedInteractionModes: tool.allowedInteractionModes,
      requiredCapabilities: tool.approvalCapabilities,
    }) === false
  );
  if (modeHiddenTools.length === 0) {
    throw decisionPolicyError(
      `requiredToolClass='${requiredToolClass}' is permitted by the current mode but unavailable from the model tool surface. Request the relevant policy or capability change.`,
      "DECISION_CAPABILITY_UNAVAILABLE",
      { requiredAction: "request_policy_or_approval_change" },
    );
  }
  const allModeHiddenToolsPolicyBlocked = modeHiddenTools.every((tool) =>
    context.executionPolicy?.toolClassPolicy?.[requiredToolClass] === false ||
    readBlockedApprovalCapability({
      executionPolicy: context.executionPolicy,
      requiredCapabilities: tool.approvalCapabilities,
    }) !== undefined
  );
  if (allModeHiddenToolsPolicyBlocked) {
    throw decisionPolicyError(
      `requiredToolClass='${requiredToolClass}' is blocked by execution policy. Request the required policy or approval change instead of a mode switch.`,
      "DECISION_CAPABILITY_UNAVAILABLE",
      { requiredAction: "request_policy_or_approval_change" },
    );
  }
}

function validateBuildModeGoalSatisfiedEvidence(context: DecisionPolicyContext): void {
  if (
    context.interactionMode !== "build" ||
    context.action.kind !== "finalize" ||
    context.action.finalizeReason !== "goal_satisfied"
  ) {
    return;
  }

  const readiness = context.goalSatisfiedCloseoutReadiness;
  const activeSessions =
    readiness?.activeExecCommandSessions ??
    context.activeExecCommandSessions ??
    [];
  const keepRunningSessionIds = readKeepRunningSessionIds(context.action);
  const keepRunningSessionIdSet = new Set(keepRunningSessionIds);
  const undeclaredActiveSessions = activeSessions.filter(
    (item) => item.processId === undefined || keepRunningSessionIdSet.has(item.processId) === false,
  );
  if (undeclaredActiveSessions.length > 0) {
    const sessionIds = undeclaredActiveSessions
      .map((item) => item.processId)
      .filter((item): item is string => Boolean(item));
    const recovery = sessionIds.map((sessionId) =>
      `Call exec_command with {"sessionId":"${sessionId}","assistantProgress":"I am checking the running process."} and no command to collect its current or final result; repeat if it returns running, or use {"sessionId":"${sessionId}","stop":true,"assistantProgress":"I am stopping the unneeded process."} if the process is no longer needed.`
    ).join(" ");
    throw decisionPolicyError(
      `Build mode cannot finalize goal_satisfied while an undeclared exec_command process is still running. ${recovery} If a listed process is intentionally part of the requested completed result, call kestrel_finalize with its exact active sessionId in data.keepRunningSessionIds and state in the user-facing message that it remains running.`,
      "DECISION_POLICY_FAILED",
      {
        reason: "build_goal_satisfied_with_live_exec_command",
        sessionIds,
        requiredAction: "settle_live_exec_command",
      },
    );
  }

  const freshness = readiness?.workspaceFreshness ?? context.workspaceFreshness;
  if (freshness?.status === "stale") {
    throw decisionPolicyError(
      "Build mode cannot finalize goal_satisfied because the latest workspace mutation has no later current-state validation evidence.",
      "DECISION_POLICY_FAILED",
      {
        reason: "build_goal_satisfied_with_stale_workspace",
        latestMutationEvidenceId: freshness.latestMutation?.evidenceId,
        latestMutationStepIndex: freshness.latestMutation?.stepIndex,
        changedFiles: freshness.latestMutation?.changedFiles,
        requiredAction: "run_current_state_validation_after_latest_mutation",
      },
    );
  }
  if (
    freshness?.status === "attempted_unresolved" &&
    (context.hasOpenVisibleTodos === true || hasExplicitResidualWarning(context.action) === false)
  ) {
    throw decisionPolicyError(
      "Build mode can finalize with unresolved validation only when no actionable todo remains and finalize data.openGap or data.knownWarnings explicitly reports the unverified result.",
      "DECISION_POLICY_FAILED",
      {
        reason: "build_goal_satisfied_with_unreported_unresolved_validation",
        unresolvedEvidenceIds: freshness.unresolvedEvidence?.map((item) => item.evidenceId),
        hasOpenVisibleTodos: context.hasOpenVisibleTodos === true,
        requiredAction: "resolve_validation_or_report_explicit_residual_warning",
      },
    );
  }

  if (
    readiness?.hasExecutionEvidence === true ||
    context.hasExecutionEvidence === true ||
    context.observedCapabilities.length > 0
  ) {
    return;
  }

  throw decisionPolicyError(
    "Build mode cannot finalize goal_satisfied before producing or observing execution evidence.",
    "DECISION_POLICY_FAILED",
    {
      reason: "build_goal_satisfied_without_evidence",
      interactionMode: context.interactionMode,
      requiredAction: "choose_valid_build_mode_action",
    },
  );
}

function hasExplicitResidualWarning(action: ReactAction): boolean {
  if (action.kind !== "finalize") {
    return false;
  }
  const data = asRecord(asRecord(action.input)?.data);
  const openGap = data?.openGap;
  if ((asString(openGap)?.trim().length ?? 0) > 0) {
    return true;
  }
  if (asRecord(openGap) !== undefined && Object.keys(asRecord(openGap) ?? {}).length > 0) {
    return true;
  }
  const warnings = data?.knownWarnings;
  return (asString(warnings)?.trim().length ?? 0) > 0 || asArray(warnings).length > 0;
}

function validateAskUserActionPolicy(
  action: Extract<ReactAction, { kind: "ask_user" }>,
): void {
  const violation = findUserVisibleTextViolation({
    field: "ask_user.prompt",
    text: action.prompt,
  });
  if (violation === undefined) {
    return;
  }
  throw decisionPolicyError(
    violation.message,
    "DECISION_POLICY_FAILED",
    violation.details,
  );
}

function validateCannotSatisfyUserVisibleMessage(
  action: Extract<ReactAction, { kind: "cannot_satisfy" }>,
): void {
  const violation = findUserVisibleTextViolation({
    field: "cannot_satisfy.message",
    text: action.message,
  });
  if (violation === undefined) {
    return;
  }
  throw decisionPolicyError(
    violation.message,
    "DECISION_POLICY_FAILED",
    violation.details,
  );
}

function validateExecutionIntentPolicy(context: DecisionPolicyContext): void {
  if (context.phase !== "deliberator" || context.executionIntent === undefined) {
    return;
  }

  const requiredFromExecutionIntent = context.requiredCapabilities;

  if (context.action.kind === "handoff_to_build") {
    return;
  }

  if (context.action.kind === "finalize") {
    const observed = new Set(context.observedCapabilities.map((capability) => normalizeCapabilityToken(capability)));
    const requiredForFinalize =
      requiredFromExecutionIntent.length > 0
        ? requiredFromExecutionIntent
        : context.requiredCapabilities;
    const unresolved = requiredForFinalize.filter(
      (capability) => observed.has(normalizeCapabilityToken(capability)) === false,
    );
    if (unresolved.length > 0) {
      if (
        (context.action.kind === "finalize" &&
          context.action.finalizeReason === "out_of_scope") &&
        hasStructuredSupportEvidence(context.action.kind === "finalize" ? context.action.supportEvidence : undefined) &&
        requiredFromExecutionIntent.length > 0
      ) {
        return;
      }
      throw decisionPolicyError(
        "Deliberator cannot finalize while extracted tool intent still lacks evidence.",
        context.action.kind === "finalize" && context.action.finalizeReason === "goal_satisfied"
          ? "DECISION_POLICY_FAILED"
          : "DECISION_CAPABILITY_EVIDENCE_REQUIRED",
        {
          eventType: "planner.finalize_blocked",
          toolIntentObjective: context.executionIntent.objective,
          candidateTools: context.executionIntent.candidateTools,
          finalizeReason: context.action.finalizeReason,
          missingEvidenceFor: unresolved,
        },
      );
    }
  }
}

function validateKeepRunningSessionPolicy(context: DecisionPolicyContext): void {
  const keepRunningSessionIds = readKeepRunningSessionIds(context.action);
  if (keepRunningSessionIds.length === 0) {
    return;
  }
  const activeSessionIds = (context.activeExecCommandSessions ?? [])
    .map((item) => item.processId)
    .filter((item): item is string => Boolean(item));
  const activeSessionIdSet = new Set(activeSessionIds);
  const invalidKeepRunningSessionIds = keepRunningSessionIds.filter(
    (sessionId) => activeSessionIdSet.has(sessionId) === false,
  );
  if (invalidKeepRunningSessionIds.length === 0) {
    return;
  }
  throw decisionPolicyError(
    "Cannot retain an exec_command session that is not currently running.",
    "DECISION_POLICY_FAILED",
    {
      reason: "keep_running_session_not_active",
      invalidSessionIds: invalidKeepRunningSessionIds,
      activeSessionIds,
      requiredAction: "use_active_session_ids_or_remove_keep_running_declaration",
    },
  );
}

function hasStructuredSupportEvidence(value: unknown): boolean {
  const record = asRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function validateFinalizeActionPolicy(context: DecisionPolicyContext): void {
  const action = context.action as Extract<ReactAction, { kind: "finalize" }>;
  if (
    action.finalizeReason !== "goal_satisfied" &&
    action.finalizeReason !== "tool_unavailable" &&
    action.finalizeReason !== "policy_blocked" &&
    action.finalizeReason !== "out_of_scope"
  ) {
    throw decisionPolicyError(
      "Finalize action must include a valid finalizeReason.",
      "DECISION_POLICY_FAILED",
    );
  }

  if (action.finalizeReason !== "tool_unavailable") {
    return;
  }

  const supportEvidence = asRecord(action.supportEvidence);
  if (supportEvidence === undefined || Object.keys(supportEvidence).length === 0) {
    throw decisionPolicyError(
      "Finalize reason 'tool_unavailable' requires structured supportEvidence.",
      "DECISION_CAPABILITY_EVIDENCE_REQUIRED",
      {
        required: "supportEvidence",
      },
    );
  }
}

function validateHandoffToBuildActionPolicy(
  action: Extract<ReactAction, { kind: "handoff_to_build" }>,
): void {
  const violation = findUserVisibleTextViolation({
    field: "handoff_to_build.message",
    text: action.message,
  });
  if (violation === undefined) {
    return;
  }
  throw decisionPolicyError(
    violation.message,
    "DECISION_POLICY_FAILED",
    violation.details,
  );
}

function validateActionToolsExist(
  action: ReactAction,
  capabilityManifest: ToolCapabilityManifestItem[],
): void {
  const known = new Set(capabilityManifest.map((tool) => tool.name));

  if (action.kind === "tool") {
    if (known.has(action.name) === false) {
      throw decisionPolicyError(`Tool '${action.name}' is not in capability manifest.`);
    }
    return;
  }

  if (action.kind === "tool_batch") {
    for (const item of action.items) {
      if (known.has(item.name) === false) {
        throw decisionPolicyError(`Tool '${item.name}' is not in capability manifest.`);
      }
    }
  }
}

function validateCannotSatisfyActionPolicy(
  action: Extract<ReactAction, { kind: "cannot_satisfy" }>,
  requiredCapabilities: string[],
  capabilityManifest: ToolCapabilityManifestItem[],
  availableTools: ModelToolSpec[],
  executionIntent?: DecisionContextExecutionIntent | undefined,
  interactionMode?: InteractionMode | undefined,
  executionPolicy?: ExecutionPolicyOverride | undefined,
): void {
  const missingRequiredCapabilities = computeMissingRequiredCapabilities(
    requiredCapabilities,
    capabilityManifest,
  );
  const availableToolNames = new Set(availableTools.map((tool) => tool.name));
  const availableCapabilityManifest = capabilityManifest.filter((tool) =>
    availableToolNames.has(tool.name)
  );
  const currentlyUnavailableCapabilities = computeMissingRequiredCapabilities(
    requiredCapabilities,
    availableCapabilityManifest,
  );
  const availableExecutionToolHints = collectAvailableExecutionToolHints(availableCapabilityManifest);
  const knownToolNames = new Set(capabilityManifest.map((tool) => normalizeCapabilityToken(tool.name)));
  const availableToolNamesNormalized = new Set(
    availableTools.map((tool) => normalizeCapabilityToken(tool.name)),
  );
  const hiddenCandidateTools = Array.from(
    new Set(
      (executionIntent?.candidateTools ?? [])
        .map((toolName) => normalizeCapabilityToken(toolName))
        .filter((toolName) =>
          toolName.length > 0 &&
          knownToolNames.has(toolName) &&
          availableToolNamesNormalized.has(toolName) === false
        ),
    ),
  );
  const availableCandidateTools = Array.from(
    new Set(
      (executionIntent?.candidateTools ?? [])
        .map((toolName) => normalizeCapabilityToken(toolName))
        .filter((toolName) => toolName.length > 0 && availableToolNamesNormalized.has(toolName)),
    ),
  );

  if (action.reasonCode === "insufficient_horizon" && interactionMode === "build") {
    throw decisionPolicyError(
      "cannot_satisfy reasonCode='insufficient_horizon' is invalid in build mode. Continue with an available tool action, ask the user for a concrete decision, or report a concrete external blocker such as an unavailable capability/tool.",
      "DECISION_POLICY_FAILED",
      {
        reasonCode: action.reasonCode,
        interactionMode,
        requiredAction: "choose_available_tool_or_concrete_blocker",
        availableToolHints: availableExecutionToolHints,
      },
    );
  }

  if (action.reasonCode === "need_user_choice" && interactionMode === "build") {
    throw decisionPolicyError(
      "cannot_satisfy reasonCode='need_user_choice' is invalid in build mode. Ask the user for the concrete decision instead.",
      "DECISION_POLICY_FAILED",
      {
        reasonCode: action.reasonCode,
        interactionMode,
        requiredAction: "ask_user_for_concrete_decision",
      },
    );
  }

  if (action.reasonCode === "missing_required_capability") {
    if (missingRequiredCapabilities.length > 0) {
      return;
    }
    if (currentlyUnavailableCapabilities.length > 0) {
      throw decisionPolicyError(
        "The required capability is configured but unavailable in the current tool surface. Request the required mode instead of reporting it absent.",
        "DECISION_CAPABILITY_UNAVAILABLE",
        {
          reasonCode: action.reasonCode,
          requiredCapabilities,
          currentlyUnavailableCapabilities,
          availableToolHints: availableExecutionToolHints,
          requiredAction: policyBlocksCapabilities({
            capabilities: currentlyUnavailableCapabilities,
            capabilityManifest,
            executionPolicy,
          }) ? "request_policy_or_approval_change" : "request_mode_switch",
        },
      );
    }
    throw decisionPolicyError(
      "cannot_satisfy reasonCode='missing_required_capability' is invalid when all requiredCapabilities exist in capabilityManifest.",
      "DECISION_CAPABILITY_UNAVAILABLE",
      {
        reasonCode: action.reasonCode,
        requiredCapabilities,
        missingRequiredCapabilities,
        knownCapabilityClasses: collectKnownCapabilityClasses(capabilityManifest),
        availableToolHints: availableExecutionToolHints,
        requiredAction: "choose_available_tool_or_concrete_blocker",
      },
    );
  }

  if (action.reasonCode === "unsatisfied_by_available_tools" && availableCandidateTools.length > 0) {
    throw decisionPolicyError(
      "cannot_satisfy reasonCode='unsatisfied_by_available_tools' is invalid when extracted candidate tools are available in capabilityManifest.",
      "DECISION_POLICY_FAILED",
      {
        reasonCode: action.reasonCode,
        availableCandidateTools,
        objective: executionIntent?.objective,
        availableToolHints: availableExecutionToolHints,
        requiredAction: "choose_available_tool_or_concrete_blocker",
      },
    );
  }
  if (action.reasonCode === "unsatisfied_by_available_tools" && hiddenCandidateTools.length > 0) {
    throw decisionPolicyError(
      "A candidate tool is configured but unavailable in the current tool surface. Request the required mode instead of reporting the task unsatisfiable.",
      "DECISION_CAPABILITY_UNAVAILABLE",
      {
        reasonCode: action.reasonCode,
        objective: executionIntent?.objective,
        availableToolHints: availableExecutionToolHints,
        requiredAction: policyBlocksAnyTools({
          toolNames: hiddenCandidateTools,
          capabilityManifest,
          executionPolicy,
        }) ? "request_policy_or_approval_change" : "request_mode_switch",
      },
    );
  }
  if (action.reasonCode === "unsatisfied_by_available_tools" && interactionMode === "build") {
    throw decisionPolicyError(
      "cannot_satisfy reasonCode='unsatisfied_by_available_tools' is invalid in build mode. Use missing_required_capability or requested_tool_unavailable with concrete evidence, choose an available tool, or ask the user.",
      "DECISION_POLICY_FAILED",
      {
        reasonCode: action.reasonCode,
        interactionMode,
        availableToolHints: availableExecutionToolHints,
        knownCapabilityClasses: collectKnownCapabilityClasses(capabilityManifest),
        requiredAction: "choose_available_tool_or_concrete_blocker",
      },
    );
  }
  if (action.reasonCode === "requested_tool_unavailable" && missingRequiredCapabilities.length === 0) {
    const requestedTool = typeof asRecord(action.details)?.requestedTool === "string"
      ? asRecord(action.details)?.requestedTool
      : undefined;
    if (
      typeof requestedTool === "string" &&
      requestedTool.trim().length > 0 &&
      knownToolNames.has(normalizeCapabilityToken(requestedTool)) === false
    ) {
      return;
    }
    if (
      typeof requestedTool === "string" &&
      requestedTool.trim().length > 0 &&
      availableToolNamesNormalized.has(normalizeCapabilityToken(requestedTool)) === false
    ) {
      const normalizedRequestedTool = normalizeCapabilityToken(requestedTool);
      throw decisionPolicyError(
        "The requested tool is configured but unavailable in the current tool surface.",
        "DECISION_CAPABILITY_UNAVAILABLE",
        {
          reasonCode: action.reasonCode,
          availableToolHints: availableExecutionToolHints,
          requiredAction: policyBlocksAnyTools({
            toolNames: [normalizedRequestedTool],
            capabilityManifest,
            executionPolicy,
          }) ? "request_policy_or_approval_change" : "request_mode_switch",
        },
      );
    }
    throw decisionPolicyError(
      "cannot_satisfy reasonCode='requested_tool_unavailable' is invalid when all requiredCapabilities exist in capabilityManifest.",
      "DECISION_CAPABILITY_UNAVAILABLE",
      {
        reasonCode: action.reasonCode,
        requiredCapabilities,
        missingRequiredCapabilities,
        knownCapabilityClasses: collectKnownCapabilityClasses(capabilityManifest),
        availableToolHints: availableExecutionToolHints,
        requiredAction: "choose_available_tool_or_concrete_blocker",
      },
    );
  }

  if (missingRequiredCapabilities.length > 0) {
    throw decisionPolicyError(
      "cannot_satisfy must use reasonCode='missing_required_capability' when requiredCapabilities are absent from capabilityManifest.",
      "DECISION_POLICY_FAILED",
      {
        reasonCode: action.reasonCode,
        missingRequiredCapabilities,
      },
    );
  }
}

export function computeMissingRequiredCapabilities(
  requiredCapabilities: string[],
  capabilityManifest: ToolCapabilityManifestItem[],
): string[] {
  const knownCapabilityClasses = new Set<string>();
  const toolNameToCapabilityClasses = new Map<string, string[]>();

  for (const tool of capabilityManifest) {
    const toolName = normalizeCapabilityToken(tool.name);
    const capabilityClasses: string[] = [];
    for (const capabilityClass of tool.capabilityClasses) {
      const normalizedCapabilityClass = normalizeCapabilityToken(capabilityClass);
      if (normalizedCapabilityClass.length > 0) {
        knownCapabilityClasses.add(normalizedCapabilityClass);
        capabilityClasses.push(normalizedCapabilityClass);
      }
    }
    if (toolName.length > 0 && capabilityClasses.length > 0) {
      toolNameToCapabilityClasses.set(toolName, capabilityClasses);
    }
  }

  const missing: string[] = [];
  for (const required of requiredCapabilities) {
    const normalizedRequired = normalizeCapabilityToken(required);
    if (normalizedRequired.length === 0) {
      continue;
    }
    if (knownCapabilityClasses.has(normalizedRequired)) {
      continue;
    }
    if (toolNameToCapabilityClasses.has(normalizedRequired)) {
      continue;
    }
    missing.push(required.trim());
  }

  return missing;
}

function collectKnownCapabilityClasses(
  capabilityManifest: ToolCapabilityManifestItem[],
): string[] {
  const classes = new Set<string>();
  for (const tool of capabilityManifest) {
    for (const capabilityClass of tool.capabilityClasses) {
      const normalized = normalizeCapabilityToken(capabilityClass);
      if (normalized.length > 0) {
        classes.add(normalized);
      }
    }
  }
  return [...classes].sort();
}

function policyBlocksAnyTools(input: {
  toolNames: string[];
  capabilityManifest: ToolCapabilityManifestItem[];
  executionPolicy?: ExecutionPolicyOverride | undefined;
}): boolean {
  const names = new Set(input.toolNames.map(normalizeCapabilityToken));
  return input.capabilityManifest.some((tool) => {
    if (names.has(normalizeCapabilityToken(tool.name)) === false) return false;
    const executionClass = tool.executionClass ?? "read_only";
    return input.executionPolicy?.toolClassPolicy?.[executionClass] === false ||
      readBlockedApprovalCapability({
        executionPolicy: input.executionPolicy,
        requiredCapabilities: tool.approvalCapabilities,
      }) !== undefined;
  });
}

function policyBlocksCapabilities(input: {
  capabilities: string[];
  capabilityManifest: ToolCapabilityManifestItem[];
  executionPolicy?: ExecutionPolicyOverride | undefined;
}): boolean {
  const required = new Set(input.capabilities.map(normalizeCapabilityToken));
  const matchingToolNames = input.capabilityManifest
    .filter((tool) =>
      required.has(normalizeCapabilityToken(tool.name)) ||
      tool.capabilityClasses.some((capability) => required.has(normalizeCapabilityToken(capability)))
    )
    .map((tool) => tool.name);
  return policyBlocksAnyTools({
    toolNames: matchingToolNames,
    capabilityManifest: input.capabilityManifest,
    executionPolicy: input.executionPolicy,
  });
}

function collectAvailableExecutionToolHints(
  capabilityManifest: ToolCapabilityManifestItem[],
): Array<{
  name: string;
  executionClass: NonNullable<ToolCapabilityManifestItem["executionClass"]>;
  capabilityClasses: string[];
}> {
  return capabilityManifest
    .filter((tool) => tool.executionClass === "sandboxed_only" || tool.executionClass === "external_side_effect")
    .map((tool) => ({
      name: tool.name,
      executionClass: tool.executionClass as NonNullable<ToolCapabilityManifestItem["executionClass"]>,
      capabilityClasses: [...tool.capabilityClasses].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 12);
}

function normalizeCapabilityToken(value: string): string {
  return value.trim().toLowerCase();
}

function decisionPolicyError(
  message: string,
  code:
    | "DECISION_POLICY_FAILED"
    | "DECISION_SCHEMA_FAILED"
    | "DECISION_CAPABILITY_UNAVAILABLE"
    | "DECISION_CAPABILITY_EVIDENCE_REQUIRED" = "DECISION_POLICY_FAILED",
  details?: Record<string, unknown>,
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
