import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverMcpServersFromKnownConfigFiles,
  parseDesktopMcpConfig,
  parseDockerMcpTools,
  type DesktopMcpCommandRunner,
} from "../src/mcpDiscovery.js";

test("parseDesktopMcpConfig discovers config-file MCP servers", () => {
  const servers = parseDesktopMcpConfig(
    {
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-playwright"],
        },
        weather: {
          transport: "sse",
          url: "https://example.test/mcp/events",
          enabled: false,
        },
      },
    },
    "Claude Desktop",
    "/Users/test/Library/Application Support/Claude/claude_desktop_config.json",
  );

  assert.deepEqual(servers, [
    {
      id: "playwright",
      name: "playwright",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-playwright"],
      enabled: true,
      source: "Claude Desktop",
      sourceKind: "config-file",
      sourcePath: "/Users/test/Library/Application Support/Claude/claude_desktop_config.json",
    },
    {
      id: "weather",
      name: "weather",
      transport: "sse",
      url: "https://example.test/mcp/events",
      enabled: false,
      source: "Claude Desktop",
      sourceKind: "config-file",
      sourcePath: "/Users/test/Library/Application Support/Claude/claude_desktop_config.json",
    },
  ]);
});

test("parseDockerMcpTools maps Docker JSON tools into capability summaries", () => {
  const tools = parseDockerMcpTools(JSON.stringify([
    {
      name: "github_create_issue",
      description: "Create a GitHub issue.",
      inputSchema: { type: "object" },
    },
    {
      name: "filesystem_read",
      description: "",
    },
  ]));

  assert.deepEqual(tools, [
    {
      name: "github_create_issue",
      description: "Create a GitHub issue.",
    },
    {
      name: "filesystem_read",
    },
  ]);
});

test("discoverMcpServersFromKnownConfigFiles includes Docker MCP Toolkit when tools are available", async () => {
  const runCommand: DesktopMcpCommandRunner = async (_command, args) => {
    const command = args.join(" ");
    if (command === "mcp version") {
      return { stdout: "Docker MCP Toolkit version 1.0.0\n", stderr: "" };
    }
    if (command === "mcp client ls") {
      return {
        stdout: "=== Project-wide MCP Configurations ===\ncodex: disconnected\n",
        stderr: "",
      };
    }
    if (command === "mcp tools ls --format json") {
      return {
        stdout: JSON.stringify([
          { name: "github_create_issue", description: "Create a GitHub issue." },
          { name: "tavily_search", description: "Search the web." },
        ]),
        stderr: "",
      };
    }
    throw new Error(`unexpected command ${command}`);
  };

  const result = await discoverMcpServersFromKnownConfigFiles({
    homeDir: "/Users/test",
    readFileImpl: async () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    runCommand,
  });

  const dockerServer = result.servers.find((server) => server.id === "docker-gw");
  assert.deepEqual(dockerServer, {
    id: "docker-gw",
    name: "Docker MCP Toolkit",
    transport: "stdio",
    command: "docker",
    args: ["mcp", "gateway", "run"],
    enabled: true,
    source: "Docker MCP Toolkit",
    sourceKind: "docker-toolkit",
    sourcePath: "docker mcp",
    toolCount: 2,
    tools: [
      { name: "github_create_issue", description: "Create a GitHub issue." },
      { name: "tavily_search", description: "Search the web." },
    ],
    setupWarning: "=== Project-wide MCP Configurations === | codex: disconnected",
  });
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.source === "Docker MCP Toolkit" &&
        diagnostic.path === "docker mcp tools ls --format json" &&
        diagnostic.status === "read",
    ),
    true,
  );
});

test("discoverMcpServersFromKnownConfigFiles returns diagnostics when Docker MCP is unavailable", async () => {
  const runCommand: DesktopMcpCommandRunner = async () => {
    throw new Error("docker command failed");
  };

  const result = await discoverMcpServersFromKnownConfigFiles({
    homeDir: "/Users/test",
    readFileImpl: async () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    runCommand,
  });

  assert.equal(result.servers.some((server) => server.id === "docker-gw"), false);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.source === "Docker MCP Toolkit" &&
        diagnostic.path === "docker mcp" &&
        diagnostic.status === "missing" &&
        diagnostic.message === "docker command failed",
    ),
    true,
  );
});
