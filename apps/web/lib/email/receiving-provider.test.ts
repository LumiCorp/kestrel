import assert from "node:assert/strict";
import test from "node:test";
import { ResendHttpReceivingProvider } from "./receiving-provider";

test("domain inspection retrieves receiving DNS details and accepts partially verified sending state", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/domains")) {
        return Response.json({
          data: [
            {
              id: "domain-1",
              name: "inbound.example.test",
              status: "partially_verified",
              capabilities: { sending: "disabled", receiving: "enabled" },
            },
          ],
        });
      }
      return Response.json({
        id: "domain-1",
        name: "inbound.example.test",
        status: "partially_verified",
        capabilities: { sending: "disabled", receiving: "enabled" },
        records: [
          { record: "SPF", type: "MX", status: "pending" },
          { record: "Receiving MX", type: "MX", status: "verified" },
        ],
      });
    },
  });

  assert.deepEqual(await provider.listDomains("re_full_access"), [
    {
      id: "domain-1",
      name: "inbound.example.test",
      status: "verified",
      receiving: "enabled",
      mxStatus: "verified",
    },
  ]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(
      (request.init?.headers as Record<string, string>)["user-agent"],
      "Kestrel-One/1.0",
    );
  }
});

test("documented temporary_failure domain state is a stable failed projection", async () => {
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async () =>
      Response.json({
        id: "domain-2",
        name: "mail.example.test",
        status: "temporary_failure",
        capabilities: { sending: "enabled", receiving: "enabled" },
        records: [
          { record: "Receiving MX", type: "MX", status: "temporary_failure" },
        ],
      }),
  });
  assert.deepEqual(await provider.getDomain("re_full_access", "domain-2"), {
    id: "domain-2",
    name: "mail.example.test",
    status: "failed",
    receiving: "enabled",
    mxStatus: "failed",
  });
});

test("webhook adapter creates without unsupported status and retrieves after mutations", async () => {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, ...(init?.body ? { body: String(init.body) } : {}) });
      if (method === "POST") {
        return Response.json({ id: "webhook-1", signing_secret: "whsec_secret" });
      }
      if (method === "PATCH") return Response.json({ id: "webhook-1" });
      return Response.json({
        id: "webhook-1",
        endpoint: "https://example.test/inbound",
        status: "disabled",
        events: ["email.received"],
      });
    },
  });

  const created = await provider.createWebhook({
    apiKey: "re_full_access",
    endpoint: "https://example.test/inbound",
    events: ["email.received"],
    enabled: false,
  });
  assert.equal(created.signingSecret, "whsec_secret");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    endpoint: "https://example.test/inbound",
    events: ["email.received"],
  });
  assert.equal(calls[1]?.method, "PATCH");
  assert.equal(calls[2]?.method, "GET");

  calls.length = 0;
  await provider.updateWebhook({
    apiKey: "re_full_access",
    webhookId: "webhook-1",
    enabled: false,
  });
  assert.deepEqual(calls.map(({ method }) => method), ["PATCH", "GET"]);
});

test("Sending-only credentials return the specific inbound readiness failure", async () => {
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async () => new Response(null, { status: 403 }),
  });
  await assert.rejects(
    provider.listDomains("re_sending_only"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT" &&
      !error.message.includes("re_sending_only"),
  );
});
