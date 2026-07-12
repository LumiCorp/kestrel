import assert from "node:assert/strict";
import test from "node:test";
import {
  BrokeredModelGateway,
  createProviderGatewayForLease,
  GATEWAY_CREDENTIAL_CACHE_TTL_MS,
  GATEWAY_CREDENTIAL_LEASE_VERSION,
  GatewayCredentialBrokerClient,
  GatewayCredentialBrokerError,
  type GatewayCredentialLease,
  GatewayCredentialLeaseCache,
} from "../../cli/runtime/gateway-credential-broker.js";
import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";

const reference = {
  source: "kestrel-one" as const,
  gatewayId: "gateway-openrouter",
  rawModelId: "openai/gpt-5.4",
};

function lease(input: {
  leaseId: string;
  expiresAtMs: number;
}): GatewayCredentialLease {
  return {
    version: GATEWAY_CREDENTIAL_LEASE_VERSION,
    leaseId: input.leaseId,
    gatewayId: reference.gatewayId,
    rawModelId: reference.rawModelId,
    provider: "openrouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai",
    apiKey: "provider-secret",
    expiresAt: new Date(input.expiresAtMs).toISOString(),
  };
}

test("credential broker client sends its dedicated token and validates the lease", async () => {
  let authorization: string | null = null;
  let requestBody: Record<string, unknown> | undefined;
  const client = new GatewayCredentialBrokerClient({
    appUrl: "http://127.0.0.1:43103",
    token: "broker-secret",
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(
        lease({
          leaseId: "lease-1",
          expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
        })
      );
    },
  });

  const result = await client.issueLease(reference);

  assert.equal(authorization, "Bearer broker-secret");
  assert.equal(requestBody?.gatewayId, reference.gatewayId);
  assert.equal(result.leaseId, "lease-1");
});

test("credential broker rejects cleartext non-loopback endpoints", () => {
  assert.throws(
    () =>
      new GatewayCredentialBrokerClient({
        appUrl: "http://app.internal",
        token: "broker-secret",
      }),
    (error: unknown) =>
      error instanceof GatewayCredentialBrokerError &&
      error.code === "GATEWAY_CREDENTIAL_BROKER_INSECURE"
  );
});

test("credential broker errors never include a response secret", async () => {
  const client = new GatewayCredentialBrokerClient({
    appUrl: "https://app.example.test",
    token: "broker-secret",
    fetchImpl: async () =>
      Response.json(
        { code: "GATEWAY_CREDENTIAL_MISSING", error: "provider-secret" },
        { status: 503 }
      ),
  });

  await assert.rejects(client.issueLease(reference), (error: unknown) => {
    assert.equal(String(error).includes("provider-secret"), false);
    return true;
  });
});

test("credential broker transport errors never include thrown secret text", async () => {
  const client = new GatewayCredentialBrokerClient({
    appUrl: "https://app.example.test",
    token: "broker-secret",
    fetchImpl: async () => {
      throw new Error("transport exposed provider-secret and broker-secret");
    },
  });

  await assert.rejects(client.issueLease(reference), (error: unknown) => {
    assert.equal(String(error).includes("provider-secret"), false);
    assert.equal(String(error).includes("broker-secret"), false);
    return true;
  });
});

test("credential cache reuses a lease until its bounded expiry", async () => {
  let now = 1_000_000;
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    now: () => now,
    random: () => 0,
    load: async () => {
      loads += 1;
      return lease({
        leaseId: `lease-${loads}`,
        expiresAtMs: now + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      });
    },
  });

  assert.equal((await cache.get(reference)).leaseId, "lease-1");
  assert.equal((await cache.get(reference)).leaseId, "lease-1");
  now += GATEWAY_CREDENTIAL_CACHE_TTL_MS;
  assert.equal((await cache.get(reference)).leaseId, "lease-2");
  assert.equal(loads, 2);
});

