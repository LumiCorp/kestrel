import assert from "node:assert/strict";
import test from "node:test";

import type {
  McpDiscoveredTool,
  McpStatusSnapshot,
} from "../../src/mcp/contracts.js";
import {
  compileMcpDiscoveredToolV1,
  compileMcpStatusSnapshotV1,
} from "../../src/mcp/toolDescriptor.js";

function discovered(
  overrides: Partial<McpDiscoveredTool> = {},
): McpDiscoveredTool {
  return {
    serverId: "tenant-a.search",
    toolName: "lookup",
    namespacedToolName: "mcp.tenant-a.search.lookup",
    description: "Look up a remote value.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    presentation: {
      displayName: "Remote lookup",
      aliases: ["lookup"],
      keywords: ["search"],
      provider: "tenant-a.search",
      toolFamily: "search",
      capabilityClasses: ["remote.search"],
    },
    ...overrides,
  };
}

test("MCP descriptor compilation is deterministic and bound to exact source identity", () => {
  const first = compileMcpDiscoveredToolV1(discovered());
  const second = compileMcpDiscoveredToolV1(
    discovered({
      inputSchema: {
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } },
        type: "object",
      },
    }),
  );
  assert.ok(first.descriptor);
  assert.equal(first.descriptor?.contractRevision, second.descriptor?.contractRevision);
  assert.equal(first.descriptor?.source.sourceId, "tenant-a.search");
  assert.equal(first.descriptor?.source.protocolTarget, "lookup");

  const otherScope = compileMcpDiscoveredToolV1(
    discovered({
      serverId: "tenant-b.search",
      namespacedToolName: "mcp.tenant-b.search.lookup",
    }),
  );
  assert.notEqual(
    first.descriptor?.contractRevision,
    otherScope.descriptor?.contractRevision,
  );
});

test("MCP uses declared output schema or a fixed opaque protocol envelope", () => {
  const opaque = compileMcpDiscoveredToolV1(discovered());
  const declared = compileMcpDiscoveredToolV1(
    discovered({
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    }),
  );
  assert.ok(opaque.descriptor);
  assert.ok(declared.descriptor);
  assert.notEqual(
    opaque.descriptor?.outputContractHash,
    declared.descriptor?.outputContractHash,
  );
  assert.equal(
    declared.descriptor?.execution.resultNormalizerId,
    "mcp:tool:envelope:v1",
  );
});

test("invalid MCP registrations fail closed without removing valid peers", () => {
  const snapshot: McpStatusSnapshot = {
    healthy: true,
    checkedAt: "2026-08-03T00:00:00.000Z",
    servers: [],
    tools: [
      discovered(),
      discovered({
        toolName: "missing-presentation",
        namespacedToolName: "mcp.tenant-a.search.missing-presentation",
        presentation: undefined,
      }),
      discovered({
        toolName: "invalid-schema",
        namespacedToolName: "mcp.tenant-a.search.invalid-schema",
        inputSchema: {
          type: "object",
          properties: { callback: { type: "string", format: "uri" } },
          additionalProperties: false,
        },
      }),
      discovered({
        toolName: "oversized-schema",
        namespacedToolName: "mcp.tenant-a.search.oversized-schema",
        inputSchema: {
          type: "object",
          description: "x".repeat(256 * 1024),
          additionalProperties: false,
        },
      }),
    ],
  };

  const compiled = compileMcpStatusSnapshotV1(snapshot);
  assert.ok(compiled.tools[0]?.descriptor);
  assert.equal(
    compiled.tools[1]?.registrationError?.code,
    "MCP_TOOL_PRESENTATION_MISSING",
  );
  assert.equal(
    compiled.tools[2]?.registrationError?.code,
    "MCP_TOOL_DESCRIPTOR_INVALID",
  );
  assert.equal(
    compiled.tools[3]?.registrationError?.code,
    "MCP_TOOL_DESCRIPTOR_INVALID",
  );
  assert.equal(compiled.tools.filter((tool) => tool.descriptor).length, 1);
});
