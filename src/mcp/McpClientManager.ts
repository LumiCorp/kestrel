import { createHash } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  McpDiscoveredTool,
  McpServerConfig,
  McpServerStatus,
  McpStatusSnapshot,
  McpToolPresentationMetadata,
} from "./contracts.js";
import { compileMcpDiscoveredToolV1 } from "./toolDescriptor.js";
import type { HostedMcpRuntimeConnection } from "./hosted-contracts.js";

export interface McpClientManagerOptions {
  servers: McpServerConfig[];
  hostedGateway?: HostedMcpRuntimeConnection | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: typeof fetch | undefined;
  oauthProviderFactory?: McpOAuthProviderFactory | undefined;
}

export type McpOAuthProviderFactory = (
  server: Extract<McpServerConfig, { transport: "http" | "sse" }>,
) => OAuthClientProvider | undefined;

type HostedGatewayServerConfig = {
  id: "kestrel-one-hosted";
  transport: "http";
  url: string;
  enabled: true;
  hostedGateway: HostedMcpRuntimeConnection;
};

type ConfiguredMcpServer = McpServerConfig | HostedGatewayServerConfig;

interface SdkBindings {
  ClientCtor: new (...args: unknown[]) => unknown;
  StdioTransportCtor?: (new (...args: unknown[]) => unknown) | undefined;
  HttpTransportCtor?: (new (...args: unknown[]) => unknown) | undefined;
  SseTransportCtor?: (new (...args: unknown[]) => unknown) | undefined;
}

interface ToolHandle {
  serverId: string;
  toolName: string;
  namespacedToolName: string;
  client: unknown;
  protocolKind: "tool" | "resource" | "resource_template" | "prompt";
  protocolTarget: string;
}

interface ServerHandle {
  serverId: string;
  client: unknown;
}

export interface PinnedMcpToolHandle {
  call<T>(input: unknown): Promise<T>;
  retain(): void;
  release(): Promise<void>;
}

const MCP_CLIENT_NAME = "kestrel-mcp-client";
const MCP_CLIENT_VERSION = "0.1.0";

export class McpClientManager {
  private readonly servers: ConfiguredMcpServer[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly oauthProviderFactory: McpOAuthProviderFactory | undefined;

  private toolHandles = new Map<string, ToolHandle>();
  private serverHandles = new Map<string, ServerHandle>();
  private snapshot: McpStatusSnapshot = {
    healthy: true,
    checkedAt: new Date(0).toISOString(),
    servers: [],
    tools: [],
  };
  private refreshInFlight: Promise<McpStatusSnapshot> | undefined;
  private readonly clientReferenceCounts = new Map<unknown, number>();
  private readonly retiredClients = new Set<unknown>();
  private readonly closedClients = new Set<unknown>();
  private readonly clientReleaseChains = new Map<unknown, Promise<void>>();
  private readonly clientCloseAttempts = new Map<unknown, Promise<void>>();
  private closeAttempt: Promise<void> | undefined;
  private closing = false;
  private closed = false;

  constructor(options: McpClientManagerOptions) {
    this.servers = [
      ...options.servers,
      ...(options.hostedGateway
        ? [
            {
              id: "kestrel-one-hosted" as const,
              transport: "http" as const,
              url: normalizeHostedGatewayUrl(
                options.hostedGateway.context.gatewayUrl,
              ),
              enabled: true as const,
              hostedGateway: options.hostedGateway,
            },
          ]
        : []),
    ];
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.oauthProviderFactory = options.oauthProviderFactory;
  }

  async refresh(): Promise<McpStatusSnapshot> {
    if (this.closing || this.closed) {
      throw createRuntimeFailure(
        "MCP_MANAGER_CLOSED",
        "MCP refresh is unavailable after close has started.",
      );
    }
    if (this.refreshInFlight !== undefined) return this.refreshInFlight;
    const refresh = this.buildAndActivateRefresh();
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    }
  }

