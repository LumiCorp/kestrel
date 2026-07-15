import assert from "node:assert/strict";
import test from "node:test";

import { UnifiedToolRegistry } from "../../tools/runtime/UnifiedToolRegistry.js";
import { kestrelOneSearchKnowledgeDocumentsTool } from "../../tools/kestrelOne/searchKnowledgeDocuments.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

const TOOL_NAME = "kestrel_one.search_knowledge_documents";

test("Kestrel-One knowledge tool sends bearer auth and tenant headers", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({ query: "docs", count: 1, results: [{ title: "Doc" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const handler = kestrelOneSearchKnowledgeDocumentsTool.createHandler({
    fetchImpl,
    kestrelOne: {
      appUrl: "https://one.example.test",
      toolToken: "tool-token",
      executionTicket: "environment-ticket",
      tenantId: "org_123",
    },
  });

  const result = await handler({ query: "docs", limit: 3 }) as {
    toolName: string;
    status: string;
    auditRecord: { output: unknown };
    presentation: { citations: unknown[] };
  };

  assert.deepEqual(result.auditRecord.output, {
    query: "docs",
    count: 1,
    results: [{ title: "Doc" }],
  });
  assert.equal(result.toolName, TOOL_NAME);
  assert.equal(result.status, "OK");
  assert.deepEqual(result.presentation.citations, []);
  assert.equal(
    capturedUrl,
    "https://one.example.test/api/kestrel/tools/search-knowledge-documents",
  );
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(capturedInit?.headers, {
    authorization: "Bearer environment-ticket",
    "content-type": "application/json",
    "x-kestrel-tenant-id": "org_123",
    "x-organization-id": "org_123",
  });
  assert.equal(capturedInit?.body, JSON.stringify({ query: "docs", limit: 3 }));
});

test("Kestrel-One knowledge tool maps app HTTP failures without retrying", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
  };
  const handler = kestrelOneSearchKnowledgeDocumentsTool.createHandler({
    fetchImpl,
    kestrelOne: {
      appUrl: "https://one.example.test",
      toolToken: "tool-token",
      tenantId: "org_123",
    },
  });

  await assert.rejects(
    () => handler({ query: "docs" }),
    /Kestrel-One knowledge search failed with HTTP 503/,
  );
  assert.equal(callCount, 1);
});

test("Kestrel-One knowledge tool input is validated by the runtime registry before fetch", async () => {
  let called = false;
  const registry = new UnifiedToolRegistry({
    allowlist: [TOOL_NAME],
    context: {
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
      kestrelOne: {
        appUrl: "https://one.example.test",
        toolToken: "tool-token",
        tenantId: "org_123",
      },
    },
    mcpManager: {
      async refresh() {
        return {
          healthy: true,
          checkedAt: new Date(0).toISOString(),
          servers: [],
          tools: [],
        };
      },
      async assertHealthy() {},
      async callTool() {
        throw new Error("unexpected mcp call");
      },
      async close() {},
    },
  });

  await assert.rejects(
    () => registry.call(TOOL_NAME, { query: "no" }),
    (error) => {
      assert.equal(error instanceof RuntimeFailure, true);
      const failure = error as RuntimeFailure;
      assert.equal(failure.code, "TOOL_INPUT_INVALID");
      assert.equal(failure.details?.classification, "schema");
      assert.equal(failure.details?.recoverable, true);
      assert.equal(failure.details?.field, "query");
      assert.equal(failure.details?.expected, "string length >= 3");
      assert.deepEqual(failure.details?.invalidValues, ["no"]);
      return true;
    },
  );
  assert.equal(called, false);
});
