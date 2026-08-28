import { z } from "zod";
import {
  GOOGLE_WORKSPACE_PACK_SCOPES,
  GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS,
  googleWorkspaceOperationHasRequiredScopes,
  googleWorkspaceMinimumApprovalMode,
  googleWorkspaceOperationDescriptor,
  resourceScopesForGoogleWorkspacePacks,
  scopesForGoogleWorkspacePacks,
  type GoogleWorkspacePack,
} from "../../../../src/apps/googleWorkspace.js";

export const GOOGLE_WORKSPACE_PROVIDER_KEY = "google_workspace";

export const GOOGLE_WORKSPACE_PACKS = [
  "calendar",
  "gmail",
] as const satisfies readonly GoogleWorkspacePack[];
export type GoogleWorkspaceConnectionPack =
  (typeof GOOGLE_WORKSPACE_PACKS)[number];

export const GOOGLE_GMAIL_SCOPES = [
  ...GOOGLE_WORKSPACE_PACK_SCOPES.gmail,
] as const;

export type GoogleWorkspacePackHealth =
  | "not_selected"
  | "ready"
  | "missing_scopes";

export const GOOGLE_CALENDAR_SCOPES = [
  ...new Set(
    GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS
      .filter((operation) => operation.pack === "calendar")
      .flatMap((operation) => operation.requiredScopes),
  ),
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

export const googleCalendarPersonalConnectionInputSchema = z.object({
  packs: z.array(z.enum(GOOGLE_WORKSPACE_PACKS)).min(1).max(2),
  finalize: z.boolean().optional(),
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
      cursor: z.string().trim().min(1).max(4096).optional(),
      maxResults: z.number().int().min(1).max(100).default(50),
    }).strict(),
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
  ],
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

/**
 * Existing records predate selected-pack storage and are Calendar-only. An
 * empty legacy delivery configuration must never manufacture Gmail consent.
 */
export function parseSelectedGoogleWorkspacePacks(
  deliveryConfig: unknown,
): GoogleWorkspaceConnectionPack[] {
  if (
    !deliveryConfig ||
    typeof deliveryConfig !== "object" ||
    Array.isArray(deliveryConfig)
  ) {
    return ["calendar"];
  }
  const capabilityPacks = (deliveryConfig as Record<string, unknown>)
    .capabilityPacks;
  if (!Array.isArray(capabilityPacks)) return ["calendar"];
  const selected = capabilityPacks.filter(
    (pack): pack is GoogleWorkspaceConnectionPack =>
      typeof pack === "string" &&
      (GOOGLE_WORKSPACE_PACKS as readonly string[]).includes(pack),
  );
  return selected.length ? [...new Set(selected)] : ["calendar"];
}

export function googleWorkspacePackHealth(input: {
  selectedPacks: readonly GoogleWorkspaceConnectionPack[];
  grantedScopes: readonly string[];
}): Record<GoogleWorkspaceConnectionPack, GoogleWorkspacePackHealth> {
  const selected = new Set(input.selectedPacks);
  const granted = new Set(input.grantedScopes);
  return Object.fromEntries(
    GOOGLE_WORKSPACE_PACKS.map((pack) => [
      pack,
      !selected.has(pack)
        ? "not_selected"
        : resourceScopesForGoogleWorkspacePacks([pack]).every((scope) =>
              granted.has(scope),
            )
          ? "ready"
          : "missing_scopes",
    ]),
  ) as Record<GoogleWorkspaceConnectionPack, GoogleWorkspacePackHealth>;
}

export function hasGoogleWorkspacePackScopes(input: {
  pack: GoogleWorkspaceConnectionPack;
  grantedScopes: readonly string[];
}) {
  const granted = new Set(input.grantedScopes);
  return resourceScopesForGoogleWorkspacePacks([input.pack]).every((scope) =>
    granted.has(scope),
  );
}

