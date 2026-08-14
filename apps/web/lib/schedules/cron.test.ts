import assert from "node:assert/strict";
import test from "node:test";
import {
  latestDueProjectPromptScheduleOccurrence,
  nextProjectPromptScheduleOccurrence,
  ProjectPromptScheduleCronError,
  validateProjectPromptSchedule,
} from "./cron";

test("schedule cron accepts standard five-field expressions including every minute", () => {
  assert.deepEqual(
    validateProjectPromptSchedule({
      cronExpression: "  *   * * * * ",
      timeZone: "America/New_York",
    }),
    { cronExpression: "* * * * *", timeZone: "America/New_York" },
  );
});

test("schedule cron rejects seconds fields and invalid timezones", () => {
  assert.throws(
    () =>
      validateProjectPromptSchedule({
        cronExpression: "0 * * * * *",
        timeZone: "UTC",
      }),
    ProjectPromptScheduleCronError,
  );
  assert.throws(
    () =>
      validateProjectPromptSchedule({
        cronExpression: "0 9 * * 1",
        timeZone: "Not/A_Zone",
      }),
    ProjectPromptScheduleCronError,
  );
});

test("schedule cron calculates through daylight-saving transitions", () => {
  const springForward = nextProjectPromptScheduleOccurrence({
    cronExpression: "30 9 * * *",
    timeZone: "America/New_York",
    after: new Date("2026-03-07T14:31:00.000Z"),
  });
  assert.equal(springForward.toISOString(), "2026-03-08T13:30:00.000Z");

  const fallBack = nextProjectPromptScheduleOccurrence({
    cronExpression: "30 9 * * *",
    timeZone: "America/New_York",
    after: new Date("2026-10-31T15:00:00.000Z"),
  });
  assert.equal(fallBack.toISOString(), "2026-11-01T14:30:00.000Z");
});

test("schedule cron coalesces an outage into the latest due occurrence", () => {
  const result = latestDueProjectPromptScheduleOccurrence({
    cronExpression: "0 * * * *",
    timeZone: "UTC",
    firstDueAt: new Date("2026-08-13T10:00:00.000Z"),
    now: new Date("2026-08-13T13:27:00.000Z"),
  });
  assert.equal(result?.scheduledFor.toISOString(), "2026-08-13T13:00:00.000Z");
  assert.equal(result?.nextRunAt.toISOString(), "2026-08-13T14:00:00.000Z");
  assert.equal(result?.catchUpFrom?.toISOString(), "2026-08-13T10:00:00.000Z");
});
