import assert from "node:assert/strict";
import test from "node:test";
import { resolveDashboardPeriod } from "./contracts";

test("month-to-date compares the same elapsed duration in the previous month", () => {
  const period = resolveDashboardPeriod(
    "mtd",
    new Date("2026-07-22T15:30:00Z")
  );
  assert.equal(period.startedAt.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(
    period.comparisonStartedAt.toISOString(),
    "2026-06-01T00:00:00.000Z"
  );
  assert.equal(
    period.comparisonEndedAt.toISOString(),
    "2026-06-22T15:30:00.000Z"
  );
});

test("rolling dashboard periods use an equal preceding window", () => {
  const period = resolveDashboardPeriod(
    "7d",
    new Date("2026-07-22T12:00:00Z")
  );
  assert.equal(period.startedAt.toISOString(), "2026-07-15T12:00:00.000Z");
  assert.equal(
    period.comparisonStartedAt.toISOString(),
    "2026-07-08T12:00:00.000Z"
  );
  assert.equal(
    period.comparisonEndedAt.toISOString(),
    "2026-07-15T12:00:00.000Z"
  );
});
