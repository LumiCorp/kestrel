import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthorizedMcpGrant } from "./contracts.js";
import type {
  InvocationAudit,
  InvocationIdentity,
} from "./invocation-audit.js";
import type { McpUpstreamProvider } from "./upstream.js";

export function createGrantMcpServer(input: {
  grant: AuthorizedMcpGrant;
  upstreams: McpUpstreamProvider;
  audit: InvocationAudit;
  approvalAuthorizer?: ApprovalAuthorizer | undefined;
}): Server {
  const { grant } = input;
  const hasTools = grant.capabilities.some(
    (capability) => capability.kind === "tool"
  );
  const hasResources = grant.capabilities.some(
    (capability) => capability.kind === "resource"
  );
  const hasPrompts = grant.capabilities.some(
    (capability) => capability.kind === "prompt"
  );
  const hasResourceTemplates = grant.capabilities.some(
    (capability) => capability.kind === "resource_template"
  );
  const server = new Server(
    { name: "kestrel-one-mcp", version: "0.1.0" },
    {
      capabilities: {
        ...(hasTools ? { tools: { listChanged: true } } : {}),
        ...(hasResources || hasResourceTemplates
          ? { resources: { listChanged: true, subscribe: hasResources } }
          : {}),
        ...(hasPrompts ? { prompts: { listChanged: true } } : {}),
      },
      instructions:
        "Capabilities are limited to the current Kestrel Environment, Project, Thread, and run grant.",
    }
  );
  if (hasTools) {
    server.setRequestHandler(ListToolsRequestSchema, () =>
      ListToolsResultSchema.parse({
        tools: grant.capabilities
          .filter((capability) => capability.kind === "tool")
          .map((capability) => ({
            ...capability.definition,
            name: requireToolCapabilityKey(capability),
            _meta: {
              ...asRecord(capability.definition._meta),
              "kestrel/approvalMode": capability.approvalMode,
            },
          })),
      })
    );
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const capability = findToolCapability(grant, request.params.name);
      return invokeCapability({
        input,
        capability,
        method: "tools/call",
        request: request.params,
        operation: async () => {
          const upstream = await input.upstreams.get(capability.serverId);
          return upstream.callTool({
            ...request.params,
            name: requireDefinitionString(capability.definition, "name"),
          });
        },
      });
    });
  }
  if (hasResources || hasResourceTemplates) {
    server.setRequestHandler(ListResourcesRequestSchema, () =>
      ListResourcesResultSchema.parse({
        resources: grant.capabilities
          .filter((capability) => capability.kind === "resource")
          .map((capability) => ({
            ...capability.definition,
            uri: capability.capabilityKey,
            _meta: { ...asRecord(capability.definition._meta), "kestrel/approvalMode": capability.approvalMode },
          })),
      })
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const capability = findResourceCapability(grant, request.params.uri);
      return invokeCapability({
        input,
        capability,
        method: "resources/read",
        request: request.params,
        operation: async () => {
          const upstream = await input.upstreams.get(capability.serverId);
          return upstream.readResource({
            ...request.params,
            uri: requireDefinitionString(capability.definition, "uri"),
          });
        },
      });
    });
  }
  if (hasResourceTemplates) {
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
      ListResourceTemplatesResultSchema.parse({
        resourceTemplates: grant.capabilities
          .filter((capability) => capability.kind === "resource_template")
          .map((capability) => ({
            ...capability.definition,
            uriTemplate: capability.capabilityKey,
            _meta: { ...asRecord(capability.definition._meta), "kestrel/approvalMode": capability.approvalMode },
          })),
      })
    );
  }
  if (hasPrompts) {
    server.setRequestHandler(ListPromptsRequestSchema, () =>
      ListPromptsResultSchema.parse({
        prompts: grant.capabilities
          .filter((capability) => capability.kind === "prompt")
          .map((capability) => ({
            ...capability.definition,
            name: capability.capabilityKey,
            _meta: { ...asRecord(capability.definition._meta), "kestrel/approvalMode": capability.approvalMode },
          })),
      })
    );
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const capability = findCapability(grant, "prompt", request.params.name);
      return invokeCapability({
        input,
        capability,
        method: "prompts/get",
        request: request.params,
        operation: async () => {
          const upstream = await input.upstreams.get(capability.serverId);
          return upstream.getPrompt({
            ...request.params,
            name: requireDefinitionString(capability.definition, "name"),
          });
        },
      });
    });
  }
  return server;
}

