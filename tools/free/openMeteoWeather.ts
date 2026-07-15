import {
  createToolProviderPayloadError,
  ensureFetchOk,
  parseJsonRecord,
  readNumber,
  readString,
} from "../helpers.js";
import type { WeatherProviderAdapter } from "./weatherProvider.js";

const DEFAULT_BASE_URL = "https://api.open-meteo.com/v1/forecast";

export function createOpenMeteoWeatherAdapter(input: {
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}): WeatherProviderAdapter {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = input.fetchImpl ?? fetch;

  return Object.freeze({
    async current(
      currentInput: Parameters<WeatherProviderAdapter["current"]>[0],
    ) {
      const url = createUrl(
        baseUrl,
        currentInput.latitude,
        currentInput.longitude,
      );
      url.searchParams.set(
        "current",
        "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
      );
      url.searchParams.set("timezone", "UTC");
      const payload = await request({
        toolName: currentInput.toolName,
        url,
        fetchImpl,
        signal: currentInput.signal,
        latitude: currentInput.latitude,
        longitude: currentInput.longitude,
      });
      const current = parseJsonRecord(
        currentInput.toolName,
        "open-meteo",
        payload.current ?? {},
        { field: "current" },
      );
      const temperatureC = readNumber(current, "temperature_2m");
      const observedAt = readString(current, "time");
      if (
        temperatureC === undefined ||
        !Number.isFinite(temperatureC) ||
        observedAt === undefined ||
        observedAt.length === 0
      ) {
        throw createToolProviderPayloadError(
          currentInput.toolName,
          "open-meteo",
          "Weather provider response is missing the current temperature or observation time.",
          { field: "current.temperature_2m|current.time" },
        );
      }
      return {
        source: "open-meteo",
        latitude: readNumber(payload, "latitude") ?? currentInput.latitude,
        longitude: readNumber(payload, "longitude") ?? currentInput.longitude,
        temperatureC,
        apparentTemperatureC: readNumber(current, "apparent_temperature"),
        humidityPct: readNumber(current, "relative_humidity_2m"),
        weatherCode: readNumber(current, "weather_code"),
        windSpeedKph: readNumber(current, "wind_speed_10m"),
        observedAt,
      };
    },

    async forecast(
      forecastInput: Parameters<WeatherProviderAdapter["forecast"]>[0],
    ) {
      const url = createUrl(
        baseUrl,
        forecastInput.latitude,
        forecastInput.longitude,
      );
      url.searchParams.set("current", "temperature_2m");
      url.searchParams.set(
        "hourly",
        "temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m",
      );
      url.searchParams.set(
        "daily",
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
      );
      url.searchParams.set("forecast_days", String(forecastInput.days));
      url.searchParams.set("timezone", forecastInput.timezone);
      const payload = await request({
        toolName: forecastInput.toolName,
        url,
        fetchImpl,
        signal: forecastInput.signal,
        latitude: forecastInput.latitude,
        longitude: forecastInput.longitude,
      });
      const hourly = parseJsonRecord(
        forecastInput.toolName,
        "open-meteo",
        payload.hourly ?? {},
        { field: "hourly" },
      );
      const daily = parseJsonRecord(
        forecastInput.toolName,
        "open-meteo",
        payload.daily ?? {},
        { field: "daily" },
      );
      if (!Array.isArray(daily.time) || daily.time.length === 0) {
        throw createToolProviderPayloadError(
          forecastInput.toolName,
          "open-meteo",
          "Forecast provider returned no daily timeline.",
          { field: "daily.time" },
        );
      }
      return {
        source: "open-meteo",
        latitude: readNumber(payload, "latitude") ?? forecastInput.latitude,
        longitude: readNumber(payload, "longitude") ?? forecastInput.longitude,
        timezone: readString(payload, "timezone") ?? forecastInput.timezone,
        current: parseOptionalRecord(payload.current),
        hourly,
        daily,
      };
    },
  });
}

function createUrl(baseUrl: string, latitude: number, longitude: number) {
  const url = new URL(baseUrl);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  return url;
}

async function request(input: {
  toolName: string;
  url: URL;
  fetchImpl: typeof fetch;
  signal?: AbortSignal | undefined;
  latitude: number;
  longitude: number;
}) {
  const response = await input.fetchImpl(input.url, {
    method: "GET",
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  ensureFetchOk(input.toolName, "open-meteo", response, {
    latitude: input.latitude,
    longitude: input.longitude,
  });
  return parseJsonRecord(
    input.toolName,
    "open-meteo",
    await response.json(),
    { latitude: input.latitude, longitude: input.longitude },
  );
}

function parseOptionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
