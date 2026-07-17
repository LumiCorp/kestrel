import {
  decryptMcpCredential,
  encryptMcpCredential,
  type McpCredentialPayload,
} from "@kestrel/mcp-security";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolRequest,
  GetPromptRequest,
  ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AuthorizedMcpGrant,
  AuthorizedMcpServer,
} from "./contracts.js";
import type { McpCredentialStore } from "./credential-store.js";
import {
  buildRemoteWorkspaceRoot,
  createMcpHostClient,
  type McpAuthorizedHostCapability,
  type McpWorkspaceRoot,
} from "./host-capabilities.js";
import { createPinnedMcpFetch } from "./network-policy.js";
import { connectOciMcpClient } from "./oci-runtime.js";
import type { McpInteractionCoordinator } from "./interaction-coordinator.js";

const MCP_PROTOCOL_VERSION = "2025-11-25";
type PinnedFetchFactory = typeof createPinnedMcpFetch;

export interface McpUpstream {
  callTool(params: CallToolRequest["params"]): ReturnType<Client["callTool"]>;
  readResource(
    params: ReadResourceRequest["params"]
  ): ReturnType<Client["readResource"]>;
  getPrompt(
    params: GetPromptRequest["params"]
  ): ReturnType<Client["getPrompt"]>;
  close(): Promise<void>;
}

export interface McpUpstreamProvider {
  get(serverId: string): Promise<McpUpstream>;
}

export class GrantUpstreamManager implements McpUpstreamProvider {
  private readonly upstreams = new Map<string, Promise<McpUpstream>>();
  private readonly workspaceBasePath: string | undefined;
  private readonly credentialStore: McpCredentialStore | undefined;
  private readonly interactionCoordinator: McpInteractionCoordinator | undefined;

  constructor(
    private readonly grant: AuthorizedMcpGrant,
    options: {
      workspaceBasePath?: string | undefined;
      credentialStore?: McpCredentialStore | undefined;
      interactionCoordinator?: McpInteractionCoordinator | undefined;
    } = {}
  ) {
    this.workspaceBasePath = options.workspaceBasePath;
    this.credentialStore = options.credentialStore;
    this.interactionCoordinator = options.interactionCoordinator;
  }

  get(serverId: string): Promise<McpUpstream> {
    const existing = this.upstreams.get(serverId);
    if (existing) {
      return existing;
    }
    const server = this.grant.servers.find(
      (candidate) => candidate.id === serverId
    );
    if (!server) {
      throw new Error("MCP grant does not authorize the requested server.");
    }
    const created = createUpstream(
      this.grant,
      server,
      this.workspaceBasePath,
      this.credentialStore,
      this.interactionCoordinator
    );
    this.upstreams.set(serverId, created);
    return created;
  }

  async close(): Promise<void> {
    const settled = await Promise.allSettled(this.upstreams.values());
    await Promise.allSettled(
      settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.close()] : []
      )
    );
    this.upstreams.clear();
  }
}

async function createUpstream(
  grant: AuthorizedMcpGrant,
  server: AuthorizedMcpServer,
  workspaceBasePath: string | undefined,
  credentialStore: McpCredentialStore | undefined,
  interactionCoordinator: McpInteractionCoordinator | undefined
): Promise<McpUpstream> {
  if (server.sourceType === "oci") {
    const connected = await connectOciMcpClient({
      grant,
      server,
      workspaceBasePath,
      interactions: interactionCoordinator
        ? { grant, serverId: server.id, coordinator: interactionCoordinator }
        : undefined,
    });
    const client = connected.client;
    return {
      callTool: (params) => client.callTool(params),
      readResource: (params) => client.readResource(params),
      getPrompt: (params) => client.getPrompt(params),
      close: connected.close,
    };
  }
  const connected = await connectRemoteMcpClient({
    organizationId: grant.organizationId,
    environmentId: grant.environmentId,
    server,
    credentialStore,
    interactions: interactionCoordinator
      ? { grant, serverId: server.id, coordinator: interactionCoordinator }
      : undefined,
    roots: [
      buildRemoteWorkspaceRoot({
        organizationId: grant.organizationId,
        projectId: grant.projectId,
        threadId: grant.threadId,
      }),
    ],
    authorizedHostCapabilities: resolveAuthorizedHostCapabilities(grant, server.id),
  });
  const client = connected.client;
  return {
    callTool: (params) => client.callTool(params),
    readResource: (params) => client.readResource(params),
    getPrompt: (params) => client.getPrompt(params),
    close: connected.close,
  };
}

export async function connectRemoteMcpClient(input: {
  organizationId: string;
  environmentId: string;
  server: Extract<AuthorizedMcpServer, { sourceType: "remote" }>;
  credentialStore?: McpCredentialStore | undefined;
  createPinnedFetch?: PinnedFetchFactory | undefined;
  roots?: McpWorkspaceRoot[] | undefined;
  authorizedHostCapabilities?: readonly McpAuthorizedHostCapability[] | undefined;
  interactions?: Parameters<typeof createMcpHostClient>[0]["interactions"];
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = input;
  const endpoint = new URL(server.remoteUrl);
  if (
    !server.egressAllowlist.some(
      (entry) => safeOrigin(entry) === endpoint.origin
    )
  ) {
    throw new Error("Remote MCP endpoint is not in its egress allowlist.");
  }
  const headers = await resolveRemoteCredentialHeaders(input, server);
  const pinned = await (input.createPinnedFetch ?? createPinnedMcpFetch)({
    endpoint,
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: pinned.fetch,
    requestInit: { headers },
  });
  transport.setProtocolVersion(MCP_PROTOCOL_VERSION);
  const client = createMcpHostClient({
    name: "kestrel-one-mcp-service",
    authorizedHostCapabilities: input.authorizedHostCapabilities,
    roots: input.roots,
    interactions: input.interactions,
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await pinned.close().catch(() => {});
    throw error;
  }
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await pinned.close().catch(() => {});
    },
  };
}

