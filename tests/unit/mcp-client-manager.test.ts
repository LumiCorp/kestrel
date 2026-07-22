import assert from "node:assert/strict";

import { McpClientManager } from "../../src/mcp/McpClientManager.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest(
  "runtime.hermetic",
  "McpClientManager throws a normalized failure when a tool is unavailable",
  async () => {
    const manager = new McpClientManager({ servers: [] });

    await assert.rejects(
      manager.callTool("mcp.docs.search", {}),
      (error: unknown) =>
        error instanceof RuntimeFailure &&
        error.code === "MCP_TOOL_UNAVAILABLE" &&
        error.message === "MCP tool 'mcp.docs.search' is not available" &&
        error.details?.namespacedToolName === "mcp.docs.search",
    );
  },
);

contractTest(
  "runtime.hermetic",
  "McpClientManager assertHealthy throws a normalized failure with unhealthy server details",
  async () => {
    const manager = new McpClientManager({ servers: [] });
    (manager as unknown as Record<string, unknown>).snapshot = {
      healthy: false,
      checkedAt: "2026-03-16T12:00:00.000Z",
      servers: [
        {
          serverId: "docs",
          enabled: true,
          healthy: false,
          error: "connection refused",
        },
      ],
      tools: [],
    };

    await assert.rejects(
      manager.assertHealthy(),
      (error: unknown) =>
        error instanceof RuntimeFailure &&
        error.code === "MCP_PRECHECK_FAILED" &&
        error.message ===
          "MCP preflight failed for server(s): docs(connection refused)" &&
        Array.isArray(error.details?.unhealthyServers),
    );
  },
);

contractTest(
  "runtime.hermetic",
  "McpClientManager fails closed when an OAuth App has no Local Core provider",
  async () => {
    const manager = new McpClientManager({
      servers: [
        {
          id: "notion",
          transport: "http",
          url: "https://mcp.notion.com/mcp",
          enabled: true,
          oauthCredentialPrefix: "mcp.standard.notion",
        },
      ],
    });

    const snapshot = await manager.refresh();
    assert.equal(snapshot.servers[0]?.healthy, false);
    assert.match(
      snapshot.servers[0]?.error ?? "",
      /Secure App authorization is unavailable/u,
    );
  },
);

contractTest(
  "runtime.hermetic",
  "McpClientManager rejects mixed OAuth and static App credentials before network use",
  async () => {
    let providerCalls = 0;
    const manager = new McpClientManager({
      servers: [
        {
          id: "notion",
          transport: "http",
          url: "https://mcp.notion.com/mcp",
          enabled: true,
          authTokenEnv: "NOTION_TOKEN",
          oauthCredentialPrefix: "mcp.standard.notion",
        },
      ],
      env: { NOTION_TOKEN: "must-not-be-used" },
      oauthProviderFactory() {
        providerCalls += 1;
        return undefined;
      },
      fetchImpl: async () => {
        throw new Error("network must not be used");
      },
    });

    const snapshot = await manager.refresh();
    assert.equal(snapshot.servers[0]?.healthy, false);
    assert.match(
      snapshot.servers[0]?.error ?? "",
      /cannot combine App authorization/u,
    );
    assert.equal(providerCalls, 0);
  },
);
