import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { AuthorizedMcpGrant, AuthorizedMcpServer } from "./contracts.js";
import { createMcpHostClient } from "./host-capabilities.js";
import type { McpInteractionCoordinator } from "./interaction-coordinator.js";
import { startOciEgressBroker } from "./oci-egress-runtime.js";

const DIGEST_PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/u;

export async function connectOciMcpClient(input: {
  grant: AuthorizedMcpGrant;
  server: Extract<AuthorizedMcpServer, { sourceType: "oci" }>;
  workspaceBasePath: string | undefined;
  runtimeCommand?: string | undefined;
  interactions?: {
    grant: AuthorizedMcpGrant;
    serverId: string;
    coordinator: McpInteractionCoordinator;
  } | undefined;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  if (input.server.transport !== "stdio") {
    throw new Error("OCI Streamable HTTP transport is not yet available.");
  }
  const workspacePath = await resolveWorkspacePath({
    workspaceBasePath: input.workspaceBasePath,
    workspaceId: input.grant.workspaceId,
  });
  return connectOciAtWorkspace({
    grantId: input.grant.id,
    server: input.server,
    workspacePath,
    runtimeCommand: input.runtimeCommand,
    roots: [{ uri: "file:///workspace", name: "Project workspace" }],
    interactions: input.interactions,
  });
}

export async function connectOciMcpDiscoveryClient(input: {
  jobId: string;
  server: Extract<AuthorizedMcpServer, { sourceType: "oci" }>;
  runtimeCommand?: string | undefined;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-mcp-discovery-")
  );
  try {
    const connected = await connectOciAtWorkspace({
      grantId: `discovery-${input.jobId}`,
      server: input.server,
      workspacePath,
      runtimeCommand: input.runtimeCommand,
    });
    return {
      client: connected.client,
      close: async () => {
        await connected.close().catch(() => {});
        await rm(workspacePath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

async function connectOciAtWorkspace(input: {
  grantId: string;
  server: Extract<AuthorizedMcpServer, { sourceType: "oci" }>;
  workspacePath: string;
  runtimeCommand?: string | undefined;
  roots?: Array<{ uri: string; name: string }> | undefined;
  interactions?: Parameters<typeof createMcpHostClient>[0]["interactions"];
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const egress = await startOciEgressBroker({
    grantId: input.grantId,
    server: input.server,
    runtimeCommand: input.runtimeCommand,
    brokerImage: process.env.KESTREL_MCP_EGRESS_BROKER_IMAGE,
  });
  const command = buildOciDockerRunCommand({
    ...input,
    ...(egress
      ? { networkName: egress.networkName, proxyUrl: egress.proxyUrl }
      : {}),
  });
  const transport = new StdioClientTransport({
    command: command.command,
    args: command.args,
    stderr: "pipe",
  });
  const client = createMcpHostClient({
    name: "kestrel-one-mcp-oci-host",
    authorizedHostCapabilities: input.interactions
      ? input.interactions.grant.capabilities.flatMap((capability) =>
          capability.serverId === input.interactions?.serverId &&
          (capability.kind === "root" ||
            capability.kind === "sampling" ||
            capability.kind === "elicitation")
            ? [capability.kind]
            : []
        )
      : [],
    roots: input.roots,
    interactions: input.interactions,
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await egress?.close().catch(() => {});
    throw error;
  }
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await egress?.close().catch(() => {});
    },
  };
}

export function buildOciDockerRunCommand(input: {
  grantId: string;
  server: Extract<AuthorizedMcpServer, { sourceType: "oci" }>;
  workspacePath: string;
  runtimeCommand?: string | undefined;
  networkName?: string | undefined;
  proxyUrl?: string | undefined;
}): { command: string; args: string[] } {
  const { server } = input;
  if (!DIGEST_PINNED_IMAGE.test(server.imageReference)) {
    throw new Error("OCI MCP image must be pinned to a sha256 digest.");
  }
  if (!server.imageReference.endsWith(`@${server.digest}`)) {
    throw new Error("OCI MCP image reference does not match its digest.");
  }
  if (server.credential) {
    throw new Error("OCI stdio MCP servers cannot receive remote credentials.");
  }
  if (
    server.egressAllowlist.length > 0 &&
    !(input.networkName && input.proxyUrl)
  ) {
    throw new Error(
      "OCI MCP egress requires an isolated egress broker lease."
    );
  }
  const containerName = `kestrel-mcp-${sanitizeName(input.grantId)}-${sanitizeName(server.id)}`.slice(
    0,
    63
  );
  return {
    command: input.runtimeCommand ?? "docker",
    args: [
      "run",
      "--rm",
      "--interactive",
      "--name",
      containerName,
      "--network",
      input.networkName ?? "none",
      ...(input.proxyUrl
        ? [
            "--env",
            `HTTPS_PROXY=${input.proxyUrl}`,
            "--env",
            `https_proxy=${input.proxyUrl}`,
            "--env",
            `HTTP_PROXY=${input.proxyUrl}`,
            "--env",
            `http_proxy=${input.proxyUrl}`,
            "--env",
            "NO_PROXY=localhost,127.0.0.1",
          ]
        : []),
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      "65532:65532",
      "--pids-limit",
      String(server.resources.pidsLimit),
      "--memory",
      `${server.resources.memoryMib}m`,
      "--cpus",
      String(server.resources.cpuMillicores / 1000),
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--mount",
      `type=bind,src=${input.workspacePath},dst=/workspace,readonly`,
      "--workdir",
      "/workspace",
      server.imageReference,
      ...server.launchArguments,
    ],
  };
}

async function resolveWorkspacePath(input: {
  workspaceBasePath: string | undefined;
  workspaceId: string;
}): Promise<string> {
  if (!input.workspaceBasePath) {
    throw new Error("KESTREL_MCP_WORKSPACE_ROOT is required for OCI MCP servers.");
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(input.workspaceId)) {
    throw new Error("MCP workspace identity is invalid.");
  }
  const base = await realpath(input.workspaceBasePath);
  const workspace = await realpath(path.join(base, input.workspaceId));
  if (!workspace.startsWith(`${base}${path.sep}`)) {
    throw new Error("MCP workspace path escaped its configured root.");
  }
  return workspace;
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/gu, "-");
}
