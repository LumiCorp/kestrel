import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";

import type { LocalCoreCredentialStore } from "./credentialStore.js";

const ACCOUNT_CREDENTIAL_ID = "kestrel_one.account" as const;
const SESSION_TTL_MS = 10 * 60_000;

export interface KestrelOneAccountProjection {
  account: {
    id: string;
    name: string;
    email: string;
    image?: string | null | undefined;
  };
  organizations: Array<{
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    organizationRole: string;
  }>;
  projects: Array<{
    id: string;
    organizationId: string;
    name: string;
    description?: string | null | undefined;
    environmentId: string;
    environmentProvider: "fly" | "desktop";
    desktopWorkspaceRef?: string | null | undefined;
    role: "owner" | "editor" | "member";
  }>;
  threads: Array<{
    id: string;
    projectId: string;
    title?: string | null | undefined;
    interactionMode: "chat" | "plan" | "build";
    activeStreamId?: string | null | undefined;
    updatedAt: string;
  }>;
}

export type KestrelOneAccountStatus =
  | { status: "signed_out" }
  | {
      status: "signed_in";
      baseUrl: string;
      projection: KestrelOneAccountProjection;
    };

export type KestrelOneAuthorizationSessionView = {
  sessionId: string;
  state: "awaiting_user" | "complete" | "failed" | "expired";
  authorizationUrl?: string | undefined;
  expiresAt: string;
  error?: string | undefined;
};

export type KestrelOneSubmittedTurn = {
  id: string;
  sequence: number;
  status: string;
};

export type KestrelOneThreadSnapshot = {
  snapshotVersion: string;
  thread: {
    id: string;
    projectId?: string | null | undefined;
    title: string;
    interactionMode: "chat" | "plan" | "build";
    updatedAt: string;
  };
  messages: Array<{
    id: string;
    turnId?: string | null | undefined;
    role: "user" | "assistant" | "system";
    createdAt: string;
    parts: Array<{
      kind:
        | "text"
        | "progress"
        | "tool"
        | "artifact"
        | "citation"
        | "source"
        | "interaction"
        | "status";
      label: string;
      text: string;
    }>;
  }>;
  turns: Array<{
    id: string;
    sequence: number;
    status: string;
    stage: string;
    updatedAt: string;
    failure?: { code: string; message: string } | null | undefined;
  }>;
  queue: {
    state: "running" | "paused";
    activeTurnId?: string | null | undefined;
    queuedTurnIds: string[];
  };
};

export type KestrelOneDesktopPreview = {
  id: string;
  publicUrl: string;
  expiresAt: string;
  maximumExpiresAt: string;
  status: string;
};

interface StoredAccountCredential {
  baseUrl: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
}

interface ActiveSession {
  sessionId: string;
  baseUrl: string;
  verifier: string;
  stateValue: string;
  callbackHost: string;
  callbackPath: string;
  callbackServer: Server;
  expiresAtMs: number;
  callbackClaimed: boolean;
  view: KestrelOneAuthorizationSessionView;
}

export class LocalCoreKestrelOneAccountManager {
  readonly #store: LocalCoreCredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #previews = new Map<string, DesktopPreviewTunnel>();
  #refreshPromise: Promise<StoredAccountCredential> | undefined;

