import { formatUserFacingModeLabel, normalizeInteractionMode } from "../mode/contracts.js";
import {
  parseExplicitModeCommand,
  readUserReplyIntent,
  type UserReplyIntent,
} from "./userReplyIntent.js";

export type BlockedReplyInteractionMode = "chat" | "plan" | "build";
export type BlockedReplyActSubmode = "strict" | "safe" | "full_auto";

export interface WaitForLike {
  eventType?: string | undefined;
  metadata?: unknown;
}

export interface BlockedWaitModeReply {
  interactionMode: BlockedReplyInteractionMode;
  actSubmode?: BlockedReplyActSubmode | undefined;
  acknowledgement: string;
  resumeBlockedRun: true;
}

export function resolveBlockedWaitModeReply(
  waitFor: WaitForLike | undefined,
  reply: unknown,
  intentValue?: unknown,
): BlockedWaitModeReply | undefined {
  if (isModeBlockedWait(waitFor) === false) {
    return undefined;
  }

  const intent = readUserReplyIntent(intentValue);
  const parsed = parseExplicitModeCommand(reply) ?? parseRequestedModeIntent(intent);
  if (parsed === undefined) {
    return undefined;
  }

  const resolved = normalizeInteractionMode({
    interactionMode: parsed.interactionMode,
    actSubmode: parsed.actSubmode,
    defaultInteractionMode: "chat",
    defaultActSubmode: "safe",
  });
  const label = formatUserFacingModeLabel({
    interactionMode: resolved.interactionMode,
  });

  return {
    interactionMode: resolved.interactionMode as BlockedReplyInteractionMode,
    acknowledgement: `Mode set to ${label}. Resuming blocked run.`,
    resumeBlockedRun: true,
  };
}

export function isModeBlockedWait(waitFor: WaitForLike | undefined): boolean {
  const metadata = asRecord(waitFor?.metadata);
  const reason = typeof metadata?.reason === "string" ? metadata.reason : undefined;
  return (
    reason === "route_mode_blocked" ||
    reason === "planner_mode_blocked" ||
    reason === "acter_mode_blocked"
  );
}

function parseRequestedModeIntent(
  intent: UserReplyIntent | undefined,
): { interactionMode: BlockedReplyInteractionMode; actSubmode?: BlockedReplyActSubmode | undefined } | undefined {
  if (
    intent?.kind !== "mode_switch" ||
    intent.proceed !== true ||
    intent.confidence !== "high" ||
    intent.interactionMode === undefined
  ) {
    return undefined;
  }
  return {
    interactionMode: intent.interactionMode,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
