import { tool } from "ai";
import { z } from "zod";

export type WeatherToolSettings = {
  units: "fahrenheit" | "celsius";
  timeoutMs: number;
  retryCount: number;
};

const DEFAULT_WEATHER_TOOL_SETTINGS: WeatherToolSettings = {
  units: "fahrenheit",
  timeoutMs: 8000,
  retryCount: 1,
};

function createWeatherToolError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function resolveWeatherToolSettings(
  settings?: Record<string, unknown>
): WeatherToolSettings {
  const units =
    settings?.units === "celsius"
      ? "celsius"
      : DEFAULT_WEATHER_TOOL_SETTINGS.units;
  const timeoutMsValue =
    typeof settings?.timeoutMs === "number"
      ? settings.timeoutMs
      : DEFAULT_WEATHER_TOOL_SETTINGS.timeoutMs;
  const retryCountValue =
    typeof settings?.retryCount === "number"
      ? settings.retryCount
      : DEFAULT_WEATHER_TOOL_SETTINGS.retryCount;

  return {
    units,
    timeoutMs: Math.max(1000, Math.round(timeoutMsValue)),
    retryCount: Math.max(0, Math.round(retryCountValue)),
  };
}

async function fetchJsonWithRetry(
  url: string,
  settings: WeatherToolSettings
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= settings.retryCount; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(settings.timeoutMs),
      });

      if (!response.ok) {
        throw createWeatherToolError(
          "WEATHER_REQUEST_FAILED",
          `Weather request failed with status ${response.status}`
        );
      }

      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : createWeatherToolError("WEATHER_REQUEST_FAILED", "Weather request failed");
}

async function geocodeCity(
  city: string,
  settings: WeatherToolSettings
): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const data = (await fetchJsonWithRetry(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
      settings
    )) as { results?: Array<{ latitude: number; longitude: number }> };

    if (!data.results || data.results.length === 0) {
      return null;
    }

    const result = data.results[0];
    return {
      latitude: result.latitude,
      longitude: result.longitude,
    };
  } catch {
    return null;
  }
}

export function createGetWeatherTool(settings?: Record<string, unknown>) {
  const resolvedSettings = resolveWeatherToolSettings(settings);

  return tool({
    description:
      "Get the current weather at a location. You can provide either coordinates or a city name.",
    inputSchema: z.object({
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      city: z
        .string()
        .describe("City name (e.g., 'San Francisco', 'New York', 'London')")
        .optional(),
    }),
    execute: async (input) => {
      let latitude: number;
      let longitude: number;

      if (input.city) {
        const coords = await geocodeCity(input.city, resolvedSettings);
        if (!coords) {
          return {
            error: `Could not find coordinates for "${input.city}". Please check the city name.`,
          };
        }
        latitude = coords.latitude;
        longitude = coords.longitude;
      } else if (
        input.latitude !== undefined &&
        input.longitude !== undefined
      ) {
        latitude = input.latitude;
        longitude = input.longitude;
      } else {
        return {
          error:
            "Please provide either a city name or both latitude and longitude coordinates.",
        };
      }

      try {
        const temperatureUnit =
          resolvedSettings.units === "fahrenheit" ? "fahrenheit" : "celsius";
        const weatherData = (await fetchJsonWithRetry(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&hourly=temperature_2m&daily=sunrise,sunset&timezone=auto&temperature_unit=${temperatureUnit}`,
          resolvedSettings
        )) as Record<string, unknown>;

        if ("city" in input) {
          weatherData.cityName = input.city;
        }

        return weatherData;
      } catch {
        return {
          error:
            "Weather service is temporarily unavailable. Please try again.",
        };
      }
    },
  });
}

export const getWeather = createGetWeatherTool();
