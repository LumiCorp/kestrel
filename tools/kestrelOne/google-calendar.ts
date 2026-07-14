import {
  createRuntimeFailure,
  RuntimeFailure,
} from "../../src/runtime/RuntimeFailure.js";
import type {
  SharedToolContext,
  SharedToolDefinition,
  SharedToolModule,
} from "../contracts.js";
import { parseObjectInput } from "../helpers.js";

type GoogleCalendarOperation =
  | "events.list"
  | "events.create"
  | "events.update"
  | "events.delete"
  | "availability.subjects"
  | "availability.query";

type GoogleCalendarToolOptions = {
  name: string;
  displayName: string;
  description: string;
  operation: GoogleCalendarOperation;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
};

function createGoogleCalendarTool(
  options: GoogleCalendarToolOptions
): SharedToolModule {
  const definition: SharedToolDefinition = {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "free",
      executionClass: options.readOnly ? "read_only" : "external_side_effect",
      capabilityClasses: ["google.calendar", "network.call"],
      approvalCapabilities: [
        "network.call",
        ...(options.readOnly ? [] : (["external.confirm"] as const)),
      ],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: options.operation === "availability.query",
        typicalFailureModes: [
          "calendar_not_connected",
          "approval_required",
          "google_calendar_unavailable",
        ],
      },
    },
    presentation: {
      displayName: options.displayName,
      aliases: [options.displayName.toLowerCase()],
      keywords: ["google", "calendar", options.operation],
      provider: "kestrel-one",
      toolFamily: "calendar",
    },
  };
  return {
    definition,
    createHandler(context) {
      return async (input: unknown) => {
        const parsed = parseObjectInput(options.name, input);
        return invokeGoogleCalendar(context, {
          operation: options.operation,
          input: parsed,
          requiresApproval: !options.readOnly,
          toolName: options.name,
        });
      };
    },
  };
}

const eventTimeSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        dateTime: { type: "string", format: "date-time" },
        timeZone: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["dateTime"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { date: { type: "string", format: "date" } },
      required: ["date"],
      additionalProperties: false,
    },
  ],
} as const;

const attendeesSchema = {
  type: "array",
  maxItems: 100,
  items: {
    type: "object",
    properties: {
      email: { type: "string", format: "email", maxLength: 320 },
      displayName: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: ["email"],
    additionalProperties: false,
  },
} as const;

const eventFields = {
  summary: { type: "string", minLength: 1, maxLength: 1024 },
  description: { type: "string", maxLength: 8192 },
  location: { type: "string", maxLength: 1024 },
  start: eventTimeSchema,
  end: eventTimeSchema,
  attendees: attendeesSchema,
} as const;

export const kestrelOneGoogleCalendarListEventsTool = createGoogleCalendarTool({
  name: "kestrel_one.google_calendar_list_events",
  displayName: "Google Calendar List Events",
  description:
    "List the current user's Google Calendar events within a maximum 31-day window.",
  operation: "events.list",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      timeMin: { type: "string", format: "date-time" },
      timeMax: { type: "string", format: "date-time" },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
    required: ["timeMin", "timeMax"],
    additionalProperties: false,
  },
});

export const kestrelOneGoogleCalendarCreateEventTool = createGoogleCalendarTool(
  {
    name: "kestrel_one.google_calendar_create_event",
    displayName: "Google Calendar Create Event",
    description:
      "Create an event on the current user's primary Google Calendar after approval. Attendee notifications are off unless notifyAttendees is explicitly true.",
    operation: "events.create",
    inputSchema: {
      type: "object",
      properties: {
        event: {
          type: "object",
          properties: eventFields,
          required: ["summary", "start", "end"],
          additionalProperties: false,
        },
        notifyAttendees: {
          type: "boolean",
          default: false,
          description:
            "Send Google invitation emails. This must be explicitly requested by the user.",
        },
      },
      required: ["event"],
      additionalProperties: false,
    },
  }
);

