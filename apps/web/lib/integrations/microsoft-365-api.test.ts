import assert from "node:assert/strict";
import { contractTest } from "../../../../tests/helpers/contract-test.js";
import {
  listMicrosoftCalendarEvents,
  searchMicrosoftSharePointSites,
  sendMicrosoftMail,
} from "./microsoft-365-api";

contractTest("web.hermetic", "Microsoft 365 reads use bounded Graph queries", async () => {
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

contractTest("web.hermetic", "Microsoft 365 mail sends are explicit and plain text", async () => {
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
