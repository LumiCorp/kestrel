import {
  asRecord,
  createToolProviderPayloadError,
  ensureFetchOk,
  parseJsonRecord,
  readNumber,
  readString,
} from "../helpers.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { WeatherProviderAdapter } from "./weatherProvider.js";

const DEFAULT_BASE_URL =
  "https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/";

export interface VisualCrossingWeatherRequest {
  toolName: string;
  latitude: number;
  longitude: number;
  include: "current" | "current,days,hours";
  timezone: string;
  signal?: AbortSignal | undefined;
}

export interface VisualCrossingWeatherTransport {
  request(input: VisualCrossingWeatherRequest): Promise<Record<string, unknown>>;
}

export type VisualCrossingWeatherAdapter = WeatherProviderAdapter;

export async function verifyVisualCrossingCredential(input: {
  apiKey: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<{ checkedAt: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 10_000,
  );
  try {
    const adapter = createVisualCrossingWeatherAdapter(input);
    await adapter.current({
      toolName: "free.weather.connection.verify",
      latitude: 0,
      longitude: 0,
      signal: controller.signal,
    });
    return { checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}

export function createVisualCrossingWeatherAdapter(input: {
  apiKey: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}): VisualCrossingWeatherAdapter {
  const apiKey = requireNonEmpty(input.apiKey, "Visual Crossing API key");
  const baseUrl = ensureTrailingSlash(input.baseUrl ?? DEFAULT_BASE_URL);
  const fetchImpl = input.fetchImpl ?? fetch;
  return createVisualCrossingWeatherAdapterFromTransport({
    async request(requestInput) {
      const url = new URL(
        `${encodeURIComponent(requestInput.latitude)},${encodeURIComponent(requestInput.longitude)}`,
        baseUrl,
      );
      url.searchParams.set("key", apiKey);
      url.searchParams.set("unitGroup", "metric");
      url.searchParams.set("include", requestInput.include);
      url.searchParams.set("contentType", "json");
      url.searchParams.set("timezone", requestInput.timezone);
      const response = await fetchImpl(url, {
        method: "GET",
        ...(requestInput.signal !== undefined
          ? { signal: requestInput.signal }
          : {}),
      });
      ensureFetchOk(requestInput.toolName, "visual-crossing", response, {
        latitude: requestInput.latitude,
        longitude: requestInput.longitude,
      });
      return parseJsonRecord(
        requestInput.toolName,
        "visual-crossing",
        await response.json(),
        {
          latitude: requestInput.latitude,
          longitude: requestInput.longitude,
        },
      );
    },
  });
}

export function createVisualCrossingWeatherAdapterFromTransport(
  transport: VisualCrossingWeatherTransport,
): VisualCrossingWeatherAdapter {

  return Object.freeze({
    async current(
      currentInput: Parameters<VisualCrossingWeatherAdapter["current"]>[0],
    ) {
      const payload = await transport.request({
        ...currentInput,
        include: "current",
        timezone: "UTC",
      });
      const current = parseJsonRecord(
        currentInput.toolName,
        "visual-crossing",
        payload.currentConditions ?? {},
        { field: "currentConditions" },
      );
      const temperatureC = readNumber(current, "temp");
      const observedAtEpoch = readNumber(current, "datetimeEpoch");
      if (
        temperatureC === undefined ||
        Number.isFinite(temperatureC) === false ||
        observedAtEpoch === undefined ||
        Number.isFinite(observedAtEpoch) === false
      ) {
        throw createToolProviderPayloadError(
          currentInput.toolName,
          "visual-crossing",
          "Weather provider response is missing the current temperature or observation time.",
          { field: "currentConditions.temp|currentConditions.datetimeEpoch" },
        );
      }
      return {
        source: "visual-crossing",
        latitude: readNumber(payload, "latitude") ?? currentInput.latitude,
        longitude: readNumber(payload, "longitude") ?? currentInput.longitude,
        temperatureC,
        apparentTemperatureC: readNumber(current, "feelslike"),
        humidityPct: readNumber(current, "humidity"),
        condition: readString(current, "conditions"),
        windSpeedKph: readNumber(current, "windspeed"),
        observedAt: new Date(observedAtEpoch * 1000).toISOString(),
      };
    },

    async forecast(
      forecastInput: Parameters<VisualCrossingWeatherAdapter["forecast"]>[0],
    ) {
      const payload = await transport.request({
        ...forecastInput,
        include: "current,days,hours",
        timezone: forecastInput.timezone,
      });
      const rawDays = Array.isArray(payload.days) ? payload.days : [];
      const days = rawDays
        .slice(0, forecastInput.days)
        .map((value) => asRecord(value))
        .filter((value): value is Record<string, unknown> => value !== undefined);
      if (days.length === 0) {
        throw createToolProviderPayloadError(
          forecastInput.toolName,
          "visual-crossing",
          "Forecast provider returned no daily timeline.",
          { field: "days" },
        );
      }
      const hourlyRows = days.flatMap((day) => {
        const date = readString(day, "datetime");
        if (!(date && Array.isArray(day.hours))) return [];
        return day.hours.flatMap((value) => {
          const hour = asRecord(value);
          const time = hour ? readString(hour, "datetime") : undefined;
          return hour && time
            ? [{ date, time, hour }]
            : [];
        });
      });
      const currentConditions = asRecord(payload.currentConditions);
      const currentDate = days[0] ? readString(days[0], "datetime") : undefined;
      const currentTime = currentConditions
        ? readString(currentConditions, "datetime")
        : undefined;
      return {
        source: "visual-crossing",
        latitude: readNumber(payload, "latitude") ?? forecastInput.latitude,
        longitude: readNumber(payload, "longitude") ?? forecastInput.longitude,
        timezone: readString(payload, "timezone") ?? forecastInput.timezone,
        current:
          currentDate && currentTime
            ? { time: toLocalHour(currentDate, currentTime) }
            : {},
        hourly: {
          time: hourlyRows.map((row) => toLocalHour(row.date, row.time)),
          temperature_2m: hourlyRows.map((row) => readNumber(row.hour, "temp")),
          apparent_temperature: hourlyRows.map((row) =>
            readNumber(row.hour, "feelslike"),
          ),
          precipitation_probability: hourlyRows.map((row) =>
            readNumber(row.hour, "precipprob"),
          ),
          precipitation: hourlyRows.map((row) =>
            readNumber(row.hour, "precip"),
          ),
          wind_speed_10m: hourlyRows.map((row) =>
            readNumber(row.hour, "windspeed"),
          ),
        },
        daily: {
          time: days.map((day) => readString(day, "datetime")),
          temperature_2m_max: days.map((day) => readNumber(day, "tempmax")),
          temperature_2m_min: days.map((day) => readNumber(day, "tempmin")),
          precipitation_probability_max: days.map((day) =>
            readNumber(day, "precipprob"),
          ),
          precipitation_sum: days.map((day) => readNumber(day, "precip")),
          wind_speed_10m_max: days.map((day) =>
            readNumber(day, "windspeed"),
          ),
        },
      };
    },
  });
}

function toLocalHour(date: string, time: string): string {
  return `${date}T${time.slice(0, 5)}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw createRuntimeFailure(
      "TOOL_PROVIDER_CONFIGURATION_MISSING",
      `${label} is required.`,
      {
        subsystem: "tooling",
        provider: "visual-crossing",
        classification: "configuration",
        recoverable: true,
      },
    );
  }
  return normalized;
}
