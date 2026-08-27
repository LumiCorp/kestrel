import {
  groupCollaboratorMessages,
  type CollaboratorGroup,
  type CollaboratorMessage,
} from "@kestrel-agents/conversation";
import type { ChatMessage } from "@/lib/types";

export function groupWebCollaboratorMessages(
  messages: readonly ChatMessage[],
): CollaboratorGroup[] {
  return groupCollaboratorMessages(messages.flatMap((message) =>
    message.parts.flatMap((part) => part.type === "data-kestrel-dialog-message"
      ? [toCollaboratorMessage(part.data)]
      : []),
  ));
}

/** Removes private collaborator traffic from the ordinary conversation view. */
export function withoutWebCollaboratorMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return messages.flatMap((message) => {
    const parts = message.parts.filter(
      (part) => part.type !== "data-kestrel-dialog-message",
    );
    return parts.length === message.parts.length
      ? [message]
      : parts.length === 0
        ? []
        : [{ ...message, parts }];
  });
}

function toCollaboratorMessage(
  data: Extract<ChatMessage["parts"][number], { type: "data-kestrel-dialog-message" }>["data"],
): CollaboratorMessage {
  return {
    messageId: data.messageId,
    dialogId: data.dialogId,
    name: data.name,
    childSessionId: data.childSessionId,
    sender: data.sender,
    text: data.text,
    createdAt: data.createdAt,
    dialogStatus: data.dialogStatus,
    ...(data.dialogActivity !== undefined ? { dialogActivity: data.dialogActivity } : {}),
    ...(data.status !== undefined ? { status: data.status } : {}),
  };
}
