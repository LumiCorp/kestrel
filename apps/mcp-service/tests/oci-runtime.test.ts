import assert from "node:assert/strict";
import test from "node:test";

import type { AuthorizedMcpServer } from "../src/contracts.js";
import { buildOciDockerRunCommand } from "../src/oci-runtime.js";

const digest = `sha256:${"a".repeat(64)}`;
const server: Extract<AuthorizedMcpServer, { sourceType: "oci" }> = {
  id: "server-1",
  name: "Filesystem MCP",
  sourceType: "oci",
  transport: "stdio",
  imageReference: `ghcr.io/kestrel/filesystem@${digest}`,
  digest,
  launchArguments: ["--stdio"],
  egressAllowlist: [],
  resources: { cpuMillicores: 250, memoryMib: 384, pidsLimit: 64 },
  credential: undefined,
};

test("OCI MCP command is per-run, read-only, resource-limited, and default-deny", () => {
  const command = buildOciDockerRunCommand({
    grantId: "grant-1",
    server,
    workspacePath: "/srv/kestrel/workspaces/workspace-1",
  });

  assert.equal(command.command, "docker");
  assert.deepEqual(command.args.slice(0, 3), [
    "run",
    "--rm",
    "--interactive",
  ]);
  assert.deepEqual(option(command.args, "--network"), ["none"]);
  assert.equal(command.args.includes("--read-only"), true);
  assert.deepEqual(option(command.args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(option(command.args, "--security-opt"), [
    "no-new-privileges:true",
  ]);
  assert.deepEqual(option(command.args, "--pids-limit"), ["64"]);
  assert.deepEqual(option(command.args, "--memory"), ["384m"]);
  assert.deepEqual(option(command.args, "--cpus"), ["0.25"]);
  assert.deepEqual(option(command.args, "--mount"), [
    "type=bind,src=/srv/kestrel/workspaces/workspace-1,dst=/workspace,readonly",
  ]);
  assert.equal(command.args.includes(server.imageReference), true);
  assert.equal(command.args.at(-1), "--stdio");
});

test("OCI MCP requires a broker lease for egress and rejects mutable images", () => {
  assert.throws(
    () =>
      buildOciDockerRunCommand({
        grantId: "grant-1",
        server: { ...server, egressAllowlist: ["https://api.example.com"] },
        workspacePath: "/workspace",
      }),
    /requires an isolated egress broker lease/u
  );
  assert.throws(
    () =>
      buildOciDockerRunCommand({
        grantId: "grant-1",
        server: {
          ...server,
          imageReference: "ghcr.io/kestrel/filesystem:latest",
        },
        workspacePath: "/workspace",
      }),
    /must be pinned/u
  );
});

test("OCI MCP with egress can reach only its broker on an internal network", () => {
  const command = buildOciDockerRunCommand({
    grantId: "grant-1",
    server: { ...server, egressAllowlist: ["https://api.example.com"] },
    workspacePath: "/workspace",
    networkName: "kestrel-mcp-net-grant-1",
    proxyUrl: "http://kestrel-egress-broker:8080",
  });
  assert.deepEqual(option(command.args, "--network"), [
    "kestrel-mcp-net-grant-1",
  ]);
  assert.equal(
    command.args.includes("HTTPS_PROXY=http://kestrel-egress-broker:8080"),
    true
  );
  assert.equal(command.args.includes("--network=bridge"), false);
});

function option(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return [args[index + 1] ?? ""];
}
