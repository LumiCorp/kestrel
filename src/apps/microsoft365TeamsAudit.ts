const TEAMS_READ_OPERATIONS = new Map<string, "chats.list" | "chat.messages.list">([
  ["microsoft_365.list_chats", "chats.list"],
  ["kestrel_one.microsoft_365_list_chats", "chats.list"],
  ["microsoft_365.list_chat_messages", "chat.messages.list"],
  ["kestrel_one.microsoft_365_list_chat_messages", "chat.messages.list"],
]);

/**
 * Teams read results are model-visible for the current turn, but the durable
 * audit record needs only provider identities, counts, and page state.
 */
export function projectMicrosoft365TeamsReadAuditOutput(
  toolName: string,
  toolInput: unknown,
  toolOutput: unknown,
): Record<string, unknown> | undefined {
  const operation = TEAMS_READ_OPERATIONS.get(toolName);
  if (operation === undefined) return;
  const input = asRecord(toolInput);
  const wrapper = asRecord(toolOutput) ?? {};
  const output = asRecord(wrapper.result) ?? wrapper;
  const items = Array.isArray(output.items) ? output.items : [];
  const providerIds = items.flatMap((item) => {
    const id = asRecord(item)?.id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
  const cursorState = typeof input?.cursor === "string" ? "continued" : "initial";
  const nextPage = typeof output?.nextCursor === "string";
  if (operation === "chats.list") {
    return {
      operation,
      resultCount: items.length,
      providerChatIds: providerIds,
      cursorState,
      nextPage,
    };
  }
  return {
    operation,
    resultCount: items.length,
    providerChatId: typeof input?.chatId === "string"
      ? input.chatId
      : typeof input?.providerChatId === "string" ? input.providerChatId : undefined,
    providerMessageIds: providerIds,
    cursorState,
    nextPage,
  };
}

/** Teams cursors are execution-only; retained input evidence records page state. */
export function projectMicrosoft365TeamsReadAuditInput(
  toolName: string,
  toolInput: unknown,
): Record<string, unknown> | undefined {
  const operation = TEAMS_READ_OPERATIONS.get(toolName);
  if (operation === undefined) return;
  const input = asRecord(toolInput);
  const cursorState = typeof input?.cursor === "string" ? "continued" : "initial";
  const maxResults = typeof input?.maxResults === "number" &&
    Number.isSafeInteger(input.maxResults)
    ? input.maxResults
    : undefined;
  if (operation === "chats.list") {
    return {
      operation,
      cursorState,
      ...(maxResults === undefined ? {} : { maxResults }),
    };
  }
  return {
    operation,
    cursorState,
    ...(typeof input?.chatId !== "string" ? {} : { providerChatId: input.chatId }),
    ...(maxResults === undefined ? {} : { maxResults }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
