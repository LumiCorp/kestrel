import {
  AllowlistedToolGateway,
  createEmbeddedToolModuleV1,
  type ToolHandler,
} from "../../src/io/ToolGateway.js";

export function createTestToolGateway(
  handlers: Readonly<Record<string, ToolHandler>>,
): AllowlistedToolGateway {
  return new AllowlistedToolGateway(
    Object.entries(handlers).map(([toolId, handler]) =>
      createEmbeddedToolModuleV1({
        ownerId: "kestrel.tests",
        toolId,
        description: `Test tool ${toolId}`,
        inputSchema: { type: "object", additionalProperties: true },
        capability: {
          freshnessClass: "static",
          latencyClass: "low",
          costClass: "free",
          executionClass: "read_only",
          capabilityClasses: [`test.${toolId}`],
        },
        presentation: {
          displayName: toolId,
          aliases: [toolId],
          keywords: ["test"],
          provider: "test",
          toolFamily: "test",
        },
        handlerId: `test:${toolId}:handler:v1`,
        resultNormalizerId: `test:${toolId}:json:v1`,
        handler,
      }),
    ),
  );
}
