import assert from "node:assert/strict";
import test from "node:test";

import {
  validateVisualCrossingConnection,
  WeatherConnectionError,
} from "./weather-connection";

test("Visual Crossing connection verification uses a bounded credentialed request", async () => {
  let requestedUrl = "";
  const result = await validateVisualCrossingConnection({
    apiKey: "visual-secret",
    baseUrl: "https://weather.example/timeline/",
    fetchImpl: (async (url) => {
      requestedUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });

  const url = new URL(requestedUrl);
  assert.equal(url.origin, "https://weather.example");
  assert.equal(url.pathname, "/timeline/0,0");
  assert.equal(url.searchParams.get("key"), "visual-secret");
  assert.equal(result.status, "connected");
});

test("Visual Crossing connection verification classifies rejected credentials", async () => {
  await assert.rejects(
    () =>
      validateVisualCrossingConnection({
        apiKey: "invalid",
        fetchImpl: (async () =>
          new Response("{}", { status: 401 })) as unknown as typeof fetch,
      }),
    (error: unknown) => {
      assert.ok(error instanceof WeatherConnectionError);
      assert.equal(error.code, "APP_CONNECTION_INVALID");
      return true;
    }
  );
});
