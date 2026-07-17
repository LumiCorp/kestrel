import assert from "node:assert/strict";
import test from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  discoverCapabilities,
  McpDiscoveryWorker,
} from "../src/discovery-worker.js";

test("MCP discovery snapshots every advertised list with stable tool projection", async () => {
  const client = {
    getServerCapabilities: () => ({
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
      completions: {},
      logging: {},
    }),
    getServerVersion: () => ({ name: "github-mcp", version: "1.2.3" }),
    getInstructions: () => "Use approved repositories only.",
    listTools: async () => ({
      tools: [
        {
          name: "issues/list",
          title: "List issues",
          description: "Lists issues",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    }),
    listResources: async () => ({
      resources: [{ uri: "repo://acme/app", name: "App repository" }],
    }),
    listResourceTemplates: async () => ({
      resourceTemplates: [
        { uriTemplate: "repo://{owner}/{name}", name: "Repository" },
      ],
    }),
    listPrompts: async () => ({
      prompts: [{ name: "triage", description: "Triage an issue" }],
    }),
  } as unknown as Pick<
    Client,
    | "getServerCapabilities"
    | "getServerVersion"
    | "getInstructions"
    | "listTools"
    | "listResources"
    | "listResourceTemplates"
    | "listPrompts"
  >;

  const first = await discoverCapabilities({
    client,
    serverSlug: "github-prod",
  });
  const second = await discoverCapabilities({
    client,
    serverSlug: "github-prod",
  });

  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(
    first.capabilities.map((capability) => capability.kind),
    [
      "completion",
      "elicitation",
      "logging",
      "prompt",
      "resource_template",
      "resource",
      "root",
      "sampling",
      "tool",
    ],
  );
  const tool = first.capabilities.find(
    (capability) => capability.kind === "tool",
  );
  assert.equal(tool?.capabilityKey, "issues/list");
  assert.match(
    tool?.toolCapabilityKey ?? "",
    /^mcp\.github-prod\.issues_list\.[0-9a-f]{16}$/u,
  );
  assert.equal(tool?.accessMode, "read");
});

test("MCP discovery gives colliding readable tool names distinct projections", async () => {
  const client = {
    getServerCapabilities: () => ({ tools: {} }),
    getServerVersion: () => ({ name: "collision-test", version: "1" }),
    getInstructions: () => {},
    listTools: async () => ({
      tools: [
        { name: "write/path", inputSchema: { type: "object" } },
        { name: "write?path", inputSchema: { type: "object" } },
      ],
    }),
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    listPrompts: async () => ({ prompts: [] }),
  } as unknown as Parameters<typeof discoverCapabilities>[0]["client"];
  const discovery = await discoverCapabilities({
    client,
    serverSlug: "server",
  });
  const names = discovery.capabilities.flatMap((capability) =>
    capability.kind === "tool" && capability.toolCapabilityKey
      ? [capability.toolCapabilityKey]
      : [],
  );
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
});

test("MCP discovery reclaims abandoned jobs with a bounded attempt count", async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("FROM mcp_discovery_jobs job")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const worker = new McpDiscoveryWorker({
    connect: async () => client,
  } as never);

  assert.equal(await worker.pollOnce(), false);
  const expiry = queries.find((query) => query.text.includes("WITH exhausted"));
  const claim = queries.find((query) =>
    query.text.includes("FROM mcp_discovery_jobs job"),
  );
  assert.match(expiry?.text ?? "", /MCP_DISCOVERY_RETRY_EXHAUSTED/u);
  assert.deepEqual(expiry?.values?.slice(1), [5]);
  assert.match(claim?.text ?? "", /job\.status = 'running'/u);
  assert.match(claim?.text ?? "", /job\.claimed_at <= \$1/u);
  assert.deepEqual(claim?.values?.slice(1), [5]);
});

test("MCP discovery refuses to persist after claim ownership is lost", async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("SELECT 1") && text.includes("FOR UPDATE")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: null };
    },
    release() {},
  };
  const worker = new McpDiscoveryWorker({
    connect: async () => client,
  } as never);
  const persistDiscovery = (
    worker as unknown as {
      persistDiscovery(
        job: unknown,
        discovery: unknown,
      ): Promise<void>;
    }
  ).persistDiscovery.bind(worker);

  await persistDiscovery(
    {
      id: "job-1",
      claimAttempt: 3,
      organizationId: "org-1",
      environmentId: "env-1",
      server: { id: "server-1", providerKey: "provider-1" },
    },
    { serverInfo: {}, capabilities: [], digest: "sha256:test" },
  );

  const ownershipCheck = queries.find((query) =>
    query.text.includes("FOR UPDATE"),
  );
  assert.deepEqual(ownershipCheck?.values, ["job-1", 3]);
  assert.equal(
    queries.some((query) =>
      query.text.includes("INSERT INTO mcp_capability_snapshots"),
    ),
    false,
  );
});
