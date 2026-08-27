import test from "node:test";
import assert from "node:assert/strict";
import {
  BrokeredModelGateway,
  createProviderGatewayForLease,
  GATEWAY_CREDENTIAL_CACHE_TTL_MS,
  GATEWAY_CREDENTIAL_LEASE_VERSION,
  GatewayCredentialBrokerError,
  getDefaultGatewayCredentialCacheForTests,
  registerEmbeddedGatewayCredentialLease,
  resetDefaultGatewayCredentialCacheForTests,
  type GatewayCredentialLease,
  GatewayCredentialLeaseCache,
} from "../../cli/runtime/gateway-credential-broker.js";
import type {
  ModelGateway,
  ModelGatewayCallOptions,
  ModelRequest,
} from "../../src/kestrel/contracts/model-io.js";
import {
  MODEL_REQUEST_V2_VERSION,
  createModelRequestV2,
} from "../../src/kestrel/contracts/model-registration.js";
import { createEffectiveModelContractV1 } from "../../src/kestrel/effective-model-contract.js";

const reference = {
  source: "kestrel-one" as const,
  runId: "run-1",
  organizationId: "org-acme",
  environmentId: "env-production",
  gatewayId: "gateway-openrouter",
  rawModelId: "openai/gpt-5.4",
  provider: "openrouter" as const,
};

const qualifiedRouteBinding = {
  version: "model_credential_route_binding_v2" as const,
  status: "qualified" as const,
  provider: "openrouter" as const,
  rawModelId: reference.rawModelId,
  registrationId: "openrouter:gpt-5.4",
  registrationRevision: "registration-4",
  registrationFingerprint: `sha256:${"a".repeat(64)}`,
  qualificationRevision: "qualification-3",
  apiEndpoint: "https://openrouter.ai/api/v1",
  endpointCodec: "openrouter.chat.v2",
  routingPolicyFingerprint: `sha256:${"b".repeat(64)}`,
  requiredRole: "agent.loop",
  credentialRevision: 7,
};

function lease(input: {
  leaseId: string;
  expiresAtMs: number;
}): GatewayCredentialLease {
  return {
    version: GATEWAY_CREDENTIAL_LEASE_VERSION,
    leaseId: input.leaseId,
    organizationId: reference.organizationId,
    environmentId: reference.environmentId,
    gatewayId: reference.gatewayId,
    rawModelId: reference.rawModelId,
    provider: "openrouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai",
    apiKey: "provider-secret",
    expiresAt: new Date(input.expiresAtMs).toISOString(),
  };
}

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

test("broker rejects a qualified route mismatch before provider creation", async () => {
  let providerCreations = 0;
  const boundReference = { ...reference, routeBinding: qualifiedRouteBinding };
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () => ({
      ...lease({
        leaseId: "qualified-lease",
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
      routeBinding: qualifiedRouteBinding,
    }),
  });
  const gateway = new BrokeredModelGateway({
    reference: boundReference,
    cache,
    createProvider: () => {
      providerCreations += 1;
      return {
        async call<T>() {
          return {} as T;
        },
      };
    },
  });

  await assert.rejects(
    gateway.call({ input: "do not substitute", model: "other-model" }),
    (error: unknown) =>
      error instanceof GatewayCredentialBrokerError &&
      error.code === "GATEWAY_CREDENTIAL_CONTRACT_MISMATCH",
  );
  assert.equal(providerCreations, 0);
});

test("broker rejects a tampered qualified lease before provider creation", async () => {
  let providerCreations = 0;
  const boundReference = { ...reference, routeBinding: qualifiedRouteBinding };
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () => ({
      ...lease({
        leaseId: "tampered-lease",
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
      routeBinding: { ...qualifiedRouteBinding, endpointCodec: "tampered" },
    }),
  });
  const gateway = new BrokeredModelGateway({
    reference: boundReference,
    cache,
    createProvider: () => {
      providerCreations += 1;
      return {
        async call<T>() {
          return {} as T;
        },
      };
    },
  });

  const request = qualifiedRequest();
  await assert.rejects(
    gateway.call(request, { effectiveModelContract: qualifiedContract(request) }),
    (error: unknown) =>
      error instanceof GatewayCredentialBrokerError &&
      error.code === "GATEWAY_CREDENTIAL_ROUTE_MISMATCH",
  );
  assert.equal(providerCreations, 0);
});

