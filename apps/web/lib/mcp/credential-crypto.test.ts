import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptMcpCredential,
  encryptMcpCredential,
  isEncryptedMcpCredential,
  MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV,
  MCP_CREDENTIAL_KEYS_ENV,
  McpCredentialEncryptionError,
  mcpCredentialPayloadSchema,
} from "./credential-crypto";

const env = {
  NODE_ENV: "test" as const,
  [MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV]: "key-1",
  [MCP_CREDENTIAL_KEYS_ENV]: JSON.stringify({
    "key-1": Buffer.alloc(32, 7).toString("base64"),
  }),
};

const identity = {
  organizationId: "org-1",
  environmentId: "env-1",
  credentialId: "credential-1",
};

test("MCP OAuth credentials round-trip through an authenticated envelope", () => {
  const encrypted = encryptMcpCredential({
    ...identity,
    payload: {
      kind: "oauth",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      scopes: ["mcp:tools"],
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "kestrel-one",
      tokenEndpointAuthMethod: "none",
    },
    env,
  });
  assert.equal(isEncryptedMcpCredential(encrypted), true);
  assert.equal(encrypted.includes("access-secret"), false);
  assert.deepEqual(decryptMcpCredential({ ...identity, encrypted, env }), {
    kind: "oauth",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    tokenType: "Bearer",
    scopes: ["mcp:tools"],
    tokenEndpoint: "https://auth.example.com/oauth/token",
    clientId: "kestrel-one",
    tokenEndpointAuthMethod: "none",
  });
});

test("MCP credential envelopes are bound to Organization, Environment, and credential", () => {
  const encrypted = encryptMcpCredential({
    ...identity,
    payload: {
      kind: "secret_headers",
      headers: { Authorization: "Bearer upstream-secret" },
    },
    env,
  });
  assert.throws(
    () =>
      decryptMcpCredential({
        ...identity,
        environmentId: "env-2",
        encrypted,
        env,
      }),
    (error) =>
      error instanceof McpCredentialEncryptionError &&
      error.code === "MCP_CREDENTIAL_DECRYPT_FAILED"
  );
});

test("MCP credential reads reject plaintext without reflecting it", () => {
  const plaintext = "raw-upstream-secret";
  assert.throws(
    () => decryptMcpCredential({ ...identity, encrypted: plaintext, env }),
    (error) =>
      error instanceof McpCredentialEncryptionError &&
      error.code === "MCP_CREDENTIAL_PLAINTEXT_REJECTED" &&
      !error.message.includes(plaintext)
  );
});

test("secret headers cannot override transport-owned headers", () => {
  for (const name of [
    "Host",
    "Origin",
    "Content-Length",
    "Mcp-Session-Id",
    "MCP-Protocol-Version",
  ]) {
    assert.equal(
      mcpCredentialPayloadSchema.safeParse({
        kind: "secret_headers",
        headers: { [name]: "attacker-controlled" },
      }).success,
      false,
      name
    );
  }
});
