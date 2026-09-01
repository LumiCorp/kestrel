import assert from "node:assert/strict";
import test from "node:test";

import { browserWorkerRunningSeconds } from "./browser-worker-usage";

const startedAt = new Date("2026-08-30T10:00:00.000Z");
const endedAt = new Date("2026-08-30T11:00:00.000Z");

test("meters a full persisted Browser worker hour", () => {
  assert.equal(
    browserWorkerRunningSeconds({
      createdAt: new Date("2026-08-30T09:00:00.000Z"),
      cleanupConfirmedAt: null,
      startedAt,
      endedAt,
    }),
    3600,
  );
});

test("meters only the durable Browser worker lifecycle overlap", () => {
  assert.equal(
    browserWorkerRunningSeconds({
      createdAt: new Date("2026-08-30T10:15:00.000Z"),
      cleanupConfirmedAt: new Date("2026-08-30T10:45:00.000Z"),
      startedAt,
      endedAt,
    }),
    1800,
  );
});

test("does not meter a Browser worker outside the hour", () => {
  assert.equal(
    browserWorkerRunningSeconds({
      createdAt: new Date("2026-08-30T09:00:00.000Z"),
      cleanupConfirmedAt: new Date("2026-08-30T09:30:00.000Z"),
      startedAt,
      endedAt,
    }),
    0,
  );
});
