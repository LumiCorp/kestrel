import { mobileActivity } from "@/lib/mobile/activity";

export type MobileMessagePart =
  | { type: "text"; text: string }
  | { type: "source_url"; sourceId: string; url: string; title: string | null }
  | {
      type: "source_document";
      sourceId: string;
      mediaType: string;
      title: string;
      filename: string | null;
    }
  | {
      type: "tool_status";
      toolCallId: string;
      toolName: string;
      state: MobileToolState;
    }
  | {
      type: "progress";
      id: string;
      category: "runtime" | "agent";
      label: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "citation";
      id: string;
      title: string;
      url: string | null;
      documentId: string | null;
      excerpt: string | null;
    }
  | {
      type: "artifact";
      id: string;
      title: string;
      kind: string;
      url: string | null;
      mediaType: string | null;
    }
  | {
      type: "interaction_status";
      requestId: string;
      kind: MobileInteractionKind;
      prompt: string;
      status: MobileInteractionStatus;
    }
  | {
      type: "assistant_status";
      status: MobileAssistantStatus;
      errorCode: MobileAssistantErrorCode | null;
      message: string | null;
    };

type MobileToolState =
  | "pending"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "denied"
  | "unavailable";
type MobileInteractionKind = "question" | "approval";
type MobileInteractionStatus = "pending" | "resolved" | "cancelled";
type MobileAssistantStatus =
  | "working"
  | "completed"
  | "waiting"
  | "failed"
  | "cancelled"
  | "contract_failure";
type MobileAssistantErrorCode =
  | "AGENT_RUN_FAILED"
  | "AGENT_RUN_CANCELLED"
  | "PRESENTATION_CONTRACT_FAILURE";

export const mobileV2DurablePartTypes: ReadonlySet<MobileMessagePart["type"]> =
  new Set([
    "text",
    "source_url",
    "source_document",
    "citation",
    "artifact",
    "interaction_status",
    "progress",
    "tool_status",
  ]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" ? record[key] : null;
}

export function mobileMessageParts(value: unknown): MobileMessagePart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): MobileMessagePart[] => {
    const part = asRecord(raw);
    const type = part ? readString(part, "type") : null;
    if (!(part && type)) return [];
    if (type === "text") {
      const text = readString(part, "text");
      return text === null ? [] : [{ type: "text", text }];
    }
    if (type === "source-url") {
      const sourceId = readString(part, "sourceId");
      const url = readString(part, "url");
      return sourceId && url
        ? [
            {
              type: "source_url",
              sourceId,
              url,
              title: readString(part, "title"),
            },
          ]
        : [];
    }
    if (type === "source-document") {
      const sourceId = readString(part, "sourceId");
      const mediaType = readString(part, "mediaType");
      const title = readString(part, "title");
      return sourceId && mediaType && title
        ? [
            {
              type: "source_document",
              sourceId,
              mediaType,
              title,
              filename: readString(part, "filename"),
            },
          ]
        : [];
    }
    if (type === "dynamic-tool" || type.startsWith("tool-")) {
      const toolCallId = readString(part, "toolCallId");
      const state = mobileToolState(readString(part, "state"), part);
      if (!toolCallId) return [];
      return [
        {
          type: "tool_status",
          toolCallId,
          toolName: readString(part, "toolName") ?? type.replace(/^tool-/u, ""),
          state,
        },
      ];
    }
    const data = asRecord(part.data);
    if (!data) return [];
    if (type === "data-kestrel-progress") {
      const id = readString(data, "id");
      const text = readString(data, "text");
      const timestamp = readString(data, "timestamp");
      const activity = mobileActivity({
        kind: "progress",
        code: readString(data, "code"),
      });
      return id && text && timestamp
        ? [
            {
              type: "progress",
              id,
              category: "runtime",
              label: readString(data, "phase") ?? "Runtime activity",
              text: activity.message,
              timestamp,
            },
          ]
        : [];
    }
    if (type === "data-kestrel-agent-progress") {
      const id = readString(data, "id");
      const text = readString(data, "text");
      const timestamp = readString(data, "timestamp");
      return id && text && timestamp
        ? [
            {
              type: "progress",
              id,
              category: "agent",
              label: readString(data, "label") ?? "Agent progress",
              text,
              timestamp,
            },
          ]
        : [];
    }
    if (type === "data-kestrel-tool") {
      const toolCallId = readString(data, "toolCallId");
      const toolName = readString(data, "toolName");
      const state = mobileToolState(readString(data, "phase"));
      return toolCallId && toolName
        ? [{ type: "tool_status", toolCallId, toolName, state }]
        : [];
    }
    if (type === "data-kestrel-citation") {
      const id = readString(data, "id");
      const title = readString(data, "title");
      return id && title
        ? [
            {
              type: "citation",
              id,
              title,
              url: readString(data, "url"),
              documentId: readString(data, "documentId"),
              excerpt: readString(data, "excerpt"),
            },
          ]
        : [];
    }
    if (type === "data-kestrel-artifact") {
      const id = readString(data, "id");
      const title = readString(data, "title");
      const kind = readString(data, "kind");
      return id && title && kind
        ? [
            {
              type: "artifact",
              id,
              title,
              kind,
              url: readString(data, "url"),
              mediaType: readString(data, "mediaType"),
            },
          ]
        : [];
    }
    if (type === "data-kestrel-interaction") {
      const requestId = readString(data, "requestId");
      const internalKind = readString(data, "kind");
      const kind = mobileInteractionKind(internalKind);
      const prompt = mobileInteractionPrompt(
        internalKind,
        readString(data, "prompt")
      );
      const status = mobileInteractionStatus(readString(data, "status"));
      return requestId && kind && prompt && status
        ? [{ type: "interaction_status", requestId, kind, prompt, status }]
        : [];
    }
    if (type === "data-kestrel-status") {
      const status = mobileAssistantStatus(readString(data, "status"));
      if (!status) return [];
      const visibleFailure = mobileAssistantFailure(status);
      return [
        {
          type: "assistant_status",
          status,
          errorCode: visibleFailure?.code ?? null,
          message: visibleFailure?.message ?? null,
        },
      ];
    }
    return [];
  });
}

