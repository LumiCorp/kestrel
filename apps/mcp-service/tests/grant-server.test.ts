import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthorizedMcpGrant } from "../src/contracts.js";
import { createGrantMcpServer } from "../src/grant-server.js";
import type {
  InvocationAudit,
  InvocationIdentity,
} from "../src/invocation-audit.js";
import type { McpUpstreamProvider } from "../src/upstream.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("services.hermetic", "grant MCP server exposes namespaced tools and proxies authorized calls", async () => {
  const calls: unknown[] = [];
  const audited: InvocationIdentity[] = [];
  const upstreams: McpUpstreamProvider = {
    async get(serverId) {
      assert.equal(serverId, "server-1");
      return {
        async callTool(params) {
          calls.push(params);
          return { content: [{ type: "text", text: "two issues" }] };
        },
        async readResource() {
          throw new Error("not used");
        },
        async getPrompt() {
          throw new Error("not used");
        },
        async close() {},
      };
    },
  };
  const audit: InvocationAudit = {
    async execute(identity, operation) {
      audited.push(identity);
      return operation();
    },
    async markWaitingApproval() {
      throw new Error("not used");
    },
  };
  const grant = makeGrant("auto");
  const server = createGrantMcpServer({ grant, upstreams, audit });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["github.issues.list"]
  );
  assert.equal(listed.tools[0]?._meta?.["kestrel/approvalMode"], "auto");
  const result = await client.callTool({
    name: "github.issues.list",
    arguments: { state: "open" },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "two issues" }]);
  assert.deepEqual(calls, [
    { name: "issues_list", arguments: { state: "open" } },
  ]);
  assert.equal(audited[0]?.capabilityId, "capability-1");
  assert.equal(audited[0]?.method, "tools/call");

  await client.close();
  await server.close();
});

contractTest("services.hermetic", "ask-mode MCP capabilities persist a wait before rejecting execution", async () => {
  let upstreamRequested = false;
  let waitingIdentity: InvocationIdentity | undefined;
  const upstreams: McpUpstreamProvider = {
    async get() {
      upstreamRequested = true;
      throw new Error("must not connect before approval");
    },
  };
  const audit: InvocationAudit = {
    async execute(_identity, operation) {
      return operation();
    },
    async markWaitingApproval(identity) {
      waitingIdentity = identity;
      return "invocation-approval-1";
    },
  };
  const server = createGrantMcpServer({
    grant: makeGrant("ask"),
    upstreams,
    audit,
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  await assert.rejects(
    client.callTool({ name: "github.issues.list", arguments: {} }),
    /requires explicit approval/u
  );
  assert.equal(upstreamRequested, false);
  assert.equal(waitingIdentity?.capabilityId, "capability-1");

  await client.close();
  await server.close();
});

contractTest("services.hermetic", "ask-mode MCP capabilities execute after a persisted Thread approval", async () => {
  let executed = false;
  const upstreams: McpUpstreamProvider = {
    async get() {
      return {
        async callTool() {
          executed = true;
          return { content: [{ type: "text", text: "approved" }] };
        },
        async readResource() {
          throw new Error("not used");
        },
        async getPrompt() {
          throw new Error("not used");
        },
        async close() {},
      };
    },
  };
  const audit: InvocationAudit = {
    async execute(_identity, operation) {
      return operation();
    },
    async markWaitingApproval() {
      throw new Error("approved invocations must not wait again");
    },
  };
  const server = createGrantMcpServer({
    grant: makeGrant("ask"),
    upstreams,
    audit,
    approvalAuthorizer: { async isApproved() { return true; } },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const listed = await client.listTools();
  assert.equal(listed.tools[0]?._meta?.["kestrel/approvalMode"], "ask");
  await client.callTool({ name: "github.issues.list", arguments: {} });
  assert.equal(executed, true);

  await client.close();
  await server.close();
});

function makeGrant(approvalMode: "auto" | "ask"): AuthorizedMcpGrant {
  return {
    id: "018f1f73-4ce2-7b0f-8e14-3b977e1577a5",
    runExecutionId: "run-1",
    workspaceId: "workspace-1",
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
    policyDigest: "sha256:policy",
    expiresAt: new Date(Date.now() + 300_000),
    capabilities: [
      {
        id: "capability-1",
        kind: "tool",
        capabilityKey: "github.issues.list",
        toolCapabilityKey: "github.issues.list",
        approvalMode,
        definition: {
          name: "issues_list",
          description: "List issues",
          inputSchema: { type: "object" },
        },
        serverId: "server-1",
      },
    ],
    servers: [
      {
        id: "server-1",
        name: "GitHub",
        sourceType: "remote",
        transport: "streamable_http",
        remoteUrl: "https://mcp.example.com/mcp",
        launchArguments: [],
        egressAllowlist: ["https://mcp.example.com"],
        resources: { cpuMillicores: 500, memoryMib: 512, pidsLimit: 128 },
        credential: undefined,
      },
    ],
  };
}
