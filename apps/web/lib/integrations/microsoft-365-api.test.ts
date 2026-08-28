import test from "node:test";
import assert from "node:assert/strict";
import {
  listMicrosoftCalendarEvents,
  Microsoft365ProviderError,
  searchMicrosoftSharePointSites,
  sendMicrosoftMail,
  sendMicrosoftTeamsChatMessage,
} from "./microsoft-365-api";

test("Microsoft 365 reads use bounded Graph queries", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await listMicrosoftCalendarEvents({
    accessToken: "secret",
    timeMin: "2026-07-21T00:00:00Z",
    timeMax: "2026-07-22T00:00:00Z",
    maxResults: 12,
    fetchImpl,
  });
  await searchMicrosoftSharePointSites({
    accessToken: "secret",
    query: "roadmap",
    maxResults: 8,
    fetchImpl,
  });
  assert.match(requests[0]?.url ?? "", /\/me\/calendarView/u);
  assert.match(requests[0]?.url ?? "", /%24top=12/u);
  assert.match(requests[1]?.url ?? "", /\/sites\?search=roadmap/u);
  assert.match(requests[1]?.url ?? "", /%24top=8/u);
  assert.equal(requests[0]?.init?.headers && "authorization" in requests[0].init.headers, true);
});

test("Microsoft 365 mail sends are explicit and plain text", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(null, { status: 202 });
  };
  assert.deepEqual(
    await sendMicrosoftMail({
      accessToken: "secret",
      to: ["person@example.com"],
      cc: [],
      subject: "Decision",
      body: "Approved.",
      fetchImpl,
    }),
    { sent: true }
  );
  assert.match(requests[0]?.url ?? "", /\/me\/sendMail$/u);
  assert.equal(requests[0]?.init?.method, "POST");
  const body = JSON.parse(String(requests[0]?.init?.body)) as {
    message: { body: { contentType: string } };
  };
  assert.equal(body.message.body.contentType, "Text");
});

test("Teams send returns only durable provider identity and timestamp", async () => {
  const result = await sendMicrosoftTeamsChatMessage({
    accessToken: "secret",
    chatId: "chat-1",
    content: "Private message body",
    fetchImpl: async () =>
      Response.json({
        id: "message-1",
        chatId: "chat-1",
        createdDateTime: "2026-08-27T00:00:00Z",
        body: { content: "Private message body" },
      }),
  });
  assert.deepEqual(result, {
    id: "message-1",
    chatId: "chat-1",
    createdAt: "2026-08-27T00:00:00Z",
  });
  assert.equal(JSON.stringify(result).includes("Private message body"), false);
});

test("Teams send preserves a Graph authorization identity without requesting reconnect", async () => {
  await assert.rejects(
    sendMicrosoftTeamsChatMessage({
      accessToken: "secret",
      chatId: "chat-1",
      content: "Hello",
      fetchImpl: async () =>
        Response.json(
          { error: { code: "Authorization_RequestDenied" } },
          { status: 403 },
        ),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Microsoft365ProviderError);
      assert.equal(error.code, "MICROSOFT_365_ACCESS_DENIED");
      assert.equal(error.providerCode, "Authorization_RequestDenied");
      assert.equal(error.reconnectRequired, false);
      return true;
    },
  );
});

test("Teams send reports an unreadable successful response as an unknown outcome", async () => {
  await assert.rejects(
    sendMicrosoftTeamsChatMessage({
      accessToken: "secret",
      chatId: "chat-1",
      content: "Hello",
      fetchImpl: async () => new Response("not json", { status: 201 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Microsoft365ProviderError);
      assert.equal(error.code, "MICROSOFT_365_OUTCOME_UNKNOWN");
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
});
