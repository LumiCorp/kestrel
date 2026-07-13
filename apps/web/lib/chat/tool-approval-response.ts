import type { UIMessage } from "ai";

export type ToolApprovalResponse = {
  assistantMessage: UIMessage;
  approvalId: string;
  approved: boolean;
  reason?: string | undefined;
};

export function findNewToolApprovalResponse(input: {
  submittedMessages: UIMessage[];
  persistedMessages: UIMessage[];
}): ToolApprovalResponse | null {
  for (const submitted of [...input.submittedMessages].reverse()) {
    if (submitted.role !== "assistant") continue;
    const persisted = input.persistedMessages.find(
      (message) => message.id === submitted.id && message.role === "assistant"
    );
    if (!persisted) continue;
    for (const part of [...submitted.parts].reverse()) {
      const response = readRespondedApproval(part);
      if (!response) continue;
      const pendingPartIndex = persisted.parts.findIndex((candidate) =>
        isPendingApproval(candidate, response.approvalId)
      );
      if (pendingPartIndex === -1) continue;
      const pendingPart = persisted.parts[pendingPartIndex];
      if (!pendingPart) continue;
      const parts = [...persisted.parts];
      parts[pendingPartIndex] = {
        ...pendingPart,
        state: "approval-responded",
        approval: {
          id: response.approvalId,
          approved: response.approved,
          ...(response.reason ? { reason: response.reason } : {}),
        },
      } as UIMessage["parts"][number];
      return {
        assistantMessage: { ...persisted, parts },
        ...response,
      };
    }
  }
  return null;
}

function isPendingApproval(part: unknown, approvalId: string) {
  const record = asRecord(part);
  const approval = asRecord(record?.approval);
  return record?.state === "approval-requested" && approval?.id === approvalId;
}

export function hasToolApprovalResponse(messages: UIMessage[]) {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => readRespondedApproval(part) !== null)
  );
}

function readRespondedApproval(part: unknown) {
  const record = asRecord(part);
  const approval = asRecord(record?.approval);
  if (
    record?.state !== "approval-responded" ||
    typeof approval?.id !== "string" ||
    typeof approval.approved !== "boolean"
  ) {
    return null;
  }
  return {
    approvalId: approval.id,
    approved: approval.approved,
    ...(typeof approval.reason === "string" ? { reason: approval.reason } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
