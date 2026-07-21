import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { UnifiedToolRegistry } from "../../tools/runtime/UnifiedToolRegistry.js";
import { contractTest } from "../helpers/contract-test.js";


const GRANT_ID = "018f1f73-4ce2-7b0f-8e14-3b977e1577a5";

contractTest("runtime.process", "hosted MCP tools are scoped to a run grant and use only gateway authorization", async () => {
  const seenHeaders: IncomingMessage["headers"][] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (request, response) => {
    seenHeaders.push(request.headers);
    const sessionId = readHeader(request.headers["mcp-session-id"]);
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => "hosted-session-1",
        onsessioninitialized: (initializedId) => {
          sessions.set(initializedId, transport!);
        },
      });
      const mcpServer = new Server(
        { name: "hosted-test", version: "1.0.0" },
        { capabilities: { tools: {}, resources: {}, prompts: {} } }
      );
      mcpServer.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
          {
            name: "github.issues.list",
            description: "List approved issues",
            inputSchema: { type: "object" },
            _meta: { "kestrel/approvalMode": "auto" },
          },
        ],
      }));
      mcpServer.setRequestHandler(CallToolRequestSchema, (request) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(request.params.arguments ?? {}),
          },
        ],
      }));
      mcpServer.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: [
          { uri: "file:///workspace/README.md", name: "README", _meta: { "kestrel/approvalMode": "auto" } },
          { uri: "file:___workspace_README.md", name: "README alias", _meta: { "kestrel/approvalMode": "auto" } },
        ],
      }));
      mcpServer.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
        resourceTemplates: [],
      }));
      mcpServer.setRequestHandler(ReadResourceRequestSchema, (request) => ({
        contents: [{ uri: request.params.uri, text: "resource body" }],
      }));
      mcpServer.setRequestHandler(ListPromptsRequestSchema, () => ({
        prompts: [{ name: "review", description: "Review a file", arguments: [{ name: "path", required: true }], _meta: { "kestrel/approvalMode": "auto" } }],
      }));
      mcpServer.setRequestHandler(GetPromptRequestSchema, (request) => ({
        description: "review",
        messages: [{ role: "user", content: { type: "text", text: `Review ${request.params.arguments?.path}` } }],
      }));
      await mcpServer.connect(
        transport as Parameters<typeof mcpServer.connect>[0]
      );
    }
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const turn = {
    mcpContext: {
      gatewayUrl: `http://127.0.0.1:${address.port}`,
      grantId: GRANT_ID,
      protocolVersion: "2025-11-25" as const,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-1",
    },
    mcpAuthorization: { executionTicket: "signed-run-ticket" },
  };
  const registry = new UnifiedToolRegistry({ allowlist: [] });

  try {
    const runtimeStatus = await registry.refreshForRuntimeTurn(turn);
    assert.equal(
      runtimeStatus.healthy,
      true,
      JSON.stringify(runtimeStatus.providers.mcp)
    );
    const mcpStatus = runtimeStatus.providers.mcp as {
      tools: Array<{
        namespacedToolName: string;
        presentation?: unknown;
        protocolKind?: string;
      }>;
    };
    assert.equal(mcpStatus.tools.length, 4, JSON.stringify(mcpStatus));
    assert.ok(mcpStatus.tools[0]?.presentation, JSON.stringify(mcpStatus));
    const allowlist = registry.resolveAvailableAllowlistForRuntimeTurn(
      [],
      turn,
      { includeGrantedMcpTools: true }
    );
    assert.equal(allowlist.includes("github.issues.list"), true);
    const resourceTools = mcpStatus.tools.filter(
      (tool) => tool.protocolKind === "resource"
    ).map((tool) => tool.namespacedToolName);
    const resourceTool = resourceTools[0];
    const promptTool = mcpStatus.tools.find(
      (tool) => tool.protocolKind === "prompt"
    )?.namespacedToolName;
    assert.ok(resourceTool);
    assert.equal(new Set(resourceTools).size, 2);
    assert.match(resourceTool, /^mcp\.resource\..+\.[0-9a-f]{16}$/u);
    assert.ok(promptTool);

    const runContext = {
      runId: "run-1",
      sessionId: "session-1",
      payload: {
        mcpContext: turn.mcpContext,
        orchestration: {
          runtimeAssembly: { toolAllowlist: allowlist },
        },
      },
      sessionState: {},
    };
    assert.deepEqual(
      registry.getModelTools({ runContext }).map((tool) => tool.name),
      allowlist
    );
    assert.deepEqual(
      registry.getCapabilityManifest({ runContext })[0]?.approvalCapabilities,
      []
    );
    const result = await registry.call(
      "github.issues.list",
      { state: "open" },
      { runContext }
    );
    assert.equal(result.status, "OK");
    assert.equal((await registry.call(resourceTool, {}, { runContext })).status, "OK");
    assert.equal((await registry.call(promptTool, { path: "README.md" }, { runContext })).status, "OK");
    assert.ok(seenHeaders.length >= 2);
    for (const headers of seenHeaders) {
      assert.equal(headers.authorization, "Bearer signed-run-ticket");
      assert.equal(headers["x-kestrel-mcp-grant-id"], GRANT_ID);
      assert.equal(headers["x-api-key"], undefined);
    }
  } finally {
    await registry.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function readHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
