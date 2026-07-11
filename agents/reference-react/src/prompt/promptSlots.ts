export const PROMPT_SLOT_IDS = [
  "role",
  "job",
  "look_at_first",
  "avoid_wasted_calls",
  "done_when",
  "output_rules",
  "extra_guidance",
  "output_format",
  "dev_shell_guidance",
  "filesystem_guidance",
  "workspace_guidance",
  "loop_state",
  "finalization_support",
  "active_failure_frame",
  "current_turn_brief",
  "current_blocking_fact",
  "valid_next_actions",
  "latest_meaningful_result",
  "runtime_pivot",
  "managed_entrypoints",
  "completion_packet",
  "repeated_completion_packet",
  "latest_concrete_fact",
  "latest_action",
  "latest_result",
  "plan_document",
  "task_ledger",
  "artifact_fact",
  "artifact_gate",
  "task_source",
  "recent_conversation",
  "budget",
  "process_facts",
  "process_continuation",
  "tools",
  "capability_manifest",
  "retry_correction",
  "current_situation",
  "route_request_frame",
  "capability_frame",
  "run_summary",
  "source_candidates",
  "resolver_action_frame",
  "chat_outcome_frame",
] as const;

export type PromptSlotId = typeof PROMPT_SLOT_IDS[number];

export type PromptSlotValues = Partial<Record<PromptSlotId, string | undefined>>;

const KNOWN_PROMPT_SLOTS = new Set<string>(PROMPT_SLOT_IDS);

export function isPromptSlotId(value: string): value is PromptSlotId {
  return KNOWN_PROMPT_SLOTS.has(value);
}

export function formatNumberedLines(items: ReadonlyArray<string> | undefined): string {
  if (items === undefined || items.length === 0) {
    return "";
  }
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export function joinPromptLines(lines: ReadonlyArray<string | undefined>): string {
  return lines
    .map((line) => line?.trim())
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join("\n");
}
