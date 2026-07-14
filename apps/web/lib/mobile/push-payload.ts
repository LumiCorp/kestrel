function notificationCopy(kind: "completed" | "failed" | "attention") {
  if (kind === "completed") {
    return { title: "Kestrel One", body: "Your agent finished its work." };
  }
  if (kind === "attention") {
    return { title: "Kestrel One", body: "Your agent needs your attention." };
  }
  return {
    title: "Kestrel One",
    body: "Your agent could not finish its work.",
  };
}

export function buildMobilePushMessage(input: {
  token: string;
  kind: "completed" | "failed" | "attention";
  organizationId: string;
  threadId: string;
  turnId: string;
}) {
  return {
    to: input.token,
    sound: "default",
    ...notificationCopy(input.kind),
    data: {
      type: `turn.${input.kind}`,
      organizationId: input.organizationId,
      threadId: input.threadId,
      turnId: input.turnId,
    },
  };
}
