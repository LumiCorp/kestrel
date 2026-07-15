export type MobileTurnEvent =
  | {
      type: "message.delta";
      data: { turnId: string; textDelta: string };
    }
  | {
      type: "snapshot.changed";
      data: {
        turnId: string;
        reason: "message_updated" | "turn_updated" | "interaction_updated";
      };
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function toMobileTurnEvent(input: {
  turnId: string;
  type: string;
  data: unknown;
}): MobileTurnEvent {
  if (input.type === "ui.message") {
    const chunk = asRecord(input.data);
    if (chunk?.type === "text-delta" && typeof chunk.delta === "string") {
      return {
        type: "message.delta",
        data: { turnId: input.turnId, textDelta: chunk.delta },
      };
    }
    return {
      type: "snapshot.changed",
      data: { turnId: input.turnId, reason: "message_updated" },
    };
  }
  return {
    type: "snapshot.changed",
    data: {
      turnId: input.turnId,
      reason: input.type.startsWith("interaction.")
        ? "interaction_updated"
        : "turn_updated",
    },
  };
}
