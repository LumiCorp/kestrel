import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareResendWebhookCreateIntent,
  ResendHttpReceivingProvider,
  ResendReceivingProviderError,
} from "./receiving-provider";

function webhookListRow(id: string) {
  return {
    id,
    endpoint: `https://example.test/unrelated/${id}`,
    status: "enabled",
    events: ["email.received"],
  };
}

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
    intent: prepareResendWebhookCreateIntent(
      "https://example.test/inbound",
    ),
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

test("restart after an ambiguous create recovers from durable intent without another POST", async () => {
  const endpoint =
    "https://example.test/api/webhooks/resend/inbound/opaque-locator";
  // The exact create intent crosses a durable serialization boundary before
  // the create process is allowed to issue its POST.
  const persistedIntentJson = JSON.stringify(
    prepareResendWebhookCreateIntent(endpoint),
  );
  const calls: Array<{ path: string; method: string }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    if (method === "POST") {
      // Resend accepted the request, but the response was lost. No create
      // evidence crosses this simulated process boundary.
      throw new Error("connection closed after provider acceptance");
    }
    if (url.pathname === "/webhooks" && !url.searchParams.has("after")) {
      return Response.json({
        object: "list",
        has_more: true,
        data: [
          {
            id: "webhook-page-1",
            endpoint: "https://example.test/unrelated",
            status: "enabled",
            events: ["email.received"],
          },
        ],
      });
    }
    if (url.pathname === "/webhooks") {
      assert.equal(url.searchParams.get("after"), "webhook-page-1");
      return Response.json({
        object: "list",
        has_more: false,
        data: [
          {
            id: "webhook-recovered",
            endpoint,
            status: "enabled",
            events: ["email.received"],
          },
        ],
      });
    }
    return Response.json({
      id: "webhook-recovered",
      endpoint,
      status: "enabled",
      events: ["email.received"],
      signing_secret: "whsec_recovered",
    });
  };

  const createProvider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl,
  });

  await assert.rejects(
    createProvider.createWebhook({
      apiKey: "re_full_access",
      intent: JSON.parse(persistedIntentJson),
    }),
    (error: unknown) =>
      error instanceof ResendReceivingProviderError &&
      error.code === "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
  );

  // A fresh provider process and a second rehydration prove recovery does not
  // depend on the failed process's provider or intent object.
  const recoveryProvider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl,
  });
  assert.deepEqual(
    await recoveryProvider.reconcileWebhookCreate({
      apiKey: "re_full_access",
      intent: JSON.parse(persistedIntentJson),
    }),
    {
      id: "webhook-recovered",
      signingSecret: "whsec_recovered",
    },
  );
  assert.deepEqual(calls, [
    { path: "/webhooks", method: "POST" },
    { path: "/webhooks?limit=100", method: "GET" },
    {
      path: "/webhooks?limit=100&after=webhook-page-1",
      method: "GET",
    },
    { path: "/webhooks/webhook-recovered", method: "GET" },
  ]);
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
});

test("ambiguous create reconciliation rejects intent matches split across pages without a POST", async () => {
  const endpoint = "https://example.test/inbound/opaque";
  const intent = prepareResendWebhookCreateIntent(endpoint);
  const calls: string[] = [];
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      const after = url.searchParams.get("after");
      return Response.json({
        object: "list",
        has_more: after === null,
        data: [
          {
            id: after === null ? "webhook-1" : "webhook-2",
            endpoint,
            status: "enabled",
            events: ["email.received"],
          },
        ],
      });
    },
  });

  await assert.rejects(
    provider.reconcileWebhookCreate({ apiKey: "re_full_access", intent }),
    (error: unknown) =>
      error instanceof ResendReceivingProviderError &&
      error.code === "RESEND_RECEIVING_RESPONSE_INVALID" &&
      !error.message.includes(endpoint),
  );
  assert.deepEqual(calls, [
    "GET /webhooks?limit=100",
    "GET /webhooks?limit=100&after=webhook-1",
  ]);
});

