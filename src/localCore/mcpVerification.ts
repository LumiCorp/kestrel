import { McpClientManager } from "../mcp/McpClientManager.js";
import type { McpServerConfig } from "../mcp/contracts.js";
import { LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS } from "./runtimeEnvironment.js";
import {
  parseLocalCoreCredentialId,
  parseLocalCoreCredentialSecret,
  type LocalCoreCredentialId,
  type LocalCoreCredentialStore,
} from "./credentialStore.js";
import { createLocalCoreMcpOAuthProviderFactory } from "./mcpOAuthProvider.js";

export interface LocalCoreMcpCredentialBindingInput {
  credentialId: LocalCoreCredentialId;
  envKey: string;
  secret?: string | undefined;
}

export interface LocalCoreMcpVerificationInput {
  server: McpServerConfig;
  credentials: LocalCoreMcpCredentialBindingInput[];
}

export interface LocalCoreMcpVerificationResult {
  serverId: string;
  verifiedAt: string;
  tools: { name: string; description?: string | undefined }[];
  credentials: { credentialId: LocalCoreCredentialId; configured: true }[];
}

export function parseLocalCoreMcpVerificationInput(
  value: unknown,
): LocalCoreMcpVerificationInput {
  const input = requireRecord(value, "MCP verification request");
  rejectUnknown(
    input,
    new Set(["server", "credentials"]),
    "MCP verification request",
  );
  const server = parseMcpServer(input.server);
  if (Array.isArray(input.credentials) === false) {
    throw new Error("MCP verification credentials must be an array.");
  }
  const seenCredentialIds = new Set<string>();
  const seenEnvKeys = new Set<string>();
  const credentials = input.credentials.map((entry) => {
    const binding = requireRecord(entry, "MCP credential binding");
    rejectUnknown(
      binding,
      new Set(["credentialId", "envKey", "secret"]),
      "MCP credential binding",
    );
    const credentialId = parseLocalCoreCredentialId(binding.credentialId);
    if (credentialId.startsWith(`mcp.${server.id}.`) === false) {
      throw new Error("MCP credential id must be scoped to its server id.");
    }
    const envKey = parseEnvironmentKey(binding.envKey);
    if (seenCredentialIds.has(credentialId) || seenEnvKeys.has(envKey)) {
      throw new Error(
        "MCP credential bindings must use unique credential ids and environment keys.",
      );
    }
    seenCredentialIds.add(credentialId);
    seenEnvKeys.add(envKey);
    return {
      credentialId,
      envKey,
      ...(binding.secret !== undefined
        ? { secret: parseLocalCoreCredentialSecret(binding.secret) }
        : {}),
    };
  });
  const declaredEnvironmentKeys = new Set(
    credentials.map((entry) => entry.envKey),
  );
  if (server.transport !== "stdio") {
    const required = [
      ...(server.authTokenEnv !== undefined ? [server.authTokenEnv] : []),
      ...Object.values(server.headerEnvs ?? {}),
    ];
    if (
      required.some((envKey) => declaredEnvironmentKeys.has(envKey) === false)
    ) {
      throw new Error(
        "Every remote MCP authentication environment key must have a credential binding.",
      );
    }
  }
  return { server, credentials };
}

