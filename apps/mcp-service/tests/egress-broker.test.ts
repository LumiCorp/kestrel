import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHttpsOrigin } from "../src/egress-broker.js";
import { buildOciEgressBrokerCommands } from "../src/oci-egress-runtime.js";

test("OCI egress broker topology isolates the MCP container network", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  const commands = buildOciEgressBrokerCommands({
    networkName: "kestrel-mcp-net-run",
    brokerName: "kestrel-mcp-egress-run",
    brokerImage: `ghcr.io/kestrel/mcp-service@${digest}`,
    allowlist: ["https://api.example.com"],
  });
  assert.deepEqual(commands.start[0], [
    "network",
    "create",
    "--internal",
    "kestrel-mcp-net-run",
  ]);
  assert.deepEqual(commands.start[2], [
    "network",
    "connect",
    "bridge",
    "kestrel-mcp-egress-run",
  ]);
  assert.equal(commands.start[1]?.includes("--read-only"), true);
  assert.equal(commands.start[1]?.includes("--no-healthcheck"), true);
  assert.equal(commands.start[1]?.includes("--cap-drop"), true);
  assert.equal(
    commands.start[1]?.includes(
      'KESTREL_MCP_EGRESS_ALLOWLIST=["https://api.example.com"]'
    ),
    true
  );
  assert.equal(commands.start[1]?.includes("PORT=8080"), true);
});

test("OCI egress allowlists accept only credential-free HTTPS origins", () => {
  assert.equal(
    normalizeHttpsOrigin("https://api.example.com/v1"),
    "https://api.example.com"
  );
  assert.throws(() => normalizeHttpsOrigin("http://api.example.com"), /HTTPS/u);
  assert.throws(
    () => normalizeHttpsOrigin("https://token@api.example.com"),
    /HTTPS/u
  );
});