  constructor(input: {
    credentialStore: LocalCoreCredentialStore;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.#store = input.credentialStore;
    this.#fetch = input.fetchImpl ?? fetch;
    this.#now = input.now ?? Date.now;
  }

  async start(input: {
    baseUrl: string;
  }): Promise<KestrelOneAuthorizationSessionView> {
    if (!this.#store.available) {
      throw new Error("Secure Kestrel One account storage is unavailable.");
    }
    this.#expireSessions();
    if (
      [...this.#sessions.values()].some(
        (session) => session.view.state === "awaiting_user",
      )
    ) {
      throw new Error("Kestrel One already has a sign-in window open.");
    }
    const baseUrl = parseBaseUrl(input.baseUrl);
    const sessionId = randomBytes(18).toString("base64url");
    const stateValue = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const callbackPath = `/oauth/callback/${sessionId}`;
    let active: ActiveSession | undefined;
    const callbackServer = createServer((request, response) => {
      if (!active) {
        writeCallback(response, 503, "Kestrel One sign-in is not ready.");
        return;
      }
      void this.#handleCallback(
        active,
        request.method,
        request.headers.host,
        request.url,
      )
        .then((result) =>
          writeCallback(
            response,
            result.status,
            result.message ?? "Kestrel One sign-in could not be completed.",
          ),
        )
        .catch(() =>
          writeCallback(
            response,
            500,
            "Kestrel One sign-in could not be completed.",
          ),
        );
    });
    await listen(callbackServer);
    const address = callbackServer.address();
    if (!address || typeof address === "string") {
      callbackServer.close();
      throw new Error("Kestrel could not create the account callback.");
    }
    const callbackHost = `127.0.0.1:${address.port}`;
    const redirectUri = `http://${callbackHost}${callbackPath}`;
    const expiresAtMs = this.#now() + SESSION_TTL_MS;
    const authorizationUrl = new URL("/desktop/auth/authorize", baseUrl);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: stateValue,
    }).toString();
    active = {
      sessionId,
      baseUrl,
      verifier,
      stateValue,
      callbackHost,
      callbackPath,
      callbackServer,
      expiresAtMs,
      callbackClaimed: false,
      view: {
        sessionId,
        state: "awaiting_user",
        authorizationUrl: authorizationUrl.toString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
    this.#sessions.set(sessionId, active);
    return { ...active.view };
  }

  status(sessionId: string): KestrelOneAuthorizationSessionView | undefined {
    this.#expireSessions();
    if (!/^[A-Za-z0-9_-]{24}$/u.test(sessionId)) {
      throw new Error("The Kestrel One authorization session ID is invalid.");
    }
    const session = this.#sessions.get(sessionId);
    return session ? { ...session.view } : undefined;
  }

  async account(): Promise<KestrelOneAccountStatus> {
    if (!this.#store.available) return { status: "signed_out" };
    const stored = await this.#readCredential();
    if (!stored) return { status: "signed_out" };
    const credential = await this.#refreshIfNeeded(stored);
    const response = await this.#fetch(
      new URL("/api/desktop/v1/account", credential.baseUrl),
      {
        headers: { authorization: `Bearer ${credential.accessToken}` },
      },
    );
    if (response.status === 401) {
      await this.#store.delete(ACCOUNT_CREDENTIAL_ID);
      throw new Error("Kestrel One rejected this account.");
    }
    if (!response.ok) {
      throw new Error(
        `Kestrel One account request failed with HTTP ${response.status}.`,
      );
    }
    return {
      status: "signed_in",
      baseUrl: credential.baseUrl,
      projection: parseAccountProjection(await response.json()),
    };
  }

  async signOut(): Promise<KestrelOneAccountStatus> {
    const stored = await this.#readCredential();
    if (stored) {
      const credential = await this.#refreshIfNeeded(stored).catch(
        () => stored,
      );
      await this.#fetch(
        new URL("/api/desktop/v1/account", credential.baseUrl),
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${credential.accessToken}` },
        },
      ).catch(() => undefined);
    }
    await this.#store.delete(ACCOUNT_CREDENTIAL_ID);
    return { status: "signed_out" };
  }

  async submitTurn(input: {
    threadId: string;
    text: string;
    interactionMode: "chat" | "plan" | "build";
    model?: string | undefined;
  }): Promise<KestrelOneSubmittedTurn> {
    const stored = await this.#readCredential();
    if (!stored) throw new Error("Sign in to Kestrel One first.");
    const credential = await this.#refreshIfNeeded(stored);
    const messageId = crypto.randomUUID();
    const response = await this.#fetch(
      new URL(
        `/api/desktop/v1/threads/${encodeURIComponent(input.threadId)}/turns`,
        credential.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
          "idempotency-key": messageId,
        },
        body: JSON.stringify({
          messageId,
          text: input.text,
          interactionMode: input.interactionMode,
          ...(input.model ? { model: input.model } : {}),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Kestrel One turn submission failed with HTTP ${response.status}.`,
      );
    }
    const body = requireRecord(await response.json(), "turn submission");
    const turn = requireRecord(body.turn, "turn");
    return {
      id: requireText(turn.id, "turn.id"),
      sequence: requireInteger(turn.sequence, "turn.sequence"),
      status: requireText(turn.status, "turn.status"),
    };
  }

  async thread(threadId: string): Promise<KestrelOneThreadSnapshot> {
    const credential = await this.#requireCredential();
    const response = await this.#fetch(
      new URL(
        `/api/desktop/v1/threads/${encodeURIComponent(requireText(threadId, "threadId"))}`,
        credential.baseUrl,
      ),
      {
        headers: { authorization: `Bearer ${credential.accessToken}` },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Kestrel One Thread request failed with HTTP ${response.status}.`,
      );
    }
    return parseThreadSnapshot(await response.json());
  }

  async publishPreview(input: {
    projectId: string;
    connectionId: string;
    localRunRef: string;
    localUrl: string;
    name?: string | undefined;
  }): Promise<KestrelOneDesktopPreview> {
    const target = parseLocalPreviewUrl(input.localUrl);
    const credential = await this.#requireCredential();
    const response = await this.#fetch(
      new URL("/api/desktop/v1/previews", credential.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: input.projectId,
          connectionId: input.connectionId,
          localRunRef: input.localRunRef,
          port: target.port,
          ...(input.name ? { name: input.name } : {}),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Kestrel One preview publication failed with HTTP ${response.status}.`,
      );
    }
    const publication = parseDesktopPreviewPublication(
      await response.json(),
      true,
    );
    const tunnel = new DesktopPreviewTunnel({
      previewId: publication.preview.id,
      tunnelUrl: publication.tunnelUrl!,
      tunnelToken: publication.tunnelToken!,
      localOrigin: target.origin,
      expiresAt: publication.preview.expiresAt,
    });
    this.#previews.get(publication.preview.id)?.close();
    this.#previews.set(publication.preview.id, tunnel);
    tunnel.start();
    return publication.preview;
  }

  async renewPreview(previewId: string): Promise<KestrelOneDesktopPreview> {
    const credential = await this.#requireCredential();
    const response = await this.#fetch(
      new URL(
        `/api/desktop/v1/previews/${encodeURIComponent(previewId)}`,
        credential.baseUrl,
      ),
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${credential.accessToken}` },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Kestrel One preview renewal failed with HTTP ${response.status}.`,
      );
    }
    const preview = parseDesktopPreviewPublication(
      await response.json(),
      false,
    ).preview;
    this.#previews.get(previewId)?.renew(preview.expiresAt);
    return preview;
  }

  async unpublishPreview(previewId: string): Promise<void> {
    const credential = await this.#requireCredential();
    const response = await this.#fetch(
      new URL(
        `/api/desktop/v1/previews/${encodeURIComponent(previewId)}`,
        credential.baseUrl,
      ),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${credential.accessToken}` },
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Kestrel One preview unpublish failed with HTTP ${response.status}.`,
      );
    }
    this.#previews.get(previewId)?.close();
    this.#previews.delete(previewId);
  }

  async close() {
    for (const preview of this.#previews.values()) preview.close();
    this.#previews.clear();
    for (const session of this.#sessions.values()) {
      session.callbackServer.close();
    }
    this.#sessions.clear();
  }

  async #handleCallback(
    session: ActiveSession,
    method: string | undefined,
    host: string | undefined,
    requestUrl: string | undefined,
  ) {
    if (this.#now() >= session.expiresAtMs) {
      this.#expireSession(session);
      return {
        status: 410,
        message:
          "Kestrel One sign-in expired. Return to Kestrel and try again.",
      };
    }
    if (method !== "GET" || host !== session.callbackHost || !requestUrl) {
      return { status: 400, message: "This account callback is invalid." };
    }
    const url = new URL(requestUrl, `http://${session.callbackHost}`);
    if (
      url.pathname !== session.callbackPath ||
      url.searchParams.get("state") !== session.stateValue
    ) {
      return {
        status: 400,
        message: "This account callback could not be verified.",
      };
    }
    if (session.callbackClaimed) {
      return {
        status: 409,
        message: "This account callback has already been used.",
      };
    }
    session.callbackClaimed = true;
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) {
      session.view = {
        ...session.view,
        state: "failed",
        error: "Kestrel One sign-in was not authorized.",
      };
      session.callbackServer.close();
      return { status: 400, message: session.view.error };
    }
    try {
      const redirectUri = `http://${session.callbackHost}${session.callbackPath}`;
      const response = await this.#fetch(
        new URL("/api/desktop/v1/oauth/token", session.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: session.verifier,
          }),
        },
      );
      if (!response.ok) {
        throw new Error("Kestrel One rejected the authorization exchange.");
      }
      const credential = parseTokenResponse(
        await response.json(),
        session.baseUrl,
        this.#now(),
      );
      await this.#store.set(ACCOUNT_CREDENTIAL_ID, JSON.stringify(credential));
      session.view = {
        sessionId: session.sessionId,
        state: "complete",
        expiresAt: session.view.expiresAt,
      };
      session.callbackServer.close();
      return {
        status: 200,
        message: "Kestrel One connected. You can return to Kestrel Desktop.",
      };
    } catch {
      session.view = {
        ...session.view,
        state: "failed",
        error: "Kestrel One sign-in could not be completed.",
      };
      session.callbackServer.close();
      return { status: 500, message: session.view.error };
    }
  }

  async #refreshIfNeeded(
    stored: StoredAccountCredential,
  ): Promise<StoredAccountCredential> {
    if (Date.parse(stored.accessTokenExpiresAt) > this.#now() + 30_000) {
      return stored;
    }
    if (this.#refreshPromise) return this.#refreshPromise;
    const refresh = this.#refreshCredential(stored);
    this.#refreshPromise = refresh;
    const clear = () => {
      if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
    };
    void refresh.then(clear, clear);
    return refresh;
  }

  async #refreshCredential(
    stale: StoredAccountCredential,
  ): Promise<StoredAccountCredential> {
    const stored = (await this.#readCredential()) ?? stale;
    if (
      stored.refreshToken !== stale.refreshToken ||
      Date.parse(stored.accessTokenExpiresAt) > this.#now() + 30_000
    ) {
      return stored;
    }
    const response = await this.#fetch(
      new URL("/api/desktop/v1/oauth/token", stored.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: stored.refreshToken,
        }),
      },
    );
    if (!response.ok) throw new Error("Kestrel One refresh token is invalid.");
    const refreshed = parseTokenResponse(
      await response.json(),
      stored.baseUrl,
      this.#now(),
    );
    await this.#store.set(ACCOUNT_CREDENTIAL_ID, JSON.stringify(refreshed));
    return refreshed;
  }

  async #readCredential(): Promise<StoredAccountCredential | undefined> {
    const value = await this.#store.get(ACCOUNT_CREDENTIAL_ID);
    if (!value) return undefined;
    return parseStoredCredential(JSON.parse(value) as unknown);
  }

  async #requireCredential() {
    const stored = await this.#readCredential();
    if (!stored) throw new Error("Sign in to Kestrel One first.");
    return this.#refreshIfNeeded(stored);
  }

  #expireSessions() {
    for (const [id, session] of this.#sessions) {
      if (this.#now() < session.expiresAtMs) continue;
      if (session.view.state === "awaiting_user") this.#expireSession(session);
      else this.#sessions.delete(id);
    }
  }

  #expireSession(session: ActiveSession) {
    session.view = {
      sessionId: session.sessionId,
      state: "expired",
      expiresAt: session.view.expiresAt,
    };
    session.callbackServer.close();
  }
}

