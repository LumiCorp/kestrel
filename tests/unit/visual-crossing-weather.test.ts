import assert from "node:assert/strict";
import test from "node:test";

import {
  createVisualCrossingWeatherAdapter,
  verifyVisualCrossingCredential,
} from "../../tools/free/visualCrossingWeather.js";

test("Visual Crossing credential verification requires normalized provider evidence", async () => {
  const result = await verifyVisualCrossingCredential({
    apiKey: "visual-secret",
    fetchImpl: async () => new Response(
      JSON.stringify({
        latitude: 0,
        longitude: 0,
        currentConditions: {
          temp: 20,
          datetimeEpoch: 1_789_564_500,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  });

  assert.equal(typeof result.checkedAt, "string");
  assert.equal(JSON.stringify(result).includes("visual-secret"), false);
});

test("Visual Crossing current weather normalizes provider data without exposing its credential", async () => {
  let requestedUrl = "";
  const adapter = createVisualCrossingWeatherAdapter({
    apiKey: "visual-secret",
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({
          latitude: 42.36,
          longitude: -71.06,
          currentConditions: {
            temp: 22.4,
            feelslike: 23.1,
            humidity: 61,
            conditions: "Partially cloudy",
            windspeed: 11.2,
            datetimeEpoch: 1_789_564_500,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const output = await adapter.current({
    toolName: "free.weather.current",
    latitude: 42.36,
    longitude: -71.06,
  });

  assert.equal(output.source, "visual-crossing");
  assert.equal(output.temperatureC, 22.4);
  assert.equal(output.condition, "Partially cloudy");
  assert.equal(String(output.observedAt).endsWith("Z"), true);
  assert.equal(JSON.stringify(output).includes("visual-secret"), false);
  assert.equal(new URL(requestedUrl).searchParams.get("key"), "visual-secret");
});

test("Visual Crossing forecast maps days and hours into the shared weather payload", async () => {
  const adapter = createVisualCrossingWeatherAdapter({
    apiKey: "visual-secret",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          latitude: 47.61,
          longitude: -122.33,
          timezone: "America/Los_Angeles",
          currentConditions: { datetime: "09:35:00" },
          days: [
            {
              datetime: "2026-07-15",
              tempmax: 24,
              tempmin: 15,
              precipprob: 12,
              precip: 0.1,
              windspeed: 16,
              hours: [
                {
                  datetime: "09:00:00",
                  temp: 18,
                  feelslike: 18,
                  precipprob: 8,
                  precip: 0,
                  windspeed: 7,
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  const output = await adapter.forecast({
    toolName: "free.weather.forecast",
    latitude: 47.61,
    longitude: -122.33,
    days: 1,
    timezone: "auto",
  });
  const hourly = output.hourly as Record<string, unknown[]>;
  const daily = output.daily as Record<string, unknown[]>;

  assert.equal(output.source, "visual-crossing");
  assert.deepEqual(hourly.time, ["2026-07-15T09:00"]);
  assert.deepEqual(hourly.temperature_2m, [18]);
  assert.deepEqual(daily.time, ["2026-07-15"]);
  assert.deepEqual(daily.temperature_2m_max, [24]);
});

test("Visual Crossing rejects a forecast without daily evidence", async () => {
  const adapter = createVisualCrossingWeatherAdapter({
    apiKey: "visual-secret",
    fetchImpl: async () =>
      new Response(JSON.stringify({ days: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () =>
      adapter.forecast({
        toolName: "free.weather.forecast",
        latitude: 0,
        longitude: 0,
        days: 1,
        timezone: "UTC",
      }),
    (error: unknown) => {
      const failure = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(failure.code, "TOOL_PROVIDER_PAYLOAD_INVALID");
      assert.equal(failure.details?.provider, "visual-crossing");
      return true;
    },
  );
});
