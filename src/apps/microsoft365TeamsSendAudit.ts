import { createHash } from "node:crypto";

const TEAMS_SEND_TOOL_NAMES = new Set([
  "microsoft_365.send_chat_message",
  "kestrel_one.microsoft_365_send_chat_message",
]);

/**
 * Teams message content is present only in the active execution. Retained
 * records carry the exact target and a content commitment, never the body.
 */
export function projectMicrosoft365TeamsSendAuditInput(
  toolName: string,
  toolInput: unknown,
): Record<string, unknown> | undefined {
  if (!TEAMS_SEND_TOOL_NAMES.has(toolName)) return;
  const input = asRecord(toolInput);
  const content = asString(input?.content);
  return compact({
    operation: "chat.send",
    providerChatId: asString(input?.chatId),
    ...(content === undefined
      ? {}
      : {
          contentBytes: Buffer.byteLength(content, "utf8"),
          contentHash: createHash("sha256").update(content).digest("hex"),
        }),
  });
}

/** Project every Teams send result into content-free durable evidence. */
export function projectMicrosoft365TeamsSendAuditOutput(
  toolName: string,
  toolInput: unknown,
  toolOutput: unknown,
): Record<string, unknown> | undefined {
  if (!TEAMS_SEND_TOOL_NAMES.has(toolName)) return;
  const candidateInput = asRecord(toolInput);
  const input = candidateInput?.operation === "chat.send"
    ? candidateInput
    : projectMicrosoft365TeamsSendAuditInput(toolName, toolInput);
  if (input === undefined) return;
  const wrapper = asRecord(toolOutput) ?? {};
  const output = asRecord(wrapper.result) ?? wrapper;
  const failureCode = asString(output.errorCode);
  return compact({
    operation: "chat.send",
    providerChatId: asString(input.providerChatId),
    contentBytes: input.contentBytes,
    contentHash: input.contentHash,
    mutationOutcome: failureCode === "MICROSOFT_365_OUTCOME_UNKNOWN"
      ? "outcome_unknown"
      : output.status === "FAILED" ? "rejected" : "confirmed",
    providerErrorCode: failureCode,
    providerMessageId: asString(output.id),
    providerCreatedAt: asString(output.createdAt),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, candidate]) => candidate !== undefined),
  );
}
