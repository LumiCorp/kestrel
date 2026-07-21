import assert from "node:assert/strict";

import {
  decryptMcpCredential,
  encryptMcpCredential,
  MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV,
  MCP_CREDENTIAL_KEYS_ENV,
} from "@kestrel/mcp-security";

import type { AuthorizedMcpServer } from "../src/contracts.js";
import type { McpCredentialStore } from "../src/credential-store.js";
import { resolveRemoteCredentialHeaders } from "../src/upstream.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("services.hermetic", "expired OAuth credentials refresh inside the MCP service and remain encrypted", async () => {
  const previousActiveKey = process.env[MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV];
  const previousKeys = process.env[MCP_CREDENTIAL_KEYS_ENV];
  process.env[MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV] = "test-key";
  process.env[MCP_CREDENTIAL_KEYS_ENV] = JSON.stringify({
    "test-key": Buffer.alloc(32, 9).toString("base64"),
  });
  const identity = {
    organizationId: "org-1",
    environmentId: "env-1",
    credentialId: "credential-1",
  };
  let persisted:
    | {
        credentialId: string;
        encryptedPayload: string;
        expiresAt: Date | null;
      }
    | undefined;
  const store: McpCredentialStore = {
    async updateRefreshedCredential(input) {
      persisted = input;
    },
    async markRefreshRequired() {
      throw new Error("refresh should succeed");
    },
  };
  const encryptedPayload = encryptMcpCredential({
    ...identity,
    payload: {
      kind: "oauth",
      accessToken: "expired-access-token",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      scopes: ["mcp:tools"],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      tokenEndpoint: "https://auth.example.com/oauth/token",
      resource: "https://mcp.example.com/mcp",
      clientId: "kestrel-one",
      tokenEndpointAuthMethod: "none",
    },
  });
  const server: Extract<AuthorizedMcpServer, { sourceType: "remote" }> = {
    id: "server-1",
    name: "Remote MCP",
    sourceType: "remote",
    transport: "streamable_http",
    remoteUrl: "https://mcp.example.com/mcp",
    launchArguments: [],
    egressAllowlist: [
      "https://mcp.example.com",
      "https://auth.example.com",
    ],
    resources: { cpuMillicores: 500, memoryMib: 512, pidsLimit: 128 },
    credential: {
      id: identity.credentialId,
      kind: "oauth",
      encryptedPayload,
    },
  };

  try {
    const headers = await resolveRemoteCredentialHeaders(
      {
        organizationId: identity.organizationId,
        environmentId: identity.environmentId,
        credentialStore: store,
        createPinnedFetch: async ({ endpoint }) => {
          assert.equal(endpoint.origin, "https://auth.example.com");
          return {
            fetch: async (_request, init) => {
              assert.match(String(init?.body), /grant_type=refresh_token/u);
              assert.match(
                String(init?.body),
                /resource=https%3A%2F%2Fmcp\.example\.com%2Fmcp/u
              );
              assert.doesNotMatch(String(init?.body), /expired-access-token/u);
              return new Response(
                JSON.stringify({
                  access_token: "new-access-token",
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: "mcp:tools mcp:resources",
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }
              );
            },
            close: async () => {},
          };
        },
      },
      server
    );

    assert.deepEqual(headers, {
      authorization: "Bearer new-access-token",
    });
    assert.ok(persisted);
    assert.equal(persisted.encryptedPayload.includes("new-access-token"), false);
    const refreshed = decryptMcpCredential({
      ...identity,
      encrypted: persisted.encryptedPayload,
    });
    assert.equal(refreshed.kind, "oauth");
    assert.equal(refreshed.accessToken, "new-access-token");
    assert.deepEqual(refreshed.scopes, ["mcp:tools", "mcp:resources"]);
  } finally {
    if (previousActiveKey === undefined) {
      delete process.env[MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV];
    } else {
      process.env[MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV] = previousActiveKey;
    }
    if (previousKeys === undefined) {
      delete process.env[MCP_CREDENTIAL_KEYS_ENV];
    } else {
      process.env[MCP_CREDENTIAL_KEYS_ENV] = previousKeys;
    }
  }
});

contractTest("services.hermetic", "rejected OAuth refresh cancels its body before closing the dispatcher", async () => {
  const previousActiveKey = process.env[MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV];
  const previousKeys = process.env[MCP_CREDENTIAL_KEYS_ENV];
  process.env[MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV] = "test-key";
  process.env[MCP_CREDENTIAL_KEYS_ENV] = JSON.stringify({
    "test-key": Buffer.alloc(32, 7).toString("base64"),
  });
  const events: string[] = [];
  const encryptedPayload = encryptMcpCredential({
    organizationId: "org-1",
    environmentId: "env-1",
    credentialId: "credential-1",
    payload: {
      kind: "oauth",
      accessToken: "expired",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      scopes: [],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "kestrel-one",
      tokenEndpointAuthMethod: "none",
    },
  });
  const server: Extract<AuthorizedMcpServer, { sourceType: "remote" }> = {
    id: "server-1",
    name: "Remote MCP",
    sourceType: "remote",
    transport: "streamable_http",
    remoteUrl: "https://mcp.example.com/mcp",
    launchArguments: [],
    egressAllowlist: ["https://mcp.example.com", "https://auth.example.com"],
    resources: { cpuMillicores: 500, memoryMib: 512, pidsLimit: 128 },
    credential: { id: "credential-1", kind: "oauth", encryptedPayload },
  };
  const store: McpCredentialStore = {
    async updateRefreshedCredential() {
      throw new Error("refresh must not be persisted");
    },
    async markRefreshRequired() {
      events.push("marked");
    },
  };

  try {
    await assert.rejects(
      resolveRemoteCredentialHeaders(
        {
          organizationId: "org-1",
          environmentId: "env-1",
          credentialStore: store,
          createPinnedFetch: async () => ({
            fetch: async () =>
              new Response(
                new ReadableStream({
                  cancel() {
                    events.push("cancelled");
                  },
                }),
                { status: 500 }
              ),
            close: async () => {
              events.push("closed");
            },
          }),
        },
        server
      ),
      /refresh failed/u
    );
    assert.deepEqual(events, ["cancelled", "marked", "closed"]);
  } finally {
    if (previousActiveKey === undefined) {
      delete process.env[MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV];
    } else {
      process.env[MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV] = previousActiveKey;
    }
    if (previousKeys === undefined) {
      delete process.env[MCP_CREDENTIAL_KEYS_ENV];
    } else {
      process.env[MCP_CREDENTIAL_KEYS_ENV] = previousKeys;
    }
  }
});
