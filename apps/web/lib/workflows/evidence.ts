type PlainRecord = Record<string, unknown>;

function record(value: unknown): PlainRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PlainRecord)
    : null;
}

export type WorkflowStepEvidence = {
  model: string | null;
  text: string;
  toolCalls: Array<{
    toolCallId: string | null;
    toolName: string;
    state: string | null;
    input?: unknown;
    output?: unknown;
    error?: string;
  }>;
};

export function workflowStepEvidence(input: {
  model?: string | null;
  parts: unknown;
}): WorkflowStepEvidence {
  const parts = Array.isArray(input.parts) ? input.parts : [];
  const text: string[] = [];
  const calls = new Map<string, WorkflowStepEvidence["toolCalls"][number]>();
  for (const value of parts) {
    const part = record(value);
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      text.push(part.text);
      continue;
    }
    const type = typeof part.type === "string" ? part.type : "";
    if (!(type.startsWith("tool-") || type === "dynamic-tool")) continue;
    const explicitName = typeof part.toolName === "string" ? part.toolName : null;
    const inferredName = type.startsWith("tool-") ? type.slice(5) : null;
    const toolName = explicitName ?? inferredName;
    if (!toolName) continue;
    const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : null;
    const key = toolCallId ?? `${toolName}:${calls.size}`;
    calls.set(key, {
      toolCallId,
      toolName,
      state: typeof part.state === "string" ? part.state : null,
      ...(Object.hasOwn(part, "input") ? { input: part.input } : {}),
      ...(Object.hasOwn(part, "output") ? { output: part.output } : {}),
      ...(typeof part.errorText === "string" ? { error: part.errorText } : {}),
    });
  }
  return { model: input.model ?? null, text: text.join("\n"), toolCalls: [...calls.values()] };
}
