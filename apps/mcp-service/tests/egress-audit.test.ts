import assert from "node:assert/strict";
import test from "node:test";
import { McpEgressEvidenceWriter } from "../src/egress-audit.js";

test("egress evidence is typed, destination-minimal, and secret-free", async () => {
  const calls: unknown[][] = [];
  const writer = new McpEgressEvidenceWriter({
    async query(_sql: string, values?: unknown[]) {
      calls.push(values ?? []);
      return { rows: [], rowCount: 1 } as never;
    },
  });
  await writer.persist({
    organizationId: "org-1",
    environmentId: "env-1",
    serverId: "server-1",
    owner: { grantId: "grant-1" },
    executionProfileFingerprint: "profile-fingerprint",
    policyRevision: "custom:server-1",
    policyDigest: `sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"b".repeat(64)}`,
    eventKind: "destination.denied",
    networkMode: "allow_hosts",
    destination: {
      hostname: "api.example.com",
      port: 443,
      protocol: "https",
      addressClassification: "private",
    },
    denialReason: "ADDRESS_FORBIDDEN",
  });
  const serialized = JSON.stringify(calls);
  assert.match(serialized, /api\.example\.com/u);
  assert.doesNotMatch(serialized, /Authorization|Bearer|query|requestBody/u);
});

test("destination and unrestricted evidence fail closed when incomplete", async () => {
  const writer = new McpEgressEvidenceWriter({
    async query() {
      throw new Error("must not persist");
    },
  });
  await assert.rejects(
    writer.persist({
      organizationId: "org-1",
      environmentId: "env-1",
      serverId: "server-1",
      owner: { discoveryJobId: "job-1" },
      policyRevision: "custom:server-1",
      policyDigest: `sha256:${"a".repeat(64)}`,
      imageDigest: `sha256:${"b".repeat(64)}`,
      eventKind: "destination.allowed",
      networkMode: "allow_hosts",
    }),
    /destination evidence is incomplete/u,
  );
});
