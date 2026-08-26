import test from "node:test";
import assert from "node:assert/strict";
import { McpClientManager } from "../../src/mcp/McpClientManager.js";
import type { McpStatusSnapshot } from "../../src/mcp/contracts.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

test("McpClientManager throws a normalized failure when a tool is unavailable", async () => {
  const manager = new McpClientManager({ servers: [] });

  await assert.rejects(
    manager.callTool("mcp.docs.search", {}),
    (error: unknown) =>
      error instanceof RuntimeFailure &&
      error.code === "MCP_TOOL_UNAVAILABLE" &&
      error.message === "MCP tool 'mcp.docs.search' is not available" &&
      error.details?.namespacedToolName === "mcp.docs.search",
  );
});

test("McpClientManager refresh is transactional, coalesced, and retains pinned clients", async () => {
  const manager = new McpClientManager({ servers: [] });
  const oldClient = fakeMcpClient("v1");
  const newClient = fakeMcpClient("v2");
  const internals = manager as unknown as {
    activateCandidate(
      snapshot: McpStatusSnapshot,
      tools: Map<string, unknown>,
      servers: Map<string, unknown>,
    ): Promise<void>;
    retainActiveAfterRefreshFailure(
      candidate: McpStatusSnapshot,
      code: string,
    ): McpStatusSnapshot;
    buildAndActivateRefresh(): Promise<McpStatusSnapshot>;
  };
  await internals.activateCandidate(
    mcpSnapshot("v1"),
    new Map([["mcp.docs.lookup", toolHandle(oldClient)]]),
    new Map([["docs", { serverId: "docs", client: oldClient }]]),
  );
  const pinned = manager.pinTool("mcp.docs.lookup");
  const retained = internals.retainActiveAfterRefreshFailure(
    { ...mcpSnapshot("broken"), healthy: false },
    "MCP_REFRESH_CANDIDATE_INVALID",
  );
  assert.equal(retained.tools[0]?.description, "Lookup v1");
  assert.equal(
    retained.refreshDiagnostic?.code,
    "MCP_REFRESH_CANDIDATE_INVALID",
  );

  await internals.activateCandidate(
    mcpSnapshot("v2"),
    new Map([["mcp.docs.lookup", toolHandle(newClient)]]),
    new Map([["docs", { serverId: "docs", client: newClient }]]),
  );
  assert.equal(oldClient.closeCalls, 0);
  assert.equal(await pinned.call({}), "v1");
  assert.equal(await manager.callTool("mcp.docs.lookup", {}), "v2");
  await pinned.release();
  assert.equal(oldClient.closeCalls, 1);

  let refreshBuilds = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  internals.buildAndActivateRefresh = async () => {
    refreshBuilds += 1;
    await refreshGate;
    return mcpSnapshot("coalesced");
  };
  const firstRefresh = manager.refresh();
  const secondRefresh = manager.refresh();
  assert.equal(refreshBuilds, 1);
  releaseRefresh();
  assert.deepEqual(await secondRefresh, await firstRefresh);
  await manager.close();
});

test("McpClientManager closes a candidate that fails after connecting", async () => {
  let closeCalls = 0;
  class CandidateClient {
    async connect() {}
    async listTools() {
      throw new Error("candidate discovery failed");
    }
    async close() {
      closeCalls += 1;
    }
  }
  class CandidateTransport {}
  const manager = new McpClientManager({ servers: [] });
  const internals = manager as unknown as {
    connectAndDiscover(
      sdk: Record<string, unknown>,
      server: Record<string, unknown>,
    ): Promise<unknown>;
  };

  await assert.rejects(
    internals.connectAndDiscover(
      {
        ClientCtor: CandidateClient,
        StdioTransportCtor: CandidateTransport,
      },
      {
        id: "candidate",
        transport: "stdio",
        command: "candidate",
        enabled: true,
      },
    ),
    /candidate discovery failed/u,
  );
  assert.equal(closeCalls, 1);
});