test("credential rotation is observed on the first call after cache expiry", async () => {
  let now = 3_000_000;
  let loads = 0;
  const usedKeys: Array<string | null> = [];
  const cache = new GatewayCredentialLeaseCache({
    now: () => now,
    random: () => 0,
    load: async () => ({
      ...lease({
        leaseId: `lease-${++loads}`,
        expiresAtMs: now + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
      apiKey: `rotated-key-${loads}`,
    }),
  });
  const gateway = new BrokeredModelGateway({
    reference,
    cache,
    createProvider: (currentLease) => ({
      async call<T>() {
        usedKeys.push(currentLease.apiKey);
        return { ok: true } as T;
      },
    }),
  });

  await gateway.call({ input: "first" });
  await gateway.call({ input: "still cached" });
  now += GATEWAY_CREDENTIAL_CACHE_TTL_MS;
  await gateway.call({ input: "after rotation bound" });

  assert.deepEqual(usedKeys, [
    "rotated-key-1",
    "rotated-key-1",
    "rotated-key-2",
  ]);
  assert.equal(loads, 2);
});

test("governance revocation fails the first call after cache expiry", async () => {
  let now = 4_000_000;
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    now: () => now,
    random: () => 0,
    load: async () => {
      loads += 1;
      if (loads > 1) {
        throw new GatewayCredentialBrokerError(
          "GATEWAY_MODEL_NOT_APPROVED",
          "model unavailable",
          404
        );
      }
      return lease({
        leaseId: "lease-before-revocation",
        expiresAtMs: now + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      });
    },
  });
  const gateway = new BrokeredModelGateway({
    reference,
    cache,
    createProvider: () => ({
      async call<T>() {
        return { ok: true } as T;
      },
    }),
  });

  await gateway.call({ input: "before revocation" });
  now += GATEWAY_CREDENTIAL_CACHE_TTL_MS;
  await assert.rejects(
    gateway.call({ input: "after revocation bound" }),
    (error: unknown) =>
      error instanceof GatewayCredentialBrokerError &&
      error.code === "GATEWAY_MODEL_NOT_APPROVED"
  );
  assert.equal(loads, 2);
});

test("credential cache coalesces concurrent misses", async () => {
  let releaseLoad: (() => void) | undefined;
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () => {
      loads += 1;
      await new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      return lease({
        leaseId: "lease-shared",
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      });
    },
  });

  const first = cache.get(reference);
  const second = cache.get(reference);
  await new Promise((resolve) => setImmediate(resolve));
  releaseLoad?.();

  assert.equal((await first).leaseId, "lease-shared");
  assert.equal((await second).leaseId, "lease-shared");
  assert.equal(loads, 1);
});

test("credential cache applies bounded early-expiration jitter", async () => {
  let now = 2_000_000;
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    now: () => now,
    random: () => 1,
    load: async () =>
      lease({
        leaseId: `lease-${++loads}`,
        expiresAtMs: now + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
  });

  await cache.get(reference);
  now += GATEWAY_CREDENTIAL_CACHE_TTL_MS - 30_001;
  assert.equal((await cache.get(reference)).leaseId, "lease-1");
  now += 1;
  assert.equal((await cache.get(reference)).leaseId, "lease-2");
});

test("credential cache evicts the least recently used bounded entry", async () => {
  const secondReference = {
    ...reference,
    rawModelId: "anthropic/claude-sonnet",
  };
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    maxEntries: 1,
    random: () => 0,
    load: async (current) => ({
      ...lease({
        leaseId: `lease-${++loads}`,
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
      rawModelId: current.rawModelId,
    }),
  });

  await cache.get(reference);
  await cache.get(secondReference);
  await cache.get(reference);
  assert.equal(loads, 3);
});

test("brokered model gateway refreshes once after provider authentication failure", async () => {
  let loads = 0;
  let providerCalls = 0;
  const requestedModels: Array<string | undefined> = [];
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () => {
      loads += 1;
      return lease({
        leaseId: `lease-${loads}`,
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      });
    },
  });
  const gateway = new BrokeredModelGateway({
    reference,
    cache,
    createProvider: (currentLease) =>
      ({
        async call<T>(request: Parameters<ModelGateway["call"]>[0]) {
          providerCalls += 1;
          requestedModels.push(request.model);
          if (currentLease.leaseId === "lease-1") {
            throw Object.assign(new Error("provider auth rejected"), {
              code: "MODEL_AUTH_ERROR",
              status: 401,
            });
          }
          return { text: "selected model answered" } as T;
        },
      }) satisfies ModelGateway,
  });

  const result = await gateway.call<{ text: string }>({
    input: "hello",
    model: "z-ai/glm-5.2",
  });

  assert.equal(result.text, "selected model answered");
  assert.equal(loads, 2);
  assert.equal(providerCalls, 2);
  assert.deepEqual(requestedModels, [
    reference.rawModelId,
    reference.rawModelId,
  ]);
});

