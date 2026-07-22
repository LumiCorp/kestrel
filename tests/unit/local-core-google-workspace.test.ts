import assert from "node:assert/strict";
import { MemoryLocalCoreCredentialStore } from "../../src/localCore/credentialStore.js";
import { LocalCoreGoogleWorkspaceOAuthSessionManager } from "../../src/localCore/googleWorkspaceOAuthSessions.js";
import { LocalCoreGoogleWorkspaceService } from "../../src/localCore/googleWorkspaceService.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "Google Workspace Desktop OAuth uses PKCE and stores an offline Calendar grant in Core", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  const calls: string[] = [];
  const scopes = "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy";
  const manager = new LocalCoreGoogleWorkspaceOAuthSessionManager({
    credentialStore: store,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "google-access", refresh_token: "google-refresh", expires_in: 3600, scope: scopes }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ sub: "user-1", email: "person@example.com" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  try {
    const session = await manager.start({ clientId: "google-public-client", packs: ["calendar"] });
    const authorization = new URL(session.authorizationUrl!);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("access_type"), "offline");
    assert.equal(authorization.searchParams.get("scope"), scopes);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("code", "authorization-code");
    assert.equal((await fetch(callback)).status, 200);
    assert.equal(manager.status(session.sessionId)?.state, "complete");
    assert.equal(calls.length, 2);
    assert.equal(await store.get("mcp.standard.google_workspace.oauth.client"), "google-public-client");
    assert.ok((await store.get("mcp.standard.google_workspace.oauth.tokens"))?.includes("google-refresh"));
  } finally { await manager.close(); }
});

contractTest("runtime.hermetic", "Google Workspace Calendar refresh and API calls stay inside Local Core", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("mcp.standard.google_workspace.oauth.client", "google-client");
  await store.set("mcp.standard.google_workspace.oauth.tokens", JSON.stringify({ accessToken: "expired", refreshToken: "refresh-secret", expiresAt: 1, scope: "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy" }));
  const requests: string[] = [];
  const service = new LocalCoreGoogleWorkspaceService({ credentialStore: store, now: () => 100_000, fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    if (url.includes("oauth2.googleapis.com/token")) { assert.ok(String(init?.body).includes("refresh-secret")); return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } }); }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fresh");
    return new Response(JSON.stringify({ items: [{ id: "event-1" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  const result = await service.invoke("events.list", { timeMin: "2026-07-22T00:00:00Z", timeMax: "2026-07-23T00:00:00Z", maxResults: 5 }) as { events: unknown[] };
  assert.equal(result.events.length, 1);
  assert.equal(requests.some((url) => url.includes("refresh-secret")), false);
});

contractTest("runtime.hermetic", "Google Workspace OAuth exchanges a callback only once", async () => {
  let releaseTokenExchange!: () => void;
  const tokenExchangeReleased = new Promise<void>((resolve) => { releaseTokenExchange = resolve; });
  let markTokenExchangeStarted!: () => void;
  const tokenExchangeStarted = new Promise<void>((resolve) => { markTokenExchangeStarted = resolve; });
  const scopes = "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy";
  const manager = new LocalCoreGoogleWorkspaceOAuthSessionManager({
    credentialStore: new MemoryLocalCoreCredentialStore(),
    fetchImpl: (async (input: string | URL | Request) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        markTokenExchangeStarted();
        await tokenExchangeReleased;
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: scopes });
      }
      return Response.json({ sub: "user-1" });
    }) as typeof fetch,
  });
  try {
    const session = await manager.start({ clientId: "google-client", packs: ["calendar"] });
    const authorization = new URL(session.authorizationUrl!);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("code", "one-use-code");
    const firstResponse = fetch(callback);
    await tokenExchangeStarted;
    assert.equal((await fetch(callback)).status, 409);
    releaseTokenExchange();
    assert.equal((await firstResponse).status, 200);
  } finally { await manager.close(); }
});
