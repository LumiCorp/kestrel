export type AgentInteractionMode = "chat" | "plan" | "build";

export function readSelectedModeSwitch(value: unknown): AgentInteractionMode | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const mode = (value as Record<string, unknown>).mode;
  return mode === "chat" || mode === "plan" || mode === "build" ? mode : undefined;
}

export function readActiveModeSwitch(input: {
  value: unknown;
  sourceEventId: string;
}): AgentInteractionMode | undefined {
  if (
    typeof input.value !== "object" ||
    input.value === null ||
    Array.isArray(input.value)
  ) {
    return;
  }
  const record = input.value as Record<string, unknown>;
  return record.sourceEventId === input.sourceEventId
    ? readSelectedModeSwitch(record)
    : undefined;
}
