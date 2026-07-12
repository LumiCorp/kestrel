import assert from "node:assert/strict";
import test from "node:test";
import { encryptGatewayCredential } from "./gateway-credential-crypto";
import {
  getGatewayCredentialAuthorityHealth,
  getGatewayCredentialStorageHealth,
} from "./gateway-credential-readiness";

test("gateway credential authority readiness requires broker and encryption configuration", () => {
  assert.deepEqual(getGatewayCredentialAuthorityHealth({ NODE_ENV: "test" }), {
    ok: false,
    code: "GATEWAY_CREDENTIAL_BROKER_NOT_CONFIGURED",
  });
  assert.deepEqual(
    getGatewayCredentialAuthorityHealth({
      NODE_ENV: "test",
      KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "broker-token",
      KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "primary",
      KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
        primary: Buffer.alloc(32, 5).toString("base64"),
      }),
    }),
    { ok: true, code: null }
  );
});

test("gateway credential storage readiness proves the encrypted-only cutover", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({
      primary: Buffer.alloc(32, 5).toString("base64"),
    }),
  };
  const encrypted = encryptGatewayCredential({
    gatewayId: "gateway-1",
    plaintext: "provider-secret",
    env,
  });

  assert.deepEqual(
    getGatewayCredentialStorageHealth(
      [{ id: "gateway-1", apiKey: encrypted, apiKeyEnvVar: null }],
      env
    ),
    { ok: true, code: null }
  );
  assert.deepEqual(
    getGatewayCredentialStorageHealth(
      [
        {
          id: "gateway-1",
          apiKey: encrypted,
          apiKeyEnvVar: "OPENAI_API_KEY",
        },
      ],
      env
    ),
    { ok: false, code: "GATEWAY_CREDENTIAL_SOURCE_NOT_CUT_OVER" }
  );
  assert.deepEqual(
    getGatewayCredentialStorageHealth(
      [{ id: "gateway-1", apiKey: "plaintext", apiKeyEnvVar: null }],
      env
    ),
    { ok: false, code: "GATEWAY_CREDENTIAL_PLAINTEXT_REJECTED" }
  );
});
