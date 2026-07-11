import type {
  DecisionContextExecutionIntent,
  ReactAction,
  ToolCapabilityManifestItem,
} from "../types.js";
import type { InteractionMode } from "../../../../src/mode/contracts.js";
import { findUserVisibleTextViolation } from "../userVisibleTextPolicy.js";

export interface DecisionPolicyContext {
  phase: "deliberator";
  action: ReactAction;
  requiredCapabilities: string[];
  observedCapabilities: string[];
  hasExecutionEvidence?: boolean | undefined;
  capabilityManifest: ToolCapabilityManifestItem[];
  executionIntent?: DecisionContextExecutionIntent | undefined;
  interactionMode?: InteractionMode | undefined;
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
  if (context.action.kind === "cannot_satisfy") {
    validateCannotSatisfyUserVisibleMessage(context.action);
    validateCannotSatisfyActionPolicy(
      context.action,
      context.requiredCapabilities,
      context.capabilityManifest,
      context.executionIntent,
      context.interactionMode,
    );
    checksPassed.push("cannot_satisfy_capability_consistency");
  }

  validateActionToolsExist(context.action, context.capabilityManifest);
  if (context.action.kind === "tool" || context.action.kind === "tool_batch") {
    checksPassed.push("tool_allowlist_valid");
  }
  return checksPassed;
}

function validateBuildModeGoalSatisfiedEvidence(context: DecisionPolicyContext): void {
  if (
    context.interactionMode !== "build" ||
    context.action.kind !== "finalize" ||
    context.action.finalizeReason !== "goal_satisfied"
  ) {
    return;
  }

  if (context.hasExecutionEvidence === true || context.observedCapabilities.length > 0) {
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
  executionIntent?: DecisionContextExecutionIntent | undefined,
  interactionMode?: InteractionMode | undefined,
): void {
  const missingRequiredCapabilities = computeMissingRequiredCapabilities(
    requiredCapabilities,
    capabilityManifest,
  );
  const availableExecutionToolHints = collectAvailableExecutionToolHints(capabilityManifest);
  const knownToolNames = new Set(capabilityManifest.map((tool) => normalizeCapabilityToken(tool.name)));
  const availableCandidateTools = Array.from(
    new Set(
      (executionIntent?.candidateTools ?? [])
        .map((toolName) => normalizeCapabilityToken(toolName))
        .filter((toolName) => toolName.length > 0 && knownToolNames.has(toolName)),
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
