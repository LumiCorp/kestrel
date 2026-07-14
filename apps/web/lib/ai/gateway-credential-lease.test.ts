import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGatewayCredentialLeaseEligible,
  authorizeGatewayCredentialBroker,
  buildGatewayCredentialLease,
  GATEWAY_CREDENTIAL_LEASE_TTL_MS,
  GatewayCredentialLeaseError,
} from "./gateway-credential-lease-contract";

test("credential broker authentication uses a dedicated bearer token", () => {
  assert.doesNotThrow(() =>
    authorizeGatewayCredentialBroker({
      authorization: "Bearer broker-secret",
      expectedToken: "broker-secret",
    })
  );
  assert.throws(
    () =>
      authorizeGatewayCredentialBroker({
        authorization: "Bearer tool-secret",
        expectedToken: "broker-secret",
      }),
    (error: unknown) =>
      error instanceof GatewayCredentialLeaseError && error.status === 401
  );
});

test("credential lease eligibility rejects disabled and unapproved gateway models", () => {
  const approved = {
    gateway: { enabled: true, provider: "openai" as const },
    model: { approved: true, modality: "language" },
  };
  assert.doesNotThrow(() => assertGatewayCredentialLeaseEligible(approved));
  for (const rejected of [
    {
      ...approved,
      gateway: { ...approved.gateway, enabled: false },
    },
    {
      ...approved,
      model: { ...approved.model, approved: false },
    },
    {
      ...approved,
      model: { ...approved.model, modality: "image" },
    },
    {
      ...approved,
      gateway: { enabled: true, provider: "replicate" as const },
    },
  ]) {
    assert.throws(
      () => assertGatewayCredentialLeaseEligible(rejected),
      (error: unknown) =>
        error instanceof GatewayCredentialLeaseError && error.status === 404
    );
  }
});

test("gateway leases expire after exactly five minutes", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");
  const lease = buildGatewayCredentialLease({
    organizationId: "org-1",
    gateway: {
      id: "gateway-openrouter",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    model: { rawModelId: "openai/gpt-5.4", metadata: null },
    apiKey: "provider-secret",
    now,
  });

  assert.equal(
    Date.parse(lease.expiresAt) - now.getTime(),
    GATEWAY_CREDENTIAL_LEASE_TTL_MS
  );
  assert.equal(lease.baseUrl, "https://openrouter.ai");
  assert.equal(lease.apiKey, "provider-secret");
});

test("Lumi leases preserve their configured language protocol", () => {
  const lease = buildGatewayCredentialLease({
    organizationId: "org-1",
    gateway: {
      id: "gateway-lumi",
      provider: "lumi",
      baseUrl: "https://api.kestrelagents.dev/v1",
    },
    model: {
      rawModelId: "claude-sonnet",
      metadata: { protocol: "anthropic" },
    },
    apiKey: "provider-secret",
    now: new Date("2026-07-11T12:00:00.000Z"),
  });

  assert.equal(lease.protocol, "anthropic");
  assert.equal(lease.baseUrl, "https://api.kestrelagents.dev");
});

test("credential leases fail closed when a provider key is missing", () => {
  assert.throws(
    () =>
      buildGatewayCredentialLease({
        organizationId: "org-1",
        gateway: {
          id: "gateway-openai",
          provider: "openai",
          baseUrl: null,
        },
        model: { rawModelId: "gpt-5.4", metadata: null },
        apiKey: null,
        now: new Date(),
      }),
    (error: unknown) =>
      error instanceof GatewayCredentialLeaseError &&
      error.code === "GATEWAY_CREDENTIAL_MISSING"
  );
});

test("validated RunPod models lease the OpenAI protocol and canonical endpoint", () => {
  const lease = buildGatewayCredentialLease({
    organizationId: "org-1",
    gateway: {
      id: "gateway-runpod",
      provider: "runpod",
      baseUrl: "https://api.runpod.ai/v2/endpoint_123/openai/v1",
    },
    model: {
      rawModelId: "Qwen/Qwen3-32B",
      metadata: {
        kestrelRunPodValidation: {
          version: "runpod-tool-round-trip-v2",
          streaming: true,
          toolRoundTrip: true,
          rawModelId: "Qwen/Qwen3-32B",
          baseUrl: "https://api.runpod.ai/v2/endpoint_123/openai/v1",
          validatedAt: "2026-07-12T12:00:00.000Z",
        },
      },
    },
    apiKey: "runpod-secret",
    now: new Date("2026-07-12T12:00:00.000Z"),
  });
  assert.equal(lease.provider, "runpod");
  assert.equal(lease.protocol, "openai");
  assert.equal(lease.baseUrl, "https://api.runpod.ai/v2/endpoint_123/openai");
});

test("RunPod lease eligibility requires server-owned validation evidence", () => {
  assert.throws(
    () =>
      assertGatewayCredentialLeaseEligible({
        gateway: { enabled: true, provider: "runpod" },
        model: { approved: true, modality: "language", metadata: null },
      }),
    (error: unknown) =>
      error instanceof GatewayCredentialLeaseError &&
      error.code === "GATEWAY_MODEL_NOT_VALIDATED"
  );
});

test("RunPod lease eligibility binds validation to model and endpoint", () => {
  const input = {
    gateway: {
      enabled: true,
      provider: "runpod" as const,
      baseUrl: "https://api.runpod.ai/v2/endpoint_123/openai/v1",
    },
    model: {
      approved: true,
      modality: "language",
      rawModelId: "Qwen/Qwen3-32B",
      metadata: {
        kestrelRunPodValidation: {
          version: "runpod-tool-round-trip-v2",
          streaming: true,
          toolRoundTrip: true,
          rawModelId: "Qwen/Qwen3-32B",
          baseUrl: "https://api.runpod.ai/v2/endpoint_123/openai/v1",
          validatedAt: "2026-07-12T12:00:00.000Z",
        },
      },
    },
  };
  assert.doesNotThrow(() => assertGatewayCredentialLeaseEligible(input));
  for (const changed of [
    { ...input, model: { ...input.model, rawModelId: "other-model" } },
    {
      ...input,
      gateway: {
        ...input.gateway,
        baseUrl: "https://api.runpod.ai/v2/other-endpoint/openai/v1",
      },
    },
  ]) {
    assert.throws(
      () => assertGatewayCredentialLeaseEligible(changed),
      (error: unknown) =>
        error instanceof GatewayCredentialLeaseError &&
        error.code === "GATEWAY_MODEL_NOT_VALIDATED"
    );
  }
});
