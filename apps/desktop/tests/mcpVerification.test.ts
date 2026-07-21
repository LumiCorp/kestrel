import assert from "node:assert/strict";
import test from "node:test";

import { parseDesktopMcpServerMutationInput } from "../../../src/desktopShell/contracts.js";
import {
  completeDesktopMcpVerification,
  prepareDesktopMcpVerification,
} from "../src/mcpVerification.js";

test("MCP mutation parser rejects unknown fields and malformed endpoints", () => {
  assert.throws(
    () => parseDesktopMcpServerMutationInput({ id: "example", name: "Example", transport: "http", url: "file:///tmp/server", enabled: true }),
    /HTTP or HTTPS/u,
  );
  assert.throws(
    () => parseDesktopMcpServerMutationInput({ id: "example", name: "Example", transport: "stdio", command: "server", enabled: true, env: { SECRET: "value" } }),
    /unsupported field 'env'/u,
  );
});

test("MCP verification preparation carries only credential references into the live request", () => {
  const input = parseDesktopMcpServerMutationInput({
    id: "example",
    name: "Example",
    transport: "http",
    url: "https://mcp.example.test/",
    credentials: [{ kind: "bearer", secret: "candidate-token" }],
    enabled: true,
  });
  const prepared = prepareDesktopMcpVerification(input);
  assert.equal(prepared.request.credentials.length, 1);
  assert.equal(prepared.request.credentials[0]?.secret, "candidate-token");
  assert.equal(JSON.stringify(prepared.bindings).includes("candidate-token"), false);

  const server = completeDesktopMcpVerification(input, prepared.bindings, {
    serverId: "example",
    verifiedAt: "2026-07-20T12:00:00.000Z",
    credentials: prepared.bindings.map((binding) => ({
      credentialId: binding.credentialId,
      configured: true,
    })),
    tools: [{ name: "lookup", description: "Look up a record." }],
  });
  assert.equal(server.sourceKind, "desktop-managed");
  assert.deepEqual(server.tools, [{
    name: "lookup",
    description: "Look up a record.",
    approvalMode: "ask",
    allowedInteractionModes: ["build"],
  }]);
});
