import assert from "node:assert/strict";
import test from "node:test";
import { getAppProviderAdapter, listAppProviderAdapters } from "./provider-adapter";

test("provider adapter registry exposes Weather and Tavily through the shared contract", () => {
  assert.deepEqual(
    listAppProviderAdapters().map((adapter) => adapter.appKey),
    ["built_in.weather", "tavily"]
  );
  const adapter = getAppProviderAdapter("tavily");
  assert.ok(adapter?.runtime);
  assert.deepEqual(adapter.authMethods, ["api_key"]);
  assert.deepEqual(adapter.runtime.capabilityKeys, [
    "search",
    "search_advanced",
    "news",
    "images",
    "extract",
    "crawl",
    "map",
    "research",
    "research_status",
    "usage",
  ]);
});

test("Weather adapter stores only Visual Crossing credential fields", () => {
  const adapter = getAppProviderAdapter("built_in.weather");
  assert.deepEqual(adapter?.authMethods, ["api_key"]);
  const credential = adapter?.createEnvironmentCredential?.({
    kind: "api_key",
    name: "Visual Crossing",
    apiKey: "visual-secret",
    projectId: "must-not-cross-provider-boundary",
    baseUrl: "https://weather.example/timeline/",
  });
  assert.deepEqual(credential, {
    kind: "api_key",
    apiKey: "visual-secret",
    baseUrl: "https://weather.example/timeline/",
  });
  const runtime = adapter?.runtime;
  assert.ok(runtime);
  assert.deepEqual(runtime.capabilityKeys, ["getWeather", "forecast"]);
  runtime.assertTarget({
    capability: "getWeather",
    method: "POST",
    path: ["timeline"],
  });
  const request = runtime.createRequest({
    capability: "getWeather",
    method: "POST",
    path: ["timeline"],
    body: new TextEncoder().encode(
      JSON.stringify({
        latitude: 42.36,
        longitude: -71.06,
        include: "current",
        timezone: "UTC",
      })
    ).buffer,
    credential: credential ?? null,
  });
  assert.equal(request.url.origin, "https://weather.example");
  assert.equal(request.url.searchParams.get("key"), "visual-secret");
  assert.equal(request.url.searchParams.get("include"), "current");
  assert.equal(request.init.method, "GET");
  assert.equal(request.timeoutMs, undefined);
  assert.throws(() =>
    runtime.createRequest({
      capability: "getWeather",
      method: "POST",
      path: ["timeline"],
      body: new TextEncoder().encode(
        JSON.stringify({
          latitude: 42.36,
          longitude: -71.06,
          include: "current,days,hours",
          timezone: "UTC",
        })
      ).buffer,
      credential: credential ?? null,
    })
  );
});

test("Tavily adapter constructs only an allowlisted credentialed request", () => {
  const runtime = getAppProviderAdapter("tavily")?.runtime;
  assert.ok(runtime);
  runtime.assertTarget({
    capability: "search",
    method: "POST",
    path: ["search"],
  });
  assert.throws(() =>
    runtime.assertTarget({
      capability: "search",
      method: "POST",
      path: ["research"],
    })
  );

  const request = runtime.createRequest({
    capability: "search",
    method: "POST",
    path: ["search"],
    body: new TextEncoder().encode('{"query":"Kestrel"}').buffer,
    credential: {
      kind: "api_key",
      apiKey: "tvly-secret",
      projectId: "project-1",
    },
  });
  assert.equal(request.url.toString(), "https://api.tavily.com/search");
  assert.equal(
    (request.init.headers as Record<string, string>).Authorization,
    "Bearer tvly-secret"
  );
  assert.equal(JSON.stringify({ url: request.url }).includes("tvly-secret"), false);
});