type AuthorizedCapability = AuthorizedMcpGrant["capabilities"][number];

function findCapability(
  grant: AuthorizedMcpGrant,
  kind: AuthorizedCapability["kind"],
  capabilityKey: string
): AuthorizedCapability {
  const capability = grant.capabilities.find(
    (candidate) =>
      candidate.kind === kind && candidate.capabilityKey === capabilityKey
  );
  if (!capability) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "The run grant does not authorize this MCP capability."
    );
  }
  return capability;
}

function findToolCapability(
  grant: AuthorizedMcpGrant,
  toolCapabilityKey: string
): AuthorizedCapability {
  const capability = grant.capabilities.find(
    (candidate) =>
      candidate.kind === "tool" &&
      candidate.toolCapabilityKey === toolCapabilityKey
  );
  if (!capability) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "The run grant does not authorize this MCP tool."
    );
  }
  return capability;
}

function findResourceCapability(
  grant: AuthorizedMcpGrant,
  uri: string
): AuthorizedCapability {
  const exact = grant.capabilities.find(
    (candidate) =>
      candidate.kind === "resource" && candidate.capabilityKey === uri
  );
  if (exact) return exact;
  const template = grant.capabilities.find(
    (candidate) =>
      candidate.kind === "resource_template" &&
      new UriTemplate(candidate.capabilityKey).match(uri) !== null
  );
  if (template) return template;
  throw new McpError(
    ErrorCode.InvalidParams,
    "The run grant does not authorize this MCP resource."
  );
}

function requireToolCapabilityKey(capability: AuthorizedCapability): string {
  if (capability.kind !== "tool" || !capability.toolCapabilityKey) {
    throw new McpError(
      ErrorCode.InternalError,
      "The approved MCP tool projection is invalid."
    );
  }
  return capability.toolCapabilityKey;
}

async function invokeCapability<T>(input: {
  input: {
    grant: AuthorizedMcpGrant;
    upstreams: McpUpstreamProvider;
    audit: InvocationAudit;
    approvalAuthorizer?: ApprovalAuthorizer | undefined;
  };
  capability: AuthorizedCapability;
  method: string;
  request: unknown;
  operation: () => Promise<T>;
}): Promise<T> {
  const identity: InvocationIdentity = {
    grant: input.input.grant,
    serverId: input.capability.serverId,
    capabilityId: input.capability.id,
    method: input.method,
    request: input.request,
  };
  if (input.capability.approvalMode === "ask") {
    if (
      input.input.approvalAuthorizer &&
      (await input.input.approvalAuthorizer.isApproved({
        grant: input.input.grant,
        capability: input.capability,
      }))
    ) {
      return input.input.audit.execute(identity, input.operation);
    }
    const invocationId = await input.input.audit.markWaitingApproval(identity);
    throw new McpError(
      ErrorCode.InvalidRequest,
      "This MCP invocation requires explicit approval.",
      { code: "MCP_APPROVAL_REQUIRED", invocationId }
    );
  }
  return input.input.audit.execute(identity, input.operation);
}

export interface ApprovalAuthorizer {
  isApproved(input: {
    grant: AuthorizedMcpGrant;
    capability: AuthorizedCapability;
  }): Promise<boolean>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireDefinitionString(
  definition: Record<string, unknown>,
  field: string
): string {
  const value = definition[field];
  if (typeof value !== "string" || !value) {
    throw new McpError(
      ErrorCode.InternalError,
      "The approved MCP capability definition is invalid."
    );
  }
  return value;
}
