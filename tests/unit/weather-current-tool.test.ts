import test from "node:test";
import assert from "node:assert/strict";

import { weatherCurrentTool } from "../../tools/free/weatherCurrent.js";
import {
  createToolProviderConfigurationResolver,
  createToolProviderRuntimeConfiguration,
} from "../../tools/providers/runtimeConfiguration.js";

test("weather current falls back to nominatim when open-meteo geocode has no results", async () => {
  const handler = weatherCurrentTool.createHandler({
    fetchImpl: async (url) => {
      const target = typeof url === "string" ? url : String(url);
      if (target.includes("geocoding-api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            results: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (target.includes("nominatim.openstreetmap.org")) {
        return new Response(
          JSON.stringify([
            {
              lat: "42.3601",
              lon: "-71.0589",
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 5.5,
            apparent_temperature: 2.3,
            relative_humidity_2m: 68,
            weather_code: 2,
            wind_speed_10m: 9.1,
            time: "2026-02-27T17:00",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const output = (await handler({
    city: "Boston",
  })) as Record<string, unknown>;

  assert.equal(output.latitude, 42.3601);
  assert.equal(output.longitude, -71.0589);
  assert.equal(output.temperatureC, 5.5);
  const attempts = output.attempts as Array<Record<string, unknown>>;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.provider, "open-meteo");
  assert.equal(attempts[0]?.outcome, "succeeded");
  assert.equal(typeof attempts[0]?.durationMs, "number");
  assert.equal(output.fallbackUsed, false);
});

test("weather current falls back to nominatim when open-meteo geocoding fails", async () => {
  const requestedUrls: string[] = [];
  const handler = weatherCurrentTool.createHandler({
    fetchImpl: async (url) => {
      const target = typeof url === "string" ? url : String(url);
      requestedUrls.push(target);
      if (target.includes("geocoding-api.open-meteo.com")) {
        throw new TypeError("network unavailable");
      }
      if (target.includes("nominatim.openstreetmap.org")) {
        return new Response(
          JSON.stringify([{ lat: "41.8781", lon: "-87.6298" }]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 12.4,
            apparent_temperature: 11.1,
            relative_humidity_2m: 62,
            weather_code: 2,
            wind_speed_10m: 8.5,
            time: "2026-07-15T09:00",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const output = (await handler({ city: "Chicago" })) as Record<
    string,
    unknown
  >;

  assert.equal(output.latitude, 41.8781);
  assert.equal(output.longitude, -87.6298);
  assert.equal(output.temperatureC, 12.4);
  assert.equal(
    requestedUrls.some((url) => url.includes("nominatim.openstreetmap.org")),
    true,
  );
});

test("weather current reports incomplete provider data and an unavailable fallback", async () => {
  const handler = weatherCurrentTool.createHandler({
    fetchImpl: async () =>
      new Response(JSON.stringify({ current: { weather_code: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () => handler({ latitude: 41.8781, longitude: -87.6298 }),
    (error: unknown) => {
      const failure = error as {
        code?: string;
        details?: Record<string, unknown>;
      };
      assert.equal(failure.code, "WEATHER_FALLBACK_NOT_CONFIGURED");
      const attempts = failure.details?.attempts as Array<Record<string, unknown>>;
      assert.equal(attempts[0]?.failureCode, "TOOL_PROVIDER_PAYLOAD_INVALID");
      assert.equal(attempts[0]?.failureClassification, "invalid_payload");
      assert.equal(attempts[1]?.outcome, "unavailable");
      return true;
    },
  );
});

test("weather current fails over from a retryable Open-Meteo status to Visual Crossing", async () => {
  const seenUrls: string[] = [];
  const handler = weatherCurrentTool.createHandler({
    providerConfigurations: createToolProviderConfigurationResolver([
      createToolProviderRuntimeConfiguration({
        providerKey: "visual-crossing",
        credential: "visual-secret",
      }),
    ]),
    fetchImpl: async (url) => {
      const target = typeof url === "string" ? url : String(url);
      seenUrls.push(target);
      if (target.includes("api.open-meteo.com")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          latitude: 41.8781,
          longitude: -87.6298,
          currentConditions: {
            temp: 18.5,
            feelslike: 17.2,
            humidity: 61,
            conditions: "Partially cloudy",
            windspeed: 10.4,
            datetimeEpoch: 1_752_592_400,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const output = (await handler({
    latitude: 41.8781,
    longitude: -87.6298,
  })) as Record<string, unknown>;
  const attempts = output.attempts as Array<Record<string, unknown>>;
  assert.equal(output.source, "visual-crossing");
  assert.equal(output.fallbackUsed, true);
  assert.equal(attempts[0]?.failureClassification, "retryable_http_status");
  assert.equal(attempts[1]?.outcome, "succeeded");
  assert.equal(seenUrls.length, 2);
  assert.equal(JSON.stringify(output).includes("visual-secret"), false);
});

test("weather current throws when no location is provided", async () => {
  const handler = weatherCurrentTool.createHandler({
    fetchImpl: async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () => handler({}),
    /requires either input\.city or both input\.latitude\/input\.longitude/u,
  );
});

test("weather current accepts location as a city alias", async () => {
  const seenUrls: string[] = [];
  const handler = weatherCurrentTool.createHandler({
    fetchImpl: async (url) => {
      const target = typeof url === "string" ? url : String(url);
      seenUrls.push(target);
      if (target.includes("geocoding-api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                latitude: 40.7128,
                longitude: -74.006,
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 7.1,
            apparent_temperature: 5.9,
            relative_humidity_2m: 71,
            weather_code: 3,
            wind_speed_10m: 11.2,
            time: "2026-03-09T12:00",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const output = (await handler({
    location: "New York City",
  })) as Record<string, unknown>;

  assert.equal(output.latitude, 40.7128);
  assert.equal(output.longitude, -74.006);
  assert.equal(
    seenUrls.some((value) => value.includes("New%20York%20City")),
    true,
  );
});
