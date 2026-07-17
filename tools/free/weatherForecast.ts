import type { SharedToolModule } from "../contracts.js";
import {
  createToolInputError,
  parseObjectInput,
  readNumber,
  readString,
} from "../helpers.js";
import { resolveCoordinatesForCity } from "./geocodeResolver.js";
import { WEATHER_FORECAST_OUTPUT_CONTRACT } from "./weatherContracts.js";
import { executeWeatherFailover } from "./weatherFailover.js";
import { WEATHER_FAILOVER_POLICY } from "./weatherPolicy.js";
import { resolveWeatherProviderSet } from "./weatherProviderResolver.js";

const DEFAULT_FORECAST_DAYS = 5;
const MAX_FORECAST_DAYS = 10;

export const weatherForecastTool: SharedToolModule = {
  definition: {
    name: "free.weather.forecast",
    description:
      "Fetch up to 10 days of daily and hourly weather using Open-Meteo with explicit Visual Crossing failover when configured. Use days for date ranges. To select one target hour, pair localHour with exactly one of localDate or dayOffset.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        location: { type: "string" },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        timezone: { type: "string", description: "IANA timezone or 'auto'." },
        localDate: {
          type: "string",
          description:
            "YYYY-MM-DD in local timezone. Requires localHour and cannot be combined with dayOffset.",
        },
        localHour: {
          type: "number",
          minimum: 0,
          maximum: 23,
          description:
            "0-23 local hour. Requires exactly one of localDate or dayOffset.",
        },
        dayOffset: {
          type: "number",
          description:
            "Whole-day offset from today in local timezone. Requires localHour and cannot be combined with localDate.",
        },
        days: {
          type: "number",
          minimum: 1,
          maximum: MAX_FORECAST_DAYS,
          description:
            "Number of forecast days to return for a date range, from 1 through 10.",
        },
        granularity: {
          type: "string",
          enum: ["hourly", "daily", "mixed"],
          description:
            "Forecast shape preference. mixed returns both daily and hourly slices.",
        },
      },
      additionalProperties: false,
    },
    outputContract: WEATHER_FORECAST_OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["weather.forecast"],
      suitability: {
        forecastHorizonDays: MAX_FORECAST_DAYS,
        granularity: "mixed",
        supportsAttribution: true,
        supportsAggregation: true,
        typicalFailureModes: [
          "requires_city_or_coordinates",
          "hourly_target_out_of_range",
        ],
      },
    },
    presentation: {
      displayName: "Weather Forecast",
      aliases: ["weather forecast", "forecast", "future weather"],
      keywords: ["weather", "forecast", "daily", "hourly"],
      provider: "open-meteo",
      toolFamily: "weather",
    },
  },
  createHandler(context) {
    const fetchImpl = context.fetchImpl ?? fetch;
    const providers = resolveWeatherProviderSet(context);

    return async (input: unknown) => {
      const body = parseObjectInput("free.weather.forecast", input);
      const selector = parseTargetSelector(body);
      let latitude = readNumber(body, "latitude");
      let longitude = readNumber(body, "longitude");
      const city =
        readInputString(body, "city") ?? readInputString(body, "location");

      if (latitude === undefined || longitude === undefined) {
        if (city === undefined || city.length === 0) {
          throw createToolInputError(
            "free.weather.forecast",
            "Weather forecast requires either input.city/location or both input.latitude/input.longitude.",
            { field: "city|location|latitude|longitude" },
          );
        }
        const resolved = await resolveCoordinatesForCity({
          fetchImpl,
          city,
          toolName: "free.weather.forecast",
        });
        latitude = resolved.latitude;
        longitude = resolved.longitude;
      }

      const requestedTimezone = readString(body, "timezone") ?? "auto";
      const requestedDays = clampForecastDays(readNumber(body, "days"));
      const granularity = readGranularity(body);
      const providerOutcome = await executeWeatherFailover({
        policy: WEATHER_FAILOVER_POLICY,
        primary: (signal) =>
          providers.primary.adapter.forecast({
            toolName: "free.weather.forecast",
            latitude,
            longitude,
            days: requestedDays,
            timezone: requestedTimezone,
            signal,
          }),
        ...(providers.fallback
          ? {
              fallback: (signal: AbortSignal) =>
                providers.fallback!.adapter.forecast({
                  toolName: "free.weather.forecast",
                  latitude,
                  longitude,
                  days: requestedDays,
                  timezone: requestedTimezone,
                  signal,
                }),
            }
          : {}),
      });
      const providerForecast = providerOutcome.value;
      const hourly = providerForecast.hourly;
      const times = asStringArray(hourly.time);
      const daily = providerForecast.daily;
      const dailyTimes = asStringArray(daily.time);
      const selectedIndex = selectForecastIndex(
        times,
        selector,
        readString(providerForecast.current, "time"),
      );
      if (selector !== undefined && selectedIndex === undefined) {
        throw createToolInputError(
          "free.weather.forecast",
          "Requested target hour is outside the returned forecast window. Increase input.days or choose a target within the available horizon.",
          {
            reason: "hourly_target_out_of_range",
            requestedDays,
            ...(selector.localDate !== undefined
              ? { localDate: selector.localDate }
              : {}),
            ...(selector.dayOffset !== undefined
              ? { dayOffset: selector.dayOffset }
              : {}),
            localHour: selector.localHour,
          },
        );
      }

      return {
        source: providerForecast.source,
        latitude: providerForecast.latitude,
        longitude: providerForecast.longitude,
        timezone: providerForecast.timezone,
        requestedDays,
        granularity,
        attempts: providerOutcome.attempts,
        fallbackUsed: providerOutcome.fallbackUsed,
        ...(selectedIndex !== undefined
          ? {
              target: mapHourAtIndex(hourly, times, selectedIndex),
              nextHours: buildHourSlice(
                hourly,
                times,
                selectedIndex,
                Math.min(12, times.length - selectedIndex),
              ),
            }
          : {}),
        ...(dailyTimes.length > 0
          ? {
              daily: buildDailySlice(
                daily,
                dailyTimes,
                Math.min(requestedDays, dailyTimes.length),
              ),
            }
          : {}),
      };
    };
  },
};

