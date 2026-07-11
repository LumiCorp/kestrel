import type { NormalizedOutput } from "../../src/index.js";
import {
  buildWaitingText as buildSharedWaitingText,
  extractWaitPrompt as extractSharedWaitPrompt,
  type WaitForLike,
} from "../../src/runtime/waitForPrompt.js";
import {
  isModeBlockedWait as isSharedModeBlockedWait,
  resolveBlockedWaitModeReply as resolveSharedBlockedWaitModeReply,
  type BlockedWaitModeReply,
} from "../../src/runtime/blockedWaitModeReply.js";

type PendingWaitFor = Exclude<NormalizedOutput["waitFor"], undefined> | undefined;

export function extractWaitPrompt(waitFor: PendingWaitFor): string | undefined {
  return extractSharedWaitPrompt(waitFor as WaitForLike | undefined);
}

export function buildWaitingSystemText(waitFor: PendingWaitFor): string {
  return buildSharedWaitingText(waitFor as WaitForLike | undefined);
}

export function resolveBlockedWaitModeReply(
  waitFor: PendingWaitFor,
  reply: unknown,
  intentValue?: unknown,
): BlockedWaitModeReply | undefined {
  return resolveSharedBlockedWaitModeReply(waitFor, reply, intentValue);
}

export function isModeBlockedWait(waitFor: PendingWaitFor): boolean {
  return isSharedModeBlockedWait(waitFor);
}
