import test from "node:test";
import assert from "node:assert/strict";

import type { AuthorizedMcpServer } from "../src/contracts.js";
import { buildOciDockerRunCommand } from "../src/oci-runtime.js";

const digest = `sha256:${"a".repeat(64)}`;
const server: Extract<AuthorizedMcpServer, { sourceType: "oci" }> = {
  id: "server-network",
  name: "Network MCP",
  sourceType: "oci",
  transport: "stdio",
  imageReference: `ghcr.io/kestrel/network@${digest}`,
  digest,
  launchArguments: [],
  networkAccess: "none",
  egressBinding: {
    version: 1,
    source: "custom",
    organizationId: "org-1",
    environmentId: "env-1",
    serverId: "server-network",
    imageDigest: digest,
    policyRevision: "custom:server-network",
    policyDigest:
      "sha256:59704c11b4f9b612e75f68fac891e4dca743d52d7a946d6d64db287c7b620633",
    policy: { version: 1, mode: "none" },
  },
  resources: { cpuMillicores: 250, memoryMib: 256, pidsLimit: 64 },
  credential: undefined,
};

test("OCI MCP none and allow_hosts remain network-off before gateway enforcement", () => {
  const none = buildOciDockerRunCommand({
    grantId: "grant-none",
    server,
    workspacePath: "/workspace",
  });
  const allowHosts = buildOciDockerRunCommand({
    grantId: "grant-allow-hosts",
    server: {
      ...server,
      egressBinding: {
        ...server.egressBinding,
        policyDigest:
          "sha256:19266371f90d4277d566a4a3e701fb572230629041b828638320648151d41773",
        policy: {
          version: 1,
          mode: "allow_hosts",
          destinations: [
            { hostname: "api.example.com", port: 443, protocol: "https" },
          ],
        },
      },
    },
    workspacePath: "/workspace",
  });

  assert.deepEqual(option(none.args, "--network"), ["none"]);
  assert.deepEqual(option(allowHosts.args, "--network"), ["none"]);
  assert.equal(
    none.args.some((argument) => /proxy/iu.test(argument)),
    false,
  );
  assert.equal(
    allowHosts.args.some((argument) => /proxy/iu.test(argument)),
    false,
  );
});

function option(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return [args[index + 1] ?? ""];
}
