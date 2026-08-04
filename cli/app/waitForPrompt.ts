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

export function readExactReviewOptionIds(
  waitFor: PendingWaitFor,
): string[] {
  const reason = waitFor?.metadata?.reason;
  if (reason !== "recovery_review" && reason !== "evaluation_review") return [];
  const inputSchema = asRecord(waitFor?.interaction?.inputSchema);
  const properties = asRecord(inputSchema?.properties);
  const optionSchema = asRecord(properties?.recoveryOptionId);
  const schemaOptions = Array.isArray(optionSchema?.enum)
    ? optionSchema.enum.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  const metadataOptions = Array.isArray(waitFor?.metadata?.allowedOptionIds)
    ? waitFor.metadata.allowedOptionIds.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  return schemaOptions.filter((optionId) => metadataOptions.includes(optionId));
}

export function resolveExactReviewOptionId(
  waitFor: PendingWaitFor,
  reply: unknown,
): string | undefined {
  if (typeof reply !== "string") return;
  const exactReply = reply.trim();
  return readExactReviewOptionIds(waitFor).find(
    (optionId) => optionId === exactReply,
  );
}

export function formatExactReviewPrompt(
  waitFor: PendingWaitFor,
  prompt: string | undefined,
): string | undefined {
  const optionIds = readExactReviewOptionIds(waitFor);
  if (optionIds.length === 0) return prompt;
  return `${prompt ?? "Choose one exact option."} Options: ${optionIds.join(", ")}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
