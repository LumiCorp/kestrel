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
  reason?: string | undefined;
}): ModeBlockedWaitGuidance {
  const requiredMode = modeForToolClass(input.requiredToolClass);
  const resumeCommand = formatModeSwitchCommand(requiredMode);
  const resumeReply = formatModeSwitchReply(requiredMode);
  const requiredModeLabel = formatUserFacingModeLabel(requiredMode);
  const currentMode = formatUserFacingModeLabel({
    interactionMode: input.interactionMode,
  });
  const question = currentMode === requiredModeLabel
    ? `I can't perform that action with the current ${currentMode} permissions. Resume it in ${requiredModeLabel}?`
    : `I can't perform that action in ${currentMode}. It requires ${requiredModeLabel}. Switch to ${requiredModeLabel} and resume this action?`;
  const prompt = [
    ...(input.reason !== undefined ? [input.reason.trim(), ""] : []),
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
