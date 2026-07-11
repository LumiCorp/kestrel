import type { SharedToolModule } from "../contracts.js";
import {
  asRecord,
  ensureFetchOk,
  fetchImplOrDefault,
  parseObjectInput,
  requireStringField,
  readNumber,
  readString,
} from "../helpers.js";

export const geocodeLookupTool: SharedToolModule = {
  definition: {
    name: "free.geocode.lookup",
    description: "Resolve a location query to latitude/longitude via OpenStreetMap Nominatim.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["geo.geocode"],
      suitability: {
        supportsAttribution: true,
        typicalFailureModes: ["query_not_found", "provider_unavailable"],
      },
    },
    presentation: {
      displayName: "Geocode Lookup",
      aliases: ["geocode lookup", "location geocode", "coordinate lookup"],
      keywords: ["geocode", "location", "coordinates", "latitude", "longitude"],
      provider: "nominatim",
      toolFamily: "geo",
    },
  },
  createHandler(context) {
    const fetchImpl = fetchImplOrDefault(context.fetchImpl);

    return async (input: unknown) => {
      const body = parseObjectInput("free.geocode.lookup", input);
      const query = requireStringField("free.geocode.lookup", body, "query");

      const url =
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;

      const response = await fetchImpl(url, {
        headers: {
          "User-Agent": "kestrel/0.1",
        },
      });
      ensureFetchOk("free.geocode.lookup", "nominatim", response, { query });

      const payload = await response.json();
      const results = Array.isArray(payload) ? payload : [];

      return {
        source: "nominatim",
        query,
        results: results
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== undefined)
          .map((item) => ({
            displayName: readString(item, "display_name"),
            latitude: Number(readString(item, "lat")),
            longitude: Number(readString(item, "lon")),
            importance: readNumber(item, "importance"),
          })),
      };
    };
  },
};
