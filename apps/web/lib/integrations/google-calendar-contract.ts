import { z } from "zod";

export const GOOGLE_WORKSPACE_PROVIDER_KEY = "google_workspace";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
] as const;

export const GOOGLE_CALENDAR_CAPABILITIES = [
  "calendar.events.read",
  "calendar.events.create",
  "calendar.events.update",
  "calendar.events.delete",
  "calendar.availability.subjects",
  "calendar.availability.read",
] as const;

export type GoogleCalendarCapability =
  (typeof GOOGLE_CALENDAR_CAPABILITIES)[number];

export type GoogleCalendarApprovalMode = "auto" | "ask" | "deny";

export const GOOGLE_CALENDAR_WRITE_CAPABILITIES = [
  "calendar.events.create",
  "calendar.events.update",
  "calendar.events.delete",
] as const satisfies readonly GoogleCalendarCapability[];

export const googleCalendarConnectionInputSchema = z.object({
  calendar: z.literal(true),
  shareAvailability: z.boolean().default(false),
});

export const googleCalendarSharingInputSchema = z.object({
  shareAvailability: z.boolean(),
});

const isoDateTimeSchema = z.string().datetime({ offset: true });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const googleCalendarEventTimeSchema = z.union([
  z.object({
    dateTime: isoDateTimeSchema,
    timeZone: z.string().trim().min(1).max(128).optional(),
  }),
  z.object({ date: dateSchema }),
]);

const attendeeSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().trim().min(1).max(256).optional(),
});

const eventFieldsSchema = z
  .object({
    summary: z.string().trim().min(1).max(1024),
    description: z.string().max(8192).optional(),
    location: z.string().max(1024).optional(),
    start: googleCalendarEventTimeSchema,
    end: googleCalendarEventTimeSchema,
    attendees: z.array(attendeeSchema).max(100).optional(),
  })
  .refine((event) => eventTimeKindsMatch(event.start, event.end), {
    message:
      "Calendar event start and end must both be timed or both be all-day.",
  })
  .refine((event) => eventEndIsAfterStart(event.start, event.end), {
    message: "Calendar event end must be after its start.",
  });

const eventPatchSchema = z
  .object({
    summary: z.string().trim().min(1).max(1024).optional(),
    description: z.string().max(8192).nullable().optional(),
    location: z.string().max(1024).nullable().optional(),
    start: googleCalendarEventTimeSchema.optional(),
    end: googleCalendarEventTimeSchema.optional(),
    attendees: z.array(attendeeSchema).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one event field must be supplied.",
  });

const eventIdSchema = z.string().trim().min(1).max(1024);

export const googleCalendarRuntimeInputSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({
      operation: z.literal("events.list"),
      timeMin: isoDateTimeSchema,
      timeMax: isoDateTimeSchema,
      maxResults: z.number().int().min(1).max(100).default(50),
    }),
    z.object({
      operation: z.literal("events.create"),
      event: eventFieldsSchema,
      notifyAttendees: z.boolean().default(false),
    }),
    z.object({
      operation: z.literal("events.update"),
      eventId: eventIdSchema,
      patch: eventPatchSchema,
      notifyAttendees: z.boolean().default(false),
    }),
    z.object({
      operation: z.literal("events.delete"),
      eventId: eventIdSchema,
      notifyAttendees: z.boolean().default(false),
    }),
    z.object({
      operation: z.literal("availability.subjects"),
    }),
    z.object({
      operation: z.literal("availability.query"),
      subjectIds: z.array(z.string().uuid()).min(1).max(20),
      timeMin: isoDateTimeSchema,
      timeMax: isoDateTimeSchema,
    }),
  ]
);

export type GoogleCalendarRuntimeInput = z.infer<
  typeof googleCalendarRuntimeInputSchema
>;

export function parseGoogleOAuthScopes(scope: string | null | undefined) {
  return (scope ?? "")
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hasRequiredGoogleCalendarScopes(scopes: readonly string[]) {
  const granted = new Set(scopes);
  return GOOGLE_CALENDAR_SCOPES.every((scope) => granted.has(scope));
}

export function shouldStartGoogleCalendarOAuth(input: {
  scopes: readonly string[];
  connectionStatus: "connected" | "degraded" | "disconnected" | null;
}) {
  return (
    input.connectionStatus === "degraded" ||
    !hasRequiredGoogleCalendarScopes(input.scopes)
  );
}

export function capabilityForGoogleCalendarOperation(
  operation: GoogleCalendarRuntimeInput["operation"]
): GoogleCalendarCapability {
  if (operation === "events.list") return "calendar.events.read";
  if (operation === "events.create") return "calendar.events.create";
  if (operation === "events.update") return "calendar.events.update";
  if (operation === "events.delete") return "calendar.events.delete";
  if (operation === "availability.subjects") {
    return "calendar.availability.subjects";
  }
  return "calendar.availability.read";
}

export function requiresGoogleCalendarApproval(
  capability: GoogleCalendarCapability
) {
  return (GOOGLE_CALENDAR_WRITE_CAPABILITIES as readonly string[]).includes(
    capability
  );
}

export function intersectGoogleCalendarApprovalModes(input: {
  environmentMode: GoogleCalendarApprovalMode;
  restrictionModes: readonly GoogleCalendarApprovalMode[];
  writeRequiresApproval: boolean;
}): GoogleCalendarApprovalMode {
  const modes = [
    input.environmentMode,
    ...input.restrictionModes,
    ...(input.writeRequiresApproval ? (["ask"] as const) : []),
  ];
  if (modes.includes("deny")) return "deny";
  return modes.includes("ask") ? "ask" : "auto";
}

export function assertGoogleCalendarRange(input: {
  timeMin: string;
  timeMax: string;
}) {
  const start = Date.parse(input.timeMin);
  const end = Date.parse(input.timeMax);
  const maximumRangeMs = 31 * 24 * 60 * 60 * 1000;
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
    throw new Error("Calendar timeMax must be after timeMin.");
  }
  if (end - start > maximumRangeMs) {
    throw new Error("Calendar queries are limited to 31 days.");
  }
}

function eventTimeKindsMatch(
  start: z.infer<typeof googleCalendarEventTimeSchema>,
  end: z.infer<typeof googleCalendarEventTimeSchema>
) {
  return "date" in start === "date" in end;
}

function eventEndIsAfterStart(
  start: z.infer<typeof googleCalendarEventTimeSchema>,
  end: z.infer<typeof googleCalendarEventTimeSchema>
) {
  const startValue = "date" in start ? start.date : start.dateTime;
  const endValue = "date" in end ? end.date : end.dateTime;
  return Date.parse(endValue) > Date.parse(startValue);
}
