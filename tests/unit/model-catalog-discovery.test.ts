import assert from "node:assert/strict";
import test from "node:test";

import { resolveProviderModelCatalog } from "../../src/profile/modelCatalogDiscovery.js";

test("live catalogs preserve provider order instead of ranking models", async () => {
  const result = await resolveProviderModelCatalog(
    "openrouter",
    {},
    (async () => new Response(JSON.stringify({
      data: [{ id: "provider/second" }, { id: "provider/first" }],
    }), { status: 200 })) as typeof fetch,
    { preserveProviderOrder: true },
  );

  assert.equal(result.source, "live");
  assert.deepEqual(result.models, ["provider/second", "provider/first"]);
});

test("LM Studio catalog discovery returns models loaded by the configured endpoint", async () => {
  let requestedUrl = "";
  const result = await resolveProviderModelCatalog(
    "lmstudio",
    { LMSTUDIO_BASE_URL: "http://127.0.0.1:4321/" },
    (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        data: [{ id: "local/one" }, { id: "local/two" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
    { requireLiveLocalCatalog: true, preserveProviderOrder: true },
  );

  assert.equal(requestedUrl, "http://127.0.0.1:4321/v1/models");
  assert.deepEqual(result, {
    provider: "lmstudio",
    models: ["local/one", "local/two"],
    source: "live",
  });
});

test("LM Studio catalog discovery reports endpoint failure without inventing availability", async () => {
  const result = await resolveProviderModelCatalog(
    "lmstudio",
    {},
    (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch,
    { requireLiveLocalCatalog: true, preserveProviderOrder: true },
  );

  assert.equal(result.provider, "lmstudio");
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, []);
  assert.match(result.note ?? "", /connection refused/u);
});
