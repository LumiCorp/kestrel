import test from "node:test";
import assert from "node:assert/strict";
import { MemoryLocalCoreCredentialStore } from "../../src/localCore/credentialStore.js";
import { LocalCoreGoogleWorkspaceOAuthSessionManager } from "../../src/localCore/googleWorkspaceOAuthSessions.js";
import {
  GoogleWorkspaceMutationOutcomeUnknownError,
  LocalCoreGoogleWorkspaceService,
} from "../../src/localCore/googleWorkspaceService.js";
import { projectGmailMutationActivityInput } from "../../src/apps/gmailMutation.js";

test("Gmail mutation activity keeps audit identity without retaining message content", () => {
  const projection = projectGmailMutationActivityInput(
    "google_workspace.reply_gmail",
    {
      text: "Do not retain this body.",
      __kestrelGmailPrepared: {
        envelope: {
          to: ["recipient@example.com"],
          cc: ["copy@example.com"],
          subject: "Do not retain this subject.",
          text: "Do not retain this body.",
          html: "<p>Do not retain this HTML.</p>",
          threadId: "provider-thread-1",
        },
        attachments: [{ fileId: "file-1", sha256: "a".repeat(64) }],
      },
    },
  );
  assert.deepEqual(projection, {
    operation: "gmail.messages.reply",
    recipientCount: 2,
    attachmentCount: 1,
    attachments: [{ fileId: "file-1", sha256: "a".repeat(64) }],
    providerThreadId: "provider-thread-1",
  });
  assert.doesNotMatch(JSON.stringify(projection), /Do not retain/u);
});

