import type { TuiProfile } from "../../cli/contracts.js";
import type { McpServerConfig } from "../mcp/contracts.js";
import {
  composeKestrelOneProfile,
} from "../profile/kestrelOnePolicy.js";
import {
  resolveProfileWithModelPolicy,
  type ResolvedModelPolicy,
} from "../profile/modelPolicy.js";
import {
  createDesktopModelConfiguration,
  getDesktopAppDefinition,
  parseDesktopExecutionSelection,
  parseDesktopModelConfigurations,
  resolveDesktopModelConfiguration,
  type DesktopCustomAppDefinitionSource,
  type DesktopExecutionSelection,
} from "./configuration.js";
import { getDesktopStandardAppConnection } from "./standardAppConnections.js";
import type {
  DesktopMcpCredentialBinding,
  DesktopMcpServerConfig,
  DesktopMcpToolSummary,
} from "./contracts.js";

export interface ResolvedDesktopKestrelOneProfile {
  profile: TuiProfile;
  modelConfigurationName: string;
}

export function resolveDesktopKestrelOneProfile(input: {
  settings: Record<string, unknown>;
  fallbackModelPolicy: ResolvedModelPolicy;
  selection: unknown;
}): ResolvedDesktopKestrelOneProfile {
  const selection = parseDesktopExecutionSelection(input.selection);
  const configurations =
    input.settings.modelConfigurations === undefined
      ? [createDesktopModelConfiguration(input.fallbackModelPolicy)]
      : parseDesktopModelConfigurations(input.settings.modelConfigurations);
  const resolved = resolveDesktopModelConfiguration(configurations, selection.modelConfiguration);
  if (resolved === undefined) {
    throw new Error(
      `Desktop model configuration '${selection.modelConfiguration.id}@${selection.modelConfiguration.revision}' is unavailable.`,
    );
  }
  const servers = parseCoreDesktopMcpServers(input.settings.mcpServers);
  const selectedAppTools = resolveSelectedDesktopAppTools(selection, servers);
  const enabledServers = servers.filter((server) => server.enabled);
  const runtimeMcpServers = enabledServers
    .filter((server) => {
      if (server.appId === undefined) return true;
      const connection = getDesktopStandardAppConnection(server.appId);
      return connection?.kind !== "authorization" || connection.runtime !== "native";
    })
    .map(desktopMcpServerToRuntime);
  const approvalPolicyPackId =
    input.settings.approvalPolicyPackId === "ci_bot" ||
    input.settings.approvalPolicyPackId === "production"
      ? input.settings.approvalPolicyPackId
      : "dev";
  const developerShellEnvMode =
    input.settings.developerShellEnvMode === "allowlist"
      ? "allowlist"
      : "inherit";
  const developerShellAllowedEnvNames =
    Array.isArray(input.settings.developerShellAllowedEnvNames) &&
    input.settings.developerShellAllowedEnvNames.every(
      (entry) => typeof entry === "string",
    )
      ? [...input.settings.developerShellAllowedEnvNames]
      : [];
  const capabilityPacks = Array.isArray(input.settings.capabilityPacks)
    ? input.settings.capabilityPacks
    : [];
  const base = composeKestrelOneProfile({
    environmentPresetId: "desktop_dev_local",
    overlay: {
      label: `${resolved.configuration.name} · Kestrel One`,
      approvalPolicyPackId,
      additionalToolNames: selectedAppTools,
      mcpServers: runtimeMcpServers,
      devShell: {
        enabled: capabilityPacks.includes("dev_shell"),
        envMode: developerShellEnvMode,
        allowedEnvNames: developerShellAllowedEnvNames,
      },
    },
  }).profile;
  return {
    profile: resolveProfileWithModelPolicy(
      base,
      resolved.revision.policy ?? input.fallbackModelPolicy,
    ),
    modelConfigurationName: resolved.configuration.name,
  };
}

