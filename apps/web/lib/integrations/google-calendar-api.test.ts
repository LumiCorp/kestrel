import assert from "node:assert/strict";
import test from "node:test";
import {
  createGoogleCalendarEvent,
  GoogleCalendarProviderError,
  queryGoogleCalendarFreeBusy,
} from "./google-calendar-api";

test("event creation sends no attendee notifications by default", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  const result = await createGoogleCalendarEvent({
    accessToken: "secret-token",
    event: {
      summary: "Planning",
      start: { dateTime: "2026-07-14T13:00:00Z" },
      end: { dateTime: "2026-07-14T13:30:00Z" },
    },
    notifyAttendees: false,
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      requestedBody = String(init?.body);
      assert.equal(init?.headers && "authorization" in init.headers, true);
      return new Response(
        JSON.stringify({
          id: "event-1",
          summary: "Planning",
          start: { dateTime: "2026-07-14T13:00:00Z" },
          end: { dateTime: "2026-07-14T13:30:00Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });
  assert.equal(new URL(requestedUrl).searchParams.get("sendUpdates"), "none");
  assert.equal(JSON.parse(requestedBody).summary, "Planning");
  assert.equal(result.id, "event-1");
});

test("free/busy returns only normalized intervals", async () => {
  const result = await queryGoogleCalendarFreeBusy({
    accessToken: "secret-token",
    timeMin: "2026-07-14T00:00:00Z",
    timeMax: "2026-07-15T00:00:00Z",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          calendars: {
            primary: {
              busy: [
                {
                  start: "2026-07-14T13:00:00Z",
                  end: "2026-07-14T14:00:00Z",
                  summary: "Private event",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
  });
  assert.deepEqual(result, [
    {
      start: "2026-07-14T13:00:00Z",
      end: "2026-07-14T14:00:00Z",
    },
  ]);
  assert.equal(JSON.stringify(result).includes("Private event"), false);
});

test("provider failures are sanitized and identify reconnect state", async () => {
  await assert.rejects(
    queryGoogleCalendarFreeBusy({
      accessToken: "secret-token",
      timeMin: "2026-07-14T00:00:00Z",
      timeMax: "2026-07-15T00:00:00Z",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "raw private provider error" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarProviderError);
      assert.equal(error.code, "GOOGLE_CALENDAR_RECONNECT_REQUIRED");
      assert.equal(error.reconnectRequired, true);
      assert.equal(error.message.includes("raw private"), false);
      return true;
    }
  );
});