test("broker rejects a mismatched effective contract before acquiring a credential lease", async () => {
  let loads = 0;
  let providerCreations = 0;
  const request = qualifiedRequest();
  const contract = createEffectiveModelContractV1({
    ...qualifiedContractInput(request),
    runtimeRole: "different-role",
  });
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () => {
      loads += 1;
      return { ...lease({ leaseId: "should-not-load", expiresAtMs: Date.now() + 60_000 }), routeBinding: qualifiedRouteBinding };
    },
  });
  const gateway = new BrokeredModelGateway({
    reference: { ...reference, routeBinding: qualifiedRouteBinding },
    cache,
    createProvider: () => {
      providerCreations += 1;
      return { async call<T>() { return {} as T; } };
    },
  });

  await assert.rejects(
    gateway.call(request, { effectiveModelContract: contract }),
    (error: unknown) => error instanceof GatewayCredentialBrokerError && error.code === "GATEWAY_CREDENTIAL_CONTRACT_MISMATCH",
  );
  assert.equal(loads, 0);
  assert.equal(providerCreations, 0);
});

test("broker rejects a qualified endpoint that does not match its bound codec", async () => {
  let loads = 0;
  const request = qualifiedRequest();
  const contract = createEffectiveModelContractV1({
    ...qualifiedContractInput(request),
    endpoint: "responses",
  });
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () => {
      loads += 1;
      return { ...lease({ leaseId: "should-not-load", expiresAtMs: Date.now() + 60_000 }), routeBinding: qualifiedRouteBinding };
    },
  });
  const gateway = new BrokeredModelGateway({
    reference: { ...reference, routeBinding: qualifiedRouteBinding },
    cache,
    createProvider: () => ({ async call<T>() { return {} as T; } }),
  });

  await assert.rejects(
    gateway.call(request, { effectiveModelContract: contract }),
    (error: unknown) =>
      error instanceof GatewayCredentialBrokerError &&
      error.code === "GATEWAY_CREDENTIAL_CONTRACT_MISMATCH",
  );
  assert.equal(loads, 0);
});

test("broker blocks structured legacy routes before acquiring a credential lease", async () => {
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () => {
      loads += 1;
      return lease({
        leaseId: "legacy-structured-should-not-load",
        expiresAtMs: Date.now() + 60_000,
      });
    },
  });
  const gateway = new BrokeredModelGateway({
    reference: {
      ...reference,
      routeBinding: {
        version: "model_credential_route_binding_v2",
        status: "legacy_unqualified",
        provider: reference.provider,
        rawModelId: reference.rawModelId,
      },
    },
    cache,
    createProvider: () => ({ async call<T>() { return {} as T; } }),
  });

  await assert.rejects(
    gateway.call(structuredRequest()),
    (error: unknown) =>
      error instanceof GatewayCredentialBrokerError &&
      error.code === "GATEWAY_CREDENTIAL_CONTRACT_MISMATCH",
  );
  assert.equal(loads, 0);
});

function qualifiedRequest() {
  return createModelRequestV2({
    version: MODEL_REQUEST_V2_VERSION,
    model: reference.rawModelId,
    input: "do not lease",
    requirements: {
      runtimeRole: "agent.loop",
      output: { kind: "text", assurance: "none" },
      tools: { choice: "none", strictArguments: false, parallelism: "forbidden" },
      reasoning: { mode: "off", continuationKinds: [] },
      streaming: { required: false, terminalBehavior: "not_required" },
      inputModalities: ["text"],
      endpoint: "chat",
    },
  });
}

function structuredRequest() {
  return createModelRequestV2({
    version: MODEL_REQUEST_V2_VERSION,
    model: reference.rawModelId,
    input: "return JSON",
    responseFormat: "json",
    requirements: {
      runtimeRole: "agent.loop",
      output: { kind: "json_object", assurance: "json_syntax" },
      tools: { choice: "none", strictArguments: false, parallelism: "forbidden" },
      reasoning: { mode: "off", continuationKinds: [] },
      streaming: { required: false, terminalBehavior: "not_required" },
      inputModalities: ["text"],
      endpoint: "chat",
    },
  });
}

function qualifiedContract(request: ReturnType<typeof qualifiedRequest>) {
  return createEffectiveModelContractV1(qualifiedContractInput(request));
}

function qualifiedContractInput(
  request: ReturnType<typeof qualifiedRequest>,
): Parameters<typeof createEffectiveModelContractV1>[0] {
  return {
    status: "qualified" as const,
    providerId: "openrouter" as const,
    modelId: reference.rawModelId,
    registrationId: qualifiedRouteBinding.registrationId,
    registrationRevision: qualifiedRouteBinding.registrationRevision,
    registrationFingerprint: qualifiedRouteBinding.registrationFingerprint,
    qualificationRevision: qualifiedRouteBinding.qualificationRevision,
    credentialRevision: qualifiedRouteBinding.credentialRevision,
    apiEndpoint: qualifiedRouteBinding.apiEndpoint,
    endpoint: "chat" as const,
    endpointCodec: qualifiedRouteBinding.endpointCodec,
    routingPolicyFingerprint: qualifiedRouteBinding.routingPolicyFingerprint,
    runtimeRole: qualifiedRouteBinding.requiredRole,
    requestFingerprint: request.fingerprints.request,
    schemaHash: request.fingerprints.schema,
    toolSurfaceHash: request.fingerprints.toolSurface,
  };
}

