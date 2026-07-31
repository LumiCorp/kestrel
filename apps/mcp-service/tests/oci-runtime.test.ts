import assert from "node:assert/strict";

import type { AuthorizedMcpServer } from "../src/contracts.js";
import { buildOciDockerRunCommand } from "../src/oci-runtime.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const digest = `sha256:${"a".repeat(64)}`;
const server: Extract<AuthorizedMcpServer, { sourceType: "oci" }> = {
  id: "server-1",
  name: "Filesystem MCP",
  sourceType: "oci",
  transport: "stdio",
  imageReference: `ghcr.io/kestrel/filesystem@${digest}`,
  digest,
  launchArguments: ["--stdio"],
  networkAccess: "full",
  resources: { cpuMillicores: 250, memoryMib: 384, pidsLimit: 64 },
  credential: undefined,
};

contractTest("services.hermetic", "OCI MCP command is per-run, read-only, resource-limited, and defaults to full network", () => {
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
  assert.deepEqual(option(command.args, "--network"), ["bridge"]);
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

contractTest("services.hermetic", "OCI MCP rejects mutable images", () => {
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

contractTest("services.hermetic", "OCI MCP can be explicitly isolated from the network", () => {
  const command = buildOciDockerRunCommand({
    grantId: "grant-1",
    server: { ...server, networkAccess: "none" },
    workspacePath: "/workspace",
  });
  assert.deepEqual(option(command.args, "--network"), ["none"]);
});

function option(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return [args[index + 1] ?? ""];
}
