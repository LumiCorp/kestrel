import type { UIMessage } from "ai";

type ToolLikePart = {
  type?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  state?: unknown;
  approval?: unknown;
  input?: unknown;
};

export type GithubApprovalCanaryRequest = {
  assistantMessage: UIMessage;
  approvalId: string;
  toolCallId: string;
};

export function findGithubIssueApprovalRequest(input: {
  messages: UIMessage[];
  repository: string;
  title: string;
  body: string;
}): GithubApprovalCanaryRequest | null {
  for (const message of [...input.messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const part of [...message.parts].reverse()) {
      const tool = asToolPart(part);
      const approval = asRecord(tool?.approval);
      const toolInput = asRecord(tool?.input);
      if (
        tool?.type !== "dynamic-tool" ||
        tool.toolName !== "kestrel_one.github_issue_create" ||
        tool.state !== "approval-requested" ||
        typeof tool.toolCallId !== "string" ||
        typeof approval?.id !== "string" ||
        toolInput?.repository !== input.repository ||
        toolInput.title !== input.title ||
        toolInput.body !== input.body
      ) {
        continue;
      }
      return {
        assistantMessage: message,
        approvalId: approval.id,
        toolCallId: tool.toolCallId,
      };
    }
  }
  return null;
}

export function respondToGithubApproval(input: {
  request: GithubApprovalCanaryRequest;
  approved: boolean;
  reason?: string | undefined;
}): UIMessage {
  return {
    ...input.request.assistantMessage,
    parts: input.request.assistantMessage.parts.map((part) => {
      const tool = asToolPart(part);
      const approval = asRecord(tool?.approval);
      if (
        tool?.state !== "approval-requested" ||
        approval?.id !== input.request.approvalId
      ) {
        return part;
      }
      return {
        ...tool,
        state: "approval-responded",
        approval: {
          id: input.request.approvalId,
          approved: input.approved,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      } as UIMessage["parts"][number];
    }),
  };
}

export function hasGithubApprovalDecision(input: {
  messages: UIMessage[];
  approvalId: string;
  approved: boolean;
}) {
  return input.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => {
        const tool = asToolPart(part);
        const approval = asRecord(tool?.approval);
        return (
          tool?.state === "approval-responded" &&
          approval?.id === input.approvalId &&
          approval.approved === input.approved
        );
      })
  );
}

function asToolPart(value: unknown): ToolLikePart | undefined {
  return asRecord(value) as ToolLikePart | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
