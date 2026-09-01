import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleCalendarPageCursor, readGoogleCalendarPageCursor } from "../../src/apps/googleCalendarPaging.js";

const secret = "google-calendar-cursor-secret-for-tests";
const context = {
  accountId: "account-1",
  projectId: "project-1",
  timeMin: "2026-08-27T00:00:00.000Z",
  timeMax: "2026-08-28T00:00:00.000Z",
  maxResults: 50,
};

test("Google Calendar cursors hide and bind provider page tokens", () => {
  const cursor = createGoogleCalendarPageCursor({ secret, context, pageToken: "provider-page-token", now: 1000 });
  assert.doesNotMatch(cursor, /provider-page-token/u);
  assert.deepEqual(readGoogleCalendarPageCursor({ secret, cursor, context, now: 1001 }), { pageToken: "provider-page-token" });
  assert.throws(() => readGoogleCalendarPageCursor({ secret, cursor, context: { ...context, timeMax: "2026-08-29T00:00:00.000Z" }, now: 1001 }), /does not match/u);
});

test("Google Calendar cursors reject tampering and expiry", () => {
  const cursor = createGoogleCalendarPageCursor({ secret, context, pageToken: "provider-page-token", now: 1000 });
  assert.throws(() => readGoogleCalendarPageCursor({ secret, cursor: `${cursor}x`, context, now: 1001 }), /invalid/u);
  assert.throws(() => readGoogleCalendarPageCursor({ secret, cursor, context, now: 1000 + 15 * 60 * 1000 }), /does not match/u);
});
