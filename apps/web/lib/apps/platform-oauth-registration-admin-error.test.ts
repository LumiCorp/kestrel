import test from "node:test";
import assert from "node:assert/strict";
import { GatewayCredentialEncryptionError } from "@/lib/ai/gateway-credential-crypto";
import { getSafePlatformOAuthRegistrationAdminError } from "./platform-oauth-registration-admin-error";

test("OAuth registration admin errors never disclose credential material", () => {
  const secret = "provider-client-secret";
  const result = getSafePlatformOAuthRegistrationAdminError(
    new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_KEYS_INVALID",
      `Invalid keyring ${secret}`,
    ),
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.status, 503);
});
