import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  auth,
  type AuthResult,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";

import type { LocalCoreCredentialStore } from "./credentialStore.js";
import {
  LocalCoreMcpOAuthProvider,
  parseOAuthCredentialPrefix,
} from "./mcpOAuthProvider.js";

const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;

type OAuthAuthorizationFunction = (
  provider: OAuthClientProvider,
  options: {
    serverUrl: string | URL;
    authorizationCode?: string;
    scope?: string;
  },
) => Promise<AuthResult>;

export interface LocalCoreMcpOAuthSessionStartInput {
  credentialPrefix: `mcp.${string}`;
  serverUrl: string;
  appName: string;
  clientId?: string | undefined;
  scopes?: readonly string[] | undefined;
}

export interface LocalCoreMcpOAuthSessionView {
  sessionId: string;
  state: "awaiting_user" | "complete" | "failed" | "expired";
  authorizationUrl?: string | undefined;
  error?: string | undefined;
  expiresAt: string;
}

export function parseLocalCoreMcpOAuthSessionStartInput(
  value: unknown,
): LocalCoreMcpOAuthSessionStartInput {
  const record = parseRecord(value, "App authorization request");
  rejectUnknown(
    record,
    new Set(["credentialPrefix", "serverUrl", "appName", "clientId", "scopes"]),
  );
  const scopes =
    record.scopes === undefined ? undefined : parseScopeList(record.scopes);
  return {
    credentialPrefix: parseOAuthCredentialPrefix(record.credentialPrefix),
    serverUrl: parseRequiredString(record.serverUrl, "remote App URL"),
    appName: parseRequiredString(record.appName, "App name"),
    ...(record.clientId !== undefined
      ? { clientId: parseClientId(record.clientId) }
      : {}),
    ...(scopes !== undefined ? { scopes } : {}),
  };
}

export function parseLocalCoreMcpOAuthSessionView(
  value: unknown,
): LocalCoreMcpOAuthSessionView {
  const record = parseRecord(value, "App authorization session");
  rejectUnknown(
    record,
    new Set(["sessionId", "state", "authorizationUrl", "error", "expiresAt"]),
  );
  if (
    record.state !== "awaiting_user" &&
    record.state !== "complete" &&
    record.state !== "failed" &&
    record.state !== "expired"
  ) {
    throw new Error("The App authorization session state is invalid.");
  }
  const sessionId = parseSessionId(
    parseRequiredString(record.sessionId, "App authorization session ID"),
  );
  const expiresAt = parseIsoDate(record.expiresAt, "App authorization expiry");
  const authorizationUrl =
    record.authorizationUrl === undefined
      ? undefined
      : parseHttpsAuthorizationUrl(record.authorizationUrl);
  const error =
    record.error === undefined
      ? undefined
      : parseRequiredString(record.error, "App authorization error");
  return {
    sessionId,
    state: record.state,
    ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
    ...(error !== undefined ? { error } : {}),
    expiresAt,
  };
}

interface ActiveOAuthSession {
  sessionId: string;
  credentialPrefix: `mcp.${string}`;
  stateValue: string;
  serverUrl: string;
  scope?: string | undefined;
  provider: LocalCoreMcpOAuthProvider;
  callbackServer: Server;
  callbackHost: string;
  callbackPath: string;
  view: LocalCoreMcpOAuthSessionView;
  expiresAtMs: number;
  callbackClaimed: boolean;
}

export class LocalCoreMcpOAuthSessionManager {
  readonly #credentialStore: LocalCoreCredentialStore;
  readonly #authorize: OAuthAuthorizationFunction;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, ActiveOAuthSession>();

