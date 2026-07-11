import {
  createToolProviderError,
  parseJsonRecord,
  readNumber,
  readString,
} from "../helpers.js";

interface ResolveCoordinatesInput {
  fetchImpl: typeof fetch;
  city: string;
  toolName: string;
}

interface ResolvedCoordinates {
  latitude: number;
  longitude: number;
}

export async function resolveCoordinatesForCity(
  input: ResolveCoordinatesInput,
): Promise<ResolvedCoordinates> {
  const openMeteo = await tryOpenMeteoGeocode(input.fetchImpl, input.city, input.toolName);
  if (openMeteo !== undefined) {
    return openMeteo;
  }

  const nominatim = await tryNominatimGeocode(input.fetchImpl, input.city, input.toolName);
  if (nominatim !== undefined) {
    return nominatim;
  }

  throw createToolProviderError(
    input.toolName,
    "geocode",
    `Geocode providers returned no coordinates for city '${input.city}'.`,
    { city: input.city },
  );
}

async function tryOpenMeteoGeocode(
  fetchImpl: typeof fetch,
  city: string,
  toolName: string,
): Promise<ResolvedCoordinates | undefined> {
  const geocodeUrl =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const response = await fetchImpl(geocodeUrl);
  if (response.ok === false) {
    return undefined;
  }

  const payload = parseJsonRecord(toolName, "open-meteo-geocode", await response.json(), {
    city,
  });
  const first = Array.isArray(payload.results)
    ? parseJsonRecord(toolName, "open-meteo-geocode", payload.results[0] ?? {}, {
        city,
        field: "results[0]",
      })
    : undefined;
  const latitude = readNumber(first, "latitude");
  const longitude = readNumber(first, "longitude");
  if (latitude === undefined || longitude === undefined) {
    return undefined;
  }

  return { latitude, longitude };
}

async function tryNominatimGeocode(
  fetchImpl: typeof fetch,
  city: string,
  toolName: string,
): Promise<ResolvedCoordinates | undefined> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(city)}`;
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "kestrel/0.1",
    },
  });
  if (response.ok === false) {
    return undefined;
  }

  const payload = await response.json();
  const first = Array.isArray(payload)
    ? parseJsonRecord(toolName, "nominatim", payload[0] ?? {}, {
        city,
        field: "results[0]",
      })
    : undefined;
  const latitude = toFiniteNumber(readString(first, "lat"));
  const longitude = toFiniteNumber(readString(first, "lon"));
  if (latitude === undefined || longitude === undefined) {
    return undefined;
  }

  return { latitude, longitude };
}

function toFiniteNumber(value: string | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
