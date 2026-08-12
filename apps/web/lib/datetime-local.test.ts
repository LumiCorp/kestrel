import assert from "node:assert/strict";
import test from "node:test";
import {
  isoInstantToLocalDateTimeInput,
  localDateTimeInputToIsoInstant,
} from "./datetime-local";

function restoreTimezone(value: string | undefined) {
  if (value === undefined) {
    delete process.env.TZ;
    return;
  }
  process.env.TZ = value;
}

test("datetime-local values round-trip through the browser's local timezone", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(
      isoInstantToLocalDateTimeInput("2026-08-13T14:00:45.123Z"),
      "2026-08-13T10:00",
    );
    assert.equal(
      localDateTimeInputToIsoInstant("2026-08-13T10:00"),
      "2026-08-13T14:00:00.000Z",
    );
  } finally {
    restoreTimezone(originalTimezone);
  }
});

test("datetime-local conversion honors standard and daylight-saving offsets", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(
      isoInstantToLocalDateTimeInput("2026-01-15T14:30:00.000Z"),
      "2026-01-15T09:30",
    );
    assert.equal(
      isoInstantToLocalDateTimeInput("2026-07-15T14:30:00.000Z"),
      "2026-07-15T10:30",
    );
  } finally {
    restoreTimezone(originalTimezone);
  }
});

test("datetime-local conversion supports no expiration and rejects invalid local times", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(isoInstantToLocalDateTimeInput(null), "");
    assert.equal(localDateTimeInputToIsoInstant(""), null);
    assert.throws(
      () => localDateTimeInputToIsoInstant("2026-03-08T02:30"),
      /valid local date and time/u,
    );
  } finally {
    restoreTimezone(originalTimezone);
  }
});