function parseTokenResponse(
  value: unknown,
  baseUrl: string,
  now: number,
): StoredAccountCredential {
  const record = requireRecord(value, "Kestrel One token response");
  if (
    record.token_type !== "Bearer" ||
    typeof record.access_token !== "string" ||
    typeof record.refresh_token !== "string" ||
    !Number.isInteger(record.expires_in) ||
    (record.expires_in as number) < 60
  ) {
    throw new Error("Kestrel One returned invalid account credentials.");
  }
  return {
    baseUrl,
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    accessTokenExpiresAt: new Date(
      now + (record.expires_in as number) * 1000,
    ).toISOString(),
  };
}

function parseStoredCredential(value: unknown): StoredAccountCredential {
  const record = requireRecord(value, "stored Kestrel One account");
  return {
    baseUrl: parseBaseUrl(requireText(record.baseUrl, "baseUrl")),
    accessToken: requireText(record.accessToken, "accessToken"),
    accessTokenExpiresAt: requireDate(record.accessTokenExpiresAt),
    refreshToken: requireText(record.refreshToken, "refreshToken"),
  };
}

class DesktopPreviewTunnel {
  readonly #previewId: string;
  readonly #tunnelUrl: string;
  readonly #tunnelToken: string;
  readonly #localOrigin: string;
  #expiresAt: number;
  readonly #localSockets = new Map<string, WebSocket>();
  #socket: WebSocket | undefined;
  #closed = false;
  #reconnectTimer: NodeJS.Timeout | undefined;

