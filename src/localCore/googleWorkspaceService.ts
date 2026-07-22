import { scopesForGoogleWorkspacePacks, type GoogleWorkspaceOperation, type GoogleWorkspacePack, type GoogleWorkspaceServicePort } from "../apps/googleWorkspace.js";
import type { LocalCoreCredentialId, LocalCoreCredentialStore } from "./credentialStore.js";

const CLIENT_ID = "mcp.standard.google_workspace.oauth.client" as LocalCoreCredentialId;
const TOKENS_ID = "mcp.standard.google_workspace.oauth.tokens" as LocalCoreCredentialId;

interface StoredGoogleTokens { accessToken: string; refreshToken: string; expiresAt: number; scope: string; }

export class LocalCoreGoogleWorkspaceService implements GoogleWorkspaceServicePort {
  readonly #store: LocalCoreCredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  constructor(options: { credentialStore: LocalCoreCredentialStore; fetchImpl?: typeof fetch; now?: () => number }) {
    this.#store = options.credentialStore;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async verify(packs: readonly GoogleWorkspacePack[]): Promise<{ verifiedAt: string }> {
    const tokens = await readGoogleTokens(this.#store);
    const granted = new Set(tokens.scope.split(/\s+/u));
    if (scopesForGoogleWorkspacePacks(packs).some((scope) => !granted.has(scope))) throw new Error("Google Workspace has not granted every selected capability.");
    const accessToken = await this.#accessToken();
    const response = await this.#fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error("Google Workspace needs to be reconnected.");
    return { verifiedAt: new Date(this.#now()).toISOString() };
  }

  async invoke(operation: GoogleWorkspaceOperation, input: Record<string, unknown>): Promise<unknown> {
    const accessToken = await this.#accessToken();
    if (operation === "events.list") {
      const url = eventUrl();
      url.searchParams.set("timeMin", requiredString(input.timeMin, "timeMin"));
      url.searchParams.set("timeMax", requiredString(input.timeMax, "timeMax"));
      url.searchParams.set("maxResults", String(integer(input.maxResults, 50)));
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      const result = record(await this.#request(accessToken, url));
      return { events: Array.isArray(result.items) ? result.items : [], nextPageToken: typeof result.nextPageToken === "string" ? result.nextPageToken : null };
    }
    if (operation === "events.create") {
      const url = eventUrl();
      url.searchParams.set("sendUpdates", input.notifyAttendees === true ? "all" : "none");
      return await this.#request(accessToken, url, { method: "POST", body: record(input.event) });
    }
    const eventId = requiredString(input.eventId, "eventId");
    const url = eventUrl(eventId);
    url.searchParams.set("sendUpdates", input.notifyAttendees === true ? "all" : "none");
    if (operation === "events.update") return await this.#request(accessToken, url, { method: "PATCH", body: record(input.patch) });
    await this.#request(accessToken, url, { method: "DELETE" });
    return { deleted: true };
  }

  async #accessToken(): Promise<string> {
    const tokens = await readGoogleTokens(this.#store);
    if (tokens.expiresAt > this.#now() + 60_000) return tokens.accessToken;
    const clientId = await this.#store.get(CLIENT_ID);
    if (!clientId) throw new Error("Google Workspace needs to be reconnected.");
    const response = await this.#fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, refresh_token: tokens.refreshToken, grant_type: "refresh_token" }) });
    const body = record(await response.json().catch(() => ({})));
    if (!response.ok) throw new Error("Google Workspace needs to be reconnected.");
    const refreshed = parseGoogleTokenResponse(body, this.#now(), tokens.refreshToken, tokens.scope);
    await this.#store.set(TOKENS_ID, JSON.stringify(refreshed));
    return refreshed.accessToken;
  }

  async #request(accessToken: string, url: URL, options: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown } = {}) {
    const response = await this.#fetch(url, { method: options.method ?? "GET", headers: { authorization: `Bearer ${accessToken}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    if (!response.ok) { if (response.status === 401 || response.status === 403) throw new Error("Google Workspace needs to be reconnected."); if (response.status === 429) throw new Error("Google Workspace is rate limited. Try again shortly."); throw new Error(`Google Workspace request failed with HTTP ${response.status}.`); }
    if (response.status === 204) return {};
    return await response.json();
  }
}

export async function readGoogleTokens(store: LocalCoreCredentialStore): Promise<StoredGoogleTokens> { const raw = await store.get(TOKENS_ID); if (!raw) throw new Error("Google Workspace is not connected."); const value = record(JSON.parse(raw)); if (typeof value.accessToken !== "string" || typeof value.refreshToken !== "string" || typeof value.expiresAt !== "number" || typeof value.scope !== "string") throw new Error("Stored Google Workspace authorization is invalid."); return value as unknown as StoredGoogleTokens; }
export function parseGoogleTokenResponse(body: Record<string, unknown>, now: number, fallbackRefresh?: string, fallbackScope?: string): StoredGoogleTokens { if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new Error("Google returned an invalid authorization response."); const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefresh; const scope = typeof body.scope === "string" ? body.scope : fallbackScope; if (!refreshToken || !scope) throw new Error("Google did not grant offline access."); return { accessToken: body.access_token, refreshToken, expiresAt: now + body.expires_in * 1000, scope }; }
function eventUrl(eventId?: string) { return new URL(`https://www.googleapis.com/calendar/v3/calendars/primary/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`); }
function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Google Workspace data is invalid."); return value as Record<string, unknown>; }
function requiredString(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`); return value; }
function integer(value: unknown, fallback: number): number { const parsed = value === undefined ? fallback : value; if (!Number.isInteger(parsed) || (parsed as number) < 1 || (parsed as number) > 100) throw new Error("The result limit is invalid."); return parsed as number; }
