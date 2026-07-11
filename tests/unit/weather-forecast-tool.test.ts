import test from "node:test";
import assert from "node:assert/strict";

import { weatherForecastTool } from "../../tools/free/weatherForecast.js";

test("weather forecast resolves target hour from city + local date/hour and returns daily forecast", async () => {
  const requestedUrls: string[] = [];
  const handler = weatherForecastTool.createHandler({
    fetchImpl: async (url) => {
      const target = typeof url === "string" ? url : String(url);
      requestedUrls.push(target);
      if (target.includes("geocoding-api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                latitude: 47.6062,
                longitude: -122.3321,
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
          timezone: "America/Los_Angeles",
          hourly: {
            time: ["2026-03-01T06:00", "2026-03-01T07:00", "2026-03-01T08:00"],
            temperature_2m: [8, 9, 10],
            apparent_temperature: [7, 8, 9],
            precipitation_probability: [20, 30, 10],
            precipitation: [0, 0.2, 0],
            wind_speed_10m: [7, 8, 6],
          },
          daily: {
            time: ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"],
            temperature_2m_max: [10, 11, 12, 13],
            temperature_2m_min: [4, 5, 6, 7],
            precipitation_probability_max: [30, 20, 10, 5],
            precipitation_sum: [0.2, 0, 0, 0],
            wind_speed_10m_max: [9, 10, 8, 7],
            weather_code: [3, 2, 1, 0],
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
    city: "Seattle",
    localDate: "2026-03-01",
    localHour: 7,
    days: 4,
    granularity: "daily",
  })) as Record<string, unknown>;

  const target = output.target as Record<string, unknown>;
  assert.equal(target.time, "2026-03-01T07:00");
  assert.equal(target.temperatureC, 9);
  assert.equal(output.timezone, "America/Los_Angeles");
  assert.equal(output.requestedDays, 4);
  assert.equal(output.granularity, "daily");
  assert.equal(requestedUrls.some((url) => url.includes("forecast_days=4")), true);

  const daily = output.daily as Array<Record<string, unknown>>;
  assert.equal(daily.length, 4);
  assert.equal(daily[0]?.date, "2026-03-01");
  assert.equal(daily[0]?.maxTemperatureC, 10);
});

test("weather forecast throws when no location is provided", async () => {
  const handler = weatherForecastTool.createHandler({
    fetchImpl: async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () =>
      handler({
        localDate: "2026-03-01",
        localHour: 7,
      }),
    /requires either input\.city/u,
  );
});

test("weather forecast falls back to nominatim when open-meteo geocode has no results", async () => {
  const handler = weatherForecastTool.createHandler({
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
              lat: "30.2672",
              lon: "-97.7431",
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
          timezone: "America/Chicago",
          hourly: {
            time: ["2026-03-01T06:00", "2026-03-01T07:00", "2026-03-01T08:00"],
            temperature_2m: [10, 11, 12],
            apparent_temperature: [9, 10, 11],
            precipitation_probability: [5, 5, 10],
            precipitation: [0, 0, 0.1],
            wind_speed_10m: [6, 7, 8],
          },
          daily: {
            time: ["2026-03-01", "2026-03-02"],
            temperature_2m_max: [12, 13],
            temperature_2m_min: [7, 8],
            precipitation_probability_max: [10, 20],
            precipitation_sum: [0.1, 0.2],
            wind_speed_10m_max: [8, 9],
            weather_code: [2, 3],
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
    city: "Austin",
    localDate: "2026-03-01",
    localHour: 7,
  })) as Record<string, unknown>;

  assert.equal(output.latitude, 30.2672);
  assert.equal(output.longitude, -97.7431);
  const target = output.target as Record<string, unknown>;
  assert.equal(target.time, "2026-03-01T07:00");
  assert.equal(target.temperatureC, 11);
  const daily = output.daily as Array<Record<string, unknown>>;
  assert.equal(daily.length, 2);
});
