export type ToolActivityEvent = {
  toolCallId: string;
  toolName: string;
  displayName?: string | undefined;
  phase: "started" | "completed" | "failed";
  sequence: number;
  error?: { message: string } | undefined;
};

export type ToolActivityPresentation = {
  toolCallId: string;
  label: string;
  phase: ToolActivityEvent["phase"];
  errorMessage?: string | undefined;
};

const INTERNAL_TOOL_NAMES = new Set(["FinalizeAnswer"]);

export function presentToolActivity(
  events: readonly ToolActivityEvent[],
): ToolActivityPresentation[] {
  const calls = new Map<
    string,
    ToolActivityPresentation & { sequence: number }
  >();

  for (const event of [...events].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (INTERNAL_TOOL_NAMES.has(event.toolName)) continue;
    const existing = calls.get(event.toolCallId);
    calls.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      label: event.displayName ?? event.toolName,
      phase: event.phase,
      ...(event.error?.message ? { errorMessage: event.error.message } : {}),
      sequence: existing?.sequence ?? event.sequence,
    });
  }

  return [...calls.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ sequence: _sequence, ...call }) => call);
}
