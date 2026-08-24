import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createQualificationProviderFetch } from "../../cli/runner/qualification-service.js";
import { tavilySearchReadAdapter } from "../../src/code/adapters/TavilySearchReadAdapter.js";

test("live qualification provider receipts bind request and response without retaining the query", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-live-provider-receipt-"));
  const evidencePath = path.join(root, "provider.ndjson");
  const marker = "kestrel-live-receipt-marker";
  try {
    const wrapped = createQualificationProviderFetch("live", evidencePath, async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const response = await wrapped("https://api.tavily.com/search", {
      method: "POST",
      headers: { authorization: "Bearer qualification-secret" },
      body: JSON.stringify({ query: marker, max_results: 1 }),
    });
    assert.equal(response.status, 200);
    const serialized = await readFile(evidencePath, "utf8");
    const records = serialized.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(records.map((record) => record.kind), ["provider_request", "provider_response"]);
    assert.equal(records[0]?.query, undefined);
    assert.match(String(records[0]?.queryDigest), /^sha256:[a-f0-9]{64}$/u);
    assert.match(String(records[1]?.responseDigest), /^sha256:[a-f0-9]{64}$/u);
    assert.equal(serialized.includes(marker), false);
    assert.equal(serialized.includes("qualification-secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Tavily model contract explains the required fixed capability path without widening selection", () => {
  assert.match(tavilySearchReadAdapter.modelContract.description, /no direct DNS/u);
  assert.match(tavilySearchReadAdapter.modelContract.usage, /same code\.execute input/u);
  assert.match(tavilySearchReadAdapter.modelContract.usage, /fixed loopback broker/u);
  assert.equal(tavilySearchReadAdapter.modelContract.optional, true);
  assert.equal(tavilySearchReadAdapter.resource, "https://api.tavily.com/search");
});