test("Google Workspace Desktop OAuth uses PKCE and stores an offline Calendar grant in Core", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  const calls: string[] = [];
  const scopes =
    "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy";
  const manager = new LocalCoreGoogleWorkspaceOAuthSessionManager({
    credentialStore: store,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("oauth2.googleapis.com/token"))
        return new Response(
          JSON.stringify({
            access_token: "google-access",
            refresh_token: "google-refresh",
            expires_in: 3600,
            scope: scopes,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      return new Response(
        JSON.stringify({ sub: "user-1", email: "person@example.com" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  try {
    const session = await manager.start({
      clientId: "google-public-client",
      packs: ["calendar"],
    });
    const authorization = new URL(session.authorizationUrl!);
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.equal(authorization.searchParams.get("access_type"), "offline");
    assert.equal(
      authorization.searchParams.get("include_granted_scopes"),
      "true",
    );
    assert.equal(authorization.searchParams.get("scope"), scopes);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state")!,
    );
    callback.searchParams.set("code", "authorization-code");
    assert.equal((await fetch(callback)).status, 200);
    assert.equal(manager.status(session.sessionId)?.state, "complete");
    assert.equal(calls.length, 2);
    assert.equal(
      await store.get("mcp.standard.google_workspace.oauth.client"),
      "google-public-client",
    );
    assert.ok(
      (await store.get("mcp.standard.google_workspace.oauth.tokens"))?.includes(
        "google-refresh",
      ),
    );
  } finally {
    await manager.close();
  }
});

test("Google Workspace Desktop OAuth requests only a newly selected Gmail pack", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set(
    "mcp.standard.google_workspace.oauth.tokens",
    JSON.stringify({
      accessToken: "calendar-access",
      refreshToken: "calendar-refresh",
      expiresAt: Date.now() + 3_600_000,
      scope:
        "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy",
    }),
  );
  const manager = new LocalCoreGoogleWorkspaceOAuthSessionManager({
    credentialStore: store,
    fetchImpl: (async () => {
      throw new Error("the authorization URL is the assertion");
    }) as typeof fetch,
  });
  try {
    const session = await manager.start({
      clientId: "google-public-client",
      packs: ["calendar", "gmail"],
    });
    const authorization = new URL(session.authorizationUrl!);
    assert.equal(
      authorization.searchParams.get("scope"),
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    );
    assert.equal(
      authorization.searchParams.get("include_granted_scopes"),
      "true",
    );
  } finally {
    await manager.close();
  }
});

test("Google Workspace Calendar refresh and API calls stay inside Local Core", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set(
    "mcp.standard.google_workspace.oauth.client",
    "google-client",
  );
  await store.set(
    "mcp.standard.google_workspace.oauth.tokens",
    JSON.stringify({
      accessToken: "expired",
      refreshToken: "refresh-secret",
      expiresAt: 1,
      scope:
        "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy",
    }),
  );
  const requests: string[] = [];
  const service = new LocalCoreGoogleWorkspaceService({
    credentialStore: store,
    now: () => 100_000,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("oauth2.googleapis.com/token")) {
        assert.ok(String(init?.body).includes("refresh-secret"));
        return new Response(
          JSON.stringify({ access_token: "fresh", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fresh",
      );
      return new Response(JSON.stringify({
        items: [{
          id: "event-1",
          summary: "Planning",
          start: { dateTime: "2026-07-22T10:00:00Z", timeZone: "UTC" },
          end: { dateTime: "2026-07-22T11:00:00Z", timeZone: "UTC" },
          attendees: [{ email: "teammate@example.com", responseStatus: "accepted" }],
          updated: "2026-07-21T10:00:00Z",
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const result = (await service.invoke("events.list", {
    timeMin: "2026-07-22T00:00:00Z",
    timeMax: "2026-07-23T00:00:00Z",
    maxResults: 5,
  })) as { events: Array<Record<string, unknown>> };
  assert.deepEqual(result.events, [{
    id: "event-1",
    status: null,
    url: null,
    summary: "Planning",
    description: null,
    location: null,
    start: { dateTime: "2026-07-22T10:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-07-22T11:00:00Z", timeZone: "UTC" },
    attendees: [{ email: "teammate@example.com", displayName: null, responseStatus: "accepted" }],
    updatedAt: "2026-07-21T10:00:00Z",
  }]);
  assert.equal(
    requests.some((url) => url.includes("refresh-secret")),
    false,
  );
});

test("Google Workspace Calendar paging never exposes a Google page token", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set(
    "mcp.standard.google_workspace.oauth.tokens",
    JSON.stringify({
      accessToken: "access",
      refreshToken: "google-refresh-token-for-calendar-cursor-tests",
      expiresAt: Date.now() + 3_600_000,
      scope:
        "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy",
    }),
  );
  const requests: string[] = [];
  const service = new LocalCoreGoogleWorkspaceService({
    credentialStore: store,
    assertGmailRestrictedDataAdmission: async () => {},
    fetchImpl: (async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json({
        items: [{ id: "event-1", start: { dateTime: "2026-07-22T10:00:00Z" }, end: { dateTime: "2026-07-22T11:00:00Z" } }],
        nextPageToken: "provider-page-token",
      });
    }) as typeof fetch,
  });
  const request = {
    timeMin: "2026-07-22T00:00:00Z",
    timeMax: "2026-07-23T00:00:00Z",
    maxResults: 5,
  };
  const result = await service.invoke("events.list", request, {
    cursorScope: "/projects/a",
  }) as { events: unknown[]; nextCursor: string | null };
  assert.equal(result.events.length, 1);
  assert.equal(typeof result.nextCursor, "string");
  assert.doesNotMatch(result.nextCursor!, /provider-page-token/u);
  await service.invoke("events.list", { ...request, cursor: result.nextCursor }, {
    cursorScope: "/projects/a",
  });
  assert.match(requests[1]!, /pageToken=provider-page-token/u);
  await assert.rejects(
    service.invoke("events.list", { ...request, cursor: result.nextCursor }, {
      cursorScope: "/projects/b",
    }),
    /does not match/u,
  );
});

test("Google Workspace Gmail paging is query and Desktop-Project bound without exposing Gmail tokens", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set(
    "mcp.standard.google_workspace.oauth.tokens",
    JSON.stringify({
      accessToken: "access",
      refreshToken: "google-refresh-token-for-gmail-cursor-tests",
      expiresAt: Date.now() + 3_600_000,
      scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
    }),
  );
  const requests: string[] = [];
  const encoded = Buffer.from("mail body", "utf8").toString("base64url");
  const service = new LocalCoreGoogleWorkspaceService({
    credentialStore: store,
    assertGmailRestrictedDataAdmission: async () => {},
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input); requests.push(url);
      if (url.includes("/messages?")) return Response.json({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "gmail-provider-token" });
      return Response.json({ id: "m1", threadId: "t1", payload: { headers: [{ name: "Subject", value: "Receipt" }], parts: [{ mimeType: "text/plain", body: { data: encoded } }, { mimeType: "application/pdf", filename: "receipt.pdf", body: { attachmentId: "a1", size: 9 } }] } });
    }) as typeof fetch,
  });
  const input = { query: "from:billing@example.com", maxResults: 5 };
  const result = await service.invoke("gmail.messages.search", input, { cursorScope: "/projects/a" }) as { messages: Array<{ attachments: unknown[] }>; nextCursor: string | null };
  assert.equal(result.messages[0]?.attachments.length, 1);
  assert.equal(typeof result.nextCursor, "string");
  assert.doesNotMatch(result.nextCursor!, /gmail-provider-token/u);
  await service.invoke("gmail.messages.search", { ...input, cursor: result.nextCursor }, { cursorScope: "/projects/a" });
  assert.match(requests[2]!, /pageToken=gmail-provider-token/u);
  await assert.rejects(
    service.invoke("gmail.messages.search", { ...input, cursor: result.nextCursor }, { cursorScope: "/projects/b" }),
    /does not match/u,
  );
});

test("Google Workspace imports only a selected Gmail attachment into the current Desktop Thread", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set(
    "mcp.standard.google_workspace.oauth.tokens",
    JSON.stringify({
      accessToken: "access",
      refreshToken: "gmail-attachment-refresh",
      expiresAt: Date.now() + 3_600_000,
      scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
    }),
  );
  const attachmentBytes = Buffer.from("hello", "utf8");
  const imported: Array<{ threadId: string; filename: string; data: Buffer; mimeType?: string | undefined }> = [];
  const service = new LocalCoreGoogleWorkspaceService({
    credentialStore: store,
    assertGmailRestrictedDataAdmission: async () => {},
    importGmailAttachment: async (input) => {
      imported.push(input);
      return {
        fileId: "file-imported",
        filename: input.filename,
        sizeBytes: input.data.byteLength,
        status: "ready",
      };
    },
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/attachments/a1")) {
        return Response.json({ data: attachmentBytes.toString("base64url") });
      }
      return Response.json({
        id: "m1",
        threadId: "gmail-thread",
        payload: {
          headers: [],
          parts: [{
            mimeType: "text/plain",
            filename: "note.txt",
            body: { attachmentId: "a1", size: attachmentBytes.byteLength },
          }],
        },
      });
    }) as typeof fetch,
  });

  const result = await service.invoke(
    "gmail.attachments.import",
    { messageId: "m1", attachmentId: "a1" },
    { threadId: "desktop-thread-1" },
  );

  assert.deepEqual(result, {
    fileId: "file-imported",
    filename: "note.txt",
    sizeBytes: 5,
    status: "ready",
  });
  assert.equal(imported.length, 1);
  assert.equal(imported[0]?.threadId, "desktop-thread-1");
  assert.equal(imported[0]?.data.toString("utf8"), "hello");
  assert.equal(imported[0]?.mimeType, "text/plain");
});

test("Google Workspace sends only a hash-bound Desktop Gmail preparation", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set(
    "mcp.standard.google_workspace.oauth.tokens",
    JSON.stringify({
      accessToken: "access",
      refreshToken: "gmail-send-refresh",
      expiresAt: Date.now() + 3_600_000,
      scope: "openid email profile https://www.googleapis.com/auth/gmail.send",
    }),
  );
  const requests: Array<{ url: string; body: unknown }> = [];
  const attachment = {
    fileId: "file-1", filename: "plan.pdf", mediaType: "application/pdf",
    sizeBytes: 4, sha256: "a".repeat(64), bytes: Buffer.from("plan"),
  };
  const service = new LocalCoreGoogleWorkspaceService({
    credentialStore: store,
    assertGmailRestrictedDataAdmission: async () => {},
    resolveGmailAttachments: async (input) => input.includeBytes
      ? [attachment]
      : [{ ...attachment, bytes: undefined }].map(({ bytes: _bytes, ...metadata }) => metadata),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "sent-message-1", threadId: "sent-thread-1", internalDate: "123" });
    }) as typeof fetch,
  });
  const prepared = await service.prepareApprovalInput!(
    "gmail.messages.send",
    { to: ["recipient@example.com"], subject: "Plan", text: "Attached.", attachmentFileIds: ["file-1"] },
    { threadId: "thread-1" },
  );
  assert.equal(requests.length, 0, "preparation must not mutate Gmail");
  const result = await service.invoke("gmail.messages.send", prepared, { threadId: "thread-1" });
  assert.deepEqual(result, { id: "sent-message-1", threadId: "sent-thread-1", createdAt: "123" });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /\/users\/me\/messages\/send/u);
  const preparedRecord = prepared.__kestrelGmailPrepared as { attachments: Array<{ sha256: string }> };
  preparedRecord.attachments[0]!.sha256 = "b".repeat(64);
  await assert.rejects(
    service.invoke("gmail.messages.send", prepared, { threadId: "thread-1" }),
    /approval no longer matches/u,
  );
  assert.equal(requests.length, 1, "a drifted preparation must not call Gmail");
});

