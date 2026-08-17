import { formatModeSwitchCommand, formatModeSwitchReply, formatUserFacingModeLabel } from "../mode/contracts.js";

export interface WaitForLike {
  eventType?: string | undefined;
  metadata?: unknown;
  prompt?: unknown;
}

export function extractWaitPrompt(waitFor: WaitForLike | undefined): string | undefined {
  if (waitFor === undefined) {
    return ;
  }

  const metadata = asRecord(waitFor.metadata);
  const metadataPrompt = readFirstNonEmptyString(metadata, ["question", "prompt", "text", "message"]);
  if (metadataPrompt !== undefined) {
    return metadataPrompt;
  }
  return typeof waitFor.prompt === "string" && waitFor.prompt.trim().length > 0
    ? waitFor.prompt.trim()
    : undefined;
}

export function extractUserReplyQuestion(waitFor: WaitForLike | undefined): string | undefined {
  if (waitFor?.eventType !== "user.reply") {
    return ;
  }

  const metadata = asRecord(waitFor.metadata);
  if (
    metadata?.reason === "max_steps_continuation" ||
    metadata?.reason === "max_model_calls_continuation"
  ) {
    return (
      readFirstNonEmptyString(metadata, ["question"])
      ?? "I’m not finished yet, but I can continue from where I left off. Want me to keep going?"
    );
  }

  if (
    metadata?.reason === "route_mode_blocked" ||
    metadata?.reason === "planner_mode_blocked" ||
    metadata?.reason === "acter_mode_blocked"
  ) {
    return readFirstNonEmptyString(metadata, ["question"]) ?? buildFallbackModeBlockedQuestion(metadata);
  }

  return extractWaitPrompt(waitFor);
}

export function extractWaitDetail(waitFor: WaitForLike | undefined): string | undefined {
  if (waitFor?.eventType !== "user.reply") {
    return ;
  }

  const metadata = asRecord(waitFor.metadata);
  const reason = readFirstNonEmptyString(metadata, ["reason"]);
  if (
    reason === "route_mode_blocked" ||
    reason === "planner_mode_blocked" ||
    reason === "acter_mode_blocked"
  ) {
    const resumeReply =
      readFirstNonEmptyString(metadata, ["resumeReply"])
      ?? buildFallbackModeBlockedReply(metadata ?? {});
    const resumeCommand =
      readFirstNonEmptyString(metadata, ["resumeCommand"])
      ?? buildFallbackModeBlockedCommand(metadata ?? {});
    return `Reply naturally to approve the switch, name the mode, or run: \`${resumeCommand}\``;
  }

  if (metadata === undefined) {
    return "Reply in chat to resume the run.";
  }

  const resumeReply = readFirstNonEmptyString(metadata, ["resumeReply"]);
  const resumeCommand = readFirstNonEmptyString(metadata, ["resumeCommand"]);
  if (resumeReply !== undefined && resumeCommand !== undefined) {
    return `Reply naturally or run: \`${resumeCommand}\``;
  }
  if (resumeReply !== undefined) {
    return `Reply naturally to continue, or say: \`${resumeReply}\``;
  }
  if (resumeCommand !== undefined) {
    return `Run: \`${resumeCommand}\``;
  }
  return "Reply in chat with the requested information to resume the run.";
}

export function buildWaitingText(waitFor: WaitForLike | undefined): string {
  const waitEvent = waitFor?.eventType ?? "unknown";
  const metadata = asRecord(waitFor?.metadata);
  if (
    metadata?.reason === "max_steps_continuation" ||
    metadata?.reason === "max_model_calls_continuation"
  ) {
    return buildContinuationWaitingText(waitEvent, metadata);
  }
  if (
    metadata?.reason === "route_mode_blocked" ||
    metadata?.reason === "planner_mode_blocked" ||
    metadata?.reason === "acter_mode_blocked"
  ) {
    return buildModeBlockedWaitingText(waitEvent, metadata);
  }
  const prompt = extractWaitPrompt(waitFor);
  const detail = extractWaitDetail(waitFor);
  if (waitEvent === "user.reply") {
    const lines = ["Waiting for your reply."];
    if (prompt !== undefined) {
      lines.push(prompt);
    }
    lines.push(detail ?? "Reply in chat to resume the run.");
    return lines.join("\n");
  }
  if (prompt === undefined) {
    return `Waiting for '${waitEvent}'. Enter input to resume.`;
  }
  return `Waiting for '${waitEvent}'. ${prompt} Enter input to resume.`;
}

