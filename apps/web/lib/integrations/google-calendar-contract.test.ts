import assert from "node:assert/strict";
import {
  assertGoogleCalendarRange,
  GOOGLE_CALENDAR_SCOPES,
  googleCalendarRuntimeInputSchema,
  hasRequiredGoogleCalendarScopes,
  intersectGoogleCalendarApprovalModes,
  parseGoogleOAuthScopes,
  shouldStartGoogleCalendarOAuth,
} from "./google-calendar-contract";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Google Calendar requires only the selected Calendar scopes", () => {
  const scopes = parseGoogleOAuthScopes(GOOGLE_CALENDAR_SCOPES.join(" "));
  assert.equal(hasRequiredGoogleCalendarScopes(scopes), true);
  assert.equal(hasRequiredGoogleCalendarScopes(scopes.slice(0, -1)), false);
  assert.equal(
    scopes.some((scope) => scope.includes("gmail")),
    false
  );
  assert.equal(
    scopes.some((scope) => scope.includes("drive")),
    false
  );
});

contractTest("web.hermetic", "degraded Calendar connections always restart Google OAuth", () => {
  assert.equal(
    shouldStartGoogleCalendarOAuth({
      scopes: GOOGLE_CALENDAR_SCOPES,
      connectionStatus: "connected",
    }),
    false
  );
  assert.equal(
    shouldStartGoogleCalendarOAuth({
      scopes: GOOGLE_CALENDAR_SCOPES,
      connectionStatus: "degraded",
    }),
    true
  );
  assert.equal(
    shouldStartGoogleCalendarOAuth({
      scopes: GOOGLE_CALENDAR_SCOPES.slice(0, -1),
      connectionStatus: "connected",
    }),
    true
  );
});

contractTest("web.hermetic", "Project Calendar policy can restrict but never widen Environment approval", () => {
  assert.equal(
    intersectGoogleCalendarApprovalModes({
      environmentMode: "deny",
      restrictionModes: ["auto"],
      writeRequiresApproval: false,
    }),
    "deny"
  );
  assert.equal(
    intersectGoogleCalendarApprovalModes({
      environmentMode: "ask",
      restrictionModes: ["auto"],
      writeRequiresApproval: false,
    }),
    "ask"
  );
  assert.equal(
    intersectGoogleCalendarApprovalModes({
      environmentMode: "auto",
      restrictionModes: [],
      writeRequiresApproval: true,
    }),
    "ask"
  );
});

contractTest("web.hermetic", "attendee notifications default off", () => {
  const parsed = googleCalendarRuntimeInputSchema.parse({
    operation: "events.create",
    event: {
      summary: "Planning",
      start: { dateTime: "2026-07-14T13:00:00Z" },
      end: { dateTime: "2026-07-14T13:30:00Z" },
      attendees: [{ email: "teammate@example.com" }],
    },
  });
  assert.equal(parsed.operation, "events.create");
  assert.equal(parsed.notifyAttendees, false);
});

contractTest("web.hermetic", "Calendar inputs reject mixed all-day/timed events and oversized ranges", () => {
  assert.throws(() =>
    googleCalendarRuntimeInputSchema.parse({
      operation: "events.create",
      event: {
        summary: "Invalid",
        start: { date: "2026-07-14" },
        end: { dateTime: "2026-07-15T00:00:00Z" },
      },
    })
  );
  assert.throws(
    () =>
      assertGoogleCalendarRange({
        timeMin: "2026-07-01T00:00:00Z",
        timeMax: "2026-08-02T00:00:00Z",
      }),
    /31 days/u
  );
});

contractTest("web.hermetic", "availability inputs use opaque UUID subjects and enforce the subject cap", () => {
  assert.throws(() =>
    googleCalendarRuntimeInputSchema.parse({
      operation: "availability.query",
      subjectIds: ["teammate@example.com"],
      timeMin: "2026-07-14T00:00:00Z",
      timeMax: "2026-07-15T00:00:00Z",
    })
  );
  assert.throws(() =>
    googleCalendarRuntimeInputSchema.parse({
      operation: "availability.query",
      subjectIds: Array.from(
        { length: 21 },
        () => "ba3c7d62-c01d-4cad-ac8c-6c73f4163a58"
      ),
      timeMin: "2026-07-14T00:00:00Z",
      timeMax: "2026-07-15T00:00:00Z",
    })
  );
});
