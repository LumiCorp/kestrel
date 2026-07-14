import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  ElicitRequestSchema,
  ElicitResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthorizedMcpGrant } from "./contracts.js";
import type { McpInteractionCoordinator } from "./interaction-coordinator.js";

export type McpWorkspaceRoot = { uri: string; name: string };
export type McpAuthorizedHostCapability = "root" | "sampling" | "elicitation";

export function createMcpHostClient(input: {
  name: string;
  authorizedHostCapabilities?: readonly McpAuthorizedHostCapability[] | undefined;
  roots?: McpWorkspaceRoot[] | undefined;
  interactions?:
    | {
        grant: AuthorizedMcpGrant;
        serverId: string;
        coordinator: McpInteractionCoordinator;
      }
    | undefined;
}): Client {
  const roots = input.roots ?? [];
  const authorized = new Set(input.authorizedHostCapabilities ?? []);
  const client = new Client(
    { name: input.name, version: "0.1.0" },
    {
      capabilities: {
        ...(authorized.has("root") ? { roots: { listChanged: false } } : {}),
        ...(authorized.has("sampling") ? { sampling: { tools: {} } } : {}),
        ...(authorized.has("elicitation")
          ? { elicitation: { form: {}, url: {} } }
          : {}),
      },
    },
  );
  if (authorized.has("root")) {
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: roots.map((root) => ({ ...root })),
    }));
  }
  if (
    input.interactions &&
    (authorized.has("sampling") || authorized.has("elicitation"))
  ) {
    const interactions = input.interactions;
    if (authorized.has("sampling")) {
      client.setRequestHandler(
        CreateMessageRequestSchema,
        async (request, extra) => {
          const result = await interactions.coordinator.request({
            grant: interactions.grant,
            serverId: interactions.serverId,
            kind: "sampling",
            request: request.params,
            signal: extra.signal,
          });
          return request.params.tools
            ? CreateMessageResultWithToolsSchema.parse(result)
            : CreateMessageResultSchema.parse(result);
        },
      );
    }
    if (authorized.has("elicitation")) {
      client.setRequestHandler(ElicitRequestSchema, async (request, extra) =>
        ElicitResultSchema.parse(
          await interactions.coordinator.request({
            grant: interactions.grant,
            serverId: interactions.serverId,
            kind: "elicitation",
            request: request.params,
            signal: extra.signal,
          }),
        ),
      );
    }
  }
  return client;
}

export function buildRemoteWorkspaceRoot(input: {
  organizationId: string;
  projectId: string | null;
  threadId: string;
}): McpWorkspaceRoot {
  return {
    uri: "file:///workspace",
    name: input.projectId
      ? `Project workspace (${input.projectId})`
      : `Thread workspace (${input.threadId})`,
  };
}