export const kestrelOneGoogleCalendarUpdateEventTool = createGoogleCalendarTool(
  {
    name: "kestrel_one.google_calendar_update_event",
    displayName: "Google Calendar Update Event",
    description:
      "Update one event on the current user's primary Google Calendar after approval. Recurrence-series editing is not supported.",
    operation: "events.update",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", minLength: 1, maxLength: 1024 },
        patch: {
          type: "object",
          properties: eventFields,
          minProperties: 1,
          additionalProperties: false,
        },
        notifyAttendees: {
          type: "boolean",
          default: false,
          description:
            "Send Google update emails. This must be explicitly requested by the user.",
        },
      },
      required: ["eventId", "patch"],
      additionalProperties: false,
    },
  }
);

export const kestrelOneGoogleCalendarDeleteEventTool = createGoogleCalendarTool(
  {
    name: "kestrel_one.google_calendar_delete_event",
    displayName: "Google Calendar Delete Event",
    description:
      "Delete one event from the current user's primary Google Calendar after approval.",
    operation: "events.delete",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", minLength: 1, maxLength: 1024 },
        notifyAttendees: {
          type: "boolean",
          default: false,
          description:
            "Send Google cancellation emails. This must be explicitly requested by the user.",
        },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
  }
);

export const kestrelOneGoogleCalendarListAvailabilitySubjectsTool =
  createGoogleCalendarTool({
    name: "kestrel_one.google_calendar_list_availability_subjects",
    displayName: "Google Calendar List Availability Subjects",
    description:
      "List stable subject IDs for Project teammates who personally opted in to free/busy sharing. Use this before checking availability; do not guess subject IDs from names.",
    operation: "availability.subjects",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  });

export const kestrelOneGoogleCalendarCheckAvailabilityTool =
  createGoogleCalendarTool({
    name: "kestrel_one.google_calendar_check_availability",
    displayName: "Google Calendar Check Availability",
    description:
      "Return only normalized busy intervals for opted-in Project teammate subject IDs. Event titles, descriptions, locations, and attendees are never returned.",
    operation: "availability.query",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        subjectIds: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", format: "uuid" },
        },
        timeMin: { type: "string", format: "date-time" },
        timeMax: { type: "string", format: "date-time" },
      },
      required: ["subjectIds", "timeMin", "timeMax"],
      additionalProperties: false,
    },
  });

async function invokeGoogleCalendar(
  context: SharedToolContext,
  input: {
    operation: GoogleCalendarOperation;
    input: Record<string, unknown>;
    requiresApproval: boolean;
    toolName: string;
  }
) {
  const appUrl = requireContextValue(
    context.kestrelOne?.appUrl,
    "KESTREL_ONE_APP_URL"
  );
  const ticket = requireContextValue(
    context.kestrelOne?.executionTicket,
    "Environment execution ticket"
  );
  const response = await (context.fetchImpl ?? fetch)(
    new URL("/api/runtime/google-calendar/action", appUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ticket}`,
        "content-type": "application/json",
        ...(input.requiresApproval
          ? { "x-kestrel-runtime-approval": "confirmed" }
          : {}),
      },
      body: JSON.stringify({ operation: input.operation, ...input.input }),
    }
  );
  const body = parseObjectInput(
    `${input.toolName} response`,
    await response.json().catch(() => ({}))
  );
  if (!response.ok) {
    throw new RuntimeFailure(
      "KESTREL_ONE_GOOGLE_CALENDAR_ACTION_FAILED",
      `Kestrel One rejected ${input.toolName} with HTTP ${response.status}.`,
      {
        subsystem: "tooling",
        toolName: input.toolName,
        status: response.status,
        classification: response.status >= 500 ? "runtime" : "policy",
        recoverable: response.status >= 500 || response.status === 429,
      }
    );
  }
  return body;
}

function requireContextValue(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw createRuntimeFailure(
      "KESTREL_ONE_GOOGLE_CALENDAR_CONTEXT_MISSING",
      `${label} is required for Kestrel One Google Calendar tools.`,
      {
        subsystem: "tooling",
        classification: "configuration",
        recoverable: true,
      }
    );
  }
  return value.trim();
}
