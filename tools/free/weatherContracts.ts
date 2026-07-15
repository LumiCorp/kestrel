import type { ModelToolContract } from "../../src/kestrel/contracts/model-io.js";

export const WEATHER_CURRENT_OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: ["source", "latitude", "longitude", "temperatureC", "observedAt"],
  fields: {
    source: { type: "string", description: "Weather data provider." },
    latitude: { type: "number", description: "Resolved latitude." },
    longitude: { type: "number", description: "Resolved longitude." },
    temperatureC: {
      type: "number",
      description: "Observed temperature in Celsius.",
    },
    apparentTemperatureC: {
      type: "number",
      description: "Feels-like temperature in Celsius.",
    },
    humidityPct: {
      type: "number",
      description: "Relative humidity percentage.",
    },
    weatherCode: {
      type: "number",
      description: "Provider weather condition code.",
    },
    condition: {
      type: "string",
      description: "Provider-normalized textual weather condition when available.",
    },
    windSpeedKph: {
      type: "number",
      description: "Wind speed in kilometers per hour.",
    },
    observedAt: {
      type: "string",
      description: "Provider-local observation timestamp.",
    },
    attempts: {
      type: "array",
      itemType: "object",
      description:
        "Ordered provider-attempt evidence including provider, outcome, duration, and normalized failure code when applicable.",
    },
    fallbackUsed: {
      type: "boolean",
      description: "Whether the successful result came from the fallback provider.",
    },
  },
  additionalProperties: false,
};

export const WEATHER_FORECAST_OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: [
    "source",
    "latitude",
    "longitude",
    "timezone",
    "requestedDays",
    "granularity",
    "daily",
  ],
  fields: {
    source: { type: "string", description: "Weather data provider." },
    latitude: { type: "number", description: "Resolved latitude." },
    longitude: { type: "number", description: "Resolved longitude." },
    timezone: {
      type: "string",
      description: "Timezone used by forecast timestamps.",
    },
    requestedDays: {
      type: "number",
      description: "Number of requested forecast days.",
    },
    granularity: {
      type: "string",
      enum: ["hourly", "daily", "mixed"],
      description: "Requested forecast presentation shape.",
    },
    target: {
      type: "object",
      description: "Selected target hour when one was requested or resolved.",
    },
    nextHours: {
      type: "array",
      itemType: "object",
      description: "Hourly forecast evidence beginning at the selected target.",
    },
    daily: {
      type: "array",
      itemType: "object",
      description: "Daily forecast evidence for the requested range.",
    },
    attempts: {
      type: "array",
      itemType: "object",
      description:
        "Ordered provider-attempt evidence including provider, outcome, duration, and normalized failure code when applicable.",
    },
    fallbackUsed: {
      type: "boolean",
      description: "Whether the successful result came from the fallback provider.",
    },
  },
  additionalProperties: false,
};
