import type {
  McpDiscoveredTool,
  McpServerConfig,
  McpServerStatus,
  McpStatusSnapshot,
  McpToolPresentationMetadata,
} from "./contracts.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

interface McpClientManagerOptions {
  servers: McpServerConfig[];
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: typeof fetch | undefined;
}

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
}

interface ServerHandle {
  serverId: string;
  client: unknown;
}

const MCP_CLIENT_NAME = "kestrel-mcp-client";
const MCP_CLIENT_VERSION = "0.1.0";

export class McpClientManager {
  private readonly servers: McpServerConfig[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch | undefined;

  private toolHandles = new Map<string, ToolHandle>();
  private serverHandles = new Map<string, ServerHandle>();
  private snapshot: McpStatusSnapshot = {
    healthy: true,
    checkedAt: new Date(0).toISOString(),
    servers: [],
    tools: [],
  };

  constructor(options: McpClientManagerOptions) {
    this.servers = [...options.servers];
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
  }

  async refresh(): Promise<McpStatusSnapshot> {
    await this.close();

    if (this.servers.length === 0) {
      this.snapshot = {
        healthy: true,
        checkedAt: new Date().toISOString(),
        servers: [],
        tools: [],
      };
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
      this.snapshot = {
        healthy: statuses.every((status) => status.healthy),
        checkedAt,
        servers: statuses,
        tools: [],
      };
      return this.statusSnapshot();
    }

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
        for (const tool of discovered.tools) {
          tools.push(tool);
          this.toolHandles.set(tool.namespacedToolName, {
            serverId: server.id,
            toolName: tool.toolName,
            namespacedToolName: tool.namespacedToolName,
            client: discovered.client,
          });
        }
        this.serverHandles.set(server.id, { serverId: server.id, client: discovered.client });

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

    this.snapshot = {
      healthy: statuses.every((status) => status.healthy),
      checkedAt: new Date().toISOString(),
      servers: statuses,
      tools,
    };
    return this.statusSnapshot();
  }

  async callTool<T>(namespacedToolName: string, input: unknown): Promise<T> {
    const handle = this.toolHandles.get(namespacedToolName);
    if (handle === undefined) {
      throw createRuntimeFailure("MCP_TOOL_UNAVAILABLE", `MCP tool '${namespacedToolName}' is not available`, {
        namespacedToolName,
      });
    }

    const callTool = readFunction(handle.client, "callTool");
    const payload: Record<string, unknown> = {
      name: handle.toolName,
      arguments: asRecord(input) ?? {},
    };
    const output = await callTool.call(handle.client, payload);
    return output as T;
  }

  statusSnapshot(): McpStatusSnapshot {
    return {
      healthy: this.snapshot.healthy,
      checkedAt: this.snapshot.checkedAt,
      servers: this.snapshot.servers.map((server) => ({ ...server })),
      tools: this.snapshot.tools.map((tool) => ({ ...tool })),
    };
  }

  async assertHealthy(): Promise<void> {
    const unhealthy = this.snapshot.servers.filter((server) => server.enabled && server.healthy === false);
    if (unhealthy.length === 0) {
      return;
    }

    const message = unhealthy
      .map((server) => `${server.serverId}${server.error !== undefined ? `(${server.error})` : ""}`)
      .join(", ");
    throw createRuntimeFailure("MCP_PRECHECK_FAILED", `MCP preflight failed for server(s): ${message}`, {
      unhealthyServers: unhealthy.map((server) => ({
        serverId: server.serverId,
        error: server.error,
      })),
    });
  }

  async close(): Promise<void> {
    const closeCalls: Promise<void>[] = [];
    for (const handle of this.serverHandles.values()) {
      const close = maybeReadFunction(handle.client, "close");
      if (close !== undefined) {
        closeCalls.push(
          Promise.resolve(close.call(handle.client)).then(() => undefined),
        );
      }
    }

    await Promise.all(closeCalls);
    this.serverHandles.clear();
    this.toolHandles.clear();
  }

  private async connectAndDiscover(
    sdk: SdkBindings,
    server: McpServerConfig,
  ): Promise<{
    client: unknown;
    tools: McpDiscoveredTool[];
  }> {
    const transport = await createTransport({
      sdk,
      server,
      env: this.env,
      fetchImpl: this.fetchImpl,
    });

    const client = new sdk.ClientCtor(
      { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      { capabilities: {} },
    );
    const connect = readFunction(client, "connect");
    await connect.call(client, transport);

    const listTools = readFunction(client, "listTools");
    const listed = await listTools.call(client);
    const tools = normalizeListedTools(server, listed);

    return {
      client,
      tools,
    };
  }
}

async function loadSdkBindings(): Promise<SdkBindings> {
  const clientModule = (await dynamicImport(
    "@modelcontextprotocol/sdk/client/index.js",
  )) as Record<string, unknown>;
  const clientCtor = readCtor(clientModule, "Client");
  if (clientCtor === undefined) {
    throw createRuntimeFailure("MCP_SDK_CLIENT_MISSING", "MCP SDK Client export is missing");
  }

  const stdioModule = await tryImport("@modelcontextprotocol/sdk/client/stdio.js");
  const httpModule =
    (await tryImport("@modelcontextprotocol/sdk/client/streamableHttp.js")) ??
    (await tryImport("@modelcontextprotocol/sdk/client/streamable-http.js"));
  const sseModule = await tryImport("@modelcontextprotocol/sdk/client/sse.js");

  return {
    ClientCtor: clientCtor,
    StdioTransportCtor: stdioModule !== undefined ? readCtor(stdioModule, "StdioClientTransport") : undefined,
    HttpTransportCtor:
      httpModule !== undefined
        ? (readCtor(httpModule, "StreamableHTTPClientTransport") ??
            readCtor(httpModule, "StreamableHttpClientTransport"))
        : undefined,
    SseTransportCtor: sseModule !== undefined ? readCtor(sseModule, "SSEClientTransport") : undefined,
  };
}

async function tryImport(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (await dynamicImport(path)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function createTransport(input: {
  sdk: SdkBindings;
  server: McpServerConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch | undefined;
}): Promise<unknown> {
  const server = input.server;

  if (server.transport === "stdio") {
    const ctor = input.sdk.StdioTransportCtor;
    if (ctor === undefined) {
      throw createRuntimeFailure("MCP_STDIO_TRANSPORT_UNAVAILABLE", "MCP stdio transport is unavailable in installed SDK", {
        serverId: server.id,
        transport: server.transport,
      });
    }

    return new ctor({
      command: server.command,
      args: server.args ?? [],
    });
  }

  const headers = resolveRemoteHeaders(server, input.env);
  if (server.transport === "http") {
    const ctor = input.sdk.HttpTransportCtor;
    if (ctor === undefined) {
      throw createRuntimeFailure("MCP_HTTP_TRANSPORT_UNAVAILABLE", "MCP HTTP transport is unavailable in installed SDK", {
        serverId: server.id,
        transport: server.transport,
      });
    }

    return new ctor(server.url, {
      requestInit: {
        headers,
      },
      ...(input.fetchImpl !== undefined ? { fetch: input.fetchImpl } : {}),
    });
  }

  const ctor = input.sdk.SseTransportCtor;
  if (ctor === undefined) {
    throw createRuntimeFailure("MCP_SSE_TRANSPORT_UNAVAILABLE", "MCP SSE transport is unavailable in installed SDK", {
      serverId: server.id,
      transport: server.transport,
    });
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

function normalizeListedTools(server: McpServerConfig, listed: unknown): McpDiscoveredTool[] {
  const tools = asArray(asRecord(listed)?.tools);
  const normalized: McpDiscoveredTool[] = [];

  for (const item of tools) {
    const tool = asRecord(item);
    const toolName = readString(tool, "name");
    if (toolName === undefined) {
      continue;
    }

    const description = readString(tool, "description") ?? "MCP tool";
    const inputSchema = asRecord(tool?.inputSchema) ?? {};
    const namespacedToolName = buildNamespacedToolName(server.id, toolName);
    const presentation = resolveToolPresentationMetadata(server, toolName, namespacedToolName);
    normalized.push({
      serverId: server.id,
      toolName,
      namespacedToolName,
      description,
      inputSchema,
      ...(presentation !== undefined ? { presentation } : {}),
    });
  }

  return normalized;
}

function resolveToolPresentationMetadata(
  server: McpServerConfig,
  toolName: string,
  namespacedToolName: string,
): McpToolPresentationMetadata | undefined {
  const configured = server.toolMetadata?.[toolName] ?? server.toolMetadata?.[namespacedToolName];
  return configured !== undefined
    ? {
        displayName: configured.displayName,
        aliases: [...configured.aliases],
        keywords: [...configured.keywords],
        provider: configured.provider,
        toolFamily: configured.toolFamily,
        capabilityClasses: [...configured.capabilityClasses],
      }
    : undefined;
}

function readCtor(
  module: Record<string, unknown>,
  key: string,
): (new (...args: unknown[]) => unknown) | undefined {
  const value = module[key];
  if (typeof value !== "function") {
    return undefined;
  }

  return value as new (...args: unknown[]) => unknown;
}

function readFunction(value: unknown, key: string): (...args: unknown[]) => unknown {
  const fn = maybeReadFunction(value, key);
  if (fn === undefined) {
    throw createRuntimeFailure("MCP_CLIENT_METHOD_MISSING", `Expected function '${key}' on MCP client object`, {
      key,
    });
  }
  return fn;
}

function maybeReadFunction(value: unknown, key: string): ((...args: unknown[]) => unknown) | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const fn = (value as Record<string, unknown>)[key];
  return typeof fn === "function" ? (fn as (...args: unknown[]) => unknown) : undefined;
}

function isEnabled(server: McpServerConfig): boolean {
  return server.enabled ?? true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

export function buildNamespacedToolName(serverId: string, toolName: string): string {
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