test("brokered model gateway refreshes once after provider authorization failure", async () => {
  let loads = 0;
  let providerCalls = 0;
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () =>
      lease({
        leaseId: `lease-${++loads}`,
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
  });
  const gateway = new BrokeredModelGateway({
    reference,
    cache,
    createProvider: (currentLease) => ({
      async call<T>() {
        providerCalls += 1;
        if (currentLease.leaseId === "lease-1") {
          throw Object.assign(new Error("provider authorization rejected"), {
            status: 403,
          });
        }
        return { text: "selected model answered" } as T;
      },
    }),
  });

  const result = await gateway.call<{ text: string }>({ input: "hello" });

  assert.equal(result.text, "selected model answered");
  assert.equal(loads, 2);
  assert.equal(providerCalls, 2);
});

test("managed provider errors cannot expose leased credentials after refresh", async () => {
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () => ({
      ...lease({
        leaseId: `lease-${++loads}`,
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
      apiKey: `leased-provider-secret-${loads}`,
    }),
  });
  const gateway = new BrokeredModelGateway({
    reference,
    cache,
    createProvider: (currentLease) => ({
      async call<T>() {
        throw Object.assign(
          new Error(`provider echoed ${currentLease.apiKey}`),
          {
            code: "MODEL_AUTH_ERROR",
            status: 401,
            details: { body: currentLease.apiKey },
          }
        ) as T;
      },
    }),
  });

  await assert.rejects(gateway.call({ input: "hello" }), (error: unknown) => {
    assert.equal(String(error).includes("leased-provider-secret-1"), false);
    assert.equal(String(error).includes("leased-provider-secret-2"), false);
    assert.equal((error as { code?: unknown }).code, "MODEL_AUTH_ERROR");
    assert.equal((error as { status?: unknown }).status, 401);
    assert.equal("details" in (error as object), false);
    return true;
  });
  assert.equal(loads, 2);
});

test("brokered model gateway fails closed when lease resolution fails", async () => {
  const cache = new GatewayCredentialLeaseCache({
    load: async () => {
      throw new GatewayCredentialBrokerError(
        "GATEWAY_CREDENTIAL_BROKER_UNAVAILABLE",
        "broker unavailable"
      );
    },
  });
  const gateway = new BrokeredModelGateway({
    reference,
    cache,
    createProvider: () => {
      throw new Error("provider fallback must not be constructed");
    },
  });

  await assert.rejects(
    gateway.call({ input: "hello" }),
    (error: unknown) =>
      error instanceof GatewayCredentialBrokerError &&
      error.code === "GATEWAY_CREDENTIAL_BROKER_UNAVAILABLE"
  );
});

test("all approved language gateway transports construct from leased credentials without runner provider keys", () => {
  const original = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const base = lease({
      leaseId: "provider-matrix",
      expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
    });
    const cases: GatewayCredentialLease[] = [
      { ...base, provider: "openrouter", protocol: "openai" },
      {
        ...base,
        provider: "openai",
        protocol: "openai",
        rawModelId: "gpt-5.4",
      },
      {
        ...base,
        provider: "anthropic",
        protocol: "anthropic",
        rawModelId: "claude-sonnet",
      },
      {
        ...base,
        provider: "ollama",
        protocol: "openai",
        apiKey: null,
        rawModelId: "qwen3",
      },
      { ...base, provider: "lumi", protocol: "openai", rawModelId: "gpt-5.4" },
      {
        ...base,
        provider: "lumi",
        protocol: "anthropic",
        rawModelId: "claude-sonnet",
      },
    ];

    for (const current of cases) {
      assert.doesNotThrow(() => createProviderGatewayForLease(current));
    }
  } finally {
    restoreEnv("OPENAI_API_KEY", original.OPENAI_API_KEY);
    restoreEnv("OPENROUTER_API_KEY", original.OPENROUTER_API_KEY);
    restoreEnv("ANTHROPIC_API_KEY", original.ANTHROPIC_API_KEY);
  }
});

