import assert from "node:assert/strict";

import type { AuthorizedMcpServer } from "../src/contracts.js";
import { buildOciDockerRunCommand } from "../src/oci-runtime.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

const digest = `sha256:${"a".repeat(64)}`;
const server: Extract<AuthorizedMcpServer, { sourceType: "oci" }> = {
  id: "server-network",
  name: "Network MCP",
  sourceType: "oci",
  transport: "stdio",
  imageReference: `ghcr.io/kestrel/network@${digest}`,
  digest,
  launchArguments: [],
  networkAccess: "full",
  resources: { cpuMillicores: 250, memoryMib: 256, pidsLimit: 64 },
  credential: undefined,
};

contractTest("services.hermetic", "OCI MCP networking is full or none without proxy policy", () => {
  const full = buildOciDockerRunCommand({
    grantId: "grant-full",
    server,
    workspacePath: "/workspace",
  });
  const none = buildOciDockerRunCommand({
    grantId: "grant-none",
    server: { ...server, networkAccess: "none" },
    workspacePath: "/workspace",
  });

  assert.deepEqual(option(full.args, "--network"), ["bridge"]);
  assert.deepEqual(option(none.args, "--network"), ["none"]);
  assert.equal(full.args.some((argument) => /proxy/iu.test(argument)), false);
  assert.equal(none.args.some((argument) => /proxy/iu.test(argument)), false);
});

function option(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return [args[index + 1] ?? ""];
}
