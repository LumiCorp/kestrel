export const PREPARED_APPROVAL_CLEANUP_RETRY_BASE_SECONDS = 5;
export const PREPARED_APPROVAL_CLEANUP_RETRY_MAX_SECONDS = 5 * 60;

export type PreparedApprovalCleanupRetrySchedule = {
  attempt: number;
  delaySeconds: number;
  startAfter: Date;
};

export function nextPreparedApprovalCleanupRetrySchedule(input: {
  previousAttempt: unknown;
  nowMs: number;
}): PreparedApprovalCleanupRetrySchedule {
  const previousAttempt =
    typeof input.previousAttempt === "number" &&
      Number.isSafeInteger(input.previousAttempt) &&
      input.previousAttempt >= 1
      ? input.previousAttempt
      : 0;
  const attempt = previousAttempt + 1;
  const delaySeconds = Math.min(
    PREPARED_APPROVAL_CLEANUP_RETRY_MAX_SECONDS,
    PREPARED_APPROVAL_CLEANUP_RETRY_BASE_SECONDS *
      (2 ** Math.min(attempt - 1, 16)),
  );
  return {
    attempt,
    delaySeconds,
    startAfter: new Date(input.nowMs + delaySeconds * 1000),
  };
}
