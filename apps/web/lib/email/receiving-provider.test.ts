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

test("webhook creation returns its recovery identity and one-time secret before follow-up work", async () => {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({
        path,
        method,
        ...(init?.body ? { body: String(init.body) } : {}),
      });
      return Response.json({ id: "webhook-1", signing_secret: "whsec_secret" });
    },
  });

  const created = await provider.createWebhook({
    apiKey: "re_full_access",
    endpoint: "https://example.test/inbound",
    events: ["email.received"],
  });
  assert.deepEqual(created, {
    id: "webhook-1",
    signingSecret: "whsec_secret",
  });
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["POST"],
  );
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    endpoint: "https://example.test/inbound",
    events: ["email.received"],
  });
});

test("retry after disable failure resumes from the created webhook ID without another POST", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  let disableAttempts = 0;
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "POST") {
        return Response.json({
          id: "webhook-1",
          signing_secret: "whsec_secret",
        });
      }
      disableAttempts += 1;
      if (disableAttempts === 1) return new Response(null, { status: 503 });
      return Response.json({ id: "webhook-1" });
    },
  });

  const created = await provider.createWebhook({
    apiKey: "re_full_access",
    endpoint: "https://example.test/inbound",
    events: ["email.received"],
  });
  await assert.rejects(
    provider.updateWebhook({
      apiKey: "re_full_access",
      webhookId: created.id,
      enabled: false,
    }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes(created.signingSecret),
  );
  const disabled = await provider.updateWebhook({
    apiKey: "re_full_access",
    webhookId: created.id,
    enabled: false,
  });

  assert.deepEqual(disabled, {
    id: "webhook-1",
    applied: { status: "disabled" },
  });
  assert.equal("signingSecret" in disabled, false);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["POST", "PATCH", "PATCH"],
  );
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
});

test("retry after retrieval failure reconciles the acknowledged disable without another POST", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  let retrieveAttempts = 0;
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "POST") {
        return Response.json({
          id: "webhook-1",
          signing_secret: "whsec_secret",
        });
      }
      if (method === "PATCH") return Response.json({ id: "webhook-1" });
      retrieveAttempts += 1;
      if (retrieveAttempts === 1) return new Response(null, { status: 503 });
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
  });
  const disabled = await provider.updateWebhook({
    apiKey: "re_full_access",
    webhookId: created.id,
    enabled: false,
  });
  await assert.rejects(provider.getWebhook("re_full_access", disabled.id));
  const reconciled = await provider.getWebhook("re_full_access", disabled.id);

  assert.deepEqual(reconciled, {
    id: "webhook-1",
    endpoint: "https://example.test/inbound",
    status: "disabled",
    events: ["email.received"],
  });
  assert.equal("signingSecret" in reconciled, false);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["POST", "PATCH", "GET", "GET"],
  );
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
});

test("webhook removal is retry-safe after an acknowledged delete", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  let removeAttempts = 0;
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input, init) => {
      calls.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "GET",
      });
      removeAttempts += 1;
      return new Response(null, { status: removeAttempts === 1 ? 204 : 404 });
    },
  });

  await provider.removeWebhook("re_full_access", "webhook-1");
  await provider.removeWebhook("re_full_access", "webhook-1");

  assert.deepEqual(calls, [
    { path: "/webhooks/webhook-1", method: "DELETE" },
    { path: "/webhooks/webhook-1", method: "DELETE" },
  ]);
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