  constructor(input: {
    previewId: string;
    tunnelUrl: string;
    tunnelToken: string;
    localOrigin: string;
    expiresAt: string;
  }) {
    this.#previewId = input.previewId;
    this.#tunnelUrl = input.tunnelUrl;
    this.#tunnelToken = input.tunnelToken;
    this.#localOrigin = input.localOrigin;
    this.#expiresAt = Date.parse(input.expiresAt);
  }

  start() {
    this.#connect();
  }

  close() {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#socket?.close(1000);
    for (const socket of this.#localSockets.values()) socket.close(1000);
    this.#localSockets.clear();
  }

  renew(expiresAt: string) {
    const nextExpiresAt = Date.parse(expiresAt);
    if (!Number.isFinite(nextExpiresAt)) {
      throw new Error("Desktop preview expiration is invalid.");
    }
    this.#expiresAt = nextExpiresAt;
    if (!this.#closed && !this.#socket && Date.now() < this.#expiresAt) {
      if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
      this.#connect();
    }
  }

  #connect() {
    if (this.#closed || Date.now() >= this.#expiresAt) return;
    const socket = new WebSocket(this.#tunnelUrl, {
      headers: { authorization: `Bearer ${this.#tunnelToken}` },
      maxPayload: 40 * 1024 * 1024,
    });
    this.#socket = socket;
    socket.on("message", (data) => {
      void this.#handleMessage(webSocketDataBuffer(data).toString("utf8"));
    });
    socket.once("close", () => {
      if (this.#socket === socket) this.#socket = undefined;
      if (!this.#closed && Date.now() < this.#expiresAt) {
        this.#reconnectTimer = setTimeout(() => this.#connect(), 1_000);
        this.#reconnectTimer.unref();
      }
    });
    socket.once("error", () => socket.close());
  }

  async #handleMessage(raw: string) {
    let message: Record<string, unknown>;
    try {
      message = requireRecord(
        JSON.parse(raw) as unknown,
        "preview tunnel message",
      );
    } catch {
      return;
    }
    const id = typeof message.id === "string" ? message.id : "";
    if (!id) return;
    if (message.type === "http.request") {
      await this.#handleHttp(id, message);
      return;
    }
    if (message.type === "websocket.open") {
      this.#openWebSocket(id, message);
      return;
    }
    const local = this.#localSockets.get(id);
    if (!local) return;
    if (message.type === "websocket.data" && typeof message.data === "string") {
      local.send(Buffer.from(message.data, "base64"), {
        binary: message.binary === true,
      });
    } else if (message.type === "websocket.close") {
      local.close(
        typeof message.code === "number" ? message.code : 1000,
        typeof message.reason === "string" ? message.reason.slice(0, 123) : "",
      );
    }
  }

