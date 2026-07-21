import assert from "node:assert/strict";
import { buildMcpMutationInput, safeMcpEndpointDisplay } from "../renderer/src/McpWorkspace.js";
import { filterRuntimeRunIndexEntries } from "../renderer/src/RuntimeRunsWorkspace.js";
import type { DesktopRuntimeRunIndexEntry } from "../src/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "MCP endpoint display strips credentials, query parameters, and fragments", () => {
  assert.equal(
    safeMcpEndpointDisplay(
      "https://user:secret@example.test/mcp?token=sensitive#private"
    ),
    "https://example.test/mcp"
  );
});

contractTest("desktop.hermetic", "MCP endpoint display does not echo malformed endpoint input", () => {
  assert.equal(
    safeMcpEndpointDisplay("token=sensitive"),
    "Configured endpoint"
  );
});

contractTest("desktop.hermetic", "MCP runtime mutations preserve credential references without leaking renderer-only status", () => {
  const input = buildMcpMutationInput({
    id: "company",
    name: "Company tools",
    transport: "http",
    url: "https://mcp.example.test/",
    enabled: false,
    source: "Desktop settings",
    sourceKind: "desktop-managed",
    credentials: [{
      kind: "header",
      name: "X-API-Key",
      credentialId: "mcp.company.header.x-api-key",
      envKey: "KESTREL_MCP_COMPANY_X_API_KEY",
      configured: true,
    }],
    tools: [{ name: "lookup", approvalMode: "ask", allowedInteractionModes: ["build"] }],
  }, false);

  assert.deepEqual(input.credentials, [{
    kind: "header",
    name: "X-API-Key",
    credentialId: "mcp.company.header.x-api-key",
    envKey: "KESTREL_MCP_COMPANY_X_API_KEY",
  }]);
  assert.equal(JSON.stringify(input).includes("configured"), false);
  assert.equal(input.enabled, false);
});

contractTest("desktop.hermetic", "runtime run index search covers run, session, thread, and diagnosis fields", () => {
  const runs: DesktopRuntimeRunIndexEntry[] = [{
    run: {
      runId: "run-public-cutover",
      sessionId: "session-desktop",
      eventType: "operator.cutover",
      status: "WAITING",
      startedAt: "2026-07-10T12:00:00.000Z",
    },
    threadId: "thread-package-proof",
    summary: { eventCount: 4, truncated: false },
    diagnosis: {
      status: "WAITING",
      finalStep: "exec.wait_approval",
      actionable: true,
      dominantFailure: {
        classification: "approval_wait",
        message: "Package proof requires approval.",
      },
    },
  }];

  assert.equal(filterRuntimeRunIndexEntries(runs, "desktop").length, 1);
  assert.equal(filterRuntimeRunIndexEntries(runs, "package-proof").length, 1);
  assert.equal(filterRuntimeRunIndexEntries(runs, "approval_wait").length, 1);
  assert.equal(filterRuntimeRunIndexEntries(runs, "missing").length, 0);
});
