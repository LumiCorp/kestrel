import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { getSafeGatewayAdminError } from "./gateway-admin-error";
import { validateOpenRouterModelDetails } from "./model-economics-profile";
import { GatewayCredentialEncryptionError } from "./gateway-credential-crypto";
import {
  GatewayModelEconomicsProfileRequiredError,
  GatewayModelInUseError,
  GatewayModelProviderResolutionError,
} from "./gateway-lifecycle-error";


test("gateway admin errors do not expose database parameters or credential envelopes", () => {
  const secretEnvelope = "kgc:v1:key:iv:tag:ciphertext";
  const result = getSafeGatewayAdminError(
    new Error(`Failed query params: ${secretEnvelope}`)
  );

  assert.deepEqual(result, {
    body: {
      code: "GATEWAY_OPERATION_FAILED",
      error: "Gateway operation failed.",
    },
    status: 500,
  });
  assert.equal(JSON.stringify(result).includes(secretEnvelope), false);
});

test("gateway admin errors preserve safe authentication and validation status", () => {
  assert.equal(getSafeGatewayAdminError(new Error("Unauthorized")).status, 401);
  assert.equal(
    getSafeGatewayAdminError(z.object({ id: z.string() }).safeParse({}).error)
      .status,
    400
  );
});

test("gateway admin encryption failures expose only a stable code", () => {
  const secret = "raw-key-material";
  const result = getSafeGatewayAdminError(
    new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_KEYS_INVALID",
      `Invalid keyring ${secret}`
    )
  );

  assert.equal(result.status, 503);
  assert.equal(result.body.code, "GATEWAY_CREDENTIAL_KEYS_INVALID");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("active model grants expose a stable conflict", () => {
  assert.deepEqual(getSafeGatewayAdminError(new GatewayModelInUseError()), {
    body: {
      code: "GATEWAY_MODEL_IN_USE",
      error: "An active Environment execution is using this gateway model.",
    },
    status: 409,
  });
});

test("missing economics profiles expose actionable approval remediation", () => {
  const result = getSafeGatewayAdminError(
    new GatewayModelEconomicsProfileRequiredError({
      provider: "openrouter",
      model: "opaque-model",
    }),
  );

  assert.deepEqual(result, {
    body: {
      code: "GATEWAY_MODEL_ECONOMICS_PROFILE_REQUIRED",
      error:
        "Cannot approve openrouter/opaque-model because provider capacity metadata is missing. Refresh the provider catalog and try again.",
    },
    status: 422,
  });
});

test("provider route mismatches expose the resolved model without secrets", () => {
  const result = getSafeGatewayAdminError(
    new GatewayModelProviderResolutionError({
      message:
        "OpenRouter resolved 'qwen/alias' to 'qwen/qwen3.8-27b'. Approve the exact returned model ID.",
      resolvedModelId: "qwen/qwen3.8-27b",
    }),
  );

  assert.equal(result.status, 422);
  assert.equal(result.body.code, "GATEWAY_MODEL_PROVIDER_RESOLUTION_FAILED");
  assert.match(result.body.error, /qwen\/qwen3\.8-27b/u);
});

test("provider resolution errors preserve retryability for the admin client", () => {
  const retryable = getSafeGatewayAdminError(
    new GatewayModelProviderResolutionError({
      message: "OpenRouter timed out.",
      status: 503,
      retryable: true,
    }),
  );
  assert.deepEqual(retryable, {
    body: {
      code: "GATEWAY_MODEL_PROVIDER_RESOLUTION_FAILED",
      error: "OpenRouter timed out.",
      retryable: true,
    },
    status: 503,
  });

  const auth = getSafeGatewayAdminError(
    new GatewayModelProviderResolutionError({
      message: "Credential rejected.",
      status: 401,
    }),
  );
  assert.equal(auth.status, 401);
  assert.equal(auth.body.retryable, false);
});

test("OpenRouter detail validation preserves exact route identity", () => {
  assert.equal(
    validateOpenRouterModelDetails({
      requestedModelId: "qwen/qwen3.8-27b",
      response: {
        data: {
          id: "qwen/qwen3.8-27b",
          canonical_slug: "qwen/qwen3.8-27b-20260814",
          context_length: 1_000_000,
          top_provider: {
            context_length: 262_144,
            max_completion_tokens: 131_072,
          },
        },
      },
    }).canonical_slug,
    "qwen/qwen3.8-27b-20260814",
  );
});
