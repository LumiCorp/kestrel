type TeamsReadInput = {
  operation: "chats.list" | "chat.messages.list";
  cursor?: string | undefined;
  chatId?: string | undefined;
};

/**
 * Build the retained evidence for a Teams read without preserving a chat body
 * or a sealed provider continuation token.
 */
export function microsoft365TeamsReadAuditMetadata(input: {
  input: TeamsReadInput;
  result?: unknown;
}): Record<string, unknown> {
  const result = asRecord(input.result);
  const items = Array.isArray(result.items) ? result.items : [];
  const providerIds = items.flatMap((item) => {
    const id = asRecord(item).id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
  const pageState =
    input.result === undefined
      ? "unavailable"
      : typeof result.nextCursor === "string"
        ? "more"
        : "complete";
  const shared = {
    cursorState: input.input.cursor === undefined ? "initial" : "continued",
    pageState,
    resultCount: items.length,
  };
  if (input.input.operation === "chats.list") {
    return { ...shared, providerChatIds: providerIds };
  }
  return {
    ...shared,
    providerChatId: input.input.chatId,
    providerMessageIds: providerIds,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
