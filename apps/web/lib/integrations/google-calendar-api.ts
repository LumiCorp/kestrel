import { z } from "zod";

const eventTimeResponseSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

const eventResponseSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  htmlLink: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: eventTimeResponseSchema,
  end: eventTimeResponseSchema,
  attendees: z
    .array(
      z.object({
        email: z.string().optional(),
        displayName: z.string().optional(),
        responseStatus: z.string().optional(),
      })
    )
    .optional(),
  updated: z.string().optional(),
});

const eventListResponseSchema = z.object({
  items: z.array(eventResponseSchema).default([]),
  nextPageToken: z.string().optional(),
});

const freeBusyResponseSchema = z.object({
  calendars: z.record(
    z.string(),
    z.object({
      busy: z
        .array(z.object({ start: z.string(), end: z.string() }))
        .default([]),
      errors: z.array(z.unknown()).optional(),
    })
  ),
});

const userInfoSchema = z.object({
  sub: z.string(),
  email: z.string().email().optional(),
});

export class GoogleCalendarProviderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reconnectRequired: boolean;

  constructor(input: {
    code: string;
    status: number;
    reconnectRequired?: boolean;
  }) {
    super(input.code);
    this.name = "GoogleCalendarProviderError";
    this.code = input.code;
    this.status = input.status;
    this.reconnectRequired = input.reconnectRequired ?? false;
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export async function getGoogleUserInfo(input: {
  accessToken: string;
  fetchImpl?: FetchLike;
}) {
  return userInfoSchema.parse(
    await googleJsonRequest({
      accessToken: input.accessToken,
      fetchImpl: input.fetchImpl,
      url: "https://openidconnect.googleapis.com/v1/userinfo",
    })
  );
}

export async function listGoogleCalendarEvents(input: {
  accessToken: string;
  timeMin: string;
  timeMax: string;
  maxResults: number;
  fetchImpl?: FetchLike;
}) {
  const url = new URL(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events"
  );
  url.searchParams.set("timeMin", input.timeMin);
  url.searchParams.set("timeMax", input.timeMax);
  url.searchParams.set("maxResults", String(input.maxResults));
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  const response = eventListResponseSchema.parse(
    await googleJsonRequest({ ...input, url: url.toString() })
  );
  return {
    events: response.items.map(normalizeGoogleEvent),
    nextPageToken: response.nextPageToken ?? null,
  };
}

export async function createGoogleCalendarEvent(input: {
  accessToken: string;
  event: Record<string, unknown>;
  notifyAttendees: boolean;
  fetchImpl?: FetchLike;
}) {
  const url = calendarEventUrl();
  url.searchParams.set("sendUpdates", input.notifyAttendees ? "all" : "none");
  return normalizeGoogleEvent(
    eventResponseSchema.parse(
      await googleJsonRequest({
        ...input,
        method: "POST",
        url: url.toString(),
        body: input.event,
      })
    )
  );
}

export async function updateGoogleCalendarEvent(input: {
  accessToken: string;
  eventId: string;
  patch: Record<string, unknown>;
  notifyAttendees: boolean;
  fetchImpl?: FetchLike;
}) {
  const url = calendarEventUrl(input.eventId);
  url.searchParams.set("sendUpdates", input.notifyAttendees ? "all" : "none");
  return normalizeGoogleEvent(
    eventResponseSchema.parse(
      await googleJsonRequest({
        ...input,
        method: "PATCH",
        url: url.toString(),
        body: input.patch,
      })
    )
  );
}

export async function deleteGoogleCalendarEvent(input: {
  accessToken: string;
  eventId: string;
  notifyAttendees: boolean;
  fetchImpl?: FetchLike;
}) {
  const url = calendarEventUrl(input.eventId);
  url.searchParams.set("sendUpdates", input.notifyAttendees ? "all" : "none");
  await googleJsonRequest({
    ...input,
    method: "DELETE",
    url: url.toString(),
  });
  return { deleted: true };
}

export async function queryGoogleCalendarFreeBusy(input: {
  accessToken: string;
  timeMin: string;
  timeMax: string;
  fetchImpl?: FetchLike;
}) {
  const response = freeBusyResponseSchema.parse(
    await googleJsonRequest({
      ...input,
      method: "POST",
      url: "https://www.googleapis.com/calendar/v3/freeBusy",
      body: {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        items: [{ id: "primary" }],
      },
    })
  );
  const calendar = response.calendars.primary;
  if (!calendar || (calendar.errors?.length ?? 0) > 0) {
    throw new GoogleCalendarProviderError({
      code: "GOOGLE_CALENDAR_FREEBUSY_UNAVAILABLE",
      status: 502,
    });
  }
  return calendar.busy;
}

async function googleJsonRequest(input: {
  accessToken: string;
  url: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  fetchImpl?: FetchLike;
}) {
  const response = await (input.fetchImpl ?? fetch)(input.url, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  if (!response.ok) {
    throw new GoogleCalendarProviderError({
      code:
        response.status === 401 || response.status === 403
          ? "GOOGLE_CALENDAR_RECONNECT_REQUIRED"
          : response.status === 429
            ? "GOOGLE_CALENDAR_RATE_LIMITED"
            : "GOOGLE_CALENDAR_UNAVAILABLE",
      status:
        response.status === 429
          ? 429
          : response.status >= 500
            ? 502
            : response.status,
      reconnectRequired: response.status === 401 || response.status === 403,
    });
  }
  if (response.status === 204) return {};
  return response.json().catch(() => {
    throw new GoogleCalendarProviderError({
      code: "GOOGLE_CALENDAR_INVALID_RESPONSE",
      status: 502,
    });
  });
}

function calendarEventUrl(eventId?: string) {
  const suffix = eventId ? `/${encodeURIComponent(eventId)}` : "";
  return new URL(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events${suffix}`
  );
}

function normalizeGoogleEvent(event: z.infer<typeof eventResponseSchema>) {
  return {
    id: event.id,
    status: event.status ?? null,
    url: event.htmlLink ?? null,
    summary: event.summary ?? "",
    description: event.description ?? null,
    location: event.location ?? null,
    start: event.start,
    end: event.end,
    attendees: (event.attendees ?? []).map((attendee) => ({
      email: attendee.email ?? null,
      displayName: attendee.displayName ?? null,
      responseStatus: attendee.responseStatus ?? null,
    })),
    updatedAt: event.updated ?? null,
  };
}