test("credential cache isolates otherwise identical references by organization", async () => {
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async (current) => ({
      ...lease({
        leaseId: `lease-${++loads}`,
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
      organizationId: current.organizationId,
    }),
  });

  const first = await cache.get(reference);
  const second = await cache.get({
    ...reference,
    organizationId: "org-other",
  });
  assert.equal(first.leaseId, "lease-1");
  assert.equal(second.leaseId, "lease-2");
  assert.equal(loads, 2);
});

test("credential cache isolates otherwise identical references by Environment", async () => {
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async (current) => ({
      ...lease({
        leaseId: `lease-${++loads}`,
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
      environmentId: current.environmentId,
    }),
  });

  const first = await cache.get(reference);
  const second = await cache.get({
    ...reference,
    environmentId: "env-staging",
  });
  assert.equal(first.leaseId, "lease-1");
  assert.equal(second.leaseId, "lease-2");
  assert.equal(loads, 2);
});

test("credential cache isolates otherwise identical references by run", async () => {
  let loads = 0;
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async (current) => ({
      ...lease({
        leaseId: `${current.runId}:lease-${++loads}`,
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
    }),
  });

  const first = await cache.get(reference);
  const second = await cache.get({
    ...reference,
    runId: "run-2",
  });
  assert.equal(first.leaseId, "run-1:lease-1");
  assert.equal(second.leaseId, "run-2:lease-2");
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
          404,
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
      error.code === "GATEWAY_MODEL_NOT_APPROVED",
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

test("brokered model gateway preserves provider authentication failure without hidden refresh", async () => {
  let loads = 0;
  let providerCalls = 0;
  const registeredLeases: string[] = [];
  const releasedLeases: string[] = [];
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
    onLease: (currentLease) => {
      registeredLeases.push(currentLease.leaseId);
      return () => releasedLeases.push(currentLease.leaseId);
    },
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

  await assert.rejects(
    gateway.call({ input: "hello", model: "z-ai/glm-5.2" }),
    (error: unknown) =>
      (error as { code?: unknown }).code === "MODEL_AUTH_ERROR",
  );
  assert.equal(loads, 1);
  assert.equal(providerCalls, 1);
  assert.deepEqual(requestedModels, [reference.rawModelId]);
  assert.deepEqual(registeredLeases, ["lease-1"]);
  assert.deepEqual(releasedLeases, []);
});

test("brokered model gateway preserves provider authorization failure without hidden refresh", async () => {
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

  await assert.rejects(
    gateway.call({ input: "hello" }),
    (error: unknown) => (error as { status?: unknown }).status === 403,
  );
  assert.equal(loads, 1);
  assert.equal(providerCalls, 1);
});

test("brokered OpenRouter failures retain provider attribution and public call options", async () => {
  const cache = new GatewayCredentialLeaseCache({
    random: () => 0,
    load: async () =>
      lease({
        leaseId: "lease-rate-limited",
        expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
      }),
  });
  let observedOptions: ModelGatewayCallOptions | undefined;
  const gateway = new BrokeredModelGateway({
    reference,
    cache,
    createProvider: () => ({
      async call<T>(
        _request: ModelRequest,
        options?: ModelGatewayCallOptions,
      ): Promise<T> {
        observedOptions = options;
        throw Object.assign(new Error("provider detail"), {
          code: "MODEL_RATE_LIMITED",
          status: 429,
        });
      },
    }),
  });
  const onEvent = async () => {};

  await assert.rejects(
    gateway.call({ input: "maintenance" }, { retryCount: 0, onEvent }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "MODEL_RATE_LIMITED");
      assert.equal((error as { status?: unknown }).status, 429);
      assert.match(
        String(error),
        /OpenRouter provider request failed \(429\)/u,
      );
      assert.doesNotMatch(String(error), /provider detail/u);
      return true;
    },
  );
  assert.equal(observedOptions?.retryCount, 0);
  assert.equal(observedOptions?.onEvent, onEvent);
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
          },
        ) as T;
      },
    }),
  });

  await assert.rejects(gateway.call({ input: "hello" }), (error: unknown) => {
    assert.equal(String(error).includes("leased-provider-secret-1"), false);
    assert.equal((error as { code?: unknown }).code, "MODEL_AUTH_ERROR");
    assert.equal((error as { status?: unknown }).status, 401);
    assert.equal("details" in (error as object), false);
    return true;
  });
  assert.equal(loads, 1);
});

