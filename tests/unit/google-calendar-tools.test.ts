import assert from "node:assert/strict";
import {
  kestrelOneGoogleCalendarCheckAvailabilityTool,
  kestrelOneGoogleCalendarCreateEventTool,
  kestrelOneGoogleCalendarListAvailabilitySubjectsTool,
  kestrelOneGoogleCalendarListEventsTool,
} from "../../tools/kestrelOne/google-calendar.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "Google Calendar writes require external confirmation", () => {
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

contractTest("runtime.hermetic", "Google Calendar reads remain read-only and availability is privacy explicit", () => {
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

contractTest("runtime.hermetic", "Calendar tool handler uses the execution ticket and omits notifications unless requested", async () => {
  let capturedHeaders: unknown;
  let capturedBody = "";
  const handler = kestrelOneGoogleCalendarCreateEventTool.createHandler({
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
    "x-kestrel-runtime-approval": "confirmed",
  });
  const body = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.equal(body.operation, "events.create");
  assert.equal("notifyAttendees" in body, false);
});

contractTest("runtime.hermetic", "Google Calendar reads forward a completed App approval when configured to ask", async () => {
  let capturedHeaders = new Headers();
  const handler = kestrelOneGoogleCalendarListEventsTool.createHandler({
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

  assert.equal(
    capturedHeaders.get("x-kestrel-runtime-approval"),
    "confirmed"
  );
});
