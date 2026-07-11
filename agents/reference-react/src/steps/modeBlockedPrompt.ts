import { formatModeSwitchCommand, formatModeSwitchReply, formatUserFacingModeLabel } from "../../../../src/mode/contracts.js";
import type { ToolExecutionClass } from "../../../../src/mode/contracts.js";

export type ModeBlockedToolClass = ToolExecutionClass;

export interface ModeBlockedWaitGuidance {
  prompt: string;
  question: string;
  resumeReply: string;
  resumeCommand: string;
}

export function buildModeBlockedWaitGuidance(input: {
  interactionMode: "chat" | "plan" | "build";
  actSubmode: "strict" | "safe" | "full_auto" | undefined;
  requiredToolClass: ModeBlockedToolClass;
}): ModeBlockedWaitGuidance {
  const requiredMode = modeForToolClass(input.requiredToolClass);
  const resumeCommand = formatModeSwitchCommand(requiredMode);
  const resumeReply = formatModeSwitchReply(requiredMode);
  const requiredModeLabel = formatUserFacingModeLabel(requiredMode);
  const currentMode = formatUserFacingModeLabel({
    interactionMode: input.interactionMode,
  });
  const toolClassLabel =
    input.requiredToolClass === "read_only"
      ? "a read-only tool"
      : input.requiredToolClass === "planning_write"
        ? "a session plan document write tool"
        : input.requiredToolClass === "sandboxed_only"
          ? "a sandboxed tool"
          : "an external side-effect tool";
  const question =
    `You're in '${currentMode}'. Can I switch to '${requiredModeLabel}' so I can use ${toolClassLabel}?`;
  const prompt = [
    `Question: ${question}`,
    `Reply naturally to approve the switch, name the mode, or run: \`${resumeCommand}\``,
    "The run will resume automatically.",
  ].join("\n");

  return {
    prompt,
    question,
    resumeReply,
    resumeCommand,
  };
}

function modeForToolClass(requiredToolClass: ModeBlockedToolClass): {
  interactionMode: "chat" | "plan" | "build";
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
} {
  if (requiredToolClass === "read_only") {
    return { interactionMode: "plan" };
  }
  if (requiredToolClass === "planning_write") {
    return { interactionMode: "plan" };
  }
  return { interactionMode: "build" };
}

export function buildModeBlockedPrompt(input: {
  interactionMode: "chat" | "plan" | "build";
  actSubmode: "strict" | "safe" | "full_auto" | undefined;
  requiredToolClass: ModeBlockedToolClass;
}): string {
  return buildModeBlockedWaitGuidance(input).prompt;
}
