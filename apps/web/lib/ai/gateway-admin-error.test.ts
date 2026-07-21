import assert from "node:assert/strict";
import { z } from "zod";
import { getSafeGatewayAdminError } from "./gateway-admin-error";
import { GatewayCredentialEncryptionError } from "./gateway-credential-crypto";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "gateway admin errors do not expose database parameters or credential envelopes", () => {
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

contractTest("web.hermetic", "gateway admin errors preserve safe authentication and validation status", () => {
  assert.equal(getSafeGatewayAdminError(new Error("Unauthorized")).status, 401);
  assert.equal(
    getSafeGatewayAdminError(z.object({ id: z.string() }).safeParse({}).error)
      .status,
    400
  );
});

contractTest("web.hermetic", "gateway admin encryption failures expose only a stable code", () => {
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