function buildContinuationWaitingText(
  waitEvent: string,
  metadata: Record<string, unknown>,
): string {
  const question =
    readFirstNonEmptyString(metadata, ["question"])
    ?? "I’m not finished yet, but I can continue from where I left off. Want me to keep going?";
  const lines = ["Waiting for your reply.", question];
  lines.push(
    extractWaitDetail({
      eventType: waitEvent,
      metadata: {
        ...metadata,
        resumeReply: readFirstNonEmptyString(metadata, ["resumeReply"]) ?? "continue",
      },
    }) ?? "Reply naturally to continue.",
  );
  return lines.join("\n");
}

function buildModeBlockedWaitingText(
  waitEvent: string,
  metadata: Record<string, unknown>,
): string {
  const question =
    readFirstNonEmptyString(metadata, ["question"])
    ?? buildFallbackModeBlockedQuestion(metadata);
  const detail =
    extractWaitDetail({
      eventType: waitEvent,
      metadata: {
        ...metadata,
        ...(readFirstNonEmptyString(metadata, ["resumeReply"]) !== undefined
          ? {}
          : { resumeReply: buildFallbackModeBlockedReply(metadata) }),
        ...(readFirstNonEmptyString(metadata, ["resumeCommand"]) !== undefined
          ? {}
          : { resumeCommand: buildFallbackModeBlockedCommand(metadata) }),
      },
    })
    ?? "Reply in chat to resume the run.";
  return [
    "Waiting for your reply.",
    question,
    detail,
    "The run will resume automatically.",
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function readFirstNonEmptyString(
  value: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (value === undefined) {
    return ;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return ;
}

function buildFallbackModeBlockedQuestion(metadata: Record<string, unknown>): string {
  const requiredToolClass = readFirstNonEmptyString(metadata, ["requiredToolClass"]) ?? "read_only";
  const currentMode =
    readFirstNonEmptyString(metadata, ["currentMode"])
    ?? "the current mode";
  const requiredMode = modeForToolClass(requiredToolClass);
  const currentModeLabel = formatRawModeLabel(currentMode);
  const requiredModeLabel = formatUserFacingModeLabel(requiredMode);
  return currentModeLabel === requiredModeLabel
    ? `I can't perform that action with the current ${currentModeLabel} permissions. Resume it in ${requiredModeLabel}?`
    : `I can't perform that action in ${currentModeLabel}. It requires ${requiredModeLabel}. Switch to ${requiredModeLabel} and resume this action?`;
}

function buildFallbackModeBlockedReply(metadata: Record<string, unknown>): string {
  const requiredToolClass = readFirstNonEmptyString(metadata, ["requiredToolClass"]) ?? "read_only";
  return formatModeSwitchReply(modeForToolClass(requiredToolClass));
}

function buildFallbackModeBlockedCommand(metadata: Record<string, unknown>): string {
  const requiredToolClass = readFirstNonEmptyString(metadata, ["requiredToolClass"]) ?? "read_only";
  return formatModeSwitchCommand(modeForToolClass(requiredToolClass));
}

function modeForToolClass(requiredToolClass: string): {
  interactionMode: "chat" | "plan" | "build";
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
} {
  if (requiredToolClass === "read_only") {
    return { interactionMode: "plan" };
  }
  return { interactionMode: "build" };
}

function formatRawModeLabel(value: string): string {
  if (value === "chat") {
    return "Chat";
  }
  if (value === "plan") {
    return "Plan";
  }
  if (
    value === "build" ||
    // Legacy input normalization only; mode switch replies emit "build".
    value === "act" ||
    value === "act.strict" ||
    value === "act.safe" ||
    value === "act.full_auto" ||
    value === "act.full-auto"
  ) {
    return "Build";
  }
  return value;
}