export async function verifyAndStoreLocalCoreMcpServer(
  input: LocalCoreMcpVerificationInput,
  options: {
    credentialStore: LocalCoreCredentialStore;
    baseEnv?: Readonly<NodeJS.ProcessEnv> | undefined;
    environmentOptions?:
      | Readonly<Partial<Record<"SHELL" | "PATH", string>>>
      | undefined;
    managerFactory?:
      | ((
          server: McpServerConfig,
          env: NodeJS.ProcessEnv,
        ) => Pick<McpClientManager, "refresh" | "close">)
      | undefined;
  },
): Promise<LocalCoreMcpVerificationResult> {
  if (
    options.credentialStore.available === false &&
    input.credentials.length > 0
  ) {
    throw new Error("The Local Core credential store is unavailable.");
  }
  const originals = new Map<LocalCoreCredentialId, string | undefined>();
  const env = buildVerificationEnvironment(
    options.baseEnv ?? {},
    options.environmentOptions ?? {},
    input.credentials.map((binding) => binding.envKey),
  );
  for (const binding of input.credentials) {
    const original = await options.credentialStore.get(binding.credentialId);
    originals.set(binding.credentialId, original);
    const value = binding.secret ?? original;
    if (value === undefined) {
      throw new Error(
        `Credential '${binding.credentialId}' must be entered before this MCP server can be verified.`,
      );
    }
    env[binding.envKey] = value;
  }
  const manager =
    options.managerFactory?.(input.server, env) ??
    new McpClientManager({
      servers: [input.server],
      env,
      oauthProviderFactory: createLocalCoreMcpOAuthProviderFactory(
        options.credentialStore,
      ),
    });
  try {
    const snapshot = await manager.refresh();
    const status = snapshot.servers.find(
      (entry) => entry.serverId === input.server.id,
    );
    if (status?.healthy !== true || status.connected !== true) {
      throw new Error(
        status?.error ?? "The server did not establish an MCP connection.",
      );
    }
    const written: LocalCoreCredentialId[] = [];
    try {
      for (const binding of input.credentials) {
        if (binding.secret !== undefined) {
          await options.credentialStore.set(
            binding.credentialId,
            binding.secret,
          );
          written.push(binding.credentialId);
        }
      }
    } catch (error) {
      for (const credentialId of written.reverse()) {
        const original = originals.get(credentialId);
        if (original === undefined)
          await options.credentialStore.delete(credentialId).catch(() => false);
        else
          await options.credentialStore
            .set(credentialId, original)
            .catch(() => {});
      }
      throw error;
    }
    return {
      serverId: input.server.id,
      verifiedAt: snapshot.checkedAt,
      tools: snapshot.tools
        .filter(
          (tool) =>
            tool.serverId === input.server.id && tool.protocolKind === "tool",
        )
        .map((tool) => ({
          name: tool.toolName,
          ...(tool.description.length > 0
            ? { description: tool.description }
            : {}),
        })),
      credentials: input.credentials.map((binding) => ({
        credentialId: binding.credentialId,
        configured: true as const,
      })),
    };
  } finally {
    await manager.close();
  }
}