function clampForecastDays(value: number | undefined): number {
  if (value === undefined || Number.isFinite(value) === false) {
    return DEFAULT_FORECAST_DAYS;
  }
  return Math.max(1, Math.min(MAX_FORECAST_DAYS, Math.trunc(value)));
}

function readInputString(
  body: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = readString(body, key);
  if (value === undefined) {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readGranularity(
  body: Record<string, unknown> | undefined,
): "hourly" | "daily" | "mixed" {
  const value = readString(body, "granularity");
  if (value === "hourly" || value === "daily" || value === "mixed") {
    return value;
  }
  return "mixed";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

interface ForecastTargetSelector {
  localDate?: string | undefined;
  localHour: number;
  dayOffset?: number | undefined;
}

function parseTargetSelector(
  body: Record<string, unknown>,
): ForecastTargetSelector | undefined {
  const localDate = readString(body, "localDate");
  const localHour = readNumber(body, "localHour");
  const dayOffset = readNumber(body, "dayOffset");
  const hasLocalDate = localDate !== undefined;
  const hasLocalHour = localHour !== undefined;
  const hasDayOffset = dayOffset !== undefined;

  if (hasLocalDate && hasDayOffset) {
    throw createToolInputError(
      "free.weather.forecast",
      "Weather forecast target selection accepts localDate or dayOffset, not both.",
      { field: "localDate|dayOffset", reason: "conflicting_target_selectors" },
    );
  }
  if ((hasLocalDate || hasDayOffset) && hasLocalHour === false) {
    throw createToolInputError(
      "free.weather.forecast",
      "Weather forecast localDate/dayOffset requires input.localHour.",
      { field: "localHour", reason: "incomplete_target_selector" },
    );
  }
  if (hasLocalHour && hasLocalDate === false && hasDayOffset === false) {
    throw createToolInputError(
      "free.weather.forecast",
      "Weather forecast localHour requires exactly one of input.localDate or input.dayOffset.",
      { field: "localDate|dayOffset", reason: "incomplete_target_selector" },
    );
  }
  if (
    hasLocalDate === false &&
    hasLocalHour === false &&
    hasDayOffset === false
  ) {
    return ;
  }
  if (hasDayOffset && Number.isInteger(dayOffset) === false) {
    throw createToolInputError(
      "free.weather.forecast",
      "Weather forecast dayOffset must be a whole number.",
      { field: "dayOffset", reason: "invalid_target_selector" },
    );
  }

  return {
    ...(localDate !== undefined ? { localDate } : {}),
    localHour: localHour!,
    ...(dayOffset !== undefined ? { dayOffset } : {}),
  };
}

function selectForecastIndex(
  times: string[],
  options: ForecastTargetSelector | undefined,
  currentLocalTime: string | undefined,
): number | undefined {
  if (times.length === 0) {
    return ;
  }
  if (options === undefined) {
    if (currentLocalTime === undefined) {
      return ;
    }
    const currentHour = `${currentLocalTime.slice(0, 13)}:00`;
    const currentIndex = times.findIndex((time) => time === currentHour);
    return currentIndex >= 0 ? currentIndex : undefined;
  }
  if (options.localDate !== undefined) {
    const targetPrefix = `${options.localDate}T${padHour(options.localHour)}:`;
    const exactIndex = times.findIndex((time) => time.startsWith(targetPrefix));
    return exactIndex >= 0 ? exactIndex : undefined;
  }
  if (options.dayOffset !== undefined) {
    const today = times[0]?.slice(0, 10);
    if (today !== undefined) {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + Math.trunc(options.dayOffset));
      const targetDate = `${date.getUTCFullYear()}-${padDatePart(date.getUTCMonth() + 1)}-${padDatePart(date.getUTCDate())}`;
      const targetPrefix = `${targetDate}T${padHour(options.localHour)}:`;
      const offsetIndex = times.findIndex((time) =>
        time.startsWith(targetPrefix),
      );
      return offsetIndex >= 0 ? offsetIndex : undefined;
    }
  }
  return ;
}

function mapHourAtIndex(
  hourly: Record<string, unknown>,
  times: string[],
  index: number,
): Record<string, unknown> {
  return {
    time: times[index],
    temperatureC: getNumericAt(hourly.temperature_2m, index),
    apparentTemperatureC: getNumericAt(hourly.apparent_temperature, index),
    precipitationProbabilityPct: getNumericAt(
      hourly.precipitation_probability,
      index,
    ),
    precipitationMm: getNumericAt(hourly.precipitation, index),
    windSpeedKph: getNumericAt(hourly.wind_speed_10m, index),
  };
}

function buildHourSlice(
  hourly: Record<string, unknown>,
  times: string[],
  startIndex: number,
  count: number,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (let index = startIndex; index < startIndex + count; index += 1) {
    items.push(mapHourAtIndex(hourly, times, index));
  }
  return items;
}

function buildDailySlice(
  daily: Record<string, unknown>,
  times: string[],
  count: number,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    items.push({
      date: times[index],
      maxTemperatureC: getNumericAt(daily.temperature_2m_max, index),
      minTemperatureC: getNumericAt(daily.temperature_2m_min, index),
      precipitationProbabilityPct: getNumericAt(
        daily.precipitation_probability_max,
        index,
      ),
      precipitationMm: getNumericAt(daily.precipitation_sum, index),
      windSpeedKph: getNumericAt(daily.wind_speed_10m_max, index),
      weatherCode: getNumericAt(daily.weather_code, index),
    });
  }
  return items;
}

function getNumericAt(value: unknown, index: number): number | undefined {
  if (Array.isArray(value) === false) {
    return ;
  }
  const item = value[index];
  return typeof item === "number" ? item : undefined;
}

function padHour(hour: number): string {
  const normalized = Math.max(0, Math.min(23, Math.trunc(hour)));
  return normalized < 10 ? `0${normalized}` : `${normalized}`;
}

function padDatePart(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}