function mobileToolState(
  state: string | null,
  part?: Record<string, unknown>
): MobileToolState {
  if (state === "input-streaming") return "pending";
  if (state === "input-available" || state === "started") return "running";
  if (state === "approval-requested") return "waiting_for_approval";
  if (state === "approval-responded") {
    return asRecord(part?.approval)?.approved === false ? "denied" : "running";
  }
  if (state === "output-available" || state === "completed") return "completed";
  if (state === "output-error" || state === "failed") return "failed";
  if (state === "output-denied") return "denied";
  return "unavailable";
}

function mobileInteractionKind(
  value: string | null
): MobileInteractionKind | null {
  if (value === "user_input" || value === "mcp_elicitation") return "question";
  if (
    value === "approval" ||
    value === "sampling" ||
    value === "mcp_sampling"
  ) {
    return "approval";
  }
  return null;
}

function mobileInteractionPrompt(
  kind: string | null,
  prompt: string | null
): string | null {
  if (kind === "sampling" || kind === "mcp_sampling") {
    return "The agent requested a protected operation.";
  }
  return prompt;
}

function mobileInteractionStatus(
  value: string | null
): MobileInteractionStatus | null {
  return value === "pending" || value === "resolved" || value === "cancelled"
    ? value
    : null;
}

function mobileAssistantStatus(
  value: string | null
): MobileAssistantStatus | null {
  return value === "working" ||
    value === "completed" ||
    value === "waiting" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "contract_failure"
    ? value
    : null;
}

function mobileAssistantFailure(
  status: MobileAssistantStatus
): { code: MobileAssistantErrorCode; message: string } | null {
  if (status === "contract_failure") {
    return {
      code: "PRESENTATION_CONTRACT_FAILURE",
      message: "The agent returned a malformed response.",
    };
  }
  if (status === "failed") {
    return {
      code: "AGENT_RUN_FAILED",
      message: "The agent could not complete this response.",
    };
  }
  if (status === "cancelled") {
    return {
      code: "AGENT_RUN_CANCELLED",
      message: "The turn was interrupted.",
    };
  }
  return null;
}
