import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  MICROSOFT_365_CREDENTIAL_PREFIX,
  isMicrosoft365Pack,
  resourceScopesForMicrosoft365Packs,
  scopesForMicrosoft365Packs,
  type Microsoft365Pack,
} from "../apps/microsoft365.js";
import type { LocalCoreCredentialId, LocalCoreCredentialStore } from "./credentialStore.js";
import type { LocalCoreMcpOAuthSessionView } from "./mcpOAuthSessions.js";
import { parseTokenResponse } from "./microsoft365Service.js";

const AUTHORIZATION_ENDPOINT =
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";
const TOKEN_ENDPOINT =
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const CLIENT_ID = `${MICROSOFT_365_CREDENTIAL_PREFIX}.oauth.client` as LocalCoreCredentialId;
const TOKENS_ID = `${MICROSOFT_365_CREDENTIAL_PREFIX}.oauth.tokens` as LocalCoreCredentialId;

export interface Microsoft365OAuthStartInput {
  clientId: string;
  packs: Microsoft365Pack[];
}

interface ActiveSession {
  sessionId: string;
  clientId: string;
  packs: Microsoft365Pack[];
  scopes: string[];
  verifier: string;
  stateValue: string;
  callbackServer: Server;
  callbackHost: string;
  callbackPath: string;
  expiresAtMs: number;
  view: LocalCoreMcpOAuthSessionView;
}

export class LocalCoreMicrosoft365OAuthSessionManager {
  readonly #store: LocalCoreCredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #sessions = new Map<string, ActiveSession>();

  constructor(options: {
    credentialStore: LocalCoreCredentialStore;
    fetchImpl?: typeof fetch | undefined;
    now?: (() => number) | undefined;
    ttlMs?: number | undefined;
  }) {
    this.#store = options.credentialStore;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  }

  async start(input: Microsoft365OAuthStartInput): Promise<LocalCoreMcpOAuthSessionView> {
    this.#expire();
    if ([...this.#sessions.values()].some((session) => session.view.state === "awaiting_user")) {
      throw new Error("Microsoft 365 already has a connection window open.");
    }
    const clientId = parseClientId(input.clientId);
    const packs = parsePacks(input.packs);
    const scopes = scopesForMicrosoft365Packs(packs);
    const sessionId = randomBytes(18).toString("base64url");
    const stateValue = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const callbackPath = `/oauth/callback/${sessionId}`;
    let active: ActiveSession | undefined;
    const callbackServer = createServer((request, response) => {
      if (active === undefined) return writeCallback(response, 503, "This App connection is not ready.");
      void this.#callback(active, request.method, request.headers.host, request.url)
        .then((result) => writeCallback(response, result.status, result.message ?? "Kestrel could not complete this App connection."))
        .catch(() => writeCallback(response, 500, "Kestrel could not complete this App connection."));
    });
    await listen(callbackServer);
    const address = callbackServer.address();
    if (address === null || typeof address === "string") throw new Error("Kestrel could not create the App authorization callback.");
    const callbackHost = `127.0.0.1:${address.port}`;
    const redirectUri = `http://${callbackHost}${callbackPath}`;
    const expiresAtMs = this.#now() + this.#ttlMs;
    const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: scopes.join(" "),
      state: stateValue,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    active = {
      sessionId, clientId, packs, scopes, verifier, stateValue, callbackServer,
      callbackHost, callbackPath, expiresAtMs,
      view: { sessionId, state: "awaiting_user", authorizationUrl: authorizationUrl.toString(), expiresAt: new Date(expiresAtMs).toISOString() },
    };
    this.#sessions.set(sessionId, active);
    return { ...active.view };
  }

  status(sessionId: string): LocalCoreMcpOAuthSessionView | undefined {
    this.#expire();
    if (!/^[A-Za-z0-9_-]{24}$/u.test(sessionId)) throw new Error("The App authorization session ID is invalid.");
    const session = this.#sessions.get(sessionId);
    return session ? { ...session.view } : undefined;
  }

  async close(): Promise<void> {
    for (const session of this.#sessions.values()) session.callbackServer.close();
    this.#sessions.clear();
  }

  async #callback(session: ActiveSession, method: string | undefined, host: string | undefined, requestUrl: string | undefined) {
    if (this.#now() >= session.expiresAtMs) {
      this.#expireSession(session);
      return { status: 410, message: "This Microsoft 365 connection expired. Return to Kestrel and try again." };
    }
    if (method !== "GET" || host !== session.callbackHost || requestUrl === undefined) return { status: 400, message: "This App authorization callback is invalid." };
    const url = new URL(requestUrl, `http://${session.callbackHost}`);
    if (url.pathname !== session.callbackPath || url.searchParams.get("state") !== session.stateValue) return { status: 400, message: "This App authorization callback could not be verified." };
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code) {
      session.view = { ...session.view, state: "failed", error: url.searchParams.get("error") === "access_denied" ? "App authorization was cancelled." : "Microsoft did not authorize this connection." };
      session.callbackServer.close();
      return { status: 400, message: session.view.error! };
    }
    try {
      const redirectUri = `http://${session.callbackHost}${session.callbackPath}`;
      const response = await this.#fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: session.clientId, grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: session.verifier, scope: session.scopes.join(" ") }),
      });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error("Microsoft rejected the authorization exchange.");
      const tokens = parseTokenResponse(
        body,
        this.#now(),
        undefined,
        session.scopes.join(" "),
      );
      const granted = new Set(tokens.scope.split(/\s+/u).map((scope) => scope.toLowerCase()));
      if (
        resourceScopesForMicrosoft365Packs(session.packs).some(
          (scope) => !granted.has(scope.toLowerCase()),
        )
      ) throw new Error("Microsoft did not grant every selected capability.");
      const verification = await this.#fetch("https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName", { headers: { authorization: `Bearer ${tokens.accessToken}` } });
      if (!verification.ok) throw new Error("Kestrel could not verify the Microsoft 365 account.");
      await this.#store.set(CLIENT_ID, session.clientId);
      await this.#store.set(TOKENS_ID, JSON.stringify(tokens));
      session.view = { sessionId: session.sessionId, state: "complete", expiresAt: session.view.expiresAt };
      session.callbackServer.close();
      return { status: 200, message: "Microsoft 365 connected. You can return to Kestrel." };
    } catch {
      session.view = { ...session.view, state: "failed", error: "Kestrel could not authorize this Microsoft 365 connection." };
      session.callbackServer.close();
      return { status: 500, message: session.view.error };
    }
  }

  #expire() { for (const session of this.#sessions.values()) if (session.view.state === "awaiting_user" && this.#now() >= session.expiresAtMs) this.#expireSession(session); }
  #expireSession(session: ActiveSession) { session.view = { sessionId: session.sessionId, state: "expired", expiresAt: session.view.expiresAt }; session.callbackServer.close(); }
}

function parseClientId(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("The Microsoft 365 client identity is invalid."); return value; }
function parsePacks(value: unknown): Microsoft365Pack[] { if (!Array.isArray(value) || value.length === 0 || value.some((pack) => typeof pack !== "string" || !isMicrosoft365Pack(pack))) throw new Error("Choose valid Microsoft 365 capabilities before connecting."); return [...new Set(value)] as Microsoft365Pack[]; }
function listen(server: Server): Promise<void> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); }); }
function writeCallback(response: import("node:http").ServerResponse, status: number, message: string) { response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(message); }
