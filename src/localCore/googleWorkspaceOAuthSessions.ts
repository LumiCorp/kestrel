import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { isGoogleWorkspacePack, scopesForGoogleWorkspacePacks, type GoogleWorkspacePack } from "../apps/googleWorkspace.js";
import type { LocalCoreCredentialId, LocalCoreCredentialStore } from "./credentialStore.js";
import type { LocalCoreMcpOAuthSessionView } from "./mcpOAuthSessions.js";
import { parseGoogleTokenResponse } from "./googleWorkspaceService.js";

const CLIENT_ID = "mcp.standard.google_workspace.oauth.client" as LocalCoreCredentialId;
const TOKENS_ID = "mcp.standard.google_workspace.oauth.tokens" as LocalCoreCredentialId;

interface ActiveSession {
  sessionId: string; clientId: string; scopes: string[]; verifier: string; stateValue: string;
  callbackServer: Server; callbackHost: string; callbackPath: string; expiresAtMs: number;
  view: LocalCoreMcpOAuthSessionView;
  callbackClaimed: boolean;
}

export class LocalCoreGoogleWorkspaceOAuthSessionManager {
  readonly #store: LocalCoreCredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sessions = new Map<string, ActiveSession>();
  constructor(options: { credentialStore: LocalCoreCredentialStore; fetchImpl?: typeof fetch; now?: () => number }) {
    this.#store = options.credentialStore;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async start(input: { clientId: string; packs: GoogleWorkspacePack[] }): Promise<LocalCoreMcpOAuthSessionView> {
    this.#expire();
    if ([...this.#sessions.values()].some((session) => session.view.state === "awaiting_user")) throw new Error("Google Workspace already has a connection window open.");
    const clientId = parseClientId(input.clientId);
    const packs = parsePacks(input.packs);
    const scopes = scopesForGoogleWorkspacePacks(packs);
    const sessionId = randomBytes(18).toString("base64url");
    const stateValue = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const callbackPath = `/oauth/callback/${sessionId}`;
    let active: ActiveSession | undefined;
    const callbackServer = createServer((request, response) => {
      if (!active) return writeCallback(response, 503, "This App connection is not ready.");
      void this.#callback(active, request.method, request.headers.host, request.url)
        .then((result) => writeCallback(response, result.status, result.message ?? "Kestrel could not complete this App connection."))
        .catch(() => writeCallback(response, 500, "Kestrel could not complete this App connection."));
    });
    await listen(callbackServer);
    const address = callbackServer.address();
    if (address === null || typeof address === "string") throw new Error("Kestrel could not create the App authorization callback.");
    const callbackHost = `127.0.0.1:${address.port}`;
    const redirectUri = `http://${callbackHost}${callbackPath}`;
    const expiresAtMs = this.#now() + 10 * 60 * 1000;
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: scopes.join(" "), state: stateValue, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", access_type: "offline", prompt: "consent" }).toString();
    active = { sessionId, clientId, scopes, verifier, stateValue, callbackServer, callbackHost, callbackPath, expiresAtMs, callbackClaimed: false, view: { sessionId, state: "awaiting_user", authorizationUrl: authorizationUrl.toString(), expiresAt: new Date(expiresAtMs).toISOString() } };
    this.#sessions.set(sessionId, active);
    return { ...active.view };
  }

  status(sessionId: string): LocalCoreMcpOAuthSessionView | undefined { this.#expire(); if (!/^[A-Za-z0-9_-]{24}$/u.test(sessionId)) throw new Error("The App authorization session ID is invalid."); const session = this.#sessions.get(sessionId); return session ? { ...session.view } : undefined; }
  async close() { for (const session of this.#sessions.values()) session.callbackServer.close(); this.#sessions.clear(); }

  async #callback(session: ActiveSession, method: string | undefined, host: string | undefined, requestUrl: string | undefined) {
    if (this.#now() >= session.expiresAtMs) { this.#expireSession(session); return { status: 410, message: "This Google Workspace connection expired. Return to Kestrel and try again." }; }
    if (method !== "GET" || host !== session.callbackHost || !requestUrl) return { status: 400, message: "This App authorization callback is invalid." };
    const url = new URL(requestUrl, `http://${session.callbackHost}`);
    if (url.pathname !== session.callbackPath || url.searchParams.get("state") !== session.stateValue) return { status: 400, message: "This App authorization callback could not be verified." };
    if (session.callbackClaimed) return { status: 409, message: "This App authorization callback has already been used." };
    session.callbackClaimed = true;
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code) { session.view = { ...session.view, state: "failed", error: url.searchParams.get("error") === "access_denied" ? "App authorization was cancelled." : "Google did not authorize this connection." }; session.callbackServer.close(); return { status: 400, message: session.view.error! }; }
    try {
      const response = await this.#fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: session.clientId, grant_type: "authorization_code", code, redirect_uri: `http://${session.callbackHost}${session.callbackPath}`, code_verifier: session.verifier }) });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error("Google rejected the authorization exchange.");
      const tokens = parseGoogleTokenResponse(body, this.#now(), undefined, session.scopes.join(" "));
      const granted = new Set(tokens.scope.split(/\s+/u));
      if (session.scopes.some((scope) => !granted.has(scope))) throw new Error("Google did not grant every selected capability.");
      const verification = await this.#fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tokens.accessToken}` } });
      if (!verification.ok) throw new Error("Kestrel could not verify the Google Workspace account.");
      await this.#store.set(CLIENT_ID, session.clientId);
      await this.#store.set(TOKENS_ID, JSON.stringify(tokens));
      session.view = { sessionId: session.sessionId, state: "complete", expiresAt: session.view.expiresAt };
      session.callbackServer.close();
      return { status: 200, message: "Google Workspace connected. You can return to Kestrel." };
    } catch { session.view = { ...session.view, state: "failed", error: "Kestrel could not authorize this Google Workspace connection." }; session.callbackServer.close(); return { status: 500, message: session.view.error }; }
  }

  #expire() { for (const [sessionId, session] of this.#sessions) { if (this.#now() < session.expiresAtMs) continue; if (session.view.state === "awaiting_user") this.#expireSession(session); else this.#sessions.delete(sessionId); } }
  #expireSession(session: ActiveSession) { session.view = { sessionId: session.sessionId, state: "expired", expiresAt: session.view.expiresAt }; session.callbackServer.close(); }
}

function parseClientId(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("The Google Workspace client identity is invalid."); return value; }
function parsePacks(value: unknown): GoogleWorkspacePack[] { if (!Array.isArray(value) || value.length === 0 || value.some((pack) => typeof pack !== "string" || !isGoogleWorkspacePack(pack))) throw new Error("Choose valid Google Workspace capabilities before connecting."); return [...new Set(value)] as GoogleWorkspacePack[]; }
function listen(server: Server): Promise<void> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); }); }
function writeCallback(response: import("node:http").ServerResponse, status: number, message: string) { response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(message); }
