export type LostRuntimeInteractionPresentation = {
  requestId: string;
  assistantMessageId: string | null;
  responseEnvelope: Record<string, unknown> | null;
};

export function readLostRuntimeInteractionPresentation(
  interactions: LostRuntimeInteractionPresentation[],
) {
  const responseMessageIds = new Set<string>();
  const requestsByAssistantMessage = new Map<string, Set<string>>();
  for (const interaction of interactions) {
    const responseMessageId = interaction.responseEnvelope?.messageId;
    if (typeof responseMessageId === "string") {
      responseMessageIds.add(responseMessageId);
    }
    if (interaction.assistantMessageId) {
      const requestIds =
        requestsByAssistantMessage.get(interaction.assistantMessageId) ??
        new Set<string>();
      requestIds.add(interaction.requestId);
      requestsByAssistantMessage.set(
        interaction.assistantMessageId,
        requestIds,
      );
    }
  }
  return { responseMessageIds, requestsByAssistantMessage };
}

export function stripLostRuntimeInteractionParts(
  value: unknown,
  requestIds: ReadonlySet<string>,
): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return true;
    const record = part as Record<string, unknown>;
    if (record.type !== "data-kestrel-interaction") return true;
    const data =
      record.data &&
      typeof record.data === "object" &&
      !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : null;
    return typeof data?.requestId !== "string" ||
      !requestIds.has(data.requestId);
  });
}