  async #handleHttp(id: string, message: Record<string, unknown>) {
    try {
      const target = localTargetUrl(
        this.#localOrigin,
        requireTunnelPath(message.path),
      );
      const requestBody =
        typeof message.body === "string" && message.body.length > 0
          ? Buffer.from(message.body, "base64")
          : undefined;
      const response = await fetch(target, {
        method: requireHttpMethod(message.method),
        headers: parseTunnelHeaders(message.headers),
        ...(requestBody ? { body: requestBody } : {}),
        redirect: "manual",
      });
      const body = Buffer.from(await response.arrayBuffer());
      this.#send({
        type: "http.response",
        id,
        status: response.status,
        headers: responseHeaders(response.headers),
        body: body.toString("base64"),
      });
    } catch {
      this.#send({
        type: "http.response",
        id,
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from("Local preview unavailable.").toString("base64"),
      });
    }
  }

  #openWebSocket(id: string, message: Record<string, unknown>) {
    let target: URL;
    try {
      target = localTargetUrl(
        this.#localOrigin,
        requireTunnelPath(message.path),
      );
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    } catch {
      this.#send({ type: "websocket.error", id });
      return;
    }
    const local = new WebSocket(target, {
      headers: headersRecord(parseTunnelHeaders(message.headers)),
      maxPayload: 40 * 1024 * 1024,
    });
    this.#localSockets.set(id, local);
    local.on("message", (data, isBinary) =>
      this.#send({
        type: "websocket.data",
        id,
        binary: isBinary,
        data: webSocketDataBuffer(data).toString("base64"),
      }),
    );
    local.once("close", (code, reason) => {
      this.#localSockets.delete(id);
      this.#send({
        type: "websocket.close",
        id,
        code,
        reason: reason.toString(),
      });
    });
    local.once("error", () => {
      this.#send({ type: "websocket.error", id });
      local.close();
    });
  }

  #send(message: Record<string, unknown>) {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }
}

