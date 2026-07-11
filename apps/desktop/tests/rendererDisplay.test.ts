import assert from "node:assert/strict";
import test from "node:test";
import { safeMcpEndpointDisplay } from "../renderer/src/McpWorkspace.js";
import { filterRuntimeRunIndexEntries } from "../renderer/src/RuntimeRunsWorkspace.js";
import type { DesktopRuntimeRunIndexEntry } from "../src/contracts.js";

test("MCP endpoint display strips credentials, query parameters, and fragments", () => {
  assert.equal(
    safeMcpEndpointDisplay(
      "https://user:secret@example.test/mcp?token=sensitive#private"
    ),
    "https://example.test/mcp"
  );
});

test("MCP endpoint display does not echo malformed endpoint input", () => {
  assert.equal(
    safeMcpEndpointDisplay("token=sensitive"),
    "Configured endpoint"
  );
});

test("runtime run index search covers run, session, thread, and diagnosis fields", () => {
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