function fakeMcpClient(version: string, closeFailures = 0) {
  return {
    closeCalls: 0,
    closeFailures,
    async callTool() {
      return version;
    },
    async close() {
      this.closeCalls += 1;
      if (this.closeFailures > 0) {
        this.closeFailures -= 1;
        throw new Error(`planned ${version} close failure`);
      }
    },
  };
}

function controlledMcpClient(version: string) {
  let signalCloseStarted!: () => void;
  let allowClose!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    signalCloseStarted = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    allowClose = resolve;
  });
  return {
    closeCalls: 0,
    closed: false,
    closeStarted,
    allowClose,
    async callTool() {
      if (this.closed) throw new Error(`called closed ${version} client`);
      return version;
    },
    async close() {
      this.closeCalls += 1;
      signalCloseStarted();
      await closeGate;
      this.closed = true;
    },
  };
}

function toolHandle(client: object) {
  return {
    serverId: "docs",
    toolName: "lookup",
    namespacedToolName: "mcp.docs.lookup",
    client,
    protocolKind: "tool",
    protocolTarget: "lookup",
  };
}

test("McpClientManager retries a failed retired-client release without losing ownership", async () => {
  const manager = new McpClientManager({ servers: [] });
  const oldClient = fakeMcpClient("retired", 1);
  const newClient = fakeMcpClient("active");
  const internals = manager as unknown as {
    activateCandidate(
      snapshot: McpStatusSnapshot,
      tools: Map<string, unknown>,
      servers: Map<string, unknown>,
    ): Promise<void>;
  };
  await internals.activateCandidate(
    mcpSnapshot("retired"),
    new Map([["mcp.docs.lookup", toolHandle(oldClient)]]),
    new Map([["docs", { serverId: "docs", client: oldClient }]]),
  );
  const pinned = manager.pinTool("mcp.docs.lookup");
  await internals.activateCandidate(
    mcpSnapshot("active"),
    new Map([["mcp.docs.lookup", toolHandle(newClient)]]),
    new Map([["docs", { serverId: "docs", client: newClient }]]),
  );

  await assert.rejects(
    () => pinned.release(),
    /planned retired close failure/u,
  );
  assert.equal(oldClient.closeCalls, 1);
  assert.equal(await pinned.call({}), "retired");
  await pinned.release();
  assert.equal(oldClient.closeCalls, 2);
  await pinned.release();
  assert.equal(oldClient.closeCalls, 2);

  await manager.close();
  assert.equal(newClient.closeCalls, 1);
});

test("McpClientManager retries a failed active-provider close and closes once successfully", async () => {
  const manager = new McpClientManager({ servers: [] });
  const client = fakeMcpClient("active-close", 1);
  const internals = manager as unknown as {
    activateCandidate(
      snapshot: McpStatusSnapshot,
      tools: Map<string, unknown>,
      servers: Map<string, unknown>,
    ): Promise<void>;
  };
  await internals.activateCandidate(
    mcpSnapshot("active-close"),
    new Map([["mcp.docs.lookup", toolHandle(client)]]),
    new Map([["docs", { serverId: "docs", client }]]),
  );

  await assert.rejects(
    () => manager.close(),
    /planned active-close close failure/u,
  );
  assert.equal(client.closeCalls, 1);
  await manager.close();
  assert.equal(client.closeCalls, 2);
  await manager.close();
  assert.equal(client.closeCalls, 2);
});

