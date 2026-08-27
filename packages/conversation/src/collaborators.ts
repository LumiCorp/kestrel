export type CollaboratorSender = "kestrel" | "collaborator" | "system";

export type CollaboratorActivity = "idle" | "working" | "waiting" | "interrupted";

export type CollaboratorVisibleState =
  | "working"
  | "ready"
  | "waiting"
  | "paused"
  | "problem"
  | "archived";

/** A durable private message projected from one collaborator dialog. */
export interface CollaboratorMessage {
  messageId: string;
  dialogId: string;
  name: string;
  childSessionId: string;
  sender: CollaboratorSender;
  text: string;
  createdAt: string;
  dialogStatus: "open" | "closed";
  dialogActivity?: CollaboratorActivity | undefined;
  status?: "failed" | "cancelled" | undefined;
}

/** The complete, private presentation of one named collaborator. */
export interface CollaboratorGroup {
  dialogId: string;
  name: string;
  childSessionId: string;
  lifecycle: "open" | "closed";
  activity: CollaboratorActivity;
  visibleState: CollaboratorVisibleState;
  latestEvent: "sent" | "replied" | "system";
  latestMessage: CollaboratorMessage;
  messages: CollaboratorMessage[];
}

/**
 * Groups durable dialog messages for presentation. This is intentionally a
 * read-only projection: it does not create unread state, change lifecycle, or
 * decide whether a collaborator should continue working.
 */
export function groupCollaboratorMessages(
  messages: readonly CollaboratorMessage[],
): CollaboratorGroup[] {
  const byDialogId = new Map<string, CollaboratorMessage[]>();
  for (const message of messages) {
    const current = byDialogId.get(message.dialogId) ?? [];
    current.push(message);
    byDialogId.set(message.dialogId, current);
  }

  return [...byDialogId.values()]
    .map((dialogMessages) => {
      const ordered = [...dialogMessages].sort(compareMessages);
      const latestMessage = ordered.at(-1)!;
      const lifecycle = latestMessage.dialogStatus;
      const activity = latestMessage.dialogActivity ?? "idle";
      return {
        dialogId: latestMessage.dialogId,
        name: latestMessage.name,
        childSessionId: latestMessage.childSessionId,
        lifecycle,
        activity,
        visibleState: resolveCollaboratorVisibleState(latestMessage, activity),
        latestEvent: latestMessage.sender === "collaborator"
          ? "replied"
          : latestMessage.sender === "kestrel"
            ? "sent"
            : "system",
        latestMessage,
        messages: ordered,
      } satisfies CollaboratorGroup;
    })
    .sort((left, right) => {
      if (left.lifecycle !== right.lifecycle) {
        return left.lifecycle === "open" ? -1 : 1;
      }
      return compareMessages(right.latestMessage, left.latestMessage);
    });
}

export function collaboratorStateLabel(group: Pick<CollaboratorGroup, "name" | "visibleState">): string {
  switch (group.visibleState) {
    case "working":
      return `${group.name} is working`;
    case "waiting":
      return `${group.name} is waiting for Kestrel`;
    case "paused":
      return `${group.name} is paused`;
    case "problem":
      return `${group.name} ran into a problem`;
    case "archived":
      return `${group.name} is archived`;
    case "ready":
      return `${group.name} is ready`;
  }
}

function resolveCollaboratorVisibleState(
  latestMessage: CollaboratorMessage,
  activity: CollaboratorActivity,
): CollaboratorVisibleState {
  if (latestMessage.status === "failed") return "problem";
  if (latestMessage.dialogStatus === "closed") return "archived";
  if (activity === "working") return "working";
  if (activity === "waiting") return "waiting";
  if (activity === "interrupted" || latestMessage.status === "cancelled") return "paused";
  return "ready";
}

function compareMessages(left: CollaboratorMessage, right: CollaboratorMessage): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.messageId.localeCompare(right.messageId);
}