function resolveAuthorizedHostCapabilities(
  grant: AuthorizedMcpGrant,
  serverId: string
): McpAuthorizedHostCapability[] {
  return grant.capabilities.flatMap((capability) =>
    capability.serverId === serverId &&
    (capability.kind === "root" ||
      capability.kind === "sampling" ||
      capability.kind === "elicitation")
      ? [capability.kind]
      : []
  );
}

export async function resolveRemoteCredentialHeaders(
  identity: {
    organizationId: string;
    environmentId: string;
    credentialStore?: McpCredentialStore | undefined;
    createPinnedFetch?: PinnedFetchFactory | undefined;
  },
  server: AuthorizedMcpServer
): Promise<Record<string, string>> {
  if (!server.credential) {
    return {};
  }
  const payload = decryptMcpCredential({
    organizationId: identity.organizationId,
    environmentId: identity.environmentId,
    credentialId: server.credential.id,
    encrypted: server.credential.encryptedPayload,
  });
  if (payload.kind !== server.credential.kind) {
    throw new Error("MCP credential kind does not match the server auth mode.");
  }
  if (payload.kind === "oauth") {
    const refreshed = await refreshOAuthCredentialIfNeeded({
      identity,
      server,
      payload,
    });
    return {
      authorization: `${refreshed.tokenType} ${refreshed.accessToken}`,
    };
  }
  return { ...payload.headers };
}

async function refreshOAuthCredentialIfNeeded(input: {
  identity: {
    organizationId: string;
    environmentId: string;
    credentialStore?: McpCredentialStore | undefined;
    createPinnedFetch?: PinnedFetchFactory | undefined;
  };
  server: AuthorizedMcpServer;
  payload: Extract<McpCredentialPayload, { kind: "oauth" }>;
}): Promise<Extract<McpCredentialPayload, { kind: "oauth" }>> {
  const expiry = input.payload.expiresAt
    ? Date.parse(input.payload.expiresAt)
    : Number.POSITIVE_INFINITY;
  if (expiry > Date.now() + 30_000) {
    return input.payload;
  }
  const credentialId = input.server.credential?.id;
  const store = input.identity.credentialStore;
  if (
    !((((credentialId &&store ) &&input.payload.refreshToken ) &&input.payload.tokenEndpoint ) &&input.payload.clientId)
  ) {
    await store?.markRefreshRequired(credentialId ?? "");
    throw new Error("MCP OAuth credential requires reauthorization.");
  }
  const tokenEndpoint = new URL(input.payload.tokenEndpoint);
  if (
    !input.server.egressAllowlist.some(
      (entry) => safeOrigin(entry) === tokenEndpoint.origin
    )
  ) {
    await store.markRefreshRequired(credentialId);
    throw new Error("MCP OAuth token endpoint is not allowlisted.");
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.payload.refreshToken,
    client_id: input.payload.clientId,
  });
  if (input.payload.resource) form.set("resource", input.payload.resource);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (input.payload.tokenEndpointAuthMethod === "client_secret_basic") {
    headers.authorization = `Basic ${Buffer.from(
      `${input.payload.clientId}:${input.payload.clientSecret ?? ""}`
    ).toString("base64")}`;
  } else if (
    input.payload.tokenEndpointAuthMethod === "client_secret_post"
  ) {
    form.set("client_secret", input.payload.clientSecret ?? "");
  }
  const pinned = await (
    input.identity.createPinnedFetch ?? createPinnedMcpFetch
  )({ endpoint: tokenEndpoint });
  try {
    const response = await pinned.fetch(tokenEndpoint, {
      method: "POST",
      headers,
      body: form.toString(),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("refresh rejected");
    }
    const body = (await response.json()) as Record<string, unknown>;
    const accessToken = readNonEmptyString(body.access_token);
    const tokenType = readNonEmptyString(body.token_type);
    if (!accessToken || tokenType?.toLowerCase() !== "bearer") {
      throw new Error("invalid refresh response");
    }
    const expiresIn =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : undefined;
    const refreshed: Extract<McpCredentialPayload, { kind: "oauth" }> = {
      ...input.payload,
      accessToken,
      tokenType: "Bearer",
      refreshToken:
        readNonEmptyString(body.refresh_token) ?? input.payload.refreshToken,
      scopes:
        readNonEmptyString(body.scope)?.split(/\s+/u).filter(Boolean) ??
        input.payload.scopes,
      ...(expiresIn
        ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
        : { expiresAt: undefined }),
    };
    const encryptedPayload = encryptMcpCredential({
      organizationId: input.identity.organizationId,
      environmentId: input.identity.environmentId,
      credentialId,
      payload: refreshed,
    });
    await store.updateRefreshedCredential({
      credentialId,
      encryptedPayload,
      expiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt) : null,
    });
    return refreshed;
  } catch {
    await store.markRefreshRequired(credentialId);
    throw new Error("MCP OAuth credential refresh failed.");
  } finally {
    await pinned.close().catch(() => {});
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return;
  }
}
