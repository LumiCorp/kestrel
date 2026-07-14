import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  AppCredentialEncryptionError,
  decryptAppCredential,
  encryptAppCredential,
  isEncryptedAppCredential,
} from "./credential-crypto";

function keyEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID: "test-key",
    KESTREL_APP_CREDENTIAL_KEYS: JSON.stringify({
      "test-key": randomBytes(32).toString("base64"),
    }),
  };
}

const identity = {
  organizationId: "org-1",
  environmentId: "env-1",
  appKey: "tavily",
  credentialId: "credential-1",
};

test("App credentials round trip without exposing plaintext", () => {
  const env = keyEnv();
  const encrypted = encryptAppCredential({
    ...identity,
    env,
    payload: { kind: "api_key", apiKey: "tvly-secret", projectId: "project-1" },
  });
  assert.ok(isEncryptedAppCredential(encrypted));
  assert.ok(!encrypted.includes("tvly-secret"));
  assert.deepEqual(
    decryptAppCredential({ ...identity, env, encrypted }),
    { kind: "api_key", apiKey: "tvly-secret", projectId: "project-1" }
  );
});

test("App credential envelopes are bound to the App identity", () => {
  const env = keyEnv();
  const encrypted = encryptAppCredential({
    ...identity,
    env,
    payload: { kind: "api_key", apiKey: "tvly-secret" },
  });
  assert.throws(
    () =>
      decryptAppCredential({
        ...identity,
        appKey: "another-app",
        env,
        encrypted,
      }),
    (error) =>
      error instanceof AppCredentialEncryptionError &&
      error.code === "APP_CREDENTIAL_DECRYPT_FAILED"
  );
});

test("App credential decrypt rejects plaintext", () => {
  assert.throws(
    () =>
      decryptAppCredential({
        ...identity,
        env: keyEnv(),
        encrypted: "tvly-plaintext",
      }),
    (error) =>
      error instanceof AppCredentialEncryptionError &&
      error.code === "APP_CREDENTIAL_PLAINTEXT_REJECTED"
  );
});

test("App credentials can use the legacy MCP keyring during expansion", () => {
  const key = randomBytes(32).toString("base64");
  const env = {
    NODE_ENV: "test",
    KESTREL_MCP_CREDENTIAL_ACTIVE_KEY_ID: "legacy-key",
    KESTREL_MCP_CREDENTIAL_KEYS: JSON.stringify({ "legacy-key": key }),
  } satisfies NodeJS.ProcessEnv;
  const encrypted = encryptAppCredential({
    ...identity,
    env,
    payload: { kind: "api_key", apiKey: "tvly-secret" },
  });
  assert.equal(
    decryptAppCredential({ ...identity, env, encrypted }).kind,
    "api_key"
  );
});
