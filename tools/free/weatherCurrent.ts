import type { SharedToolModule } from "../contracts.js";
import {
  createToolInputError,
  ensureFetchOk,
  fetchImplOrDefault,
  parseJsonRecord,
  parseObjectInput,
  readNumber,
  readString,
} from "../helpers.js";
import { resolveCoordinatesForCity } from "./geocodeResolver.js";

export const weatherCurrentTool: SharedToolModule = {
  definition: {
    name: "free.weather.current",
    description: "Fetch current weather from Open-Meteo for coordinates or a city name.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        location: { type: "string" },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
      },
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["weather.current"],
      suitability: {
        supportsAttribution: true,
        typicalFailureModes: [
          "requires_city_or_coordinates",
        ],
      },
    },
    presentation: {
      displayName: "Current Weather",
      aliases: ["current weather", "weather now", "weather current"],
      keywords: ["weather", "forecast", "current", "temperature"],
      provider: "open-meteo",
      toolFamily: "weather",
    },
  },
  createHandler(context) {
    const fetchImpl = fetchImplOrDefault(context.fetchImpl);

    return async (input: unknown) => {
      const body = parseObjectInput("free.weather.current", input);
      let latitude = readNumber(body, "latitude");
      let longitude = readNumber(body, "longitude");
      const city = readInputString(body, "city") ?? readInputString(body, "location");

      if (latitude === undefined || longitude === undefined) {
        if (city === undefined || city.length === 0) {
          throw createToolInputError(
            "free.weather.current",
            "Current weather requires either input.city or both input.latitude/input.longitude (input.location is also accepted).",
            { field: "city|location|latitude|longitude" },
          );
        }
        const resolved = await resolveCoordinatesForCity({
          fetchImpl,
          city,
          toolName: "free.weather.current",
        });
        latitude = resolved.latitude;
        longitude = resolved.longitude;
      }

      const weatherUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=UTC`;
      const weatherResponse = await fetchImpl(weatherUrl);
      ensureFetchOk("free.weather.current", "open-meteo", weatherResponse, { city, latitude, longitude });

      const weatherPayload = parseJsonRecord("free.weather.current", "open-meteo", await weatherResponse.json(), {
        city,
        latitude,
        longitude,
      });
      const current = parseJsonRecord("free.weather.current", "open-meteo", weatherPayload.current ?? {}, {
        field: "current",
      });

      return {
        source: "open-meteo",
        latitude,
        longitude,
        temperatureC: readNumber(current, "temperature_2m"),
        apparentTemperatureC: readNumber(current, "apparent_temperature"),
        humidityPct: readNumber(current, "relative_humidity_2m"),
        weatherCode: readNumber(current, "weather_code"),
        windSpeedKph: readNumber(current, "wind_speed_10m"),
        observedAt: readString(current, "time"),
      };
    };
  },
};

function readInputString(
  body: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = readString(body, key);
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
