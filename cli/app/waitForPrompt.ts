import type { NormalizedOutput } from "../../src/index.js";
import {
  parseRunnerStructuredReviewInteractionV1,
  runnerStructuredReviewOptionLabel,
  type RunnerStructuredReviewClassificationV1,
} from "@kestrel-agents/protocol";
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
  const review = readExactReview(waitFor);
  return review.kind === "structured_review" ? [...review.allowedOptionIds] : [];
}

export function readExactReview(
  waitFor: PendingWaitFor,
): RunnerStructuredReviewClassificationV1 {
  const review = parseRunnerStructuredReviewInteractionV1(waitFor?.interaction);
  if (review.kind !== "ordinary") return review;
  const reason = waitFor?.metadata?.reason;
  if (reason === "recovery_review" || reason === "evaluation_review") {
    return {
      kind: "invalid_review",
      reason,
      error: "This request cannot be answered safely because its interaction contract is missing.",
    };
  }
  return review;
}

export function resolveExactReviewOptionId(
  waitFor: PendingWaitFor,
  reply: unknown,
): string | undefined {
  if (typeof reply !== "string") return;
  const exactReply = reply.trim();
  const optionIds = readExactReviewOptionIds(waitFor);
  const numericSelection = Number(exactReply);
  if (
    Number.isSafeInteger(numericSelection) &&
    numericSelection >= 1 &&
    numericSelection <= optionIds.length
  ) {
    return optionIds[numericSelection - 1];
  }
  return optionIds.find((optionId) => optionId === exactReply);
}

export function formatExactReviewPrompt(
  waitFor: PendingWaitFor,
  prompt: string | undefined,
): string | undefined {
  const classification = readExactReview(waitFor);
  if (classification.kind === "invalid_review") {
    return `${classification.error} Use /stop to end the waiting run.`;
  }
  const optionIds = readExactReviewOptionIds(waitFor);
  if (optionIds.length === 0) return prompt;
  if (classification.kind !== "structured_review") return prompt;
  const options = classification.allowedOptionIds.map(
    (optionId, index) =>
      `${index + 1}. ${runnerStructuredReviewOptionLabel(classification.reason, optionId)}`,
  );
  return [
    prompt ?? "Choose one option.",
    ...options,
    "Enter a number or the exact option ID. Use /stop to end the waiting run.",
  ].join("\n");
}
