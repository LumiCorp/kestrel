import assert from "node:assert/strict";
import test from "node:test";
import {
  GatewayModelSyncHttpError,
  initialGatewayCredentialStatus,
  isGatewayCredentialReadyForRuntime,
  isGatewayModelSyncAuthenticationFailure,
  shouldInvalidateGatewayCredential,
} from "./gateway-credential-health";

test("new credential health starts unverified except for Ollama", () => {
  assert.equal(initialGatewayCredentialStatus("openai"), "unverified");
  assert.equal(initialGatewayCredentialStatus("ollama"), "not_required");
});

test("runtime readiness requires a validated credential", () => {
  assert.equal(
    isGatewayCredentialReadyForRuntime({
      provider: "openai",
      credentialStatus: "ready",
      credentialValidatedAt: "2026-08-12T12:00:00.000Z",
      hasRequiredCredential: true,
    }),
    true,
  );
  for (const credentialStatus of ["unverified", "invalid"] as const) {
    assert.equal(
      isGatewayCredentialReadyForRuntime({
        provider: "openai",
        credentialStatus,
        credentialValidatedAt: null,
        hasRequiredCredential: true,
      }),
      false,
    );
  }
  assert.equal(
    isGatewayCredentialReadyForRuntime({
      provider: "ollama",
      credentialStatus: "not_required",
      credentialValidatedAt: null,
      hasRequiredCredential: false,
    }),
    true,
  );
});

test("only an exact auth failure for the leased revision invalidates", () => {
  assert.equal(
    shouldInvalidateGatewayCredential({
      failureCode: "MODEL_AUTH_ERROR",
      grantCredentialRevision: 4,
      gatewayCredentialRevision: 4,
    }),
    true,
  );
  for (const input of [
    {
      failureCode: "MODEL_RATE_LIMITED",
      grantCredentialRevision: 4,
      gatewayCredentialRevision: 4,
    },
    {
      failureCode: "MODEL_AUTH_ERROR",
      grantCredentialRevision: 4,
      gatewayCredentialRevision: 5,
    },
    {
      failureCode: "MODEL_AUTH_ERROR",
      grantCredentialRevision: null,
      gatewayCredentialRevision: 4,
    },
  ]) {
    assert.equal(shouldInvalidateGatewayCredential(input), false);
  }
});

test("only provider 401 and 403 sync responses are authentication failures", () => {
  assert.equal(
    isGatewayModelSyncAuthenticationFailure(new GatewayModelSyncHttpError(401)),
    true,
  );
  assert.equal(
    isGatewayModelSyncAuthenticationFailure(new GatewayModelSyncHttpError(403)),
    true,
  );
  assert.equal(
    isGatewayModelSyncAuthenticationFailure(new GatewayModelSyncHttpError(429)),
    false,
  );
  assert.equal(
    isGatewayModelSyncAuthenticationFailure(new GatewayModelSyncHttpError(503)),
    false,
  );
});