test("Google Workspace Calendar mutations report a transport failure as an unknown outcome", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set(
    "mcp.standard.google_workspace.oauth.tokens",
    JSON.stringify({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3_600_000,
      scope:
        "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy",
    }),
  );
  const service = new LocalCoreGoogleWorkspaceService({
    credentialStore: store,
    fetchImpl: (async () => {
      throw new Error("connection reset after request dispatch");
    }) as typeof fetch,
  });
  await assert.rejects(
    service.invoke("events.create", {
      event: {
        summary: "Planning",
        start: { dateTime: "2026-07-22T10:00:00Z" },
        end: { dateTime: "2026-07-22T11:00:00Z" },
      },
      notifyAttendees: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleWorkspaceMutationOutcomeUnknownError);
      assert.equal(error.code, "GOOGLE_CALENDAR_OUTCOME_UNKNOWN");
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
});

test("Google Workspace Calendar mutations report an unreadable successful response as an unknown outcome", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set(
    "mcp.standard.google_workspace.oauth.tokens",
    JSON.stringify({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3_600_000,
      scope:
        "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy",
    }),
  );
  const service = new LocalCoreGoogleWorkspaceService({
    credentialStore: store,
    fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch,
  });
  await assert.rejects(
    service.invoke("events.create", {
      event: {
        summary: "Planning",
        start: { dateTime: "2026-07-22T10:00:00Z" },
        end: { dateTime: "2026-07-22T11:00:00Z" },
      },
      notifyAttendees: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleWorkspaceMutationOutcomeUnknownError);
      assert.equal(error.code, "GOOGLE_CALENDAR_OUTCOME_UNKNOWN");
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
});

test("Google Workspace rejects an operation before a provider call when its grant is incomplete", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set(
    "mcp.standard.google_workspace.oauth.tokens",
    JSON.stringify({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3_600_000,
      scope:
        "openid email profile https://www.googleapis.com/auth/calendar.events.owned",
    }),
  );
  const service = new LocalCoreGoogleWorkspaceService({
    credentialStore: store,
    fetchImpl: (async () => {
      throw new Error("provider should not be called");
    }) as typeof fetch,
  });
  await assert.rejects(
    service.invoke("events.list", {
      timeMin: "2026-07-22T00:00:00Z",
      timeMax: "2026-07-23T00:00:00Z",
    }),
    /has not granted this operation/u,
  );
});

test("Google Workspace OAuth exchanges a callback only once", async () => {
  let releaseTokenExchange!: () => void;
  const tokenExchangeReleased = new Promise<void>((resolve) => {
    releaseTokenExchange = resolve;
  });
  let markTokenExchangeStarted!: () => void;
  const tokenExchangeStarted = new Promise<void>((resolve) => {
    markTokenExchangeStarted = resolve;
  });
  const scopes =
    "openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy";
  const manager = new LocalCoreGoogleWorkspaceOAuthSessionManager({
    credentialStore: new MemoryLocalCoreCredentialStore(),
    fetchImpl: (async (input: string | URL | Request) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        markTokenExchangeStarted();
        await tokenExchangeReleased;
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: scopes,
        });
      }
      return Response.json({ sub: "user-1" });
    }) as typeof fetch,
  });
  try {
    const session = await manager.start({
      clientId: "google-client",
      packs: ["calendar"],
    });
    const authorization = new URL(session.authorizationUrl!);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state")!,
    );
    callback.searchParams.set("code", "one-use-code");
    const firstResponse = fetch(callback);
    await tokenExchangeStarted;
    assert.equal((await fetch(callback)).status, 409);
    releaseTokenExchange();
    assert.equal((await firstResponse).status, 200);
  } finally {
    await manager.close();
  }
});