test("brokered model gateway fails closed when lease resolution fails", async () => {
  const cache = new GatewayCredentialLeaseCache({
    load: async () => {
      throw new GatewayCredentialBrokerError(
        "GATEWAY_CREDENTIAL_BROKER_UNAVAILABLE",
        "broker unavailable",
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
      error.code === "GATEWAY_CREDENTIAL_BROKER_UNAVAILABLE",
  );
});

test("embedded Desktop model grants remain reusable until lease expiry", async (context) => {
  resetDefaultGatewayCredentialCacheForTests();
  context.after(() => resetDefaultGatewayCredentialCacheForTests());
  const original = {
    KESTREL_ENVIRONMENT_GATEWAY_URL:
      process.env.KESTREL_ENVIRONMENT_GATEWAY_URL,
    KESTREL_WORKSPACE_SERVICE_TOKEN:
      process.env.KESTREL_WORKSPACE_SERVICE_TOKEN,
  };
  delete process.env.KESTREL_ENVIRONMENT_GATEWAY_URL;
  delete process.env.KESTREL_WORKSPACE_SERVICE_TOKEN;
  context.after(() => {
    restoreEnv(
      "KESTREL_ENVIRONMENT_GATEWAY_URL",
      original.KESTREL_ENVIRONMENT_GATEWAY_URL,
    );
    restoreEnv(
      "KESTREL_WORKSPACE_SERVICE_TOKEN",
      original.KESTREL_WORKSPACE_SERVICE_TOKEN,
    );
  });
  const embedded = lease({
    leaseId: "embedded-desktop-lease",
    expiresAtMs: Date.now() + GATEWAY_CREDENTIAL_CACHE_TTL_MS,
  });
  registerEmbeddedGatewayCredentialLease({ reference, lease: embedded });
  const cache = getDefaultGatewayCredentialCacheForTests();

  assert.equal((await cache.get(reference)).leaseId, "embedded-desktop-lease");
  cache.invalidate(reference);
  assert.equal((await cache.get(reference)).leaseId, "embedded-desktop-lease");
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
      {
        ...base,
        provider: "lumi",
        protocol: "openai",
        rawModelId: "gpt-5.4",
      },
      {
        ...base,
        provider: "runpod",
        protocol: "openai",
        rawModelId: "Qwen/Qwen3-32B",
        baseUrl: "https://api.runpod.ai/v2/endpoint_123/openai",
      },
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
            { status: 401 },
          );
        },
      },
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
      expectedUrl: "https://api.openai.com/v1/responses",
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
      name: "RunPod",
      lease: {
        ...lease({ leaseId: "runpod", expiresAtMs: Date.now() + 60_000 }),
        provider: "runpod",
        rawModelId: "Qwen/Qwen3-32B",
        baseUrl: "https://api.runpod.ai/v2/endpoint_123/openai",
      },
      expectedUrl:
        "https://api.runpod.ai/v2/endpoint_123/openai/v1/chat/completions",
      expectedAuthorization: "Bearer provider-secret",
      expectedAnthropicKey: null,
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
        ...lease({
          leaseId: "lumi-openai",
          expiresAtMs: Date.now() + 60_000,
        }),
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
          { status: 401 },
        );
      },
    });

    await assert.rejects(gateway.call({ input: "hello" }), current.name);
    assert.equal(captured?.url, current.expectedUrl, current.name);
    assert.equal(
      captured?.headers.get("authorization") ?? null,
      current.expectedAuthorization,
      current.name,
    );
    assert.equal(
      captured?.headers.get("x-api-key") ?? null,
      current.expectedAnthropicKey,
      current.name,
    );
    assert.equal(captured?.body.model, current.lease.rawModelId, current.name);
  }
});

test("RunPod gateway responses preserve RunPod model provenance", async () => {
  const gateway = createProviderGatewayForLease(
    {
      ...lease({
        leaseId: "runpod-provenance",
        expiresAtMs: Date.now() + 60_000,
      }),
      provider: "runpod",
      protocol: "openai",
      rawModelId: "Qwen/Qwen3-32B",
      baseUrl: "https://api.runpod.ai/v2/endpoint_123/openai",
    },
    {
      fetchImpl: async () =>
        Response.json({
          model: "Qwen/Qwen3-32B",
          choices: [{ message: { content: "ready" } }],
        }),
    },
  );
  const response = await gateway.call<{
    provider: { name: string; model: string };
  }>({ input: "hello" });
  assert.deepEqual(response.provider, {
    name: "runpod",
    model: "Qwen/Qwen3-32B",
    endpoint: "chat",
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
