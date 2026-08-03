import assert from "node:assert/strict";
import test from "node:test";
import { digestHostedMcpRunPolicyEvidence } from "./grant-service";

const resolvedPolicy = {
  gatewayUrl: "https://mcp.example.test/",
  organizationId: "org-1",
  environmentId: "env-1",
  projectId: "project-1",
  effectiveCapabilities: [
    {
      id: "capability-1",
      kind: "tool" as const,
      approvalMode: "ask" as const,
      serverId: "server-1",
      snapshotId: "snapshot-1",
      snapshotDigest: `sha256:${"c".repeat(64)}`,
    },
  ],
  ociEgressBindings: [
    {
      version: 1 as const,
      source: "custom" as const,
      organizationId: "org-1",
      environmentId: "env-1",
      serverId: "server-1",
      imageDigest: `sha256:${"a".repeat(64)}`,
      policyRevision: "custom:server-1",
      policyDigest:
        "sha256:59704c11b4f9b612e75f68fac891e4dca743d52d7a946d6d64db287c7b620633",
      policy: { version: 1 as const, mode: "none" as const },
    },
  ],
};

test("MCP grant digest binds the execution profile and OCI authority", () => {
  const base = {
    threadId: "thread-1",
    executionProfileId: "profile-1",
    executionProfileFingerprint: "fingerprint-1",
    resolvedPolicy,
  };
  assert.notEqual(
    digestHostedMcpRunPolicyEvidence(base),
    digestHostedMcpRunPolicyEvidence({
      ...base,
      executionProfileFingerprint: "fingerprint-2",
    }),
  );
  assert.notEqual(
    digestHostedMcpRunPolicyEvidence(base),
    digestHostedMcpRunPolicyEvidence({
      ...base,
      resolvedPolicy: { ...resolvedPolicy, ociEgressBindings: [] },
    }),
  );
});
