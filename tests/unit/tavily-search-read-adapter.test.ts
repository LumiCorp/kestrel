import assert from "node:assert/strict";
import test from "node:test";

import { SandboxCapabilityAdapterFailure, tavilySearchReadAdapter } from "../../src/code/adapters/TavilySearchReadAdapter.js";

const profile = tavilySearchReadAdapter.parseProfile({
  version: 1,
  capabilityId: "tavily.search.read",
  operations: ["search"],
  resource: "https://api.tavily.com/search",
  audience: { tenantId: "tenant", environmentId: "environment" },
  maxRequests: 1,
  maxQueryChars: 100,
  maxResults: 3,
  maxResponseBytes: 4096,
  timeoutMs: 1000,
  maxExpiryMs: 5000,
  brokerAuthority: { authorityId: "broker", revision: "revision" },
});
const selection = tavilySearchReadAdapter.parseSelection({ capabilityId: "tavily.search.read", input: { query: "q" } });
const canonicalInput = tavilySearchReadAdapter.canonicalInput(profile, selection);

for (const scenario of ["deadline", "cancel"] as const) {
  test(`Tavily response-body stalls fail with stable ${scenario} evidence`, async () => {
    const cancellation = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":[]}'));
        // Deliberately remain open after a complete JSON value.
      },
    });
    const invocation = tavilySearchReadAdapter.invoke(canonicalInput, {
      fetchImpl: async () => new Response(body, { status: 200 }),
      credential: "secret",
      timeoutMs: 1000,
      expiryMs: scenario === "deadline" ? 10 : 1000,
      maxResponseBytes: 4096,
      signal: cancellation.signal,
    });
    if (scenario === "cancel") setTimeout(() => cancellation.abort(), 10);
    await assert.rejects(invocation, (error) =>
      error instanceof SandboxCapabilityAdapterFailure &&
      error.code === (scenario === "deadline" ? "CAPABILITY_DEADLINE_EXCEEDED" : "CAPABILITY_CANCELLED"),
    );
  });
}
