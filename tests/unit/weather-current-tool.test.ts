import test from "node:test";
import assert from "node:assert/strict";

import { weatherCurrentTool } from "../../tools/free/weatherCurrent.js";

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
  assert.equal(seenUrls.some((value) => value.includes("New%20York%20City")), true);
});
