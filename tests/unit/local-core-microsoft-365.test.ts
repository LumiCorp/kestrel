import test from "node:test";
import assert from "node:assert/strict";

import { MemoryLocalCoreCredentialStore } from "../../src/localCore/credentialStore.js";
import { LocalCoreMicrosoft365OAuthSessionManager } from "../../src/localCore/microsoft365OAuthSessions.js";
import {
  LocalCoreMicrosoft365Service,
  Microsoft365TeamsSendError,
} from "../../src/localCore/microsoft365Service.js";

test("Microsoft 365 OAuth requests only selected pack scopes and stores tokens in Local Core", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  const requested: URL[] = [];
  const manager = new LocalCoreMicrosoft365OAuthSessionManager({
    credentialStore: store,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.hostname === "login.microsoftonline.com") {
        return new Response(JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "User.Read Mail.Read Mail.Send Calendars.Read",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  try {
    const session = await manager.start({ clientId: "public-client", packs: ["outlook"] });
    const authorization = new URL(session.authorizationUrl!);
    const scopes = authorization.searchParams.get("scope")!.split(" ");
    assert.ok(scopes.includes("Mail.Read"));
    assert.ok(scopes.includes("Mail.Send"));
    assert.equal(scopes.includes("Chat.Read"), false);
    assert.equal(scopes.includes("Sites.Read.All"), false);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    assert.equal(callback.hostname, "localhost");
    assert.equal(callback.pathname, "/oauth/callback");
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("code", "authorization-code");
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    assert.equal(manager.status(session.sessionId)?.state, "complete");
    assert.equal(requested.length, 2);
    assert.equal(await store.get("mcp.standard.microsoft_365.oauth.client"), "public-client");
    const stored = await store.get("mcp.standard.microsoft_365.oauth.tokens");
    assert.ok(stored?.includes("refresh-token"));
  } finally {
    await manager.close();
  }
});

test("Microsoft 365 service refreshes in Core and calls Graph without exposing refresh tokens", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("mcp.standard.microsoft_365.oauth.client", "public-client");
  await store.set("mcp.standard.microsoft_365.oauth.tokens", JSON.stringify({ accessToken: "expired", refreshToken: "refresh-secret", expiresAt: 1, scope: "offline_access User.Read Mail.Read" }));
  const requests: Array<{ url: string; authorization?: string }> = [];
  const service = new LocalCoreMicrosoft365Service({
    credentialStore: store,
    now: () => 100_000,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      requests.push({ url, ...(authorization !== undefined ? { authorization } : {}) });
      if (url.includes("oauth2/v2.0/token")) {
        assert.ok(String(init?.body).includes("refresh-secret"));
        return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ value: [{ id: "mail-1" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const result = await service.invoke("mail.list", { maxResults: 1 }) as { items: unknown[] };
  assert.equal(result.items.length, 1);
  assert.equal(requests[1]?.authorization, "Bearer fresh-access");
  assert.equal(requests[1]?.url.includes("refresh-secret"), false);
});

test("Microsoft 365 activation fails closed when the stored grant lacks a selected pack", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("mcp.standard.microsoft_365.oauth.tokens", JSON.stringify({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    scope: "openid profile email offline_access User.Read Mail.Read Mail.Send Calendars.Read",
  }));
  const service = new LocalCoreMicrosoft365Service({ credentialStore: store });
  await assert.rejects(
    service.verify(["outlook", "teams"]),
    /has not granted every selected capability/u,
  );
});

test("Microsoft 365 rejects Teams send before Graph when ChatMessage.Send is absent", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("mcp.standard.microsoft_365.oauth.tokens", JSON.stringify({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    scope: "openid profile email offline_access User.Read Chat.Read",
  }));
  const service = new LocalCoreMicrosoft365Service({
    credentialStore: store,
    fetchImpl: (async () => {
      throw new Error("provider should not be called");
    }) as typeof fetch,
  });
  await assert.rejects(
    service.invoke("chat.send", { chatId: "chat-1", content: "Hello" }),
    /has not granted this operation/u,
  );
});

test("Microsoft 365 Teams send returns no message content and preserves Graph authorization identity", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("mcp.standard.microsoft_365.oauth.tokens", JSON.stringify({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    scope: "openid profile email offline_access User.Read ChatMessage.Send",
  }));
  const service = new LocalCoreMicrosoft365Service({
    credentialStore: store,
    fetchImpl: (async () => Response.json({
      id: "message-1",
      chatId: "chat-1",
      createdDateTime: "2026-08-27T00:00:00Z",
      body: { content: "private content" },
    })) as typeof fetch,
  });
  assert.deepEqual(
    await service.invoke("chat.send", { chatId: "chat-1", content: "private content" }),
    { id: "message-1", chatId: "chat-1", createdAt: "2026-08-27T00:00:00Z" },
  );

  const denied = new LocalCoreMicrosoft365Service({
    credentialStore: store,
    fetchImpl: (async () => Response.json(
      { error: { code: "Authorization_RequestDenied" } },
      { status: 403 },
    )) as typeof fetch,
  });
  await assert.rejects(
    denied.invoke("chat.send", { chatId: "chat-1", content: "Hello" }),
    (error: unknown) => {
      assert.ok(error instanceof Microsoft365TeamsSendError);
      assert.equal(error.code, "MICROSOFT_365_ACCESS_DENIED");
      assert.equal(error.providerCode, "Authorization_RequestDenied");
      assert.equal(error.reconnectRequired, false);
      return true;
    },
  );
});

test("Microsoft 365 message paging never returns a Graph continuation URL", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("mcp.standard.microsoft_365.oauth.tokens", JSON.stringify({
    accessToken: "access",
    refreshToken: "refresh-token-for-message-cursor-tests",
    expiresAt: Date.now() + 3_600_000,
    scope: "openid profile email offline_access User.Read Chat.Read",
  }));
  const requested: string[] = [];
  const service = new LocalCoreMicrosoft365Service({
    credentialStore: store,
    fetchImpl: (async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json({
        value: [{ id: "message-1" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/chat-1/messages?$skiptoken=provider-secret",
      });
    }) as typeof fetch,
  });
  const result = await service.invoke("chat.messages.list", {
    chatId: "chat-1",
    maxResults: 20,
  }, { cursorScope: "/projects/a" }) as { items: unknown[]; nextCursor: string | null };
  assert.equal(result.items.length, 1);
  assert.equal(typeof result.nextCursor, "string");
  assert.doesNotMatch(result.nextCursor!, /graph\.microsoft\.com|provider-secret/u);
  await service.invoke("chat.messages.list", {
    chatId: "chat-1",
    maxResults: 20,
    cursor: result.nextCursor,
  }, { cursorScope: "/projects/a" });
  assert.match(requested[1]!, /\$skiptoken=provider-secret/u);
  await assert.rejects(
    service.invoke("chat.messages.list", {
      chatId: "chat-2",
      maxResults: 20,
      cursor: result.nextCursor,
    }, { cursorScope: "/projects/a" }),
    /does not match/u,
  );
  await assert.rejects(
    service.invoke("chat.messages.list", {
      chatId: "chat-1",
      maxResults: 20,
      cursor: result.nextCursor,
    }, { cursorScope: "/projects/b" }),
    /does not match/u,
  );
});

test("Microsoft 365 chat paging never returns a Graph continuation URL", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("mcp.standard.microsoft_365.oauth.tokens", JSON.stringify({
    accessToken: "access",
    refreshToken: "refresh-token-for-chat-cursor-tests",
    expiresAt: Date.now() + 3_600_000,
    scope: "openid profile email offline_access User.Read Chat.Read",
  }));
  const service = new LocalCoreMicrosoft365Service({
    credentialStore: store,
    fetchImpl: (async () => Response.json({
      value: [{ id: "chat-1" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?$skiptoken=provider-secret",
    })) as typeof fetch,
  });
  const result = await service.invoke("chats.list", { maxResults: 20 }) as {
    items: unknown[];
    nextCursor: string | null;
  };
  assert.equal(result.items.length, 1);
  assert.equal(typeof result.nextCursor, "string");
  assert.doesNotMatch(result.nextCursor!, /graph\.microsoft\.com|provider-secret/u);
  await assert.rejects(
    service.invoke("chats.list", { maxResults: 21, cursor: result.nextCursor }),
    /does not match/u,
  );
});

test("Microsoft 365 OAuth exchanges a callback only once", async () => {
  let releaseTokenExchange!: () => void;
  const tokenExchangeReleased = new Promise<void>((resolve) => { releaseTokenExchange = resolve; });
  let markTokenExchangeStarted!: () => void;
  const tokenExchangeStarted = new Promise<void>((resolve) => { markTokenExchangeStarted = resolve; });
  const manager = new LocalCoreMicrosoft365OAuthSessionManager({
    credentialStore: new MemoryLocalCoreCredentialStore(),
    fetchImpl: (async (input: string | URL | Request) => {
      if (String(input).includes("oauth2/v2.0/token")) {
        markTokenExchangeStarted();
        await tokenExchangeReleased;
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "User.Read Mail.Read Mail.Send Calendars.Read" });
      }
      return Response.json({ id: "user-1" });
    }) as typeof fetch,
  });
  try {
    const session = await manager.start({ clientId: "microsoft-client", packs: ["outlook"] });
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
