import assert from "node:assert/strict";
import test from "node:test";
import { GatewayCredentialEncryptionError } from "@/lib/ai/gateway-credential-crypto";
import { getSafeEmailAdminError } from "./admin-error";

test("email admin errors never expose credential material", () => {
  const secret = "re_super_secret";
  const result = getSafeEmailAdminError(
    new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_KEYS_INVALID",
      `Invalid keyring ${secret}`
    )
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.status, 503);
});