function buildVerificationEnvironment(
  baseEnv: Readonly<NodeJS.ProcessEnv>,
  environmentOptions: Readonly<Partial<Record<"SHELL" | "PATH", string>>>,
  credentialKeys: readonly string[],
): NodeJS.ProcessEnv {
  const excluded = new Set<string>([
    ...LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS,
    ...credentialKeys,
  ]);
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of Object.keys(baseEnv).sort()) {
    const value = baseEnv[key];
    if (excluded.has(key) === false && value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(environmentOptions)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function parseMcpServer(value: unknown): McpServerConfig {
  const server = requireRecord(value, "MCP server");
  const common = new Set([
    "id",
    "transport",
    "enabled",
    "command",
    "args",
    "url",
    "authTokenEnv",
    "headerEnvs",
    "oauthCredentialPrefix",
    "toolMetadata",
  ]);
  rejectUnknown(server, common, "MCP server");
  const id = parseServerId(server.id);
  if (server.enabled !== true)
    throw new Error("MCP verification server must be enabled.");
  const toolMetadata =
    server.toolMetadata === undefined
      ? undefined
      : parseToolMetadata(server.toolMetadata);
  if (server.transport === "stdio") {
    const command = parseRequiredString(server.command, "MCP stdio command");
    if (
      server.args !== undefined &&
      (Array.isArray(server.args) === false ||
        server.args.some((arg) => typeof arg !== "string"))
    ) {
      throw new Error("MCP stdio args must be an array of strings.");
    }
    return {
      id,
      transport: "stdio",
      command,
      ...(server.args !== undefined
        ? { args: [...server.args] as string[] }
        : {}),
      enabled: true,
      ...(toolMetadata !== undefined ? { toolMetadata } : {}),
    };
  }
  if (server.transport !== "http" && server.transport !== "sse")
    throw new Error("MCP transport is unsupported.");
  const url = new URL(parseRequiredString(server.url, "MCP server URL"));
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(
      "Remote MCP URL must use HTTP(S) without embedded credentials.",
    );
  }
  const authTokenEnv =
    server.authTokenEnv === undefined
      ? undefined
      : parseEnvironmentKey(server.authTokenEnv);
  const headerEnvsRecord =
    server.headerEnvs === undefined
      ? undefined
      : requireRecord(server.headerEnvs, "MCP header bindings");
  const headerEnvs =
    headerEnvsRecord === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(headerEnvsRecord).map(([name, envKey]) => {
            if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) === false)
              throw new Error(`MCP header name '${name}' is invalid.`);
            return [name, parseEnvironmentKey(envKey)] as const;
          }),
        );
  const oauthCredentialPrefix =
    server.oauthCredentialPrefix === undefined
      ? undefined
      : parseLocalCoreCredentialId(server.oauthCredentialPrefix);
  if (
    oauthCredentialPrefix !== undefined &&
    (!oauthCredentialPrefix.startsWith("mcp.") ||
      authTokenEnv !== undefined ||
      headerEnvs !== undefined)
  ) {
    throw new Error(
      "MCP OAuth credentials cannot be combined with static credentials.",
    );
  }
  return {
    id,
    transport: server.transport,
    url: url.toString(),
    enabled: true,
    ...(authTokenEnv !== undefined ? { authTokenEnv } : {}),
    ...(headerEnvs !== undefined ? { headerEnvs } : {}),
    ...(oauthCredentialPrefix !== undefined
      ? { oauthCredentialPrefix: oauthCredentialPrefix as `mcp.${string}` }
      : {}),
    ...(toolMetadata !== undefined ? { toolMetadata } : {}),
  };
}

function parseToolMetadata(
  value: unknown,
): NonNullable<McpServerConfig["toolMetadata"]> {
  const metadata = requireRecord(value, "MCP tool metadata");
  return Object.fromEntries(
    Object.entries(metadata).map(([toolName, raw]) => {
      const item = requireRecord(raw, `MCP tool metadata '${toolName}'`);
      if (item.approvalMode !== "auto" && item.approvalMode !== "ask")
        throw new Error(`MCP tool '${toolName}' approvalMode is invalid.`);
      if (
        Array.isArray(item.allowedInteractionModes) === false ||
        item.allowedInteractionModes.some(
          (mode) => mode !== "chat" && mode !== "plan" && mode !== "build",
        )
      )
        throw new Error(
          `MCP tool '${toolName}' allowedInteractionModes is invalid.`,
        );
      return [
        toolName,
        {
          displayName:
            typeof item.displayName === "string" ? item.displayName : toolName,
          aliases: [],
          keywords: [],
          provider: "mcp",
          toolFamily: "mcp",
          capabilityClasses: ["mcp.invoke"],
          approvalMode: item.approvalMode,
          allowedInteractionModes: [
            ...new Set(item.allowedInteractionModes),
          ] as ("chat" | "plan" | "build")[],
        },
      ] as const;
    }),
  );
}

function parseServerId(value: unknown): string {
  const id = parseRequiredString(value, "MCP server id");
  if (/^[a-zA-Z0-9._-]+$/u.test(id) === false)
    throw new Error("MCP server id is invalid.");
  return id;
}

function parseEnvironmentKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) === false
  )
    throw new Error("MCP credential environment key is invalid.");
  return value;
}

function parseRequiredString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim() !== value
  )
    throw new Error(`${label} must be a non-empty trimmed string.`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(
  record: Record<string, unknown>,
  supported: Set<string>,
  label: string,
): void {
  const key = Object.keys(record).find(
    (candidate) => supported.has(candidate) === false,
  );
  if (key !== undefined)
    throw new Error(`${label} includes unsupported field '${key}'.`);
}
