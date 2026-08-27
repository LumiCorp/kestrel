import test from "node:test";
import assert from "node:assert/strict";

import {
  nextPreparedApprovalCleanupRetrySchedule,
  PREPARED_APPROVAL_CLEANUP_RETRY_MAX_SECONDS,
} from "./prepared-approval-cleanup-retry";

test("persistent cleanup failures back off and success schedules no successor", () => {
  const nowMs = Date.parse("2026-08-27T12:00:00.000Z");
  const scheduled = [];
  let previousAttempt: number | undefined;
  for (const outcome of ["failed", "failed", "failed", "completed"] as const) {
    if (outcome === "completed") continue;
    const retry = nextPreparedApprovalCleanupRetrySchedule({
      previousAttempt,
      nowMs,
    });
    scheduled.push(retry);
    previousAttempt = retry.attempt;
  }

  assert.deepEqual(
    scheduled.map(({ attempt, delaySeconds }) => ({ attempt, delaySeconds })),
    [
      { attempt: 1, delaySeconds: 5 },
      { attempt: 2, delaySeconds: 10 },
      { attempt: 3, delaySeconds: 20 },
    ],
  );
  assert.deepEqual(
    scheduled.map(({ startAfter }) => startAfter.toISOString()),
    [
      "2026-08-27T12:00:05.000Z",
      "2026-08-27T12:00:10.000Z",
      "2026-08-27T12:00:20.000Z",
    ],
  );
  assert.equal(scheduled.length, 3);
});

test("cleanup retry backoff remains bounded during a persistent outage", () => {
  let previousAttempt: number | undefined;
  let latest = nextPreparedApprovalCleanupRetrySchedule({
    previousAttempt,
    nowMs: 0,
  });
  for (let index = 0; index < 24; index += 1) {
    previousAttempt = latest.attempt;
    latest = nextPreparedApprovalCleanupRetrySchedule({
      previousAttempt,
      nowMs: 0,
    });
  }
  assert.equal(latest.delaySeconds, PREPARED_APPROVAL_CLEANUP_RETRY_MAX_SECONDS);
  assert.equal(
    latest.startAfter.toISOString(),
    "1970-01-01T00:05:00.000Z",
  );
});
