import assert from "node:assert/strict";
import test from "node:test";

import { resolveToolProviderDescriptorRefs } from "../../apps/web/lib/tools/registry.js";
import {
  AllowlistedToolGateway,
  createEmbeddedToolModuleV1,
} from "../../src/io/ToolGateway.js";
import {
  TOOL_SCHEMA_LIMITS_V1,
  createToolDescriptorV1,
  hashCanonical,
  type ToolDescriptorAuthoringV1,
  type ToolDescriptorV1,
} from "../../src/kestrel/contracts/tool-contract.js";
import {
  compileToolRegistryV1,
  type ToolRegistrySourceAdapterV1,
} from "../../src/kestrel/contracts/tool-registry.js";
import { McpClientManager } from "../../src/mcp/McpClientManager.js";
import type { McpStatusSnapshot } from "../../src/mcp/contracts.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import {
  type McpToolProvider,
  UnifiedToolRegistry,
} from "../../tools/runtime/UnifiedToolRegistry.js";
import {
  executeTestToolCall,
  prepareTestToolCall,
} from "../helpers/createTestToolGateway.js";

test("chaos rejects malformed and oversized discovered schemas", () => {
  assert.throws(
    () => createToolDescriptorV1(authoring({ inputSchema: { $ref: "remote" } })),
    /unknown field '\$ref'/u,
  );
  assert.throws(
    () => createToolDescriptorV1(authoring({
      inputSchema: {
        type: "object",
        description: "x".repeat(TOOL_SCHEMA_LIMITS_V1.maxBytes),
        additionalProperties: false,
      },
    })),
    /exceeds 262144 bytes/u,
  );
});

test("chaos retains the active MCP generation when a refresh candidate loses its server", async () => {
  const manager = new McpClientManager({ servers: [] });
  const client = {
    closeCalls: 0,
    async callTool() { return "active"; },
    async close() { this.closeCalls += 1; },
  };
  const activeSnapshot = mcpSnapshot("active");
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
  };
  await internals.activateCandidate(
    activeSnapshot,
    new Map([["mcp.chaos.lookup", {
      serverId: "chaos",
      toolName: "lookup",
      namespacedToolName: "mcp.chaos.lookup",
      client,
      protocolKind: "tool",
      protocolTarget: "lookup",
    }]]),
    new Map([["chaos", { serverId: "chaos", client }]]),
  );

  const retained = internals.retainActiveAfterRefreshFailure(
    {
      ...mcpSnapshot("unavailable"),
      healthy: false,
      servers: [{
        serverId: "chaos",
        transport: "stdio",
        enabled: true,
        healthy: false,
        connected: false,
        toolCount: 0,
        checkedAt: "2026-08-03T00:00:00.000Z",
        error: "lost",
      }],
    },
    "MCP_REFRESH_CANDIDATE_INVALID",
  );
  assert.equal(retained.tools[0]?.description, "Lookup active");
  assert.equal(retained.refreshDiagnostic?.code, "MCP_REFRESH_CANDIDATE_INVALID");
  assert.equal(client.closeCalls, 0);
  await manager.close();
});

test("chaos rejects a cross-source identity collision", () => {
  const first = createToolDescriptorV1(authoring());
  const second = createToolDescriptorV1(authoring({
    source: { ...authoring().source, sourceId: "chaos.other" },
  }));
  assert.throws(
    () => compileToolRegistryV1([adapter(first), adapter(second)]),
    /cross-source collision/u,
  );
});

test("chaos fails closed when a retired dynamic handler cannot be rehydrated", async () => {
  const provider = new ChaosMcpProvider();
  const original = new UnifiedToolRegistry({
    allowlist: ["mcp.chaos.lookup"],
    mcpManager: provider,
  });
  await original.refresh();
  const prepared = await prepareTestToolCall({
    gateway: original,
    toolName: "mcp.chaos.lookup",
    toolInput: {},
  });
  const restarted = new UnifiedToolRegistry({
    allowlist: ["mcp.chaos.lookup"],
    mcpManager: new ChaosMcpProvider(),
  });
  await restarted.refresh();

  await assert.rejects(
    () => restarted.executePreparedToolCall(prepared),
    (error) =>
      error instanceof RuntimeFailure &&
      error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );
  await original.close();
  await restarted.close();
});

