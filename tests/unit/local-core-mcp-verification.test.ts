import assert from "node:assert/strict";
import test from "node:test";

import { MemoryLocalCoreCredentialStore } from "../../src/localCore/credentialStore.js";
import {
  parseLocalCoreMcpVerificationInput,
  verifyAndStoreLocalCoreMcpServer,
} from "../../src/localCore/mcpVerification.js";

test("Local Core verifies MCP with transient candidates before storing them", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  let observedSecret: string | undefined;
  let observedPath: string | undefined;
  let observedAmbientProviderSecret: string | undefined;
  const input = parseLocalCoreMcpVerificationInput({
    server: {
      id: "docs",
      transport: "http",
      url: "https://mcp.example.test",
      enabled: true,
      authTokenEnv: "KESTREL_MCP_DOCS_TOKEN",
    },
    credentials: [{
      credentialId: "mcp.docs.bearer.default",
      envKey: "KESTREL_MCP_DOCS_TOKEN",
      secret: "candidate-token",
    }],
  });
  const result = await verifyAndStoreLocalCoreMcpServer(input, {
    credentialStore: store,
    baseEnv: {
      HOME: "/Users/kestrel",
      PATH: "/usr/bin:/bin",
      OPENAI_API_KEY: "ambient-provider-secret",
      KESTREL_MCP_DOCS_TOKEN: "ambient-mcp-secret",
    },
    environmentOptions: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
    managerFactory(_server, env) {
      observedSecret = env.KESTREL_MCP_DOCS_TOKEN;
      observedPath = env.PATH;
      observedAmbientProviderSecret = env.OPENAI_API_KEY;
      assert.equal(env.HOME, "/Users/kestrel");
      return {
        async refresh() {
          return {
            healthy: true,
            checkedAt: "2026-07-20T12:00:00.000Z",
            servers: [{ serverId: "docs", transport: "http" as const, healthy: true, connected: true, enabled: true, toolCount: 1, checkedAt: "2026-07-20T12:00:00.000Z" }],
            tools: [{ serverId: "docs", toolName: "search", namespacedToolName: "mcp.docs.search", description: "Search docs", inputSchema: {}, protocolKind: "tool" as const }],
          };
        },
        async close() {},
      };
    },
  });

  assert.equal(observedSecret, "candidate-token");
  assert.equal(observedPath, "/opt/homebrew/bin:/usr/bin:/bin");
  assert.equal(observedAmbientProviderSecret, undefined);
  assert.equal(await store.get("mcp.docs.bearer.default"), "candidate-token");
  assert.deepEqual(result.credentials, [{ credentialId: "mcp.docs.bearer.default", configured: true }]);
  assert.equal(JSON.stringify(result).includes("candidate-token"), false);
});

test("Local Core keeps the previous MCP credential when candidate verification fails", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("mcp.docs.bearer.default", "working-token");
  await assert.rejects(
    verifyAndStoreLocalCoreMcpServer(parseLocalCoreMcpVerificationInput({
      server: { id: "docs", transport: "http", url: "https://mcp.example.test", enabled: true, authTokenEnv: "KESTREL_MCP_DOCS_TOKEN" },
      credentials: [{ credentialId: "mcp.docs.bearer.default", envKey: "KESTREL_MCP_DOCS_TOKEN", secret: "bad-token" }],
    }), {
      credentialStore: store,
      managerFactory() {
        return {
          async refresh() {
            return { healthy: false, checkedAt: new Date().toISOString(), servers: [{ serverId: "docs", transport: "http" as const, healthy: false, connected: false, enabled: true, toolCount: 0, checkedAt: new Date().toISOString(), error: "unauthorized" }], tools: [] };
          },
          async close() {},
        };
      },
    }),
    /unauthorized/u,
  );
  assert.equal(await store.get("mcp.docs.bearer.default"), "working-token");
});

test("Local Core rejects remote authentication without an owned credential binding", () => {
  assert.throws(
    () => parseLocalCoreMcpVerificationInput({
      server: { id: "docs", transport: "http", url: "https://mcp.example.test", enabled: true, authTokenEnv: "UNBOUND_TOKEN" },
      credentials: [],
    }),
    /must have a credential binding/u,
  );
});
