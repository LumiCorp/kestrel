import assert from "node:assert/strict";
import test from "node:test";
import { scheduleOperationalStatus } from "./schedule-status";

const run = (
  status: "queued" | "materialized" | "failed" | "cancelled",
  turnStatus:
    | "queued"
    | "running"
    | "waiting_for_input"
    | "completed"
    | "failed"
    | "cancelled"
    | null,
) => ({ status, turnStatus });

test("schedule status prioritizes active and actionable execution state", () => {
  assert.equal(
    scheduleOperationalStatus({
      enabled: false,
      activeStatus: "waiting_for_input",
      latestRun: run("materialized", "waiting_for_input"),
    }),
    "Needs input",
  );
  assert.equal(
    scheduleOperationalStatus({
      enabled: false,
      activeStatus: "running",
      latestRun: run("materialized", "running"),
    }),
    "Running",
  );
  assert.equal(
    scheduleOperationalStatus({
      enabled: true,
      activeStatus: "running",
      latestRun: run("queued", null),
    }),
    "Running",
  );
});

test("schedule status settles to paused, failed, or scheduled", () => {
  assert.equal(
    scheduleOperationalStatus({
      enabled: false,
      activeStatus: null,
      latestRun: run("failed", "failed"),
    }),
    "Paused",
  );
  assert.equal(
    scheduleOperationalStatus({
      enabled: true,
      activeStatus: null,
      latestRun: run("failed", null),
    }),
    "Failed",
  );
  assert.equal(
    scheduleOperationalStatus({
      enabled: true,
      activeStatus: null,
      latestRun: run("materialized", "completed"),
    }),
    "Scheduled",
  );
  assert.equal(
    scheduleOperationalStatus({
      enabled: true,
      activeStatus: null,
      latestRun: run("materialized", "cancelled"),
    }),
    "Scheduled",
  );
  assert.equal(
    scheduleOperationalStatus({
      enabled: true,
      activeStatus: null,
      latestRun: null,
    }),
    "Scheduled",
  );
});

test("schedule status aggregates active state independently of the latest run", () => {
  assert.equal(
    scheduleOperationalStatus({
      enabled: true,
      activeStatus: "waiting_for_input",
      latestRun: run("materialized", "completed"),
    }),
    "Needs input",
  );
  assert.equal(
    scheduleOperationalStatus({
      enabled: false,
      activeStatus: "running",
      latestRun: run("materialized", "failed"),
    }),
    "Running",
  );
});
