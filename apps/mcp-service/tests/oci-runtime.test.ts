import test from "node:test";
import assert from "node:assert/strict";

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
  networkAccess: "none",
  egressBinding: {
    version: 1,
    source: "custom",
    organizationId: "org-1",
    environmentId: "env-1",
    serverId: "server-1",
    imageDigest: digest,
    policyRevision: "custom:server-1",
    policyDigest:
      "sha256:59704c11b4f9b612e75f68fac891e4dca743d52d7a946d6d64db287c7b620633",
    policy: { version: 1, mode: "none" },
  },
  resources: { cpuMillicores: 250, memoryMib: 384, pidsLimit: 64 },
  credential: undefined,
};

test("OCI MCP command is per-run, read-only, resource-limited, and defaults to no network", () => {
  const command = buildOciDockerRunCommand({
    grantId: "grant-1",
    server,
    workspacePath: "/srv/kestrel/workspaces/workspace-1",
  });

  assert.equal(command.command, "docker");
  assert.deepEqual(command.args.slice(0, 3), ["run", "--rm", "--interactive"]);
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

test("OCI MCP rejects mutable images", () => {
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
    /must be pinned/u,
  );
});

test("OCI MCP bridge access requires the exact unrestricted binding", () => {
  const command = buildOciDockerRunCommand({
    grantId: "grant-1",
    server: {
      ...server,
      networkAccess: "full",
      egressBinding: {
        ...server.egressBinding,
        policyDigest:
          "sha256:670784f711937cc335266433561a1591174221b47eb40c4bad53ce151294232c",
        policy: {
          version: 1,
          mode: "unrestricted",
          acknowledgedRisk: true,
          justification: "legacy development dependency",
        },
      },
    },
    workspacePath: "/workspace",
  });
  assert.deepEqual(option(command.args, "--network"), ["bridge"]);
});

test("OCI MCP launch rejects disagreement with the network projection", () => {
  assert.throws(
    () =>
      buildOciDockerRunCommand({
        grantId: "grant-1",
        server: { ...server, networkAccess: "full" },
        workspacePath: "/workspace",
      }),
    /egress binding does not match/u,
  );
});

function option(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return [args[index + 1] ?? ""];
}
