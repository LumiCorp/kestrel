import { sanitizeJsonValue, stringifySanitizedJson } from "../jsonSanitizer.js";

export interface KestrelAgentValidationFeedbackInput {
  code: string;
  message: string;
  schemaCategory?: string | undefined;
  details?: Record<string, unknown> | undefined;
  loopAttempt?: number | undefined;
  maxLoopAttempts?: number | undefined;
  exhausted?: boolean | undefined;
}

export function buildKestrelAgentValidationFeedbackMessage(
  input: KestrelAgentValidationFeedbackInput,
): string {
  const recoveryInstruction = retryInstructionForValidationFeedback(input);
  const requiredCorrection = readRequiredCorrection(input.details);
  const lines = [
    input.exhausted === true
      ? "Validation feedback exhausted the retry budget."
      : "The previous action was rejected by validation.",
    `- code: ${input.code}`,
    `- message: ${input.message}`,
    ...(input.schemaCategory !== undefined ? [`- schemaCategory: ${input.schemaCategory}`] : []),
    ...(requiredCorrection !== undefined ? [`- correction: ${requiredCorrection}`] : []),
    ...(input.loopAttempt !== undefined && input.maxLoopAttempts !== undefined
      ? [`- attempt: ${input.loopAttempt}/${input.maxLoopAttempts}`]
      : []),
    ...(recoveryInstruction !== undefined ? [`- nextAction: ${recoveryInstruction}`] : []),
  ];
  return lines.join("\n");
}

export function readCorrection(retryContext: Record<string, unknown> | undefined): string | undefined {
  const structuredCorrection = renderStructuredRetryCorrection(retryContext?.requiredCorrection);
  if (structuredCorrection !== undefined) {
    return structuredCorrection;
  }
  const failure = asRecord(retryContext?.failure);
  const fallbackCorrection = asString(asRecord(failure?.details)?.modelFeedback) ??
    asString(asRecord(failure?.details)?.correction) ??
    asString(failure?.message);
  if (fallbackCorrection === undefined) {
    return undefined;
  }
  const recoveryInstruction = retryInstructionForValidationFeedback({
    code: asString(failure?.code) ?? "",
    schemaCategory: asString(failure?.schemaCategory) ?? asString(asRecord(failure?.details)?.schemaCategory),
    details: asRecord(failure?.details),
  });
  if (recoveryInstruction === undefined || fallbackCorrection.includes(recoveryInstruction)) {
    return fallbackCorrection;
  }
  return `${fallbackCorrection}\n- nextAction: ${recoveryInstruction}`;
}

function retryInstructionForValidationFeedback(input: {
  code: string;
  schemaCategory?: string | undefined;
  details?: Record<string, unknown> | undefined;
}): string | undefined {
  const reason = asString(input.details?.reason);
  const toolName = asString(input.details?.toolName);
  if (toolName === "exec_command" && reason === "exec_command_ambiguous_lifecycle_input") {
    return [
      "For exec_command, use exactly one lifecycle shape:",
      "start with { \"command\": \"...\", \"cwd\": \"...\" } and omit sessionId/stdin/stop;",
      "or continue with { \"sessionId\": \"returned-session-id\", \"stdin\": \"...\\n\" } and omit command.",
      "Never invent sessionId.",
    ].join(" ");
  }
  if (toolName === "exec_command" && reason === "live_dev_process_start_replay_requires_process_continuation") {
    return "Continue the live exec_command session with sessionId + stdin/read, or stop it before starting a new process. Use fresh command only when intentionally resetting or starting unrelated work.";
  }
  if (
    input.schemaCategory === "tool_call" &&
    (input.code === "DECISION_SCHEMA_FAILED" || input.code === "DECISION_PARSE_FAILED")
  ) {
    return "Call exactly one available tool or Kestrel control tool now; do not answer in prose.";
  }
  return undefined;
}

function readRequiredCorrection(value: unknown): string | undefined {
  const correction = asString(asRecord(value)?.requiredCorrection);
  return correction !== undefined && correction.trim().length > 0
    ? correction.trim()
    : undefined;
}