export function googleWorkspaceScopesToRequest(input: {
  selectedPacks: readonly GoogleWorkspaceConnectionPack[];
  grantedScopes: readonly string[];
}) {
  const requested = resourceScopesForGoogleWorkspacePacks(
    input.selectedPacks,
  ).filter((scope) => !input.grantedScopes.includes(scope));
  return input.grantedScopes.length === 0
    ? scopesForGoogleWorkspacePacks(input.selectedPacks)
    : requested;
}

export function shouldStartGoogleWorkspaceOAuth(input: {
  selectedPacks: readonly GoogleWorkspaceConnectionPack[];
  scopes: readonly string[];
  connectionStatus: "connected" | "degraded" | "disconnected" | null;
}) {
  return (
    input.connectionStatus === "disconnected" ||
    input.selectedPacks.some(
      (pack) =>
        !hasGoogleWorkspacePackScopes({
          pack,
          grantedScopes: input.scopes,
        }),
    )
  );
}

export function hasRequiredGoogleCalendarScopes(scopes: readonly string[]) {
  const granted = new Set(scopes);
  return GOOGLE_CALENDAR_SCOPES.every((scope) => granted.has(scope));
}

export function hasGoogleCalendarCapabilityScopes(input: {
  grantedScopes: readonly string[];
  capability: GoogleCalendarCapability;
}) {
  if (
    input.capability === "calendar.events.read" ||
    input.capability === "calendar.events.create" ||
    input.capability === "calendar.events.update" ||
    input.capability === "calendar.events.delete"
  ) {
    return googleWorkspaceOperationHasRequiredScopes({
      operation: (input.capability === "calendar.events.read"
        ? "events.list"
        : input.capability.slice("calendar.".length)) as
        | "events.list"
        | "events.create"
        | "events.update"
        | "events.delete",
      grantedScopes: input.grantedScopes,
    });
  }
  return hasRequiredGoogleCalendarScopes(input.grantedScopes);
}

export function shouldStartGoogleCalendarOAuth(input: {
  scopes: readonly string[];
  connectionStatus: "connected" | "degraded" | "disconnected" | null;
}) {
  return (
    input.connectionStatus === "degraded" ||
    shouldStartGoogleWorkspaceOAuth({
      selectedPacks: ["calendar"],
      scopes: input.scopes,
      connectionStatus: input.connectionStatus,
    })
  );
}

export function capabilityForGoogleCalendarOperation(
  operation: GoogleCalendarRuntimeInput["operation"],
): GoogleCalendarCapability {
  if (
    operation === "events.list" ||
    operation === "events.create" ||
    operation === "events.update" ||
    operation === "events.delete"
  ) {
    return googleWorkspaceOperationDescriptor(operation)
      .id as GoogleCalendarCapability;
  }
  if (operation === "availability.subjects") {
    return "calendar.availability.subjects";
  }
  return "calendar.availability.read";
}

export function requiresGoogleCalendarApproval(
  capability: GoogleCalendarCapability,
) {
  if (
    capability === "calendar.events.create" ||
    capability === "calendar.events.update" ||
    capability === "calendar.events.delete"
  ) {
    const operation = capability.slice("calendar.".length) as
      | "events.create"
      | "events.update"
      | "events.delete";
    return googleWorkspaceMinimumApprovalMode(operation) === "ask";
  }
  return (GOOGLE_CALENDAR_WRITE_CAPABILITIES as readonly string[]).includes(
    capability,
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
  end: z.infer<typeof googleCalendarEventTimeSchema>,
) {
  return "date" in start === "date" in end;
}

function eventEndIsAfterStart(
  start: z.infer<typeof googleCalendarEventTimeSchema>,
  end: z.infer<typeof googleCalendarEventTimeSchema>,
) {
  const startValue = "date" in start ? start.date : start.dateTime;
  const endValue = "date" in end ? end.date : end.dateTime;
  return Date.parse(endValue) > Date.parse(startValue);
}
