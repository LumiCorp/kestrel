import {
  isMobileActivityStage,
  type MobileActivityStage,
  mobileActivity,
} from "@/lib/mobile/activity";

export type MobileTurnEvent =
  | {
      type: "message.delta";
      data: { turnId: string; textDelta: string };
    }
  | {
      type: "activity.updated";
      data: {
        turnId: string;
        stage: MobileActivityStage;
        message: string;
      };
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
  if (input.type === "turn.activity") {
    const activity = asRecord(input.data);
    if (
      isMobileActivityStage(activity?.stage) &&
      typeof activity.message === "string" &&
      activity.message.trim()
    ) {
      return {
        type: "activity.updated",
        data: {
          turnId: input.turnId,
          stage: activity.stage,
          message: activity.message.trim(),
        },
      };
    }
  }
  if (input.type === "ui.message") {
    const chunk = asRecord(input.data);
    if (chunk?.type === "text-delta" && typeof chunk.delta === "string") {
      return {
        type: "message.delta",
        data: { turnId: input.turnId, textDelta: chunk.delta },
      };
    }
    if (chunk?.type === "data-kestrel-progress") {
      const presentation = asRecord(chunk.data);
      if (typeof presentation?.text === "string" && presentation.text.trim()) {
        const activity = mobileActivity({
          kind: "progress",
          code:
            typeof presentation.code === "string" ? presentation.code : null,
        });
        return {
          type: "activity.updated",
          data: {
            turnId: input.turnId,
            ...activity,
          },
        };
      }
    }
    if (chunk?.type === "data-kestrel-agent-progress") {
      const presentation = asRecord(chunk.data);
      if (typeof presentation?.text === "string" && presentation.text.trim()) {
        const activity = mobileActivity({
          kind: "agent_progress",
          text: presentation.text,
        });
        return {
          type: "activity.updated",
          data: {
            turnId: input.turnId,
            ...activity,
          },
        };
      }
    }
    if (chunk?.type === "data-kestrel-tool") {
      const activity = mobileActivity({ kind: "tool" });
      return {
        type: "activity.updated",
        data: {
          turnId: input.turnId,
          ...activity,
        },
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
