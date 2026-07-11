import { formatModeSwitchCommand, formatModeSwitchReply, formatUserFacingModeLabel } from "../mode/contracts.js";

export interface WaitForLike {
  eventType?: string | undefined;
  metadata?: unknown;
}

export function extractWaitPrompt(waitFor: WaitForLike | undefined): string | undefined {
  if (waitFor === undefined) {
    return undefined;
  }

  const metadata = asRecord(waitFor.metadata);
  return readFirstNonEmptyString(metadata, ["question", "prompt", "text", "message"]);
}

export function extractUserReplyQuestion(waitFor: WaitForLike | undefined): string | undefined {
  if (waitFor?.eventType !== "user.reply") {
    return undefined;
  }

  const metadata = asRecord(waitFor.metadata);
  if (
    metadata?.reason === "max_steps_continuation" ||
    metadata?.reason === "max_model_calls_continuation"
  ) {
    const extraStepsRequested = readPositiveInteger(metadata.extraStepsRequested) ?? 10;
    const extraModelCallsRequested = readPositiveInteger(metadata.extraModelCallsRequested);
    return (
      readFirstNonEmptyString(metadata, ["question"])
      ?? `Should I continue this run with ${formatContinuationBudget(extraStepsRequested, extraModelCallsRequested)}?`
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
    return undefined;
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
  const completedSoFar = readStringArray(metadata.completedSoFar);
  const blockedOn = readFirstNonEmptyString(metadata, ["blockedOn"]) ?? "I need more steps to continue.";
  const nextIfApproved = readStringArray(metadata.nextIfApproved);
  const extraStepsRequested = readPositiveInteger(metadata.extraStepsRequested) ?? 10;
  const extraModelCallsRequested = readPositiveInteger(metadata.extraModelCallsRequested);
  const continuationBudget = formatContinuationBudget(extraStepsRequested, extraModelCallsRequested);

  const question =
    readFirstNonEmptyString(metadata, ["question"])
    ?? `Should I continue this run with ${continuationBudget}?`;
  const lines = ["Waiting for your reply.", question];
  if (completedSoFar.length > 0) {
    lines.push("Completed so far:");
    for (const item of completedSoFar) {
      lines.push(`- ${item}`);
    }
  }
  lines.push(`Blocked on: ${blockedOn}`);
  if (nextIfApproved.length > 0) {
    lines.push(`With ${continuationBudget}, I will:`);
    for (const item of nextIfApproved) {
      lines.push(`- ${item}`);
    }
  }
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
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readFirstNonEmptyString(
  value: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return undefined;
  }
  return Math.max(1, Math.trunc(value));
}

function formatContinuationBudget(
  extraStepsRequested: number,
  extraModelCallsRequested: number | undefined,
): string {
  if (extraModelCallsRequested !== undefined) {
    return `${extraModelCallsRequested} more model calls and ${extraStepsRequested} more steps`;
  }
  return `${extraStepsRequested} more steps`;
}

function buildFallbackModeBlockedQuestion(metadata: Record<string, unknown>): string {
  const requiredToolClass = readFirstNonEmptyString(metadata, ["requiredToolClass"]) ?? "read_only";
  const currentMode =
    readFirstNonEmptyString(metadata, ["currentMode"])
    ?? "the current mode";
  const requiredMode = modeForToolClass(requiredToolClass);
  const toolClassLabel =
    requiredToolClass === "read_only"
      ? "a read-only tool"
      : requiredToolClass === "sandboxed_only"
        ? "a sandboxed tool"
        : "an external side-effect tool";
  return `You're in '${formatRawModeLabel(currentMode)}'. Can I switch to '${formatUserFacingModeLabel(requiredMode)}' so I can use ${toolClassLabel}?`;
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
