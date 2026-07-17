import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuthorizedMcpServer } from "./contracts.js";

const execFileAsync = promisify(execFile);
const DIGEST_PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/u;

export type OciEgressLease = {
  networkName: string;
  proxyUrl: string;
  close(): Promise<void>;
};

export async function startOciEgressBroker(input: {
  grantId: string;
  server: Extract<AuthorizedMcpServer, { sourceType: "oci" }>;
  runtimeCommand?: string | undefined;
  brokerImage?: string | undefined;
}): Promise<OciEgressLease | undefined> {
  if (input.server.egressAllowlist.length === 0) return;
  const brokerImage = input.brokerImage?.trim();
  if (!(brokerImage && DIGEST_PINNED_IMAGE.test(brokerImage))) {
    throw new Error(
      "KESTREL_MCP_EGRESS_BROKER_IMAGE must be a digest-pinned image when OCI egress is enabled."
    );
  }
  const runtime = input.runtimeCommand ?? "docker";
  const suffix = sanitize(`${input.grantId}-${input.server.id}`).slice(-42);
  const networkName = `kestrel-mcp-net-${suffix}`;
  const brokerName = `kestrel-mcp-egress-${suffix}`;
  const commands = buildOciEgressBrokerCommands({
    networkName,
    brokerName,
    brokerImage,
    allowlist: input.server.egressAllowlist,
  });
  try {
    for (const args of commands.start) await execFileAsync(runtime, args);
  } catch (error) {
    await cleanup(runtime, commands.stop);
    throw error;
  }
  return {
    networkName,
    proxyUrl: "http://kestrel-egress-broker:8080",
    close: () => cleanup(runtime, commands.stop),
  };
}

export function buildOciEgressBrokerCommands(input: {
  networkName: string;
  brokerName: string;
  brokerImage: string;
  allowlist: string[];
}) {
  return {
    start: [
      ["network", "create", "--internal", input.networkName],
      [
        "run",
        "--detach",
        "--rm",
        "--no-healthcheck",
        "--name",
        input.brokerName,
        "--network",
        input.networkName,
        "--network-alias",
        "kestrel-egress-broker",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "65532:65532",
        "--pids-limit",
        "64",
        "--memory",
        "128m",
        "--cpus",
        "0.25",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--env",
        `KESTREL_MCP_EGRESS_ALLOWLIST=${JSON.stringify(input.allowlist)}`,
        "--env",
        "PORT=8080",
        input.brokerImage,
        "node",
        "dist/egress-broker-main.js",
      ],
      ["network", "connect", "bridge", input.brokerName],
    ],
    stop: [
      ["rm", "--force", input.brokerName],
      ["network", "rm", input.networkName],
    ],
  };
}

async function cleanup(runtime: string, commands: string[][]) {
  for (const args of commands) {
    await execFileAsync(runtime, args).catch(() => {});
  }
}

function sanitize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/gu, "-");
}
