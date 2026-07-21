import assert from "node:assert/strict";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
  GatewayCredentialEncryptionError,
  isEncryptedGatewayCredential,
} from "./gateway-credential-crypto";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const encryptionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "primary",
  KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
    primary: Buffer.alloc(32, 7).toString("base64"),
    previous: Buffer.alloc(32, 3).toString("base64"),
  }),
};

contractTest("web.hermetic", "gateway credentials round-trip through an authenticated envelope", () => {
  const encrypted = encryptGatewayCredential({
    gatewayId: "gateway-1",
    plaintext: "provider-secret",
    env: encryptionEnv,
  });

  assert.equal(isEncryptedGatewayCredential(encrypted), true);
  assert.equal(encrypted.includes("provider-secret"), false);
  assert.equal(
    decryptGatewayCredential({
      gatewayId: "gateway-1",
      encrypted,
      env: encryptionEnv,
    }),
    "provider-secret"
  );
});

contractTest("web.hermetic", "gateway credential envelopes are bound to their gateway", () => {
  const encrypted = encryptGatewayCredential({
    gatewayId: "gateway-1",
    plaintext: "provider-secret",
    env: encryptionEnv,
  });

  assert.throws(
    () =>
      decryptGatewayCredential({
        gatewayId: "gateway-2",
        encrypted,
        env: encryptionEnv,
      }),
    (error: unknown) =>
      error instanceof GatewayCredentialEncryptionError &&
      error.code === "GATEWAY_CREDENTIAL_DECRYPT_FAILED"
  );
});

contractTest("web.hermetic", "gateway credential runtime reads reject plaintext", () => {
  assert.throws(
    () =>
      decryptGatewayCredential({
        gatewayId: "gateway-1",
        encrypted: "provider-secret",
        env: encryptionEnv,
      }),
    (error: unknown) =>
      error instanceof GatewayCredentialEncryptionError &&
      error.code === "GATEWAY_CREDENTIAL_PLAINTEXT_REJECTED"
  );
});

contractTest("web.hermetic", "gateway credential envelopes fail closed when authentication is changed", () => {
  const encrypted = encryptGatewayCredential({
    gatewayId: "gateway-1",
    plaintext: "provider-secret",
    env: encryptionEnv,
  });
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

  assert.throws(
    () =>
      decryptGatewayCredential({
        gatewayId: "gateway-1",
        encrypted: tampered,
        env: encryptionEnv,
      }),
    GatewayCredentialEncryptionError
  );
});