function renderStructuredRetryCorrection(value: unknown): string | undefined {
  const correction = asRecord(value);
  if (correction === undefined) {
    return undefined;
  }
  const sections = Object.entries(correction)
    .map(([kind, detail]) => renderStructuredRetryCorrectionSection(kind, detail))
    .filter((section): section is string => section !== undefined);
  if (sections.length === 0) {
    return undefined;
  }
  return [
    "The previous action was rejected. Correct the next action using this structured feedback.",
    ...sections,
  ].join("\n");
}

function renderStructuredRetryCorrectionSection(kind: string, value: unknown): string | undefined {
  const detail = asRecord(value);
  if (detail === undefined) {
    return undefined;
  }
  const action = asString(detail.action);
  const instruction = retryInstructionForAction(action);
  const structuredFacts = stableStringify(removeUndefinedProperties({
    ...detail,
    action,
  }));
  return [
    `- correctionKind: ${kind}`,
    ...(action !== undefined ? [`  action: ${action}`] : []),
    ...(instruction !== undefined ? [`  instruction: ${instruction}`] : []),
    `  structuredFacts: ${structuredFacts}`,
  ].join("\n");
}

function retryInstructionForAction(action: string | undefined): string | undefined {
  switch (action) {
    case "call_one_terminal_control_tool":
      return "Call exactly one Kestrel control tool now; do not answer in prose.";
    case "emit_compact_understanding_object":
      return "Emit understanding as a compact object with task, facts, currentGap, and actionBasis.";
    case "call_handoff_to_build_with_compact_continuation":
      return "Call kestrel_handoff_to_build with an operator-facing message and compact continuation object.";
    case "write_session_plan_before_handoff":
      return "Call planning_write_document now to create or update the current session PLAN.md. Do not call kestrel_handoff_to_build again until that tool result confirms the session plan document exists.";
    case "choose_valid_build_mode_action":
      return "Choose a valid build-mode tool action, ask_user, cannot_satisfy, or grounded goal_satisfied closeout.";
    case "choose_available_tool_or_concrete_blocker":
      return "Continue with an available tool action, especially any availableToolHints in the retry details, ask for a concrete decision, or use a concrete external-blocker reason.";
    case "call_finalize_with_user_facing_message":
      return "Call kestrel_finalize with status and a direct user-facing message.";
    case "call_available_tool":
    case "call_available_tool_directly":
      return "Call an available tool directly with its documented input object.";
    case "emit_valid_visible_todos":
      return "If updating visible todos, emit a small valid checklist with objective and item id/text/status fields.";
    case "omit_or_fix_optional_browser_evidence":
      return "Omit optional browser evidence unless it matches the required structured shape.";
    case "emit_non_empty_evidence_expectation_values":
      return "Omit internal verification expectation fields from model output; mention useful checks in the final message instead.";
    case "write_or_repair_source_without_interactive_editor":
      return "Write or repair source using file tools or bounded shell commands, not an interactive editor command.";
    case "rewrite_operator_facing_text":
      return "Rewrite the user-visible field so it directly addresses the operator.";
    case "remove_execution_role":
      return "Remove executionRole; command roles are internal runtime bookkeeping.";
    case "emit_single_stop_action":
      return "Emit one stop action for the live process by itself, then observe the stopped process result.";
    case "target_known_process_or_start_new_process":
      return "Use a listed live process id or start a new managed process; do not invent process handles.";
    case "target_live_process_or_start_new_process":
      return "Target a live process id or start a new managed process.";
    case "stop_live_process_or_run_bounded_controller":
      return "Do not start the same managed command again; stop it or run a bounded controller/checker.";
    case "continue_live_process_by_process_id":
      return "Continue the live process by its listed process/session id instead of starting the same command again.";
    case "stop_live_process_or_use_process_tools_or_file_tools":
      return "Use process tools, stop the live process, or create files with file tools instead of starting escaped multiline input.";
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stableStringify(value: unknown): string {
  try {
    return stringifySanitizedJson(sortValue(sanitizeJsonValue(value)));
  } catch {
    return String(value);
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort((left, right) => left.localeCompare(right))) {
    output[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return output;
}

function removeUndefinedProperties(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      output[key] = item;
    }
  }
  return output;
}
