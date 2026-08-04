import {
  TOOL_DESCRIPTOR_VERSION,
  createToolDescriptorV1,
} from "../kestrel/contracts/tool-contract.js";
import type {
  McpDiscoveredTool,
  McpStatusSnapshot,
} from "./contracts.js";

const MCP_PROTOCOL_OUTPUT_SCHEMAS: Readonly<
  Record<NonNullable<McpDiscoveredTool["protocolKind"]>, Record<string, unknown>>
> = {
  tool: {
    type: "object",
    properties: {
      content: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
      structuredContent: { type: "object", additionalProperties: true },
      isError: { type: "boolean" },
    },
    additionalProperties: true,
  },
  resource: {
    type: "object",
    properties: {
      contents: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
    },
    additionalProperties: true,
  },
  resource_template: {
    type: "object",
    properties: {
      contents: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
    },
    additionalProperties: true,
  },
  prompt: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
    },
    additionalProperties: true,
  },
};

export function compileMcpDiscoveredToolV1(
  tool: McpDiscoveredTool,
): McpDiscoveredTool {
  const base: McpDiscoveredTool = {
    ...tool,
    inputSchema: { ...tool.inputSchema },
    ...(tool.outputSchema !== undefined
      ? { outputSchema: { ...tool.outputSchema } }
      : {}),
  };
  if (tool.presentation === undefined) {
    return {
      ...base,
      registrationError: {
        code: "MCP_TOOL_PRESENTATION_MISSING",
        message: "MCP tool is missing trusted presentation metadata.",
      },
    };
  }
  const protocolKind = tool.protocolKind ?? "tool";
  try {
    const descriptor = createToolDescriptorV1({
      version: TOOL_DESCRIPTOR_VERSION,
      toolId: tool.namespacedToolName,
      source: {
        kind: "mcp",
        sourceId: tool.serverId,
        protocolKind,
        protocolTarget: tool.protocolTarget ?? tool.toolName,
      },
      description: tool.description,
      inputSchema: tool.inputSchema,
      runtimeOutput: {
        schema:
          tool.outputSchema ??
          MCP_PROTOCOL_OUTPUT_SCHEMAS[protocolKind],
      },
      capability: {
        freshnessClass: "volatile",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "external_side_effect",
        ...(tool.presentation.allowedInteractionModes !== undefined
          ? {
              allowedInteractionModes: [
                ...tool.presentation.allowedInteractionModes,
              ],
            }
          : {}),
        capabilityClasses: [...tool.presentation.capabilityClasses],
        ...(tool.presentation.approvalMode === "auto"
          ? {}
          : { approvalCapabilities: ["mcp.invoke"] }),
      },
      presentation: {
        displayName: tool.presentation.displayName,
        aliases: [...tool.presentation.aliases],
        keywords: [...tool.presentation.keywords],
        provider: tool.presentation.provider,
        toolFamily: tool.presentation.toolFamily,
      },
      execution: {
        handlerId: `mcp:${tool.serverId}:${protocolKind}:${tool.protocolTarget ?? tool.toolName}:v1`,
        resultNormalizerId: `mcp:${protocolKind}:envelope:v1`,
      },
    });
    return { ...base, descriptor };
  } catch (error) {
    return {
      ...base,
      registrationError: {
        code: "MCP_TOOL_DESCRIPTOR_INVALID",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function compileMcpStatusSnapshotV1(
  snapshot: McpStatusSnapshot,
): McpStatusSnapshot {
  return {
    ...snapshot,
    servers: snapshot.servers.map((server) => ({ ...server })),
    tools: snapshot.tools.map(compileMcpDiscoveredToolV1),
  };
}