export function desktopMcpServerToRuntime(
  server: DesktopMcpServerConfig,
): McpServerConfig {
  const toolMetadata = Object.fromEntries(
    (server.tools ?? []).map((tool) => [
      tool.name,
      {
        displayName: tool.name,
        aliases: [],
        keywords: [],
        provider: server.name,
        toolFamily: "mcp",
        capabilityClasses: ["mcp.invoke"],
        approvalMode: tool.approvalMode ?? "ask",
        allowedInteractionModes: tool.allowedInteractionModes ?? ["build"],
      },
    ]),
  );
  if (server.transport === "stdio") {
    return {
      id: server.id,
      transport: "stdio",
      command: server.command!,
      ...(server.args !== undefined ? { args: [...server.args] } : {}),
      enabled: true,
      ...(Object.keys(toolMetadata).length > 0 ? { toolMetadata } : {}),
    };
  }
  const bearer = server.credentials?.find(
    (binding) => binding.kind === "bearer",
  );
  const headers =
    server.credentials?.filter((binding) => binding.kind === "header") ?? [];
  return {
    id: server.id,
    transport: server.transport,
    url: server.url!,
    enabled: true,
    ...(server.oauthCredentialPrefix !== undefined
      ? { oauthCredentialPrefix: server.oauthCredentialPrefix }
      : {}),
    ...(bearer !== undefined ? { authTokenEnv: bearer.envKey } : {}),
    ...(headers.length > 0
      ? {
          headerEnvs: Object.fromEntries(
            headers.map((binding) => [binding.name!, binding.envKey]),
          ),
        }
      : {}),
    ...(Object.keys(toolMetadata).length > 0 ? { toolMetadata } : {}),
  };
}

function resolveSelectedDesktopAppTools(
  selection: DesktopExecutionSelection,
  servers: DesktopMcpServerConfig[],
): string[] {
  const customApps: DesktopCustomAppDefinitionSource[] = servers.map(
    (server) => ({
      id: server.id,
      ...(server.appId !== undefined ? { appId: server.appId } : {}),
      name: server.name,
      enabled: server.enabled,
      ...(server.tools !== undefined
        ? { tools: server.tools.map((tool) => ({ ...tool })) }
        : {}),
      ...(server.capabilityPacks !== undefined
        ? { capabilityPacks: [...server.capabilityPacks] }
        : {}),
    }),
  );
  const selected = new Set<string>();
  for (const app of selection.apps) {
    const definition = getDesktopAppDefinition(
      app.id,
      app.contractVersion,
      customApps,
    );
    if (definition === undefined) {
      throw new Error(
        `Desktop app contract '${app.id}@${app.contractVersion}' is unavailable.`,
      );
    }
    for (const toolName of definition.toolNames) selected.add(toolName);
  }
  return [...selected];
}

function parseCoreDesktopMcpServers(value: unknown): DesktopMcpServerConfig[] {
  if (value === undefined) return [];
  if (Array.isArray(value) === false) {
    throw new Error("Desktop settings mcpServers must be an array.");
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, `mcpServers[${index}]`);
    const transport = record.transport;
    if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
      throw new Error(`Desktop settings mcpServers[${index}].transport is invalid.`);
    }
    const id = requireString(record.id, `mcpServers[${index}].id`);
    const name = requireString(record.name, `mcpServers[${index}].name`);
    const enabled = record.enabled === true;
    const tools = parseDesktopMcpTools(record.tools, index);
    const credentials = parseDesktopMcpCredentials(record.credentials, index);
    const command =
      transport === "stdio"
        ? requireString(record.command, `mcpServers[${index}].command`)
        : undefined;
    const url =
      transport === "stdio"
        ? undefined
        : requireString(record.url, `mcpServers[${index}].url`);
    return {
      id,
      ...(typeof record.appId === "string" && record.appId.trim().length > 0
        ? { appId: record.appId.trim() }
        : {}),
      name,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(Array.isArray(record.args) &&
      record.args.every((argument) => typeof argument === "string")
        ? { args: [...record.args] }
        : {}),
      ...(url !== undefined ? { url } : {}),
      enabled,
      source:
        typeof record.source === "string" && record.source.trim().length > 0
          ? record.source
          : "desktop-managed",
      ...(tools.length > 0 ? { tools } : {}),
      ...(credentials.length > 0 ? { credentials } : {}),
      ...(typeof record.oauthCredentialPrefix === "string" &&
      record.oauthCredentialPrefix.startsWith("mcp.")
        ? {
            oauthCredentialPrefix:
              record.oauthCredentialPrefix as `mcp.${string}`,
          }
        : {}),
      ...(Array.isArray(record.capabilityPacks) &&
      record.capabilityPacks.every((pack) => typeof pack === "string")
        ? { capabilityPacks: [...record.capabilityPacks] }
        : {}),
    };
  });
}