test("managed Ollama omits a runner environment key when its lease has no key", async () => {
  let authorization: string | null = "not-called";
  const original = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "runner-fallback-secret";
  try {
    const gateway = createProviderGatewayForLease(
      {
        ...lease({
          leaseId: "ollama-without-key",
          expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
        }),
        provider: "ollama",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:11434",
        apiKey: null,
        rawModelId: "qwen3",
      },
      {
        fetchImpl: async (_url, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return Response.json(
            { error: { message: "synthetic auth failure" } },
            { status: 401 }
          );
        },
      }
    );
    await assert.rejects(gateway.call({ input: "hello" }));
    assert.equal(authorization, null);
  } finally {
    restoreEnv("OLLAMA_API_KEY", original);
  }
});

test("all gateway transports send the leased model and credential to the expected protocol", async () => {
  const cases: Array<{
    name: string;
    lease: GatewayCredentialLease;
    expectedUrl: string;
    expectedAuthorization: string | null;
    expectedAnthropicKey: string | null;
  }> = [
    {
      name: "OpenRouter",
      lease: {
        ...lease({ leaseId: "openrouter", expiresAtMs: Date.now() + 60_000 }),
        baseUrl: "https://openrouter.ai",
      },
      expectedUrl: "https://openrouter.ai/api/v1/chat/completions",
      expectedAuthorization: "Bearer provider-secret",
      expectedAnthropicKey: null,
    },
    {
      name: "OpenAI",
      lease: {
        ...lease({ leaseId: "openai", expiresAtMs: Date.now() + 60_000 }),
        provider: "openai",
        rawModelId: "gpt-5.4",
        baseUrl: "https://api.openai.com",
      },
      expectedUrl: "https://api.openai.com/v1/chat/completions",
      expectedAuthorization: "Bearer provider-secret",
      expectedAnthropicKey: null,
    },
    {
      name: "Anthropic",
      lease: {
        ...lease({ leaseId: "anthropic", expiresAtMs: Date.now() + 60_000 }),
        provider: "anthropic",
        protocol: "anthropic",
        rawModelId: "claude-sonnet",
        baseUrl: "https://api.anthropic.com",
      },
      expectedUrl: "https://api.anthropic.com/v1/messages",
      expectedAuthorization: null,
      expectedAnthropicKey: "provider-secret",
    },
    {
      name: "Ollama",
      lease: {
        ...lease({ leaseId: "ollama", expiresAtMs: Date.now() + 60_000 }),
        provider: "ollama",
        rawModelId: "qwen3",
        baseUrl: "http://127.0.0.1:11434",
        apiKey: null,
      },
      expectedUrl: "http://127.0.0.1:11434/v1/chat/completions",
      expectedAuthorization: null,
      expectedAnthropicKey: null,
    },
    {
      name: "Lumi OpenAI",
      lease: {
        ...lease({ leaseId: "lumi-openai", expiresAtMs: Date.now() + 60_000 }),
        provider: "lumi",
        rawModelId: "gpt-5.4",
        baseUrl: "https://api.kestrelagents.dev",
      },
      expectedUrl: "https://api.kestrelagents.dev/v1/chat/completions",
      expectedAuthorization: "Bearer provider-secret",
      expectedAnthropicKey: null,
    },
    {
      name: "Lumi Anthropic",
      lease: {
        ...lease({
          leaseId: "lumi-anthropic",
          expiresAtMs: Date.now() + 60_000,
        }),
        provider: "lumi",
        protocol: "anthropic",
        rawModelId: "claude-sonnet",
        baseUrl: "https://api.kestrelagents.dev",
      },
      expectedUrl: "https://api.kestrelagents.dev/v1/messages",
      expectedAuthorization: null,
      expectedAnthropicKey: "provider-secret",
    },
  ];

  for (const current of cases) {
    let captured:
      | { url: string; headers: Headers; body: Record<string, unknown> }
      | undefined;
    const gateway = createProviderGatewayForLease(current.lease, {
      fetchImpl: async (url, init) => {
        captured = {
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        return Response.json(
          { error: { message: "synthetic stop" } },
          { status: 401 }
        );
      },
    });

    await assert.rejects(gateway.call({ input: "hello" }), current.name);
    assert.equal(captured?.url, current.expectedUrl, current.name);
    assert.equal(
      captured?.headers.get("authorization") ?? null,
      current.expectedAuthorization,
      current.name
    );
    assert.equal(
      captured?.headers.get("x-api-key") ?? null,
      current.expectedAnthropicKey,
      current.name
    );
    assert.equal(captured?.body.model, current.lease.rawModelId, current.name);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