test("chaos records output-contract rejection after a committed external effect", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.chaos",
    toolId: "chaos.external",
    description: "External output chaos fixture",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    runtimeOutputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
    capability: capability("external_side_effect"),
    presentation: presentation("Chaos external"),
    handlerId: "chaos:external:handler:v1",
    resultNormalizerId: "chaos:external:normalizer:v1",
    handler: async () => ({ malformed: true }),
  });
  const result = await executeTestToolCall({
    gateway: new AllowlistedToolGateway([module]),
    toolName: "chaos.external",
    toolInput: {},
  });
  assert.equal(result.outcome.kind, "failure");
  assert.equal(result.outcome.effectState, "committed");
  assert.equal(
    result.outcome.kind === "failure" && result.outcome.normalizedFailureCode,
    "TOOL_RESULT_CONTRACT_FAILED",
  );
});

test("chaos rejects App overlay divergence", () => {
  assert.throws(
    () => resolveToolProviderDescriptorRefs({
      getDescriptorRef(runtimeName) {
        return {
          toolId: `${runtimeName}.substituted`,
          contractRevision: hashCanonical({ runtimeName }),
        };
      },
    }),
    /diverges from descriptor/u,
  );
});

class ChaosMcpProvider implements McpToolProvider {
  async refresh(): Promise<McpStatusSnapshot> {
    return mcpSnapshot("dynamic");
  }
  async assertHealthy(): Promise<void> {}
  async callTool<T>(): Promise<T> {
    return { content: [] } as T;
  }
  pinTool() {
    return {
      call: async <T>() => ({ content: [] }) as T,
      retain() {},
      async release() {},
    };
  }
  async close(): Promise<void> {}
}

function mcpSnapshot(version: string): McpStatusSnapshot {
  return {
    healthy: true,
    checkedAt: "2026-08-03T00:00:00.000Z",
    servers: [],
    tools: [{
      serverId: "chaos",
      toolName: "lookup",
      namespacedToolName: "mcp.chaos.lookup",
      description: `Lookup ${version}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      presentation: {
        displayName: "Chaos lookup",
        aliases: ["mcp.chaos.lookup"],
        keywords: ["chaos"],
        provider: "chaos",
        toolFamily: "chaos",
        capabilityClasses: ["chaos.lookup"],
        approvalMode: "auto",
      },
    }],
  };
}

function authoring(
  overrides: Partial<ToolDescriptorAuthoringV1> = {},
): ToolDescriptorAuthoringV1 {
  return {
    version: "v1",
    toolId: "chaos.lookup",
    source: {
      kind: "embedded",
      sourceId: "chaos.primary",
      protocolKind: "handler",
      protocolTarget: "lookup",
    },
    description: "Chaos lookup fixture.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    runtimeOutput: {
      schema: { type: "object", properties: {}, additionalProperties: false },
    },
    capability: capability("read_only"),
    presentation: presentation("Chaos lookup"),
    execution: {
      handlerId: "chaos:lookup:handler:v1",
      resultNormalizerId: "chaos:lookup:normalizer:v1",
    },
    ...overrides,
  };
}

function adapter(descriptor: ToolDescriptorV1): ToolRegistrySourceAdapterV1 {
  return {
    adapterId: `${descriptor.source.sourceId}:v1`,
    sourceKind: descriptor.source.kind,
    sourceId: descriptor.source.sourceId,
    compileDescriptors: () => [descriptor],
    hasHandler: () => true,
    hasResultNormalizer: () => true,
  };
}

function capability(executionClass: "read_only" | "external_side_effect") {
  return {
    freshnessClass: "live" as const,
    latencyClass: "low" as const,
    costClass: "free" as const,
    executionClass,
    capabilityClasses: ["chaos"],
    ...(executionClass === "external_side_effect"
      ? { approvalCapabilities: ["external.confirm" as const] }
      : {}),
  };
}

function presentation(displayName: string) {
  return {
    displayName,
    aliases: [displayName.toLowerCase()],
    keywords: ["chaos"],
    provider: "chaos",
    toolFamily: "chaos",
  };
}
