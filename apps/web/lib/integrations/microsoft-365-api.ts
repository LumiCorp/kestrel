import { z } from "zod";

const graphCollectionSchema = z.object({
  value: z.array(z.record(z.string(), z.unknown())).default([]),
  "@odata.nextLink": z.string().optional(),
});

export class Microsoft365ProviderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reconnectRequired: boolean;

  constructor(input: { code: string; status: number; reconnectRequired?: boolean }) {
    super(input.code);
    this.name = "Microsoft365ProviderError";
    this.code = input.code;
    this.status = input.status;
    this.reconnectRequired = input.reconnectRequired ?? false;
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export async function listMicrosoftMail(input: {
  accessToken: string;
  maxResults: number;
  fetchImpl?: FetchLike;
}) {
  const url = graphUrl("/me/messages");
  url.searchParams.set("$top", String(input.maxResults));
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set(
    "$select",
    "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,webLink"
  );
  return graphCollection(input, url);
}

export async function sendMicrosoftMail(input: {
  accessToken: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  fetchImpl?: FetchLike;
}) {
  await graphRequest({
    ...input,
    method: "POST",
    url: graphUrl("/me/sendMail"),
    body: {
      message: {
        subject: input.subject,
        body: { contentType: "Text", content: input.body },
        toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: input.cc.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    },
  });
  return { sent: true };
}

export async function listMicrosoftCalendarEvents(input: {
  accessToken: string;
  timeMin: string;
  timeMax: string;
  maxResults: number;
  fetchImpl?: FetchLike;
}) {
  const url = graphUrl("/me/calendarView");
  url.searchParams.set("startDateTime", input.timeMin);
  url.searchParams.set("endDateTime", input.timeMax);
  url.searchParams.set("$top", String(input.maxResults));
  url.searchParams.set("$orderby", "start/dateTime");
  url.searchParams.set(
    "$select",
    "id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeeting,webLink"
  );
  return graphCollection(input, url);
}

export async function listMicrosoftTeamsChats(input: {
  accessToken: string;
  chatId?: string;
  maxResults: number;
  fetchImpl?: FetchLike;
}) {
  const url = graphUrl(
    input.chatId
      ? `/chats/${encodeURIComponent(input.chatId)}/messages`
      : "/me/chats"
  );
  url.searchParams.set("$top", String(input.maxResults));
  return graphCollection(input, url);
}

export async function sendMicrosoftTeamsChatMessage(input: {
  accessToken: string;
  chatId: string;
  content: string;
  fetchImpl?: FetchLike;
}) {
  return graphRequest({
    ...input,
    method: "POST",
    url: graphUrl(`/chats/${encodeURIComponent(input.chatId)}/messages`),
    body: { body: { contentType: "text", content: input.content } },
  });
}

export async function searchMicrosoftSharePointSites(input: {
  accessToken: string;
  query: string;
  maxResults: number;
  fetchImpl?: FetchLike;
}) {
  const url = graphUrl("/sites");
  url.searchParams.set("search", input.query);
  url.searchParams.set("$top", String(input.maxResults));
  url.searchParams.set("$select", "id,name,displayName,description,webUrl");
  return graphCollection(input, url);
}

function graphUrl(path: string) {
  return new URL(`https://graph.microsoft.com/v1.0${path}`);
}

async function graphCollection(
  input: { accessToken: string; fetchImpl?: FetchLike },
  url: URL
) {
  const response = graphCollectionSchema.parse(
    await graphRequest({ ...input, url })
  );
  return {
    items: response.value,
    nextPage: response["@odata.nextLink"] ?? null,
  };
}

async function graphRequest(input: {
  accessToken: string;
  url: URL;
  method?: "GET" | "POST";
  body?: unknown;
  fetchImpl?: FetchLike;
}) {
  const response = await (input.fetchImpl ?? fetch)(input.url, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  if (!response.ok) {
    const reconnectRequired = response.status === 401 || response.status === 403;
    throw new Microsoft365ProviderError({
      code: reconnectRequired
        ? "MICROSOFT_365_RECONNECT_REQUIRED"
        : response.status === 429
          ? "MICROSOFT_365_RATE_LIMITED"
          : "MICROSOFT_365_UNAVAILABLE",
      status: response.status === 429 ? 429 : reconnectRequired ? 401 : 502,
      reconnectRequired,
    });
  }
  if (response.status === 202 || response.status === 204) return {};
  return response.json();
}