test("ambiguous create reconciliation rejects empty continuing pages and cursor loops", async () => {
  const intent = prepareResendWebhookCreateIntent(
    "https://example.test/inbound/opaque",
  );
  const cases = [
    {
      pages: [{ object: "list", has_more: true, data: [] }],
      expectedCalls: 1,
    },
    {
      pages: [
        {
          object: "list",
          has_more: true,
          data: [webhookListRow("cursor-1")],
        },
        {
          object: "list",
          has_more: true,
          data: [webhookListRow("cursor-1")],
        },
      ],
      expectedCalls: 2,
    },
    {
      pages: [
        {
          object: "list",
          has_more: true,
          data: [webhookListRow("cursor-1")],
        },
        {
          object: "list",
          has_more: true,
          data: [webhookListRow("cursor-2")],
        },
        {
          object: "list",
          has_more: true,
          data: [webhookListRow("cursor-1")],
        },
      ],
      expectedCalls: 3,
    },
    {
      pages: [
        {
          object: "list",
          has_more: true,
          data: [webhookListRow("cursor-1")],
        },
        {
          object: "list",
          has_more: false,
          data: [
            webhookListRow("cursor-1"),
            webhookListRow("cursor-2"),
          ],
        },
      ],
      expectedCalls: 2,
    },
  ];

  for (const testCase of cases) {
    let page = 0;
    const calls: string[] = [];
    const provider = new ResendHttpReceivingProvider({
      baseUrl: "https://resend.test",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
        return Response.json(testCase.pages[page++]);
      },
    });
    await assert.rejects(
      provider.reconcileWebhookCreate({ apiKey: "re_full_access", intent }),
      (error: unknown) =>
        error instanceof ResendReceivingProviderError &&
        error.code === "RESEND_RECEIVING_RESPONSE_INVALID" &&
        !error.message.includes(intent.endpoint),
    );
    assert.equal(calls.length, testCase.expectedCalls);
    assert.equal(
      calls.every((call) => call.startsWith("GET ")),
      true,
    );
  }
});

test("ambiguous create reconciliation rejects a malformed page without retrieval or POST", async () => {
  const intent = prepareResendWebhookCreateIntent(
    "https://example.test/inbound/opaque",
  );
  const malformedPages: unknown[] = [
    { object: "list", has_more: "false", data: [] },
    { object: "list", has_more: false, data: {} },
    {
      object: "list",
      has_more: false,
      data: [{ ...webhookListRow("webhook-1"), events: "email.received" }],
    },
  ];

  for (const page of malformedPages) {
    const calls: string[] = [];
    const provider = new ResendHttpReceivingProvider({
      baseUrl: "https://resend.test",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
        return Response.json(page);
      },
    });
    await assert.rejects(
      provider.reconcileWebhookCreate({ apiKey: "re_full_access", intent }),
      (error: unknown) =>
        error instanceof ResendReceivingProviderError &&
        error.code === "RESEND_RECEIVING_RESPONSE_INVALID" &&
        !error.message.includes(intent.endpoint),
    );
    assert.deepEqual(calls, ["GET /webhooks?limit=100"]);
  }
});

test("malformed create evidence fails closed without disclosing secret input", async () => {
  const providerSecret = "whsec_malformed_must_not_escape";
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async () =>
      Response.json({ signing_secret: providerSecret, unexpected: true }),
  });

  await assert.rejects(
    provider.createWebhook({
      apiKey: "re_full_access",
      intent: prepareResendWebhookCreateIntent(
        "https://example.test/inbound/opaque",
      ),
    }),
    (error: unknown) =>
      error instanceof ResendReceivingProviderError &&
      error.code === "RESEND_RECEIVING_RESPONSE_INVALID" &&
      !error.message.includes(providerSecret),
  );
});

test("ambiguous create reconciliation fails closed on zero or multiple intent matches", async () => {
  const endpoint = "https://example.test/inbound/opaque";
  const intent = prepareResendWebhookCreateIntent(endpoint);

  for (const data of [
    [],
    [
      {
        id: "webhook-1",
        endpoint,
        status: "enabled",
        events: ["email.received"],
      },
      {
        id: "webhook-2",
        endpoint,
        status: "disabled",
        events: ["email.received"],
      },
    ],
  ]) {
    const calls: string[] = [];
    const provider = new ResendHttpReceivingProvider({
      baseUrl: "https://resend.test",
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
        return Response.json({ object: "list", has_more: false, data });
      },
    });

    await assert.rejects(
      provider.reconcileWebhookCreate({ apiKey: "re_full_access", intent }),
      (error: unknown) =>
        error instanceof ResendReceivingProviderError &&
        error.code === "RESEND_RECEIVING_RESPONSE_INVALID" &&
        !error.message.includes(endpoint),
    );
    assert.deepEqual(calls, ["GET /webhooks"]);
  }
});