function parseDesktopPreviewPublication(
  value: unknown,
  requireTunnel: boolean,
) {
  const record = requireRecord(value, "Desktop preview publication");
  const preview: KestrelOneDesktopPreview = {
    id: requireText(record.id, "preview.id"),
    publicUrl: requireSecureUrl(record.publicUrl, "preview.publicUrl", [
      "https:",
    ]),
    expiresAt: requireDate(record.expiresAt),
    maximumExpiresAt: requireDate(record.maximumExpiresAt),
    status: requireText(record.status, "preview.status"),
  };
  const tunnelUrl =
    record.tunnelUrl === undefined
      ? undefined
      : requireSecureUrl(record.tunnelUrl, "preview.tunnelUrl", [
          "wss:",
          "ws:",
        ]);
  const tunnelToken =
    record.tunnelToken === undefined
      ? undefined
      : requireText(record.tunnelToken, "preview.tunnelToken");
  if (requireTunnel && !(tunnelUrl && tunnelToken)) {
    throw new Error("Kestrel One preview tunnel details are missing.");
  }
  return { preview, tunnelUrl, tunnelToken };
}

function parseLocalPreviewUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("Only an HTTP loopback preview URL can be published.");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("The local preview port is invalid.");
  }
  return { origin: url.origin, port };
}

function localTargetUrl(origin: string, path: string) {
  const url = new URL(path, origin);
  if (url.origin !== origin)
    throw new Error("Preview target escaped loopback.");
  return url;
}

function requireTunnelPath(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error("Preview tunnel path is invalid.");
  }
  return value;
}

function requireHttpMethod(value: unknown) {
  if (
    typeof value !== "string" ||
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
      value,
    )
  ) {
    throw new Error("Preview HTTP method is invalid.");
  }
  return value;
}