  private async buildAndActivateRefresh(): Promise<McpStatusSnapshot> {
    if (this.servers.length === 0) {
      const next = {
        healthy: true,
        checkedAt: new Date().toISOString(),
        servers: [],
        tools: [],
      };
      await this.activateCandidate(next, new Map(), new Map());
      return this.statusSnapshot();
    }

    const statuses: McpServerStatus[] = [];
    const tools: McpDiscoveredTool[] = [];

    let sdk: SdkBindings | undefined;
    try {
      sdk = await loadSdkBindings();
    } catch (error) {
      const checkedAt = new Date().toISOString();
      for (const server of this.servers) {
        statuses.push({
          serverId: server.id,
          transport: server.transport,
          healthy: isEnabled(server) === false,
          connected: false,
          enabled: isEnabled(server),
          toolCount: 0,
          checkedAt,
          ...(isEnabled(server)
            ? {
                error: `MCP SDK unavailable: ${error instanceof Error ? error.message : String(error)}`,
              }
            : {}),
        });
      }
      const failed = {
        healthy: statuses.every((status) => status.healthy),
        checkedAt,
        servers: statuses,
        tools: [],
      };
      return this.retainActiveAfterRefreshFailure(
        failed,
        "MCP_REFRESH_SDK_UNAVAILABLE",
      );
    }

    const candidateToolHandles = new Map<string, ToolHandle>();
    const candidateServerHandles = new Map<string, ServerHandle>();

    for (const server of this.servers) {
      const checkedAt = new Date().toISOString();
      if (isEnabled(server) === false) {
        statuses.push({
          serverId: server.id,
          transport: server.transport,
          healthy: true,
          connected: false,
          enabled: false,
          toolCount: 0,
          checkedAt,
        });
        continue;
      }

      try {
        const discovered = await this.connectAndDiscover(sdk, server);
        candidateServerHandles.set(server.id, {
          serverId: server.id,
          client: discovered.client,
        });
        for (const tool of discovered.tools) {
          tools.push(tool);
          if (candidateToolHandles.has(tool.namespacedToolName)) {
            throw createRuntimeFailure(
              "MCP_TOOL_COLLISION",
              `MCP refresh produced duplicate tool '${tool.namespacedToolName}'.`,
              { namespacedToolName: tool.namespacedToolName },
            );
          }
          candidateToolHandles.set(tool.namespacedToolName, {
            serverId: server.id,
            toolName: tool.toolName,
            namespacedToolName: tool.namespacedToolName,
            client: discovered.client,
            protocolKind: tool.protocolKind ?? "tool",
            protocolTarget: tool.protocolTarget ?? tool.toolName,
          });
        }
        statuses.push({
          serverId: server.id,
          transport: server.transport,
          healthy: true,
          connected: true,
          enabled: true,
          toolCount: discovered.tools.length,
          checkedAt,
        });
      } catch (error) {
        statuses.push({
          serverId: server.id,
          transport: server.transport,
          healthy: false,
          connected: false,
          enabled: true,
          toolCount: 0,
          checkedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const candidateSnapshot = {
      healthy: statuses.every((status) => status.healthy),
      checkedAt: new Date().toISOString(),
      servers: statuses,
      tools,
    };
    if (candidateSnapshot.healthy === false) {
      await closeServerHandleMap(candidateServerHandles);
      return this.retainActiveAfterRefreshFailure(
        candidateSnapshot,
        "MCP_REFRESH_CANDIDATE_INVALID",
      );
    }
    if (this.closing || this.closed) {
      await closeServerHandleMap(candidateServerHandles);
      throw createRuntimeFailure(
        "MCP_MANAGER_CLOSED",
        "MCP manager closed before candidate activation.",
      );
    }
    await this.activateCandidate(
      candidateSnapshot,
      candidateToolHandles,
      candidateServerHandles,
    );
    return this.statusSnapshot();
  }

  async callTool<T>(namespacedToolName: string, input: unknown): Promise<T> {
    const handle = this.toolHandles.get(namespacedToolName);
    if (handle === undefined) {
      throw createRuntimeFailure(
        "MCP_TOOL_UNAVAILABLE",
        `MCP tool '${namespacedToolName}' is not available`,
        {
          namespacedToolName,
        },
      );
    }

    return callToolHandle<T>(handle, input);
  }

  pinTool(namespacedToolName: string): PinnedMcpToolHandle {
    const handle = this.toolHandles.get(namespacedToolName);
    if (handle === undefined) {
      throw createRuntimeFailure(
        "MCP_TOOL_UNAVAILABLE",
        `MCP tool '${namespacedToolName}' is not available`,
        { namespacedToolName },
      );
    }
    let references = 1;
    let releaseChain = Promise.resolve();
    this.retainClient(handle.client);
    return {
      call: <T>(input: unknown) => callToolHandle<T>(handle, input),
      retain: () => {
        if (references < 1) {
          throw createRuntimeFailure(
            "MCP_PIN_RELEASED",
            `Pinned MCP tool '${namespacedToolName}' was already released.`,
          );
        }
        references += 1;
        this.retainClient(handle.client);
      },
      release: async () => {
        const release = releaseChain.then(async () => {
          if (references < 1) return;
          await this.releaseClient(handle.client);
          references -= 1;
        });
        releaseChain = release.catch(() => {});
        await release;
      },
    };
  }

  private retainClient(client: unknown): void {
    this.clientReferenceCounts.set(
      client,
      (this.clientReferenceCounts.get(client) ?? 0) + 1,
    );
  }

  private async releaseClient(client: unknown): Promise<void> {
    const previous = this.clientReleaseChains.get(client) ?? Promise.resolve();
    const release = previous.then(() => this.releaseClientReference(client));
    const tail = release.catch(() => {});
    this.clientReleaseChains.set(client, tail);
    try {
      await release;
    } finally {
      if (this.clientReleaseChains.get(client) === tail) {
        this.clientReleaseChains.delete(client);
      }
    }
  }

  private async releaseClientReference(client: unknown): Promise<void> {
    const next = Math.max(0, (this.clientReferenceCounts.get(client) ?? 0) - 1);
    if (next === 0) {
      if (this.retiredClients.has(client)) {
        await this.closeClient(client);
        this.retiredClients.delete(client);
      }
      this.clientReferenceCounts.delete(client);
      return;
    }
    this.clientReferenceCounts.set(client, next);
  }

  private async activateCandidate(
    snapshot: McpStatusSnapshot,
    toolHandles: Map<string, ToolHandle>,
    serverHandles: Map<string, ServerHandle>,
  ): Promise<void> {
    const previousClients = new Set(
      [...this.serverHandles.values()].map((handle) => handle.client),
    );
    this.toolHandles = toolHandles;
    this.serverHandles = serverHandles;
    this.snapshot = snapshot;
    await Promise.all(
      [...previousClients].map(async (client) => {
        if ((this.clientReferenceCounts.get(client) ?? 0) > 0) {
          this.retiredClients.add(client);
        } else {
          this.retiredClients.add(client);
          await this.closeClient(client);
          this.retiredClients.delete(client);
        }
      }),
    );
  }

  private retainActiveAfterRefreshFailure(
    candidate: McpStatusSnapshot,
    code: string,
  ): McpStatusSnapshot {
    if (this.snapshot.checkedAt === new Date(0).toISOString()) {
      this.snapshot = candidate;
      return this.statusSnapshot();
    }
    this.snapshot = {
      ...this.snapshot,
      refreshDiagnostic: {
        code,
        message:
          candidate.servers
            .filter((server) => server.enabled && !server.healthy)
            .map(
              (server) => `${server.serverId}: ${server.error ?? "unhealthy"}`,
            )
            .join(", ") || "MCP refresh candidate was rejected.",
        checkedAt: candidate.checkedAt,
      },
    };
    return this.statusSnapshot();
  }

  private async closeClient(client: unknown): Promise<void> {
    if (this.closedClients.has(client)) return;
    const existing = this.clientCloseAttempts.get(client);
    if (existing !== undefined) {
      await existing;
      return;
    }
    const attempt = Promise.resolve().then(async () => {
      const close = maybeReadFunction(client, "close");
      if (close !== undefined) await Promise.resolve(close.call(client));
      this.closedClients.add(client);
    });
    this.clientCloseAttempts.set(client, attempt);
    try {
      await attempt;
    } finally {
      if (this.clientCloseAttempts.get(client) === attempt) {
        this.clientCloseAttempts.delete(client);
      }
    }
  }

  private async closeActiveAndRetiredClients(): Promise<void> {
    const clients = new Set([
      ...[...this.serverHandles.values()].map((handle) => handle.client),
      ...this.retiredClients,
    ]);
    const results = await Promise.allSettled(
      [...clients].map(async (client) => {
        await this.closeClient(client);
        for (const [serverId, handle] of this.serverHandles) {
          if (handle.client === client) this.serverHandles.delete(serverId);
        }
        for (const [toolName, handle] of this.toolHandles) {
          if (handle.client === client) this.toolHandles.delete(toolName);
        }
        this.retiredClients.delete(client);
        this.clientReferenceCounts.delete(client);
      }),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }

  statusSnapshot(): McpStatusSnapshot {
    return {
      healthy: this.snapshot.healthy,
      checkedAt: this.snapshot.checkedAt,
      servers: this.snapshot.servers.map((server) => ({ ...server })),
      tools: this.snapshot.tools.map((tool) => ({ ...tool })),
      ...(this.snapshot.refreshDiagnostic === undefined
        ? {}
        : { refreshDiagnostic: { ...this.snapshot.refreshDiagnostic } }),
    };
  }

  async assertHealthy(): Promise<void> {
    const unhealthy = this.snapshot.servers.filter(
      (server) => server.enabled && server.healthy === false,
    );
    if (unhealthy.length === 0) {
      return;
    }

    const message = unhealthy
      .map(
        (server) =>
          `${server.serverId}${server.error !== undefined ? `(${server.error})` : ""}`,
      )
      .join(", ");
    throw createRuntimeFailure(
      "MCP_PRECHECK_FAILED",
      `MCP preflight failed for server(s): ${message}`,
      {
        unhealthyServers: unhealthy.map((server) => ({
          serverId: server.serverId,
          error: server.error,
        })),
      },
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closeAttempt !== undefined) {
      await this.closeAttempt;
      return;
    }
    this.closing = true;
    const attempt = (async () => {
      const refresh = this.refreshInFlight;
      if (refresh !== undefined) await refresh.catch(() => {});
      await this.closeActiveAndRetiredClients();
      this.closed = true;
      this.closing = false;
    })();
    this.closeAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.closeAttempt === attempt) this.closeAttempt = undefined;
    }
  }

  async retire(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    const clients = new Set(
      [...this.serverHandles.values()].map((handle) => handle.client),
    );
    await Promise.all(
      [...clients].map(async (client) => {
        this.retiredClients.add(client);
        if ((this.clientReferenceCounts.get(client) ?? 0) > 0) {
          for (const [serverId, handle] of this.serverHandles) {
            if (handle.client === client) this.serverHandles.delete(serverId);
          }
          for (const [toolName, handle] of this.toolHandles) {
            if (handle.client === client) this.toolHandles.delete(toolName);
          }
        } else {
          await this.closeClient(client);
          this.retiredClients.delete(client);
          for (const [serverId, handle] of this.serverHandles) {
            if (handle.client === client) this.serverHandles.delete(serverId);
          }
          for (const [toolName, handle] of this.toolHandles) {
            if (handle.client === client) this.toolHandles.delete(toolName);
          }
        }
      }),
    );
    if (this.clientReferenceCounts.size === 0) {
      this.closed = true;
      this.closing = false;
    }
  }

  private async connectAndDiscover(
    sdk: SdkBindings,
    server: ConfiguredMcpServer,
  ): Promise<{
    client: unknown;
    tools: McpDiscoveredTool[];
  }> {
    const transport = await createTransport({
      sdk,
      server,
      env: this.env,
      fetchImpl: this.fetchImpl,
      oauthProviderFactory: this.oauthProviderFactory,
    });

    const client = new sdk.ClientCtor(
      { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      { capabilities: {} },
    );
    try {
      const connect = readFunction(client, "connect");
      await connect.call(client, transport);

      const listTools = readFunction(client, "listTools");
      const listed = await listTools.call(client);
      const tools = normalizeListedTools(server, listed);
      const capabilities = asRecord(
        maybeReadFunction(client, "getServerCapabilities")?.call(client),
      );
      if (asRecord(capabilities?.resources)) {
        const listResources = maybeReadFunction(client, "listResources");
        const listTemplates = maybeReadFunction(
          client,
          "listResourceTemplates",
        );
        if (listResources) {
          tools.push(
            ...normalizeListedResources(
              server,
              await listResources.call(client),
            ),
          );
        }
        if (listTemplates) {
          tools.push(
            ...normalizeListedResourceTemplates(
              server,
              await listTemplates.call(client),
            ),
          );
        }
      }
      if (asRecord(capabilities?.prompts)) {
        const listPrompts = maybeReadFunction(client, "listPrompts");
        if (listPrompts)
          tools.push(
            ...normalizeListedPrompts(server, await listPrompts.call(client)),
          );
      }
      assertUniqueProjectedToolNames(tools);

      return {
        client,
        tools,
      };
    } catch (error) {
      await this.closeClient(client);
      throw error;
    }
  }
}

async function callToolHandle<T>(
  handle: ToolHandle,
  input: unknown,
): Promise<T> {
  const args = asRecord(input) ?? {};
  let output: unknown;
  try {
    if (handle.protocolKind === "resource") {
      output = await readFunction(handle.client, "readResource").call(
        handle.client,
        { uri: handle.protocolTarget },
      );
    } else if (handle.protocolKind === "resource_template") {
      const uri = readString(args, "uri");
      if (!uri) {
        throw createRuntimeFailure(
          "MCP_RESOURCE_URI_REQUIRED",
          "MCP resource template access requires a URI.",
        );
      }
      output = await readFunction(handle.client, "readResource").call(
        handle.client,
        { uri },
      );
    } else if (handle.protocolKind === "prompt") {
      output = await readFunction(handle.client, "getPrompt").call(
        handle.client,
        { name: handle.protocolTarget, arguments: args },
      );
    } else {
      output = await readFunction(handle.client, "callTool").call(
        handle.client,
        { name: handle.toolName, arguments: args },
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("EXECUTION_AUTH_EXPIRED")
    ) {
      throw createRuntimeFailure(
        "EXECUTION_AUTH_EXPIRED",
        "Execution authorization expired before provider dispatch.",
        {
          subsystem: "tooling",
          classification: "authorization",
          recoverable: true,
        },
      );
    }
    throw error;
  }
  return output as T;
}

async function closeServerHandleMap(
  handles: ReadonlyMap<string, ServerHandle>,
): Promise<void> {
  const clients = new Set([...handles.values()].map((handle) => handle.client));
  await Promise.all(
    [...clients].map(async (client) => {
      const close = maybeReadFunction(client, "close");
      if (close !== undefined) await Promise.resolve(close.call(client));
    }),
  );
}

async function loadSdkBindings(): Promise<SdkBindings> {
  const clientModule = (await dynamicImport(
    "@modelcontextprotocol/sdk/client/index.js",
  )) as Record<string, unknown>;
  const clientCtor = readCtor(clientModule, "Client");
  if (clientCtor === undefined) {
    throw createRuntimeFailure(
      "MCP_SDK_CLIENT_MISSING",
      "MCP SDK Client export is missing",
    );
  }

  const stdioModule = await tryImport(
    "@modelcontextprotocol/sdk/client/stdio.js",
  );
  const httpModule =
    (await tryImport("@modelcontextprotocol/sdk/client/streamableHttp.js")) ??
    (await tryImport("@modelcontextprotocol/sdk/client/streamable-http.js"));
  const sseModule = await tryImport("@modelcontextprotocol/sdk/client/sse.js");

  return {
    ClientCtor: clientCtor,
    StdioTransportCtor:
      stdioModule !== undefined
        ? readCtor(stdioModule, "StdioClientTransport")
        : undefined,
    HttpTransportCtor:
      httpModule !== undefined
        ? (readCtor(httpModule, "StreamableHTTPClientTransport") ??
          readCtor(httpModule, "StreamableHttpClientTransport"))
        : undefined,
    SseTransportCtor:
      sseModule !== undefined
        ? readCtor(sseModule, "SSEClientTransport")
        : undefined,
  };
}

async function tryImport(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return (await dynamicImport(path)) as Record<string, unknown>;
  } catch {
    return;
  }
}

async function createTransport(input: {
  sdk: SdkBindings;
  server: ConfiguredMcpServer;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch | undefined;
  oauthProviderFactory?: McpOAuthProviderFactory | undefined;
}): Promise<unknown> {
  const server = input.server;

  if (server.transport === "stdio") {
    const ctor = input.sdk.StdioTransportCtor;
    if (ctor === undefined) {
      throw createRuntimeFailure(
        "MCP_STDIO_TRANSPORT_UNAVAILABLE",
        "MCP stdio transport is unavailable in installed SDK",
        {
          serverId: server.id,
          transport: server.transport,
        },
      );
    }

    return new ctor({
      command: server.command,
      args: server.args ?? [],
      env: Object.fromEntries(
        Object.entries(input.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
  }

  const headers = isHostedGatewayServer(server)
    ? {
        Authorization: `Bearer ${server.hostedGateway.executionTicket}`,
        "x-kestrel-mcp-grant-id": server.hostedGateway.context.grantId,
      }
    : resolveRemoteHeaders(server, input.env);
  const authProvider =
    !isHostedGatewayServer(server) && server.oauthCredentialPrefix !== undefined
      ? input.oauthProviderFactory?.(server)
      : undefined;
  if (
    !isHostedGatewayServer(server) &&
    server.oauthCredentialPrefix !== undefined &&
    authProvider === undefined
  ) {
    throw createRuntimeFailure(
      "MCP_OAUTH_PROVIDER_UNAVAILABLE",
      `Secure App authorization is unavailable for server '${server.id}'`,
      { serverId: server.id },
    );
  }
  if (server.transport === "http") {
    const ctor = input.sdk.HttpTransportCtor;
    if (ctor === undefined) {
      throw createRuntimeFailure(
        "MCP_HTTP_TRANSPORT_UNAVAILABLE",
        "MCP HTTP transport is unavailable in installed SDK",
        {
          serverId: server.id,
          transport: server.transport,
        },
      );
    }

    return new ctor(server.url, {
      ...(authProvider !== undefined ? { authProvider } : {}),
      requestInit: {
        headers,
      },
      ...(input.fetchImpl !== undefined ? { fetch: input.fetchImpl } : {}),
    });
  }

  const ctor = input.sdk.SseTransportCtor;
  if (ctor === undefined) {
    throw createRuntimeFailure(
      "MCP_SSE_TRANSPORT_UNAVAILABLE",
      "MCP SSE transport is unavailable in installed SDK",
      {
        serverId: server.id,
        transport: server.transport,
      },
    );
  }

  return new ctor(server.url, {
    requestInit: {
      headers,
    },
    ...(input.fetchImpl !== undefined ? { fetch: input.fetchImpl } : {}),
  });
}

function resolveRemoteHeaders(
  server: Extract<McpServerConfig, { transport: "http" | "sse" }>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (
    server.oauthCredentialPrefix !== undefined &&
    (server.authTokenEnv !== undefined ||
      Object.keys(server.headerEnvs ?? {}).length > 0)
  ) {
    throw createRuntimeFailure(
      "MCP_AUTH_CONFIGURATION_INVALID",
      `Server '${server.id}' cannot combine App authorization with static credentials`,
      { serverId: server.id },
    );
  }

  if (server.authTokenEnv !== undefined) {
    const token = env[server.authTokenEnv];
    if (typeof token !== "string" || token.trim().length === 0) {
      throw createRuntimeFailure(
        "MCP_ENV_VAR_REQUIRED",
        `Missing required env var '${server.authTokenEnv}' for server '${server.id}'`,
        {
          serverId: server.id,
          envVar: server.authTokenEnv,
        },
      );
    }
    headers.Authorization = `Bearer ${token}`;
  }

  const mappings = server.headerEnvs ?? {};
  for (const [headerName, envVar] of Object.entries(mappings)) {
    const value = env[envVar];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw createRuntimeFailure(
        "MCP_HEADER_ENV_REQUIRED",
        `Missing required env var '${envVar}' for header '${headerName}'`,
        {
          serverId: server.id,
          headerName,
          envVar,
        },
      );
    }
    headers[headerName] = value;
  }

  return headers;
}

function normalizeListedTools(
  server: ConfiguredMcpServer,
  listed: unknown,
): McpDiscoveredTool[] {
  const tools = asArray(asRecord(listed)?.tools);
  const normalized: McpDiscoveredTool[] = [];

  for (const item of tools) {
    const tool = asRecord(item);
    if (!tool) {
      continue;
    }
    const toolName = readString(tool, "name");
    if (toolName === undefined) {
      continue;
    }

    const description = readString(tool, "description") ?? "MCP tool";
    const inputSchema = asRecord(tool?.inputSchema) ?? {};
    const outputSchema = asRecord(tool?.outputSchema);
    const namespacedToolName = isHostedGatewayServer(server)
      ? toolName
      : buildNamespacedToolName(server.id, toolName);
    const presentation = isHostedGatewayServer(server)
      ? hostedToolPresentation(tool, toolName)
      : resolveToolPresentationMetadata(server, toolName, namespacedToolName);
    normalized.push(
      compileMcpDiscoveredToolV1({
        serverId: server.id,
        toolName,
        namespacedToolName,
        description,
        inputSchema,
        ...(outputSchema !== undefined ? { outputSchema } : {}),
        ...(presentation !== undefined ? { presentation } : {}),
        protocolKind: "tool",
        protocolTarget: toolName,
      }),
    );
  }

  return normalized;
}

function normalizeListedResources(
  server: ConfiguredMcpServer,
  listed: unknown,
): McpDiscoveredTool[] {
  return normalizeProtocolItems(
    server,
    asArray(asRecord(listed)?.resources),
    "resource",
  );
}

function normalizeListedResourceTemplates(
  server: ConfiguredMcpServer,
  listed: unknown,
): McpDiscoveredTool[] {
  return normalizeProtocolItems(
    server,
    asArray(asRecord(listed)?.resourceTemplates),
    "resource_template",
  );
}

function normalizeListedPrompts(
  server: ConfiguredMcpServer,
  listed: unknown,
): McpDiscoveredTool[] {
  return normalizeProtocolItems(
    server,
    asArray(asRecord(listed)?.prompts),
    "prompt",
  );
}

function normalizeProtocolItems(
  server: ConfiguredMcpServer,
  items: unknown[],
  kind: "resource" | "resource_template" | "prompt",
): McpDiscoveredTool[] {
  return items.flatMap((item) => {
    const record = asRecord(item);
    const target =
      kind === "resource_template"
        ? readString(record, "uriTemplate")
        : readString(record, kind === "prompt" ? "name" : "uri");
    if (!target) return [];
    const rawName = buildProtocolItemName(server.id, kind, target);
    const namespacedToolName = isHostedGatewayServer(server)
      ? `mcp.${rawName}`
      : buildNamespacedToolName(server.id, rawName);
    const metadata = asRecord(record?._meta);
    const approvalMode = readString(metadata, "kestrel/approvalMode");
    const argumentsList = asArray(record?.arguments).flatMap((entry) => {
      const argument = asRecord(entry);
      const name = readString(argument, "name");
      return name ? [[name, argument] as const] : [];
    });
    const properties = Object.fromEntries(
      argumentsList.map(([name, argument]) => [
        name,
        {
          type: "string",
          ...(readString(argument, "description")
            ? { description: readString(argument, "description") }
            : {}),
        },
      ]),
    );
    const required = argumentsList
      .filter(([, argument]) => argument?.required === true)
      .map(([name]) => name);
    return [
      compileMcpDiscoveredToolV1({
        serverId: server.id,
        toolName: rawName,
        namespacedToolName,
        description: readString(record, "description") ?? `${kind} ${target}`,
        inputSchema:
          kind === "resource_template"
            ? {
                type: "object",
                properties: { uri: { type: "string" } },
                required: ["uri"],
                additionalProperties: false,
              }
            : kind === "prompt"
              ? {
                  type: "object",
                  properties,
                  ...(required.length ? { required } : {}),
                  additionalProperties: false,
                }
              : { type: "object", properties: {}, additionalProperties: false },
        protocolKind: kind,
        protocolTarget: target,
        presentation: {
          displayName: readString(record, "name") ?? target,
          aliases: [target],
          keywords: ["mcp", kind],
          provider: "kestrel-one-hosted-mcp",
          toolFamily: `hosted_mcp_${kind}`,
          capabilityClasses: [`mcp.${kind}`],
          approvalMode: approvalMode === "auto" ? "auto" : "ask",
        },
      }),
    ];
  });
}

function buildProtocolItemName(
  serverId: string,
  kind: "resource" | "resource_template" | "prompt",
  target: string,
): string {
  const readable =
    target
      .trim()
      .replace(/[^a-zA-Z0-9._-]/gu, "_")
      .slice(0, 40) || "item";
  const digest = createHash("sha256")
    .update(`${serverId}\0${kind}\0${target}`)
    .digest("hex")
    .slice(0, 16);
  return `${kind}.${readable}.${digest}`;
}

function assertUniqueProjectedToolNames(
  tools: readonly McpDiscoveredTool[],
): void {
  const projected = new Set<string>();
  for (const tool of tools) {
    if (projected.has(tool.namespacedToolName)) {
      throw new Error(
        `MCP server produced duplicate projected tool name '${tool.namespacedToolName}'.`,
      );
    }
    projected.add(tool.namespacedToolName);
  }
}

function resolveToolPresentationMetadata(
  server: McpServerConfig,
  toolName: string,
  namespacedToolName: string,
): McpToolPresentationMetadata | undefined {
  const configured =
    server.toolMetadata?.[toolName] ??
    server.toolMetadata?.[namespacedToolName];
  return configured !== undefined
    ? {
        displayName: configured.displayName,
        aliases: [...configured.aliases],
        keywords: [...configured.keywords],
        provider: configured.provider,
        toolFamily: configured.toolFamily,
        capabilityClasses: [...configured.capabilityClasses],
        ...(configured.approvalMode !== undefined
          ? { approvalMode: configured.approvalMode }
          : {}),
        ...(configured.allowedInteractionModes !== undefined
          ? { allowedInteractionModes: [...configured.allowedInteractionModes] }
          : {}),
      }
    : undefined;
}

function hostedToolPresentation(
  tool: Record<string, unknown>,
  toolName: string,
): McpToolPresentationMetadata {
  const metadata = asRecord(tool._meta);
  const approvalMode = readString(metadata, "kestrel/approvalMode");
  const allowedInteractionModes = asArray(
    metadata?.["kestrel/allowedInteractionModes"],
  ).filter(
    (value): value is "chat" | "plan" | "build" =>
      value === "chat" || value === "plan" || value === "build",
  );
  return {
    displayName:
      readString(tool, "title") ?? readString(tool, "description") ?? toolName,
    aliases: [toolName],
    keywords: ["mcp", ...toolName.split(/[._-]/u).filter(Boolean)],
    provider: "kestrel-one-hosted-mcp",
    toolFamily: "hosted_mcp",
    capabilityClasses: ["mcp.tool"],
    ...(approvalMode === "auto" || approvalMode === "ask"
      ? { approvalMode }
      : { approvalMode: "ask" as const }),
    ...(allowedInteractionModes.length > 0 ? { allowedInteractionModes } : {}),
  };
}

function readCtor(
  module: Record<string, unknown>,
  key: string,
): (new (...args: unknown[]) => unknown) | undefined {
  const value = module[key];
  if (typeof value !== "function") {
    return;
  }

  return value as new (...args: unknown[]) => unknown;
}

function readFunction(
  value: unknown,
  key: string,
): (...args: unknown[]) => unknown {
  const fn = maybeReadFunction(value, key);
  if (fn === undefined) {
    throw createRuntimeFailure(
      "MCP_CLIENT_METHOD_MISSING",
      `Expected function '${key}' on MCP client object`,
      {
        key,
      },
    );
  }
  return fn;
}

function maybeReadFunction(
  value: unknown,
  key: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const fn = (value as Record<string, unknown>)[key];
  return typeof fn === "function"
    ? (fn as (...args: unknown[]) => unknown)
    : undefined;
}

function isEnabled(server: ConfiguredMcpServer): boolean {
  return server.enabled ?? true;
}

function isHostedGatewayServer(
  server: ConfiguredMcpServer,
): server is HostedGatewayServerConfig {
  return "hostedGateway" in server;
}

function normalizeHostedGatewayUrl(value: string): string {
  const url = new URL(value);
  if (!url.pathname.endsWith("/mcp")) {
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/mcp`;
  }
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (value === undefined) {
    return;
  }
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

export function buildNamespacedToolName(
  serverId: string,
  toolName: string,
): string {
  return `mcp.${sanitizeSegment(serverId)}.${sanitizeSegment(toolName)}`;
}

function sanitizeSegment(value: string): string {
  const compact = value.trim();
  if (compact.length === 0) {
    return "unknown";
  }

  return compact.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

const dynamicImport = new Function(
  "modulePath",
  "return import(modulePath)",
) as (modulePath: string) => Promise<unknown>;
