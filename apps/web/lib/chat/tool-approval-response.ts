import type { UIMessage } from "ai";

export type ToolApprovalResponse = {
  assistantMessage: UIMessage;
  approvalId: string;
  approved: boolean;
  reason?: string | undefined;
};

export type SubmittedToolApproval = {
  messageId: string;
  approvalId: string;
  approved: boolean;
  reason?: string | undefined;
};

export function findSubmittedToolApproval(
  messages: UIMessage[]
): SubmittedToolApproval | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const part of [...message.parts].reverse()) {
      const response = readRespondedApproval(part);
      if (!response) continue;
      return { messageId: message.id, ...response };
    }
  }
  return null;
}

export function applySubmittedToolApproval(input: {
  submittedApproval: SubmittedToolApproval;
  persistedMessages: UIMessage[];
}): ToolApprovalResponse | null {
  const persisted = input.persistedMessages.find(
    (message) =>
      message.id === input.submittedApproval.messageId &&
      message.role === "assistant"
  );
  if (!persisted) return null;
  const pendingPartIndex = persisted.parts.findIndex((candidate) =>
    isPendingApproval(candidate, input.submittedApproval.approvalId)
  );
  if (pendingPartIndex === -1) return null;
  const pendingPart = persisted.parts[pendingPartIndex];
  if (!pendingPart) return null;
  const parts = [...persisted.parts];
  parts[pendingPartIndex] = {
    ...pendingPart,
    state: "approval-responded",
    approval: {
      id: input.submittedApproval.approvalId,
      approved: input.submittedApproval.approved,
      ...(input.submittedApproval.reason
        ? { reason: input.submittedApproval.reason }
        : {}),
    },
  } as UIMessage["parts"][number];
  return {
    assistantMessage: { ...persisted, parts },
    approvalId: input.submittedApproval.approvalId,
    approved: input.submittedApproval.approved,
    ...(input.submittedApproval.reason
      ? { reason: input.submittedApproval.reason }
      : {}),
  };
}

function isPendingApproval(part: unknown, approvalId: string) {
  const record = asRecord(part);
  const approval = asRecord(record?.approval);
  return record?.state === "approval-requested" && approval?.id === approvalId;
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
