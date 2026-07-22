import type {
  Microsoft365Operation,
  Microsoft365ServicePort,
} from "../apps/microsoft365.js";
import {
  resourceScopesForMicrosoft365Packs,
  type Microsoft365Pack,
} from "../apps/microsoft365.js";
import type {
  LocalCoreCredentialId,
  LocalCoreCredentialStore,
} from "./credentialStore.js";

const TOKENS_ID = "mcp.standard.microsoft_365.oauth.tokens" as LocalCoreCredentialId;
const CLIENT_ID = "mcp.standard.microsoft_365.oauth.client" as LocalCoreCredentialId;
const TOKEN_ENDPOINT =
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";

export interface StoredMicrosoft365Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

export class LocalCoreMicrosoft365Service implements Microsoft365ServicePort {
  readonly #credentialStore: LocalCoreCredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: {
    credentialStore: LocalCoreCredentialStore;
    fetchImpl?: typeof fetch | undefined;
    now?: (() => number) | undefined;
  }) {
    this.#credentialStore = options.credentialStore;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async invoke(
    operation: Microsoft365Operation,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const accessToken = await this.#accessToken();
    if (operation === "mail.list") {
      const url = graphUrl("/me/messages");
      url.searchParams.set("$top", String(integer(input.maxResults, 20, 1, 50)));
      url.searchParams.set("$orderby", "receivedDateTime desc");
      url.searchParams.set("$select", "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,webLink");
      return await this.#collection(accessToken, url);
    }
    if (operation === "mail.send") {
      await this.#request(accessToken, graphUrl("/me/sendMail"), {
        method: "POST",
        body: {
          message: {
            subject: string(input.subject, "subject"),
            body: { contentType: "Text", content: string(input.body, "body") },
            toRecipients: strings(input.to, "to").map((address) => ({ emailAddress: { address } })),
            ccRecipients: strings(input.cc ?? [], "cc").map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: true,
        },
      });
      return { sent: true };
    }
    if (operation === "calendar.list") {
      const url = graphUrl("/me/calendarView");
      url.searchParams.set("startDateTime", string(input.timeMin, "timeMin"));
      url.searchParams.set("endDateTime", string(input.timeMax, "timeMax"));
      url.searchParams.set("$top", String(integer(input.maxResults, 50, 1, 100)));
      url.searchParams.set("$orderby", "start/dateTime");
      url.searchParams.set("$select", "id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeeting,webLink");
      return await this.#collection(accessToken, url);
    }
    if (operation === "chats.list") {
      const chatId = optionalString(input.chatId);
      const url = graphUrl(chatId ? `/chats/${encodeURIComponent(chatId)}/messages` : "/me/chats");
      url.searchParams.set("$top", String(integer(input.maxResults, 20, 1, 50)));
      return await this.#collection(accessToken, url);
    }
    if (operation === "chat.send") {
      return await this.#request(
        accessToken,
        graphUrl(`/chats/${encodeURIComponent(string(input.chatId, "chatId"))}/messages`),
        { method: "POST", body: { body: { contentType: "text", content: string(input.content, "content") } } },
      );
    }
    const url = graphUrl("/sites");
    url.searchParams.set("search", string(input.query, "query"));
    url.searchParams.set("$top", String(integer(input.maxResults, 20, 1, 50)));
    url.searchParams.set("$select", "id,name,displayName,description,webUrl");
    return await this.#collection(accessToken, url);
  }

  async verify(packs: readonly Microsoft365Pack[]): Promise<{ verifiedAt: string }> {
    const tokens = await readTokens(this.#credentialStore);
    const granted = new Set(tokens.scope.split(/\s+/u).map((scope) => scope.toLowerCase()));
    if (resourceScopesForMicrosoft365Packs(packs).some((scope) => !granted.has(scope.toLowerCase()))) {
      throw new Error("Microsoft 365 has not granted every selected capability.");
    }
    const accessToken = await this.#accessToken();
    const response = await this.#fetch(
      "https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName",
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) throw new Error("Microsoft 365 needs to be reconnected.");
    return { verifiedAt: new Date(this.#now()).toISOString() };
  }

  async #accessToken(): Promise<string> {
    const tokens = await readTokens(this.#credentialStore);
    if (tokens.expiresAt > this.#now() + 60_000) return tokens.accessToken;
    const clientId = await this.#credentialStore.get(CLIENT_ID);
    if (!clientId) throw new Error("Microsoft 365 needs to be reconnected.");
    const response = await this.#fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      }),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error("Microsoft 365 needs to be reconnected.");
    const refreshed = parseTokenResponse(
      body,
      this.#now(),
      tokens.refreshToken,
      tokens.scope,
    );
    await this.#credentialStore.set(TOKENS_ID, JSON.stringify(refreshed));
    return refreshed.accessToken;
  }

  async #collection(accessToken: string, url: URL) {
    const body = await this.#request(accessToken, url);
    const record = object(body, "Microsoft Graph response");
    return {
      items: Array.isArray(record.value) ? record.value : [],
      nextPage: typeof record["@odata.nextLink"] === "string" ? record["@odata.nextLink"] : null,
    };
  }

  async #request(
    accessToken: string,
    url: URL,
    options: { method?: "POST"; body?: unknown } = {},
  ): Promise<unknown> {
    const response = await this.#fetch(url, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error("Microsoft 365 needs to be reconnected.");
      if (response.status === 429) throw new Error("Microsoft 365 is rate limited. Try again shortly.");
      throw new Error(`Microsoft 365 request failed with HTTP ${response.status}.`);
    }
    if (response.status === 202 || response.status === 204) return {};
    return await response.json();
  }
}

export async function readTokens(store: LocalCoreCredentialStore): Promise<StoredMicrosoft365Tokens> {
  const raw = await store.get(TOKENS_ID);
  if (!raw) throw new Error("Microsoft 365 is not connected.");
  const record = object(JSON.parse(raw), "stored Microsoft 365 authorization");
  if (typeof record.accessToken !== "string" || typeof record.refreshToken !== "string" || typeof record.expiresAt !== "number" || typeof record.scope !== "string") {
    throw new Error("Stored Microsoft 365 authorization is invalid.");
  }
  return record as unknown as StoredMicrosoft365Tokens;
}

export function parseTokenResponse(
  body: Record<string, unknown>,
  now: number,
  fallbackRefreshToken?: string,
  fallbackScope?: string,
): StoredMicrosoft365Tokens {
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new Error("Microsoft returned an invalid authorization response.");
  }
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefreshToken;
  const scope = typeof body.scope === "string" ? body.scope : fallbackScope;
  if (!refreshToken) throw new Error("Microsoft did not grant offline access.");
  if (!scope) throw new Error("Microsoft did not grant App capabilities.");
  return { accessToken: body.access_token, refreshToken, expiresAt: now + body.expires_in * 1000, scope };
}

function graphUrl(path: string) { return new URL(`https://graph.microsoft.com/v1.0${path}`); }
function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid.`); return value as Record<string, unknown>; }
function string(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function strings(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`${label} must be a list of values.`); return value as string[]; }
function integer(value: unknown, fallback: number, min: number, max: number): number { const result = value === undefined ? fallback : value; if (!Number.isInteger(result) || (result as number) < min || (result as number) > max) throw new Error("A result limit is invalid."); return result as number; }
