import assert from "node:assert/strict";
import test from "node:test";
import {
  OCI_MCP_NO_EGRESS_POLICY,
  digestOciMcpEgressPolicy,
  ociMcpEgressPolicyV1Schema,
  resolvedOciMcpEgressBindingV1Schema,
  resolveCustomOciMcpEgressPolicy,
} from "./oci-egress-policy.js";

test("canonicalizes and deterministically orders exact OCI destinations", () => {
  const parsed = ociMcpEgressPolicyV1Schema.parse({
    version: 1,
    mode: "allow_hosts",
    destinations: [
      { hostname: "Bücher.Example.", port: 443, protocol: "https" },
      { hostname: "api.example.com", port: 80, protocol: "http" },
    ],
  });
  assert.equal(parsed.mode, "allow_hosts");
  if (parsed.mode !== "allow_hosts") throw new Error("Expected allow_hosts.");
  assert.deepEqual(parsed.destinations, [
    { hostname: "api.example.com", port: 80, protocol: "http" },
    { hostname: "xn--bcher-kva.example", port: 443, protocol: "https" },
  ]);
  assert.equal(
    digestOciMcpEgressPolicy(parsed),
    digestOciMcpEgressPolicy({
      version: 1,
      mode: "allow_hosts",
      destinations: [...parsed.destinations].reverse(),
    }),
  );
});

test("rejects duplicate canonical destinations and non-host policy syntax", () => {
  assert.equal(
    ociMcpEgressPolicyV1Schema.safeParse({
      version: 1,
      mode: "allow_hosts",
      destinations: [
        { hostname: "API.EXAMPLE.COM", port: 443, protocol: "https" },
        { hostname: "api.example.com.", port: 443, protocol: "https" },
      ],
    }).success,
    false,
  );
  for (const hostname of [
    "127.0.0.1",
    "999.0.0.1",
    "[::1]",
    "*.example.com",
    "10.0.0.0/8",
    "https://example.com",
    "example.com/path",
    "user@example.com",
  ]) {
    assert.equal(
      ociMcpEgressPolicyV1Schema.safeParse({
        version: 1,
        mode: "allow_hosts",
        destinations: [{ hostname, port: 443, protocol: "https" }],
      }).success,
      false,
      hostname,
    );
  }
});

test("strict policy objects reject unknown fields and invalid overrides", () => {
  assert.equal(
    ociMcpEgressPolicyV1Schema.safeParse({
      version: 1,
      mode: "none",
      fallback: "unrestricted",
    }).success,
    false,
  );
  assert.equal(
    ociMcpEgressPolicyV1Schema.safeParse({
      version: 1,
      mode: "unrestricted",
      acknowledgedRisk: false,
      justification: "development compatibility",
    }).success,
    false,
  );
});

test("missing or malformed custom policy resolves to none", () => {
  assert.deepEqual(
    resolveCustomOciMcpEgressPolicy(undefined),
    OCI_MCP_NO_EGRESS_POLICY,
  );
  assert.deepEqual(
    resolveCustomOciMcpEgressPolicy({
      version: 1,
      mode: "allow_hosts",
      destinations: [],
    }),
    OCI_MCP_NO_EGRESS_POLICY,
  );
});

test("resolved bindings reject stale digests and managed unrestricted mode", () => {
  const policy = OCI_MCP_NO_EGRESS_POLICY;
  const base = {
    version: 1 as const,
    source: "custom" as const,
    organizationId: "org-1",
    environmentId: "env-1",
    serverId: "server-1",
    imageDigest: `sha256:${"a".repeat(64)}`,
    policyRevision: "custom:1",
    policyDigest: digestOciMcpEgressPolicy(policy),
    policy,
  };
  assert.equal(
    resolvedOciMcpEgressBindingV1Schema.safeParse(base).success,
    true,
  );
  assert.equal(
    resolvedOciMcpEgressBindingV1Schema.safeParse({
      ...base,
      policyDigest: `sha256:${"b".repeat(64)}`,
    }).success,
    false,
  );
  assert.equal(
    resolvedOciMcpEgressBindingV1Schema.safeParse({
      ...base,
      source: "managed",
      policy: {
        version: 1,
        mode: "unrestricted",
        acknowledgedRisk: true,
        justification: "unsupported",
      },
      policyDigest: digestOciMcpEgressPolicy({
        version: 1,
        mode: "unrestricted",
        acknowledgedRisk: true,
        justification: "unsupported",
      }),
    }).success,
    false,
  );
});
