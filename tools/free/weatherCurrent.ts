import type { SharedToolModule } from "../contracts.js";
import {
  createToolInputError,
  parseObjectInput,
  readNumber,
  readString,
} from "../helpers.js";
import { resolveCoordinatesForCity } from "./geocodeResolver.js";
import { WEATHER_CURRENT_OUTPUT_CONTRACT } from "./weatherContracts.js";
import { executeWeatherFailover } from "./weatherFailover.js";
import { WEATHER_FAILOVER_POLICY } from "./weatherPolicy.js";
import { resolveWeatherProviderSet } from "./weatherProviderResolver.js";

export const weatherCurrentTool: SharedToolModule = {
  definition: {
    name: "free.weather.current",
    description:
      "Fetch current weather for coordinates or a city name using Open-Meteo with explicit Visual Crossing failover when configured.",
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
    outputContract: WEATHER_CURRENT_OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["weather.current"],
      suitability: {
        supportsAttribution: true,
        typicalFailureModes: ["requires_city_or_coordinates"],
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
    const fetchImpl = context.fetchImpl ?? fetch;
    const providers = resolveWeatherProviderSet(context);

    return async (input: unknown) => {
      const body = parseObjectInput("free.weather.current", input);
      let latitude = readNumber(body, "latitude");
      let longitude = readNumber(body, "longitude");
      const city =
        readInputString(body, "city") ?? readInputString(body, "location");

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

      const outcome = await executeWeatherFailover({
        policy: WEATHER_FAILOVER_POLICY,
        primary: (signal) =>
          providers.primary.adapter.current({
            toolName: "free.weather.current",
            latitude,
            longitude,
            signal,
          }),
        ...(providers.fallback
          ? {
              fallback: (signal: AbortSignal) =>
                providers.fallback!.adapter.current({
                  toolName: "free.weather.current",
                  latitude,
                  longitude,
                  signal,
                }),
            }
          : {}),
      });
      return {
        ...outcome.value,
        attempts: outcome.attempts,
        fallbackUsed: outcome.fallbackUsed,
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
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