test("McpClientManager rejects retain racing a retired client's final close", async () => {
  const manager = new McpClientManager({ servers: [] });
  const oldClient = controlledMcpClient("retired-race");
  const newClient = fakeMcpClient("active-after-race");
  const internals = manager as unknown as {
    activateCandidate(
      snapshot: McpStatusSnapshot,
      tools: Map<string, unknown>,
      servers: Map<string, unknown>,
    ): Promise<void>;
  };
  await internals.activateCandidate(
    mcpSnapshot("retired-race"),
    new Map([["mcp.docs.lookup", toolHandle(oldClient)]]),
    new Map([["docs", { serverId: "docs", client: oldClient }]]),
  );
  const pinned = manager.pinTool("mcp.docs.lookup");
  await internals.activateCandidate(
    mcpSnapshot("active-after-race"),
    new Map([["mcp.docs.lookup", toolHandle(newClient)]]),
    new Map([["docs", { serverId: "docs", client: newClient }]]),
  );

  const finalRelease = pinned.release();
  await oldClient.closeStarted;
  assert.throws(
    () => pinned.retain(),
    (error: unknown) =>
      error instanceof RuntimeFailure && error.code === "MCP_CLIENT_RETIRED",
  );
  assert.throws(
    () => pinned.call({}),
    (error: unknown) =>
      error instanceof RuntimeFailure && error.code === "MCP_PIN_RELEASED",
  );
  oldClient.allowClose();
  await finalRelease;

  assert.equal(oldClient.closeCalls, 1);
  assert.equal(oldClient.closed, true);
  assert.throws(
    () => pinned.retain(),
    (error: unknown) =>
      error instanceof RuntimeFailure && error.code === "MCP_PIN_RELEASED",
  );
  assert.throws(
    () => pinned.call({}),
    (error: unknown) =>
      error instanceof RuntimeFailure && error.code === "MCP_PIN_RELEASED",
  );
  await manager.close();
  assert.equal(oldClient.closeCalls, 1);
});

test("McpClientManager rejects retain racing manager close and closes exactly once", async () => {
  const manager = new McpClientManager({ servers: [] });
  const client = controlledMcpClient("manager-close-race");
  const internals = manager as unknown as {
    activateCandidate(
      snapshot: McpStatusSnapshot,
      tools: Map<string, unknown>,
      servers: Map<string, unknown>,
    ): Promise<void>;
  };
  await internals.activateCandidate(
    mcpSnapshot("manager-close-race"),
    new Map([["mcp.docs.lookup", toolHandle(client)]]),
    new Map([["docs", { serverId: "docs", client }]]),
  );
  const pinned = manager.pinTool("mcp.docs.lookup");

  const close = manager.close();
  await client.closeStarted;
  assert.throws(
    () => pinned.retain(),
    (error: unknown) =>
      error instanceof RuntimeFailure && error.code === "MCP_CLIENT_RETIRED",
  );
  assert.throws(
    () => pinned.call({}),
    (error: unknown) =>
      error instanceof RuntimeFailure && error.code === "MCP_PIN_RELEASED",
  );
  client.allowClose();
  await close;
  await manager.close();

  assert.equal(client.closeCalls, 1);
  assert.equal(client.closed, true);
});

test("McpClientManager retries failed retirement and closes exactly once successfully", async () => {
  const manager = new McpClientManager({ servers: [] });
  const client = fakeMcpClient("retire-retry", 1);
  const internals = manager as unknown as {
    activateCandidate(
      snapshot: McpStatusSnapshot,
      tools: Map<string, unknown>,
      servers: Map<string, unknown>,
    ): Promise<void>;
  };
  await internals.activateCandidate(
    mcpSnapshot("retire-retry"),
    new Map([["mcp.docs.lookup", toolHandle(client)]]),
    new Map([["docs", { serverId: "docs", client }]]),
  );

  await assert.rejects(
    () => manager.retire(),
    /planned retire-retry close failure/u,
  );
  assert.equal(client.closeCalls, 1);
  await manager.retire();
  await manager.retire();

  assert.equal(client.closeCalls, 2);
});

function mcpSnapshot(version: string): McpStatusSnapshot {
  return {
    healthy: true,
    checkedAt: new Date().toISOString(),
    servers: [],
    tools: [
      {
        serverId: "docs",
        toolName: "lookup",
        namespacedToolName: "mcp.docs.lookup",
        description: `Lookup ${version}`,
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
  };
}

test("McpClientManager assertHealthy throws a normalized failure with unhealthy server details", async () => {
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
});

test("McpClientManager fails closed when an OAuth App has no Local Core provider", async () => {
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
});

test("McpClientManager rejects mixed OAuth and static App credentials before network use", async () => {
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
});
