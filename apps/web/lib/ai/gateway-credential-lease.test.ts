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