test("ambiguous create reconciliation verifies retrieved identity, endpoint, status, events, and secret", async () => {
  const endpoint = "https://example.test/inbound/opaque";
  const intent = prepareResendWebhookCreateIntent(endpoint);
  const base = {
    id: "webhook-1",
    endpoint,
    status: "enabled",
    events: ["email.received"],
    signing_secret: "whsec_recovered",
  };
  const invalidRetrieved: unknown[] = [
    { ...base, id: "webhook-other" },
    { ...base, endpoint: `${endpoint}/other` },
    { ...base, endpoint: ` ${endpoint}` },
    { ...base, status: "disabled" },
    { ...base, events: ["email.sent"] },
    { ...base, events: ["email.received", "email.sent"] },
    { ...base, events: [" email.received"] },
    { ...base, signing_secret: "" },
  ];

  for (const retrieved of invalidRetrieved) {
    const calls: string[] = [];
    const provider = new ResendHttpReceivingProvider({
      baseUrl: "https://resend.test",
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/webhooks") {
          return Response.json({
            object: "list",
            has_more: false,
            data: [base],
          });
        }
        return Response.json(retrieved);
      },
    });

    await assert.rejects(
      provider.reconcileWebhookCreate({ apiKey: "re_full_access", intent }),
      (error: unknown) =>
        error instanceof ResendReceivingProviderError &&
        error.code === "RESEND_RECEIVING_RESPONSE_INVALID" &&
        !error.message.includes(base.signing_secret),
    );
    assert.deepEqual(calls, [
      "GET /webhooks",
      "GET /webhooks/webhook-1",
    ]);
  }
});

test("ambiguous create reconciliation requires matching enabled list and retrieve status", async () => {
  const endpoint = "https://example.test/inbound/opaque";
  const providerSecret = "whsec_status_contradiction";
  const intent = prepareResendWebhookCreateIntent(endpoint);
  const cases = [
    { listedStatus: "enabled", retrievedStatus: "disabled" },
    { listedStatus: "disabled", retrievedStatus: "enabled" },
  ] as const;

  for (const testCase of cases) {
    const calls: string[] = [];
    const provider = new ResendHttpReceivingProvider({
      baseUrl: "https://resend.test",
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/webhooks") {
          return Response.json({
            object: "list",
            has_more: false,
            data: [
              {
                id: "webhook-1",
                endpoint,
                status: testCase.listedStatus,
                events: ["email.received"],
              },
            ],
          });
        }
        return Response.json({
          id: "webhook-1",
          endpoint,
          status: testCase.retrievedStatus,
          events: ["email.received"],
          signing_secret: providerSecret,
        });
      },
    });

    await assert.rejects(
      provider.reconcileWebhookCreate({ apiKey: "re_full_access", intent }),
      (error: unknown) =>
        error instanceof ResendReceivingProviderError &&
        error.code === "RESEND_RECEIVING_RESPONSE_INVALID" &&
        !error.message.includes(endpoint) &&
        !error.message.includes(providerSecret),
    );
    assert.deepEqual(calls, ["GET /webhooks", "GET /webhooks/webhook-1"]);
  }
});

test("ambiguous create reconciliation recovers from matching enabled projections with GET only", async () => {
  const endpoint = "https://example.test/inbound/opaque";
  const intent = prepareResendWebhookCreateIntent(endpoint);
  const calls: string[] = [];
  const provider = new ResendHttpReceivingProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      const projection = {
        id: "webhook-1",
        endpoint,
        status: "enabled",
        events: ["email.received"],
      };
      return path === "/webhooks"
        ? Response.json({
            object: "list",
            has_more: false,
            data: [projection],
          })
        : Response.json({
            ...projection,
            signing_secret: "whsec_recovered",
          });
    },
  });

  assert.deepEqual(
    await provider.reconcileWebhookCreate({ apiKey: "re_full_access", intent }),
    { id: "webhook-1", signingSecret: "whsec_recovered" },
  );
  assert.deepEqual(calls, ["GET /webhooks", "GET /webhooks/webhook-1"]);
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
    intent: prepareResendWebhookCreateIntent(
      "https://example.test/inbound",
    ),
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
    intent: prepareResendWebhookCreateIntent(
      "https://example.test/inbound",
    ),
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