  constructor(options: {
    credentialStore: LocalCoreCredentialStore;
    authorize?: OAuthAuthorizationFunction | undefined;
    ttlMs?: number | undefined;
    now?: (() => number) | undefined;
  }) {
    this.#credentialStore = options.credentialStore;
    this.#authorize = options.authorize ?? auth;
    this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new Error("The App authorization session lifetime is invalid.");
    }
  }

  async start(
    input: LocalCoreMcpOAuthSessionStartInput,
  ): Promise<LocalCoreMcpOAuthSessionView> {
    this.#expireSessions();
    const credentialPrefix = parseOAuthCredentialPrefix(input.credentialPrefix);
    if (
      [...this.#sessions.values()].some(
        (session) =>
          session.credentialPrefix === credentialPrefix &&
          session.view.state === "awaiting_user",
      )
    ) {
      throw new Error("This App already has a connection window open.");
    }
    const serverUrl = parseRemoteAppUrl(input.serverUrl);
    const appName = parseAppName(input.appName);
    const scope = normalizeScopes(input.scopes);
    const sessionId = randomBytes(18).toString("base64url");
    const stateValue = randomBytes(32).toString("base64url");
    const callbackPath = `/oauth/callback/${sessionId}`;
    let active: ActiveOAuthSession | undefined;
    const callbackServer = createServer((request, response) => {
      if (active === undefined) {
        writeCallback(response, 503, "This App connection is not ready.");
        return;
      }
      void this.#handleCallback(
        active,
        request.method,
        request.headers.host,
        request.url,
      )
        .then(({ status, message }) => writeCallback(response, status, message))
        .catch(() =>
          writeCallback(
            response,
            500,
            "Kestrel could not complete this App connection.",
          ),
        );
    });
    await listenOnLoopback(callbackServer);
    const address = callbackServer.address();
    if (address === null || typeof address === "string") {
      callbackServer.close();
      throw new Error(
        "Kestrel could not create the App authorization callback.",
      );
    }
    const callbackHost = `127.0.0.1:${address.port}`;
    const redirectUrl = `http://${callbackHost}${callbackPath}`;
    let authorizationUrl: string | undefined;
    const provider = new LocalCoreMcpOAuthProvider({
      credentialStore: this.#credentialStore,
      credentialPrefix,
      redirectUrl,
      authorizationState: stateValue,
      clientMetadata: {
        client_name: `Kestrel Desktop — ${appName}`,
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      onAuthorization(url) {
        authorizationUrl = url.toString();
      },
    });
    const expiresAtMs = this.#now() + this.#ttlMs;
    active = {
      sessionId,
      credentialPrefix,
      stateValue,
      serverUrl,
      ...(scope !== undefined ? { scope } : {}),
      provider,
      callbackServer,
      callbackHost,
      callbackPath,
      view: {
        sessionId,
        state: "awaiting_user",
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
      expiresAtMs,
      callbackClaimed: false,
    };
    this.#sessions.set(sessionId, active);
    try {
      if (input.clientId !== undefined) {
        await provider.saveClientInformation({
          client_id: parseClientId(input.clientId),
          token_endpoint_auth_method: "none",
        });
      }
      const result = await this.#authorize(provider, {
        serverUrl,
        ...(scope !== undefined ? { scope } : {}),
      });
      if (result === "AUTHORIZED") {
        active.view = { ...active.view, state: "complete" };
        await provider.invalidateCredentials("verifier");
        callbackServer.close();
      } else if (authorizationUrl === undefined) {
        throw new Error("The App did not provide an authorization URL.");
      } else {
        active.view = { ...active.view, authorizationUrl };
      }
    } catch (error) {
      await provider.invalidateCredentials("verifier").catch(() => undefined);
      active.view = {
        ...active.view,
        state: "failed",
        error: safeAuthorizationError(error),
      };
      callbackServer.close();
    }
    return cloneView(active.view);
  }

  status(sessionId: string): LocalCoreMcpOAuthSessionView | undefined {
    this.#expireSessions();
    const active = this.#sessions.get(parseSessionId(sessionId));
    return active === undefined ? undefined : cloneView(active.view);
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) {
      session.callbackServer.close();
    }
    this.#sessions.clear();
    await Promise.all(
      sessions
        .filter((session) => session.view.state === "awaiting_user")
        .map(
          async (session) =>
            await session.provider
              .invalidateCredentials("verifier")
              .catch(() => undefined),
        ),
    );
  }

  async #handleCallback(
    session: ActiveOAuthSession,
    method: string | undefined,
    host: string | undefined,
    requestUrl: string | undefined,
  ): Promise<{ status: number; message: string }> {
    if (this.#now() >= session.expiresAtMs) {
      this.#expireSession(session);
      return {
        status: 410,
        message:
          "This App connection expired. Return to Kestrel and try again.",
      };
    }
    if (
      method !== "GET" ||
      host !== session.callbackHost ||
      requestUrl === undefined
    ) {
      return {
        status: 400,
        message: "This App authorization callback is invalid.",
      };
    }
    const url = new URL(requestUrl, `http://${session.callbackHost}`);
    if (
      url.pathname !== session.callbackPath ||
      url.searchParams.get("state") !== session.stateValue
    ) {
      return {
        status: 400,
        message: "This App authorization callback could not be verified.",
      };
    }
    if (session.callbackClaimed) {
      return {
        status: 409,
        message: "This App authorization callback has already been used.",
      };
    }
    session.callbackClaimed = true;
    const providerError = url.searchParams.get("error");
    const authorizationCode = url.searchParams.get("code");
    if (
      providerError !== null ||
      authorizationCode === null ||
      authorizationCode.length === 0
    ) {
      await session.provider
        .invalidateCredentials("verifier")
        .catch(() => undefined);
      session.view = {
        ...session.view,
        state: "failed",
        error:
          providerError === "access_denied"
            ? "App authorization was cancelled."
            : "The App did not authorize this connection.",
      };
      session.callbackServer.close();
      return { status: 400, message: session.view.error! };
    }
    try {
      const result = await this.#authorize(session.provider, {
        serverUrl: session.serverUrl,
        authorizationCode,
        ...(session.scope !== undefined ? { scope: session.scope } : {}),
      });
      if (result !== "AUTHORIZED") {
        throw new Error("The App authorization exchange was incomplete.");
      }
      await session.provider.invalidateCredentials("verifier");
      session.view = {
        sessionId: session.sessionId,
        state: "complete",
        expiresAt: session.view.expiresAt,
      };
      session.callbackServer.close();
      return {
        status: 200,
        message: "App connected. You can return to Kestrel.",
      };
    } catch (error) {
      await session.provider
        .invalidateCredentials("verifier")
        .catch(() => undefined);
      session.view = {
        ...session.view,
        state: "failed",
        error: safeAuthorizationError(error),
      };
      session.callbackServer.close();
      return {
        status: 500,
        message: "Kestrel could not complete this App connection.",
      };
    }
  }

  #expireSessions(): void {
    for (const [sessionId, session] of this.#sessions) {
      if (this.#now() < session.expiresAtMs) continue;
      if (session.view.state === "awaiting_user") {
        this.#expireSession(session);
      } else {
        this.#sessions.delete(sessionId);
      }
    }
  }

  #expireSession(session: ActiveOAuthSession): void {
    void session.provider
      .invalidateCredentials("verifier")
      .catch(() => undefined);
    session.view = {
      sessionId: session.sessionId,
      state: "expired",
      expiresAt: session.view.expiresAt,
    };
    session.callbackServer.close();
  }
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function writeCallback(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(message);
}

function parseRemoteAppUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("The remote App URL must be credential-free HTTPS.");
  }
  return url.toString();
}

function parseAppName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("The App name is invalid.");
  }
  return name;
}

function parseClientId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("The App authorization client identity is invalid.");
  }
  return value;
}

function normalizeScopes(
  scopes: readonly string[] | undefined,
): string | undefined {
  if (scopes === undefined || scopes.length === 0) return undefined;
  const normalized = [...new Set(scopes.map((scope) => scope.trim()))];
  if (normalized.some((scope) => !scope || /\s/u.test(scope))) {
    throw new Error("The App authorization scopes are invalid.");
  }
  return normalized.sort().join(" ");
}

function parseSessionId(value: string): string {
  if (!/^[A-Za-z0-9_-]{24}$/u.test(value)) {
    throw new Error("The App authorization session ID is invalid.");
  }
  return value;
}

function safeAuthorizationError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "UnauthorizedError") {
    return "The App requires authorization.";
  }
  return "Kestrel could not authorize this App connection.";
}

function cloneView(
  view: LocalCoreMcpOAuthSessionView,
): LocalCoreMcpOAuthSessionView {
  return { ...view };
}

function parseRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`App authorization field '${unknown}' is unsupported.`);
  }
}

function parseRequiredString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function parseScopeList(value: unknown): string[] {
  if (
    Array.isArray(value) === false ||
    value.some((scope) => typeof scope !== "string")
  ) {
    throw new Error(
      "The App authorization scopes must be an array of strings.",
    );
  }
  return [...value] as string[];
}

function parseIsoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function parseHttpsAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("The App authorization URL is invalid.");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("The App authorization URL is invalid.");
  }
  return url.toString();
}
