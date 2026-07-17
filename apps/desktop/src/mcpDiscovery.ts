import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DesktopMcpDiscoveryDiagnostic,
  DesktopMcpDiscoveryResult,
  DesktopMcpServerConfig,
  DesktopMcpToolSummary,
} from "./contracts.js";

type CommandResult = {
  stdout: string;
  stderr: string;
};

export type DesktopMcpCommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

type DiscoveryCandidate = {
  source: string;
  path: string;
};

type DiscoveryOptions = {
  homeDir?: string | undefined;
  readFileImpl?: ((filePath: string, encoding: "utf8") => Promise<string>) | undefined;
  runCommand?: DesktopMcpCommandRunner | undefined;
};

const execFileAsync = promisify(execFile);
const DOCKER_MCP_SERVER_ID = "docker-gw";
const DOCKER_TOOL_PREVIEW_LIMIT = 12;

export async function discoverMcpServersFromKnownConfigFiles(
  options: DiscoveryOptions = {},
): Promise<DesktopMcpDiscoveryResult> {
  const home = options.homeDir ?? homedir();
  const readFileImpl = options.readFileImpl ?? readFile;
  const runCommand = options.runCommand ?? runDesktopMcpCommand;
  const candidates = knownMcpConfigCandidates(home);
  const servers: DesktopMcpServerConfig[] = [];
  const diagnostics: DesktopMcpDiscoveryDiagnostic[] = [];

  for (const candidate of candidates) {
    try {
      const raw = await readFileImpl(candidate.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const discovered = parseDesktopMcpConfig(parsed, candidate.source, candidate.path);
      servers.push(...discovered);
      diagnostics.push({
        source: candidate.source,
        path: candidate.path,
        status: "read",
        message: `${discovered.length} server${discovered.length === 1 ? "" : "s"} discovered.`,
      });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        diagnostics.push({
          source: candidate.source,
          path: candidate.path,
          status: "missing",
        });
        continue;
      }
      diagnostics.push({
        source: candidate.source,
        path: candidate.path,
        status: nodeError instanceof SyntaxError ? "invalid" : "error",
        message: nodeError.message,
      });
    }
  }

  const dockerDiscovery = await discoverDockerMcpToolkit(runCommand);
  servers.push(...dockerDiscovery.servers);
  diagnostics.push(...dockerDiscovery.diagnostics);

  return {
    servers,
    diagnostics,
    discoveredAt: new Date().toISOString(),
  };
}

export function parseDesktopMcpConfig(
  input: unknown,
  source: string,
  sourcePath: string,
): DesktopMcpServerConfig[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [];
  }
  const record = input as Record<string, unknown>;
  const serverRecord = isRecord(record.mcpServers)
    ? record.mcpServers
    : isRecord(record.servers)
      ? record.servers
      : isRecord(record.mcp)
        ? record.mcp
        : undefined;
  if (serverRecord === undefined) {
    return [];
  }

  return Object.entries(serverRecord)
    .map(([id, value]) => parseDesktopMcpServer(id, value, source, sourcePath))
    .filter((server): server is DesktopMcpServerConfig => server !== undefined);
}

