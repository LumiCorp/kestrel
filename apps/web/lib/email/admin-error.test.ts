import assert from "node:assert/strict";
import { GatewayCredentialEncryptionError } from "@/lib/ai/gateway-credential-crypto";
import { getSafeEmailAdminError } from "./admin-error";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "email admin errors never expose credential material", () => {
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
