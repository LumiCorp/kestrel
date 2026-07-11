import type { SharedToolModule } from "../contracts.js";
import {
  fetchImplOrDefault,
  parseJsonRecord,
  parseObjectInput,
  readString,
} from "../helpers.js";

export const timeCurrentTool: SharedToolModule = {
  definition: {
    name: "free.time.current",
    description: "Get current time for a timezone using WorldTimeAPI.",
    inputSchema: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone, e.g. America/New_York" },
      },
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["time.current"],
      suitability: {
        supportsAttribution: true,
        typicalFailureModes: ["invalid_timezone", "provider_unavailable"],
      },
    },
    presentation: {
      displayName: "Current Time",
      aliases: ["current time", "time lookup", "timezone time"],
      keywords: ["time", "timezone", "clock", "current"],
      provider: "worldtimeapi",
      toolFamily: "time",
    },
  },
  createHandler(context) {
    const fetchImpl = fetchImplOrDefault(context.fetchImpl);

    return async (input: unknown) => {
      const body = parseObjectInput("free.time.current", input);
      const timezone = readString(body, "timezone") ?? "Etc/UTC";

      const worldTime = await tryWorldTimeApi(fetchImpl, timezone);
      if (worldTime !== undefined) {
        return worldTime;
      }

      const timeApiIo = await tryTimeApiIo(fetchImpl, timezone);
      if (timeApiIo !== undefined) {
        return timeApiIo;
      }

      return {
        source: "time.providers",
        timezone,
        error: {
          code: "all_providers_unavailable",
          message: "Unable to retrieve current time from configured providers.",
        },
      };
    };
  },
};

async function tryWorldTimeApi(
  fetchImpl: typeof fetch,
  timezone: string,
): Promise<Record<string, unknown> | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(
      `https://worldtimeapi.org/api/timezone/${encodeURIComponent(timezone)}`,
    );
  } catch {
    return undefined;
  }
  if (response.ok === false) {
    return undefined;
  }

  const payload = parseJsonRecord("free.time.current", "worldtimeapi", await response.json(), {
    timezone,
  });
  return {
    source: "worldtimeapi",
    timezone,
    datetime: readString(payload, "datetime"),
    utc: readString(payload, "utc_datetime"),
    dayOfWeek: payload.day_of_week,
  };
}

async function tryTimeApiIo(
  fetchImpl: typeof fetch,
  timezone: string,
): Promise<Record<string, unknown> | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(
      `https://timeapi.io/api/Time/current/zone?timeZone=${encodeURIComponent(timezone)}`,
    );
  } catch {
    return undefined;
  }
  if (response.ok === false) {
    return undefined;
  }

  const payload = parseJsonRecord("free.time.current", "timeapi.io", await response.json(), {
    timezone,
  });
  const dateTime = readString(payload, "dateTime");
  const utcOffset = readString(payload, "utcOffset");
  return {
    source: "timeapi.io",
    timezone,
    datetime: dateTime,
    utcOffset,
  };
}