async function discoverDockerMcpToolkit(
  runCommand: DesktopMcpCommandRunner,
): Promise<{
  servers: DesktopMcpServerConfig[];
  diagnostics: DesktopMcpDiscoveryDiagnostic[];
}> {
  const diagnostics: DesktopMcpDiscoveryDiagnostic[] = [];
  const dockerPath = "docker mcp";

  try {
    await runCommand("docker", ["mcp", "version"]);
  } catch (error) {
    diagnostics.push({
      source: "Docker MCP Toolkit",
      path: dockerPath,
      status: "missing",
      message: formatCommandError(error),
    });
    return { servers: [], diagnostics };
  }

  let clientState: string | undefined;
  try {
    const clientResult = await runCommand("docker", ["mcp", "client", "ls"]);
    clientState = compactCommandOutput(clientResult.stdout);
    diagnostics.push({
      source: "Docker MCP Toolkit",
      path: "docker mcp client ls",
      status: "read",
      ...(clientState.length > 0 ? { message: clientState } : {}),
    });
  } catch (error) {
    diagnostics.push({
      source: "Docker MCP Toolkit",
      path: "docker mcp client ls",
      status: "error",
      message: formatCommandError(error),
    });
  }

  let toolResult: CommandResult;
  try {
    toolResult = await runCommand("docker", ["mcp", "tools", "ls", "--format", "json"]);
  } catch (error) {
    diagnostics.push({
      source: "Docker MCP Toolkit",
      path: "docker mcp tools ls --format json",
      status: "error",
      message: formatCommandError(error),
    });
    return { servers: [], diagnostics };
  }

  const parsedTools = parseDockerMcpTools(toolResult.stdout);
  if (parsedTools === undefined) {
    diagnostics.push({
      source: "Docker MCP Toolkit",
      path: "docker mcp tools ls --format json",
      status: "invalid",
      message: "Docker MCP tools output was not a JSON array.",
    });
    return { servers: [], diagnostics };
  }

  diagnostics.push({
    source: "Docker MCP Toolkit",
    path: "docker mcp tools ls --format json",
    status: "read",
    message: `${parsedTools.length} tool${parsedTools.length === 1 ? "" : "s"} discovered.`,
  });

  if (parsedTools.length === 0) {
    return { servers: [], diagnostics };
  }

  const dockerServer: DesktopMcpServerConfig = {
    id: DOCKER_MCP_SERVER_ID,
    name: "Docker MCP Toolkit",
    transport: "stdio",
    command: "docker",
    args: ["mcp", "gateway", "run"],
    enabled: true,
    source: "Docker MCP Toolkit",
    sourceKind: "docker-toolkit",
    sourcePath: dockerPath,
    toolCount: parsedTools.length,
    tools: parsedTools.slice(0, DOCKER_TOOL_PREVIEW_LIMIT),
    ...(clientState !== undefined && clientState.length > 0 ? { setupWarning: clientState } : {}),
  };

  return { servers: [dockerServer], diagnostics };
}

export function parseDockerMcpTools(raw: string): DesktopMcpToolSummary[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ;
  }

  if (Array.isArray(parsed) === false) {
    return ;
  }

  const tools: DesktopMcpToolSummary[] = [];
  for (const item of parsed) {
    if (isRecord(item) === false) {
      continue;
    }
    const name = readString(item, "name");
    if (name === undefined || name.trim().length === 0) {
      continue;
    }
    const description = readString(item, "description");
    tools.push({
      name,
      ...(description !== undefined && description.trim().length > 0
        ? { description: description.trim() }
        : {}),
    });
  }
  return tools;
}

function knownMcpConfigCandidates(home: string): DiscoveryCandidate[] {
  return [
    {
      source: "Claude Desktop",
      path: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    },
    {
      source: "Cursor",
      path: path.join(home, ".cursor", "mcp.json"),
    },
    {
      source: "Cursor",
      path: path.join(home, "Library", "Application Support", "Cursor", "User", "mcp.json"),
    },
    {
      source: "Codex",
      path: path.join(home, ".codex", "mcp.json"),
    },
    {
      source: "Codex",
      path: path.join(home, ".codex", "mcp_servers.json"),
    },
  ];
}

async function runDesktopMcpCommand(command: string, args: string[]): Promise<CommandResult> {
  const result = await execFileAsync(command, args, {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseDesktopMcpServer(
  id: string,
  input: unknown,
  source: string,
  sourcePath: string,
): DesktopMcpServerConfig | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return ;
  }
  const record = input as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : undefined;
  const url = typeof record.url === "string" ? record.url : undefined;
  const transport = record.transport === "http" || record.transport === "sse"
    ? record.transport
    : "stdio";
  if (command === undefined && url === undefined) {
    return ;
  }
  return {
    id,
    name: typeof record.name === "string" ? record.name : id,
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(Array.isArray(record.args) ? { args: record.args.filter((arg): arg is string => typeof arg === "string") } : {}),
    ...(isStringRecord(record.env) ? { env: record.env } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(typeof record.cwd === "string" ? { workingDirectory: record.cwd } : {}),
    ...(typeof record.workingDirectory === "string" ? { workingDirectory: record.workingDirectory } : {}),
    enabled: record.enabled !== false,
    source,
    sourceKind: "config-file",
    sourcePath,
  };
}

function compactCommandOutput(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "").trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function formatCommandError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (isRecord(value) === false) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}
