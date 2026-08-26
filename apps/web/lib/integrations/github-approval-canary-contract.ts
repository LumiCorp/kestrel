import type { UIMessage } from "ai";
import {
  parseRunnerHostedToolApprovalInteractionV3,
  type HostedToolApprovalDecision,
  type RunnerHostedToolApprovalInteractionV3,
} from "@kestrel-agents/protocol";
import type { ThreadInteractionView } from "@/lib/turns/client-contract";

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

export type GithubDurableApprovalCanaryRequest = {
  interactionId: string;
  requestId: string;
  turnId: string;
  preparedInvocationId: string;
  stableToolIdentity: RunnerHostedToolApprovalInteractionV3["approval"]["stableToolIdentity"];
  requestingActor: RunnerHostedToolApprovalInteractionV3["approval"]["requestingActor"];
};

const GITHUB_ISSUE_TOOL = "kestrel_one.github_issue_create";

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
      }),
  );
}

export function findGithubDurableApprovalRequest(input: {
  interactions: ThreadInteractionView[];
  repository: string;
  title: string;
  body: string;
}): GithubDurableApprovalCanaryRequest | null {
  for (const interaction of [...input.interactions].reverse()) {
    if (
      interaction.source !== "runtime" ||
      interaction.kind !== "approval" ||
      interaction.eventType !== "user.approval" ||
      interaction.status !== "pending" ||
      interaction.turnId === null
    ) {
      continue;
    }
    let request: RunnerHostedToolApprovalInteractionV3;
    try {
      request = parseRunnerHostedToolApprovalInteractionV3(
        interaction.requestEnvelope,
        interaction.eventType,
      );
    } catch {
      continue;
    }
    if (
      request.requestId !== interaction.requestId ||
      request.approval.toolName !== GITHUB_ISSUE_TOOL ||
      !hasExactGithubIssuePresentation(request.approval.presentation, input)
    ) {
      continue;
    }
    return {
      interactionId: interaction.id,
      requestId: request.requestId,
      turnId: interaction.turnId,
      preparedInvocationId: request.approval.preparedInvocationId,
      stableToolIdentity: request.approval.stableToolIdentity,
      requestingActor: request.approval.requestingActor,
    };
  }
  return null;
}

export function durableApprovalResponse(input: {
  request: GithubDurableApprovalCanaryRequest;
  decision: HostedToolApprovalDecision;
  reason: string;
}) {
  return {
    requestId: input.request.requestId,
    eventType: "user.approval" as const,
    turnId: input.request.turnId,
    message: input.reason,
    decision: input.decision,
    reason: input.reason,
  };
}

export function assertDurableApprovalTerminal(input: {
  interactions: ThreadInteractionView[];
  request: GithubDurableApprovalCanaryRequest;
  decision: HostedToolApprovalDecision;
}) {
  const interaction = input.interactions.find(
    (candidate) => candidate.id === input.request.interactionId,
  );
  if (!interaction) return false;
  const recordedDecision = interaction.responseEnvelope?.decision;
  const expectedDecision = input.decision === "decline" ? "denied" : "approved";
  const expectedEffect =
    input.decision === "decline" ? "not_started" : "committed";
  return (
    interaction.requestId === input.request.requestId &&
    interaction.status === "resolved" &&
    recordedDecision === input.decision &&
    interaction.approvalOutcome?.decision === expectedDecision &&
    interaction.approvalOutcome.authorizationState ===
      (input.decision === "decline" ? "denied" : "accepted") &&
    interaction.approvalOutcome.effectState === expectedEffect
  );
}

function hasExactGithubIssuePresentation(
  value: unknown,
  expected: { repository: string; title: string; body: string },
) {
  const presentation = asRecord(value);
  if (!presentation || !Array.isArray(presentation.fields)) return false;
  const fields = new Map<string, string>();
  for (const field of presentation.fields) {
    const record = asRecord(field);
    if (typeof record?.label === "string" && typeof record.value === "string") {
      fields.set(record.label, record.value);
    }
  }
  return (
    presentation.title === "Create a GitHub issue" &&
    fields.get("Repository") === expected.repository &&
    fields.get("Title") === expected.title &&
    fields.get("Description") === expected.body
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
