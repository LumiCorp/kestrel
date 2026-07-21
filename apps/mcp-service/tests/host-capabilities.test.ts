import assert from "node:assert/strict";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AuthorizedMcpGrant } from "../src/contracts.js";

import {
  buildRemoteWorkspaceRoot,
  createMcpHostClient,
} from "../src/host-capabilities.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("services.hermetic", "MCP host exposes only the current run workspace root", async () => {
  const root = buildRemoteWorkspaceRoot({
    organizationId: "org-1",
    projectId: "project-1",
    threadId: "thread-1",
  });
  const client = createMcpHostClient({
    name: "root-test",
    authorizedHostCapabilities: ["root"],
    roots: [root],
  });
  const server = new Server(
    { name: "root-requester", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const listed = await server.listRoots();
  assert.deepEqual(listed.roots, [root]);
  assert.equal(listed.roots[0]?.uri, "file:///workspace");
  assert.equal(listed.roots[0]?.name?.includes("thread-1"), false);
  assert.equal(listed.roots[0]?.name?.includes("project-1"), true);

  await server.close();
  await client.close();
});

contractTest("services.hermetic", "MCP host routes sampling and elicitation through the durable coordinator", async () => {
  const kinds: string[] = [];
  const grant = {
    id: "grant-1",
    capabilities: [],
  } as unknown as AuthorizedMcpGrant;
  const client = createMcpHostClient({
    name: "interaction-test",
    authorizedHostCapabilities: ["sampling", "elicitation"],
    interactions: {
      grant,
      serverId: "server-1",
      coordinator: {
        async request(input) {
          kinds.push(input.kind);
          return input.kind === "sampling"
            ? Array.isArray(
                (input.request as { tools?: unknown[] | undefined }).tools,
              )
              ? {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      name: "lookup",
                      id: "tool-call-1",
                      input: { query: "safe" },
                    },
                  ],
                  model: "test-model",
                  stopReason: "toolUse",
                }
              : {
                  role: "assistant",
                  content: { type: "text", text: "sampled" },
                  model: "test-model",
                  stopReason: "endTurn",
                }
            : { action: "accept", content: { answer: "yes" } };
        },
      },
    },
  });
  const server = new Server(
    { name: "interaction-requester", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const sample = await server.createMessage({
    messages: [
      { role: "user", content: { type: "text", text: "sample this" } },
    ],
    maxTokens: 100,
  });
  const elicited = await server.elicitInput({
    mode: "form",
    message: "Answer",
    requestedSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
    },
  });
  const sampledTool = await server.createMessage({
    messages: [{ role: "user", content: { type: "text", text: "use a tool" } }],
    maxTokens: 100,
    tools: [
      {
        name: "lookup",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });

  assert.equal(sample.content.type, "text");
  assert.equal(elicited.action, "accept");
  assert.equal(Array.isArray(sampledTool.content), true);
  assert.deepEqual(kinds, ["sampling", "elicitation", "sampling"]);

  await server.close();
  await client.close();
});

contractTest("services.hermetic", "MCP host does not advertise ungranted host capabilities", async () => {
  const client = createMcpHostClient({
    name: "ungranted-test",
    roots: [{ uri: "file:///workspace", name: "Workspace" }],
  });
  const server = new Server(
    { name: "ungranted-requester", version: "1.0.0" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  assert.deepEqual(server.getClientCapabilities(), {});
  await server.close();
  await client.close();
});