function parseTunnelHeaders(value: unknown) {
  const record = requireRecord(value, "preview headers");
  const headers = new Headers();
  for (const [name, candidate] of Object.entries(record)) {
    if (
      ["host", "connection", "upgrade", "content-length", "cookie"].includes(
        name.toLowerCase(),
      )
    ) {
      continue;
    }
    if (typeof candidate === "string") headers.set(name, candidate);
    else if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === "string") headers.append(name, item);
      }
    }
  }
  return headers;
}

function responseHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!["connection", "transfer-encoding", "content-length"].includes(name)) {
      result[name] = value;
    }
  });
  return result;
}

function headersRecord(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

function requireSecureUrl(value: unknown, field: string, protocols: string[]) {
  const text = requireText(value, field);
  const url = new URL(text);
  if (
    !protocols.includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === "ws:" &&
      !["127.0.0.1", "localhost"].includes(url.hostname))
  ) {
    throw new Error(`${field} is invalid.`);
  }
  return url.toString();
}

function webSocketDataBuffer(value: WebSocket.RawData) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(new Uint8Array(value));
}

function parseAccountProjection(value: unknown): KestrelOneAccountProjection {
  const record = requireRecord(value, "Kestrel One account");
  const account = requireRecord(record.account, "account");
  return {
    account: {
      id: requireText(account.id, "account.id"),
      name: requireText(account.name, "account.name"),
      email: requireText(account.email, "account.email"),
      ...(account.image === null
        ? { image: null }
        : account.image === undefined
          ? {}
          : { image: requireText(account.image, "account.image") }),
    },
    organizations: requireArray(record.organizations, "organizations").map(
      (value) => {
        const item = requireRecord(value, "organization");
        return {
          organizationId: requireText(item.organizationId, "organization.id"),
          organizationName: requireText(
            item.organizationName,
            "organization.name",
          ),
          organizationSlug: requireText(
            item.organizationSlug,
            "organization.slug",
          ),
          organizationRole: requireText(
            item.organizationRole,
            "organization.role",
          ),
        };
      },
    ),
    projects: requireArray(record.projects, "projects").map((value) => {
      const item = requireRecord(value, "project");
      const provider = item.environmentProvider;
      const role = item.role;
      if (
        (provider !== "fly" && provider !== "desktop") ||
        (role !== "owner" && role !== "editor" && role !== "member")
      ) {
        throw new Error("Kestrel One project projection is invalid.");
      }
      return {
        id: requireText(item.id, "project.id"),
        organizationId: requireText(
          item.organizationId,
          "project.organizationId",
        ),
        name: requireText(item.name, "project.name"),
        ...(item.description === null
          ? { description: null }
          : item.description === undefined
            ? {}
            : {
                description: requireText(
                  item.description,
                  "project.description",
                ),
              }),
        environmentId: requireText(item.environmentId, "project.environmentId"),
        environmentProvider: provider,
        ...(item.desktopWorkspaceRef === null
          ? { desktopWorkspaceRef: null }
          : item.desktopWorkspaceRef === undefined
            ? {}
            : {
                desktopWorkspaceRef: requireText(
                  item.desktopWorkspaceRef,
                  "project.desktopWorkspaceRef",
                ),
              }),
        role,
      };
    }),
    threads: requireArray(record.threads, "threads").map((value) => {
      const item = requireRecord(value, "thread");
      const mode = item.interactionMode;
      if (mode !== "chat" && mode !== "plan" && mode !== "build") {
        throw new Error("Kestrel One Thread mode is invalid.");
      }
      return {
        id: requireText(item.id, "thread.id"),
        projectId: requireText(item.projectId, "thread.projectId"),
        ...(item.title === null
          ? { title: null }
          : item.title === undefined
            ? {}
            : { title: requireText(item.title, "thread.title") }),
        interactionMode: mode,
        ...(item.activeStreamId === null
          ? { activeStreamId: null }
          : item.activeStreamId === undefined
            ? {}
            : {
                activeStreamId: requireText(
                  item.activeStreamId,
                  "thread.activeStreamId",
                ),
              }),
        updatedAt: requireDate(item.updatedAt),
      };
    }),
  };
}

