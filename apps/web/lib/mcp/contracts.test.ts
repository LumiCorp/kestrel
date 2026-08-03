import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildMcpRunGrant,
  createMcpServerInputSchema,
  MCP_RUN_GRANT_TTL_SECONDS,
  resolveEffectiveMcpCapabilities,
} from "./contracts";

const BASE_SERVER = {
  name: "GitHub MCP",
  slug: "github-mcp",
  auth: { mode: "none" as const },
  launchArguments: [],
  resources: { cpuMillicores: 500, memoryMib: 512, pidsLimit: 128 },
};

const environmentPanelSource = readFileSync(
  new URL(
    "../../app/admin/environments/mcp-environment-panel.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("OCI MCP installation discloses default-deny outbound policy", () => {
  assert.match(environmentPanelSource, /No network/u);
  assert.match(environmentPanelSource, /Exact destinations/u);
  assert.match(environmentPanelSource, /Unrestricted compatibility override/u);
  assert.match(environmentPanelSource, /risk/u);
});

test("remote MCP requires HTTPS, public addressing, and full network access", () => {
  const valid = createMcpServerInputSchema.parse({
    ...BASE_SERVER,
    sourceType: "remote",
    transport: "streamable_http",
    remoteUrl: "https://mcp.example.com/mcp",
  });
  assert.equal(valid.sourceType, "remote");
  assert.equal(valid.networkAccess, "full");

  for (const remoteUrl of [
    "http://mcp.example.com/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://10.0.0.1/mcp",
    "https://[::1]/mcp",
  ]) {
    assert.equal(
      createMcpServerInputSchema.safeParse({
        ...BASE_SERVER,
        sourceType: "remote",
        transport: "streamable_http",
        remoteUrl,
      }).success,
      false,
      remoteUrl,
    );
  }
  assert.equal(
    createMcpServerInputSchema.safeParse({
      ...BASE_SERVER,
      sourceType: "remote",
      transport: "streamable_http",
      remoteUrl: "https://mcp.example.com/mcp",
      networkAccess: "none",
    }).success,
    false,
  );
});

test("OCI MCP installation requires a matching digest-pinned reference", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const valid = createMcpServerInputSchema.parse({
    ...BASE_SERVER,
    sourceType: "oci",
    transport: "stdio",
    imageReference: `ghcr.io/kestrel/example@${digest}`,
    digest,
  });
  assert.equal(valid.sourceType, "oci");
  assert.deepEqual(valid.egressPolicy, { version: 1, mode: "none" });
  assert.equal(
    createMcpServerInputSchema.safeParse({
      ...BASE_SERVER,
      sourceType: "oci",
      transport: "stdio",
      imageReference: `ghcr.io/kestrel/example@${digest}`,
      digest,
      egressPolicy: {
        version: 1,
        mode: "unrestricted",
        acknowledgedRisk: true,
        justification: "compatibility",
      },
    }).success,
    true,
  );
  assert.equal(
    createMcpServerInputSchema.safeParse({
      ...BASE_SERVER,
      sourceType: "oci",
      transport: "stdio",
      imageReference: "ghcr.io/kestrel/example:latest",
      digest,
    }).success,
    false,
  );
});

test("OCI MCP authoring accepts only strict exact destination policies", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const parsed = createMcpServerInputSchema.parse({
    ...BASE_SERVER,
    sourceType: "oci",
    transport: "stdio",
    imageReference: `ghcr.io/kestrel/example@${digest}`,
    digest,
    egressPolicy: {
      version: 1,
      mode: "allow_hosts",
      destinations: [
        { hostname: "API.Example.COM.", port: 443, protocol: "https" },
      ],
    },
  });
  assert.equal(parsed.sourceType, "oci");
  assert.deepEqual(parsed.egressPolicy, {
    version: 1,
    mode: "allow_hosts",
    destinations: [
      { hostname: "api.example.com", port: 443, protocol: "https" },
    ],
  });
  assert.equal(
    createMcpServerInputSchema.safeParse({
      ...BASE_SERVER,
      sourceType: "oci",
      transport: "stdio",
      imageReference: `ghcr.io/kestrel/example@${digest}`,
      digest,
      egressPolicy: {
        version: 1,
        mode: "none",
        fallback: "unrestricted",
      },
    }).success,
    false,
  );
});

test("Project MCP policy can narrow but cannot widen Environment authority", () => {
  const environmentCapabilities = [
    {
      id: "read",
      kind: "tool" as const,
      environmentEnabled: true,
      approvalMode: "auto" as const,
    },
    {
      id: "write",
      kind: "tool" as const,
      environmentEnabled: true,
      approvalMode: "ask" as const,
    },
    {
      id: "newly-discovered",
      kind: "prompt" as const,
      environmentEnabled: false,
      approvalMode: "auto" as const,
    },
  ];
  assert.deepEqual(
    resolveEffectiveMcpCapabilities({
      environmentCapabilities,
      projectRestrictions: [
        { capabilityId: "read", enabled: true, approvalMode: "ask" },
        { capabilityId: "write", enabled: true, approvalMode: "auto" },
        {
          capabilityId: "newly-discovered",
          enabled: true,
          approvalMode: "auto",
        },
      ],
    }),
    [
      { id: "read", kind: "tool", approvalMode: "ask" },
      { id: "write", kind: "tool", approvalMode: "ask" },
    ],
  );
});

test("standalone Threads inherit enabled Environment authority", () => {
  assert.deepEqual(
    resolveEffectiveMcpCapabilities({
      environmentCapabilities: [
        {
          id: "prompt",
          kind: "prompt",
          environmentEnabled: true,
          approvalMode: "auto",
        },
      ],
    }),
    [{ id: "prompt", kind: "prompt", approvalMode: "auto" }],
  );
});

test("run grants are short lived and contain capability IDs only", () => {
  const now = new Date("2026-07-13T12:00:00.000Z");
  const grant = buildMcpRunGrant({
    id: "018f1f73-4ce2-7b0f-8e14-3b977e1577a5",
    runExecutionId: "run-1",
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
    policyDigest: "sha256:policy",
    effectiveCapabilities: [
      { id: "tool-1", kind: "tool", approvalMode: "ask" },
    ],
    now,
  });
  assert.deepEqual(grant.effectiveCapabilities, ["tool-1"]);
  assert.deepEqual(grant.effectivePolicy, [
    { capabilityId: "tool-1", approvalMode: "ask" },
  ]);
  assert.equal(
    grant.expiresAt.getTime() - grant.createdAt.getTime(),
    MCP_RUN_GRANT_TTL_SECONDS * 1000,
  );
  assert.equal(JSON.stringify(grant).includes("credential"), false);
});
