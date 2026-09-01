import { z } from "zod";
import {
  normalizeMicrosoft365TeamsChats,
  normalizeMicrosoft365TeamsMessages,
} from "../../../../src/apps/microsoft365Teams.js";

const graphCollectionSchema = z.object({
  value: z.array(z.record(z.string(), z.unknown())).default([]),
  "@odata.nextLink": z.string().optional(),
});

const teamsChatMessageSendResultSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  createdDateTime: z.string().min(1).optional(),
});

export class Microsoft365ProviderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reconnectRequired: boolean;
  readonly outcomeUnknown: boolean;
  readonly providerCode: string | undefined;

  constructor(input: {
    code: string;
    status: number;
    reconnectRequired?: boolean;
    outcomeUnknown?: boolean;
    providerCode?: string;
  }) {
    super(input.code);
    this.name = "Microsoft365ProviderError";
    this.code = input.code;
    this.status = input.status;
    this.reconnectRequired = input.reconnectRequired ?? false;
    this.outcomeUnknown = input.outcomeUnknown ?? false;
    this.providerCode = input.providerCode;
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
  maxResults: number;
  nextLink?: string;
  fetchImpl?: FetchLike;
}) {
  const url = input.nextLink ? new URL(input.nextLink) : graphUrl("/me/chats");
  if (!input.nextLink) {
    url.searchParams.set("$top", String(input.maxResults));
    url.searchParams.set(
      "$select",
      "id,topic,chatType,createdDateTime,lastUpdatedDateTime,webUrl,members",
    );
    url.searchParams.set("$expand", "members");
  }
  const result = await graphCollection(input, url);
  return {
    items: normalizeMicrosoft365TeamsChats(result.items),
    nextPage: result.nextPage,
  };
}

export async function listMicrosoftTeamsChatMessages(input: {
  accessToken: string;
  chatId: string;
  maxResults: number;
  nextLink?: string;
  fetchImpl?: FetchLike;
}) {
  const url = input.nextLink
    ? new URL(input.nextLink)
    : graphUrl(`/chats/${encodeURIComponent(input.chatId)}/messages`);
  if (!input.nextLink) {
    url.searchParams.set("$top", String(input.maxResults));
    url.searchParams.set(
      "$select",
      "id,chatId,createdDateTime,lastModifiedDateTime,from,body",
    );
  }
  const result = await graphCollection(input, url);
  return {
    items: normalizeMicrosoft365TeamsMessages({
      chatId: input.chatId,
      items: result.items,
    }),
    nextPage: result.nextPage,
  };
}

export async function sendMicrosoftTeamsChatMessage(input: {
  accessToken: string;
  chatId: string;
  content: string;
  fetchImpl?: FetchLike;
}) {
  try {
    const response = await graphTeamsSendRequest({
      ...input,
      url: graphUrl(`/chats/${encodeURIComponent(input.chatId)}/messages`),
      body: { body: { contentType: "text", content: input.content } },
    });
    const message = teamsChatMessageSendResultSchema.parse(response);
    return {
      id: message.id,
      chatId: message.chatId,
      createdAt: message.createdDateTime ?? null,
    };
  } catch (error) {
    if (error instanceof Microsoft365ProviderError) throw error;
    throw new Microsoft365ProviderError({
      code: "MICROSOFT_365_OUTCOME_UNKNOWN",
      status: 502,
      outcomeUnknown: true,
    });
  }
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

async function graphTeamsSendRequest(input: {
  accessToken: string;
  url: URL;
  body: unknown;
  fetchImpl?: FetchLike;
}) {
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
    });
  } catch {
    throw new Microsoft365ProviderError({
      code: "MICROSOFT_365_OUTCOME_UNKNOWN",
      status: 502,
      outcomeUnknown: true,
    });
  }
  if (!response.ok) throw await teamsSendProviderError(response);
  return response.json().catch(() => {
    throw new Microsoft365ProviderError({
      code: "MICROSOFT_365_OUTCOME_UNKNOWN",
      status: 502,
      outcomeUnknown: true,
    });
  });
}

async function teamsSendProviderError(response: Response) {
  const providerCode = await response
    .json()
    .then((body: unknown) => {
      const error = body && typeof body === "object" && "error" in body
        ? (body as { error?: unknown }).error
        : undefined;
      return error && typeof error === "object" && "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    })
    .catch(() => undefined);
  if (response.status === 401) {
    return new Microsoft365ProviderError({
      code: "MICROSOFT_365_RECONNECT_REQUIRED",
      status: 401,
      reconnectRequired: true,
      ...(providerCode === undefined ? {} : { providerCode }),
    });
  }
  if (response.status === 403) {
    return new Microsoft365ProviderError({
      code: "MICROSOFT_365_ACCESS_DENIED",
      status: 403,
      ...(providerCode === undefined ? {} : { providerCode }),
    });
  }
  if (response.status === 429) {
    return new Microsoft365ProviderError({
      code: "MICROSOFT_365_RATE_LIMITED",
      status: 429,
      ...(providerCode === undefined ? {} : { providerCode }),
    });
  }
  if (response.status >= 500) {
    return new Microsoft365ProviderError({
      code: "MICROSOFT_365_UNAVAILABLE",
      status: 502,
      ...(providerCode === undefined ? {} : { providerCode }),
    });
  }
  return new Microsoft365ProviderError({
    code: "MICROSOFT_365_PROVIDER_REJECTED",
    status: response.status,
    ...(providerCode === undefined ? {} : { providerCode }),
  });
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
