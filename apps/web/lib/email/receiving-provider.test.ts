import assert from "node:assert/strict";
import test from "node:test";
import {
  ResendHttpReceivingProvider,
  ResendReceivingProviderError,
} from "./receiving-provider";

test("domain inspection retrieves receiving DNS details and accepts partially verified sending state", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/domains")) {
        return Response.json({
          object: "list",
          has_more: false,
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

test("domain inspection accepts a complete empty list", async () => {
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async () =>
      Response.json({ object: "list", has_more: false, data: [] }),
  });

  assert.deepEqual(await provider.listDomains("re_full_access"), []);
});

test("domain inspection rejects incomplete and malformed list envelopes", async () => {
  const cases: unknown[] = [
    {
      object: "list",
      has_more: true,
      data: [
        {
          id: "domain-1",
          name: "mail.example.test",
          status: "verified",
          capabilities: { sending: "enabled", receiving: "disabled" },
        },
      ],
    },
    { object: "list", has_more: true, data: [] },
    { object: "domain", has_more: false, data: [] },
    { object: "list", data: [] },
    { object: "list", has_more: "false", data: [] },
    { object: "list", has_more: false, data: {} },
  ];

  for (const payload of cases) {
    const provider = new ResendHttpReceivingProvider({
      baseUrl: "https://resend.test",
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(
      provider.listDomains("re_full_access"),
      (error: unknown) =>
        error instanceof ResendReceivingProviderError &&
        error.code === "RESEND_RECEIVING_RESPONSE_INVALID",
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

test("domain retrieval rejects a successful response for another domain identity", async () => {
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async () =>
      Response.json({
        id: "domain-other",
        name: "other.example.test",
        status: "verified",
        capabilities: { sending: "enabled", receiving: "enabled" },
        records: [
          { record: "Receiving MX", type: "MX", status: "verified" },
        ],
      }),
  });

  await assert.rejects(
    provider.getDomain("re_full_access", "domain-requested"),
    (error: unknown) =>
      error instanceof ResendReceivingProviderError &&
      error.code === "RESEND_RECEIVING_RESPONSE_INVALID",
  );
});

test("domain list hydration rejects details for a contradictory domain identity", async () => {
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/domains") {
        return Response.json({
          object: "list",
          has_more: false,
          data: [
            {
              id: "domain-requested",
              name: "requested.example.test",
              status: "verified",
              capabilities: { sending: "enabled", receiving: "enabled" },
            },
          ],
        });
      }
      return Response.json({
        id: "domain-other",
        name: "other.example.test",
        status: "verified",
        capabilities: { sending: "enabled", receiving: "enabled" },
        records: [
          { record: "Receiving MX", type: "MX", status: "verified" },
        ],
      });
    },
  });

  await assert.rejects(
    provider.listDomains("re_full_access"),
    (error: unknown) =>
      error instanceof ResendReceivingProviderError &&
      error.code === "RESEND_RECEIVING_RESPONSE_INVALID",
  );
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

test("network and retryable HTTP failures are provider-unavailable without credential disclosure", async () => {
  const secret = "re_network_secret_must_not_escape";
  for (const fetchImpl of [
    async () => {
      throw new Error(`network failure for ${secret}`);
    },
    async () => new Response(`upstream detail ${secret}`, { status: 503 }),
    async () => new Response(`rate limit detail ${secret}`, { status: 429 }),
  ]) {
    const provider = new ResendHttpReceivingProvider({
      baseUrl: "https://resend.test",
      fetchImpl,
    });
    await assert.rejects(
      provider.listDomains(secret),
      (error: unknown) =>
        error instanceof ResendReceivingProviderError &&
        error.code === "RESEND_RECEIVING_PROVIDER_UNAVAILABLE" &&
        !error.message.includes(secret),
    );
  }
});

test("malformed successful payload is an invalid upstream response", async () => {
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async () => Response.json({ unexpected: "shape" }),
  });
  await assert.rejects(
    provider.listDomains("re_full_access"),
    (error: unknown) =>
      error instanceof ResendReceivingProviderError &&
      error.code === "RESEND_RECEIVING_RESPONSE_INVALID",
  );
});

test("provider client failures distinguish invalid resources and request state", async () => {
  const cases = [
    {
      status: 404,
      code: "RESEND_RECEIVING_DOMAIN_INVALID",
    },
    {
      status: 422,
      code: "RESEND_RECEIVING_REQUEST_INVALID",
    },
  ] as const;
  for (const expected of cases) {
    const provider = new ResendHttpReceivingProvider({
      baseUrl: "https://resend.test",
      fetchImpl: async () => new Response(null, { status: expected.status }),
    });
    await assert.rejects(
      provider.getDomain("re_full_access", "domain-1"),
      (error: unknown) =>
        error instanceof ResendReceivingProviderError &&
        error.code === expected.code,
    );
  }
});
