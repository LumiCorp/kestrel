import test from "node:test";
import assert from "node:assert/strict";
import {
  kestrelOneGoogleCalendarCheckAvailabilityTool,
  kestrelOneGoogleCalendarCreateEventTool,
  kestrelOneGoogleCalendarListAvailabilitySubjectsTool,
  kestrelOneGoogleCalendarListEventsTool,
} from "../../tools/kestrelOne/google-calendar.js";


test("Google Calendar writes require external confirmation", () => {
  assert.equal(
    kestrelOneGoogleCalendarCreateEventTool.definition.capability
      .executionClass,
    "external_side_effect"
  );
  assert.deepEqual(
    kestrelOneGoogleCalendarCreateEventTool.definition.capability
      .approvalCapabilities,
    ["network.call", "external.confirm"]
  );
});

test("Google Calendar reads remain read-only and availability is privacy explicit", () => {
  assert.equal(
    kestrelOneGoogleCalendarListEventsTool.definition.capability.executionClass,
    "read_only"
  );
  assert.equal(
    kestrelOneGoogleCalendarListAvailabilitySubjectsTool.definition.description.includes(
      "do not guess subject IDs"
    ),
    true
  );
  assert.equal(
    kestrelOneGoogleCalendarCheckAvailabilityTool.definition.description.includes(
      "never returned"
    ),
    true
  );
});

test("Calendar tool handler uses the execution ticket and omits notifications unless requested", async () => {
  let capturedHeaders: unknown;
  let capturedBody = "";
  const handler = kestrelOneGoogleCalendarCreateEventTool.createHandler({
    runtime: {
      runId: "run-1",
      sessionId: "session-1",
      approvalId: "approval-1",
    },
    kestrelOne: {
      appUrl: "https://app.example.test",
      executionTicket: "signed-ticket",
    },
    fetchImpl: async (_url, init) => {
      capturedHeaders = init?.headers;
      capturedBody = String(init?.body);
      return new Response(
        JSON.stringify({ operation: "events.create", result: {} }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    },
  });
  await handler({
    event: {
      summary: "Planning",
      start: { dateTime: "2026-07-14T13:00:00Z" },
      end: { dateTime: "2026-07-14T13:30:00Z" },
    },
  });
  assert.deepEqual(capturedHeaders, {
    authorization: "Bearer signed-ticket",
    "content-type": "application/json",
    "x-kestrel-approval-id": "approval-1",
  });
  const body = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.equal(body.operation, "events.create");
  assert.equal("notifyAttendees" in body, false);
});

test("Google Calendar reads forward a completed App approval when configured to ask", async () => {
  let capturedHeaders = new Headers();
  const handler = kestrelOneGoogleCalendarListEventsTool.createHandler({
    runtime: {
      runId: "run-1",
      sessionId: "session-1",
      approvalId: "approval-2",
    },
    kestrelOne: {
      appUrl: "https://app.example.test",
      executionTicket: "signed-ticket",
      appApprovalModes: {
        "kestrel_one.google_calendar_list_events": "ask",
      },
    },
    fetchImpl: async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return Response.json({ operation: "events.list", result: {} });
    },
  });

  await handler({
    timeMin: "2026-07-14T00:00:00Z",
    timeMax: "2026-07-15T00:00:00Z",
  });

  assert.equal(capturedHeaders.get("x-kestrel-approval-id"), "approval-2");
});

test("Google Calendar writes cannot lower the canonical ask minimum", async () => {
  const handler = kestrelOneGoogleCalendarCreateEventTool.createHandler({
    kestrelOne: {
      appUrl: "https://app.example.test",
      executionTicket: "signed-ticket",
      appApprovalModes: {
        "kestrel_one.google_calendar_create_event": "auto",
      },
    },
    fetchImpl: async (_url, init) => {
      return Response.json({ operation: "events.create", result: {} });
    },
  });
  await assert.rejects(
    handler({
      event: {
        summary: "Planning",
        start: { dateTime: "2026-07-14T13:00:00Z" },
        end: { dateTime: "2026-07-14T13:30:00Z" },
      },
    }),
    /approval ID/u,
  );
});
