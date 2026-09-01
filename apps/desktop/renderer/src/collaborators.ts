import {
  groupCollaboratorMessages,
  type CollaboratorGroup,
  type CollaboratorMessage,
} from "@kestrel-agents/conversation";

import type { RendererTranscriptLine } from "./state";

export function groupDesktopCollaboratorMessages(
  transcript: readonly RendererTranscriptLine[],
): CollaboratorGroup[] {
  return groupCollaboratorMessages(transcript.flatMap((line) => {
    if (line.dialog === undefined) return [];
    const dialog: CollaboratorMessage = {
      messageId: line.dialog.messageId,
      dialogId: line.dialog.dialogId,
      name: line.dialog.name,
      childSessionId: line.dialog.childSessionId,
      sender: line.dialog.sender,
      text: line.text,
      createdAt: line.timestamp,
      dialogStatus: line.dialog.dialogStatus ?? "open",
      ...(line.dialog.dialogActivity !== undefined
        ? { dialogActivity: line.dialog.dialogActivity }
        : {}),
      ...(line.dialog.status !== undefined ? { status: line.dialog.status } : {}),
    };
    return [dialog];
  }));
}