function parseThreadSnapshot(value: unknown): KestrelOneThreadSnapshot {
  const record = requireRecord(value, "Kestrel One Thread");
  const thread = requireRecord(record.thread, "thread");
  const interactionMode = thread.interactionMode;
  if (
    interactionMode !== "chat" &&
    interactionMode !== "plan" &&
    interactionMode !== "build"
  ) {
    throw new Error("Kestrel One Thread mode is invalid.");
  }
  const queue = requireRecord(record.queue, "queue");
  if (queue.state !== "running" && queue.state !== "paused") {
    throw new Error("Kestrel One Thread queue state is invalid.");
  }
  return {
    snapshotVersion: requireText(record.snapshotVersion, "snapshotVersion"),
    thread: {
      id: requireText(thread.id, "thread.id"),
      ...(thread.projectId === null
        ? { projectId: null }
        : thread.projectId === undefined
          ? {}
          : { projectId: requireText(thread.projectId, "thread.projectId") }),
      title: requireText(thread.title, "thread.title"),
      interactionMode,
      updatedAt: requireDate(thread.updatedAt),
    },
    messages: requireArray(record.messages, "messages").map((value) => {
      const message = requireRecord(value, "message");
      const role = message.role;
      if (role !== "user" && role !== "assistant" && role !== "system") {
        throw new Error("Kestrel One message role is invalid.");
      }
      return {
        id: requireText(message.id, "message.id"),
        ...(message.turnId === null
          ? { turnId: null }
          : message.turnId === undefined
            ? {}
            : { turnId: requireText(message.turnId, "message.turnId") }),
        role,
        createdAt: requireDate(message.createdAt),
        parts: requireArray(message.parts, "message.parts").map((value) => {
          const part = requireRecord(value, "message part");
          const kind = part.kind;
          if (
            kind !== "text" &&
            kind !== "progress" &&
            kind !== "tool" &&
            kind !== "artifact" &&
            kind !== "citation" &&
            kind !== "source" &&
            kind !== "interaction" &&
            kind !== "status"
          ) {
            throw new Error("Kestrel One message part kind is invalid.");
          }
          return {
            kind,
            label: requireText(part.label, "message part label"),
            text: requireText(part.text, "message part text"),
          };
        }),
      };
    }),
    turns: requireArray(record.turns, "turns").map((value) => {
      const turn = requireRecord(value, "turn");
      let failure: { code: string; message: string } | null | undefined;
      if (turn.failure === null) {
        failure = null;
      } else if (turn.failure !== undefined) {
        const detail = requireRecord(turn.failure, "turn.failure");
        failure = {
          code: requireText(detail.code, "turn.failure.code"),
          message: requireText(detail.message, "turn.failure.message"),
        };
      }
      return {
        id: requireText(turn.id, "turn.id"),
        sequence: requireInteger(turn.sequence, "turn.sequence"),
        status: requireText(turn.status, "turn.status"),
        stage: requireText(turn.stage, "turn.stage"),
        updatedAt: requireDate(turn.updatedAt),
        ...(failure !== undefined ? { failure } : {}),
      };
    }),
    queue: {
      state: queue.state,
      ...(queue.activeTurnId === null
        ? { activeTurnId: null }
        : queue.activeTurnId === undefined
          ? {}
          : {
              activeTurnId: requireText(
                queue.activeTurnId,
                "queue.activeTurnId",
              ),
            }),
      queuedTurnIds: requireArray(
        queue.queuedTurnIds,
        "queue.queuedTurnIds",
      ).map((value) => requireText(value, "queued turn ID")),
    },
  };
}

function parseBaseUrl(value: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      )) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Kestrel One URL must be HTTPS (or loopback HTTP for development).",
    );
  }
  return url.origin;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requireText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireDate(value: unknown) {
  const text = requireText(value, "timestamp");
  if (Number.isNaN(Date.parse(text))) throw new Error("Timestamp is invalid.");
  return text;
}

function requireInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid.`);
  return value as number;
}

function listen(server: Server) {
  return new Promise<void>((resolve, reject) => {
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
) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(message);
}
