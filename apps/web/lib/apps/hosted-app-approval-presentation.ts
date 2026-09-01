import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";
import type {
  GmailPreparedAttachment,
  PreparedGmailMutation,
} from "@/lib/integrations/gmail-mutation-preparation";

export type HostedAppApprovalPresentation = {
  title: string;
  summary: string;
  fields: Array<{ label: string; value: string }>;
  warnings: string[];
};

/**
 * Builds the user-visible description from the provider-resolved Gmail
 * mutation. This projection is deliberately separate from the runner's raw
 * input binding: the provider-owned reply target is only known after lookup.
 */
export function buildGmailApprovalPresentation(
  prepared: PreparedGmailMutation,
): HostedAppApprovalPresentation {
  const attachmentValue = describeAttachments(prepared.attachments);
  const commonFields = [
    { label: "To", value: prepared.envelope.to.join(", ") },
    ...(prepared.envelope.cc.length > 0
      ? [{ label: "Cc", value: prepared.envelope.cc.join(", ") }]
      : []),
    { label: "Subject", value: prepared.envelope.subject },
    { label: "Message", value: prepared.envelope.text },
    { label: "Attachments", value: attachmentValue },
  ];
  if (prepared.envelope.threadId === undefined) {
    return {
      title: "Send Gmail message",
      summary: "Review the exact Gmail message before it is sent.",
      fields: commonFields,
      warnings: [],
    };
  }
  return {
    title: "Reply with Gmail",
    summary: "Review the exact provider-resolved reply target and message before it is sent.",
    fields: [
      { label: "Thread", value: prepared.envelope.threadId },
      ...commonFields,
    ],
    warnings: [],
  };
}

/**
 * Attach a server-derived display projection without changing the immutable
 * raw tool input or its external approval binding.
 */
export function attachHostedAppApprovalPresentation(
  terminal: RunnerRunTerminalEvent,
  presentation: HostedAppApprovalPresentation | undefined,
): RunnerRunTerminalEvent {
  if (presentation === undefined || terminal.type !== "run.completed") {
    return terminal;
  }
  const output = terminal.payload.result.output;
  if (output.status !== "WAITING" || output.waitFor?.kind !== "approval") {
    return terminal;
  }
  const interaction = output.waitFor.interaction;
  if (!isRecord(interaction) || !isRecord(interaction.approval)) {
    return terminal;
  }
  const priorPresentation = isRecord(interaction.approval.presentation)
    ? interaction.approval.presentation
    : undefined;
  const policy = priorPresentation?.policy;
  return {
    ...terminal,
    payload: {
      ...terminal.payload,
      result: {
        ...terminal.payload.result,
        output: {
          ...output,
          waitFor: {
            ...output.waitFor,
            interaction: {
              ...interaction,
              approval: {
                ...interaction.approval,
                presentation: {
                  ...(isRecord(policy) ? { policy } : {}),
                  title: presentation.title,
                  summary: presentation.summary,
                  fields: presentation.fields,
                  warnings: presentation.warnings,
                },
              },
            },
          },
        },
      },
    },
  } as RunnerRunTerminalEvent;
}

function describeAttachments(attachments: readonly GmailPreparedAttachment[]) {
  return attachments.length === 0
    ? "None"
    : attachments.map((attachment) => attachment.filename).join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
