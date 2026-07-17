import type { McpServerConfig, McpStatusSnapshot } from "../../src/index.js";
import type { TuiAppContext } from "./TuiAppContext.js";

const MCP_DOCKER_GATEWAY_SERVER_ID = "docker-gw";

export interface McpControllerContext extends TuiAppContext {
  fetchMcpStatus(refresh: boolean): Promise<McpStatusSnapshot>;
}

export class McpController {
  private readonly context: McpControllerContext;

  constructor(context: McpControllerContext) {
    this.context = context;
  }

  async handleMcpCommandSafely(args: string[]): Promise<void> {
    try {
      await this.handleMcpCommand(args);
    } catch (error) {
      await this.context.appendHistoryLine(
        "system",
        `MCP command failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async handleMcpCommand(args: string[]): Promise<void> {
    const [subcommand, ...rest] = args;
    if (subcommand === undefined) {
      const status = await this.context.fetchMcpStatus(false);
      this.context.navigateToView("mcp");
      this.context.uiStore.patch({
        mcpStatus: status,
      });
      await this.context.persistUiState();
      return;
    }

    if (subcommand === "help") {
      await this.context.appendHistoryLine(
        "system",
        [
          "MCP commands:",
          "/mcp status",
          "/mcp servers",
          "/mcp tools [serverId]",
          "/mcp allow <toolId>",
          "/mcp deny <toolId>",
          "/mcp docker [server]",
          "/mcp add stdio <id> <command> [args...]",
          "/mcp add http <id> <url> [--auth-env VAR] [--header-env Name=ENV]",
          "/mcp add sse <id> <url> [--auth-env VAR] [--header-env Name=ENV]",
          "/mcp remove <serverId>",
          "/mcp refresh",
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "status") {
      const status = await this.context.fetchMcpStatus(false);
      await this.context.appendHistoryLine("system", `MCP: ${summarizeMcpDetails(status)}`);
      return;
    }

    if (subcommand === "refresh") {
      const status = await this.context.fetchMcpStatus(true);
      await this.context.appendHistoryLine("system", `MCP refreshed: ${summarizeMcpDetails(status)}`);
      return;
    }

    if (subcommand === "servers") {
      const status = await this.context.fetchMcpStatus(false);
      if (status.servers.length === 0) {
        await this.context.appendHistoryLine("system", "No MCP servers configured.");
        return;
      }
      const lines = status.servers.map((server) => {
        const state = server.enabled
          ? server.healthy
            ? "healthy"
            : "unhealthy"
          : "disabled";
        const detail = server.error !== undefined ? ` error=${server.error}` : "";
        return `${server.serverId} transport=${server.transport} state=${state} tools=${server.toolCount}${detail}`;
      });
      await this.context.appendHistoryLine("system", `MCP servers:\n${lines.join("\n")}`);
      return;
    }

    if (subcommand === "tools") {
      const serverId = rest[0];
      const status = await this.context.fetchMcpStatus(false);
      const tools =
        serverId !== undefined
          ? status.tools.filter((tool) => tool.serverId === serverId)
          : status.tools;
      if (tools.length === 0) {
        await this.context.appendHistoryLine(
          "system",
          serverId !== undefined
            ? `No MCP tools discovered for '${serverId}'.`
            : "No MCP tools discovered.",
        );
        return;
      }

      const lines = tools.map((tool) => {
        const allowed = tool.allowlisted ? "allowlisted" : "blocked";
        return `${tool.namespacedToolName} (${allowed})`;
      });
      await this.context.appendHistoryLine("system", `MCP tools:\n${lines.join("\n")}`);
      return;
    }

    if (subcommand === "allow") {
      const toolId = rest[0];
      if (toolId === undefined || toolId.trim().length === 0) {
        await this.context.appendHistoryLine("system", "Usage: /mcp allow <toolId>");
        return;
      }

      const state = this.context.uiStore.getState();
      const nextAllowlist = [...(state.activeProfile.toolAllowlist ?? [])];
      if (nextAllowlist.includes(toolId) === false) {
        nextAllowlist.push(toolId);
      }
      await this.context.persistActiveProfile({
        ...state.activeProfile,
        toolAllowlist: nextAllowlist,
      });
      await this.context.fetchMcpStatus(true);
      await this.context.appendHistoryLine("system", `Allowed tool '${toolId}'.`);
      return;
    }

    if (subcommand === "deny") {
      const toolId = rest[0];
      if (toolId === undefined || toolId.trim().length === 0) {
        await this.context.appendHistoryLine("system", "Usage: /mcp deny <toolId>");
        return;
      }

      const state = this.context.uiStore.getState();
      const nextAllowlist = (state.activeProfile.toolAllowlist ?? []).filter((name) => name !== toolId);
      await this.context.persistActiveProfile({
        ...state.activeProfile,
        toolAllowlist: nextAllowlist,
      });
      await this.context.fetchMcpStatus(true);
      await this.context.appendHistoryLine("system", `Denied tool '${toolId}'.`);
      return;
    }

    if (subcommand === "docker") {
      await this.handleMcpDocker(rest);
      return;
    }

    if (subcommand === "add") {
      await this.handleMcpAdd(rest);
      return;
    }

    if (subcommand === "remove") {
      const serverId = rest[0];
      if (serverId === undefined || serverId.trim().length === 0) {
        await this.context.appendHistoryLine("system", "Usage: /mcp remove <serverId>");
        return;
      }

      const state = this.context.uiStore.getState();
      const currentServers = state.activeProfile.mcpServers ?? [];
      const nextServers = currentServers.filter((server) => server.id !== serverId);
      const prefix = `mcp.${serverId}.`;
      const nextAllowlist = (state.activeProfile.toolAllowlist ?? []).filter((name) => name.startsWith(prefix) === false);
      await this.context.persistActiveProfile({
        ...state.activeProfile,
        mcpServers: nextServers,
        toolAllowlist: nextAllowlist,
      });
      await this.context.fetchMcpStatus(true);
      await this.context.appendHistoryLine("system", `Removed MCP server '${serverId}'.`);
      return;
    }

    await this.context.appendHistoryLine("system", `Unknown /mcp subcommand '${subcommand}'. Try '/mcp help'.`);
  }

  private async handleMcpDocker(args: string[]): Promise<void> {
    if (args.length > 1) {
      await this.context.appendHistoryLine("system", "Usage: /mcp docker [server]");
      return;
    }

    const dockerServer = (args[0] ?? "").trim();
    if (dockerServer.length > 0 && dockerServer.toLowerCase() === "default") {
      await this.context.appendHistoryLine(
        "system",
        "Docker MCP no longer supports '--profile default'; using default gateway config.",
      );
    }
    if (dockerServer.length === 0 || dockerServer.toLowerCase() === "default") {
      // Use Docker MCP Toolkit default config from Docker Desktop.
      // CLI no longer supports --profile.
    } else if (/^[a-zA-Z0-9._-]+$/u.test(dockerServer) === false) {
      await this.context.appendHistoryLine("system", "Server must match [a-zA-Z0-9._-]+.");
      return;
    }

    const state = this.context.uiStore.getState();
    const currentServers = state.activeProfile.mcpServers ?? [];
    const withoutExisting = currentServers.filter((server) => server.id !== MCP_DOCKER_GATEWAY_SERVER_ID);
    const gatewayArgs =
      dockerServer.length > 0 && dockerServer.toLowerCase() !== "default"
        ? ["mcp", "gateway", "run", "--servers", dockerServer]
        : ["mcp", "gateway", "run"];
    const dockerGatewayServer: McpServerConfig = {
      id: MCP_DOCKER_GATEWAY_SERVER_ID,
      transport: "stdio",
      command: "docker",
      args: gatewayArgs,
    };

    await this.context.persistActiveProfile({
      ...state.activeProfile,
      mcpServers: [...withoutExisting, dockerGatewayServer],
    });

    const discovered = await this.context.fetchMcpStatus(true);
    const discoveredTools = discovered.tools
      .filter((tool) => tool.serverId === MCP_DOCKER_GATEWAY_SERVER_ID)
      .map((tool) => tool.namespacedToolName);
    const uniqueDiscoveredTools = [...new Set(discoveredTools)];

    const refreshedState = this.context.uiStore.getState();
    const nextAllowlist = new Set(refreshedState.activeProfile.toolAllowlist ?? []);
    const allowlistBefore = nextAllowlist.size;
    for (const toolName of uniqueDiscoveredTools) {
      nextAllowlist.add(toolName);
    }
    const autoAllowedCount = Math.max(0, nextAllowlist.size - allowlistBefore);

    if (autoAllowedCount > 0) {
      await this.context.persistActiveProfile({
        ...refreshedState.activeProfile,
        toolAllowlist: [...nextAllowlist],
      });
    }

    const finalStatus = autoAllowedCount > 0 ? await this.context.fetchMcpStatus(true) : discovered;
    await this.context.appendHistoryLine(
      "system",
      `Docker MCP connected (server='${MCP_DOCKER_GATEWAY_SERVER_ID}'${dockerServer.length > 0 && dockerServer.toLowerCase() !== "default" ? `, filter='${dockerServer}'` : ""}). discovered=${uniqueDiscoveredTools.length} autoAllowed=${autoAllowedCount}. ${summarizeMcpDetails(finalStatus)}`,
    );
  }

  private async handleMcpAdd(args: string[]): Promise<void> {
    const [transport, serverId, ...rest] = args;
    if (transport === undefined || serverId === undefined) {
      await this.context.appendHistoryLine(
        "system",
        "Usage: /mcp add <stdio|http|sse> <id> ...",
      );
      return;
    }
    if (/^[a-zA-Z0-9._-]+$/u.test(serverId) === false) {
      await this.context.appendHistoryLine(
        "system",
        "Server id must match [a-zA-Z0-9._-]+.",
      );
      return;
    }

    const state = this.context.uiStore.getState();
    const currentServers = state.activeProfile.mcpServers ?? [];
    const withoutExisting = currentServers.filter((server) => server.id !== serverId);

    let nextServer: McpServerConfig;
    if (transport === "stdio") {
      const [command, ...commandArgs] = rest;
      if (command === undefined || command.trim().length === 0) {
        await this.context.appendHistoryLine(
          "system",
          "Usage: /mcp add stdio <id> <command> [args...]",
        );
        return;
      }
      nextServer = {
        id: serverId,
        transport: "stdio",
        command,
        ...(commandArgs.length > 0 ? { args: commandArgs } : {}),
      };
    } else if (transport === "http" || transport === "sse") {
      const [url, ...flagTokens] = rest;
      if (url === undefined || url.trim().length === 0) {
        await this.context.appendHistoryLine(
          "system",
          `Usage: /mcp add ${transport} <id> <url> [--auth-env VAR] [--header-env Name=ENV]`,
        );
        return;
      }

      const parsed = parseMcpRemoteFlags(flagTokens);
      if (parsed.ok === false) {
        await this.context.appendHistoryLine("system", parsed.error);
        return;
      }

      nextServer = {
        id: serverId,
        transport,
        url,
        ...(parsed.authTokenEnv !== undefined ? { authTokenEnv: parsed.authTokenEnv } : {}),
        ...(parsed.headerEnvs !== undefined ? { headerEnvs: parsed.headerEnvs } : {}),
      };
    } else {
      await this.context.appendHistoryLine(
        "system",
        `Unsupported MCP transport '${transport}'. Use stdio, http, or sse.`,
      );
      return;
    }

    await this.context.persistActiveProfile({
      ...state.activeProfile,
      mcpServers: [...withoutExisting, nextServer],
    });
    const status = await this.context.fetchMcpStatus(true);
    await this.context.appendHistoryLine(
      "system",
      `Added MCP server '${serverId}' (${transport}). ${summarizeMcpDetails(status)}`,
    );
  }
}

export function summarizeMcpDetails(status: McpStatusSnapshot): string {
  const enabled = status.servers.filter((server) => server.enabled);
  if (enabled.length === 0) {
    return "no enabled servers";
  }
  const unhealthy = enabled.filter((server) => server.healthy === false);
  if (unhealthy.length === 0) {
    return `${enabled.length}/${enabled.length} healthy, tools=${status.tools.length}`;
  }

  return `${enabled.length - unhealthy.length}/${enabled.length} healthy, tools=${status.tools.length}, unhealthy=${unhealthy
    .map((server) => server.serverId)
    .join(",")}`;
}

export function parseMcpRemoteFlags(tokens: string[]):
  | {
      ok: true;
      authTokenEnv?: string | undefined;
      headerEnvs?: Record<string, string> | undefined;
    }
  | {
      ok: false;
      error: string;
    } {
  let authTokenEnv: string | undefined;
  const headerEnvs: Record<string, string> = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--auth-env") {
      const value = tokens[i + 1];
      if (value === undefined || value.trim().length === 0) {
        return {
          ok: false,
          error: "Flag --auth-env requires an env var name.",
        };
      }
      authTokenEnv = value;
      i += 1;
      continue;
    }

    if (token === "--header-env") {
      const value = tokens[i + 1];
      if (value === undefined || value.trim().length === 0) {
        return {
          ok: false,
          error: "Flag --header-env requires Name=ENV.",
        };
      }

      const equals = value.indexOf("=");
      if (equals <= 0 || equals === value.length - 1) {
        return {
          ok: false,
          error: "Flag --header-env must be formatted as Name=ENV.",
        };
      }

      const headerName = value.slice(0, equals);
      const envName = value.slice(equals + 1);
      headerEnvs[headerName] = envName;
      i += 1;
      continue;
    }

    return {
      ok: false,
      error: `Unknown MCP flag '${token}'. Supported: --auth-env, --header-env.`,
    };
  }

  return {
    ok: true,
    ...(authTokenEnv !== undefined ? { authTokenEnv } : {}),
    ...(Object.keys(headerEnvs).length > 0 ? { headerEnvs } : {}),
  };
}
