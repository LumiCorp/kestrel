import {
  resolveConversationModeSwitch,
  type ConversationMode,
} from "@kestrel-agents/conversation";
import type { ThreadInteractionView } from "./client-contract";

export type KestrelOneComposerModeSelection =
  | { kind: "change_mode" }
  | {
      kind: "resume_mode_switch";
      interaction: ThreadInteractionView;
    };

function readKestrelOneModeSwitch(
  interaction: ThreadInteractionView,
  currentMode: ConversationMode,
) {
  if (
    interaction.source !== "runtime" ||
    interaction.kind !== "user_input"
  ) {
    return;
  }
  return resolveConversationModeSwitch({
    recommendationId: interaction.requestId,
    originatingMessageId:
      interaction.assistantMessageId ?? interaction.requestId,
    fromMode: currentMode,
    reason: interaction.prompt,
    metadata:
      typeof interaction.requestEnvelope.metadata === "object" &&
      interaction.requestEnvelope.metadata !== null &&
      !Array.isArray(interaction.requestEnvelope.metadata)
        ? (interaction.requestEnvelope.metadata as Record<string, unknown>)
        : undefined,
  });
}

export function resolveKestrelOneComposerModeSelection(input: {
  currentMode: ConversationMode;
  interactions: readonly ThreadInteractionView[];
  selectedMode: ConversationMode;
}): KestrelOneComposerModeSelection {
  const pendingInteraction = input.interactions.find(
    (interaction) => interaction.status === "pending",
  );
  if (
    pendingInteraction?.source !== "runtime" ||
    pendingInteraction.kind !== "user_input" ||
    pendingInteraction.turnId === null
  ) {
    return { kind: "change_mode" };
  }

  const modeSwitch = readKestrelOneModeSwitch(
    pendingInteraction,
    input.currentMode,
  );

  return modeSwitch?.toMode === input.selectedMode
    ? { kind: "resume_mode_switch", interaction: pendingInteraction }
    : { kind: "change_mode" };
}

export async function executeKestrelOneComposerModeSelection(input: {
  currentMode: ConversationMode;
  interactions: readonly ThreadInteractionView[];
  selectedMode: ConversationMode;
  changeMode(mode: ConversationMode): boolean | void | Promise<boolean | void>;
  resumeModeSwitch(
    interaction: ThreadInteractionView,
    mode: ConversationMode,
  ): void | Promise<void>;
  onResumeFailure(error: unknown): void;
}) {
  const selection = resolveKestrelOneComposerModeSelection(input);
  if (selection.kind === "change_mode") {
    return input.changeMode(input.selectedMode);
  }
  try {
    await input.resumeModeSwitch(selection.interaction, input.selectedMode);
    return true;
  } catch (error) {
    input.onResumeFailure(error);
    return false;
  }
}

export function filterKestrelOneComposerControlMessages<
  Message extends { id: string },
>(input: {
  interactions: readonly ThreadInteractionView[];
  messages: readonly Message[];
  optimisticControlMessageIds: ReadonlySet<string>;
}): Message[] {
  const controlMessageIds = new Set(input.optimisticControlMessageIds);
  for (const interaction of input.interactions) {
    if (
      interaction.responseMessageId !== null &&
      readKestrelOneModeSwitch(interaction, "chat") !== undefined
    ) {
      controlMessageIds.add(interaction.responseMessageId);
    }
  }
  return input.messages.filter(
    (message) => !controlMessageIds.has(message.id),
  );
}