function parseDesktopMcpTools(
  value: unknown,
  serverIndex: number,
): DesktopMcpToolSummary[] {
  if (value === undefined) return [];
  if (Array.isArray(value) === false) {
    throw new Error(`Desktop settings mcpServers[${serverIndex}].tools must be an array.`);
  }
  return value.map((entry, toolIndex) => {
    const record = requireRecord(
      entry,
      `mcpServers[${serverIndex}].tools[${toolIndex}]`,
    );
    const approvalMode =
      record.approvalMode === "auto" || record.approvalMode === "ask"
        ? record.approvalMode
        : undefined;
    const allowedInteractionModes =
      Array.isArray(record.allowedInteractionModes) &&
      record.allowedInteractionModes.every(
        (mode) => mode === "chat" || mode === "plan" || mode === "build",
      )
        ? record.allowedInteractionModes
        : undefined;
    return {
      name: requireString(
        record.name,
        `mcpServers[${serverIndex}].tools[${toolIndex}].name`,
      ),
      ...(typeof record.description === "string"
        ? { description: record.description }
        : {}),
      ...(approvalMode !== undefined ? { approvalMode } : {}),
      ...(allowedInteractionModes !== undefined
        ? { allowedInteractionModes: [...allowedInteractionModes] }
        : {}),
    };
  });
}

function parseDesktopMcpCredentials(
  value: unknown,
  serverIndex: number,
): DesktopMcpCredentialBinding[] {
  if (value === undefined) return [];
  if (Array.isArray(value) === false) {
    throw new Error(
      `Desktop settings mcpServers[${serverIndex}].credentials must be an array.`,
    );
  }
  return value.map((entry, credentialIndex) => {
    const record = requireRecord(
      entry,
      `mcpServers[${serverIndex}].credentials[${credentialIndex}]`,
    );
    if (
      record.kind !== "bearer" &&
      record.kind !== "header" &&
      record.kind !== "environment"
    ) {
      throw new Error(
        `Desktop settings mcpServers[${serverIndex}].credentials[${credentialIndex}].kind is invalid.`,
      );
    }
    const credentialId = requireString(
      record.credentialId,
      `mcpServers[${serverIndex}].credentials[${credentialIndex}].credentialId`,
    );
    if (credentialId.startsWith("mcp.") === false) {
      throw new Error("Desktop MCP credential IDs must begin with 'mcp.'.");
    }
    return {
      kind: record.kind,
      ...(typeof record.name === "string" && record.name.trim().length > 0
        ? { name: record.name.trim() }
        : {}),
      credentialId: credentialId as `mcp.${string}`,
      envKey: requireString(
        record.envKey,
        `mcpServers[${serverIndex}].credentials[${credentialIndex}].envKey`,
      ),
      configured: record.configured === true,
    };
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Desktop settings ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Desktop settings ${label} must be a non-empty string.`);
  }
  return value.trim();
}
