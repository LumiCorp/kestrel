import assert from "node:assert/strict";
import {
  digestCanonicalJson,
  planMcpCapabilitySnapshot,
} from "./capability-snapshot";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "capability snapshot digests are independent of object key order", () => {
  assert.equal(
    digestCanonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    digestCanonicalJson({ a: { c: 3, d: 4 }, b: 2 })
  );
});

contractTest("web.hermetic", "new and changed MCP capabilities default disabled and deny", () => {
  const plan = planMcpCapabilitySnapshot({
    protocolVersion: "2025-11-25",
    discovered: [
      {
        kind: "tool",
        capabilityKey: "issues.create",
        toolCapabilityKey: "issues.create",
        definition: { inputSchema: { type: "object", required: ["title"] } },
      },
      {
        kind: "prompt",
        capabilityKey: "triage",
        definition: { arguments: [] },
      },
    ],
    previous: [
      {
        id: "old-tool",
        kind: "tool",
        capabilityKey: "issues.create",
        toolCapabilityKey: "issues.create",
        definition: { inputSchema: { type: "object" } },
        environmentEnabled: true,
        approvalMode: "auto",
      },
      {
        id: "removed-resource",
        kind: "resource",
        capabilityKey: "repo://old",
        definition: { uri: "repo://old" },
        environmentEnabled: true,
        approvalMode: "auto",
      },
    ],
  });
  assert.equal(plan.status, "pending_review");
  assert.deepEqual(
    plan.capabilities.map((capability) => ({
      key: capability.capabilityKey,
      change: capability.change,
      enabled: capability.environmentEnabled,
      approval: capability.approvalMode,
    })),
    [
      { key: "triage", change: "added", enabled: false, approval: "deny" },
      {
        key: "issues.create",
        change: "changed",
        enabled: false,
        approval: "deny",
      },
    ]
  );
  assert.deepEqual(
    plan.removed.map((capability) => capability.id),
    ["removed-resource"]
  );
});

contractTest("web.hermetic", "exactly unchanged capabilities retain reviewed Environment policy", () => {
  const definition = { inputSchema: { type: "object" } };
  const plan = planMcpCapabilitySnapshot({
    protocolVersion: "2025-11-25",
    discovered: [
      {
        kind: "tool",
        capabilityKey: "issues.list",
        toolCapabilityKey: "issues.list",
        definition,
      },
    ],
    previous: [
      {
        id: "previous-list",
        kind: "tool",
        capabilityKey: "issues.list",
        toolCapabilityKey: "issues.list",
        definition,
        environmentEnabled: true,
        approvalMode: "ask",
      },
    ],
  });
  assert.deepEqual(plan.capabilities[0], {
    kind: "tool",
    capabilityKey: "issues.list",
    toolCapabilityKey: "issues.list",
    definition,
    definitionDigest: digestCanonicalJson(definition),
    environmentEnabled: true,
    approvalMode: "ask",
    change: "unchanged",
    previousCapabilityId: "previous-list",
  });
});

contractTest("web.hermetic", "tool projection is mandatory only for tools", () => {
  assert.throws(
    () =>
      planMcpCapabilitySnapshot({
        protocolVersion: "2025-11-25",
        discovered: [{ kind: "tool", capabilityKey: "broken", definition: {} }],
      }),
    /must project into a tool capability key/u
  );
  assert.throws(
    () =>
      planMcpCapabilitySnapshot({
        protocolVersion: "2025-11-25",
        discovered: [
          {
            kind: "prompt",
            capabilityKey: "broken",
            toolCapabilityKey: "not-a-tool",
            definition: {},
          },
        ],
      }),
    /Only MCP tools/u
  );
});
