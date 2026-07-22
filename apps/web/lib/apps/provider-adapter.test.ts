import assert from "node:assert/strict";
import {
  getAppProviderAdapter,
  listAppProviderAdapters,
} from "./provider-adapter";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest(
  "web.hermetic",
  "provider adapter registry exposes managed API Apps through the shared contract",
  () => {
    assert.deepEqual(
      listAppProviderAdapters().map((adapter) => adapter.appKey),
      ["built_in.weather", "tavily", "ngrok", "vercel"],
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
  },
);

contractTest(
  "web.hermetic",
  "Vercel adapter binds bounded reads to the official API",
  () => {
    const adapter = getAppProviderAdapter("vercel");
    const runtime = adapter?.runtime;
    assert.ok(runtime);
    assert.equal(runtime.mode, "request_proxy");
    if (runtime.mode !== "request_proxy") {
      throw new Error("Vercel runtime must use the request proxy.");
    }
    assert.deepEqual(runtime.capabilityKeys, [
      "projects.read",
      "deployments.read",
      "operations.read",
    ]);
    const credential = adapter.createEnvironmentCredential?.({
      kind: "api_key",
      name: "Primary",
      apiKey: "vercel-secret",
      projectId: "team_123",
    });
    const request = runtime.createRequest({
      capability: "deployments.read",
      method: "POST",
      path: ["deployments"],
      body: new TextEncoder().encode(
        JSON.stringify({ limit: 20, target: "production" }),
      ).buffer,
      credential: credential ?? null,
    });
    assert.equal(request.url.origin, "https://api.vercel.com");
    assert.equal(request.url.pathname, "/v6/deployments");
    assert.equal(request.url.searchParams.get("teamId"), "team_123");
    assert.equal(request.url.searchParams.get("target"), "production");
    assert.equal(request.init.method, "GET");
    assert.equal(request.url.toString().includes("vercel-secret"), false);
    assert.throws(() =>
      runtime.createRequest({
        capability: "deployments.read",
        method: "POST",
        path: ["deployments"],
        body: new TextEncoder().encode('{"unknown":true}').buffer,
        credential: credential ?? null,
      }),
    );
  },
);

contractTest(
  "web.hermetic",
  "Weather adapter stores only Visual Crossing credential fields",
  () => {
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
    assert.equal(runtime.mode, "request_proxy");
    if (runtime.mode !== "request_proxy")
      throw new Error("Expected request proxy.");
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
        }),
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
          }),
        ).buffer,
        credential: credential ?? null,
      }),
    );
  },
);

contractTest(
  "web.hermetic",
  "Tavily adapter constructs only an allowlisted credentialed request",
  () => {
    const runtime = getAppProviderAdapter("tavily")?.runtime;
    assert.ok(runtime);
    assert.equal(runtime.mode, "request_proxy");
    if (runtime.mode !== "request_proxy")
      throw new Error("Expected request proxy.");
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
      }),
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
      "Bearer tvly-secret",
    );
    assert.equal(
      JSON.stringify({ url: request.url }).includes("tvly-secret"),
      false,
    );
  },
);
